/**
 * Shared SDK helpers for `pipeline/llm/generate.ts` and
 * `pipeline/llm/classify.ts`.
 *
 * These helpers were originally duplicated byte-for-byte across the two
 * modules. The bodies are structurally identical; only the schema types
 * and the per-module failure-kind unions differ. The kind-mapper stays
 * LOCAL to each module (`mapSdkErrorToKind`) because the literal sets
 * differ (5 vs 4); everything else lives here.
 *
 * **Logger discipline.** Do not log the Authorization header, the API
 * key, or `process.env`. None of the helpers here log; if a future
 * contributor adds logging, redact secrets first.
 */

import { AnthropicError } from "@anthropic-ai/sdk";
import { transformJSONSchema } from "@anthropic-ai/sdk/lib/transform-json-schema.js";
import type { ZodIssue, ZodSchema } from "zod";

// ---------------------------------------------------------------------------
// Usage extraction shared shape
// ---------------------------------------------------------------------------

/**
 * The subset of the Anthropic SDK `Usage` shape both `generate` and
 * `classify` consume. Mirrors the SDK's nullable cache fields; callers
 * normalize null → 0 in their per-module `to{Generate,Classify}Usage`.
 */
export interface SdkUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/** Best-effort message extraction. Falls back to `String(err)`. */
export function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * The exact prefix the SDK uses when wrapping our `outputFormat.parse`
 * throws. Sourced verbatim from
 * `node_modules/@anthropic-ai/sdk/lib/parser.js`:
 *
 *   throw new AnthropicError(`Failed to parse structured output: ${error}`);
 *
 * The prefix is part of an upstream SDK contract that has no typed
 * carrier class as of `@anthropic-ai/sdk@0.91.1` (verified by reading
 * `node_modules/@anthropic-ai/sdk/core/error.d.ts` — only `AnthropicError`,
 * `APIError`, and HTTP-status-specific subclasses exist; no
 * `StructuredOutputParseError` or similar).
 *
 * Defense-in-depth this string detection requires:
 *   1. **Pin `~0.91.1`** in `package.json` (not `^0.91.1`). The tilde
 *      range allows patch upgrades only (0.91.x) — no surprise minor
 *      bump that could change the wrapper string.
 *   2. **Regression test** in `tests/llm/sdk-helpers.test.ts`
 *      constructs a real `AnthropicError` with this exact prefix and
 *      asserts `isStructuredOutputParseError` returns true. A future
 *      SDK that changes the prefix would still pass tsc but fail this
 *      test — visible breakage.
 *   3. **Layer 1 (instanceof) when available.** If a future SDK ships a
 *      typed `StructuredOutputParseError` class, switch the body to
 *      prefer `err instanceof StructuredOutputParseError` first and
 *      fall back to the prefix check. Today only the prefix-string
 *      detection exists.
 */
const STRUCTURED_OUTPUT_PARSE_ERROR_PREFIX =
  "Failed to parse structured output";

/**
 * Detect whether a thrown value is the "JSON.parse failed" or "Zod
 * safeParse failed" path produced by `makeOutputFormat().parse`. See
 * `STRUCTURED_OUTPUT_PARSE_ERROR_PREFIX` for the upstream contract and
 * the defense-in-depth measures (version pin + regression test) that
 * back this detection.
 */
export function isStructuredOutputParseError(err: unknown): boolean {
  // Layer 1 — typed class check. Today the SDK has no typed
  // `StructuredOutputParseError`; if a future SDK introduces one, the
  // `instanceof` check should go HERE before the prefix fallback.
  // Leaving this comment as a guidepost for the next contributor.
  if (err instanceof AnthropicError) {
    return err.message.startsWith(STRUCTURED_OUTPUT_PARSE_ERROR_PREFIX);
  }
  return false;
}

/**
 * Type guard: does `value` look like a `ZodIssue`? We only check the two
 * fields the auto-repair turn reads (`path: unknown[]`, `message: string`).
 * The full ZodIssue surface includes more fields (`code`, `expected`,
 * etc.) but the runtime treatment of any mismatch is harmless — issues
 * are rendered as bullet points in the repair prompt.
 */
function isZodIssueLike(value: unknown): value is ZodIssue {
  if (value === null || typeof value !== "object") return false;
  const v = value as { path?: unknown; message?: unknown };
  return Array.isArray(v.path) && typeof v.message === "string";
}

/**
 * Best-effort extraction of the ZodIssue array from an
 * `AnthropicError("Failed to parse structured output: ...")`. The SDK
 * captures the inner Error in `error.cause` (Node Error.cause), so we
 * unwrap one level. Returns `[]` if the cause is not a ZodError shape.
 *
 * Each candidate element is type-guarded via `isZodIssueLike` rather than
 * cast en masse — the previous version cast `unknown[]` straight to
 * `ZodIssue[]` and would have surfaced a stray non-ZodIssue element only
 * at render time.
 */
export function extractZodIssues(err: unknown): ReadonlyArray<ZodIssue> {
  if (!(err instanceof Error)) return [];
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause === undefined || cause === null) return [];
  // ZodError has `.issues: ZodIssue[]`. Accept either the inner Error we
  // constructed in `makeOutputFormat().parse` (whose cause IS the
  // ZodError) or a direct ZodError thrown.
  const direct = (cause as { issues?: unknown }).issues;
  if (Array.isArray(direct)) {
    return direct.filter(isZodIssueLike);
  }
  const causeOfCause = (cause as { cause?: unknown }).cause;
  if (causeOfCause !== undefined && causeOfCause !== null) {
    const inner = (causeOfCause as { issues?: unknown }).issues;
    if (Array.isArray(inner)) {
      return inner.filter(isZodIssueLike);
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Output-format builder (shared body, per-module schema)
// ---------------------------------------------------------------------------

/**
 * The shape `client.messages.parse` expects for `output_config.format`.
 * Generic over the Zod-parsed return type so each caller (generate,
 * classify) keeps its precise inferred type at the boundary.
 */
export interface StructuredOutputFormat<T> {
  type: "json_schema";
  schema: { [key: string]: unknown };
  parse: (content: string) => T;
}

/**
 * Build the `output_config.format` shape. `wireSchema` is the
 * already-`transformJSONSchema`-transformed JSON-Schema object the SDK
 * uses for the wire request. `schema` is the Zod v3 schema we run
 * `safeParse` against (since the SDK's helper expects v4).
 *
 * The SDK throws `AnthropicError("Failed to parse structured output:
 * ...")` when this `parse` throws. The `cause` field carries the original
 * Zod error so `extractZodIssues` can read it.
 */
export function makeOutputFormat<T>(
  schema: ZodSchema<T>,
  wireSchema: { [key: string]: unknown },
): StructuredOutputFormat<T> {
  return {
    type: "json_schema",
    schema: wireSchema,
    parse: (content: string) => {
      let raw: unknown;
      try {
        raw = JSON.parse(content);
      } catch (err) {
        const e = new Error(
          `Failed to JSON.parse model output: ${(err as Error).message}`,
        );
        // Preserve cause so the catcher can read it.
        (e as Error & { cause?: unknown }).cause = err;
        throw e;
      }
      const result = schema.safeParse(raw);
      if (!result.success) {
        const e = new Error(
          `Zod validation failed: ${result.error.issues.length} issue(s)`,
        );
        (e as Error & { cause?: unknown }).cause = result.error;
        throw e;
      }
      return result.data;
    },
  };
}

// Re-export `transformJSONSchema` so callers don't need to re-import the
// SDK's lib path.
export { transformJSONSchema };
