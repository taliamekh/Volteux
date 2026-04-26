# Volteux

AI-powered Arduino starter kit web tool for absolute beginners. Beginner types a project description in plain English; AI generates an interactive 3D component view (clickable, click-to-learn), a 2D breadboard wiring view, an Arduino C++ sketch, and a pre-filled Adafruit cart. One-click browser-direct flash to a real Uno.

> **2026-04-25 update — flash API language:** "WebUSB" appears throughout this doc and `docs/PLAN.md` by historical convention. Subsequent investigation (see [docs/plans/2026-04-25-001-feat-v01-pipeline-archetype-1-plan.md](./docs/plans/2026-04-25-001-feat-v01-pipeline-archetype-1-plan.md) Unit 2) found that `avrgirl-arduino` is Node-first with alpha-stage **Web Serial** (not WebUSB) browser support. The Day 1-2 spike resolves the actual library + Web API path. Treat "WebUSB" in this doc as "browser-direct flash (likely Web Serial)" until the spike confirms otherwise. Once it does, this doc and `docs/PLAN.md` need a coordinated edit (joint signoff per Schema discipline cadence).

**v0 scope:** archetype 1 only — Uno + HC-SR04 ultrasonic sensor + micro-servo. 5 components in the 3D library. ~10 rules. Full eval harness with Wokwi headless behavior simulation. Meta-harness loop (agentic prompt-improvement). Server-side shareable-link service. Browser-direct flashing only across all boards — no `.hex` download fallback (the underlying Web API is Web Serial / WebUSB / File System Access depending on board). Cross-platform validation on 3+ host platforms. v0 ships ~10-12 weeks.

**Source of truth:** [docs/PLAN.md](./docs/PLAN.md). Read this first if you're new.

**Documented solutions:** [`docs/solutions/`](./docs/solutions/) — learnings from past problems (bugs, best practices, workflow patterns), organized by category with YAML frontmatter (`module`, `tags`, `problem_type`). Relevant when implementing or debugging in documented areas.

## Track ownership

> **2026-04-26 — handoff.** Talia handed Volteux off to Kai (Talia's Claude usage exhausted); Kai is now sole owner of both tracks for the v0 finish. The two-track partition below is preserved for architectural clarity (UI surface vs pipeline surface), not for ownership.

| Track | Owner | Surface |
|---|---|---|
| Track 1 — UI / Frontend | **Kai** (was Talia until 2026-04-26) | React-Three-Fiber 3D scene, 2D breadboard SVG, Monaco sketch viewer, parts list, WebUSB flash UX, error boundary, URL-hash persistence, UI snapshot tests |
| Track 2 — Pipeline / Backend | **Kai** | LLM prompting (Anthropic structured output), schema gate (Zod), arduino-cli compile gate, rules engine, cross-consistency gate, intent classifier (Haiku 4.5), Honest Gap, eval harness (with Wokwi), meta-harness loop, compile API + share service, pipeline CI |

## Schema discipline (non-negotiable)

The JSON contract at `schemas/document.schema.json` is the single integration point between Track 1 and Track 2.

- **Schema changes require both names on the commit** + a new entry in `schemas/CHANGELOG.md`.
- **No exceptions for "tiny" fields.** A tiny schema change is the silent killer of parallel work. The strictness is the whole reason the parallel structure survives.
- **Fixtures keep both sides honest.** Pipeline-side CI must Zod-validate every output. UI-side CI must snapshot-test every fixture against every view. If a fixture changes, both sides bump.
- **Static component metadata is NOT in the runtime JSON.** It lives in `components/registry.ts` (single source of truth). The runtime JSON's `components[]` carries only `{id, sku, quantity}`. The cross-consistency gate verifies every emitted SKU exists in the registry.

## Stack

| Layer | Choice | Reason |
|---|---|---|
| Runtime | Bun | Fast, modern, both teammates have it |
| Frontend | Vite + React + TypeScript | boring, fast HMR |
| 3D | `@react-three/fiber` + `@react-three/drei` | Standard for declarative R3F |
| Editor | Monaco (`@monaco-editor/react`) | read-only sketch viewer |
| Schema | Zod | runtime validation + `z.infer` for TS types |
| LLM | Anthropic SDK | Sonnet for generation, Haiku for classification |
| Compile | `arduino-cli` on a small VPS (Hetzner CX21 / Fly.io shared-cpu-2x, 4GB RAM minimum) | not Cloudflare Workers — they can't host the toolchain |
| Behavior eval | Wokwi headless (`wokwi-cli`) | runs the sketch in simulation, asserts state changes |
| Browser-direct Uno flash | `avrgirl-arduino` (candidate; see flash API note above) | Day 1-2 spike confirms library + Web API or this becomes the v0 blocker |
| Persistence | URL hash (base64+gzip) + localStorage (small) + server-side share service (large) | Stateless v0; sign-in is v1.5 |

## Development cadence

- **Weekly 30-min sync** — Friday EOD. What shipped, what's blocked, anything that needs a schema change.
- **PRs touching `pipeline/prompts/`, `rules/`, `meta/`, or `schemas/` trigger eval CI.** PR fails if any 4-axis score drops below baseline. Other PRs (UI work, fixtures) skip the eval suite.
- **Schema PRs:** both names, plus `schemas/CHANGELOG.md` entry, plus a new fixture demonstrating the change if applicable.
- **Worktree convention:** parallel tracks work in separate git worktrees off `main`. Merge weekly. Conflict surface = `components/registry.ts`; treat that file with extra care.

## v0 success criteria (sequential gates)

1. **Week 4 — track-isolated milestones.** Both tracks ship their half against fixtures. Talia: all four views render `fixtures/uno-ultrasonic-servo.json`, 3D click-to-label works on 5 components, `avrgirl-arduino` flashes a real Uno on at least 3 host platforms (Mac Apple Silicon, Mac Intel, Linux x86, Windows x86, Windows ARM, Linux ARM — pick 3). Kai: prompt → JSON → arduino-cli compile pass on 90%+ of 5 hand-written prompts.
2. **Week 7 — eval harness milestone.** 30-50 archetype-1 cases. CI runs them on every prompt/rule/meta PR. Schema-validity ≥ 99%, compile-pass ≥ 95%, rules-clean ≥ 90%, behavior-correctness (via Wokwi) ≥ 85%.
3. **Week 10 — meta-harness milestone.** 3 completed proposer cycles. ≥1 cycle improved archetype-1 eval scores by ≥2pp on at least one axis without regression. If after 3 cycles no improvement, drop the proposer; keep the eval harness.
4. **Week 10-12 — v0 friend demo.** A friend who has never touched Arduino types a project description, sees JSON flow through both tracks, walks through the 3D component library, opens the Adafruit cart, and (when parts arrive) flashes the binary onto a real Uno.

## Critical risk to track

**The browser-direct Uno flash spike is the v0 go/no-go.** End of week 1, on real hardware, on at least 3 host platforms. The spike resolves both the library (`avrgirl-arduino` candidate, alternatives in plan Unit 2) and the Web API (likely Web Serial, possibly WebUSB). If neither works, this is a real blocker — re-plan that day. There is no `.hex` download fallback in v0.

## Open decisions

See [docs/PLAN.md](./docs/PLAN.md) for the full list. Highest-priority unresolved:

1. **28 visual identity decisions** (typography, accent color, 3D scene aesthetic, etc.) — captured in the `Visual Design — Unresolved Decisions` section of `docs/PLAN.md`. Defer to a dedicated visual design session before week 3.

### Resolved

- **Schema v1.5 fields emitted in v0 → warn (amber).** Layered enforcement: unknown top-level fields fail at the schema gate (`VolteuxProjectDocumentSchema.strict()`); known v1.5 fields on archetype 1 (`captive_portal_ssid`, `aio_feed_names`, `mdns_name`) surface as amber via [`pipeline/rules/archetype-1/no-v15-fields-on-archetype-1.ts`](./pipeline/rules/archetype-1/no-v15-fields-on-archetype-1.ts). Tightening to red is a v0.2-or-later measured decision once acceptance traces show whether the LLM ever emits these on archetype 1 (current measurement: 0/25 tuning prompts). See `schemas/CHANGELOG.md` v0.1 entry.

## Skill routing (gstack)

When a request matches an available skill, invoke it via the Skill tool BEFORE answering directly:

- Product ideas, "is this worth building", brainstorming → `/office-hours`
- Bugs, errors, "why is this broken", 500 errors → `/investigate`
- Ship, deploy, push, create PR → `/ship`
- QA, test the site, find bugs → `/qa`
- Code review, check my diff → `/review`
- Update docs after shipping → `/document-release`
- Weekly retro → `/retro`
- Design system, brand → `/design-consultation`
- Visual audit, design polish → `/design-review`
- Architecture review → `/plan-eng-review`
- Save progress, checkpoint, resume → `/checkpoint`
- Code quality, health check → `/health`

## Coding conventions

- **TypeScript strict mode**, no `any` without comment justification.
- **Zod is law.** Every external boundary (LLM output, compile API, share API, file imports) parses through Zod. Never trust a string.
- **`components/registry.ts` is the only place static component metadata is written.** Anywhere else that names a component is consuming, never authoritative.
- **No silent failures.** Every error path either surfaces through the generic error boundary (with `mailto:` recovery) or through Honest Gap. We don't `console.error` and shrug.
- **No `.hex` download fallback paths.** Browser-direct flash only is committed.
- **One-line PR description rule:** if you can't describe the diff in one sentence, the PR is too big. Split it.

## Out of scope (v0)

- Mobile, dark mode, i18n, print stylesheet
- Archetypes 2-5 (audio dashboard, OLED menu, DHT+AIO, photoresistor LED)
- 20 of 25 components (only the 5 for archetype 1)
- ESP32 + Pi Pico flash paths
- WiFi captive portal templates
- AvantLink affiliate ID integration
- User accounts / project library / sign-in
- Beauty pass on 3D models
- Public deployment / SEO / distribution
