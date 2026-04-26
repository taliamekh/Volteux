#!/usr/bin/env bun
/**
 * v0.1-pipeline-io smoke wiring script — Unit 5 integration proof.
 *
 *   bun run smoke              # default: ASCII table + sha256, real API calls
 *   bun run smoke --json       # JSON output to stdout (rows + hash) instead of table
 *   bun run smoke --dry-run    # skip Anthropic + compile calls; emit canonical happy-path
 *                              #   outcomes for each prompt (useful for testing
 *                              #   pre-flight + output formatting without burning ~$0.27)
 *
 * Flags compose: `--json --dry-run` works.
 *
 * Runs 5 hand-written archetype-1 prompts SEQUENTIALLY through the full
 * v0.1 pipeline:
 *
 *   classify(prompt) → generate(prompt) → runSchemaGate(doc)
 *     → runCrossConsistencyGate(doc) → runRules(doc)
 *     → runCompileGate({ fqbn, sketch_main_ino, additional_files, libraries })
 *
 * Prints a per-prompt outcome table (or JSON) to stdout, computes
 * `sha256(JSON.stringify(table))` as the wiring-proof digest, and writes
 * the raw table to `traces/smoke-<run-id>.txt` (gitignored).
 *
 * **Stream discipline (agent-readability).** Stdout carries ONLY the
 * payload (table-or-JSON + the trailing hash line, or JSON-mode bytes).
 * Stderr carries every progress line, the trace path, and pre-flight
 * error messages. After writing the trace, the script emits a single
 * deterministic `TRACE_PATH=<path>` line on stderr — agents grepping
 * stderr for that prefix get a stable extraction path. Trace-write
 * failures are caught (logged on stderr) so a missing `traces/` write
 * permission does not crash the run.
 *
 * **Pre-flight discipline (the "fail informatively, not silently" mirror).**
 * Two pre-flight checks run BEFORE any Anthropic call so a missing local
 * dep does not burn Sonnet tokens chasing a missing container:
 *
 *   1. `GET /api/health` against `COMPILE_API_URL` (default
 *      `http://localhost:8787`). Non-200, fetch-throw, or 5s timeout →
 *      `"Compile API unreachable at <url>; run 'bun run compile:up' first"`
 *      → exit 1.
 *   2. `process.env.ANTHROPIC_API_KEY` non-empty. Missing → exit 1.
 *
 * Verified manually by running `bun run smoke` without `compile:up`
 * running: prints the unreachable message and exits 1 BEFORE any
 * `classify()` or `generate()` call.
 *
 * **Strict serial execution.** `await` each prompt's full pipeline
 * before starting the next. No `Promise.all`. The Compile API's
 * `pLimit(2)` would interleave concurrent compiles and the cache
 * (keyed on sketch content) could serve A's stderr to B's caller if
 * Sonnet emitted byte-identical sketches for two different prompts.
 * Sequentiality also keeps the per-prompt outcome table interpretable.
 *
 * **Per-prompt outcome enum (TypeScript discriminated union).**
 *   OK | OUT_OF_SCOPE | CLASSIFY_FAILED(kind) | GENERATE_FAILED(kind)
 *   | SCHEMA_FAILED | XCONSIST_FAILED | RULES_RED(count)
 *   | COMPILE_FAILED(kind) | QUEUE_FULL(retry_after_s)
 *
 * The outcome-print switch calls `assertNeverGenerateFailureKind`,
 * `assertNeverClassifyFailureKind`, and `assertNeverFailureKind` (the
 * existing one for `CompileGateFailureKind`) at the default branch of
 * each kind switch — a future kind addition fails compile-time at the
 * smoke script too. Mirrors the structural-mirror principle from
 * docs/solutions/best-practices/c-preprocessor-modelling-in-llm-output-gates-2026-04-25.md
 * — every gate failure produces a discriminated outcome the table can
 * render.
 *
 * **Confidence threshold filter is applied IN THE SCRIPT.** Even though
 * `classify()` returns raw output, this script applies the
 * `archetype_id !== "uno-ultrasonic-servo" || confidence < 0.6` check
 * itself — that is the orchestrator behaviour at smoke scale. The
 * threshold is NOT baked into `classify()`; the meta-harness in v0.9
 * tunes it. See classify.ts for the full rationale.
 *
 * **Queue-full is a load-shed signal, not a sketch problem.** When
 * `runCompileGate` returns `kind: "queue-full"`, this script records
 * `QUEUE_FULL(retry_after_s)` and skips. It does NOT retry — that's
 * orchestrator territory (Unit 9). The smoke script is a wiring proof,
 * not an orchestrator.
 *
 * **Cost projection.** ~$0.27 per full smoke run (5 × ~$0.05 Sonnet
 * generation calls + 5 × ~$0.005 Haiku classify calls + 5 × $0 compile
 * cache hits if same prompts/toolchain). Expect 5-10 runs during Unit 5
 * iteration ≈ ~$2.70 total. Ctrl-C interrupts safely between prompts.
 *
 * **Logger discipline.** Do not log the API key, request bodies, or
 * `process.env`. Every line printed is a structured outcome or a
 * pre-flight error message — no debug dumps.
 *
 * Exit codes (distinct so agents can disambiguate without parsing logs):
 *   0 — ≥3/5 OK rows (the wiring proof passes)
 *   1 — pre-flight failed (Compile API down, missing API key); the run
 *       never started its per-prompt loop
 *   2 — run completed but fewer than 3/5 OK rows (something is wired wrong
 *       inside the pipeline, not at its boundaries)
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve as pathResolve } from "node:path";
import {
  classify,
  assertNeverClassifyFailureKind,
  type ClassifyFailureKind,
  type ClassifyResult,
} from "../pipeline/llm/classify.ts";
import {
  generate,
  assertNeverGenerateFailureKind,
  type GenerateFailureKind,
  type GenerateResult,
} from "../pipeline/llm/generate.ts";
import { runSchemaGate } from "../pipeline/gates/schema.ts";
import { runCrossConsistencyGate } from "../pipeline/gates/cross-consistency.ts";
import { runRules } from "../pipeline/rules/index.ts";
import {
  runCompileGate,
  assertNeverFailureKind,
  type CompileGateFailureKind,
  type CompileGateResult,
} from "../pipeline/gates/compile.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_COMPILE_API_URL =
  process.env.COMPILE_API_URL ?? "http://localhost:8787";
const HEALTH_TIMEOUT_MS = 5_000;
const TARGET_ARCHETYPE_ID = "uno-ultrasonic-servo";
const CONFIDENCE_THRESHOLD = 0.6;
const PASS_THRESHOLD = 3; // ≥3/5 OK rows for exit 0
const SMOKE_PROMPTS_DIR = "scripts/smoke-prompts";
const TRACES_DIR = "traces";

// Distinct exit codes — `runSmoke` returns these in `SmokeOutput.exitCode`.
const EXIT_OK = 0;
const EXIT_PREFLIGHT_FAILED = 1;
const EXIT_BELOW_THRESHOLD = 2;

const PROMPT_FILES: ReadonlyArray<string> = [
  "01-distance-servo.txt",
  "02-pet-bowl.txt",
  "03-wave-on-approach.txt",
  "04-doorbell-style.txt",
  "05-misspelled.txt",
];

// ---------------------------------------------------------------------------
// CLI flag parsing (tiny — argparse would be overkill for 2 flags)
// ---------------------------------------------------------------------------

export interface SmokeFlags {
  /** `--json`: emit JSON output to stdout instead of the ASCII table. */
  json: boolean;
  /**
   * `--dry-run`: skip the actual classify/generate/compile calls and
   * stub a happy-path outcome per prompt. Useful for testing
   * pre-flight, formatting, and exit-code wiring without spending API
   * credits.
   */
  dryRun: boolean;
}

export function parseFlags(argv: ReadonlyArray<string>): SmokeFlags {
  return {
    json: argv.includes("--json"),
    dryRun: argv.includes("--dry-run"),
  };
}

// ---------------------------------------------------------------------------
// Outcome discriminated union (local to the script — Unit 9 has its own)
// ---------------------------------------------------------------------------

export type SmokeOutcome =
  | {
      kind: "OK";
      hex_size_bytes: number;
      cache_hit: boolean;
      latency_ms: number;
    }
  | { kind: "OUT_OF_SCOPE"; archetype_id: string | null; confidence: number }
  | { kind: "CLASSIFY_FAILED"; failure_kind: ClassifyFailureKind }
  | { kind: "GENERATE_FAILED"; failure_kind: GenerateFailureKind }
  | { kind: "SCHEMA_FAILED" }
  | { kind: "XCONSIST_FAILED" }
  | { kind: "RULES_RED"; count: number }
  | { kind: "COMPILE_FAILED"; failure_kind: CompileGateFailureKind }
  | { kind: "QUEUE_FULL"; retry_after_s: number };

export interface SmokeRow {
  prompt_index: number;
  prompt_file: string;
  prompt_text: string;
  outcome: SmokeOutcome;
  /** Wall-clock time of the full per-prompt pipeline. */
  total_latency_ms: number;
}

// ---------------------------------------------------------------------------
// Outcome short-form (used in the table column AND in the exhaustiveness switch)
// ---------------------------------------------------------------------------

/**
 * Render a per-stage outcome as a short string for the table column.
 * The default branches call the three `assertNever*` helpers so a future
 * kind addition fails compile-time at this site.
 */
function renderClassifyKind(kind: ClassifyFailureKind): string {
  switch (kind) {
    case "transport":
      return "classify-fail(transport)";
    case "sdk-error":
      return "classify-fail(sdk-error)";
    case "abort":
      return "classify-fail(abort)";
    case "schema-failed":
      return "classify-fail(schema-failed)";
    default:
      assertNeverClassifyFailureKind(kind);
  }
}

function renderGenerateKind(kind: GenerateFailureKind): string {
  switch (kind) {
    case "schema-failed":
      return "gen-fail(schema-failed)";
    case "truncated":
      return "gen-fail(truncated)";
    case "transport":
      return "gen-fail(transport)";
    case "sdk-error":
      return "gen-fail(sdk-error)";
    case "abort":
      return "gen-fail(abort)";
    default:
      assertNeverGenerateFailureKind(kind);
  }
}

function renderCompileKind(kind: CompileGateFailureKind): string {
  switch (kind) {
    case "transport":
      return "compile-fail(transport)";
    case "timeout":
      return "compile-fail(timeout)";
    case "auth":
      return "compile-fail(auth)";
    case "bad-request":
      return "compile-fail(bad-request)";
    case "rate-limit":
      return "compile-fail(rate-limit)";
    case "queue-full":
      // Defensive: should be `QUEUE_FULL` outcome, not `COMPILE_FAILED` with
      // `queue-full`. If it arrives here it's a bug; render anyway.
      return "compile-fail(queue-full)";
    case "compile-error":
      return "compile-fail(compile-error)";
    default:
      assertNeverFailureKind(kind);
  }
}

function renderClassifyOutcome(o: SmokeOutcome): string {
  if (o.kind === "OK") return "ok";
  if (o.kind === "OUT_OF_SCOPE") return "skip(out-of-scope)";
  if (o.kind === "CLASSIFY_FAILED") return renderClassifyKind(o.failure_kind);
  return "ok"; // classify succeeded; later stage failed.
}

function renderGenerateOutcome(o: SmokeOutcome): string {
  if (o.kind === "OK") return "ok";
  if (o.kind === "GENERATE_FAILED") return renderGenerateKind(o.failure_kind);
  // Stages before generate didn't run, or stages after report.
  if (o.kind === "OUT_OF_SCOPE" || o.kind === "CLASSIFY_FAILED") return "-";
  return "ok";
}

function renderCompileOutcome(o: SmokeOutcome): string {
  if (o.kind === "OK") return "ok";
  if (o.kind === "QUEUE_FULL") return `queue-full(retry=${o.retry_after_s}s)`;
  if (o.kind === "COMPILE_FAILED") return renderCompileKind(o.failure_kind);
  // Earlier stages failed; compile didn't run.
  return "-";
}

function renderRulesOutcome(o: SmokeOutcome): string {
  if (o.kind === "RULES_RED") return `red=${o.count}`;
  if (
    o.kind === "OK" ||
    o.kind === "QUEUE_FULL" ||
    o.kind === "COMPILE_FAILED"
  ) {
    return "0";
  }
  return "-";
}

function renderSchemaOutcome(o: SmokeOutcome): string {
  if (o.kind === "SCHEMA_FAILED") return "fail";
  if (
    o.kind === "OK" ||
    o.kind === "QUEUE_FULL" ||
    o.kind === "COMPILE_FAILED" ||
    o.kind === "XCONSIST_FAILED" ||
    o.kind === "RULES_RED"
  ) {
    return "ok";
  }
  return "-";
}

function renderXcOutcome(o: SmokeOutcome): string {
  if (o.kind === "XCONSIST_FAILED") return "fail";
  if (
    o.kind === "OK" ||
    o.kind === "QUEUE_FULL" ||
    o.kind === "COMPILE_FAILED" ||
    o.kind === "RULES_RED"
  ) {
    return "ok";
  }
  return "-";
}

// ---------------------------------------------------------------------------
// Pre-flight checks
// ---------------------------------------------------------------------------

export interface PreflightResult {
  ok: boolean;
  message?: string;
}

/**
 * Pre-flight ping of the Compile API's `/api/health` endpoint. Returns
 * `{ok: true}` on a 200; `{ok: false, message}` on any non-200, fetch
 * throw, or timeout. Treats degraded (503) the same as unreachable for
 * the smoke gate — we need a fully-functional compile path or there's
 * nothing to prove.
 */
export async function preflightHealthCheck(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = HEALTH_TIMEOUT_MS,
): Promise<PreflightResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${url}/api/health`, {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        message: `Compile API unreachable at ${url}; run 'bun run compile:up' first`,
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      message: `Compile API unreachable at ${url}; run 'bun run compile:up' first`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pre-flight env-var check. We never log the value — only check
 * non-empty.
 */
export function preflightApiKeyCheck(env: NodeJS.ProcessEnv): PreflightResult {
  const key = env["ANTHROPIC_API_KEY"];
  if (key === undefined || key === "") {
    return {
      ok: false,
      message:
        "ANTHROPIC_API_KEY is not set; export it before running 'bun run smoke'",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Per-prompt pipeline runner
// ---------------------------------------------------------------------------

export interface RunPromptDeps {
  classify: typeof classify;
  generate: typeof generate;
  runSchemaGate: typeof runSchemaGate;
  runCrossConsistencyGate: typeof runCrossConsistencyGate;
  runRules: typeof runRules;
  runCompileGate: typeof runCompileGate;
}

/**
 * Run the full pipeline for one prompt. Returns the SmokeOutcome.
 * Pure(-ish) — only side effects are the API calls in the deps.
 */
export async function runPromptPipeline(
  prompt: string,
  deps: RunPromptDeps,
): Promise<SmokeOutcome> {
  // ---- classify -------------------------------------------------------
  const classifyResult: ClassifyResult = await deps.classify(prompt);
  if (!classifyResult.ok) {
    return { kind: "CLASSIFY_FAILED", failure_kind: classifyResult.kind };
  }

  // The orchestrator behavior at smoke scale: filter on archetype + confidence.
  // The threshold lives HERE (not in classify.ts) — see file header.
  if (
    classifyResult.archetype_id !== TARGET_ARCHETYPE_ID ||
    classifyResult.confidence < CONFIDENCE_THRESHOLD
  ) {
    return {
      kind: "OUT_OF_SCOPE",
      archetype_id: classifyResult.archetype_id,
      confidence: classifyResult.confidence,
    };
  }

  // ---- generate -------------------------------------------------------
  const generateResult: GenerateResult = await deps.generate(prompt);
  if (!generateResult.ok) {
    return { kind: "GENERATE_FAILED", failure_kind: generateResult.kind };
  }
  const doc = generateResult.doc;

  // ---- schema gate ----------------------------------------------------
  const schemaResult = deps.runSchemaGate(doc);
  if (!schemaResult.ok) {
    return { kind: "SCHEMA_FAILED" };
  }

  // ---- cross-consistency gate ----------------------------------------
  const xcResult = deps.runCrossConsistencyGate(doc);
  if (!xcResult.ok) {
    return { kind: "XCONSIST_FAILED" };
  }

  // ---- rules engine ---------------------------------------------------
  const rulesOutcome = deps.runRules(doc);
  if (rulesOutcome.red.length > 0) {
    return { kind: "RULES_RED", count: rulesOutcome.red.length };
  }

  // ---- compile gate ---------------------------------------------------
  const compileResult: CompileGateResult = await deps.runCompileGate({
    fqbn: doc.board.fqbn,
    sketch_main_ino: doc.sketch.main_ino,
    additional_files: doc.sketch.additional_files,
    libraries: doc.sketch.libraries,
  });
  if (!compileResult.ok) {
    if (compileResult.kind === "queue-full") {
      // Load-shed signal — record and skip. Do NOT retry (orchestrator territory).
      return {
        kind: "QUEUE_FULL",
        retry_after_s: compileResult.retry_after_s ?? 30,
      };
    }
    return { kind: "COMPILE_FAILED", failure_kind: compileResult.kind };
  }

  return {
    kind: "OK",
    hex_size_bytes: compileResult.value.hex_size_bytes,
    cache_hit: compileResult.value.cache_hit,
    latency_ms: compileResult.value.latency_ms,
  };
}

// ---------------------------------------------------------------------------
// Table rendering + sha256 digest
// ---------------------------------------------------------------------------

export function computeSmokeHash(rows: ReadonlyArray<SmokeRow>): string {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function renderTable(rows: ReadonlyArray<SmokeRow>): string {
  const header =
    "prompt# | classify              | generate              | schema | xc   | rules | compile                  | hex   | cache  | total_ms";
  const sep =
    "------- | --------------------- | --------------------- | ------ | ---- | ----- | ------------------------ | ----- | ------ | --------";
  const lines = [header, sep];
  for (const row of rows) {
    const o = row.outcome;
    const hexCell = o.kind === "OK" ? String(o.hex_size_bytes) : "-";
    const cacheCell = o.kind === "OK" ? (o.cache_hit ? "true" : "false") : "-";
    const cells = [
      String(row.prompt_index).padStart(7, " "),
      renderClassifyOutcome(o).padEnd(21, " "),
      renderGenerateOutcome(o).padEnd(21, " "),
      renderSchemaOutcome(o).padEnd(6, " "),
      renderXcOutcome(o).padEnd(4, " "),
      renderRulesOutcome(o).padEnd(5, " "),
      renderCompileOutcome(o).padEnd(24, " "),
      hexCell.padEnd(5, " "),
      cacheCell.padEnd(6, " "),
      String(row.total_latency_ms).padStart(8, " "),
    ];
    lines.push(cells.join(" | "));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Run-id generation
// ---------------------------------------------------------------------------

/**
 * Generate a filesystem-safe run-id. ISO timestamp slug + 8-char UUID
 * suffix to disambiguate same-second runs.
 */
function generateRunId(): string {
  // Drop separators & sub-seconds for a tidy filename. UTC.
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const suffix = randomUUID().slice(0, 8);
  return `${ts}-${suffix}`;
}

// ---------------------------------------------------------------------------
// Smoke runner (testable; takes deps so unit tests can mock SDK + env)
// ---------------------------------------------------------------------------

export interface SmokeDeps {
  /** Function reading the prompt files. */
  readPromptFile: (filename: string) => Promise<string>;
  /** Pre-flight health-check function. */
  healthCheck: () => Promise<PreflightResult>;
  /** Pre-flight env-var check function. */
  apiKeyCheck: () => PreflightResult;
  /** Run-pipeline deps for each prompt. */
  pipelineDeps: RunPromptDeps;
  /** Persist the trace file (gitignored). Pass a noop in tests. */
  writeTraceFile: (filename: string, content: string) => Promise<void>;
  /** stdout sink (`process.stdout.write` in production; captured in tests). */
  stdout: (line: string) => void;
  /** stderr sink (`process.stderr.write` in production; captured in tests). */
  stderr: (line: string) => void;
  /** Run-id generator (deterministic in tests). */
  generateRunId: () => string;
  /** Optional flags. Defaults: { json: false, dryRun: false }. */
  flags?: SmokeFlags;
}

export interface SmokeOutput {
  /**
   * Exit code:
   *   0 — ≥3/5 OK rows passed
   *   1 — pre-flight failed; the per-prompt loop never started
   *   2 — run completed but <3/5 OK rows
   */
  exitCode: number;
  /** Rows produced (empty if pre-flight failed). */
  rows: ReadonlyArray<SmokeRow>;
  /** Sha256 digest of `JSON.stringify(rows)` (empty if no rows). */
  hash: string;
}

/**
 * Canonical happy-path SmokeOutcome for `--dry-run`. Every prompt
 * produces this without invoking classify/generate/compile, which
 * lets agents (and humans) test pre-flight + formatting + exit-code
 * wiring without burning ~$0.27 of API credit.
 */
function dryRunHappyOutcome(): SmokeOutcome {
  return {
    kind: "OK",
    hex_size_bytes: 0,
    cache_hit: false,
    latency_ms: 0,
  };
}

/**
 * Run the smoke script with injected deps. The CLI entrypoint at
 * `if (import.meta.main)` calls this with `defaultSmokeDeps()`.
 *
 * Stream discipline: stdout = payload (table or JSON + hash). Stderr =
 * progress lines, pre-flight errors, the trailing `TRACE_PATH=<path>`
 * marker, and any trace-write failure note. Agents that want a
 * one-shot extraction grep stderr for `^TRACE_PATH=`.
 */
export async function runSmoke(deps: SmokeDeps): Promise<SmokeOutput> {
  const flags: SmokeFlags = deps.flags ?? { json: false, dryRun: false };

  // `--dry-run` skips both pre-flight checks AND the per-prompt API calls
  // — its purpose is to exercise the output formatting + exit-code wiring
  // on a workstation without `compile:up` running and without an API key.
  if (!flags.dryRun) {
    // ---- Pre-flight 1: Compile API health ----------------------------
    const health = await deps.healthCheck();
    if (!health.ok) {
      deps.stderr(`${health.message ?? "Compile API unreachable"}\n`);
      return { exitCode: EXIT_PREFLIGHT_FAILED, rows: [], hash: "" };
    }

    // ---- Pre-flight 2: ANTHROPIC_API_KEY -----------------------------
    const keyCheck = deps.apiKeyCheck();
    if (!keyCheck.ok) {
      deps.stderr(`${keyCheck.message ?? "ANTHROPIC_API_KEY missing"}\n`);
      return { exitCode: EXIT_PREFLIGHT_FAILED, rows: [], hash: "" };
    }
  }

  // ---- Sequential per-prompt loop (NO Promise.all) -------------------
  const rows: SmokeRow[] = [];
  for (let i = 0; i < PROMPT_FILES.length; i++) {
    const filename = PROMPT_FILES[i] ?? "";
    const promptIndex = i + 1;
    const startedAt = Date.now();
    const promptText = (await deps.readPromptFile(filename)).trim();
    // Progress lines go to STDERR — stdout stays the structured payload.
    deps.stderr(`[smoke] prompt ${promptIndex}/${PROMPT_FILES.length}: ${filename}\n`);

    const outcome = flags.dryRun
      ? dryRunHappyOutcome()
      : await runPromptPipeline(promptText, deps.pipelineDeps);
    const elapsed = Date.now() - startedAt;

    rows.push({
      prompt_index: promptIndex,
      prompt_file: filename,
      prompt_text: promptText,
      outcome,
      total_latency_ms: elapsed,
    });
  }

  // ---- Render + persist ---------------------------------------------
  const tableText = renderTable(rows);
  const hash = computeSmokeHash(rows);
  const okCount = rows.filter((r) => r.outcome.kind === "OK").length;
  const exitCode = okCount >= PASS_THRESHOLD ? EXIT_OK : EXIT_BELOW_THRESHOLD;

  if (flags.json) {
    // JSON-mode output: a single self-describing payload to stdout.
    // The trailing newline keeps line-buffered consumers happy.
    deps.stdout(
      `${JSON.stringify({ rows, hash, ok_rows: okCount, threshold: PASS_THRESHOLD, exit_code: exitCode })}\n`,
    );
  } else {
    const summary =
      `\n${tableText}\n\n` +
      `OK rows: ${okCount}/${rows.length} (threshold: ≥${PASS_THRESHOLD})\n` +
      `smoke run hash: ${hash}\n`;
    deps.stdout(summary);
  }

  const runId = deps.generateRunId();
  const traceFilename = `${TRACES_DIR}/smoke-${runId}.txt`;
  const traceBody =
    `run_id: ${runId}\n` +
    `compile_api_url: ${DEFAULT_COMPILE_API_URL}\n` +
    `ok_rows: ${okCount}/${rows.length}\n` +
    `hash: ${hash}\n\n` +
    `${tableText}\n\n` +
    `${rows
      .map((r) => `prompt ${r.prompt_index} (${r.prompt_file}): ${JSON.stringify(r.outcome)}`)
      .join("\n")}\n`;

  // Trace-write failure should NOT crash the run — the smoke result is
  // already in `rows`/`hash` and the JSON/table payload is on stdout.
  // Log the failure on stderr and continue to the TRACE_PATH marker.
  try {
    await deps.writeTraceFile(traceFilename, traceBody);
    // Single deterministic line for agents: stable prefix + path.
    deps.stderr(`TRACE_PATH=${traceFilename}\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.stderr(
      `[smoke] WARN: trace write to ${traceFilename} failed: ${msg}\n`,
    );
  }

  return { exitCode, rows, hash };
}

// ---------------------------------------------------------------------------
// Production deps factory
// ---------------------------------------------------------------------------

/**
 * Production wiring. Reads from real files, calls real pre-flight
 * checks, calls the real LLM and gate functions. Test code constructs
 * deps inline instead.
 */
export function defaultSmokeDeps(flags?: SmokeFlags): SmokeDeps {
  return {
    readPromptFile: async (filename: string): Promise<string> => {
      const path = pathResolve(SMOKE_PROMPTS_DIR, filename);
      return Bun.file(path).text();
    },
    healthCheck: () => preflightHealthCheck(DEFAULT_COMPILE_API_URL),
    apiKeyCheck: () => preflightApiKeyCheck(process.env),
    pipelineDeps: {
      classify,
      generate,
      runSchemaGate,
      runCrossConsistencyGate,
      runRules,
      runCompileGate,
    },
    writeTraceFile: async (filename: string, content: string): Promise<void> => {
      await mkdir(TRACES_DIR, { recursive: true });
      await Bun.write(filename, content);
    },
    stdout: (line: string) => process.stdout.write(line),
    stderr: (line: string) => process.stderr.write(line),
    generateRunId,
    flags,
  };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const flags = parseFlags(process.argv.slice(2));
  const result = await runSmoke(defaultSmokeDeps(flags));
  process.exit(result.exitCode);
}
