/**
 * voltage-match — every component's `power_in` pin is connected to a board
 * pin supplying the right voltage (within ±10%).
 *
 * Why red: powering a 3.3V-only sensor from a 5V rail can damage the sensor;
 * powering a 5V sensor from a 3.3V rail typically results in undefined
 * behavior (sensor doesn't respond, no clear error).
 *
 * Datasheet: ATmega328P (Uno) supplies 5V (USB-powered) and 3.3V; both have
 * a stated tolerance of ±5% under nominal load.
 */

import type { VolteuxProjectDocument } from "../../../schemas/document.zod.ts";
import type { Rule, RuleResult } from "../../types.ts";
import { lookupBySku } from "../../../components/registry.ts";

const VOLTAGE_TOLERANCE = 0.1; // ±10% — accommodates measurement noise + LDO drop

export const voltageMatchRule: Rule<VolteuxProjectDocument> = {
  id: "voltage-match",
  severity: "red",
  description:
    "Every component's power_in pin connects to a board pin at the correct voltage (±10%)",
  check(doc): RuleResult {
    for (const conn of doc.connections) {
      // Look at both endpoints; either could be the power_in side
      for (const [endpoint, otherEndpoint] of [
        [conn.from, conn.to],
        [conn.to, conn.from],
      ] as const) {
        const component = doc.components.find(
          (c) => c.id === endpoint.component_id,
        );
        if (!component) continue;
        const entry = lookupBySku(component.sku);
        if (!entry) continue;
        const pin = entry.pin_metadata.find((p) => p.label === endpoint.pin_label);
        if (!pin || pin.direction !== "power_in" || pin.voltage === undefined) {
          continue;
        }

        // The other endpoint must be a board pin supplying compatible voltage
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
        if (!otherPin || otherPin.voltage === undefined) continue;

        const expected = pin.voltage;
        const supplied = otherPin.voltage;
        if (Math.abs(expected - supplied) / expected > VOLTAGE_TOLERANCE) {
          return {
            passed: false,
            severity: "red",
            message: `Voltage mismatch: ${endpoint.component_id} (${entry.name}) needs ${expected}V on ${endpoint.pin_label}, but is connected to ${otherEndpoint.component_id} ${otherEndpoint.pin_label} which supplies ${supplied}V`,
            context: {
              component_id: endpoint.component_id,
              expected_v: expected,
              supplied_v: supplied,
            },
          };
        }
      }
    }
    return { passed: true };
  },
};
