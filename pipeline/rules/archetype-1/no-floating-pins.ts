/**
 * no-floating-pins — every non-passive non-power pin on every emitted
 * non-MCU component appears in `connections[]`. Catches the LLM emitting
 * a sensor without wiring its trig pin, etc.
 *
 * Why red: a floating signal pin produces nondeterministic behavior on a
 * real board (CMOS inputs latch onto noise). For beginner projects this
 * looks like "the sensor reports random distances" with no clear cause.
 *
 * Scope: applied to sensors, actuators, displays. NOT applied to MCUs
 * (the Uno has 30+ pins; most go unused on archetype 1) or passives.
 */

import type { VolteuxProjectDocument } from "../../../schemas/document.zod.ts";
import type { Rule, RuleResult } from "../../types.ts";
import { lookupBySku, type ComponentType } from "../../../components/registry.ts";

const TYPES_TO_CHECK: ReadonlyArray<ComponentType> = [
  "sensor",
  "actuator",
  "display",
];

/**
 * Pin directions whose absence in connections[] is acceptable. `passive` pins
 * (e.g., decorative or NC pins) genuinely don't need wiring. `ground` was
 * previously also skipped, but that left ungrounded sensors passing all
 * checks (review finding ADV-005 / COR-004) — a CMOS input with no ground
 * reference floats nondeterministically. `ground` is now REQUIRED.
 */
const SKIPPABLE_DIRECTIONS = new Set(["passive"]);

export const noFloatingPinsRule: Rule<VolteuxProjectDocument> = {
  id: "no-floating-pins",
  severity: "red",
  description:
    "Every signal pin on a sensor/actuator/display appears in connections[]",
  check(doc): RuleResult {
    const usedPins = new Set<string>();
    for (const conn of doc.connections) {
      usedPins.add(`${conn.from.component_id}:${conn.from.pin_label}`);
      usedPins.add(`${conn.to.component_id}:${conn.to.pin_label}`);
    }

    const floating: string[] = [];
    for (const c of doc.components) {
      const entry = lookupBySku(c.sku);
      if (!entry) continue;
      if (!TYPES_TO_CHECK.includes(entry.type)) continue;
      for (const pin of entry.pin_metadata) {
        if (SKIPPABLE_DIRECTIONS.has(pin.direction)) continue;
        if (!usedPins.has(`${c.id}:${pin.label}`)) {
          floating.push(`${c.id} (${entry.name}).${pin.label}`);
        }
      }
    }

    if (floating.length > 0) {
      return {
        passed: false,
        severity: "red",
        message: `Floating pin(s) on sensors/actuators: ${floating.join(", ")}. Every signal pin must be connected.`,
        context: { floating_pins: floating },
      };
    }
    return { passed: true };
  },
};
