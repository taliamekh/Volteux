/**
 * current-budget — sum of current draw across components powered by the
 * board's 5V rail does not exceed the board's source limit.
 *
 * Why amber: Uno's onboard 5V rail can source ~500mA from USB; archetype 1
 * (HC-SR04 ~15mA + servo SG90 ~150mA peak) lands well under. But projects
 * pushing close to the limit work intermittently — better to flag.
 *
 * Datasheet: Arduino Uno R3 board specs say 500mA max from the 5V rail
 * when USB-powered (PTC fuse trips above this).
 */

import type { VolteuxProjectDocument } from "../../../schemas/document.zod.ts";
import type { Rule, RuleResult } from "../../types.ts";
import { lookupBySku } from "../../../components/registry.ts";

const UNO_5V_RAIL_BUDGET_MA = 500;
const WARNING_THRESHOLD = 0.8; // warn at 80% of budget

export const currentBudgetRule: Rule<VolteuxProjectDocument> = {
  id: "current-budget",
  severity: "amber",
  description:
    "Total current draw on the board's 5V rail stays under 80% of the rail's budget",
  check(doc): RuleResult {
    if (doc.board.type !== "uno") return { passed: true }; // archetype 1 only ships Uno

    let totalCurrentMa = 0;
    const sources: string[] = [];

    for (const conn of doc.connections) {
      // Look for connections that POWER something from the Uno's 5V pin
      for (const [endpoint, otherEndpoint] of [
        [conn.from, conn.to],
        [conn.to, conn.from],
      ] as const) {
        const component = doc.components.find(
          (c) => c.id === endpoint.component_id,
        );
        if (!component) continue;
        const entry = lookupBySku(component.sku);
        if (!entry || entry.type !== "mcu") continue;
        if (endpoint.pin_label !== "5V") continue;

        // Other endpoint draws from the 5V rail
        const otherComponent = doc.components.find(
          (c) => c.id === otherEndpoint.component_id,
        );
        if (!otherComponent) continue;
        const otherEntry =
          lookupBySku(otherComponent.sku);
        if (!otherEntry) continue;
        const otherPin = otherEntry.pin_metadata.find(
          (p) => p.label === otherEndpoint.pin_label,
        );
        if (!otherPin || otherPin.direction !== "power_in") continue;
        if (otherPin.current_ma !== undefined) {
          totalCurrentMa += otherPin.current_ma;
          sources.push(
            `${otherComponent.id} (${otherEntry.name}) ${otherPin.current_ma}mA`,
          );
        }
      }
    }

    const threshold = UNO_5V_RAIL_BUDGET_MA * WARNING_THRESHOLD;
    if (totalCurrentMa > threshold) {
      return {
        passed: false,
        severity: "amber",
        message: `Estimated 5V current draw is ${totalCurrentMa}mA — close to the Uno's ~${UNO_5V_RAIL_BUDGET_MA}mA limit. Sources: ${sources.join(", ")}`,
        context: {
          total_current_ma: totalCurrentMa,
          budget_ma: UNO_5V_RAIL_BUDGET_MA,
          threshold_ma: threshold,
        },
      };
    }
    return { passed: true };
  },
};
