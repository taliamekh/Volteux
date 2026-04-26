/**
 * Unit + gated-integration tests for `pipeline/llm/classify.ts`.
 *
 * Coverage:
 *   - Happy paths (mocked):
 *       - single-call success returns the model's raw output verbatim
 *       - low-confidence output is preserved (NO internal threshold filter)
 *       - null archetype_id (out-of-scope) is preserved verbatim
 *   - Discriminated failure kinds (mocked): transport, sdk-error, abort,
 *     schema-failed.
 *   - Input-validation guards (synchronous throws): empty + oversize prompts.
 *   - DI overrides: model name passed through `buildClassifier(deps)` reaches
 *     the SDK call.
 *   - Exhaustiveness guard: see `tests/llm/classify-exhaustiveness.test.ts`
 *     (sibling file with `// @ts-expect-error` on a switch missing a kind).
 *
 * Gated integration tests run only when `ANTHROPIC_API_KEY` is set in
 * the environment. They:
 *   - Verify the 5-archetype mapping (in-scope happy path, free-form
 *     variant, load-cell out-of-scope, smart-home out-of-scope,
 *     archetype-4-but-v1.5 out-of-scope).
 *   - Verify the no-cache decision: `usage.cache_read_input_tokens` AND
 *     `usage.cache_creation_input_tokens` are BOTH zero on every call.
 *     If either is non-zero the implementer accidentally wired
 *     `cache_control` somewhere — the test fails loudly.
 *
 * **Cost note.** Integration tests fire ~5-7 real Haiku calls. Expect
 * ~$0.005 per full integration run. Run with `ANTHROPIC_API_KEY` set
 * only when the unit tests pass first.
 */

import { describe, expect, test } from "bun:test";
import type { ZodIssue } from "zod";
import {
  buildClassifier,
  classify,
  type ClassifyDeps,
  type ClassifyResult,
} from "../../pipeline/llm/classify.ts";
import {
  APIConnectionError,
  APIError,
  AnthropicError,
} from "@anthropic-ai/sdk";
import { makeDeps as buildDeps, type MockHandler, type MockSdk } from "./test-helpers.ts";

// ---------------------------------------------------------------------------
// Test SDK builder — uses shared mock infra from `./test-helpers.ts`.
// ---------------------------------------------------------------------------

function makeDeps(
  handlers: MockHandler[],
  overrides: Partial<ClassifyDeps> = {},
): { deps: ClassifyDeps; sdk: MockSdk } {
  return buildDeps<ClassifyDeps>(
    handlers,
    {
      systemPromptSource: "[mock intent classifier system prompt]",
      model: "claude-haiku-4-5",
      maxTokens: 1024,
    },
    overrides,
  );
}

// ---------------------------------------------------------------------------
// Happy path: single call returns archetype_id verbatim
// ---------------------------------------------------------------------------

describe("buildClassifier — happy path (single call)", () => {
  test("returns archetype_id, confidence, reasoning + usage after exactly 1 call", async () => {
    const { deps, sdk } = makeDeps([
      () => ({
        parsed_output: {
          archetype_id: "uno-ultrasonic-servo",
          confidence: 0.85,
          reasoning: "Servo-on-distance maps cleanly to archetype 1.",
        },
        stop_reason: "end_turn",
        usage: {
          input_tokens: 600,
          output_tokens: 80,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        content: [
          {
            type: "text",
            text: JSON.stringify({
              archetype_id: "uno-ultrasonic-servo",
              confidence: 0.85,
              reasoning: "Servo-on-distance maps cleanly to archetype 1.",
            }),
          },
        ],
      }),
    ]);
    const classifier = buildClassifier(deps);
    const result = await classifier(
      "a robot that waves when something gets close",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.archetype_id).toBe("uno-ultrasonic-servo");
      expect(result.confidence).toBe(0.85);
      expect(result.reasoning).toBe(
        "Servo-on-distance maps cleanly to archetype 1.",
      );
      expect(result.usage.input_tokens).toBe(600);
      expect(result.usage.output_tokens).toBe(80);
      expect(result.usage.cache_creation_input_tokens).toBe(0);
      expect(result.usage.cache_read_input_tokens).toBe(0);
    }
    expect(sdk.__calls.length).toBe(1);
  });

  test("system prompt is a single string (NOT a multi-block array); no cache_control on the call", async () => {
    const { deps, sdk } = makeDeps([
      () => ({
        parsed_output: {
          archetype_id: "uno-ultrasonic-servo",
          confidence: 0.9,
          reasoning: "ok",
        },
        stop_reason: "end_turn",
        usage: {
          input_tokens: 600,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        content: [{ type: "text", text: "{}" }],
      }),
    ]);
    const classifier = buildClassifier(deps);
    await classifier("a robot that waves when something gets close");
    const call = sdk.__calls[0];
    expect(call).toBeDefined();
    // The classifier MUST pass `system` as a plain string. A multi-block
    // array would be the shape `generate.ts` uses to enable cache_control.
    expect(typeof call?.system).toBe("string");
    expect(call?.system).toBe("[mock intent classifier system prompt]");
    // Belt-and-suspenders: walk the call structure looking for any
    // `cache_control` field. Any presence indicates an accidental wiring.
    const json = JSON.stringify(call);
    expect(json).not.toContain("cache_control");
  });
});

// ---------------------------------------------------------------------------
// Happy path: raw output preserved (NO threshold filter inside)
// ---------------------------------------------------------------------------

describe("buildClassifier — raw output preserved (no threshold filter)", () => {
  test("low confidence (0.4) is returned verbatim; classify() does NOT filter", async () => {
    const { deps, sdk } = makeDeps([
      () => ({
        parsed_output: {
          archetype_id: "uno-ultrasonic-servo",
          confidence: 0.4,
          reasoning: "Weak signal — could be archetype 1 or out-of-scope.",
        },
        stop_reason: "end_turn",
        usage: {
          input_tokens: 600,
          output_tokens: 80,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        content: [{ type: "text", text: "{}" }],
      }),
    ]);
    const classifier = buildClassifier(deps);
    const result = await classifier("ambiguous prompt");
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The orchestrator (Unit 9) applies the >=0.6 threshold; this
      // function returns the raw 0.4 verbatim. If a future change bakes
      // in a threshold here, this test fails.
      expect(result.confidence).toBe(0.4);
      expect(result.archetype_id).toBe("uno-ultrasonic-servo");
    }
    expect(sdk.__calls.length).toBe(1);
  });

  test("null archetype_id is preserved verbatim (out-of-scope routing)", async () => {
    const { deps, sdk } = makeDeps([
      () => ({
        parsed_output: {
          archetype_id: null,
          confidence: 0.95,
          reasoning: "Load cell — not in any archetype.",
        },
        stop_reason: "end_turn",
        usage: {
          input_tokens: 600,
          output_tokens: 60,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        content: [{ type: "text", text: "{}" }],
      }),
    ]);
    const classifier = buildClassifier(deps);
    const result = await classifier("a scale that weighs my packages");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.archetype_id).toBeNull();
      expect(result.confidence).toBe(0.95);
    }
    expect(sdk.__calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Defensive: response with no parsed_output. The SDK should normally
// throw an AnthropicError when structured-output parsing fails; this
// branch only fires if the SDK ever silently returns no parsed_output.
// Surfaces as `sdk-error` with the stop_reason carried in errors[].
// ---------------------------------------------------------------------------

describe("buildClassifier — defensive: parsed_output=null", () => {
  test("returns kind:'sdk-error' with stop_reason in errors[] (single call, no retry)", async () => {
    const { deps, sdk } = makeDeps([
      () => ({
        parsed_output: null,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 600,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        content: [{ type: "text", text: "" }],
      }),
    ]);
    const classifier = buildClassifier(deps);
    const result = await classifier("a robot that waves when something gets close");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("sdk-error");
      expect(result.severity).toBe("red");
      expect(result.errors[0]).toContain("stop_reason=end_turn");
    }
    // Classify makes EXACTLY one call — no auto-repair, no retry.
    expect(sdk.__calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Discriminated failure kinds
// ---------------------------------------------------------------------------

describe("buildClassifier — schema-failed (Zod parse fails)", () => {
  test("returns kind:'schema-failed' with ZodIssues after exactly 1 call (NO auto-repair)", async () => {
    const fakeIssues: ZodIssue[] = [
      {
        code: "invalid_enum_value",
        path: ["archetype_id"],
        message:
          "Invalid enum value. Expected 'uno-ultrasonic-servo' | 'esp32-audio-dashboard' | 'pico-rotary-oled' | 'esp32c3-dht-aio' | 'uno-photoresistor-led' | null, received 'unknown-archetype'",
        // The shape of invalid_enum_value carries `received` and `options`
        // but the impl only reads path + message.
      } as unknown as ZodIssue,
    ];
    const inner = new Error("Zod validation failed: 1 issue(s)") as Error & {
      cause?: unknown;
    };
    inner.cause = { issues: fakeIssues };
    const sdkThrow = new AnthropicError(
      `Failed to parse structured output: ${inner.message}`,
    ) as AnthropicError & { cause?: unknown };
    sdkThrow.cause = inner;

    const { deps, sdk } = makeDeps([() => sdkThrow]);
    const classifier = buildClassifier(deps);
    const result = await classifier("a robot that waves when something gets close");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("schema-failed");
      expect(result.severity).toBe("red");
      expect(result.errors.length).toBeGreaterThan(0);
    }
    // CRITICAL: classify does NOT auto-repair — exactly 1 call.
    expect(sdk.__calls.length).toBe(1);
  });
});

describe("buildClassifier — transport (network throw)", () => {
  test("APIConnectionError → kind:'transport' (no retry)", async () => {
    const connErr = new APIConnectionError({
      message: "connect ECONNREFUSED",
      cause: new Error("ECONNREFUSED 127.0.0.1:443"),
    });
    const { deps, sdk } = makeDeps([() => connErr]);
    const classifier = buildClassifier(deps);
    const result = await classifier(
      "a robot that waves when something gets close",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("transport");
      expect(result.severity).toBe("red");
    }
    expect(sdk.__calls.length).toBe(1);
  });

  test("plain TypeError('fetch failed') → kind:'transport'", async () => {
    const err = new TypeError("fetch failed");
    const { deps } = makeDeps([() => err]);
    const classifier = buildClassifier(deps);
    const result = await classifier(
      "a robot that waves when something gets close",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("transport");
  });
});

describe("buildClassifier — sdk-error (5xx / rate-limit retried-out)", () => {
  test("APIError(529 Overloaded) → kind:'sdk-error' (no retry)", async () => {
    class FakeAPIError extends APIError<529, undefined, undefined> {
      constructor() {
        super(
          529 as const,
          undefined,
          "529 Overloaded",
          undefined,
        );
      }
    }
    const err = new FakeAPIError();
    const { deps, sdk } = makeDeps([() => err]);
    const classifier = buildClassifier(deps);
    const result = await classifier(
      "a robot that waves when something gets close",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("sdk-error");
      expect(result.severity).toBe("red");
    }
    expect(sdk.__calls.length).toBe(1);
  });
});

describe("buildClassifier — abort", () => {
  test("pre-fired AbortSignal → kind:'abort' (no retry)", async () => {
    const controller = new AbortController();
    controller.abort();
    const { deps, sdk } = makeDeps([
      () => ({
        parsed_output: {
          archetype_id: "uno-ultrasonic-servo",
          confidence: 0.9,
          reasoning: "ok",
        },
        stop_reason: "end_turn",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        content: [{ type: "text", text: "{}" }],
      }),
    ]);
    const classifier = buildClassifier(deps);
    const result = await classifier(
      "a robot that waves when something gets close",
      { signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("abort");
      expect(result.severity).toBe("red");
    }
    // The mock raises APIUserAbortError before the handler runs, so the
    // call IS logged but no real model invocation happened.
    expect(sdk.__calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Input-validation guards (synchronous throws; no API call made)
// ---------------------------------------------------------------------------

describe("buildClassifier — input-validation guards", () => {
  test("empty prompt throws synchronously; zero API calls", async () => {
    const { deps, sdk } = makeDeps([]);
    const classifier = buildClassifier(deps);
    await expect(classifier("")).rejects.toThrow("empty prompt");
    expect(sdk.__calls.length).toBe(0);
  });

  test("oversize (>5000 chars) prompt throws synchronously; zero API calls", async () => {
    const { deps, sdk } = makeDeps([]);
    const classifier = buildClassifier(deps);
    const big = "x".repeat(5001);
    await expect(classifier(big)).rejects.toThrow("prompt exceeds 5000 chars");
    expect(sdk.__calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DI override: model name passes through
// ---------------------------------------------------------------------------

describe("buildClassifier — DI override", () => {
  test("override model name reaches the SDK call (production sees default)", async () => {
    const { deps, sdk } = makeDeps(
      [
        () => ({
          parsed_output: {
            archetype_id: "uno-ultrasonic-servo",
            confidence: 0.9,
            reasoning: "ok",
          },
          stop_reason: "end_turn",
          usage: {
            input_tokens: 600,
            output_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [{ type: "text", text: "{}" }],
        }),
      ],
      { model: "claude-haiku-4-5-future" },
    );
    const classifier = buildClassifier(deps);
    await classifier("a robot that waves when something gets close");
    expect(sdk.__calls[0]?.model).toBe("claude-haiku-4-5-future");
  });
});

// ---------------------------------------------------------------------------
// Gated integration tests
// ---------------------------------------------------------------------------

const HAS_API_KEY = (process.env.ANTHROPIC_API_KEY ?? "") !== "";

const integrationDescribe = HAS_API_KEY ? describe : describe.skip;

integrationDescribe(
  "classify() — integration (requires ANTHROPIC_API_KEY)",
  () => {
    test(
      "in-scope: 'a robot that waves when something gets close' → archetype_id='uno-ultrasonic-servo'",
      async () => {
        const result: ClassifyResult = await classify(
          "a robot that waves when something gets close",
        );
        expect(result.ok).toBe(true);
        if (!result.ok) {
          throw new Error(
            `classify() returned not-ok: kind=${result.kind} message=${result.message} errors=${JSON.stringify(result.errors)}`,
          );
        }
        expect(result.archetype_id).toBe("uno-ultrasonic-servo");
        expect(result.confidence).toBeGreaterThanOrEqual(0.7);
        expect(result.reasoning.length).toBeGreaterThan(0);
        // Log the input_tokens so the implementer can confirm the prompt
        // is in the expected ~500-800 range.
        process.stdout.write(
          `[classify.test] in-scope call usage: input_tokens=${result.usage.input_tokens} output_tokens=${result.usage.output_tokens} cache_creation=${result.usage.cache_creation_input_tokens} cache_read=${result.usage.cache_read_input_tokens}\n`,
        );
      },
      { timeout: 60_000 },
    );

    test(
      "free-form variant: 'I want to measure how close my dog gets to the food bowl' → archetype_id='uno-ultrasonic-servo'",
      async () => {
        // Tests figurative-language mapping (no explicit "servo" or "ultrasonic").
        const result: ClassifyResult = await classify(
          "I want to measure how close my dog gets to the food bowl",
        );
        expect(result.ok).toBe(true);
        if (!result.ok) {
          throw new Error(
            `classify() returned not-ok: kind=${result.kind} message=${result.message}`,
          );
        }
        expect(result.archetype_id).toBe("uno-ultrasonic-servo");
        expect(result.reasoning.length).toBeGreaterThan(0);
      },
      { timeout: 60_000 },
    );

    test(
      "out-of-scope (load cell): 'a scale that weighs my packages' → archetype_id=null",
      async () => {
        const result: ClassifyResult = await classify(
          "a scale that weighs my packages",
        );
        expect(result.ok).toBe(true);
        if (!result.ok) {
          throw new Error(
            `classify() returned not-ok: kind=${result.kind} message=${result.message}`,
          );
        }
        expect(result.archetype_id).toBeNull();
        // Reasoning should mention load cell or weight — surfaces the
        // model's understanding of WHY it routed to null. This is a
        // soft check; if the model uses different wording the test
        // failure mode logs the actual reasoning for inspection.
        const reasoning = result.reasoning.toLowerCase();
        const mentionsWeight =
          reasoning.includes("load cell") ||
          reasoning.includes("weight") ||
          reasoning.includes("scale") ||
          reasoning.includes("hx711");
        if (!mentionsWeight) {
          process.stdout.write(
            `[classify.test] WARNING: load-cell reasoning did not mention weight/load-cell. Got: ${result.reasoning}\n`,
          );
        }
      },
      { timeout: 60_000 },
    );

    test(
      "out-of-scope (smart home / mains): 'control my house lights from my phone' → archetype_id=null",
      async () => {
        const result: ClassifyResult = await classify(
          "control my house lights from my phone",
        );
        expect(result.ok).toBe(true);
        if (!result.ok) {
          throw new Error(
            `classify() returned not-ok: kind=${result.kind} message=${result.message}`,
          );
        }
        expect(result.archetype_id).toBeNull();
      },
      { timeout: 60_000 },
    );

    test(
      "out-of-scope (archetype-4 v1.5 territory): 'a temperature display that texts me' → archetype_id=null",
      async () => {
        // This prompt looks archetype-4-shaped (DHT + AIO) but adds
        // SMS routing v0.1 doesn't ship. The classifier should route
        // null rather than misroute to esp32c3-dht-aio with a partial fit.
        const result: ClassifyResult = await classify(
          "a temperature display that texts me",
        );
        expect(result.ok).toBe(true);
        if (!result.ok) {
          throw new Error(
            `classify() returned not-ok: kind=${result.kind} message=${result.message}`,
          );
        }
        expect(result.archetype_id).toBeNull();
      },
      { timeout: 60_000 },
    );

    test(
      "no-cache audit: every call returns cache_read_input_tokens===0 AND cache_creation_input_tokens===0",
      async () => {
        // This test is the structural audit for the no-cache decision.
        // Any future contributor adding `cache_control` somewhere in
        // `classify.ts` will fail here. We make a fresh call (NOT a
        // repeat of a previous test's prompt) so we don't depend on
        // 1h cache-window timing.
        const result: ClassifyResult = await classify(
          "an Arduino project that does something with sensors",
        );
        expect(result.ok).toBe(true);
        if (!result.ok) {
          throw new Error(
            `classify() returned not-ok: kind=${result.kind} message=${result.message}`,
          );
        }
        expect(result.usage.cache_read_input_tokens).toBe(0);
        expect(result.usage.cache_creation_input_tokens).toBe(0);
      },
      { timeout: 60_000 },
    );
  },
);
