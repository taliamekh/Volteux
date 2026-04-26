---
title: Cluster B — type/contract hygiene + dead-code cleanup
type: refactor
status: active
date: 2026-04-26
---

# Cluster B — type/contract hygiene + dead-code cleanup

## Overview

Six bounded type-safety + cleanup items deferred from PR #4 and PR #7 reviews. No user-visible behavior changes. The PR exists to remove footguns the next round of UI work would otherwise inherit: untrusted localStorage, optional `Project.document` that's actually always populated, default-branch wire-color mapping that loses exhaustiveness, the `"SKU 239"` display-prefix trap, a global `window.__volteux_focusInput` shim, and a cluster of dead Project fields + dead code branches.

This is Lightweight-depth planning — the items are mechanical, bounded, and well-understood. No deepening pass.

---

## Problem Frame

Three of these items are direct findings from PR #7's `/ce:review` pass that were triaged into Cluster B (kt-001 dead boolean, kt-002 SKU branding, kt-005 readonly drag state). The rest were deferred from PR #4's review (PS-003, kt-003, kt-004, kt-005, kt-007, M-01..M-04). Shipping them as one PR keeps the diffs related-by-theme without bloating any single commit.

---

## Requirements Trace

- R1. `loadUser()` parses raw localStorage through a Zod schema. A garbled or attacker-modified localStorage entry returns null instead of typing-by-cast. → U1
- R2. `Project.document` is required (not optional). The `WiringPanel` fixture-fallback shim disappears. → U2
- R3. `mapWireColor` accepts the schema's `wire_color` enum (not `string | undefined`) and uses an exhaustive switch with `assertNever`-style never-check. → U3
- R4. `Part.sku` carries the raw SKU (e.g., `"239"`), not the display-prefixed form (`"SKU 239"`). PartsPanel adds the "SKU " prefix at render time. HeroScene's lookup no longer needs `skuKey()`. → U4
- R5. `LandingView`'s focus + scroll-back behavior is exposed via a `useImperativeHandle` ref forwarded from App, not via `window.__volteux_focusInput` global assignment. → U5
- R6. `Project.match`, `Project.prompt`, `Project.code`, `CodeLine`/`CodeSegment`/`CodeSegmentKind` types, the `tokenizeSketch` adapter helper, the `applyRefinement` `p.code` mutations, and the unreachable `automatic-gate` branch are removed. → U6
- R7 (system). `npx tsc --noEmit` clean. `npm test -- --run` 15/15 pass after each unit lands. The Landing → Loading → Result flow, chat refinements, drag handles, expand mode, sign-in modal, FlashModal, hashchange/back-forward, and ErrorBoundary all keep working. → all units

---

## Scope Boundaries

- **No new user-visible behavior.** This PR is type-tightening + dead-code cleanup. All four interaction flows behave identically.
- **No edits outside `app/`.** Pipeline/, infra/, schemas/, components/registry.ts, root package.json, bunfig.toml are off-limits. Talia owns the UI track exclusively.
- **No test rewrites.** The 15 existing tests must continue to pass. New tests are nice-to-have but deferred to Cluster C.
- **No registry changes.** Buzzer SKU `"1536"` (referenced by `applyRefinement`'s "add a beep" branch) is a Cluster D / joint-commit item. The chat-driven refinement keeps the existing `WiringPanel` warning behavior unchanged.

### Deferred to Follow-Up Work

- **Cluster C (test coverage):** unit tests for the new `loadUser` Zod schema, `Part.sku` shape regression, dead-code-removal regression. Separate PR.
- **Cluster D (cross-track):** Buzzer SKU `"1536"` registration in `components/registry.ts` and Adafruit URL comma-encoding sanity check. Joint with Kai.

---

## Context & Research

### Relevant Code

- [app/src/App.tsx:23-30](app/src/App.tsx) — `loadUser()` does `JSON.parse(raw) as User` (R1).
- [app/src/types.ts:94](app/src/types.ts) — `Project.document?: VolteuxProjectDocument` (R2).
- [app/src/panels/WiringPanel.tsx:17-28](app/src/panels/WiringPanel.tsx) — `fixtureDoc` fallback at line 27-28; consumed at line 237 (`project.document ?? fixtureDoc`). Drop with R2.
- [app/src/data/adapter.ts:91-110](app/src/data/adapter.ts) — `mapWireColor(color: string | undefined): WireColor` with default branch (R3).
- [app/src/data/adapter.ts:254](app/src/data/adapter.ts) — `sku: \`SKU ${entry.sku}\`` produces the prefixed display string (R4).
- [app/src/panels/HeroScene.tsx:69-78,256,264](app/src/panels/HeroScene.tsx) — `skuKey()` strip + `part.sku === "SKU 239"` literal compare. Both go away with R4.
- [app/src/panels/PartsPanel.tsx:47](app/src/panels/PartsPanel.tsx) — `<div className="part-sku">{p.sku}</div>` becomes `{`SKU ${p.sku}`}`.
- [app/src/views/LandingView.tsx:32-37](app/src/views/LandingView.tsx) — `__volteux_focusInput` global assignment (R5).
- [app/src/App.tsx:259-261](app/src/App.tsx) — `onScrollToInput={() => window.__volteux_focusInput?.()}` (R5).
- [app/src/types.ts:54-79](app/src/types.ts) — `CodeSegmentKind`, `CodeSegment`, `CodeLine`, `Project.code`, `Project.match`, `Project.prompt` to be removed (R6).
- [app/src/data/adapter.ts:114-194](app/src/data/adapter.ts) — `tokenizeSketch` + `CPP_KEYWORDS` + `CPP_FUNCTIONS` + `classifyToken`. Dead post-R6.
- [app/src/data/projects.ts:81-103,146-162](app/src/data/projects.ts) — `p.code` mutations + automatic-gate branch (R6).

### Patterns to Follow

- **Zod boundary validation** — mirror existing `decode()` in [app/src/lib/urlHash.ts](app/src/lib/urlHash.ts): `safeParse` returns `null` on failure, never throws. The `loadUser` change is the same shape.
- **`assertNever` exhaustiveness** — use the pipeline's `assertNeverCompileGateFailureKind` pattern from [pipeline/types.ts](pipeline/types.ts) at module-local scope (just `const _: never = color;` with `// @ts-expect-error` if exhaustiveness isn't met would also work, but the inline `_: never = color` is clearer).
- **`useImperativeHandle`** — mirror `HeroScene`'s `forwardRef<HeroSceneHandle, ...>` pattern at [app/src/panels/HeroScene.tsx:172-194](app/src/panels/HeroScene.tsx). LandingView's exposed surface is `{ focusInput: () => void }`.

---

## Key Technical Decisions

- **`Part.sku` becomes raw SKU; PartsPanel renders the prefix.** Alternative considered: branded type with `Sku` newtype + helper. Rejected as over-engineered for v0 — the prefix lives in one render site (PartsPanel) plus one logical comparison (HeroScene's `isBreadboard`). Inline string template is fine.
- **`UserSchema` lives in `app/src/types.ts`** alongside the `User` interface, exported separately. Not in a new `schemas/` file — the User shape is UI-only; localStorage is the only boundary.
- **Drop `tokenizeSketch` + `CodeLine` types entirely** rather than mark them deprecated. They are not exported and have one consumer (the adapter) that no longer needs them. Half-cleanup is worse than full cleanup here.
- **`useImperativeHandle` over a callback prop** for LandingView's focus surface. Alternative: `App` passes a `focusRequestRef` and LandingView writes to it on mount. Rejected — `useImperativeHandle` is the React-idiomatic primitive for exposing imperative methods from a child. The React docs explicitly call out this pattern for "scrolling to an item, focusing an input."
- **Keep the `applyRefinement` buzzer / "really close" branches.** They WORK on the current view-model; only the dead `p.code` mutations get removed. The buzzer SKU registration is a separate Cluster D commit.

---

## Open Questions

### Resolved During Planning

- *Should `Project.prompt` go via removal or via promotion to required?* → Removal. App carries its own `prompt` state ([App.tsx:34](app/src/App.tsx)) and Header reads from that, not from `Project.prompt`. The field is write-only.
- *Drop `CodeLine`/`CodeSegment` types entirely or keep for future syntax-highlighting?* → Drop. Monaco does its own highlighting. The types are storage for a tokenizer that produces output nobody renders.
- *Snapshot impact of `Part.sku` change?* → PartsPanel snapshot will show `<div class="part-sku">SKU 239</div>` vs `<div class="part-sku">SKU 239</div>` — identical output if PartsPanel adds the prefix. ResultView snapshot includes parts list, expect zero diff. If diff appears, accept the new baseline (the rendered text is unchanged; internal data shape differs).

### Deferred to Implementation

- *Where to put `assertNever` helper* — implementer's call. Could be a one-liner inline in `mapWireColor`, or extracted to `app/src/lib/assertNever.ts`. Default: inline.
- *LandingView `useImperativeHandle` shape — `focusInput` or `scrollAndFocus`?* — implementer's call. The current global does both (scroll + delayed focus). Same name for clarity.

---

## Implementation Units

- U1. **Zod-validate localStorage `User`**

  **Goal:** Replace `JSON.parse(raw) as User` with `UserSchema.safeParse(JSON.parse(raw))`. Garbage localStorage returns null gracefully.

  **Requirements:** R1, R7

  **Dependencies:** None.

  **Files:**
  - Modify: `app/src/types.ts` — export `UserSchema = z.object({...})` matching the `User` interface; keep `User` as `z.infer<typeof UserSchema>`.
  - Modify: `app/src/App.tsx` — `loadUser()` runs `safeParse` on the parsed JSON; returns null on failure.

  **Approach:**
  - Schema: `z.object({ email: z.string(), initials: z.string(), provider: z.enum(["email", "google", "github"]) })`.
  - Replace `User` interface with `type User = z.infer<typeof UserSchema>`.
  - `loadUser`: `try { const parsed = JSON.parse(raw); const r = UserSchema.safeParse(parsed); return r.success ? r.data : null; } catch { return null; }`.

  **Test scenarios:**
  - Test expectation: none — covered indirectly by the existing test suite continuing to pass. A focused unit test for the safeParse failure path is a Cluster C item.

  **Verification:** tsc clean. `npm test -- --run` passes.

---

- U2. **`Project.document` required + drop WiringPanel fixture-fallback**

  **Goal:** Make `Project.document` non-optional. The adapter always populates it; only test mocks would need updating (snapshot tests don't construct Projects directly). Drop `WiringPanel`'s `fixtureDoc` fallback shim.

  **Requirements:** R2, R7

  **Dependencies:** None (parallel-safe).

  **Files:**
  - Modify: `app/src/types.ts` — `Project.document: VolteuxProjectDocument` (drop the `?`).
  - Modify: `app/src/panels/WiringPanel.tsx` — remove `fixtureJson` import, `fixtureDoc` constant, and `?? fixtureDoc` at line 237.
  - Verify: `app/src/data/adapter.ts:294` — adapter already always sets `document: doc`. No change needed.
  - Verify: `app/src/data/projects.ts:62-70,93-101,125-141` — `applyRefinement` already guards on `if (p.document)` for safety, but with the field required these guards become unnecessary; simplify (drop the `if` wrapping; the inner code runs unconditionally).

  **Approach:**
  - The `if (p.document)` guards in `applyRefinement` were defensive given the optional field. With it required, simplify to direct mutation. Reduces nesting.
  - WiringPanel's `fixtureDoc` import was a "safety net" for the brief render window where Project might not have a document. With the field required, the safety net is dead code.

  **Test scenarios:**
  - Test expectation: existing snapshot tests cover regression — ResultView mounts WiringPanel with the fixture-derived project; output should be identical.
  - Manual: dev server should still render the wiring panel correctly with no console warnings.

  **Verification:** tsc clean. Tests pass. WiringPanel renders unchanged in dev server.

---

- U3. **`WireColor` exhaustive switch in `mapWireColor`**

  **Goal:** Narrow `mapWireColor`'s parameter from `string | undefined` to the schema's `wire_color` enum (which is an optional enum on connections). Replace the `default` branch with an exhaustiveness check.

  **Requirements:** R3, R7

  **Dependencies:** None.

  **Files:**
  - Modify: `app/src/data/adapter.ts:91-110` — narrow parameter type, replace `default` with exhaustive match + `const _: never = color;`.

  **Approach:**
  - Type: extract the schema's wire_color enum type (`type WireColorIn = NonNullable<VolteuxProjectDocument["connections"][number]["wire_color"]>`). Or use Zod's inferred type directly.
  - The function becomes `function mapWireColor(color: WireColorIn | undefined): WireColor`. The `undefined` case stays (some connections don't specify a color); only the schema-listed values appear in the explicit branches.
  - Replace `default: return "blue"` with an explicit handling of `undefined` first (`if (color === undefined) return "blue";`), then a switch on the now-narrowed `color` value, and `const _: never = color;` after the switch as the exhaustiveness guard.
  - Behavior unchanged: same WireColor values returned for the same inputs.

  **Test scenarios:**
  - Test expectation: existing tests cover regression — adapter is exercised by ResultView snapshot.
  - Verify: if the schema's wire_color enum gains a new value, the build will fail at the never-check until the new branch is added.

  **Verification:** tsc clean (the `_: never` line proves exhaustiveness at compile time).

---

- U4. **`Part.sku` carries raw SKU**

  **Goal:** `Part.sku` becomes the raw SKU (e.g., `"239"`). PartsPanel renders the `"SKU "` prefix at the display layer. HeroScene drops the `skuKey()` helper and the literal `"SKU 239"` comparison.

  **Requirements:** R4, R7

  **Dependencies:** None.

  **Files:**
  - Modify: `app/src/data/adapter.ts:254` — change `sku: \`SKU ${entry.sku}\`` to `sku: entry.sku`.
  - Modify: `app/src/panels/PartsPanel.tsx:47` — change `{p.sku}` to `{`SKU ${p.sku}`}`.
  - Modify: `app/src/panels/HeroScene.tsx` — remove the `skuKey()` helper (lines ~69-78); update the loop to use `part.sku` directly for table lookups; change `part.sku === "SKU 239"` to `part.sku === "239"`.

  **Approach:**
  - Adapter change is one line.
  - PartsPanel change is one line (template literal).
  - HeroScene: drop the helper, simplify the lookup site (`POSITIONS_BY_SKU[part.sku] ?? POSITIONS_BY_ICON[part.icon] ?? [0, 0.2, 0]`).
  - Update the explanatory comment that referenced the prefix-strip rationale.

  **Test scenarios:**
  - Test expectation: existing snapshot tests cover regression. The rendered DOM in PartsPanel should be identical (same visible text). ResultView snapshot may diff in zero ways (display text unchanged) or in one way if Part.sku appears anywhere unprefixed (it doesn't, per the grep audit).
  - Manual: Adafruit cart URL still composes correctly (it reads from `doc.components[].sku`, not `Part.sku`, so it's unaffected — confirmed in the existing [adafruitCart.ts](app/src/lib/adafruitCart.ts) implementation).

  **Verification:** tsc clean. Tests pass (snapshot may need update — accept new baseline if so).

---

- U5. **Drop `window.__volteux_focusInput` global**

  **Goal:** Replace the global function assignment with a `useImperativeHandle` ref forwarded from App. Same UX (header CTA scrolls to + focuses the prompt input on landing).

  **Requirements:** R5, R7

  **Dependencies:** None.

  **Files:**
  - Modify: `app/src/views/LandingView.tsx` — convert to `forwardRef`, expose `{ focusInput: () => void }` via `useImperativeHandle`. Remove the `window.__volteux_focusInput` assignment effect.
  - Modify: `app/src/App.tsx` — create `landingRef = useRef<LandingHandle | null>(null)`; pass `ref={landingRef}` to `<LandingView>`; change `onScrollToInput` prop to `() => landingRef.current?.focusInput()`.
  - Modify: `app/src/types.ts` (optional) — export `LandingHandle = { focusInput: () => void }` interface. Or define inline in LandingView.tsx.

  **Approach:**
  - `LandingView` becomes `forwardRef<LandingHandle, LandingViewProps>(...)`.
  - Inside, `useImperativeHandle(ref, () => ({ focusInput: () => { scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" }); window.setTimeout(() => inputRef.current?.focus(), 400); } }), [])`.
  - App's `onScrollToInput` callback no longer needs `(window as Window & { __volteux_focusInput?: ... }).__volteux_focusInput?.()`.
  - The deps array on `useImperativeHandle` is `[]` because the closure only captures stable refs.

  **Test scenarios:**
  - Test expectation: existing LandingView snapshot covers regression (the ref is internal — no DOM diff).
  - Manual: scroll the landing page so the CTA appears in the header; click it; should scroll to top + focus the input box. Same behavior as before.

  **Verification:** tsc clean. Tests pass. Manual focus + scroll-back works.

---

- U6. **Dead-code cleanup**

  **Goal:** Remove `Project.match`, `Project.prompt`, `Project.code`, `CodeLine`/`CodeSegment`/`CodeSegmentKind` types, the `tokenizeSketch` helper + its `CPP_KEYWORDS`/`CPP_FUNCTIONS`/`classifyToken` support, the `p.code` mutations in `applyRefinement`, and the unreachable `automatic-gate` branch.

  **Requirements:** R6, R7

  **Dependencies:** None (independent of U1-U5; can run last).

  **Files:**
  - Modify: `app/src/types.ts` — drop `CodeSegmentKind`, `CodeSegment`, `CodeLine`, `Project.match`, `Project.code`, `Project.prompt`.
  - Modify: `app/src/data/adapter.ts` — drop `tokenizeSketch`, `CPP_KEYWORDS`, `CPP_FUNCTIONS`, `classifyToken`, the `code: tokenize...` line in the returned Project, the `match: []` line, and any `prompt` propagation.
  - Modify: `app/src/data/projects.ts` — drop the two `p.code = p.code.map(...)` blocks (in the "really close" branch and the "stay open longer" branch); drop the entire "automatic-gate" branch.
  - Modify: `app/src/App.tsx` — remove `prompt: exampleText` from `setProject({ ...proj, prompt: exampleText })` and `prompt` from `setProject({ ...proj, prompt })` in `finishLoading()`. App's own `prompt` state ([App.tsx:34](app/src/App.tsx)) is what Header reads; Project doesn't need to carry it.

  **Approach:**
  - Mechanical removals. After removing the imports and types, run tsc to find any lingering references and fix them.
  - The "really close" `applyRefinement` branch keeps its `sketchSource` mutation and the `document.sketch.main_ino` mutation; only the `p.code` mutation goes away.
  - The "stay open longer" branch is entirely removable since it's gated on `project.key === "automatic-gate"` which never matches (no archetype produces that key).

  **Test scenarios:**
  - Test expectation: existing tests cover regression. The removed fields aren't read by any consumer; their absence shouldn't affect rendering.
  - Snapshot impact: zero diff expected. If a snapshot includes `prompt` or `match` somewhere in serialized state, accept the new baseline.

  **Verification:** tsc clean. All 15 tests pass. Dev server: chat refinement still works (the "really close" and "wave N times" and "add a beep" branches still produce visible changes in Monaco + the wiring panel).

---

## Execution Sequencing

All 6 units are independent (no inter-unit file overlap). Single-agent serial execution is the right call — parallel build agents would have to spin up 6 contexts for ~150 lines of mostly mechanical edits. The orchestrator does each unit inline, runs tsc + tests after each, commits, moves on.

```
U1 → tsc → commit
U2 → tsc → commit
U3 → tsc → commit
U4 → tsc → tests → commit (Part.sku snapshot may shift)
U5 → tsc → commit
U6 → tsc → tests → commit
final tsc + tests
```

---

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| `Project.document` required-flip surfaces optional-chaining sites I missed | tsc will catch every `project.document?` site that becomes redundant. Fix as they surface. |
| `Part.sku` snapshot drift in PartsPanel | Snapshot test renders parts; if drift appears, accept the new baseline (rendered text is unchanged, only internal data shape differs). |
| `mapWireColor` exhaustive switch breaks if schema enum changes | That's the point. The build-time `_: never = color;` fail is the desired regression net. |
| `useImperativeHandle` change breaks ref-typing | tsc catches mismatches. The `LandingHandle` type is the contract. |
| Dead-code removal accidentally drops something live | `git grep` audit performed during planning — no live consumers found. tsc + the existing 15-test suite is the safety net. |
| `.code` field removal breaks chat refinement output | The `sketchSource` mutations stay; only the parallel `p.code` mutations go. Monaco renders `sketchSource`. Verify "wave N times" + "really close" + "add a beep" still produce visible changes in the dev server. |

---

## Sources & References

- **Origin:** No upstream brainstorm; planning context comes from PR #4 review (PS-003, kt-003, kt-004, kt-005, kt-007, M-01..M-04) and PR #7 review (kt-001/-002/-003).
- Related plans: [docs/plans/2026-04-26-001-feat-v01-ui-track1-completion-plan.md](docs/plans/2026-04-26-001-feat-v01-ui-track1-completion-plan.md), [docs/plans/2026-04-26-002-feat-v01-ui-quality-pass-plan.md](docs/plans/2026-04-26-002-feat-v01-ui-quality-pass-plan.md).
- Related code: see "Relevant Code" section above.
