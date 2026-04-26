# Volteux — Project Handoff / Context Snapshot

**Last updated:** 2026-04-25 (mid-hackathon)
**Purpose:** Self-contained context dump for any new chat / new collaborator. Read this first if you've never touched the project, or if you're continuing in a new chat session.

---

## What is Volteux

AI-powered Arduino starter-kit web tool for absolute beginners. A user types a project description in plain English (e.g. "a robot arm that waves when something gets close"). The AI:

1. Picks the right Arduino-compatible parts
2. Writes the Arduino C++ code (with beginner-readable comments)
3. Lays out the wiring on a 2D breadboard view
4. Renders an interactive 3D component view where each part is clickable to learn what it does
5. Pre-fills an Adafruit cart with the parts to buy
6. Lets the user flash the binary onto a real Uno from the browser via WebUSB / Web Serial

**The wedge:** the 3D click-to-learn component view. No competitor (PleaseDontCode, Wokwi, Tinkercad, Arduino Cloud) ships this. It's the thing that closes the gap for someone who has never wired a breadboard.

**Long-term vision (v2+):** custom complex projects (drones, robotic arms, 3D-printed parts), AI-generated STL files, exploded/reassemble 3D animations, support for thousands of microcontrollers and parts.

---

## Who's working on it

Two-person team, locked tracks (no swapping mid-stream):

| Track | Owner | Surface |
|---|---|---|
| Track 1 — UI / Frontend | **Talia** | React-Three-Fiber 3D scene, 2D breadboard SVG, Monaco code viewer, parts list, WebUSB/Web Serial flash UX, error boundary, URL-hash persistence, UI snapshot tests |
| Track 2 — Pipeline / Backend | **Kai** | LLM prompting (Anthropic structured output), schema gate (Zod), arduino-cli compile gate, rules engine, cross-consistency gate, intent classifier (Haiku 4.5), Honest Gap, eval harness (Wokwi), meta-harness loop, compile API + share service, pipeline CI |

**About Talia (the user):** mechanical engineer learning software. Visual learner. Prefers plain language — define jargon the first time it appears. Owns the UI track and is the decision-maker for everything in it.

---

## Where we are in time

**Pre-hackathon:** ~10-12 weeks of planned parallel work between Talia and Kai. Most of the design + planning happened over weeks. Schema is locked, component registry is authored, fixture exists, pipeline gates are mostly built.

**Right now:** **12-hour MLH hackathon sprint.** We are NOT shipping the full v0 production. We are shipping a **polished interactive demo** that tells the story end-to-end so judges can interact with it.

**MLH Tracks we're going for:**
- General hackathon prizes
- **Best Use of Vultr** (deploy Kai's pipeline backend on a Vultr VPS — fits the architecture, prize is a free InnoView 15.6" portable monitor each)

---

## State of the work as of last commit

### Pipeline (Kai's track) — mostly built

- Schema locked at v0.1 in `schemas/document.zod.ts` (single source of truth) + generated `schemas/document.schema.json` mirror
- `schemas/CHANGELOG.md` v0.1 entry signed off (with two late-day tightenings: anchor_hole regex tightened to columns 1-30 only, JSON Schema target documented as draft/2019-09)
- `components/registry.ts` fully authored for all 5 v0 components (Uno R3, HC-SR04, SG90 servo, breadboard, jumper wires) with full pin metadata, education_blurbs, model URLs
- `fixtures/uno-ultrasonic-servo.json` is the canonical demo project (5 components, 7 wires, 3 breadboard placements, full Arduino sketch with Servo library)
- 4 gates implemented: schema, library allowlist, cross-consistency
- 10 archetype-1 rules (current budget, voltage match, breadboard rail discipline, no floating pins, no v1.5 fields on archetype 1, pin uniqueness, sensor echo input pin, sensor trig output pin, servo PWM pin, sketch references pins, wire color discipline)
- Tests for everything (gates, schema, all rules)
- Project setup: Bun runtime, package.json, tsconfig.json, bunfig.toml
- Detailed plan at `docs/plans/2026-04-25-001-feat-v01-pipeline-archetype-1-plan.md`

**Open in pipeline:** browser-direct flash spike (`avrgirl-arduino` + Web Serial / WebUSB) — Day 1-2 timeboxed, v0 keystone risk.

### UI (Talia's track) — mockup done, code starting

- HTML mockup at `mockups/ui-v1.html` — ~85% done visually, three views (Empty / Loading / Main success state)
- React + Vite starter scaffolded at `../react-router-app/` (outside this repo for now; cleaned of shadcn-ui leftovers earlier in the session)
- Real React app to be built in the hackathon sprint, ported from the mockup

### Design decisions made (the visual identity)

These were locked during the mockup design phase. They override the "28 unresolved decisions" list in `docs/PLAN.md`:

| Decision | Choice |
|---|---|
| Theme | Dark mode only (slate-blue, blue undertones) |
| Background | `#161C2A` (slate midnight) |
| Surfaces | `#1E2536` panels, `#283044` inset |
| Text | `#ECEEF5` cool off-white |
| Accent (primary) | `#A78BFA` electric violet |
| Accent (success) | `#5DD3B5` teal-mint (chosen specifically to harmonize with violet, not clash) |
| Wordmark font | DM Serif Display (the only place serif is used) |
| Display font (headings) | Exo 2 (futuristic-geometric, NOT Space Grotesk) |
| Body font | Inter |
| Mono font | JetBrains Mono (sketch viewer + step numbers) |
| Header height | 64px |
| Right-column splits | 45 / 35 / 20 (wiring / code / parts) |
| 3D camera controls | Orbit + zoom + reset (no pan) |
| Resizable panels | No (keeps dominance hierarchy) |
| Empty-state preview | No teaser 3D scene |
| Pin callout style | Floating tooltip with leader line |
| First-visit hint | Pulse + "click any part to learn" callout |
| 3D scene aesthetic | TBD — stylized PBR vs. real product photo vs. isometric (highest-stakes call still open) |

**Per-element treatments:**
- Wordmark "Volteux." has a metallic silver gradient text effect
- Hero tagline "Build the *thing.*" has metallic silver on "Build the" + metallic violet on "thing."
- Section titles use metallic silver gradient
- CTAs (Build it, Flash to my Uno, sticky header CTA) use a metallic-glossy violet gradient with inset light + ambient glow
- Preview cards have hairline gradient borders (silver-to-violet) that catch light
- White text on violet buttons has text-stroke + text-shadow for contrast

**Removed (do not re-add unless asked):** the moving "shine line" experiment + brushed-metal background texture. Talia disliked the streak; "metallic" direction to be revisited later.

### Landing page architecture (locked in mockup)

Top to bottom:
1. **Hero** — eyebrow pill ("v0 · beta" + "AI builds the hardware project you describe") + big tagline ("Build the *thing.*") + subhead + prompt input + 3 example chips + "or — see a finished project first" link + subtle radial violet glow + two floating glow orbs
2. **Trust strip** — 3 items with teal-mint dots: "Built for absolute beginners · Real code you can trust, fully commented · Flash to your board in one click"
3. **Scope strip** — "TODAY: Arduino Uno · COMING SOON: ESP32, Pi Pico, custom maker projects, 3D-printed parts, drones, robotics" (this is the honest framing of where we are vs. where we're going)
4. **"What you'll see" section** — section title + 4 preview cards (3D component view, Wiring diagram, Arduino sketch, Parts to buy)
5. **"How it works" section** — section title + 3 numbered steps (mono numerals "01"/"02"/"03" in metallic violet)
6. **Footer** — wordmark + credits + 3 links (GitHub, How it works, Adafruit kit)

**Header (always visible):** wordmark "Volteux." (left) + prompt-chip when in main view (middle) + classification chip (right) + sticky "Build it →" CTA that appears when scrolling past the hero input (right, only on landing).

### Main view architecture (locked in mockup)

```
+------------------------------------------------------------------+
|  Volteux.   [prompt as chip — click to change idea]   [Uno · 92%] |  ← header
+------------------------------------------------------------------+
|                                          |  WIRING DIAGRAM       |
|  3D INTERACTIVE COMPONENT VIEW           |  (SVG, hole-addressed) |
|  (hero panel, ~60% width)                +-----------------------+
|  Click hotspots → callout with           |  CODE                 |
|  education_blurb                         |  (Monaco, read-only,  |
|                                          |   commented Arduino)  |
|                                          +-----------------------+
|                                          |  WHAT YOU'LL NEED     |
|                                          |  [OWNED checklist]    |
|                                          |  [Buy on Adafruit →]  |
+------------------------------------------------------------------+
|  TWEAK IT [refine input]                                         |  ← refine bar
+------------------------------------------------------------------+
|  [✓ Compiled]  [✓ Wiring checked]   [Share]  [Flash to my Uno →] |  ← bottom CTA
+------------------------------------------------------------------+
```

---

## Plan changes captured during the mockup design phase

These all live in `TODOS.md` as full entries. Summary:

1. **Manual editing & AI-assisted wiring (v1.5+)** — Three stages: (1) "Swap part" feature, (2) drag-drop wiring editor where AI completes/fixes user's wiring, (3) sandbox mode where AI is optional helper.
2. **Generated sketch teaching comments (v0)** — Kai's prompt change: every Arduino sketch must include thorough beginner-friendly comments at section + per-line level.
3. **Real component photos in parts list (v0)** — replace emoji thumbnails with Adafruit product photos. Same images double as 3D model textures.
4. **Custom complex projects + AI-generated STL + assembly view (v2+)** — biggest TODO. Beyond Arduino starter kits to drones, robotic arms, animatronics. AI generates 3D-printable STL files for custom parts. Schematic view (electronics only) + 3D assembly view (everything) with rotate-to-explode/reassemble animation. Confidence-aware code generation that scaffolds + tips instead of hallucinating complex code.
5. **Long-term hardware breadth: thousands of microcontrollers and parts (v2+)** — explicitly surfaces tension with the current `PLAN.md` "Scope as a feature" pillar. Decision needed before v1.5 wraps: stays narrow forever or broadens.

---

## Hackathon scope (12-hour ship list)

Full checklist at `HACKATHON-CHECKLIST.md` (also in this repo, also as a Google Doc Talia can check off).

**Ships in 12 hours:**
- Landing page (already built in mockup, port to React)
- Empty → Loading → Main view flow (needs interaction wiring)
- 4-panel main view rendering the canonical fixture
- Refine bar (visually only, no real backend in 12hr)
- Parts checklist with "I have it" toggle
- Sticky CTA + see-finished-project link
- Honest Gap card (one example: load cell)
- Fake Flash flow OR real flash if Kai's WebUSB/Web Serial spike works

**Becomes the "what's next" pitch slide:**
- Real LLM pipeline integration (Kai's track may or may not get there in 12hr)
- ESP32, Pi Pico boards (v1.5)
- Custom complex projects: drones, robotic arms, 3D-printed STL (v2+)
- Drag-drop wiring editor (v2+)
- Thousands of supported microcontrollers (v2+)

**Hackathon decisions made:**
- Build path: **port HTML mockup to React/Vite** (matches planned stack, integrates with Kai's pipeline, handoff-friendly)
- Deploy: **frontend on Vercel + backend on Vultr** (Vultr fits the planned VPS architecture for arduino-cli; also goes for the MLH "Best Use of Vultr" prize)
- Real Arduino flash demo: **yes, Talia has hardware**
- Demo prompts: 3 selected (robot arm waves / desk lamp on hand-over / parking sensor beeps)

---

## File locations (single source of truth)

| What | Where |
|---|---|
| This handoff doc | `repo/HANDOFF.md` |
| Hackathon ship checklist | `repo/HACKATHON-CHECKLIST.md` (also as Google Doc — see below) |
| HTML mockup (design reference) | `repo/mockups/ui-v1.html` |
| React app skeleton (to become the real app) | `../react-router-app/` (outside this repo for now) |
| Schema (single source of truth) | `repo/schemas/document.zod.ts` |
| Schema mirror (generated) | `repo/schemas/document.schema.json` |
| Schema CHANGELOG | `repo/schemas/CHANGELOG.md` |
| Component registry | `repo/components/registry.ts` |
| Canonical demo fixture | `repo/fixtures/uno-ultrasonic-servo.json` |
| Pipeline source | `repo/pipeline/` |
| Pipeline plan | `repo/docs/plans/2026-04-25-001-feat-v01-pipeline-archetype-1-plan.md` |
| Track ownership + schema discipline + conventions | `repo/CLAUDE.md` |
| Full design plan | `repo/docs/PLAN.md` |
| Test plan | `repo/docs/TEST-PLAN.md` |
| Backlog of TODOs (5 entries we added) | `repo/TODOS.md` |

**Google Doc checklist (interactive checkboxes):** https://docs.google.com/document/d/1U_VlVDGfaE6Wpa8l-2f_1nu1mvoO6ilQCb7h0ArIXqE/edit

---

## How to continue work in a new chat

If Talia hits her Claude Code usage limit and has to switch to a new chat:

### Step 1 — Paste this briefing into the new chat

```
I'm Talia, working on Volteux (the AI Arduino starter-kit hackathon project).

Read these files in this order to get full context:
1. C:/Users/talia/OneDrive/CODING/Volteux/repo/HANDOFF.md
2. C:/Users/talia/OneDrive/CODING/Volteux/repo/HACKATHON-CHECKLIST.md
3. C:/Users/talia/OneDrive/CODING/Volteux/repo/CLAUDE.md
4. C:/Users/talia/OneDrive/CODING/Volteux/repo/TODOS.md
5. C:/Users/talia/OneDrive/CODING/Volteux/repo/mockups/ui-v1.html

I am the UI/Frontend track owner (mechanical engineer learning software, visual learner, prefer plain language).
Kai owns the pipeline track.

We are mid-12-hour-hackathon. The previous chat was working on: [LAST_ACTION].
The next thing to do is: [NEXT_ACTION].

Background agents in flight: [LIST_TASK_IDS or "none"].

Now tell me where we are and what to do next.
```

### Step 2 — Fill in the bracketed parts

Update `[LAST_ACTION]`, `[NEXT_ACTION]`, and `[LIST_TASK_IDS]` based on what was happening when the chat ended.

### Step 3 — Hand it off

Paste, hit enter. The new Claude reads the docs, gets caught up in 30 seconds, picks up from where you left off.

---

## Running agents tracker (update as you spawn)

**Currently in flight:** none

**Completed this session:** none

(I'll update this section every time an agent is spawned or completes.)

---

## Open decisions for Talia + Kai (joint)

1. **3D scene aesthetic** — stylized PBR / real product photo / isometric line. Locks before any `.glb` model sourcing. Highest-stakes visual call.
2. **Long-term scope question** (from the v2+ TODO) — "Scope as a feature" forever, or transitional? Decide before v1.5 wraps.
3. **Custom complex projects feasibility** — when v0+v1.5 ship, run a 1-2 week spike on AI parametric CAD (OpenSCAD/CadQuery + LLM). Decide if v2 is real.
