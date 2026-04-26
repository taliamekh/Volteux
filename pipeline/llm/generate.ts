/**
 * Sonnet 4.6 generation with structured output (Zod-validated) +
 * 1h prompt cache + single auto-repair retry.
 *
 *   buildGenerator(deps) → (prompt) => Promise<GenerateResult>
 *   generate(prompt, opts?) → Promise<GenerateResult>     // convenience
 *
 * Mirrors the `buildApp(deps) + startServer()` DI shape from
 * `infra/server/compile-api.ts`. `buildGenerator(deps)` is a pure
 * factory; `generate()` is a thin convenience that lazily constructs
 * `defaultGenerateDeps()` on first call. Tests construct deps directly
 * via `buildGenerator(mockDeps)` without touching the env.
 *
 * **Failure-kind discriminated union (5 literals):**
 *   - "schema-failed" — SDK threw on Zod parse (post-retry); model emitted
 *                       JSON that does not match `VolteuxProjectDocumentSchema`.
 *                       One auto-repair turn worth attempting before this fires.
 *   - "truncated"    — `stop_reason === "max_tokens"`; retry with same prompt
 *                       won't help. Surface to Honest Gap.
 *   - "transport"    — SDK threw before/after fetch (network, DNS, socket
 *                       reset, fetch rejection); APIConnectionError.
 *   - "sdk-error"    — SDK threw inside its own retry-exhaustion path
 *                       (rate-limit retried-out, 5xx retried-out).
 *   - "abort"        — `AbortController` signal fired (caller cancelled);
 *                       APIUserAbortError.
 *
 * **Wire-contract uniformity.** Hyphenated lowercase literals matching
 * `CompileGateFailureKind` and `FilenameRejectionKind`. The orchestrator
 * (Unit 9) switches on `kind` to decide retry policy without parsing
 * free-text reason strings.
 *
 * **Throwing crosses the boundary ONLY for input-validation guards.**
 * Empty prompt → `throw new Error("empty prompt")`. Prompt longer than
 * 5000 chars → `throw new Error("prompt exceeds 5000 chars")`. Every
 * other failure (SDK throw, network, abort, schema-fail, truncated)
 * returns `{ok: false, kind, ...}`. This split is the contract.
 *
 * **Cache discipline (cached-prefix block boundary).** The system prompt
 * is built as a multi-block array (intro + schema/registry primer +
 * optional fewshot). `cache_control: { type: "ephemeral", ttl: "1h" }`
 * sits on the LAST system block. The auto-repair retry adds a NEW user
 * turn AFTER the cached system blocks; the cached prefix is NEVER
 * mutated, so `cache_creation_input_tokens === 0` and
 * `cache_read_input_tokens > 0` on the retry call. See
 * docs/solutions/best-practices/c-preprocessor-modelling-in-llm-output-gates-2026-04-25.md
 * for the structural mirror — putting the auto-repair instruction inside
 * the cached system block is the same class of static-vs-runtime drift.
 *
 * **Auto-repair shape (no assistant prefill).** Retry messages are
 *   system → user(original)
 *          → assistant(repair_context_from_validator)
 *          → user(repair instruction with zod errors).
 * The last turn is a USER turn, not an assistant-suffixed prefill. The
 * "fresh user turn carrying ZodIssues, not assistant-prefill" pattern
 * works on every Anthropic model version regardless of whether
 * Sonnet 4.6+ rejects prefill (the integration test probes that
 * outcome and documents it).
 *
 * The assistant turn carries the SDK's parse-error message — NOT the
 * model's actual prior raw output. `messages.parse` does not expose
 * raw text on its throw path; fetching it via a second `messages.create`
 * would double-charge tokens for the schema-failed path. The user-turn
 * repair instruction explicitly names this ("your previous attempt
 * failed structured-output validation") so the model treats the
 * assistant content as conversational context rather than a faithful
 * echo of its own prior speech. See `buildRepairMessages` docstring.
 *
 * **Few-shot padding source discipline.** `defaultGenerateDeps()` reads
 * ONLY from `pipeline/prompts/` (synchronously via `Bun.file().text()`
 * on first call). It never reads from `fixtures/` at module load —
 * Unit 10 will commit `fixtures/generated/*.json` produced by this
 * function, and reading those at module load would silently invalidate
 * the cache when fixtures regenerate.
 *
 * **Note for Unit 9 (trace writer).** `usage` is carried on success so
 * the orchestrator can emit `llm_call` events. If a future contributor
 * adds a `prompt_version_hash` to the trace event, they must serialize
 * the inputs through a single `JSON.stringify` envelope — never
 * separator-byte concatenation. See
 * docs/solutions/security-issues/sha256-cache-key-canonical-json-serialization-2026-04-26.md
 * for the NUL-collision class this prevents.
 *
 * **Logger discipline.** Do not log the Authorization header, the API
 * key, or `process.env`. The Anthropic SDK's request logger is OFF by
 * default — leave it OFF here.
 */

import Anthropic, {
  APIConnectionError,
  APIError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";
import type {
  MessageParam,
  TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import type { ZodIssue } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  VolteuxProjectDocumentSchema,
  type VolteuxProjectDocument,
} from "../../schemas/document.zod.ts";
import { COMPONENTS } from "../../components/registry.ts";
import { createAnthropicClient } from "./anthropic-client.ts";
import {
  extractMessage,
  extractZodIssues,
  isStructuredOutputParseError,
  makeOutputFormat as makeStructuredOutputFormat,
  transformJSONSchema,
  type SdkUsage,
  type StructuredOutputFormat,
} from "./sdk-helpers.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 16000;
const MAX_PROMPT_CHARS = 5000;
const SYSTEM_PROMPT_PATH = "pipeline/prompts/archetype-1-system.md";
const FEWSHOT_PROMPT_PATH = "pipeline/prompts/archetype-1-fewshot.md";

/**
 * Per-call SDK timeout. Sonnet 4.6 typical end-to-end + cache write
 * lands in 5-10s; 60s is generous but still well below the SDK's
 * 600s default — long enough to absorb a single transient slowdown,
 * short enough that a stuck request surfaces as `transport`/`abort`
 * rather than blocking the orchestrator (Unit 9) for minutes.
 */
const SDK_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The 5-literal discriminated failure kind. Hyphenated lowercase to
 * match the wire-contract style of `CompileGateFailureKind` and
 * `FilenameRejectionKind`.
 */
export type GenerateFailureKind =
  | "schema-failed"
  | "truncated"
  | "transport"
  | "sdk-error"
  | "abort";

/** Token-usage snapshot fed into Unit 9's trace writer. */
export interface GenerateUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export type GenerateResult =
  | { ok: true; doc: VolteuxProjectDocument; usage: GenerateUsage }
  | {
      ok: false;
      severity: "red";
      kind: GenerateFailureKind;
      message: string;
      errors: ReadonlyArray<string | ZodIssue>;
    };

/**
 * Dependencies for `buildGenerator`. Production wiring uses
 * `defaultGenerateDeps()`; tests construct this object inline.
 */
export interface GenerateDeps {
  client: Anthropic;
  /** Raw archetype-1-system.md content (the meta-harness PR-edits this). */
  systemPromptSource: string;
  /** Optional frozen few-shot string (only set when padding is needed). */
  fewshotSource?: string;
  /**
   * Schema + registry primer. Built dynamically from
   * `VolteuxProjectDocumentSchema` and `COMPONENTS` at deps construction
   * time. The runtime JSON contract is the source of truth; the prompt
   * source describes what the primer should contain but never duplicates
   * the registry data.
   */
  schemaPrimer: string;
  model: string;
  maxTokens: number;
}

export interface GenerateOptions {
  /** Inject partial deps overrides. */
  deps?: Partial<GenerateDeps>;
  /** Caller-cancellation signal forwarded to the SDK. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Compile-time exhaustiveness guard
// ---------------------------------------------------------------------------

/**
 * Compile-time exhaustiveness guard for `GenerateFailureKind` switches.
 * Mirrors `assertNeverCompileGateFailureKind` in `pipeline/gates/compile.ts`.
 *
 * Usage in callers (e.g., Unit 9's repair() helper):
 *
 *   switch (result.kind) {
 *     case "schema-failed": ...; break;
 *     case "truncated":     ...; break;
 *     case "transport":     ...; break;
 *     case "sdk-error":     ...; break;
 *     case "abort":         ...; break;
 *     default: assertNeverGenerateFailureKind(result.kind);
 *   }
 *
 * If a future change adds a 6th kind without updating the switch, tsc
 * fails at the `default:` site rather than letting the case silently
 * fall through.
 */
export function assertNeverGenerateFailureKind(kind: never): never {
  throw new Error(`Unhandled GenerateFailureKind: ${String(kind)}`);
}

// ---------------------------------------------------------------------------
// Schema/registry primer builder
// ---------------------------------------------------------------------------

/**
 * Build the schema+registry primer block from `COMPONENTS`. Called by
 * `defaultGenerateDeps()` at lazy-init time. Tests can override
 * `deps.schemaPrimer` with a hand-frozen string when they want to assert
 * exact prompt bytes.
 *
 * The primer enumerates the 5 archetype-1 components by SKU + name +
 * type + role, plus a one-line summary of each pin's direction. It does
 * NOT paste the full education_blurb (too verbose for the cached prefix).
 */
export function buildSchemaPrimer(): string {
  const lines: string[] = [];
  lines.push("# Schema and component registry");
  lines.push("");
  lines.push(
    "You emit a single JSON object matching the VolteuxProjectDocument schema. " +
      "Use ONLY the SKUs from the registry below. Do NOT invent SKUs. Do NOT " +
      "include v1.5 fields (captive_portal_ssid, aio_feed_names, mdns_name).",
  );
  lines.push("");
  lines.push("## Component registry (the only authoritative source)");
  lines.push("");
  // `Object.values(COMPONENTS)` is typed correctly off the `as const`
  // declaration in components/registry.ts — no cast or undefined guard
  // needed. Iterating values directly avoids the bracket-access lookup
  // and the dead `if (!entry) continue` guard the previous shape required.
  for (const entry of Object.values(COMPONENTS)) {
    lines.push(`- SKU ${entry.sku}: ${entry.name} (type: ${entry.type})`);
    if (entry.pin_metadata.length > 0) {
      const pinSummary = entry.pin_metadata
        .map((p) => `${p.label}(${p.direction})`)
        .join(", ");
      lines.push(`  pins: ${pinSummary}`);
    }
  }
  lines.push("");
  lines.push("## Top-level shape");
  lines.push("");
  lines.push(
    "{ archetype_id, board: {sku,name,type,fqbn}, components: [{id,sku,quantity}], " +
      "connections: [{from:{component_id,pin_label}, to:{component_id,pin_label}, purpose, wire_color?}], " +
      "breadboard_layout: {components: [{component_id, anchor_hole, rotation}]}, " +
      "sketch: {main_ino, libraries: [...]}, external_setup: {needs_wifi, needs_aio_credentials}, " +
      "honest_gap?: {scope, missing_capabilities, explanation} }",
  );
  lines.push("");
  lines.push("## Hard rules");
  lines.push("");
  lines.push(
    "- archetype_id is one of: uno-ultrasonic-servo, esp32-audio-dashboard, " +
      "pico-rotary-oled, esp32c3-dht-aio, uno-photoresistor-led.",
  );
  lines.push(
    "- For archetype 1 (uno-ultrasonic-servo): board.fqbn must be 'arduino:avr:uno'.",
  );
  lines.push(
    "- anchor_hole format: rows a-j, columns 1-30, e.g. 'e15'. Column 0 does not exist.",
  );
  lines.push("- rotation is one of 0, 90, 180, 270.");
  lines.push(
    "- wire_color is one of: red, black, yellow, blue, green, white, orange.",
  );
  lines.push("- Output JSON only. No markdown fences. No prose.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Default deps factory (lazy, in-flight promise)
// ---------------------------------------------------------------------------

/**
 * The lazy-initialization slot stores the in-flight PROMISE, not the
 * resolved deps. Concurrent callers (e.g. two simultaneous
 * `await defaultGenerateDeps()` from a parallelized smoke run) share the
 * same single in-flight initialization — they all `await` the same
 * promise. Without this, both concurrent calls would pass the `null`
 * check before the first `await` resolved, both would construct an
 * Anthropic client, and the second assignment would silently win — the
 * first client (and its connection pool) would be abandoned.
 *
 * Also makes the cache safe under bun's shared-module test runner:
 * `_resetDefaultDepsForTest()` clears the slot so subsequent unit tests
 * get a fresh deps instead of reusing a real client populated by a
 * preceding integration test.
 */
let cachedDefaultDepsPromise: Promise<GenerateDeps> | null = null;

/**
 * Build the default deps. Reads the prompt source from
 * `pipeline/prompts/archetype-1-system.md` and (when present) the
 * frozen few-shot from `pipeline/prompts/archetype-1-fewshot.md`. Reads
 * the env var `ANTHROPIC_API_KEY` indirectly through
 * `createAnthropicClient()`. Cached as an in-flight promise after first
 * call so repeated `generate()` invocations share a single client AND
 * concurrent first-callers share a single initialization (no duplicate
 * Anthropic clients constructed under contention).
 *
 * Throws if `ANTHROPIC_API_KEY` is missing OR the prompt source file is
 * missing. These are configuration errors at the dev workstation level;
 * surfacing them as throws (not a `kind: "transport"` return) is
 * intentional — the caller is wrong, no recovery is meaningful.
 */
export function defaultGenerateDeps(): Promise<GenerateDeps> {
  if (cachedDefaultDepsPromise !== null) return cachedDefaultDepsPromise;
  cachedDefaultDepsPromise = (async () => {
    const systemPromptSource = await Bun.file(SYSTEM_PROMPT_PATH).text();
    // Few-shot is conditional — only read if the file exists. The padding
    // decision (engage cache vs document no-cache ADR) is made AFTER the
    // first integration run measures `usage.input_tokens`. Until then the
    // system+schema primer alone may be < 2048 tokens; the few-shot padding
    // is added in a follow-up commit if needed.
    let fewshotSource: string | undefined;
    try {
      fewshotSource = await Bun.file(FEWSHOT_PROMPT_PATH).text();
    } catch {
      // Bun.file().text() throws on ENOENT; the absence is normal pre-padding.
      fewshotSource = undefined;
    }
    return {
      client: createAnthropicClient(),
      systemPromptSource,
      fewshotSource,
      schemaPrimer: buildSchemaPrimer(),
      model: DEFAULT_MODEL,
      maxTokens: DEFAULT_MAX_TOKENS,
    };
  })();
  return cachedDefaultDepsPromise;
}

/**
 * Test-only escape hatch. Production code MUST NOT import from here.
 *
 * Bun's test runner shares modules across files; without this reset,
 * an integration test that populates `cachedDefaultDepsPromise` with a
 * real-client deps would leak that client into subsequent unit tests
 * that exercise the convenience `generate()` wrapper, regardless of
 * mock-injection intent. Mirrors `infra/server/cache.ts`'s
 * `__testing.resetMemoizedHash()` pattern.
 */
export function _resetDefaultDepsForTest(): void {
  cachedDefaultDepsPromise = null;
}

// ---------------------------------------------------------------------------
// JSON-schema (v3 zod compatible)
// ---------------------------------------------------------------------------

/**
 * Pre-compute the JSON Schema once per process.
 *
 * The Anthropic SDK's `zodOutputFormat` helper expects a Zod v4 schema;
 * our schema is v3 (the wider project pins `zod^3`). We construct the
 * equivalent `AutoParseableOutputFormat` ourselves using
 * `zod-to-json-schema` for the wire schema and our v3 schema's
 * `safeParse` for the parse step.
 *
 * **Replicate the downstream pipeline before matching.** The SDK applies
 * `transformJSONSchema()` to whatever the user passes — folding
 * unsupported constraints (like `minimum` on integers, regex patterns,
 * `minLength > 1` on strings, format keywords outside the allowlist)
 * into a free-text description string, and forcing
 * `additionalProperties: false` on every object. We do the same here so
 * the wire schema is what Anthropic's structured-output endpoint
 * actually accepts. Without this, requests fail with
 * `400 invalid_request_error: For 'integer' type, property 'minimum'
 * is not supported.`
 *
 * This mirrors the C-preprocessor compound learning: replicate the
 * downstream tool's transformation pipeline before constructing inputs
 * for it. See
 * docs/solutions/best-practices/c-preprocessor-modelling-in-llm-output-gates-2026-04-25.md
 * for the framing.
 */
// `name` is intentionally OMITTED so zodToJsonSchema returns the schema
// inline at the top level (no `$ref`). The SDK's `transformJSONSchema`
// short-circuits on `$ref` and would not strip the unsupported
// constraints inside the referenced definition; passing the inline
// shape is the only way to get the transformation applied.
const VOLTEUX_JSON_SCHEMA_RAW = zodToJsonSchema(VolteuxProjectDocumentSchema, {
  $refStrategy: "none",
  target: "jsonSchema2019-09",
});
const VOLTEUX_JSON_SCHEMA = transformJSONSchema(
  VOLTEUX_JSON_SCHEMA_RAW as { [key: string]: unknown },
);

/**
 * Build the `output_config.format` shape the SDK expects for structured
 * output. Thin module-local wrapper around the shared `makeOutputFormat`
 * in `sdk-helpers.ts`, parameterized with this module's Zod schema +
 * pre-transformed wire schema.
 */
function makeOutputFormat(): StructuredOutputFormat<VolteuxProjectDocument> {
  return makeStructuredOutputFormat(
    VolteuxProjectDocumentSchema,
    VOLTEUX_JSON_SCHEMA as { [key: string]: unknown },
  );
}

// ---------------------------------------------------------------------------
// Message construction (cached-prefix discipline)
// ---------------------------------------------------------------------------

/**
 * Build the `system` parameter as a multi-block array so
 * `cache_control` can sit on the LAST block. Order:
 *   1. Intro / role description (from archetype-1-system.md)
 *   2. Schema + registry primer (built dynamically; rev'd via PR
 *      whenever the schema or registry changes)
 *   3. Few-shot example (only when padding for cache engagement is
 *      needed — frozen string committed via PR; never read from
 *      fixtures/ at module load)
 *
 * `cache_control` sits on the LAST present block. If the cached prefix
 * is < Sonnet's 2048-token threshold the cache simply does not engage;
 * placing the marker is harmless. If the prefix mutates between
 * attempts the cache silently misses, which is what the auto-repair
 * test scenarios assert against.
 */
function buildSystemBlocks(deps: GenerateDeps): TextBlockParam[] {
  const blocks: TextBlockParam[] = [
    { type: "text", text: deps.systemPromptSource },
    { type: "text", text: deps.schemaPrimer },
  ];
  if (deps.fewshotSource !== undefined) {
    blocks.push({ type: "text", text: deps.fewshotSource });
  }
  // Mark ONLY the last block. The SDK transmits the boundary verbatim;
  // user/assistant turns appended AFTER do not invalidate the prefix.
  // Replace via spread (immutable update) rather than mutating the
  // existing element in place — keeps the function aligned with the
  // codebase-wide immutability convention without changing the wire
  // payload.
  const lastIdx = blocks.length - 1;
  const last = blocks[lastIdx];
  if (last !== undefined) {
    blocks[lastIdx] = {
      ...last,
      cache_control: { type: "ephemeral", ttl: "1h" },
    };
  }
  return blocks;
}

/**
 * Build the auto-repair retry messages. The cached system blocks are
 * passed unchanged; the new turns sit AFTER them. The retry sends:
 *   user(original prompt)
 *   assistant(repair_context_from_validator as completed turn) ← NOT a prefill
 *   user("Your previous attempt failed structured-output validation: ...; return corrected JSON.")
 *
 * The last turn is a USER turn. The model treats this as a normal
 * conversational continuation, not an assistant-suffixed prefill that
 * Sonnet 4.6+ may reject.
 *
 * **Why we feed a validator message into the assistant turn (not the
 * model's actual raw output).** When `messages.parse` rejects on Zod
 * validation it throws an `AnthropicError("Failed to parse structured
 * output: <inner>")` — the SDK does NOT expose the model's raw
 * generated text on the throw path. The auto-repair could fetch it via
 * a second non-parse `messages.create` call, but that doubles the
 * schema-failed-path cost (input tokens + output tokens billed twice
 * for the same content) for a modest information gain. We accept the
 * tradeoff: the assistant turn carries the validator's error context
 * (a stand-in for what the model produced), and the next user turn
 * EXPLICITLY says "your previous attempt failed structured-output
 * validation" so the model treats the assistant content as
 * conversational context rather than a faithful echo of its own prior
 * speech. The integration tests confirm Sonnet 4.6 accepts this shape
 * and produces a valid corrected document.
 */
function buildRepairMessages(
  userPrompt: string,
  repairContextFromValidator: string,
  zodIssues: ReadonlyArray<ZodIssue>,
): MessageParam[] {
  const issueLines = zodIssues
    .slice(0, 10)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `  - ${path}: ${issue.message}`;
    })
    .join("\n");
  const issueSuffix =
    zodIssues.length > 10 ? `\n  ... and ${zodIssues.length - 10} more issue(s)` : "";
  const repairText =
    `Your previous attempt failed structured-output validation with this error: ${repairContextFromValidator}\n\n` +
    `The full Zod issues are:\n${issueLines}${issueSuffix}\n\n` +
    `Return a corrected JSON document that satisfies the schema. JSON only — no markdown fences, no prose.`;
  return [
    { role: "user", content: userPrompt },
    { role: "assistant", content: repairContextFromValidator },
    { role: "user", content: repairText },
  ];
}

// ---------------------------------------------------------------------------
// Failure-kind mapping (SDK throw → kind literal)
// ---------------------------------------------------------------------------
//
// `extractMessage`, `extractZodIssues`, `isStructuredOutputParseError`
// live in `./sdk-helpers.ts` and are imported above. The kind-mapper
// stays LOCAL because the failure-kind union differs from classify
// (5 vs 4 literals).

/**
 * Map an SDK throw to a `GenerateFailureKind`. Distinct from the
 * structured-output Zod-parse case which is handled inline (it triggers
 * the auto-repair retry on first attempt and fails as `schema-failed`
 * on second attempt).
 *
 * Distinguishing "transport" (no response received) from "sdk-error"
 * (got a response, SDK retried out): `APIConnectionError` is the
 * transport class; `APIError` with a status is sdk-error.
 */
function mapSdkErrorToKind(err: unknown): GenerateFailureKind {
  if (err instanceof APIUserAbortError) return "abort";
  if (err instanceof APIConnectionError) return "transport";
  if (err instanceof APIError) return "sdk-error";
  // Plain TypeError("fetch failed") and similar — also transport.
  if (err instanceof Error) {
    const name = err.name;
    if (name === "AbortError" || name === "TimeoutError") return "abort";
    if (name === "TypeError" && err.message.toLowerCase().includes("fetch")) {
      return "transport";
    }
  }
  return "sdk-error";
}

// ---------------------------------------------------------------------------
// Usage extraction
// ---------------------------------------------------------------------------

function toGenerateUsage(usage: SdkUsage): GenerateUsage {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a generator closure. Pure: no env reads, no file I/O. The
 * closure performs at most 2 model calls (initial + 1 auto-repair).
 *
 * Production callers use `generate()` which lazily wraps
 * `defaultGenerateDeps()`; tests call this directly with mock deps.
 *
 * **Closure call shape.** The returned closure accepts ONLY
 * `{signal?}` per call — there is no per-call `deps` override. To swap
 * deps (e.g., a different model name in a smoke script), use the
 * `generate()` convenience wrapper's `opts.deps` partial-merge instead;
 * that path constructs a fresh `buildGenerator(...)` per call. Mixing
 * the two would bind half a request's behaviour to the closed-over
 * deps and the other half to a runtime override, which is the wrong
 * mental model.
 */
export function buildGenerator(
  deps: GenerateDeps,
): (prompt: string, opts?: { signal?: AbortSignal }) => Promise<GenerateResult> {
  return async function generateInner(
    prompt: string,
    innerOpts: { signal?: AbortSignal } = {},
  ): Promise<GenerateResult> {
    // ---- Input-validation guards (THROW; no recovery is meaningful) ----
    if (prompt === "") {
      throw new Error("empty prompt");
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new Error(`prompt exceeds ${MAX_PROMPT_CHARS} chars`);
    }

    const systemBlocks = buildSystemBlocks(deps);
    const outputFormat = makeOutputFormat();

    // ---- Attempt 1 ---------------------------------------------------------
    // `repairContextFromValidator` is the SDK's parse-error message we
    // feed into the assistant turn of the auto-repair retry as a
    // stand-in for the model's actual raw output (which `messages.parse`
    // does not expose on throw). The repair-instruction user turn is
    // explicit about what this is — see `buildRepairMessages` doc.
    let repairContextFromValidator = "";
    let zodIssues: ReadonlyArray<ZodIssue> = [];

    try {
      const response = await deps.client.messages.parse(
        {
          model: deps.model,
          max_tokens: deps.maxTokens,
          system: systemBlocks,
          messages: [{ role: "user", content: prompt }],
          output_config: { format: outputFormat },
        },
        innerOpts.signal !== undefined
          ? { signal: innerOpts.signal, timeout: SDK_TIMEOUT_MS }
          : { timeout: SDK_TIMEOUT_MS },
      );

      // Truncation: stop_reason === "max_tokens" with no parsed_output.
      if (
        response.stop_reason === "max_tokens" &&
        response.parsed_output === null
      ) {
        return {
          ok: false,
          severity: "red",
          kind: "truncated",
          message: "Sonnet response truncated at max_tokens",
          errors: [],
        };
      }

      if (response.parsed_output !== null) {
        return {
          ok: true,
          doc: response.parsed_output,
          usage: toGenerateUsage(response.usage),
        };
      }

      // No parsed_output but not truncated — defensive sdk-error.
      return {
        ok: false,
        severity: "red",
        kind: "sdk-error",
        message: "Sonnet returned no parsed_output and stop_reason was not max_tokens",
        errors: [`stop_reason=${String(response.stop_reason)}`],
      };
    } catch (err) {
      // Structured-output parse failure: the SDK threw because our
      // `parse()` rejected the JSON. The SDK does NOT expose the
      // model's raw generated text on this throw path; we'd have to
      // make a second non-parse `messages.create` call to get it,
      // which would double-charge tokens for the schema-failed path.
      // Instead we feed the validator's error message into the
      // assistant turn (as a stand-in) and the next user turn
      // explicitly says "your previous attempt failed validation" so
      // the model treats the assistant content as context, not as its
      // own faithful prior speech. Integration tests confirm this
      // shape produces valid corrected output.
      if (isStructuredOutputParseError(err)) {
        zodIssues = extractZodIssues(err);
        repairContextFromValidator = extractMessage(err);
        // Fall through to attempt 2.
      } else {
        // Pre-fetch / mid-fetch / SDK-retry-exhausted throws.
        const kind = mapSdkErrorToKind(err);
        return {
          ok: false,
          severity: "red",
          kind,
          message:
            kind === "abort"
              ? "generate aborted"
              : kind === "transport"
                ? `anthropic-sdk transport error: ${extractMessage(err)}`
                : `anthropic-sdk error: ${extractMessage(err)}`,
          errors: [extractMessage(err)],
        };
      }
    }

    // ---- Attempt 2 (auto-repair) -------------------------------------------
    // Cache discipline: system blocks are UNCHANGED. The retry adds new
    // user/assistant turns after the cached prefix. cache_creation_input_tokens
    // is expected to be 0 on this call; cache_read_input_tokens > 0
    // confirms the prefix was hit.
    try {
      const response = await deps.client.messages.parse(
        {
          model: deps.model,
          max_tokens: deps.maxTokens,
          system: systemBlocks,
          messages: buildRepairMessages(
            prompt,
            repairContextFromValidator,
            zodIssues,
          ),
          output_config: { format: outputFormat },
        },
        innerOpts.signal !== undefined
          ? { signal: innerOpts.signal, timeout: SDK_TIMEOUT_MS }
          : { timeout: SDK_TIMEOUT_MS },
      );

      if (
        response.stop_reason === "max_tokens" &&
        response.parsed_output === null
      ) {
        return {
          ok: false,
          severity: "red",
          kind: "truncated",
          message: "Sonnet response truncated at max_tokens (auto-repair retry)",
          errors: [],
        };
      }

      if (response.parsed_output !== null) {
        // The second-call usage carries the cache_read_input_tokens and
        // cache_creation_input_tokens that the auto-repair test scenarios
        // assert against (cache_read > 0, cache_creation === 0).
        return {
          ok: true,
          doc: response.parsed_output,
          usage: toGenerateUsage(response.usage),
        };
      }

      return {
        ok: false,
        severity: "red",
        kind: "sdk-error",
        message: "Sonnet returned no parsed_output on auto-repair retry",
        errors: [`stop_reason=${String(response.stop_reason)}`],
      };
    } catch (err) {
      if (isStructuredOutputParseError(err)) {
        const finalIssues = extractZodIssues(err);
        return {
          ok: false,
          severity: "red",
          kind: "schema-failed",
          message:
            "Sonnet output failed schema validation after one auto-repair turn",
          errors: finalIssues.length > 0 ? finalIssues : [extractMessage(err)],
        };
      }
      const kind = mapSdkErrorToKind(err);
      return {
        ok: false,
        severity: "red",
        kind,
        message:
          kind === "abort"
            ? "generate aborted (auto-repair retry)"
            : kind === "transport"
              ? `anthropic-sdk transport error (auto-repair retry): ${extractMessage(err)}`
              : `anthropic-sdk error (auto-repair retry): ${extractMessage(err)}`,
        errors: [extractMessage(err)],
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Convenience wrapper
// ---------------------------------------------------------------------------

/**
 * Convenience entry point for production callers. Lazily constructs
 * `defaultGenerateDeps()` on first invocation; subsequent calls reuse
 * the cached deps. Tests should NOT use this — they should call
 * `buildGenerator(mockDeps)` directly.
 *
 * The `opts.deps` partial-override is provided so ad-hoc smoke scripts
 * can override the model name or maxTokens without rewriting the
 * default-deps factory.
 */
export async function generate(
  prompt: string,
  opts: GenerateOptions = {},
): Promise<GenerateResult> {
  const base = await defaultGenerateDeps();
  const deps: GenerateDeps =
    opts.deps !== undefined ? { ...base, ...opts.deps } : base;
  const inner = buildGenerator(deps);
  return inner(
    prompt,
    opts.signal !== undefined ? { signal: opts.signal } : {},
  );
}
