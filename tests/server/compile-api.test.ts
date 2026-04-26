/**
 * In-process integration tests for `infra/server/compile-api.ts`.
 *
 * Closes T-001 from the v0.1-pipeline-io review (the plan-slip — the
 * predecessor plan listed `tests/compile-server.test.ts` as a Unit 1
 * deliverable; manual Docker verification was done instead, but it was
 * not auditable or re-runnable in CI).
 *
 * These tests exercise the Hono app via `app.request()` (Hono's built-in
 * Web-Standard Request/Response API), with `buildApp` accepting injected
 * stubs for the cache, arduino-cli invocation, and toolchain hash
 * (F-003). No Docker container needed; no temp dirs created in the
 * "happy" mock path. The live integration test against a running Docker
 * container lives separately and is gated by `VOLTEUX_COMPILE_SERVER_LIVE=1`.
 *
 * Coverage:
 *   - Auth (401 missing/wrong; 200 valid)
 *   - Filename allowlist (rejection_kind enum surfaces; sketch.ino guard)
 *   - zValidator normalized 400 envelope (`{ok:false, error:"bad-request", issues}`)
 *   - Cache hit response shape (cache_hit:true + toolchain_version_hash)
 *   - Cold compile response shape (cache_hit:false + cachePut called)
 *   - cachePut throw → still 200 ok=true (REL-001)
 *   - Compile error → 200 ok=false with stderr verbatim
 *   - Rate limit (10 req/60s window + 11th gets 429 + envelope)
 *   - Queue depth cap (>=6 in-flight gets 503 + Retry-After)
 *   - Health: healthy → 200; degraded → 503
 *   - onError suppresses stack from response body
 */

import { describe, expect, test } from "bun:test";
import pLimit from "p-limit";
import {
  buildApp,
  type CompileApiDeps,
} from "../../infra/server/compile-api.ts";
import type { CacheEntry } from "../../infra/server/cache.ts";

// ---------------------------------------------------------------------------
// Test fixture / dep factory
// ---------------------------------------------------------------------------

const SECRET = "x".repeat(32);
const TOOLCHAIN_HASH = "deadbeef" + "0".repeat(56);

interface StubOpts {
  cacheGetReturns?: CacheEntry | null;
  cachePutThrows?: boolean;
  invokeArduinoCliReturns?:
    | { ok: true; hex_b64: string; stderr: string }
    | { ok: false; stderr: string };
  isHealthy?: boolean;
}

interface StubBundle {
  deps: CompileApiDeps;
  cachePutCalls: Array<{ key: string; entry: CacheEntry }>;
  /** Live counter — read after the request to assert. */
  readonly invokeCalls: () => number;
}

function makeDeps(opts: StubOpts = {}): StubBundle {
  const cachePutCalls: Array<{ key: string; entry: CacheEntry }> = [];
  let invokeCount = 0;
  const deps: CompileApiDeps = {
    toolchainHash: TOOLCHAIN_HASH,
    bearerSecret: SECRET,
    cacheGet: async () => opts.cacheGetReturns ?? null,
    cachePut: async (key, entry) => {
      if (opts.cachePutThrows) throw new Error("ENOSPC: simulated disk full");
      cachePutCalls.push({ key, entry });
    },
    invokeArduinoCli: async () => {
      invokeCount += 1;
      return (
        opts.invokeArduinoCliReturns ?? {
          ok: true as const,
          hex_b64: "aGVsbG8=", // "hello" — 5 bytes
          stderr: "Sketch uses 924 bytes (2%)",
        }
      );
    },
    isHealthy: () => opts.isHealthy ?? true,
  };
  return { deps, cachePutCalls, invokeCalls: () => invokeCount };
}

const validBody = {
  fqbn: "arduino:avr:uno",
  sketch_main_ino: "void setup(){}\nvoid loop(){}",
  libraries: [],
};

async function postCompile(
  app: ReturnType<typeof buildApp>,
  body: unknown,
  authHeader: string | null = `Bearer ${SECRET}`,
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authHeader !== null) headers.Authorization = authHeader;
  return await app.request("/api/compile", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe("POST /api/compile — auth", () => {
  test("missing Authorization header → 401", async () => {
    const { deps } = makeDeps();
    const app = buildApp(deps);
    const res = await postCompile(app, validBody, null);
    expect(res.status).toBe(401);
  });

  test("wrong secret → 401", async () => {
    const { deps } = makeDeps();
    const app = buildApp(deps);
    const res = await postCompile(app, validBody, "Bearer wrongsecret");
    expect(res.status).toBe(401);
  });

  test("correct secret → 200", async () => {
    const { deps } = makeDeps();
    const app = buildApp(deps);
    const res = await postCompile(app, validBody);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// zValidator normalized 400 envelope (AC-001)
// ---------------------------------------------------------------------------

describe("POST /api/compile — zValidator 400 normalization (AC-001)", () => {
  test("missing required fields → 400 with {ok:false, error:'bad-request', issues}", async () => {
    const { deps } = makeDeps();
    const app = buildApp(deps);
    const res = await postCompile(app, { fqbn: "" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("bad-request");
    expect(Array.isArray(body.issues)).toBe(true);
    // Critical: discriminator is `ok`, NOT zValidator's default `success`.
    expect(body.success).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Filename allowlist (W-001 enum)
// ---------------------------------------------------------------------------

describe("POST /api/compile — filename allowlist with rejection_kind (W-001)", () => {
  test("leading-dash filename → 400 with rejection_kind:'bad-extension'", async () => {
    const { deps } = makeDeps();
    const app = buildApp(deps);
    const res = await postCompile(app, {
      ...validBody,
      additional_files: { "-flag.h": "x" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("filename-allowlist");
    expect(body.filename).toBe("-flag.h");
    expect(body.rejection_kind).toBe("bad-extension");
  });

  test("consecutive dots → 400 with rejection_kind:'consecutive-dots'", async () => {
    const { deps } = makeDeps();
    const app = buildApp(deps);
    const res = await postCompile(app, {
      ...validBody,
      additional_files: { "test..h": "x" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.rejection_kind).toBe("consecutive-dots");
  });

  test("sketch.ino in additional_files → 400 with rejection_kind:'reserved-name' (ADV-002)", async () => {
    // sketch.ino passes validateAdditionalFileName; the sketch-fs server-
    // side guard in createPerRequestSketchDir is what catches it.
    // The pre-validation in compile-api.ts doesn't catch sketch.ino, so
    // the request reaches the inner branch which surfaces rejection_kind
    // = "reserved-name" from sketch-fs.
    const { deps } = makeDeps();
    const app = buildApp(deps);
    const res = await postCompile(app, {
      ...validBody,
      additional_files: { "sketch.ino": "void setup(){/*malicious*/}" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("filename-allowlist");
    expect(body.filename).toBe("sketch.ino");
    expect(body.rejection_kind).toBe("reserved-name");
  });
});

// ---------------------------------------------------------------------------
// Cache hit + cold path
// ---------------------------------------------------------------------------

describe("POST /api/compile — cache hit", () => {
  test("cache hit returns artifact + cache_hit:true + toolchain_version_hash, skips arduino-cli", async () => {
    const stub = makeDeps({
      cacheGetReturns: { hex_b64: "Y2FjaGVk", stderr: "from cache" },
    });
    const app = buildApp(stub.deps);
    const res = await postCompile(app, validBody);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.artifact_b64).toBe("Y2FjaGVk");
    expect(body.cache_hit).toBe(true);
    expect(body.toolchain_version_hash).toBe(TOOLCHAIN_HASH);
    expect(stub.invokeCalls()).toBe(0);
  });
});

describe("POST /api/compile — cold compile", () => {
  test("cold path returns artifact + cache_hit:false + writes cache", async () => {
    const stub = makeDeps();
    const app = buildApp(stub.deps);
    const res = await postCompile(app, validBody);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.artifact_b64).toBe("aGVsbG8=");
    expect(body.cache_hit).toBe(false);
    expect(stub.cachePutCalls.length).toBe(1);
    expect(stub.cachePutCalls[0]?.entry.hex_b64).toBe("aGVsbG8=");
  });

  test("cachePut throw → still 200 ok=true with hex (REL-001)", async () => {
    const stub = makeDeps({ cachePutThrows: true });
    const app = buildApp(stub.deps);
    const res = await postCompile(app, validBody);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.artifact_b64).toBe("aGVsbG8=");
    // The hex artifact MUST NOT be lost just because the cache write
    // failed. This is the regression REL-001 closes.
  });

  test("compile error → 200 ok=false with stderr verbatim", async () => {
    const stub = makeDeps({
      invokeArduinoCliReturns: {
        ok: false,
        stderr: "sketch.ino:1:1: error: expected unqualified-id before 'this'",
      },
    });
    const app = buildApp(stub.deps);
    const res = await postCompile(app, validBody);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("compile-error");
    expect(body.stderr).toContain("error: expected unqualified-id");
  });
});

// ---------------------------------------------------------------------------
// Rate limit (10/60s)
// ---------------------------------------------------------------------------

describe("POST /api/compile — rate limit", () => {
  test("11th request in window → 429 with envelope", async () => {
    const { deps } = makeDeps();
    const app = buildApp(deps);
    // First 10 succeed
    for (let i = 0; i < 10; i++) {
      const res = await postCompile(app, validBody);
      expect(res.status).toBe(200);
    }
    // 11th gets rate limited
    const res = await postCompile(app, validBody);
    expect(res.status).toBe(429);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("rate-limit");
  });
});

// ---------------------------------------------------------------------------
// Queue-depth cap (round-2 T-007 / COR-R2-002 closure)
// ---------------------------------------------------------------------------

describe("POST /api/compile — queue-depth cap (PERF-003 + REL-003)", () => {
  test("requests past MAX_QUEUE_DEPTH return 503 with Retry-After + queue-full envelope", async () => {
    // Inject pLimit(1) so the depth math is trivial: only 1 active slot,
    // and the cap triggers at 6 in-flight (active + pending). Suspend
    // arduino-cli on a shared release signal so the test can free all
    // queued requests in one go.
    let releaseAll: () => void = () => {};
    const releasePromise = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    const stub = makeDeps();
    const blockingDeps: CompileApiDeps = {
      ...stub.deps,
      invokeArduinoCli: async () => {
        await releasePromise;
        return { ok: true as const, hex_b64: "aGVsbG8=", stderr: "" };
      },
    };
    // Round-2 had to write this test specifically — round-1 added
    // `compileLimit` to BuildAppOptions for exactly this purpose but no
    // test ever used it.
    const app = buildApp(blockingDeps, {
      compileLimit: pLimit(1),
    });

    // Fire 6 requests; the 6th saturates the cap at active + pending = 6
    // (1 active + 5 pending). Don't await them.
    const inFlight: Array<Promise<Response>> = [];
    for (let i = 0; i < 6; i++) {
      inFlight.push(postCompile(app, validBody));
    }
    // Yield to the event loop so all 6 enter the pLimit queue before
    // the 7th request fires its check.
    await new Promise((r) => setTimeout(r, 0));

    // 7th request hits the cap.
    const overflow = await postCompile(app, validBody);
    expect(overflow.status).toBe(503);
    expect(overflow.headers.get("Retry-After")).toBe("30");
    const body = (await overflow.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("queue-full");

    // Release ALL queued requests at once so the test doesn't hang.
    releaseAll();
    await Promise.all(inFlight);
  });
});

// ---------------------------------------------------------------------------
// Round-2 isHealthy throws → 503 (REL-007)
// ---------------------------------------------------------------------------

describe("GET /api/health — isHealthy throw → 503 (REL-007)", () => {
  test("isHealthy that throws is treated as degraded, not 500", async () => {
    const { deps } = makeDeps();
    const throwingDeps: CompileApiDeps = {
      ...deps,
      isHealthy: () => {
        throw new Error("simulated probe failure");
      },
    };
    const app = buildApp(throwingDeps);
    const res = await app.request("/api/health");
    // Round-2: round-1 would return 500 here (uncaught throw → onError).
    // Now the route handler catches and returns 503 (degraded).
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("degraded");
  });
});

// ---------------------------------------------------------------------------
// Round-2 401 envelope normalization (AC-009)
// ---------------------------------------------------------------------------

describe("POST /api/compile — 401 envelope (AC-009)", () => {
  test("missing header → 401 JSON envelope (not Hono's plain-text default)", async () => {
    const { deps } = makeDeps();
    const app = buildApp(deps);
    const res = await postCompile(app, validBody, null);
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("auth");
  });

  test("wrong secret → 401 JSON envelope", async () => {
    const { deps } = makeDeps();
    const app = buildApp(deps);
    const res = await postCompile(app, validBody, "Bearer wrongsecret");
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("auth");
  });
});

// ---------------------------------------------------------------------------
// Round-2 zValidator vs rate-limit ordering (ADV-R2-003)
// ---------------------------------------------------------------------------

describe("POST /api/compile — invalid-body floods consume rate-limit tokens (ADV-R2-003)", () => {
  test("11 invalid-body requests still get rate-limited (round-1: rate-limit ran AFTER zValidator and invalid bodies bypassed it)", async () => {
    const { deps } = makeDeps();
    const app = buildApp(deps);
    // First 10 invalid-body requests consume rate-limit tokens AND get
    // rejected by zValidator with 400.
    for (let i = 0; i < 10; i++) {
      const res = await postCompile(app, { fqbn: "" });
      expect(res.status).toBe(400);
    }
    // 11th gets rate-limited BEFORE zValidator — proves the middleware
    // ordering fix (rate-limit middleware runs first now).
    const res = await postCompile(app, { fqbn: "" });
    expect(res.status).toBe(429);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("rate-limit");
  });
});

// ---------------------------------------------------------------------------
// Health 503 path (AC-005)
// ---------------------------------------------------------------------------

describe("GET /api/health", () => {
  test("healthy → 200 with toolchain_version_hash", async () => {
    const { deps } = makeDeps();
    const app = buildApp(deps);
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.toolchain_version_hash).toBe(TOOLCHAIN_HASH);
  });

  test("degraded (isHealthy returns false) → 503 with error:'degraded' (AC-005)", async () => {
    const { deps } = makeDeps({ isHealthy: false });
    const app = buildApp(deps);
    const res = await app.request("/api/health");
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("degraded");
    // Toolchain hash still present so a probe can correlate.
    expect(body.toolchain_version_hash).toBe(TOOLCHAIN_HASH);
  });
});

// ---------------------------------------------------------------------------
// onError suppresses stack (SEC-HONO-500-001)
// ---------------------------------------------------------------------------

describe("POST /api/compile — onError stack suppression (SEC-HONO-500-001)", () => {
  test("uncaught exception in arduino-cli stub → 500 with generic body, no stack", async () => {
    const { deps } = makeDeps();
    const failingDeps: CompileApiDeps = {
      ...deps,
      invokeArduinoCli: async () => {
        throw new Error("simulated unhandled exception with /opt/secret/path");
      },
    };
    const app = buildApp(failingDeps);
    const res = await postCompile(app, validBody);
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("internal-error");
    // The body MUST NOT echo the underlying error message (which could
    // disclose internal paths or context). It contains only a generic
    // string.
    expect(body.message).toBe("internal server error");
    expect(JSON.stringify(body)).not.toContain("/opt/secret/path");
    expect(JSON.stringify(body)).not.toContain("simulated unhandled");
  });
});
