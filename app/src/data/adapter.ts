// ============================================================
// Volteux — VolteuxProjectDocument → UI Project adapter (U1)
// ============================================================
// The UI panels consume a `Project` view-model (parts/wiring/code arrays
// shaped for direct render). Track 2 emits the canonical
// `VolteuxProjectDocument`; this adapter joins it with `components/registry.ts`
// (the single source of truth for static component metadata per CLAUDE.md
// § Schema discipline) to produce the view-model.
//
// Failure modes: any unknown SKU throws — there is no silent fallback. The
// React error boundary surfaces it. The cross-consistency gate (Track 2)
// already guarantees emitted SKUs are registered, so this should only fire
// during development.

import {
  lookupBySku,
  type ComponentRegistryEntry,
} from "../../../components/registry";
import type { VolteuxProjectDocument } from "../../../schemas/document.zod";
import type {
  CodeLine,
  CodeSegment,
  CodeSegmentKind,
  IconKind,
  Part,
  Position,
  Project,
  WireColor,
  WiringConnection,
} from "../types";

// ---------- Defaults ----------

const DEFAULT_PRICE_BY_SKU: Readonly<Record<string, number>> = {
  "50": 27.5,    // Arduino Uno R3
  "3942": 3.95,  // HC-SR04
  "169": 5.95,   // SG90 servo
  "239": 5.95,   // 830-tie breadboard
  "758": 4.95,   // jumper wires
};

/**
 * Fallback hotspot positions for the 3D hero. Pulled from the canned
 * `robot-arm-wave` project so visual placement is preserved post-swap.
 * Future iteration (U3) will derive these from `pin_metadata.anchor`.
 */
const DEFAULT_POS_BY_SKU: Readonly<Record<string, Position>> = {
  "50": { x: 22, y: 32 },    // Uno
  "3942": { x: 42, y: 53 },  // HC-SR04
  "169": { x: 70, y: 50 },   // SG90 servo
  "239": { x: 50, y: 71 },   // breadboard
  "758": { x: 30, y: 70 },   // jumper wires (rarely shown, fallback)
};

// ---------- Helpers ----------

function iconForEntry(entry: ComponentRegistryEntry): IconKind {
  // SKU-specific overrides win (HC-SR04 = sonar, SG90 = servo, PIR = eye, etc.)
  switch (entry.sku) {
    case "3942":
      return "sonar";
    case "169":
      return "servo";
  }
  // Type-based fallback.
  switch (entry.type) {
    case "mcu":
      return "board";
    case "breadboard":
      return "board";
    case "sensor":
      return "sonar"; // best generic visual for "thing that detects"
    case "actuator":
      return "servo"; // SG90 is the only actuator in v0
    case "display":
      return "led";   // rough fallback; v0 has no displays
    case "passive":
      return "res";
    case "wire":
      return "res";   // jumper wires — closest visual is the squiggly resistor
  }
}

/**
 * Map the schema's wire_color enum to the UI's WireColor. The schema's
 * "white" and "orange" don't have direct UI equivalents in the v0 palette;
 * map them to the closest available color so the renderer doesn't choke.
 * "purple" is UI-only (the chat's "add a beep" path adds it) and never
 * appears in the schema, so it's not produced here.
 */
function mapWireColor(color: string | undefined): WireColor {
  switch (color) {
    case "red":
      return "red";
    case "black":
      return "black";
    case "yellow":
      return "yellow";
    case "blue":
      return "blue";
    case "green":
      return "green";
    case "orange":
      return "yellow"; // closest UI palette match
    case "white":
      return "blue";   // closest UI palette match
    default:
      return "blue";   // safe fallback for missing color
  }
}

// ---------- Tiny C++ tokenizer ----------

const CPP_KEYWORDS = new Set([
  "#include",
  "#define",
  "void",
  "int",
  "long",
  "const",
  "if",
  "else",
  "for",
  "while",
  "return",
  "true",
  "false",
]);

const CPP_FUNCTIONS = new Set([
  "setup",
  "loop",
  "pinMode",
  "digitalRead",
  "digitalWrite",
  "delay",
  "delayMicroseconds",
  "pulseIn",
  "attach",
  "write",
  "begin",
]);

function classifyToken(tok: string): CodeSegmentKind {
  if (CPP_KEYWORDS.has(tok)) return "kw";
  if (CPP_FUNCTIONS.has(tok)) return "fn";
  if (/^\d+$/.test(tok)) return "num";
  return "";
}

/**
 * Coarse line-by-line tokenizer. Renders comments + angle-bracketed includes
 * + a few keywords/functions/numbers. Good enough as a v0 fallback before
 * U4's Monaco editor lands.
 */
function tokenizeSketch(source: string): CodeLine[] {
  const lines = source.split(/\r?\n/);
  const out: CodeLine[] = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      out.push({ kind: "blank" });
      continue;
    }
    if (trimmed.startsWith("//")) {
      out.push({ kind: "com", text: raw });
      continue;
    }
    // Tokenize: keep leading whitespace, then split on word boundaries
    // while preserving angle-bracket strings as a single "str" token.
    const parts: CodeSegment[] = [];
    const leadingWs = raw.match(/^\s*/)?.[0] ?? "";
    if (leadingWs.length > 0) parts.push({ k: "", t: leadingWs });
    const body = raw.slice(leadingWs.length);
    // Regex pieces:
    //   <[^>]+>  — include's angle-bracket payload
    //   #?[A-Za-z_][A-Za-z0-9_]*  — identifiers and preprocessor directives
    //   \d+  — numbers
    //   .  — any single other char (whitespace, punctuation)
    const tokenRe = /<[^>]+>|#?[A-Za-z_][A-Za-z0-9_]*|\d+|./g;
    let match: RegExpExecArray | null;
    while ((match = tokenRe.exec(body)) !== null) {
      const tok = match[0];
      if (tok.startsWith("<") && tok.endsWith(">")) {
        parts.push({ k: "str", t: tok });
      } else {
        const k = classifyToken(tok);
        parts.push({ k, t: tok });
      }
    }
    out.push({ kind: "raw", parts });
  }
  return out;
}

// ---------- Title / project-key mapping ----------

const ARCHETYPE_TITLES: Readonly<Record<string, { title: string; blurb: string }>> = {
  "uno-ultrasonic-servo": {
    title: "Waving robot arm",
    blurb: "A servo arm that waves whenever something gets close.",
  },
  "esp32-audio-dashboard": {
    title: "Audio dashboard",
    blurb: "An ESP32 reads sound levels and renders a live dashboard in the browser.",
  },
  "pico-rotary-oled": {
    title: "Rotary OLED menu",
    blurb: "A Pi Pico drives a small OLED menu you scroll with a rotary encoder.",
  },
  "esp32c3-dht-aio": {
    title: "Cloud temperature logger",
    blurb: "An ESP32-C3 streams temperature/humidity to Adafruit IO.",
  },
  "uno-photoresistor-led": {
    title: "Light-sensing LED",
    blurb: "An LED that brightens as the room gets darker.",
  },
};

/**
 * Detect whether the document is the canonical waving-arm fixture. The chat
 * refinement's `applyRefinement` keys off `project.key === "robot-arm-wave"`
 * for the wave-N-times branch; mapping here keeps that path working without
 * touching the chat code (smaller blast radius — see plan U1's gotcha).
 */
function isWavingArmFixture(doc: VolteuxProjectDocument): boolean {
  if (doc.archetype_id !== "uno-ultrasonic-servo") return false;
  const skus = new Set(doc.components.map((c) => c.sku));
  return skus.has("50") && skus.has("3942") && skus.has("169") && skus.has("239");
}

// ---------- Adapter ----------

/**
 * Convert a parsed VolteuxProjectDocument into the UI's Project view-model.
 * Throws on any unknown SKU (no silent fallback per CLAUDE.md).
 */
export function pipelineToProject(doc: VolteuxProjectDocument): Project {
  // ----- Parts -----
  // Every registered component appears in the parts list (the user still
  // needs to buy the jumper wires, so they belong in the cart). Wires don't
  // get a `breadboard_layout` entry — that's a U5 rendering concern, not a
  // parts-list one.
  const parts: Part[] = [];
  for (const c of doc.components) {
    const entry = lookupBySku(c.sku);
    if (!entry) {
      throw new Error(`Unknown SKU: ${c.sku}`);
    }
    parts.push({
      id: c.id,
      name: entry.name,
      sku: `SKU ${entry.sku}`,
      price: DEFAULT_PRICE_BY_SKU[entry.sku] ?? 0,
      qty: c.quantity,
      icon: iconForEntry(entry),
      desc: entry.education_blurb,
      pos: DEFAULT_POS_BY_SKU[entry.sku] ?? { x: 50, y: 50 },
      ...(entry.type === "sensor" ? { pulse: true } : {}),
    });
  }

  // ----- Wiring (use human-readable pin labels for from/to display) -----
  const wiring: WiringConnection[] = doc.connections.map((conn) => ({
    from: conn.from.pin_label,
    to: conn.to.pin_label,
    color: mapWireColor(conn.wire_color),
    pin: conn.to.pin_label,
  }));

  // ----- Code (tokenize the raw .ino for the legacy span renderer) -----
  const code = tokenizeSketch(doc.sketch.main_ino);

  // ----- Title / blurb / key -----
  const titleInfo = ARCHETYPE_TITLES[doc.archetype_id] ?? {
    title: doc.archetype_id,
    blurb: "",
  };

  const key = isWavingArmFixture(doc) ? "robot-arm-wave" : doc.archetype_id;

  return {
    key,
    match: [],
    board: doc.board.name,
    confidence: 95, // placeholder; real value comes from intent classifier later
    title: titleInfo.title,
    blurb: titleInfo.blurb,
    parts,
    wiring,
    code,
    sketchSource: doc.sketch.main_ino,
    refineSuggestions: [
      "make it wave 3 times",
      "trigger only when really close",
      "add a beep when it triggers",
    ],
  };
}
