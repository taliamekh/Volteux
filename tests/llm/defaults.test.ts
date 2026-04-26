/**
 * Unit tests for the lazy default-deps factories in
 * `pipeline/llm/generate.ts` and `pipeline/llm/classify.ts`.
 *
 * Coverage:
 *   - Concurrent first-callers share ONE in-flight initialization (the
 *     fix for the "two simultaneous `await defaultDeps()` both pass the
 *     `null` check, both construct an Anthropic client, second
 *     assignment silently wins" race that the previous singleton shape
 *     allowed).
 *   - `_resetDefaultDepsForTest()` clears the cached promise so the
 *     next call rebuilds — required because bun's test runner shares
 *     modules across files and an integration test populating the slot
 *     would leak a real client into mock-driven unit tests otherwise.
 *
 * These tests do NOT make a real Anthropic API call. They construct the
 * SDK client (which is just instantiation) and inspect the resolved
 * deps object identity. The only side effect is reading the prompt
 * source files from disk — same as the production lazy-init path.
 *
 * The suite saves/restores `process.env.ANTHROPIC_API_KEY` so it is
 * hermetic regardless of whether the integration env is loaded.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  defaultGenerateDeps,
  _resetDefaultDepsForTest as resetGenerateDeps,
} from "../../pipeline/llm/generate.ts";
import {
  defaultClassifyDeps,
  _resetDefaultDepsForTest as resetClassifyDeps,
} from "../../pipeline/llm/classify.ts";

const ENV_KEY = "ANTHROPIC_API_KEY";

describe("defaultGenerateDeps — in-flight promise dedup", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
    // The factory needs *some* key to construct the SDK client.
    // No real API call is made by these tests — they only verify
    // object-identity invariants of the lazy-init slot.
    process.env[ENV_KEY] = "test-key-for-defaults-suite";
    resetGenerateDeps();
  });

  afterEach(() => {
    resetGenerateDeps();
    if (savedEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = savedEnv;
    }
  });

  test("two concurrent callers share the SAME resolved client (no duplicate construction)", async () => {
    // Promise.all with two parallel calls is the smallest reproducer
    // for the race the previous `let cached: Deps | null = null` shape
    // permitted: both calls would pass the `null` check before the
    // first `await Bun.file().text()` resolved, both would construct a
    // fresh Anthropic client, and the second assignment would silently
    // win. With the in-flight-promise fix, both callers `await` the
    // SAME promise → both receive the SAME client object reference.
    const [a, b] = await Promise.all([
      defaultGenerateDeps(),
      defaultGenerateDeps(),
    ]);
    expect(a.client).toBe(b.client);
    // Cross-checking the whole deps object: both callers share the
    // exact same resolved value (it IS the same promise resolution).
    expect(a).toBe(b);
  });

  test("synchronous repeat calls return the same promise (cached after first)", () => {
    // Without awaiting, the cached promise IS the same reference. This
    // pins that the slot is set on the FIRST call (synchronously) so
    // the SECOND call returns the cached promise rather than starting
    // its own initialization.
    const first = defaultGenerateDeps();
    const second = defaultGenerateDeps();
    expect(first).toBe(second);
  });

  test("_resetDefaultDepsForTest clears the slot (next call returns a different deps)", async () => {
    const a = await defaultGenerateDeps();
    resetGenerateDeps();
    const b = await defaultGenerateDeps();
    expect(b).not.toBe(a);
    // The two clients are different SDK instances — proves the cache
    // genuinely flushed and a fresh `createAnthropicClient()` ran.
    expect(b.client).not.toBe(a.client);
  });
});

describe("defaultClassifyDeps — in-flight promise dedup", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
    process.env[ENV_KEY] = "test-key-for-defaults-suite";
    resetClassifyDeps();
  });

  afterEach(() => {
    resetClassifyDeps();
    if (savedEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = savedEnv;
    }
  });

  test("two concurrent callers share the SAME resolved client (no duplicate construction)", async () => {
    const [a, b] = await Promise.all([
      defaultClassifyDeps(),
      defaultClassifyDeps(),
    ]);
    expect(a.client).toBe(b.client);
    expect(a).toBe(b);
  });

  test("synchronous repeat calls return the same promise (cached after first)", () => {
    const first = defaultClassifyDeps();
    const second = defaultClassifyDeps();
    expect(first).toBe(second);
  });

  test("_resetDefaultDepsForTest clears the slot (next call returns a different deps)", async () => {
    const a = await defaultClassifyDeps();
    resetClassifyDeps();
    const b = await defaultClassifyDeps();
    expect(b).not.toBe(a);
    expect(b.client).not.toBe(a.client);
  });
});
