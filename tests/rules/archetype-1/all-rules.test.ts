/**
 * One test file for all 11 archetype-1 rules. Each rule gets:
 *   - happy path: canonical fixture passes
 *   - failure path: minimally-mutated fixture fails with expected severity
 *   - edge cases where applicable
 *
 * Plus runner-level tests for severity bucketing and registry coverage.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  VolteuxProjectDocumentSchema,
  type VolteuxProjectDocument,
} from "../../../schemas/document.zod.ts";
import {
  runRules,
  ARCHETYPE_1_RULES,
} from "../../../pipeline/rules/index.ts";

const fixture: VolteuxProjectDocument = VolteuxProjectDocumentSchema.parse(
  JSON.parse(
    readFileSync(
      resolve(import.meta.dir, "../../../fixtures/uno-ultrasonic-servo.json"),
      "utf8",
    ),
  ),
);

function clone(): VolteuxProjectDocument {
  return JSON.parse(JSON.stringify(fixture)) as VolteuxProjectDocument;
}

function ruleById(id: string) {
  const rule = ARCHETYPE_1_RULES.find((r) => r.id === id);
  if (!rule) throw new Error(`Rule "${id}" not registered`);
  return rule;
}

describe("Rule registry", () => {
  test("11 archetype-1 rules registered", () => {
    expect(ARCHETYPE_1_RULES.length).toBe(11);
  });

  test("every rule has a unique id", () => {
    const ids = ARCHETYPE_1_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every rule has a non-empty description", () => {
    for (const rule of ARCHETYPE_1_RULES) {
      expect(rule.description.length).toBeGreaterThan(0);
    }
  });
});

describe("runRules — canonical fixture", () => {
  test("passes all 11 rules clean (no red, amber, or blue)", () => {
    const result = runRules(fixture);
    if (
      result.red.length > 0 ||
      result.amber.length > 0 ||
      result.blue.length > 0
    ) {
      const fmt = (a: typeof result.red) =>
        a
          .map(
            (att) =>
              `[${att.rule.id}] ${att.result.passed ? "passed" : att.result.message}`,
          )
          .join("\n");
      throw new Error(
        `Canonical fixture should pass clean.\nRed:\n${fmt(result.red)}\nAmber:\n${fmt(result.amber)}\nBlue:\n${fmt(result.blue)}`,
      );
    }
    expect(result.attempts.length).toBe(11);
  });
});

describe("voltage-match", () => {
  const rule = ruleById("voltage-match");

  test("passes on canonical fixture", () => {
    expect(rule.check(fixture).passed).toBe(true);
  });

  test("fails when 5V sensor is connected to 3.3V supply", () => {
    const doc = clone();
    // Find the s1.VCC -> u1.5V connection and re-route it to u1.3.3V
    for (const conn of doc.connections) {
      if (conn.from.component_id === "s1" && conn.from.pin_label === "VCC") {
        conn.to.pin_label = "3.3V";
      }
    }
    const result = rule.check(doc);
    expect(result.passed).toBe(false);
    if (!result.passed) {
      expect(result.severity).toBe("red");
      expect(result.message).toContain("Voltage mismatch");
    }
  });
});

describe("current-budget", () => {
  const rule = ruleById("current-budget");

  test("passes on canonical fixture (HC-SR04 + servo are well under budget)", () => {
    expect(rule.check(fixture).passed).toBe(true);
  });

  test("flags amber when synthetic high-draw component pushes total past 80%", () => {
    const doc = clone();
    // Add 4 fictitious additional servos; SG90 peak is 150mA, so 5 servos = 750mA > 400mA threshold
    for (let i = 0; i < 4; i++) {
      doc.components.push({ id: `extra_servo_${i}`, sku: "169", quantity: 1 });
      doc.connections.push({
        from: { component_id: `extra_servo_${i}`, pin_label: "VCC" },
        to: { component_id: "u1", pin_label: "5V" },
        purpose: "extra power",
      });
    }
    const result = rule.check(doc);
    expect(result.passed).toBe(false);
    if (!result.passed) expect(result.severity).toBe("amber");
  });
});

describe("breadboard-rail-discipline", () => {
  const rule = ruleById("breadboard-rail-discipline");

  test("passes on canonical fixture (only 2 ground + 2 supply conns to board pins)", () => {
    // canonical fixture has 4 connections to board GND/5V (2 each); under threshold of 3 each
    expect(rule.check(fixture).passed).toBe(true);
  });

  test("flags blue when many components share the same supply pin without a rail", () => {
    const doc = clone();
    for (let i = 0; i < 4; i++) {
      doc.components.push({ id: `extra_${i}`, sku: "3942", quantity: 1 });
      doc.connections.push({
        from: { component_id: `extra_${i}`, pin_label: "GND" },
        to: { component_id: "u1", pin_label: "GND" },
        purpose: "ground",
      });
    }
    const result = rule.check(doc);
    expect(result.passed).toBe(false);
    if (!result.passed) expect(result.severity).toBe("blue");
  });
});

describe("no-floating-pins", () => {
  const rule = ruleById("no-floating-pins");

  test("passes on canonical fixture (all sensor + actuator pins wired)", () => {
    expect(rule.check(fixture).passed).toBe(true);
  });

  test("fails when sensor's Trig pin is removed from connections", () => {
    const doc = clone();
    doc.connections = doc.connections.filter(
      (c) =>
        !(c.from.component_id === "s1" && c.from.pin_label === "Trig") &&
        !(c.to.component_id === "s1" && c.to.pin_label === "Trig"),
    );
    const result = rule.check(doc);
    expect(result.passed).toBe(false);
    if (!result.passed) {
      expect(result.severity).toBe("red");
      expect(result.message).toContain("Trig");
    }
  });
});

describe("wire-color-discipline", () => {
  const rule = ruleById("wire-color-discipline");

  test("passes on canonical fixture (red for power, black for ground)", () => {
    expect(rule.check(fixture).passed).toBe(true);
  });

  test("fails when a power connection uses a non-red wire", () => {
    const doc = clone();
    for (const conn of doc.connections) {
      if (conn.from.component_id === "s1" && conn.from.pin_label === "VCC") {
        conn.wire_color = "green";
      }
    }
    const result = rule.check(doc);
    expect(result.passed).toBe(false);
    if (!result.passed) expect(result.severity).toBe("amber");
  });

  test("passes when wire_color is undefined (we don't enforce a default)", () => {
    const doc = clone();
    for (const conn of doc.connections) delete (conn as { wire_color?: string }).wire_color;
    expect(rule.check(doc).passed).toBe(true);
  });
});

describe("pin-uniqueness", () => {
  const rule = ruleById("pin-uniqueness");

  test("passes on canonical fixture", () => {
    expect(rule.check(fixture).passed).toBe(true);
  });

  test("fails when two components share the same MCU signal pin", () => {
    const doc = clone();
    // Re-route servo Signal to pin 7 (currently used by HC-SR04 Trig)
    for (const conn of doc.connections) {
      if (conn.from.component_id === "a1" && conn.from.pin_label === "Signal") {
        conn.to.pin_label = "7";
      }
    }
    const result = rule.check(doc);
    expect(result.passed).toBe(false);
    if (!result.passed) expect(result.severity).toBe("red");
  });

  test("does NOT flag fanout on power/ground pins", () => {
    // Canonical fixture has 2 connections each to 5V, GND, GND2 — that's
    // expected fanout, not a violation.
    expect(rule.check(fixture).passed).toBe(true);
  });
});

describe("servo-pwm-pin", () => {
  const rule = ruleById("servo-pwm-pin");

  test("passes on canonical fixture (servo on pin 9 = PWM)", () => {
    expect(rule.check(fixture).passed).toBe(true);
  });

  test("fails when servo is on a non-PWM pin (e.g., pin 7)", () => {
    const doc = clone();
    for (const conn of doc.connections) {
      if (conn.from.component_id === "a1" && conn.from.pin_label === "Signal") {
        conn.to.pin_label = "7";
      }
    }
    const result = rule.check(doc);
    expect(result.passed).toBe(false);
    if (!result.passed) {
      expect(result.severity).toBe("amber");
      expect(result.message).toContain("PWM");
    }
  });
});

describe("sensor-trig-output-pin", () => {
  const rule = ruleById("sensor-trig-output-pin");

  test("passes on canonical fixture (Trig on pin 7 = digital_io)", () => {
    expect(rule.check(fixture).passed).toBe(true);
  });

  test("fails when Trig is on an analog pin (A0)", () => {
    const doc = clone();
    for (const conn of doc.connections) {
      if (conn.from.component_id === "s1" && conn.from.pin_label === "Trig") {
        conn.to.pin_label = "A0";
      }
    }
    const result = rule.check(doc);
    expect(result.passed).toBe(false);
    if (!result.passed) {
      expect(result.severity).toBe("red");
      expect(result.message).toContain("Trig");
    }
  });
});

describe("sensor-echo-input-pin", () => {
  const rule = ruleById("sensor-echo-input-pin");

  test("passes on canonical fixture (Echo on pin 8 = digital_io)", () => {
    expect(rule.check(fixture).passed).toBe(true);
  });

  test("fails when Echo is on an analog pin (A0)", () => {
    const doc = clone();
    for (const conn of doc.connections) {
      if (conn.from.component_id === "s1" && conn.from.pin_label === "Echo") {
        conn.to.pin_label = "A0";
      }
    }
    const result = rule.check(doc);
    expect(result.passed).toBe(false);
    if (!result.passed) expect(result.severity).toBe("red");
  });
});

describe("sketch-references-pins", () => {
  const rule = ruleById("sketch-references-pins");

  test("passes on canonical fixture (sketch uses pins 7, 8, 9)", () => {
    expect(rule.check(fixture).passed).toBe(true);
  });

  test("fails when wiring pin doesn't appear in sketch source", () => {
    const doc = clone();
    // Re-route sensor Trig from pin 7 to pin 12; sketch still uses 7
    for (const conn of doc.connections) {
      if (conn.from.component_id === "s1" && conn.from.pin_label === "Trig") {
        conn.to.pin_label = "12";
      }
    }
    const result = rule.check(doc);
    expect(result.passed).toBe(false);
    if (!result.passed) {
      expect(result.severity).toBe("red");
      expect(result.message).toContain("12");
    }
  });

  test("word-boundary regex avoids false positive (pin 9 inside 'delay(900)')", () => {
    const doc = clone();
    // Replace the sketch with one where pin 9 only appears inside 900
    doc.sketch.main_ino =
      "void setup() { pinMode(7, OUTPUT); pinMode(8, INPUT); }\n" +
      "void loop() { delay(900); }\n"; // 900 should NOT count as pin 9
    const result = rule.check(doc);
    expect(result.passed).toBe(false);
    if (!result.passed) expect(result.message).toContain("9");
  });
});

describe("no-v15-fields-on-archetype-1", () => {
  const rule = ruleById("no-v15-fields-on-archetype-1");

  test("passes on canonical fixture (no v1.5 fields set)", () => {
    expect(rule.check(fixture).passed).toBe(true);
  });

  test("flags amber when captive_portal_ssid is set on archetype 1", () => {
    const doc = clone();
    doc.external_setup.captive_portal_ssid = "VolteuxSetup";
    const result = rule.check(doc);
    expect(result.passed).toBe(false);
    if (!result.passed) {
      expect(result.severity).toBe("amber");
      expect(result.message).toContain("captive_portal_ssid");
    }
  });

  test("flags amber when aio_feed_names is non-empty", () => {
    const doc = clone();
    doc.external_setup.aio_feed_names = ["temperature"];
    expect(rule.check(doc).passed).toBe(false);
  });

  test("does NOT flag empty arrays (only populated v1.5 fields trigger)", () => {
    const doc = clone();
    doc.external_setup.aio_feed_names = [];
    expect(rule.check(doc).passed).toBe(true);
  });
});

describe("runRules — severity bucketing", () => {
  test("two simultaneous failures bucket into the right severities", () => {
    const doc = clone();
    // Trip voltage-match (red): re-route sensor power to 3.3V
    for (const conn of doc.connections) {
      if (conn.from.component_id === "s1" && conn.from.pin_label === "VCC") {
        conn.to.pin_label = "3.3V";
      }
    }
    // Trip wire-color-discipline (amber): change a power wire color
    for (const conn of doc.connections) {
      if (conn.from.component_id === "a1" && conn.from.pin_label === "VCC") {
        conn.wire_color = "blue";
      }
    }
    const result = runRules(doc);
    expect(result.red.length).toBeGreaterThanOrEqual(1);
    expect(result.amber.length).toBeGreaterThanOrEqual(1);
    expect(result.attempts.length).toBe(11);
  });

  test("empty rules array returns empty buckets", () => {
    const result = runRules(fixture, []);
    expect(result.red).toEqual([]);
    expect(result.amber).toEqual([]);
    expect(result.blue).toEqual([]);
    expect(result.attempts).toEqual([]);
  });
});
