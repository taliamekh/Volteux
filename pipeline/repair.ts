/**
 * Cross-gate repair helper — Unit 6.
 *
 *   repair(failure, prior_doc, prompt, gen) → Promise<GenerateResult>
 *
 * When the orchestrator's gate sequence (xconsist / rules / compile)
 * fails on attempt 0, it calls `repair()` to produce a corrected
 * document via a fresh `generate()` turn. This helper composes the
 * repair user turn carrying the failing-gate's structured errors and
 * dispatches it through the injected `gen` function (so tests can
 * inject mocks without importing `pipeline/llm/generate.ts` here).
 *
 * **Bound enforcement lives in the orchestrator, not here.** The
 * orchestrator's per-run state (`repair_count`) prevents this helper
 * from being called more than once per `runPipeline` invocation. This
 * helper is composition: it never tracks state itself.
 *
 * **The gen function signature mirrors `generate()`'s public API.**
 * Tests inject a mock `gen` to simulate repair-success / repair-failure
 * paths without spinning up a real Sonnet call. Production callers (the
 * orchestrator) inject `deps.generate` from `PipelineDeps`.
 *
 * **Repair-prompt construction replicates the schema/registry primer
 * that `generate()` uses, never a divergent description.** Per the
 * c-preprocessor compound learning: the repair turn rides on top of the
 * existing cached system blocks (system prompt + schema/registry
 * primer); we never re-describe the schema or invent a parallel one. The
 * `pipeline/prompts/repair-archetype-1.md` template carries gate-specific
 * stems that the runtime fills with structured error data.
 *
 * @see docs/solutions/best-practices/c-preprocessor-modelling-in-llm-output-gates-2026-04-25.md
 */

import { readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import type { GenerateResult } from "./llm/generate.ts";
import type { VolteuxProjectDocument } from "../schemas/document.zod.ts";
import type { PipelineFailureKind } from "./index.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPAIR_PROMPT_PATH = "pipeline/prompts/repair-archetype-1.md";

/**
 * The 3 gate-specific stems we slice out of the repair-prompt template.
 * `schema` is reserved (generate() handles schema repair internally);
 * the orchestrator never calls repair() with `kind: "schema-failed"`.
 */
type RepairableKind = "xconsist-failed" | "rules-red" | "compile-failed";

/**
 * The repair-failure subset of `PipelineFailureKind`. The orchestrator
 * narrows to this subset before calling `repair()`.
 */
export interface RepairableFailure {
  kind: PipelineFailureKind;
  message: string;
  errors: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Lazy template load (synchronous; the template is small + co-located)
// ---------------------------------------------------------------------------

/**
 * The full repair-prompt template content. Loaded once per process
 * (lazily on first `repair()` call) using `readFileSync` since the
 * template ships co-located with the codebase and is small (~2KB).
 *
 * `readFileSync` is appropriate here because:
 *   - The template is a build-time artifact, not a per-call input.
 *   - First-call latency is paid once per process, then cached.
 *   - There is no env-dep on file presence — the file ships with the
 *     repo; absence is a build-time error, not a runtime path.
 */
let cachedTemplate: string | null = null;

function loadTemplate(): string {
  if (cachedTemplate !== null) return cachedTemplate;
  const path = pathResolve(REPAIR_PROMPT_PATH);
  cachedTemplate = readFileSync(path, "utf8");
  return cachedTemplate;
}

/**
 * Test-only escape hatch. Production code MUST NOT import from here.
 * Lets `tests/repair.test.ts` evict the cached template between runs
 * if a test mutates the file (none currently do; included for symmetry
 * with the rest of the codebase's __testing namespace pattern).
 */
export const __testing = {
  resetTemplateCache(): void {
    cachedTemplate = null;
  },
};

// ---------------------------------------------------------------------------
// Stem extraction (the template uses `## Stem: <name>` headers)
// ---------------------------------------------------------------------------

function extractStem(template: string, stemName: string): string {
  // Split-based extraction (more robust than regex-with-lookahead, which
  // mishandles end-of-string when the requested stem is the LAST one
  // in the template). Each section starts with `## Stem: <name>` and
  // runs through to the next `## Stem:` header or EOF.
  const sections = template.split(/^## Stem:\s*/m);
  // sections[0] is the preamble before any stem header. The remaining
  // sections each start with `<name>\n<body>`.
  for (let i = 1; i < sections.length; i++) {
    const section = sections[i]!;
    const newlineIdx = section.indexOf("\n");
    if (newlineIdx < 0) continue;
    const headerName = section.slice(0, newlineIdx).trim();
    if (headerName === stemName) {
      return section.slice(newlineIdx + 1).trim();
    }
  }
  throw new Error(
    `repair template missing stem "${stemName}" (path: ${REPAIR_PROMPT_PATH})`,
  );
}

// ---------------------------------------------------------------------------
// Per-failure-kind stem dispatch
// ---------------------------------------------------------------------------

function stemNameForKind(kind: RepairableKind): string {
  switch (kind) {
    case "xconsist-failed":
      return "xconsist";
    case "rules-red":
      return "rules";
    case "compile-failed":
      return "compile";
  }
}

/**
 * Build the structured prior-doc summary used as `{{prior_doc_summary}}`.
 * Structured extract (NOT the literal first 200 chars of the JSON) so
 * the model sees archetype + board + counts at a glance.
 */
function buildPriorDocSummary(doc: VolteuxProjectDocument): string {
  return JSON.stringify({
    archetype_id: doc.archetype_id,
    board_fqbn: doc.board.fqbn,
    components_count: doc.components.length,
    libraries_count: doc.sketch.libraries.length,
  });
}

/**
 * Build the bullet-list `{{errors_block}}` from the failing gate's errors.
 * Caps at 10 entries to keep the user turn under a token budget.
 */
function buildErrorsBlock(errors: ReadonlyArray<string>): string {
  const capped = errors.slice(0, 10);
  const lines = capped.map((e) => `  - ${e}`).join("\n");
  const suffix =
    errors.length > 10 ? `\n  ... and ${errors.length - 10} more error(s)` : "";
  return `${lines}${suffix}`;
}

// ---------------------------------------------------------------------------
// Public dispatcher
// ---------------------------------------------------------------------------

/**
 * Compose a repair user turn and dispatch it through the injected
 * `gen` function. The orchestrator is responsible for bounding the
 * call (it never invokes `repair()` more than once per `runPipeline`).
 *
 * If the failure kind is not a repairable kind (i.e., not xconsist /
 * rules / compile), this throws — the orchestrator should never call
 * repair() with a non-repairable kind, and surfacing a throw here is
 * the correct way to catch a bug in the orchestrator's branching.
 */
export async function repair(
  failure: RepairableFailure,
  prior_doc: VolteuxProjectDocument,
  prompt: string,
  gen: (
    prompt: string,
    opts?: { signal?: AbortSignal },
  ) => Promise<GenerateResult>,
): Promise<GenerateResult> {
  if (
    failure.kind !== "xconsist-failed" &&
    failure.kind !== "rules-red" &&
    failure.kind !== "compile-failed"
  ) {
    throw new Error(
      `repair() called with non-repairable kind: ${String(failure.kind)} — orchestrator bug`,
    );
  }
  const repairableKind: RepairableKind = failure.kind;
  const template = loadTemplate();
  const stem = extractStem(template, stemNameForKind(repairableKind));
  const filledStem = stem
    .replace("{{prior_doc_summary}}", buildPriorDocSummary(prior_doc))
    .replace("{{errors_block}}", buildErrorsBlock(failure.errors));

  // Compose the new prompt = original user prompt + repair instructions.
  // We append rather than replace so the system+schema-primer cached
  // prefix stays unchanged (cache_creation_input_tokens stays 0 on the
  // repair call; cache_read_input_tokens > 0 confirms the cache hit).
  // The model sees the original ask + the structured repair guidance
  // in a single user turn — no multi-turn conversation; no assistant
  // prefill.
  const repairPrompt = `${prompt}\n\n---\n\n${filledStem}`;
  return gen(repairPrompt);
}
