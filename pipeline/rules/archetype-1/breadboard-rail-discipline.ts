/**
 * breadboard-rail-discipline — connections to GND and to a single supply
 * voltage (5V or 3.3V) should each consolidate at the breadboard rails
 * rather than fan out from the board to each component independently.
 *
 * Why blue: cosmetic but worth noting. Beginners often run individual
 * GND wires from each sensor back to the Uno; consolidating to the GND
 * rail keeps the breadboard tidier and is a habit worth instilling.
 *
 * v0.1 implementation note: the runtime JSON doesn't carry rail topology;
 * we approximate by counting how many GND connections originate from
 * different "non-board ground" sources. If 3+ GND connections all land
 * on board GND pins independently, suggest a rail.
 */

import type { VolteuxProjectDocument } from "../../../schemas/document.zod.ts";
import type { Rule, RuleResult } from "../../types.ts";
import { lookupBySku } from "../../../components/registry.ts";

const RAIL_SUGGESTION_THRESHOLD = 3;

export const breadboardRailDisciplineRule: Rule<VolteuxProjectDocument> = {
  id: "breadboard-rail-discipline",
  severity: "blue",
  description:
    "Suggest using the breadboard's power/ground rails when 3+ components need the same supply or ground",
  check(doc): RuleResult {
    let groundConns = 0;
    let supplyConns = 0;

    for (const conn of doc.connections) {
      for (const endpoint of [conn.from, conn.to] as const) {
        const component = doc.components.find(
          (c) => c.id === endpoint.component_id,
        );
        if (!component) continue;
        const entry = lookupBySku(component.sku);
        if (!entry || entry.type !== "mcu") continue;
        if (endpoint.pin_label === "GND" || endpoint.pin_label === "GND2") {
          groundConns++;
        } else if (endpoint.pin_label === "5V" || endpoint.pin_label === "3.3V") {
          supplyConns++;
        }
      }
    }

    if (
      groundConns >= RAIL_SUGGESTION_THRESHOLD ||
      supplyConns >= RAIL_SUGGESTION_THRESHOLD
    ) {
      return {
        passed: false,
        severity: "blue",
        message: `Several connections land on the board's power/ground pins (${supplyConns} supply, ${groundConns} ground). Consider running one wire from the board to a breadboard rail and using the rail to fan out — it's tidier and more reliable.`,
        context: { ground_conns: groundConns, supply_conns: supplyConns },
      };
    }
    return { passed: true };
  },
};
