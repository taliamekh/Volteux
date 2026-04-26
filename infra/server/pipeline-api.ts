/**
 * Pipeline API — Hono server.
 *
 *   POST /api/pipeline       — accepts { prompt }; runs the full pipeline
 *                              (classify → generate → schema → xc → rules
 *                              → compile) and returns the discriminated
 *                              PipelineResult JSON. CORS-allowed for the
 *                              Vite dev origin.
 *   GET  /api/pipeline/health — unauthed liveness probe; 200 if the deps
 *                              factory can construct (env present, prompt
 *                              files readable). Used by the frontend's
 *                              loading view as a pre-flight.
 *
 * Auth: NONE in v0 (local-only dev). Production deploy (v0.2 VPS) gates
 * via reverse-proxy + Turnstile per `infra/deploy.md`.
 *
 * CORS: explicit allowlist for the Vite dev origin (default
 * http://127.0.0.1:5174). Override via PIPELINE_API_CORS_ORIGIN env. The
 * production deploy disables permissive CORS — that's a v1.0 concern
 * when the UI integrates against a hosted endpoint.
 *
 * Concurrency: a single in-flight pipeline run per process. Pipeline runs
 * are 15-30s wall-clock and cost ~$0.05; queueing concurrent requests is
 * the right default for v0 dev (a busy click on the prompt button
 * shouldn't fan out 4 simultaneous Sonnet calls).
 *
 * Logger discipline: NEVER log the prompt body, the Authorization
 * header, or `process.env`. The Hono logger middleware is intentionally
 * not enabled; runtime errors emit a single redacted line via the
 * `app.onError` hook.
 *
 * Testability: `buildApp(deps)` is a pure factory; `startServer()` runs
 * the side-effecting boot. Tests construct the bundle inline at the
 * `buildApp` call site.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { runPipeline, type PipelineResult } from "../../pipeline/index.ts";

const DEFAULT_PORT = 8788;
const DEFAULT_CORS_ORIGIN = "http://127.0.0.1:5174";
const MAX_PROMPT_CHARS = 5000;

export interface PipelineApiDeps {
  /**
   * Pipeline runner. Tests inject a mock that returns canned
   * PipelineResult shapes; production wiring uses the real
   * `runPipeline` from `../../pipeline/index.ts`.
   */
  runPipeline: (
    prompt: string,
    opts?: { signal?: AbortSignal },
  ) => Promise<PipelineResult>;
}

/**
 * Build the Hono app. Pure factory: no env reads, no listen.
 *
 * The single-flight gate is per-app-instance so tests can construct
 * fresh apps without leaking concurrency state across cases.
 */
export function buildApp(deps: PipelineApiDeps, opts: { corsOrigin?: string } = {}): Hono {
  const app = new Hono();
  const corsOrigin = opts.corsOrigin ?? DEFAULT_CORS_ORIGIN;
  let inFlight: Promise<PipelineResult> | null = null;

  app.use(
    "/api/*",
    cors({
      origin: corsOrigin,
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type"],
      maxAge: 600,
    }),
  );

  app.get("/api/pipeline/health", (c) => {
    return c.json({ ok: true, name: "pipeline-api" });
  });

  app.post("/api/pipeline", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { ok: false, error: "bad-request", message: "request body must be valid JSON" },
        400,
      );
    }

    if (typeof body !== "object" || body === null) {
      return c.json(
        { ok: false, error: "bad-request", message: 'expected JSON object with a "prompt" field' },
        400,
      );
    }
    const prompt = (body as { prompt?: unknown }).prompt;
    if (typeof prompt !== "string") {
      return c.json(
        { ok: false, error: "bad-request", message: '"prompt" must be a string' },
        400,
      );
    }
    const trimmed = prompt.trim();
    if (trimmed.length === 0) {
      return c.json(
        { ok: false, error: "bad-request", message: '"prompt" must not be empty' },
        400,
      );
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      return c.json(
        {
          ok: false,
          error: "bad-request",
          message: `"prompt" exceeds ${MAX_PROMPT_CHARS} characters`,
        },
        400,
      );
    }

    if (inFlight !== null) {
      return c.json(
        {
          ok: false,
          error: "queue-full",
          message:
            "another pipeline run is already in progress; v0 single-flight gate is per-process",
        },
        503,
        { "Retry-After": "30" },
      );
    }

    const controller = new AbortController();
    const promise = deps.runPipeline(prompt, { signal: controller.signal });
    inFlight = promise;
    try {
      const result = await promise;
      return c.json(result);
    } finally {
      inFlight = null;
    }
  });

  app.onError((err, c) => {
    // Single redacted stderr line; never echo prompt content.
    const name = err instanceof Error ? err.name : "Unknown";
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[pipeline-api] error: ${name}: ${message}\n`);
    return c.json(
      { ok: false, error: "internal-error", message: "internal server error" },
      500,
    );
  });

  return app;
}

/**
 * Side-effecting boot. Reads PIPELINE_API_PORT + PIPELINE_API_CORS_ORIGIN
 * from env at call time. Production callers run this; tests do not.
 */
export function startServer(): void {
  const port = Number(process.env.PIPELINE_API_PORT ?? DEFAULT_PORT);
  const corsOrigin = process.env.PIPELINE_API_CORS_ORIGIN ?? DEFAULT_CORS_ORIGIN;

  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    process.stderr.write(
      `[pipeline-api] FATAL: PIPELINE_API_PORT must be a valid TCP port (1-65535), got: ${process.env.PIPELINE_API_PORT}\n`,
    );
    process.exit(1);
  }

  const app = buildApp({ runPipeline }, { corsOrigin });

  // Bun.serve on the configured port.
  Bun.serve({
    port,
    fetch: app.fetch,
  });

  process.stdout.write(
    `[pipeline-api] listening on http://127.0.0.1:${port} (CORS allow-origin: ${corsOrigin})\n`,
  );
}

if (import.meta.main) {
  startServer();
}
