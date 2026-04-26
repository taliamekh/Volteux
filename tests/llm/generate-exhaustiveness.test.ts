/**
 * Compile-time exhaustiveness guard test for `GenerateFailureKind`.
 *
 * The test asserts that `assertNeverGenerateFailureKind` correctly fails
 * to compile when a switch is missing one of the 5 union members. We
 * write the "negative" case as a `// @ts-expect-error` block so tsc's
 * own check fires when a future contributor adds a 6th literal to the
 * union without updating the switch.
 *
 * This file is loaded by `bun test`, but the runtime assertions are
 * trivial — the real check is the type system rejecting the missing
 * branch. If `// @ts-expect-error` ever stops firing (because the
 * union grew and the switch silently became exhaustive in a different
 * way), the build fails too.
 */

import { test, expect } from "bun:test";
import {
  assertNeverGenerateFailureKind,
  type GenerateFailureKind,
} from "../../pipeline/llm/generate.ts";

/**
 * A correctly-exhaustive switch over `GenerateFailureKind`. Compiles.
 */
function classifyComplete(kind: GenerateFailureKind): string {
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

/**
 * A switch missing the `"abort"` case. tsc must reject this — the
 * `default` branch types `kind` as `"abort"` (the missing literal),
 * which is NOT `never`, so `assertNeverGenerateFailureKind(kind: never)`
 * fails the call-site type check.
 */
function classifyIncomplete(kind: GenerateFailureKind): string {
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
      // @ts-expect-error — `kind` is `"abort"` here, not `never`. If
      // tsc ever stops flagging this, the union grew or the helper
      // weakened, and the exhaustiveness contract is broken.
      assertNeverGenerateFailureKind(kind);
      return "fallback";
  }
}

test("complete switch over GenerateFailureKind compiles and runs", () => {
  expect(classifyComplete("schema-failed")).toBe("schema");
  expect(classifyComplete("truncated")).toBe("trunc");
  expect(classifyComplete("transport")).toBe("tx");
  expect(classifyComplete("sdk-error")).toBe("sdk");
  expect(classifyComplete("abort")).toBe("abort");
});

test("incomplete switch hits the @ts-expect-error fallback at runtime when a missing kind is passed", () => {
  // The runtime side: when "abort" hits the default branch, the
  // assertNever call throws.
  expect(() => classifyIncomplete("abort")).toThrow(
    /Unhandled GenerateFailureKind/,
  );
});

test("assertNeverGenerateFailureKind throws at runtime if reached", () => {
  expect(() => {
    assertNeverGenerateFailureKind("unexpected" as never);
  }).toThrow(/Unhandled GenerateFailureKind/);
});
