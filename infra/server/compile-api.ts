/**
 * Compile API — Hono server.
 *
 *   POST /api/compile     — bearer-authed; runs arduino-cli on a sketch.
 *   GET  /api/health      — unauthed; returns { ok: true, toolchain_version_hash }
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
 * queue rather than thrash arduino-cli.
 *
 * Logger discipline: NEVER log the Authorization header, the API secret,
 * `process.env`, or any request body field that could carry secrets. The
 * Hono logger middleware here is intentionally NOT enabled by default —
 * the server's own structured stderr lines are the only log surface.
 *
 * Filename allowlist: imports `validateAdditionalFileName` from the
 * pipeline-side library-allowlist module. Single source of truth — the
 * cross-consistency gate (pipeline) and this server use the SAME
 * predicate. Defense in depth comes from running the predicate at TWO
 * sites, not from defining it twice. (Two literal copies were the bug
 * SEC-002 + ADV-003 demonstrated.)
 */

import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { zValidator } from "@hono/zod-validator";
import pLimit from "p-limit";
import { z } from "zod";
import { validateAdditionalFileName } from "../../pipeline/gates/library-allowlist.ts";
import {
  cacheDirSize,
  cacheGet,
  cacheKey,
  cachePut,
  computeToolchainVersionHash,
  SIZE_WARN_BYTES,
} from "./cache.ts";
import { createPerRequestSketchDir } from "./sketch-fs.ts";
import { runCompile } from "./run-compile.ts";

// ---------------------------------------------------------------------------
// Env + startup assertions
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 8787);
const SECRET = process.env.COMPILE_API_SECRET ?? "";
const MIN_SECRET_BYTES = 32;

if (SECRET.length < MIN_SECRET_BYTES) {
  // Direct stderr write to avoid any interpolation framework that might
  // accidentally log the (empty/short) secret value.
  process.stderr.write(
    `[compile-api] FATAL: COMPILE_API_SECRET must be at least ${MIN_SECRET_BYTES} bytes ` +
      `(64 hex chars). Generate with: openssl rand -hex 32\n`,
  );
  process.exit(1);
}

// Compute the toolchain version hash at boot. Failure (e.g., AVR core
// missing) throws; we log a clean message and exit so the operator catches
// it before any request lands.
let TOOLCHAIN_HASH: string;
try {
  TOOLCHAIN_HASH = await computeToolchainVersionHash();
} catch (err) {
  process.stderr.write(`[compile-api] FATAL: ${(err as Error).message}\n`);
  process.exit(1);
}

// Cache size health check at boot.
const cacheBytes = await cacheDirSize();
if (cacheBytes > SIZE_WARN_BYTES) {
  process.stderr.write(
    `[compile-api] WARN: cache directory exceeds 4 GB (${(cacheBytes / 1024 / 1024 / 1024).toFixed(2)} GB). ` +
      `Eviction is a v0.2 cron task; consider manual cleanup.\n`,
  );
}

// ---------------------------------------------------------------------------
// Concurrency + rate limit
// ---------------------------------------------------------------------------

const compileLimit = pLimit(2);

interface RateLimitState {
  count: number;
  resetAt: number; // epoch ms
}
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 10;
const rateLimitState = new Map<string, RateLimitState>();

function rateLimitTake(secret: string): boolean {
  const now = Date.now();
  const state = rateLimitState.get(secret);
  if (!state || now > state.resetAt) {
    rateLimitState.set(secret, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (state.count >= RATE_LIMIT_MAX) return false;
  state.count += 1;
  return true;
}

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
// Hono app
// ---------------------------------------------------------------------------

export const app = new Hono();

// Health check — unauthed. The smoke script (Unit 5) pings this before
// burning Anthropic tokens to verify the container is up.
app.get("/api/health", (c) =>
  c.json({ ok: true, toolchain_version_hash: TOOLCHAIN_HASH }),
);

// All /api/compile routes require Bearer auth.
app.use("/api/compile", bearerAuth({ token: SECRET }));

app.post(
  "/api/compile",
  zValidator("json", CompileRequestSchema),
  async (c) => {
    // Rate limit (in-process, per-secret). v0.1 has one secret per env so
    // this is effectively a global limit; v0.2 will key on per-IP too.
    if (!rateLimitTake(SECRET)) {
      return c.json(
        {
          ok: false,
          error: "rate_limited",
          message: `rate limit ${RATE_LIMIT_MAX} req / ${RATE_LIMIT_WINDOW_MS / 1000}s exceeded`,
        },
        429,
      );
    }

    const body = c.req.valid("json");

    // --- Filename allowlist (single source of truth: pipeline/gates/library-allowlist.ts) ---
    const additional = body.additional_files ?? {};
    for (const filename of Object.keys(additional)) {
      const reason = validateAdditionalFileName(filename);
      if (reason !== null) {
        return c.json(
          {
            ok: false,
            error: "filename_allowlist",
            filename,
            reason,
          },
          400,
        );
      }
    }

    // --- Cache lookup ---
    const key = cacheKey({
      toolchainHash: TOOLCHAIN_HASH,
      fqbn: body.fqbn,
      main_ino: body.sketch_main_ino,
      additional_files: additional,
      libraries: body.libraries,
    });
    const cached = await cacheGet(key);
    if (cached) {
      return c.json({
        ok: true,
        artifact_b64: cached.hex_b64,
        artifact_kind: "hex",
        stderr: cached.stderr,
        cache_hit: true,
      });
    }

    // --- Compile under p-limit(2) ---
    const result = await compileLimit(async () => {
      const sketchResult = await createPerRequestSketchDir({
        main_ino: body.sketch_main_ino,
        additional_files: additional,
      });
      if (!sketchResult.ok) {
        // Already validated above; this branch is defense in depth in case
        // the validators ever drift.
        return {
          httpStatus: 400 as const,
          body: {
            ok: false as const,
            error: "filename_allowlist" as const,
            filename: sketchResult.error.filename,
            reason: sketchResult.error.reason,
          },
        };
      }

      const { handle } = sketchResult;
      try {
        const compile = await runCompile({
          sketchDir: handle.path,
          fqbn: body.fqbn,
        });
        if (!compile.ok) {
          return {
            httpStatus: 200 as const,
            body: {
              ok: false as const,
              error: "compile_error" as const,
              stderr: compile.stderr,
            },
          };
        }
        // Cache the artifact for next time. Do this BEFORE responding so
        // an immediate retry hits the cache. REL-001 — `cachePut` is wrapped
        // because a throw here (ENOSPC, EACCES) was producing a 500 to the
        // client even though the compile succeeded; the hex artifact was
        // lost and the operator had no log signal because Hono's logger is
        // intentionally off. Now: log to stderr, return success anyway.
        try {
          await cachePut(key, {
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
          },
        };
      } finally {
        await handle.cleanup();
      }
    });

    return c.json(result.body, result.httpStatus);
  },
);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

if (import.meta.main) {
  Bun.serve({ port: PORT, fetch: app.fetch });
  // One structured stdout line on startup. No secret value, no env dump.
  // Direct stdout write avoids any logger middleware interpolation.
  process.stdout.write(
    JSON.stringify({
      event: "compile_api_started",
      port: PORT,
      toolchain_version_hash: TOOLCHAIN_HASH,
      cache_dir_bytes: cacheBytes,
    }) + "\n",
  );
}
