import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseHole,
  holeToXY,
  shiftHole,
  ORIGIN_X,
  TOP_ROW_Y,
  COL_SPACING,
  ROW_SPACING,
  CHANNEL,
} from "../panels/breadboard-geometry";

// Pure synchronous helpers — no async, no DOM, no timers actually fire here.
// We keep the fake-timer skeleton for consistency with the sibling tests
// (LoadingView.test.tsx, etc.) so timer-leak guards are uniform across files.
describe("breadboard-geometry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("parseHole", () => {
    it("parses a1 (top-left corner)", () => {
      expect(parseHole("a1")).toEqual({ row: "a", col: 1 });
    });

    it("parses j30 (bottom-right corner)", () => {
      expect(parseHole("j30")).toEqual({ row: "j", col: 30 });
    });

    it("parses e15 (mid-grid, last top-half row)", () => {
      expect(parseHole("e15")).toEqual({ row: "e", col: 15 });
    });

    it.each([
      ["k1", "row 'k' is outside a-j"],
      ["a31", "col > 30"],
      ["a0", "col < 1 (regex starts at [1-9])"],
      ["", "empty string"],
      ["1a", "wrong order — digit before letter"],
      ["A1", "uppercase row not allowed"],
    ])("returns null for %s (%s)", (input) => {
      expect(parseHole(input)).toBeNull();
    });
  });

  describe("holeToXY", () => {
    it("places a1 at the top-left origin", () => {
      // x = ORIGIN_X + (1-1)*COL_SPACING = 29 + 0 = 29
      // y = TOP_ROW_Y + 0*ROW_SPACING + 0 (no CHANNEL, top half) = 40
      expect(holeToXY({ row: "a", col: 1 })).toEqual({ x: 29, y: 40 });
    });

    it("places e1 at the last top-half row WITHOUT the channel offset", () => {
      // rowIdx for e = 4 → still top half (< 5), no CHANNEL applied.
      // y = 40 + 4*16 + 0 = 104
      const expected = { x: ORIGIN_X, y: TOP_ROW_Y + 4 * ROW_SPACING };
      expect(expected).toEqual({ x: 29, y: 104 });
      expect(holeToXY({ row: "e", col: 1 })).toEqual({ x: 29, y: 104 });
    });

    it("places f1 at the first bottom-half row WITH the channel offset", () => {
      // rowIdx for f = 5 → bottom half, CHANNEL added.
      // y = 40 + 5*16 + 16 = 136
      const expected = {
        x: ORIGIN_X,
        y: TOP_ROW_Y + 5 * ROW_SPACING + CHANNEL,
      };
      expect(expected).toEqual({ x: 29, y: 136 });
      expect(holeToXY({ row: "f", col: 1 })).toEqual({ x: 29, y: 136 });
    });

    it("places j30 at the bottom-right corner with the channel offset", () => {
      // x = 29 + 29*18 = 551; y = 40 + 9*16 + 16 = 200
      const expected = {
        x: ORIGIN_X + 29 * COL_SPACING,
        y: TOP_ROW_Y + 9 * ROW_SPACING + CHANNEL,
      };
      expect(expected).toEqual({ x: 551, y: 200 });
      expect(holeToXY({ row: "j", col: 30 })).toEqual({ x: 551, y: 200 });
    });
  });

  describe("shiftHole", () => {
    it("shifts in-bounds: c5 by (+1, +2) → d7", () => {
      expect(shiftHole({ row: "c", col: 5 }, 1, 2)).toEqual({
        row: "d",
        col: 7,
      });
    });

    it("returns null when shifting off the top (a1 by -1 row)", () => {
      expect(shiftHole({ row: "a", col: 1 }, -1, 0)).toBeNull();
    });

    it("returns null when shifting off the bottom (j1 by +1 row)", () => {
      expect(shiftHole({ row: "j", col: 1 }, 1, 0)).toBeNull();
    });

    it("returns null when shifting off the left (a1 by -1 col → col 0)", () => {
      expect(shiftHole({ row: "a", col: 1 }, 0, -1)).toBeNull();
    });

    it("returns null when shifting off the right (a30 by +1 col → col 31)", () => {
      expect(shiftHole({ row: "a", col: 30 }, 0, 1)).toBeNull();
    });

    it("crosses the center channel as a plain row step (e15 +1 row → f15)", () => {
      // The shift is purely an indexOf step in ROWS — there's no special
      // handling for crossing from the top-half (e) to the bottom-half (f).
      expect(shiftHole({ row: "e", col: 15 }, 1, 0)).toEqual({
        row: "f",
        col: 15,
      });
    });
  });
});
