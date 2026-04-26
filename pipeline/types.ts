/**
 * Shared types for gates, rules, and the pipeline orchestrator.
 *
 * Single types file (not split per-concern) for v0.1 — gates and rules
 * share Severity and the result shape. If divergence appears in v0.2+,
 * splitting is cheap.
 */

import type { ZodIssue } from "zod";

/**
 * Three-tier severity per origin doc § Definitions.
 *
 * - `red`   = blocks the pipeline; routes to Honest Gap (after retry where applicable)
 * - `amber` = surfaces as a warning on the final document; does NOT block
 * - `blue`  = info-level note; does NOT block
 */
export type Severity = "red" | "amber" | "blue";

/**
 * Discriminated-union result type returned by every gate.
 *
 * Gates that produce a parsed value on success (e.g., the schema gate)
 * carry the value in the `ok: true` variant.
 */
export type GateResult<TValue = void> =
  | { ok: true; value: TValue }
  | {
      ok: false;
      severity: Severity;
      /** Human-readable summary of the failure (used in trace events). */
      message: string;
      /**
       * Structured errors fed back to the LLM by the auto-repair retry helper.
       * Schema gate uses ZodIssue[]; other gates use string[] for arbitrary detail.
       */
      errors: ReadonlyArray<ZodIssue> | ReadonlyArray<string>;
    };

/** Per-rule outcome. Aggregated by `pipeline/rules/index.ts`. */
export type RuleResult =
  | { passed: true }
  | {
      passed: false;
      severity: Severity;
      message: string;
      /** Optional structured context (e.g., the offending pin id, voltage values). */
      context?: Readonly<Record<string, unknown>>;
    };

/** A registered rule. See `pipeline/rules/index.ts` for the runner shape. */
export interface Rule<TInput> {
  /** Stable identifier — used in trace events and as the test file name. */
  readonly id: string;
  /** The severity this rule emits when it fails. */
  readonly severity: Severity;
  /** One-line summary of what the rule checks (used in error messages). */
  readonly description: string;
  /** Pure function. No side effects. */
  check(input: TInput): RuleResult;
}
