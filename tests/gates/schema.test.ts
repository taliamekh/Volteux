import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runSchemaGate } from "../../pipeline/gates/schema.ts";

const fixture: unknown = JSON.parse(
  readFileSync(
    resolve(import.meta.dir, "../../fixtures/uno-ultrasonic-servo.json"),
    "utf8",
  ),
);

describe("runSchemaGate — happy path", () => {
  test("canonical fixture returns ok with parsed value", () => {
    const result = runSchemaGate(fixture);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.archetype_id).toBe("uno-ultrasonic-servo");
      expect(result.value.board.fqbn).toBe("arduino:avr:uno");
    }
  });
});

describe("runSchemaGate — failure modes", () => {
  test("missing board.fqbn returns ok=false with red severity and ZodIssues", () => {
    const mutated = structuredClone(fixture) as Record<string, unknown>;
    const board = mutated.board as Record<string, unknown>;
    delete board.fqbn;

    const result = runSchemaGate(mutated);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("red");
      expect(result.errors.length).toBeGreaterThan(0);
      const firstError = result.errors[0] as { path: ReadonlyArray<string | number> };
      expect(firstError.path).toEqual(["board", "fqbn"]);
      expect(result.message).toContain("board.fqbn");
    }
  });

  test("wrong type for archetype_id returns invalid_type error", () => {
    const mutated = { ...(fixture as object), archetype_id: 42 };
    const result = runSchemaGate(mutated);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.errors.map((e) => (e as { code: string }).code);
      // Either invalid_type or invalid_enum_value depending on Zod's path
      expect(
        codes.some((c) => c === "invalid_type" || c === "invalid_enum_value"),
      ).toBe(true);
    }
  });

  test("strict-mode unknown top-level field fails with unrecognized_keys", () => {
    const mutated = { ...(fixture as object), foo: "bar" };
    const result = runSchemaGate(mutated);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.errors.map((e) => (e as { code: string }).code);
      expect(codes).toContain("unrecognized_keys");
    }
  });
});

describe("runSchemaGate — non-object inputs (no throws)", () => {
  test("null input returns ok=false without throwing", () => {
    const result = runSchemaGate(null);
    expect(result.ok).toBe(false);
  });

  test("string input returns ok=false without throwing", () => {
    const result = runSchemaGate("hello");
    expect(result.ok).toBe(false);
  });

  test("empty object returns ok=false with multiple required-field errors", () => {
    const result = runSchemaGate({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // 7 required top-level fields: archetype_id, board, components,
      // connections, breadboard_layout, sketch, external_setup
      expect(result.errors.length).toBeGreaterThanOrEqual(7);
    }
  });
});

describe("runSchemaGate — empty payload defenses", () => {
  test("valid envelope with empty contents (degenerate LLM output) is caught here, not at compile gate", () => {
    const degenerate = {
      archetype_id: "uno-ultrasonic-servo",
      board: {
        sku: "50",
        name: "Arduino Uno R3",
        type: "uno",
        fqbn: "arduino:avr:uno",
      },
      components: [],
      connections: [],
      breadboard_layout: { components: [] },
      sketch: { main_ino: "", libraries: [] },
      external_setup: { needs_wifi: false, needs_aio_credentials: false },
    };
    const result = runSchemaGate(degenerate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Should report the empty-array violations on at least one of components,
      // connections, or breadboard_layout.components — and the empty-string
      // violation on sketch.main_ino
      const paths = result.errors.map((e) =>
        (e as { path: ReadonlyArray<string | number> }).path.join("."),
      );
      const hasEmptyArrayError = paths.some(
        (p) =>
          p === "components" ||
          p === "connections" ||
          p === "breadboard_layout.components",
      );
      const hasEmptyStringError = paths.includes("sketch.main_ino");
      expect(hasEmptyArrayError).toBe(true);
      expect(hasEmptyStringError).toBe(true);
    }
  });
});
