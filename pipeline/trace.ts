/**
 * Trace event interfaces — STUB for Unit 6.
 *
 * Unit 7 expands this file with the real writer, scrub policy, canonical-
 * envelope hash helpers (`computePromptVersionHash`), and the tightened
 * `TraceEvent` discriminated union. Unit 6 ships only the interface +
 * NoopTraceWriter so the orchestrator's `PipelineDeps.traceWriter` slot
 * has a contract to consume.
 *
 * Design rationale (locked here so Unit 7 doesn't re-litigate):
 *   - Best-effort writer: file-write failures are caught at the writer
 *     boundary, logged on stderr, and never propagate. The orchestrator
 *     does not see write failures as a return value.
 *   - JSON-Lines append-only: one event per line, `\n`-delimited, no
 *     trailing comma. Each `emit` is a single `Bun.write` append call
 *     so a process kill mid-run still leaves a parseable prefix.
 *   - Run lifecycle: `open(run_id)` writes the start `pipeline_summary`;
 *     `close()` writes the end `pipeline_summary`. The double-summary
 *     shape lets a downstream reader detect partial traces.
 *
 * @see docs/plans/2026-04-27-001-feat-v01-pipeline-units-6-7-8-plan.md
 *      § Trace event schema (Unit 7) — the full event shape Unit 7 lands.
 */

/**
 * Loose union for Unit 6. Unit 7 tightens this into a discriminated
 * union over `"pipeline_summary" | "llm_call" | "gate_outcome" |
 * "compile_call" | "honest_gap" | "repair_attempt"`. Keeping it loose
 * here lets Unit 6's orchestrator emit events without committing to the
 * exact field set Unit 7 will lock.
 */
export interface TraceEvent {
  /** ISO-8601 timestamp of the event. */
  ts: string;
  /** Run identifier shared by every event in the same run. */
  run_id: string;
  /** Discriminator chosen from the union above. */
  event: string;
  /** Per-event payload fields. Unknown shape at the Unit 6 stub level. */
  [key: string]: unknown;
}

/**
 * v0.5 — Unit 1: structured `wokwi_run` trace event variant.
 *
 * Emitted by `tests/acceptance/wokwi/run.ts` after each per-prompt
 * simulation (cache hit OR cold). The fields are typed so the v0.5
 * eval consumer + v0.9 meta-harness proposer can read assertion
 * results without runtime parsing of an opaque payload.
 *
 * Per the v0.5 plan § High-Level Technical Design § wokwi_run schema:
 *
 * ```text
 * { ts, run_id, event: "wokwi_run", prompt_filename, cache_hit,
 *   bundle_sha256, cache_key, outcome: "ok" | WokwiFailureKind,
 *   simulated_ms, assertion_results: [...] }
 * ```
 *
 * **Scrub policy.** `assertion_results` is structured-only (per-assertion
 * pass/fail state + actual values + expected ranges). It carries NO SDK
 * error content, NO request bodies, NO Bearer tokens. The existing
 * `pipeline/trace.ts` Bearer/messages scrubber (Unit 7) passes the
 * variant through unchanged. The v0.5 plan calls this out: "scrub
 * policy passes through without redaction." Defense-in-depth: the
 * Wokwi runner explicitly does NOT include any token/secret/env value
 * in the event payload. If a future contributor adds an `errors[]`
 * field carrying SDK output, the existing scrubber handles it.
 *
 * **Append-only discipline.** This variant is additive — it does not
 * change any existing event's shape. Existing tests (`tests/pipeline.test.ts`'s
 * `RecordingTraceWriter` consumes the loose `TraceEvent` interface)
 * continue to type-check unchanged.
 */
export interface WokwiRunTraceEvent extends TraceEvent {
  event: "wokwi_run";
  /** Acceptance prompt filename (e.g., "01-distance-servo.txt"). */
  prompt_filename: string;
  /** True iff the simulation cache short-circuited the wokwi-cli call. */
  cache_hit: boolean;
  /**
   * SHA-256 of the canonical bundle envelope
   * (`{diagram_json, wokwi_toml, assertions}`). Determined-by-input;
   * a change in any input byte produces a new hash. Used by the v0.5
   * acceptance runner to detect bundle drift across runs.
   */
  bundle_sha256: string;
  /**
   * The composite cache key combining `bundle_sha256` with the compiled
   * hex's hash. Two prompts producing the same hex against the same
   * bundle share a `cache_key` and a single simulation result.
   */
  cache_key: string;
  /**
   * `"ok"` on assertion pass, otherwise the failure kind from the
   * 8-literal `WokwiFailureKind` discriminated union in
   * `tests/acceptance/wokwi/run.ts`. We use a string here (not a
   * cross-module import) because `pipeline/trace.ts` should not depend
   * on the test-side runner module.
   */
  outcome:
    | "ok"
    | "missing-bundle"
    | "synthesis-failed"
    | "cli-not-installed"
    | "license-missing"
    | "timeout"
    | "assertion-failed"
    | "transport"
    | "aborted";
  /** Wall-clock duration of the simulation in milliseconds. 0 on cache hit replay. */
  simulated_ms: number;
  /**
   * Per-assertion outcome list. Each entry carries the assertion kind,
   * its target/expected fields, and pass/actual data. Structured-only;
   * see the scrub-policy comment above.
   */
  assertion_results: ReadonlyArray<WokwiAssertionResult>;
}

/**
 * Per-assertion outcome — the structured payload of `assertion_results`
 * inside a `wokwi_run` event. Discriminated on `kind` so the v0.5 eval
 * consumer can switch on the assertion type without per-event runtime
 * parsing.
 */
export type WokwiAssertionResult =
  | {
      kind: "state";
      at_ms: number;
      target: string;
      expected_range?: readonly [number, number];
      expected_value?: string | boolean;
      actual?: number | string | boolean;
      passed: boolean;
    }
  | {
      kind: "duration";
      run_for_ms: number;
      target: string;
      actual: boolean;
      passed: boolean;
    }
  | {
      kind: "serial_regex";
      pattern: string;
      must_match: boolean;
      matched: boolean;
      passed: boolean;
    };

/**
 * The writer contract Unit 6's orchestrator depends on. Unit 7's
 * production writer will implement this exact shape; the NoopTraceWriter
 * below is the default Unit 6 ships so tests + DI never see a `null`
 * writer.
 *
 * All three methods return `Promise<void>` — the orchestrator awaits
 * each call sequentially. Unit 7's real writer flushes per-emit so a
 * process kill leaves the file in a parseable state.
 */
export interface TraceWriter {
  /**
   * Open a new trace for `run_id`. Unit 7 implementation: opens
   * `traces/<run-id>.jsonl` for append, writes the start
   * `pipeline_summary` event.
   */
  open(run_id: string): Promise<void>;
  /**
   * Append an event. Unit 7 implementation: serializes through the
   * scrub policy + canonical-envelope hashes, writes one line.
   */
  emit(event: TraceEvent): Promise<void>;
  /**
   * Close the trace. Unit 7 implementation: writes the end
   * `pipeline_summary` event with outcome + cost_usd + total_latency_ms.
   */
  close(): Promise<void>;
}

/**
 * The no-op writer Unit 6 ships as the default. Unit 7's PR swaps
 * `defaultPipelineDeps()` to inject `defaultTraceWriter()` instead.
 *
 * Tests that don't care about traces use this directly. Production
 * callers post-Unit 7 get the real writer.
 */
export const NoopTraceWriter: TraceWriter = {
  open: async (_run_id: string): Promise<void> => undefined,
  emit: async (_event: TraceEvent): Promise<void> => undefined,
  close: async (): Promise<void> => undefined,
};
