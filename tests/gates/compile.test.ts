/**
 * Unit tests for the pipeline-side compile gate client.
 *
 * Covers the 6-way discriminated `CompileGateResult` failure union with
 * mocked `fetch`. Live integration against the Docker server lives in
 * `tests/compile-server.test.ts` (gated by VOLTEUX_COMPILE_SERVER_LIVE).
 */

import { describe, expect, test } from "bun:test";
import {
  runCompileGate,
  toGateResult,
  type CompileGateResult,
} from "../../pipeline/gates/compile.ts";

const validReq = {
  fqbn: "arduino:avr:uno",
  sketch_main_ino: "void setup(){}\nvoid loop(){}",
  libraries: [],
};

/** Build a fake fetch that returns the given Response on the first call. */
function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return ((url: string, init: RequestInit) => Promise.resolve(handler(url, init))) as unknown as typeof fetch;
}

/** Build a fake fetch that throws the given error. */
function throwingFetch(err: Error) {
  return (() => Promise.reject(err)) as unknown as typeof fetch;
}

describe("runCompileGate — happy path", () => {
  test("ok: true with hex_b64 + cache_hit on a 200 ok=true response", async () => {
    const fetchImpl = fakeFetch(() =>
      new Response(
        JSON.stringify({
          ok: true,
          artifact_b64: "aGVsbG8=",
          artifact_kind: "hex",
          stderr: "",
          cache_hit: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const result = await runCompileGate(validReq, {
      baseUrl: "http://test",
      secret: "x".repeat(32),
      fetch: fetchImpl,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hex_b64).toBe("aGVsbG8=");
      expect(result.value.cache_hit).toBe(false);
    }
  });

  test("propagates cache_hit: true when server reports cache hit", async () => {
    const fetchImpl = fakeFetch(() =>
      new Response(
        JSON.stringify({ ok: true, artifact_b64: "aGV4", cache_hit: true }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const result = await runCompileGate(validReq, {
      baseUrl: "http://test",
      secret: "x".repeat(32),
      fetch: fetchImpl,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.cache_hit).toBe(true);
  });
});

describe("runCompileGate — failure kinds (discriminated union)", () => {
  test("transport: ECONNREFUSED is mapped to kind:'transport', not throw", async () => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:8787");
    const result = await runCompileGate(validReq, {
      baseUrl: "http://nope:9999",
      secret: "x".repeat(32),
      fetch: throwingFetch(err),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("transport");
      expect(result.message).toContain("compile-api unreachable");
      expect(result.severity).toBe("red");
    }
  });

  test("timeout: AbortError is mapped to kind:'timeout'", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    const result = await runCompileGate(validReq, {
      baseUrl: "http://slow",
      secret: "x".repeat(32),
      fetch: throwingFetch(abortErr),
      timeoutMs: 100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("timeout");
  });

  test("auth: 401 from server is mapped to kind:'auth'", async () => {
    const fetchImpl = fakeFetch(() => new Response("Unauthorized", { status: 401 }));
    const result = await runCompileGate(validReq, {
      baseUrl: "http://test",
      secret: "x".repeat(32),
      fetch: fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("auth");
      expect(result.severity).toBe("red");
    }
  });

  test("rate-limited: 429 from server is mapped to kind:'rate-limited'", async () => {
    const fetchImpl = fakeFetch(() => new Response("Too Many Requests", { status: 429 }));
    const result = await runCompileGate(validReq, {
      baseUrl: "http://test",
      secret: "x".repeat(32),
      fetch: fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("rate-limited");
  });

  test("bad-request: 400 from server is mapped to kind:'bad-request' with errors[] AND populated message", async () => {
    const fetchImpl = fakeFetch(() =>
      new Response(
        JSON.stringify({
          ok: false,
          error: "filename_allowlist",
          filename: "-flag.h",
          reason: "does not match /...",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );
    const result = await runCompileGate(validReq, {
      baseUrl: "http://test",
      secret: "x".repeat(32),
      fetch: fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("bad-request");
      expect(result.errors.length).toBeGreaterThan(0);
      // T-006: message must come from body.reason (or body.message) — not
      // the default fallback. The orchestrator's auto-repair turn keys
      // off message for diagnostics.
      expect(result.message).toBe("does not match /...");
    }
  });

  test("bad-request: 400 with non-JSON body falls back to default message + empty errors[]", async () => {
    const fetchImpl = fakeFetch(() =>
      new Response("not-json garbage", { status: 400 }),
    );
    const result = await runCompileGate(validReq, {
      baseUrl: "http://test",
      secret: "x".repeat(32),
      fetch: fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("bad-request");
      // safeJson returned null → message falls back to the default fallback
      // string AND errors[] is empty (no body to JSON.stringify).
      expect(result.message).toBe("compile-api rejected request shape");
      expect(result.errors).toEqual([]);
    }
  });

  test("compile-error: 200 ok=false with stderr is mapped to kind:'compile-error'", async () => {
    const fetchImpl = fakeFetch(() =>
      new Response(
        JSON.stringify({
          ok: false,
          error: "compile_error",
          stderr: "sketch.ino:5:2: error: 'undefinedSymbol' was not declared in this scope",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const result = await runCompileGate(validReq, {
      baseUrl: "http://test",
      secret: "x".repeat(32),
      fetch: fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("compile-error");
      // stderr is surfaced verbatim in errors[] so the orchestrator's
      // auto-repair turn (Unit 9) can feed it back to Sonnet.
      expect(result.errors[0]).toContain("undefinedSymbol");
    }
  });

  test("transport (unexpected status): 503 from server is mapped to kind:'transport'", async () => {
    const fetchImpl = fakeFetch(() => new Response("Service Unavailable", { status: 503 }));
    const result = await runCompileGate(validReq, {
      baseUrl: "http://test",
      secret: "x".repeat(32),
      fetch: fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("transport");
  });

  test("transport (200 non-JSON): malformed response body is mapped to kind:'transport'", async () => {
    const fetchImpl = fakeFetch(() =>
      new Response("not-json", { status: 200, headers: { "Content-Type": "text/plain" } }),
    );
    const result = await runCompileGate(validReq, {
      baseUrl: "http://test",
      secret: "x".repeat(32),
      fetch: fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("transport");
  });

  test("transport (200 ok=true but no artifact_b64): malformed success body", async () => {
    const fetchImpl = fakeFetch(() =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await runCompileGate(validReq, {
      baseUrl: "http://test",
      secret: "x".repeat(32),
      fetch: fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("transport");
      expect(result.message).toContain("artifact_b64");
    }
  });
});

describe("runCompileGate — request shape", () => {
  test("includes Authorization: Bearer header from `secret` option", async () => {
    let capturedAuth = "";
    const fetchImpl = fakeFetch((_url, init) => {
      capturedAuth = String((init.headers as Record<string, string>).Authorization);
      return new Response(JSON.stringify({ ok: true, artifact_b64: "aGV4" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    await runCompileGate(validReq, {
      baseUrl: "http://test",
      secret: "supersecret-32-bytes-1234567890ab",
      fetch: fetchImpl,
    });
    expect(capturedAuth).toBe("Bearer supersecret-32-bytes-1234567890ab");
  });

  test("posts to `${baseUrl}/api/compile` with JSON body", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    const fetchImpl = fakeFetch((url, init) => {
      capturedUrl = String(url);
      capturedBody = String(init.body);
      return new Response(JSON.stringify({ ok: true, artifact_b64: "aGV4" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    await runCompileGate(validReq, {
      baseUrl: "http://test",
      secret: "x".repeat(32),
      fetch: fetchImpl,
    });
    expect(capturedUrl).toBe("http://test/api/compile");
    const parsed = JSON.parse(capturedBody);
    expect(parsed.fqbn).toBe("arduino:avr:uno");
    expect(parsed.sketch_main_ino).toContain("void setup");
    expect(parsed.libraries).toEqual([]);
  });

  test("defaults additional_files to empty object and libraries to empty array", async () => {
    let body: { additional_files?: unknown; libraries?: unknown } | null = null;
    const fetchImpl = fakeFetch((_url, init) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ ok: true, artifact_b64: "aGV4" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    await runCompileGate(
      { fqbn: "arduino:avr:uno", sketch_main_ino: "x" },
      { baseUrl: "http://test", secret: "x".repeat(32), fetch: fetchImpl },
    );
    expect(body!.additional_files).toEqual({});
    expect(body!.libraries).toEqual([]);
  });
});

describe("toGateResult", () => {
  test("preserves the ok branch", () => {
    const r: CompileGateResult = {
      ok: true,
      value: { hex_b64: "x", stderr: "", cache_hit: false },
    };
    const g = toGateResult(r);
    expect(g.ok).toBe(true);
    if (g.ok) expect(g.value.hex_b64).toBe("x");
  });

  test("strips `kind` from the failure branch", () => {
    const r: CompileGateResult = {
      ok: false,
      severity: "red",
      kind: "compile-error",
      message: "boom",
      errors: ["err1"],
    };
    const g = toGateResult(r);
    expect(g.ok).toBe(false);
    if (!g.ok) {
      expect(g.message).toBe("boom");
      expect(g.errors).toEqual(["err1"]);
      // No `kind` on a plain GateResult — verify by structural absence.
      expect((g as Record<string, unknown>).kind).toBeUndefined();
    }
  });
});
