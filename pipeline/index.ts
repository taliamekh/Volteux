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
 * **Cost tracking placeholder.** Unit 7's `pipeline/cost.ts` lands the
 * real CostTracker. Unit 6 ships a `NoopCostTracker` so the orchestrator's
 * `cost_usd` field has a contract; Unit 7 swaps the implementation.
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
} from "./llm/classify.ts";
import {
  generate as defaultGenerate,
  defaultGenerateDeps,
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
} from "./gates/compile.ts";
import {
  NoopTraceWriter,
  type TraceWriter,
} from "./trace.ts";
import type {
  VolteuxHonestGap,
  VolteuxProjectDocument,
} from "../schemas/document.zod.ts";
import type { RuleAttempt } from "./rules/index.ts";

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
      traceWriter: NoopTraceWriter,
      costTrackerFactory: NoopCostTracker,
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
// Factory (commit-1 scaffold; commit-4 fills in the orchestration body)
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
 *
 * **Commit-1 scaffold:** the closure body throws a not-implemented
 * error — commit-4 lands the full classify→generate→[gates]→compile
 * sequence with bounded cross-gate repair. The factory's signature is
 * stable so tests + downstream consumers can target the shape today.
 */
export function buildPipeline(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _deps: PipelineDeps,
): (prompt: string, opts?: PipelineOptions) => Promise<PipelineResult> {
  return async function runPipelineInner(
    _prompt: string,
    _opts: PipelineOptions = {},
  ): Promise<PipelineResult> {
    throw new Error(
      "buildPipeline body is a commit-1 scaffold; commit-4 lands the orchestration loop",
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
