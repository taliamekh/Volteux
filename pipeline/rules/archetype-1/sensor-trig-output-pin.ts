/**
 * sensor-trig-output-pin — the HC-SR04's Trig pin must connect to a
 * digital pin on the MCU. The Arduino sketch will configure that pin as
 * OUTPUT and pulse it HIGH for 10µs to fire the chirp.
 *
 * Why red: connecting Trig to an analog-only pin (none on the Uno; A6/A7
 * on Nano variants) means the sketch can't drive it. Connecting to a
 * power rail leaves the sensor permanently triggered (gibberish output).
 */

import type { VolteuxProjectDocument } from "../../../schemas/document.zod.ts";
import type { Rule, RuleResult } from "../../types.ts";
import { lookupBySku } from "../../../components/registry.ts";

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
        const component = doc.components.find(
          (c) => c.id === endpoint.component_id,
        );
        if (!component || component.sku !== HC_SR04_SKU) continue;
        if (endpoint.pin_label !== "Trig") continue;

        const otherComponent = doc.components.find(
          (c) => c.id === otherEndpoint.component_id,
        );
        if (!otherComponent) continue;
        const otherEntry =
          lookupBySku(otherComponent.sku);
        if (!otherEntry || otherEntry.type !== "mcu") continue;
        const otherPin = otherEntry.pin_metadata.find(
          (p) => p.label === otherEndpoint.pin_label,
        );
        if (!otherPin) continue;

        if (!VALID_OUTPUT_DIRECTIONS.has(otherPin.direction)) {
          return {
            passed: false,
            severity: "red",
            message: `HC-SR04 Trig is connected to Uno pin ${otherEndpoint.pin_label}, which is ${otherPin.direction}. Trig must connect to a digital pin (the sketch will set it OUTPUT and pulse HIGH).`,
            context: {
              sensor_id: component.id,
              connected_to: otherEndpoint.pin_label,
              direction: otherPin.direction,
            },
          };
        }
      }
    }
    return { passed: true };
  },
};
