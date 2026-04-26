/**
 * pin-uniqueness — no MCU digital/analog/PWM pin is referenced by more
 * than one connection (excluding GND, 5V, 3.3V, GND2 which are designed
 * to fan out to multiple consumers).
 *
 * Why red: assigning two output signals to the same MCU pin is electrically
 * destructive (each driver fights the other). For inputs, only one device
 * can drive the pin at a time.
 */

import type { VolteuxProjectDocument } from "../../../schemas/document.zod.ts";
import type { Rule, RuleResult } from "../../types.ts";
import { lookupBySku } from "../../../components/registry.ts";

const FANOUT_PINS = new Set(["GND", "GND2", "5V", "3.3V"]);

export const pinUniquenessRule: Rule<VolteuxProjectDocument> = {
  id: "pin-uniqueness",
  severity: "red",
  description:
    "No MCU signal pin (digital/analog/PWM) appears in more than one connection",
  check(doc): RuleResult {
    const mcuPinUsage = new Map<string, string[]>();

    for (const conn of doc.connections) {
      for (const endpoint of [conn.from, conn.to] as const) {
        const component = doc.components.find(
          (c) => c.id === endpoint.component_id,
        );
        if (!component) continue;
        const entry = lookupBySku(component.sku);
        if (!entry || entry.type !== "mcu") continue;
        if (FANOUT_PINS.has(endpoint.pin_label)) continue;

        const key = `${component.id}:${endpoint.pin_label}`;
        const otherEndpoint =
          endpoint === conn.from ? conn.to : conn.from;
        const summary = `${otherEndpoint.component_id}.${otherEndpoint.pin_label}`;
        const existing = mcuPinUsage.get(key);
        if (existing) {
          existing.push(summary);
        } else {
          mcuPinUsage.set(key, [summary]);
        }
      }
    }

    const dupes: string[] = [];
    for (const [pinKey, consumers] of mcuPinUsage) {
      if (consumers.length > 1) {
        dupes.push(`${pinKey} → [${consumers.join(", ")}]`);
      }
    }

    if (dupes.length > 0) {
      return {
        passed: false,
        severity: "red",
        message: `MCU pin double-assignment: ${dupes.join("; ")}. Each signal pin can only drive one consumer.`,
        context: { duplicates: dupes },
      };
    }
    return { passed: true };
  },
};
