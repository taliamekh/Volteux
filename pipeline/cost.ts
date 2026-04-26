/**
 * Per-run cost tracker for the v0.1 pipeline.
 *
 * Accumulates USD spend from every classify + generate (+ repair) call
 * using committed Anthropic public per-model rates. Compile API spend is
 * $0 in v0.1 (local arduino-cli on a dev VPS); the slot is wired so v0.2
 * can attach a real per-compile cost without touching callers.
 *
 * **Precision discipline.** Token rates are quoted in USD per million
 * tokens, so a single token costs $3e-6 (Sonnet input). JavaScript number
 * arithmetic at that magnitude drifts under repeated addition (the
 * classic 0.1 + 0.2 ≠ 0.3 pattern, scaled). We accumulate in INTEGER
 * MICROCENTS internally and divide at `total()` / `breakdown()` time:
 *
 *   1 USD            = 100      cents
 *   1 cent           = 100_000  microcents (we store cents × 100_000)
 *   1 USD            = 10_000_000 microcents
 *   1 token (Sonnet input) = $3e-6 = 3¢/MTok = 30 microcents/MTok = 0.00003 microcents/token
 *
 * Wait: 30 microcents / 1_000_000 tokens = 0.00003 microcents/token —
 * still sub-integer per token. The committed rates table stores
 * "microcents per million tokens" (a 7-digit integer for typical rates),
 * and `track()` does `(usage * rate) / 1_000_000` with intermediate
 * Number math that stays within safe-integer range for v0.1 token
 * volumes (a single run consumes < 100k tokens; rate * tokens stays
 * below 2^53). v0.5 may swap to BigInt if per-batch totals climb past
 * the safe-integer ceiling.
 *
 * **Rate-table source of truth.** The constants below are committed in
 * source per the plan's Key Technical Decisions: when v0.5 needs to
 * update rates, the diff is one constant. `__testing.snapshotRates()`
 * exposes a frozen copy for test assertions.
 *
 * **Per-run instances, never shared.** The orchestrator constructs a
 * fresh `CostTracker` for every `runPipeline` invocation
 * (`costTrackerFactory: () => new CostTracker()`). Concurrent runs MUST
 * NOT share counters — the trace writer's per-run `pipeline_summary`
 * end-event uses `cost.total()` as the persisted cost figure.
 *
 * @see docs/plans/2026-04-27-001-feat-v01-pipeline-units-6-7-8-plan.md
 *      § Key Technical Decisions — CostTracker rates committed in source.
 */

import type { CostTrackerLike } from "./index.ts";
import type { SdkUsage } from "./llm/sdk-helpers.ts";

// ---------------------------------------------------------------------------
// Per-model rates (Anthropic public pricing, v0.1 commit)
// ---------------------------------------------------------------------------

/**
 * The model identifier set the tracker accepts. Hyphenated short form so
 * orchestrator call sites don't depend on the full SDK identifier
 * (`claude-sonnet-4-6` vs `claude-sonnet-4-6-20250105` etc.).
 */
export type CostTrackedModel = "sonnet-4-6" | "haiku-4-5";

/**
 * Per-million-token rates in USD. Source: Anthropic public pricing as of
 * the v0.1 plan commit (2026-04-27). When rates change, update this table
 * AND bump the rate_version_hash on the trace event payload (v0.5).
 *
 * Each entry maps the four token classes the SDK reports:
 *   - input — fresh prompt tokens (no cache hit)
 *   - cache_write — prefix tokens being WRITTEN to the cache for the first
 *                   time (Anthropic charges 1.25× input rate for this)
 *   - cache_read — prefix tokens served from a previously-written cache
 *                  entry (Anthropic charges 0.10× input rate)
 *   - output — assistant response tokens
 */
const RATES_USD_PER_MTOK = Object.freeze({
  "sonnet-4-6": Object.freeze({
    input: 3,
    cache_write: 3.75,
    cache_read: 0.3,
    output: 15,
  }),
  "haiku-4-5": Object.freeze({
    input: 1,
    cache_write: 1.25,
    cache_read: 0.1,
    output: 5,
  }),
} satisfies Readonly<
  Record<
    CostTrackedModel,
    Readonly<{
      input: number;
      cache_write: number;
      cache_read: number;
      output: number;
    }>
  >
>);

/**
 * Compile API cost-per-call in v0.1. Local arduino-cli on a dev VPS:
 * effectively $0. v0.2 may attach a per-compile rate when the Compile
 * API moves to managed infra.
 */
const COMPILE_USD_PER_CALL = 0;

// ---------------------------------------------------------------------------
// Microcent integer math (precision discipline)
// ---------------------------------------------------------------------------

/**
 * 1 USD in microcents. `total()` divides the accumulator by this to
 * return a Number USD figure.
 */
const MICROCENTS_PER_USD = 10_000_000;
const MICROCENTS_PER_MTOK_FACTOR = MICROCENTS_PER_USD;

/**
 * Compute microcents charged for a single (tokens, rate-USD-per-MTok)
 * pair. Floors to the nearest microcent so we never over-bill the user
 * for sub-microcent fractions. `Math.round` would also be defensible —
 * floor matches the "no surprises" invariant: a $0.0500001 charge
 * persists as 50_000_010 microcents and round-trips to USD as
 * $0.05000001 within float precision.
 */
function microcentsForUsage(tokens: number, ratePerMTokUsd: number): number {
  // Multiply integer-ish first (Number-safe: tokens stay < 1e6, rate
  // microcents stay < 4e7, product stays < 4e13 — well under 2^53).
  const rateMicrocentsPerMTok = ratePerMTokUsd * MICROCENTS_PER_MTOK_FACTOR;
  // tokens * (microcents/MTok) / 1_000_000 = microcents.
  return Math.floor((tokens * rateMicrocentsPerMTok) / 1_000_000);
}

// ---------------------------------------------------------------------------
// Usage shape (accepts SDK + per-module shapes)
// ---------------------------------------------------------------------------

/**
 * The minimal usage shape `track()` accepts. Mirrors `GenerateUsage` /
 * `ClassifyUsage` (cache fields are non-null after the per-module
 * normalization) AND tolerates the raw `SdkUsage` shape (where the cache
 * fields can be null) so a future caller that hasn't normalized yet
 * doesn't crash.
 */
export type CostTrackerUsage =
  | SdkUsage
  | {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    };

function normalizeNullable(value: number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return value;
}

// ---------------------------------------------------------------------------
// CostTracker class
// ---------------------------------------------------------------------------

/**
 * Per-run cost accumulator. One instance per `runPipeline` invocation;
 * never shared across runs. Implements the orchestrator's
 * `CostTrackerLike` contract so `defaultPipelineDeps()` can swap from
 * `NoopCostTracker` to `new CostTracker()` without touching any caller.
 */
export class CostTracker implements CostTrackerLike {
  /**
   * Accumulator state — all microcents (integers). Per-model breakdown
   * lives here so `breakdown()` is a pure read; total() sums them.
   */
  private sonnetMicrocents = 0;
  private haikuMicrocents = 0;
  private compileMicrocents = 0;

  /**
   * Record token usage for a single LLM call. Pass the model short id
   * (`"sonnet-4-6"` or `"haiku-4-5"`); the orchestrator's call sites
   * pass the SDK's full id (`"claude-sonnet-4-6"`) which we tolerate by
   * stripping the `claude-` prefix.
   */
  track(usage: CostTrackerUsage, model: CostTrackedModel | string): void {
    const normalizedModel = normalizeModel(model);
    if (normalizedModel === null) {
      // Unknown model — accumulate $0 rather than throwing. The
      // orchestrator's per-call-site assertion would be the right place
      // to fail loud; this method stays best-effort so a rate-table
      // refresh in v0.5 never crashes a live pipeline run.
      return;
    }
    const rate = RATES_USD_PER_MTOK[normalizedModel];
    const inputTokens = usage.input_tokens;
    const outputTokens = usage.output_tokens;
    const cacheCreate = normalizeNullable(usage.cache_creation_input_tokens);
    const cacheRead = normalizeNullable(usage.cache_read_input_tokens);
    const microcents =
      microcentsForUsage(inputTokens, rate.input) +
      microcentsForUsage(outputTokens, rate.output) +
      microcentsForUsage(cacheCreate, rate.cache_write) +
      microcentsForUsage(cacheRead, rate.cache_read);
    if (normalizedModel === "sonnet-4-6") {
      this.sonnetMicrocents += microcents;
    } else {
      this.haikuMicrocents += microcents;
    }
  }

  /**
   * Record a compile-call cost. v0.1: always $0 (local arduino-cli). The
   * orchestrator may call this on every compile invocation so v0.2 can
   * swap the rate without touching call sites.
   */
  trackCompile(): void {
    this.compileMicrocents += Math.floor(
      COMPILE_USD_PER_CALL * MICROCENTS_PER_USD,
    );
  }

  /** Total accumulated cost in USD (sum of all per-source breakdowns). */
  total(): number {
    return (
      (this.sonnetMicrocents +
        this.haikuMicrocents +
        this.compileMicrocents) /
      MICROCENTS_PER_USD
    );
  }

  /**
   * Per-source breakdown in USD. Used by the trace writer's
   * `pipeline_summary` end-event so the eval harness can attribute spend
   * by model class without re-summing per-call usage.
   */
  breakdown(): { sonnet: number; haiku: number; compile: number } {
    return {
      sonnet: this.sonnetMicrocents / MICROCENTS_PER_USD,
      haiku: this.haikuMicrocents / MICROCENTS_PER_USD,
      compile: this.compileMicrocents / MICROCENTS_PER_USD,
    };
  }
}

// ---------------------------------------------------------------------------
// Model-id normalization
// ---------------------------------------------------------------------------

/**
 * Map an arbitrary model identifier to the short form the rate table
 * uses. Tolerates both the SDK's full id (`"claude-sonnet-4-6"`) and
 * the short form already (`"sonnet-4-6"`). Returns `null` for unknown
 * models so `track()` can no-op safely.
 */
function normalizeModel(model: string): CostTrackedModel | null {
  if (model === "sonnet-4-6" || model === "claude-sonnet-4-6") {
    return "sonnet-4-6";
  }
  if (model === "haiku-4-5" || model === "claude-haiku-4-5") {
    return "haiku-4-5";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Test-only escape hatches
// ---------------------------------------------------------------------------

/**
 * Test-only namespace. Production code MUST NOT import from here. Mirrors
 * `infra/server/cache.ts`'s `__testing` shape per the lazy-init learning's
 * forward-going prescription.
 */
export const __testing = {
  /**
   * Return a deeply-frozen snapshot of the rate table. Tests assert
   * specific rates without depending on the table's literal shape.
   */
  snapshotRates(): Readonly<
    Record<
      CostTrackedModel,
      Readonly<{
        input: number;
        cache_write: number;
        cache_read: number;
        output: number;
      }>
    >
  > {
    return RATES_USD_PER_MTOK;
  },
  /** Compile cost-per-call constant (test-only read). */
  compileUsdPerCall(): number {
    return COMPILE_USD_PER_CALL;
  },
  /** Microcents per USD constant (test-only read). */
  microcentsPerUsd(): number {
    return MICROCENTS_PER_USD;
  },
  /** Direct accessor for the normalize helper. */
  normalizeModel,
};
