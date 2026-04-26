/**
 * Compile-API client for the v0 Uno flash spike harness.
 *
 *   buildGetHex(deps) → (req) => Promise<GetHexResult>
 *   getHex(req, opts?) → Promise<GetHexResult>           // convenience
 *
 * Mirrors `runCompileGate` in `pipeline/gates/compile.ts`: same Bearer
 * auth, same JSON envelope shape, same 30s `AbortController` timeout.
 * The only structural difference is the failure surface — the gate's
 * 7-literal `CompileGateFailureKind` (transport / timeout / auth /
 * bad-request / rate-limit / queue-full / compile-error) collapses
 * here into ONE spike-level kind: `compile-api-unreachable`. The
 * gate's underlying kind is preserved verbatim in the `errors` array
 * so the spike report can name the actual failure mode without
 * widening the spike's failure surface.
 *
 * Why collapse vs reuse the gate. Reuse would force the spike to
 * import `pipeline/gates/compile.ts` and pull in Zod + the gate's
 * full envelope-parse machinery. The spike is a leaf node that only
 * needs `{ok: true, hex_b64, sketch_main_ino} | {ok: false, kind:
 * "compile-api-unreachable", reason}` — a 30-LOC client is the right
 * granularity. The gate's failure-classification work is duplicated
 * structurally (same status-code branches) but the spike's surface
 * stays minimal.
 *
 * Wire-contract uniformity. `{ok: true, ...} | {ok: false, kind, ...}`
 * matching the rest of the codebase. Bare throws cross the boundary
 * ONLY at input-validation guards (empty `sketch_main_ino`, missing
 * fqbn). Network failures, server errors, and timeouts return
 * `{ok: false, kind: "compile-api-unreachable", ...}`.
 *
 * **Logger discipline.** Do NOT log the bearer secret, the request
 * body, or `process.env`. The Anthropic SDK's request logger is OFF
 * by default; same discipline here.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "http://localhost:8787";
const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GetHexRequest {
  fqbn: string;
  sketch_main_ino: string;
  additional_files?: Readonly<Record<string, string>>;
  libraries?: ReadonlyArray<string>;
}

/**
 * The harness consumes both `hex_b64` (for `avrgirl.flash(buffer)`) and
 * `sketch_main_ino` (so the spike report can record the exact .ino bytes
 * that produced the .hex on this run — a deterministic-record surface
 * for cross-platform comparison).
 */
export interface GetHexValue {
  hex_b64: string;
  sketch_main_ino: string;
}

/**
 * Wire-contract uniform result. Only one failure kind: the spike doesn't
 * widen its surface. The `reason` field carries the underlying class so
 * the spike report can name the actual gate-level failure ("server down"
 * vs "401 auth" vs "429 rate-limit" vs "503 queue-full").
 */
export type GetHexResult =
  | { ok: true; value: GetHexValue }
  | {
      ok: false;
      kind: "compile-api-unreachable";
      message: string;
      reason: string;
      errors: ReadonlyArray<string>;
    };

export interface GetHexDeps {
  /** Compile API base URL (default `http://localhost:8787`). */
  baseUrl: string;
  /** Bearer secret. Empty string means "unauth path" (will 401). */
  secret: string;
  /** Fetch implementation. Tests inject a fake fetch. */
  fetch: typeof fetch;
  /** Request timeout in ms (default 30_000). */
  timeoutMs: number;
}

export interface GetHexOptions {
  /** Override individual deps fields for one call. */
  deps?: Partial<GetHexDeps>;
  /** Caller-cancellation signal forwarded to fetch. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Server response shape
// ---------------------------------------------------------------------------

/**
 * The Compile API's success envelope. We don't pull in Zod here — the
 * spike's risk of accepting a malformed 200 response is low (the same
 * server is exercising the gate's full Zod validation in production
 * paths, and a malformed envelope here would fail downstream when
 * avrgirl tries to parse the hex bytes). The shape is enforced via a
 * narrow runtime predicate.
 */
interface CompileApiSuccessEnvelope {
  ok: true;
  artifact_b64: string;
  artifact_kind?: string;
  stderr?: string;
  cache_hit?: boolean;
  toolchain_version_hash: string;
}

function isCompileApiSuccess(raw: unknown): raw is CompileApiSuccessEnvelope {
  if (raw === null || typeof raw !== "object") return false;
  const obj = raw as Record<string, unknown>;
  if (obj["ok"] !== true) return false;
  if (typeof obj["artifact_b64"] !== "string") return false;
  if (typeof obj["toolchain_version_hash"] !== "string") return false;
  return true;
}

// ---------------------------------------------------------------------------
// Default deps factory (lazy, in-flight promise)
// ---------------------------------------------------------------------------

/**
 * The lazy-init slot stores the in-flight PROMISE, not the resolved
 * deps. This forecloses the concurrent-init race documented in
 * `docs/solutions/logic-errors/lazy-init-singleton-in-flight-promise-bun-test-isolation-2026-04-26.md`:
 * two simultaneous `getHex()` calls in tests would otherwise both pass
 * the `null` check before either assigned the slot. The cached promise
 * means both `await` the same value.
 *
 * The function is NOT `async` — the slot is assigned synchronously
 * inside the IIFE so a `defaultGetHexDeps() === defaultGetHexDeps()`
 * promise-identity check passes. An `async` wrapper would create a
 * fresh `Promise` wrapper on every call regardless of the cache,
 * masking whether the slot was set synchronously.
 *
 * Test-only reset lives in the `__testing` namespace below — Bun's
 * test runner shares modules across files, so a populated slot from
 * one test would leak deps into a subsequent test's mock-injection
 * path otherwise.
 */
let cachedDefaultDepsPromise: Promise<GetHexDeps> | null = null;

export function defaultGetHexDeps(): Promise<GetHexDeps> {
  if (cachedDefaultDepsPromise !== null) return cachedDefaultDepsPromise;
  cachedDefaultDepsPromise = (async () => {
    return {
      baseUrl: process.env["COMPILE_API_URL"] ?? DEFAULT_BASE_URL,
      secret: process.env["COMPILE_API_SECRET"] ?? "",
      fetch: globalThis.fetch,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    };
  })();
  return cachedDefaultDepsPromise;
}

/**
 * Test-only escape hatch. Production code MUST NOT import from here.
 * Mirrors `infra/server/cache.ts`'s `__testing` namespace shape; the
 * `__testing.x` form is the codebase standard for test-only state
 * eviction (see lazy-init learning §"namespace form" recommendation).
 */
export const __testing = {
  resetDefaultGetHexDeps(): void {
    cachedDefaultDepsPromise = null;
  },
};

// ---------------------------------------------------------------------------
// Factory + convenience wrapper
// ---------------------------------------------------------------------------

/**
 * Build a get-hex closure. Pure: no env reads, no module-load
 * side-effects. Tests construct deps inline; production wires
 * `defaultGetHexDeps()`.
 */
export function buildGetHex(
  deps: GetHexDeps,
): (
  req: GetHexRequest,
  opts?: { signal?: AbortSignal },
) => Promise<GetHexResult> {
  return async function getHexInner(
    req: GetHexRequest,
    innerOpts: { signal?: AbortSignal } = {},
  ): Promise<GetHexResult> {
    // Input-validation guards (THROW; no recovery is meaningful).
    if (req.fqbn === "") {
      throw new Error("get-hex: fqbn is required");
    }
    if (req.sketch_main_ino === "") {
      throw new Error("get-hex: sketch_main_ino is required");
    }

    const controller = new AbortController();
    // If the caller passed a signal, propagate its abort to the
    // controller so a single timeout-clearing path covers both cases.
    if (innerOpts.signal !== undefined) {
      if (innerOpts.signal.aborted) controller.abort();
      else
        innerOpts.signal.addEventListener("abort", () => controller.abort(), {
          once: true,
        });
    }
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs);

    let response: Response;
    try {
      response = await deps.fetch(`${deps.baseUrl}/api/compile`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${deps.secret}`,
        },
        body: JSON.stringify({
          fqbn: req.fqbn,
          sketch_main_ino: req.sketch_main_ino,
          additional_files: req.additional_files ?? {},
          libraries: req.libraries ?? [],
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const aborted =
        (err as Error).name === "AbortError" ||
        (err as { code?: string }).code === "ABORT_ERR";
      const message = (err as Error).message ?? String(err);
      return {
        ok: false,
        kind: "compile-api-unreachable",
        message: aborted
          ? `compile-api request aborted (timeout ${deps.timeoutMs}ms or caller cancellation)`
          : `compile-api unreachable at ${deps.baseUrl}: ${message}`,
        reason: aborted ? "timeout" : "transport",
        errors: [message],
      };
    }
    clearTimeout(timer);

    // Status-code branches mirror runCompileGate's classification, but
    // every non-200 collapses to `compile-api-unreachable` here. The
    // `reason` carries the gate-level discriminator verbatim so the
    // spike report can record "401" vs "429" vs "503" without widening
    // the spike's failure-kind union.
    if (response.status === 401) {
      return {
        ok: false,
        kind: "compile-api-unreachable",
        message: "compile-api rejected bearer secret (401)",
        reason: "auth",
        errors: ["401"],
      };
    }
    if (response.status === 429) {
      return {
        ok: false,
        kind: "compile-api-unreachable",
        message: "compile-api rate-limited (429)",
        reason: "rate-limit",
        errors: ["429"],
      };
    }
    if (response.status === 503) {
      const retryAfter = response.headers.get("Retry-After") ?? "";
      return {
        ok: false,
        kind: "compile-api-unreachable",
        message: `compile-api queue-full (503${retryAfter !== "" ? `; Retry-After=${retryAfter}` : ""})`,
        reason: "queue-full",
        errors: ["503"],
      };
    }
    if (response.status === 400) {
      return {
        ok: false,
        kind: "compile-api-unreachable",
        message: "compile-api rejected request shape (400)",
        reason: "bad-request",
        errors: ["400"],
      };
    }
    if (response.status !== 200) {
      return {
        ok: false,
        kind: "compile-api-unreachable",
        message: `compile-api returned unexpected status ${response.status}`,
        reason: "transport",
        errors: [String(response.status)],
      };
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch (err) {
      return {
        ok: false,
        kind: "compile-api-unreachable",
        message: "compile-api returned non-JSON 200 response",
        reason: "transport",
        errors: [(err as Error).message],
      };
    }

    if (!isCompileApiSuccess(raw)) {
      // 200 with `{ok: false, ...}` envelope → arduino-cli compile
      // failed on the server. The spike report records the stderr;
      // the harness treats this as compile-api-unreachable for failure
      // routing because the spike doesn't have a separate
      // "compile-error" kind (the realistic recovery is "fix your
      // .ino", not "retry the spike").
      const obj = (raw ?? {}) as Record<string, unknown>;
      const stderr = typeof obj["stderr"] === "string" ? obj["stderr"] : "";
      return {
        ok: false,
        kind: "compile-api-unreachable",
        message: "compile-api returned 200 with non-success envelope",
        reason: "compile-error",
        errors: stderr !== "" ? [stderr] : [],
      };
    }

    return {
      ok: true,
      value: {
        hex_b64: raw.artifact_b64,
        sketch_main_ino: req.sketch_main_ino,
      },
    };
  };
}

/**
 * Convenience entry point. Lazily wraps `defaultGetHexDeps()`.
 * Tests should call `buildGetHex(mockDeps)` directly.
 */
export async function getHex(
  req: GetHexRequest,
  opts: GetHexOptions = {},
): Promise<GetHexResult> {
  const base = await defaultGetHexDeps();
  const deps: GetHexDeps =
    opts.deps !== undefined ? { ...base, ...opts.deps } : base;
  const inner = buildGetHex(deps);
  return inner(
    req,
    opts.signal !== undefined ? { signal: opts.signal } : {},
  );
}
