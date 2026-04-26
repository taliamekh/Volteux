/**
 * Compile API — Hono server.
 *
 *   POST /api/compile     — bearer-authed; runs arduino-cli on a sketch.
 *   GET  /api/health      — unauthed; returns 200 healthy / 503 degraded.
 *
 * Auth: `Authorization: Bearer <COMPILE_API_SECRET>`. Server REFUSES TO
 * START unless the secret is at least 32 bytes — prevents the "test"
 * placeholder from ever shipping past local dev.
 *
 * Rate limit: a small in-process token bucket (10 req / 60s per secret).
 * v0.1 ships with one secret per environment so this is effectively a
 * global rate limit; v0.2 deploy will key on Bearer secret + per-IP.
 *
 * Concurrency: `pLimit(2)` matches CX22's vCPU count; concurrent requests
 * queue rather than thrash arduino-cli. The queue is depth-capped at
 * MAX_QUEUE_DEPTH; bursts past the cap return 503 immediately rather
 * than building a graveyard queue past the client-side timeout
 * (PERF-003 + REL-003).
 *
 * Logger discipline: NEVER log the Authorization header, the API secret,
 * `process.env`, or any request body field that could carry secrets. The
 * Hono logger middleware is intentionally NOT enabled. The custom
 * `app.onError` hook (SEC-HONO-500-001) writes a single redacted line
 * to stderr and returns a generic 500 body to the client.
 *
 * Filename allowlist: imports `validateAdditionalFileName` from the
 * pipeline-side library-allowlist module. Single source of truth — the
 * cross-consistency gate (pipeline) and this server use the SAME
 * predicate. Defense in depth comes from running the predicate at TWO
 * sites, not from defining it twice. (Two literal copies were the bug
 * SEC-002 + ADV-003 demonstrated.)
 *
 * Testability (F-003): the module exports `buildApp(deps)` and
 * `startServer()`. `buildApp` accepts dependency injection so unit tests
 * can stub the toolchain hash, cache, and arduino-cli invocation
 * without spawning a Docker container or mutating filesystem state.
 * `startServer()` is the binary's entry point and is only invoked when
 * `import.meta.main` — importing this module from a test runner does
 * NOT bind a port or compute the toolchain hash.
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bearerAuth } from "hono/bearer-auth";
import { zValidator } from "@hono/zod-validator";
import pLimit from "p-limit";
import { z } from "zod";
import {
  validateAdditionalFileName,
  type FilenameRejectionKind,
} from "../../pipeline/gates/library-allowlist.ts";
import {
  cacheDirSize,
  cacheGet,
  cacheKey,
  cachePut,
  computeToolchainVersionHash,
  SIZE_WARN_BYTES,
  type CacheEntry,
} from "./cache.ts";
import { createPerRequestSketchDir } from "./sketch-fs.ts";
import { invokeArduinoCli } from "./run-compile.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_SECRET_BYTES = 32;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 10;
const COMPILE_CONCURRENCY = 2;
/**
 * Max requests in the p-limit queue (active + pending) before the server
 * sheds load with 503. PERF-003 + REL-003: a burst of N requests at the
 * cold-compile latency would build a graveyard queue past the client's
 * 30s AbortController; the cap stops that before tail requests time out
 * server-side. 6 = 2 active + 4 pending; tail request waits ≤4 × 8s ≈
 * 32s, just past the client cap, so anything beyond fails fast instead.
 */
const MAX_QUEUE_DEPTH = 6;

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const CompileRequestSchema = z.object({
  fqbn: z.string().min(1),
  sketch_main_ino: z.string().min(1),
  additional_files: z.record(z.string(), z.string()).optional(),
  libraries: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// Dependency injection (F-003 testability)
// ---------------------------------------------------------------------------

/**
 * Things `buildApp` needs from outside. Production wiring: real cache +
 * real arduino-cli + computed-at-boot toolchain hash + `invokeArduinoCli`.
 * Tests can stub each independently.
 */
export interface CompileApiDeps {
  toolchainHash: string;
  bearerSecret: string;
  cacheGet: (key: string) => Promise<CacheEntry | null>;
  cachePut: (key: string, entry: CacheEntry) => Promise<void>;
  invokeArduinoCli: typeof invokeArduinoCli;
  /**
   * Liveness probe — return false to make GET /api/health respond 503.
   * Production: noop returning true. Tests: stub to simulate degraded
   * states (cache unwritable, AVR core gone) without producing them.
   */
  isHealthy: () => boolean | Promise<boolean>;
}

export interface BuildAppOptions {
  /**
   * Override the in-memory rate limit map (test-only). Default: a fresh
   * Map() per app build. Tests pass a shared map to assert window math.
   */
  rateLimitState?: Map<string, RateLimitState>;
  /**
   * Override the p-limit instance (test-only). Default: `pLimit(2)`.
   * Tests pass `pLimit(1)` to make queue depth easier to assert.
   */
  compileLimit?: ReturnType<typeof pLimit>;
}

interface RateLimitState {
  count: number;
  resetAt: number; // epoch ms
}

function takeFromBucket(
  state: Map<string, RateLimitState>,
  secret: string,
): boolean {
  const now = Date.now();
  const entry = state.get(secret);
  if (!entry || now > entry.resetAt) {
    state.set(secret, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count += 1;
  return true;
}

// ---------------------------------------------------------------------------
// App construction
// ---------------------------------------------------------------------------

/**
 * Build a Hono app wired to the given dependencies. Pure: no side
 * effects beyond constructing routes. Used by `startServer()` in
 * production and by integration tests via `app.request()`.
 */
export function buildApp(deps: CompileApiDeps, opts: BuildAppOptions = {}): Hono {
  const rateLimitState = opts.rateLimitState ?? new Map<string, RateLimitState>();
  const compileLimit = opts.compileLimit ?? pLimit(COMPILE_CONCURRENCY);

  const app = new Hono();

  // SEC-HONO-500-001 — suppress stack traces from the response body and
  // write a redacted single-line message to stderr. NEVER include the
  // full error object (which Bun's default would format with stack) in
  // either output.
  //
  // HTTPException (thrown by bearer-auth and other Hono middleware to
  // signal status + body) is intentionally NOT remapped — it carries
  // the right status (401, 403, etc.) and a known-safe body. Calling
  // err.getResponse() returns that response unchanged.
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    process.stderr.write(
      `[compile-api] unhandled exception: ${(err as Error).message}\n`,
    );
    return c.json(
      { ok: false, error: "internal-error", message: "internal server error" },
      500,
    );
  });

  // Health check — unauthed.
  // AC-005 — degraded state returns 503 so liveness probes (smoke
  // pre-flight, future load balancer) catch a server that started but
  // has lost its dependencies (cache unwritable, AVR core evicted via
  // volume mount).
  app.get("/api/health", async (c) => {
    const healthy = await deps.isHealthy();
    if (!healthy) {
      return c.json(
        {
          ok: false,
          error: "degraded",
          toolchain_version_hash: deps.toolchainHash,
        },
        503,
      );
    }
    return c.json({ ok: true, toolchain_version_hash: deps.toolchainHash });
  });

  // All /api/compile routes require Bearer auth.
  app.use("/api/compile", bearerAuth({ token: deps.bearerSecret }));

  app.post(
    "/api/compile",
    // Custom hook normalizes Zod's default 400 envelope into the
    // standard `{ok:false, error, ...}` shape every other server
    // response uses. Discriminator is always `ok`, never `success`.
    // AC-001.
    zValidator("json", CompileRequestSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          {
            ok: false,
            error: "bad-request",
            message: "request body failed schema validation",
            issues: result.error.issues,
          },
          400,
        );
      }
    }),
    async (c) => {
      // Rate limit (in-process, per-secret). v0.1 has one secret per
      // env so this is effectively a global limit; v0.2 will key on
      // per-IP too.
      if (!takeFromBucket(rateLimitState, deps.bearerSecret)) {
        return c.json(
          {
            ok: false,
            error: "rate-limit",
            message: `rate limit ${RATE_LIMIT_MAX} req / ${RATE_LIMIT_WINDOW_MS / 1000}s exceeded`,
          },
          429,
        );
      }

      // Queue-depth shed (PERF-003 + REL-003): pending + active >=
      // MAX_QUEUE_DEPTH means a tail request would wait past the
      // client-side timeout. Fail fast with 503 + Retry-After so the
      // client backs off intelligently rather than the server building
      // a graveyard queue of abandoned compiles.
      if (
        compileLimit.pendingCount + compileLimit.activeCount >=
        MAX_QUEUE_DEPTH
      ) {
        return c.json(
          {
            ok: false,
            error: "queue-full",
            message: `compile queue at capacity (${MAX_QUEUE_DEPTH}); retry in 5s`,
          },
          503,
          { "Retry-After": "5" },
        );
      }

      const body = c.req.valid("json");

      // --- Filename allowlist (single source of truth: pipeline/gates/library-allowlist.ts) ---
      const additional = body.additional_files ?? {};
      for (const filename of Object.keys(additional)) {
        const rejection = validateAdditionalFileName(filename);
        if (rejection !== null) {
          return c.json(
            {
              ok: false,
              error: "filename-allowlist",
              filename,
              reason: rejection.reason,
              rejection_kind: rejection.kind satisfies FilenameRejectionKind,
            },
            400,
          );
        }
      }

      // --- Cache lookup ---
      const key = cacheKey({
        toolchainHash: deps.toolchainHash,
        fqbn: body.fqbn,
        main_ino: body.sketch_main_ino,
        additional_files: additional,
        libraries: body.libraries,
      });
      const cached = await deps.cacheGet(key);
      if (cached) {
        return c.json({
          ok: true,
          artifact_b64: cached.hex_b64,
          artifact_kind: "hex",
          stderr: cached.stderr,
          cache_hit: true,
          toolchain_version_hash: deps.toolchainHash,
        });
      }

      // --- Compile under p-limit(2) ---
      const result = await compileLimit(async () => {
        const sketchResult = await createPerRequestSketchDir({
          main_ino: body.sketch_main_ino,
          additional_files: additional,
        });
        if (!sketchResult.ok) {
          // Defense in depth in case validators drift (the pre-request
          // pass should have caught the same case).
          return {
            httpStatus: 400 as const,
            body: {
              ok: false as const,
              error: "filename-allowlist" as const,
              filename: sketchResult.error.filename,
              reason: sketchResult.error.reason,
              rejection_kind: sketchResult.error.rejection_kind,
            },
          };
        }

        const { handle } = sketchResult;
        try {
          const compile = await deps.invokeArduinoCli({
            sketchDir: handle.path,
            fqbn: body.fqbn,
          });
          if (!compile.ok) {
            return {
              httpStatus: 200 as const,
              body: {
                ok: false as const,
                error: "compile-error" as const,
                stderr: compile.stderr,
              },
            };
          }
          // Cache the artifact for next time. REL-001 — wrapped because
          // a throw here was producing a 500 to the client even though
          // the compile succeeded; the hex was lost and the operator
          // had no log signal because the request logger is off.
          try {
            await deps.cachePut(key, {
              hex_b64: compile.hex_b64,
              stderr: compile.stderr,
            });
          } catch (err) {
            process.stderr.write(
              `[compile-api] WARN: cachePut(${key}) failed (compile result still returned): ${(err as Error).message}\n`,
            );
          }
          return {
            httpStatus: 200 as const,
            body: {
              ok: true as const,
              artifact_b64: compile.hex_b64,
              artifact_kind: "hex" as const,
              stderr: compile.stderr,
              cache_hit: false,
              toolchain_version_hash: deps.toolchainHash,
            },
          };
        } finally {
          await handle.cleanup();
        }
      });

      return c.json(result.body, result.httpStatus);
    },
  );

  return app;
}

// ---------------------------------------------------------------------------
// Production startup
// ---------------------------------------------------------------------------

/**
 * Boot the server. Reads env vars, asserts the secret length, computes
 * the toolchain hash, and binds the port. Throws (or process.exit(1) on
 * fatal env config) — caller is `if (import.meta.main)` below.
 *
 * Extracted from module-load (F-003) so importing this module from a
 * test runner does NOT bind a port or compute the toolchain hash.
 */
export async function startServer(): Promise<void> {
  const port = Number(process.env.PORT ?? 8787);
  const secret = process.env.COMPILE_API_SECRET ?? "";

  if (secret.length < MIN_SECRET_BYTES) {
    process.stderr.write(
      `[compile-api] FATAL: COMPILE_API_SECRET must be at least ${MIN_SECRET_BYTES} bytes ` +
        `(64 hex chars). Generate with: openssl rand -hex 32\n`,
    );
    process.exit(1);
  }

  let toolchainHash: string;
  try {
    toolchainHash = await computeToolchainVersionHash();
  } catch (err) {
    process.stderr.write(`[compile-api] FATAL: ${(err as Error).message}\n`);
    process.exit(1);
  }

  const cacheBytes = await cacheDirSize();
  if (cacheBytes > SIZE_WARN_BYTES) {
    process.stderr.write(
      `[compile-api] WARN: cache directory exceeds 4 GB ` +
        `(${(cacheBytes / 1024 / 1024 / 1024).toFixed(2)} GB). ` +
        `Eviction is a v0.2 cron task; consider manual cleanup.\n`,
    );
  }

  const app = buildApp({
    toolchainHash,
    bearerSecret: secret,
    cacheGet,
    cachePut,
    invokeArduinoCli,
    // Production liveness — the boot check ASSERTED arduino:avr was
    // present, so as long as the process is running and the cache dir
    // is not size-WARN, we report healthy. v0.2 should add a probe
    // that re-runs `arduino-cli core list --json` periodically.
    isHealthy: () => true,
  });

  Bun.serve({ port, fetch: app.fetch });

  process.stdout.write(
    JSON.stringify({
      event: "compile_api_started",
      port,
      toolchain_version_hash: toolchainHash,
      cache_dir_bytes: cacheBytes,
    }) + "\n",
  );
}

if (import.meta.main) {
  await startServer();
}
