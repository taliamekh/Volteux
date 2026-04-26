---
module: pipeline-llm
date: 2026-04-26
problem_type: logic_error
component: tooling
severity: high
symptoms:
  - Two concurrent awaits of `defaultDeps()` both pass the null-check before
    the first call resolves, constructing duplicate Anthropic clients; one
    connection pool silently leaks for the process lifetime.
  - Integration tests populate the module-level singleton with a real
    Anthropic client; subsequent unit tests in the same `bun test` run
    receive the cached real-client deps instead of fresh defaults, even
    when a mock is injected via `opts.deps`. The unit test passes but
    bills against the live API key and never exercises the mock.
root_cause: async_timing
resolution_type: code_fix
related_components:
  - testing_framework
tags:
  - lazy-init
  - singleton
  - in-flight-promise
  - test-isolation
  - bun-test-runner
  - concurrent-init-race
  - dependency-injection
  - module-state
---

# Lazy-init module singleton: cache the in-flight Promise, not the resolved value

## Problem

The `defaultGenerateDeps()` and `defaultClassifyDeps()` lazy-init helpers in
[`pipeline/llm/generate.ts`](../../../pipeline/llm/generate.ts) and
[`pipeline/llm/classify.ts`](../../../pipeline/llm/classify.ts) memoized the
fully-resolved `GenerateDeps` / `ClassifyDeps` object in a module-level
`let cached: T | null = null` slot. Two coupled defects fell out of that
shape: a concurrent-init race that silently constructed duplicate Anthropic
SDK clients, and a Bun-test-runner isolation hole that leaked real-client
deps from integration tests into subsequent unit tests within the same
process.

## Symptoms

- Concurrent `Promise.all([defaultGenerateDeps(), defaultGenerateDeps()])`
  resolved to **two distinct client objects** (the second `await` started
  before the first completed and constructed a fresh client).
- One Anthropic SDK client (with its underlying HTTP connection pool)
  was abandoned per concurrent-init burst — invisible at the type level,
  no error logged, leak stays for the process lifetime.
- Integration tests in `tests/llm/generate.test.ts` populated the
  singleton with a real client when `ANTHROPIC_API_KEY` was set;
  subsequent unit tests calling the convenience wrapper `generate(prompt)`
  silently used that real client. Tests passed using live API calls
  while their `opts.deps` mock was never exercised — non-hermetic and
  potentially billable.
- Five of thirteen reviewers in a single `/ce:review` pass independently
  flagged this code (correctness, reliability, kieran-typescript,
  agent-native, adversarial). The cross-reviewer agreement boosted the
  finding to confidence 1.00 and made it the second-ranked finding
  overall — a strong signal that the hole is non-obvious enough to trip
  multiple experienced reviewers simultaneously.

## What Didn't Work

**The "naïve sync-to-async singleton" translation.** A synchronous singleton
guard (`if (cached !== null) return cached;` followed by synchronous
construction) is correct because there is no yield point between the check
and the assignment. Translating that shape directly into an `async function`
introduces an implicit yield at every `await` between the check and the
assignment:

```ts
let cachedDefaultDeps: GenerateDeps | null = null;

export async function defaultGenerateDeps(): Promise<GenerateDeps> {
  if (cachedDefaultDeps !== null) return cachedDefaultDeps;
  // ↓ implicit yield. Two concurrent callers can both arrive here
  //   before either of them assigns to cachedDefaultDeps.
  const systemPromptSource = await Bun.file(SYSTEM_PROMPT_PATH).text();
  cachedDefaultDeps = { client: createAnthropicClient(), /* ... */ };
  return cachedDefaultDeps;
}
```

The shape *looks* like the synchronous version it was translated from,
which is why this defect is easy to write and easy to miss in review —
the bug has the visual rhythm of a correct cache. The fact that 5 of 13
reviewers flagged it independently is not because it was glaringly wrong,
but because each reviewer recognized a different angle (concurrent race,
test pollution, credential rotation, abandoned connection pool, mock
ineffectiveness) of the same structural mistake.

## Solution

Cache the **in-flight Promise**, not the resolved value. The slot is
assigned synchronously during the first call (the IIFE-started promise
is a value that exists immediately even though it hasn't resolved); every
subsequent call — concurrent or serial — returns the same promise
reference. Because they all `await` the same promise, only one
initialization ever runs.

```ts
let cachedDefaultDepsPromise: Promise<GenerateDeps> | null = null;

export function defaultGenerateDeps(): Promise<GenerateDeps> {
  if (cachedDefaultDepsPromise !== null) return cachedDefaultDepsPromise;
  cachedDefaultDepsPromise = (async () => {
    const systemPromptSource = await Bun.file(SYSTEM_PROMPT_PATH).text();
    return {
      client: createAnthropicClient(),
      systemPromptSource,
      schemaPrimer: buildSchemaPrimer(),
      model: DEFAULT_MODEL,
      maxTokens: DEFAULT_MAX_TOKENS,
    };
  })();
  return cachedDefaultDepsPromise;
}

/**
 * Test-only escape hatch. Production code MUST NOT import from here.
 *
 * Bun's test runner shares modules across files; without this reset,
 * an integration test that populates `cachedDefaultDepsPromise` with a
 * real-client deps would leak that client into subsequent unit tests
 * that exercise the convenience `generate()` wrapper, regardless of
 * mock-injection intent. Mirrors `infra/server/cache.ts`'s
 * `__testing.resetMemoizedHash()` pattern.
 */
export function _resetDefaultDepsForTest(): void {
  cachedDefaultDepsPromise = null;
}
```

Two non-obvious details beyond the slot type change:

1. **The function signature drops `async`.** It was `async function
   defaultGenerateDeps(): Promise<GenerateDeps>` and is now `function
   defaultGenerateDeps(): Promise<GenerateDeps>`. An `async` wrapper
   would create a fresh `Promise` wrapper on every call regardless of
   the cache, masking whether the slot was really set synchronously.
   **TypeScript will not catch a regression here:** because `Promise`
   is covariant and `async` machinery flattens nested promises, the
   declared return type `Promise<GenerateDeps>` compiles whether or not
   `async` is present. The promise-identity test
   (`expect(first).toBe(second)` against repeated synchronous calls,
   shown in Examples below) is the *only* automated guard against
   someone re-adding `async` later.

2. **The reset escape hatch is underscore-prefixed and carries an
   explicit "production must not import" JSDoc.** The naming convention
   establishes a codebase-wide vocabulary for test-only cache evictions
   that is greppable and enforceable. The precedent is in
   [`infra/server/cache.ts`](../../../infra/server/cache.ts):

   ```typescript
   export const __testing = {
     resetMemoizedHash(): void {
       cachedToolchainHash = null;
     },
   };
   ```

   That module's memoization is synchronous (no async yield), so the
   plain-value cache is correct there. The LLM modules' memoization is
   async, which is precisely why the cached-promise shape is required
   instead.

   **The two precedents differ in shape and that divergence should be
   resolved going forward.** `infra/server/cache.ts` exports a named
   namespace object `__testing` containing reset methods (call site:
   `__testing.resetMemoizedHash()`); `pipeline/llm/{generate,classify}.ts`
   export the reset as a standalone underscore-prefixed function (call
   site: `_resetDefaultDepsForTest()`). Both signal "test-only" but they
   have different searchability and import ergonomics. **Recommendation
   for new modules: prefer the `__testing` namespace form** — `grep
   __testing` finds every test-only export across the repo in one
   search, and `import { __testing } from "..."` carries the test-only
   intent into the call site. The two LLM modules will be migrated to
   the namespace form opportunistically; this doc is the reference for
   the new vocabulary.

## Why This Works

The in-flight-promise pattern eliminates the race window because **the
slot is assigned synchronously**. The IIFE returns a `Promise` value
*before* it begins resolving; the assignment to
`cachedDefaultDepsPromise` happens in the same microtask tick as the
null check. Two concurrent callers cannot both pass the null check —
the second caller arrives after the first has already populated the
slot, even though neither call has finished resolving yet. Both
callers `await` the same promise object; the SDK client is constructed
exactly once.

The test-isolation half of the fix is the explicit reset escape hatch.
Bun's test runner shares module state across all test files in a single
`bun test` invocation — a deliberate design choice for performance. The
escape hatch lets `beforeEach`/`afterEach` blocks evict the cached
promise so each test file starts with a clean slate. Without it, the
first integration test to set `ANTHROPIC_API_KEY` and call
`defaultGenerateDeps()` permanently poisons the singleton for every
subsequent test in the run — and the failure is silent because the
real client succeeds at the same operations the mock was supposed to
verify.

## Prevention

Apply the in-flight-promise pattern (and ship a paired test-reset
escape hatch) whenever **all** of the following are true:

- A module-level variable memoizes the result of an `async`
  initialization — any initialization that includes at least one `await`
  between the null check and the final assignment.
- The initialization constructs or wraps an external resource that must
  not be duplicated: an HTTP client, a database connection pool, a file
  handle, a long-lived WebSocket, or any object whose constructor has
  observable side effects (network sockets, credential capture,
  filesystem locks).
- The module runs under a test runner (Bun, Jest, Vitest) that shares
  module instances across test files — or might do so in the future.
- Tests inject mock dependencies via an `opts.deps` escape hatch — if
  the singleton is already populated from a prior integration test,
  `opts.deps` will never be reached on the convenience wrapper path.
- The module is called from parallelized contexts: eval harness loops,
  concurrent request handlers, `Promise.all` fan-outs, or worker-thread
  pools.

When the pattern applies, ship three things together:
1. The `let cached: Promise<T> | null = null` slot.
2. The non-`async` outer function that assigns the IIFE promise on first
   call.
3. The underscore-prefixed `_resetForTest()` (or `__testing.resetX()`)
   escape hatch with a "production MUST NOT import" JSDoc.

## Examples

The full test suite covering both `defaultGenerateDeps` and
`defaultClassifyDeps` lives at
[`tests/llm/defaults.test.ts`](../../../tests/llm/defaults.test.ts).
Three test shapes lock in the contract:

**1. Object-identity dedup — the smallest reproducer for the old race:**

```ts
test("two concurrent callers share the SAME resolved client (no duplicate construction)", async () => {
  const [a, b] = await Promise.all([
    defaultGenerateDeps(),
    defaultGenerateDeps(),
  ]);
  expect(a.client).toBe(b.client);
});
```

**2. Synchronous promise-reference test — pins that the slot is set on
the first call before any await runs:**

```ts
test("synchronous repeat calls return the same promise (cached after first)", () => {
  const first = defaultGenerateDeps();
  const second = defaultGenerateDeps();
  expect(first).toBe(second);
});
```

This test depends on the function being plain (not `async`). An `async`
wrapper would return a different `Promise` wrapper on each call even
when the cached promise was the same — `first` and `second` would not
be `.toBe`-equal, and the test would silently start passing for the
wrong reason if someone re-added `async` later.

**3. Reset test — proves the escape hatch actually evicts the cached
client:**

```ts
test("_resetDefaultDepsForTest clears the slot (next call returns a different deps)", async () => {
  const a = await defaultGenerateDeps();
  _resetDefaultDepsForTest();
  const b = await defaultGenerateDeps();
  expect(b).not.toBe(a);
});
```

The suite wraps each test group in `beforeEach`/`afterEach` hooks that
save and restore `process.env.ANTHROPIC_API_KEY`, set it to a synthetic
value (`"test-key-for-defaults-suite"`), and call the reset function —
making the suite hermetic regardless of whether the integration
environment is active when `bun test` runs.

The identical three-test shape is replicated for `defaultClassifyDeps`
in the same file, establishing this as the codebase standard for any
future lazy-deps factory under `pipeline/llm/`.

## Related Issues

- [`docs/solutions/security-issues/sha256-cache-key-canonical-json-serialization-2026-04-26.md`](../security-issues/sha256-cache-key-canonical-json-serialization-2026-04-26.md)
  — covers the same `infra/server/cache.ts` module from a different
  angle (SHA-256 cache-key collision via raw `\0`-delimited
  concatenation). That doc owns the file's `__testing.resetMemoizedHash()`
  surface; this doc cites it as the codebase precedent for the
  test-reset escape hatch. The two docs together form the codebase's
  pattern set for module-level memoization (synchronous and
  asynchronous variants).
- Round-1 + round-2 `/ce:review` passes on `feat/v01-pipeline-llm`
  (PR [#3](https://github.com/taliamekh/Volteux/pull/3)) — five reviewer
  personas independently flagged the singleton, generating the
  cross-reviewer agreement signal that produced the high-confidence
  merge.
- Commit `db28d38` on `feat/v01-pipeline-llm` — the fix landed.
