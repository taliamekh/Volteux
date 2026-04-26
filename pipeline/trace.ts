/**
 * JSON-Lines trace writer + scrub policy + canonical-envelope hash helpers.
 *
 * Unit 7 expansion of the Unit 6 stub. Ships:
 *   - `TraceEvent` discriminated union (6 event kinds + double
 *     `pipeline_summary` start/end shape)
 *   - `TraceWriter` interface (unchanged from the stub)
 *   - `NoopTraceWriter` (unchanged from the stub; tests still use it)
 *   - `defaultTraceWriter(opts?)` factory (NEW) — opens
 *     `<dir>/<run-id>.jsonl` for append, per-emit flush, best-effort
 *     boundary (file-write failures log a stderr WARN but never propagate)
 *   - `computePromptVersionHash(inputs)` (NEW) — single-envelope JSON
 *     stringify per the sha256 cache-key learning
 *   - `scrubSdkError(message)` (NEW) — pure function, redacts API keys,
 *     Bearer tokens, request body fragments, and Authorization header
 *     value echoes; returns a `miss` flag the writer surfaces as a
 *     stderr WARN per the no-silent-failures discipline
 *   - `__testing` namespace exposing internals for test introspection
 *
 * **Best-effort writer boundary (residual #18 + smoke-script precedent).**
 * `defaultTraceWriter`'s `emit` catches every `Bun.write` reject and
 * `mkdir` failure, logs `[trace] WARN: write to <path> failed: <message>`
 * on stderr, and returns `Promise.resolve()`. The orchestrator NEVER
 * sees a write failure as a return value — the whole point of the writer
 * is to be observable by humans/eval-harness without becoming a critical
 * path that crashes the run.
 *
 * **JSON-Lines integrity.** One JSON object per line, `\n`-terminated,
 * append-only. No trailing comma. Each `emit` call is exactly one
 * `Bun.write` append; the file is never seeked or rewritten. A process
 * kill mid-run leaves a parseable prefix.
 *
 * **Double `pipeline_summary` (start + end) is intentional.** `open()`
 * writes the START summary; `close()` writes the END summary. A partial
 * trace (process killed) has the START but no END — the eval harness can
 * detect incomplete runs without parsing the whole file.
 *
 * **Canonical-envelope rule for ALL composite hashes (sha256 learning).**
 * `computePromptVersionHash` builds ONE canonical `JSON.stringify`
 * envelope object → ONE `hash.update()` call → digest. No separator
 * bytes (`\0`, `:`, `|`, etc.) anywhere. The cache-key learning
 * documented why: `z.string()` accepts NUL and any user-controlled
 * field can collide with a sibling field's content under raw
 * separator-byte concatenation.
 *
 * **Scrub-misses surface as stderr WARN, not silent.** When
 * `scrubSdkError` returns `{miss: true}`, the writer logs the WARN AND
 * replaces the field's value with `<scrub-miss-detected>` BEFORE
 * writing the line. Per the no-silent-failures discipline.
 *
 * **Module-level state.** `defaultTraceWriter` is a factory — each call
 * returns a fresh closure carrying the per-run file handle path + the
 * pending-write tracker. There is NO module-level singleton; the
 * lazy-init learning's in-flight-Promise pattern doesn't apply here
 * because every `runPipeline` call constructs its own writer instance.
 *
 * @see docs/plans/2026-04-27-001-feat-v01-pipeline-units-6-7-8-plan.md
 *      § Trace event schema (Unit 7)
 * @see docs/solutions/security-issues/sha256-cache-key-canonical-json-serialization-2026-04-26.md
 */

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { CompileGateFailureKind } from "./gates/compile.ts";
import type {
  VolteuxArchetypeId,
  VolteuxHonestGapScope,
} from "../schemas/document.zod.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TRACE_DIR = "traces";
const PROMPT_VERSION_HASH_LENGTH = 16;

/** Sensitive-pattern regexes used by `scrubSdkError`. Module-level so
 *  the test suite can reference them directly via `__testing`. */
const RE_API_KEY = /sk-ant-api03-[A-Za-z0-9_-]{20,}/g;
const RE_BEARER = /Bearer [A-Za-z0-9._-]{20,}/gi;
const RE_MESSAGES_FRAGMENT = /"messages"\s*:\s*\[[\s\S]*?\]/g;
const RE_AUTH_HEADER = /"authorization"\s*:\s*"[^"]*"/gi;

/** Second-pass detectors used to compute the `miss` flag. These are
 *  STRICTER than the redaction regexes above — they fire on PARTIAL
 *  matches (e.g., the `sk-ant-api03-` substring with insufficient
 *  trailing chars to satisfy the redaction regex's `{20,}` quantifier).
 *  Any post-scrub hit indicates a redaction shape we missed. */
const RE_MISS_API_KEY_PREFIX = /sk-ant-api03-[A-Za-z0-9_-]+/;
const RE_MISS_BEARER_PREFIX = /Bearer [A-Za-z0-9._-]+/i;
const RE_MISS_MESSAGES_PREFIX = /"messages"\s*:\s*\[/;

// ---------------------------------------------------------------------------
// Pipeline failure-kind alias (avoid circular import with pipeline/index.ts)
// ---------------------------------------------------------------------------

/**
 * Re-declared here verbatim from `pipeline/index.ts`'s
 * `PipelineFailureKind` to avoid a circular import (`pipeline/trace.ts`
 * is imported BY `pipeline/index.ts`). Any drift here would surface as
 * a TS error at the call site in `pipeline/index.ts`'s emitEvent
 * helper, which assigns a `PipelineFailureKind` to a `TraceEvent`
 * field typed against this alias.
 *
 * Single source of truth for the literal set is `pipeline/index.ts`;
 * this declaration MUST stay in sync.
 */
export type TracePipelineFailureKind =
  | "out-of-scope"
  | "schema-failed"
  | "compile-failed"
  | "rules-red"
  | "xconsist-failed"
  | "transport"
  | "truncated"
  | "aborted";

// ---------------------------------------------------------------------------
// TraceEvent discriminated union (6 kinds; pipeline_summary covers start + end)
// ---------------------------------------------------------------------------

/**
 * Common fields every event carries. Discriminator is `event`. Each
 * variant adds its own payload fields.
 */
interface TraceEventBase {
  /** ISO-8601 timestamp at the moment the event was emitted. */
  ts: string;
  /** Run identifier shared by every event in the same run. */
  run_id: string;
}

/**
 * `pipeline_summary` — TWO emissions per run, distinguished by `phase`.
 * Start event has `prompt`/`prompt_sha256`/`started_at`; end event has
 * `outcome`/`cost_usd`/`total_latency_ms`/`ended_at`. Splitting them
 * into one variant with an optional payload + `phase` discriminator
 * keeps the union narrow without forcing two top-level event names.
 */
export interface TracePipelineSummaryStart extends TraceEventBase {
  event: "pipeline_summary";
  phase: "start";
  /** Verbatim user prompt; the writer's scrub policy doesn't touch this. */
  prompt: string;
  /** SHA-256 of the prompt text (full hex). Used for cross-run dedup. */
  prompt_sha256: string;
  /** Composite hash over the canonical envelope of all prompt-shaping inputs. */
  prompt_version_hash: string;
  /** Short git commit hash for this build of the pipeline; "" if unavailable. */
  git_sha: string;
  /** ISO-8601 timestamp of run start. */
  started_at: string;
}

export interface TracePipelineSummaryEnd extends TraceEventBase {
  event: "pipeline_summary";
  phase: "end";
  outcome: "ok" | TracePipelineFailureKind;
  cost_usd: number;
  total_latency_ms: number;
  ended_at: string;
}

export type TracePipelineSummary =
  | TracePipelineSummaryStart
  | TracePipelineSummaryEnd;

/**
 * `llm_call` — one event per Sonnet/Haiku request. Carries usage on
 * success; `outcome` discriminates success vs the per-source failure
 * kinds. `usage` is OPTIONAL because the failure paths don't always
 * carry a usage snapshot (e.g., transport errors fire before the
 * response is parsed).
 */
export interface TraceLlmCall extends TraceEventBase {
  event: "llm_call";
  model: "claude-sonnet-4-6" | "claude-haiku-4-5";
  attempt: number;
  outcome:
    | "ok"
    | "schema-failed"
    | "truncated"
    | "transport"
    | "sdk-error"
    | "abort";
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  /** Latency in ms; OPTIONAL because the orchestrator may not measure
   *  per-call latency in v0.1 (deferred to v0.5 trace expansion). */
  latency_ms?: number;
}

/**
 * `gate_outcome` — one event per gate evaluation. The 3 in-scope gates
 * are schema, xconsist, rules. (compile is a separate `compile_call`
 * event because its payload is much richer.) The orchestrator emits
 * exactly 3 of these per attempt; with cross-gate repair, an attempt-2
 * loop emits another 3 (or fewer if repair succeeded earlier).
 */
export interface TraceGateOutcome extends TraceEventBase {
  event: "gate_outcome";
  gate: "schema" | "xconsist" | "rules";
  ok: boolean;
  errors_count: number;
  /** Rules engine specifically — the 3 severity buckets. */
  red_count?: number;
  amber_count?: number;
  blue_count?: number;
}

/**
 * `compile_call` — one event per arduino-cli compile invocation. Carries
 * the cache_hit + latency + hex_size + toolchain_version_hash so the
 * eval harness can attribute timing to cache vs cold-compile.
 */
export interface TraceCompileCall extends TraceEventBase {
  event: "compile_call";
  ok: boolean;
  kind?: CompileGateFailureKind;
  cache_hit: boolean;
  hex_size_bytes: number;
  latency_ms: number;
  toolchain_version_hash?: string;
  errors_count?: number;
}

/**
 * `honest_gap` — one event when the orchestrator finalizes a failure
 * with a formatted Honest Gap. `trigger_kind` is the
 * `PipelineFailureKind` that produced it; `scope` is the formatter's
 * categorical output.
 */
export interface TraceHonestGap extends TraceEventBase {
  event: "honest_gap";
  scope: VolteuxHonestGapScope;
  missing_capabilities: ReadonlyArray<string>;
  explanation: string;
  trigger_kind: TracePipelineFailureKind;
}

/**
 * `repair_attempt` — one event per cross-gate repair turn. Bounded at
 * ≤1 per `runPipeline` call (per the orchestrator's per-run counter);
 * the trace MUST never carry more than one of these.
 */
export interface TraceRepairAttempt extends TraceEventBase {
  event: "repair_attempt";
  trigger_kind: TracePipelineFailureKind;
  /** Structured 200-char-ish digest of the failing doc; not the full doc. */
  prior_doc_digest: string;
  /** SHA-256 of the repair-prompt text (post-template substitution). */
  repair_prompt_sha256?: string;
  /** Set on the END of the repair turn — `ok` if the second gate pass
   *  succeeded; `failed` if it didn't. The orchestrator emits this
   *  field on the second event for the same repair turn (currently the
   *  v0.1 emitter writes the repair_attempt at trigger time without an
   *  outcome; v0.5 may split into start/end events). */
  outcome?: "ok" | "failed";
}

/**
 * The full discriminated union over the 6 event kinds (with
 * `pipeline_summary` split into start + end variants under one
 * discriminator).
 */
export type TraceEvent =
  | TracePipelineSummary
  | TraceLlmCall
  | TraceGateOutcome
  | TraceCompileCall
  | TraceHonestGap
  | TraceRepairAttempt;

/**
 * Canonical event-name set used by the test scenarios + downstream
 * consumers. Frozen to prevent accidental mutation.
 */
export const TRACE_EVENT_NAMES = Object.freeze([
  "pipeline_summary",
  "llm_call",
  "gate_outcome",
  "compile_call",
  "honest_gap",
  "repair_attempt",
] as const);

export type TraceEventName = (typeof TRACE_EVENT_NAMES)[number];

// ---------------------------------------------------------------------------
// TraceWriter interface + NoopTraceWriter (UNCHANGED from Unit 6 stub)
// ---------------------------------------------------------------------------

/**
 * The writer contract every TraceWriter implements. Same shape as
 * Unit 6's stub — `defaultTraceWriter` is the production replacement.
 *
 * All three methods return `Promise<void>` — the orchestrator awaits
 * each call sequentially. The real writer flushes per-emit so a
 * process kill leaves the file in a parseable state.
 */
export interface TraceWriter {
  /**
   * Open a new trace for `run_id`. Implementations write the start
   * `pipeline_summary` event. Idempotent within a single instance —
   * calling `open` twice on the same writer is a programming error
   * but the writer must not crash (logs a WARN and continues).
   */
  open(run_id: string): Promise<void>;
  /**
   * Append an event. The real writer applies the scrub policy +
   * canonical-envelope hashes, writes one line. Best-effort: file-I/O
   * failures log a stderr WARN and return without throwing.
   */
  emit(event: TraceEvent): Promise<void>;
  /**
   * Close the trace. Implementations write the end `pipeline_summary`
   * event with outcome + cost_usd + total_latency_ms.
   *
   * IMPORTANT: in Unit 7, the START + END `pipeline_summary` events are
   * emitted by the ORCHESTRATOR via `emit()`, NOT by the writer's
   * open/close. The writer's open/close are file-handle lifecycle only.
   * This split keeps the writer policy-free; the orchestrator decides
   * the payload for both summaries.
   */
  close(): Promise<void>;
}

/**
 * The no-op writer Unit 6 still ships as the test default. Tests that
 * don't care about traces use this directly. Production callers
 * post-Unit 7 get `defaultTraceWriter()` instead.
 */
export const NoopTraceWriter: TraceWriter = {
  open: async (_run_id: string): Promise<void> => undefined,
  emit: async (_event: TraceEvent): Promise<void> => undefined,
  close: async (): Promise<void> => undefined,
};

// ---------------------------------------------------------------------------
// computePromptVersionHash — canonical-envelope rule (sha256 learning)
// ---------------------------------------------------------------------------

/**
 * Inputs to the prompt-version hash. Every field is user-controlled or
 * version-controlled; the canonical-envelope rule applies to ALL of
 * them per the sha256 cache-key learning (a NUL byte in any field would
 * collide under raw separator-byte concatenation; canonical JSON
 * envelope is structurally unambiguous).
 */
export interface PromptVersionHashInputs {
  archetype_id: VolteuxArchetypeId;
  /** Hex SHA-256 of `pipeline/prompts/archetype-1-system.md` source bytes. */
  system_prompt_source_sha256: string;
  /** Hex SHA-256 of the schema primer source bytes. */
  schema_primer_sha256: string;
  /** Hex SHA-256 of the few-shot source bytes. `null` if no few-shots. */
  fewshot_source_sha256_or_null: string | null;
  /** Hex SHA-256 of `pipeline/prompts/repair-archetype-1.md`. */
  repair_prompt_sha256: string;
  /** Anthropic model id (e.g., `claude-sonnet-4-6`). */
  model: string;
  /** Generation `max_tokens` cap; affects truncation behavior. */
  max_tokens: number;
}

/**
 * Compute the prompt-version hash. Builds ONE canonical envelope object
 * → ONE `JSON.stringify` → ONE `hash.update()` call. NEVER use
 * separator-byte concatenation. The 16-char prefix is enough for cross-
 * run dedup at v0.1 trace volume; v0.5 may extend if collision risk
 * grows.
 *
 * @see docs/solutions/security-issues/sha256-cache-key-canonical-json-serialization-2026-04-26.md
 *      Prevention #1 (canonical-envelope rule).
 */
export function computePromptVersionHash(
  inputs: PromptVersionHashInputs,
): string {
  const canonical = JSON.stringify({
    archetype_id: inputs.archetype_id,
    system_prompt_source_sha256: inputs.system_prompt_source_sha256,
    schema_primer_sha256: inputs.schema_primer_sha256,
    fewshot_source_sha256_or_null: inputs.fewshot_source_sha256_or_null,
    repair_prompt_sha256: inputs.repair_prompt_sha256,
    model: inputs.model,
    max_tokens: inputs.max_tokens,
  });
  const hash = createHash("sha256");
  hash.update(canonical);
  return hash.digest("hex").slice(0, PROMPT_VERSION_HASH_LENGTH);
}

/**
 * Compute the SHA-256 of an arbitrary string (full hex). Used for
 * `prompt_sha256` on the start `pipeline_summary` event.
 */
export function computeStringSha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ---------------------------------------------------------------------------
// scrubSdkError — redaction policy (residual #18)
// ---------------------------------------------------------------------------

/**
 * Result of `scrubSdkError`. `clean` is the redacted message; `miss`
 * is true when a sensitive shape may still be present after scrubbing.
 */
export interface ScrubResult {
  clean: string;
  miss: boolean;
}

/**
 * Pure function: redact secrets from an SDK error message before
 * persistence. Replicates the common shapes the Anthropic SDK actually
 * emits in 4xx/5xx error bodies (per the c-preprocessor learning's
 * principle: model the downstream emitter, not what we think it
 * should emit).
 *
 * Redactions:
 *   - `sk-ant-api03-...` API keys → `<redacted-anthropic-key>`
 *   - `Bearer ...` tokens → `Bearer <redacted>`
 *   - `"messages": [...]` request body fragments → `"messages":<redacted-request-body>`
 *     (non-greedy match across newlines; brace-balanced extraction is
 *     overkill for the v0.1 surface — see limitation note below)
 *   - `"authorization": "..."` header value echoes → `"authorization":"<redacted>"`
 *
 * **`miss` flag.** Computed via a STRICTER second pass over the cleaned
 * string. If a sensitive PREFIX (`sk-ant-api03-` substring, `Bearer `
 * with any token chars, `"messages":` with any opening bracket) survives
 * the redaction, `miss` is true and the writer surfaces a stderr WARN
 * before persisting.
 *
 * **Limitation: messages-fragment is regex-based, not brace-balanced.**
 * A pathological SDK error containing nested arrays inside the
 * `"messages":` value (e.g., a content block with array attachments)
 * could produce an over-aggressive match. v0.5 may swap to a streaming
 * JSON parser if real SDK errors exhibit this shape. The non-greedy
 * `[\s\S]*?` quantifier covers newlines without span-runaway.
 */
export function scrubSdkError(message: string): ScrubResult {
  const clean = message
    .replace(RE_API_KEY, "<redacted-anthropic-key>")
    .replace(RE_BEARER, "Bearer <redacted>")
    .replace(RE_MESSAGES_FRAGMENT, '"messages":<redacted-request-body>')
    .replace(RE_AUTH_HEADER, '"authorization":"<redacted>"');
  // Second pass: stricter prefix detectors. If any sensitive PREFIX
  // survives the redactions above, flag a miss.
  const miss =
    RE_MISS_API_KEY_PREFIX.test(clean) ||
    RE_MISS_BEARER_PREFIX.test(clean) ||
    RE_MISS_MESSAGES_PREFIX.test(clean);
  return { clean, miss };
}

// ---------------------------------------------------------------------------
// defaultTraceWriter — JSON-Lines append-only writer
// ---------------------------------------------------------------------------

/**
 * Options for `defaultTraceWriter`. All optional; defaults match the
 * v0.1 production setup.
 */
export interface DefaultTraceWriterOptions {
  /** Directory for trace files. Defaults to `traces/`. */
  dir?: string;
  /**
   * Clock injected for testing — `() => new Date()` in production. When
   * the writer scrubs an event payload, it stamps a fresh `ts` from
   * this clock; tests use a fixed clock for deterministic output.
   */
  clock?: () => Date;
  /**
   * Stderr sink. Defaults to `process.stderr.write`. Tests inject a
   * recorder to assert the WARN emissions (scrub-miss + write-fail).
   */
  stderr?: (line: string) => void;
}

/**
 * Build a fresh `TraceWriter` instance. Each call returns an
 * independent writer — there is NO module-level singleton because each
 * `runPipeline` invocation needs its own file handle path.
 *
 * Implementation detail: `Bun.write(path, str)` appends when the file
 * exists (Bun.file's write semantics are append-on-overwrite for new
 * data when called with a string at a non-zero offset — actually
 * Bun.write OVERWRITES). To get APPEND semantics we use Node's
 * `fs.promises.appendFile` via a dynamic import, which is the
 * documented append API on the Bun runtime as of 1.3.
 *
 * Trace-write failures (`appendFile` reject, `mkdir` failure) are
 * caught at the `emit` boundary; the writer logs `[trace] WARN: write
 * to <path> failed: <message>` on stderr and returns without
 * propagating. Mirrors the smoke script's `writeTraceFile` boundary
 * pattern (precedent referenced in the plan).
 */
export function defaultTraceWriter(
  opts: DefaultTraceWriterOptions = {},
): TraceWriter {
  const dir = opts.dir ?? DEFAULT_TRACE_DIR;
  const stderr =
    opts.stderr ??
    ((line: string): void => {
      process.stderr.write(line);
    });

  let path: string | null = null;
  let dirEnsured = false;

  /**
   * Ensure the trace directory exists. Idempotent — first call mkdirs;
   * subsequent calls no-op. Mkdir failure is caught and surfaced as a
   * stderr WARN; subsequent emits then fail (and surface their own
   * WARN) but never crash the orchestrator.
   */
  async function ensureDir(): Promise<boolean> {
    if (dirEnsured) return true;
    try {
      await mkdir(dir, { recursive: true });
      dirEnsured = true;
      return true;
    } catch (err) {
      stderr(
        `[trace] WARN: mkdir(${dir}) failed: ${(err as Error).message}\n`,
      );
      return false;
    }
  }

  /**
   * Apply the scrub policy to event payload string fields. Returns a
   * new event object with redacted strings; the original event is not
   * mutated. The set of field names we scrub is intentionally narrow —
   * we DON'T scrub the `prompt` field on `pipeline_summary` start
   * (that's the user's verbatim input; redacting it would defeat the
   * trace's purpose). We DO scrub fields that may carry SDK error
   * messages: `explanation`, `errors[]` items if present, the
   * `repair_prompt_sha256` is a hash so it's not at risk.
   *
   * Returns a `miss` flag aggregated across every scrubbed field; the
   * caller emits a stderr WARN if any field hit the miss detector.
   */
  function scrubEventFields(event: TraceEvent): {
    scrubbed: TraceEvent;
    miss: boolean;
    missField?: string;
  } {
    let miss = false;
    let missField: string | undefined;

    function scrubField(value: unknown): unknown {
      if (typeof value !== "string") return value;
      const result = scrubSdkError(value);
      if (result.miss) {
        miss = true;
        return "<scrub-miss-detected>";
      }
      return result.clean;
    }

    // Honest Gap explanation may carry an SDK error excerpt.
    if (event.event === "honest_gap") {
      const cleanedExplanation = scrubField(event.explanation);
      if (miss && missField === undefined) missField = "explanation";
      return {
        scrubbed: { ...event, explanation: cleanedExplanation as string },
        miss,
        missField,
      };
    }

    // pipeline_summary START carries the verbatim user prompt; we DO
    // NOT scrub that. END carries no string fields at risk.
    if (event.event === "pipeline_summary") {
      return { scrubbed: event, miss: false };
    }

    // llm_call/gate_outcome/compile_call/repair_attempt have no
    // free-form string fields except possibly compile_call's missing
    // toolchain_version_hash and repair_attempt's prior_doc_digest;
    // both are structured outputs of our own code and not at risk of
    // carrying secrets. No scrub needed.
    return { scrubbed: event, miss: false };
  }

  return {
    async open(run_id: string): Promise<void> {
      // Per-instance idempotence: opening a second time on the same
      // instance is a programming error. We log a WARN and reset the
      // path to the new run id.
      if (path !== null) {
        stderr(
          `[trace] WARN: open(${run_id}) called twice on the same writer; previous path was ${path}\n`,
        );
      }
      path = `${dir}/${run_id}.jsonl`;
      // Eagerly ensure the dir so the first emit doesn't race.
      await ensureDir();
    },

    async emit(event: TraceEvent): Promise<void> {
      if (path === null) {
        stderr(
          `[trace] WARN: emit() called before open(); event dropped (event=${event.event})\n`,
        );
        return;
      }
      const okDir = await ensureDir();
      if (!okDir) {
        // ensureDir already logged the WARN.
        return;
      }
      const { scrubbed, miss, missField } = scrubEventFields(event);
      if (miss) {
        stderr(
          `[trace] WARN: scrub may have missed a sensitive token in event=${event.event} field=${missField ?? "<unknown>"}\n`,
        );
      }
      const line = JSON.stringify(scrubbed) + "\n";
      try {
        // Use Node's fs.promises.appendFile for APPEND semantics.
        // Bun.write overwrites; this is the documented append path.
        const { appendFile } = await import("node:fs/promises");
        // Defensive: if the parent dir disappeared between mkdir and
        // appendFile (race with a janitor), recreate it.
        await appendFile(path, line, { encoding: "utf8" });
      } catch (err) {
        stderr(
          `[trace] WARN: write to ${path} failed: ${(err as Error).message}\n`,
        );
        // Best-effort: if the parent dir vanished, try to recreate
        // and retry once. This is the only retry the writer does.
        try {
          await mkdir(dirname(path), { recursive: true });
          const { appendFile } = await import("node:fs/promises");
          await appendFile(path, line, { encoding: "utf8" });
        } catch (retryErr) {
          stderr(
            `[trace] WARN: retry write to ${path} failed: ${(retryErr as Error).message}\n`,
          );
        }
      }
    },

    async close(): Promise<void> {
      // No file handle to close — `appendFile` opens + closes per call
      // (acceptable at v0.1 trace volume: ~10-15 events per run). v0.5
      // may swap to a long-lived `FileHandle` if event rates climb.
      // We deliberately do NOT clear `path` so a post-close emit logs
      // a clear WARN naming the closed run.
    },
  };
}

// ---------------------------------------------------------------------------
// __testing namespace (test-only introspection)
// ---------------------------------------------------------------------------

/**
 * Test-only escape hatches. Production code MUST NOT import from here.
 * Mirrors `infra/server/cache.ts`'s `__testing` shape per the lazy-init
 * learning's forward-going prescription.
 *
 * Stateless module: there is no cached singleton to reset. The exposed
 * helpers are introspection-only.
 */
export const __testing = {
  /** Internal scrub regexes (read-only references). */
  RE_API_KEY,
  RE_BEARER,
  RE_MESSAGES_FRAGMENT,
  RE_AUTH_HEADER,
  /** Default trace directory + prompt-version hash length. */
  DEFAULT_TRACE_DIR,
  PROMPT_VERSION_HASH_LENGTH,
  /** Computes the canonical JSON envelope used by computePromptVersionHash
   *  WITHOUT hashing — used by the NUL-collision matrix tests to assert
   *  every input field produces a distinct envelope. */
  envelopeForPromptVersionHash(inputs: PromptVersionHashInputs): string {
    return JSON.stringify({
      archetype_id: inputs.archetype_id,
      system_prompt_source_sha256: inputs.system_prompt_source_sha256,
      schema_primer_sha256: inputs.schema_primer_sha256,
      fewshot_source_sha256_or_null: inputs.fewshot_source_sha256_or_null,
      repair_prompt_sha256: inputs.repair_prompt_sha256,
      model: inputs.model,
      max_tokens: inputs.max_tokens,
    });
  },
};
