/**
 * Unit tests for `pipeline/llm/sdk-helpers.ts` — specifically the
 * `isStructuredOutputParseError` detector.
 *
 * The detector relies on a string prefix that is part of an upstream
 * `@anthropic-ai/sdk` contract (`AnthropicError("Failed to parse
 * structured output: ...")`). The SDK has no typed
 * `StructuredOutputParseError` class as of 0.91.1, so the prefix
 * string is the only mechanism for distinguishing parse failures from
 * other AnthropicError throws.
 *
 * Defense-in-depth measures backing the prefix detection:
 *   - `package.json` pins `~0.91.1` (patch-only) so a minor SDK bump
 *     can't silently change the wrapper text.
 *   - This test constructs the same shape the SDK would throw and
 *     asserts the detector recognises it. A future SDK upgrade that
 *     changed the prefix would pass tsc but fail this test — visible
 *     breakage rather than silent auto-repair death.
 */

import { describe, expect, test } from "bun:test";
import { AnthropicError } from "@anthropic-ai/sdk";
import {
  isStructuredOutputParseError,
  extractMessage,
  extractZodIssues,
} from "../../pipeline/llm/sdk-helpers.ts";

describe("isStructuredOutputParseError — prefix-string detection", () => {
  test("returns true for AnthropicError whose message starts with the documented prefix", () => {
    // Mirrors `node_modules/@anthropic-ai/sdk/lib/parser.js`'s wrap:
    //   throw new AnthropicError(`Failed to parse structured output: ${error}`);
    const err = new AnthropicError(
      "Failed to parse structured output: Zod validation failed: 3 issue(s)",
    );
    expect(isStructuredOutputParseError(err)).toBe(true);
  });

  test("returns true for AnthropicError with the exact bare prefix (no suffix)", () => {
    // Defensive: even a bare-prefix message (no inner detail) is
    // structurally a parse error, so the detector must accept it.
    const err = new AnthropicError("Failed to parse structured output");
    expect(isStructuredOutputParseError(err)).toBe(true);
  });

  test("returns false for AnthropicError with a non-matching prefix", () => {
    // Any other AnthropicError shape (e.g. transport, auth) must NOT
    // be misclassified as a parse error — that would route SDK errors
    // through the auto-repair retry instead of through the kind
    // mapper.
    const err = new AnthropicError("connection refused");
    expect(isStructuredOutputParseError(err)).toBe(false);
  });

  test("returns false for a plain Error whose message looks like the prefix", () => {
    // Discrimination is by class first (must be AnthropicError) and
    // prefix second. A plain Error with a colliding message must NOT
    // trigger auto-repair.
    const err = new Error("Failed to parse structured output: ...");
    expect(isStructuredOutputParseError(err)).toBe(false);
  });

  test("returns false for non-Error values (string, null, object)", () => {
    expect(isStructuredOutputParseError("Failed to parse structured output")).toBe(false);
    expect(isStructuredOutputParseError(null)).toBe(false);
    expect(isStructuredOutputParseError(undefined)).toBe(false);
    expect(isStructuredOutputParseError({ message: "Failed to parse structured output" })).toBe(false);
  });
});

describe("extractMessage — best-effort error message extraction", () => {
  test("returns Error.message when the value is an Error", () => {
    expect(extractMessage(new Error("boom"))).toBe("boom");
  });

  test("returns String(err) for non-Error values", () => {
    expect(extractMessage("plain string")).toBe("plain string");
    expect(extractMessage(42)).toBe("42");
    expect(extractMessage(null)).toBe("null");
    expect(extractMessage(undefined)).toBe("undefined");
  });
});

describe("extractZodIssues — best-effort ZodIssue array extraction", () => {
  test("returns issues when the error has cause.issues", () => {
    const err = new Error("Zod validation failed") as Error & {
      cause?: unknown;
    };
    err.cause = {
      issues: [
        { path: ["board"], message: "Required" },
        { path: ["sketch", "main_ino"], message: "Expected string" },
      ],
    };
    const issues = extractZodIssues(err);
    expect(issues.length).toBe(2);
    expect(issues[0]?.message).toBe("Required");
    expect(issues[1]?.message).toBe("Expected string");
  });

  test("unwraps a second cause level (the SDK's wrapped form)", () => {
    // `makeOutputFormat().parse` throws `Error("Zod validation failed: N
    // issue(s)")` whose `.cause` is the ZodError. The SDK then wraps
    // THAT in an `AnthropicError("Failed to parse structured output:
    // <inner>")`. extractZodIssues unwraps both layers.
    const inner = new Error("Zod validation failed: 1 issue(s)") as Error & {
      cause?: unknown;
    };
    inner.cause = { issues: [{ path: ["x"], message: "bad" }] };
    const outer = new Error(
      "Failed to parse structured output: Zod validation failed",
    ) as Error & { cause?: unknown };
    outer.cause = inner;
    const issues = extractZodIssues(outer);
    expect(issues.length).toBe(1);
    expect(issues[0]?.message).toBe("bad");
  });

  test("returns [] when err is not an Error", () => {
    expect(extractZodIssues("string")).toEqual([]);
    expect(extractZodIssues(null)).toEqual([]);
  });

  test("returns [] when err.cause is missing or null", () => {
    expect(extractZodIssues(new Error("no cause"))).toEqual([]);
    const err = new Error("null cause") as Error & { cause?: unknown };
    err.cause = null;
    expect(extractZodIssues(err)).toEqual([]);
  });

  test("filters out non-ZodIssue-shaped elements (defensive)", () => {
    // The detector only enforces `path: unknown[]` and `message: string`.
    // Stray non-issue elements are filtered rather than rendered as
    // bullet points in the repair prompt.
    const err = new Error("noise") as Error & { cause?: unknown };
    err.cause = {
      issues: [
        { path: ["valid"], message: "good" },
        "not-an-issue",
        null,
        { path: "not-an-array", message: "still bad" },
      ],
    };
    const issues = extractZodIssues(err);
    expect(issues.length).toBe(1);
    expect(issues[0]?.message).toBe("good");
  });
});
