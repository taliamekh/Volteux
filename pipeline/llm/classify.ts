/**
 * Haiku 4.5 intent classifier.
 *
 *   buildClassifier(deps) → (prompt) => Promise<ClassifyResult>
 *   classify(prompt, opts?) → Promise<ClassifyResult>     // convenience
 *
 * Mirrors the `buildApp(deps) + startServer()` DI shape from
 * `infra/server/compile-api.ts` and the `buildGenerator(deps)` pattern
 * from `pipeline/llm/generate.ts`. `buildClassifier(deps)` is a pure
 * factory; `classify()` is a thin convenience that lazily constructs
 * `defaultClassifyDeps()` on first call. Tests construct deps directly
 * via `buildClassifier(mockDeps)` without touching the env or filesystem.
 *
 * **Failure-kind discriminated union (4 literals):**
 *   - "transport"    — SDK threw before/after fetch (network, DNS, socket
 *                       reset, fetch rejection); APIConnectionError.
 *   - "sdk-error"    — SDK threw inside its own retry-exhaustion path
 *                       (rate-limit retried-out, 5xx retried-out).
 *   - "abort"        — `AbortController` signal fired (caller cancelled);
 *                       APIUserAbortError.
 *   - "schema-failed" — SDK threw on Zod parse (model returned an invalid
 *                       `archetype_id` enum value or malformed shape).
 *                       NOT auto-repaired in this batch (Unit 9 decides).
 *
 * **No `"truncated"` literal — by deliberate design.** `max_tokens: 1024`
 * is ~5× the response shape (`{archetype_id, confidence, reasoning}` is
 * ~150-200 tokens on a generous reasoning string). A truncation here is
 * structurally indistinguishable from malformed shape — the SDK's Zod
 * parse fails inside `messages.parse` and surfaces as the same
 * `AnthropicError("Failed to parse structured output: ...")` that
 * `schema-failed` already covers. There is no condition in the SDK
 * response shape that would fire a `truncated` literal here without
 * also firing `schema-failed`. Adding the literal would create a
 * dead branch and an exhaustiveness guard that asserts something the
 * code path can't reach. Documented here so a future contributor
 * doesn't add a literal that has no condition firing it.
 *
 * **No auto-repair on classify failure.** The classifier is a
 * deterministic mapping job over a tiny enum. A parse failure indicates
 * either a model bug (non-deterministic deviation from the schema) or a
 * prompt issue (the system prompt admits ambiguity). Both are real bugs
 * worth surfacing immediately, not papering over with retries. Single
 * attempt per call; failures bubble out as `kind: "schema-failed"` with
 * the SDK's ZodIssues in `errors`.
 *
 * **Threshold filter is NOT here.** `classify()` returns `confidence` and
 * `archetype_id` exactly as the model emits them. The orchestrator
 * (Unit 9) applies the `confidence >= 0.6` threshold and the
 * `archetype_id !== "uno-ultrasonic-servo"` archetype-1-only filter. Do
 * NOT bake either threshold into this function — the meta-harness in
 * v0.9 will tune the threshold and a hard-coded filter here would
 * silently override the proposer's adjustments.
 *
 * **No cache (deliberate).** Haiku 4.5's prompt cache requires ≥4096
 * tokens of cached prefix; this system prompt is ~600 tokens. Padding
 * to 4096 is not worth it at v0.5 eval volume (~600 calls/month →
 * ~$0.78/month total without cache; the padding work would cost more
 * implementer time than the cache saves). The prompt source's header
 * is the audit trail. Do NOT add `cache_control` anywhere in this
 * file. The integration test asserts `cache_read_input_tokens === 0`
 * AND `cache_creation_input_tokens === 0` to catch any accidental
 * `cache_control` insertion. See
 * docs/solutions/best-practices/c-preprocessor-modelling-in-llm-output-gates-2026-04-25.md
 * for the broader principle: documenting a deliberate divergence from
 * the cached-prefix discipline is the audit-trail analogue of
 * replicating the downstream tool's transformation pipeline.
 *
 * **Throwing crosses the boundary ONLY for input-validation guards.**
 * Empty prompt → `throw new Error("empty prompt")`. Prompt longer than
 * 5000 chars → `throw new Error("prompt exceeds 5000 chars")`. Every
 * other failure (SDK throw, network, abort, schema-fail) returns
 * `{ok: false, kind, ...}`. Same contract as `generate()`.
 *
 * **Note for Unit 9 (trace writer).** `usage` is carried on success so
 * the orchestrator can emit `llm_call` events. If a future contributor
 * adds a composite `prompt_version_hash` to the trace event, they must
 * serialize the inputs through a single `JSON.stringify` envelope —
 * never separator-byte concatenation. See
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
import { z, type ZodIssue } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ARCHETYPE_IDS } from "../../schemas/document.zod.ts";
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

const DEFAULT_MODEL = "claude-haiku-4-5";
const DEFAULT_MAX_TOKENS = 1024;
const MAX_PROMPT_CHARS = 5000;
const SYSTEM_PROMPT_PATH = "pipeline/prompts/intent-classifier-system.md";

// ---------------------------------------------------------------------------
// Public schema
// ---------------------------------------------------------------------------

/**
 * The Zod schema the model's structured output is validated against.
 * `archetype_id` reuses `ARCHETYPE_IDS` from `schemas/document.zod.ts`
 * (single source of truth for the 5 archetype identifiers) wrapped in
 * `.nullable()`. An explicit `null` is the strongest out-of-scope signal
 * — the orchestrator's primary routing decision is `archetype_id ===
 * null` ? out-of-scope : check-confidence-threshold.
 */
export const IntentClassificationSchema = z
  .object({
    archetype_id: z.enum(ARCHETYPE_IDS).nullable(),
    confidence: z.number().min(0).max(1),
    reasoning: z.string(),
  })
  .strict();

export type IntentClassification = z.infer<typeof IntentClassificationSchema>;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The 4-literal discriminated failure kind. Hyphenated lowercase to
 * match the wire-contract style of `CompileGateFailureKind`,
 * `FilenameRejectionKind`, and `GenerateFailureKind`.
 *
 * Note absence of `"truncated"` — see file-header rationale.
 */
export type ClassifyFailureKind =
  | "transport"
  | "sdk-error"
  | "abort"
  | "schema-failed";

/** Token-usage snapshot fed into Unit 9's trace writer. */
export interface ClassifyUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export type ClassifyResult =
  | {
      ok: true;
      archetype_id: IntentClassification["archetype_id"];
      confidence: number;
      reasoning: string;
      usage: ClassifyUsage;
    }
  | {
      ok: false;
      severity: "red";
      kind: ClassifyFailureKind;
      message: string;
      errors: ReadonlyArray<string | ZodIssue>;
    };

/**
 * Dependencies for `buildClassifier`. Production wiring uses
 * `defaultClassifyDeps()`; tests construct this object inline.
 */
export interface ClassifyDeps {
  client: Anthropic;
  /** Raw intent-classifier-system.md content (the meta-harness PR-edits this). */
  systemPromptSource: string;
  model: string;
  maxTokens: number;
}

export interface ClassifyOptions {
  /** Inject partial deps overrides. */
  deps?: Partial<ClassifyDeps>;
  /** Caller-cancellation signal forwarded to the SDK. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Compile-time exhaustiveness guard
// ---------------------------------------------------------------------------

/**
 * Compile-time exhaustiveness guard for `ClassifyFailureKind` switches.
 * Mirrors `assertNeverFailureKind` in `pipeline/gates/compile.ts` and
 * `assertNeverGenerateFailureKind` in `pipeline/llm/generate.ts`.
 *
 * Usage in callers (e.g., Unit 9's classify-then-generate orchestrator):
 *
 *   switch (result.kind) {
 *     case "transport":     ...; break;
 *     case "sdk-error":     ...; break;
 *     case "abort":         ...; break;
 *     case "schema-failed": ...; break;
 *     default: assertNeverClassifyFailureKind(result.kind);
 *   }
 *
 * If a future change adds a 5th kind without updating the switch, tsc
 * fails at the `default:` site rather than letting the case silently
 * fall through.
 */
export function assertNeverClassifyFailureKind(kind: never): never {
  throw new Error(`Unhandled ClassifyFailureKind: ${String(kind)}`);
}

// ---------------------------------------------------------------------------
// Default deps factory (lazy)
// ---------------------------------------------------------------------------

let cachedDefaultDeps: ClassifyDeps | null = null;

/**
 * Build the default deps. Reads the prompt source from
 * `pipeline/prompts/intent-classifier-system.md` synchronously via
 * `Bun.file().text()` on first call. Reads the env var
 * `ANTHROPIC_API_KEY` indirectly through `createAnthropicClient()`.
 * Cached after first call so repeated `classify()` invocations share a
 * single client.
 *
 * Throws if `ANTHROPIC_API_KEY` is missing OR the prompt source file is
 * missing. These are configuration errors at the dev workstation level;
 * surfacing them as throws (not a `kind: "transport"` return) is
 * intentional — the caller is wrong, no recovery is meaningful.
 */
export async function defaultClassifyDeps(): Promise<ClassifyDeps> {
  if (cachedDefaultDeps !== null) return cachedDefaultDeps;
  const systemPromptSource = await Bun.file(SYSTEM_PROMPT_PATH).text();
  cachedDefaultDeps = {
    client: createAnthropicClient(),
    systemPromptSource,
    model: DEFAULT_MODEL,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
  return cachedDefaultDeps;
}

// ---------------------------------------------------------------------------
// JSON-schema (v3 zod compatible)
// ---------------------------------------------------------------------------

/**
 * Pre-compute the JSON Schema once per process.
 *
 * Mirrors the Unit 3 pattern: the Anthropic SDK's `zodOutputFormat`
 * helper expects a Zod v4 schema; the project pins `zod^3`. We
 * construct the equivalent `AutoParseableOutputFormat` ourselves using
 * `zod-to-json-schema` for the wire schema and our v3 schema's
 * `safeParse` for the parse step.
 *
 * **Replicate the downstream pipeline before matching.** The SDK applies
 * `transformJSONSchema()` to whatever the user passes — folding
 * unsupported constraints (like `minimum`/`maximum` on numbers, regex
 * patterns, `minLength`/`enum` violations on strings) into a free-text
 * description string, and forcing `additionalProperties: false` on every
 * object. We do the same here so the wire schema is what Anthropic's
 * structured-output endpoint actually accepts. Without this, the
 * `confidence: z.number().min(0).max(1)` constraint fails with
 * `400 invalid_request_error: For 'number' type, property 'minimum' is
 * not supported.`
 *
 * `name` is intentionally OMITTED so zodToJsonSchema returns the schema
 * inline at the top level (no `$ref`). The SDK's `transformJSONSchema`
 * short-circuits on `$ref` and would not strip the unsupported
 * constraints inside the referenced definition; passing the inline
 * shape is the only way to get the transformation applied.
 */
const CLASSIFY_JSON_SCHEMA_RAW = zodToJsonSchema(IntentClassificationSchema, {
  $refStrategy: "none",
  target: "jsonSchema2019-09",
});
const CLASSIFY_JSON_SCHEMA = transformJSONSchema(
  CLASSIFY_JSON_SCHEMA_RAW as { [key: string]: unknown },
);

/**
 * Build the `output_config.format` shape the SDK expects for structured
 * output. Thin module-local wrapper around the shared `makeOutputFormat`
 * in `sdk-helpers.ts`, parameterized with this module's Zod schema +
 * pre-transformed wire schema.
 */
function makeOutputFormat(): StructuredOutputFormat<IntentClassification> {
  return makeStructuredOutputFormat(
    IntentClassificationSchema,
    CLASSIFY_JSON_SCHEMA as { [key: string]: unknown },
  );
}

// ---------------------------------------------------------------------------
// Failure-kind mapping (SDK throw → kind literal)
// ---------------------------------------------------------------------------
//
// `extractMessage`, `extractZodIssues`, `isStructuredOutputParseError`
// live in `./sdk-helpers.ts` and are imported above. The kind-mapper
// stays LOCAL because the failure-kind union differs from generate
// (4 vs 5 literals).

/**
 * Map an SDK throw to a `ClassifyFailureKind`. Distinct from the
 * structured-output Zod-parse case which is handled inline (it directly
 * surfaces as `schema-failed` with no retry).
 *
 * Distinguishing "transport" (no response received) from "sdk-error"
 * (got a response, SDK retried out): `APIConnectionError` is the
 * transport class; `APIError` with a status is sdk-error.
 */
function mapSdkErrorToKind(err: unknown): ClassifyFailureKind {
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

function toClassifyUsage(usage: SdkUsage): ClassifyUsage {
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
 * Build a classifier closure. Pure: no env reads, no file I/O. The
 * closure performs at most 1 model call per invocation (no auto-repair).
 *
 * Production callers use `classify()` which lazily wraps
 * `defaultClassifyDeps()`; tests call this directly with mock deps.
 *
 * **No `cache_control` is set anywhere.** The system prompt is passed
 * as a single string (not a multi-block array) and the messages array
 * carries only the user prompt. Any future contributor adding
 * `cache_control` here will fail the `usage.cache_*_input_tokens === 0`
 * integration test.
 */
export function buildClassifier(
  deps: ClassifyDeps,
): (prompt: string, opts?: { signal?: AbortSignal }) => Promise<ClassifyResult> {
  return async function classifyInner(
    prompt: string,
    innerOpts: { signal?: AbortSignal } = {},
  ): Promise<ClassifyResult> {
    // ---- Input-validation guards (THROW; no recovery is meaningful) ----
    if (prompt === "") {
      throw new Error("empty prompt");
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new Error(`prompt exceeds ${MAX_PROMPT_CHARS} chars`);
    }

    const outputFormat = makeOutputFormat();

    // ---- Single attempt (no auto-repair) -------------------------------
    try {
      const response = await deps.client.messages.parse(
        {
          model: deps.model,
          max_tokens: deps.maxTokens,
          // Single-string system prompt — NO cache_control, NO multi-block.
          // The header in `intent-classifier-system.md` documents why.
          system: deps.systemPromptSource,
          messages: [{ role: "user", content: prompt }],
          output_config: { format: outputFormat },
        },
        innerOpts.signal !== undefined
          ? { signal: innerOpts.signal }
          : undefined,
      );

      if (response.parsed_output !== null) {
        const parsed = response.parsed_output;
        return {
          ok: true,
          archetype_id: parsed.archetype_id,
          confidence: parsed.confidence,
          reasoning: parsed.reasoning,
          usage: toClassifyUsage(response.usage),
        };
      }

      // No parsed_output: defensive sdk-error. Truncation is NOT a
      // distinct kind here — see file-header rationale. If the SDK
      // returns a response with no parsed_output, surface as sdk-error
      // with the stop_reason for diagnosis.
      return {
        ok: false,
        severity: "red",
        kind: "sdk-error",
        message:
          "Haiku returned no parsed_output (the SDK's structured-output flow did not surface a parsed object)",
        errors: [`stop_reason=${String(response.stop_reason)}`],
      };
    } catch (err) {
      if (isStructuredOutputParseError(err)) {
        const issues = extractZodIssues(err);
        return {
          ok: false,
          severity: "red",
          kind: "schema-failed",
          message:
            "Haiku output failed schema validation (no auto-repair on classify)",
          errors: issues.length > 0 ? issues : [extractMessage(err)],
        };
      }
      const kind = mapSdkErrorToKind(err);
      return {
        ok: false,
        severity: "red",
        kind,
        message:
          kind === "abort"
            ? "classify aborted"
            : kind === "transport"
              ? `anthropic-sdk transport error: ${extractMessage(err)}`
              : `anthropic-sdk error: ${extractMessage(err)}`,
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
 * `defaultClassifyDeps()` on first invocation; subsequent calls reuse
 * the cached deps. Tests should NOT use this — they should call
 * `buildClassifier(mockDeps)` directly.
 *
 * The `opts.deps` partial-override is provided so ad-hoc smoke scripts
 * can override the model name or maxTokens without rewriting the
 * default-deps factory.
 */
export async function classify(
  prompt: string,
  opts: ClassifyOptions = {},
): Promise<ClassifyResult> {
  const base = await defaultClassifyDeps();
  const deps: ClassifyDeps =
    opts.deps !== undefined ? { ...base, ...opts.deps } : base;
  const inner = buildClassifier(deps);
  return inner(
    prompt,
    opts.signal !== undefined ? { signal: opts.signal } : {},
  );
}
