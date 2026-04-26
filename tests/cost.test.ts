/**
 * Unit tests for `pipeline/cost.ts`'s `CostTracker`.
 *
 * Coverage (per plan § Unit 7 Test scenarios — cost subset):
 *   - Cost: cache hit accumulator math (Sonnet rates).
 *   - Cost: cache-miss + creation accumulator math.
 *   - Cost: zero usage accumulates 0.
 *   - Per-model rate snapshot test (frozen rate table).
 *   - Per-model attribution via `breakdown()`.
 *   - Model-id normalization (full SDK id + short form both accepted).
 *   - Unknown model id no-ops without throwing.
 *   - Compile call accumulates $0 in v0.1.
 *   - Cache fields tolerate null (raw SdkUsage shape).
 */

import { describe, expect, test } from "bun:test";
import { CostTracker, __testing } from "../pipeline/cost.ts";

// ---------------------------------------------------------------------------
// Rate-table snapshot
// ---------------------------------------------------------------------------

describe("__testing.snapshotRates", () => {
  test("Sonnet 4.6 rates match the committed Anthropic pricing", () => {
    const rates = __testing.snapshotRates();
    expect(rates["sonnet-4-6"].input).toBe(3);
    expect(rates["sonnet-4-6"].cache_write).toBe(3.75);
    expect(rates["sonnet-4-6"].cache_read).toBe(0.3);
    expect(rates["sonnet-4-6"].output).toBe(15);
  });

  test("Haiku 4.5 rates match the committed Anthropic pricing", () => {
    const rates = __testing.snapshotRates();
    expect(rates["haiku-4-5"].input).toBe(1);
    expect(rates["haiku-4-5"].cache_write).toBe(1.25);
    expect(rates["haiku-4-5"].cache_read).toBe(0.1);
    expect(rates["haiku-4-5"].output).toBe(5);
  });

  test("rate table is frozen — mutation attempts throw or no-op", () => {
    const rates = __testing.snapshotRates();
    expect(Object.isFrozen(rates)).toBe(true);
    expect(Object.isFrozen(rates["sonnet-4-6"])).toBe(true);
    expect(Object.isFrozen(rates["haiku-4-5"])).toBe(true);
  });

  test("Compile API cost-per-call is $0 in v0.1", () => {
    expect(__testing.compileUsdPerCall()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Accumulator math — Sonnet
// ---------------------------------------------------------------------------

describe("CostTracker — Sonnet accumulator math", () => {
  test("zero usage accumulates 0", () => {
    const tracker = new CostTracker();
    tracker.track(
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      "sonnet-4-6",
    );
    expect(tracker.total()).toBe(0);
    expect(tracker.breakdown().sonnet).toBe(0);
  });

  test("100 input tokens at $3/MTok = $0.0003", () => {
    const tracker = new CostTracker();
    tracker.track(
      {
        input_tokens: 100,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      "sonnet-4-6",
    );
    // 100 * 3 / 1_000_000 = 0.0003
    expect(tracker.total()).toBeCloseTo(0.0003, 7);
  });

  test("cache hit: 100 input + 50 output + 1000 cache_read", () => {
    const tracker = new CostTracker();
    tracker.track(
      {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 1000,
      },
      "sonnet-4-6",
    );
    // 100 * $3 + 50 * $15 + 1000 * $0.30 per MTok
    // = (100*3 + 50*15 + 1000*0.30) / 1_000_000 USD
    // = (300 + 750 + 300) / 1_000_000
    // = 1350 / 1_000_000
    // = 0.00135
    expect(tracker.total()).toBeCloseTo(0.00135, 7);
  });

  test("cache miss + creation: 1500 input + 200 output + 3000 cache_creation", () => {
    const tracker = new CostTracker();
    tracker.track(
      {
        input_tokens: 1500,
        output_tokens: 200,
        cache_creation_input_tokens: 3000,
        cache_read_input_tokens: 0,
      },
      "sonnet-4-6",
    );
    // 1500*3 + 200*15 + 3000*3.75 per MTok
    // = (4500 + 3000 + 11250) / 1_000_000
    // = 18750 / 1_000_000
    // = 0.01875
    expect(tracker.total()).toBeCloseTo(0.01875, 7);
  });

  test("repeated tracks accumulate cumulatively", () => {
    const tracker = new CostTracker();
    tracker.track(
      {
        input_tokens: 1000,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      "sonnet-4-6",
    );
    tracker.track(
      {
        input_tokens: 1000,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      "sonnet-4-6",
    );
    // 2000 * $3 / 1_000_000 = 0.006
    expect(tracker.total()).toBeCloseTo(0.006, 7);
  });
});

// ---------------------------------------------------------------------------
// Accumulator math — Haiku
// ---------------------------------------------------------------------------

describe("CostTracker — Haiku accumulator math", () => {
  test("zero usage accumulates 0", () => {
    const tracker = new CostTracker();
    tracker.track(
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      "haiku-4-5",
    );
    expect(tracker.total()).toBe(0);
  });

  test("Haiku rates are 1/3 of Sonnet for input + output", () => {
    const tracker = new CostTracker();
    tracker.track(
      {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      "haiku-4-5",
    );
    // 1000 * $1 + 500 * $5 per MTok
    // = (1000 + 2500) / 1_000_000
    // = 0.0035
    expect(tracker.total()).toBeCloseTo(0.0035, 7);
  });
});

// ---------------------------------------------------------------------------
// Per-model attribution — breakdown
// ---------------------------------------------------------------------------

describe("CostTracker — breakdown attribution", () => {
  test("Sonnet + Haiku tracked separately and total sums them", () => {
    const tracker = new CostTracker();
    // 1000 Sonnet input = 1000 * $3 / 1_000_000 = 0.003
    tracker.track(
      {
        input_tokens: 1000,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      "sonnet-4-6",
    );
    // 1000 Haiku input = 1000 * $1 / 1_000_000 = 0.001
    tracker.track(
      {
        input_tokens: 1000,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      "haiku-4-5",
    );
    const breakdown = tracker.breakdown();
    expect(breakdown.sonnet).toBeCloseTo(0.003, 7);
    expect(breakdown.haiku).toBeCloseTo(0.001, 7);
    expect(breakdown.compile).toBe(0);
    expect(tracker.total()).toBeCloseTo(0.004, 7);
  });

  test("compile call accumulates $0 in v0.1 and shows up in breakdown", () => {
    const tracker = new CostTracker();
    tracker.trackCompile();
    tracker.trackCompile();
    expect(tracker.breakdown().compile).toBe(0);
    expect(tracker.total()).toBe(0);
  });

  test("two trackers do not share state (per-run isolation)", () => {
    const a = new CostTracker();
    const b = new CostTracker();
    a.track(
      {
        input_tokens: 10000,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      "sonnet-4-6",
    );
    expect(a.total()).toBeGreaterThan(0);
    expect(b.total()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Model-id normalization
// ---------------------------------------------------------------------------

describe("CostTracker — model-id normalization", () => {
  test("accepts short id `sonnet-4-6`", () => {
    expect(__testing.normalizeModel("sonnet-4-6")).toBe("sonnet-4-6");
  });

  test("accepts full SDK id `claude-sonnet-4-6`", () => {
    expect(__testing.normalizeModel("claude-sonnet-4-6")).toBe("sonnet-4-6");
  });

  test("accepts short id `haiku-4-5`", () => {
    expect(__testing.normalizeModel("haiku-4-5")).toBe("haiku-4-5");
  });

  test("accepts full SDK id `claude-haiku-4-5`", () => {
    expect(__testing.normalizeModel("claude-haiku-4-5")).toBe("haiku-4-5");
  });

  test("returns null for unknown model id", () => {
    expect(__testing.normalizeModel("opus-3")).toBeNull();
    expect(__testing.normalizeModel("")).toBeNull();
  });

  test("track() no-ops on unknown model (does not throw, does not bill)", () => {
    const tracker = new CostTracker();
    expect(() =>
      tracker.track(
        {
          input_tokens: 10_000,
          output_tokens: 10_000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        "future-model-not-in-rate-table",
      ),
    ).not.toThrow();
    expect(tracker.total()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cache-field nullability tolerance
// ---------------------------------------------------------------------------

describe("CostTracker — cache field nullability", () => {
  test("track() tolerates null cache fields (raw SdkUsage shape)", () => {
    const tracker = new CostTracker();
    tracker.track(
      {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
      "sonnet-4-6",
    );
    // Same as zero cache fields: 100*3 + 50*15 = 1050 / 1_000_000 = 0.00105
    expect(tracker.total()).toBeCloseTo(0.00105, 7);
  });
});

// ---------------------------------------------------------------------------
// CostTrackerLike interface conformance
// ---------------------------------------------------------------------------

describe("CostTracker — CostTrackerLike conformance", () => {
  test("`track` and `total` match the orchestrator's CostTrackerLike contract", () => {
    const tracker = new CostTracker();
    // The orchestrator passes the SDK's full id; we tolerate it.
    tracker.track(
      {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      "claude-sonnet-4-6",
    );
    expect(typeof tracker.total).toBe("function");
    expect(typeof tracker.total()).toBe("number");
    expect(tracker.total()).toBeGreaterThan(0);
  });
});
