#!/usr/bin/env bun
/**
 * Volteux v0.1 pipeline CLI.
 *
 *   bun run pipeline -- "<prompt>"               # default: human-readable summary
 *   bun run pipeline -- --json -- "<prompt>"     # JSON envelope to stdout
 *   bun run pipeline -- --dry-run -- "<prompt>"  # skip Anthropic + pre-flight
 *   bun run pipeline -- --repair=off -- "<prompt>"  # disable cross-gate repair
 *   bun run pipeline -- --prompt "<prompt>"      # explicit --prompt flag form
 *
 * Flags compose: `--json --dry-run --repair=off` works.
 *
 * **Stream discipline (agent-readability).** Stdout carries ONLY the
 * payload (text summary or JSON envelope). Stderr carries every progress
 * line, the trace path marker, and pre-flight error messages. The trace
 * marker is a single deterministic line `TRACE_PATH=<path>` on stderr;
 * agents grepping stderr for that prefix get a stable extraction path.
 *
 * **Pre-flight discipline.** Two pre-flight checks run BEFORE any
 * Anthropic call so a missing local dep does not burn Sonnet tokens
 * chasing a missing container:
 *
 *   1. `GET /api/health` against `COMPILE_API_URL` (default
 *      `http://localhost:8787`). Non-200, fetch-throw, or 5s timeout →
 *      `"Compile API unreachable at <url>; run 'bun run compile:up' first"`
 *      → exit 1.
 *   2. `process.env.ANTHROPIC_API_KEY` non-empty. Missing → exit 1.
 *
 * `--dry-run` skips both checks AND the per-prompt API calls; emits a
 * canonical happy-path payload so agents can test pre-flight + output
 * formatting + exit-code wiring without spending API credits.
 *
 * **Cost projection.** ~$0.05 Sonnet + ~$0.005 Haiku + $0 local compile
 * ≈ $0.055/prompt. Cross-gate repair adds ~$0.05.
 *
 * **Logger discipline.** Do not log the API key, request bodies, or
 * `process.env`. The pre-flight only checks `non-empty` for the key —
 * the actual value is never written anywhere.
 *
 * Exit codes (distinct so agents can disambiguate without parsing logs):
 *   0 — pipeline produced .hex (or dry-run completed)
 *   1 — pre-flight failed (Compile API down, missing API key);
 *       the run never started its per-prompt path
 *   2 — pipeline failed inside boundaries (out-of-scope, schema-failed,
 *       compile-failed, etc.)
 */

import { runPipeline, type PipelineResult } from "./index.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_COMPILE_API_URL =
  process.env.COMPILE_API_URL ?? "http://localhost:8787";
const HEALTH_TIMEOUT_MS = 5_000;

const EXIT_OK = 0;
const EXIT_PREFLIGHT_FAILED = 1;
const EXIT_PIPELINE_FAILED = 2;

// ---------------------------------------------------------------------------
// CLI flag parsing (tiny — argparse would be overkill for a handful of flags)
// ---------------------------------------------------------------------------

export interface CliFlags {
  json: boolean;
  dryRun: boolean;
  repairOff: boolean;
  /** The prompt text. Either via positional or --prompt. Empty if absent. */
  prompt: string;
}

/**
 * Parse argv into structured flags. The prompt can come from a positional
 * arg (the first non-flag token) OR from `--prompt <text>`. The first
 * `--` ends flag parsing per POSIX convention; everything after is
 * treated as positional even if it starts with `-`.
 */
export function parseFlags(argv: ReadonlyArray<string>): CliFlags {
  let json = false;
  let dryRun = false;
  let repairOff = false;
  let prompt = "";
  let i = 0;
  let endOfFlags = false;
  while (i < argv.length) {
    const tok = argv[i]!;
    if (!endOfFlags && tok === "--") {
      endOfFlags = true;
      i++;
      continue;
    }
    if (!endOfFlags && tok === "--json") {
      json = true;
      i++;
      continue;
    }
    if (!endOfFlags && tok === "--dry-run") {
      dryRun = true;
      i++;
      continue;
    }
    if (!endOfFlags && tok === "--repair=off") {
      repairOff = true;
      i++;
      continue;
    }
    if (!endOfFlags && tok === "--prompt") {
      const next = argv[i + 1] ?? "";
      prompt = next;
      i += 2;
      continue;
    }
    // Positional: the first non-flag token (or any token after --)
    // becomes the prompt unless --prompt already set it.
    if (prompt === "") {
      prompt = tok;
    }
    i++;
  }
  return { json, dryRun, repairOff, prompt };
}

// ---------------------------------------------------------------------------
// Pre-flight checks (copied verbatim from the soon-to-be-deleted smoke
// script; retained as inline functions per plan to avoid re-export from
// the deleted module).
// ---------------------------------------------------------------------------

export interface PreflightResult {
  ok: boolean;
  message?: string;
}

/**
 * Pre-flight ping of the Compile API's `/api/health` endpoint. Returns
 * `{ok: true}` on a 200; `{ok: false, message}` on any non-200, fetch
 * throw, or timeout. Treats degraded (503) the same as unreachable —
 * we need a fully-functional compile path to produce a .hex.
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
        "ANTHROPIC_API_KEY is not set; export it before running 'bun run pipeline'",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Output rendering (text summary vs JSON envelope)
// ---------------------------------------------------------------------------

/**
 * Render a successful or failed PipelineResult as a single text summary
 * for stdout (default mode). Uses no ANSI / no markdown — line-oriented
 * so a tail-style consumer can grep it.
 */
function renderTextSummary(result: PipelineResult): string {
  const lines: string[] = [];
  lines.push(`run_id: ${result.run_id}`);
  lines.push(`cost_usd: ${result.cost_usd.toFixed(4)}`);
  if (result.ok) {
    lines.push(`outcome: ok`);
    lines.push(`archetype_id: ${result.doc.archetype_id}`);
    lines.push(`board: ${result.doc.board.name} (${result.doc.board.fqbn})`);
    lines.push(`components: ${result.doc.components.length}`);
    lines.push(`connections: ${result.doc.connections.length}`);
    lines.push(`libraries: [${result.doc.sketch.libraries.join(", ")}]`);
    lines.push(`hex_b64: ${result.hex_b64.slice(0, 24)}... (${result.hex_b64.length} chars)`);
    if (result.amber.length > 0) {
      lines.push(`amber_warnings: ${result.amber.length}`);
    }
    if (result.blue.length > 0) {
      lines.push(`blue_notes: ${result.blue.length}`);
    }
  } else {
    lines.push(`outcome: ${result.kind}`);
    lines.push(`scope: ${result.honest_gap.scope}`);
    lines.push(`explanation: ${result.honest_gap.explanation}`);
    if (result.honest_gap.missing_capabilities.length > 0) {
      lines.push(
        `missing_capabilities: [${result.honest_gap.missing_capabilities.join(", ")}]`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Render the result as a single-line JSON envelope (`--json` mode). On
 * failure, includes the structured Honest Gap; on success, includes a
 * truncated hex_b64 (the full hex would inflate the payload by ~50KB
 * for a typical sketch).
 */
function renderJsonEnvelope(result: PipelineResult): string {
  if (result.ok) {
    return JSON.stringify({
      ok: true,
      run_id: result.run_id,
      cost_usd: result.cost_usd,
      doc: result.doc,
      hex_b64_length: result.hex_b64.length,
      hex_b64_prefix: result.hex_b64.slice(0, 24),
      amber_count: result.amber.length,
      blue_count: result.blue.length,
    });
  }
  return JSON.stringify({
    ok: false,
    kind: result.kind,
    run_id: result.run_id,
    cost_usd: result.cost_usd,
    honest_gap: result.honest_gap,
    message: result.message,
    errors: result.errors,
  });
}

// ---------------------------------------------------------------------------
// CLI runner (testable; takes deps so unit tests can mock stdio + env)
// ---------------------------------------------------------------------------

export interface CliDeps {
  /** Pre-flight ping; defaults to live fetch. Tests inject a mock. */
  healthCheck: () => Promise<PreflightResult>;
  /** Pre-flight env-var check; defaults to live process.env. */
  apiKeyCheck: () => PreflightResult;
  /**
   * Pipeline runner; defaults to the real `runPipeline` from
   * `pipeline/index.ts`. Tests inject a mock to exercise the CLI's
   * output formatting + exit-code wiring without API calls.
   */
  runPipeline: typeof runPipeline;
  /** Stdout sink. Defaults to `process.stdout.write` in production. */
  stdout: (line: string) => void;
  /** Stderr sink. Defaults to `process.stderr.write` in production. */
  stderr: (line: string) => void;
}

/**
 * Construct a canonical happy-path PipelineResult for `--dry-run` mode.
 * Lets agents (and humans) test the CLI's output formatting + exit-code
 * wiring without burning API credits or requiring a running Compile API.
 */
function dryRunResult(): PipelineResult {
  return {
    ok: true,
    doc: {
      archetype_id: "uno-ultrasonic-servo",
      board: {
        sku: "50",
        name: "Arduino Uno R3 (dry-run)",
        type: "uno",
        fqbn: "arduino:avr:uno",
      },
      components: [{ id: "u1", sku: "50", quantity: 1 }],
      connections: [
        {
          from: { component_id: "u1", pin_label: "5V" },
          to: { component_id: "u1", pin_label: "GND" },
          purpose: "dry-run placeholder connection",
        },
      ],
      breadboard_layout: {
        components: [{ component_id: "u1", anchor_hole: "a1", rotation: 0 }],
      },
      sketch: { main_ino: "void setup(){}\nvoid loop(){}\n", libraries: [] },
      external_setup: {},
    },
    hex_b64: "ZHJ5LXJ1bg==",
    cost_usd: 0,
    run_id: "dry-run",
    amber: [],
    blue: [],
  };
}

/**
 * Run the CLI with injected deps. The CLI entrypoint at the bottom of
 * the file calls this with `defaultCliDeps()`.
 *
 * Stream discipline: stdout = payload (text summary or JSON envelope).
 * Stderr = progress lines, pre-flight errors, the trailing
 * `TRACE_PATH=<path>` marker (when known).
 */
export async function runCli(
  flags: CliFlags,
  deps: CliDeps,
): Promise<number> {
  if (flags.prompt === "") {
    deps.stderr(
      "no prompt provided; use --prompt <text> or pass a positional argument\n",
    );
    return EXIT_PREFLIGHT_FAILED;
  }

  // `--dry-run` skips both pre-flight checks AND the real pipeline call.
  if (!flags.dryRun) {
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
  }

  let result: PipelineResult;
  if (flags.dryRun) {
    result = dryRunResult();
  } else {
    deps.stderr(`[pipeline] running for prompt (${flags.prompt.length} chars)\n`);
    result = await deps.runPipeline(
      flags.prompt,
      flags.repairOff ? { repair: "off" } : {},
    );
  }

  // Emit trace path marker (Unit 7's writer will land at traces/<run_id>.jsonl;
  // commit-1's NoopTraceWriter doesn't actually write a file, but the
  // marker still locates the canonical path Unit 7 will use).
  deps.stderr(`TRACE_PATH=traces/${result.run_id}.jsonl\n`);

  const payload = flags.json
    ? renderJsonEnvelope(result)
    : renderTextSummary(result);
  deps.stdout(payload + (flags.json ? "\n" : ""));

  return result.ok ? EXIT_OK : EXIT_PIPELINE_FAILED;
}

// ---------------------------------------------------------------------------
// Production deps factory
// ---------------------------------------------------------------------------

/**
 * Production wiring. Calls the real pre-flight functions, the real
 * runPipeline, and writes to real process stdio. Test code constructs
 * deps inline instead.
 */
function defaultCliDeps(): CliDeps {
  return {
    healthCheck: () => preflightHealthCheck(DEFAULT_COMPILE_API_URL),
    apiKeyCheck: () => preflightApiKeyCheck(process.env),
    runPipeline,
    stdout: (line: string) => process.stdout.write(line),
    stderr: (line: string) => process.stderr.write(line),
  };
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const flags = parseFlags(process.argv.slice(2));
  const exitCode = await runCli(flags, defaultCliDeps());
  process.exit(exitCode);
}
