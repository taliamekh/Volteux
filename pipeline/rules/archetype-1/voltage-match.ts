/**
 * voltage-match — every component's `power_in` pin is connected to a board
 * (MCU) pin supplying the right voltage (within ±10%).
 *
 * Why red: powering a 3.3V-only sensor from a 5V rail can damage the sensor;
 * powering a 5V sensor from a 3.3V rail typically results in undefined
 * behavior (sensor doesn't respond, no clear error).
 *
 * Registry semantics: both the Uno's `5V` pin and a sensor's `VCC` pin are
 * `direction: "power_in"`. The registry doesn't tag a "supply" direction —
 * the supply role is implied by `entry.type === "mcu"`. The MCU's power_in
 * pins act as supply; non-MCU power_in pins act as consumers.
 *
 * COR-002 closure: the rule previously iterated both endpoint orderings
 * and checked voltage match without ever asserting that one side was the
 * MCU. HC-SR04.VCC (5V power_in) wired to SG90.VCC (5V power_in) had
 * voltage matching at 0% delta and silently passed — even though the
 * wiring is electrically meaningless (two consumers with no source). The
 * rule now requires exactly one side of any power connection to be the
 * MCU; if neither is, COR-002 fires red.
 *
 * Datasheet: ATmega328P (Uno) supplies 5V (USB-powered) and 3.3V; both have
 * a stated tolerance of ±5% under nominal load.
 */

import type { VolteuxProjectDocument } from "../../../schemas/document.zod.ts";
import type { Rule, RuleResult } from "../../types.ts";
import { resolveEndpoint, type ResolvedEndpoint } from "../rule-helpers.ts";

const VOLTAGE_TOLERANCE = 0.1; // ±10% — accommodates measurement noise + LDO drop

function isPowerInWithVoltage(end: ResolvedEndpoint): boolean {
  return (
    end.pin?.direction === "power_in" && end.pin.voltage !== undefined
  );
}

export const voltageMatchRule: Rule<VolteuxProjectDocument> = {
  id: "voltage-match",
  severity: "red",
  description:
    "Every component's power_in pin connects to an MCU pin at the correct voltage (±10%)",
  check(doc): RuleResult {
    for (const conn of doc.connections) {
      const a = resolveEndpoint(doc, conn.from);
      const b = resolveEndpoint(doc, conn.to);
      if (!a || !b) continue; // cross-consistency check (b)/(g) catches this

      const aIsPower = isPowerInWithVoltage(a);
      const bIsPower = isPowerInWithVoltage(b);
      if (!aIsPower && !bIsPower) continue; // not a power connection

      const aIsMcu = a.entry.type === "mcu";
      const bIsMcu = b.entry.type === "mcu";

      // COR-002: a power connection must have an MCU on one side. Two
      // non-MCU power_in pins wired together (e.g., HC-SR04.VCC → SG90.VCC)
      // is a silent failure — voltages match but no current flows.
      if (!aIsMcu && !bIsMcu) {
        const [consumerEnd, supplyEnd] = aIsPower
          ? [conn.from, conn.to]
          : [conn.to, conn.from];
        const [consumer, supply] = aIsPower ? [a, b] : [b, a];
        return {
          passed: false,
          severity: "red",
          message: `Power input on ${consumerEnd.component_id}.${consumerEnd.pin_label} (${consumer.entry.name}) must come from the board's power rail, not from ${supplyEnd.component_id}.${supplyEnd.pin_label} (${supply.entry.name}, type ${supply.entry.type})`,
          context: {
            consumer_id: consumerEnd.component_id,
            supply_id: supplyEnd.component_id,
            supply_type: supply.entry.type,
            expected_v: consumer.pin?.voltage,
          },
        };
      }

      // Both MCU is unusual (not archetype 1) — skip rather than spuriously fail.
      if (aIsMcu && bIsMcu) continue;

      // Exactly one MCU: that side is the supply, the other is the consumer.
      const [supply, consumer, supplyEnd, consumerEnd] = aIsMcu
        ? [a, b, conn.from, conn.to]
        : [b, a, conn.to, conn.from];

      // The consumer must be a power_in pin with a voltage to match against.
      if (
        consumer.pin?.direction !== "power_in" ||
        consumer.pin.voltage === undefined
      ) {
        continue;
      }
      // The supply pin must carry a voltage (e.g., a GND pin won't).
      if (supply.pin?.voltage === undefined) continue;

      const expected = consumer.pin.voltage;
      const supplied = supply.pin.voltage;
      if (Math.abs(expected - supplied) / expected > VOLTAGE_TOLERANCE) {
        return {
          passed: false,
          severity: "red",
          message: `Voltage mismatch: ${consumerEnd.component_id} (${consumer.entry.name}) needs ${expected}V on ${consumerEnd.pin_label}, but is connected to ${supplyEnd.component_id} ${supplyEnd.pin_label} which supplies ${supplied}V`,
          context: {
            component_id: consumerEnd.component_id,
            expected_v: expected,
            supplied_v: supplied,
          },
        };
      }
    }
    return { passed: true };
  },
};
