/**
 * Unit tests for the pipeline-side compile gate client.
 *
 * Covers the 6-way discriminated `CompileGateResult` failure union with
 * mocked `fetch`. Live integration against the Docker server lives in
 * `tests/compile-server.test.ts` (gated by VOLTEUX_COMPILE_SERVER_LIVE).
 */

import { describe, expect, test } from "bun:test";
import { runCompileGate } from "../../pipeline/gates/compile.ts";

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
          toolchain_version_hash: "abc123",
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
        JSON.stringify({
          ok: true,
          artifact_b64: "aGV4",
          cache_hit: true,
          toolchain_version_hash: "abc123",
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
    if (result.ok) expect(result.value.cache_hit).toBe(true);
  });

  // W-002 — telemetry surface for Unit 9's trace writer.
  test("populates latency_ms, hex_size_bytes, toolchain_version_hash on success", async () => {
    const fetchImpl = fakeFetch(() =>
      new Response(
        JSON.stringify({
          ok: true,
          artifact_b64: "aGVsbG8=", // decodes to "hello" (5 bytes)
          cache_hit: false,
          toolchain_version_hash: "abc123", // required (round-2 AC-013)
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
      expect(result.value.latency_ms).toBeGreaterThanOrEqual(0);
      // 8-char base64 with one padding char → 5 decoded bytes.
      expect(result.value.hex_size_bytes).toBe(5);
      expect(result.value.toolchain_version_hash).toBe("abc123");
    }
  });

  test("toolchain_version_hash is REQUIRED — a server response omitting it is a contract violation routed as kind:'transport'", async () => {
    // Round-2 AC-013: round-1 made the field optional in the success
    // schema; the type contract was looser than the wire contract. Now
    // the schema requires it — a missing field fails the schema parse
    // and the gate surfaces kind:'transport' with the schema error.
    const fetchImpl = fakeFetch(() =>
      new Response(
        JSON.stringify({ ok: true, artifact_b64: "aGV4", cache_hit: false }),
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
      expect(result.kind).toBe("transport");
      // Zod's union-discriminator failure produces a generic "Invalid
      // input" summary when the response satisfies neither branch
      // (success without toolchain_version_hash AND not an error
      // envelope). The message names the schema failure even when the
      // exact missing field can't be pinpointed.
      expect(result.message).toContain("envelope schema");
    }
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

  test("rate-limit: 429 from server is mapped to kind:'rate-limit'", async () => {
    const fetchImpl = fakeFetch(() => new Response("Too Many Requests", { status: 429 }));
    const result = await runCompileGate(validReq, {
      baseUrl: "http://test",
      secret: "x".repeat(32),
      fetch: fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("rate-limit");
  });

  test("bad-request: 400 from filename allowlist surfaces reason in errors[] AND populates message", async () => {
    // Server-side wire shape after AC-001/AC-003 normalization:
    //   {ok: false, error: "filename-allowlist", filename, reason}
    const fetchImpl = fakeFetch(() =>
      new Response(
        JSON.stringify({
          ok: false,
          error: "filename-allowlist",
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
      // AC-002: errors[] now carries the structured reason verbatim,
      // not a JSON.stringify blob. Sonnet's auto-repair turn can read it
      // directly without re-parsing.
      expect(result.errors).toEqual(["does not match /..."]);
      expect(result.message).toBe("does not match /...");
    }
  });

  test("bad-request: 400 from zValidator surfaces structured ZodIssues in errors[]", async () => {
    // AC-001: server's custom hook normalizes Zod's default 400 shape
    // into the standard envelope with `issues` populated. AC-002: each
    // issue becomes a `path: message` line in errors[].
    const fetchImpl = fakeFetch(() =>
      new Response(
        JSON.stringify({
          ok: false,
          error: "bad-request",
          message: "request body failed schema validation",
          issues: [
            { code: "too_small", path: ["fqbn"], message: "String must contain at least 1 character(s)" },
            { code: "invalid_type", path: ["sketch_main_ino"], message: "Required" },
          ],
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
      expect(result.message).toBe("request body failed schema validation");
      expect(result.errors).toEqual([
        "fqbn: String must contain at least 1 character(s)",
        "sketch_main_ino: Required",
      ]);
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
      // parseErrorResponse returned null → message falls back to the
      // default string and errors[] is empty.
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

  test("queue-full: 503 from server is mapped to kind:'queue-full' with retry_after_s parsed from header", async () => {
    // Round-2 AN-R2-001 + AC-011: round-1 routed all 503s to the
    // generic transport branch and silently dropped the Retry-After
    // header. The gate now has an explicit 503 branch that surfaces
    // queue-full and parses Retry-After.
    const fetchImpl = fakeFetch(() =>
      new Response(
        JSON.stringify({
          ok: false,
          error: "queue-full",
          message: "compile queue at capacity (6); retry in 30s",
        }),
        {
          status: 503,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "30",
          },
        },
      ),
    );
    const result = await runCompileGate(validReq, {
      baseUrl: "http://test",
      secret: "x".repeat(32),
      fetch: fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("queue-full");
      expect(result.retry_after_s).toBe(30);
      expect(result.message).toContain("retry in 30s");
    }
  });

  test("queue-full: 503 with no Retry-After header omits retry_after_s", async () => {
    const fetchImpl = fakeFetch(() =>
      new Response(
        JSON.stringify({ ok: false, error: "queue-full", message: "queued" }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      ),
    );
    const result = await runCompileGate(validReq, {
      baseUrl: "http://test",
      secret: "x".repeat(32),
      fetch: fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("queue-full");
      expect(result.retry_after_s).toBeUndefined();
    }
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
      // Round-2: schema-failed message no longer hardcodes
      // "artifact_b64" since toolchain_version_hash is also required
      // and could be the missing field. The Zod summary names the path
      // when one is identifiable.
      expect(result.message).toContain("envelope schema");
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

