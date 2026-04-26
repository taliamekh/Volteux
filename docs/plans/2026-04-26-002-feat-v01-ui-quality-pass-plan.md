---
title: UI quality pass — error boundary, 3D hotspot fix, async/timer cleanups
type: feat
status: active
date: 2026-04-26
deepened: 2026-04-26
---

# UI quality pass — error boundary, 3D hotspot fix, async/timer cleanups

## Overview

Ship the five P1-P2 follow-ups left over from the `/ce:review` pass on PR #4 (`feat/v01-ui-scaffold`, merged as commit `818e8fb`). All five are bounded, isolated UI fixes that close known gaps in error surfacing, 3D interaction correctness, async cleanup, and browser-history sync. No new product surfaces, no new dependencies.

The work is sequenced into three small implementation units that mostly run in parallel — only one file (`app/src/App.tsx`) is touched twice and those edits are additive at disjoint lines.

---

## Problem Frame

PR #4 landed the Track 1 v0 scaffold with full /ce:review coverage. Reviewers flagged ~15 follow-ups across four severity tiers and the team triaged the must-fix-before-archetype-2 items into three named clusters. This plan executes **Cluster A — UI quality**:

1. **PS-002 (P1, project-standards):** `app/src/main.tsx` mounts `<App />` with no error boundary. Any throw inside `pipelineToProject()` (unknown SKU per [adapter.ts:248](app/src/data/adapter.ts:248) — adapter throws `Error("Unknown SKU: <sku>")`), URL-hash decode that for whatever reason raises before being caught (today `decode()` swallows everything but a future refactor could regress), or any other render-time error blanks the page with no recovery path. CLAUDE.md "no silent failures" requires every error path to either surface through the boundary (with mailto recovery) or through Honest Gap.

2. **Correctness (P2):** `app/src/panels/HeroScene.tsx` `POSITIONS_BY_ICON` is keyed by `IconKind`. Two of v0's five components share `icon='board'` (Arduino Uno SKU 50, breadboard SKU 239 — see [adapter.ts:67-70](app/src/data/adapter.ts:67)). Both `<group>` wrappers render at the same `[-1.6, 0.1, -0.4]` position, so the breadboard's hotspot stacks directly on top of the Uno's. Visually overlapping; click-target intent is lost.

3. **julik (P2), refine-toast leak:** `app/src/App.tsx:153` `refine()` calls `window.setTimeout(() => setRefineToast(null), 2400)` with no handle stored. Rapid refinements pile up multiple timers; an in-flight clear can null out a freshly-set toast prematurely. Pattern already exists in the codebase for the SignInModal auth timer ([SignInModal.tsx:29-37](app/src/components/SignInModal.tsx:29)) — apply it here too.

4. **julik (P2), pointer capture:** `app/src/components/ResizableRow.tsx` `startDrag` attaches `pointermove` / `pointerup` to `window`. If the pointer leaves the window mid-drag (off-screen, OS modal, tab switch) the listeners can stop firing or fire on a different surface. The right primitive is `setPointerCapture` on the divider element + `pointercancel` for OS-initiated cancellation.

5. **julik (P2), hashchange desync:** `app/src/App.tsx` writes the hash with `history.replaceState` ([App.tsx:95](app/src/App.tsx:95)) and reads it once on mount ([App.tsx:64-79](app/src/App.tsx:64)). Browser back/forward navigates to an older hash but the React state stays at the current project — the URL and the rendered project disagree. Need a `hashchange` listener that re-decodes and reconciles, with the same loop-prevention guard the mount restore uses ([App.tsx:52](app/src/App.tsx:52) `restoredFromHashRef`).

Track 2 (pipeline/backend) is owned by Kai and is OUT OF SCOPE. None of these changes touch `pipeline/`, `infra/`, `schemas/`, `components/registry.ts`, root `package.json`, or `bunfig.toml`.

---

## Requirements Trace

- R1. A render-time throw from any descendant of `<App />` renders the standard error-boundary card from `docs/PLAN.md` § "Error boundary (generic)" instead of a blank page. The card includes a one-line description, "Try again" (resets the boundary), and "Tell us what happened" (opens a `mailto:` with prefilled diagnostic info). → U1
- R2. Each of the 5 v0 archetype-1 components occupies a unique XYZ position in the 3D scene. The breadboard's hotspot does not stack on the Uno's. The existing `ResultView` snapshot does not regress (or, if it does, the regression is intentional and the snapshot updates are reviewed). → U2
- R3. `ResizableRow` divider drag survives the pointer leaving the window: pointer capture is acquired on `pointerdown` on the divider element, released on `pointerup` and `pointercancel`. The window-level `pointermove`/`pointerup` listeners are removed. Existing drag math and `min-px` clamping are preserved. → U3
- R4. `refine()` cancels any in-flight toast-clear timer before scheduling the next one. The timer is also cancelled on App unmount so React StrictMode double-mount doesn't leak. → U4
- R5. `hashchange` fires a re-decode of `window.location.hash`. On valid decode, project state reconciles to the new hash; on empty hash, app returns to the landing view via the same code path `goLanding()` uses (no behavior drift between the two routes); on invalid/garbage hash, the current project state is preserved (no silent destruction of in-progress work). The existing `restoredFromHashRef` loop-guard pattern is reused so the re-decode does not echo back into a write. → U5
- R6 (system). `npx tsc --noEmit` passes after every unit. `npm test -- --run` passes (existing 3 snapshot tests + new tests added by U1 and U5). The dev server (`npm run dev`) starts cleanly. The Landing → Loading → Result flow, chat refinements, drag handles, expand mode, sign-in modal, FlashModal, and tweaks panel all keep working. → all units

---

## Scope Boundaries

- **Pipeline/backend code is OUT.** No edits to `pipeline/`, `infra/`, `schemas/document.zod.ts`, `schemas/CHANGELOG.md`, `components/registry.ts`, root `package.json`, or `bunfig.toml`. If a finding requires editing those, flag for joint commit; do not edit.
- **Other reviewer findings are OUT** (Cluster B type/contract hygiene, Cluster C test coverage, Cluster D cross-track items). Each ships in its own PR. This is the smallest possible vertical slice.
- **Real telemetry / Sentry-style sink is OUT.** The error boundary uses `mailto:` per the spec — an in-product feedback widget is v1.5 (per `docs/PLAN.md` "Error boundary (generic)").
- **`.glb` 3D models are OUT.** The hotspot fix re-keys positions but keeps drei-primitive meshes.
- **Dependency upgrades are OUT.** No bumping React, R3F, drei, or vitest.
- **Visual identity rework is OUT.** Slate/violet palette tokens from `app/src/styles.css :root` are reused as-is; no new colors.
- **`useHashChangeRestore` extracted as a reusable hook is OUT.** Inline `useEffect` is fine for one call site; extracting prematurely violates YAGNI.

### Deferred to Follow-Up Work

- Cluster B (type/contract hygiene): localStorage Zod-validate, `Project.document` required, `WireColor` exhaustive switch, `__volteux_focusInput` global removal, dead-code cleanup. → separate PR.
- Cluster C (test coverage): `applyRefinement` unit tests, `urlHash` round-trip + 6 error-path tests, `breadboard-geometry` helpers, `FlashModal` step advance + Esc + backdrop, adapter unknown-SKU + `mapWireColor` parameterized, `LoadingView` fake-timer exhaustion. → separate PR.
- Cluster D (cross-track): buzzer SKU `1536` registration, Adafruit URL comma-encoding manual test. → joint commit with Kai.

---

## Context & Research

### Relevant Code and Patterns

- [app/src/main.tsx:9-13](app/src/main.tsx:9) — current `createRoot(...).render(<StrictMode><App /></StrictMode>)`. Wrap target.
- [app/src/components/SignInModal.tsx:29-37](app/src/components/SignInModal.tsx:29) — exemplar `useRef<number | null>` + cleanup `useEffect` pattern for cancellable `setTimeout`s. Apply the same shape to `App.tsx`'s refine-toast timer (U4) and to the FlashModal-style "no silent failures" cleanup posture.
- [app/src/components/SignInModal.tsx:39-45](app/src/components/SignInModal.tsx:39) — exemplar window-level keydown listener with cleanup. Use the same shape for the `hashchange` listener (U5).
- [app/src/App.tsx:46-52](app/src/App.tsx:46) — existing `restoredFromHashRef` loop-prevention guard. Reuse for the `hashchange` listener; do not invent a parallel mechanism.
- [app/src/App.tsx:64-79](app/src/App.tsx:64) — mount-time hash restore. The `hashchange` handler is the same pattern run on a different trigger; consider whether to factor a shared `restoreFromHash(hash)` helper inside `App.tsx` (small win — reduces duplication; defer if it bloats the diff).
- [app/src/lib/urlHash.ts:64-113](app/src/lib/urlHash.ts:64) — `decode()` returns `null` on any failure; never throws. `hashchange` handler treats `null` as "no-op, leave current state alone."
- [app/src/data/adapter.ts:67-82](app/src/data/adapter.ts:67) `iconForEntry` — both `mcu` (Uno) and `breadboard` map to `icon: "board"`. This is correct for the parts list (both are PCB-like things visually) but breaks position-by-icon in 3D. The fix lives in `HeroScene.tsx`, not the adapter; the adapter mapping is intentional.
- [app/src/panels/HeroScene.tsx:39-47](app/src/panels/HeroScene.tsx:39) `POSITIONS_BY_ICON` — current source of the bug. The 5 v0 SKUs are `"50"` (Uno), `"3942"` (HC-SR04), `"169"` (SG90), `"239"` (breadboard), `"758"` (jumper wires).
- [app/src/panels/HeroScene.tsx:215](app/src/panels/HeroScene.tsx:215) — existing `isBreadboard = part.sku === "SKU 239"` special-case. The adapter prefixes SKUs with `"SKU "` ([adapter.ts:254](app/src/data/adapter.ts:254)), so any new SKU-keyed lookup must strip that prefix or match the prefixed form consistently.
- [app/src/styles.css:6-23](app/src/styles.css:6) — design tokens (`--bg`, `--surface`, `--surface-2`, `--ink`, `--ink-2`, `--ink-3`, `--accent`, `--shadow-md`, `--shadow-lg`, `--radius`, `--radius-lg`). The error boundary card MUST use only these tokens.
- [app/src/components/ResizableRow.tsx:38-69](app/src/components/ResizableRow.tsx:38) — current `startDrag`. Replace window-level event listeners with element-level + `setPointerCapture`. The inner state (weights math, min-weight clamping, body cursor reset) stays.
- [app/src/test-setup.ts](app/src/test-setup.ts) — vitest setup with R3F + Monaco + drei mocks already configured. The error-boundary test does not need new mocks.

### Institutional Learnings

- [docs/solutions/security-issues/sha256-cache-key-canonical-json-serialization-2026-04-26.md](docs/solutions/security-issues/sha256-cache-key-canonical-json-serialization-2026-04-26.md) — canonical-JSON principle. Not directly relevant to this plan but worth re-reading because U5 touches the URL-hash code path that depends on it.
- [docs/solutions/logic-errors/lazy-init-singleton-in-flight-promise-bun-test-isolation-2026-04-26.md](docs/solutions/logic-errors/lazy-init-singleton-in-flight-promise-bun-test-isolation-2026-04-26.md) — bun test isolation around module-level singletons. Vitest in `app/` runs differently (jsdom + per-test setup); this is informational only.
- No prior Track 1 learning exists for React error boundaries, R3F position-keying, or pointer capture. After this PR ships, consider `/ce:compound` to capture the React error-boundary mailto pattern (it's likely to recur for FlashModal and the eventual real Web Serial integration).

### External References

- React docs: error boundaries are still class components only as of React 18 — no hook-based API. Use `componentDidCatch(error, info)` to capture the stack and `getDerivedStateFromError(error)` to trigger the fallback render.
- MDN: `setPointerCapture(pointerId)` ensures all subsequent pointer events for that pointerId route to the capturing element until `releasePointerCapture` or `pointercancel`. `pointercancel` fires when the OS or browser preempts the gesture (e.g., touch turning into a scroll, palm rejection, OS-level modal).
- MDN: `hashchange` fires on user navigation that changes only the fragment, AND on programmatic `location.hash = ...` assignment, but NOT on `history.replaceState` or `history.pushState`. So our existing `replaceState`-based writes do NOT trigger `hashchange`, which means the loop-guard is defensive only — but worth keeping for symmetry with the mount restore.
- MDN: `mailto:` URL allows `?subject=...&body=...`; both must be `encodeURIComponent`-ed. Most mail clients accept `\n` (newline as `%0A`) in the body.

---

## Key Technical Decisions

- **Error boundary is a class component, not a third-party library.** *Rationale:* React 18 still requires a class for `componentDidCatch`. `react-error-boundary` would add a dependency for ~30 LOC of boundary glue; no abstraction win. Keep it inline.
- **Error boundary lives in `app/src/components/ErrorBoundary.tsx` and wraps `<App />` inside the `<StrictMode>` in `main.tsx`.** *Rationale:* The boundary is React-shaped (catches render errors); the `mailto:` recipient is a constant exported from the boundary module so it's grep-able when the team decides on a real address. Wrapping inside StrictMode is correct: StrictMode is a dev-only developer tool; the boundary should still apply to production renders.
- **`mailto:` recipient: configurable constant, default to `feedback@volteux.app`.** *Rationale:* The spec doesn't name a real recipient. Use a placeholder address so the diff doesn't leak Talia's personal email. The team can change the constant before launch. Document this in the PR description as a known follow-up.
- **`mailto:` body content:** failed action class (`error.name` + truncated `error.message` to 200 chars), browser/OS via `navigator.userAgent`, current `window.location.hash` (truncated to 120 chars), and a short stack trace from `componentStack` (first 3 frames). *Rationale:* matches `docs/PLAN.md` § "Error boundary (generic)" requirements. Tighter caps than first instinct because Outlook desktop and Windows `ShellExecute` truncate `mailto:` URLs near 2048 chars, and `encodeURIComponent` roughly doubles raw byte counts for non-ASCII / punctuation. Final encoded URL stays under ~1.4KB even with a long userAgent.
- **3D hotspot keying: by SKU (with prefix stripped), with icon-keyed fallback.** *Rationale:* SKU is unique per component; icon is not. Keep the icon table as a fallback so future archetypes that emit unknown SKUs still get a sensible (if shared) default position rather than crashing. The fallback also keeps the existing test snapshot mostly stable. Strip the `"SKU "` prefix in the lookup so the table reads naturally.
- **`ResizableRow` pointer capture: capture on the divider element, attach all listeners to that same element.** *Rationale:* `setPointerCapture` routes all events for the captured pointerId to the capturing element regardless of where the pointer physically is. Element-level `onPointerMove`/`onPointerUp`/`onPointerCancel` work without needing global listeners. Cursor + user-select reset still happens on `document.body` because the visual cue spans the whole page.
- **Refine-toast timer: stored in `useRef<number | null>(null)`, cleared on every new schedule and on unmount.** *Rationale:* mirrors the SignInModal pattern. `useRef` (not state) because timer ID changes don't need to trigger re-render.
- **`hashchange` listener: inline `useEffect` in `App.tsx`, no extraction to hook.** *Rationale:* one call site. Premature extraction violates YAGNI. If a second `hashchange` consumer ever appears, refactor then.
- **`hashchange` failure handling: empty hash → return to landing via the SAME helper `goLanding()` calls; invalid decode → no-op (preserve current state).** *Rationale:* empty hash is an explicit user navigation away from the project (e.g., back-button to root); preserving state would lie to the user. Invalid decode is likely a corrupted manual edit; nuking in-progress work would be a worse outcome than ignoring the bad URL. This matches the mount-restore behavior (mount also no-ops on invalid hash and stays on landing) but with an asymmetric "go back to landing on empty hash" twist that only makes sense for navigation, not for first-load.
- **`goLanding` body extracted to a `resetToLanding({ clearHash })` helper, called from BOTH the existing logo/new-project click path AND the new hashchange empty-hash path.** *Rationale:* `goLanding` already does five things (`setView("landing")`, `setPrompt("")`, `setProject(null)`, conditional `replaceState` to wipe the hash, `restoredFromHashRef.current = true`). Duplicating the first three in the hashchange handler while skipping the loop-guard flip is a latent re-entrancy bug — currently masked because the project-write effect early-returns on null `project?.document`, but fragile under any future refactor of that effect. One helper, two call sites: the user-click path passes `clearHash: true`; the hashchange path passes `clearHash: false` (the browser already did it).
- **No `popstate` listener — `hashchange` is sufficient.** *Rationale:* `hashchange` fires for hash-only browser navigation. We don't use `pushState` for non-hash routes (no client router). `popstate` would be redundant and could double-fire on hash navigation in some browsers.
- **Test the error boundary at `app/src/__tests__/ErrorBoundary.test.tsx`.** Test a `hashchange` integration at `app/src/__tests__/App.hashchange.test.tsx`. *Rationale:* boundary is unit-testable (throw a child, assert card); hashchange needs a mounted App so it's an integration test colocated with other App-level tests.

---

## Open Questions

### Resolved During Planning

- *Where does the `mailto:` recipient address come from?* → A `FEEDBACK_EMAIL` constant exported from `ErrorBoundary.tsx`, default `feedback@volteux.app`. Team changes it before public launch.
- *Should the error boundary itself be wrapped by StrictMode, or wrap StrictMode?* → Boundary wraps `<App />`, StrictMode wraps `<ErrorBoundary>`. StrictMode is a dev concern; the boundary should apply in production.
- *Should the hashchange handler also fire on `popstate`?* → No. Hash-only navigation fires `hashchange`; we have no non-hash router. Adding `popstate` would double-fire in some browsers.
- *Should the hashchange handler nuke in-progress project state on invalid hash?* → No. Empty hash → landing (explicit nav away). Invalid hash → preserve current state (likely a corrupt manual edit).
- *Should `restoreFromHash(hash)` be extracted as a shared helper between mount-restore and hashchange-restore?* → REQUIRED. The extraction also covers `goLanding`'s body (factored into `resetToLanding({ clearHash })`) so the hashchange empty-hash branch and the user-click landing branch share one code path. Closes a latent re-entrancy bug where the empty-hash branch would skip the `restoredFromHashRef.current = true` flip.
- *3D hotspot fallback when SKU is unknown — error or default?* → Default to icon-keyed table (current behavior) so future archetypes don't crash; this is a fallback, not a silent failure (the unknown-SKU case is already caught by the adapter throwing in U1).
- *Should `pointercancel` reset weights to pre-drag state, or commit the partial drag?* → Commit partial. The drag math has been running on every move; cancelling reverts what the user was looking at on screen, which is jarring. Match the `pointerup` behavior.

### Deferred to Implementation

- *Exact mailto subject line wording* — implementer picks something short like `"Volteux error: <error.name>"`. Subject is mostly cosmetic; body is what matters.
- *Snapshot drift in `ResultView.test.tsx` after U2's hotspot positions change* — `<Html>` is mocked to `<div data-testid="drei-html">` and meshes are mocked to `null` ([test-setup.ts:90-100](app/src/test-setup.ts:90)), so the actual XYZ values don't appear in the snapshot. The snapshot should be stable. If it drifts, accept the new snapshot (the change is intentional).
- *Whether to add a `data-testid` to the error-boundary card for easier query* — implementer's call; testing-library prefers role-based queries (`screen.getByRole("alert")`) but a `data-testid` is fine if no obvious role fits.
- *Cleanup ordering inside the refine-toast effect* — implementer picks whether to use a `useEffect` cleanup or a one-shot `useEffect(() => () => clearTimeout(ref.current), [])`. Both are correct.

---

## Implementation Units

- U1. **Error boundary with mailto recovery**

  **Goal:** Wrap `<App />` in a class-component error boundary that catches render-time throws and renders a recovery card matching `docs/PLAN.md` § "Error boundary (generic)". The card surfaces the error class + message and exposes "Try again" (resets the boundary) and "Tell us what happened" (opens a `mailto:` with prefilled diagnostic body).

  **Requirements:** R1, R6

  **Dependencies:** None.

  **Files:**
  - Create: `app/src/components/ErrorBoundary.tsx` — class component with `getDerivedStateFromError`, `componentDidCatch`, render branch for the recovery card. Exports `FEEDBACK_EMAIL` constant.
  - Modify: `app/src/main.tsx` — wrap `<App />` in `<ErrorBoundary>` inside the `<StrictMode>`.
  - Modify: `app/src/styles.css` — add `.error-card`, `.error-card-title`, `.error-card-msg`, `.error-card-actions`, `.error-card-btn`, `.error-card-btn-primary` rules using existing `--surface-2`, `--ink`, `--ink-2`, `--accent`, `--shadow-lg`, `--radius-lg` tokens. No new colors.
  - Create: `app/src/__tests__/ErrorBoundary.test.tsx` — unit tests covering: caught throw → card renders, "Try again" resets, mailto href contains expected fields.

  **Approach:**
  - Class component shape: `class ErrorBoundary extends React.Component<{children: React.ReactNode}, {error: Error | null, info: React.ErrorInfo | null}>`. Initial state: `{error: null, info: null}`.
  - `static getDerivedStateFromError(error)` returns `{error}`. `componentDidCatch(error, info)` stores `info` and (per CLAUDE.md "no silent failures") `console.error("Volteux error boundary caught:", error, info)` so dev tooling sees the original stack.
  - Render: when `state.error` is `null`, return `children`. Otherwise render the recovery card.
  - Recovery card structure: title "Something didn't work.", a one-line description (the error message, truncated to ~120 chars), and a button row with "Try again" (resets state to `{error: null, info: null}`) and "Tell us what happened" (anchor with `href={mailtoHref}` opening the user's mail client).
  - `mailtoHref` is built by a pure helper inside the same file (`buildMailtoHref(error, info, hash, userAgent)`) that returns `mailto:${FEEDBACK_EMAIL}?subject=...&body=...`. Body fields: error class, error message (truncated to 200 chars), browser/OS (from `navigator.userAgent`), current `window.location.hash` (truncated to 120 chars), first 3 frames of `info.componentStack`. All values `encodeURIComponent`-ed before assembling. Implementer asserts the final encoded URL length is under ~1.4KB in the unit test (Outlook truncates near 2048).
  - Card styling honors `app/src/styles.css :root` tokens only. Layout: centered modal-style overlay similar to `auth-overlay` + `auth-modal` shape, but plain — no logo, no tabs.

  **Patterns to follow:**
  - React class component with explicit `<{children: React.ReactNode}>` props typing; strict-mode safe.
  - CSS class naming convention from existing `app/src/styles.css` (`.error-card-*` mirrors `.auth-modal-*` shape).
  - "No silent failures" (CLAUDE.md) — `console.error` the captured error so dev tooling sees the stack even when the boundary swallows it for the user.

  **Test scenarios:**
  - **Happy path:** A child component that throws on mount → boundary catches → card renders with the error message visible. Assert `getByRole("alert")` (or equivalent) finds the card; `getByText` finds "Something didn't work."
  - **Happy path:** Click "Try again" → state resets → on next render, if the child no longer throws (test rerenders with a passing child), card is replaced by the child. Use `rerender` from `@testing-library/react`.
  - **Error path:** No throw → boundary renders children unchanged (snapshot or assert the child's content visible).
  - **Edge case:** mailto href is well-formed: starts with `mailto:feedback@volteux.app?`, contains `subject=` and `body=` query params, the body contains the error name (`Error`), the truncated message, and at least the literal substring of `navigator.userAgent`. Use `expect(href).toContain(...)`.
  - **Edge case:** Long error message is truncated in the card (assert visible text length ≤ ~120 chars).
  - **Edge case:** Hash longer than 120 chars is truncated in the mailto body (assert the encoded `body=` segment containing `Hash:` does not exceed ~140 chars accounting for the label).
  - **Edge case:** Final encoded mailto URL stays under 1400 chars even when the error message is at the 200-char cap and the hash is at the 120-char cap and userAgent is a typical 150-char Chrome string.
  - **Integration:** The boundary is mounted inside `main.tsx` (covered indirectly by the existing `LandingView` snapshot test continuing to pass — the wrap is transparent for non-throwing children).

  **Verification:**
  - `npx tsc --noEmit` from `app/` passes.
  - `npm test -- --run` passes including the new ErrorBoundary tests.
  - Dev server: artificially inject a throw in a child component (e.g., temporarily edit `LandingView.tsx` to `throw new Error("test")` at top of render); reload → recovery card appears, "Try again" cycles back to throwing, "Tell us what happened" opens the user's mail client with prefilled subject/body. Revert the artificial throw before commit.

---

- U2. **3D hotspot collocation: position by SKU, not icon**

  **Goal:** Re-key `POSITIONS_BY_ICON` (and `HOTSPOT_Y_OFFSET_BY_ICON`) in `HeroScene.tsx` so each component lands at a unique XYZ. The Arduino Uno (`SKU 50`, `icon: board`) and breadboard (`SKU 239`, `icon: board`) currently share `[-1.6, 0.1, -0.4]`, causing the breadboard's hotspot to stack on the Uno's. Fix by introducing `POSITIONS_BY_SKU` keyed by raw SKU (without the `"SKU "` prefix the adapter adds) and falling back to the existing icon-keyed table for unknown SKUs.

  **Requirements:** R2, R6

  **Dependencies:** None (parallel-safe with U1, U3, U4, U5).

  **Files:**
  - Modify: `app/src/panels/HeroScene.tsx` — add `POSITIONS_BY_SKU` and `HOTSPOT_Y_OFFSET_BY_SKU` tables; update the part loop to look up by SKU first, fall through to icon-keyed table on miss; add a small helper to strip the `"SKU "` prefix from `part.sku`.
  - Update snapshot if needed: `app/src/__tests__/__snapshots__/ResultView.test.tsx.snap` — the meshes and `<Html>` are mocked to nulls and `<div data-testid="drei-html">` respectively, so position values don't appear in the snapshot. If the snapshot does drift, accept the new baseline (the change is intentional and the bug fix is documented in the plan + commit).

  **Approach:**
  - New helper at module scope: `function skuKey(prefixed: string): string { return prefixed.startsWith("SKU ") ? prefixed.slice(4) : prefixed; }`. Pure.
  - New tables (added; old tables stay for fallback):
    ```
    POSITIONS_BY_SKU: Readonly<Record<string, [number, number, number]>>
      "50":   [-1.6, 0.1, -0.4]    // Uno (off to the left, off-board)
      "3942": [-0.6, 0.3, 0.5]     // HC-SR04 sensor on breadboard
      "169":  [1.4, 0.32, 0.2]     // SG90 servo on the right
      "239":  [0.2, 0.075, 0.0]    // breadboard centered (matches BreadboardSlab pos)
      "758":  [0.2, 0.05, 0.6]     // jumper wires laid flat on breadboard
    HOTSPOT_Y_OFFSET_BY_SKU: same shape, sensible offsets above each mesh
    ```
    Exact values are implementer's call; the constraint is no two SKUs collide.
  - In the parts loop:
    ```
    const sku = skuKey(part.sku);
    const pos = POSITIONS_BY_SKU[sku] ?? POSITIONS_BY_ICON[part.icon] ?? [0, 0.2, 0];
    const hotspotY = HOTSPOT_Y_OFFSET_BY_SKU[sku] ?? HOTSPOT_Y_OFFSET_BY_ICON[part.icon] ?? 0.5;
    ```
  - The `isBreadboard` special-case ([HeroScene.tsx:215](app/src/panels/HeroScene.tsx:215)) stays — its purpose is to skip the per-part mesh render (since `<BreadboardSlab>` handles it), distinct from positioning. With the SKU-keyed table, the breadboard's `<Html>` hotspot now floats above its actual position (where `<BreadboardSlab>` is), not on top of the Uno.
  - Add a one-line code comment at the lookup site explaining the prefix-strip is intentional and that fallback to icon-keyed table is acceptable (the adapter throws on unknown SKUs at the parts-list boundary, so a SKU that reaches `HeroScene` but is missing from `POSITIONS_BY_SKU` is a registered but uncatalogued component, not a system error).
  - Update the existing comment at [HeroScene.tsx:7-8](app/src/panels/HeroScene.tsx:7) ("see plan U3 § Key Technical Decisions") to point at the prior PR #4 plan ([docs/plans/2026-04-26-001-feat-v01-ui-track1-completion-plan.md](docs/plans/2026-04-26-001-feat-v01-ui-track1-completion-plan.md)) rather than this plan's U3 (which is unrelated). Drop the cross-reference if simpler.
  - **Out of scope but noted:** the `Part.sku` shape — a display-formatted string `"SKU 239"` instead of a structured `{display, id}` — makes typed lookups by raw SKU footgun-prone. TypeScript can't catch a forgotten prefix-strip because `part.sku` is just `string`. This is a Cluster B / type-hygiene item; deferred. The mitigation in this unit is the localized `skuKey` helper + the explanatory comment.

  **Patterns to follow:**
  - Module-level `Readonly<Record<...>>` constants matching the existing `POSITIONS_BY_ICON` style.
  - No runtime errors on unknown SKU — fallback chain returns a default rather than throwing (the adapter already throws on unknown SKUs at the parts-list boundary).

  **Test scenarios:**
  - **Visual / dev server (manual):** load the result view → 5 hotspots are visible at distinct screen positions. Specifically the Uno hotspot and breadboard hotspot are no longer overlapping; clicking each opens its own callout.
  - **Snapshot:** `npm test -- --run` re-runs `ResultView.test.tsx` — snapshot remains stable (drei meshes are mocked away). If it drifts, accept the new baseline; `<Html>` is rendered as `<div data-testid="drei-html">` so the snapshot wouldn't capture XYZ positions anyway.
  - **Regression check:** the existing 3 snapshot tests continue to pass. No new tests required for U2 because the position values are not user-observable in the snapshot DOM and the integration is best validated visually.

  **Verification:**
  - `npx tsc --noEmit` passes.
  - `npm test -- --run` passes (snapshots stable or accepted).
  - Dev server: 5 hotspots render at 5 distinct XYZ positions; clicking the breadboard hotspot opens the breadboard callout, not the Uno's.

---

- U3. **ResizableRow pointer capture + pointercancel**

  **Goal:** Replace `ResizableRow`'s window-level `pointermove`/`pointerup` listeners with element-level handlers + `setPointerCapture` on the divider. Add `pointercancel` so OS-initiated cancellation (palm rejection, scroll preemption, OS modal) cleanly releases the capture and resets cursor/user-select.

  **Requirements:** R3, R6

  **Dependencies:** None (parallel-safe with U1, U2, U4, U5).

  **Files:**
  - Modify: `app/src/components/ResizableRow.tsx` — refactor `startDrag` to acquire pointer capture and attach listeners via React props on the divider element rather than `window.addEventListener`. Restructure to per-divider closure that holds `startX`, `startWeights`, `total`, `usable`, `minWeight` and uses `onPointerMove`/`onPointerUp`/`onPointerCancel` props.

  **Approach:**
  - Rework `startDrag(idx)` to mutate a `dragStateRef` (a `useRef<DragState | null>(null)`) on `pointerdown`, then attach React-prop event handlers on the divider that read from the ref. State shape: `{ idx, startX, startWeights, total, usable, minWeight, pointerId }`.
  - On `pointerdown`: if `e.button !== 0`, bail; otherwise `e.currentTarget.setPointerCapture(e.pointerId)`, populate `dragStateRef.current`, set `document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none"`.
  - `onPointerMove` (on the divider): if no `dragStateRef.current` or `e.pointerId !== dragStateRef.current.pointerId`, bail. Otherwise compute `dx = e.clientX - state.startX`, recompute the weight redistribution exactly as today, `setWeights(next)`.
  - `onPointerUp` and `onPointerCancel` (both on the divider): if no `dragStateRef.current` or pointerId mismatch, bail. Otherwise `e.currentTarget.releasePointerCapture(e.pointerId)`, clear `dragStateRef.current`, reset `document.body.style.cursor = ""; document.body.style.userSelect = ""`.
  - Remove the `window.addEventListener("pointermove", onMove)` / `window.addEventListener("pointerup", onUp)` calls entirely. The captured pointer routes events to the divider regardless of where the pointer physically is.
  - Cleanup useEffect: on component unmount, if `dragStateRef.current` is non-null, reset `document.body.style.cursor` and `userSelect` so a sudden unmount mid-drag doesn't leave the page in a bad state.

  **Patterns to follow:**
  - React event-prop attachment (no manual `addEventListener` for in-component DOM events).
  - `useRef` for mutable per-drag state (no re-render on each `pointermove`).
  - `setPointerCapture` / `releasePointerCapture` are the canonical primitives; the divider element is `e.currentTarget`.

  **Test scenarios:**
  - **Manual (dev server):** start a drag, move pointer outside the browser window, drag continues; release pointer inside the window — drag ends cleanly and weights reflect final position.
  - **Manual:** start a drag, switch tabs (Cmd+Tab / Alt+Tab) → on return, drag is no longer active (browser cancelled the gesture); cursor and user-select are reset.
  - **Manual:** start a drag, hit Esc or trigger an OS modal mid-drag → `pointercancel` fires → cursor/user-select reset.
  - **Test expectation: no automated test.** Pointer capture + pointercancel are environment-level browser behaviors; jsdom 25 (per [app/package.json](app/package.json) — not 26) ships no-op stubs for `setPointerCapture`/`releasePointerCapture` (calls don't throw but events aren't routed) and never synthesizes `pointercancel` from "pointer left window". Synthesizing these events with `userEvent.pointer({ target })` would silently no-op the move handler because the `pointerId` matching won't work as expected. The behavior is observable in the dev-server walkthrough; the math is unchanged from the working window-level version. **Cluster C deferred-test landmine:** any future automated test for `ResizableRow` will need a pointer-capture polyfill installed in [app/src/test-setup.ts](app/src/test-setup.ts). Document this in the Cluster C plan when authored. If the team needs automated coverage sooner, lift the drag math (weight redistribution + min-weight clamping) to a pure helper that's unit-testable without DOM events.

  **Verification:**
  - `npx tsc --noEmit` passes.
  - `npm test -- --run` passes (no new tests; existing tests don't exercise ResizableRow).
  - Dev server walkthrough (above) shows cleaner drag behavior across the 3 manual scenarios.

---

- U4. **Refine-toast clear-timer cleanup**

  **Goal:** Track the refine-toast clear timer in a `useRef<number | null>(null)` so rapid refinements don't pile up timers and an in-flight clear can't null out a freshly-set toast. Mirror the SignInModal pattern at [SignInModal.tsx:29-37](app/src/components/SignInModal.tsx:29).

  **Requirements:** R4, R6

  **Dependencies:** None (parallel-safe with U1, U2, U3, U5; touches `App.tsx` at lines disjoint from U5).

  **Files:**
  - Modify: `app/src/App.tsx` — add `const refineToastTimerRef = useRef<number | null>(null);` near the other refs. Add a cleanup `useEffect` to clear the timer on unmount. In `refine()`, before scheduling the new clear, call `if (refineToastTimerRef.current !== null) window.clearTimeout(refineToastTimerRef.current);` then assign `refineToastTimerRef.current = window.setTimeout(() => { refineToastTimerRef.current = null; setRefineToast(null); }, 2400);`.

  **Approach:**
  - Place the new ref next to `restoredFromHashRef` ([App.tsx:52](app/src/App.tsx:52)) so all timer/loop refs cluster together.
  - Cleanup `useEffect` runs once on mount, returns a cleanup that clears the ref's timer if non-null. Empty deps array.
  - The `setRefineToast(null)` callback inside the timer also nulls out the ref (`refineToastTimerRef.current = null`) before clearing the toast — so the next refine sees `null` and doesn't double-clear.
  - Match the `setTimeout` body shape of SignInModal's `authTimerRef` ([SignInModal.tsx:55-59](app/src/components/SignInModal.tsx:55)): null the ref first, then run the side effect.

  **Patterns to follow:**
  - SignInModal's auth-timer cleanup pattern.
  - `window.setTimeout` (number return type) over the bare `setTimeout` (NodeJS.Timeout); matches the existing `App.tsx` style at [App.tsx:142](app/src/App.tsx:142) and [App.tsx:153](app/src/App.tsx:153).

  **Test scenarios:**
  - **Test expectation: covered by manual verification.** Rapid refinements is a multi-step UX flow that's easier to verify in the dev server than to set up with fake timers + state assertions. The unit test would essentially re-implement the cleanup it's verifying.
  - **Manual (dev server):** trigger 3 chat refinements in quick succession (faster than 2400ms apart). Toast text shows the latest refinement's message and stays visible for ~2.4s after the LAST refinement, not after the first.

  **Verification:**
  - `npx tsc --noEmit` passes.
  - `npm test -- --run` passes (no new tests; existing tests don't exercise rapid refines).
  - Dev server manual walkthrough (above) shows the toast no longer flickers.

---

- U5. **hashchange listener for browser back/forward sync**

  **Goal:** Add a `hashchange` `useEffect` in `App.tsx` that re-decodes `window.location.hash` and reconciles project state. Reuse the existing `restoredFromHashRef` loop-prevention guard so the resulting `setProject` doesn't re-write the hash that just changed.

  **Requirements:** R5, R6

  **Dependencies:** None (parallel-safe with U1, U2, U3, U4; touches `App.tsx` at lines disjoint from U4).

  **Files:**
  - Modify: `app/src/App.tsx` —
    - Extract `goLanding`'s body into a `resetToLanding({ clearHash }: { clearHash: boolean })` helper (closure over the App's setters + `restoredFromHashRef`).
    - Refactor the existing `goLanding` (line ~156) to call `resetToLanding({ clearHash: true })` — behavior unchanged.
    - Add a new `useEffect` that registers a `hashchange` listener on mount and removes it on unmount. Handler logic:
      - empty hash (`""` or `"#"`) → call `resetToLanding({ clearHash: false })`.
      - non-empty → `await decode(hash)`; on `null` no-op (preserve state); on success, `restoredFromHashRef.current = true; setProject(pipelineToProject(doc)); setView("result");`.
    - **Required refactor (was optional):** extract `restoreFromHash(hash: string): Promise<void>` as a helper inside `App.tsx` so the mount-restore effect ([App.tsx:64-79](app/src/App.tsx:64)) and the new hashchange handler share the success-path code (decode → setProject → setView). The shared helper takes a "should mark as restored" flag so the mount path and hashchange path both flip the loop guard correctly.
  - Create: `app/src/__tests__/App.hashchange.test.tsx` — integration test that mounts `App`, fires a synthetic `hashchange` event, and asserts state transitions.

  **Approach:**
  - New effect, placed right after the existing project-write effect (~`App.tsx:100`):
    ```
    useEffect(() => {
      const onHashChange = async () => {
        const hash = window.location.hash;
        if (!hash || hash === "#") {
          // explicit nav away from any project — return to landing via the
          // same code path goLanding() uses, so the loop guard flip and any
          // future side-effects stay symmetric.
          resetToLanding({ clearHash: false });
          return;
        }
        await restoreFromHash(hash);
      };
      window.addEventListener("hashchange", onHashChange);
      return () => window.removeEventListener("hashchange", onHashChange);
    }, []);
    ```
    Where `resetToLanding` and `restoreFromHash` are the new helpers added in this unit (see Files).
  - The async closure inside the listener is fine; React + the listener don't need to await it — fire and let the resulting `setProject` re-render. No explicit cancellation token needed because `decode()` is fast (~ms) and a stale resolution would just overwrite with the next event's resolution; the worst case is a brief flicker which is acceptable.
  - Loop guard: setting `restoredFromHashRef.current = true` before `setProject` means the project-write effect (which fires after the state update) sees `true`, flips it back to `false`, and skips its own write. The `hashchange` event we just responded to is therefore not echoed. (Note: per MDN, `replaceState` doesn't fire `hashchange` anyway, so this is defensive — but worth keeping for parity with the mount-restore.)
  - Empty hash handling: `window.location.hash` is `""` when the URL has no fragment, and `"#"` when the URL has a bare `#`. Treat both as "go to landing" — explicit user navigation away from any project.

  **Patterns to follow:**
  - SignInModal's keydown `useEffect` ([SignInModal.tsx:39-45](app/src/components/SignInModal.tsx:39)) for window listener attach/cleanup shape.
  - Existing mount-restore effect ([App.tsx:64-79](app/src/App.tsx:64)) for the decode + setProject flow.

  **Test scenarios:**
  - **Happy path:** mount App with empty hash, programmatically set `window.location.hash = "#v1:..."` (a known-good encoded fixture), fire `new HashChangeEvent("hashchange", { oldURL, newURL })`, await microtasks, assert project state reflects the decoded fixture (e.g., `screen.findByText("Waving robot arm")` resolves).
  - **Edge case:** mount with a project loaded (set hash to a fixture before mount, await mount-restore), then dispatch `hashchange` with an empty hash → assert app returns to landing (`screen.findByText("Tell me what you want to build")` or similar landing-marker visible). State assertion: prompt cleared, project null, view = landing.
  - **Edge case:** mount with a project loaded, dispatch `hashchange` with garbage hash (`#v1:not-base64`) → assert project state UNCHANGED (the title still visible).
  - **Loop-prevention:** mount with a project loaded, dispatch `hashchange` with a valid different hash → spy on `window.history.replaceState` (or wrap and assert call count) → assert it's NOT called as a result of the hashchange-induced setProject (the loop guard worked).
  - **Cleanup:** unmount the App → no hashchange listener remains. Verify by spying on `window.removeEventListener` or checking `getEventListeners(window)` if available.

  **Verification:**
  - `npx tsc --noEmit` passes.
  - `npm test -- --run` passes including the new App.hashchange tests.
  - Dev server: build a project (URL hash gets `#v1:...`), refine the project (hash updates), click browser back button → URL goes back to previous hash → project state reconciles to that earlier project. Click forward → reconciles forward.

---

## Execution Sequencing

```
Wave 1 (parallel — disjoint files):
  U1  app/src/components/ErrorBoundary.tsx + main.tsx + styles.css + ErrorBoundary.test.tsx
  U2  app/src/panels/HeroScene.tsx
  U3  app/src/components/ResizableRow.tsx

Wave 2 (single agent, serial — both touch App.tsx):
  U4  App.tsx (refineToastTimerRef + cleanup useEffect)
  U5  App.tsx (resetToLanding + restoreFromHash extraction + hashchange useEffect)
       + App.hashchange.test.tsx
```

**Wave 1** can run as 3 parallel build agents — each touches its own file. Total: ~25 min wall-clock.

**Wave 2 — MANDATORY single-agent serial.** U4 and U5 both edit `App.tsx`. U5 also touches the `goLanding` helper (line ~156) to factor it into `resetToLanding`, which means U5's diff is wider than just "add a useEffect". Spawning two parallel agents would risk a manual merge over the same file and the same cluster of `useRef` / `useEffect` / helper definitions. Single agent does U4 first (additive: new ref near line 52, cleanup useEffect near other useEffects, modify `refine()` at line ~138 to use the timer ref), then U5 (extracts `goLanding` body to `resetToLanding`, adds `restoreFromHash` helper, refactors the mount-restore useEffect to call it, adds the new hashchange useEffect, writes the integration test). Expected line ranges after both units land: ref additions near line 52-55, helper definitions near line 124-160, useEffects near line 60-110, refactored `goLanding` near line 175. Total: ~25 min wall-clock.

**Wave 3 (manual integration smoke):** dev-server walkthrough hitting all 5 fix paths (artificial throw + recovery, 5 hotspots, drag-out-of-window, rapid refines, browser back/forward), plus `npx tsc --noEmit` + `npm test -- --run`. Total: ~10 min.

Total wall-clock: ~60 min.

---

## System-Wide Impact

- **Interaction graph:** ErrorBoundary becomes the new top-of-tree (above `<App />`); any throw in any descendant routes there. The `hashchange` listener participates in the same loop-prevention dance the mount restore already uses (`restoredFromHashRef`). The pointer-capture refactor changes `ResizableRow`'s event surface from window-level to element-level — no other components observe these events, so the change is local.
- **Error propagation:** Adapter throws (unknown SKU) now have a UI surface (the boundary card with mailto recovery). URL-hash decode failures continue to return `null` from `decode()` and are no-ops at the call site. `pointercancel` now triggers cleanup that previously only ran on `pointerup`.
- **State lifecycle risks:** `hashchange` handler must not infinite-loop with the project-write effect — handled by the existing `restoredFromHashRef` guard. Refine-toast cleanup must not fire on stale state — handled by the `useRef` pattern. Pointer-capture must release on `pointercancel` — handled by adding the cancel handler.
- **API surface parity:** None — UI internal only.
- **Integration coverage:** ErrorBoundary unit test + App.hashchange integration test cover the new behavior. Existing 3 snapshot tests cover regression in the unaffected paths (Landing, Loading, Result happy path).
- **Unchanged invariants:** Landing-view layout, header chrome, sign-in modal, tweaks panel, FlashModal, chat panel UX, drag-resize math (only the event surface changes), URL-hash encode format (`v1:` prefix unchanged), URL-hash write semantics (still `replaceState`, still skipped by loop guard), CompressionStream/DecompressionStream usage. None of these change.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| **ErrorBoundary card design clashes with the slate/violet palette** | Restrict to existing `app/src/styles.css :root` tokens; no new colors. Reuse `--surface-2`, `--ink`, `--accent`, `--shadow-lg`, `--radius-lg`. Visual-design pass is a separate work-stream per CLAUDE.md. |
| **`mailto:` body length exceeds Outlook desktop / Windows `ShellExecute` 2048-char ceiling** | Truncate message to 200 chars, hash to 120 chars, componentStack to first 3 frames. After `encodeURIComponent` (which roughly 1.5-3x's content with `%XX`), final encoded URL stays under ~1.4KB even with a 150-char Chrome userAgent. Unit test asserts the cap. |
| **U2's snapshot drift forces a baseline update** | Drei `<Html>` is mocked to `<div data-testid="drei-html">` and meshes are mocked to `null` ([test-setup.ts:90-100](app/src/test-setup.ts:90)) so XYZ values don't appear in the snapshot. If the snapshot does drift, the change is intentional and reviewers see a single `__snapshots__` diff alongside the source change. |
| **`setPointerCapture` not supported in jsdom for tests** | U3 ships without an automated test (per the unit's "Test expectation"). Manual dev-server walkthrough is the verification. The drag math is unchanged from the working version, so risk is bounded to the event-routing surface. |
| **`hashchange` async race: multiple rapid hash changes mid-decode** | `decode()` is fast (single-digit ms in jsdom; <50ms in production for typical hashes) and `setProject` is synchronous. Worst case is a brief flicker as a stale resolution overwrites with the new one, then the next hashchange's resolution overwrites again. Acceptable for v0; if it becomes user-observable, add an AbortController to `decode()` in a follow-up. |
| **U4 + U5 both edit `App.tsx`** | MANDATORY single-agent serial execution (Wave 2). U5 also extracts `goLanding`'s body into `resetToLanding`, widening its diff beyond just adding effects, so two parallel agents would conflict. The Execution Sequencing section names the expected line ranges. |
| **U5 empty-hash branch latently fragile if it diverges from `goLanding()`** | Mandatory `resetToLanding({ clearHash })` extraction in U5: one helper, two call sites (logo/new-project click + hashchange empty-hash). Fixes the missing `restoredFromHashRef.current = true` flip the empty-hash branch would otherwise skip. |
| **`feedback@volteux.app` is a placeholder address** | Documented in the PR description as a known follow-up. Constant is exported (`FEEDBACK_EMAIL`) so a one-line change updates it. Block on this only if the team has a real address ready before merge — otherwise ship the placeholder. |

---

## Documentation / Operational Notes

- After merge, capture a `/ce:compound` learning on the React error-boundary mailto pattern. It will recur for FlashModal's "real Web Serial" flow and any future async-failure surfaces. File under `docs/solutions/best-practices/`.
- The PR description should call out: error boundary added (with `feedback@volteux.app` placeholder address — change before launch); 3D hotspot fix re-keys positions by SKU; ResizableRow now uses pointer capture; refine-toast and hashchange cleanups land. List the 3 follow-up clusters (B, C, D) as deferred.
- No `docs/PLAN.md` or `CLAUDE.md` updates required — the spec already calls for these behaviors; this plan implements them.

---

## Sources & References

- **Origin:** No upstream brainstorm/requirements doc; planning context comes directly from the PR #4 `/ce:review` findings (PS-002, correctness P2, julik P2 ×3) and `docs/PLAN.md` § "Error boundary (generic)".
- Related code: `app/src/main.tsx`, `app/src/App.tsx`, `app/src/components/SignInModal.tsx` (pattern), `app/src/components/ResizableRow.tsx`, `app/src/panels/HeroScene.tsx`, `app/src/lib/urlHash.ts`, `app/src/data/adapter.ts`, `components/registry.ts` (read-only).
- Related plans: [docs/plans/2026-04-26-001-feat-v01-ui-track1-completion-plan.md](docs/plans/2026-04-26-001-feat-v01-ui-track1-completion-plan.md) (the PR #4 plan this builds on).
- External docs: React 18 error boundaries, MDN `setPointerCapture` / `pointercancel`, MDN `hashchange` event, MDN `mailto:` URL scheme.
