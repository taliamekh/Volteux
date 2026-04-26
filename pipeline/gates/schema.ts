/**
 * Gate 1 — Schema gate.
 *
 * Wraps `VolteuxProjectDocumentSchema.safeParse()` in the `GateResult`
 * shape used by the orchestrator. On failure, returns ZodIssues verbatim
 * so the auto-repair retry helper (`pipeline/repair.ts`, Unit 9) can feed
 * them back to the LLM.
 *
 * Severity is always `red` for schema failures — the document is malformed
 * and cannot be passed downstream regardless of intent.
 */

import {
  VolteuxProjectDocumentSchema,
  type VolteuxProjectDocument,
} from "../../schemas/document.zod.ts";
import type { GateResult } from "../types.ts";

/**
 * Parse arbitrary input through the schema. Returns a typed document on
 * success or a structured failure carrying ZodIssues on rejection.
 *
 * Pure function — does not log, throw, or mutate. The orchestrator and
 * trace writer handle observability.
 */
export function runSchemaGate(
  input: unknown,
): GateResult<VolteuxProjectDocument> {
  const result = VolteuxProjectDocumentSchema.safeParse(input);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return {
    ok: false,
    severity: "red",
    message: summarizeIssues(result.error.issues),
    errors: result.error.issues,
  };
}

/**
 * One-line summary of the first ~3 issues. Used in trace events and
 * in the orchestrator's Honest Gap message when the gate exhausts retries.
 */
function summarizeIssues(
  issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>,
): string {
  const top = issues.slice(0, 3).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
    return `${path}: ${issue.message}`;
  });
  const rest = issues.length > 3 ? ` (+${issues.length - 3} more)` : "";
  return `Schema validation failed: ${top.join("; ")}${rest}`;
}
