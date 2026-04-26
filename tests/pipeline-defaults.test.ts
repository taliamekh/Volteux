/**
 * Unit tests for the lazy default-deps factory in `pipeline/index.ts`.
 *
 * Coverage (mirrors `tests/llm/defaults.test.ts` exactly):
 *   - Concurrent first-callers share ONE in-flight initialization (the
 *     fix for the "two simultaneous `await defaultPipelineDeps()` both
 *     pass the `null` check, both construct deps, second assignment
 *     silently wins" race the previous singleton shape allowed).
 *   - `__testing.resetDefaultPipelineDeps()` clears the cached promise so
 *     the next call rebuilds — required because bun's test runner shares
 *     modules across files and an integration test populating the slot
 *     would leak state into mock-driven unit tests otherwise.
 *
 * These tests do NOT make a real Anthropic API call. The lazy-init slot
 * resolves to a deps object whose `client` field comes from the
 * Anthropic SDK constructor (instantiation only — no network). Side
 * effects: reading the prompt source files from disk (same as the
 * production lazy-init path) and constructing two SDK clients
 * (transitively via classify+generate's own lazy-init).
 *
 * The suite saves/restores `process.env.ANTHROPIC_API_KEY` so it is
 * hermetic regardless of whether the integration env is loaded.
 *
 * The three test shapes are the exact contract from the lazy-init
 * compound learning. See:
 * docs/solutions/logic-errors/lazy-init-singleton-in-flight-promise-bun-test-isolation-2026-04-26.md
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  defaultPipelineDeps,
  __testing,
} from "../pipeline/index.ts";
import { _resetDefaultDepsForTest as resetGenerateDeps } from "../pipeline/llm/generate.ts";
import { _resetDefaultDepsForTest as resetClassifyDeps } from "../pipeline/llm/classify.ts";

const ENV_KEY = "ANTHROPIC_API_KEY";

describe("defaultPipelineDeps — in-flight promise dedup", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
    // The factory needs *some* key to construct the underlying
    // Anthropic SDK clients (transitively via classify + generate
    // default deps). No real API call is made.
    process.env[ENV_KEY] = "test-key-for-defaults-suite";
    __testing.resetDefaultPipelineDeps();
    // Also reset the LLM-side caches so this suite's first call always
    // does a fresh construction (otherwise object-identity comparisons
    // against `client` would carry over a previous test's reference).
    resetGenerateDeps();
    resetClassifyDeps();
  });

  afterEach(() => {
    __testing.resetDefaultPipelineDeps();
    resetGenerateDeps();
    resetClassifyDeps();
    if (savedEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = savedEnv;
    }
  });

  test("two concurrent callers share the SAME resolved deps (no duplicate construction)", async () => {
    // Promise.all with two parallel calls is the smallest reproducer
    // for the race the previous `let cached: Deps | null = null` shape
    // permitted: both calls would pass the `null` check before the
    // first `await ...` resolved, both would construct, and the second
    // assignment would silently win. With the in-flight-promise fix,
    // both callers `await` the SAME promise → both receive the SAME
    // deps object reference.
    const [a, b] = await Promise.all([
      defaultPipelineDeps(),
      defaultPipelineDeps(),
    ]);
    // Cross-checking the whole deps object: both callers share the
    // exact same resolved value (it IS the same promise resolution).
    expect(a).toBe(b);
  });

  test("synchronous repeat calls return the same promise (cached after first)", () => {
    // Without awaiting, the cached promise IS the same reference. This
    // pins that the slot is set on the FIRST call (synchronously) so
    // the SECOND call returns the cached promise rather than starting
    // its own initialization.
    //
    // This test depends on `defaultPipelineDeps` being plain (NOT
    // `async`). An `async` wrapper would return a different `Promise`
    // wrapper on each call even when the cached promise was the same
    // — `first` and `second` would not be `.toBe`-equal, and the test
    // would silently start passing for the wrong reason if someone
    // re-added `async` later.
    const first = defaultPipelineDeps();
    const second = defaultPipelineDeps();
    expect(first).toBe(second);
  });

  test("__testing.resetDefaultPipelineDeps clears the slot (next call returns a different deps)", async () => {
    const a = await defaultPipelineDeps();
    __testing.resetDefaultPipelineDeps();
    // Also reset the LLM-side caches so the underlying clients are
    // freshly constructed and we can assert object-distinctness.
    resetGenerateDeps();
    resetClassifyDeps();
    const b = await defaultPipelineDeps();
    expect(b).not.toBe(a);
  });
});
