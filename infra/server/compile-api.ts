/**
 * Compile API — Hono server.
 *
 *   POST /api/compile     — bearer-authed; runs arduino-cli on a sketch.
 *   GET  /api/health      — unauthed; returns 200 healthy / 503 degraded.
 *
 * Auth: `Authorization: Bearer <COMPILE_API_SECRET>`. Server REFUSES TO
 * START unless the secret is at least 32 bytes — prevents the "test"
 * placeholder from ever shipping past local dev. Custom 401/400 hooks on
 * the bearer middleware emit the same `{ok:false, error, message}`
 * envelope as every other server response (round-2 AC-009: round-1
 * shipped Hono's plain-text "Unauthorized" default).
 *
 * Rate limit: a small in-process token bucket (10 req / 60s per secret).
 * The check runs as a route-level middleware BEFORE `zValidator` so an
 * invalid-body flood does NOT escape the rate limit while still
 * triggering Bun-side body buffering (round-2 ADV-R2-003).
 *
 * Concurrency: `pLimit(2)` matches CX22's vCPU count; concurrent requests
 * queue rather than thrash arduino-cli. The queue is depth-capped at
 * MAX_QUEUE_DEPTH; the cap is checked AFTER the cache lookup so cache
 * hits never count against it AND there's no async yield between the
 * check and `compileLimit(...)` enqueue (round-2 COR-R2-001 closed the
 * TOCTOU race the round-1 cap had).
 *
 * Logger discipline: NEVER log the Authorization header, the API secret,
 * `process.env`, or any request body field that could carry secrets. The
 * Hono logger middleware is intentionally NOT enabled. The custom
 * `app.onError` hook writes a single redacted line to stderr and returns
 * a generic 500 body; HTTPException is short-circuited via
 * `err.getResponse()` so middleware-thrown statuses (auth 401, etc.)
 * keep their semantic codes.
 *
 * Filename allowlist: imports `validateAdditionalFileName` from the
 * pipeline-side library-allowlist module. Single source of truth — the
 * cross-consistency gate (pipeline) and this server use the SAME
 * predicate. Defense in depth comes from running the predicate at TWO
 * sites, not from defining it twice. (Two literal copies were the bug
 * SEC-002 + ADV-003 demonstrated.)
 *
 * Testability: `buildApp(deps)` is a pure factory; `startServer()` runs
 * the side-effecting boot. Test hooks (rateLimitState, compileLimit
 * overrides) live in an `_internalTestHooks` parameter that callers in
 * production never pass — the type signature itself documents the
 * intent (round-2 M2-002 / R2-K-004 / AC-012: round-1 shipped these
 * hooks on a public `BuildAppOptions` interface that no test actually
 * used).
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bearerAuth } from "hono/bearer-auth";
import { zValidator } from "@hono/zod-validator";
import pLimit from "p-limit";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { validateAdditionalFileName } from "../../pipeline/gates/library-allowlist.ts";
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
 *
 * Round-2 raised the documented `Retry-After` from 5s to 30s — at
 * MAX_QUEUE_DEPTH=6 the realistic drain is ~30s, and Retry-After: 5 was
 * encouraging agent retry storms (AN-R2-005).
 */
const MAX_QUEUE_DEPTH = 6;
const QUEUE_FULL_RETRY_AFTER_S = 30;

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
   * Round-2 REL-007: implementations that THROW are caught and treated
   * as `false` (degraded) rather than propagating to a 500.
   */
  isHealthy: () => boolean | Promise<boolean>;
}

interface RateLimitState {
  count: number;
  resetAt: number; // epoch ms
}

/**
 * Test-only hooks. Production callers MUST NOT pass this — the
 * underscore-prefix + this docstring + the lack of an `export` on the
 * type itself signal that. Tests construct the bundle inline at the
 * `buildApp` call site so a future production caller can't accidentally
 * import a public test-only type (round-2 M2-002 / R2-K-004 / AC-012).
 */
interface InternalTestHooks {
  rateLimitState?: Map<string, RateLimitState>;
  compileLimit?: ReturnType<typeof pLimit>;
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
 *
 * The optional second parameter (`_internalTestHooks`) is intentionally
 * not exported and not documented as part of the production contract.
 * Production callers in `startServer()` omit it entirely.
 */
export function buildApp(
  deps: CompileApiDeps,
  _internalTestHooks: InternalTestHooks = {},
): Hono {
  const rateLimitState =
    _internalTestHooks.rateLimitState ?? new Map<string, RateLimitState>();
  const compileLimit =
    _internalTestHooks.compileLimit ?? pLimit(COMPILE_CONCURRENCY);

  const app = new Hono();

  // SEC-HONO-500-001 — suppress stack traces from the response body and
  // write a redacted single-line message to stderr. NEVER include the
  // full error object (which Bun's default would format with stack) in
  // either output. Each request gets a short correlation ID echoed in
  // both the stderr line and the 500 body so an operator can correlate
  // (round-2 AN-R2-003).
  //
  // HTTPException (thrown by bearer-auth and other Hono middleware to
  // signal status + body) is intentionally NOT remapped — the bearer
  // middleware's hooks (configured below) already emit the standard
  // envelope, so HTTPException carries that envelope and getResponse()
  // returns it unchanged.
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    const requestId = randomUUID().slice(0, 8);
    process.stderr.write(
      `[compile-api] unhandled exception (request_id=${requestId}): ${(err as Error).message}\n`,
    );
    return c.json(
      {
        ok: false,
        error: "internal-error",
        message: "internal server error",
        request_id: requestId,
      },
      500,
    );
  });

  // Health check — unauthed.
  // AC-005 — degraded state returns 503 so liveness probes (smoke
  // pre-flight, future load balancer) catch a server that started but
  // has lost its dependencies (cache unwritable, AVR core evicted via
  // volume mount). Round-2 REL-007: an isHealthy implementation that
  // throws is caught here and treated as degraded — load balancers
  // expect 503 (shed) not 500 (process broken / restart) for a server
  // that's up but unhealthy.
  app.get("/api/health", async (c) => {
    let healthy = false;
    try {
      healthy = await deps.isHealthy();
    } catch (err) {
      process.stderr.write(
        `[compile-api] WARN: isHealthy() threw, treating as degraded: ${(err as Error).message}\n`,
      );
    }
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

  // All /api/compile routes require Bearer auth. The custom hooks
  // (round-2 AC-009) override Hono's plain-text 401/400 defaults so
  // every server response carries the standard `{ok:false, error, ...}`
  // envelope (discriminator is `ok`, never `success`).
  app.use(
    "/api/compile",
    bearerAuth({
      token: deps.bearerSecret,
      noAuthenticationHeader: {
        message: {
          ok: false,
          error: "auth",
          message: "missing Authorization header",
        },
      },
      invalidAuthenticationHeader: {
        message: {
          ok: false,
          error: "auth",
          message: "malformed Authorization header",
        },
      },
      invalidToken: {
        message: {
          ok: false,
          error: "auth",
          message: "invalid bearer token",
        },
      },
    }),
  );

  // Rate limit MUST run before zValidator (round-2 ADV-R2-003): if
  // zValidator runs first, an invalid-body flood (large bodies, malformed
  // JSON) bypasses the rate limit entirely because zValidator returns 400
  // before the rate-limit handler ever fires.
  app.use("/api/compile", async (c, next) => {
    if (c.req.method !== "POST") return next();
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
    return next();
  });

  app.post(
    "/api/compile",
    // Custom hook normalizes Zod's default 400 envelope into the
    // standard `{ok:false, error, ...}` shape every other server
    // response uses. AC-001.
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
      const body = c.req.valid("json");

      // --- Filename allowlist (single source of truth) ---
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
              // W-001: structured rejection class — agent callers switch
              // on it without parsing free text.
              rejection_kind: rejection.kind,
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

      // --- Queue-depth cap (round-2 COR-R2-001 closure) ---
      // The cap check must run AFTER the cache lookup (so cache hits
      // skip it entirely) AND immediately before `compileLimit(...)` so
      // there's no async yield between the check and the enqueue. The
      // round-1 placement was BEFORE the cache lookup — `await
      // deps.cacheGet(key)` was an async yield point, and concurrent
      // requests could all pass the check during the cache-lookup
      // window before any of them entered the queue.
      if (
        compileLimit.pendingCount + compileLimit.activeCount >=
        MAX_QUEUE_DEPTH
      ) {
        return c.json(
          {
            ok: false,
            error: "queue-full",
            message: `compile queue at capacity (${MAX_QUEUE_DEPTH}); retry in ${QUEUE_FULL_RETRY_AFTER_S}s`,
          },
          503,
          { "Retry-After": String(QUEUE_FULL_RETRY_AFTER_S) },
        );
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
          // the compile succeeded; the hex was lost. Round-2 COR-R2-004:
          // the inner `process.stderr.write` is itself wrapped so an
          // EPIPE on stderr doesn't propagate either.
          try {
            await deps.cachePut(key, {
              hex_b64: compile.hex_b64,
              stderr: compile.stderr,
            });
          } catch (err) {
            try {
              process.stderr.write(
                `[compile-api] WARN: cachePut(${key}) failed (compile result still returned): ${(err as Error).message}\n`,
              );
            } catch {
              // stderr is broken; nothing to do but proceed. The hex
              // result is still returned to the client below.
            }
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
    // that re-runs `arduino-cli core list --json` periodically (and
    // the round-2 REL-007 try/catch in the route handler ensures a
    // throw from that probe is treated as 503, not 500).
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
