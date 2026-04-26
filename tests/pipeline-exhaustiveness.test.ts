/**
 * Compile-time exhaustiveness guard test for `PipelineFailureKind`.
 *
 * The test asserts that `assertNeverPipelineFailureKind` correctly fails
 * to compile when a switch is missing one of the 8 union members. We
 * write the "negative" case as a `// @ts-expect-error` block so tsc's
 * own check fires when a future contributor adds a 9th literal to the
 * union without updating the switch.
 *
 * This file is loaded by `bun test`, but the runtime assertions are
 * trivial — the real check is the type system rejecting the missing
 * branch. If `// @ts-expect-error` ever stops firing (because the
 * union grew and the switch silently became exhaustive in a different
 * way), the build fails too.
 *
 * Mirrors `tests/llm/generate-exhaustiveness.test.ts` and
 * `tests/llm/classify-exhaustiveness.test.ts` shape.
 */

import { test, expect } from "bun:test";
import {
  assertNeverPipelineFailureKind,
  type PipelineFailureKind,
} from "../pipeline/index.ts";

/**
 * A correctly-exhaustive switch over `PipelineFailureKind`. Compiles.
 */
function classifyComplete(kind: PipelineFailureKind): string {
  switch (kind) {
    case "out-of-scope":
      return "oos";
    case "schema-failed":
      return "schema";
    case "compile-failed":
      return "compile";
    case "rules-red":
      return "rules";
    case "xconsist-failed":
      return "xconsist";
    case "transport":
      return "tx";
    case "truncated":
      return "trunc";
    case "aborted":
      return "abort";
    default:
      assertNeverPipelineFailureKind(kind);
  }
}

/**
 * A switch missing the `"aborted"` case. tsc must reject this — the
 * `default` branch types `kind` as `"aborted"` (the missing literal),
 * which is NOT `never`, so `assertNeverPipelineFailureKind(kind: never)`
 * fails the call-site type check.
 */
function classifyIncomplete(kind: PipelineFailureKind): string {
  switch (kind) {
    case "out-of-scope":
      return "oos";
    case "schema-failed":
      return "schema";
    case "compile-failed":
      return "compile";
    case "rules-red":
      return "rules";
    case "xconsist-failed":
      return "xconsist";
    case "transport":
      return "tx";
    case "truncated":
      return "trunc";
    default:
      // @ts-expect-error — `kind` is `"aborted"` here, not `never`. If
      // tsc ever stops flagging this, the union grew or the helper
      // weakened, and the exhaustiveness contract is broken.
      assertNeverPipelineFailureKind(kind);
      return "fallback";
  }
}

test("complete switch over PipelineFailureKind compiles and runs", () => {
  expect(classifyComplete("out-of-scope")).toBe("oos");
  expect(classifyComplete("schema-failed")).toBe("schema");
  expect(classifyComplete("compile-failed")).toBe("compile");
  expect(classifyComplete("rules-red")).toBe("rules");
  expect(classifyComplete("xconsist-failed")).toBe("xconsist");
  expect(classifyComplete("transport")).toBe("tx");
  expect(classifyComplete("truncated")).toBe("trunc");
  expect(classifyComplete("aborted")).toBe("abort");
});

test("incomplete switch hits the @ts-expect-error fallback at runtime when a missing kind is passed", () => {
  // The runtime side: when "aborted" hits the default branch, the
  // assertNever call throws.
  expect(() => classifyIncomplete("aborted")).toThrow(
    /Unhandled PipelineFailureKind/,
  );
});

test("assertNeverPipelineFailureKind throws at runtime if reached", () => {
  expect(() => {
    assertNeverPipelineFailureKind("unexpected" as never);
  }).toThrow(/Unhandled PipelineFailureKind/);
});
