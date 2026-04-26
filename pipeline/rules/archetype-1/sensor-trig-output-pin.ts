/**
 * sensor-trig-output-pin — the HC-SR04's Trig pin must connect to a digital
 * output-capable pin on the MCU. The Arduino sketch will configure that pin
 * as OUTPUT and pulse it HIGH for 10µs to fire the chirp.
 *
 * Why red: connecting Trig to an analog-only pin (none on the Uno; A6/A7
 * on Nano variants) means the sketch can't drive it. Connecting to a
 * power rail leaves the sensor permanently triggered (gibberish output).
 *
 * COR-003 closure: the rule previously had `if (!otherEntry || otherEntry.type !== "mcu") continue;`
 * which silently accepted Trig wired to a non-MCU component (e.g., another
 * sensor's pin). The "skip" was the bug — the rule's stated invariant is
 * that Trig connects to a digital output pin on the MCU; a non-MCU target
 * trivially fails that invariant and should emit red.
 */

import type { VolteuxProjectDocument } from "../../../schemas/document.zod.ts";
import type { Rule, RuleResult } from "../../types.ts";
import { resolveEndpoint } from "../rule-helpers.ts";

const HC_SR04_SKU = "3942";
const VALID_OUTPUT_DIRECTIONS = new Set([
  "digital_io",
  "digital_output",
  "pwm_output",
]);

export const sensorTrigOutputPinRule: Rule<VolteuxProjectDocument> = {
  id: "sensor-trig-output-pin",
  severity: "red",
  description:
    "HC-SR04 Trig pin connects to a digital-output-capable MCU pin",
  check(doc): RuleResult {
    for (const conn of doc.connections) {
      for (const [endpoint, otherEndpoint] of [
        [conn.from, conn.to],
        [conn.to, conn.from],
      ] as const) {
        const sensor = resolveEndpoint(doc, endpoint);
        if (!sensor || sensor.component.sku !== HC_SR04_SKU) continue;
        if (endpoint.pin_label !== "Trig") continue;

        const target = resolveEndpoint(doc, otherEndpoint);
        if (!target) continue; // cross-consistency check (b) catches this

        // COR-003 — Trig MUST land on an MCU. Trig wired to a sensor or
        // actuator pin (e.g., HC-SR04.Trig → SG90.Signal) trivially can't
        // be driven OUTPUT by the sketch.
        if (target.entry.type !== "mcu") {
          return {
            passed: false,
            severity: "red",
            message: `HC-SR04 Trig (${endpoint.component_id}) must connect to a digital-output pin on the Uno, not to ${otherEndpoint.component_id}.${otherEndpoint.pin_label} (${target.entry.name}, type ${target.entry.type})`,
            context: {
              sensor_id: endpoint.component_id,
              connected_to: otherEndpoint.component_id,
              connected_pin: otherEndpoint.pin_label,
              target_type: target.entry.type,
            },
          };
        }

        if (!target.pin) continue; // cross-consistency check (c) catches this

        if (!VALID_OUTPUT_DIRECTIONS.has(target.pin.direction)) {
          return {
            passed: false,
            severity: "red",
            message: `HC-SR04 Trig is connected to Uno pin ${otherEndpoint.pin_label}, which is ${target.pin.direction}. Trig must connect to a digital pin (the sketch will set it OUTPUT and pulse HIGH).`,
            context: {
              sensor_id: endpoint.component_id,
              connected_to: otherEndpoint.pin_label,
              direction: target.pin.direction,
            },
          };
        }
      }
    }
    return { passed: true };
  },
};
