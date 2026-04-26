/**
 * Tests for `infra/server/pipeline-api.ts`.
 *
 * The Hono app is constructed via `buildApp({runPipeline})` with a mock
 * runner that returns canned PipelineResult shapes. This proves the
 * server's request/response wiring without invoking real Anthropic / arduino-cli.
 */

import { describe, expect, test } from "bun:test";
import { buildApp } from "../../infra/server/pipeline-api.ts";
import type { PipelineResult } from "../../pipeline/index.ts";

interface MockRunPipelineCall {
  prompt: string;
}

function makeApp(
  runPipeline: (prompt: string, opts?: { signal?: AbortSignal }) => Promise<PipelineResult>,
  opts: { corsOrigin?: string } = {},
) {
  return buildApp({ runPipeline }, opts);
}

const SUCCESS_RESULT: PipelineResult = {
  ok: true,
  // The doc field is typed as VolteuxProjectDocument; tests don't need a
  // realistic shape because the server passes it through verbatim.
  doc: { archetype_id: "uno-ultrasonic-servo" } as never,
  hex_b64: "AAEC",
  cost_usd: 0.05,
  run_id: "20260426-test",
  amber: [],
  blue: [],
};

const HONEST_GAP_RESULT: PipelineResult = {
  ok: false,
  severity: "red",
  kind: "out-of-scope",
  message: "out of scope",
  errors: ["classifier rejected"],
  honest_gap: {
    scope: "out-of-scope",
    missing_capabilities: ["load cell"],
    explanation: "Your idea needs a load cell, which v0 does not support.",
  },
  cost_usd: 0.001,
  run_id: "20260426-oos",
};

describe("pipeline-api — POST /api/pipeline", () => {
  test("happy path returns the success PipelineResult verbatim", async () => {
    const calls: MockRunPipelineCall[] = [];
    const app = makeApp(async (prompt) => {
      calls.push({ prompt });
      return SUCCESS_RESULT;
    });

    const res = await app.fetch(
      new Request("http://localhost/api/pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "a robot that waves when something gets close" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as PipelineResult;
    expect(body.ok).toBe(true);
    if (body.ok) {
      expect(body.hex_b64).toBe("AAEC");
      expect(body.run_id).toBe("20260426-test");
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toBe("a robot that waves when something gets close");
  });

  test("Honest Gap result passes through with HTTP 200 + ok:false", async () => {
    const app = makeApp(async () => HONEST_GAP_RESULT);
    const res = await app.fetch(
      new Request("http://localhost/api/pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "a scale that weighs my packages" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as PipelineResult;
    expect(body.ok).toBe(false);
    if (!body.ok) {
      expect(body.kind).toBe("out-of-scope");
      expect(body.honest_gap.scope).toBe("out-of-scope");
    }
  });

  test("rejects malformed JSON body with 400 bad-request", async () => {
    const app = makeApp(async () => SUCCESS_RESULT);
    const res = await app.fetch(
      new Request("http://localhost/api/pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json {",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: false; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("bad-request");
  });

  test("rejects missing prompt field with 400", async () => {
    const app = makeApp(async () => SUCCESS_RESULT);
    const res = await app.fetch(
      new Request("http://localhost/api/pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: false; error: string };
    expect(body.error).toBe("bad-request");
  });

  test("rejects non-string prompt with 400", async () => {
    const app = makeApp(async () => SUCCESS_RESULT);
    const res = await app.fetch(
      new Request("http://localhost/api/pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: 42 }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("rejects empty / whitespace-only prompt with 400", async () => {
    const app = makeApp(async () => SUCCESS_RESULT);
    const res = await app.fetch(
      new Request("http://localhost/api/pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "   " }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("rejects oversize prompt with 400", async () => {
    const app = makeApp(async () => SUCCESS_RESULT);
    const res = await app.fetch(
      new Request("http://localhost/api/pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "x".repeat(5001) }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("single-flight gate returns 503 queue-full when a run is in progress", async () => {
    let resolveFirst: (r: PipelineResult) => void = () => {};
    const firstPromise = new Promise<PipelineResult>((r) => {
      resolveFirst = r;
    });
    const app = makeApp(async () => firstPromise);

    // Fire the first request; do NOT await it (it's pending).
    const first = app.fetch(
      new Request("http://localhost/api/pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "first" }),
      }),
    );

    // Yield to let the first request reach the in-flight gate.
    await new Promise((r) => setTimeout(r, 10));

    const second = await app.fetch(
      new Request("http://localhost/api/pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "second" }),
      }),
    );
    expect(second.status).toBe(503);
    const secondBody = (await second.json()) as { ok: false; error: string };
    expect(secondBody.error).toBe("queue-full");
    expect(second.headers.get("Retry-After")).toBe("30");

    // Now resolve the first; clean up.
    resolveFirst(SUCCESS_RESULT);
    const firstRes = await first;
    expect(firstRes.status).toBe(200);
  });

  test("after first request completes, single-flight gate releases", async () => {
    const app = makeApp(async () => SUCCESS_RESULT);

    const first = await app.fetch(
      new Request("http://localhost/api/pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "first" }),
      }),
    );
    expect(first.status).toBe(200);

    const second = await app.fetch(
      new Request("http://localhost/api/pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "second" }),
      }),
    );
    expect(second.status).toBe(200);
  });

  test("internal error in runPipeline is mapped to 500 with redacted body", async () => {
    const app = makeApp(async () => {
      throw new Error("anthropic-sdk: stack trace with sensitive content sk-ant-api03-LEAK");
    });
    const res = await app.fetch(
      new Request("http://localhost/api/pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "test" }),
      }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: false; message: string };
    expect(body.ok).toBe(false);
    // Body must NOT echo the API key or stack trace.
    expect(body.message).not.toContain("sk-ant-api03");
    expect(body.message).not.toContain("anthropic-sdk");
  });
});

describe("pipeline-api — GET /api/pipeline/health", () => {
  test("returns 200 ok", async () => {
    const app = makeApp(async () => SUCCESS_RESULT);
    const res = await app.fetch(new Request("http://localhost/api/pipeline/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true };
    expect(body.ok).toBe(true);
  });
});

describe("pipeline-api — CORS", () => {
  test("preflight OPTIONS returns Access-Control-Allow-Origin header", async () => {
    const app = makeApp(async () => SUCCESS_RESULT, {
      corsOrigin: "http://127.0.0.1:5174",
    });
    const res = await app.fetch(
      new Request("http://localhost/api/pipeline", {
        method: "OPTIONS",
        headers: {
          Origin: "http://127.0.0.1:5174",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "Content-Type",
        },
      }),
    );
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://127.0.0.1:5174");
  });
});
