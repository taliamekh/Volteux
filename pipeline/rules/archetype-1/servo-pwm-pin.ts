/**
 * servo-pwm-pin — the SG90 servo's Signal pin must connect to a
 * PWM-capable Uno pin (3, 5, 6, 9, 10, 11).
 *
 * Why amber: the Servo library can drive any digital pin via timer
 * interrupts, so non-PWM pins technically work — but the resulting
 * jitter is visible (~1-2 degrees at low angles) and unprofessional.
 * The convention is to use a PWM-capable pin.
 *
 * Datasheet: ATmega328P (Uno) — pins 3, 5, 6, 9, 10, 11 are PWM-capable
 * (Timer0/1/2 outputs).
 */

import type { VolteuxProjectDocument } from "../../../schemas/document.zod.ts";
import type { Rule, RuleResult } from "../../types.ts";
import { lookupBySku } from "../../../components/registry.ts";

const PWM_CAPABLE_UNO_PINS = new Set(["3", "5", "6", "9", "10", "11"]);
const SERVO_SKU = "169";

export const servoPwmPinRule: Rule<VolteuxProjectDocument> = {
  id: "servo-pwm-pin",
  severity: "amber",
  description:
    "Servo Signal pin connects to a PWM-capable Uno pin (3, 5, 6, 9, 10, or 11)",
  check(doc): RuleResult {
    if (doc.board.type !== "uno") return { passed: true };

    for (const conn of doc.connections) {
      for (const [endpoint, otherEndpoint] of [
        [conn.from, conn.to],
        [conn.to, conn.from],
      ] as const) {
        const component = doc.components.find(
          (c) => c.id === endpoint.component_id,
        );
        if (!component || component.sku !== SERVO_SKU) continue;
        if (endpoint.pin_label !== "Signal") continue;

        const otherComponent = doc.components.find(
          (c) => c.id === otherEndpoint.component_id,
        );
        if (!otherComponent) continue;
        const otherEntry =
          lookupBySku(otherComponent.sku);
        if (!otherEntry || otherEntry.type !== "mcu") continue;

        if (!PWM_CAPABLE_UNO_PINS.has(otherEndpoint.pin_label)) {
          return {
            passed: false,
            severity: "amber",
            message: `Servo Signal is on Uno pin ${otherEndpoint.pin_label}, which is not PWM-capable. Use one of: ${[...PWM_CAPABLE_UNO_PINS].join(", ")}. The servo will work but jitter visibly at low angles.`,
            context: {
              servo_id: component.id,
              connected_to: otherEndpoint.pin_label,
              pwm_capable_pins: [...PWM_CAPABLE_UNO_PINS],
            },
          };
        }
      }
    }
    return { passed: true };
  },
};
