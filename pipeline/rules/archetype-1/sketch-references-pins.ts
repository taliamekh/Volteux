/**
 * sketch-references-pins — every MCU pin that appears in a connection
 * also appears as a literal number in the sketch source. Catches the
 * LLM emitting wiring for pin 9 but writing code that uses pin 7.
 *
 * Why red: a wiring/code mismatch produces silent failure. The board
 * compiles cleanly and runs, but the wired-up component never receives
 * any signal. Beginners read this as "my hardware is broken" — exactly
 * the failure mode this tool is supposed to prevent.
 *
 * v0.1 implementation note: simple substring search for the pin number.
 * False positives are possible (e.g., pin 9 with "delay(9)" in the sketch
 * passes by accident), but the failure mode this rule catches is severe
 * enough to be worth the noise. v0.5 can refine to AST-aware checking.
 */

import type { VolteuxProjectDocument } from "../../../schemas/document.zod.ts";
import type { Rule, RuleResult } from "../../types.ts";
import { lookupBySku } from "../../../components/registry.ts";
import { stripComments } from "../../gates/library-allowlist.ts";

const POWER_AND_GROUND = new Set(["GND", "GND2", "5V", "3.3V"]);

export const sketchReferencesPinsRule: Rule<VolteuxProjectDocument> = {
  id: "sketch-references-pins",
  severity: "red",
  description:
    "Every wired MCU signal pin also appears (as a literal number) in the sketch source",
  check(doc): RuleResult {
    const referencedPins = new Set<string>();
    for (const conn of doc.connections) {
      for (const endpoint of [conn.from, conn.to] as const) {
        const component = doc.components.find(
          (c) => c.id === endpoint.component_id,
        );
        if (!component) continue;
        const entry = lookupBySku(component.sku);
        if (!entry || entry.type !== "mcu") continue;
        if (POWER_AND_GROUND.has(endpoint.pin_label)) continue;
        // Only check numeric digital pins (skip A0-A5 since those have
        // dual representation as PIN_A0 etc — false-positive prone)
        if (/^[0-9]+$/.test(endpoint.pin_label)) {
          referencedPins.add(endpoint.pin_label);
        }
      }
    }

    // Sketch must contain each referenced pin as a token in EXECUTABLE code,
    // not in a comment. Strip C/C++ comments first (review finding ADV-002:
    // a leftover '// servo was on pin 9' comment otherwise made the rule
    // pass even when the actual sketch used a different pin). Word-boundary
    // regex still in use to avoid false positives (e.g., pin "9" matching
    // "39" or "9000").
    const sketchExecutable = stripComments(doc.sketch.main_ino);
    const missing: string[] = [];
    for (const pin of referencedPins) {
      const re = new RegExp(`\\b${pin}\\b`);
      if (!re.test(sketchExecutable)) {
        missing.push(pin);
      }
    }

    if (missing.length > 0) {
      return {
        passed: false,
        severity: "red",
        message: `Wiring references Uno pin(s) ${missing.join(", ")} but the sketch source does not mention them. The wired-up component will never receive a signal.`,
        context: { missing_pins: missing, wired_pins: [...referencedPins] },
      };
    }
    return { passed: true };
  },
};
