// ============================================================
// Volteux — adapter.ts coverage (U5 / Cluster C)
// ============================================================
// Covers `pipelineToProject` happy path, archetype title/key mapping,
// unknown-SKU + empty-SKU throw paths, and the full `mapWireColor`
// matrix exercised through the public adapter API (the helper itself
// is intentionally not exported — see plan U5 decision).
//
// Pattern: mutate a deep clone of `loadDefaultFixture()` to construct
// each variant, then call `pipelineToProject(clone)`. Some scenarios
// require bypassing Zod (the schema would reject empty SKUs, unknown
// archetype IDs, and unrecognized wire colors). That bypass is fine
// here because the *adapter* never re-parses — it trusts its
// `VolteuxProjectDocument` typed input. The Zod gate is exercised
// elsewhere (the fixture loader test surface).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pipelineToProject } from "../data/adapter";
import { loadDefaultFixture } from "../data/fixtures";
import type {
  VolteuxProjectDocument,
  VolteuxArchetypeId,
  VolteuxWireColor,
} from "../../../schemas/document.zod";
import type { WireColor } from "../types";

/**
 * Deep-clone helper. `structuredClone` is available in jsdom (Node 18+);
 * fall back to JSON round-trip if a future runtime drops it. The fixture
 * is JSON-serializable by definition (it's loaded from a .json file), so
 * the fallback is lossless.
 */
function cloneDoc(doc: VolteuxProjectDocument): VolteuxProjectDocument {
  if (typeof structuredClone === "function") {
    return structuredClone(doc);
  }
  return JSON.parse(JSON.stringify(doc)) as VolteuxProjectDocument;
}

// File-level fake-timer hooks. These tests are synchronous (the adapter is
// pure), but the convention across __tests__/ is to wrap describes in fake
// timers so a leaked handle from any test surfaces early. Hoisted here so
// the four describe blocks below don't each carry an identical pair.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  // Drain any pending fake timers BEFORE restoring real timers — otherwise
  // a leftover handle could leak into the next test file in the same
  // worker, breaking files like urlHash.test.ts that explicitly require
  // real timers for CompressionStream/DecompressionStream async I/O.
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("pipelineToProject — happy path", () => {
  it("returns a canonical Project for the default fixture", () => {
    const result = pipelineToProject(loadDefaultFixture());
    expect(result.key).toBe("robot-arm-wave");
    // Fixture has Uno + HC-SR04 + SG90 + breadboard + jumper wires = 5 parts
    // and 7 connections. Pin to exact counts so a future refactor that
    // accidentally drops a part or wire mapping is caught.
    expect(result.parts.length).toBe(5);
    expect(result.wiring.length).toBe(7);
    expect(result.document).toBeDefined();
    expect(result.sketchSource.length).toBeGreaterThan(0);
    expect(result.board).toBe("Arduino Uno R3");
  });

  it("maps the canonical archetype to its UI title and blurb", () => {
    const result = pipelineToProject(loadDefaultFixture());
    expect(result.title).toBe("Waving robot arm");
    expect(result.blurb.length).toBeGreaterThan(0);
  });

  it("populates refineSuggestions and a placeholder confidence", () => {
    const result = pipelineToProject(loadDefaultFixture());
    expect(result.refineSuggestions.length).toBeGreaterThan(0);
    expect(result.confidence).toBe(95);
  });
});

describe("pipelineToProject — error paths", () => {
  it("throws on an unknown SKU with the SKU in the message", () => {
    const doc = cloneDoc(loadDefaultFixture());
    doc.components.push({ id: "x1", sku: "9999", quantity: 1 });
    expect(() => pipelineToProject(doc)).toThrow(/Unknown SKU: 9999/);
  });

  it("throws on an empty SKU with an empty value after the colon", () => {
    const doc = cloneDoc(loadDefaultFixture());
    // Bypass Zod's `string().min(1)` constraint — the adapter never
    // re-parses, so this exercises the lookupBySku("") -> undefined branch.
    doc.components.push({ id: "x2", sku: "", quantity: 1 });
    // Anchor the regex to the exact error string. A loose `/Unknown SKU:/`
    // would also match the unknown-SKU case above; only `/^Unknown SKU: $/`
    // proves the empty-SKU branch was the one that fired.
    expect(() => pipelineToProject(doc)).toThrow(/^Unknown SKU: $/);
  });
});

describe("pipelineToProject — archetype mapping", () => {
  it("uses the schema archetype_id as the project key for non-canonical archetypes", () => {
    const doc = cloneDoc(loadDefaultFixture());
    // Swapping archetype to esp32-audio-dashboard makes isWavingArmFixture
    // return false (archetype check fails first), so the key falls through
    // to doc.archetype_id and the title comes from ARCHETYPE_TITLES.
    doc.archetype_id = "esp32-audio-dashboard";
    const result = pipelineToProject(doc);
    expect(result.key).toBe("esp32-audio-dashboard");
    expect(result.title).toBe("Audio dashboard");
    expect(result.blurb.length).toBeGreaterThan(0);
  });

  it("falls back to archetype_id as title when the archetype is unknown", () => {
    const doc = cloneDoc(loadDefaultFixture());
    // Cast through `as` to bypass Zod's enum constraint — adapter trusts
    // its typed input and never re-parses. This exercises the
    // `ARCHETYPE_TITLES[id] ?? { title: doc.archetype_id, blurb: "" }`
    // fallback branch in the adapter.
    doc.archetype_id =
      "unknown-archetype-xyz" as unknown as VolteuxArchetypeId;
    const result = pipelineToProject(doc);
    expect(result.title).toBe("unknown-archetype-xyz");
    expect(result.blurb).toBe("");
    expect(result.key).toBe("unknown-archetype-xyz");
  });
});

describe("pipelineToProject — mapWireColor (via public API)", () => {
  // Schema-allowed wire colors plus the documented UI-palette mappings
  // for the two that don't have direct equivalents (orange -> yellow,
  // white -> blue). See adapter.ts mapWireColor switch.
  const cases: ReadonlyArray<{
    input: VolteuxWireColor;
    expected: WireColor;
  }> = [
    { input: "red", expected: "red" },
    { input: "black", expected: "black" },
    { input: "yellow", expected: "yellow" },
    { input: "blue", expected: "blue" },
    { input: "green", expected: "green" },
    { input: "orange", expected: "yellow" },
    { input: "white", expected: "blue" },
  ];

  it.each(cases)(
    "maps wire_color=$input to UI color=$expected",
    ({ input, expected }) => {
      const doc = cloneDoc(loadDefaultFixture());
      doc.connections[0].wire_color = input;
      const result = pipelineToProject(doc);
      expect(result.wiring[0].color).toBe(expected);
    },
  );

  it("maps an undefined wire_color to blue (default branch)", () => {
    const doc = cloneDoc(loadDefaultFixture());
    // wire_color is `.optional()` in the schema (see schemas/document.zod.ts
    // line 84) — undefined is reachable through Zod without bypass.
    doc.connections[0].wire_color = undefined;
    const result = pipelineToProject(doc);
    expect(result.wiring[0].color).toBe("blue");
  });

  it("maps an unrecognized wire_color string to blue (default branch)", () => {
    const doc = cloneDoc(loadDefaultFixture());
    // Cast through `as` to bypass Zod's WIRE_COLORS enum — adapter
    // trusts its typed input. This exercises the `default:` arm of
    // mapWireColor for the only-runtime-reachable case where pipeline
    // emits a non-enum string (defensive coding inside the adapter).
    doc.connections[0].wire_color =
      "fuchsia" as unknown as VolteuxWireColor;
    const result = pipelineToProject(doc);
    expect(result.wiring[0].color).toBe("blue");
  });
});
