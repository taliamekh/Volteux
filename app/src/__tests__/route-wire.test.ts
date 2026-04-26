import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  routeWire,
  assignBusOffsets,
  BUS_OFFSET_SLOTS,
} from "../data/route-wire";

// Pure synchronous helpers — no async, no DOM, no timers actually fire here.
// We keep the fake-timer skeleton for consistency with the sibling tests
// (breadboard-geometry.test.ts, etc.) so timer-leak guards are uniform.
describe("route-wire", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("routeWire — default (busOffset = 0)", () => {
    it("emits H-then-V form starting at the source for a diagonal run", () => {
      // (10,20) → (50,60); midX = round((10+50)/2) = 30
      // Expected: M 10 20 H 30 V 60 H 50
      expect(routeWire({ x: 10, y: 20 }, { x: 50, y: 60 }, 0)).toBe(
        "M 10 20 H 30 V 60 H 50",
      );
    });

    it("uses busOffset = 0 by default when omitted", () => {
      expect(routeWire({ x: 10, y: 20 }, { x: 50, y: 60 })).toBe(
        "M 10 20 H 30 V 60 H 50",
      );
    });

    it("contains only M, H, and V commands (no diagonals)", () => {
      const path = routeWire({ x: 0, y: 0 }, { x: 100, y: 100 }, 0);
      // Strip command letters and whitespace; everything else must be numeric.
      expect(path).toMatch(/^[MHV0-9 .\-]+$/);
      expect(path).not.toMatch(/[LCQAZ]/i);
    });
  });

  describe("routeWire — non-zero busOffset", () => {
    it("routes through an offset corridor (V → H → V)", () => {
      // (10,20) → (50,60), busOffset = 8 → corridorY = 28
      // Expected: M 10 20 V 28 H 50 V 60
      expect(routeWire({ x: 10, y: 20 }, { x: 50, y: 60 }, 8)).toBe(
        "M 10 20 V 28 H 50 V 60",
      );
    });

    it("supports negative busOffset (corridor above the source)", () => {
      // corridorY = 20 + (-6) = 14
      expect(routeWire({ x: 10, y: 20 }, { x: 50, y: 60 }, -6)).toBe(
        "M 10 20 V 14 H 50 V 60",
      );
    });
  });

  describe("routeWire — degenerate runs", () => {
    it("returns just the move command when source and destination are equal", () => {
      expect(routeWire({ x: 10, y: 20 }, { x: 10, y: 20 }, 0)).toBe("M 10 20");
    });

    it("returns just the move command even with non-zero busOffset on same point", () => {
      // Same-point short-circuit takes priority over bus offset.
      expect(routeWire({ x: 10, y: 20 }, { x: 10, y: 20 }, 6)).toBe("M 10 20");
    });

    it("emits a single V segment for a vertical-only run (sx === dx)", () => {
      const path = routeWire({ x: 10, y: 20 }, { x: 10, y: 60 }, 0);
      expect(path).toBe("M 10 20 V 60");
      expect(path).not.toMatch(/H/);
    });

    it("emits a single H segment for a horizontal-only run (sy === dy)", () => {
      const path = routeWire({ x: 10, y: 20 }, { x: 50, y: 20 }, 0);
      expect(path).toBe("M 10 20 H 50");
      expect(path).not.toMatch(/V/);
    });
  });

  describe("routeWire — invalid input", () => {
    it("warns and returns 'M 0 0' when start has NaN", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const path = routeWire({ x: NaN, y: 20 }, { x: 50, y: 60 }, 0);
        expect(path).toBe("M 0 0");
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });

    it("warns and returns 'M 0 0' when end has NaN", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const path = routeWire({ x: 10, y: 20 }, { x: 50, y: NaN }, 0);
        expect(path).toBe("M 0 0");
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });

    it("warns and returns 'M 0 0' when busOffset is NaN", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const path = routeWire({ x: 10, y: 20 }, { x: 50, y: 60 }, NaN);
        expect(path).toBe("M 0 0");
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });

    it("warns on Infinity inputs (also non-finite)", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const path = routeWire({ x: Infinity, y: 0 }, { x: 0, y: 0 }, 0);
        expect(path).toBe("M 0 0");
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });

    it("does not throw on bad input (no crash contract)", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(() =>
          routeWire({ x: NaN, y: NaN }, { x: NaN, y: NaN }, NaN),
        ).not.toThrow();
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("assignBusOffsets", () => {
    const sample = [
      { fromId: "uno", toId: "servo", fromPin: "9", toPin: "signal" },
      { fromId: "uno", toId: "hcsr04", fromPin: "5v", toPin: "vcc" },
      { fromId: "uno", toId: "hcsr04", fromPin: "gnd", toPin: "gnd" },
      { fromId: "uno", toId: "hcsr04", fromPin: "7", toPin: "trig" },
      { fromId: "uno", toId: "hcsr04", fromPin: "8", toPin: "echo" },
    ];

    it("assigns an offset to every unique connection", () => {
      const result = assignBusOffsets(sample);
      expect(result.size).toBe(sample.length);
    });

    it("only assigns offsets from the BUS_OFFSET_SLOTS palette", () => {
      const result = assignBusOffsets(sample);
      for (const offset of result.values()) {
        expect(BUS_OFFSET_SLOTS).toContain(offset);
      }
    });

    it("is deterministic — same input produces same output across calls", () => {
      const a = assignBusOffsets(sample);
      const b = assignBusOffsets(sample);
      expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
    });

    it("is order-independent — shuffled input produces same per-connection offsets", () => {
      const shuffled = [...sample].reverse();
      const original = assignBusOffsets(sample);
      const reordered = assignBusOffsets(shuffled);
      // Each connection's assigned offset must match between the two runs.
      for (const [key, offset] of original.entries()) {
        expect(reordered.get(key)).toBe(offset);
      }
    });

    it("returns an empty map for an empty connection list", () => {
      const result = assignBusOffsets([]);
      expect(result.size).toBe(0);
    });

    it("dedupes identical connections (same key keeps one entry)", () => {
      const dup = [
        { fromId: "uno", toId: "servo", fromPin: "9", toPin: "signal" },
        { fromId: "uno", toId: "servo", fromPin: "9", toPin: "signal" },
      ];
      const result = assignBusOffsets(dup);
      expect(result.size).toBe(1);
    });

    it("distinguishes connections that differ only in fromPin", () => {
      const conns = [
        { fromId: "uno", toId: "x", fromPin: "1", toPin: "a" },
        { fromId: "uno", toId: "x", fromPin: "2", toPin: "a" },
      ];
      const result = assignBusOffsets(conns);
      expect(result.size).toBe(2);
    });
  });
});
