/**
 * Unit tests for `pipeline/honest-gap.ts`'s per-kind formatter dispatch.
 *
 * Coverage:
 *   - Every PipelineFailureKind produces the per-decision-matrix scope.
 *   - Every formatter output is a valid VolteuxHonestGap (Zod parse).
 *   - missing_capabilities is always non-empty for partial/out-of-scope.
 *   - explanation is always non-empty.
 *   - out-of-scope honors the classifier_reasoning when set.
 *   - compile-failed honors the compile_stderr when set.
 *   - rules-red honors the first error string when set.
 *
 * The tests assert SHAPE, not exact strings — the per-kind copy is
 * deferred-to-implementation per the plan; it can be tuned by the
 * meta-harness later without breaking these assertions.
 */

import { describe, expect, test } from "bun:test";
import { formatHonestGap } from "../pipeline/honest-gap.ts";
import type {
  PipelineFailure,
  PipelineFailureKind,
} from "../pipeline/index.ts";
import { HonestGapSchema } from "../schemas/document.zod.ts";

const PROMPT = "a robot that waves when something gets close";

function makeFailure(
  kind: PipelineFailureKind,
  extras: Partial<PipelineFailure> = {},
): PipelineFailure {
  return {
    ok: false,
    severity: "red",
    kind,
    message: extras.message ?? `mock ${kind} failure`,
    errors: extras.errors ?? [],
    ...(extras.classifier_reasoning !== undefined
      ? { classifier_reasoning: extras.classifier_reasoning }
      : {}),
    ...(extras.compile_stderr !== undefined
      ? { compile_stderr: extras.compile_stderr }
      : {}),
  };
}

const ALL_KINDS: ReadonlyArray<PipelineFailureKind> = [
  "out-of-scope",
  "schema-failed",
  "compile-failed",
  "rules-red",
  "xconsist-failed",
  "transport",
  "truncated",
  "aborted",
];

describe("formatHonestGap — shape contract", () => {
  test("every kind produces a Zod-valid VolteuxHonestGap", () => {
    for (const kind of ALL_KINDS) {
      const result = formatHonestGap(makeFailure(kind), PROMPT);
      const parsed = HonestGapSchema.safeParse(result);
      expect(parsed.success).toBe(true);
    }
  });

  test("every kind produces a non-empty explanation", () => {
    for (const kind of ALL_KINDS) {
      const result = formatHonestGap(makeFailure(kind), PROMPT);
      expect(result.explanation.length).toBeGreaterThan(0);
    }
  });

  test("every kind produces a non-empty missing_capabilities array (each element non-empty)", () => {
    for (const kind of ALL_KINDS) {
      const result = formatHonestGap(makeFailure(kind), PROMPT);
      expect(result.missing_capabilities.length).toBeGreaterThan(0);
      for (const cap of result.missing_capabilities) {
        expect(cap.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("formatHonestGap — per-kind scope dispatch (per plan decision matrix)", () => {
  test("out-of-scope → scope: out-of-scope", () => {
    const result = formatHonestGap(makeFailure("out-of-scope"), PROMPT);
    expect(result.scope).toBe("out-of-scope");
  });

  test("schema-failed → scope: out-of-scope", () => {
    const result = formatHonestGap(makeFailure("schema-failed"), PROMPT);
    expect(result.scope).toBe("out-of-scope");
  });

  test("compile-failed → scope: partial", () => {
    const result = formatHonestGap(makeFailure("compile-failed"), PROMPT);
    expect(result.scope).toBe("partial");
  });

  test("rules-red → scope: partial", () => {
    const result = formatHonestGap(makeFailure("rules-red"), PROMPT);
    expect(result.scope).toBe("partial");
  });

  test("xconsist-failed → scope: partial", () => {
    const result = formatHonestGap(makeFailure("xconsist-failed"), PROMPT);
    expect(result.scope).toBe("partial");
  });

  test("transport → scope: out-of-scope", () => {
    const result = formatHonestGap(makeFailure("transport"), PROMPT);
    expect(result.scope).toBe("out-of-scope");
  });

  test("truncated → scope: out-of-scope", () => {
    const result = formatHonestGap(makeFailure("truncated"), PROMPT);
    expect(result.scope).toBe("out-of-scope");
  });

  test("aborted → scope: out-of-scope", () => {
    const result = formatHonestGap(makeFailure("aborted"), PROMPT);
    expect(result.scope).toBe("out-of-scope");
  });
});

describe("formatHonestGap — per-kind explanation context", () => {
  test("out-of-scope incorporates classifier_reasoning when set", () => {
    const reasoning =
      "the prompt mentions audio output, which requires the I2S audio archetype";
    const result = formatHonestGap(
      makeFailure("out-of-scope", { classifier_reasoning: reasoning }),
      PROMPT,
    );
    expect(result.explanation).toContain("audio output");
    // missing_capabilities also names the reasoning.
    expect(result.missing_capabilities[0]).toContain("audio");
  });

  test("out-of-scope falls back to generic copy when reasoning is empty", () => {
    const result = formatHonestGap(
      makeFailure("out-of-scope", { classifier_reasoning: "" }),
      PROMPT,
    );
    expect(result.explanation.length).toBeGreaterThan(0);
    expect(result.missing_capabilities[0]).toContain("archetype-1");
  });

  test("compile-failed incorporates compile_stderr when set", () => {
    const stderr =
      "/tmp/sketch/sketch.ino:42:5: error: 'undeclaredVar' was not declared in this scope\n  more lines below";
    const result = formatHonestGap(
      makeFailure("compile-failed", { compile_stderr: stderr }),
      PROMPT,
    );
    // Only the first stderr line should appear in the beginner explanation.
    expect(result.explanation).toContain("undeclaredVar");
    expect(result.explanation).not.toContain("more lines below");
  });

  test("compile-failed falls back to generic copy when stderr is empty", () => {
    const result = formatHonestGap(
      makeFailure("compile-failed", { compile_stderr: "" }),
      PROMPT,
    );
    expect(result.explanation.length).toBeGreaterThan(0);
  });

  test("rules-red incorporates the first errors[] entry when set", () => {
    const result = formatHonestGap(
      makeFailure("rules-red", {
        errors: [
          "voltage-match: HC-SR04 VCC connected to 3.3V (component requires 5V)",
          "current-budget: total 700mA exceeds Uno regulator",
        ],
      }),
      PROMPT,
    );
    expect(result.explanation).toContain("voltage-match");
    expect(result.explanation).toContain("3.3V");
  });

  test("xconsist-failed incorporates the first errors[] entry when set", () => {
    const result = formatHonestGap(
      makeFailure("xconsist-failed", {
        errors: [
          "[check b] connection references unknown component id(s): missing_id",
        ],
      }),
      PROMPT,
    );
    expect(result.explanation).toContain("missing_id");
  });

  test("transport explanation does NOT mention compile_stderr or classifier_reasoning", () => {
    const result = formatHonestGap(
      makeFailure("transport", {
        compile_stderr: "should not be in transport explanation",
        classifier_reasoning: "should not be in transport explanation",
      }),
      PROMPT,
    );
    expect(result.explanation).not.toContain(
      "should not be in transport explanation",
    );
  });

  test("aborted explanation is distinct from transport (different user experience)", () => {
    const transportResult = formatHonestGap(makeFailure("transport"), PROMPT);
    const abortedResult = formatHonestGap(makeFailure("aborted"), PROMPT);
    expect(transportResult.explanation).not.toBe(abortedResult.explanation);
  });
});

describe("formatHonestGap — purity", () => {
  test("two calls with the same input produce identical outputs (no hidden state)", () => {
    const failure = makeFailure("compile-failed", {
      compile_stderr: "deterministic stderr",
    });
    const a = formatHonestGap(failure, PROMPT);
    const b = formatHonestGap(failure, PROMPT);
    expect(a).toEqual(b);
  });

  test("the prompt parameter does not affect output (currently reserved)", () => {
    const failure = makeFailure("compile-failed", {
      compile_stderr: "deterministic stderr",
    });
    const a = formatHonestGap(failure, "prompt A");
    const b = formatHonestGap(failure, "prompt B");
    // The current implementation does not key on the prompt; the
    // signature reserves it for a future per-kind builder.
    expect(a).toEqual(b);
  });
});
