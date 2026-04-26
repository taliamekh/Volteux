/**
 * Unit + contract tests for `tests/acceptance/wokwi/run.ts`.
 *
 * Coverage matches the v0.5 plan § Unit 1 § Test scenarios — 17 named
 * cases organized into:
 *   - Happy path (mocked) + cache hit
 *   - Cache-key NUL-collision matrix (mirrors the 2026-04-26 cache-key
 *     learning's prevention #3 — independent NUL injection per field)
 *   - Assertion evaluator: state pass/fail, duration pass/fail
 *   - Error paths: cli-not-installed, license-missing, timeout,
 *     transport, missing-bundle
 *   - Abort
 *   - Exhaustiveness guard (assertNeverWokwiFailureKind)
 *   - Lazy-init three-test contract (object-identity dedup,
 *     sync-promise-reference, reset evicts) per the 2026-04-26
 *     lazy-init learning's required shape
 *   - Trace event shape via buildWokwiTraceEvent
 *
 * Mock-deps pattern: every test constructs a `WokwiDeps` object inline.
 * The default-deps lazy-init contract is exercised separately against
 * `defaultWokwiDeps()` + `__testing.resetDefaultWokwiDeps()`.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  __testing,
  assertNeverWokwiFailureKind,
  buildWokwiHarness,
  buildWokwiTraceEvent,
  computeBundleSha256,
  computeCacheKey,
  defaultWokwiDeps,
  evaluateAssertions,
  type RunWokwiArgs,
  type WokwiBundle,
  type WokwiCacheStore,
  type WokwiCliResult,
  type WokwiDeps,
  type WokwiFailureKind,
  type WokwiSimulationOutput,
  type WokwiStateSample,
} from "./run.ts";
import type { WokwiAssertions } from "./assertions.zod.ts";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const HEX_B64 = "AAECAwQFBgcICQ=="; // 10 bytes of dummy hex
const PROMPT_FILENAME = "01-distance-servo.txt";
const TOKEN = "test-wokwi-token-xyz";

function makeAssertions(
  overrides: Partial<WokwiAssertions> = {},
): WokwiAssertions {
  return {
    state: [
      {
        at_ms: 2000,
        expect: { servo_angle: { min: 80, max: 100 } },
      },
    ],
    duration: [
      {
        run_for_ms: 5000,
        expect: { no_crash: true },
      },
    ],
    ...overrides,
  };
}

function makeBundle(overrides: Partial<WokwiBundle> = {}): WokwiBundle {
  return {
    diagram_json: '{"version":1,"parts":[],"connections":[]}',
    wokwi_toml: '[wokwi]\nversion = 1\nfirmware = "firmware.hex"\n',
    assertions: makeAssertions(),
    ...overrides,
  };
}

function makeStateStream(
  overrides: Partial<WokwiSimulationOutput> = {},
): WokwiSimulationOutput {
  return {
    samples: [
      { kind: "state", at_ms: 1500, target: "servo_angle", value: 87 },
      { kind: "state", at_ms: 2000, target: "servo_angle", value: 87 },
      { kind: "ended", at_ms: 5000 },
    ] satisfies ReadonlyArray<WokwiStateSample>,
    simulated_ms: 5000,
    ...overrides,
  };
}

interface MockCacheStore extends WokwiCacheStore {
  store: Map<string, WokwiSimulationOutput>;
  getCalls: number;
  putCalls: number;
}

function makeMockCache(
  initial?: Iterable<readonly [string, WokwiSimulationOutput]>,
): MockCacheStore {
  const store = new Map<string, WokwiSimulationOutput>(initial);
  const wrapper: MockCacheStore = {
    store,
    getCalls: 0,
    putCalls: 0,
    async get(key) {
      wrapper.getCalls++;
      return store.get(key) ?? null;
    },
    async put(key, value) {
      wrapper.putCalls++;
      store.set(key, value);
    },
  };
  return wrapper;
}

interface CliInvocationCapture {
  count: number;
  lastBinary?: string;
  lastTokenSeen?: string;
}

function makeMockDeps(
  cliResult: WokwiCliResult | (() => Promise<WokwiCliResult>),
  opts: {
    cliInstalled?: boolean;
    token?: string;
    cache?: MockCacheStore;
    capture?: CliInvocationCapture;
  } = {},
): WokwiDeps {
  const capture = opts.capture ?? { count: 0 };
  return {
    runCli: async (invocation) => {
      capture.count++;
      capture.lastBinary = invocation.cliBinary;
      capture.lastTokenSeen = invocation.cliToken;
      return typeof cliResult === "function" ? cliResult() : cliResult;
    },
    probeCliInstalled: async () => opts.cliInstalled ?? true,
    cache: opts.cache ?? makeMockCache(),
    cliToken: opts.token ?? TOKEN,
    cliBinary: "wokwi-cli",
    timeoutMs: 10_000,
  };
}

function makeArgs(overrides: Partial<RunWokwiArgs> = {}): RunWokwiArgs {
  return {
    hex_b64: HEX_B64,
    prompt_filename: PROMPT_FILENAME,
    bundle: makeBundle(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Scenario 1: Happy path (mocked)
// ---------------------------------------------------------------------------

describe("buildWokwiHarness — happy path (mocked)", () => {
  test("returns ok with all assertions passed; bundle_sha256 + cache_key are non-empty hex", async () => {
    const cache = makeMockCache();
    const capture: CliInvocationCapture = { count: 0 };
    const deps = makeMockDeps(
      { kind: "ok", output: makeStateStream() },
      { cache, capture },
    );
    const harness = buildWokwiHarness(deps);
    const result = await harness(makeArgs());

    if (!result.ok) throw new Error(`expected ok, got ${result.kind}`);
    expect(result.cache_hit).toBe(false);
    expect(result.simulated_ms).toBe(5000);
    expect(result.assertions.length).toBeGreaterThanOrEqual(2);
    expect(result.assertions.every((a) => a.passed)).toBe(true);
    expect(result.bundle_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.cache_key).toMatch(/^[0-9a-f]{64}$/);
    expect(capture.count).toBe(1);
    expect(capture.lastTokenSeen).toBe(TOKEN);
    expect(cache.putCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Happy path (cache hit)
// ---------------------------------------------------------------------------

describe("buildWokwiHarness — cache hit replays without invoking wokwi-cli", () => {
  test("second call with identical inputs short-circuits the subprocess", async () => {
    const cache = makeMockCache();
    const capture: CliInvocationCapture = { count: 0 };
    const deps = makeMockDeps(
      { kind: "ok", output: makeStateStream() },
      { cache, capture },
    );
    const harness = buildWokwiHarness(deps);

    const first = await harness(makeArgs());
    if (!first.ok) throw new Error("first call failed");
    expect(first.cache_hit).toBe(false);
    expect(capture.count).toBe(1);

    const second = await harness(makeArgs());
    if (!second.ok) throw new Error("second call failed");
    expect(second.cache_hit).toBe(true);
    expect(second.simulated_ms).toBe(0);
    expect(capture.count).toBe(1); // unchanged — no second subprocess call
    expect(second.cache_key).toBe(first.cache_key);
    expect(second.bundle_sha256).toBe(first.bundle_sha256);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Cache-key collision matrix (NUL-byte injection per field)
// ---------------------------------------------------------------------------

describe("computeCacheKey — NUL-byte collision resistance per field (mirrors the 2026-04-26 cache-key learning)", () => {
  const baseInput = {
    hex_b64: "AA==",
    diagram_json_sha256: "a".repeat(64),
    wokwi_toml_sha256: "b".repeat(64),
    assertions_sha256: "c".repeat(64),
  };

  test("NUL injected into hex_b64 produces a distinct key", () => {
    const a = computeCacheKey({ ...baseInput, hex_b64: "AA\0BB" });
    const b = computeCacheKey({ ...baseInput, hex_b64: "AABB" });
    expect(a).not.toBe(b);
  });

  test("NUL injected into diagram_json_sha256 produces a distinct key", () => {
    const a = computeCacheKey({
      ...baseInput,
      diagram_json_sha256: "a\0".repeat(32),
    });
    const b = computeCacheKey({ ...baseInput, diagram_json_sha256: "a".repeat(64) });
    expect(a).not.toBe(b);
  });

  test("NUL injected into wokwi_toml_sha256 produces a distinct key", () => {
    const a = computeCacheKey({
      ...baseInput,
      wokwi_toml_sha256: "b\0".repeat(32),
    });
    const b = computeCacheKey({ ...baseInput, wokwi_toml_sha256: "b".repeat(64) });
    expect(a).not.toBe(b);
  });

  test("NUL injected into assertions_sha256 produces a distinct key", () => {
    const a = computeCacheKey({
      ...baseInput,
      assertions_sha256: "c\0".repeat(32),
    });
    const b = computeCacheKey({ ...baseInput, assertions_sha256: "c".repeat(64) });
    expect(a).not.toBe(b);
  });

  test("classic ambiguous-concat collision: NUL in hex vs NUL in diagram does NOT collide", () => {
    // The pre-canonical-envelope hazard would have been:
    //   hex="X\0", diagram="Y"  vs  hex="X", diagram="\0Y"
    // The JSON envelope makes both produce distinct strings because
    // JSON encodes NUL as ` ` inside quotes.
    const a = computeCacheKey({
      ...baseInput,
      hex_b64: "X\0",
      diagram_json_sha256: "Y" + "0".repeat(63),
    });
    const b = computeCacheKey({
      ...baseInput,
      hex_b64: "X",
      diagram_json_sha256: "\0Y" + "0".repeat(62),
    });
    expect(a).not.toBe(b);
  });

  test("computeBundleSha256 is deterministic for byte-identical bundles", () => {
    const a = computeBundleSha256(makeBundle());
    const b = computeBundleSha256(makeBundle());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test("computeBundleSha256 differs when any bundle component changes", () => {
    const base = computeBundleSha256(makeBundle());
    const altDiagram = computeBundleSha256(
      makeBundle({ diagram_json: '{"version":2}' }),
    );
    const altToml = computeBundleSha256(
      makeBundle({ wokwi_toml: "[wokwi]\nversion = 2\n" }),
    );
    const altAssertions = computeBundleSha256(
      makeBundle({
        assertions: makeAssertions({
          duration: [{ run_for_ms: 9999, expect: { no_crash: true } }],
        }),
      }),
    );
    expect(altDiagram).not.toBe(base);
    expect(altToml).not.toBe(base);
    expect(altAssertions).not.toBe(base);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 + 5: Assertion evaluator — state pass/fail
// ---------------------------------------------------------------------------

describe("evaluateAssertions — state assertion: servo_angle in range", () => {
  test("pass: servo_angle 87 falls within [80, 100] at t=2000", () => {
    const result = evaluateAssertions(
      { state: [{ at_ms: 2000, expect: { servo_angle: { min: 80, max: 100 } } }] },
      makeStateStream(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected pass");
    expect(result.results.length).toBe(1);
    const first = result.results[0]!;
    expect(first.kind).toBe("state");
    expect(first.passed).toBe(true);
    if (first.kind === "state") {
      expect(first.actual).toBe(87);
    }
  });

  test("fail: servo_angle 0 outside [80, 100] surfaces the actual value", () => {
    const result = evaluateAssertions(
      { state: [{ at_ms: 2000, expect: { servo_angle: { min: 80, max: 100 } } }] },
      {
        samples: [
          { kind: "state", at_ms: 2000, target: "servo_angle", value: 0 },
          { kind: "ended", at_ms: 5000 },
        ],
        simulated_ms: 5000,
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(result.kind).toBe("assertion-failed");
    expect(result.results.length).toBe(1);
    const first = result.results[0]!;
    expect(first.passed).toBe(false);
    if (first.kind === "state") {
      expect(first.actual).toBe(0);
    }
  });

  test("fail: missing servo_angle sample at the requested timestamp", () => {
    const result = evaluateAssertions(
      { state: [{ at_ms: 2000, expect: { servo_angle: { min: 80, max: 100 } } }] },
      {
        samples: [{ kind: "ended", at_ms: 5000 }],
        simulated_ms: 5000,
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail (missing sample)");
    expect(result.kind).toBe("assertion-failed");
    expect(result.results[0]!.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 + 7: Duration assertion pass/fail
// ---------------------------------------------------------------------------

describe("evaluateAssertions — duration: no_crash + run_for_ms", () => {
  test("pass: ran 5000ms with no crash sample", () => {
    const result = evaluateAssertions(
      { duration: [{ run_for_ms: 5000, expect: { no_crash: true } }] },
      {
        samples: [{ kind: "ended", at_ms: 5000 }],
        simulated_ms: 5000,
      },
    );
    expect(result.ok).toBe(true);
  });

  test("fail: crash at t=2000 fails no_crash:true", () => {
    const result = evaluateAssertions(
      { duration: [{ run_for_ms: 5000, expect: { no_crash: true } }] },
      {
        samples: [
          { kind: "crash", at_ms: 2000, reason: "hard fault" },
        ],
        simulated_ms: 2000,
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(result.kind).toBe("assertion-failed");
  });

  test("fail: simulator stopped early (3000ms) before run_for_ms (5000ms)", () => {
    const result = evaluateAssertions(
      { duration: [{ run_for_ms: 5000, expect: { no_crash: true } }] },
      {
        samples: [{ kind: "ended", at_ms: 3000 }],
        simulated_ms: 3000,
      },
    );
    expect(result.ok).toBe(false);
  });

  test("layered: state pass + duration fail → overall fail", () => {
    const result = evaluateAssertions(
      {
        state: [
          { at_ms: 1000, expect: { servo_angle: { min: 80, max: 100 } } },
        ],
        duration: [{ run_for_ms: 5000, expect: { no_crash: true } }],
      },
      {
        samples: [
          { kind: "state", at_ms: 1000, target: "servo_angle", value: 90 },
          { kind: "crash", at_ms: 1500, reason: "stack overflow" },
        ],
        simulated_ms: 1500,
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(result.results.length).toBe(2);
    expect(result.results[0]!.passed).toBe(true);
    expect(result.results[1]!.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 8: cli-not-installed
// ---------------------------------------------------------------------------

describe("buildWokwiHarness — cli-not-installed pre-flight", () => {
  test("returns kind: cli-not-installed when wokwi-cli is not on PATH", async () => {
    const deps = makeMockDeps(
      { kind: "ok", output: makeStateStream() },
      { cliInstalled: false },
    );
    const harness = buildWokwiHarness(deps);
    const result = await harness(makeArgs());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(result.kind).toBe("cli-not-installed");
    expect(result.message).toContain("wokwi-cli");
  });
});

// ---------------------------------------------------------------------------
// Scenario 9: license-missing
// ---------------------------------------------------------------------------

describe("buildWokwiHarness — license-missing pre-flight", () => {
  test("returns kind: license-missing when WOKWI_CLI_TOKEN is empty", async () => {
    const capture: CliInvocationCapture = { count: 0 };
    const deps = makeMockDeps(
      { kind: "ok", output: makeStateStream() },
      { token: "", capture },
    );
    const harness = buildWokwiHarness(deps);
    const result = await harness(makeArgs());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(result.kind).toBe("license-missing");
    // Pre-flight: subprocess must NOT have been invoked.
    expect(capture.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 10: timeout
// ---------------------------------------------------------------------------

describe("buildWokwiHarness — timeout", () => {
  test("returns kind: timeout when subprocess wrapper reports timeout", async () => {
    const deps = makeMockDeps({ kind: "timeout" });
    const harness = buildWokwiHarness(deps);
    const result = await harness(makeArgs({ timeoutMs: 1234 }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(result.kind).toBe("timeout");
    expect(result.simulated_ms).toBe(1234);
  });
});

// ---------------------------------------------------------------------------
// Scenario 11: transport
// ---------------------------------------------------------------------------

describe("buildWokwiHarness — transport (subprocess crash)", () => {
  test("subprocess non-zero exit surfaces as kind: transport", async () => {
    const deps = makeMockDeps({
      kind: "transport",
      message: "wokwi-cli exited 1: licence error",
    });
    const harness = buildWokwiHarness(deps);
    const result = await harness(makeArgs());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(result.kind).toBe("transport");
    expect(result.message).toContain("wokwi-cli exited");
    expect(result.errors?.length ?? 0).toBeGreaterThan(0);
  });

  test("malformed serial_regex pattern surfaces as kind: transport (bundle-author bug)", async () => {
    // A malformed pattern is detected during assertion eval, NOT at
    // bundle load (the Zod schema accepts any string). The runner
    // converts the evaluator's `transport` outcome to the wire-contract
    // failure kind.
    const cache = makeMockCache();
    const deps = makeMockDeps(
      { kind: "ok", output: makeStateStream() },
      { cache },
    );
    const harness = buildWokwiHarness(deps);
    const result = await harness(
      makeArgs({
        bundle: makeBundle({
          assertions: {
            serial_regex: [{ pattern: "[unterminated", must_match: true }],
          },
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(result.kind).toBe("transport");
    expect(result.message).toContain("invalid");
  });
});

// ---------------------------------------------------------------------------
// Scenario 12: missing-bundle
// ---------------------------------------------------------------------------

describe("buildWokwiHarness — missing-bundle", () => {
  test("returns kind: missing-bundle when neither bundle nor bundlePath supplied", async () => {
    const deps = makeMockDeps({ kind: "ok", output: makeStateStream() });
    const harness = buildWokwiHarness(deps);
    const result = await harness({
      hex_b64: HEX_B64,
      prompt_filename: PROMPT_FILENAME,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(result.kind).toBe("missing-bundle");
  });

  test("returns kind: missing-bundle when bundlePath does not resolve", async () => {
    const deps = makeMockDeps({ kind: "ok", output: makeStateStream() });
    const harness = buildWokwiHarness(deps);
    const result = await harness({
      hex_b64: HEX_B64,
      prompt_filename: PROMPT_FILENAME,
      bundlePath: "/tmp/this-bundle-does-not-exist-volteux",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(result.kind).toBe("missing-bundle");
  });
});

// ---------------------------------------------------------------------------
// Scenario 13: synthesis-failed (malformed pre-resolved bundle)
// ---------------------------------------------------------------------------

describe("buildWokwiHarness — synthesis-failed (malformed bundle assertions)", () => {
  test("malformed assertions surface as kind: synthesis-failed", async () => {
    const deps = makeMockDeps({ kind: "ok", output: makeStateStream() });
    const harness = buildWokwiHarness(deps);
    const result = await harness({
      hex_b64: HEX_B64,
      prompt_filename: PROMPT_FILENAME,
      bundle: {
        diagram_json: "{}",
        wokwi_toml: "",
        // Empty assertions object — fails the `at least one of state /
        // duration / serial_regex` refine.
        assertions: {} as WokwiAssertions,
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(result.kind).toBe("synthesis-failed");
  });
});

// ---------------------------------------------------------------------------
// Scenario 14: aborted
// ---------------------------------------------------------------------------

describe("buildWokwiHarness — abort", () => {
  test("pre-fired AbortSignal returns kind: aborted before any work", async () => {
    const capture: CliInvocationCapture = { count: 0 };
    const deps = makeMockDeps(
      { kind: "ok", output: makeStateStream() },
      { capture },
    );
    const harness = buildWokwiHarness(deps);
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await harness(makeArgs({ signal: ctrl.signal }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(result.kind).toBe("aborted");
    expect(capture.count).toBe(0);
  });

  test("subprocess-reported abort surfaces as kind: aborted", async () => {
    const deps = makeMockDeps({ kind: "aborted" });
    const harness = buildWokwiHarness(deps);
    const result = await harness(makeArgs());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(result.kind).toBe("aborted");
  });
});

// ---------------------------------------------------------------------------
// Scenario 15: Exhaustiveness guard
// ---------------------------------------------------------------------------

describe("WokwiFailureKind exhaustiveness guard", () => {
  test("covers every literal in the union", () => {
    // Compile-time exhaustiveness: if a 9th literal lands without
    // updating this switch, the `default` arm fails to type-check.
    function classify(kind: WokwiFailureKind): string {
      switch (kind) {
        case "missing-bundle":
          return "missing-bundle";
        case "synthesis-failed":
          return "synthesis-failed";
        case "cli-not-installed":
          return "cli-not-installed";
        case "license-missing":
          return "license-missing";
        case "timeout":
          return "timeout";
        case "assertion-failed":
          return "assertion-failed";
        case "transport":
          return "transport";
        case "aborted":
          return "aborted";
        default:
          return assertNeverWokwiFailureKind(kind);
      }
    }
    const allKinds: ReadonlyArray<WokwiFailureKind> = [
      "missing-bundle",
      "synthesis-failed",
      "cli-not-installed",
      "license-missing",
      "timeout",
      "assertion-failed",
      "transport",
      "aborted",
    ];
    for (const kind of allKinds) {
      expect(classify(kind)).toBe(kind);
    }
  });

  test("assertNeverWokwiFailureKind throws when called with a non-literal at runtime", () => {
    expect(() =>
      assertNeverWokwiFailureKind("rogue-literal" as never),
    ).toThrow(/Unhandled WokwiFailureKind/);
  });
});

// ---------------------------------------------------------------------------
// Scenario 16: Lazy-init three-test contract
// ---------------------------------------------------------------------------

describe("defaultWokwiDeps — lazy-init three-test contract (per the 2026-04-26 lazy-init learning)", () => {
  beforeEach(() => {
    process.env["WOKWI_CLI_TOKEN"] = "lazy-init-test-token";
    __testing.resetDefaultWokwiDeps();
  });
  afterEach(() => {
    __testing.resetDefaultWokwiDeps();
  });

  test("two concurrent callers share the SAME resolved deps (no duplicate construction)", async () => {
    const [a, b] = await Promise.all([
      defaultWokwiDeps(),
      defaultWokwiDeps(),
    ]);
    // Identity equality on the deps object proves both callers awaited
    // the same in-flight promise, not two separate constructions.
    expect(a).toBe(b);
    expect(a.cliToken).toBe("lazy-init-test-token");
  });

  test("synchronous repeat calls return the same promise (cached after first)", () => {
    // This test depends on the function being plain (not async) — an
    // async wrapper would create a fresh Promise wrapper on each call
    // even when the cached promise was the same. The lazy-init learning
    // calls this out explicitly as the regression-pinning test.
    const first = defaultWokwiDeps();
    const second = defaultWokwiDeps();
    expect(first).toBe(second);
  });

  test("__testing.resetDefaultWokwiDeps() evicts the cached deps", async () => {
    const a = await defaultWokwiDeps();
    __testing.resetDefaultWokwiDeps();
    const b = await defaultWokwiDeps();
    expect(b).not.toBe(a);
  });
});

// ---------------------------------------------------------------------------
// Scenario 17: Trace event shape
// ---------------------------------------------------------------------------

describe("buildWokwiTraceEvent — wokwi_run TraceEvent shape", () => {
  test("constructs a fully populated wokwi_run event", () => {
    const evt = buildWokwiTraceEvent({
      ts: "2026-04-27T10:00:00.000Z",
      run_id: "01HXYZ12345",
      prompt_filename: "01-distance-servo.txt",
      cache_hit: false,
      bundle_sha256: "a".repeat(64),
      cache_key: "b".repeat(64),
      outcome: "ok",
      simulated_ms: 4321,
      assertion_results: [
        {
          kind: "state",
          at_ms: 2000,
          target: "servo_angle",
          expected_range: [80, 100] as const,
          actual: 87,
          passed: true,
        },
      ],
    });
    expect(evt.event).toBe("wokwi_run");
    expect(evt.outcome).toBe("ok");
    expect(evt.simulated_ms).toBe(4321);
    expect(evt.assertion_results.length).toBe(1);
    expect(evt.assertion_results[0]!.passed).toBe(true);
  });

  test("trace event carries WokwiFailureKind on the failure path", () => {
    const evt = buildWokwiTraceEvent({
      ts: "2026-04-27T10:00:00.000Z",
      run_id: "run-x",
      prompt_filename: "02-pet-bowl.txt",
      cache_hit: true,
      bundle_sha256: "c".repeat(64),
      cache_key: "d".repeat(64),
      outcome: "assertion-failed",
      simulated_ms: 0,
      assertion_results: [],
    });
    expect(evt.outcome).toBe("assertion-failed");
    expect(evt.cache_hit).toBe(true);
  });

  test("bundle_sha256 deterministic across runs of identical bundles", () => {
    const a = computeBundleSha256(makeBundle());
    const b = computeBundleSha256(makeBundle());
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Scenario 18: Subprocess invocation contract (defensive coverage)
// ---------------------------------------------------------------------------

describe("buildWokwiHarness — subprocess invocation contract", () => {
  test("forwards cliBinary + cliToken to runCli verbatim", async () => {
    const capture: CliInvocationCapture = { count: 0 };
    const deps: WokwiDeps = {
      ...makeMockDeps({ kind: "ok", output: makeStateStream() }, { capture }),
      cliBinary: "wokwi-cli-pinned",
      cliToken: "TOKEN-123",
    };
    const harness = buildWokwiHarness(deps);
    const result = await harness(makeArgs());
    if (!result.ok) throw new Error("expected ok");
    expect(capture.lastBinary).toBe("wokwi-cli-pinned");
    expect(capture.lastTokenSeen).toBe("TOKEN-123");
  });

  test("input-validation: empty hex_b64 throws synchronously", async () => {
    const deps = makeMockDeps({ kind: "ok", output: makeStateStream() });
    const harness = buildWokwiHarness(deps);
    expect(harness({ hex_b64: "", prompt_filename: PROMPT_FILENAME })).rejects.toThrow(
      /non-empty hex_b64/,
    );
  });

  test("input-validation: empty prompt_filename throws synchronously", async () => {
    const deps = makeMockDeps({ kind: "ok", output: makeStateStream() });
    const harness = buildWokwiHarness(deps);
    expect(harness({ hex_b64: HEX_B64, prompt_filename: "" })).rejects.toThrow(
      /non-empty prompt_filename/,
    );
  });
});
