# Frontend coordination handoff — Track 1 (Talia) integration of Track 2's flash + acceptance surfaces

**Date:** 2026-04-26
**From:** Kai (Track 2 / pipeline)
**To:** Talia (Track 1 / UI) + her frontend agent
**Status:** ACTIVE — Track 2 has shipped the surfaces; Track 1 integration outstanding

---

## TL;DR for the frontend agent

Two Track 2 surfaces need wiring into Talia's UI:

1. **Avrgirl flash harness** (Spike Unit 2) — replace the placeholder `setTimeout`-based fake flash in `app/src/components/FlashModal.tsx` with the real browser harness at `app/spike/`. The harness emits `postMessage` events matching the existing 4-step stepper (`connect | compile | upload | verify`) verbatim — your wire-up is mechanical.
2. **(Optional, deferred unless you want it for v0)** acceptance-summary surface — display the latest `bun run acceptance --with-wokwi` aggregate axis line somewhere in the UI footer/header. Defer unless beneficial; the friend-demo doesn't require it.

Land your changes on `feat/v0-flash-frontend-integration`. The joint signoff PR (CLAUDE.md + docs/PLAN.md hedge-language removal) happens AFTER your PR + my hardware test both land.

---

## What Track 2 ships (and where it lives)

### Bun harness (already on main via PR #13)
- `scripts/spike/avrgirl-node.ts` — Bun CLI for hands-on hardware testing. Not consumed by your UI.
- `scripts/spike/spike-types.ts` — exports:
  - `SpikeFailureKind` 6-literal discriminated union: `"port-not-found" | "write-failed" | "verify-mismatch" | "transport" | "compile-api-unreachable" | "aborted"`.
  - `SpikeStepEvent` interface: `{ step: "connect" | "compile" | "upload" | "verify", status: "pending" | "active" | "done" | "failed", detail?: string, reason?: SpikeFailureKind }`.
  - `assertNeverSpikeFailureKind(kind: never): never` — exhaustiveness guard.
  - `SPIKE_EXIT_CODE` — exit-code map (irrelevant for browser; for Node CLI only).
  - `SpikeResult` type: `{ ok: true, port, hex_size, verified } | { ok: false, kind, message, errors? }`.
- `scripts/spike/status-events.ts` — formats `STEP=<id> STATUS=<state> [DETAIL=...] [REASON=...]` for Bun stderr. **Browser harness mirrors this exact format via `console.log`** for parity; you don't need to consume the Bun version.

### Browser harness (Spike Unit 2, on `feat/v0-uno-flash-spike-unit-2`)
- `app/spike/flash.html` — standalone page. Single "Flash my Uno" button. No build step (native ES modules). Listens for `postMessage` from a parent window when embedded; works standalone for direct testing.
- `app/spike/flash.js` — main harness logic. Uses `navigator.serial.requestPort()`. Imports avrgirl via `app/spike/avrgirl-browser.js`.
- `app/spike/avrgirl-browser.js` — adapter that imports `avrgirl-arduino@5.0.1` via CDN ESM URL OR Vite-bundled IIFE (whichever works in browser; documented in the Spike Unit 2 PR).
- `app/spike/README.md` — operator instructions: `python -m http.server 8000` from `app/spike/`; permissions; expected behavior.

### Acceptance harness (already on main via PR #14 + subsequent v0.5 PRs)
- `tests/acceptance/run.ts` — runs `bun run acceptance --with-wokwi` after v0.5 Unit 3 lands. Outputs aggregate axis line + per-prompt JSON. Operator runs locally; results land in `traces/acceptance-<run-id>/`.
- For your optional acceptance-summary surface: parse the JSON output OR a `traces/acceptance-summary.json` file (TBD if you want it; Track 2 can add a `--summary-out <path>` flag to the runner if you commit to consuming it).

---

## What Track 1 must do (your scope)

### REQUIRED — Wire `FlashModal.tsx` to the real flash harness

**Goal:** When the user clicks "Flash to my Uno" on a successful pipeline run, replace the current 4-step placeholder timer with real avrgirl flow against a real Uno over Web Serial.

**Files to modify:**
- `app/src/components/FlashModal.tsx` — replace fake-flash setTimeout with real browser harness invocation.
- `app/src/App.tsx` (or wherever the modal is mounted) — pass the compiled `hex_b64` from the pipeline result to the modal as a prop.
- (Optional) `app/src/lib/spike-bridge.ts` — small adapter module if you prefer to encapsulate the postMessage-or-direct-import dance.

**Two implementation options for the integration boundary:**

#### Option A — iframe + postMessage (simpler, isolated)
```
<iframe src="/spike/flash.html" ref={iframeRef} />
// Send hex_b64:
iframeRef.current.contentWindow.postMessage({ action: "flash", hex_b64 }, window.origin);
// Listen for steps:
window.addEventListener("message", (e) => {
  if (e.data?.type === "step") {
    setStepperState(e.data.step, e.data.status, e.data.detail, e.data.reason);
  }
});
```
**Pro:** isolated; the spike harness's bundling/CDN concerns don't pollute your build.
**Con:** iframe overhead; permission prompts (Web Serial port pick) happen in the iframe context.

#### Option B — direct ES module import (tighter integration)
```ts
import { runBrowserSpike } from "../spike/flash.js"; // or app/src/lib/spike-bridge.ts
const result = await runBrowserSpike(hex_b64, (event: SpikeStepEvent) => {
  setStepperState(event.step, event.status, event.detail, event.reason);
});
```
**Pro:** type-safe; no iframe overhead; permission flows through the main page context.
**Con:** the spike harness's bundle gets pulled into your Vite build; may need Vite plugin tweaks for avrgirl.

**Recommendation:** Try Option B first (cleaner UX). Fall back to Option A if Vite complains about avrgirl's CommonJS or transitive deps.

---

### Integration interface contract (the EXACT shape you consume)

Your component listens for these events (postMessage in Option A; callback in Option B). The shape is identical:

```ts
interface SpikeStepEvent {
  type: "step";   // present in postMessage form; absent in direct-callback form (the function emits raw event)
  step: "connect" | "compile" | "upload" | "verify";
  status: "pending" | "active" | "done" | "failed";
  detail?: string;        // human-readable progress (e.g., "writing 1024/4096 bytes")
  reason?: SpikeFailureKind;  // present only on status="failed"
}
```

The 4 step IDs match `FlashModal.tsx`'s existing stepper steps verbatim (`connect | compile | upload | verify`). You don't rename steps; you don't add steps. If a new step is needed for v0, file an issue against Track 2 first.

**Failure-kind → user-facing copy** (you map; suggested mapping):

| `reason` | User-facing message |
|---|---|
| `port-not-found` | "Plug your Uno into a USB port and try again." |
| `write-failed` | "Couldn't write the program to your Uno. Try unplugging and replugging." |
| `verify-mismatch` | "The Uno didn't store the program correctly. Try again — sometimes the first try doesn't take." |
| `transport` | "Lost connection to your Uno. Plug it back in and click Flash again." |
| `compile-api-unreachable` | (shouldn't surface in the v0 friend demo flow — pipeline's already produced the hex by the time Flash is clickable; if it does fire, treat as a generic error.) |
| `aborted` | "Flashing cancelled." |

These map to your existing `FlashModal.tsx` error states; pick the closest existing affordance.

---

### How to test integration locally

```bash
# Terminal 1: Compile API
git checkout main
git pull
bun install
bun run compile:up &

# Terminal 2: dev server
cd app
bun run dev    # or npm run dev — whichever Vite scripts already exist
# Open http://localhost:5173 (or whatever port Vite picks)

# Type a prompt → see classification + generation → click Flash
# Plug in your Uno via USB
# Watch the FlashModal stepper run real avrgirl through connect → compile → upload → verify

# Optional: run the spike's standalone page to debug the harness in isolation
cd app/spike
python -m http.server 8000
# Open http://localhost:8000/flash.html
```

The first time you click Flash, Chrome will prompt you to grant Web Serial permission and pick a port. Pick the Arduino's port (usually `/dev/cu.usbmodem*` on Mac, `/dev/ttyACM*` on Linux, `COMx` on Windows).

---

### What's NOT in scope for Track 1 (don't touch these)

- **The spike harness's Bun side** — `scripts/spike/*.ts` is Track 2's. If it misbehaves, file an issue.
- **The 4 step IDs** — already match. Renaming would break Track 2's contract.
- **The `SpikeFailureKind` literals** — Track 2 owns. Adding a literal requires a Track 2 PR + your follow-up to handle it.
- **The `compile-api-unreachable` mapping** — that fires only if Talia's pipeline failed BEFORE the user clicked Flash, which means FlashModal shouldn't even open. Defensive UX: treat it as a generic error.
- **avrgirl-arduino's package.json placement** — it's in `devDependencies` until your integration PR. Your PR can promote it to `dependencies` if you import it directly (Option B). If you use the iframe path (Option A), it stays devDep.

---

### OPTIONAL — Acceptance-summary surface

DEFER unless you want it for v0. The friend-demo doesn't require user-facing acceptance scores. If you choose to add it:

- A footer chip showing "v0.1 acceptance: 24/25 schema · 18/19 compile · 25/25 rules · 22/24 behavior" — small, unobtrusive.
- Source: parse `traces/acceptance-<run-id>/aggregate.json` (Track 2 will add `--summary-out <path>` to the runner if you commit to consuming it).
- Or: hardcode a "✓ v0.1 baseline" badge that updates only on PR review.

If you want this, file the request as a Track 2 PR; otherwise skip.

---

## Final integration verification (post-everything)

Once your integration PR + Track 2's remaining PRs all merge, Kai runs the integration verification:

1. `git checkout main && git pull` — sync.
2. `bun install` + `bun run compile:up &` — backend up.
3. `bun run acceptance --with-wokwi` — clears 4-axis gate.
4. `cd app && bun run dev` — frontend up.
5. Type a prompt → see classification + generation + render.
6. Click Flash → plug in real Uno → watch FlashModal step through `connect → compile → upload → verify`.
7. Verify the Uno is running the flashed sketch (LED blinks, servo sweeps).
8. Capture screenshots / logs for the joint signoff PR description.

If all green, Kai opens the joint signoff PR.

---

## Joint signoff PR scope (you and Kai both sign)

Triggered by: hardware test PASS + your integration PR landed + acceptance gate passing.

**Edits CLAUDE.md** (3 sites):
1. The "WebUSB" → "browser-direct flash" hedge language at the top.
2. The `Browser-direct Uno flash` row in the stack table.
3. Open Decisions or Critical Risk references to the spike (mark as resolved).

**Edits docs/PLAN.md** (2 sites):
1. The "2026-04-25 update — flash API for Uno" callout at the top.
2. The "Flash mechanism per board" table row for Uno.

Both your signature and Kai's must appear on the commit (per CLAUDE.md schema-discipline cadence). Suggested commit message:

```
docs(decisions): close v0 browser-direct flash spike — avrgirl-arduino + Web Serial works

Joint signoff: Kai (Track 2) + Talia (Track 1).

Hardware test PASS on Mac Apple Silicon (Kai 2026-MM-DD) + Mac Intel
(Talia 2026-MM-DD). Cross-platform validation on a third platform is
best-effort follow-up.

Removes hedge language from CLAUDE.md (3 sites) and docs/PLAN.md (2 sites).
The library + Web API path is now committed: avrgirl-arduino@5.0.1 +
navigator.serial. STK500v1 transfer + verify pass; servo + blink both
verified end-to-end against a real Uno.

Closes the v0 § Critical Risk: browser-direct Uno flash spike.

Co-authored-by: Talia <talia@…>
```

---

## Questions / escalation paths

- If avrgirl ESM import fails in Vite → escalate to Track 2; we'll spike a Vite plugin OR document the iframe fallback.
- If `SpikeStepEvent` shape doesn't match what your stepper needs → file a Track 2 PR proposing the shape change; we'll discuss before merging.
- If hardware test reveals avrgirl doesn't work → re-plan day per the spike plan's documented fallbacks (forked avrgirl + custom Web Serial transport, hand-rolled STK500v1, library swap).
- If you need acceptance-summary data and want Track 2 to ship the writer → file a Track 2 PR.

---

**Status:** This handoff is the formal coordination artifact. Track 1 picks up; Track 2 stays out of `app/src/components/FlashModal.tsx` until joint signoff.

🤖 Generated by Track 2 (Kai's agent).
