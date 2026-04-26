/**
 * Unit tests for the v0 Uno flash spike harness.
 *
 * Coverage:
 *   - Happy path (mocked avrgirl resolves; status events fire)
 *   - 6 SpikeFailureKind branches (port-not-found, write-failed,
 *     verify-mismatch, transport, compile-api-unreachable, aborted)
 *   - Status-event emission count + ordering per state transition
 *   - Exit-code mapping per SPIKE_EXIT_CODE
 *   - assertNeverSpikeFailureKind exhaustiveness (`@ts-expect-error`
 *     for a switch missing a kind)
 *   - parseArgs CLI guard branches
 *   - classifyAvrgirlError mapping from messages to kinds
 *   - defaultSpikeDeps in-flight-Promise dedup + __testing reset
 *
 * Mocking strategy:
 *   The harness's `runSpike(opts, deps)` accepts a fully-typed
 *   `SpikeDeps` argument so tests construct deps inline with a fake
 *   avrgirl client + in-memory emitter + stub readFile/portExists.
 *   No mock.module(...) is used; the DI shape carries the entire
 *   surface that needs faking.
 *
 *   The avrgirl mock implements the narrow `AvrgirlClient` interface
 *   from spike-types — flash() resolves or rejects per scenario,
 *   verify() (when present) returns a buffer that does or does not
 *   match the input.
 *
 *   The emitter mock collects events into an array so tests assert
 *   step-event ordering verbatim.
 *
 * Hardware: NONE. The spike's truth is hands-on hardware (Unit 2);
 * this file covers the harness's logic only.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  __testing,
  classifyAvrgirlError,
  defaultSpikeDeps,
  main,
  parseArgs,
  runSpike,
  spikeExitCode,
  type AvrgirlClient,
  type SpikeDeps,
} from "../../scripts/spike/avrgirl-node.ts";
import { buildStatusEmitter } from "../../scripts/spike/status-events.ts";
import {
  assertNeverSpikeFailureKind,
  SPIKE_EXIT_CODE,
  type SpikeFailureKind,
  type SpikeResult,
  type SpikeStepEvent,
} from "../../scripts/spike/spike-types.ts";
import { __testing as getHexTesting } from "../../scripts/spike/get-hex.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake avrgirl client. By default flash() resolves with no
 * verification (the production shape — avrgirl's internal flash-time
 * verify pass is the implicit verification). Tests override behaviour
 * via the `behavior` arg.
 */
function fakeAvrgirl(
  behavior: {
    flash?: (hex: Buffer, signal?: AbortSignal) => Promise<void>;
    verify?: (expected: Buffer, signal?: AbortSignal) => Promise<Buffer>;
  } = {},
): AvrgirlClient {
  const client: AvrgirlClient = {
    flash:
      behavior.flash ??
      (async (_hex, signal) => {
        if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      }),
  };
  if (behavior.verify !== undefined) {
    client.verify = behavior.verify;
  }
  return client;
}

/**
 * In-memory deps that the harness can run against without touching
 * the filesystem, the network, or a real avrgirl client. The
 * `events` array captures every status event emitted during the run
 * so tests can assert step-event ordering.
 */
function buildTestDeps(overrides: {
  avrgirl?: AvrgirlClient;
  fixtureJSON?: string;
  hexBytes?: Buffer;
  portExistsResult?: boolean;
  readFileError?: Error;
  getHexBaseUrl?: string;
  fetch?: typeof fetch;
}): { deps: SpikeDeps; events: SpikeStepEvent[] } {
  const events: SpikeStepEvent[] = [];
  const emitter = buildStatusEmitter({
    write: () => {
      // we capture events via the inner emit, not the formatted line
    },
  });
  // Wrap the emitter to capture the original event objects for assertions.
  const captured: { emit: (e: SpikeStepEvent) => void } = {
    emit: (e: SpikeStepEvent) => {
      events.push(e);
      emitter.emit(e);
    },
  };

  const fixtureJSON =
    overrides.fixtureJSON ??
    JSON.stringify({
      archetype_id: "uno-ultrasonic-servo",
      board: { fqbn: "arduino:avr:uno" },
      sketch: { main_ino: "void setup(){}\nvoid loop(){}", libraries: [] },
    });

  const deps: SpikeDeps = {
    buildAvrgirlClient: (_port: string) =>
      overrides.avrgirl ?? fakeAvrgirl(),
    getHexDeps: {
      baseUrl: overrides.getHexBaseUrl ?? "http://localhost-test",
      secret: "x".repeat(32),
      fetch:
        overrides.fetch ??
        ((async () =>
          new Response(
            JSON.stringify({
              ok: true,
              artifact_b64: Buffer.from(
                overrides.hexBytes ?? Buffer.from("hex-bytes"),
              ).toString("base64"),
              toolchain_version_hash: "test-hash",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )) as unknown as typeof fetch),
      timeoutMs: 1000,
    },
    emitter: captured,
    now: () => 0,
    readFile: async (path: string) => {
      if (overrides.readFileError !== undefined) {
        throw overrides.readFileError;
      }
      // The fixture path returns the JSON; the --hex path returns hex bytes.
      if (path.endsWith(".json")) {
        return Buffer.from(fixtureJSON, "utf-8");
      }
      return overrides.hexBytes ?? Buffer.from("hex-bytes");
    },
    portExists: async (_path: string) => overrides.portExistsResult ?? true,
  };
  return { deps, events };
}

// ---------------------------------------------------------------------------
// Reset module-level state before every test
// ---------------------------------------------------------------------------

beforeEach(() => {
  __testing.resetDefaultSpikeDeps();
  getHexTesting.resetDefaultGetHexDeps();
});
afterEach(() => {
  __testing.resetDefaultSpikeDeps();
  getHexTesting.resetDefaultGetHexDeps();
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("runSpike — happy path", () => {
  test("--mode=fixture with mocked avrgirl + Compile API → ok: true, all 4 steps complete", async () => {
    const { deps, events } = buildTestDeps({});
    const result = await runSpike(
      { port: "/dev/test-uno", mode: "fixture" },
      deps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.port).toBe("/dev/test-uno");
      expect(result.verified).toBe(true);
      expect(result.hex_size_bytes).toBeGreaterThan(0);
    }
    // All 4 steps emit active + done with no failures.
    const activeSteps = events.filter((e) => e.state === "active");
    const doneSteps = events.filter((e) => e.state === "done");
    expect(activeSteps.map((e) => e.step)).toEqual([
      "connect",
      "compile",
      "upload",
      "verify",
    ]);
    expect(doneSteps.map((e) => e.step)).toEqual([
      "connect",
      "compile",
      "upload",
      "verify",
    ]);
    expect(events.filter((e) => e.state === "failed")).toHaveLength(0);
  });

  test("happy-path exit code is 0", async () => {
    const { deps } = buildTestDeps({});
    const result = await runSpike(
      { port: "/dev/test-uno", mode: "fixture" },
      deps,
    );
    expect(spikeExitCode(result)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SpikeFailureKind branches
// ---------------------------------------------------------------------------

describe("runSpike — port-not-found", () => {
  test("portExists false → kind=port-not-found, exit 1, connect step fails", async () => {
    const { deps, events } = buildTestDeps({ portExistsResult: false });
    const result = await runSpike(
      { port: "/dev/nonexistent", mode: "fixture" },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("port-not-found");
      expect(spikeExitCode(result)).toBe(1);
    }
    // Connect emits active then failed; no further steps.
    const failed = events.find((e) => e.state === "failed");
    expect(failed?.step).toBe("connect");
    expect(events.find((e) => e.step === "compile")).toBeUndefined();
  });
});

describe("runSpike — write-failed", () => {
  test("avrgirl flash() rejects with 'write timeout' → kind=write-failed, exit 2", async () => {
    const { deps, events } = buildTestDeps({
      avrgirl: fakeAvrgirl({
        flash: async () => {
          throw new Error("avr109: write timeout");
        },
      }),
    });
    const result = await runSpike(
      { port: "/dev/test-uno", mode: "fixture" },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("write-failed");
      expect(spikeExitCode(result)).toBe(2);
    }
    // Upload step fails after connect + compile complete.
    const failed = events.find((e) => e.state === "failed");
    expect(failed?.step).toBe("upload");
    expect(events.filter((e) => e.step === "verify")).toHaveLength(0);
  });
});

describe("runSpike — verify-mismatch", () => {
  test("avrgirl verify() returns mismatched bytes → kind=verify-mismatch, exit 3", async () => {
    const expected = Buffer.from([1, 2, 3, 4]);
    const { deps, events } = buildTestDeps({
      hexBytes: expected,
      avrgirl: fakeAvrgirl({
        flash: async () => {},
        verify: async () => Buffer.from([1, 2, 9, 4]), // byte 2 differs
      }),
    });
    const result = await runSpike(
      { port: "/dev/test-uno", mode: "fixture" },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("verify-mismatch");
      expect(spikeExitCode(result)).toBe(3);
      expect(result.errors).toEqual(["offset 2"]);
    }
    const failed = events.find((e) => e.state === "failed");
    expect(failed?.step).toBe("verify");
  });

  test("avrgirl flash() rejects with 'verification failed' → kind=verify-mismatch (classified by message)", async () => {
    const { deps } = buildTestDeps({
      avrgirl: fakeAvrgirl({
        flash: async () => {
          throw new Error("STK500v1 verification failed at byte 0x42");
        },
      }),
    });
    const result = await runSpike(
      { port: "/dev/test-uno", mode: "fixture" },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("verify-mismatch");
      expect(spikeExitCode(result)).toBe(3);
    }
  });
});

describe("runSpike — transport", () => {
  test("avrgirl flash() rejects with generic 'serial port closed' → kind=transport, exit 4", async () => {
    const { deps } = buildTestDeps({
      avrgirl: fakeAvrgirl({
        flash: async () => {
          throw new Error("serial port closed unexpectedly");
        },
      }),
    });
    const result = await runSpike(
      { port: "/dev/test-uno", mode: "fixture" },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("transport");
      expect(spikeExitCode(result)).toBe(4);
    }
  });
});

describe("runSpike — compile-api-unreachable", () => {
  test("get-hex fetch rejects → kind=compile-api-unreachable, exit 5, compile step fails", async () => {
    const { deps, events } = buildTestDeps({
      fetch: (async () => {
        throw Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
      }) as unknown as typeof fetch,
    });
    const result = await runSpike(
      { port: "/dev/test-uno", mode: "fixture" },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("compile-api-unreachable");
      expect(spikeExitCode(result)).toBe(5);
    }
    // Compile step fails after connect completes; upload + verify never start.
    const failed = events.find((e) => e.state === "failed");
    expect(failed?.step).toBe("compile");
    expect(events.find((e) => e.step === "upload")).toBeUndefined();
  });
});

describe("runSpike — aborted", () => {
  test("pre-fired AbortSignal → kind=aborted, exit 6, connect step fails", async () => {
    const controller = new AbortController();
    controller.abort();
    const { deps, events } = buildTestDeps({});
    const result = await runSpike(
      { port: "/dev/test-uno", mode: "fixture", signal: controller.signal },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("aborted");
      expect(spikeExitCode(result)).toBe(6);
    }
    const failed = events.find((e) => e.state === "failed");
    expect(failed?.step).toBe("connect");
  });

  test("avrgirl flash() throws AbortError → kind=aborted (classified by error.name)", async () => {
    const { deps } = buildTestDeps({
      avrgirl: fakeAvrgirl({
        flash: async () => {
          throw new DOMException("aborted", "AbortError");
        },
      }),
    });
    const result = await runSpike(
      { port: "/dev/test-uno", mode: "fixture" },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("aborted");
      expect(spikeExitCode(result)).toBe(6);
    }
  });
});

// ---------------------------------------------------------------------------
// Status-event emission contract
// ---------------------------------------------------------------------------

describe("status-event emission", () => {
  test("happy path emits exactly 8 events: 4 active + 4 done in order", async () => {
    const { deps, events } = buildTestDeps({});
    await runSpike({ port: "/dev/test-uno", mode: "fixture" }, deps);
    expect(events).toHaveLength(8);
    expect(events.map((e) => `${e.step}:${e.state}`)).toEqual([
      "connect:active",
      "connect:done",
      "compile:active",
      "compile:done",
      "upload:active",
      "upload:done",
      "verify:active",
      "verify:done",
    ]);
  });

  test("compile-step failure emits 3 events: connect:active connect:done compile:active compile:failed", async () => {
    const { deps, events } = buildTestDeps({
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    await runSpike({ port: "/dev/test-uno", mode: "fixture" }, deps);
    expect(events.map((e) => `${e.step}:${e.state}`)).toEqual([
      "connect:active",
      "connect:done",
      "compile:active",
      "compile:failed",
    ]);
  });

  test("verify-failed emits 8 events with verify:failed at the end", async () => {
    const { deps, events } = buildTestDeps({
      hexBytes: Buffer.from([1, 2, 3]),
      avrgirl: fakeAvrgirl({
        flash: async () => {},
        verify: async () => Buffer.from([1, 9, 3]),
      }),
    });
    await runSpike({ port: "/dev/test-uno", mode: "fixture" }, deps);
    // 2 + 2 + 2 + 2 = 8: connect(active+done), compile(active+done),
    // upload(active+done), verify(active+failed). The final state is
    // failed (not done), so the count matches the happy path's count
    // but the last entry differs.
    expect(events).toHaveLength(8);
    expect(events[events.length - 1]).toEqual({
      step: "verify",
      state: "failed",
      reason: expect.stringContaining("offset"),
    });
  });
});

// ---------------------------------------------------------------------------
// parseArgs guards
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  test("happy path: --port + --mode=fixture parses", () => {
    const opts = parseArgs(["--port", "/dev/foo", "--mode", "fixture"]);
    expect(opts.port).toBe("/dev/foo");
    expect(opts.mode).toBe("fixture");
  });

  test("--mode=blink parses", () => {
    const opts = parseArgs(["--port", "/dev/foo", "--mode", "blink"]);
    expect(opts.mode).toBe("blink");
  });

  test("missing --port throws", () => {
    expect(() => parseArgs(["--mode", "blink"])).toThrow(/missing --port/);
  });

  test("missing --mode throws", () => {
    expect(() => parseArgs(["--port", "/dev/foo"])).toThrow(/missing --mode/);
  });

  test("unknown flag throws", () => {
    expect(() =>
      parseArgs(["--port", "/dev/foo", "--mode", "blink", "--bogus"]),
    ).toThrow(/unknown spike harness flag/);
  });

  test("invalid --mode value throws", () => {
    expect(() =>
      parseArgs(["--port", "/dev/foo", "--mode", "wrong"]),
    ).toThrow(/--mode must be/);
  });

  test("--hex path passthrough", () => {
    const opts = parseArgs([
      "--port",
      "/dev/foo",
      "--mode",
      "blink",
      "--hex",
      "/tmp/blink.hex",
    ]);
    expect(opts.hexPath).toBe("/tmp/blink.hex");
  });
});

// ---------------------------------------------------------------------------
// classifyAvrgirlError mapping
// ---------------------------------------------------------------------------

describe("classifyAvrgirlError", () => {
  test("'port not found' → port-not-found", () => {
    expect(classifyAvrgirlError(new Error("port not found"))).toBe(
      "port-not-found",
    );
  });

  test("ENOENT → port-not-found", () => {
    expect(classifyAvrgirlError(new Error("ENOENT: no such file"))).toBe(
      "port-not-found",
    );
  });

  test("'verify' → verify-mismatch", () => {
    expect(classifyAvrgirlError(new Error("verify pass failed"))).toBe(
      "verify-mismatch",
    );
  });

  test("'verification' → verify-mismatch", () => {
    expect(classifyAvrgirlError(new Error("verification mismatch"))).toBe(
      "verify-mismatch",
    );
  });

  test("'mismatch' alone → verify-mismatch", () => {
    expect(classifyAvrgirlError(new Error("byte 0x42 mismatch"))).toBe(
      "verify-mismatch",
    );
  });

  test("'write timeout' → write-failed", () => {
    expect(classifyAvrgirlError(new Error("write timeout"))).toBe(
      "write-failed",
    );
  });

  test("AbortError → aborted (priority over message text)", () => {
    const err = new DOMException("aborted", "AbortError");
    expect(classifyAvrgirlError(err)).toBe("aborted");
  });

  test("'cancelled' → aborted", () => {
    expect(classifyAvrgirlError(new Error("cancelled by user"))).toBe(
      "aborted",
    );
  });

  test("generic error → transport (the safe default)", () => {
    expect(classifyAvrgirlError(new Error("unrecognized failure"))).toBe(
      "transport",
    );
  });

  test("null/undefined → transport", () => {
    expect(classifyAvrgirlError(null)).toBe("transport");
    expect(classifyAvrgirlError(undefined)).toBe("transport");
  });
});

// ---------------------------------------------------------------------------
// Exit-code mapping
// ---------------------------------------------------------------------------

describe("spikeExitCode + SPIKE_EXIT_CODE", () => {
  test("ok: true → 0", () => {
    const result: SpikeResult = {
      ok: true,
      port: "/dev/x",
      hex_size_bytes: 1,
      verified: true,
      latency_ms: 0,
    };
    expect(spikeExitCode(result)).toBe(0);
  });

  test("each kind maps to a unique code 1-6", () => {
    const codes = new Set(Object.values(SPIKE_EXIT_CODE));
    expect(codes.size).toBe(6);
    expect(Array.from(codes).sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("SPIKE_EXIT_CODE covers every SpikeFailureKind literal", () => {
    const required: ReadonlyArray<SpikeFailureKind> = [
      "port-not-found",
      "write-failed",
      "verify-mismatch",
      "transport",
      "compile-api-unreachable",
      "aborted",
    ];
    for (const kind of required) {
      expect(SPIKE_EXIT_CODE[kind]).toBeGreaterThanOrEqual(1);
      expect(SPIKE_EXIT_CODE[kind]).toBeLessThanOrEqual(6);
    }
  });
});

// ---------------------------------------------------------------------------
// Exhaustiveness guard (compile-time + runtime)
// ---------------------------------------------------------------------------

/**
 * A correctly-exhaustive switch over `SpikeFailureKind`. Compiles.
 */
function classifyComplete(kind: SpikeFailureKind): string {
  switch (kind) {
    case "port-not-found":
      return "port";
    case "write-failed":
      return "write";
    case "verify-mismatch":
      return "verify";
    case "transport":
      return "tx";
    case "compile-api-unreachable":
      return "compile-api";
    case "aborted":
      return "abort";
    default:
      assertNeverSpikeFailureKind(kind);
  }
}

/**
 * A switch missing the `"aborted"` case. tsc must reject this — the
 * `default` branch types `kind` as `"aborted"` (the missing literal),
 * which is NOT `never`, so `assertNeverSpikeFailureKind(kind: never)`
 * fails the call-site type check.
 */
function classifyIncomplete(kind: SpikeFailureKind): string {
  switch (kind) {
    case "port-not-found":
      return "port";
    case "write-failed":
      return "write";
    case "verify-mismatch":
      return "verify";
    case "transport":
      return "tx";
    case "compile-api-unreachable":
      return "compile-api";
    default:
      // @ts-expect-error — `kind` is `"aborted"` here, not `never`.
      // If tsc ever stops flagging this, the union grew or the helper
      // weakened, and the exhaustiveness contract is broken.
      assertNeverSpikeFailureKind(kind);
      return "fallback";
  }
}

describe("assertNeverSpikeFailureKind exhaustiveness", () => {
  test("complete switch over SpikeFailureKind compiles and runs", () => {
    expect(classifyComplete("port-not-found")).toBe("port");
    expect(classifyComplete("write-failed")).toBe("write");
    expect(classifyComplete("verify-mismatch")).toBe("verify");
    expect(classifyComplete("transport")).toBe("tx");
    expect(classifyComplete("compile-api-unreachable")).toBe("compile-api");
    expect(classifyComplete("aborted")).toBe("abort");
  });

  test("incomplete switch hits the @ts-expect-error fallback at runtime when 'aborted' is passed", () => {
    expect(() => classifyIncomplete("aborted")).toThrow(
      /Unhandled SpikeFailureKind/,
    );
  });

  test("assertNeverSpikeFailureKind throws at runtime if reached", () => {
    expect(() => {
      assertNeverSpikeFailureKind("unexpected" as never);
    }).toThrow(/Unhandled SpikeFailureKind/);
  });
});

// ---------------------------------------------------------------------------
// defaultSpikeDeps — in-flight-Promise dedup + __testing reset
// ---------------------------------------------------------------------------

describe("defaultSpikeDeps — lazy-init contract", () => {
  test("synchronous repeat calls return the same promise reference", () => {
    const first = defaultSpikeDeps();
    const second = defaultSpikeDeps();
    expect(first).toBe(second);
  });

  test("__testing.resetDefaultSpikeDeps clears the slot — next call returns a different promise", () => {
    const first = defaultSpikeDeps();
    __testing.resetDefaultSpikeDeps();
    const second = defaultSpikeDeps();
    expect(first).not.toBe(second);
  });
});

// ---------------------------------------------------------------------------
// main() — CLI integration
// ---------------------------------------------------------------------------

describe("main() — CLI invocation", () => {
  test("returns 1 with usage line on missing required flags", async () => {
    // We can't easily intercept stderr here without monkeypatching
    // console.error globally; instead we verify the return code and
    // trust the (covered-elsewhere) parseArgs throw text.
    const code = await main([]);
    expect(code).toBe(1);
  });

  test("returns 1 on unknown flag", async () => {
    const code = await main(["--bogus"]);
    expect(code).toBe(1);
  });
});
