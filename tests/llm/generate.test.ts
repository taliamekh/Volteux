/**
 * Unit + gated-integration tests for `pipeline/llm/generate.ts`.
 *
 * Coverage:
 *   - Happy paths (mocked): single-call success; auto-repair retry success.
 *   - Discriminated failure kinds (mocked): schema-failed, truncated,
 *     transport, sdk-error, abort.
 *   - Input-validation guards (synchronous throws): empty + oversize prompts.
 *   - DI overrides: model name passed through buildGenerator(deps) reaches
 *     the SDK call.
 *   - Cache discipline (assertion): the auto-repair retry sends the SAME
 *     system blocks as the initial call AND appends a fresh user turn
 *     LAST (no assistant prefill).
 *   - Exhaustiveness guard: see `tests/llm/generate-exhaustiveness.test.ts`
 *     (sibling file with `// @ts-expect-error` on a switch missing a kind).
 *
 * Gated integration tests run only when `ANTHROPIC_API_KEY` is set in
 * the environment. They:
 *   - Verify a real Sonnet 4.6 call returns a schema-valid
 *     VolteuxProjectDocument that ALSO passes the schema, cross-consistency,
 *     library allowlist, AND archetype-1 rules gates (red bucket empty).
 *   - Verify the prompt cache engages (cache_read_input_tokens > 0 on a
 *     repeat call) when the system+schema primer is ≥2048 tokens. If the
 *     measurement script previously found <2048 tokens, this assertion
 *     skips with a clear log line and the no-cache ADR comment in the
 *     prompt header is the audit trail.
 *
 * **Prefill probe outcome (from first integration run on 2026-04-26):**
 *
 *     Sonnet 4.6 REJECTED the assistant-suffixed message with HTTP 400
 *     `invalid_request_error: This model does not support assistant
 *     message prefill. The conversation must end with a user message.`
 *
 *     Verified `request_id=req_011CaRtkRTuw6q9ZXycD6Zi5` (logged on
 *     stdout from the integration test "prefill probe — deliberately
 *     constructs an assistant-suffixed message").
 *
 *     This is what the multi-turn shape we ship is designed for: the
 *     auto-repair retry sends `system → user(prompt) → assistant(prior)
 *     → user(repair)` — the LAST turn is a USER turn, NOT an
 *     assistant-suffixed prefill. The retry survives Sonnet 4.6's
 *     rejection policy by construction.
 *
 *     If a future model relaxes this rule, the shape continues to work
 *     (assistant-prefill is strictly more constrained than
 *     ending-with-user, which we already do). Re-run the probe when
 *     migrating to a new model version to update this header.
 *
 * **Cost note.** Integration tests fire ~6-8 real Sonnet calls. Expect
 * ~$0.50-0.80 per full integration run. Run with `ANTHROPIC_API_KEY` set
 * only when the unit tests pass first.
 */

import { describe, expect, test } from "bun:test";
import type { ZodIssue } from "zod";
import {
  buildGenerator,
  generate,
  type GenerateDeps,
  type GenerateResult,
} from "../../pipeline/llm/generate.ts";
import { runSchemaGate } from "../../pipeline/gates/schema.ts";
import { runCrossConsistencyGate } from "../../pipeline/gates/cross-consistency.ts";
import { runRules } from "../../pipeline/rules/index.ts";
import { VolteuxProjectDocumentSchema } from "../../schemas/document.zod.ts";
import {
  APIConnectionError,
  APIError,
  AnthropicError,
} from "@anthropic-ai/sdk";
import { makeDeps as buildDeps, type MockHandler, type MockSdk } from "./test-helpers.ts";

// ---------------------------------------------------------------------------
// Fixture: a known-good VolteuxProjectDocument the mock SDK returns.
// We import the canonical fixture so happy-path tests use shape that's
// already validated against the schema.
// ---------------------------------------------------------------------------

const CANONICAL_FIXTURE = await Bun.file(
  "fixtures/uno-ultrasonic-servo.json",
).json();

// Safe-parse to give the test a properly-typed VolteuxProjectDocument value.
const parsedFixture = VolteuxProjectDocumentSchema.parse(CANONICAL_FIXTURE);

// ---------------------------------------------------------------------------
// Test SDK builder — uses shared mock infra from `./test-helpers.ts`.
// The per-suite shape thunked in here is the production `GenerateDeps`
// minus its `client`; the helper wires the mock SDK into `client` for us.
// ---------------------------------------------------------------------------

function makeDeps(
  handlers: MockHandler[],
  overrides: Partial<GenerateDeps> = {},
): { deps: GenerateDeps; sdk: MockSdk } {
  return buildDeps<GenerateDeps>(
    handlers,
    {
      systemPromptSource: "[mock system prompt]",
      schemaPrimer: "[mock schema primer]",
      model: "claude-sonnet-4-6",
      maxTokens: 16000,
    },
    overrides,
  );
}

// ---------------------------------------------------------------------------
// Happy path: single call success
// ---------------------------------------------------------------------------

describe("buildGenerator — happy path (single call)", () => {
  test("returns ok with parsed doc + usage after exactly 1 call", async () => {
    const { deps, sdk } = makeDeps([
      () => ({
        parsed_output: parsedFixture,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 2500,
          output_tokens: 800,
          cache_creation_input_tokens: 2500,
          cache_read_input_tokens: 0,
        },
        content: [{ type: "text", text: JSON.stringify(parsedFixture) }],
      }),
    ]);
    const generator = buildGenerator(deps);
    const result = await generator("a robot that waves when something gets close");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.doc.archetype_id).toBe("uno-ultrasonic-servo");
      expect(result.doc.sketch.libraries).toEqual(["Servo"]);
      expect(result.usage.input_tokens).toBe(2500);
      expect(result.usage.cache_creation_input_tokens).toBe(2500);
    }
    expect(sdk.__calls.length).toBe(1);
  });

  test("system blocks are an array with cache_control on the LAST block", async () => {
    const { deps, sdk } = makeDeps([
      () => ({
        parsed_output: parsedFixture,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 2500,
          output_tokens: 800,
          cache_creation_input_tokens: 2500,
          cache_read_input_tokens: 0,
        },
        content: [{ type: "text", text: JSON.stringify(parsedFixture) }],
      }),
    ]);
    const generator = buildGenerator(deps);
    await generator("a robot that waves when something gets close");
    const call = sdk.__calls[0];
    expect(call).toBeDefined();
    const system = call?.system as Array<{ type: string; cache_control?: unknown }>;
    expect(Array.isArray(system)).toBe(true);
    expect(system.length).toBeGreaterThanOrEqual(2);
    const last = system[system.length - 1];
    expect(last?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // Earlier blocks must NOT carry cache_control — only the LAST one.
    for (let i = 0; i < system.length - 1; i++) {
      const b = system[i];
      expect(b?.cache_control).toBeUndefined();
    }
  });

  test("fewshot block is appended when deps.fewshotSource is set, and gets the cache_control marker", async () => {
    const { deps, sdk } = makeDeps(
      [
        () => ({
          parsed_output: parsedFixture,
          stop_reason: "end_turn",
          usage: {
            input_tokens: 4000,
            output_tokens: 800,
            cache_creation_input_tokens: 4000,
            cache_read_input_tokens: 0,
          },
          content: [{ type: "text", text: JSON.stringify(parsedFixture) }],
        }),
      ],
      { fewshotSource: "[mock fewshot]" },
    );
    const generator = buildGenerator(deps);
    await generator("a robot that waves when something gets close");
    const call = sdk.__calls[0];
    const system = call?.system as Array<{ type: string; text: string; cache_control?: unknown }>;
    expect(system.length).toBe(3);
    expect(system[2]?.text).toBe("[mock fewshot]");
    expect(system[2]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // The schemaPrimer (block 1) and the systemPromptSource (block 0)
    // are NOT marked when fewshot exists.
    expect(system[0]?.cache_control).toBeUndefined();
    expect(system[1]?.cache_control).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Auto-repair retry: success
// ---------------------------------------------------------------------------

describe("buildGenerator — auto-repair retry (success)", () => {
  test("first call throws zod-parse, second call returns parsed doc; exactly 2 calls", async () => {
    // Construct the AnthropicError shape the real SDK throws when our
    // outputFormat.parse() throws. We mirror the inner-Error-with-cause
    // shape so extractZodIssues can read the issues.
    const fakeIssues: ZodIssue[] = [
      {
        code: "invalid_type",
        path: ["sketch", "main_ino"],
        message: "Expected string, received number",
        // expected/received fields are required on invalid_type issues but
        // the impl only reads `path` and `message`.
        expected: "string",
        received: "number",
      } as ZodIssue,
    ];
    const inner = new Error("Zod validation failed: 1 issue(s)") as Error & {
      cause?: unknown;
    };
    inner.cause = { issues: fakeIssues };
    const sdkThrow = new AnthropicError(
      `Failed to parse structured output: ${inner.message}\nValidation issues:\n  - sketch.main_ino: Expected string, received number`,
    ) as AnthropicError & { cause?: unknown };
    sdkThrow.cause = inner;

    const { deps, sdk } = makeDeps([
      () => sdkThrow,
      () => ({
        parsed_output: parsedFixture,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 100,
          output_tokens: 800,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 2500,
        },
        content: [{ type: "text", text: JSON.stringify(parsedFixture) }],
      }),
    ]);
    const generator = buildGenerator(deps);
    const result = await generator("a robot that waves when something gets close");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.doc.archetype_id).toBe("uno-ultrasonic-servo");
      // Cache-discipline assertion: on the retry call, cache_read > 0 AND
      // cache_creation === 0 — the prefix was hit, no second creation.
      expect(result.usage.cache_read_input_tokens).toBe(2500);
      expect(result.usage.cache_creation_input_tokens).toBe(0);
    }
    expect(sdk.__calls.length).toBe(2);
  });

  test("retry message order: system → user(prompt) → assistant(prior) → user(errors); LAST turn is USER, not assistant prefill", async () => {
    const fakeIssues: ZodIssue[] = [
      {
        code: "invalid_type",
        path: ["board", "fqbn"],
        message: "Required",
        expected: "string",
        received: "undefined",
      } as ZodIssue,
    ];
    const inner = new Error("Zod validation failed: 1 issue(s)") as Error & {
      cause?: unknown;
    };
    inner.cause = { issues: fakeIssues };
    const sdkThrow = new AnthropicError(
      `Failed to parse structured output: ${inner.message}`,
    ) as AnthropicError & { cause?: unknown };
    sdkThrow.cause = inner;

    const { deps, sdk } = makeDeps([
      () => sdkThrow,
      () => ({
        parsed_output: parsedFixture,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 100,
          output_tokens: 800,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 2500,
        },
        content: [{ type: "text", text: JSON.stringify(parsedFixture) }],
      }),
    ]);
    const generator = buildGenerator(deps);
    await generator("a robot that waves when something gets close");

    const retryCall = sdk.__calls[1];
    expect(retryCall).toBeDefined();
    const messages = retryCall?.messages as ReadonlyArray<{
      role: "user" | "assistant";
      content: string;
    }>;
    expect(messages.length).toBe(3);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toBe(
      "a robot that waves when something gets close",
    );
    expect(messages[1]?.role).toBe("assistant");
    expect(messages[2]?.role).toBe("user");
    // The last turn must contain the schema-error feedback.
    expect(messages[2]?.content).toContain("schema validation");

    // System blocks are UNCHANGED across attempts — the cached prefix
    // stays byte-identical so cache_read fires.
    const initialSystem = JSON.stringify(sdk.__calls[0]?.system);
    const retrySystem = JSON.stringify(retryCall?.system);
    expect(initialSystem).toBe(retrySystem);
  });
});

// ---------------------------------------------------------------------------
// Discriminated failure kinds
// ---------------------------------------------------------------------------

describe("buildGenerator — schema-failed (both attempts fail Zod parse)", () => {
  test("returns kind:'schema-failed' with ZodIssues after exactly 2 calls", async () => {
    const fakeIssues: ZodIssue[] = [
      {
        code: "invalid_type",
        path: ["board"],
        message: "Required",
        expected: "object",
        received: "undefined",
      } as ZodIssue,
    ];
    const inner = new Error("Zod validation failed") as Error & {
      cause?: unknown;
    };
    inner.cause = { issues: fakeIssues };
    const buildThrow = (): AnthropicError => {
      const e = new AnthropicError(
        `Failed to parse structured output: Zod validation failed`,
      ) as AnthropicError & { cause?: unknown };
      e.cause = inner;
      return e;
    };

    const { deps, sdk } = makeDeps([() => buildThrow(), () => buildThrow()]);
    const generator = buildGenerator(deps);
    const result = await generator("a robot that waves when something gets close");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("schema-failed");
      expect(result.severity).toBe("red");
      expect(result.errors.length).toBeGreaterThan(0);
    }
    // No infinite retry — exactly 2 calls.
    expect(sdk.__calls.length).toBe(2);
  });
});

describe("buildGenerator — truncated", () => {
  test("first call returns stop_reason='max_tokens' with parsed_output:null → kind:'truncated' after exactly 1 call (no retry)", async () => {
    const { deps, sdk } = makeDeps([
      () => ({
        parsed_output: null,
        stop_reason: "max_tokens",
        usage: {
          input_tokens: 2500,
          output_tokens: 16000,
          cache_creation_input_tokens: 2500,
          cache_read_input_tokens: 0,
        },
        content: [{ type: "text", text: "{partial json without closing brace" }],
      }),
    ]);
    const generator = buildGenerator(deps);
    const result = await generator("a robot that waves when something gets close");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("truncated");
      expect(result.severity).toBe("red");
    }
    // Truncation does NOT trigger an auto-repair retry — same prompt
    // would just truncate again at the same boundary.
    expect(sdk.__calls.length).toBe(1);
  });
});

describe("buildGenerator — transport (network throw)", () => {
  test("APIConnectionError → kind:'transport' (no retry)", async () => {
    const connErr = new APIConnectionError({
      message: "connect ECONNREFUSED",
      cause: new Error("ECONNREFUSED 127.0.0.1:443"),
    });
    const { deps, sdk } = makeDeps([() => connErr]);
    const generator = buildGenerator(deps);
    const result = await generator("a robot that waves when something gets close");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("transport");
      expect(result.severity).toBe("red");
    }
    // Transport errors are NOT auto-repaired — orchestrator territory.
    expect(sdk.__calls.length).toBe(1);
  });

  test("plain TypeError('fetch failed') → kind:'transport'", async () => {
    const err = new TypeError("fetch failed");
    const { deps } = makeDeps([() => err]);
    const generator = buildGenerator(deps);
    const result = await generator("a robot that waves when something gets close");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("transport");
  });
});

describe("buildGenerator — sdk-error (5xx / rate-limit retried-out)", () => {
  test("APIError(529 Overloaded) → kind:'sdk-error' (no retry)", async () => {
    // Construct a stand-in for an APIError surfaced after the SDK's
    // internal retry loop gave up.
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
    const generator = buildGenerator(deps);
    const result = await generator("a robot that waves when something gets close");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("sdk-error");
      expect(result.severity).toBe("red");
    }
    expect(sdk.__calls.length).toBe(1);
  });
});

describe("buildGenerator — abort", () => {
  test("pre-fired AbortSignal → kind:'abort' (no retry)", async () => {
    const controller = new AbortController();
    controller.abort();
    const { deps, sdk } = makeDeps([
      () => ({
        parsed_output: parsedFixture,
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
    const generator = buildGenerator(deps);
    const result = await generator(
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
// Defensive branches: response with no parsed_output (NOT max_tokens).
//
// The SDK should normally throw an AnthropicError when structured-output
// parsing fails; the `parsed_output: null && stop_reason !== "max_tokens"`
// branch only fires if the SDK ever silently returns no parsed_output
// without throwing. The branch exists as a safety net — surface as
// `sdk-error` rather than confidently crash. These tests pin that
// behaviour so a refactor that drops the defensive case is caught.
// ---------------------------------------------------------------------------

describe("buildGenerator — defensive: parsed_output=null on attempt 1 (stop_reason !== max_tokens)", () => {
  test("returns kind:'sdk-error' with stop_reason carried in errors[]", async () => {
    const { deps, sdk } = makeDeps([
      () => ({
        parsed_output: null,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 100,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        content: [{ type: "text", text: "" }],
      }),
    ]);
    const generator = buildGenerator(deps);
    const result = await generator("a robot that waves when something gets close");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("sdk-error");
      expect(result.severity).toBe("red");
      expect(result.errors[0]).toContain("stop_reason=end_turn");
    }
    // No retry — defensive sdk-error returns immediately.
    expect(sdk.__calls.length).toBe(1);
  });
});

describe("buildGenerator — defensive: parsed_output=null on attempt 2 (auto-repair retry)", () => {
  test("attempt-1 zod throw → attempt-2 returns parsed_output:null with stop_reason 'end_turn' → kind:'sdk-error'", async () => {
    const fakeIssues: ZodIssue[] = [
      {
        code: "invalid_type",
        path: ["board"],
        message: "Required",
        expected: "object",
        received: "undefined",
      } as ZodIssue,
    ];
    const inner = new Error("Zod validation failed: 1 issue(s)") as Error & {
      cause?: unknown;
    };
    inner.cause = { issues: fakeIssues };
    const sdkThrow = new AnthropicError(
      `Failed to parse structured output: ${inner.message}`,
    ) as AnthropicError & { cause?: unknown };
    sdkThrow.cause = inner;

    const { deps, sdk } = makeDeps([
      () => sdkThrow,
      () => ({
        parsed_output: null,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 100,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 2500,
        },
        content: [{ type: "text", text: "" }],
      }),
    ]);
    const generator = buildGenerator(deps);
    const result = await generator("a robot that waves when something gets close");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("sdk-error");
      expect(result.message).toContain("auto-repair retry");
      expect(result.errors[0]).toContain("stop_reason=end_turn");
    }
    expect(sdk.__calls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Retry-path failure modes: attempt 1 fails Zod parse; attempt 2 throws
// transport / sdk-error / abort. The post-retry kind is taken from the
// attempt-2 throw.
// ---------------------------------------------------------------------------

describe("buildGenerator — retry path: attempt 2 throws transport", () => {
  test("attempt-1 zod-parse throw, attempt-2 APIConnectionError → kind:'transport'", async () => {
    const fakeIssues: ZodIssue[] = [
      {
        code: "invalid_type",
        path: ["sketch"],
        message: "Required",
        expected: "object",
        received: "undefined",
      } as ZodIssue,
    ];
    const inner = new Error("Zod validation failed: 1 issue(s)") as Error & {
      cause?: unknown;
    };
    inner.cause = { issues: fakeIssues };
    const zodThrow = new AnthropicError(
      `Failed to parse structured output: ${inner.message}`,
    ) as AnthropicError & { cause?: unknown };
    zodThrow.cause = inner;

    const transportErr = new APIConnectionError({
      message: "connect ECONNREFUSED",
      cause: new Error("ECONNREFUSED on retry"),
    });

    const { deps, sdk } = makeDeps([() => zodThrow, () => transportErr]);
    const generator = buildGenerator(deps);
    const result = await generator("a robot that waves when something gets close");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("transport");
      expect(result.message).toContain("auto-repair retry");
    }
    expect(sdk.__calls.length).toBe(2);
  });
});

describe("buildGenerator — retry path: attempt 2 throws sdk-error", () => {
  test("attempt-1 zod-parse throw, attempt-2 APIError(529) → kind:'sdk-error'", async () => {
    const fakeIssues: ZodIssue[] = [
      {
        code: "invalid_type",
        path: ["board"],
        message: "Required",
        expected: "object",
        received: "undefined",
      } as ZodIssue,
    ];
    const inner = new Error("Zod validation failed: 1 issue(s)") as Error & {
      cause?: unknown;
    };
    inner.cause = { issues: fakeIssues };
    const zodThrow = new AnthropicError(
      `Failed to parse structured output: ${inner.message}`,
    ) as AnthropicError & { cause?: unknown };
    zodThrow.cause = inner;

    class FakeAPIError extends APIError<529, undefined, undefined> {
      constructor() {
        super(529 as const, undefined, "529 Overloaded", undefined);
      }
    }

    const { deps, sdk } = makeDeps([() => zodThrow, () => new FakeAPIError()]);
    const generator = buildGenerator(deps);
    const result = await generator("a robot that waves when something gets close");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("sdk-error");
      expect(result.message).toContain("auto-repair retry");
    }
    expect(sdk.__calls.length).toBe(2);
  });
});

describe("buildGenerator — retry path: attempt 2 aborts", () => {
  test("attempt-1 zod-parse throw, signal aborts BEFORE attempt-2 fires → kind:'abort'", async () => {
    // Adversarial cascade: attempt 1 throws a Zod error so we enter the
    // auto-repair branch. Between attempt 1 and attempt 2 the caller
    // aborts the signal. The mock SDK pre-checks `opts.signal.aborted`
    // on each call, so attempt 2 surfaces as APIUserAbortError → "abort".
    const controller = new AbortController();
    const fakeIssues: ZodIssue[] = [
      {
        code: "invalid_type",
        path: ["board"],
        message: "Required",
        expected: "object",
        received: "undefined",
      } as ZodIssue,
    ];
    const inner = new Error("Zod validation failed: 1 issue(s)") as Error & {
      cause?: unknown;
    };
    inner.cause = { issues: fakeIssues };
    const zodThrow = new AnthropicError(
      `Failed to parse structured output: ${inner.message}`,
    ) as AnthropicError & { cause?: unknown };
    zodThrow.cause = inner;

    const { deps, sdk } = makeDeps([
      () => {
        // Fire the abort BEFORE returning from attempt 1's handler — this
        // lands the abort flag in time for attempt 2's pre-handler check
        // in `makeMockSdk`.
        controller.abort();
        return zodThrow;
      },
      // Attempt 2's handler is never actually invoked — the signal pre-check
      // throws APIUserAbortError before reaching it. Provide a stub anyway
      // so an unexpected reach surfaces as "no handler" rather than masking.
      () => ({
        parsed_output: parsedFixture,
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
    const generator = buildGenerator(deps);
    const result = await generator(
      "a robot that waves when something gets close",
      { signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("abort");
      expect(result.message).toContain("auto-repair retry");
    }
    // Both calls were logged (the second hit the abort pre-check).
    expect(sdk.__calls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Input-validation guards (synchronous throws; no API call made)
// ---------------------------------------------------------------------------

describe("buildGenerator — input-validation guards", () => {
  test("empty prompt throws synchronously; zero API calls", async () => {
    const { deps, sdk } = makeDeps([]);
    const generator = buildGenerator(deps);
    await expect(generator("")).rejects.toThrow("empty prompt");
    expect(sdk.__calls.length).toBe(0);
  });

  test("oversize (>5000 chars) prompt throws synchronously; zero API calls", async () => {
    const { deps, sdk } = makeDeps([]);
    const generator = buildGenerator(deps);
    const big = "x".repeat(5001);
    await expect(generator(big)).rejects.toThrow("prompt exceeds 5000 chars");
    expect(sdk.__calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DI override: model name passes through
// ---------------------------------------------------------------------------

describe("buildGenerator — DI override", () => {
  test("override model name reaches the SDK call (production sees default)", async () => {
    const { deps, sdk } = makeDeps(
      [
        () => ({
          parsed_output: parsedFixture,
          stop_reason: "end_turn",
          usage: {
            input_tokens: 100,
            output_tokens: 800,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [{ type: "text", text: JSON.stringify(parsedFixture) }],
        }),
      ],
      { model: "claude-sonnet-4-6-future" },
    );
    const generator = buildGenerator(deps);
    await generator("a robot that waves when something gets close");
    expect(sdk.__calls[0]?.model).toBe("claude-sonnet-4-6-future");
  });
});

// ---------------------------------------------------------------------------
// Gated integration tests
// ---------------------------------------------------------------------------

const HAS_API_KEY = (process.env.ANTHROPIC_API_KEY ?? "") !== "";

const integrationDescribe = HAS_API_KEY ? describe : describe.skip;

integrationDescribe(
  "generate() — integration (requires ANTHROPIC_API_KEY)",
  () => {
    test(
      "produces a doc that passes schema, cross-consistency, AND archetype-1 rules (red bucket empty)",
      async () => {
        const result: GenerateResult = await generate(
          "a robot that waves when something gets close",
        );
        expect(result.ok).toBe(true);
        if (!result.ok) {
          // Surface the failure directly so the test output is informative.
          throw new Error(
            `generate() returned not-ok: kind=${result.kind} message=${result.message} errors=${JSON.stringify(result.errors)}`,
          );
        }
        // Schema gate
        const sg = runSchemaGate(result.doc);
        expect(sg.ok).toBe(true);
        // Cross-consistency gate
        const xc = runCrossConsistencyGate(result.doc);
        expect(xc.ok).toBe(true);
        // Archetype-1 rules — red bucket must be empty
        const rules = runRules(result.doc);
        if (rules.red.length > 0) {
          const red = rules.red.map((a) => `${a.rule.id}: ${a.result.passed ? "" : a.result.message}`);
          throw new Error(
            `archetype-1 rules emitted RED: ${red.join("; ")}`,
          );
        }
        expect(result.doc.archetype_id).toBe("uno-ultrasonic-servo");
      },
      { timeout: 120_000 },
    );

    test(
      "second call within 1h shows cache_read_input_tokens > 0 (cache engaged)",
      async () => {
        // First call primes the cache; second call should hit it.
        // If the system+schema primer is < 2048 tokens this will not
        // engage and the test logs a clear skip message.
        const first = await generate(
          "a robot that waves when something gets close",
        );
        if (!first.ok) {
          throw new Error(
            `first call failed: kind=${first.kind} message=${first.message}`,
          );
        }
        if (
          first.usage.cache_creation_input_tokens === 0 &&
          first.usage.cache_read_input_tokens === 0
        ) {
          process.stdout.write(
            "[generate.test] cache did not engage on first call — system+schema primer likely <2048 tokens. " +
              "Run `bun run measure:prompt-tokens` and pad with archetype-1-fewshot.md, or document no-cache ADR. Skipping cache-read assertion.\n",
          );
          return;
        }
        const second = await generate(
          "a robot that waves when something gets close",
        );
        if (!second.ok) {
          throw new Error(
            `second call failed: kind=${second.kind} message=${second.message}`,
          );
        }
        expect(second.usage.cache_read_input_tokens).toBeGreaterThan(0);
      },
      { timeout: 240_000 },
    );

    test(
      "prefill probe — deliberately constructs an assistant-suffixed message and records the API's response",
      async () => {
        // We probe via a low-level Anthropic client directly to keep the
        // generate() function shape pure. The probe outcome is logged
        // and written into this file's header on first run; future
        // contributors see the latest observed behavior.
        const Anthropic = (await import("@anthropic-ai/sdk")).default;
        const client = new Anthropic({
          apiKey: process.env.ANTHROPIC_API_KEY ?? "",
        });
        let outcome: string;
        try {
          const response = await client.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 200,
            messages: [
              { role: "user", content: "Reply with only the word 'OK'." },
              { role: "assistant", content: "OK" },
            ],
          });
          outcome = `Sonnet 4.6 ACCEPTED an assistant-suffixed message; stop_reason=${response.stop_reason}, response content=${JSON.stringify(response.content).slice(0, 200)}`;
        } catch (err) {
          outcome = `Sonnet 4.6 REJECTED the assistant-suffixed message: ${(err as Error).message.slice(0, 300)}`;
        }
        process.stdout.write(`[prefill probe] ${outcome}\n`);
        // Outcome does NOT gate the test — the multi-turn shape we ship
        // works regardless. We just record it.
        expect(typeof outcome).toBe("string");
      },
      { timeout: 60_000 },
    );
  },
);
