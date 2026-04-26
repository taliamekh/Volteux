/**
 * Unit tests for the acceptance runner (`tests/acceptance/run.ts`).
 *
 * Coverage (per plan § Unit 8 Test scenarios — every scenario implemented
 * as a discrete test):
 *
 * Frontmatter parser:
 *   - Happy path: a sample frontmatter parses to the expected object.
 *   - Edge: missing closing `---` → FrontmatterError.
 *   - Edge: unknown frontmatter key → FrontmatterError.
 *   - Edge: missing required key → FrontmatterError.
 *   - Edge: out-of-scope kind requires null archetype.
 *   - Edge: ok kind requires non-null archetype.
 *   - Edge: HTML-style comment lines stripped from body.
 *
 * Holdout discipline:
 *   - --tuning-only: synthetic holdout-frontmatter prompt placed in
 *     tuning dir → "holdout discipline violation" exit 1.
 *   - --regen-fixtures: same synthetic case; regen mode also refuses.
 *   - Fingerprint mismatch → exit 1; stderr names offending file.
 *
 * Per-prompt scoring (single prompt at a time; mocked runPipeline):
 *   - schema-only-fail produces correct axes.
 *   - compile-only-fail produces correct axes.
 *   - rules-only-fail produces correct axes.
 *   - all-pass produces correct axes.
 *   - out-of-scope expected + out-of-scope actual = expected_match true,
 *     EXCLUDED from compile_pass denominator.
 *   - out-of-scope expected + in-scope actual = expected_match false.
 *   - in-scope expected + out-of-scope actual = expected_match false +
 *     stderr WARN about classifier rejection.
 *
 * Aggregate gate logic:
 *   - Tuning gates pass when all 3 axes meet thresholds + holdout has
 *     ≥1 passed.
 *   - Tuning gate fail (schema below 99%) → exit 2 + reason listed.
 *   - Tuning gate fail (compile below 95%) → exit 2.
 *   - Tuning gate fail (rules below 90%) → exit 2.
 *   - Holdout 0/5 → exit 2 + "holdout 0/5 — gate requires ≥1".
 *
 * Pre-flight:
 *   - Compile API down → exit 1 BEFORE iterating any prompt.
 *   - Missing API key → exit 1 BEFORE iterating any prompt.
 *
 * Fixture regen:
 *   - On all-success: 25 JSON files written; each parses with schema.
 *   - On partial failure: only successful prompts' fixtures written;
 *     stderr names the failing prompt.
 */

import { describe, expect, test } from "bun:test";
import {
  parsePromptFile,
  scorePrompt,
  aggregateTuning,
  aggregateHoldout,
  evaluateGates,
  checkFingerprints,
  sha256Hex,
  parseFlags,
  runAcceptance,
  FrontmatterError,
  __testing,
  type AcceptanceDeps,
  type AcceptanceFlags,
  type PromptFile,
  type PromptScore,
} from "./run.ts";
import {
  buildPipeline,
  NoopCostTracker,
  type PipelineResult,
} from "../../pipeline/index.ts";
import { NoopTraceWriter } from "../../pipeline/trace.ts";
import {
  VolteuxProjectDocumentSchema,
  type VolteuxProjectDocument,
} from "../../schemas/document.zod.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CANONICAL_FIXTURE = await Bun.file(
  "fixtures/uno-ultrasonic-servo.json",
).json();
const PARSED_DOC: VolteuxProjectDocument =
  VolteuxProjectDocumentSchema.parse(CANONICAL_FIXTURE);

function makeOkPipelineResult(): PipelineResult {
  return {
    ok: true,
    doc: PARSED_DOC,
    hex_b64: "ZmFrZS1oZXg=",
    cost_usd: 0.05,
    run_id: "test-run",
    amber: [],
    blue: [],
  };
}

function makeFailedPipelineResult(
  kind:
    | "out-of-scope"
    | "schema-failed"
    | "compile-failed"
    | "rules-red"
    | "xconsist-failed"
    | "transport"
    | "truncated"
    | "aborted",
): PipelineResult {
  return {
    ok: false,
    severity: "red",
    kind,
    message: `mock ${kind}`,
    errors: [],
    honest_gap: {
      scope: kind === "out-of-scope" ? "out-of-scope" : "partial",
      missing_capabilities: ["mock"],
      explanation: "mock honest gap",
    },
    cost_usd: 0.04,
    run_id: "test-run",
  };
}

function makeTuningPrompt(
  filename: string,
  expected_kind: "ok" | "out-of-scope" = "ok",
  body = "a robot that waves when something gets close",
  holdout = false,
): PromptFile {
  return {
    filename,
    raw: `---\nholdout: ${holdout}\nexpected_kind: ${expected_kind}\nexpected_archetype: ${expected_kind === "ok" ? "uno-ultrasonic-servo" : "null"}\n---\n${body}`,
    frontmatter: {
      holdout,
      expected_kind,
      expected_archetype:
        expected_kind === "ok" ? "uno-ultrasonic-servo" : null,
    },
    body,
    origin: "tuning",
  };
}

function makeHoldoutPrompt(
  filename: string,
  expected_kind: "ok" | "out-of-scope" = "ok",
  body = "wave a small flag when someone approaches my desk",
): PromptFile {
  return {
    filename,
    raw: `---\nholdout: true\nexpected_kind: ${expected_kind}\nexpected_archetype: ${expected_kind === "ok" ? "uno-ultrasonic-servo" : "null"}\n---\n${body}`,
    frontmatter: {
      holdout: true,
      expected_kind,
      expected_archetype:
        expected_kind === "ok" ? "uno-ultrasonic-servo" : null,
    },
    body,
    origin: "holdout",
  };
}

interface RecordingSinks {
  stdout: string[];
  stderr: string[];
  fixtures: Map<string, VolteuxProjectDocument>;
}

function makeRecordingSinks(): RecordingSinks {
  return { stdout: [], stderr: [], fixtures: new Map() };
}

interface MockDepsInput {
  tuningPrompts?: PromptFile[];
  holdoutPrompts?: PromptFile[];
  // Per-prompt result: keyed by prompt filename.
  results?: Map<string, PipelineResult>;
  fingerprints?: Record<string, string>;
  holdoutRaw?: Map<string, string>;
  healthOk?: boolean;
  apiKeyOk?: boolean;
  runIdValue?: string;
}

function makeMockDeps(
  sinks: RecordingSinks,
  input: MockDepsInput = {},
): AcceptanceDeps {
  const tuning = input.tuningPrompts ?? [];
  const holdout = input.holdoutPrompts ?? [];
  // If no fingerprints given, fingerprint check passes automatically.
  // (Compute hashes from holdoutRaw if both provided; otherwise empty.)
  const holdoutRaw = input.holdoutRaw ?? new Map<string, string>();
  let fingerprints = input.fingerprints;
  if (fingerprints === undefined) {
    fingerprints = {};
    for (const [name, raw] of holdoutRaw) {
      fingerprints[name] = sha256Hex(raw);
    }
  }
  const results = input.results ?? new Map<string, PipelineResult>();
  return {
    healthCheck: async () => ({
      ok: input.healthOk ?? true,
      message:
        (input.healthOk ?? true) === false
          ? "Compile API unreachable at http://localhost:8787; run 'bun run compile:up' first"
          : undefined,
    }),
    apiKeyCheck: () => ({
      ok: input.apiKeyOk ?? true,
      message:
        (input.apiKeyOk ?? true) === false
          ? "ANTHROPIC_API_KEY is not set; export it before running 'bun run acceptance'"
          : undefined,
    }),
    readPromptDir: async (origin) => (origin === "tuning" ? tuning : holdout),
    readFingerprints: async () => fingerprints,
    readHoldoutRaw: async () => holdoutRaw,
    runPromptPipeline: async (prompt, trace_dir) => {
      const result = results.get(prompt.filename) ?? makeOkPipelineResult();
      return {
        result,
        trace_path: `${trace_dir}/${prompt.filename.replace(/\.txt$/, "")}.jsonl`,
      };
    },
    writeFixture: async (filename, doc) => {
      sinks.fixtures.set(filename, doc);
    },
    stdout: (line) => sinks.stdout.push(line),
    stderr: (line) => sinks.stderr.push(line),
    generateRunId: () => input.runIdValue ?? "test-acceptance-run-id",
  };
}

function defaultFlags(overrides: Partial<AcceptanceFlags> = {}): AcceptanceFlags {
  return {
    json: false,
    tuningOnly: false,
    holdoutOnly: false,
    regenFixtures: false,
    regenFingerprints: false,
    ...overrides,
  };
}

// ===========================================================================
// Frontmatter parser
// ===========================================================================

describe("parsePromptFile", () => {
  test("happy path — parses frontmatter shape with in-scope expected", () => {
    const raw = `---
holdout: false
expected_kind: ok
expected_archetype: uno-ultrasonic-servo
---
a robot that waves when something gets close
`;
    const { frontmatter, body } = parsePromptFile("01-test.txt", raw);
    expect(frontmatter.holdout).toBe(false);
    expect(frontmatter.expected_kind).toBe("ok");
    expect(frontmatter.expected_archetype).toBe("uno-ultrasonic-servo");
    expect(body).toBe("a robot that waves when something gets close");
  });

  test("happy path — parses out-of-scope frontmatter shape", () => {
    const raw = `---
holdout: false
expected_kind: out-of-scope
expected_archetype: null
---
a scale that weighs my packages and tells me the weight
`;
    const { frontmatter, body } = parsePromptFile("20-test.txt", raw);
    expect(frontmatter.expected_kind).toBe("out-of-scope");
    expect(frontmatter.expected_archetype).toBeNull();
    expect(body).toContain("scale");
  });

  test("happy path — strips HTML-style comment lines from body (holdout freeze comment)", () => {
    const raw = `---
holdout: true
expected_kind: ok
expected_archetype: uno-ultrasonic-servo
---
<!-- SEALED 2026-04-27. Do NOT modify this prompt. -->
wave a small flag when someone approaches my desk
`;
    const { frontmatter, body } = parsePromptFile("h01-test.txt", raw);
    expect(frontmatter.holdout).toBe(true);
    expect(body).not.toContain("<!--");
    expect(body).toBe("wave a small flag when someone approaches my desk");
  });

  test("edge case — missing opening '---' throws FrontmatterError", () => {
    const raw = `holdout: false
expected_kind: ok
expected_archetype: uno-ultrasonic-servo
---
body
`;
    expect(() => parsePromptFile("bad.txt", raw)).toThrow(FrontmatterError);
    try {
      parsePromptFile("bad.txt", raw);
    } catch (err) {
      expect((err as FrontmatterError).filename).toBe("bad.txt");
      expect((err as FrontmatterError).message).toContain("opening '---'");
    }
  });

  test("edge case — missing closing '---' throws FrontmatterError naming the file", () => {
    const raw = `---
holdout: false
expected_kind: ok
expected_archetype: uno-ultrasonic-servo
body without close marker
`;
    expect(() => parsePromptFile("malformed.txt", raw)).toThrow(
      FrontmatterError,
    );
    try {
      parsePromptFile("malformed.txt", raw);
    } catch (err) {
      expect((err as FrontmatterError).filename).toBe("malformed.txt");
      expect((err as FrontmatterError).message).toContain("closing '---'");
    }
  });

  test("edge case — unknown frontmatter key (typo 'expected_kink:') throws", () => {
    const raw = `---
holdout: false
expected_kink: ok
expected_archetype: uno-ultrasonic-servo
---
body
`;
    expect(() => parsePromptFile("typo.txt", raw)).toThrow(/expected_kink/);
  });

  test("edge case — missing required key 'holdout' throws", () => {
    const raw = `---
expected_kind: ok
expected_archetype: uno-ultrasonic-servo
---
body
`;
    expect(() => parsePromptFile("missing.txt", raw)).toThrow(/holdout/);
  });

  test("edge case — out-of-scope kind requires null archetype", () => {
    const raw = `---
holdout: false
expected_kind: out-of-scope
expected_archetype: uno-ultrasonic-servo
---
body
`;
    expect(() => parsePromptFile("inconsistent.txt", raw)).toThrow(
      /out-of-scope.*null/,
    );
  });

  test("edge case — ok kind requires non-null archetype", () => {
    const raw = `---
holdout: false
expected_kind: ok
expected_archetype: null
---
body
`;
    expect(() => parsePromptFile("inconsistent2.txt", raw)).toThrow(
      /ok.*non-null/,
    );
  });

  test("edge case — invalid holdout value (not 'true'/'false') throws", () => {
    const raw = `---
holdout: maybe
expected_kind: ok
expected_archetype: uno-ultrasonic-servo
---
body
`;
    expect(() => parsePromptFile("bad-holdout.txt", raw)).toThrow(/holdout/);
  });

  test("edge case — invalid expected_kind throws", () => {
    const raw = `---
holdout: false
expected_kind: maybe
expected_archetype: uno-ultrasonic-servo
---
body
`;
    expect(() => parsePromptFile("bad-kind.txt", raw)).toThrow(/expected_kind/);
  });

  test("edge case — invalid expected_archetype throws", () => {
    const raw = `---
holdout: false
expected_kind: ok
expected_archetype: not-a-real-archetype
---
body
`;
    expect(() => parsePromptFile("bad-arch.txt", raw)).toThrow(
      /expected_archetype/,
    );
  });

  test("edge case — empty body after frontmatter throws", () => {
    const raw = `---
holdout: false
expected_kind: ok
expected_archetype: uno-ultrasonic-servo
---

`;
    expect(() => parsePromptFile("empty.txt", raw)).toThrow(/empty/);
  });
});

// ===========================================================================
// CLI flag parsing
// ===========================================================================

describe("parseFlags", () => {
  test("default — all flags false", () => {
    expect(parseFlags([])).toEqual({
      json: false,
      tuningOnly: false,
      holdoutOnly: false,
      regenFixtures: false,
      regenFingerprints: false,
    });
  });

  test("--json and --tuning-only and --regen-fixtures combine", () => {
    expect(
      parseFlags(["--json", "--tuning-only", "--regen-fixtures"]),
    ).toEqual({
      json: true,
      tuningOnly: true,
      holdoutOnly: false,
      regenFixtures: true,
      regenFingerprints: false,
    });
  });

  test("--holdout-only is independent", () => {
    expect(parseFlags(["--holdout-only"])).toMatchObject({ holdoutOnly: true });
  });

  test("--regen-fingerprints flag parses", () => {
    expect(parseFlags(["--regen-fingerprints"])).toMatchObject({
      regenFingerprints: true,
    });
  });
});

// ===========================================================================
// Per-prompt scoring
// ===========================================================================

describe("scorePrompt", () => {
  test("all-pass — every axis true; expected_match true for in-scope", () => {
    const prompt = makeTuningPrompt("01.txt", "ok");
    const result = makeOkPipelineResult();
    const score = scorePrompt(prompt, result, "trace.jsonl");
    expect(score.schema_validity).toBe(true);
    expect(score.compile_pass).toBe(true);
    expect(score.rules_clean).toBe(true);
    expect(score.expected_match).toBe(true);
    expect(score.actual_kind).toBe("ok");
    expect(score.actual_archetype).toBe("uno-ultrasonic-servo");
  });

  test("schema-only-fail — schema_validity false, compile_pass false, rules_clean true", () => {
    const prompt = makeTuningPrompt("02.txt", "ok");
    const result = makeFailedPipelineResult("schema-failed");
    const score = scorePrompt(prompt, result, "trace.jsonl");
    expect(score.schema_validity).toBe(false);
    expect(score.compile_pass).toBe(false);
    expect(score.rules_clean).toBe(true);
    expect(score.expected_match).toBe(false);
    expect(score.actual_kind).toBe("schema-failed");
  });

  test("compile-only-fail — schema_validity true, compile_pass false, rules_clean true", () => {
    const prompt = makeTuningPrompt("03.txt", "ok");
    const result = makeFailedPipelineResult("compile-failed");
    const score = scorePrompt(prompt, result, "trace.jsonl");
    expect(score.schema_validity).toBe(true);
    expect(score.compile_pass).toBe(false);
    expect(score.rules_clean).toBe(true);
    expect(score.actual_kind).toBe("compile-failed");
  });

  test("rules-only-fail — schema_validity true, compile_pass false, rules_clean false", () => {
    const prompt = makeTuningPrompt("04.txt", "ok");
    const result = makeFailedPipelineResult("rules-red");
    const score = scorePrompt(prompt, result, "trace.jsonl");
    expect(score.schema_validity).toBe(true);
    expect(score.compile_pass).toBe(false);
    expect(score.rules_clean).toBe(false);
    expect(score.actual_kind).toBe("rules-red");
  });

  test("out-of-scope expected + out-of-scope actual = expected_match true", () => {
    const prompt = makeTuningPrompt("20.txt", "out-of-scope");
    const result = makeFailedPipelineResult("out-of-scope");
    const score = scorePrompt(prompt, result, "trace.jsonl");
    expect(score.expected_match).toBe(true);
    expect(score.compile_pass).toBe(false);
    expect(score.actual_kind).toBe("out-of-scope");
  });

  test("out-of-scope expected + in-scope actual = expected_match FALSE (gate violation)", () => {
    const prompt = makeTuningPrompt("20.txt", "out-of-scope");
    const result = makeOkPipelineResult();
    const score = scorePrompt(prompt, result, "trace.jsonl");
    expect(score.expected_match).toBe(false);
    expect(score.actual_kind).toBe("ok");
    // Note: the runner's gate logic does NOT auto-pass via "ok" outcome
    // when expected_kind is out-of-scope. The runAcceptance test below
    // verifies the stderr surface for this case.
  });

  test("in-scope expected + out-of-scope actual = expected_match FALSE (classifier regression)", () => {
    const prompt = makeTuningPrompt("01.txt", "ok");
    const result = makeFailedPipelineResult("out-of-scope");
    const score = scorePrompt(prompt, result, "trace.jsonl");
    expect(score.expected_match).toBe(false);
    expect(score.actual_kind).toBe("out-of-scope");
  });
});

// ===========================================================================
// Aggregate scoring
// ===========================================================================

describe("aggregateTuning", () => {
  test("all-pass over 25 in-scope prompts produces 100% rates", () => {
    const scores: PromptScore[] = [];
    for (let i = 0; i < 25; i++) {
      scores.push(
        scorePrompt(
          makeTuningPrompt(`${i}.txt`, "ok"),
          makeOkPipelineResult(),
          "t",
        ),
      );
    }
    const agg = aggregateTuning(scores);
    expect(agg.count).toBe(25);
    expect(agg.schema_validity_rate).toBe(1);
    expect(agg.compile_pass_rate).toBe(1);
    expect(agg.rules_clean_rate).toBe(1);
    expect(agg.expected_match_rate).toBe(1);
    expect(agg.out_of_scope_excluded).toBe(0);
  });

  test("24/25 compile-pass — rate is 24/25 = 0.96 (passes 0.95 gate)", () => {
    const scores: PromptScore[] = [];
    for (let i = 0; i < 24; i++) {
      scores.push(
        scorePrompt(
          makeTuningPrompt(`${i}.txt`, "ok"),
          makeOkPipelineResult(),
          "t",
        ),
      );
    }
    scores.push(
      scorePrompt(
        makeTuningPrompt(`24.txt`, "ok"),
        makeFailedPipelineResult("compile-failed"),
        "t",
      ),
    );
    const agg = aggregateTuning(scores);
    expect(agg.compile_pass_rate).toBeCloseTo(24 / 25, 5);
  });

  test("out-of-scope expected prompts EXCLUDED from compile_pass denominator", () => {
    // 19 in-scope all-pass + 6 out-of-scope all matched → compile-pass denom = 19, all 19 pass.
    const scores: PromptScore[] = [];
    for (let i = 0; i < 19; i++) {
      scores.push(
        scorePrompt(
          makeTuningPrompt(`${i}.txt`, "ok"),
          makeOkPipelineResult(),
          "t",
        ),
      );
    }
    for (let i = 19; i < 25; i++) {
      scores.push(
        scorePrompt(
          makeTuningPrompt(`${i}.txt`, "out-of-scope"),
          makeFailedPipelineResult("out-of-scope"),
          "t",
        ),
      );
    }
    const agg = aggregateTuning(scores);
    expect(agg.compile_pass_rate).toBe(1);
    expect(agg.out_of_scope_excluded).toBe(6);
    expect(agg.count).toBe(25);
  });

  test("23/25 schema-valid → schema_validity_rate = 23/25 = 0.92 (BELOW 0.99)", () => {
    const scores: PromptScore[] = [];
    for (let i = 0; i < 23; i++) {
      scores.push(
        scorePrompt(
          makeTuningPrompt(`${i}.txt`, "ok"),
          makeOkPipelineResult(),
          "t",
        ),
      );
    }
    scores.push(
      scorePrompt(
        makeTuningPrompt(`23.txt`, "ok"),
        makeFailedPipelineResult("schema-failed"),
        "t",
      ),
    );
    scores.push(
      scorePrompt(
        makeTuningPrompt(`24.txt`, "ok"),
        makeFailedPipelineResult("schema-failed"),
        "t",
      ),
    );
    const agg = aggregateTuning(scores);
    expect(agg.schema_validity_rate).toBeCloseTo(23 / 25, 5);
  });

  test("empty scores returns 100% (no division-by-zero)", () => {
    const agg = aggregateTuning([]);
    expect(agg.count).toBe(0);
    expect(agg.schema_validity_rate).toBe(1);
    expect(agg.compile_pass_rate).toBe(1);
    expect(agg.rules_clean_rate).toBe(1);
  });
});

describe("aggregateHoldout", () => {
  test("5 in-scope all-pass — passed=5", () => {
    const scores: PromptScore[] = [];
    for (let i = 0; i < 5; i++) {
      scores.push(
        scorePrompt(
          makeHoldoutPrompt(`h0${i}.txt`, "ok"),
          makeOkPipelineResult(),
          "t",
        ),
      );
    }
    const agg = aggregateHoldout(scores);
    expect(agg.passed).toBe(5);
    expect(agg.expected_match_rate).toBe(1);
  });

  test("3 in-scope success + 2 out-of-scope matched — passed=5 (out-of-scope counts on match)", () => {
    const scores: PromptScore[] = [];
    for (let i = 0; i < 3; i++) {
      scores.push(
        scorePrompt(
          makeHoldoutPrompt(`h0${i}.txt`, "ok"),
          makeOkPipelineResult(),
          "t",
        ),
      );
    }
    for (let i = 3; i < 5; i++) {
      scores.push(
        scorePrompt(
          makeHoldoutPrompt(`h0${i}.txt`, "out-of-scope"),
          makeFailedPipelineResult("out-of-scope"),
          "t",
        ),
      );
    }
    const agg = aggregateHoldout(scores);
    expect(agg.passed).toBe(5);
  });

  test("0/5 holdout passed when all compiles fail", () => {
    const scores: PromptScore[] = [];
    for (let i = 0; i < 5; i++) {
      scores.push(
        scorePrompt(
          makeHoldoutPrompt(`h0${i}.txt`, "ok"),
          makeFailedPipelineResult("compile-failed"),
          "t",
        ),
      );
    }
    const agg = aggregateHoldout(scores);
    expect(agg.passed).toBe(0);
  });
});

// ===========================================================================
// Gate evaluation
// ===========================================================================

describe("evaluateGates", () => {
  test("tuning all 100% + holdout 5/5 → pass", () => {
    const tuning = aggregateTuning(
      Array.from({ length: 25 }, (_, i) =>
        scorePrompt(
          makeTuningPrompt(`${i}.txt`, "ok"),
          makeOkPipelineResult(),
          "t",
        ),
      ),
    );
    const holdout = aggregateHoldout(
      Array.from({ length: 5 }, (_, i) =>
        scorePrompt(
          makeHoldoutPrompt(`h0${i}.txt`, "ok"),
          makeOkPipelineResult(),
          "t",
        ),
      ),
    );
    const eval_ = evaluateGates(tuning, holdout);
    expect(eval_.pass).toBe(true);
    expect(eval_.reasons).toEqual([]);
  });

  test("schema below threshold → reason mentions schema_validity_rate", () => {
    const scores: PromptScore[] = Array.from({ length: 25 }, (_, i) => {
      // 23 ok + 2 schema-failed → 92% schema validity (below 99%)
      const result =
        i < 23
          ? makeOkPipelineResult()
          : makeFailedPipelineResult("schema-failed");
      return scorePrompt(makeTuningPrompt(`${i}.txt`, "ok"), result, "t");
    });
    const eval_ = evaluateGates(aggregateTuning(scores), undefined);
    expect(eval_.pass).toBe(false);
    expect(eval_.reasons.some((r) => r.includes("schema_validity_rate"))).toBe(
      true,
    );
  });

  test("compile below threshold → reason mentions compile_pass_rate", () => {
    const scores: PromptScore[] = Array.from({ length: 25 }, (_, i) => {
      // 22/25 compile-pass = 88% (below 95%)
      const result =
        i < 22
          ? makeOkPipelineResult()
          : makeFailedPipelineResult("compile-failed");
      return scorePrompt(makeTuningPrompt(`${i}.txt`, "ok"), result, "t");
    });
    const eval_ = evaluateGates(aggregateTuning(scores), undefined);
    expect(eval_.pass).toBe(false);
    expect(eval_.reasons.some((r) => r.includes("compile_pass_rate"))).toBe(
      true,
    );
  });

  test("rules below threshold → reason mentions rules_clean_rate", () => {
    const scores: PromptScore[] = Array.from({ length: 25 }, (_, i) => {
      // 22/25 rules-clean = 88% (below 90%)
      const result =
        i < 22
          ? makeOkPipelineResult()
          : makeFailedPipelineResult("rules-red");
      return scorePrompt(makeTuningPrompt(`${i}.txt`, "ok"), result, "t");
    });
    const eval_ = evaluateGates(aggregateTuning(scores), undefined);
    expect(eval_.pass).toBe(false);
    expect(eval_.reasons.some((r) => r.includes("rules_clean_rate"))).toBe(
      true,
    );
  });

  test("holdout 0/5 → reason 'holdout 0/5 — gate requires ≥1'", () => {
    const holdoutScores: PromptScore[] = Array.from({ length: 5 }, (_, i) =>
      scorePrompt(
        makeHoldoutPrompt(`h0${i}.txt`, "ok"),
        makeFailedPipelineResult("compile-failed"),
        "t",
      ),
    );
    const eval_ = evaluateGates(undefined, aggregateHoldout(holdoutScores));
    expect(eval_.pass).toBe(false);
    expect(eval_.reasons[0]).toContain("0/5");
    expect(eval_.reasons[0]).toContain("≥1");
  });
});

// ===========================================================================
// Fingerprint check
// ===========================================================================

describe("checkFingerprints", () => {
  test("all matching → ok=true", () => {
    const files = new Map<string, string>([
      ["h01.txt", "content-1"],
      ["h02.txt", "content-2"],
    ]);
    const expected = {
      "h01.txt": sha256Hex("content-1"),
      "h02.txt": sha256Hex("content-2"),
    };
    const result = checkFingerprints(files, expected);
    expect(result.ok).toBe(true);
  });

  test("mismatched hash → ok=false; mismatched populated", () => {
    const files = new Map<string, string>([
      ["h01.txt", "content-edited"],
    ]);
    const expected = {
      "h01.txt": sha256Hex("content-original"),
    };
    const result = checkFingerprints(files, expected);
    expect(result.ok).toBe(false);
    expect(result.mismatched).toEqual(["h01.txt"]);
  });

  test("file on disk missing from fingerprint file → flagged", () => {
    const files = new Map<string, string>([
      ["h01.txt", "x"],
      ["h99.txt", "y"],
    ]);
    const expected = { "h01.txt": sha256Hex("x") };
    const result = checkFingerprints(files, expected);
    expect(result.ok).toBe(false);
    expect(result.missing_from_file).toEqual(["h99.txt"]);
  });

  test("fingerprint listed but file absent → flagged", () => {
    const files = new Map<string, string>([["h01.txt", "x"]]);
    const expected = {
      "h01.txt": sha256Hex("x"),
      "h99.txt": "deadbeef",
    };
    const result = checkFingerprints(files, expected);
    expect(result.ok).toBe(false);
    expect(result.missing_from_disk).toEqual(["h99.txt"]);
  });
});

// ===========================================================================
// runAcceptance — end-to-end runner with mocked deps
// ===========================================================================

describe("runAcceptance — pre-flight checks", () => {
  test("Compile API down → exit 1; never iterates a prompt", async () => {
    let pipelineCalls = 0;
    const sinks = makeRecordingSinks();
    const deps = makeMockDeps(sinks, {
      tuningPrompts: [makeTuningPrompt("01.txt")],
      healthOk: false,
    });
    deps.runPromptPipeline = async (p, t) => {
      pipelineCalls++;
      return {
        result: makeOkPipelineResult(),
        trace_path: `${t}/${p.filename}.jsonl`,
      };
    };
    const code = await runAcceptance(defaultFlags(), deps);
    expect(code).toBe(__testing.EXIT_PREFLIGHT_FAILED);
    expect(pipelineCalls).toBe(0);
    expect(sinks.stderr.join("")).toContain("Compile API unreachable");
  });

  test("ANTHROPIC_API_KEY missing → exit 1", async () => {
    const sinks = makeRecordingSinks();
    const deps = makeMockDeps(sinks, {
      tuningPrompts: [makeTuningPrompt("01.txt")],
      apiKeyOk: false,
    });
    const code = await runAcceptance(defaultFlags(), deps);
    expect(code).toBe(__testing.EXIT_PREFLIGHT_FAILED);
    expect(sinks.stderr.join("")).toContain("ANTHROPIC_API_KEY");
  });

  test("fingerprint mismatch → exit 1; stderr names offending file", async () => {
    const sinks = makeRecordingSinks();
    const holdoutRaw = new Map([["h01.txt", "edited content"]]);
    const fingerprints = { "h01.txt": sha256Hex("original content") };
    const deps = makeMockDeps(sinks, {
      tuningPrompts: [],
      holdoutPrompts: [],
      holdoutRaw,
      fingerprints,
    });
    const code = await runAcceptance(defaultFlags(), deps);
    expect(code).toBe(__testing.EXIT_PREFLIGHT_FAILED);
    const stderr = sinks.stderr.join("");
    expect(stderr).toContain("holdout fingerprint mismatch");
    expect(stderr).toContain("h01.txt");
  });
});

// ===========================================================================
// Holdout discipline — the central correctness assertion
// ===========================================================================

describe("runAcceptance — holdout discipline", () => {
  test("--tuning-only refuses synthetic holdout-frontmatter prompt found in tuning dir", async () => {
    const sinks = makeRecordingSinks();
    // Synthetic: a prompt in the tuning dir whose frontmatter says holdout: true.
    // This mirrors the bad-copy scenario the runner must defend against.
    const stray = makeTuningPrompt("99-stray-holdout.txt", "ok");
    stray.frontmatter.holdout = true;
    const deps = makeMockDeps(sinks, {
      tuningPrompts: [stray],
    });
    const code = await runAcceptance(defaultFlags({ tuningOnly: true }), deps);
    expect(code).toBe(__testing.EXIT_PREFLIGHT_FAILED);
    const stderr = sinks.stderr.join("");
    expect(stderr).toContain("holdout discipline violation");
    expect(stderr).toContain("99-stray-holdout.txt");
  });

  test("--regen-fixtures refuses synthetic holdout-frontmatter prompt in tuning dir", async () => {
    const sinks = makeRecordingSinks();
    const stray = makeTuningPrompt("99-stray-holdout.txt", "ok");
    stray.frontmatter.holdout = true;
    const deps = makeMockDeps(sinks, {
      tuningPrompts: [stray],
    });
    const code = await runAcceptance(
      defaultFlags({ regenFixtures: true, tuningOnly: true }),
      deps,
    );
    expect(code).toBe(__testing.EXIT_PREFLIGHT_FAILED);
    expect(sinks.stderr.join("")).toContain("holdout discipline violation");
  });

  test("normal full run — holdout=true prompts in holdout dir are processed without violation", async () => {
    const sinks = makeRecordingSinks();
    const tuning = [makeTuningPrompt("01.txt", "ok")];
    const holdout = [makeHoldoutPrompt("h01.txt", "ok")];
    const deps = makeMockDeps(sinks, {
      tuningPrompts: tuning,
      holdoutPrompts: holdout,
    });
    const code = await runAcceptance(defaultFlags(), deps);
    // Both should run; gates pass.
    expect(code).toBe(__testing.EXIT_OK);
    expect(sinks.stderr.join("")).not.toContain("discipline violation");
  });
});

// ===========================================================================
// Frontmatter parser propagation through the runner
// ===========================================================================

describe("runAcceptance — malformed frontmatter surfaces at pre-flight", () => {
  test("readPromptDir throwing FrontmatterError → exit 1; stderr names file", async () => {
    const sinks = makeRecordingSinks();
    const deps = makeMockDeps(sinks);
    deps.readPromptDir = async () => {
      throw new FrontmatterError("bad.txt", "missing closing '---'");
    };
    const code = await runAcceptance(defaultFlags(), deps);
    expect(code).toBe(__testing.EXIT_PREFLIGHT_FAILED);
    const stderr = sinks.stderr.join("");
    expect(stderr).toContain("bad.txt");
    expect(stderr).toContain("closing '---'");
  });
});

// ===========================================================================
// Aggregate gate paths
// ===========================================================================

describe("runAcceptance — aggregate gate paths", () => {
  test("happy path — 25 tuning + 5 holdout all pass → exit 0", async () => {
    const sinks = makeRecordingSinks();
    const tuning = Array.from({ length: 25 }, (_, i) =>
      makeTuningPrompt(`${String(i + 1).padStart(2, "0")}.txt`, "ok"),
    );
    const holdout = Array.from({ length: 5 }, (_, i) =>
      makeHoldoutPrompt(`h0${i + 1}.txt`, "ok"),
    );
    const deps = makeMockDeps(sinks, {
      tuningPrompts: tuning,
      holdoutPrompts: holdout,
    });
    const code = await runAcceptance(defaultFlags(), deps);
    expect(code).toBe(__testing.EXIT_OK);
    expect(sinks.stdout.join("")).toContain("gates_pass: yes");
  });

  test("one-of-25 prompts fails compile → 24/25 = 96% compile-pass (passes 0.95) → exit 0", async () => {
    const sinks = makeRecordingSinks();
    const tuning = Array.from({ length: 25 }, (_, i) =>
      makeTuningPrompt(`${String(i + 1).padStart(2, "0")}.txt`, "ok"),
    );
    const holdout = Array.from({ length: 5 }, (_, i) =>
      makeHoldoutPrompt(`h0${i + 1}.txt`, "ok"),
    );
    const results = new Map<string, PipelineResult>();
    // The 25th prompt fails compile.
    results.set("25.txt", makeFailedPipelineResult("compile-failed"));
    const deps = makeMockDeps(sinks, {
      tuningPrompts: tuning,
      holdoutPrompts: holdout,
      results,
    });
    const code = await runAcceptance(defaultFlags(), deps);
    expect(code).toBe(__testing.EXIT_OK);
  });

  test("two-of-25 prompts fail schema → 23/25 = 92% schema-valid (BELOW 0.99) → exit 2", async () => {
    const sinks = makeRecordingSinks();
    const tuning = Array.from({ length: 25 }, (_, i) =>
      makeTuningPrompt(`${String(i + 1).padStart(2, "0")}.txt`, "ok"),
    );
    const holdout = Array.from({ length: 5 }, (_, i) =>
      makeHoldoutPrompt(`h0${i + 1}.txt`, "ok"),
    );
    const results = new Map<string, PipelineResult>();
    results.set("01.txt", makeFailedPipelineResult("schema-failed"));
    results.set("02.txt", makeFailedPipelineResult("schema-failed"));
    const deps = makeMockDeps(sinks, {
      tuningPrompts: tuning,
      holdoutPrompts: holdout,
      results,
    });
    const code = await runAcceptance(defaultFlags(), deps);
    expect(code).toBe(__testing.EXIT_GATES_FAILED);
    expect(sinks.stderr.join("") + sinks.stdout.join("")).toContain(
      "schema_validity_rate",
    );
  });

  test("all 5 holdout fail compile → exit 2; stderr 'holdout 0/5 — gate requires ≥1'", async () => {
    const sinks = makeRecordingSinks();
    const tuning = Array.from({ length: 25 }, (_, i) =>
      makeTuningPrompt(`${String(i + 1).padStart(2, "0")}.txt`, "ok"),
    );
    const holdout = Array.from({ length: 5 }, (_, i) =>
      makeHoldoutPrompt(`h0${i + 1}.txt`, "ok"),
    );
    const results = new Map<string, PipelineResult>();
    for (const p of holdout) {
      results.set(p.filename, makeFailedPipelineResult("compile-failed"));
    }
    const deps = makeMockDeps(sinks, {
      tuningPrompts: tuning,
      holdoutPrompts: holdout,
      results,
    });
    const code = await runAcceptance(defaultFlags(), deps);
    expect(code).toBe(__testing.EXIT_GATES_FAILED);
    const out = sinks.stdout.join("") + sinks.stderr.join("");
    expect(out).toContain("0/5");
  });
});

// ===========================================================================
// Expected-vs-actual classification scenarios (stderr surface)
// ===========================================================================

describe("runAcceptance — expected vs actual classification", () => {
  test("in-scope expected, out-of-scope actual → stderr WARN about classifier regression", async () => {
    const sinks = makeRecordingSinks();
    const prompt = makeTuningPrompt("01.txt", "ok");
    const results = new Map<string, PipelineResult>([
      [prompt.filename, makeFailedPipelineResult("out-of-scope")],
    ]);
    const deps = makeMockDeps(sinks, {
      tuningPrompts: [prompt],
      results,
    });
    await runAcceptance(defaultFlags({ tuningOnly: true }), deps);
    const stderr = sinks.stderr.join("");
    expect(stderr).toContain("classifier rejected an in-scope prompt");
  });

  test("out-of-scope expected, in-scope actual → stderr WARN; expected_match=false", async () => {
    const sinks = makeRecordingSinks();
    const prompt = makeTuningPrompt("20.txt", "out-of-scope");
    const results = new Map<string, PipelineResult>([
      [prompt.filename, makeOkPipelineResult()],
    ]);
    const deps = makeMockDeps(sinks, {
      tuningPrompts: [prompt],
      results,
    });
    await runAcceptance(defaultFlags({ tuningOnly: true }), deps);
    const stderr = sinks.stderr.join("");
    expect(stderr).toContain("pipeline accepted an out-of-scope prompt");
  });
});

// ===========================================================================
// Fixture regen
// ===========================================================================

describe("runAcceptance — --regen-fixtures", () => {
  test("on all-success — N JSON files written; each parses with VolteuxProjectDocumentSchema", async () => {
    const sinks = makeRecordingSinks();
    const tuning = Array.from({ length: 25 }, (_, i) =>
      makeTuningPrompt(`${String(i + 1).padStart(2, "0")}.txt`, "ok"),
    );
    const deps = makeMockDeps(sinks, {
      tuningPrompts: tuning,
    });
    const code = await runAcceptance(
      defaultFlags({ regenFixtures: true, tuningOnly: true }),
      deps,
    );
    expect(code).toBe(__testing.EXIT_OK);
    expect(sinks.fixtures.size).toBe(25);
    for (const [, doc] of sinks.fixtures) {
      // Re-parse the doc shape; should not throw.
      const parsed = VolteuxProjectDocumentSchema.parse(doc);
      expect(parsed.archetype_id).toBe("uno-ultrasonic-servo");
    }
  });

  test("on partial failure (24/25 success) — 24 fixtures written; failed prompt's fixture untouched + stderr names it", async () => {
    const sinks = makeRecordingSinks();
    const tuning = Array.from({ length: 25 }, (_, i) =>
      makeTuningPrompt(`${String(i + 1).padStart(2, "0")}.txt`, "ok"),
    );
    const results = new Map<string, PipelineResult>();
    results.set("13.txt", makeFailedPipelineResult("compile-failed"));
    const deps = makeMockDeps(sinks, {
      tuningPrompts: tuning,
      results,
    });
    await runAcceptance(
      defaultFlags({ regenFixtures: true, tuningOnly: true }),
      deps,
    );
    expect(sinks.fixtures.size).toBe(24);
    expect(sinks.fixtures.has("13.txt")).toBe(false);
    const stderr = sinks.stderr.join("");
    expect(stderr).toContain("13.txt");
    expect(stderr).toContain("prior fixture");
  });

  test("--regen-fixtures does NOT regenerate holdout prompts (holdout-print refusal applies)", async () => {
    const sinks = makeRecordingSinks();
    const tuning = [makeTuningPrompt("01.txt", "ok")];
    const holdout = [makeHoldoutPrompt("h01.txt", "ok")];
    const deps = makeMockDeps(sinks, {
      tuningPrompts: tuning,
      holdoutPrompts: holdout,
    });
    await runAcceptance(
      defaultFlags({ regenFixtures: true, tuningOnly: true }),
      deps,
    );
    // Only the tuning prompt's fixture written.
    expect(sinks.fixtures.size).toBe(1);
    expect(sinks.fixtures.has("01.txt")).toBe(true);
    expect(sinks.fixtures.has("h01.txt")).toBe(false);
  });
});

// ===========================================================================
// JSON output mode
// ===========================================================================

describe("runAcceptance — --json output", () => {
  test("emits a single JSON envelope to stdout with prompts + tuning + holdout + gates_pass", async () => {
    const sinks = makeRecordingSinks();
    const tuning = [makeTuningPrompt("01.txt", "ok")];
    const holdout = [makeHoldoutPrompt("h01.txt", "ok")];
    const deps = makeMockDeps(sinks, {
      tuningPrompts: tuning,
      holdoutPrompts: holdout,
    });
    await runAcceptance(defaultFlags({ json: true }), deps);
    const stdout = sinks.stdout.join("");
    const parsed = JSON.parse(stdout);
    expect(parsed.run_id).toBe("test-acceptance-run-id");
    expect(Array.isArray(parsed.prompts)).toBe(true);
    expect(parsed.prompts.length).toBe(2);
    expect(parsed.gates_pass).toBe(true);
    expect(parsed.tuning).toBeDefined();
    expect(parsed.holdout).toBeDefined();
  });
});

// ===========================================================================
// --regen-fingerprints
// ===========================================================================

describe("runAcceptance — --regen-fingerprints", () => {
  test("emits the SHA-256 map for the holdout files to stdout", async () => {
    const sinks = makeRecordingSinks();
    const holdoutRaw = new Map<string, string>([
      ["h01.txt", "content one"],
      ["h02.txt", "content two"],
    ]);
    const deps = makeMockDeps(sinks, {
      holdoutRaw,
      // The fingerprint check is skipped in --regen-fingerprints mode,
      // so an empty fingerprint map (default) is fine.
    });
    const code = await runAcceptance(
      defaultFlags({ regenFingerprints: true }),
      deps,
    );
    expect(code).toBe(__testing.EXIT_OK);
    const stdout = sinks.stdout.join("");
    const parsed = JSON.parse(stdout);
    expect(parsed["h01.txt"]).toBe(sha256Hex("content one"));
    expect(parsed["h02.txt"]).toBe(sha256Hex("content two"));
  });
});

// ===========================================================================
// Per-prompt trace path naming
// ===========================================================================

describe("runAcceptance — trace path naming", () => {
  test("trace_path lands at traces/acceptance-<run-id>/<filename-no-ext>.jsonl", async () => {
    const sinks = makeRecordingSinks();
    const tuning = [makeTuningPrompt("01-distance-servo.txt", "ok")];
    const deps = makeMockDeps(sinks, {
      tuningPrompts: tuning,
      runIdValue: "fixed-run-id",
    });
    await runAcceptance(defaultFlags({ tuningOnly: true }), deps);
    // The mocked runPromptPipeline writes the synthesized trace path back
    // into the score; the report's prompts[].trace_path reflects it.
    const stdout = sinks.stdout.join("");
    expect(stdout).toContain(
      "traces/acceptance-fixed-run-id",
    );
  });

  test("stderr emits TRACE_DIR=traces/acceptance-<run-id> marker", async () => {
    const sinks = makeRecordingSinks();
    const deps = makeMockDeps(sinks, {
      tuningPrompts: [],
      holdoutPrompts: [],
      runIdValue: "marker-run-id",
    });
    await runAcceptance(defaultFlags(), deps);
    const stderr = sinks.stderr.join("");
    expect(stderr).toContain("TRACE_DIR=traces/acceptance-marker-run-id");
  });
});

// ===========================================================================
// Defensive: runPromptPipeline throws (non-PipelineResult disaster)
// ===========================================================================

describe("runAcceptance — runPromptPipeline throws", () => {
  test("an empty-prompt input-validation throw surfaces with filename + exit 1", async () => {
    const sinks = makeRecordingSinks();
    const tuning = [makeTuningPrompt("01.txt", "ok")];
    const deps = makeMockDeps(sinks, { tuningPrompts: tuning });
    deps.runPromptPipeline = async () => {
      throw new Error("empty prompt");
    };
    const code = await runAcceptance(
      defaultFlags({ tuningOnly: true }),
      deps,
    );
    expect(code).toBe(__testing.EXIT_PREFLIGHT_FAILED);
    const stderr = sinks.stderr.join("");
    expect(stderr).toContain("01.txt");
    expect(stderr).toContain("empty prompt");
  });
});

// ===========================================================================
// Real-prompt smoke (non-runtime) — verify our shipped 30 prompt files all parse
// ===========================================================================

describe("real prompt files parse cleanly", () => {
  test("every shipped tuning prompt parses without error", async () => {
    const dir = "tests/acceptance/prompts/archetype-1/tuning";
    const entries = (await Bun.$`ls ${dir}`.text())
      .split("\n")
      .filter((f) => f.endsWith(".txt"));
    expect(entries.length).toBe(25);
    for (const filename of entries) {
      const raw = await Bun.file(`${dir}/${filename}`).text();
      const { frontmatter } = parsePromptFile(filename, raw);
      expect(frontmatter.holdout).toBe(false);
    }
  });

  test("every shipped holdout prompt parses without error AND has holdout=true", async () => {
    const dir = "tests/acceptance/prompts/archetype-1/holdout";
    const entries = (await Bun.$`ls ${dir}`.text())
      .split("\n")
      .filter((f) => f.endsWith(".txt"));
    expect(entries.length).toBe(5);
    for (const filename of entries) {
      const raw = await Bun.file(`${dir}/${filename}`).text();
      const { frontmatter, body } = parsePromptFile(filename, raw);
      expect(frontmatter.holdout).toBe(true);
      // The freeze comment must NOT be in the body sent to the LLM.
      expect(body).not.toContain("<!--");
      expect(body).not.toContain("SEALED");
    }
  });

  test("committed holdout-fingerprints.json matches every shipped holdout file's SHA-256", async () => {
    const dir = "tests/acceptance/prompts/archetype-1/holdout";
    const fpRaw = await Bun.file(
      "tests/acceptance/holdout-fingerprints.json",
    ).text();
    const fp = JSON.parse(fpRaw) as Record<string, string>;
    const entries = (await Bun.$`ls ${dir}`.text())
      .split("\n")
      .filter((f) => f.endsWith(".txt"));
    expect(Object.keys(fp).length).toBe(entries.length);
    for (const filename of entries) {
      const raw = await Bun.file(`${dir}/${filename}`).text();
      expect(fp[filename]).toBe(sha256Hex(raw));
    }
  });
});

// ===========================================================================
// Dependency sanity — ensure imports compile
// ===========================================================================

describe("imports compile", () => {
  test("buildPipeline + NoopCostTracker + NoopTraceWriter + schema export referenceable", () => {
    expect(typeof buildPipeline).toBe("function");
    expect(typeof NoopCostTracker).toBe("function");
    expect(typeof NoopTraceWriter.emit).toBe("function");
    expect(typeof __testing.VolteuxProjectDocumentSchema.parse).toBe(
      "function",
    );
  });
});
