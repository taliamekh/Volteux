/**
 * Tests for `app/src/data/pipeline-client.ts`.
 *
 * The client is a thin fetch wrapper. Tests inject a mock `fetch` via the
 * `opts.fetch` parameter to exercise the full success / structured-failure /
 * transport-failure matrix without touching the network.
 */

import { describe, expect, test, vi } from "vitest";
import { fetchPipeline, PipelineClientError } from "../data/pipeline-client";

function makeMockFetch(responseInit: {
  status: number;
  body: unknown;
}): typeof fetch {
  return vi.fn(async () => {
    return new Response(JSON.stringify(responseInit.body), {
      status: responseInit.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("fetchPipeline — success path", () => {
  test("200 + ok:true PipelineResult is returned verbatim", async () => {
    const mock = makeMockFetch({
      status: 200,
      body: {
        ok: true,
        doc: { archetype_id: "uno-ultrasonic-servo" },
        hex_b64: "AAEC",
        run_id: "20260426-test",
        cost_usd: 0.05,
        amber: [],
        blue: [],
      },
    });
    const result = await fetchPipeline("a robot that waves", { fetch: mock });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hex_b64).toBe("AAEC");
      expect(result.run_id).toBe("20260426-test");
    }
  });

  test("200 + ok:false (Honest Gap) PipelineResult is returned verbatim", async () => {
    const mock = makeMockFetch({
      status: 200,
      body: {
        ok: false,
        severity: "red",
        kind: "out-of-scope",
        message: "out of scope",
        errors: ["classifier rejected"],
        honest_gap: {
          scope: "out-of-scope",
          missing_capabilities: ["load cell"],
          explanation: "Your idea needs a load cell.",
        },
        cost_usd: 0.001,
        run_id: "20260426-oos",
      },
    });
    const result = await fetchPipeline("a scale that weighs my packages", { fetch: mock });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("out-of-scope");
      expect(result.honest_gap.scope).toBe("out-of-scope");
    }
  });
});

describe("fetchPipeline — server-side errors (PipelineClientError)", () => {
  test("400 bad-request throws PipelineClientError(kind=bad-request)", async () => {
    const mock = makeMockFetch({
      status: 400,
      body: { ok: false, error: "bad-request", message: '"prompt" must not be empty' },
    });
    let caught: unknown = null;
    try {
      await fetchPipeline("", { fetch: mock });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PipelineClientError);
    expect((caught as PipelineClientError).kind).toBe("bad-request");
    expect((caught as PipelineClientError).status).toBe(400);
    expect((caught as PipelineClientError).message).toContain('"prompt" must not be empty');
  });

  test("503 queue-full throws PipelineClientError(kind=queue-full)", async () => {
    const mock = makeMockFetch({
      status: 503,
      body: { ok: false, error: "queue-full", message: "another run in progress" },
    });
    let caught: unknown = null;
    try {
      await fetchPipeline("test", { fetch: mock });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PipelineClientError);
    expect((caught as PipelineClientError).kind).toBe("queue-full");
    expect((caught as PipelineClientError).status).toBe(503);
  });

  test("500 internal-error throws PipelineClientError(kind=internal-error)", async () => {
    const mock = makeMockFetch({
      status: 500,
      body: { ok: false, error: "internal-error", message: "internal server error" },
    });
    let caught: unknown = null;
    try {
      await fetchPipeline("test", { fetch: mock });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PipelineClientError);
    expect((caught as PipelineClientError).kind).toBe("internal-error");
  });

  test("unexpected status (502) throws PipelineClientError(kind=unexpected-status)", async () => {
    const mock = makeMockFetch({
      status: 502,
      body: { ok: false },
    });
    let caught: unknown = null;
    try {
      await fetchPipeline("test", { fetch: mock });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PipelineClientError);
    expect((caught as PipelineClientError).kind).toBe("unexpected-status");
    expect((caught as PipelineClientError).status).toBe(502);
  });

  test("non-JSON response body throws PipelineClientError(kind=unexpected-status)", async () => {
    const mock = vi.fn(async () => {
      return new Response("not json at all", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }) as unknown as typeof fetch;
    let caught: unknown = null;
    try {
      await fetchPipeline("test", { fetch: mock });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PipelineClientError);
    expect((caught as PipelineClientError).kind).toBe("unexpected-status");
  });
});

describe("fetchPipeline — transport errors", () => {
  test("fetch reject throws PipelineClientError(kind=transport)", async () => {
    const mock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    let caught: unknown = null;
    try {
      await fetchPipeline("test", { fetch: mock });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PipelineClientError);
    expect((caught as PipelineClientError).kind).toBe("transport");
    expect((caught as PipelineClientError).message).toContain("Failed to fetch");
  });
});

describe("fetchPipeline — request shape", () => {
  test("POSTs JSON body with the prompt", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const mock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          ok: true,
          doc: {},
          hex_b64: "",
          run_id: "x",
          cost_usd: 0,
          amber: [],
          blue: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await fetchPipeline("hello world", { fetch: mock });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/api/pipeline");
    expect(calls[0]?.init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.prompt).toBe("hello world");
  });

  test("respects baseUrl override", async () => {
    const calls: { url: string }[] = [];
    const mock = vi.fn(async (url: string) => {
      calls.push({ url });
      return new Response(
        JSON.stringify({
          ok: true,
          doc: {},
          hex_b64: "",
          run_id: "x",
          cost_usd: 0,
          amber: [],
          blue: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await fetchPipeline("test", { fetch: mock, baseUrl: "http://example.com" });
    expect(calls[0]?.url).toBe("http://example.com/api/pipeline");
  });
});
