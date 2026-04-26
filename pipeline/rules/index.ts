/**
 * Rules engine — runs a set of registered Rule<VolteuxProjectDocument>
 * instances over a parsed document and aggregates results by severity.
 *
 * Severity model (see pipeline/types.ts and origin doc § Definitions):
 *   - red   = blocks the pipeline; orchestrator routes to Honest Gap
 *   - amber = surfaces as a warning attached to the final document; non-blocking
 *   - blue  = info-level note; non-blocking
 *
 * Severity-locking discipline: once shipped, severity assignments are
 * locked. Any downgrade during weeks 3-4 requires a SEVERITY DOWNGRADED
 * comment in the rule file PLUS an entry in pipeline/rules/CHANGELOG.md.
 * Without this, the acceptance gate becomes self-validating (Kai writes
 * the rules + the prompts; downgrading a stuck rule is the path of least
 * resistance to "passing"). See plan Risks table.
 */

import type {
  VolteuxProjectDocument,
} from "../../schemas/document.zod.ts";
import type { Rule, RuleResult, Severity } from "../types.ts";

import { voltageMatchRule } from "./archetype-1/voltage-match.ts";
import { currentBudgetRule } from "./archetype-1/current-budget.ts";
import { breadboardRailDisciplineRule } from "./archetype-1/breadboard-rail-discipline.ts";
import { noFloatingPinsRule } from "./archetype-1/no-floating-pins.ts";
import { wireColorDisciplineRule } from "./archetype-1/wire-color-discipline.ts";
import { pinUniquenessRule } from "./archetype-1/pin-uniqueness.ts";
import { servoPwmPinRule } from "./archetype-1/servo-pwm-pin.ts";
import { sensorTrigOutputPinRule } from "./archetype-1/sensor-trig-output-pin.ts";
import { sensorEchoInputPinRule } from "./archetype-1/sensor-echo-input-pin.ts";
import { sketchReferencesPinsRule } from "./archetype-1/sketch-references-pins.ts";
import { noV15FieldsOnArchetype1Rule } from "./archetype-1/no-v15-fields-on-archetype-1.ts";

/** The canonical archetype-1 rule set. */
export const ARCHETYPE_1_RULES: ReadonlyArray<Rule<VolteuxProjectDocument>> = [
  voltageMatchRule,
  currentBudgetRule,
  breadboardRailDisciplineRule,
  noFloatingPinsRule,
  wireColorDisciplineRule,
  pinUniquenessRule,
  servoPwmPinRule,
  sensorTrigOutputPinRule,
  sensorEchoInputPinRule,
  sketchReferencesPinsRule,
  noV15FieldsOnArchetype1Rule,
];

export interface RuleAttempt {
  rule: Rule<VolteuxProjectDocument>;
  result: RuleResult;
}

export interface RulesRunOutcome {
  red: ReadonlyArray<RuleAttempt>;
  amber: ReadonlyArray<RuleAttempt>;
  blue: ReadonlyArray<RuleAttempt>;
  /** All rules that ran (passed + failed), useful for trace logging. */
  attempts: ReadonlyArray<RuleAttempt>;
}

/**
 * Run a rule set over a document. Returns failures bucketed by severity
 * for the orchestrator to act on (red → Honest Gap; amber/blue → warnings
 * attached to the final document).
 *
 * Pure function. Each rule's check() must also be pure.
 */
export function runRules(
  doc: VolteuxProjectDocument,
  rules: ReadonlyArray<Rule<VolteuxProjectDocument>> = ARCHETYPE_1_RULES,
): RulesRunOutcome {
  const attempts: RuleAttempt[] = rules.map((rule) => ({
    rule,
    result: rule.check(doc),
  }));

  const red: RuleAttempt[] = [];
  const amber: RuleAttempt[] = [];
  const blue: RuleAttempt[] = [];

  for (const attempt of attempts) {
    if (attempt.result.passed) continue;
    bucketBySeverity(attempt.result.severity, attempt, red, amber, blue);
  }

  return { red, amber, blue, attempts };
}

function bucketBySeverity(
  severity: Severity,
  attempt: RuleAttempt,
  red: RuleAttempt[],
  amber: RuleAttempt[],
  blue: RuleAttempt[],
): void {
  switch (severity) {
    case "red":
      red.push(attempt);
      break;
    case "amber":
      amber.push(attempt);
      break;
    case "blue":
      blue.push(attempt);
      break;
  }
}
