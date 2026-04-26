#!/usr/bin/env bun
/**
 * Volteux v0.1 acceptance harness — Unit 8.
 *
 * CLI runner that drives the orchestrator (`runPipeline`) across the
 * 30-prompt archetype-1 calibration set and aggregates per-axis scores.
 *
 *   bun run acceptance                                 # full run (tuning + holdout)
 *   bun run acceptance -- --tuning-only                # 25 tuning prompts only
 *   bun run acceptance -- --holdout-only               # 5 holdout prompts only
 *   bun run acceptance -- --json                       # machine-readable to stdout
 *   bun run acceptance:regen                           # regenerate fixtures (tuning only)
 *
 * **3-axis scoring (v0.1).** Per the Week-7 milestone in docs/PLAN.md and
 * plan § Key Technical Decisions:
 *   - schema_validity ≥ 99% on tuning
 *   - compile_pass    ≥ 95% on tuning
 *   - rules_clean     ≥ 90% on tuning
 *   - holdout passed  ≥ 1 of 5 (passed = schema-valid AND compile-pass;
 *                                rules-clean is informational on holdout)
 *
 * **The 4th axis (Wokwi behavior-correctness) is explicitly v0.5-pending.**
 * That axis runs the compiled .hex inside `wokwi-cli` headless and asserts
 * state changes (servo position swept, distance threshold triggers
 * response, etc.). It is NOT scored here. The runner's score struct uses
 * optional fields so a v0.5 contributor can extend without re-shaping
 * existing 3-axis aggregates.
 *
 * **Holdout discipline (enforced by code, not convention).**
 *   1. Frontmatter `holdout: true` marks a sealed prompt. The runner
 *      refuses to process holdout prompts in `--tuning-only` and
 *      `--regen-fixtures` modes; encountering one is a runner-level
 *      error ("holdout discipline violation").
 *   2. SHA-256 fingerprints of every holdout file are committed at
 *      `tests/acceptance/holdout-fingerprints.json`. The runner verifies
 *      every holdout file's hash on each invocation; any mismatch
 *      (intentional edit OR accidental reformat) fails the pre-flight
 *      with exit 1 and stderr names the offending file. To legitimately
 *      refresh the holdout, the contributor regenerates fingerprints
 *      AND coordinates the change in PR review (the v0.5 calibration
 *      cycle's responsibility).
 *
 * **Per-prompt traces** land at `traces/acceptance-<run-id>/<prompt-filename-no-ext>.jsonl`,
 * one trace per prompt. The directory naming distinguishes acceptance
 * runs from CLI runs for downstream eval-harness consumption (v0.5).
 *
 * **Stream discipline (agent-readability).** Stdout carries the final
 * report (text aggregate or single-line JSON envelope). Stderr carries
 * progress, pre-flight errors, per-prompt status lines, and the
 * trailing `TRACE_DIR=<path>` marker. The API key is never logged.
 *
 * **Pre-flight checks (mirror pipeline/cli.ts).** Both run BEFORE any
 * prompt is processed:
 *   1. `GET <COMPILE_API_URL>/api/health` non-200 / fetch-throw / 5s
 *      timeout → exit 1 with "Compile API unreachable at <url>; run
 *      'bun run compile:up' first".
 *   2. `process.env.ANTHROPIC_API_KEY` non-empty → exit 1 with
 *      "ANTHROPIC_API_KEY is not set; export it before running
 *      'bun run acceptance'".
 *
 * **--regen-fixtures** writes ONLY the `doc` field of each successful
 * tuning result to `fixtures/generated/archetype-1/<prompt-filename-no-ext>.json`.
 * The `hex_b64` is intentionally NOT written (too large for fixtures;
 * Talia's UI snapshot tests don't need it). On a partial-failure run
 * (e.g., 24 of 25 tuning prompts succeed), the failed prompt's prior
 * fixture (if any) stays put; the run logs the gap to stderr and the PR
 * review surfaces it.
 *
 * **Cost watch.** A full 30-prompt run is ≈ $1.65 (≈ $0.05 Sonnet +
 * ≈ $0.005 Haiku per prompt × 30). Expect 5-10 iterations during Unit 8
 * tuning ≈ $10-15 total. Cross-gate repair adds ≈ $0.05 per failing
 * prompt. The harness does NOT cap cost — the operator decides when to
 * stop iterating.
 *
 * Exit codes:
 *   0 — gates pass (tuning thresholds + holdout ≥ 1 of 5)
 *   1 — pre-flight failed (Compile API down, missing API key, fingerprint
 *       mismatch, holdout discipline violation, malformed frontmatter)
 *   2 — gates fail (one or more axis below threshold OR holdout 0/5)
 *
 * @see docs/plans/2026-04-27-001-feat-v01-pipeline-units-6-7-8-plan.md § Unit 8
 * @see docs/solutions/best-practices/c-preprocessor-modelling-in-llm-output-gates-2026-04-25.md
 *      (calibration prompts must replicate downstream semantics)
 */

import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  buildPipeline,
  defaultPipelineDeps,
  type PipelineFailureKind,
  type PipelineResult,
} from "../../pipeline/index.ts";
import { defaultTraceWriter } from "../../pipeline/trace.ts";
import {
  VolteuxProjectDocumentSchema,
  type VolteuxArchetypeId,
  type VolteuxProjectDocument,
} from "../../schemas/document.zod.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = process.cwd();
const PROMPTS_TUNING_DIR = "tests/acceptance/prompts/archetype-1/tuning";
const PROMPTS_HOLDOUT_DIR = "tests/acceptance/prompts/archetype-1/holdout";
const FINGERPRINTS_PATH = "tests/acceptance/holdout-fingerprints.json";
const FIXTURES_OUT_DIR = "fixtures/generated/archetype-1";
const TRACES_BASE_DIR = "traces";

const DEFAULT_COMPILE_API_URL =
  process.env["COMPILE_API_URL"] ?? "http://localhost:8787";
const HEALTH_TIMEOUT_MS = 5_000;

const EXIT_OK = 0;
const EXIT_PREFLIGHT_FAILED = 1;
const EXIT_GATES_FAILED = 2;

/** Acceptance gate thresholds (per docs/PLAN.md § Week-7). */
const TUNING_GATES = Object.freeze({
  schema_validity_min: 0.99,
  compile_pass_min: 0.95,
  rules_clean_min: 0.9,
});

/** Holdout passed = schema-valid AND compile-pass. Threshold is ≥ 1 of 5. */
const HOLDOUT_PASSED_MIN = 1;

/** The 5 archetype IDs accepted in expected_archetype frontmatter. */
const VALID_ARCHETYPE_IDS = new Set<string>([
  "uno-ultrasonic-servo",
  "esp32-audio-dashboard",
  "pico-rotary-oled",
  "esp32c3-dht-aio",
  "uno-photoresistor-led",
]);

const VALID_FRONTMATTER_KEYS = new Set([
  "holdout",
  "expected_kind",
  "expected_archetype",
]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ExpectedKind = "ok" | "out-of-scope";

/**
 * Parsed prompt frontmatter. `expected_archetype` is `null` when the
 * frontmatter literal `null` or when `expected_kind: out-of-scope`.
 */
export interface PromptFrontmatter {
  holdout: boolean;
  expected_kind: ExpectedKind;
  expected_archetype: VolteuxArchetypeId | null;
}

export interface PromptFile {
  /** Filename without directory (e.g., "01-distance-servo.txt"). */
  filename: string;
  /** Full file contents as read from disk. */
  raw: string;
  /** Parsed frontmatter. */
  frontmatter: PromptFrontmatter;
  /**
   * The prompt body sent to runPipeline. HTML-style comments
   * (`<!-- ... -->` lines) and the frontmatter block are stripped; the
   * remainder is trimmed.
   */
  body: string;
  /** Whether this prompt came from the tuning or holdout directory. */
  origin: "tuning" | "holdout";
}

/**
 * Per-prompt scoring outcome. The runner aggregates across all prompts
 * to produce the final `AcceptanceReport`.
 *
 * **Optional axes for forward compatibility.** `behavior_correctness` is
 * v0.5 (Wokwi headless); the v0.1 runner leaves it `undefined` so a
 * later contributor can extend without re-shaping existing aggregates.
 */
export interface PromptScore {
  prompt_filename: string;
  expected_kind: ExpectedKind;
  expected_archetype: VolteuxArchetypeId | null;
  actual_kind: "ok" | PipelineFailureKind;
  actual_archetype: VolteuxArchetypeId | null;
  /** Schema-valid means the orchestrator passed the schema gate. */
  schema_validity: boolean;
  /** Compile-pass means the compile gate produced a .hex. */
  compile_pass: boolean;
  /** Rules-clean means runRules() returned 0 red rule violations. */
  rules_clean: boolean;
  /** True when expected_kind matches the actual outcome shape. */
  expected_match: boolean;
  cost_usd: number;
  latency_ms: number;
  trace_path: string;
  /** v0.5 — Wokwi behavior-correctness; undefined for v0.1. */
  behavior_correctness?: boolean;
}

export interface AggregateScores {
  count: number;
  schema_validity_rate: number;
  compile_pass_rate: number;
  rules_clean_rate: number;
  expected_match_rate: number;
  /**
   * For tuning: how many prompts were excluded from compile_pass
   * denominator because expected_kind was out-of-scope (those never reach
   * the compile gate even on a healthy run).
   */
  out_of_scope_excluded: number;
}

export interface HoldoutAggregate {
  count: number;
  /** passed = schema-valid AND compile-pass per the plan's holdout rule. */
  passed: number;
  expected_match_rate: number;
}

export interface AcceptanceReport {
  run_id: string;
  trace_dir: string;
  prompts: ReadonlyArray<PromptScore>;
  tuning?: AggregateScores;
  holdout?: HoldoutAggregate;
  /** True when EVERY axis on the relevant set meets threshold. */
  gates_pass: boolean;
  /** Human-readable reasons this run failed gates (empty when gates_pass=true). */
  gate_failures: ReadonlyArray<string>;
  total_cost_usd: number;
  total_latency_ms: number;
}

// ---------------------------------------------------------------------------
// CLI flag parsing (tiny — argparse would be overkill for a handful of flags)
// ---------------------------------------------------------------------------

export interface AcceptanceFlags {
  json: boolean;
  tuningOnly: boolean;
  holdoutOnly: boolean;
  regenFixtures: boolean;
  /** Internal-use: regenerate the fingerprints file from holdout/*.txt and exit. */
  regenFingerprints: boolean;
}

export function parseFlags(argv: ReadonlyArray<string>): AcceptanceFlags {
  let json = false;
  let tuningOnly = false;
  let holdoutOnly = false;
  let regenFixtures = false;
  let regenFingerprints = false;
  for (const tok of argv) {
    if (tok === "--json") json = true;
    else if (tok === "--tuning-only") tuningOnly = true;
    else if (tok === "--holdout-only") holdoutOnly = true;
    else if (tok === "--regen-fixtures") regenFixtures = true;
    else if (tok === "--regen-fingerprints") regenFingerprints = true;
  }
  return { json, tuningOnly, holdoutOnly, regenFixtures, regenFingerprints };
}

// ---------------------------------------------------------------------------
// Frontmatter parser (strict; fail-loud on malformed input)
// ---------------------------------------------------------------------------

/**
 * Error thrown by the frontmatter parser. The runner translates this
 * into a stderr line + exit 1. Carries the filename so the operator can
 * locate the offending file without grepping.
 */
export class FrontmatterError extends Error {
  constructor(
    public readonly filename: string,
    message: string,
  ) {
    super(`[${filename}] ${message}`);
    this.name = "FrontmatterError";
  }
}

/**
 * Parse the frontmatter+body shape:
 *
 *   ---
 *   holdout: false
 *   expected_kind: ok
 *   expected_archetype: uno-ultrasonic-servo
 *   ---
 *   <prompt body, may span multiple lines>
 *
 * **Strict.** Any malformed frontmatter throws. Unknown keys (typos)
 * throw. Missing required keys throw. The body is whatever follows the
 * closing `---` line, with leading/trailing whitespace stripped and
 * `<!-- ... -->` HTML-style comment lines removed (so the holdout
 * freeze-comment doesn't enter the prompt sent to the LLM).
 */
export function parsePromptFile(
  filename: string,
  raw: string,
): { frontmatter: PromptFrontmatter; body: string } {
  const lines = raw.split("\n");
  if (lines.length === 0 || lines[0]?.trim() !== "---") {
    throw new FrontmatterError(
      filename,
      "missing opening '---' frontmatter delimiter",
    );
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    throw new FrontmatterError(
      filename,
      "missing closing '---' frontmatter delimiter",
    );
  }
  const fmLines = lines.slice(1, endIdx);
  const fm: Record<string, string> = {};
  for (const line of fmLines) {
    if (line.trim() === "") continue;
    const sepIdx = line.indexOf(":");
    if (sepIdx === -1) {
      throw new FrontmatterError(
        filename,
        `frontmatter line has no ':' separator: ${JSON.stringify(line)}`,
      );
    }
    const key = line.slice(0, sepIdx).trim();
    const value = line.slice(sepIdx + 1).trim();
    if (!VALID_FRONTMATTER_KEYS.has(key)) {
      throw new FrontmatterError(
        filename,
        `unknown frontmatter key '${key}'; valid keys are ${[...VALID_FRONTMATTER_KEYS].join(", ")}`,
      );
    }
    fm[key] = value;
  }

  // Required keys
  for (const required of ["holdout", "expected_kind", "expected_archetype"]) {
    if (!(required in fm)) {
      throw new FrontmatterError(
        filename,
        `missing required frontmatter key '${required}'`,
      );
    }
  }

  // Parse holdout (boolean)
  const holdoutRaw = fm["holdout"]!;
  let holdout: boolean;
  if (holdoutRaw === "true") holdout = true;
  else if (holdoutRaw === "false") holdout = false;
  else {
    throw new FrontmatterError(
      filename,
      `'holdout' must be 'true' or 'false', got ${JSON.stringify(holdoutRaw)}`,
    );
  }

  // Parse expected_kind
  const kindRaw = fm["expected_kind"]!;
  if (kindRaw !== "ok" && kindRaw !== "out-of-scope") {
    throw new FrontmatterError(
      filename,
      `'expected_kind' must be 'ok' or 'out-of-scope', got ${JSON.stringify(kindRaw)}`,
    );
  }
  const expected_kind: ExpectedKind = kindRaw;

  // Parse expected_archetype
  const archRaw = fm["expected_archetype"]!;
  let expected_archetype: VolteuxArchetypeId | null;
  if (archRaw === "null") {
    expected_archetype = null;
  } else if (VALID_ARCHETYPE_IDS.has(archRaw)) {
    expected_archetype = archRaw as VolteuxArchetypeId;
  } else {
    throw new FrontmatterError(
      filename,
      `'expected_archetype' must be 'null' or a valid archetype id; got ${JSON.stringify(archRaw)}`,
    );
  }

  // Cross-validation: out-of-scope expects null archetype; ok expects non-null.
  if (expected_kind === "out-of-scope" && expected_archetype !== null) {
    throw new FrontmatterError(
      filename,
      `'expected_kind: out-of-scope' requires 'expected_archetype: null'`,
    );
  }
  if (expected_kind === "ok" && expected_archetype === null) {
    throw new FrontmatterError(
      filename,
      `'expected_kind: ok' requires a non-null 'expected_archetype'`,
    );
  }

  // Body: everything after the closing ---, with HTML comment lines
  // stripped (so the holdout freeze-comment doesn't bleed into the
  // prompt sent to the LLM).
  const bodyLines = lines.slice(endIdx + 1);
  const cleanedBody = bodyLines
    .filter((line) => !line.trim().startsWith("<!--"))
    .join("\n")
    .trim();

  if (cleanedBody.length === 0) {
    throw new FrontmatterError(filename, "prompt body is empty after frontmatter");
  }

  return {
    frontmatter: { holdout, expected_kind, expected_archetype },
    body: cleanedBody,
  };
}

// ---------------------------------------------------------------------------
// Pre-flight checks (mirror pipeline/cli.ts)
// ---------------------------------------------------------------------------

export interface PreflightResult {
  ok: boolean;
  message?: string;
}

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

export function preflightApiKeyCheck(
  env: NodeJS.ProcessEnv,
): PreflightResult {
  const key = env["ANTHROPIC_API_KEY"];
  if (key === undefined || key === "") {
    return {
      ok: false,
      message:
        "ANTHROPIC_API_KEY is not set; export it before running 'bun run acceptance'",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Holdout fingerprint check
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 (hex) of the file's full bytes. Used both for the
 * one-off fingerprint regeneration and the per-run check.
 */
export function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export interface FingerprintCheckResult {
  ok: boolean;
  /** Filenames whose computed hash didn't match the committed value. */
  mismatched: ReadonlyArray<string>;
  /** Filenames present on disk but missing from the fingerprint file. */
  missing_from_file: ReadonlyArray<string>;
  /** Filenames listed in the fingerprint file but absent on disk. */
  missing_from_disk: ReadonlyArray<string>;
}

/**
 * Verify every holdout file's SHA-256 matches the committed fingerprint.
 * Pure: takes the on-disk file map + the expected fingerprint map; returns
 * a structured result the caller turns into stderr + exit code.
 */
export function checkFingerprints(
  holdoutFiles: ReadonlyMap<string, string>,
  expected: Readonly<Record<string, string>>,
): FingerprintCheckResult {
  const mismatched: string[] = [];
  const missing_from_file: string[] = [];
  const missing_from_disk: string[] = [];

  for (const [filename, content] of holdoutFiles) {
    const expectedHash = expected[filename];
    if (expectedHash === undefined) {
      missing_from_file.push(filename);
      continue;
    }
    const actualHash = sha256Hex(content);
    if (actualHash !== expectedHash) {
      mismatched.push(filename);
    }
  }
  for (const filename of Object.keys(expected)) {
    if (!holdoutFiles.has(filename)) {
      missing_from_disk.push(filename);
    }
  }
  return {
    ok:
      mismatched.length === 0 &&
      missing_from_file.length === 0 &&
      missing_from_disk.length === 0,
    mismatched,
    missing_from_file,
    missing_from_disk,
  };
}

// ---------------------------------------------------------------------------
// Per-prompt scoring + aggregation
// ---------------------------------------------------------------------------

/**
 * Convert a `PipelineResult` into the per-axis score for the runner.
 * The 3 axes are derived from the orchestrator's failure shape:
 *   - schema_validity: result.ok OR (result.kind !== "schema-failed")
 *     — a schema-failed result means the schema gate rejected the doc.
 *   - compile_pass:    result.ok — only success carries a .hex.
 *   - rules_clean:     result.ok OR (result.kind !== "rules-red") — a
 *     rules-red result means the rules engine emitted ≥1 red attempt.
 *
 * Out-of-scope expected: the prompt is excluded from compile_pass
 * denominator (it never reaches the compile gate by design). The
 * `expected_match` field captures whether actual matches expected.
 */
export function scorePrompt(
  prompt: PromptFile,
  result: PipelineResult,
  trace_path: string,
): PromptScore {
  const actual_kind: "ok" | PipelineFailureKind = result.ok ? "ok" : result.kind;
  const actual_archetype: VolteuxArchetypeId | null = result.ok
    ? result.doc.archetype_id
    : null;

  // Schema validity: failed iff kind === "schema-failed".
  const schema_validity = result.ok || result.kind !== "schema-failed";

  // Compile pass: only success carries a .hex.
  const compile_pass = result.ok === true;

  // Rules clean: failed iff kind === "rules-red".
  const rules_clean = result.ok || result.kind !== "rules-red";

  // expected_match: ok-vs-ok or out-of-scope-vs-out-of-scope.
  let expected_match: boolean;
  if (prompt.frontmatter.expected_kind === "ok") {
    expected_match =
      result.ok &&
      result.doc.archetype_id === prompt.frontmatter.expected_archetype;
  } else {
    // expected_kind === "out-of-scope"
    expected_match = !result.ok && result.kind === "out-of-scope";
  }

  return {
    prompt_filename: prompt.filename,
    expected_kind: prompt.frontmatter.expected_kind,
    expected_archetype: prompt.frontmatter.expected_archetype,
    actual_kind,
    actual_archetype,
    schema_validity,
    compile_pass,
    rules_clean,
    expected_match,
    cost_usd: result.cost_usd,
    latency_ms: 0, // populated by caller (orchestrator latency lives in the trace)
    trace_path,
  };
}

/**
 * Aggregate per-prompt scores into tuning-set rates. Out-of-scope
 * expected prompts are EXCLUDED from the compile_pass denominator (they
 * never reach the compile gate even on a healthy run). All other
 * denominators are the full set.
 */
export function aggregateTuning(
  scores: ReadonlyArray<PromptScore>,
): AggregateScores {
  const count = scores.length;
  if (count === 0) {
    return {
      count: 0,
      schema_validity_rate: 1,
      compile_pass_rate: 1,
      rules_clean_rate: 1,
      expected_match_rate: 1,
      out_of_scope_excluded: 0,
    };
  }
  const inScope = scores.filter((s) => s.expected_kind === "ok");
  const outOfScopeExcluded = count - inScope.length;
  const schemaValid = scores.filter((s) => s.schema_validity).length;
  const rulesClean = scores.filter((s) => s.rules_clean).length;
  const expectedMatch = scores.filter((s) => s.expected_match).length;
  // Compile-pass denominator excludes out-of-scope prompts.
  const compilePass = inScope.filter((s) => s.compile_pass).length;
  return {
    count,
    schema_validity_rate: schemaValid / count,
    compile_pass_rate: inScope.length === 0 ? 1 : compilePass / inScope.length,
    rules_clean_rate: rulesClean / count,
    expected_match_rate: expectedMatch / count,
    out_of_scope_excluded: outOfScopeExcluded,
  };
}

/**
 * Aggregate per-prompt scores into the holdout-set summary. holdout
 * "passed" = schema-valid AND compile-pass (per plan § Key Technical
 * Decisions). For out-of-scope-expected holdout prompts, "passed" reduces
 * to schema_validity (since they never reach compile by design); a
 * matched out-of-scope routing counts as a holdout pass.
 */
export function aggregateHoldout(
  scores: ReadonlyArray<PromptScore>,
): HoldoutAggregate {
  const count = scores.length;
  if (count === 0) {
    return { count: 0, passed: 0, expected_match_rate: 1 };
  }
  const passed = scores.filter((s) => {
    if (s.expected_kind === "out-of-scope") {
      return s.expected_match;
    }
    return s.schema_validity && s.compile_pass;
  }).length;
  const expectedMatch = scores.filter((s) => s.expected_match).length;
  return {
    count,
    passed,
    expected_match_rate: expectedMatch / count,
  };
}

/**
 * Apply the gate logic from plan § Key Technical Decisions:
 *   tuning: schema_validity_rate >= 0.99 AND compile_pass_rate >= 0.95
 *           AND rules_clean_rate >= 0.90
 *   holdout: passed >= 1 of 5
 * Returns a list of human-readable reasons (empty when both pass).
 */
export function evaluateGates(
  tuning: AggregateScores | undefined,
  holdout: HoldoutAggregate | undefined,
): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (tuning !== undefined && tuning.count > 0) {
    if (tuning.schema_validity_rate < TUNING_GATES.schema_validity_min) {
      reasons.push(
        `schema_validity_rate ${(tuning.schema_validity_rate * 100).toFixed(1)}% < ${(TUNING_GATES.schema_validity_min * 100).toFixed(0)}% on tuning`,
      );
    }
    if (tuning.compile_pass_rate < TUNING_GATES.compile_pass_min) {
      reasons.push(
        `compile_pass_rate ${(tuning.compile_pass_rate * 100).toFixed(1)}% < ${(TUNING_GATES.compile_pass_min * 100).toFixed(0)}% on tuning`,
      );
    }
    if (tuning.rules_clean_rate < TUNING_GATES.rules_clean_min) {
      reasons.push(
        `rules_clean_rate ${(tuning.rules_clean_rate * 100).toFixed(1)}% < ${(TUNING_GATES.rules_clean_min * 100).toFixed(0)}% on tuning`,
      );
    }
  }
  if (holdout !== undefined && holdout.count > 0) {
    if (holdout.passed < HOLDOUT_PASSED_MIN) {
      reasons.push(
        `holdout ${holdout.passed}/${holdout.count} — gate requires ≥${HOLDOUT_PASSED_MIN}`,
      );
    }
  }
  return { pass: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Default deps factory + production wiring
// ---------------------------------------------------------------------------

/**
 * The runner's deps. Production wiring uses live filesystem + the real
 * `runPipeline`; tests inject mocks. Mirrors the DI shape from
 * `pipeline/cli.ts`'s `CliDeps`.
 */
export interface AcceptanceDeps {
  /** Pre-flight health check. */
  healthCheck: () => Promise<PreflightResult>;
  /** Pre-flight API-key check. */
  apiKeyCheck: () => PreflightResult;
  /** Read all prompt files for a given origin (tuning|holdout). */
  readPromptDir: (origin: "tuning" | "holdout") => Promise<PromptFile[]>;
  /** Read the committed fingerprint map. */
  readFingerprints: () => Promise<Record<string, string>>;
  /** Read the holdout files raw (for fingerprint check; keyed by filename). */
  readHoldoutRaw: () => Promise<Map<string, string>>;
  /**
   * Run the pipeline against a single prompt, returning the result + the
   * trace path the writer emitted to. The runner is responsible for
   * passing per-prompt trace dirs (production wiring constructs a fresh
   * trace writer per call).
   */
  runPromptPipeline: (
    prompt: PromptFile,
    trace_dir: string,
  ) => Promise<{ result: PipelineResult; trace_path: string }>;
  /** Write a fixture JSON for a successful tuning prompt. */
  writeFixture: (filename: string, doc: VolteuxProjectDocument) => Promise<void>;
  /** Stdout sink. */
  stdout: (line: string) => void;
  /** Stderr sink. */
  stderr: (line: string) => void;
  /** Run-id generator. */
  generateRunId: () => string;
}

/**
 * Read every `.txt` file in a prompts directory and parse its
 * frontmatter. Sorted by filename for deterministic iteration.
 */
async function defaultReadPromptDir(
  origin: "tuning" | "holdout",
): Promise<PromptFile[]> {
  const dir =
    origin === "tuning" ? PROMPTS_TUNING_DIR : PROMPTS_HOLDOUT_DIR;
  const entries = await readdir(join(REPO_ROOT, dir));
  const txtFiles = entries.filter((f) => f.endsWith(".txt")).sort();
  const out: PromptFile[] = [];
  for (const filename of txtFiles) {
    const path = join(REPO_ROOT, dir, filename);
    const raw = await readFile(path, "utf8");
    const { frontmatter, body } = parsePromptFile(filename, raw);
    out.push({ filename, raw, frontmatter, body, origin });
  }
  return out;
}

async function defaultReadFingerprints(): Promise<Record<string, string>> {
  const path = join(REPO_ROOT, FINGERPRINTS_PATH);
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as Record<string, string>;
}

async function defaultReadHoldoutRaw(): Promise<Map<string, string>> {
  const dir = join(REPO_ROOT, PROMPTS_HOLDOUT_DIR);
  const entries = await readdir(dir);
  const map = new Map<string, string>();
  for (const filename of entries) {
    if (!filename.endsWith(".txt")) continue;
    const raw = await readFile(join(dir, filename), "utf8");
    map.set(filename, raw);
  }
  return map;
}

/**
 * Production wiring for `runPromptPipeline`. Constructs a fresh trace
 * writer per prompt that writes to `trace_dir/<prompt-filename-no-ext>.jsonl`,
 * then assembles `PipelineDeps` swapping in that writer over the
 * default deps.
 */
async function defaultRunPromptPipeline(
  prompt: PromptFile,
  trace_dir: string,
): Promise<{ result: PipelineResult; trace_path: string }> {
  const filenameNoExt = prompt.filename.replace(/\.txt$/, "");
  const writer = defaultTraceWriter({ dir: trace_dir });
  // Build deps from defaults + override the trace writer + run id.
  const baseDeps = await defaultPipelineDeps();
  const deps = {
    ...baseDeps,
    traceWriter: writer,
    // Force the run_id so the writer's path matches `<filename-no-ext>.jsonl`.
    generateRunId: () => filenameNoExt,
  };
  const inner = buildPipeline(deps);
  const result = await inner(prompt.body);
  return { result, trace_path: join(trace_dir, `${filenameNoExt}.jsonl`) };
}

async function defaultWriteFixture(
  filename: string,
  doc: VolteuxProjectDocument,
): Promise<void> {
  const filenameNoExt = filename.replace(/\.txt$/, "");
  const outPath = join(REPO_ROOT, FIXTURES_OUT_DIR, `${filenameNoExt}.json`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(doc, null, 2) + "\n", "utf8");
}

function defaultGenerateRunId(): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const suffix = randomUUID().slice(0, 8);
  return `${ts}-${suffix}`;
}

function defaultDeps(): AcceptanceDeps {
  return {
    healthCheck: () => preflightHealthCheck(DEFAULT_COMPILE_API_URL),
    apiKeyCheck: () => preflightApiKeyCheck(process.env),
    readPromptDir: defaultReadPromptDir,
    readFingerprints: defaultReadFingerprints,
    readHoldoutRaw: defaultReadHoldoutRaw,
    runPromptPipeline: defaultRunPromptPipeline,
    writeFixture: defaultWriteFixture,
    stdout: (line: string) => process.stdout.write(line),
    stderr: (line: string) => process.stderr.write(line),
    generateRunId: defaultGenerateRunId,
  };
}

// ---------------------------------------------------------------------------
// Output rendering
// ---------------------------------------------------------------------------

function renderTextReport(report: AcceptanceReport): string {
  const lines: string[] = [];
  lines.push(`run_id: ${report.run_id}`);
  lines.push(`trace_dir: ${report.trace_dir}`);
  lines.push(`prompts_processed: ${report.prompts.length}`);
  lines.push(`total_cost_usd: ${report.total_cost_usd.toFixed(4)}`);
  lines.push(`total_latency_ms: ${report.total_latency_ms}`);
  if (report.tuning !== undefined) {
    const t = report.tuning;
    lines.push(
      `tuning: count=${t.count} schema=${(t.schema_validity_rate * 100).toFixed(1)}% compile=${(t.compile_pass_rate * 100).toFixed(1)}% rules=${(t.rules_clean_rate * 100).toFixed(1)}% expected_match=${(t.expected_match_rate * 100).toFixed(1)}% (oos_excluded=${t.out_of_scope_excluded})`,
    );
  }
  if (report.holdout !== undefined) {
    const h = report.holdout;
    lines.push(
      `holdout: count=${h.count} passed=${h.passed} expected_match=${(h.expected_match_rate * 100).toFixed(1)}%`,
    );
  }
  lines.push(`gates_pass: ${report.gates_pass ? "yes" : "no"}`);
  for (const reason of report.gate_failures) {
    lines.push(`  - ${reason}`);
  }
  return lines.join("\n") + "\n";
}

function renderJsonReport(report: AcceptanceReport): string {
  return JSON.stringify(report);
}

// ---------------------------------------------------------------------------
// Main runner (testable; takes deps so unit tests can mock everything)
// ---------------------------------------------------------------------------

/**
 * The runner's main entry point. Returns the exit code.
 *
 * Sequence:
 *   1. (Optional) regen-fingerprints early-exit branch.
 *   2. Pre-flight health + API-key checks (unless --regen-fingerprints).
 *   3. Holdout fingerprint verification.
 *   4. Iterate tuning prompts (if not --holdout-only) sequentially.
 *      Each prompt: parse already done; run pipeline; score; trace.
 *      Holdout-print refusal in --tuning-only and --regen-fixtures
 *      modes (defense-in-depth: directory selection already excludes
 *      holdout, but a stray holdout-frontmatter file in the tuning
 *      directory must still error).
 *   5. Iterate holdout prompts (if not --tuning-only).
 *   6. Aggregate + evaluate gates + render report.
 */
export async function runAcceptance(
  flags: AcceptanceFlags,
  deps: AcceptanceDeps,
): Promise<number> {
  // ---- Regenerate fingerprints (operator-only utility) ----
  if (flags.regenFingerprints) {
    const holdoutRaw = await deps.readHoldoutRaw();
    const fp: Record<string, string> = {};
    const sortedKeys = [...holdoutRaw.keys()].sort();
    for (const filename of sortedKeys) {
      fp[filename] = sha256Hex(holdoutRaw.get(filename)!);
    }
    deps.stdout(JSON.stringify(fp, null, 2) + "\n");
    deps.stderr(
      `wrote ${Object.keys(fp).length} holdout fingerprints to stdout — copy into ${FINGERPRINTS_PATH} and review the diff carefully\n`,
    );
    return EXIT_OK;
  }

  // ---- Pre-flight checks ----
  const health = await deps.healthCheck();
  if (!health.ok) {
    deps.stderr(`${health.message ?? "Compile API unreachable"}\n`);
    return EXIT_PREFLIGHT_FAILED;
  }
  const keyCheck = deps.apiKeyCheck();
  if (!keyCheck.ok) {
    deps.stderr(`${keyCheck.message ?? "ANTHROPIC_API_KEY missing"}\n`);
    return EXIT_PREFLIGHT_FAILED;
  }

  // ---- Holdout fingerprint verification ----
  let expectedFingerprints: Record<string, string>;
  let holdoutRaw: Map<string, string>;
  try {
    expectedFingerprints = await deps.readFingerprints();
    holdoutRaw = await deps.readHoldoutRaw();
  } catch (err) {
    deps.stderr(
      `failed to read holdout fingerprints or files: ${(err as Error).message}\n`,
    );
    return EXIT_PREFLIGHT_FAILED;
  }
  const fpResult = checkFingerprints(holdoutRaw, expectedFingerprints);
  if (!fpResult.ok) {
    if (fpResult.mismatched.length > 0) {
      deps.stderr(
        `holdout fingerprint mismatch: ${fpResult.mismatched.join(", ")} — editing a holdout file without regenerating fingerprints breaks discipline. To refresh, run 'bun tests/acceptance/run.ts --regen-fingerprints' and review the diff explicitly.\n`,
      );
    }
    if (fpResult.missing_from_file.length > 0) {
      deps.stderr(
        `holdout files present on disk but missing from fingerprint file: ${fpResult.missing_from_file.join(", ")}\n`,
      );
    }
    if (fpResult.missing_from_disk.length > 0) {
      deps.stderr(
        `holdout files listed in fingerprint file but absent on disk: ${fpResult.missing_from_disk.join(", ")}\n`,
      );
    }
    return EXIT_PREFLIGHT_FAILED;
  }

  const run_id = deps.generateRunId();
  const trace_dir = join(TRACES_BASE_DIR, `acceptance-${run_id}`);
  deps.stderr(`TRACE_DIR=${trace_dir}\n`);

  // ---- Read prompts (errors here are fail-loud — malformed frontmatter = exit 1) ----
  let tuningPrompts: PromptFile[] = [];
  let holdoutPrompts: PromptFile[] = [];
  try {
    if (!flags.holdoutOnly) {
      tuningPrompts = await deps.readPromptDir("tuning");
    }
    if (!flags.tuningOnly && !flags.regenFixtures) {
      holdoutPrompts = await deps.readPromptDir("holdout");
    }
  } catch (err) {
    if (err instanceof FrontmatterError) {
      deps.stderr(`${err.message}\n`);
      return EXIT_PREFLIGHT_FAILED;
    }
    throw err;
  }

  // ---- Holdout-print refusal: defense in depth ----
  // The directory partition (tuning/ vs holdout/) is the primary
  // discipline; this check fires only if a holdout-frontmatter file
  // somehow ended up in the tuning directory (e.g., a bad copy).
  if (flags.tuningOnly || flags.regenFixtures) {
    for (const p of tuningPrompts) {
      if (p.frontmatter.holdout) {
        deps.stderr(
          `holdout discipline violation: encountered holdout=true prompt in tuning-only run (file: ${p.filename})\n`,
        );
        return EXIT_PREFLIGHT_FAILED;
      }
    }
    // In regen-fixtures mode we additionally refuse to even READ the
    // holdout directory; verify nothing snuck in via the holdout list.
    for (const p of holdoutPrompts) {
      if (p.frontmatter.holdout) {
        deps.stderr(
          `holdout discipline violation: encountered holdout=true prompt during a tuning-only run (file: ${p.filename})\n`,
        );
        return EXIT_PREFLIGHT_FAILED;
      }
    }
  }

  // ---- Iterate prompts sequentially ----
  const tuningScores: PromptScore[] = [];
  const holdoutScores: PromptScore[] = [];
  let totalCost = 0;
  let totalLatency = 0;

  const allPrompts: PromptFile[] = [...tuningPrompts, ...holdoutPrompts];
  for (const prompt of allPrompts) {
    const startedAt = Date.now();
    let result: PipelineResult;
    let trace_path: string;
    try {
      const out = await deps.runPromptPipeline(prompt, trace_dir);
      result = out.result;
      trace_path = out.trace_path;
    } catch (err) {
      // The runner's contract says runPromptPipeline returns a
      // PipelineResult on every gate-failure path; bare throws come from
      // input-validation (empty/oversize prompt) or infrastructure
      // disasters. Surface the throw with the prompt filename so the
      // operator can fix the input.
      deps.stderr(
        `[${prompt.filename}] runPipeline threw: ${(err as Error).message}\n`,
      );
      return EXIT_PREFLIGHT_FAILED;
    }
    const latency = Date.now() - startedAt;
    const score = scorePrompt(prompt, result, trace_path);
    score.latency_ms = latency;
    totalCost += score.cost_usd;
    totalLatency += latency;

    deps.stderr(
      `[${prompt.origin}] ${prompt.filename} → ${score.actual_kind} (schema=${score.schema_validity ? "ok" : "FAIL"}, compile=${score.compile_pass ? "ok" : "FAIL"}, rules=${score.rules_clean ? "ok" : "FAIL"}, match=${score.expected_match ? "ok" : "MISS"}, ${latency}ms, $${score.cost_usd.toFixed(4)})\n`,
    );

    // In-scope expected, out-of-scope actual = possible classifier regression.
    if (
      prompt.frontmatter.expected_kind === "ok" &&
      !result.ok &&
      result.kind === "out-of-scope"
    ) {
      deps.stderr(
        `[${prompt.filename}] WARN: classifier rejected an in-scope prompt — possible regression\n`,
      );
    }
    // Out-of-scope expected, in-scope actual = NEVER auto-passes the gate.
    if (
      prompt.frontmatter.expected_kind === "out-of-scope" &&
      result.ok
    ) {
      deps.stderr(
        `[${prompt.filename}] WARN: pipeline accepted an out-of-scope prompt — expected_match=false counted as gate violation\n`,
      );
    }

    if (prompt.origin === "tuning") {
      tuningScores.push(score);
    } else {
      holdoutScores.push(score);
    }

    // ---- Fixture regen on success ----
    if (
      flags.regenFixtures &&
      prompt.origin === "tuning" &&
      result.ok
    ) {
      try {
        await deps.writeFixture(prompt.filename, result.doc);
      } catch (err) {
        deps.stderr(
          `[${prompt.filename}] WARN: failed to write fixture: ${(err as Error).message}\n`,
        );
      }
    } else if (
      flags.regenFixtures &&
      prompt.origin === "tuning" &&
      !result.ok
    ) {
      deps.stderr(
        `[${prompt.filename}] WARN: pipeline failed (kind=${result.kind}); prior fixture (if any) left untouched\n`,
      );
    }
  }

  // ---- Aggregate + evaluate gates ----
  const tuning =
    tuningScores.length > 0 ? aggregateTuning(tuningScores) : undefined;
  const holdout =
    holdoutScores.length > 0 ? aggregateHoldout(holdoutScores) : undefined;
  const gateEval = evaluateGates(tuning, holdout);

  const report: AcceptanceReport = {
    run_id,
    trace_dir,
    prompts: [...tuningScores, ...holdoutScores],
    tuning,
    holdout,
    gates_pass: gateEval.pass,
    gate_failures: gateEval.reasons,
    total_cost_usd: totalCost,
    total_latency_ms: totalLatency,
  };

  const payload = flags.json
    ? renderJsonReport(report) + "\n"
    : renderTextReport(report);
  deps.stdout(payload);

  return gateEval.pass ? EXIT_OK : EXIT_GATES_FAILED;
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
  // The script lives at tests/acceptance/run.ts and is invoked from the
  // repo root via `bun tests/acceptance/run.ts`. Bun preserves cwd, so
  // REPO_ROOT === process.cwd() in production. The tests inject an
  // absolute deps shape so cwd doesn't matter.
  const flags = parseFlags(process.argv.slice(2));
  const exitCode = await runAcceptance(flags, defaultDeps());
  process.exit(exitCode);
}

// ---------------------------------------------------------------------------
// __testing namespace (introspection-only; production code MUST NOT import)
// ---------------------------------------------------------------------------

export const __testing = {
  TUNING_GATES,
  HOLDOUT_PASSED_MIN,
  PROMPTS_TUNING_DIR,
  PROMPTS_HOLDOUT_DIR,
  FINGERPRINTS_PATH,
  FIXTURES_OUT_DIR,
  TRACES_BASE_DIR,
  EXIT_OK,
  EXIT_PREFLIGHT_FAILED,
  EXIT_GATES_FAILED,
  /** Re-export schema for fixture-shape assertions in tests. */
  VolteuxProjectDocumentSchema,
};
