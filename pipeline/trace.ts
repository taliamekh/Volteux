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
