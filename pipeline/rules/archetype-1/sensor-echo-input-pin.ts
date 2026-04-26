/**
 * sensor-echo-input-pin — the HC-SR04's Echo pin must connect to a
 * digital pin on the MCU. The Arduino sketch will configure that pin as
 * INPUT and use pulseIn() to measure how long Echo stays HIGH.
 *
 * Why red: connecting Echo to a power rail or analog-only pin breaks
 * pulseIn(); connecting to a PWM-output pin is OK (PWM pins are also
 * digital inputs) but counterproductive.
 *
 * Note: HC-SR04 Echo pin outputs 5V; the Uno's digital inputs tolerate 5V
 * directly. On 3.3V boards this rule would also need a level shifter check
 * (added in v0.2 for ESP32 archetypes).
 */

import type { VolteuxProjectDocument } from "../../../schemas/document.zod.ts";
import type { Rule, RuleResult } from "../../types.ts";
import { lookupBySku } from "../../../components/registry.ts";

const HC_SR04_SKU = "3942";
const VALID_INPUT_DIRECTIONS = new Set([
  "digital_io",
  "digital_input",
  "pwm_output", // PWM pins double as digital input
]);

export const sensorEchoInputPinRule: Rule<VolteuxProjectDocument> = {
  id: "sensor-echo-input-pin",
  severity: "red",
  description:
    "HC-SR04 Echo pin connects to a digital-input-capable MCU pin",
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
        if (endpoint.pin_label !== "Echo") continue;

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

        if (!VALID_INPUT_DIRECTIONS.has(otherPin.direction)) {
          return {
            passed: false,
            severity: "red",
            message: `HC-SR04 Echo is connected to Uno pin ${otherEndpoint.pin_label}, which is ${otherPin.direction}. Echo must connect to a digital pin (the sketch will set it INPUT and use pulseIn()).`,
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
