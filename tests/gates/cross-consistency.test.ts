import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  VolteuxProjectDocumentSchema,
  type VolteuxProjectDocument,
} from "../../schemas/document.zod.ts";
import {
  runCrossConsistencyGate,
  checkUniqueComponentIds,
  checkConnectionComponentsExist,
  checkConnectionPinLabelsExist,
  checkBreadboardLayoutComponentsExist,
  checkAllRequiredComponentsAreLaidOut,
  checkBoardFqbn,
  checkAllSkusInRegistry,
  checkLibraryAllowlist,
  DEFAULT_REGISTRY,
} from "../../pipeline/gates/cross-consistency.ts";

const fixture: VolteuxProjectDocument = VolteuxProjectDocumentSchema.parse(
  JSON.parse(
    readFileSync(
      resolve(import.meta.dir, "../../fixtures/uno-ultrasonic-servo.json"),
      "utf8",
    ),
  ),
);

/** Deep-clone the fixture so each test gets a fresh, mutable copy. */
function clone(): VolteuxProjectDocument {
  return structuredClone(fixture);
}

describe("runCrossConsistencyGate — happy path", () => {
  test("canonical fixture passes all 8 checks", () => {
    const result = runCrossConsistencyGate(fixture);
    if (!result.ok) {
      throw new Error(
        `Expected pass but gate failed: ${result.message}\n${result.errors.join("\n")}`,
      );
    }
    expect(result.ok).toBe(true);
  });
});

describe("Check (a) — unique component ids", () => {
  test("passes on canonical fixture", () => {
    expect(checkUniqueComponentIds(fixture).ok).toBe(true);
  });

  test("fails when two components share an id", () => {
    const doc = clone();
    doc.components[1] = { ...doc.components[1]!, id: doc.components[0]!.id };
    const result = checkUniqueComponentIds(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("duplicate component id");
  });
});

describe("Check (b) — connection component_ids exist", () => {
  test("passes on canonical fixture", () => {
    expect(checkConnectionComponentsExist(fixture).ok).toBe(true);
  });

  test("fails when a connection references a non-existent component", () => {
    const doc = clone();
    doc.connections[0]!.from.component_id = "ghost";
    const result = checkConnectionComponentsExist(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("ghost");
  });
});

describe("Check (c) — connection pin labels exist", () => {
  test("passes on canonical fixture", () => {
    expect(
      checkConnectionPinLabelsExist(fixture, DEFAULT_REGISTRY).ok,
    ).toBe(true);
  });

  test("fails when a connection references an unknown pin on a known component", () => {
    const doc = clone();
    doc.connections[0]!.from.pin_label = "NonexistentPin";
    const result = checkConnectionPinLabelsExist(doc, DEFAULT_REGISTRY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("NonexistentPin");
  });

  test("does not fail when registry lookup misses (defers to check g)", () => {
    const doc = clone();
    doc.components[0]!.sku = "9999"; // unknown SKU
    // Check (c) should not error on unknown SKUs — that's check (g)'s job
    expect(
      checkConnectionPinLabelsExist(doc, DEFAULT_REGISTRY).ok,
    ).toBe(true);
  });

  test("rejects a connection that references a wire/breadboard component (review ADV-004)", () => {
    const doc = clone();
    // Add a connection routed through the jumper-wire bundle (w1, sku 758,
    // type 'wire' — empty pin_metadata). Previously this slipped through
    // because empty pin_metadata triggered a `continue`; now it must fail.
    doc.connections.push({
      from: { component_id: "u1", pin_label: "5V" },
      to: { component_id: "w1", pin_label: "in" },
      purpose: "test wire-as-node rejection",
    });
    const result = checkConnectionPinLabelsExist(doc, DEFAULT_REGISTRY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("w1");
      expect(result.message).toContain("inventory");
    }
  });
});

describe("Check (d) — breadboard_layout component_ids exist", () => {
  test("passes on canonical fixture", () => {
    expect(checkBreadboardLayoutComponentsExist(fixture).ok).toBe(true);
  });

  test("fails when breadboard_layout references unknown component", () => {
    const doc = clone();
    doc.breadboard_layout.components[0]!.component_id = "ghost";
    const result = checkBreadboardLayoutComponentsExist(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("ghost");
  });
});

describe("Check (e) — all required components are laid out", () => {
  test("passes on canonical fixture", () => {
    expect(
      checkAllRequiredComponentsAreLaidOut(fixture, DEFAULT_REGISTRY).ok,
    ).toBe(true);
  });

  test("fails when a sensor is missing from breadboard_layout", () => {
    const doc = clone();
    // Drop the s1 (HC-SR04) layout entry
    doc.breadboard_layout.components = doc.breadboard_layout.components.filter(
      (c) => c.component_id !== "s1",
    );
    const result = checkAllRequiredComponentsAreLaidOut(doc, DEFAULT_REGISTRY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("s1");
  });

  test("does not require wires (jumper wires) to have layout entries", () => {
    expect(
      checkAllRequiredComponentsAreLaidOut(fixture, DEFAULT_REGISTRY).ok,
    ).toBe(true);
  });

  test("does not require the breadboard itself to have a layout entry", () => {
    // The breadboard component (b1, sku 239) is in components[] but NOT in
    // breadboard_layout.components[] — this should pass.
    expect(
      fixture.breadboard_layout.components.some((c) => c.component_id === "b1"),
    ).toBe(false);
    expect(
      checkAllRequiredComponentsAreLaidOut(fixture, DEFAULT_REGISTRY).ok,
    ).toBe(true);
  });
});

describe("Check (f) — board.fqbn matches canonical FQBN", () => {
  test("passes on canonical fixture (uno -> arduino:avr:uno)", () => {
    expect(checkBoardFqbn(fixture).ok).toBe(true);
  });

  test("fails when fqbn doesn't match the board.type", () => {
    const doc = clone();
    doc.board.fqbn = "esp32:esp32:esp32";
    const result = checkBoardFqbn(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("esp32:esp32:esp32");
      expect(result.message).toContain("arduino:avr:uno");
    }
  });

  test("fails on completely arbitrary fqbn string", () => {
    const doc = clone();
    doc.board.fqbn = "wat:nonsense:42";
    expect(checkBoardFqbn(doc).ok).toBe(false);
  });
});

describe("Check (g) — all SKUs in registry", () => {
  test("passes on canonical fixture", () => {
    expect(
      checkAllSkusInRegistry(fixture, DEFAULT_REGISTRY).ok,
    ).toBe(true);
  });

  test("fails when a component has an SKU not in the registry", () => {
    const doc = clone();
    doc.components[1]!.sku = "9999";
    const result = checkAllSkusInRegistry(doc, DEFAULT_REGISTRY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("9999");
  });

  test("uses passed-in registry stub, not the singleton import", () => {
    const stub = { "9999": DEFAULT_REGISTRY["50"]! };
    const doc = clone();
    doc.components = [{ id: "x", sku: "9999", quantity: 1 }];
    expect(checkAllSkusInRegistry(doc, stub).ok).toBe(true);
  });
});

describe("Check (h) — library allowlist", () => {
  test("passes on canonical fixture", () => {
    expect(checkLibraryAllowlist(fixture).ok).toBe(true);
  });

  test("fails when libraries[] contains something off-allowlist", () => {
    const doc = clone();
    doc.sketch.libraries = ["Servo", "WiFi"];
    expect(checkLibraryAllowlist(doc).ok).toBe(false);
  });

  test("fails when sketch #includes a forbidden header", () => {
    const doc = clone();
    doc.sketch.main_ino = "#include <WiFi.h>\n" + doc.sketch.main_ino;
    expect(checkLibraryAllowlist(doc).ok).toBe(false);
  });

  test("fails when additional_files key fails the filename regex", () => {
    const doc = clone();
    doc.sketch.additional_files = { "arduino-cli.yaml": "" };
    expect(checkLibraryAllowlist(doc).ok).toBe(false);
  });
});

describe("runCrossConsistencyGate — failure aggregation", () => {
  test("returns red severity with all failed check labels in the message", () => {
    const doc = clone();
    // Trip checks (a), (b), and (f) — duplicate b1 (breadboard, not referenced
    // by any connection or layout entry) onto u1 to avoid cascading failures
    // into checks (d)/(e).
    const breadboardIdx = doc.components.findIndex((c) => c.id === "b1");
    expect(breadboardIdx).toBeGreaterThanOrEqual(0);
    doc.components[breadboardIdx]!.id = doc.components[0]!.id;
    doc.connections[0]!.from.component_id = "ghost";
    doc.board.fqbn = "wat:nonsense:42";

    const result = runCrossConsistencyGate(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("red");
      expect(result.message).toContain("(a)");
      expect(result.message).toContain("(b)");
      expect(result.message).toContain("(f)");
      expect(result.errors.length).toBe(3);
    }
  });

  test("errors array contains check labels for traceability", () => {
    const doc = clone();
    doc.components[1]!.id = doc.components[0]!.id;
    const result = runCrossConsistencyGate(doc);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors[0]).toContain("[check a]");
  });
});
