/**
 * Unit tests for `scripts/v01-pipeline-io-smoke.ts`.
 *
 * The smoke script's full end-to-end run is integration-only — it
 * burns Sonnet + Haiku tokens and requires the Compile API container to
 * be running. These tests cover the failure-mode paths via mocked deps
 * so the cross-unit wiring contract is verified without external calls:
 *
 *   - Pre-flight: Compile API down → exit 1, no Anthropic call made.
 *   - Pre-flight: ANTHROPIC_API_KEY missing → exit 1 after health passes.
 *   - SmokeOutcome.kind: "QUEUE_FULL" — runCompileGate returning
 *     queue-full → outcome captured, NO retry.
 *   - SmokeOutcome.kind: "OUT_OF_SCOPE" — classify returns wrong
 *     archetype.
 *   - SmokeOutcome.kind: "OUT_OF_SCOPE" — confidence below threshold.
 *   - Sha256 digest is deterministic for a fixed table.
 *   - Happy path with mocked pipeline: all gates pass → OK outcome with
 *     hex_size_bytes from the mocked compile.
 *
 * Sibling exhaustiveness test in `tests/scripts/smoke-exhaustiveness.test.ts`
 * carries the `// @ts-expect-error` checks against incomplete switches.
 */

import { describe, expect, test } from "bun:test";
import {
  computeSmokeHash,
  preflightApiKeyCheck,
  preflightHealthCheck,
  runPromptPipeline,
  runSmoke,
  type RunPromptDeps,
  type SmokeDeps,
  type SmokeRow,
} from "../../scripts/v01-pipeline-io-smoke.ts";
import {
  VolteuxProjectDocumentSchema,
  type VolteuxProjectDocument,
} from "../../schemas/document.zod.ts";
import type {
  ClassifyResult,
} from "../../pipeline/llm/classify.ts";
import type {
  GenerateResult,
} from "../../pipeline/llm/generate.ts";
import type { CompileGateResult } from "../../pipeline/gates/compile.ts";

// ---------------------------------------------------------------------------
// Canonical fixture (parsed) — used by happy-path and queue-full tests.
// ---------------------------------------------------------------------------

const CANONICAL_FIXTURE = await Bun.file(
  "fixtures/uno-ultrasonic-servo.json",
).json();
const parsedFixture: VolteuxProjectDocument = VolteuxProjectDocumentSchema.parse(
  CANONICAL_FIXTURE,
);

// ---------------------------------------------------------------------------
// Test deps builder
// ---------------------------------------------------------------------------

interface CallCounter {
  classify: number;
  generate: number;
  compile: number;
}

interface BuildSmokeDepsOptions {
  /** Default: health passes. */
  healthOk?: boolean;
  /** Default: API key set. */
  apiKeySet?: boolean;
  /** Per-prompt classify result. Defaults to in-scope, high confidence. */
  classifyResultFor?: (prompt: string) => ClassifyResult;
  /** Per-prompt generate result. Defaults to canonical fixture. */
  generateResultFor?: (prompt: string) => GenerateResult;
  /** Per-prompt compile result. Defaults to OK with mock hex. */
  compileResultFor?: (prompt: string, callIndex: number) => CompileGateResult;
}

interface CapturedIo {
  stdout: string[];
  stderr: string[];
}

interface BuiltDeps {
  deps: SmokeDeps;
  io: CapturedIo;
  counters: CallCounter;
  writes: { filename: string; content: string }[];
}

function buildSmokeDeps(opts: BuildSmokeDepsOptions = {}): BuiltDeps {
  const counters: CallCounter = { classify: 0, generate: 0, compile: 0 };
  const io: CapturedIo = { stdout: [], stderr: [] };
  const writes: { filename: string; content: string }[] = [];

  const healthOk = opts.healthOk !== false; // default true
  const apiKeySet = opts.apiKeySet !== false; // default true

  const classifyImpl = opts.classifyResultFor ?? defaultClassifyOk;
  const generateImpl = opts.generateResultFor ?? defaultGenerateOk;
  const compileImpl = opts.compileResultFor ?? defaultCompileOk;

  // Per-prompt compile call counter so the test can assert NO retry on
  // queue-full.
  let compilePromptIdx = 0;

  const pipelineDeps: RunPromptDeps = {
    classify: async (prompt: string) => {
      counters.classify += 1;
      return classifyImpl(prompt);
    },
    generate: async (prompt: string) => {
      counters.generate += 1;
      return generateImpl(prompt);
    },
    runSchemaGate: (input: unknown) => ({ ok: true, value: input as VolteuxProjectDocument }) as ReturnType<RunPromptDeps["runSchemaGate"]>,
    runCrossConsistencyGate: () => ({ ok: true, value: undefined }),
    runRules: () => ({ red: [], amber: [], blue: [], attempts: [] }),
    runCompileGate: async (req: { fqbn: string; sketch_main_ino: string; additional_files?: Readonly<Record<string, string>>; libraries?: ReadonlyArray<string> }) => {
      counters.compile += 1;
      const r = compileImpl(req.sketch_main_ino, compilePromptIdx);
      compilePromptIdx += 1;
      return r;
    },
  };

  const deps: SmokeDeps = {
    readPromptFile: async (filename: string) => `[mock prompt ${filename}]`,
    healthCheck: async () =>
      healthOk
        ? { ok: true }
        : {
            ok: false,
            message:
              "Compile API unreachable at http://localhost:8787; run 'bun run compile:up' first",
          },
    apiKeyCheck: () =>
      apiKeySet
        ? { ok: true }
        : {
            ok: false,
            message:
              "ANTHROPIC_API_KEY is not set; export it before running 'bun run smoke'",
          },
    pipelineDeps,
    writeTraceFile: async (filename: string, content: string) => {
      writes.push({ filename, content });
    },
    stdout: (line: string) => {
      io.stdout.push(line);
    },
    stderr: (line: string) => {
      io.stderr.push(line);
    },
    generateRunId: () => "test-run-id",
  };

  return { deps, io, counters, writes };
}

function defaultClassifyOk(_prompt: string): ClassifyResult {
  return {
    ok: true,
    archetype_id: "uno-ultrasonic-servo",
    confidence: 0.9,
    reasoning: "mock",
    usage: {
      input_tokens: 600,
      output_tokens: 80,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

function defaultGenerateOk(_prompt: string): GenerateResult {
  return {
    ok: true,
    doc: parsedFixture,
    usage: {
      input_tokens: 2500,
      output_tokens: 800,
      cache_creation_input_tokens: 2500,
      cache_read_input_tokens: 0,
    },
  };
}

function defaultCompileOk(
  _sketch: string,
  _callIndex: number,
): CompileGateResult {
  return {
    ok: true,
    value: {
      hex_b64: "aGVsbG8=",
      stderr: "",
      cache_hit: false,
      latency_ms: 1234,
      hex_size_bytes: 5,
      toolchain_version_hash: "abc123",
    },
  };
}

// ---------------------------------------------------------------------------
// Pre-flight: Compile API health
// ---------------------------------------------------------------------------

describe("preflightHealthCheck", () => {
  test("returns ok when fetch responds 200", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response('{"ok":true}', { status: 200 }),
      )) as unknown as typeof fetch;
    const result = await preflightHealthCheck("http://test", fetchImpl);
    expect(result.ok).toBe(true);
  });

  test("returns unreachable message when fetch returns 503", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response('{"ok":false,"error":"degraded"}', { status: 503 }),
      )) as unknown as typeof fetch;
    const result = await preflightHealthCheck("http://test", fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Compile API unreachable at http://test");
    expect(result.message).toContain("bun run compile:up");
  });

  test("returns unreachable message when fetch throws", async () => {
    const fetchImpl = (() =>
      Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    const result = await preflightHealthCheck("http://test", fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Compile API unreachable at http://test");
  });
});

// ---------------------------------------------------------------------------
// Pre-flight: ANTHROPIC_API_KEY
// ---------------------------------------------------------------------------

describe("preflightApiKeyCheck", () => {
  test("returns ok when ANTHROPIC_API_KEY is non-empty", () => {
    expect(preflightApiKeyCheck({ ANTHROPIC_API_KEY: "sk-..." }).ok).toBe(true);
  });

  test("returns missing-key message when ANTHROPIC_API_KEY is undefined", () => {
    const r = preflightApiKeyCheck({});
    expect(r.ok).toBe(false);
    expect(r.message).toContain("ANTHROPIC_API_KEY is not set");
  });

  test("returns missing-key message when ANTHROPIC_API_KEY is empty string", () => {
    const r = preflightApiKeyCheck({ ANTHROPIC_API_KEY: "" });
    expect(r.ok).toBe(false);
  });

  test("does not log the API key value", () => {
    // The check function itself never receives a logger, but the message
    // must not contain the value. Sanity check.
    const r = preflightApiKeyCheck({
      ANTHROPIC_API_KEY: "sk-very-secret-do-not-leak",
    });
    expect(r.ok).toBe(true);
    expect(r.message ?? "").not.toContain("sk-very-secret-do-not-leak");
  });
});

// ---------------------------------------------------------------------------
// runSmoke: pre-flight failures short-circuit BEFORE any prompt processing
// ---------------------------------------------------------------------------

describe("runSmoke pre-flight: Compile API down", () => {
  test("exits 1 with unreachable message; no classify/generate calls made", async () => {
    const { deps, io, counters } = buildSmokeDeps({ healthOk: false });
    const result = await runSmoke(deps);

    expect(result.exitCode).toBe(1);
    expect(result.rows).toEqual([]);
    expect(result.hash).toBe("");
    expect(io.stderr.join("")).toContain("Compile API unreachable at");
    expect(counters.classify).toBe(0);
    expect(counters.generate).toBe(0);
    expect(counters.compile).toBe(0);
  });
});

describe("runSmoke pre-flight: missing ANTHROPIC_API_KEY", () => {
  test("exits 1 after health passes; no classify/generate calls made", async () => {
    const { deps, io, counters } = buildSmokeDeps({
      healthOk: true,
      apiKeySet: false,
    });
    const result = await runSmoke(deps);

    expect(result.exitCode).toBe(1);
    expect(result.rows).toEqual([]);
    expect(io.stderr.join("")).toContain("ANTHROPIC_API_KEY is not set");
    expect(counters.classify).toBe(0);
    expect(counters.generate).toBe(0);
    expect(counters.compile).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runPromptPipeline: queue-full handling
// ---------------------------------------------------------------------------

describe("runPromptPipeline: queue-full handling", () => {
  test("records QUEUE_FULL outcome and does NOT retry compile", async () => {
    let compileCalls = 0;
    const pipelineDeps: RunPromptDeps = {
      classify: async () => defaultClassifyOk(""),
      generate: async () => defaultGenerateOk(""),
      runSchemaGate: (input: unknown) => ({ ok: true, value: input as VolteuxProjectDocument }) as ReturnType<RunPromptDeps["runSchemaGate"]>,
      runCrossConsistencyGate: () => ({ ok: true, value: undefined }),
      runRules: () => ({ red: [], amber: [], blue: [], attempts: [] }),
      runCompileGate: async () => {
        compileCalls += 1;
        return {
          ok: false,
          severity: "red",
          kind: "queue-full",
          message: "queue full",
          errors: ["queue depth exceeded"],
          retry_after_s: 30,
        };
      },
    };

    const outcome = await runPromptPipeline("a test prompt", pipelineDeps);

    expect(outcome.kind).toBe("QUEUE_FULL");
    if (outcome.kind === "QUEUE_FULL") {
      expect(outcome.retry_after_s).toBe(30);
    }
    expect(compileCalls).toBe(1); // strictly no retry
  });

  test("uses a default 30s retry_after_s when the gate omits it", async () => {
    const pipelineDeps: RunPromptDeps = {
      classify: async () => defaultClassifyOk(""),
      generate: async () => defaultGenerateOk(""),
      runSchemaGate: (input: unknown) => ({ ok: true, value: input as VolteuxProjectDocument }) as ReturnType<RunPromptDeps["runSchemaGate"]>,
      runCrossConsistencyGate: () => ({ ok: true, value: undefined }),
      runRules: () => ({ red: [], amber: [], blue: [], attempts: [] }),
      runCompileGate: async () => ({
        ok: false,
        severity: "red",
        kind: "queue-full",
        message: "queue full",
        errors: [],
      }),
    };

    const outcome = await runPromptPipeline("p", pipelineDeps);
    expect(outcome.kind).toBe("QUEUE_FULL");
    if (outcome.kind === "QUEUE_FULL") {
      expect(outcome.retry_after_s).toBe(30);
    }
  });
});

// ---------------------------------------------------------------------------
// runPromptPipeline: out-of-scope filter
// ---------------------------------------------------------------------------

describe("runPromptPipeline: out-of-scope filter", () => {
  test("wrong archetype → OUT_OF_SCOPE, no generate or compile call", async () => {
    let generateCalls = 0;
    let compileCalls = 0;
    const pipelineDeps: RunPromptDeps = {
      classify: async () => ({
        ok: true,
        archetype_id: "esp32-audio-dashboard",
        confidence: 0.9,
        reasoning: "mock",
        usage: {
          input_tokens: 600,
          output_tokens: 80,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
      generate: async () => {
        generateCalls += 1;
        return defaultGenerateOk("");
      },
      runSchemaGate: (input: unknown) => ({ ok: true, value: input as VolteuxProjectDocument }) as ReturnType<RunPromptDeps["runSchemaGate"]>,
      runCrossConsistencyGate: () => ({ ok: true, value: undefined }),
      runRules: () => ({ red: [], amber: [], blue: [], attempts: [] }),
      runCompileGate: async () => {
        compileCalls += 1;
        return defaultCompileOk("", 0);
      },
    };

    const outcome = await runPromptPipeline("p", pipelineDeps);
    expect(outcome.kind).toBe("OUT_OF_SCOPE");
    expect(generateCalls).toBe(0);
    expect(compileCalls).toBe(0);
  });

  test("confidence below threshold → OUT_OF_SCOPE", async () => {
    const pipelineDeps: RunPromptDeps = {
      classify: async () => ({
        ok: true,
        archetype_id: "uno-ultrasonic-servo",
        confidence: 0.4, // below 0.6 threshold
        reasoning: "mock",
        usage: {
          input_tokens: 600,
          output_tokens: 80,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
      generate: async () => defaultGenerateOk(""),
      runSchemaGate: (input: unknown) => ({ ok: true, value: input as VolteuxProjectDocument }) as ReturnType<RunPromptDeps["runSchemaGate"]>,
      runCrossConsistencyGate: () => ({ ok: true, value: undefined }),
      runRules: () => ({ red: [], amber: [], blue: [], attempts: [] }),
      runCompileGate: async () => defaultCompileOk("", 0),
    };

    const outcome = await runPromptPipeline("p", pipelineDeps);
    expect(outcome.kind).toBe("OUT_OF_SCOPE");
    if (outcome.kind === "OUT_OF_SCOPE") {
      expect(outcome.confidence).toBe(0.4);
      expect(outcome.archetype_id).toBe("uno-ultrasonic-servo");
    }
  });

  test("null archetype_id → OUT_OF_SCOPE", async () => {
    const pipelineDeps: RunPromptDeps = {
      classify: async () => ({
        ok: true,
        archetype_id: null,
        confidence: 0.95,
        reasoning: "load cell — out of scope",
        usage: {
          input_tokens: 600,
          output_tokens: 80,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
      generate: async () => defaultGenerateOk(""),
      runSchemaGate: (input: unknown) => ({ ok: true, value: input as VolteuxProjectDocument }) as ReturnType<RunPromptDeps["runSchemaGate"]>,
      runCrossConsistencyGate: () => ({ ok: true, value: undefined }),
      runRules: () => ({ red: [], amber: [], blue: [], attempts: [] }),
      runCompileGate: async () => defaultCompileOk("", 0),
    };

    const outcome = await runPromptPipeline("p", pipelineDeps);
    expect(outcome.kind).toBe("OUT_OF_SCOPE");
    if (outcome.kind === "OUT_OF_SCOPE") {
      expect(outcome.archetype_id).toBe(null);
    }
  });
});

// ---------------------------------------------------------------------------
// runPromptPipeline: happy path → OK
// ---------------------------------------------------------------------------

describe("runPromptPipeline: happy path", () => {
  test("all gates pass → OK with hex_size_bytes from compile", async () => {
    const pipelineDeps: RunPromptDeps = {
      classify: async () => defaultClassifyOk(""),
      generate: async () => defaultGenerateOk(""),
      runSchemaGate: (input: unknown) => ({ ok: true, value: input as VolteuxProjectDocument }) as ReturnType<RunPromptDeps["runSchemaGate"]>,
      runCrossConsistencyGate: () => ({ ok: true, value: undefined }),
      runRules: () => ({ red: [], amber: [], blue: [], attempts: [] }),
      runCompileGate: async () => ({
        ok: true,
        value: {
          hex_b64: "aGVsbG8=",
          stderr: "",
          cache_hit: true,
          latency_ms: 67,
          hex_size_bytes: 5,
          toolchain_version_hash: "abc123",
        },
      }),
    };

    const outcome = await runPromptPipeline("p", pipelineDeps);
    expect(outcome.kind).toBe("OK");
    if (outcome.kind === "OK") {
      expect(outcome.hex_size_bytes).toBe(5);
      expect(outcome.cache_hit).toBe(true);
      expect(outcome.latency_ms).toBe(67);
    }
  });
});

// ---------------------------------------------------------------------------
// computeSmokeHash determinism
// ---------------------------------------------------------------------------

describe("computeSmokeHash", () => {
  test("returns the same sha256 for the same table object", () => {
    const rows: SmokeRow[] = [
      {
        prompt_index: 1,
        prompt_file: "01.txt",
        prompt_text: "hello",
        outcome: { kind: "OK", hex_size_bytes: 1234, cache_hit: false, latency_ms: 200 },
        total_latency_ms: 250,
      },
    ];
    const a = computeSmokeHash(rows);
    const b = computeSmokeHash(rows);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test("matches the manual sha256 of JSON.stringify(rows)", async () => {
    const rows: SmokeRow[] = [
      {
        prompt_index: 1,
        prompt_file: "x.txt",
        prompt_text: "x",
        outcome: { kind: "SCHEMA_FAILED" },
        total_latency_ms: 10,
      },
    ];
    const computed = computeSmokeHash(rows);

    // Compare against an independently-computed hash via Bun's crypto.
    const { createHash } = await import("node:crypto");
    const expected = createHash("sha256")
      .update(JSON.stringify(rows))
      .digest("hex");

    expect(computed).toBe(expected);
  });

  test("differs when rows differ", () => {
    const a: SmokeRow[] = [
      {
        prompt_index: 1,
        prompt_file: "01.txt",
        prompt_text: "a",
        outcome: { kind: "SCHEMA_FAILED" },
        total_latency_ms: 1,
      },
    ];
    const b: SmokeRow[] = [
      {
        prompt_index: 1,
        prompt_file: "01.txt",
        prompt_text: "b",
        outcome: { kind: "SCHEMA_FAILED" },
        total_latency_ms: 1,
      },
    ];
    expect(computeSmokeHash(a)).not.toBe(computeSmokeHash(b));
  });
});

// ---------------------------------------------------------------------------
// runSmoke: full mocked happy-path run; verifies trace write + exit code
// ---------------------------------------------------------------------------

describe("runSmoke: end-to-end with mocked deps (all OK)", () => {
  test("returns exitCode 0, 5 rows, deterministic hash, writes trace file", async () => {
    const { deps, io, writes } = buildSmokeDeps();
    const result = await runSmoke(deps);

    expect(result.exitCode).toBe(0);
    expect(result.rows.length).toBe(5);
    for (const row of result.rows) {
      expect(row.outcome.kind).toBe("OK");
    }
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(writes.length).toBe(1);
    expect(writes[0]?.filename).toBe("traces/smoke-test-run-id.txt");
    expect(io.stdout.join("")).toContain("smoke run hash:");
  });
});

describe("runSmoke: <3/5 OK rows → exitCode 2 (below threshold; pre-flight passed)", () => {
  test("3 SCHEMA_FAILED + 2 OK = 2 OK rows → exitCode 2", async () => {
    let invocation = 0;
    const generateImpl = (): GenerateResult => {
      invocation += 1;
      // Return 3 outputs that won't pass schema, then 2 valid.
      // Easier: use a custom runSchemaGate to fail first 3.
      return defaultGenerateOk("");
    };
    let schemaCallCount = 0;
    const failingSchemaDeps = buildSmokeDeps({
      generateResultFor: () => generateImpl(),
    });
    // Override the runSchemaGate to fail the first 3 calls.
    failingSchemaDeps.deps.pipelineDeps.runSchemaGate = ((
      input: unknown,
    ) => {
      schemaCallCount += 1;
      if (schemaCallCount <= 3) {
        return {
          ok: false as const,
          severity: "red" as const,
          message: "mock schema fail",
          errors: [],
        };
      }
      return { ok: true as const, value: input as VolteuxProjectDocument };
    }) as RunPromptDeps["runSchemaGate"];

    const result = await runSmoke(failingSchemaDeps.deps);
    // exitCode 2 — pre-flight passed but the pipeline produced too few OK rows.
    // Distinct from exitCode 1 (pre-flight failure) so agents can branch
    // without parsing logs.
    expect(result.exitCode).toBe(2);
    expect(result.rows.length).toBe(5);
    const okRows = result.rows.filter((r) => r.outcome.kind === "OK").length;
    expect(okRows).toBe(2);
    expect(invocation).toBe(5);
  });
});
