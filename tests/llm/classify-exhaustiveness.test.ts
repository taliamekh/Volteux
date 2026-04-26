/**
 * Compile-time exhaustiveness guard test for `ClassifyFailureKind`.
 *
 * The test asserts that `assertNeverClassifyFailureKind` correctly fails
 * to compile when a switch is missing one of the 4 union members. We
 * write the "negative" case as a `// @ts-expect-error` block so tsc's
 * own check fires when a future contributor adds a 5th literal to the
 * union without updating the switch.
 *
 * Mirrors `tests/llm/generate-exhaustiveness.test.ts`. This file is
 * loaded by `bun test`, but the runtime assertions are trivial — the
 * real check is the type system rejecting the missing branch. If
 * `// @ts-expect-error` ever stops firing (because the union grew and
 * the switch silently became exhaustive in a different way), the build
 * fails too.
 *
 * **Note on the missing `"truncated"` literal.** Unlike
 * `GenerateFailureKind` (5 literals), `ClassifyFailureKind` is
 * intentionally 4 literals — see the `classify.ts` file header for the
 * rationale (max_tokens=1024 vs ~150-200-token response shape; any
 * truncation surfaces as `schema-failed`). If a future contributor adds
 * `"truncated"` they must:
 *   1. Add a condition in `classify.ts`'s try-block that detects the
 *      truncation path (e.g. `stop_reason === "max_tokens"` AND
 *      `parsed_output === null`).
 *   2. Update this exhaustiveness test to include the new literal.
 *   3. Update `classify.test.ts` to add a mocked-truncated scenario.
 *   4. Update the file header to remove the no-truncated rationale.
 * Adding the literal without (1) is the failure mode the file header
 * warns about — a dead branch with no firing condition.
 */

import { test, expect } from "bun:test";
import {
  assertNeverClassifyFailureKind,
  type ClassifyFailureKind,
} from "../../pipeline/llm/classify.ts";

/**
 * A correctly-exhaustive switch over `ClassifyFailureKind`. Compiles.
 */
function classifyComplete(kind: ClassifyFailureKind): string {
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

/**
 * A switch missing the `"schema-failed"` case. tsc must reject this — the
 * `default` branch types `kind` as `"schema-failed"` (the missing literal),
 * which is NOT `never`, so `assertNeverClassifyFailureKind(kind: never)`
 * fails the call-site type check.
 */
function classifyIncomplete(kind: ClassifyFailureKind): string {
  switch (kind) {
    case "transport":
      return "tx";
    case "sdk-error":
      return "sdk";
    case "abort":
      return "abort";
    default:
      // @ts-expect-error — `kind` is `"schema-failed"` here, not `never`. If
      // tsc ever stops flagging this, the union shrank or the helper
      // weakened, and the exhaustiveness contract is broken.
      assertNeverClassifyFailureKind(kind);
      return "fallback";
  }
}

test("complete switch over ClassifyFailureKind compiles and runs", () => {
  expect(classifyComplete("transport")).toBe("tx");
  expect(classifyComplete("sdk-error")).toBe("sdk");
  expect(classifyComplete("abort")).toBe("abort");
  expect(classifyComplete("schema-failed")).toBe("schema");
});

test("incomplete switch hits the @ts-expect-error fallback at runtime when a missing kind is passed", () => {
  // The runtime side: when "schema-failed" hits the default branch, the
  // assertNever call throws.
  expect(() => classifyIncomplete("schema-failed")).toThrow(
    /Unhandled ClassifyFailureKind/,
  );
});

test("assertNeverClassifyFailureKind throws at runtime if reached", () => {
  expect(() => {
    assertNeverClassifyFailureKind("unexpected" as never);
  }).toThrow(/Unhandled ClassifyFailureKind/);
});
