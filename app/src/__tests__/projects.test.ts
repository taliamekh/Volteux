// ============================================================
// Volteux UI — applyRefinement reducer coverage (U1, Cluster C)
// ============================================================
// Behavioral coverage for every branch of applyRefinement in
// app/src/data/projects.ts:
//   - "wave N times"            (project.key === "robot-arm-wave")
//   - "really close" / nearby   (sketch + code mutation)
//   - "add a beep" / buzz       (parts + wiring + document mutation)
//   - "stay open longer"        (DEAD BRANCH today — project.key === "automatic-gate")
//
// The canonical fixture (loadDefaultFixture) drives the input Project
// via pipelineToProject. Because the fixture's sketch source uses
// `waveServo.write(angle)` (not the legacy `arm.write(160/20)` block) and
// `cm < CLOSE_DISTANCE_CM` (not the literal `distance < 25`), tests that
// exercise the regex-driven sketchSource mutations override only
// `sketchSource` + `document.sketch.main_ino` on top of the real project
// shape. This mirrors the U5 wire-color pattern: real Project from real
// fixture, surgical override of the bytes the reducer is keying on.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { applyRefinement } from "../data/projects";
import { pipelineToProject } from "../data/adapter";
import { loadDefaultFixture } from "../data/fixtures";
import type { Project } from "../types";

// --- Helpers ---------------------------------------------------------------

/**
 * Build a fresh Project from the canonical fixture for each test, so no
 * test leaks state into another (applyRefinement is supposed to clone
 * its input; this guard catches us if it ever stops doing so).
 */
function freshProject(): Project {
  return pipelineToProject(loadDefaultFixture());
}

/**
 * Deep-clone a Project for "wrong key" tests. structuredClone is available
 * in Node 18+ (jsdom test runner) but we keep the JSON fallback for safety.
 */
function clone(p: Project): Project {
  if (typeof structuredClone === "function") {
    return structuredClone(p);
  }
  return JSON.parse(JSON.stringify(p)) as Project;
}

/**
 * Synthetic .ino source containing the legacy `arm.write(160/20)` wave
 * block that the wave-N-times regex actually matches. Used only by the
 * wave-branch happy path; not invented fixture data — it's the smallest
 * source string that exercises the regex on top of a real Project shape.
 */
const SYNTHETIC_WAVE_SKETCH = [
  "#include <Servo.h>",
  "Servo arm;",
  "void setup() { arm.attach(9); }",
  "void loop() {",
  "  arm.write(160);",
  "  delay(300);",
  "  arm.write(20);",
  "  delay(300);",
  "}",
  "",
].join("\n");

/**
 * Build a project whose sketchSource (and document.sketch.main_ino) is
 * the synthetic wave sketch. Everything else (parts, wiring, key, etc.)
 * comes from the canonical fixture.
 */
function projectWithWaveSketch(): Project {
  const p = freshProject();
  p.sketchSource = SYNTHETIC_WAVE_SKETCH;
  if (p.document) {
    p.document = {
      ...p.document,
      sketch: { ...p.document.sketch, main_ino: SYNTHETIC_WAVE_SKETCH },
    };
  }
  return p;
}

/**
 * Build a project whose sketchSource contains the literal `distance < 25`
 * the "really close" replace() keys on. Same pattern as projectWithWaveSketch.
 */
const SYNTHETIC_DISTANCE_SKETCH = [
  "void loop() {",
  "  long distance = readDistanceCm();",
  "  if (distance < 25) {",
  "    wave();",
  "  }",
  "  delay(100);",
  "}",
  "",
].join("\n");

function projectWithDistanceSketch(): Project {
  const p = freshProject();
  p.sketchSource = SYNTHETIC_DISTANCE_SKETCH;
  if (p.document) {
    p.document = {
      ...p.document,
      sketch: { ...p.document.sketch, main_ino: SYNTHETIC_DISTANCE_SKETCH },
    };
  }
  return p;
}

// --- Suite -----------------------------------------------------------------

describe("applyRefinement", () => {
  // Vitest fake-timer setup is convention here even though applyRefinement
  // is purely synchronous — keeps a uniform shape with the rest of __tests__/
  // so timer leaks across files surface early. (See LoadingView.test.tsx.)
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

  // ---------- "wave N times" branch ---------------------------------------

  describe("wave N times branch", () => {
    it("wraps the wave block in a for-loop on the canonical waving-arm key", () => {
      const project = projectWithWaveSketch();
      const before = JSON.stringify(project);

      const { project: next, changed } = applyRefinement(project, "wave 3 times");

      expect(changed).toBe(true);
      expect(next.sketchSource).toContain("for (int i = 0; i < 3; i++) {");
      expect(next.sketchSource).toContain("arm.write(160);");
      expect(next.sketchSource).toContain("arm.write(20);");
      // The document mirrors the same change (URL-hash share path).
      expect(next.document?.sketch.main_ino).toContain("for (int i = 0; i < 3; i++) {");
      expect(next.document?.sketch.main_ino).toBe(next.sketchSource);

      // Input immutability — applyRefinement deep-clones internally.
      expect(JSON.stringify(project)).toBe(before);
    });

    it("returns changed === false when the project key is not robot-arm-wave", () => {
      const project = clone(projectWithWaveSketch());
      project.key = "some-other-archetype";
      const before = JSON.stringify(project);

      const { project: next, changed } = applyRefinement(project, "wave 5 times");

      expect(changed).toBe(false);
      expect(next.sketchSource).toBe(project.sketchSource);
      expect(next.sketchSource).not.toContain("for (int i = 0;");
      expect(JSON.stringify(project)).toBe(before);
    });
  });

  // ---------- "really close" branch ---------------------------------------

  describe("really close branch", () => {
    it("tightens distance < 25 to distance < 10 in sketch + document", () => {
      const project = projectWithDistanceSketch();
      const before = JSON.stringify(project);

      const { project: next, changed } = applyRefinement(project, "really close");

      expect(changed).toBe(true);
      expect(next.sketchSource).toContain("distance < 10");
      expect(next.sketchSource).not.toContain("distance < 25");
      expect(next.document?.sketch.main_ino).toContain("distance < 10");
      expect(next.document?.sketch.main_ino).not.toContain("distance < 25");

      // Input immutability.
      expect(JSON.stringify(project)).toBe(before);
    });

    it("rewrites the legacy code-array `25` num token to `10`", () => {
      // Use the canonical fixture directly — its tokenized `code` includes
      // the literal "25" token from `const int CLOSE_DISTANCE_CM = 25;`,
      // which is exactly what the legacy p.code.map() rewrite targets.
      const project = freshProject();
      const before = JSON.stringify(project);

      // Capture the count of "10" num-tokens BEFORE the refinement. The
      // canonical fixture sketch contains other "10" literals (e.g.,
      // `delayMicroseconds(10)`, `delay(100)`), so a naive `some(p.t==="10")`
      // assertion is satisfied trivially. The real signal is: the count
      // grew by exactly the number of "25" tokens that got rewritten.
      const countTen = (p: Project): number =>
        p.code.flatMap((line) =>
          line.kind === "raw" ? line.parts.filter((p) => p.k === "num") : [],
        ).filter((p) => p.t === "10").length;
      const countTwentyFive = (p: Project): number =>
        p.code.flatMap((line) =>
          line.kind === "raw" ? line.parts.filter((p) => p.k === "num") : [],
        ).filter((p) => p.t === "25").length;

      const tensBefore = countTen(project);
      const twentyFivesBefore = countTwentyFive(project);
      expect(twentyFivesBefore).toBeGreaterThan(0); // sanity — fixture has "25"

      const { project: next, changed } = applyRefinement(project, "really close");

      expect(changed).toBe(true);

      // The "25" tokens are gone, and the "10" count grew by exactly that
      // many — proving the rewrite did the substitution rather than just
      // incidentally touching some other line.
      expect(countTwentyFive(next)).toBe(0);
      expect(countTen(next)).toBe(tensBefore + twentyFivesBefore);

      // Input immutability.
      expect(JSON.stringify(project)).toBe(before);
    });

    it("matches the `10 cm` synonym (regex alternation)", () => {
      const project = projectWithDistanceSketch();
      const before = JSON.stringify(project);

      const { project: next, changed } = applyRefinement(project, "trigger at 10 cm");

      expect(changed).toBe(true);
      expect(next.sketchSource).toContain("distance < 10");
      expect(next.sketchSource).not.toContain("distance < 25");
      expect(JSON.stringify(project)).toBe(before);
    });
  });

  // ---------- "add a beep" branch -----------------------------------------

  describe("add a beep branch", () => {
    it("appends a buzzer part, wiring entry, and document component+connection", () => {
      const project = freshProject();
      const before = JSON.stringify(project);
      const partsCountBefore = project.parts.length;
      const wiringCountBefore = project.wiring.length;
      const docComponentsBefore = project.document?.components.length ?? 0;
      const docConnectionsBefore = project.document?.connections.length ?? 0;

      const { project: next, changed } = applyRefinement(project, "add a beep");

      expect(changed).toBe(true);

      // View-model side: parts + wiring grew by one each, with the right shape.
      expect(next.parts.length).toBe(partsCountBefore + 1);
      const buzzerPart = next.parts.find((p) => p.id === "buzzer");
      expect(buzzerPart).toBeDefined();
      expect(buzzerPart?.name).toBe("Piezo buzzer");

      expect(next.wiring.length).toBe(wiringCountBefore + 1);
      const buzzerWire = next.wiring.find((w) => w.from === "Buzzer+");
      expect(buzzerWire).toBeDefined();
      expect(buzzerWire?.pin).toBe("D5");

      // Document side: components include bz1/SKU 1536, connections include
      // the Buzzer signal-pin entry.
      expect(next.document?.components.length).toBe(docComponentsBefore + 1);
      const docBuzzer = next.document?.components.find((c) => c.id === "bz1");
      expect(docBuzzer).toEqual({ id: "bz1", sku: "1536", quantity: 1 });

      expect(next.document?.connections.length).toBe(docConnectionsBefore + 1);
      const buzzerConn = next.document?.connections.find(
        (c) => c.from.component_id === "bz1",
      );
      expect(buzzerConn?.from.pin_label).toBe("+");
      expect(buzzerConn?.to.component_id).toBe("u1");
      expect(buzzerConn?.to.pin_label).toBe("D5");
      expect(buzzerConn?.purpose).toBe("Buzzer signal pin");

      // Input immutability.
      expect(JSON.stringify(project)).toBe(before);
    });

    it("is idempotent — second call returns changed === false", () => {
      const project = freshProject();

      const first = applyRefinement(project, "add a beep");
      expect(first.changed).toBe(true);

      const second = applyRefinement(first.project, "add a beep");
      expect(second.changed).toBe(false);

      // Buzzer count must still be exactly 1 after the no-op pass.
      const buzzerCount = second.project.parts.filter((p) => p.id === "buzzer").length;
      expect(buzzerCount).toBe(1);
    });
  });

  // ---------- "stay open longer" (dead automatic-gate) branch -------------

  describe("automatic-gate stay-open branch (currently dead)", () => {
    it("returns changed === false when key is not automatic-gate (current dead state)", () => {
      // Canonical fixture project has key === "robot-arm-wave", not
      // "automatic-gate", so this branch is unreachable — covers the M-04
      // dead-code state so the deletion follow-up has a clean diff signal.
      const project = freshProject();
      const before = JSON.stringify(project);

      const { project: next, changed } = applyRefinement(project, "stay open longer");

      expect(changed).toBe(false);
      expect(next.sketchSource).toBe(project.sketchSource);
      expect(JSON.stringify(project)).toBe(before);
    });

    it("rewrites delay(5000) to delay(10000) when key === automatic-gate", () => {
      // Synthesise a project with the dead branch's expected key + the
      // delay literal it keys on. Verifies the dead branch's documented
      // behavior so M-04's deletion PR has a clean diff signal.
      const base = freshProject();
      const project = clone(base);
      project.key = "automatic-gate";
      const synthSketch = "void loop() {\n  delay(5000);\n}\n";
      project.sketchSource = synthSketch;
      if (project.document) {
        project.document = {
          ...project.document,
          sketch: { ...project.document.sketch, main_ino: synthSketch },
        };
      }
      const before = JSON.stringify(project);

      const { project: next, changed } = applyRefinement(project, "stay open longer");

      expect(changed).toBe(true);
      expect(next.sketchSource).toContain("delay(10000)");
      expect(next.sketchSource).not.toContain("delay(5000)");

      // Input immutability.
      expect(JSON.stringify(project)).toBe(before);
    });
  });

  // ---------- No-op cases --------------------------------------------------

  describe("no-op cases", () => {
    it("returns changed === false for an empty refinement string", () => {
      const project = freshProject();
      const before = JSON.stringify(project);

      const { project: next, changed } = applyRefinement(project, "");

      expect(changed).toBe(false);
      expect(JSON.stringify(next)).toBe(before);
      expect(JSON.stringify(project)).toBe(before);
    });

    it("returns changed === false for a refinement with no matching keyword", () => {
      const project = freshProject();
      const before = JSON.stringify(project);

      const { project: next, changed } = applyRefinement(project, "make it green");

      expect(changed).toBe(false);
      expect(JSON.stringify(next)).toBe(before);
      expect(JSON.stringify(project)).toBe(before);
    });
  });

  // Note: input immutability is asserted inline in every branch test above
  // (search "Input immutability") rather than as a separate it.each block,
  // because each branch's test already takes a JSON.stringify snapshot
  // before the call and asserts against it after. Adding a parallel it.each
  // here would re-cover the same ground without catching anything new.
});
