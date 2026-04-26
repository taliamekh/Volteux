---
title: Cluster C — UI test coverage for 6 modules
type: feat
status: active
date: 2026-04-26
origin: docs/plans/2026-04-26-001-feat-v01-ui-track1-completion-plan.md
---

# Cluster C — UI test coverage for 6 modules

## Overview

Add focused unit + component tests for six modules under `app/src/` that the prior PR-#4 review flagged as having no behavioral test coverage (review tags `testing-001` through `testing-006`). Five tests are net-new files; one extends the existing `LoadingView` snapshot test to actually exercise the timer chain it currently wraps in `vi.useFakeTimers()` but never advances.

This is test-only work. No source code changes. Six implementation units, fully independent (no shared files), suitable for parallel execution.

---

## Problem Frame

PR #4's `/ce:review` pass surfaced six modules that ship with zero or near-zero coverage — the snapshot tests prove nothing about the underlying `applyRefinement` reducer, the URL-hash gzip+Zod round-trip, the breadboard geometry helpers, the `FlashModal` step chain, the pipeline→UI adapter's failure mode, or the `LoadingView` timer animation past its initial render.

These are exactly the modules where a future regression would be invisible — pure functions and effect-driven UI that the snapshots don't touch. Locking them in now prevents v0.5 refinement work (Track 1 follow-ups, schema bumps, refactor PRs) from silently breaking shared invariants.

Strict scope: stay inside `app/`. No edits to `pipeline/`, `infra/`, `schemas/document.zod.ts`, `components/registry.ts`, `package.json` (root), or `bunfig.toml`. The branch is `test/v01-ui-cluster-c`.

---

## Requirements Trace

- R1. **applyRefinement coverage** — every branch of [app/src/data/projects.ts:29](app/src/data/projects.ts:29) (`applyRefinement`) is exercised, including the dead `automatic-gate` branch (M-04 follow-up depends on this being either covered or formally deleted).
- R2. **urlHash round-trip + error paths** — `encode` / `decode` round-trip equality plus every documented `return null` branch in [app/src/lib/urlHash.ts](app/src/lib/urlHash.ts) is asserted.
- R3. **breadboard-geometry pure helpers** — `parseHole`, `holeToXY`, `shiftHole` from [app/src/panels/breadboard-geometry.ts](app/src/panels/breadboard-geometry.ts) covered for valid input + every documented invalid case.
- R4. **FlashModal interaction coverage** — step auto-advance (4 steps → done), Esc dismissal, backdrop click dismissal, modal-body click does NOT close, reset-on-close behavior of [app/src/components/FlashModal.tsx](app/src/components/FlashModal.tsx).
- R5. **Adapter coverage** — unknown-SKU throws an `Error` with the SKU in the message; every `wire_color` case in `mapWireColor` (red/black/yellow/blue/green/orange→yellow/white→blue/undefined→blue) verified through the `pipelineToProject` public API.
- R6. **LoadingView timer-chain coverage** — extend (do not replace) [app/src/__tests__/LoadingView.test.tsx](app/src/__tests__/LoadingView.test.tsx) to advance through the full 7,700 ms step chain and verify `onComplete` fires.
- R7. **No regression** — the 3 existing snapshot tests continue to pass unchanged.
- R8. **Project conventions hold** — TypeScript strict, no `any` without inline justification; Zod is law (use real schemas, not parallel test fixtures); behavior-focused (no over-mocking, no implementation-coupled assertions).

---

## Scope Boundaries

- **Source changes are out of scope.** If a test reveals that a private helper (e.g., `mapWireColor`) needs to become public to be testable cleanly, surface that as a follow-up — do not change the source in this PR.
- **Test additions for modules already covered are out of scope.** `LandingView`, `ResultView`, and `LoadingView`'s existing render assertion stay as-is (LoadingView gets an additive test, not a rewrite).
- **Snapshot churn is out of scope.** No new snapshots; new tests use explicit `expect()` assertions to avoid the existing snapshot fragility doubling.
- **No edits outside `app/`.** Track 2 owns `pipeline/`, `infra/`, `schemas/document.zod.ts`, `components/registry.ts`, root `package.json`, `bunfig.toml`. Findings that require changes there get flagged for joint-commit review, not patched here.

### Deferred to Follow-Up Work

- **Export `mapWireColor` for direct unit testing**: deferred to a follow-up if U5's indirect approach (synthesize wire-color variants through `pipelineToProject`) proves noisy. Tracked as a v0.1 maintainability question, not blocking.
- **Delete dead `automatic-gate` branch in `applyRefinement`**: M-04 follow-up; covered by U1 with an explicit "no-op verification" test rather than deleted in this PR (deletion is a Cluster B concern).
- **Snapshot LF/CRLF line-ending normalization**: pre-existing repo hygiene issue surfaced by Windows test runs. Out of scope for Cluster C; should be handled by a `.gitattributes` PR.

---

## Context & Research

### Relevant Code and Patterns

- **Test entry point**: `app/vitest.config.ts` (verify) + [app/src/test-setup.ts](app/src/test-setup.ts) which mocks `@monaco-editor/react`, `@react-three/fiber` `Canvas`, and `@react-three/drei` (`OrbitControls`, `Html`, `Box`, `Cylinder`, `Sphere`, `Plane`), plus an `IntersectionObserver` stub.
- **Fixture loader pattern** ([app/src/data/fixtures.ts](app/src/data/fixtures.ts)): `loadDefaultFixture()` returns a `VolteuxProjectDocumentSchema.parse(fixtureJson)`. Use this everywhere a test needs a real project — never invent parallel fixture data.
- **Adapter usage** ([app/src/__tests__/ResultView.test.tsx:16](app/src/__tests__/ResultView.test.tsx:16)): `const project = pipelineToProject(loadDefaultFixture())` is the canonical way to build a `Project` for tests.
- **Existing test shape** ([app/src/__tests__/LoadingView.test.tsx](app/src/__tests__/LoadingView.test.tsx), [app/src/__tests__/LandingView.test.tsx](app/src/__tests__/LandingView.test.tsx)): all three current tests use `vi.useFakeTimers()` in `beforeEach` + `vi.useRealTimers()` in `afterEach`, even when timers are not advanced — keep this convention so timer leaks across files are caught early.
- **R3F mocking gotcha** ([app/src/test-setup.ts:14-41](app/src/test-setup.ts:14-41)): `console.error` filter swallows R3F intrinsic-tag warnings. New tests that render anything past `HeroPanel` inherit this for free; tests that don't (the four pure-function tests) are unaffected.

### Institutional Learnings

- **No prior UI-testing learnings exist** in `docs/solutions/` (verified via `ce-learnings-researcher` 2026-04-26). Conventions established here become the documented baseline. After this PR lands, `/ce:compound` should capture: R3F+jsdom mock pattern, fake-timer + `act()` pattern for effect-driven UI, Zod-round-trip pattern.
- **One tangentially-relevant lesson**: [docs/solutions/logic-errors/lazy-init-singleton-in-flight-promise-bun-test-isolation-2026-04-26.md](docs/solutions/logic-errors/lazy-init-singleton-in-flight-promise-bun-test-isolation-2026-04-26.md) — module-level mutable state can leak across tests. Vitest isolates per file by default, so risk is low here, but watch for it in `applyRefinement` if the deep-clone (`JSON.parse(JSON.stringify(project))`) ever gets optimized away.

### External References

- None. The patterns (vitest + @testing-library/react + jsdom) are standard; the existing test infra already encodes the project's conventions.

---

## Key Technical Decisions

- **Decision: All six units run as parallel build agents in `/ce:work`.** Rationale: they touch six distinct files with zero shared state. Serial execution would waste real time for no quality gain.
- **Decision: `mapWireColor` tested through `pipelineToProject`, not via direct export.** Rationale: keeps Cluster C strictly test-only. The implementer constructs synthetic `VolteuxProjectDocument` variants by spreading `loadDefaultFixture()` with overridden `connections[].wire_color`. If this proves noisy in practice, exporting `mapWireColor` becomes a v0.1 follow-up — but it is not a planning-time blocker.
- **Decision: New tests use explicit `expect()` assertions, not new snapshots.** Rationale: the three existing snapshot tests already protect render output. New tests cover behavior (state transitions, error returns, mappings) that snapshots cannot prove. Adding more snapshots doubles maintenance cost without coverage gain.
- **Decision: Use `vi.advanceTimersByTime()` + `act()` for the two timer-driven tests (FlashModal, LoadingView).** Rationale: setTimeout chains inside `useEffect` schedule React state updates; advancing timers without `act()` produces console warnings and flaky assertions.
- **Decision: U1 includes the dead `automatic-gate` branch.** Rationale: covering it now makes the M-04 deletion (Cluster B follow-up) safer — the test confirms current behavior so the deletion PR has a clean diff signal.
- **Decision: U6 extends, not replaces, the existing `LoadingView` snapshot test.** Rationale: the existing snapshot is a non-coupling cheap regression guard. Adding a separate timer-advance test in the same file gives both protections without one stepping on the other.

---

## Open Questions

### Resolved During Planning

- **Where does `applyRefinement` live?** → [app/src/data/projects.ts](app/src/data/projects.ts) (verified — the prompt's `app/src/state/projects.ts` was wrong; project state is in `data/`, not `state/`).
- **Where does the URL-hash codec live?** → [app/src/lib/urlHash.ts](app/src/lib/urlHash.ts) (verified).
- **Is `mapWireColor` exported?** → No, internal to [app/src/data/adapter.ts](app/src/data/adapter.ts). Plan accommodates by testing through `pipelineToProject`.
- **Does jsdom support `CompressionStream` / `DecompressionStream`?** → Yes in modern Node 18+ (which the repo uses). The existing prod code in `urlHash.ts` already depends on this; if it works at runtime it works in tests.

### Deferred to Implementation

- **Exact `act()` ergonomics for FlashModal / LoadingView timer advances.** React 18 + @testing-library/react may handle this transparently or require explicit `await act(async () => { vi.advanceTimersByTime(N); })`. Implementer should pick the minimum-friction pattern that produces zero React warnings.
- **Whether `vi.advanceTimersByTimeAsync` (vitest 0.30+) is available.** If yes, use it for the async-effect tests; cleaner than the sync version.
- **Whether `vitest.config.ts` already imports `app/src/test-setup.ts`.** Need to verify during U4 + U6 that the global mocks are picked up (the existing tests work, so this is almost certainly fine — flagging only because it's an execution-time observation).

---

## Implementation Units

The six units are **fully independent** — each writes one new test file (or modifies one existing) and reads only its own source under test plus the shared fixture loader. Run all six as parallel build agents.

| U-ID | Test file (new/modify) | Source under test | Type |
|---|---|---|---|
| U1 | `app/src/__tests__/projects.test.ts` (NEW) | `app/src/data/projects.ts` | Pure unit |
| U2 | `app/src/__tests__/urlHash.test.ts` (NEW) | `app/src/lib/urlHash.ts` | Async unit |
| U3 | `app/src/__tests__/breadboard-geometry.test.ts` (NEW) | `app/src/panels/breadboard-geometry.ts` | Pure unit |
| U4 | `app/src/__tests__/FlashModal.test.tsx` (NEW) | `app/src/components/FlashModal.tsx` | Component (timers + DOM) |
| U5 | `app/src/__tests__/adapter.test.ts` (NEW) | `app/src/data/adapter.ts` | Integration unit |
| U6 | `app/src/__tests__/LoadingView.test.tsx` (MODIFY) | `app/src/views/LoadingView.tsx` | Component (timers) |

---

- U1. **applyRefinement reducer coverage**

**Goal:** Cover all four conditional branches in `applyRefinement`, the no-op cases, and the input-immutability invariant.

**Requirements:** R1, R8

**Dependencies:** None.

**Files:**
- Create: `app/src/__tests__/projects.test.ts`
- Reads: `app/src/data/projects.ts`, `app/src/data/adapter.ts` (for `pipelineToProject`), `app/src/data/fixtures.ts` (for `loadDefaultFixture`)

**Approach:**
- Use `pipelineToProject(loadDefaultFixture())` as the input project — it has `key === "robot-arm-wave"` (verified in `adapter.ts` `isWavingArmFixture`), the `distance < 25` substring, and no buzzer.
- Each test calls `applyRefinement(project, "<refinement string>")` and asserts on both `result.changed` and the relevant slice of `result.project`.
- Verify input immutability by deep-equality-checking the original project after the call (the deep-clone via `JSON.parse(JSON.stringify())` is a load-bearing invariant per [app/src/data/projects.ts:33](app/src/data/projects.ts:33)).

**Patterns to follow:**
- Mirror the import + `describe`/`it` shape of `LoadingView.test.tsx`.
- No timer setup needed (pure synchronous function).

**Test scenarios:**
- Happy path — "wave 3 times": `result.changed === true`, `result.project.sketchSource` contains `for (int i = 0; i < 3; i++) {`, `result.project.document?.sketch.main_ino` mirrors the same change. Original `project.sketchSource` unchanged.
- Happy path — "really close": `changed === true`, `result.project.sketchSource` contains `distance < 10` not `distance < 25`, `result.project.document?.sketch.main_ino` reflects the same, `result.project.code` updated (the legacy `p.code.map` path).
- Happy path — "10 cm": same expectation as "really close" (regex alternation `/really close|closer|10\s*cm|nearby/`).
- Happy path — "add a beep": `changed === true`, `result.project.parts` includes a `Piezo buzzer` with `id === "buzzer"`, `result.project.wiring` includes a connection from `Buzzer+`, `result.project.document?.components` includes `{ id: "bz1", sku: "1536", quantity: 1 }`, `result.project.document?.connections` includes the buzzer signal-pin entry.
- Edge case — "add a beep" idempotency: calling refinement twice returns `changed === true` then `changed === false` (the second call hits the `&& !p.parts.find((x) => x.id === "buzzer")` guard).
- Edge case — wave with wrong project key: clone the project with `key` overridden to anything other than `"robot-arm-wave"`, refinement `"wave 5 times"` → `changed === false`, `sketchSource` unchanged.
- Edge case — automatic-gate "stay open longer" with wrong key: `changed === false` (currently dead — verifies the dead-code state for the M-04 deletion follow-up).
- Edge case — automatic-gate "stay open longer" with `key === "automatic-gate"`: clone with key override; `changed === true` and `delay(10000)` appears (covers the dead branch's documented behavior so the M-04 deletion has a clean diff signal).
- Edge case — empty refinement string: `changed === false`, project unchanged.
- Edge case — refinement with no matching keyword ("make it green"): `changed === false`, project unchanged.
- Edge case — input immutability after every branch: `JSON.stringify(originalProject)` matches a snapshot taken before the call.

**Verification:**
- `npm test -- --run projects.test.ts` exits clean.
- All four `applyRefinement` branches (lines 46, 81, 113, 149 of projects.ts) have at least one passing assertion exercising both their truthy and falsy paths.

---

- U2. **urlHash round-trip + error-path coverage**

**Goal:** Verify `encode` → `decode` round-trip identity, plus every documented `return null` branch in `decode`.

**Requirements:** R2, R8

**Dependencies:** None.

**Files:**
- Create: `app/src/__tests__/urlHash.test.ts`
- Reads: `app/src/lib/urlHash.ts`, `app/src/data/fixtures.ts`, `schemas/document.zod.ts` (read-only — DO NOT modify)

**Approach:**
- Use `loadDefaultFixture()` as the canonical input doc.
- `encode` and `decode` are both `async` — use `async`/`await` in test bodies.
- Round-trip: `expect(await decode(await encode(doc))).toEqual(doc)` (deep equality on the parsed schema).
- For error paths, construct the bad input directly (no need to corrupt `encode`'s output).
- All decode failures should resolve to `null`, never throw — assert `expect(...).resolves.toBeNull()` not `expect(...).rejects`.

**Patterns to follow:**
- Same `describe`/`it`/`vi.useFakeTimers` skeleton as the other tests, even though no timers fire (consistency with file conventions; harmless overhead).

**Test scenarios:**
- Happy path — round-trip identity: `await decode(await encode(loadDefaultFixture()))` deep-equals `loadDefaultFixture()`.
- Happy path — encode produces `v1:` prefix: `(await encode(doc)).startsWith("v1:")`.
- Happy path — encode is URL-safe: encoded body matches `/^v1:[A-Za-z0-9_-]+$/` (no `+`, `/`, or `=`).
- Happy path — decode tolerates leading `#`: `decode("#" + encoded)` returns the same doc as `decode(encoded)`.
- Error path — wrong prefix: `decode("v2:abc")` resolves to `null`.
- Error path — no prefix: `decode("abc")` resolves to `null`.
- Error path — `v1:` with empty body: `decode("v1:")` resolves to `null`.
- Error path — oversized base64 (decompression-bomb cap): `decode("v1:" + "A".repeat(64 * 1024 + 1))` resolves to `null` (the >MAX_HASH_INPUT_BYTES branch).
- Error path — malformed base64 (atob throws): `decode("v1:!!!")` resolves to `null` (caught by outer try).
- Error path — valid base64, non-gzip body: encode something garbage to base64-url and prefix with `v1:` — DecompressionStream errors, caught, returns `null`.
- Error path — valid gzip, non-JSON body: gzip-encode the literal string `"not json {{"`, base64-url it, prefix `v1:`, expect `null` (JSON.parse throws, caught).
- Error path — valid JSON, fails Zod: gzip-encode `JSON.stringify({ unrelated: "object" })`, expect `null` (safeParse fails).
- Error path — extra-large decompressed payload: synthesize a gzipped payload that decompresses to >1 MiB (e.g., gzip of `"x".repeat(2 * 1024 * 1024)`) — expect `null` from the bomb-cap reader loop. Use a helper that mirrors `encode`'s gzip step.

**Verification:**
- `npm test -- --run urlHash.test.ts` exits clean.
- Every `return null` branch in [app/src/lib/urlHash.ts](app/src/lib/urlHash.ts) `decode` (lines 69, 71, 74, 96, 109, 111) has at least one test reaching it.

---

- U3. **breadboard-geometry pure helpers**

**Goal:** Cover `parseHole`, `holeToXY`, `shiftHole` for valid input and every documented invalid case.

**Requirements:** R3, R8

**Dependencies:** None.

**Files:**
- Create: `app/src/__tests__/breadboard-geometry.test.ts`
- Reads: `app/src/panels/breadboard-geometry.ts`

**Approach:**
- Pure synchronous functions — no async, no timers, no DOM.
- Use `it.each([...])` for parameterized rows where helpful.
- Verify the `holeToXY` output against the documented constants (`ORIGIN_X = 29`, `COL_SPACING = 18`, `ROW_SPACING = 16`, `CHANNEL = 16`).

**Patterns to follow:**
- Plain `describe`/`it`. No render. No timer setup.

**Test scenarios:**
- Happy path — `parseHole("a1")` returns `{ row: "a", col: 1 }`.
- Happy path — `parseHole("j30")` returns `{ row: "j", col: 30 }`.
- Happy path — `parseHole("e15")` returns `{ row: "e", col: 15 }`.
- Edge case — `parseHole("k1")` returns `null` (row out of range).
- Edge case — `parseHole("a31")` returns `null` (col > 30).
- Edge case — `parseHole("a0")` returns `null` (col < 1; regex starts at `[1-9]`).
- Edge case — `parseHole("")` returns `null`.
- Edge case — `parseHole("1a")` returns `null` (wrong order).
- Edge case — `parseHole("A1")` returns `null` (uppercase row not allowed by regex).
- Happy path — `holeToXY({ row: "a", col: 1 })` returns `{ x: 29, y: 40 }` (top-left).
- Happy path — `holeToXY({ row: "f", col: 1 })` returns `{ x: 29, y: 40 + 5 * 16 + 16 }` = `{ x: 29, y: 136 }` (first bottom-half row, includes CHANNEL).
- Happy path — `holeToXY({ row: "e", col: 1 })` returns `{ x: 29, y: 40 + 4 * 16 }` = `{ x: 29, y: 104 }` (last top-half row, no CHANNEL).
- Happy path — `holeToXY({ row: "j", col: 30 })` returns `{ x: 29 + 29 * 18, y: 40 + 9 * 16 + 16 }` = `{ x: 551, y: 200 }`.
- Happy path — `shiftHole({ row: "c", col: 5 }, 1, 2)` returns `{ row: "d", col: 7 }`.
- Edge case — `shiftHole({ row: "a", col: 1 }, -1, 0)` returns `null` (off the top).
- Edge case — `shiftHole({ row: "j", col: 1 }, 1, 0)` returns `null` (off the bottom).
- Edge case — `shiftHole({ row: "a", col: 1 }, 0, -1)` returns `null` (off the left, col < 1).
- Edge case — `shiftHole({ row: "a", col: 30 }, 0, 1)` returns `null` (off the right, col > 30).
- Edge case — `shiftHole({ row: "e", col: 15 }, 1, 0)` returns `{ row: "f", col: 15 }` (crosses the channel — purely an `indexOf` step, no special handling).

**Verification:**
- `npm test -- --run breadboard-geometry.test.ts` exits clean.
- All three exported functions covered with at least 3 happy-path + 3 edge-case assertions each.

---

- U4. **FlashModal interaction coverage**

**Goal:** Cover step auto-advance through the 4-step chain, "done" phase render, Esc dismissal, backdrop click dismissal, modal-body click does NOT close, and reset on close.

**Requirements:** R4, R8

**Dependencies:** None.

**Files:**
- Create: `app/src/__tests__/FlashModal.test.tsx`
- Reads: `app/src/components/FlashModal.tsx`, `app/src/data/adapter.ts` + `app/src/data/fixtures.ts` (for a real `Project` instance)

**Approach:**
- Use `vi.useFakeTimers()` in `beforeEach` and advance with `vi.advanceTimersByTime` wrapped in `act()` (or `await act(async () => ...)` if needed for state-update flushing).
- The 4 step durations are 700 + 900 + 1100 + 600 = 3,300 ms. After 3,300 ms the phase becomes `"done"`.
- Use `pipelineToProject(loadDefaultFixture())` for the `project` prop; assert title appears (`"Waving robot arm"`) in the modal copy.
- For Esc: `fireEvent.keyDown(window, { key: "Escape" })` then assert `onClose` was called.
- For backdrop: `fireEvent.click(container.querySelector(".auth-overlay")!)` then assert `onClose` called.
- For modal-body click: `fireEvent.click(container.querySelector(".flash-modal")!)` then assert `onClose` NOT called.
- For reset: render with `open={true}`, advance to step 2, rerender with `open={false}`, then `open={true}` again — assert step 0 active again.

**Patterns to follow:**
- `vi.useFakeTimers()` + `vi.useRealTimers()` shape from existing tests.
- `render` + `screen` + `fireEvent` from `@testing-library/react`.

**Test scenarios:**
- Happy path — initial render with `open={true}`: shows "Connecting to your Uno" label; phase is `"connect"`; success view NOT shown.
- Happy path — `open={false}`: nothing rendered (`return null` at line 60).
- Happy path — step advance: render → advance 700 ms → "Compiling your sketch" is the active step → advance 900 ms → "Uploading to the board" active → advance 1,100 ms → "Verifying" active → advance 600 ms → success view (`"Done!"`) shown.
- Happy path — done view shows project title: after full advance, screen contains `Waving robot arm`.
- Happy path — done view fallback when `project={null}`: success message includes `"project"` (the `project?.title ?? "project"` fallback).
- Integration — Esc closes: render with `onClose` mock; `fireEvent.keyDown(window, { key: "Escape" })`; expect `onClose` called once.
- Integration — Esc does nothing when modal closed: render with `open={false}`, dispatch Escape, expect `onClose` NOT called.
- Integration — backdrop click closes: click `.auth-overlay`, expect `onClose` called.
- Integration — modal body click does NOT close: click `.flash-modal` (or `.auth-modal`), expect `onClose` NOT called (the `e.stopPropagation()` guard).
- Integration — close button (`button[aria-label="Close"]`) calls `onClose` when clicked.
- Integration — reset on close: render `open={true}`, advance 1,000 ms (past first step), rerender with `open={false}`, then rerender with `open={true}` again; first step "Connecting to your Uno" should be active again (state reset to `setActive(0)` / `setPhase("connect")`).

**Verification:**
- `npm test -- --run FlashModal.test.tsx` exits clean.
- No React `act()` warnings printed.
- Both `useEffect` hooks (line 23 and line 51) have their cleanup paths exercised at least once.

---

- U5. **Adapter coverage — unknown SKU + wire-color mapping**

**Goal:** Verify `pipelineToProject` throws for unknown SKUs with the SKU in the message, and that every `mapWireColor` case is reachable through the adapter.

**Requirements:** R5, R8

**Dependencies:** None.

**Files:**
- Create: `app/src/__tests__/adapter.test.ts`
- Reads: `app/src/data/adapter.ts`, `app/src/data/fixtures.ts`, `schemas/document.zod.ts` (read-only), `components/registry.ts` (read-only)

**Approach:**
- Use `loadDefaultFixture()` as a base, mutate via `structuredClone` (jsdom supports it) to construct the variants.
- For unknown-SKU: clone the doc, push a synthetic `{ id: "x1", sku: "9999", quantity: 1 }` into `components`. Assert `expect(() => pipelineToProject(modified)).toThrow(/Unknown SKU: 9999/)`.
- For wire-color cases: clone the doc, set `connections[0].wire_color` to each variant in turn (`red`, `black`, `yellow`, `blue`, `green`, `orange`, `white`), call `pipelineToProject(clone)`, and assert `result.wiring[0].color` matches the documented mapping (`orange → "yellow"`, `white → "blue"`, `red → "red"`, etc.).
- For `undefined` wire_color: the schema requires the field (verify in schemas/document.zod.ts), so this case may only be reachable by bypassing the schema. If schema-required, document the case as "unreachable through Zod, internal default branch" with one synthetic call that bypasses parse — or skip with a `it.skip` + comment explaining. Implementer decides at runtime based on what the schema actually allows.

**Patterns to follow:**
- Plain `describe`/`it` + `it.each(...)` for the wire-color matrix.
- Reuse the `loadDefaultFixture()` pattern from `ResultView.test.tsx`.

**Test scenarios:**
- Happy path — `pipelineToProject(loadDefaultFixture())` returns a `Project` with `key === "robot-arm-wave"`, `parts.length >= 4` (Uno, sensor, servo, breadboard), `wiring.length > 0`, `document` populated, `sketchSource` non-empty.
- Happy path — title mapping: `result.title === "Waving robot arm"`, `result.blurb` non-empty.
- Error path — unknown SKU: clone doc, push `{ id: "x1", sku: "9999", quantity: 1 }`, expect `pipelineToProject` to throw `Error` whose message matches `/Unknown SKU: 9999/`.
- Error path — empty SKU: same approach with `sku: ""`, expect throw.
- Edge case — non-canonical archetype: clone doc, set `archetype_id: "esp32-audio-dashboard"` (one of the other entries in `ARCHETYPE_TITLES`); assert `result.key === "esp32-audio-dashboard"` (the `isWavingArmFixture` returns false because archetype no longer matches), `result.title === "Audio dashboard"`.
- Edge case — unknown archetype falls back: clone doc, set `archetype_id: "unknown-archetype-xyz"`; assert `result.title === "unknown-archetype-xyz"`, `result.blurb === ""`.
- Wire-color matrix (it.each): for each input → expected mapping:
  - `red` → `"red"`
  - `black` → `"black"`
  - `yellow` → `"yellow"`
  - `blue` → `"blue"`
  - `green` → `"green"`
  - `orange` → `"yellow"` (closest UI palette match)
  - `white` → `"blue"` (closest UI palette match)
- Edge case — wire-color undefined / unrecognized (if schema permits): the `default` branch returns `"blue"` — assert this if a clone with an unrecognized color survives Zod, otherwise skip with rationale comment.

**Verification:**
- `npm test -- --run adapter.test.ts` exits clean.
- The `mapWireColor` switch (lines 91-110 of adapter.ts) has every documented case asserted.
- The unknown-SKU throw (line 249 of adapter.ts) has at least one assertion reaching it.

---

- U6. **LoadingView timer-chain coverage (extend existing)**

**Goal:** Extend (do NOT replace) the existing snapshot test in `LoadingView.test.tsx` to advance the full 7,700 ms timer chain and verify `onComplete` fires exactly once.

**Requirements:** R6, R7, R8

**Dependencies:** None.

**Files:**
- Modify: `app/src/__tests__/LoadingView.test.tsx`
- Reads: `app/src/views/LoadingView.tsx`

**Approach:**
- Keep the existing `it("renders the prompt + first step active", ...)` test entirely as-is.
- Add a second `it(...)` block in the same `describe` that uses `vi.useFakeTimers()` (already in `beforeEach`), renders the view with a mock `onComplete`, advances through the step chain, and asserts state at each transition.
- Steps and durations from `LoadingView.tsx` lines 15-21: `read` 800, `parts` 1500, `code` 2200, `compile` 1500, `wire` 1200 → 7,200 ms total. After all steps, an additional 500 ms delay before `onComplete` fires (line 43). Total: 7,700 ms.
- The existing snapshot stays. The new test does NOT take a snapshot — explicit `expect()` assertions only.
- Wrap timer advances in `act()` to flush React state updates without warnings.

**Patterns to follow:**
- Identical setup as the existing test (same imports, same `beforeEach`/`afterEach`).
- Do not touch the existing snapshot file.

**Test scenarios:**
- Happy path — each step transition: render → assert step 0 ("read") active → advance 800 ms → assert step 1 ("parts") active → advance 1500 ms → step 2 ("code") active → advance 2200 ms → step 3 ("compile") active → advance 1500 ms → step 4 ("wire") active → advance 1200 ms → status text becomes `"Done. Loading your project…"`.
- Happy path — `onComplete` callback: after advancing the full 7,700 ms, expect `onComplete` mock was called exactly once.
- Edge case — early unmount cancels: render, advance 1,000 ms (mid-step-1), call `unmount()`, advance another 10,000 ms; `onComplete` mock NOT called (the `cancelled` flag in the cleanup function prevents the trailing call).
- Edge case — connector classes update with progress: after advancing past step 0, the first `.step-connector` element has class `done` (covers the connector rendering at LoadingView.tsx line 67).

**Verification:**
- `npm test -- --run LoadingView.test.tsx` exits clean.
- Both `it(...)` blocks pass.
- The existing snapshot file is byte-identical (no changes to `__snapshots__/LoadingView.test.tsx.snap`).
- No React `act()` warnings printed.

---

## System-Wide Impact

- **Interaction graph:** None. Tests run in isolation per vitest's per-file worker model. No shared mutable state introduced.
- **Error propagation:** No production code paths change. Test failures are local to the new files; existing snapshot tests are untouched (U6 extends, doesn't modify, the existing test).
- **State lifecycle risks:** None — tests are pure additions.
- **API surface parity:** No changes. `mapWireColor` stays internal; `applyRefinement`'s public shape is preserved.
- **Integration coverage:** This work *is* integration coverage for previously-blind module interactions (`adapter` ↔ `registry`, `urlHash` ↔ `Zod schema`, `applyRefinement` ↔ `document` mutation chain).
- **Unchanged invariants:** The 3 existing snapshot tests (`LandingView`, `LoadingView` first test, `ResultView`) MUST continue to pass byte-identically. The R3F + Monaco mocks at `test-setup.ts` MUST not need any changes — if a new test would require additional mocks, that's a signal something is wrong with the test approach.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Fake-timer + React `act()` warnings flood test output (U4, U6) | Implementer wraps `vi.advanceTimersByTime` in `act()` or uses `vi.advanceTimersByTimeAsync` if available. Test counts as "complete" only when no warnings print. |
| `mapWireColor` is not exported, indirect testing through `pipelineToProject` is noisy (U5) | Plan accepts the noise as the v0 trade-off (keeps Cluster C test-only). If real friction emerges, exporting becomes a v0.1 follow-up — not a blocker. |
| Decompression-bomb test (U2) consumes too much memory in CI | Use a small synthetic input (gzip of `"x".repeat(2 * 1024 * 1024)` is well within reasonable test memory; the 1 MiB cap aborts the read loop quickly). |
| LF/CRLF line-ending diff appears in `__snapshots__/` after running tests on Windows | Pre-existing repo issue (not caused by this PR). Documented in Scope Boundaries → Deferred. Implementer should `git checkout` the snapshot files before commit if they show up modified. |
| `structuredClone` not available in jsdom Node version | Verify during U5 implementation; fallback is `JSON.parse(JSON.stringify(doc))` (safe because `VolteuxProjectDocument` is JSON-serializable by definition). |

---

## Documentation / Operational Notes

- **After merge**: run `/ce:compound` to capture the test patterns established here (R3F + jsdom mocking, fake-timer + `act()` for effect-driven UI, Zod-round-trip pattern, gzip-bomb-cap testing) into `docs/solutions/`. The `ce-learnings-researcher` confirmed these are net-new institutional knowledge.
- **No CI config changes needed**: the existing `npm test -- --run` command picks up new files in `app/src/__tests__/` automatically.
- **No README updates needed**: tests are self-documenting via test names.

---

## Sources & References

- **Origin plan**: [docs/plans/2026-04-26-001-feat-v01-ui-track1-completion-plan.md](docs/plans/2026-04-26-001-feat-v01-ui-track1-completion-plan.md) (PR #4 follow-up cluster)
- **PR #4** (foundation): [Volteux#4](https://github.com/taliamekh/Volteux/pull/4)
- **Source files under test**:
  - [app/src/data/projects.ts](app/src/data/projects.ts)
  - [app/src/lib/urlHash.ts](app/src/lib/urlHash.ts)
  - [app/src/panels/breadboard-geometry.ts](app/src/panels/breadboard-geometry.ts)
  - [app/src/components/FlashModal.tsx](app/src/components/FlashModal.tsx)
  - [app/src/data/adapter.ts](app/src/data/adapter.ts)
  - [app/src/views/LoadingView.tsx](app/src/views/LoadingView.tsx)
- **Test infra**: [app/src/test-setup.ts](app/src/test-setup.ts), existing tests in [app/src/__tests__/](app/src/__tests__/)
- **Tangentially relevant learning**: [docs/solutions/logic-errors/lazy-init-singleton-in-flight-promise-bun-test-isolation-2026-04-26.md](docs/solutions/logic-errors/lazy-init-singleton-in-flight-promise-bun-test-isolation-2026-04-26.md)
