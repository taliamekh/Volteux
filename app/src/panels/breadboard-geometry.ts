// ============================================================
// Volteux — Breadboard geometry helpers (U5)
// ============================================================
// Pure functions converting hole addresses (e.g., "e15") into pixel
// coordinates within a 600x280 SVG viewBox. The hole grid models a
// real breadboard: 10 rows (a-j) split into a top half (a-e) and bottom
// half (f-j) by a center channel, and 30 columns. Component pin layouts
// (`pin_layout` from `components/registry.ts`) compose with an
// `anchor_hole` to position individual pin holes.
//
// Validation: `parseHole` returns `null` for malformed strings instead
// of throwing — callers decide how to surface the error (the WiringPanel
// uses console.warn + skip, per CLAUDE.md "no silent failures").

export type Row = "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i" | "j";

export interface Hole {
  row: Row;
  col: number;
}

export const ROWS: readonly Row[] = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
export const COL_COUNT = 30;
export const COL_SPACING = 18;
export const ROW_SPACING = 16;
export const ORIGIN_X = 29;
export const TOP_ROW_Y = 40;
/** Vertical gap between row e (top half) and row f (bottom half). */
export const CHANNEL = 16;

/**
 * Parse a breadboard hole string ("a1" through "j30").
 * Mirrors the schema regex `^[a-j]([1-9]|[12][0-9]|30)$`.
 * Returns `null` for any malformed input — callers decide how to react.
 */
export function parseHole(s: string): Hole | null {
  const m = /^([a-j])([1-9]|[12][0-9]|30)$/.exec(s);
  if (!m) return null;
  return { row: m[1] as Row, col: Number.parseInt(m[2]!, 10) };
}

/**
 * Convert a Hole into SVG x/y coordinates within the 600x280 viewBox.
 * The bottom half (rows f-j) is offset by CHANNEL pixels to leave space
 * for the breadboard's center groove.
 */
export function holeToXY(h: Hole): { x: number; y: number } {
  const x = ORIGIN_X + (h.col - 1) * COL_SPACING;
  const rowIdx = ROWS.indexOf(h.row);
  const inBottomHalf = rowIdx >= 5;
  const y = TOP_ROW_Y + rowIdx * ROW_SPACING + (inBottomHalf ? CHANNEL : 0);
  return { x, y };
}

/**
 * Shift a hole by row/column offsets, returning a new Hole or `null`
 * if the resulting coordinates fall outside the breadboard.
 * Used to compute pin positions from `anchor_hole + pin_layout`.
 */
export function shiftHole(
  anchor: Hole,
  rowOffset: number,
  columnOffset: number,
): Hole | null {
  const newColIdx = anchor.col + columnOffset;
  const newRowIdx = ROWS.indexOf(anchor.row) + rowOffset;
  if (newColIdx < 1 || newColIdx > COL_COUNT) return null;
  if (newRowIdx < 0 || newRowIdx >= ROWS.length) return null;
  return { row: ROWS[newRowIdx]!, col: newColIdx };
}

/**
 * Schema-side wire color names (`schemas/document.zod.ts` WIRE_COLORS)
 * plus the UI-only "purple" used by the chat refinement path. Unknown
 * colors fall back to grey (`#888`) at the call site.
 */
export const WIRE_COLORS: Readonly<Record<string, string>> = {
  red: "#C8302C",
  black: "#1A1814",
  yellow: "#D9B43C",
  blue: "#3A6FB8",
  green: "#5DA34A",
  white: "#E5E7EB",
  orange: "#E26A2C",
  purple: "#9B6FE0",
};
