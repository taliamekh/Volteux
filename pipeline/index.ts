/**
 * Volteux v0.1 pipeline orchestrator.
 *
 *   buildPipeline(deps) → (prompt, opts?) => Promise<PipelineResult>
 *   runPipeline(prompt, opts?) → Promise<PipelineResult>     // convenience
 *
 * Composes classify → generate → schema → cross-consistency → rules →
 * compile gates into one entry point. Mirrors the
 * `buildGenerator(deps) + generate()` and `buildClassifier(deps) +
 * classify()` patterns from `pipeline/llm/{generate,classify}.ts`. Tests
 * construct `buildPipeline(mockDeps)` directly so production callers
 * cannot import a public test-only type.
 *
 * **Failure-kind discriminated union (8 literals):**
 *   - "out-of-scope"   — classifier returned `archetype_id === null` OR
 *                        `confidence < 0.6` OR a non-archetype-1 ID.
 *                        Honest Gap scope: "out-of-scope". No retry.
 *   - "schema-failed"  — `generate()` returned `kind: "schema-failed"`
 *                        AFTER its own 2-call local repair. Cross-gate
 *                        repair() does NOT retry generate again.
 *                        Honest Gap scope: "out-of-scope".
 *   - "compile-failed" — `runCompileGate` returned `kind: "compile-error"`
 *                        (200 OK with stderr). One cross-gate repair()
 *                        turn worth attempting. Honest Gap scope: "partial".
 *   - "rules-red"      — `runRules(doc).red.length > 0`. One cross-gate
 *                        repair() turn worth attempting. Honest Gap
 *                        scope: "partial".
 *   - "xconsist-failed" — `runCrossConsistencyGate(doc)` returned
 *                        `{ok: false}`. One cross-gate repair() turn
 *                        worth attempting. Honest Gap scope: "partial".
 *   - "transport"      — Any infra failure: classify/generate
 *                        `kind: "transport"|"sdk-error"`, compile
 *                        `kind: "transport"|"timeout"|"auth"|"bad-request"
 *                        |"rate-limit"|"queue-full"`. No retry; infra is
 *                        the caller's problem. Honest Gap scope:
 *                        "out-of-scope".
 *   - "truncated"      — `generate()` returned `kind: "truncated"`. No
 *                        retry; surfaces as Honest Gap. Decision rationale
 *                        in plan § Key Technical Decisions.
 *   - "aborted"        — `AbortSignal` fired (caller cancelled). Distinct
 *                        from `transport` because the explanation differs:
 *                        the user knows they cancelled.
 *
 * **Wire-contract uniformity.** Hyphenated lowercase literals matching
 * `CompileGateFailureKind`, `GenerateFailureKind`, `ClassifyFailureKind`,
 * and `FilenameRejectionKind`. Bare throws cross the function boundary
 * ONLY at input-validation guards (empty prompt, oversize prompt) — same
 * contract as `generate()` and `classify()`.
 *
 * **Cross-gate repair is bounded at ≤1 attempt per `runPipeline` call.**
 * The counter lives on the orchestrator's per-run state (a local
 * variable inside the closure returned by `buildPipeline`), NOT on
 * closure-deps. After 1 repair, ANY subsequent gate failure (including
 * the same gate) routes to Honest Gap unconditionally — the orchestrator
 * does NOT let the repair attempt itself trigger another repair.
 *
 * **No module-level singleton client.** `defaultPipelineDeps()` reads
 * env at call time (transitively through `defaultGenerateDeps()` +
 * `defaultClassifyDeps()`). Cached as in-flight Promise per the lazy-init
 * learning. Outer function is plain (NOT `async`) — see
 * docs/solutions/logic-errors/lazy-init-singleton-in-flight-promise-bun-test-isolation-2026-04-26.md
 * for why TypeScript will not catch a regression to async.
 *
 * **__testing namespace form.** This module is NEW — it ships the
 * namespace-form reset directly per the lazy-init learning's forward-going
 * prescription. Mirrors `infra/server/cache.ts`'s `__testing` shape.
 *
 * **Cost tracking.** Unit 7 ships the real `CostTracker` at
 * `pipeline/cost.ts` and `defaultPipelineDeps()` swaps from
 * `NoopCostTracker` to a per-run `() => new CostTracker()` factory.
 * The `NoopCostTracker` interface + factory remain exported here so
 * tests can construct `PipelineDeps` inline without accumulating real
 * per-token cost.
 *
 * **Trace writer.** Unit 7 ships the real `defaultTraceWriter()` at
 * `pipeline/trace.ts` and `defaultPipelineDeps()` swaps from
 * `NoopTraceWriter` to it. The `NoopTraceWriter` (still exported from
 * `pipeline/trace.ts`) is the test default — tests that don't want
 * disk I/O construct `PipelineDeps` inline with it.
 *
 * **Logger discipline.** Do not log the API key, request bodies, or
 * `process.env`. The Anthropic SDK's request logger is OFF by default —
 * leave it OFF here.
 *
 * Unit 6 commit-1 ships the scaffold (types, exports, factory, lazy
 * deps). The orchestration body is a stub here that throws — commit-4
 * fills in the full classify→generate→[gates]→compile sequence with
 * bounded cross-gate repair.
 */

import { randomUUID } from "node:crypto";
import {
  classify as defaultClassify,
  defaultClassifyDeps,
  type ClassifyFailureKind,
} from "./llm/classify.ts";
import {
  generate as defaultGenerate,
  defaultGenerateDeps,
  type GenerateFailureKind,
  type GenerateResult,
} from "./llm/generate.ts";
import {
  runSchemaGate,
} from "./gates/schema.ts";
import {
  runCrossConsistencyGate,
} from "./gates/cross-consistency.ts";
import {
  runRules as defaultRunRules,
} from "./rules/index.ts";
import {
  runCompileGate as defaultRunCompileGate,
  type CompileGateFailureKind,
} from "./gates/compile.ts";
import { formatHonestGap } from "./honest-gap.ts";
import {
  defaultTraceWriter,
  type TraceEvent,
  type TraceWriter,
} from "./trace.ts";
import { CostTracker } from "./cost.ts";
import type {
  VolteuxHonestGap,
  VolteuxProjectDocument,
} from "../schemas/document.zod.ts";
import type { RuleAttempt } from "./rules/index.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TARGET_ARCHETYPE_ID = "uno-ultrasonic-servo";
const CONFIDENCE_THRESHOLD = 0.6;
const MAX_PROMPT_CHARS = 5000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The 8-literal discriminated failure kind. Hyphenated lowercase to
 * match the wire-contract style of `CompileGateFailureKind`,
 * `GenerateFailureKind`, `ClassifyFailureKind`, and `FilenameRejectionKind`.
 */
export type PipelineFailureKind =
  | "out-of-scope"
  | "schema-failed"
  | "compile-failed"
  | "rules-red"
  | "xconsist-failed"
  | "transport"
  | "truncated"
  | "aborted";

/**
 * Compile-time exhaustiveness guard for `PipelineFailureKind` switches.
 * Mirrors `assertNeverGenerateFailureKind` / `assertNeverClassifyFailureKind`
 * / `assertNeverCompileGateFailureKind`.
 *
 * Usage in callers (e.g., `pipeline/honest-gap.ts`):
 *
 *   switch (failure.kind) {
 *     case "out-of-scope":     ...; break;
 *     case "schema-failed":    ...; break;
 *     case "compile-failed":   ...; break;
 *     case "rules-red":        ...; break;
 *     case "xconsist-failed":  ...; break;
 *     case "transport":        ...; break;
 *     case "truncated":        ...; break;
 *     case "aborted":          ...; break;
 *     default: assertNeverPipelineFailureKind(failure.kind);
 *   }
 */
export function assertNeverPipelineFailureKind(kind: never): never {
  throw new Error(`Unhandled PipelineFailureKind: ${String(kind)}`);
}

/**
 * The structured failure carrying everything Honest Gap and tests need.
 * `errors` is `ReadonlyArray<string>` for orchestrator-side errors
 * (gate aggregations, classifier reasoning); the underlying gates may
 * carry ZodIssue arrays, but the orchestrator stringifies them at the
 * boundary so callers don't need to discriminate further.
 */
export interface PipelineFailure {
  ok: false;
  severity: "red";
  kind: PipelineFailureKind;
  message: string;
  /** Stringified detail per failure kind. May be empty for kinds with no detail (e.g., "aborted"). */
  errors: ReadonlyArray<string>;
  /**
   * The classifier reasoning (only set for `out-of-scope`); helps the
   * Honest Gap formatter produce a useful "missing capabilities" line.
   */
  classifier_reasoning?: string;
  /**
   * The compile-error stderr (only set for `compile-failed`); the
   * Honest Gap formatter trims this for beginner-readability.
   */
  compile_stderr?: string;
}

/**
 * The success shape carries the doc + .hex + accumulated cost +
 * non-blocking warnings (amber/blue rules). Trace events have already
 * been emitted at this point; the run_id lets the caller correlate.
 */
export interface PipelineSuccess {
  ok: true;
  doc: VolteuxProjectDocument;
  /** Base64-encoded compiled .hex artifact. */
  hex_b64: string;
  /** Accumulated cost across classify + generate (+ any repair turn). $0 in dry-run. */
  cost_usd: number;
  /** Identifier for the trace file `traces/<run_id>.jsonl`. */
  run_id: string;
  /** Non-blocking warnings flagged amber by the rules engine. */
  amber: ReadonlyArray<RuleAttempt>;
  /** Info-level notes flagged blue by the rules engine. */
  blue: ReadonlyArray<RuleAttempt>;
}

/**
 * The discriminated union returned by `runPipeline`. On failure the
 * caller gets the structured `PipelineFailure` PLUS the formatted
 * `VolteuxHonestGap` that the UI consumes verbatim (no further
 * formatting needed).
 */
export type PipelineResult =
  | PipelineSuccess
  | (PipelineFailure & {
      honest_gap: VolteuxHonestGap;
      cost_usd: number;
      run_id: string;
    });

// ---------------------------------------------------------------------------
// Cost tracker placeholder (Unit 7 lands the real implementation)
// ---------------------------------------------------------------------------

/**
 * Minimal interface the orchestrator depends on. Unit 7 ships a real
 * `CostTracker` class implementing `track(usage, model)` with per-model
 * rates; Unit 6 uses the `NoopCostTracker` default below to keep the
 * PR self-contained.
 *
 * Inline in this file (not extracted to a separate module) because
 * Unit 7's PR will replace the interface + Noop with imports from
 * `pipeline/cost.ts`. Keeping it inline avoids a chicken-and-egg dep
 * that would force Unit 6 to land coupled to Unit 7.
 */
export interface CostTrackerLike {
  /**
   * Accumulate cost from a usage snapshot for the given model.
   * Unit 6's noop ignores both args; Unit 7's real implementation
   * uses per-model rates from `pipeline/cost.ts`.
   */
  track(
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    },
    model: string,
  ): void;
  /** Total accumulated cost in USD. */
  total(): number;
}

class NoopCostTrackerImpl implements CostTrackerLike {
  track(
    _usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    },
    _model: string,
  ): void {
    // Unit 7 replaces this with the real CostTracker.
  }
  total(): number {
    return 0;
  }
}

/**
 * Construct a fresh per-run `NoopCostTracker`. The orchestrator creates
 * one per `runPipeline` call so concurrent runs do not share counters.
 */
export function NoopCostTracker(): CostTrackerLike {
  return new NoopCostTrackerImpl();
}

// ---------------------------------------------------------------------------
// PipelineDeps + options
// ---------------------------------------------------------------------------

/**
 * Repair helper signature. The orchestration commit (commit-4) imports
 * `repair` from `./repair.ts`; this file's commit-1 scaffold uses the
 * forward-declared shape so deps construction type-checks before
 * `./repair.ts` lands.
 */
export type RepairHelper = (
  failure: { kind: PipelineFailureKind; message: string; errors: ReadonlyArray<string> },
  prior_doc: VolteuxProjectDocument,
  prompt: string,
  gen: (
    prompt: string,
    opts?: { signal?: AbortSignal },
  ) => Promise<Awaited<ReturnType<typeof defaultGenerate>>>,
) => Promise<Awaited<ReturnType<typeof defaultGenerate>>>;

/**
 * Dependencies for `buildPipeline`. Production wiring uses
 * `defaultPipelineDeps()`; tests construct this object inline.
 *
 * The 6 pipeline-stage deps mirror the smoke script's `RunPromptDeps`
 * shape so tests can reuse mock builders. The trace writer + cost
 * tracker factory + repair helper + run-id generator are all swappable
 * for hermetic testing.
 *
 * `costTrackerFactory` is a factory (not a single instance) because the
 * orchestrator constructs a fresh tracker per `runPipeline` call —
 * concurrent runs must not share counters.
 */
export interface PipelineDeps {
  classify: typeof defaultClassify;
  generate: typeof defaultGenerate;
  runSchemaGate: typeof runSchemaGate;
  runCrossConsistencyGate: typeof runCrossConsistencyGate;
  runRules: typeof defaultRunRules;
  runCompileGate: typeof defaultRunCompileGate;
  /**
   * Cross-gate repair helper. Defaults to `pipeline/repair.ts`'s
   * `repair`. Tests inject a mock to simulate repair-failure paths.
   */
  repair: RepairHelper;
  /** Trace writer. Defaults to `NoopTraceWriter` in Unit 6; Unit 7 swaps. */
  traceWriter: TraceWriter;
  /**
   * Cost tracker factory. Each `runPipeline` invocation creates a fresh
   * tracker via this factory.
   */
  costTrackerFactory: () => CostTrackerLike;
  /**
   * Run-id generator. Defaults to a UTC timestamp slug + 8-char UUID
   * suffix; tests inject a deterministic generator.
   */
  generateRunId: () => string;
}

export interface PipelineOptions {
  /** Caller-cancellation signal forwarded to classify/generate. */
  signal?: AbortSignal;
  /**
   * Disable cross-gate repair (the inner-loop is bounded at 1 anyway;
   * this kills it entirely). Useful for traces of clean failures.
   */
  repair?: "off";
}

// ---------------------------------------------------------------------------
// Default deps factory (lazy, in-flight promise)
// ---------------------------------------------------------------------------

/**
 * The lazy-initialization slot stores the in-flight PROMISE, not the
 * resolved deps. Concurrent callers share the same single in-flight
 * initialization — they all `await` the same promise. Without this,
 * both concurrent calls would pass the `null` check before the first
 * `await defaultGenerateDeps()` resolved, both would construct fresh
 * Anthropic clients (transitively via the LLM modules' own lazy-init),
 * and the second assignment would silently win.
 *
 * See docs/solutions/logic-errors/lazy-init-singleton-in-flight-promise-bun-test-isolation-2026-04-26.md
 * for the full rationale + the three-test contract this slot's shape
 * must satisfy.
 */
let cachedDefaultDepsPromise: Promise<PipelineDeps> | null = null;

/**
 * Build the default deps. Reads `ANTHROPIC_API_KEY` indirectly through
 * `defaultGenerateDeps()` + `defaultClassifyDeps()` (which themselves
 * cache as in-flight promises). Reads `COMPILE_API_URL` and
 * `COMPILE_API_SECRET` at call time inside `runCompileGate` (which
 * already does so via `pipeline/gates/compile.ts`). Cached as an
 * in-flight promise after first call so repeated `runPipeline()`
 * invocations share the underlying clients.
 *
 * Outer function is plain (NOT `async`) — TypeScript will not catch a
 * regression to `async`; the synchronous-promise-reference test in
 * `tests/pipeline-defaults.test.ts` is the only automated guard. See
 * the lazy-init learning for why.
 */
export function defaultPipelineDeps(): Promise<PipelineDeps> {
  if (cachedDefaultDepsPromise !== null) return cachedDefaultDepsPromise;
  cachedDefaultDepsPromise = (async () => {
    // Eagerly warm both LLM-deps caches so concurrent first-callers of
    // `runPipeline` don't race on classify+generate init. This is the
    // "transitive" claim the file header makes — without it, two
    // concurrent runs would each construct their own classify+generate
    // closures even though the underlying clients are properly cached.
    await defaultClassifyDeps();
    await defaultGenerateDeps();
    // Lazy import of the repair helper to avoid pulling
    // `pipeline/repair.ts` into the module-init graph for callers that
    // never actually run the orchestrator (e.g., tests that import
    // only the type union).
    const { repair: defaultRepair } = await import("./repair.ts");
    return {
      classify: defaultClassify,
      generate: defaultGenerate,
      runSchemaGate,
      runCrossConsistencyGate,
      runRules: defaultRunRules,
      runCompileGate: defaultRunCompileGate,
      repair: defaultRepair,
      // Unit 7: real JSON-Lines writer at traces/<run-id>.jsonl. The
      // writer is best-effort: file-write failures log a stderr WARN
      // and never propagate. Tests that don't want file I/O construct
      // PipelineDeps inline with `traceWriter: NoopTraceWriter`
      // (still exported above) — defaultPipelineDeps() is for
      // production callers only.
      traceWriter: defaultTraceWriter(),
      // Unit 7: real CostTracker accumulating spend in integer
      // microcents using committed Anthropic per-model rates. Per-run
      // factory, NEVER shared across runs (concurrent runs would race
      // on the accumulator). Tests use `costTrackerFactory: NoopCostTracker`
      // when constructing PipelineDeps inline.
      costTrackerFactory: () => new CostTracker(),
      generateRunId,
    };
  })();
  return cachedDefaultDepsPromise;
}

/**
 * Test-only escape hatches. Production code MUST NOT import from here.
 *
 * Mirrors `infra/server/cache.ts`'s `__testing` namespace shape — the
 * forward-going prescription per the lazy-init learning. The LLM
 * modules' standalone `_resetDefaultDepsForTest()` form is NOT migrated
 * in this batch (deferred opportunistically per plan § Scope Boundaries).
 */
export const __testing = {
  resetDefaultPipelineDeps(): void {
    cachedDefaultDepsPromise = null;
  },
};

// ---------------------------------------------------------------------------
// Run-id generation
// ---------------------------------------------------------------------------

/**
 * Generate a filesystem-safe run-id. ISO timestamp slug + 8-char UUID
 * suffix to disambiguate same-second runs. Mirrors the smoke script's
 * generator so trace filenames stay format-compatible with Unit 7's
 * writer.
 */
function generateRunId(): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const suffix = randomUUID().slice(0, 8);
  return `${ts}-${suffix}`;
}

// ---------------------------------------------------------------------------
// Helpers (failure-shape construction + per-source kind mapping)
// ---------------------------------------------------------------------------

/**
 * Construct the canonical `PipelineFailure` shape. The orchestrator
 * uses this everywhere it returns a failure so the wire shape stays
 * uniform regardless of which gate or LLM call surfaced the failure.
 */
function makeFailure(
  kind: PipelineFailureKind,
  message: string,
  errors: ReadonlyArray<string> = [],
  extras: Pick<
    PipelineFailure,
    "classifier_reasoning" | "compile_stderr"
  > = {},
): PipelineFailure {
  return {
    ok: false,
    severity: "red",
    kind,
    message,
    errors,
    ...(extras.classifier_reasoning !== undefined
      ? { classifier_reasoning: extras.classifier_reasoning }
      : {}),
    ...(extras.compile_stderr !== undefined
      ? { compile_stderr: extras.compile_stderr }
      : {}),
  };
}

/**
 * Map a `ClassifyFailureKind` to a `PipelineFailureKind` per the plan's
 * decision matrix. `transport`/`sdk-error` roll up to `"transport"`;
 * `abort` to `"aborted"`; `schema-failed` to `"transport"` (a classify
 * schema failure is an infra-class issue — the model produced
 * unparseable output for a tiny enum schema).
 */
function classifyFailureToPipelineKind(
  kind: ClassifyFailureKind,
): PipelineFailureKind {
  switch (kind) {
    case "transport":
      return "transport";
    case "sdk-error":
      return "transport";
    case "abort":
      return "aborted";
    case "schema-failed":
      return "transport";
  }
}

/**
 * Map a `GenerateFailureKind` to a `PipelineFailureKind`. The
 * `schema-failed` literal preserves its identity (generate has already
 * burned its internal auto-repair turn; cross-gate repair does NOT
 * re-call generate on this kind per the decision matrix).
 */
function generateFailureToPipelineKind(
  kind: GenerateFailureKind,
): PipelineFailureKind {
  switch (kind) {
    case "schema-failed":
      return "schema-failed";
    case "truncated":
      return "truncated";
    case "transport":
      return "transport";
    case "sdk-error":
      return "transport";
    case "abort":
      return "aborted";
  }
}

/**
 * Map a `CompileGateFailureKind` to a `PipelineFailureKind`. Only
 * `compile-error` becomes `compile-failed`; all other infra-class
 * compile failures (auth/timeout/queue-full/rate-limit/bad-request/
 * transport) roll up to `"transport"` per the plan's decision matrix.
 */
function compileFailureToPipelineKind(
  kind: CompileGateFailureKind,
): PipelineFailureKind {
  switch (kind) {
    case "compile-error":
      return "compile-failed";
    case "transport":
    case "timeout":
    case "auth":
    case "bad-request":
    case "rate-limit":
    case "queue-full":
      return "transport";
  }
}

// ---------------------------------------------------------------------------
// Trace event helpers (loose Unit 6 shape; Unit 7 tightens)
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function emitEvent(
  writer: TraceWriter,
  run_id: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  // Unit 7 tightened `TraceEvent` into a discriminated union; this
  // helper still constructs events from the loose Unit-6 shape
  // (event-name string + arbitrary payload). Commit 3 of Unit 7
  // refactors every call site to use the typed event variants
  // directly. For commit 2 (this commit only touches trace.ts +
  // tests/trace.test.ts in spirit) we cast through `unknown` so the
  // orchestrator continues to compile while the writer's runtime
  // contract (one JSON object per line) is satisfied identically.
  const evt = {
    ts: nowIso(),
    run_id,
    event,
    ...payload,
  } as unknown as TraceEvent;
  return writer.emit(evt);
}

/**
 * Build a structured 200-char-ish digest of the failing document for
 * the repair_attempt trace event. Uses a structured extract rather
 * than the literal first 200 chars (the deferred-to-implementation
 * decision per plan § Open Questions). The structured form lets the
 * v0.5 eval harness aggregate by archetype / board / size without
 * re-parsing the full doc.
 */
function digestDoc(doc: VolteuxProjectDocument): string {
  return JSON.stringify({
    archetype_id: doc.archetype_id,
    board_fqbn: doc.board.fqbn,
    components_count: doc.components.length,
    libraries_count: doc.sketch.libraries.length,
  });
}

// ---------------------------------------------------------------------------
// Factory (commit-4 — full orchestration loop)
// ---------------------------------------------------------------------------

/**
 * Build a pipeline closure. Pure: no env reads, no file I/O. The
 * closure performs at most:
 *   - 1 classify call
 *   - 1 generate call (+ generate's own internal repair, ≤2 model calls)
 *   - 1 cross-gate repair turn (which is a 2nd generate call) when a
 *     gate fails and `opts.repair !== "off"`
 *   - 1 compile call (+ 1 retry compile after repair)
 *
 * Production callers use `runPipeline()` which lazily wraps
 * `defaultPipelineDeps()`; tests call this directly with mock deps.
 */
export function buildPipeline(
  deps: PipelineDeps,
): (prompt: string, opts?: PipelineOptions) => Promise<PipelineResult> {
  return async function runPipelineInner(
    prompt: string,
    opts: PipelineOptions = {},
  ): Promise<PipelineResult> {
    // ---- Input-validation guards (THROW; no recovery is meaningful) ----
    if (prompt === "") {
      throw new Error("empty prompt");
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new Error(`prompt exceeds ${MAX_PROMPT_CHARS} chars`);
    }

    const run_id = deps.generateRunId();
    const cost = deps.costTrackerFactory();
    const startedAt = Date.now();
    const repairEnabled = opts.repair !== "off";
    let repairCount = 0;

    // Open the trace + emit the start summary. Trace I/O failures are
    // best-effort; the writer handles them internally (NoopTraceWriter
    // ignores all calls; Unit 7's real writer try/catches on disk I/O).
    await deps.traceWriter.open(run_id);
    await emitEvent(deps.traceWriter, run_id, "pipeline_summary", {
      phase: "start",
      prompt,
      started_at: nowIso(),
    });

    // The end-summary + close happen on every return path via this helper.
    const closeAndEmitEnd = async (
      outcome: "ok" | PipelineFailureKind,
    ): Promise<void> => {
      await emitEvent(deps.traceWriter, run_id, "pipeline_summary", {
        phase: "end",
        outcome,
        cost_usd: cost.total(),
        total_latency_ms: Date.now() - startedAt,
        ended_at: nowIso(),
      });
      await deps.traceWriter.close();
    };

    // Construct a failure result with Honest Gap + close the trace.
    const finalize = async (
      failure: PipelineFailure,
    ): Promise<PipelineResult> => {
      const honest_gap = formatHonestGap(failure, prompt);
      await emitEvent(deps.traceWriter, run_id, "honest_gap", {
        scope: honest_gap.scope,
        missing_capabilities: honest_gap.missing_capabilities,
        explanation: honest_gap.explanation,
        trigger_kind: failure.kind,
      });
      await closeAndEmitEnd(failure.kind);
      return {
        ...failure,
        honest_gap,
        cost_usd: cost.total(),
        run_id,
      };
    };

    // -----------------------------------------------------------------
    // Stage 1: classify
    // -----------------------------------------------------------------
    const classifyResult = await deps.classify(
      prompt,
      opts.signal !== undefined ? { signal: opts.signal } : {},
    );
    if (!classifyResult.ok) {
      // Classify failure paths don't carry usage; treat as 0.
      cost.track(
        {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        "claude-haiku-4-5",
      );
      await emitEvent(deps.traceWriter, run_id, "llm_call", {
        model: "claude-haiku-4-5",
        attempt: 1,
        outcome: classifyResult.kind,
      });
      const kind = classifyFailureToPipelineKind(classifyResult.kind);
      return finalize(
        makeFailure(
          kind,
          `classify failed: ${classifyResult.message}`,
          classifyResult.errors.map((e) =>
            typeof e === "string" ? e : `${e.path.join(".")}: ${e.message}`,
          ),
        ),
      );
    }

    cost.track(classifyResult.usage, "claude-haiku-4-5");
    await emitEvent(deps.traceWriter, run_id, "llm_call", {
      model: "claude-haiku-4-5",
      attempt: 1,
      usage: classifyResult.usage,
      outcome: "ok",
    });

    // Out-of-scope routing: null archetype OR low confidence OR wrong archetype.
    if (
      classifyResult.archetype_id === null ||
      classifyResult.archetype_id !== TARGET_ARCHETYPE_ID ||
      classifyResult.confidence < CONFIDENCE_THRESHOLD
    ) {
      return finalize(
        makeFailure(
          "out-of-scope",
          `classifier routed to out-of-scope: archetype_id=${String(classifyResult.archetype_id)}, confidence=${classifyResult.confidence}`,
          [],
          { classifier_reasoning: classifyResult.reasoning },
        ),
      );
    }

    // -----------------------------------------------------------------
    // Stages 2-6: generate → schema → xconsist → rules → compile
    // (Loop bound: at most 2 attempts; the 2nd only fires after a
    //  successful repair, which is itself bounded at 1.)
    // -----------------------------------------------------------------
    let currentDoc: VolteuxProjectDocument | null = null;
    // Loop-scope state carrying the failing-gate context across the
    // attempt boundary. Set in attempt 0's gate-failure paths; consumed
    // by attempt 1's repair() call. Declared outside the loop so the
    // attempt-1 closure can reference attempt-0's values.
    let lastFailureKind: PipelineFailureKind | undefined;
    let lastFailureMessage: string | undefined;
    let lastFailureErrors: ReadonlyArray<string> | undefined;

    for (let attempt = 0; attempt <= 1; attempt++) {
      // ---- Generate ----
      const generateResult: GenerateResult =
        attempt === 0
          ? await deps.generate(
              prompt,
              opts.signal !== undefined ? { signal: opts.signal } : {},
            )
          : // Attempt 1 (post-repair): repair() is responsible for the call.
            await deps.repair(
              {
                kind: lastFailureKind!,
                message: lastFailureMessage!,
                errors: lastFailureErrors!,
              },
              currentDoc!,
              prompt,
              (p, o) =>
                deps.generate(
                  p,
                  o ??
                    (opts.signal !== undefined ? { signal: opts.signal } : {}),
                ),
            );
      if (!generateResult.ok) {
        cost.track(
          {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          "claude-sonnet-4-6",
        );
        await emitEvent(deps.traceWriter, run_id, "llm_call", {
          model: "claude-sonnet-4-6",
          attempt: attempt + 1,
          outcome: generateResult.kind,
        });
        const kind = generateFailureToPipelineKind(generateResult.kind);
        return finalize(
          makeFailure(
            kind,
            `generate failed: ${generateResult.message}`,
            generateResult.errors.map((e) =>
              typeof e === "string" ? e : `${e.path.join(".")}: ${e.message}`,
            ),
          ),
        );
      }
      cost.track(generateResult.usage, "claude-sonnet-4-6");
      await emitEvent(deps.traceWriter, run_id, "llm_call", {
        model: "claude-sonnet-4-6",
        attempt: attempt + 1,
        usage: generateResult.usage,
        outcome: "ok",
      });

      currentDoc = generateResult.doc;

      // ---- Gate sequence ----
      // Each gate failure either: (a) triggers a repair if attempt===0
      // and repair is enabled; or (b) routes to Honest Gap.
      // (The lastFailureKind/Message/Errors slots are loop-scoped above.)

      // Schema gate.
      const schemaResult = deps.runSchemaGate(currentDoc);
      await emitEvent(deps.traceWriter, run_id, "gate_outcome", {
        gate: "schema",
        ok: schemaResult.ok,
        errors_count: schemaResult.ok ? 0 : schemaResult.errors.length,
      });
      if (!schemaResult.ok) {
        // generate() already auto-repaired schema failures internally;
        // a schema failure escaping here means the SDK's parse passed
        // but our schema rejected it (impossible in practice unless deps
        // are mismatched). No further repair — surface as schema-failed.
        return finalize(
          makeFailure(
            "schema-failed",
            schemaResult.message,
            schemaResult.errors.map((e) =>
              typeof e === "string" ? e : `${e.path.join(".")}: ${e.message}`,
            ),
          ),
        );
      }

      // Cross-consistency gate.
      const xcResult = deps.runCrossConsistencyGate(currentDoc);
      await emitEvent(deps.traceWriter, run_id, "gate_outcome", {
        gate: "xconsist",
        ok: xcResult.ok,
        errors_count: xcResult.ok ? 0 : xcResult.errors.length,
      });
      if (!xcResult.ok) {
        const errors = xcResult.errors.map((e) =>
          typeof e === "string" ? e : `${e.path.join(".")}: ${e.message}`,
        );
        if (attempt === 0 && repairEnabled && repairCount === 0) {
          repairCount++;
          await emitEvent(deps.traceWriter, run_id, "repair_attempt", {
            trigger_kind: "xconsist-failed",
            prior_doc_digest: digestDoc(currentDoc),
          });
          lastFailureKind = "xconsist-failed";
          lastFailureMessage = xcResult.message;
          lastFailureErrors = errors;
          // Loop continues; attempt 1 will call repair().
          continue;
        }
        return finalize(
          makeFailure("xconsist-failed", xcResult.message, errors),
        );
      }

      // Rules engine.
      const rulesOutcome = deps.runRules(currentDoc);
      await emitEvent(deps.traceWriter, run_id, "gate_outcome", {
        gate: "rules",
        ok: rulesOutcome.red.length === 0,
        red_count: rulesOutcome.red.length,
        amber_count: rulesOutcome.amber.length,
        blue_count: rulesOutcome.blue.length,
      });
      if (rulesOutcome.red.length > 0) {
        const errors = rulesOutcome.red.map((a) => {
          const result = a.result;
          if ("message" in result) return `${a.rule.id}: ${result.message}`;
          return a.rule.id;
        });
        if (attempt === 0 && repairEnabled && repairCount === 0) {
          repairCount++;
          await emitEvent(deps.traceWriter, run_id, "repair_attempt", {
            trigger_kind: "rules-red",
            prior_doc_digest: digestDoc(currentDoc),
          });
          lastFailureKind = "rules-red";
          lastFailureMessage = `rules red: ${rulesOutcome.red.length} violation(s)`;
          lastFailureErrors = errors;
          continue;
        }
        return finalize(
          makeFailure(
            "rules-red",
            `rules red: ${rulesOutcome.red.length} violation(s)`,
            errors,
          ),
        );
      }

      // Compile gate.
      const compileResult = await deps.runCompileGate({
        fqbn: currentDoc.board.fqbn,
        sketch_main_ino: currentDoc.sketch.main_ino,
        additional_files: currentDoc.sketch.additional_files,
        libraries: currentDoc.sketch.libraries,
      });
      await emitEvent(deps.traceWriter, run_id, "compile_call", {
        ok: compileResult.ok,
        kind: compileResult.ok ? undefined : compileResult.kind,
        cache_hit: compileResult.ok ? compileResult.value.cache_hit : false,
        hex_size_bytes: compileResult.ok
          ? compileResult.value.hex_size_bytes
          : 0,
        latency_ms: compileResult.ok ? compileResult.value.latency_ms : 0,
        toolchain_version_hash: compileResult.ok
          ? compileResult.value.toolchain_version_hash
          : undefined,
        errors_count: compileResult.ok ? 0 : compileResult.errors.length,
      });
      if (!compileResult.ok) {
        const kind = compileFailureToPipelineKind(compileResult.kind);
        const errors = [...compileResult.errors];
        if (
          kind === "compile-failed" &&
          attempt === 0 &&
          repairEnabled &&
          repairCount === 0
        ) {
          repairCount++;
          await emitEvent(deps.traceWriter, run_id, "repair_attempt", {
            trigger_kind: "compile-failed",
            prior_doc_digest: digestDoc(currentDoc),
          });
          lastFailureKind = "compile-failed";
          lastFailureMessage = compileResult.message;
          lastFailureErrors = errors;
          continue;
        }
        return finalize(
          makeFailure(
            kind,
            compileResult.message,
            errors,
            kind === "compile-failed"
              ? { compile_stderr: errors[0] ?? "" }
              : {},
          ),
        );
      }

      // ---- Success ----
      await emitEvent(deps.traceWriter, run_id, "pipeline_summary", {
        phase: "end",
        outcome: "ok",
        cost_usd: cost.total(),
        total_latency_ms: Date.now() - startedAt,
        ended_at: nowIso(),
      });
      await deps.traceWriter.close();
      return {
        ok: true,
        doc: currentDoc,
        hex_b64: compileResult.value.hex_b64,
        cost_usd: cost.total(),
        run_id,
        amber: rulesOutcome.amber,
        blue: rulesOutcome.blue,
      };
    }

    // Unreachable in practice — both attempts handle every gate-failure
    // path. If the loop falls through somehow (defensive), surface as
    // transport so the caller doesn't get a malformed result.
    return finalize(
      makeFailure(
        "transport",
        "pipeline loop fell through without producing a result",
        [],
      ),
    );
  };
}

// ---------------------------------------------------------------------------
// Convenience wrapper
// ---------------------------------------------------------------------------

/**
 * Convenience entry point for production callers. Lazily constructs
 * `defaultPipelineDeps()` on first invocation; subsequent calls reuse
 * the cached deps. Tests should NOT use this — they should call
 * `buildPipeline(mockDeps)` directly.
 */
export async function runPipeline(
  prompt: string,
  opts: PipelineOptions = {},
): Promise<PipelineResult> {
  const deps = await defaultPipelineDeps();
  const inner = buildPipeline(deps);
  return inner(prompt, opts);
}
