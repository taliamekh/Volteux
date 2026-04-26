/**
 * Unit tests for `pipeline/repair.ts`.
 *
 * Coverage:
 *   - The 3 repairable stems (xconsist, rules, compile) extract correctly
 *     from the template + fill the placeholders.
 *   - The non-repairable kinds (out-of-scope, schema-failed, transport,
 *     truncated, aborted) cause repair() to throw — catches an orchestrator
 *     branching bug at the boundary.
 *   - The repair prompt PRESERVES the original user prompt (the cached
 *     system+schema-primer prefix discipline depends on this — we never
 *     mutate the cached prefix; the new turn appends after it).
 *   - The injected `gen` function is called with the composed prompt;
 *     the helper does not import generate.ts directly.
 *   - Failing errors[] entries beyond 10 are summarized as "... and N
 *     more error(s)" (token-budget discipline).
 *   - The structured prior_doc_summary names the archetype + board +
 *     counts (NOT the literal first 200 chars of the JSON).
 *   - Bounded-repair: this file asserts the helper's stateless contract
 *     (it never tracks state itself); the orchestrator-level bound test
 *     lives in tests/pipeline.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { repair, type RepairableFailure } from "../pipeline/repair.ts";
import type { GenerateResult } from "../pipeline/llm/generate.ts";
import type { PipelineFailureKind } from "../pipeline/index.ts";
import { VolteuxProjectDocumentSchema } from "../schemas/document.zod.ts";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const CANONICAL_FIXTURE = await Bun.file(
  "fixtures/uno-ultrasonic-servo.json",
).json();
const PARSED_DOC = VolteuxProjectDocumentSchema.parse(CANONICAL_FIXTURE);

const PROMPT = "a robot that waves when something gets close";

function makeFailure(
  kind: PipelineFailureKind,
  errors: ReadonlyArray<string> = [],
): RepairableFailure {
  return {
    kind,
    message: `mock ${kind} failure`,
    errors,
  };
}

function makeOkResult(): GenerateResult {
  return {
    ok: true,
    doc: PARSED_DOC,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 4000,
    },
  };
}

// ---------------------------------------------------------------------------
// Stem extraction + placeholder filling
// ---------------------------------------------------------------------------

describe("repair() — stem extraction + placeholder filling", () => {
  test("xconsist-failed produces a prompt containing the xconsist stem", async () => {
    let captured = "";
    const mockGen = async (p: string): Promise<GenerateResult> => {
      captured = p;
      return makeOkResult();
    };
    await repair(
      makeFailure("xconsist-failed", [
        "[check b] connection references unknown component id(s): missing_id",
      ]),
      PARSED_DOC,
      PROMPT,
      mockGen,
    );
    // The prompt is "<original>\n\n---\n\n<filled stem>".
    expect(captured.startsWith(PROMPT)).toBe(true);
    expect(captured).toContain("cross-consistency gate");
    expect(captured).toContain("missing_id");
    // Placeholders MUST be replaced (not literal in the output).
    expect(captured).not.toContain("{{prior_doc_summary}}");
    expect(captured).not.toContain("{{errors_block}}");
  });

  test("rules-red produces a prompt containing the rules stem", async () => {
    let captured = "";
    const mockGen = async (p: string): Promise<GenerateResult> => {
      captured = p;
      return makeOkResult();
    };
    await repair(
      makeFailure("rules-red", [
        "voltage-match: HC-SR04 connected to 3.3V (requires 5V)",
      ]),
      PARSED_DOC,
      PROMPT,
      mockGen,
    );
    expect(captured).toContain("rules engine");
    expect(captured).toContain("voltage-match");
    expect(captured).not.toContain("{{");
  });

  test("compile-failed produces a prompt containing the compile stem", async () => {
    let captured = "";
    const mockGen = async (p: string): Promise<GenerateResult> => {
      captured = p;
      return makeOkResult();
    };
    await repair(
      makeFailure("compile-failed", [
        "/tmp/sketch/sketch.ino:42: error: 'undeclaredVar' was not declared",
      ]),
      PARSED_DOC,
      PROMPT,
      mockGen,
    );
    expect(captured).toContain("arduino-cli compile failed");
    expect(captured).toContain("undeclaredVar");
    expect(captured).not.toContain("{{");
  });
});

// ---------------------------------------------------------------------------
// Original prompt preservation
// ---------------------------------------------------------------------------

describe("repair() — preserves the original user prompt", () => {
  test("the original user prompt appears verbatim at the start of the composed prompt", async () => {
    let captured = "";
    const mockGen = async (p: string): Promise<GenerateResult> => {
      captured = p;
      return makeOkResult();
    };
    const idiosyncraticPrompt =
      "I want a robot that waves when something gets close (specifically: my dog at her bowl)";
    await repair(
      makeFailure("xconsist-failed", ["error a"]),
      PARSED_DOC,
      idiosyncraticPrompt,
      mockGen,
    );
    expect(captured.startsWith(idiosyncraticPrompt)).toBe(true);
    // The composed prompt has the original + a separator + the stem.
    expect(captured).toContain("\n\n---\n\n");
  });
});

// ---------------------------------------------------------------------------
// Non-repairable kinds throw
// ---------------------------------------------------------------------------

describe("repair() — non-repairable kinds throw", () => {
  const NON_REPAIRABLE: ReadonlyArray<PipelineFailureKind> = [
    "out-of-scope",
    "schema-failed",
    "transport",
    "truncated",
    "aborted",
  ];

  for (const kind of NON_REPAIRABLE) {
    test(`${kind} throws (orchestrator should never call repair() with this kind)`, async () => {
      const mockGen = async (): Promise<GenerateResult> => makeOkResult();
      await expect(
        repair(makeFailure(kind), PARSED_DOC, PROMPT, mockGen),
      ).rejects.toThrow(/non-repairable kind/);
    });
  }
});

// ---------------------------------------------------------------------------
// Token-budget discipline (errors capped at 10 + summary suffix)
// ---------------------------------------------------------------------------

describe("repair() — token-budget discipline on errors[]", () => {
  test("more than 10 errors are capped with a '... and N more error(s)' suffix", async () => {
    let captured = "";
    const mockGen = async (p: string): Promise<GenerateResult> => {
      captured = p;
      return makeOkResult();
    };
    const errors = Array.from({ length: 15 }, (_, i) => `error-${i}`);
    await repair(
      makeFailure("xconsist-failed", errors),
      PARSED_DOC,
      PROMPT,
      mockGen,
    );
    // First 10 must appear; #10 onward must NOT appear by name; the
    // suffix names the leftover count.
    for (let i = 0; i < 10; i++) {
      expect(captured).toContain(`error-${i}`);
    }
    expect(captured).not.toContain("error-10");
    expect(captured).toContain("and 5 more error(s)");
  });

  test("≤10 errors do not produce the '... and N more' suffix", async () => {
    let captured = "";
    const mockGen = async (p: string): Promise<GenerateResult> => {
      captured = p;
      return makeOkResult();
    };
    const errors = ["only-error-1", "only-error-2"];
    await repair(
      makeFailure("rules-red", errors),
      PARSED_DOC,
      PROMPT,
      mockGen,
    );
    expect(captured).toContain("only-error-1");
    expect(captured).toContain("only-error-2");
    expect(captured).not.toMatch(/and \d+ more error/);
  });
});

// ---------------------------------------------------------------------------
// Structured prior_doc_summary
// ---------------------------------------------------------------------------

describe("repair() — structured prior_doc_summary", () => {
  test("the prior-doc summary names archetype + board fqbn + counts (NOT the literal first 200 chars)", async () => {
    let captured = "";
    const mockGen = async (p: string): Promise<GenerateResult> => {
      captured = p;
      return makeOkResult();
    };
    await repair(
      makeFailure("compile-failed", ["any error"]),
      PARSED_DOC,
      PROMPT,
      mockGen,
    );
    // The summary is JSON; assert each field appears.
    expect(captured).toContain("uno-ultrasonic-servo");
    expect(captured).toContain("arduino:avr:uno");
    expect(captured).toContain('"components_count":');
    expect(captured).toContain('"libraries_count":');
    // Specifically: the summary should NOT contain a wholesale doc dump
    // (e.g., the connections array is not in the summary).
    expect(captured).not.toContain('"wire_color"');
  });
});

// ---------------------------------------------------------------------------
// Stateless contract (orchestrator owns bounding)
// ---------------------------------------------------------------------------

describe("repair() — stateless (orchestrator owns bounding)", () => {
  test("repeated calls do not throw or accumulate state — bound is the orchestrator's job", async () => {
    let calls = 0;
    const mockGen = async (): Promise<GenerateResult> => {
      calls++;
      return makeOkResult();
    };
    // Three back-to-back calls — the helper doesn't bound itself.
    await repair(
      makeFailure("xconsist-failed", ["err"]),
      PARSED_DOC,
      PROMPT,
      mockGen,
    );
    await repair(
      makeFailure("rules-red", ["err"]),
      PARSED_DOC,
      PROMPT,
      mockGen,
    );
    await repair(
      makeFailure("compile-failed", ["err"]),
      PARSED_DOC,
      PROMPT,
      mockGen,
    );
    expect(calls).toBe(3);
  });

  test("the injected gen function is called exactly once per repair() call", async () => {
    let calls = 0;
    const mockGen = async (): Promise<GenerateResult> => {
      calls++;
      return makeOkResult();
    };
    await repair(
      makeFailure("compile-failed", ["err"]),
      PARSED_DOC,
      PROMPT,
      mockGen,
    );
    expect(calls).toBe(1);
  });

  test("a gen failure is propagated unchanged", async () => {
    const failureResult: GenerateResult = {
      ok: false,
      severity: "red",
      kind: "schema-failed",
      message: "synthetic schema failure",
      errors: ["mock zod issue"],
    };
    const mockGen = async (): Promise<GenerateResult> => failureResult;
    const result = await repair(
      makeFailure("compile-failed", ["err"]),
      PARSED_DOC,
      PROMPT,
      mockGen,
    );
    expect(result).toBe(failureResult);
  });
});
