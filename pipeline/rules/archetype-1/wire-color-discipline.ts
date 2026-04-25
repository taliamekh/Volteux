/**
 * wire-color-discipline — power connections use red wires; ground
 * connections use black wires. Other connections may use any color.
 *
 * Why amber: works either way electrically, but breaks beginner mental
 * models when a black wire turns out to be carrying signal. The convention
 * is universal in electronics tutorials and Adafruit guides.
 */

import type { VolteuxProjectDocument } from "../../../schemas/document.zod.ts";
import type { Rule, RuleResult } from "../../types.ts";
import { lookupBySku } from "../../../components/registry.ts";

export const wireColorDisciplineRule: Rule<VolteuxProjectDocument> = {
  id: "wire-color-discipline",
  severity: "amber",
  description:
    "Power connections use red, ground connections use black; signal/data lines may use any color",
  check(doc): RuleResult {
    const violations: string[] = [];

    for (const conn of doc.connections) {
      // Determine if this connection is power, ground, or signal
      let isPower = false;
      let isGround = false;
      for (const endpoint of [conn.from, conn.to] as const) {
        const component = doc.components.find(
          (c) => c.id === endpoint.component_id,
        );
        if (!component) continue;
        const entry = lookupBySku(component.sku);
        if (!entry) continue;
        const pin = entry.pin_metadata.find((p) => p.label === endpoint.pin_label);
        if (!pin) continue;
        if (pin.direction === "power_in" || pin.label === "5V" || pin.label === "3.3V") {
          isPower = true;
        }
        if (pin.direction === "ground") {
          isGround = true;
        }
      }

      if (isPower && conn.wire_color !== undefined && conn.wire_color !== "red") {
        violations.push(
          `power connection ${conn.from.component_id}.${conn.from.pin_label} → ${conn.to.component_id}.${conn.to.pin_label} uses ${conn.wire_color} (should be red)`,
        );
      }
      if (isGround && conn.wire_color !== undefined && conn.wire_color !== "black") {
        violations.push(
          `ground connection ${conn.from.component_id}.${conn.from.pin_label} → ${conn.to.component_id}.${conn.to.pin_label} uses ${conn.wire_color} (should be black)`,
        );
      }
    }

    if (violations.length > 0) {
      return {
        passed: false,
        severity: "amber",
        message: `Wire color convention not followed: ${violations[0]}${violations.length > 1 ? ` (+${violations.length - 1} more)` : ""}`,
        context: { violations },
      };
    }
    return { passed: true };
  },
};
