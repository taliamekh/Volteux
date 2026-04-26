/**
 * sensor-echo-input-pin — the HC-SR04's Echo pin must connect to a digital
 * input-capable pin on the MCU. The Arduino sketch will configure that pin
 * as INPUT and use pulseIn() to measure how long Echo stays HIGH.
 *
 * Why red: connecting Echo to a power rail or analog-only pin breaks
 * pulseIn(); connecting to a PWM-output pin is OK (PWM pins are also
 * digital inputs) but counterproductive.
 *
 * Note: HC-SR04 Echo pin outputs 5V; the Uno's digital inputs tolerate 5V
 * directly. On 3.3V boards this rule would also need a level shifter check
 * (added in v0.2 for ESP32 archetypes).
 *
 * COR-003 closure (parallel to sensor-trig): the rule previously had
 * `if (!otherEntry || otherEntry.type !== "mcu") continue;` which silently
 * passed Echo wired to a non-MCU pin. Echo wired anywhere but the MCU
 * means the sketch's pulseIn() never sees a signal — the project silently
 * never works. Now emits red.
 */

import type { VolteuxProjectDocument } from "../../../schemas/document.zod.ts";
import type { Rule, RuleResult } from "../../types.ts";
import { resolveEndpoint } from "../rule-helpers.ts";

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
        const sensor = resolveEndpoint(doc, endpoint);
        if (!sensor || sensor.component.sku !== HC_SR04_SKU) continue;
        if (endpoint.pin_label !== "Echo") continue;

        const target = resolveEndpoint(doc, otherEndpoint);
        if (!target) continue; // cross-consistency check (b) catches this

        // COR-003 — Echo MUST land on an MCU. Echo wired elsewhere means
        // the sketch's pulseIn() has nothing to read.
        if (target.entry.type !== "mcu") {
          return {
            passed: false,
            severity: "red",
            message: `HC-SR04 Echo (${endpoint.component_id}) must connect to a digital-input pin on the Uno, not to ${otherEndpoint.component_id}.${otherEndpoint.pin_label} (${target.entry.name}, type ${target.entry.type})`,
            context: {
              sensor_id: endpoint.component_id,
              connected_to: otherEndpoint.component_id,
              connected_pin: otherEndpoint.pin_label,
              target_type: target.entry.type,
            },
          };
        }

        if (!target.pin) continue; // cross-consistency check (c) catches this

        if (!VALID_INPUT_DIRECTIONS.has(target.pin.direction)) {
          return {
            passed: false,
            severity: "red",
            message: `HC-SR04 Echo is connected to Uno pin ${otherEndpoint.pin_label}, which is ${target.pin.direction}. Echo must connect to a digital pin (the sketch will set it INPUT and use pulseIn()).`,
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
