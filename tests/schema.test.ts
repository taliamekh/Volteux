import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { VolteuxProjectDocumentSchema } from "../schemas/document.zod.ts";
import { COMPONENTS, KNOWN_SKUS } from "../components/registry.ts";

const FIXTURE_PATH = resolve(
  import.meta.dir,
  "../fixtures/uno-ultrasonic-servo.json",
);

const fixture: unknown = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

describe("VolteuxProjectDocumentSchema — canonical fixture", () => {
  test("parses fixtures/uno-ultrasonic-servo.json cleanly", () => {
    const result = VolteuxProjectDocumentSchema.safeParse(fixture);
    if (!result.success) {
      // Surface every issue so a fixture break is debuggable in one run
      throw new Error(
        `Fixture failed to parse:\n${JSON.stringify(result.error.issues, null, 2)}`,
      );
    }
    expect(result.data.archetype_id).toBe("uno-ultrasonic-servo");
  });

  test("fixture stripped of optional v1.5 field captive_portal_ssid still parses", () => {
    // captive_portal_ssid was never in the canonical fixture; verify the
    // schema accepts a fixture both with and without it.
    const stripped = structuredClone(fixture) as Record<string, unknown>;
    const ext = stripped.external_setup as Record<string, unknown>;
    delete ext.captive_portal_ssid;
    expect(
      VolteuxProjectDocumentSchema.safeParse(stripped).success,
    ).toBe(true);
  });

  test("fixture without optional needs_aio_credentials still parses", () => {
    const stripped = structuredClone(fixture) as Record<string, unknown>;
    const ext = stripped.external_setup as Record<string, unknown>;
    delete ext.needs_aio_credentials;
    expect(
      VolteuxProjectDocumentSchema.safeParse(stripped).success,
    ).toBe(true);
  });
});

describe("VolteuxProjectDocumentSchema — strictness", () => {
  test("unknown top-level field fails parse", () => {
    const mutated = { ...(fixture as object), foo: "bar" };
    const result = VolteuxProjectDocumentSchema.safeParse(mutated);
    expect(result.success).toBe(false);
    if (!result.success) {
      // Zod reports unknown keys with code 'unrecognized_keys'
      const codes = result.error.issues.map((i) => i.code);
      expect(codes).toContain("unrecognized_keys");
    }
  });

  test("invalid archetype_id surfaces an enum error", () => {
    const mutated = {
      ...(fixture as object),
      archetype_id: "not-an-archetype",
    };
    const result = VolteuxProjectDocumentSchema.safeParse(mutated);
    expect(result.success).toBe(false);
    if (!result.success) {
      const codes = result.error.issues.map((i) => i.code);
      expect(codes).toContain("invalid_enum_value");
    }
  });

  test("missing required board.fqbn fails with a path-anchored error", () => {
    const mutated = structuredClone(fixture) as Record<string, unknown>;
    const board = mutated.board as Record<string, unknown>;
    delete board.fqbn;
    const result = VolteuxProjectDocumentSchema.safeParse(mutated);
    expect(result.success).toBe(false);
    if (!result.success) {
      const path = result.error.issues[0]?.path ?? [];
      expect(path).toEqual(["board", "fqbn"]);
    }
  });
});

describe("anchor_hole — column range (review COR-001 + ADV-008)", () => {
  test("column 0 is rejected (no real breadboard has column 0)", () => {
    const mutated = structuredClone(fixture) as Record<string, unknown>;
    const layout = mutated.breadboard_layout as Record<string, unknown>;
    const components = layout.components as Array<Record<string, unknown>>;
    components[0]!.anchor_hole = "e0";
    expect(
      VolteuxProjectDocumentSchema.safeParse(mutated).success,
    ).toBe(false);
  });

  test("column 31 is rejected (off the 30-column breadboard)", () => {
    const mutated = structuredClone(fixture) as Record<string, unknown>;
    const layout = mutated.breadboard_layout as Record<string, unknown>;
    const components = layout.components as Array<Record<string, unknown>>;
    components[0]!.anchor_hole = "e31";
    expect(
      VolteuxProjectDocumentSchema.safeParse(mutated).success,
    ).toBe(false);
  });

  test("column 99 is rejected (the old `[0-9]{1,2}` regex would have allowed this)", () => {
    const mutated = structuredClone(fixture) as Record<string, unknown>;
    const layout = mutated.breadboard_layout as Record<string, unknown>;
    const components = layout.components as Array<Record<string, unknown>>;
    components[0]!.anchor_hole = "e99";
    expect(
      VolteuxProjectDocumentSchema.safeParse(mutated).success,
    ).toBe(false);
  });

  test("column 30 is accepted (boundary)", () => {
    const mutated = structuredClone(fixture) as Record<string, unknown>;
    const layout = mutated.breadboard_layout as Record<string, unknown>;
    const components = layout.components as Array<Record<string, unknown>>;
    components[0]!.anchor_hole = "j30";
    expect(
      VolteuxProjectDocumentSchema.safeParse(mutated).success,
    ).toBe(true);
  });

  test("column 1 is accepted (boundary)", () => {
    const mutated = structuredClone(fixture) as Record<string, unknown>;
    const layout = mutated.breadboard_layout as Record<string, unknown>;
    const components = layout.components as Array<Record<string, unknown>>;
    components[0]!.anchor_hole = "a1";
    expect(
      VolteuxProjectDocumentSchema.safeParse(mutated).success,
    ).toBe(true);
  });

  test("row outside a-j is rejected", () => {
    const mutated = structuredClone(fixture) as Record<string, unknown>;
    const layout = mutated.breadboard_layout as Record<string, unknown>;
    const components = layout.components as Array<Record<string, unknown>>;
    components[0]!.anchor_hole = "k15";
    expect(
      VolteuxProjectDocumentSchema.safeParse(mutated).success,
    ).toBe(false);
  });
});

describe("VolteuxProjectDocumentSchema — empty payload defenses", () => {
  test("empty components[] fails parse", () => {
    const mutated = structuredClone(fixture) as Record<string, unknown>;
    mutated.components = [];
    expect(
      VolteuxProjectDocumentSchema.safeParse(mutated).success,
    ).toBe(false);
  });

  test("empty connections[] fails parse", () => {
    const mutated = structuredClone(fixture) as Record<string, unknown>;
    mutated.connections = [];
    expect(
      VolteuxProjectDocumentSchema.safeParse(mutated).success,
    ).toBe(false);
  });

  test("empty breadboard_layout.components[] fails parse", () => {
    const mutated = structuredClone(fixture) as Record<string, unknown>;
    mutated.breadboard_layout = { components: [] };
    expect(
      VolteuxProjectDocumentSchema.safeParse(mutated).success,
    ).toBe(false);
  });

  test("empty sketch.main_ino fails parse", () => {
    const mutated = structuredClone(fixture) as Record<string, unknown>;
    const sketch = mutated.sketch as Record<string, unknown>;
    sketch.main_ino = "";
    expect(
      VolteuxProjectDocumentSchema.safeParse(mutated).success,
    ).toBe(false);
  });

  test("empty sketch.libraries[] is permitted (sketches with no #includes are valid)", () => {
    const mutated = structuredClone(fixture) as Record<string, unknown>;
    const sketch = mutated.sketch as Record<string, unknown>;
    sketch.libraries = [];
    sketch.main_ino = "void setup() {} void loop() {}";
    expect(
      VolteuxProjectDocumentSchema.safeParse(mutated).success,
    ).toBe(true);
  });
});

describe("VolteuxProjectDocumentSchema — non-object inputs", () => {
  test("null returns failure without throwing", () => {
    expect(VolteuxProjectDocumentSchema.safeParse(null).success).toBe(false);
  });

  test("string returns failure without throwing", () => {
    expect(
      VolteuxProjectDocumentSchema.safeParse("hello").success,
    ).toBe(false);
  });

  test("empty object returns multiple required-field errors", () => {
    const result = VolteuxProjectDocumentSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      // At minimum: archetype_id, board, components, connections,
      // breadboard_layout, sketch, external_setup are required (7 fields)
      expect(result.error.issues.length).toBeGreaterThanOrEqual(7);
    }
  });
});

describe("Components registry consistency", () => {
  test("every SKU referenced in the fixture exists in registry.COMPONENTS", () => {
    const doc = VolteuxProjectDocumentSchema.parse(fixture);
    for (const component of doc.components) {
      if (!KNOWN_SKUS.has(component.sku)) {
        throw new Error(
          `Fixture references unknown SKU "${component.sku}" (component id: "${component.id}"). ` +
            `Known SKUs: ${[...KNOWN_SKUS].join(", ")}.`,
        );
      }
    }
  });

  test("registry contains exactly the 5 archetype-1 SKUs", () => {
    expect([...KNOWN_SKUS].sort()).toEqual(
      ["169", "239", "3942", "50", "758"].sort(),
    );
  });

  test("every registry entry's pin_metadata pin labels are unique within the component", () => {
    for (const [sku, entry] of Object.entries(COMPONENTS)) {
      const labels = entry.pin_metadata.map((p) => p.label);
      const unique = new Set(labels);
      if (labels.length !== unique.size) {
        const dupes = labels.filter((l, i) => labels.indexOf(l) !== i);
        throw new Error(
          `SKU ${sku} (${entry.name}) has duplicate pin labels: ${dupes.join(", ")}`,
        );
      }
    }
  });
});
