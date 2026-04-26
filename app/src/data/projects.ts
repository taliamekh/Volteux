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

  // "wave 3 times" → wrap the loop body in a for-loop
  const waveMatch = r.match(/(\d+)\s*times?/);
  if (waveMatch && project.key === "robot-arm-wave") {
    const n = Number.parseInt(waveMatch[1]!, 10);
    p.code = [
      ...project.code.slice(
        0,
        project.code.findIndex(
          (l) => l.kind === "raw" && l.parts.some((x) => x.t === "  if "),
        ),
      ),
      { kind: "com", text: "// loop body" },
      { kind: "raw", parts: [{ k: "", t: "  " }, { k: "kw", t: "long " }, { k: "", t: "distance = " }, { k: "fn", t: "measureDistance" }, { k: "", t: "();" }] },
      { kind: "raw", parts: [{ k: "", t: "  " }, { k: "kw", t: "if " }, { k: "", t: "(distance < " }, { k: "num", t: "25" }, { k: "", t: ") {" }] },
      { kind: "raw", parts: [{ k: "", t: "    " }, { k: "kw", t: "for " }, { k: "", t: "(" }, { k: "kw", t: "int " }, { k: "", t: "i = " }, { k: "num", t: "0" }, { k: "", t: "; i < " }, { k: "num", t: String(n) }, { k: "", t: "; i++) {" }] },
      { kind: "raw", parts: [{ k: "", t: "      arm." }, { k: "fn", t: "write" }, { k: "", t: "(" }, { k: "num", t: "160" }, { k: "", t: ");" }] },
      { kind: "raw", parts: [{ k: "", t: "      " }, { k: "fn", t: "delay" }, { k: "", t: "(" }, { k: "num", t: "300" }, { k: "", t: ");" }] },
      { kind: "raw", parts: [{ k: "", t: "      arm." }, { k: "fn", t: "write" }, { k: "", t: "(" }, { k: "num", t: "20" }, { k: "", t: ");" }] },
      { kind: "raw", parts: [{ k: "", t: "      " }, { k: "fn", t: "delay" }, { k: "", t: "(" }, { k: "num", t: "300" }, { k: "", t: ");" }] },
      { kind: "raw", parts: [{ k: "", t: "    }" }] },
      { kind: "raw", parts: [{ k: "", t: "  }" }] },
      { kind: "raw", parts: [{ k: "", t: "}" }] },
    ];
    changed = true;
  }

  // "really close" / "trigger when closer" → tighten the threshold
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
    changed = true;
  }

  // "add a beep" → push a buzzer part + wire
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
    changed = true;
  }

  // "stay open longer" → bump the gate-open delay from 5s to 10s
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
