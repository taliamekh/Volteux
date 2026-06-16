import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  calculatePinPositions,
  getPinAnchor,
  BOARD_DIMENSIONS,
  type BoardKey,
} from "../data/board-data";
import { COMPONENTS } from "../../../components/registry";

const TOL = 0.001;

function expectClose(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(TOL);
}

describe("board-data", () => {
  // Mirror sibling test suites (e.g. breadboard-geometry) — fake timers are
  // unused by these synchronous helpers but kept for consistency so timer-leak
  // guards remain uniform across the test directory.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("BOARD_DIMENSIONS", () => {
    it("exposes dimensions for all four boards", () => {
      const expectedKeys: BoardKey[] = ["uno", "esp32-wroom", "pi-pico", "esp32-c3"];
      for (const key of expectedKeys) {
        const dims = BOARD_DIMENSIONS[key];
        expect(dims).toBeDefined();
        expect(dims.w).toBeGreaterThan(0);
        expect(dims.h).toBeGreaterThan(0);
        expect(dims.d).toBeGreaterThan(0);
      }
    });
  });

  describe("calculatePinPositions", () => {
    it("returns 26 pins for the Uno", () => {
      const pins = calculatePinPositions("uno");
      expect(Object.keys(pins)).toHaveLength(26);
    });

    it("places Uno digital pin D0 at the configured start of the digital header", () => {
      // Digital header: X=-0.90, Z starts at +2.6, step +0.254.
      // Y = (board height/2) + 0.05 = 0.16/2 + 0.05 = 0.13.
      const pins = calculatePinPositions("uno");
      const pin = pins["0"];
      expect(pin).toBeDefined();
      if (!pin) return;
      expectClose(pin.x, -0.9);
      expectClose(pin.y, 0.13);
      expectClose(pin.z, 2.6);
    });

    it("places Uno D7 at the expected stepped Z", () => {
      // i=7 → z = 2.6 + 7*0.254 = 4.378
      const pins = calculatePinPositions("uno");
      const pin = pins["7"];
      expect(pin).toBeDefined();
      if (!pin) return;
      expectClose(pin.x, -0.9);
      expectClose(pin.z, 2.6 + 7 * 0.254);
    });

    it("places Uno AREF at the end of the 16-pin digital header", () => {
      // i=15 → z = 2.6 + 15*0.254 = 6.41
      const pins = calculatePinPositions("uno");
      const aref = pins["AREF"];
      expect(aref).toBeDefined();
      if (!aref) return;
      expectClose(aref.x, -0.9);
      expectClose(aref.z, 2.6 + 15 * 0.254);
    });

    it("places Uno 5V at the configured start of the power/analog header", () => {
      // Power/analog: X=+0.55, Z starts at -2.55 step -0.254.
      const pins = calculatePinPositions("uno");
      const pin = pins["5V"];
      expect(pin).toBeDefined();
      if (!pin) return;
      expectClose(pin.x, 0.55);
      expectClose(pin.z, -2.55);
    });

    it("places Uno A5 at the end of the 10-pin power/analog header", () => {
      // i=9 → z = -2.55 - 9*0.254 = -4.836
      const pins = calculatePinPositions("uno");
      const a5 = pins["A5"];
      expect(a5).toBeDefined();
      if (!a5) return;
      expectClose(a5.x, 0.55);
      expectClose(a5.z, -2.55 - 9 * 0.254);
    });

    it("returns 40 pins for the Pi Pico", () => {
      const pins = calculatePinPositions("pi-pico");
      expect(Object.keys(pins)).toHaveLength(40);
      expect(pins["GP0"]).toBeDefined();
      expect(pins["GP39"]).toBeDefined();
    });

    it("places Pi Pico GP0 at the left column start", () => {
      const pins = calculatePinPositions("pi-pico");
      const pin = pins["GP0"];
      expect(pin).toBeDefined();
      if (!pin) return;
      expectClose(pin.x, -0.55);
      expectClose(pin.z, 0.95);
    });

    it("places Pi Pico GP20 at the right column start (mirrors GP0 in Z)", () => {
      const pins = calculatePinPositions("pi-pico");
      const pin = pins["GP20"];
      expect(pin).toBeDefined();
      if (!pin) return;
      expectClose(pin.x, 0.55);
      expectClose(pin.z, 0.95);
    });

    it("returns 30 pins for the ESP32-WROOM", () => {
      const pins = calculatePinPositions("esp32-wroom");
      expect(Object.keys(pins)).toHaveLength(30);
      expect(pins["GP0"]).toBeDefined();
      expect(pins["GP29"]).toBeDefined();
    });

    it("places ESP32-WROOM GP0 at the left column start", () => {
      const pins = calculatePinPositions("esp32-wroom");
      const pin = pins["GP0"];
      expect(pin).toBeDefined();
      if (!pin) return;
      expectClose(pin.x, -0.55);
      expectClose(pin.z, 0.84);
    });

    it("returns 23 pins for the ESP32-C3", () => {
      const pins = calculatePinPositions("esp32-c3");
      expect(Object.keys(pins)).toHaveLength(23);
      expect(pins["GP0"]).toBeDefined();
      expect(pins["GP22"]).toBeDefined();
    });

    it("places ESP32-C3 left column at X=-0.35 and right column at X=+0.35", () => {
      const pins = calculatePinPositions("esp32-c3");
      const left = pins["GP0"];
      const right = pins["GP15"];
      expect(left).toBeDefined();
      expect(right).toBeDefined();
      if (!left || !right) return;
      expectClose(left.x, -0.35);
      expectClose(right.x, 0.35);
    });
  });

  describe("getPinAnchor", () => {
    it("returns three + breadboard for an Uno digital pin (D7)", () => {
      const anchor = getPinAnchor("uno", "D7");
      expect(anchor).not.toBeNull();
      if (!anchor) return;
      expect(anchor.three).toBeDefined();
      expect(anchor.breadboard).not.toBeNull();
    });

    it("accepts the bare-digit form for Uno digital pins (7)", () => {
      const anchor = getPinAnchor("uno", "7");
      expect(anchor).not.toBeNull();
      if (!anchor) return;
      expect(anchor.breadboard).not.toBeNull();
    });

    it("returns three but breadboard:null for an off-grid Uno pin (VIN-equivalent: 5V)", () => {
      const anchor = getPinAnchor("uno", "5V");
      expect(anchor).not.toBeNull();
      if (!anchor) return;
      expect(anchor.three).toBeDefined();
      expect(anchor.breadboard).toBeNull();
    });

    it("treats the registry's '3.3V' and the silkscreen-style '3V3' as the same pin", () => {
      const a = getPinAnchor("uno", "3.3V");
      const b = getPinAnchor("uno", "3V3");
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      if (!a || !b) return;
      expectClose(a.three.x, b.three.x);
      expectClose(a.three.z, b.three.z);
    });

    it("returns null (not throw) for unknown pin name", () => {
      expect(getPinAnchor("uno", "BOGUS")).toBeNull();
    });

    it("returns three + breadboard for a Pi Pico GP pin", () => {
      const anchor = getPinAnchor("pi-pico", "GP5");
      expect(anchor).not.toBeNull();
      if (!anchor) return;
      expect(anchor.three).toBeDefined();
      expect(anchor.breadboard).not.toBeNull();
    });

    it("returns null for out-of-range Pi Pico GP", () => {
      expect(getPinAnchor("pi-pico", "GP99")).toBeNull();
    });

    it("returns null for ESP32-C3 pin past 22", () => {
      expect(getPinAnchor("esp32-c3", "GP23")).toBeNull();
    });
  });

  describe("registry parity (Uno)", () => {
    it("every registry pin with an anchor is resolvable in calculatePinPositions output", () => {
      const uno = COMPONENTS["50"];
      const pins = calculatePinPositions("uno");

      const missing: string[] = [];
      for (const meta of uno.pin_metadata) {
        if (!meta.anchor) continue;
        // Either present directly, or via Uno label aliasing.
        const direct = pins[meta.label] !== undefined;
        const aliased = getPinAnchor("uno", meta.label) !== null;
        if (!direct && !aliased) {
          missing.push(meta.label);
        }
      }

      expect(missing).toEqual([]);
    });
  });
});
