#!/usr/bin/env bun
/**
 * One-off measurement script. NOT part of `bun test`.
 *
 *   bun run measure:prompt-tokens          # prose-formatted output (default)
 *   bun run measure:prompt-tokens --json   # JSON output to stdout
 *
 * Constructs the production deps via `defaultGenerateDeps()`, makes a
 * single Anthropic call with a trivial user prompt, and prints
 * `usage.input_tokens` plus `cache_creation_input_tokens` and
 * `cache_read_input_tokens`. The developer runs this ONCE after Unit 3
 * lands and writes the measured value into the
 * `pipeline/prompts/archetype-1-system.md` header in this format:
 *
 *   <!-- system+schema primer measured at 1847 tokens on 2026-05-02; cache engages: yes (≥2048) -->
 *
 * If `input_tokens < 2048` (Sonnet's cache minimum), the developer
 * decides between two paths and records the choice in the same header
 * line:
 *
 *   - Pad: commit a frozen `pipeline/prompts/archetype-1-fewshot.md`
 *     with a hand-written example until the prefix clears 2048 tokens.
 *     Re-run this script to confirm.
 *
 *   - No-cache: write an ADR comment in archetype-1-system.md with a
 *     cost projection (per-call delta × estimated v0.5 eval volume × N
 *     weeks until v0.5). Padding is the default; no-cache requires
 *     justification.
 *
 * **Cost note.** This script makes ONE Sonnet call. ~$0.05-0.10 per run.
 * Do not run repeatedly without intent.
 */

import { defaultGenerateDeps, generate } from "../pipeline/llm/generate.ts";

const MEASURE_PROMPT = "a robot that waves when something gets close";

async function main(): Promise<void> {
  const jsonMode = process.argv.slice(2).includes("--json");

  // Touch defaultGenerateDeps once so any config error (missing env, missing
  // prompt source) surfaces with the right error message before the call.
  await defaultGenerateDeps();

  if (!jsonMode) {
    process.stdout.write(
      `[measure-prompt-tokens] sending one Sonnet call with prompt: ${JSON.stringify(MEASURE_PROMPT)}\n`,
    );
  }

  const result = await generate(MEASURE_PROMPT);

  if (!result.ok) {
    process.stderr.write(
      `[measure-prompt-tokens] generate() returned a failure: kind=${result.kind} message=${result.message}\n`,
    );
    process.exit(1);
  }

  const u = result.usage;
  const cacheEngaged =
    u.cache_creation_input_tokens > 0 || u.cache_read_input_tokens > 0;

  if (jsonMode) {
    process.stdout.write(
      `${JSON.stringify({
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        cache_creation_input_tokens: u.cache_creation_input_tokens,
        cache_read_input_tokens: u.cache_read_input_tokens,
        cache_engaged: cacheEngaged,
      })}\n`,
    );
    return;
  }

  process.stdout.write(
    [
      "[measure-prompt-tokens] usage:",
      `  input_tokens                  = ${u.input_tokens}`,
      `  output_tokens                 = ${u.output_tokens}`,
      `  cache_creation_input_tokens   = ${u.cache_creation_input_tokens}`,
      `  cache_read_input_tokens       = ${u.cache_read_input_tokens}`,
      "",
      `  Sonnet 4.6 cache minimum: 2048 tokens.`,
      `  cache engaged: ${cacheEngaged ? "yes" : "no"}`,
      "",
    ].join("\n"),
  );
}

main().catch((err) => {
  process.stderr.write(
    `[measure-prompt-tokens] FATAL: ${(err as Error).message}\n`,
  );
  process.exit(1);
});
