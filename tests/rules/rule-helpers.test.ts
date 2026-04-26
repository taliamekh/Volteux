/**
 * Unit tests for the shared `resolveEndpoint` helper extracted in M-002.
 * Rules consume this helper; the tests here cover the helper's own contract.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  VolteuxProjectDocumentSchema,
  type VolteuxProjectDocument,
} from "../../schemas/document.zod.ts";
import {
  resolveEndpoint,
  type ComponentRegistry,
} from "../../pipeline/rules/rule-helpers.ts";
import { COMPONENTS } from "../../components/registry.ts";

const fixture: VolteuxProjectDocument = VolteuxProjectDocumentSchema.parse(
  JSON.parse(
    readFileSync(
      resolve(import.meta.dir, "../../fixtures/uno-ultrasonic-servo.json"),
      "utf8",
    ),
  ),
);

describe("resolveEndpoint", () => {
  test("resolves a known component + valid pin", () => {
    const result = resolveEndpoint(fixture, {
      component_id: "u1",
      pin_label: "5V",
    });
    expect(result).not.toBeNull();
    if (result) {
      expect(result.component.id).toBe("u1");
      expect(result.entry.type).toBe("mcu");
      expect(result.pin?.label).toBe("5V");
      expect(result.pin?.voltage).toBe(5);
    }
  });

  test("returns null when component_id is not in doc.components", () => {
    expect(
      resolveEndpoint(fixture, {
        component_id: "ghost",
        pin_label: "5V",
      }),
    ).toBeNull();
  });

  test("returns null when SKU is not in the registry", () => {
    // Stub registry that omits the Uno's SKU
    const stubRegistry: ComponentRegistry = {};
    expect(
      resolveEndpoint(
        fixture,
        { component_id: "u1", pin_label: "5V" },
        stubRegistry,
      ),
    ).toBeNull();
  });

  test("returns {component, entry, pin: undefined} when pin label is not declared", () => {
    const result = resolveEndpoint(fixture, {
      component_id: "u1",
      pin_label: "DOES_NOT_EXIST",
    });
    expect(result).not.toBeNull();
    if (result) {
      expect(result.component.id).toBe("u1");
      expect(result.entry.type).toBe("mcu");
      expect(result.pin).toBeUndefined();
    }
  });

  test("uses the canonical registry by default", () => {
    const result = resolveEndpoint(fixture, {
      component_id: "s1",
      pin_label: "VCC",
    });
    expect(result).not.toBeNull();
    if (result) {
      // The default registry is COMPONENTS — same entry should come back if we pass it explicitly.
      const explicit = resolveEndpoint(
        fixture,
        { component_id: "s1", pin_label: "VCC" },
        COMPONENTS,
      );
      expect(explicit?.entry).toBe(result.entry);
    }
  });
});
