// KAI-DONE (Unit 1): Pin geometry adapter for 4 boards (Uno, Pi Pico,
// ESP32-WROOM, ESP32-C3). Cross-validates Uno against components/registry.ts
// pin_metadata[].anchor — registry stays authoritative per CLAUDE.md schema discipline.

/**
 * Shared board geometry data — single source of truth for pin positions
 * across the 4 boards Volteux supports for the v1.5 UI deep pass.
 *
 * Pin positions derive from real header geometry at 2.54 mm pitch (0.1") which
 * maps to 0.254 Three.js units per step (1 unit = 1 cm in our scene).
 *
 * Pure module: no React imports, no side effects, no I/O. Consumed by both
 * the 3D HeroScene (Three.js coordinates) and the 2D breadboard view
 * (column/row coordinates).
 */

/** Three.js coordinate (centimeters in scene units). */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** 2D breadboard coordinate (col, row are integer hole indices). */
export interface BreadboardCoord {
  readonly col: number;
  readonly row: number;
}

/** Identifier for the 4 boards supported in v1.5. */
export type BoardKey = "uno" | "esp32-wroom" | "pi-pico" | "esp32-c3";

/** Pin positions keyed by pin label. Three.js space. */
export type PinPositionMap = Readonly<Record<string, Vec3>>;

/**
 * Combined pin anchor — Three.js position plus optional 2D breadboard
 * coordinate. `breadboard` is null for pins that don't sit on the breadboard
 * grid in our 3D layout (e.g. the Uno's 5V/GND/analog header which the user
 * connects via jumper wires from the side).
 */
export interface PinAnchor {
  readonly three: Vec3;
  readonly breadboard: BreadboardCoord | null;
}

/** Physical board outline (centimeters, Three.js scene units). */
export interface BoardDimensions {
  readonly w: number;
  readonly h: number;
  readonly d: number;
}

// -----------------------------------------------------------------------------
// Constants — header geometry. 2.54 mm pitch == 0.254 Three.js units.
// -----------------------------------------------------------------------------

/** 0.1 inch (2.54 mm) header pitch in Three.js units. */
const PITCH = 0.254;

/**
 * Half-pitch step used by the Pi Pico's denser through-hole layout.
 * The Pico's 40 pins span 51 mm (~2 cm board height equivalent at 1.27 mm
 * spacing per side). For the 3D model we use a tighter visual pitch.
 */
const PICO_PITCH = 0.127;

/**
 * Board dimensions in Three.js units (1 unit = 1 cm).
 * Sizes approximate real PCB outlines so the 3D scene reads correctly.
 */
export const BOARD_DIMENSIONS: Readonly<Record<BoardKey, BoardDimensions>> = {
  uno: { w: 2.1, h: 0.16, d: 6.85 },
  "esp32-wroom": { w: 2.55, h: 0.16, d: 5.5 },
  "pi-pico": { w: 2.1, h: 0.16, d: 5.1 },
  "esp32-c3": { w: 1.8, h: 0.16, d: 5.0 },
};

/** Y plane where pins poke out of the top of the board. */
function pinY(board: BoardKey): number {
  return BOARD_DIMENSIONS[board].h / 2 + 0.05;
}

// -----------------------------------------------------------------------------
// Uno layout
// -----------------------------------------------------------------------------

/**
 * Uno digital header (16 pins). On the back edge of the board.
 * Indices 0..15 → labels D0..D13, GND_D, AREF.
 */
const UNO_DIGITAL_LABELS: readonly string[] = [
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "11",
  "12",
  "13",
  "GND_D",
  "AREF",
];

/**
 * Uno power/analog header (10 pins). On the front edge of the board.
 * Order along the header (matching Adafruit registry semantics for this v0
 * archetype): 5V, 3.3V, GND, GND2, then A0..A5.
 */
const UNO_POWER_ANALOG_LABELS: readonly string[] = [
  "5V",
  "3.3V",
  "GND",
  "GND2",
  "A0",
  "A1",
  "A2",
  "A3",
  "A4",
  "A5",
];

/** Pins on the Uno's power/analog header don't terminate on the breadboard
 *  surface in 3D space — the user connects them via jumper wires. */
const UNO_OFFGRID_PINS = new Set<string>(UNO_POWER_ANALOG_LABELS);

function unoPositions(): PinPositionMap {
  const y = pinY("uno");
  const out: Record<string, Vec3> = {};

  // Digital header: X = -0.90, Z starts at +2.6 stepping +PITCH per pin.
  const digitalX = -0.9;
  const digitalStartZ = 2.6;
  for (let i = 0; i < UNO_DIGITAL_LABELS.length; i += 1) {
    const label = UNO_DIGITAL_LABELS[i];
    if (label === undefined) continue;
    out[label] = {
      x: digitalX,
      y,
      z: digitalStartZ + i * PITCH,
    };
  }

  // Power/analog header: X = +0.55, Z starts at -2.55 stepping -PITCH per pin.
  const powerX = 0.55;
  const powerStartZ = -2.55;
  for (let i = 0; i < UNO_POWER_ANALOG_LABELS.length; i += 1) {
    const label = UNO_POWER_ANALOG_LABELS[i];
    if (label === undefined) continue;
    out[label] = {
      x: powerX,
      y,
      z: powerStartZ - i * PITCH,
    };
  }

  return out;
}

// -----------------------------------------------------------------------------
// Pi Pico layout — 2 columns of 20 pins each (40 total).
// -----------------------------------------------------------------------------

function picoPositions(): PinPositionMap {
  const y = pinY("pi-pico");
  const out: Record<string, Vec3> = {};
  const startZ = 0.95;

  // Left column: GP0..GP19 at X=-0.55.
  for (let i = 0; i < 20; i += 1) {
    out[`GP${i}`] = {
      x: -0.55,
      y,
      z: startZ - i * PICO_PITCH,
    };
  }

  // Right column: GP20..GP39 at X=+0.55.
  for (let i = 0; i < 20; i += 1) {
    out[`GP${i + 20}`] = {
      x: 0.55,
      y,
      z: startZ - i * PICO_PITCH,
    };
  }

  return out;
}

// -----------------------------------------------------------------------------
// ESP32-WROOM layout — 2 columns of 15 pins (30 total).
// -----------------------------------------------------------------------------

function esp32WroomPositions(): PinPositionMap {
  const y = pinY("esp32-wroom");
  const out: Record<string, Vec3> = {};
  const startZ = 0.84;

  for (let i = 0; i < 15; i += 1) {
    out[`GP${i}`] = {
      x: -0.55,
      y,
      z: startZ - i * PITCH,
    };
  }
  for (let i = 0; i < 15; i += 1) {
    out[`GP${i + 15}`] = {
      x: 0.55,
      y,
      z: startZ - i * PITCH,
    };
  }

  return out;
}

// -----------------------------------------------------------------------------
// ESP32-C3 layout — 15 left + 8 right (23 total, asymmetric module).
// -----------------------------------------------------------------------------

function esp32C3Positions(): PinPositionMap {
  const y = pinY("esp32-c3");
  const out: Record<string, Vec3> = {};
  const startZ = 0.84;

  for (let i = 0; i < 15; i += 1) {
    out[`GP${i}`] = {
      x: -0.35,
      y,
      z: startZ - i * PITCH,
    };
  }
  for (let i = 0; i < 8; i += 1) {
    out[`GP${i + 15}`] = {
      x: 0.35,
      y,
      z: startZ - i * PITCH,
    };
  }

  return out;
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Calculate the Three.js position of every pin on the given board.
 * Returns a fresh object each call (safe for callers to read but the values
 * are conceptually frozen — derived from constants).
 */
export function calculatePinPositions(boardKey: BoardKey): PinPositionMap {
  switch (boardKey) {
    case "uno":
      return unoPositions();
    case "pi-pico":
      return picoPositions();
    case "esp32-wroom":
      return esp32WroomPositions();
    case "esp32-c3":
      return esp32C3Positions();
    default: {
      // Exhaustiveness guard — TS will flag if we add a new board key.
      const _exhaustive: never = boardKey;
      return _exhaustive;
    }
  }
}

/**
 * Approximate breadboard column/row each board pin maps to. The 3D scene
 * places these boards next to a standard 30-column / 10-row breadboard; the
 * mapping here is the visual contract the 2D breadboard view consumes.
 *
 * For the Uno specifically: only the digital-header pins (D0-D13, GND_D,
 * AREF) terminate on the breadboard surface. The power/analog header pins
 * (5V, 3.3V, GND, GND2, A0-A5) get jumper wires off the side of the board
 * and therefore have `breadboard: null`.
 */
function unoBreadboardCoord(label: string, pinIndex: number): BreadboardCoord | null {
  if (UNO_OFFGRID_PINS.has(label)) return null;
  // Digital header sits on rows a..b along columns 1..16 of the breadboard.
  return { col: pinIndex + 1, row: 0 };
}

function picoBreadboardCoord(pinIndex: number): BreadboardCoord {
  // Pico straddles the central channel — left column is row 0, right is row 1.
  const isRight = pinIndex >= 20;
  const colIndex = isRight ? pinIndex - 20 : pinIndex;
  return { col: colIndex + 1, row: isRight ? 1 : 0 };
}

function esp32WroomBreadboardCoord(pinIndex: number): BreadboardCoord {
  const isRight = pinIndex >= 15;
  const colIndex = isRight ? pinIndex - 15 : pinIndex;
  return { col: colIndex + 1, row: isRight ? 1 : 0 };
}

function esp32C3BreadboardCoord(pinIndex: number): BreadboardCoord {
  const isRight = pinIndex >= 15;
  const colIndex = isRight ? pinIndex - 15 : pinIndex;
  return { col: colIndex + 1, row: isRight ? 1 : 0 };
}

/**
 * Resolve a pin name to its full anchor (3D position + optional breadboard
 * coordinate). Returns `null` if the pin is not known on the given board.
 *
 * Accepts a few alias spellings for the Uno so callers using either the
 * registry's labels (e.g. "3.3V") or canonical board labels (e.g. "3V3")
 * land on the same pin.
 */
export function getPinAnchor(boardKey: BoardKey, pinName: string): PinAnchor | null {
  const positions = calculatePinPositions(boardKey);
  const canonical = canonicalizeUnoLabel(boardKey, pinName);
  const three = positions[canonical];
  if (three === undefined) return null;

  let breadboard: BreadboardCoord | null;
  switch (boardKey) {
    case "uno": {
      const idx = UNO_DIGITAL_LABELS.indexOf(canonical);
      breadboard = idx >= 0 ? unoBreadboardCoord(canonical, idx) : null;
      break;
    }
    case "pi-pico": {
      const idx = picoIndexFromLabel(canonical);
      breadboard = idx === null ? null : picoBreadboardCoord(idx);
      break;
    }
    case "esp32-wroom": {
      const idx = genericGpIndex(canonical, 30);
      breadboard = idx === null ? null : esp32WroomBreadboardCoord(idx);
      break;
    }
    case "esp32-c3": {
      const idx = genericGpIndex(canonical, 23);
      breadboard = idx === null ? null : esp32C3BreadboardCoord(idx);
      break;
    }
    default: {
      const _exhaustive: never = boardKey;
      return _exhaustive;
    }
  }

  return { three, breadboard };
}

/** Aliases — registry uses some labels that differ from on-board silkscreen.
 *  Map them to the canonical form used by `calculatePinPositions`. */
function canonicalizeUnoLabel(boardKey: BoardKey, label: string): string {
  if (boardKey !== "uno") return label;
  // Registry sometimes uses "3V3" or "D7"; map to canonical labels.
  if (label === "3V3") return "3.3V";
  if (label.length >= 2 && label.startsWith("D")) {
    const rest = label.slice(1);
    if (/^\d+$/.test(rest)) return rest;
  }
  return label;
}

function picoIndexFromLabel(label: string): number | null {
  return genericGpIndex(label, 40);
}

function genericGpIndex(label: string, max: number): number | null {
  if (!label.startsWith("GP")) return null;
  const rest = label.slice(2);
  if (!/^\d+$/.test(rest)) return null;
  const n = Number.parseInt(rest, 10);
  if (Number.isNaN(n) || n < 0 || n >= max) return null;
  return n;
}
