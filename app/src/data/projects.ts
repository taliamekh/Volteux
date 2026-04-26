// ============================================================
// Volteux — local refinement logic + landing-view examples
// ============================================================
// Post-U1 this module no longer carries a canned project catalog —
// `pipelineToProject(loadDefaultFixture())` (see ./adapter + ./fixtures)
// drives the result view from `fixtures/uno-ultrasonic-servo.json`
// instead. What stays here is shape-agnostic: the chat-refinement logic
// (operates on the `Project` view-model, doesn't care about its source),
// a `summarizeChange` stub for the optional Anthropic-summary toast,
// and the landing's example prompts.

import type { Project } from "../types";

export const examples: string[] = [
  "a robot arm that waves when something gets close",
  "a gate that opens when I walk up to it",
  "a desk lamp that turns on when my hand is over it",
];

/**
 * Apply a chat refinement to a project. Returns the next project plus a flag
 * indicating whether anything actually changed (used by the chat to choose
 * "Updated: …" vs "Got it — no changes needed").
 *
 * Note on `project.key === "robot-arm-wave"`: the U1 adapter maps the
 * canonical waving-arm fixture (Uno + HC-SR04 + SG90 + breadboard) onto
 * this key so this branch keeps working without edits here.
 */
export function applyRefinement(
  project: Project,
  refinement: string,
): { project: Project; changed: boolean } {
  const p: Project = JSON.parse(JSON.stringify(project));
  const r = (refinement ?? "").toLowerCase();
  let changed = false;

  // "wave N times" → wrap the inner wave block in a for-loop. Operates on
  // p.sketchSource (what Monaco renders) AND p.document.sketch.main_ino (what
  // the URL-hash share encodes), per code-review kt-001/kt-002. v0 limitation:
  // the regex only matches the canonical waving-arm wave block (arm.write up
  // / delay / arm.write down / delay) and only on the first refinement —
  // calling "wave N times" twice in a row leaves the count from the first
  // call (the for-loop is already there). Tracked as v0.5 follow-up to do
  // proper AST-level rewriting once Track 2 owns the refine path.
  const waveMatch = r.match(/(\d+)\s*times?/);
  if (waveMatch && project.key === "robot-arm-wave") {
    const n = Number.parseInt(waveMatch[1]!, 10);
    const waveBlock =
      /(\s*)arm\.write\(160\);\s*\n\s*delay\(300\);\s*\n\s*arm\.write\(20\);\s*\n\s*delay\(300\);\s*\n/;
    const wrapBlock = (_match: string, indent: string): string => {
      const pad = indent.replace(/\n/g, "");
      return (
        `\n${pad}for (int i = 0; i < ${n}; i++) {\n` +
        `${pad}  arm.write(160);\n${pad}  delay(300);\n` +
        `${pad}  arm.write(20);\n${pad}  delay(300);\n` +
        `${pad}}\n`
      );
    };
    const nextSketch = p.sketchSource.replace(waveBlock, wrapBlock);
    if (nextSketch !== p.sketchSource) {
      p.sketchSource = nextSketch;
      p.document = {
        ...p.document,
        sketch: {
          ...p.document.sketch,
          main_ino: nextSketch,
        },
      };
      changed = true;
    }
  }

  // "really close" / "trigger when closer" → tighten the threshold.
  // Update both representations: legacy p.code (still mutated for any consumer
  // that hasn't migrated yet) AND p.sketchSource + p.document.sketch.main_ino
  // (what Monaco renders + what the URL-hash share encodes). Per code review
  // (kt-001/api-001), refinements that only touch p.code are silently invisible
  // because U4 swapped CodePanel to render sketchSource via Monaco.
  if (/really close|closer|10\s*cm|nearby/.test(r)) {
    p.code = p.code.map((line) =>
      line.kind === "raw"
        ? {
            kind: "raw",
            parts: line.parts.map((part) =>
              part.k === "num" && part.t === "25" ? { k: "num" as const, t: "10" } : part,
            ),
          }
        : line,
    );
    p.sketchSource = p.sketchSource.replace(/distance < 25/g, "distance < 10");
    p.document = {
      ...p.document,
      sketch: {
        ...p.document.sketch,
        main_ino: p.document.sketch.main_ino.replace(/distance < 25/g, "distance < 10"),
      },
    };
    changed = true;
  }

  // "add a beep" → push a buzzer part + wire. v0 known limitation: the buzzer
  // SKU "1536" isn't in components/registry.ts, so the WiringPanel will warn
  // and skip its breadboard placement (that's fine — it appears in parts list
  // and connections legend). We push to BOTH the view-model AND the canonical
  // document so the Adafruit cart URL (reads doc.components) and URL-hash
  // share (encodes doc) include the buzzer — fixes correctness/api-001 silent
  // breakage. Adding "1536" to the registry is a Track-2 / Talia joint commit
  // tracked as v0.5 follow-up.
  if (/beep|buzz|sound|noise/.test(r) && !p.parts.find((x) => x.id === "buzzer")) {
    p.parts.push({
      id: "buzzer",
      name: "Piezo buzzer",
      sku: "SKU 1536",
      price: 1.95,
      qty: 1,
      icon: "buzzer",
      desc: "Makes a beep when you toggle a pin on it.",
      pos: { x: 30, y: 70 },
    });
    p.wiring.push({ from: "Buzzer+", to: "D5", color: "purple", pin: "D5" });
    p.document = {
      ...p.document,
      components: [
        ...p.document.components,
        { id: "bz1", sku: "1536", quantity: 1 },
      ],
      connections: [
        ...p.document.connections,
        {
          from: { component_id: "bz1", pin_label: "+" },
          to: { component_id: "u1", pin_label: "D5" },
          wire_color: "yellow",
          purpose: "Buzzer signal pin",
        },
      ],
    };
    changed = true;
  }

  // "stay open longer" — kept for the (currently unreachable) automatic-gate
  // archetype. Dead code today; flagged in maintainability review M-04 for
  // cleanup once the archetype is either added or formally dropped.
  if (/longer|more time|stay open/.test(r) && project.key === "automatic-gate") {
    p.code = p.code.map((line) =>
      line.kind === "raw"
        ? {
            kind: "raw",
            parts: line.parts.map((part) =>
              part.k === "num" && part.t === "5000" ? { k: "num" as const, t: "10000" } : part,
            ),
          }
        : line,
    );
    p.sketchSource = p.sketchSource.replace(/delay\(5000\)/g, "delay(10000)");
    changed = true;
  }

  return { project: p, changed };
}

/**
 * Optional Anthropic-summary stub. The prototype called Claude Design's
 * `window.claude.complete`, which doesn't exist outside that host. Wiring
 * this to a real backend route is a Track 1 follow-up; for now it's a
 * no-op so the rest of the chat flow keeps working with `tweaks.useAi`.
 */
export async function summarizeChange(
  _refinement: string,
  _project: Project,
): Promise<string | null> {
  return null;
}
