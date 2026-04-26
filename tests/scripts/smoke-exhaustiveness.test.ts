/**
 * Compile-time exhaustiveness guard test for the smoke script's
 * `SmokeOutcome` discriminated union AND each of the three nested
 * failure-kind unions (`ClassifyFailureKind`, `GenerateFailureKind`,
 * `CompileGateFailureKind`).
 *
 * The smoke script calls `assertNeverClassifyFailureKind`,
 * `assertNeverGenerateFailureKind`, and `assertNeverCompileGateFailureKind`
 * (the renamed-from-`assertNeverFailureKind` guard for
 * `CompileGateFailureKind`) at the default branch of each kind switch.
 * This test mirrors the same pattern with sibling incomplete-switch
 * helpers carrying `// @ts-expect-error` so a future literal added
 * without updating the smoke script's switches fails compile-time at
 * this test as well.
 *
 * Mirrors `tests/llm/generate-exhaustiveness.test.ts` and
 * `tests/llm/classify-exhaustiveness.test.ts`.
 */

import { test, expect } from "bun:test";
import {
  assertNeverGenerateFailureKind,
  type GenerateFailureKind,
} from "../../pipeline/llm/generate.ts";
import {
  assertNeverClassifyFailureKind,
  type ClassifyFailureKind,
} from "../../pipeline/llm/classify.ts";
import {
  assertNeverCompileGateFailureKind,
  type CompileGateFailureKind,
} from "../../pipeline/gates/compile.ts";
import type { SmokeOutcome } from "../../scripts/v01-pipeline-io-smoke.ts";

// ---------------------------------------------------------------------------
// Complete switches over each failure kind compile cleanly.
// ---------------------------------------------------------------------------

function classifyKindComplete(kind: ClassifyFailureKind): string {
  switch (kind) {
    case "transport":
      return "tx";
    case "sdk-error":
      return "sdk";
    case "abort":
      return "abort";
    case "schema-failed":
      return "schema";
    default:
      assertNeverClassifyFailureKind(kind);
  }
}

function generateKindComplete(kind: GenerateFailureKind): string {
  switch (kind) {
    case "schema-failed":
      return "schema";
    case "truncated":
      return "trunc";
    case "transport":
      return "tx";
    case "sdk-error":
      return "sdk";
    case "abort":
      return "abort";
    default:
      assertNeverGenerateFailureKind(kind);
  }
}

function compileKindComplete(kind: CompileGateFailureKind): string {
  switch (kind) {
    case "transport":
      return "tx";
    case "timeout":
      return "to";
    case "auth":
      return "au";
    case "bad-request":
      return "br";
    case "rate-limit":
      return "rl";
    case "queue-full":
      return "qf";
    case "compile-error":
      return "ce";
    default:
      assertNeverCompileGateFailureKind(kind);
  }
}

// ---------------------------------------------------------------------------
// Incomplete switches must fail at the default site (// @ts-expect-error).
// ---------------------------------------------------------------------------

function classifyKindIncomplete(kind: ClassifyFailureKind): string {
  switch (kind) {
    case "transport":
      return "tx";
    case "sdk-error":
      return "sdk";
    case "abort":
      return "abort";
    default:
      // @ts-expect-error — `kind` is `"schema-failed"` here, not `never`.
      assertNeverClassifyFailureKind(kind);
      return "fallback";
  }
}

function generateKindIncomplete(kind: GenerateFailureKind): string {
  switch (kind) {
    case "schema-failed":
      return "schema";
    case "truncated":
      return "trunc";
    case "transport":
      return "tx";
    case "sdk-error":
      return "sdk";
    default:
      // @ts-expect-error — `kind` is `"abort"` here, not `never`.
      assertNeverGenerateFailureKind(kind);
      return "fallback";
  }
}

function compileKindIncomplete(kind: CompileGateFailureKind): string {
  switch (kind) {
    case "transport":
      return "tx";
    case "timeout":
      return "to";
    case "auth":
      return "au";
    case "bad-request":
      return "br";
    case "rate-limit":
      return "rl";
    case "queue-full":
      return "qf";
    default:
      // @ts-expect-error — `kind` is `"compile-error"` here, not `never`.
      assertNeverCompileGateFailureKind(kind);
      return "fallback";
  }
}

// ---------------------------------------------------------------------------
// SmokeOutcome shape — a sample exhaustive switch (proves the discriminated
// union is exported and structurally usable).
// ---------------------------------------------------------------------------

function describeOutcome(o: SmokeOutcome): string {
  switch (o.kind) {
    case "OK":
      return `OK(hex=${o.hex_size_bytes})`;
    case "OUT_OF_SCOPE":
      return `OUT_OF_SCOPE(${o.archetype_id ?? "null"}, ${o.confidence})`;
    case "PROMPT_READ_FAILED":
      return `PROMPT_READ_FAILED(${o.message})`;
    case "CLASSIFY_FAILED":
      return `CLASSIFY_FAILED(${o.failure_kind})`;
    case "GENERATE_FAILED":
      return `GENERATE_FAILED(${o.failure_kind})`;
    case "SCHEMA_FAILED":
      return "SCHEMA_FAILED";
    case "XCONSIST_FAILED":
      return "XCONSIST_FAILED";
    case "RULES_RED":
      return `RULES_RED(${o.count})`;
    case "COMPILE_FAILED":
      return `COMPILE_FAILED(${o.failure_kind})`;
    case "QUEUE_FULL":
      return `QUEUE_FULL(${o.retry_after_s})`;
    default: {
      const _never: never = o;
      throw new Error(`Unhandled SmokeOutcome: ${String(_never)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Runtime guards — minimal, the real proof is the type system.
// ---------------------------------------------------------------------------

test("complete switches over each failure-kind union compile and run", () => {
  expect(classifyKindComplete("transport")).toBe("tx");
  expect(generateKindComplete("truncated")).toBe("trunc");
  expect(compileKindComplete("queue-full")).toBe("qf");
});

test("incomplete switches throw at the default branch when the missing literal is hit", () => {
  expect(() => classifyKindIncomplete("schema-failed")).toThrow(
    /Unhandled ClassifyFailureKind/,
  );
  expect(() => generateKindIncomplete("abort")).toThrow(
    /Unhandled GenerateFailureKind/,
  );
  expect(() => compileKindIncomplete("compile-error")).toThrow(
    /Unhandled CompileGateFailureKind/,
  );
});

test("describeOutcome renders every SmokeOutcome variant", () => {
  expect(
    describeOutcome({
      kind: "OK",
      hex_size_bytes: 1234,
      cache_hit: false,
      latency_ms: 200,
    }),
  ).toBe("OK(hex=1234)");
  expect(
    describeOutcome({
      kind: "OUT_OF_SCOPE",
      archetype_id: null,
      confidence: 0.95,
    }),
  ).toBe("OUT_OF_SCOPE(null, 0.95)");
  expect(
    describeOutcome({ kind: "PROMPT_READ_FAILED", message: "ENOENT: no such file" }),
  ).toBe("PROMPT_READ_FAILED(ENOENT: no such file)");
  expect(
    describeOutcome({ kind: "CLASSIFY_FAILED", failure_kind: "transport" }),
  ).toBe("CLASSIFY_FAILED(transport)");
  expect(
    describeOutcome({ kind: "GENERATE_FAILED", failure_kind: "truncated" }),
  ).toBe("GENERATE_FAILED(truncated)");
  expect(describeOutcome({ kind: "SCHEMA_FAILED" })).toBe("SCHEMA_FAILED");
  expect(describeOutcome({ kind: "XCONSIST_FAILED" })).toBe("XCONSIST_FAILED");
  expect(describeOutcome({ kind: "RULES_RED", count: 3 })).toBe("RULES_RED(3)");
  expect(
    describeOutcome({
      kind: "COMPILE_FAILED",
      failure_kind: "compile-error",
    }),
  ).toBe("COMPILE_FAILED(compile-error)");
  expect(describeOutcome({ kind: "QUEUE_FULL", retry_after_s: 30 })).toBe(
    "QUEUE_FULL(30)",
  );
});
