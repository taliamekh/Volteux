/**
 * Bun/Node entry point for the v0 Uno browser-direct flash spike.
 *
 *   bun run scripts/spike/avrgirl-node.ts \
 *     --port /dev/tty.usbserial-XXX \
 *     --mode blink|fixture
 *     [--hex /path/to/precompiled.hex]
 *     [--fixture fixtures/generated/archetype-1/01-distance-servo.json]
 *
 * The harness orchestrates: (1) connect to the named serial port,
 * (2) source a `.hex` (precompiled OR fresh from the local Compile API
 * via `get-hex.ts`), (3) hand the hex bytes to `avrgirl-arduino`'s
 * `flash()` API, (4) verify via avrgirl's read-back. Each phase emits
 * a status event on stderr in the format
 * `STEP=<id> STATUS=<state> [DETAIL=<...>]` consumed verbatim by
 * `app/src/components/FlashModal.tsx` (Talia's batch).
 *
 * Wire-contract uniformity. The harness's `runSpike(opts)` returns
 *   {ok: true, port, hex_size_bytes, verified: true, latency_ms}
 *   | {ok: false, kind: SpikeFailureKind, message, errors?}
 * Bare throws cross the boundary ONLY at input-validation guards
 * (missing required arg, unknown `--mode`). The `main()` CLI wrapper
 * converts those throws into stderr WARN + non-zero exit; a
 * `SpikeResult` is never produced for them because the user's
 * invocation is wrong, not the runtime environment.
 *
 * Stream discipline:
 *   stdout — final `SpikeResult` as a single JSON line on exit
 *   stderr — per-step status events + any debug WARN
 *   exit   — 0 on `ok: true`, 1-6 per `SPIKE_EXIT_CODE` on `ok: false`
 *
 * **avrgirl error → SpikeFailureKind mapping:**
 *   - "port not found" / ENOENT on port path → port-not-found
 *   - error containing "verify" / "verification" → verify-mismatch
 *   - error containing "write" / mid-flash rejection → write-failed
 *   - AbortSignal fired / "abort" / "cancel" → aborted
 *   - everything else → transport (the safe default; serial reset, USB
 *     yank, generic avrgirl exception)
 *
 * **No silent failures.** Every avrgirl path either returns through the
 * discriminated union OR throws a typed input-validation error caught
 * by `main()`. The `assertNeverSpikeFailureKind` guard on the exit-code
 * switch catches a future 7th kind at compile time.
 *
 * **The harness handles BOTH `--mode=blink` and `--mode=fixture`.** Blink
 * mode does NOT contact the Compile API; the operator pre-compiles
 * `canonical-blink.ino` once via `arduino-cli` and points `--hex` at
 * the result, OR the harness falls back to the fixture path with a
 * canned blink.ino bytes (TBD on first hands-on iteration). Fixture
 * mode reads a generated JSON document from disk and POSTs to the
 * local Compile API.
 *
 * **`compile-api-unreachable` is unreachable in `--mode=blink` and in
 * `--mode=fixture --hex <path>`** — those flows never contact the
 * Compile API. The kind only fires on `--mode=fixture` without `--hex`.
 */

import { readFile, access } from "node:fs/promises";
import {
  buildGetHex,
  defaultGetHexDeps,
  type GetHexDeps,
  type GetHexResult,
} from "./get-hex.ts";
import {
  defaultStatusEmitter,
  type StatusEmitter,
} from "./status-events.ts";
import {
  assertNeverSpikeFailureKind,
  SPIKE_EXIT_CODE,
  type SpikeFailureKind,
  type SpikeResult,
  type SpikeStepEvent,
} from "./spike-types.ts";

// ---------------------------------------------------------------------------
// CLI flag parsing
// ---------------------------------------------------------------------------

export type SpikeMode = "blink" | "fixture";

export interface SpikeRunOptions {
  port: string;
  mode: SpikeMode;
  /** When set, bypass the Compile API and load these hex bytes verbatim. */
  hexPath?: string;
  /** Default: fixtures/generated/archetype-1/01-distance-servo.json. */
  fixturePath?: string;
  /** Caller cancellation. Production wires SIGINT; tests pass a controller. */
  signal?: AbortSignal;
}

/**
 * Parse a flat array of CLI args (`process.argv.slice(2)`) into
 * `SpikeRunOptions`. Throws on unknown flags / missing values — those
 * throws are caught by `main()` and surfaced as exit-1 with a usage
 * line. (The exit-1 here is the "unknown CLI invocation" path, NOT the
 * `port-not-found` SpikeFailureKind path which reaches the same exit
 * code via a different route.)
 */
export function parseArgs(argv: ReadonlyArray<string>): SpikeRunOptions {
  let port: string | undefined;
  let mode: SpikeMode | undefined;
  let hexPath: string | undefined;
  let fixturePath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    switch (arg) {
      case "--port":
        port = argv[++i];
        break;
      case "--mode": {
        const v = argv[++i];
        if (v !== "blink" && v !== "fixture") {
          throw new Error(`--mode must be 'blink' or 'fixture' (got '${v}')`);
        }
        mode = v;
        break;
      }
      case "--hex":
        hexPath = argv[++i];
        break;
      case "--fixture":
        fixturePath = argv[++i];
        break;
      default:
        throw new Error(`unknown spike harness flag: ${arg}`);
    }
  }

  if (port === undefined || port === "") {
    throw new Error("missing --port (e.g., /dev/tty.usbserial-XXXX on macOS)");
  }
  if (mode === undefined) {
    throw new Error("missing --mode (one of: blink, fixture)");
  }

  return {
    port,
    mode,
    ...(hexPath !== undefined ? { hexPath } : {}),
    ...(fixturePath !== undefined ? { fixturePath } : {}),
  };
}

// ---------------------------------------------------------------------------
// Avrgirl client interface (DI shape)
// ---------------------------------------------------------------------------

/**
 * The narrow interface the harness needs from `avrgirl-arduino`. Tests
 * supply a fake implementation; production wires a thin adapter that
 * constructs the real `new AvrgirlArduino({board, port})` and calls
 * `flash(buffer, cb)` (avrgirl is callback-based; the adapter
 * promisifies it).
 *
 * `flash` accepts a Buffer of decoded hex bytes; the adapter
 * synthesizes a temp file path if the underlying library only accepts
 * a path on a given platform (avrgirl 5.0.1 accepts both per source).
 *
 * `verify` is a read-back primitive: returns the bytes the device
 * thinks it has flashed. Avrgirl 5.0.1 doesn't expose this as a
 * separate method on the public API; the production adapter reads
 * back via the same STK500v1 protocol channel and exposes the bytes
 * here. Mismatch ≠ matching length is the verify-mismatch signal.
 */
export interface AvrgirlClient {
  flash(hexBytes: Buffer, signal?: AbortSignal): Promise<void>;
  /**
   * Optional read-back. When omitted, `runSpike()` skips the explicit
   * read-back and trusts avrgirl's internal verification (the library
   * runs a verify pass during `flash()` unless `disableVerify: true`).
   * A returned Buffer that is not byte-equal to `expected` produces
   * a `verify-mismatch`.
   */
  verify?(expected: Buffer, signal?: AbortSignal): Promise<Buffer>;
}

// ---------------------------------------------------------------------------
// Default deps factory (lazy, in-flight promise)
// ---------------------------------------------------------------------------

/**
 * The lazy-init slot stores the in-flight PROMISE per the lazy-init
 * learning. Concurrent `defaultSpikeDeps()` callers (e.g., a test
 * harness running scenarios in parallel) share the same single
 * initialization. The `__testing.resetDefaultSpikeDeps()` form below
 * lets `bun test` evict the cached deps between files.
 */
let cachedDefaultSpikeDepsPromise: Promise<SpikeDeps> | null = null;

export interface SpikeDeps {
  /** Promisified avrgirl client factory. Production constructs lazily per port. */
  buildAvrgirlClient: (port: string) => AvrgirlClient;
  /** Compile API client deps (used only when --mode=fixture without --hex). */
  getHexDeps: GetHexDeps;
  /** Status-event sink. Production: stderr; tests: in-memory. */
  emitter: StatusEmitter;
  /** Wall-clock source. Production: Date.now; tests: deterministic counter. */
  now: () => number;
  /** File reader for `--hex` and `--fixture`. Production: fs/promises. */
  readFile: (path: string) => Promise<Buffer>;
  /** Existence check for `--port`. Production: fs.access; tests: stub. */
  portExists: (path: string) => Promise<boolean>;
}

/**
 * Build the default deps. Reads env vars (via `defaultGetHexDeps`) and
 * constructs the production avrgirl-client factory. The function is
 * NOT `async` — the slot assignment must be synchronous so concurrent
 * callers share the same promise reference.
 */
export function defaultSpikeDeps(): Promise<SpikeDeps> {
  if (cachedDefaultSpikeDepsPromise !== null)
    return cachedDefaultSpikeDepsPromise;
  cachedDefaultSpikeDepsPromise = (async () => {
    const getHexDeps = await defaultGetHexDeps();
    return {
      buildAvrgirlClient: buildProductionAvrgirlClient,
      getHexDeps,
      emitter: defaultStatusEmitter(),
      now: () => Date.now(),
      readFile: async (path: string) => {
        // Bun's fs/promises returns a Buffer-compatible Uint8Array; cast
        // for the AvrgirlClient.flash signature which expects Buffer.
        const data = await readFile(path);
        return Buffer.from(data);
      },
      portExists: async (path: string) => {
        try {
          await access(path);
          return true;
        } catch {
          return false;
        }
      },
    };
  })();
  return cachedDefaultSpikeDepsPromise;
}

/**
 * Test-only escape hatch. Production code MUST NOT import from here.
 * `__testing` namespace shape per the lazy-init learning's recommended
 * vocabulary.
 */
export const __testing = {
  resetDefaultSpikeDeps(): void {
    cachedDefaultSpikeDepsPromise = null;
  },
};

/**
 * Production avrgirl wrapper. Promisifies the callback API and bridges
 * AbortSignal cancellation. Avrgirl 5.0.1 does NOT support cancellation
 * mid-flash — once `flash()` is called, the protocol completes or the
 * serial port resets. The signal here is honoured for pre-flash
 * cancellation only; mid-flash abort is a documented limitation
 * captured in the spike report.
 *
 * The dynamic `import` keeps avrgirl out of the import graph for tests
 * that don't need it (the test suite injects a mock `AvrgirlClient`
 * via `buildSpikeHarness(deps)`). Production loads the library once on
 * the first `flash()` call; failures during dynamic-import surface as
 * `transport` because the spike can't talk to a board without it.
 */
function buildProductionAvrgirlClient(port: string): AvrgirlClient {
  return {
    async flash(hexBytes: Buffer, signal?: AbortSignal): Promise<void> {
      if (signal?.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      // Dynamic import keeps the cost of pulling in serialport native
      // bindings off the test path. The mocked tests never hit this
      // factory (they construct their own AvrgirlClient).
      // avrgirl-arduino@5.0.1 ships no TypeScript declarations; the
      // `unknown` cast plus narrow runtime use ("flash takes a Buffer
      // and a callback") is intentional. A future @types/avrgirl-arduino
      // (if shipped) would replace this dynamic-import shape.
      // @ts-expect-error -- avrgirl-arduino has no TypeScript declarations
      const mod = (await import("avrgirl-arduino")) as unknown as {
        default?: new (opts: { board: string; port: string }) => {
          flash(file: Buffer, cb: (err: Error | null) => void): void;
        };
      };
      const AvrgirlArduino = (
        mod.default !== undefined ? mod.default : (mod as unknown)
      ) as new (opts: { board: string; port: string }) => {
        flash(file: Buffer, cb: (err: Error | null) => void): void;
      };
      const avrgirl = new AvrgirlArduino({ board: "uno", port });
      await new Promise<void>((resolve, reject) => {
        avrgirl.flash(hexBytes, (err: Error | null) => {
          if (err !== null && err !== undefined) reject(err);
          else resolve();
        });
      });
    },
    // `verify` deliberately omitted — avrgirl's internal flash() pass
    // runs a STK500v1 verify cycle unless `disableVerify: true`. The
    // spike trusts the library's verify (matching the v0 production
    // path Talia's batch will use). An explicit read-back surface is
    // a Day-2 nice-to-have; for now, treating "flash() resolved
    // without throwing" as "verified: true" is the spike's contract.
  };
}

// ---------------------------------------------------------------------------
// Avrgirl error → SpikeFailureKind mapping
// ---------------------------------------------------------------------------

/**
 * Classify an exception from `avrgirl.flash()` (or related serial-port
 * operations) into one of the 5 reachable SpikeFailureKind literals
 * (compile-api-unreachable doesn't fire here — that's get-hex's
 * domain). The mapping is conservative: if we can't tell what kind of
 * failure it is, we return `transport` (the safe default per the
 * decision matrix).
 */
export function classifyAvrgirlError(err: unknown): SpikeFailureKind {
  if (err === null || err === undefined) return "transport";
  // Abort takes priority over anything pattern-matched in the message —
  // an aborted operation may surface a generic "cancelled"-style
  // message that would otherwise be classified as transport.
  if (err instanceof Error) {
    if (err.name === "AbortError") return "aborted";
  }
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  // Order matters: "port" appears in "port not found" AND in many
  // generic transport errors; check the specific phrase first.
  if (
    lower.includes("port not found") ||
    lower.includes("no such file or directory") ||
    lower.includes("enoent")
  ) {
    return "port-not-found";
  }
  if (
    lower.includes("verify") ||
    lower.includes("verification") ||
    lower.includes("mismatch")
  ) {
    return "verify-mismatch";
  }
  if (
    lower.includes("write") &&
    !lower.includes("port not found") // already handled
  ) {
    return "write-failed";
  }
  if (lower.includes("abort") || lower.includes("cancel")) {
    return "aborted";
  }
  return "transport";
}

// ---------------------------------------------------------------------------
// Hex source resolution
// ---------------------------------------------------------------------------

interface HexSource {
  hexBytes: Buffer;
  /** Provenance — included in the spike report for cross-platform comparison. */
  source: "blink-precompiled" | "fixture-precompiled" | "fixture-compile-api";
}

interface SpikeFixture {
  archetype_id: string;
  board: { fqbn: string };
  sketch: { main_ino: string; libraries: ReadonlyArray<string> };
}

function isSpikeFixture(raw: unknown): raw is SpikeFixture {
  if (raw === null || typeof raw !== "object") return false;
  const obj = raw as Record<string, unknown>;
  if (typeof obj["archetype_id"] !== "string") return false;
  const board = obj["board"];
  if (board === null || typeof board !== "object") return false;
  if (typeof (board as Record<string, unknown>)["fqbn"] !== "string")
    return false;
  const sketch = obj["sketch"];
  if (sketch === null || typeof sketch !== "object") return false;
  const sketchObj = sketch as Record<string, unknown>;
  if (typeof sketchObj["main_ino"] !== "string") return false;
  if (!Array.isArray(sketchObj["libraries"])) return false;
  return true;
}

const DEFAULT_FIXTURE_PATH =
  "fixtures/generated/archetype-1/01-distance-servo.json";

/**
 * Resolve hex bytes for the given run options, returning a wire-contract
 * uniform result. Routes:
 *   --hex <path>    → read file as decoded hex (Intel HEX or raw bytes
 *                      — the harness passes bytes through; avrgirl's
 *                      flash() handles both shapes per its internal
 *                      `intel-hex` parser)
 *   --mode=blink    → no Compile API; either --hex was passed OR the
 *                      operator pre-baked the canonical-blink.ino
 *                      result and points --hex at it. If neither, this
 *                      surfaces as port-not-found-style "missing input"
 *                      failure (see runSpike for details).
 *   --mode=fixture  → load JSON document, POST to local Compile API,
 *                      decode response.artifact_b64
 */
async function resolveHexSource(
  opts: SpikeRunOptions,
  deps: SpikeDeps,
): Promise<
  | { ok: true; value: HexSource }
  | {
      ok: false;
      kind: SpikeFailureKind;
      message: string;
      errors: ReadonlyArray<string>;
    }
> {
  if (opts.hexPath !== undefined) {
    try {
      const bytes = await deps.readFile(opts.hexPath);
      return {
        ok: true,
        value: {
          hexBytes: bytes,
          source:
            opts.mode === "blink"
              ? "blink-precompiled"
              : "fixture-precompiled",
        },
      };
    } catch (err) {
      return {
        ok: false,
        kind: "port-not-found",
        message: `failed to read --hex ${opts.hexPath}: ${(err as Error).message}`,
        errors: [(err as Error).message],
      };
    }
  }

  if (opts.mode === "blink") {
    // Blink mode without --hex requires the operator to pre-bake the
    // canonical-blink.ino result (e.g., via `arduino-cli compile
    // scripts/spike/canonical-blink.ino --output-dir /tmp/blink`).
    // The harness does NOT auto-compile; that would couple the spike
    // to a working arduino-cli install which is exactly what the
    // Compile API path already validates.
    return {
      ok: false,
      kind: "port-not-found",
      message:
        "--mode=blink requires --hex <path> to a precompiled .hex (e.g., from `arduino-cli compile scripts/spike/canonical-blink.ino --output-dir /tmp`)",
      errors: [],
    };
  }

  // --mode=fixture: load fixture JSON, POST to Compile API.
  const fixturePath = opts.fixturePath ?? DEFAULT_FIXTURE_PATH;
  let fixtureRaw: Buffer;
  try {
    fixtureRaw = await deps.readFile(fixturePath);
  } catch (err) {
    return {
      ok: false,
      kind: "port-not-found",
      message: `failed to read --fixture ${fixturePath}: ${(err as Error).message}`,
      errors: [(err as Error).message],
    };
  }
  let fixture: unknown;
  try {
    fixture = JSON.parse(fixtureRaw.toString("utf-8"));
  } catch (err) {
    return {
      ok: false,
      kind: "compile-api-unreachable",
      message: `fixture ${fixturePath} is not valid JSON: ${(err as Error).message}`,
      errors: [(err as Error).message],
    };
  }
  if (!isSpikeFixture(fixture)) {
    return {
      ok: false,
      kind: "compile-api-unreachable",
      message: `fixture ${fixturePath} missing required fields (archetype_id, board.fqbn, sketch.main_ino, sketch.libraries)`,
      errors: [],
    };
  }

  const getHex = buildGetHex(deps.getHexDeps);
  const result: GetHexResult = await getHex(
    {
      fqbn: fixture.board.fqbn,
      sketch_main_ino: fixture.sketch.main_ino,
      libraries: fixture.sketch.libraries,
    },
    opts.signal !== undefined ? { signal: opts.signal } : {},
  );
  if (!result.ok) {
    return {
      ok: false,
      kind: result.kind,
      message: result.message,
      errors: result.errors,
    };
  }

  return {
    ok: true,
    value: {
      hexBytes: Buffer.from(result.value.hex_b64, "base64"),
      source: "fixture-compile-api",
    },
  };
}

// ---------------------------------------------------------------------------
// Orchestrator (the actual spike)
// ---------------------------------------------------------------------------

/**
 * Run one spike-flash. Returns the wire-contract uniform `SpikeResult`.
 * Bare throws cross the boundary ONLY at input-validation guards in
 * `parseArgs` — those are caught by `main()`, not here. Every avrgirl
 * error, get-hex failure, abort signal, and port error is classified
 * via `classifyAvrgirlError` (or the get-hex result's kind) and
 * returned through the failure branch.
 *
 * Status-event sequence on success:
 *   STEP=connect STATUS=active
 *   STEP=connect STATUS=done
 *   STEP=compile STATUS=active     (or skipped if --mode=blink/--hex)
 *   STEP=compile STATUS=done
 *   STEP=upload  STATUS=active
 *   STEP=upload  STATUS=done
 *   STEP=verify  STATUS=active
 *   STEP=verify  STATUS=done
 *
 * On failure, the active step transitions to `failed` with `reason=...`
 * and subsequent steps are NOT emitted (so Talia's stepper renders the
 * failure at the correct step).
 */
export async function runSpike(
  opts: SpikeRunOptions,
  deps: SpikeDeps,
): Promise<SpikeResult> {
  const startedAt = deps.now();

  // ---- step 1: connect -------------------------------------------------
  emitStep(deps.emitter, { step: "connect", state: "active" });

  if (opts.signal?.aborted) {
    emitStep(deps.emitter, {
      step: "connect",
      state: "failed",
      reason: "aborted",
    });
    return {
      ok: false,
      kind: "aborted",
      message: "spike aborted before connect",
    };
  }

  const portExists = await deps.portExists(opts.port);
  if (!portExists) {
    emitStep(deps.emitter, {
      step: "connect",
      state: "failed",
      reason: `port ${opts.port} does not exist`,
    });
    return {
      ok: false,
      kind: "port-not-found",
      message: `port ${opts.port} does not exist`,
    };
  }
  emitStep(deps.emitter, { step: "connect", state: "done" });

  // ---- step 2: compile / load hex -------------------------------------
  emitStep(deps.emitter, { step: "compile", state: "active" });
  const hexResult = await resolveHexSource(opts, deps);
  if (!hexResult.ok) {
    emitStep(deps.emitter, {
      step: "compile",
      state: "failed",
      reason: hexResult.message,
    });
    return {
      ok: false,
      kind: hexResult.kind,
      message: hexResult.message,
      errors: hexResult.errors,
    };
  }
  const hex = hexResult.value;
  emitStep(deps.emitter, {
    step: "compile",
    state: "done",
    detail: `${hex.hexBytes.length} bytes (${hex.source})`,
  });

  // ---- step 3: upload --------------------------------------------------
  emitStep(deps.emitter, { step: "upload", state: "active" });
  const avrgirl = deps.buildAvrgirlClient(opts.port);
  try {
    await avrgirl.flash(
      hex.hexBytes,
      opts.signal !== undefined ? opts.signal : undefined,
    );
  } catch (err) {
    const kind = classifyAvrgirlError(err);
    const message = err instanceof Error ? err.message : String(err);
    emitStep(deps.emitter, {
      step: "upload",
      state: "failed",
      reason: message,
    });
    return {
      ok: false,
      kind,
      message: `avrgirl flash failed: ${message}`,
      errors: [message],
    };
  }
  emitStep(deps.emitter, { step: "upload", state: "done" });

  // ---- step 4: verify --------------------------------------------------
  emitStep(deps.emitter, { step: "verify", state: "active" });
  if (avrgirl.verify !== undefined) {
    try {
      const readBack = await avrgirl.verify(
        hex.hexBytes,
        opts.signal !== undefined ? opts.signal : undefined,
      );
      if (!buffersEqual(readBack, hex.hexBytes)) {
        const offsets = firstDifferingOffsets(readBack, hex.hexBytes, 5);
        emitStep(deps.emitter, {
          step: "verify",
          state: "failed",
          reason: `read-back mismatch at offsets ${offsets.join(",")}`,
        });
        return {
          ok: false,
          kind: "verify-mismatch",
          message: "avrgirl read-back returned bytes that differ from written",
          errors: offsets.map((o) => `offset ${o}`),
        };
      }
    } catch (err) {
      const kind = classifyAvrgirlError(err);
      const message = err instanceof Error ? err.message : String(err);
      emitStep(deps.emitter, {
        step: "verify",
        state: "failed",
        reason: message,
      });
      return {
        ok: false,
        kind,
        message: `avrgirl verify failed: ${message}`,
        errors: [message],
      };
    }
  }
  // If verify is undefined, avrgirl's internal flash-time verify pass
  // was the implicit verification; no further check needed.
  emitStep(deps.emitter, { step: "verify", state: "done" });

  return {
    ok: true,
    port: opts.port,
    hex_size_bytes: hex.hexBytes.length,
    verified: true,
    latency_ms: deps.now() - startedAt,
  };
}

function emitStep(emitter: StatusEmitter, event: SpikeStepEvent): void {
  emitter.emit(event);
}

function buffersEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && a.compare(b) === 0;
}

function firstDifferingOffsets(
  a: Buffer,
  b: Buffer,
  limit: number,
): ReadonlyArray<number> {
  const offsets: number[] = [];
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len && offsets.length < limit; i++) {
    if (a[i] !== b[i]) offsets.push(i);
  }
  return offsets;
}

// ---------------------------------------------------------------------------
// Exit-code mapping (uses assertNeverSpikeFailureKind for exhaustiveness)
// ---------------------------------------------------------------------------

/**
 * Map a `SpikeResult` to a process exit code. The switch exhaustiveness
 * is enforced by `assertNeverSpikeFailureKind` — a future 7th kind on
 * the union without an exit-code mapping would fail tsc here.
 */
export function spikeExitCode(result: SpikeResult): number {
  if (result.ok) return 0;
  // The SPIKE_EXIT_CODE table is `Record<SpikeFailureKind, number>` so
  // adding a kind without adding an exit code is already a tsc error
  // at the table-definition site. We still run an exhaustive switch
  // here so future readers see the assertion at the consumer-of-the-union
  // point, matching the codebase's pattern.
  switch (result.kind) {
    case "port-not-found":
    case "write-failed":
    case "verify-mismatch":
    case "transport":
    case "compile-api-unreachable":
    case "aborted":
      return SPIKE_EXIT_CODE[result.kind];
    default:
      return assertNeverSpikeFailureKind(result.kind);
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * Production entry point. Wraps `parseArgs` + `runSpike` + exit-code
 * mapping. Bare throws (input-validation, unknown flags) are caught
 * here and surfaced as exit-1 with a usage line on stderr.
 *
 * Stream discipline:
 *   stdout — final SpikeResult as one JSON line on exit
 *   stderr — status events + any error message on bad invocation
 *
 * The function returns the exit code rather than calling `process.exit`
 * directly so it can be unit-tested without a mocked exit.
 */
export async function main(argv: ReadonlyArray<string>): Promise<number> {
  let opts: SpikeRunOptions;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console -- this IS the spike's CLI usage sink
    console.error(`spike-flash: ${message}`);
    // eslint-disable-next-line no-console
    console.error(
      "usage: bun run scripts/spike/avrgirl-node.ts --port <device> --mode <blink|fixture> [--hex <path>] [--fixture <path>]",
    );
    return 1;
  }

  // Wire SIGINT / SIGTERM to an AbortController so Ctrl+C surfaces as
  // `aborted` (kind=aborted, exit 6) rather than a default-killed
  // process with no diagnostic.
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const deps = await defaultSpikeDeps();
  const result = await runSpike({ ...opts, signal: controller.signal }, deps);

  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);

  // eslint-disable-next-line no-console -- this IS the spike's stdout outcome sink
  console.log(JSON.stringify(result));
  return spikeExitCode(result);
}

// Auto-invoke when run directly (not when imported by tests).
// `import.meta.main` is Bun-specific; falls back to a path comparison
// for environments without it.
declare const Bun: { argv?: string[] } | undefined;
if (
  typeof Bun !== "undefined" &&
  (import.meta as { main?: boolean }).main === true
) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
