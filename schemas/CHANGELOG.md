# Schema CHANGELOG

The JSON contract between Track 2 (Pipeline / Kai) and Track 1 (UI / Talia).
Source of truth: [`document.zod.ts`](./document.zod.ts). Mirror artifact:
[`document.schema.json`](./document.schema.json) (generated via `bun run gen:schema`).

**Discipline (per [CLAUDE.md](../CLAUDE.md) § Schema discipline):** every change
requires both signatures on the commit + a new entry here. No exceptions for
"tiny" fields. A tiny schema change is the silent killer of parallel work.

---

## v0.1 — 2026-04-25

**Signatures:** Kai (Track 2) — Talia signoff PENDING (joint Day 1 session)

### 2026-04-25 — late-day tightenings (within v0.1 lock; review-driven)

Two strict-narrowing changes from the post-Unit-5 review pass. Both are
strict subsets of what the original v0.1 schema permitted — every fixture
that parsed before still parses. No type signature changes for downstream
consumers. **Talia signoff covers these together with the original v0.1
lock at the joint Day 1 session.**

- **`anchor_hole` regex tightened** from `/^[a-j][0-9]{1,2}$/` (allowed
  columns 0–99) to `/^[a-j]([1-9]|[12][0-9]|30)$/` (columns 1–30 only).
  Closes review findings COR-001 + ADV-008. The 830-tie breadboard physically
  has columns 1–30; the previous regex accepted off-grid coordinates that
  the UI renderer would have to silently coerce or render off-canvas.
- **Generated JSON Schema target documented as draft/2019-09.** PLAN.md
  § "v0 JSON schema (draft)" currently declares draft/2020-12, but
  `zod-to-json-schema` (the generator) only emits up to draft/2019-09. The
  structural output is compatible with both drafts (no `unevaluatedProperties`,
  no recursive refs); validators using either draft behave identically. The
  PLAN.md drift is documented as a JOINT-SIGNOFF resolution item — pick one
  draft consistently. (Closes review finding AC-002.)

Initial schema lock for the v0 demo (archetype 1 only — Uno + HC-SR04 + servo).
Ports `docs/PLAN.md` § "v0 JSON schema (draft)" into Zod as the single source
of truth.

### Top-level shape

- `archetype_id` — enum of all 5 v0 archetypes; v0.1 pipeline only emits
  `"uno-ultrasonic-servo"`. The other 4 archetypes are listed so the intent
  classifier can route them to Honest Gap (`scope: "out-of-scope"`) instead of
  misrouting to archetype 1.
- `board` — `{sku, name, type, fqbn}`. v0 board types are fixed at four enum
  values; FQBN is a free-form string validated by the cross-consistency gate.
- `components` — array of `{id, sku, quantity}`. **Runtime-only data** —
  static metadata (name, type, education_blurb, model_url, pin_metadata,
  pin_layout) lives in [`components/registry.ts`](../components/registry.ts).
  The cross-consistency gate verifies every emitted SKU exists in the registry.
- `connections` — array of `{from, to, purpose, wire_color?}`. `purpose` is
  beginner-readable; `wire_color` is one of 7 enum values when present.
- `breadboard_layout.components` — array of `{component_id, anchor_hole,
  rotation}`. `anchor_hole` matches `^[a-j][0-9]{1,2}$` (a-e upper half, f-j
  lower half, columns 1-30). `rotation` is one of `0, 90, 180, 270`.
- `sketch` — `{main_ino, additional_files?, libraries}`. `libraries` may be
  empty (sketches with no `#includes`); per-archetype allowlist enforced by
  the cross-consistency gate, not the schema.
- `external_setup` — `{needs_wifi?, needs_aio_credentials?, captive_portal_ssid?,
  aio_feed_names?, mdns_name?}`. The last three are v1.5 fields — the schema
  permits them but the rule `no-v15-fields-on-archetype-1` flags them as amber
  when emitted alongside `archetype_id === "uno-ultrasonic-servo"`. **Decision:
  allow at schema level; warn at rule level** (closes the v1.5-emit-policy
  question raised in `docs/PLAN.md`).
- `honest_gap` — optional `{scope, missing_capabilities, explanation}`. Set by
  any pipeline surface (intent classifier, schema gate, compile gate, rules,
  cross-consistency) that emits a Honest Gap.

### Strictness

- All objects use Zod `.strict()` — unknown fields fail parse. Forces LLM
  discipline; prevents silent shape drift between tracks.
- Empty-payload defenses: `components`, `connections`, `breadboard_layout.components`
  all require `.min(1)`; `sketch.main_ino` requires non-empty string. Catches
  the LLM degenerate "valid envelope, empty contents" failure mode at the
  cheap schema gate instead of the expensive compile gate.
- `wire_color` is OPTIONAL — connections without an explicit color render as
  the UI's default. Wire-color discipline (e.g., red for VCC, black for GND)
  is enforced by the rules engine, not the schema.

### Schema/registry split (non-negotiable)

Per [CLAUDE.md](../CLAUDE.md) § Schema discipline: static component metadata
lives ONLY in `components/registry.ts`. Anywhere else that names a component
is consuming, never authoritative. The cross-consistency gate verifies every
runtime SKU resolves against the registry.

### Generated artifacts

Running `bun run gen:schema` writes `document.schema.json`. CI verifies the
on-disk JSON Schema matches the Zod source via `bun run verify:schema-current`
(prevents drift from a `document.zod.ts` edit that forgot to regenerate).

---

## Future versions

Reserved for actual changes. **Do not add a version stub before the change
is real.** v0.2-v1.5 will land here as concrete schema evolutions:
- v0.5 — eval harness consumer fields (TBD)
- v1.5 — archetype-2 LittleFS + WiFiManager fields will be required by
  archetypes 2 and 4 (currently optional + warned)
