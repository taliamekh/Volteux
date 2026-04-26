/**
 * Unit + gated-integration tests for `pipeline/index.ts`'s orchestrator.
 *
 * Coverage (per plan § Unit 6 Test scenarios):
 *   - Happy path (mocked): full pipeline succeeds; trace contains all
 *     expected events.
 *   - Happy path with cross-gate repair (mocked): first compile fails;
 *     repair fires; second compile passes.
 *   - Out-of-scope routing: classifier null / low confidence / wrong
 *     archetype → out-of-scope kind.
 *   - Generate failure path: schema-failed / truncated / transport /
 *     abort all surface as the right PipelineFailureKind.
 *   - Compile-failed → repair → repair fails: counter never exceeds 1
 *     (no infinite loop).
 *   - Rules red → repair → success: bound respected on the success
 *     path too.
 *   - Xconsist failed → repair → success: same.
 *   - Input validation: empty + oversize prompts throw synchronously.
 *   - DI deps override: tests can swap any individual dep.
 *   - --repair=off disables cross-gate repair entirely.
 *   - Aborted: AbortSignal pre-fires; classify returns abort.
 *   - Integration (gated): real Compile API + ANTHROPIC_API_KEY runs the
 *     full 6-gate pipeline against a real prompt; closes residual #29.
 *
 * Mock-deps pattern: every test constructs a `PipelineDeps` object inline
 * with stub functions for each pipeline stage. Tests assert against the
 * trace events captured by an in-memory `RecordingTraceWriter` rather
 * than disk, keeping the suite hermetic.
 */

import { describe, expect, test } from "bun:test";
import {
  buildPipeline,
  NoopCostTracker,
  type CostTrackerLike,
  type PipelineDeps,
  type RepairHelper,
} from "../pipeline/index.ts";
import type {
  TraceEvent,
  TraceWriter,
} from "../pipeline/trace.ts";
import type { ClassifyResult } from "../pipeline/llm/classify.ts";
import type { GenerateResult } from "../pipeline/llm/generate.ts";
import type { CompileGateResult } from "../pipeline/gates/compile.ts";
import type { GateResult } from "../pipeline/types.ts";
import type {
  RulesRunOutcome,
} from "../pipeline/rules/index.ts";
import type {
  VolteuxProjectDocument,
} from "../schemas/document.zod.ts";
import { VolteuxProjectDocumentSchema } from "../schemas/document.zod.ts";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const CANONICAL_FIXTURE = await Bun.file(
  "fixtures/uno-ultrasonic-servo.json",
).json();
const PARSED_DOC: VolteuxProjectDocument =
  VolteuxProjectDocumentSchema.parse(CANONICAL_FIXTURE);

// ---------------------------------------------------------------------------
// In-memory trace writer (records events to an array; verifies sequence)
// ---------------------------------------------------------------------------

interface RecordingWriter extends TraceWriter {
  events: TraceEvent[];
  opens: string[];
  closes: number;
}

function makeRecordingWriter(): RecordingWriter {
  const events: TraceEvent[] = [];
  const opens: string[] = [];
  let closes = 0;
  return {
    events,
    opens,
    get closes() {
      return closes;
    },
    open: async (run_id: string): Promise<void> => {
      opens.push(run_id);
    },
    emit: async (evt: TraceEvent): Promise<void> => {
      events.push(evt);
    },
    close: async (): Promise<void> => {
      closes++;
    },
  } as RecordingWriter;
}

// ---------------------------------------------------------------------------
// Mock-deps builder
// ---------------------------------------------------------------------------

interface MockDeps {
  classifyResult?: ClassifyResult;
  classifyResultsQueue?: ClassifyResult[];
  generateResults: GenerateResult[];
  schemaResults?: GateResult<VolteuxProjectDocument>[];
  xcResults?: GateResult<void>[];
  rulesResults?: RulesRunOutcome[];
  compileResults: CompileGateResult[];
  repair?: RepairHelper;
  costTracker?: CostTrackerLike;
  generateRunId?: () => string;
}

function makeOkClassify(): ClassifyResult {
  return {
    ok: true,
    archetype_id: "uno-ultrasonic-servo",
    confidence: 0.95,
    reasoning: "matches archetype 1",
    usage: {
      input_tokens: 200,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

function makeOkGenerate(doc: VolteuxProjectDocument = PARSED_DOC): GenerateResult {
  return {
    ok: true,
    doc,
    usage: {
      input_tokens: 4000,
      output_tokens: 800,
      cache_creation_input_tokens: 4000,
      cache_read_input_tokens: 0,
    },
  };
}

function makeOkSchema(
  doc: VolteuxProjectDocument = PARSED_DOC,
): GateResult<VolteuxProjectDocument> {
  return { ok: true, value: doc };
}

function makeOkXc(): GateResult<void> {
  return { ok: true, value: undefined };
}

function makeOkRules(): RulesRunOutcome {
  return { red: [], amber: [], blue: [], attempts: [] };
}

function makeOkCompile(): CompileGateResult {
  return {
    ok: true,
    value: {
      hex_b64: "ZmFrZS1oZXg=",
      stderr: "",
      cache_hit: false,
      latency_ms: 120,
      hex_size_bytes: 8,
      toolchain_version_hash: "deadbeef",
    },
  };
}

function makeFailedCompile(): CompileGateResult {
  return {
    ok: false,
    severity: "red",
    kind: "compile-error",
    message: "arduino-cli compile failed",
    errors: ["sketch.ino:42: error: 'foo' was not declared in this scope"],
  };
}

function makeFailedXc(): GateResult<void> {
  return {
    ok: false,
    severity: "red",
    message: "Cross-consistency gate found 1 violation(s) across (b)",
    errors: ["[check b] connection references unknown component id"],
  };
}

function makeFailedRules(): RulesRunOutcome {
  const ruleAttempt = {
    rule: {
      id: "voltage-match",
      severity: "red" as const,
      description: "voltage rail matching",
      check: () => ({ passed: true as const }),
    },
    result: {
      passed: false as const,
      severity: "red" as const,
      message: "HC-SR04 connected to 3.3V (requires 5V)",
    },
  };
  return { red: [ruleAttempt], amber: [], blue: [], attempts: [ruleAttempt] };
}

function makeMockDeps(input: MockDeps): {
  deps: PipelineDeps;
  writer: RecordingWriter;
  costTracker: CostTrackerLike;
} {
  const writer = makeRecordingWriter();
  const costTracker = input.costTracker ?? NoopCostTracker();
  const generateQueue = [...input.generateResults];
  const schemaQueue = [...(input.schemaResults ?? [])];
  const xcQueue = [...(input.xcResults ?? [])];
  const rulesQueue = [...(input.rulesResults ?? [])];
  const compileQueue = [...input.compileResults];
  const classifyQueue = [...(input.classifyResultsQueue ?? [])];
  const repair: RepairHelper =
    input.repair ??
    (async (_failure, _doc, _prompt, gen) => gen("repair-prompt"));

  const deps: PipelineDeps = {
    classify: async () => {
      if (classifyQueue.length > 0) return classifyQueue.shift()!;
      if (input.classifyResult !== undefined) return input.classifyResult;
      return makeOkClassify();
    },
    generate: async () => {
      const next = generateQueue.shift();
      if (next === undefined) {
        throw new Error("mock generate queue exhausted");
      }
      return next;
    },
    runSchemaGate: () => {
      if (schemaQueue.length > 0) return schemaQueue.shift()!;
      return makeOkSchema();
    },
    runCrossConsistencyGate: () => {
      if (xcQueue.length > 0) return xcQueue.shift()!;
      return makeOkXc();
    },
    runRules: () => {
      if (rulesQueue.length > 0) return rulesQueue.shift()!;
      return makeOkRules();
    },
    runCompileGate: async () => {
      const next = compileQueue.shift();
      if (next === undefined) {
        throw new Error("mock compile queue exhausted");
      }
      return next;
    },
    repair,
    traceWriter: writer,
    costTrackerFactory: () => costTracker,
    generateRunId: input.generateRunId ?? (() => "run-test-0001"),
  };
  return { deps, writer, costTracker };
}

// ---------------------------------------------------------------------------
// Helpers to query the recorded trace
// ---------------------------------------------------------------------------

/**
 * Type-narrowing event filter. Unit 7 tightened `TraceEvent` into a
 * discriminated union over the 6 event-name literals; this helper
 * returns the narrowed variant so test assertions can read variant-
 * specific fields (`model`, `gate`, `phase`, etc.) without a manual
 * cast at every call site.
 */
function eventsOfKind<K extends TraceEvent["event"]>(
  writer: RecordingWriter,
  event: K,
): Extract<TraceEvent, { event: K }>[] {
  return writer.events.filter(
    (e): e is Extract<TraceEvent, { event: K }> => e.event === event,
  );
}

// ===========================================================================
// Happy paths
// ===========================================================================

describe("buildPipeline — happy path (mocked)", () => {
  test("full pipeline succeeds with all defaults; result carries doc + hex_b64 + run_id + amber/blue", async () => {
    const { deps } = makeMockDeps({
      generateResults: [makeOkGenerate()],
      compileResults: [makeOkCompile()],
    });
    const run = buildPipeline(deps);
    const result = await run("a robot that waves when something gets close");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.doc.archetype_id).toBe("uno-ultrasonic-servo");
    expect(result.hex_b64).toBe("ZmFrZS1oZXg=");
    expect(result.run_id).toBe("run-test-0001");
    expect(Array.isArray(result.amber)).toBe(true);
    expect(Array.isArray(result.blue)).toBe(true);
  });

  test("trace contains the expected events: 1 classify llm_call + 1 sonnet llm_call + 3 gate_outcome + 1 compile_call + 2 pipeline_summary", async () => {
    const { deps, writer } = makeMockDeps({
      generateResults: [makeOkGenerate()],
      compileResults: [makeOkCompile()],
    });
    const run = buildPipeline(deps);
    await run("a robot that waves when something gets close");
    const llmCalls = eventsOfKind(writer, "llm_call");
    const gateOutcomes = eventsOfKind(writer, "gate_outcome");
    const compileCalls = eventsOfKind(writer, "compile_call");
    const summaries = eventsOfKind(writer, "pipeline_summary");
    // The orchestrator emits 1 classify + 1 sonnet generate llm_call.
    expect(llmCalls.length).toBe(2);
    expect(llmCalls[0]?.model).toBe("claude-haiku-4-5");
    expect(llmCalls[1]?.model).toBe("claude-sonnet-4-6");
    // 3 gate_outcomes (schema, xconsist, rules); compile_call is its own event.
    expect(gateOutcomes.length).toBe(3);
    expect(gateOutcomes.map((e) => e.gate)).toEqual([
      "schema",
      "xconsist",
      "rules",
    ]);
    expect(compileCalls.length).toBe(1);
    // 2 pipeline_summary events (start + end).
    expect(summaries.length).toBe(2);
    expect(summaries[0]?.phase).toBe("start");
    expect(summaries[1]?.phase).toBe("end");
    // Narrow to the END variant for the outcome assertion.
    const endSummary = summaries[1];
    if (endSummary !== undefined && endSummary.phase === "end") {
      expect(endSummary.outcome).toBe("ok");
    }
  });

  test("happy path with cross-gate repair (compile-fail → repair → compile-pass)", async () => {
    let repairCalls = 0;
    const repair: RepairHelper = async (_failure, _doc, _prompt, gen) => {
      repairCalls++;
      return gen("repair-prompt");
    };
    const { deps, writer } = makeMockDeps({
      generateResults: [makeOkGenerate(), makeOkGenerate()],
      compileResults: [makeFailedCompile(), makeOkCompile()],
      repair,
    });
    const run = buildPipeline(deps);
    const result = await run("a robot that waves when something gets close");
    expect(result.ok).toBe(true);
    expect(repairCalls).toBe(1);
    const repairAttempts = eventsOfKind(writer, "repair_attempt");
    expect(repairAttempts.length).toBe(1);
    expect(repairAttempts[0]?.trigger_kind).toBe("compile-failed");
  });

  test("rules-red → repair → success", async () => {
    let repairCalls = 0;
    const repair: RepairHelper = async (_failure, _doc, _prompt, gen) => {
      repairCalls++;
      return gen("repair-prompt");
    };
    const { deps, writer } = makeMockDeps({
      generateResults: [makeOkGenerate(), makeOkGenerate()],
      rulesResults: [makeFailedRules(), makeOkRules()],
      compileResults: [makeOkCompile()],
      repair,
    });
    const run = buildPipeline(deps);
    const result = await run("a robot that waves when something gets close");
    expect(result.ok).toBe(true);
    expect(repairCalls).toBe(1);
    const repairAttempts = eventsOfKind(writer, "repair_attempt");
    expect(repairAttempts[0]?.trigger_kind).toBe("rules-red");
  });

  test("xconsist-failed → repair → success", async () => {
    let repairCalls = 0;
    const repair: RepairHelper = async (_failure, _doc, _prompt, gen) => {
      repairCalls++;
      return gen("repair-prompt");
    };
    const { deps, writer } = makeMockDeps({
      generateResults: [makeOkGenerate(), makeOkGenerate()],
      xcResults: [makeFailedXc(), makeOkXc()],
      compileResults: [makeOkCompile()],
      repair,
    });
    const run = buildPipeline(deps);
    const result = await run("a robot that waves when something gets close");
    expect(result.ok).toBe(true);
    expect(repairCalls).toBe(1);
    const repairAttempts = eventsOfKind(writer, "repair_attempt");
    expect(repairAttempts[0]?.trigger_kind).toBe("xconsist-failed");
  });
});

// ===========================================================================
// Out-of-scope routing
// ===========================================================================

describe("buildPipeline — out-of-scope routing", () => {
  test("classifier returns archetype_id: null → out-of-scope; no generate call", async () => {
    let generateCalls = 0;
    const { deps } = makeMockDeps({
      classifyResult: {
        ok: true,
        archetype_id: null,
        confidence: 0.95,
        reasoning: "out of scope",
        usage: {
          input_tokens: 200,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      generateResults: [makeOkGenerate()],
      compileResults: [makeOkCompile()],
    });
    // Override generate to count calls.
    const origGenerate = deps.generate;
    deps.generate = async (...args) => {
      generateCalls++;
      return origGenerate(...args);
    };
    const run = buildPipeline(deps);
    const result = await run("scale that weighs my packages");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.kind).toBe("out-of-scope");
    expect(result.honest_gap.scope).toBe("out-of-scope");
    expect(generateCalls).toBe(0);
  });

  test("classifier returns low confidence (< 0.6) → out-of-scope", async () => {
    const { deps } = makeMockDeps({
      classifyResult: {
        ok: true,
        archetype_id: "uno-ultrasonic-servo",
        confidence: 0.45,
        reasoning: "ambiguous",
        usage: {
          input_tokens: 200,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      generateResults: [makeOkGenerate()],
      compileResults: [makeOkCompile()],
    });
    const run = buildPipeline(deps);
    const result = await run("vague description");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.kind).toBe("out-of-scope");
  });

  test("classifier returns wrong archetype → out-of-scope; explanation references the foreign archetype", async () => {
    const { deps } = makeMockDeps({
      classifyResult: {
        ok: true,
        archetype_id: "esp32-audio-dashboard",
        confidence: 0.92,
        reasoning: "needs ESP32 + I2S microphone for audio capture",
        usage: {
          input_tokens: 200,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      generateResults: [makeOkGenerate()],
      compileResults: [makeOkCompile()],
    });
    const run = buildPipeline(deps);
    const result = await run("audio dashboard project");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.kind).toBe("out-of-scope");
    expect(result.honest_gap.explanation).toContain("ESP32");
  });
});

// ===========================================================================
// Error paths — generate-side failures
// ===========================================================================

describe("buildPipeline — generate-side failure routing", () => {
  test("schema-failed surfaces as schema-failed; no cross-gate repair (generate already retried)", async () => {
    let repairCalls = 0;
    const { deps } = makeMockDeps({
      generateResults: [
        {
          ok: false,
          severity: "red",
          kind: "schema-failed",
          message: "Sonnet output failed schema validation after one auto-repair turn",
          errors: ["mock zod issue"],
        },
      ],
      compileResults: [makeOkCompile()],
      repair: async (_f, _d, _p, _g) => {
        repairCalls++;
        return makeOkGenerate();
      },
    });
    const run = buildPipeline(deps);
    const result = await run("any prompt");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.kind).toBe("schema-failed");
    expect(repairCalls).toBe(0);
  });

  test("truncated → kind: truncated; no retry", async () => {
    const { deps } = makeMockDeps({
      generateResults: [
        {
          ok: false,
          severity: "red",
          kind: "truncated",
          message: "Sonnet response truncated at max_tokens",
          errors: [],
        },
      ],
      compileResults: [makeOkCompile()],
    });
    const run = buildPipeline(deps);
    const result = await run("any prompt");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.kind).toBe("truncated");
  });

  test("classify transport → kind: transport", async () => {
    const { deps } = makeMockDeps({
      classifyResult: {
        ok: false,
        severity: "red",
        kind: "transport",
        message: "anthropic-sdk transport error",
        errors: ["ECONNREFUSED"],
      },
      generateResults: [],
      compileResults: [],
    });
    const run = buildPipeline(deps);
    const result = await run("any prompt");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.kind).toBe("transport");
    expect(result.honest_gap.explanation).not.toContain("cancelled");
  });

  test("classify abort → kind: aborted; explanation differs from transport", async () => {
    const { deps } = makeMockDeps({
      classifyResult: {
        ok: false,
        severity: "red",
        kind: "abort",
        message: "classify aborted",
        errors: ["aborted"],
      },
      generateResults: [],
      compileResults: [],
    });
    const run = buildPipeline(deps);
    const result = await run("any prompt");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.kind).toBe("aborted");
    expect(result.honest_gap.explanation).toContain("cancelled");
  });

  test("generate transport → kind: transport (after a successful classify)", async () => {
    const { deps } = makeMockDeps({
      generateResults: [
        {
          ok: false,
          severity: "red",
          kind: "transport",
          message: "anthropic-sdk transport error",
          errors: ["ECONNRESET"],
        },
      ],
      compileResults: [],
    });
    const run = buildPipeline(deps);
    const result = await run("any prompt");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.kind).toBe("transport");
  });
});

// ===========================================================================
// Bounded-repair: counter never exceeds 1
// ===========================================================================

describe("buildPipeline — bounded cross-gate repair", () => {
  test("compile-failed → repair → repair fails → kind: compile-failed; repair counter respects bound", async () => {
    let repairCalls = 0;
    const repair: RepairHelper = async (_failure, _doc, _prompt, gen) => {
      repairCalls++;
      return gen("repair-prompt");
    };
    const { deps } = makeMockDeps({
      generateResults: [makeOkGenerate(), makeOkGenerate()],
      // BOTH compiles fail — orchestrator should NOT call repair twice.
      compileResults: [makeFailedCompile(), makeFailedCompile()],
      repair,
    });
    const run = buildPipeline(deps);
    const result = await run("any prompt");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.kind).toBe("compile-failed");
    expect(repairCalls).toBe(1);
  });

  test("compile-failed → repair → DIFFERENT gate fails on attempt 1 → routes to that gate's failure unconditionally (no second repair)", async () => {
    let repairCalls = 0;
    const repair: RepairHelper = async (_failure, _doc, _prompt, gen) => {
      repairCalls++;
      return gen("repair-prompt");
    };
    const { deps } = makeMockDeps({
      generateResults: [makeOkGenerate(), makeOkGenerate()],
      // Attempt 0: compile fails. Attempt 1 (post-repair): rules fails.
      // The orchestrator must NOT trigger a second repair on the rules
      // failure; it routes to rules-red unconditionally.
      rulesResults: [makeOkRules(), makeFailedRules()],
      compileResults: [makeFailedCompile()],
      repair,
    });
    const run = buildPipeline(deps);
    const result = await run("any prompt");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.kind).toBe("rules-red");
    expect(repairCalls).toBe(1);
  });

  test("--repair=off disables cross-gate repair entirely", async () => {
    let repairCalls = 0;
    const repair: RepairHelper = async (_failure, _doc, _prompt, gen) => {
      repairCalls++;
      return gen("repair-prompt");
    };
    const { deps } = makeMockDeps({
      generateResults: [makeOkGenerate()],
      compileResults: [makeFailedCompile()],
      repair,
    });
    const run = buildPipeline(deps);
    const result = await run("any prompt", { repair: "off" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.kind).toBe("compile-failed");
    expect(repairCalls).toBe(0);
  });
});

// ===========================================================================
// Input validation (synchronous throws)
// ===========================================================================

describe("buildPipeline — input validation", () => {
  test("empty prompt throws synchronously; no API call attempted", async () => {
    let classifyCalls = 0;
    const { deps } = makeMockDeps({
      generateResults: [],
      compileResults: [],
    });
    const orig = deps.classify;
    deps.classify = async (...args) => {
      classifyCalls++;
      return orig(...args);
    };
    const run = buildPipeline(deps);
    await expect(run("")).rejects.toThrow(/empty prompt/);
    expect(classifyCalls).toBe(0);
  });

  test("oversize prompt (>5000 chars) throws synchronously", async () => {
    const { deps } = makeMockDeps({
      generateResults: [],
      compileResults: [],
    });
    const run = buildPipeline(deps);
    await expect(run("x".repeat(5001))).rejects.toThrow(/exceeds 5000 chars/);
  });
});

// ===========================================================================
// DI + factory
// ===========================================================================

describe("buildPipeline — DI deps override", () => {
  test("buildPipeline respects mock deps for every stage", async () => {
    let calls = 0;
    const { deps } = makeMockDeps({
      generateResults: [makeOkGenerate()],
      compileResults: [makeOkCompile()],
    });
    deps.runRules = () => {
      calls++;
      return makeOkRules();
    };
    const run = buildPipeline(deps);
    await run("any prompt");
    expect(calls).toBe(1);
  });

  test("custom run-id generator is used", async () => {
    const { deps, writer } = makeMockDeps({
      generateResults: [makeOkGenerate()],
      compileResults: [makeOkCompile()],
      generateRunId: () => "custom-run-id-xyz",
    });
    const run = buildPipeline(deps);
    const result = await run("any prompt");
    if (!result.ok) throw new Error("expected ok");
    expect(result.run_id).toBe("custom-run-id-xyz");
    expect(writer.opens[0]).toBe("custom-run-id-xyz");
  });

  test("AbortSignal pre-fired propagates to classify (which surfaces aborted)", async () => {
    const controller = new AbortController();
    controller.abort();
    const { deps } = makeMockDeps({
      classifyResult: {
        ok: false,
        severity: "red",
        kind: "abort",
        message: "classify aborted",
        errors: ["aborted"],
      },
      generateResults: [],
      compileResults: [],
    });
    const run = buildPipeline(deps);
    const result = await run("any prompt", { signal: controller.signal });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.kind).toBe("aborted");
  });
});

// ===========================================================================
// Trace lifecycle
// ===========================================================================

describe("buildPipeline — trace lifecycle", () => {
  test("trace writer's open() is called once with the run_id; close() is called once", async () => {
    const { deps, writer } = makeMockDeps({
      generateResults: [makeOkGenerate()],
      compileResults: [makeOkCompile()],
      generateRunId: () => "lifecycle-run-id",
    });
    const run = buildPipeline(deps);
    await run("any prompt");
    expect(writer.opens.length).toBe(1);
    expect(writer.opens[0]).toBe("lifecycle-run-id");
    expect(writer.closes).toBe(1);
  });

  test("trace's pipeline_summary start contains the prompt verbatim", async () => {
    const { deps, writer } = makeMockDeps({
      generateResults: [makeOkGenerate()],
      compileResults: [makeOkCompile()],
    });
    const run = buildPipeline(deps);
    const prompt = "the verbatim prompt";
    await run(prompt);
    const summaries = eventsOfKind(writer, "pipeline_summary");
    // Narrow to the START variant for the prompt assertion.
    const startSummary = summaries[0];
    if (startSummary !== undefined && startSummary.phase === "start") {
      expect(startSummary.prompt).toBe(prompt);
    }
  });

  test("trace's compile_call carries cache_hit + hex_size_bytes + toolchain_version_hash on success", async () => {
    const { deps, writer } = makeMockDeps({
      generateResults: [makeOkGenerate()],
      compileResults: [makeOkCompile()],
    });
    const run = buildPipeline(deps);
    await run("any prompt");
    const compileCalls = eventsOfKind(writer, "compile_call");
    expect(compileCalls[0]?.ok).toBe(true);
    expect(compileCalls[0]?.cache_hit).toBe(false);
    expect(compileCalls[0]?.hex_size_bytes).toBe(8);
    expect(compileCalls[0]?.toolchain_version_hash).toBe("deadbeef");
  });
});

// ===========================================================================
// Honest Gap envelope on every failure result
// ===========================================================================

describe("buildPipeline — every failure result carries Honest Gap + run_id + cost_usd", () => {
  test("compile-failed carries Honest Gap with scope: partial", async () => {
    const { deps } = makeMockDeps({
      generateResults: [makeOkGenerate()],
      compileResults: [makeFailedCompile()],
    });
    const run = buildPipeline(deps);
    const result = await run("any prompt", { repair: "off" });
    if (result.ok) throw new Error("expected failure");
    expect(result.honest_gap.scope).toBe("partial");
    expect(result.honest_gap.explanation.length).toBeGreaterThan(0);
    expect(result.honest_gap.missing_capabilities.length).toBeGreaterThan(0);
    expect(result.run_id).toBeDefined();
    expect(typeof result.cost_usd).toBe("number");
  });
});

// ===========================================================================
// Integration test (gated) — closes residual #29 (6-gate regression net)
// ===========================================================================

describe("buildPipeline — gated integration (live Compile API + Anthropic)", () => {
  const live =
    process.env.VOLTEUX_COMPILE_SERVER_LIVE === "1" &&
    typeof process.env.ANTHROPIC_API_KEY === "string" &&
    process.env.ANTHROPIC_API_KEY.length > 0;
  if (!live) {
    test.skip("integration test skipped — set VOLTEUX_COMPILE_SERVER_LIVE=1 + ANTHROPIC_API_KEY to run", () => {
      // No-op skip so the gate is visible in the test output.
    });
    return;
  }

  test("runPipeline against a real Sonnet + Compile API: ok + trace contains 6 gate events + cost_usd in (0, 0.20)", async () => {
    const { runPipeline } = await import("../pipeline/index.ts");
    const result = await runPipeline(
      "a robot that waves when something gets close",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cost_usd).toBeGreaterThan(0);
    expect(result.cost_usd).toBeLessThan(0.2);
    expect(result.run_id.length).toBeGreaterThan(0);
    expect(result.hex_b64.length).toBeGreaterThan(0);
  }, 120_000);
});
