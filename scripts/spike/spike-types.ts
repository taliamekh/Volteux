/**
 * Type contract for the v0 Uno browser-direct flash spike harness.
 *
 *   SpikeFailureKind          — 6-literal discriminated failure union
 *   assertNeverSpikeFailureKind — compile-time exhaustiveness guard
 *   SpikeStepEvent            — 4-step status event shape consumed by
 *                               app/src/components/FlashModal.tsx
 *   SpikeResult               — wire-contract uniform success/failure value
 *   SPIKE_EXIT_CODE           — kind → exit code mapping table
 *
 * Wire-contract uniformity. Hyphenated lowercase literals matching
 * `CompileGateFailureKind` (pipeline/gates/compile.ts) and
 * `GenerateFailureKind` (pipeline/llm/generate.ts). The orchestrator (or
 * Talia's post-spike integration) switches on `kind` to disambiguate
 * without parsing free-text reason strings.
 *
 * Status-event surface. The 4 step IDs (`connect | compile | upload |
 * verify`) match the `STEPS` array in `app/src/components/FlashModal.tsx`
 * verbatim — Talia's integration imports `SpikeStepEvent` directly so
 * her wire-up is mechanical rather than a redesign.
 *
 * **Throwing crosses the boundary ONLY for input-validation guards**
 * (missing required arg, unknown `--mode`). Every avrgirl-arduino error,
 * Compile-API failure, abort signal, port error returns
 * `{ok: false, kind, message, errors?}` so the caller's switch is total.
 */

// ---------------------------------------------------------------------------
// Failure-kind discriminated union
// ---------------------------------------------------------------------------

/**
 * The 6-literal failure-kind union. Each kind maps 1:1 to a distinct
 * Node exit code (1-6) and to a beginner-readable browser surface
 * message in Talia's post-spike integration. The mapping is documented
 * inline in the `SPIKE_EXIT_CODE` table below.
 *
 *   port-not-found          — `--port` device missing OR
 *                              `requestPort()` cancelled by user
 *   write-failed            — avrgirl `flash()` rejected mid-write
 *   verify-mismatch         — avrgirl read-back returned bytes ≠ written
 *   transport               — Web Serial open() failed, USB disconnected
 *                              mid-flash, EOF on read, generic avrgirl
 *                              transport error
 *   compile-api-unreachable — get-hex.ts fetch failed for any reason
 *                              (server down, 401, 429, 503, 5xx, malformed
 *                              response, AbortController timeout). Only
 *                              fires in `--mode=fixture --prompt ...`
 *                              flows; never reachable in `--mode=blink`
 *                              or `--mode=fixture --hex <path>`.
 *   aborted                 — caller's AbortSignal fired (Ctrl+C in Node
 *                              or browser cancellation)
 */
export type SpikeFailureKind =
  | "port-not-found"
  | "write-failed"
  | "verify-mismatch"
  | "transport"
  | "compile-api-unreachable"
  | "aborted";

/**
 * Compile-time exhaustiveness guard for `SpikeFailureKind` switches.
 *
 * Mirrors `assertNeverCompileGateFailureKind` (pipeline/gates/compile.ts)
 * and `assertNeverGenerateFailureKind` (pipeline/llm/generate.ts). The
 * symmetric "assertNever<UnionName>" naming is what lets the orchestrator
 * (or Talia's batch) import all three together without ambiguity.
 *
 * Usage:
 *
 *   switch (kind) {
 *     case "port-not-found":          ...; break;
 *     case "write-failed":            ...; break;
 *     case "verify-mismatch":         ...; break;
 *     case "transport":               ...; break;
 *     case "compile-api-unreachable": ...; break;
 *     case "aborted":                 ...; break;
 *     default: assertNeverSpikeFailureKind(kind);
 *   }
 *
 * If a future change adds a 7th kind to the union without updating the
 * switch, tsc fails at the `default:` site rather than letting the case
 * silently fall through.
 */
export function assertNeverSpikeFailureKind(kind: never): never {
  throw new Error(`Unhandled SpikeFailureKind: ${String(kind)}`);
}

// ---------------------------------------------------------------------------
// Exit-code matrix (Node harness only)
// ---------------------------------------------------------------------------

/**
 * Exit-code matrix per the plan's "SpikeFailureKind decision matrix".
 * Distinct codes per kind so an outer caller (CI, shell pipeline, Talia's
 * integration smoke script) can disambiguate without parsing JSON.
 *
 * 0 is reserved for `{ok: true}`. 1-6 map to the 6 SpikeFailureKind
 * literals; the `Record<SpikeFailureKind, number>` type ensures the table
 * stays in sync with the union (adding a kind without adding an exit code
 * fails the build).
 */
export const SPIKE_EXIT_CODE: Record<SpikeFailureKind, number> = {
  "port-not-found": 1,
  "write-failed": 2,
  "verify-mismatch": 3,
  transport: 4,
  "compile-api-unreachable": 5,
  aborted: 6,
};

// ---------------------------------------------------------------------------
// Status-event surface (FlashModal.tsx contract)
// ---------------------------------------------------------------------------

/**
 * The 4-step IDs that `app/src/components/FlashModal.tsx` already renders.
 * Exposed as a const-asserted tuple so Talia's integration can iterate
 * the same shape rather than re-typing string literals.
 */
export const SPIKE_STEP_IDS = [
  "connect",
  "compile",
  "upload",
  "verify",
] as const;

export type SpikeStepId = (typeof SPIKE_STEP_IDS)[number];

/** Lifecycle state for one step of the 4-step stepper. */
export type SpikeStepState = "pending" | "active" | "done" | "failed";

/**
 * One status event emitted to stderr (Node) or as a CustomEvent (browser).
 *
 * Format on the wire:
 *   STEP=<step> STATUS=<state> [DETAIL=<optional>]
 *
 * The serializer is `formatStatusLine()` in `status-events.ts`. The
 * shape is forward-compatible: adding `progress_pct?: number` to the
 * `upload` event is a non-break, but renaming/removing fields is a
 * break and must be coordinated with Talia per the schema-discipline
 * cadence.
 */
export interface SpikeStepEvent {
  step: SpikeStepId;
  state: SpikeStepState;
  /** Optional human-readable detail (e.g., "wrote 12345 bytes"). */
  detail?: string;
  /** Populated only on `state: "failed"`. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Wire-contract uniform result (mirrors GenerateResult / CompileGateResult)
// ---------------------------------------------------------------------------

/**
 * The harness's `runSpike()` return value. Every avrgirl error,
 * Compile-API failure, abort signal, and port error funnels into the
 * `{ok: false, kind, ...}` branch. Bare throws cross the boundary ONLY
 * at input-validation guards (missing required arg, unknown --mode);
 * those throws are CLI-level (the user's invocation is wrong, no
 * recovery is meaningful).
 *
 * The `errors` array is populated for `compile-api-unreachable` (carries
 * the underlying CompileGateFailureKind as a string) and for
 * `verify-mismatch` (carries the offsets of the first N differing bytes
 * for debugging). Empty for the other kinds.
 */
export type SpikeResult =
  | {
      ok: true;
      port: string;
      hex_size_bytes: number;
      verified: true;
      latency_ms: number;
    }
  | {
      ok: false;
      kind: SpikeFailureKind;
      message: string;
      errors?: ReadonlyArray<string>;
    };
