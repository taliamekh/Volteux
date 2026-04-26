# TODOs

Open work captured during planning. Each item: what, why, when it surfaces, when to pick it up.

---

## Component metadata schema + authoring guide

**What:** A documented spec for `components/registry.ts` entries. Includes the TypeScript type for a Component, an authoring checklist (what `pin_metadata`, `pin_layout`, `model_url`, `education_blurb` need to contain), and an example walkthrough authoring one new component end-to-end.

**Why:** v0 hand-authors 5 components for archetype 1. v1.5 adds 20 more. Without a documented authoring spec, each new component is "copy the closest existing one and tweak" — the canonical source of long-tail bugs (missing pin descriptions, wrong pin_layout, unspecified anchor coordinates, education_blurb tone drift).

**Pros:**
- Catches missing fields at TypeScript compile time
- Author guide is also onboarding for any future contributor
- Forces explicit thinking about what makes a component "complete"

**Cons:**
- ~1 hour of writing
- Slight overhead per new component (vs. ad-hoc copy-tweak)

**Surfaces during:** Week 1-2, while authoring the 5 archetype-1 components. The friction (which fields, what tone for blurbs, how to source pin coordinates) is freshest then.

**Depends on:** `components/registry.ts` shape stabilizing (~end of week 2).

**Pick up:** As soon as the 5th archetype-1 component lands. Capture the authoring lessons from those 5 into a `components/AUTHORING.md` doc. Saves hours per component in v1.5.

---

## Manual editing & AI-assisted wiring (v1.5+)

**What:** A staged path from today's "AI builds it for you, read-only" UI toward a workspace where the user can drag, drop, swap, and rewire components — and where the AI completes/fixes any wiring the user starts. Three stages:

1. **Stage 1 — "Swap part" (target: v1.5).** User clicks a component in the parts list (or 3D scene) and says "use a buzzer instead of a servo." AI regenerates the wiring graph + sketch. No drag-and-drop yet. Cheap to build, big learning value. Validates the "AI re-emits the doc on user intent" pattern that the next stages depend on.

2. **Stage 2 — "Drag in / move / rewire, AI completes" (target: v2).** Real interactive 2D breadboard editor:
   - User can drag components from a library palette into the breadboard. **AI fills in any wiring needed for the dropped component to integrate** (e.g. user drops a buzzer → AI wires VCC, GND, signal pin and updates the sketch to use it).
   - User can drag existing components to new holes. AI re-routes wires to keep electrical intent intact.
   - User can drag wires manually (start at a pin, end at a hole). If the user leaves wiring incomplete or wrong, **AI offers to "complete" or "fix" the wiring** — surfacing what's missing, what's shorted, what's unused, and proposing a corrected wiring graph the user can accept.
   - 3D scene mirrors any 2D edits in real time.
   - Sketch gets a "regenerate to match" button (rather than auto-regenerating on every keystroke — too many LLM calls, too unpredictable).
   - Same gate stack runs on user edits as on AI output (schema, cross-consistency, rules) — including new human-edit-specific rules like "you just shorted 5V to GND, do you want to undo?"

3. **Stage 3 — "Sandbox mode" (target: v2.5).** Toggle that lets advanced users build with the component library and the AI as an *optional* helper rather than the driver. Volteux becomes a teaching CAD tool with AI-on-tap.

**Why:**
- Today, when the AI gets it 90% right but one wire is wrong, the only recovery is re-prompting from scratch. Manual editing turns that into a 5-second drag.
- Shifts product positioning from "AI generator" → "AI tutor + workspace." Stickier, more learning value, much harder for a pure-AI competitor to copy.
- The AI-assisted wiring (stages 2 + 3) is the magic — the user does what they understand, the AI fills the gap. That's the "tutor sitting next to you" feel that nobody else ships.

**Pros:**
- Closes the iteration loop without re-prompting
- Beginners learn by manipulating, not just consuming
- Differentiates from PleaseDontCode, Wokwi, Arduino Cloud — none let you mix AI + manual editing
- Stage 1 is small enough to ship inside the v1.5 window without slipping the archetype-2-5 work

**Cons:**
- Stage 2 is a real engineering project (interactive editor, snap-to-hole, validation, re-routing). Months, not weeks.
- New failure modes: human edits can produce states the AI never would (shorts, floating pins, mid-edit invalid graphs). Need a "draft" sub-state for the document so the gate stack doesn't reject every keystroke.
- Risk of undermining the beginner-first wedge if editing surface is too prominent. Mitigation: editing is an opt-in mode (toggle or "edit this project" button), not the default.

**Surfaces during:** This came up while planning the v0 UI. The need for in-place tweaks (without full re-prompts) was the entry point; manual editing is the natural next step beyond the refine bar.

**Depends on:**
- v0 ships first. Don't bleed any of this into v0 scope.
- A "regenerate from current document state" prompt path exists in the pipeline (Stage 1 needs this). Kai's track owns the LLM endpoint shape.
- Schema gets a `mode: 'ai-generated' | 'user-edited' | 'mixed'` flag so the gate stack can apply the right rule set.

**Pick up:** Stage 1 in the v1.5 planning round (week 14-ish). Re-evaluate Stage 2 timing once Stage 1 ships and we see whether users actually swap parts or just re-prompt.

---

## Generated sketch must include teaching comments (v0)

**What:** The Arduino sketch produced by the LLM for every project must include comments that walk the user through what the code is doing — both at a section level (`// === Trigger the ultrasonic pulse ===`) and at a per-line level for anything non-obvious (`pulseIn(echoPin, HIGH);  // wait for the echo to come back, return how many microseconds it took`). The comments should explain what each segment *does* AND why the prototype needs it (cause → effect, not just code → code).

**Why:**
- The 3D scene teaches what each *part* is. The sketch needs to teach what each *line* is. Without comments, the Monaco viewer is just a wall of unfamiliar C++ for a beginner — they read it, nod, learn nothing.
- Volteux's wedge is "I have never wired a breadboard." That same beginner cannot read a `pinMode(7, OUTPUT);` and know what it means. Inline comments turn the sketch panel into a teaching surface that mirrors the 3D scene, instead of a black box.
- Costs nothing in UI engineering — it's a single addition to Kai's LLM prompt ("write the sketch with thorough beginner-level comments explaining each block and what it makes the prototype do"). The schema doesn't change (the sketch is still a string).
- Comment quality and tone become part of the eval set — meta-harness can iterate on comment clarity over time, same way it iterates on code correctness.

**Pros:**
- Massive learning multiplier for free
- Tightens the wedge — every panel teaches, not just the 3D scene
- Discoverable: comments are visible the moment the sketch panel renders; no extra interaction needed

**Cons:**
- Increases sketch length 2-3×, makes the Monaco panel feel busier
- Comments themselves can be wrong or condescending — needs voice guidance in the prompt and probably a line in the eval set scoring "comments are accurate and beginner-readable"
- Slightly more LLM tokens per generation (negligible cost)

**Surfaces during:** Week 5-7, when Kai is authoring the archetype-1 prompt and the eval set. Catching this then means comment-quality gets baked into the eval scoring axis from day one.

**Depends on:** Kai's prompt for archetype 1. UI side is unaffected — Monaco already renders comments naturally.

**Pick up:** Add to the archetype-1 prompt before the first eval-harness run (week 5). Add a "comment-quality" check to the eval set rubric (could be a 5th axis, or roll into rules-clean).

---

## Real component photos in parts list (v0)

**What:** Replace the emoji/icon placeholders in the parts list with small photographic thumbnails of the actual components. Same images can be reused as textures on the 3D models (the spec already allows this), so the cost is one image-sourcing pass that pays into both panels.

**Why:**
- A beginner who has never bought Arduino parts cannot match an emoji `📡` to "the actual thing in the Adafruit cart I'm about to receive in the mail." They need to recognize the part visually so when the box arrives they know what they're holding.
- The parts list visually anchors the cart — clicking "Buy on Adafruit" is the moment of trust ("am I really buying the right things?"). Real photos make that moment feel concrete instead of abstract.
- Already in the spec recommendation (`docs/PLAN.md` → Iconography & decoration → "small photographic thumbnails — uses the Adafruit photos you've already approved for textures, ties parts list to 3D scene visually"). This TODO is about making sure it actually ships in v0, not punted to v1.5.
- Visual continuity with the 3D scene: the same Adafruit photo that textures the 3D model can be cropped down for the parts list thumbnail. One asset, two surfaces.

**Pros:**
- Zero engineering complexity (an `<img>` tag swap)
- Reinforces the "this is real hardware" framing
- Makes the parts list look professional/finished instead of demo-ish
- Asset reuse across 3D textures and parts list thumbnails

**Cons:**
- Need to source 5 product photos cleanly (background-removed or on a consistent neutral background) for v0 — ~30-60 min of asset prep
- Adafruit images may need re-encoding/optimization to keep the parts panel snappy
- Licensing: Adafruit product photos need attribution check before public deployment (out of scope for the friend demo, but flag for v1.5+)

**Surfaces during:** Week 1-2, while Talia authors the 5 archetype-1 components into `components/registry.ts`. Each component entry already needs a `model_url`; add a `thumbnail_url` field at the same time.

**Depends on:** `components/registry.ts` shape stabilizing. Easiest if the thumbnail field is added the same week as the schema lands so authors fill it on first pass.

**Pick up:** Same time as authoring the 5 v0 components. Source one consistent set of Adafruit product photos, crop to ~200×200, save into `public/components/thumbnails/`, reference from registry. Add a snapshot test that fails if any registry entry is missing a `thumbnail_url`.

---

## Custom complex projects with AI-generated mechanical parts + assembly view (v2+)

**What:** A v2+ direction that expands Volteux from "Arduino starter-kit projects (4 boards × 5 archetypes)" into "any custom maker project the user can describe in plain English." For each project, the AI emits an integrated package:

1. **3D-printable parts as STL files** — bespoke geometry generated by the AI for any structural/mechanical parts the project needs (servo mounts, drone arms, robotic gripper fingers, enclosure halves, etc.). User downloads the STLs and prints them on their own printer or a print service.
2. **Circuit schematic** — electronics-only view (sensors, actuators, MCU, wires, passives). NO 3D-printed parts, NO screws, NO mechanical fasteners. Stays focused on the electrical story.
3. **Full 3D assembly view** — the entire physical project as it exists in real life: electronics + printed parts + screws + bearings + everything. Lives in the hero panel (currently the 3D component view).
4. **Interactive explode/reassemble animation tied to rotation** — the assembly view has a unique gesture: **rotate the model one direction → it gracefully comes apart into all its components in 3D space (exploded view); rotate the other direction → it reassembles back together.** This IS the new wedge for complex projects — it teaches the user how the project goes together visually, in a way no static instructions can.
5. **Bill of materials** — electronics + printed parts (with print times / filament estimates) + standard hardware (M3 screws, M2 inserts, bearings, etc., with hardware-store SKUs).
6. **Code with confidence-aware safeguards** — for complex domains where current LLMs struggle (PID tuning for drone flight controllers, inverse kinematics for arms, sensor fusion), the AI provides **scaffolding + tips + reference resources** instead of full hallucinated code. The honest framing: "This part of your project is too complex for me to write reliably. Here's the structure, here's the math you'll need, here are the libraries that solve it. I'll fill in what I can verify."

**Example projects this enables:** robotic arm with custom 3D-printed segments, fixed-wing or quadcopter drones, animatronic pets, autonomous rovers, hydroponic system controllers, CNC pen plotters, custom prosthetics, line-following robots, segway-style balancers.

**Why:**
- **Massive moat.** No tool today integrates mechanical CAD generation + electronics schematic + code + interactive assembly visualization in a single beginner-readable surface. PleaseDontCode does electronics+code only. Tinkercad does CAD only. Onshape does CAD only. Fusion 360 does CAD only. None of them generate from a plain-English prompt, and none of them visualize assembly the way a beginner needs.
- **Bridges "I have an idea" to "I have a finished physical project"** without the user needing to know FreeCAD, OpenSCAD, KiCad, or any mechanical tool. This is the same wedge as v0 (closing the gap for absolute beginners) — just at 10× the project complexity.
- **The exploded/reassemble animation is the new wedge for complex projects.** It teaches assembly the way a video tutorial teaches it, but on-demand and tied to the user's specific generated project. Think "iFixit teardown video, but generated for your project, in 3D, on a rotation gesture."
- **Confidence-aware code generation prevents hallucinated code in complex domains.** Today's LLMs will happily emit a "PID controller for your drone" that compiles but doesn't actually fly. Volteux's honest framing — "this is too complex for me to write reliably; here's a scaffold" — is more trustworthy than competitors who pretend the code works. Builds long-term reputation as the maker tool that doesn't lie.

**Pros:**
- True end-to-end project generation. No other tool does this.
- Massive TAM expansion: starter-kit beginners → makers → hobbyists → educational makerspaces → STEM curriculum.
- The 3D explode/reassemble animation is genuinely novel UX for makers and could become a defining product moment.
- Confidence safeguards build product trust over time — each "I'm not sure I can do this part reliably" grows the brand as the honest tool.
- The schematic / assembly view split mirrors how engineers already think about projects (electrical schematic vs mechanical assembly), so it scales to more sophisticated users without alienating beginners.

**Cons:**
- **Enormous engineering effort.** STL generation alone is a research project — current AI mech-CAD is bleeding edge. Most viable approach is parametric (AI generates parameters + OpenSCAD or CadQuery code, server renders STL) but still hard.
- New gates needed: printability check (overhangs, bridges, supports), structural soundness check (will this servo mount actually hold the load?), fit-tolerance check (do the printed parts mate correctly with the off-the-shelf parts?). These are physics + manufacturing knowledge that the eval harness has to encode.
- Doubles the eval surface — generated code AND generated mechanical parts both need quantitative scoring on a much larger eval set.
- The explode/reassemble animation requires a real assembly graph in the data model (which parts attach to which, in what order, with what fasteners). This is a new schema dimension that pipeline + UI both have to learn.
- Risks scope creep before v1.5 even ships. **Must not bleed into v0 or v1.5 work.**

**Surfaces during:** Came up while designing the v0 landing page. The "what you'll see" preview cards already imply a structured project deliverable (3D + wiring + sketch + parts) — this TODO is the natural extension when project complexity exceeds starter-kit archetypes.

**Depends on:**
- v0 (Arduino starter kit, archetype 1) ships and is validated with friends.
- v1.5 (archetypes 2-5, full eval+meta-harness, more components) ships and is stable in production.
- A research spike on AI-driven parametric CAD generation succeeds — OR a partnership with an existing mech-CAD-AI service unlocks the capability without building the geometry stack from scratch.
- The schema gets a "mechanical_assembly" branch that the cross-consistency gate validates separately from the electronics graph.

**Pick up:**
1. **Not before the second half of v1.5.** First validate v0 + v1.5 are useful and have real users.
2. Run a 1-2 week research spike on AI mech-CAD generation feasibility (OpenSCAD/CadQuery + LLM, or eval existing services like Spline/Onshape APIs).
3. If feasibility spike succeeds, write a v2 PLAN.md with full scope, archetypes (start with one — probably the robotic arm since it's the highest-impact / most-visual), and a separate v2 eval set.
4. If feasibility spike fails, defer indefinitely and note the blocker (likely "AI parametric CAD isn't reliable enough yet"). Re-evaluate every 6 months.

---

## Long-term hardware breadth: thousands of microcontrollers and parts (v2+)

**What:** A long-term vision shift: expand Volteux from the planned **4 boards × ~25 components** (locked v0+v1.5 scope per `docs/PLAN.md`) to **broad coverage across the maker hardware ecosystem** — eventually thousands of microcontrollers, sensors, actuators, displays, motors, and modules. This includes Arduino-family boards (Uno R3/R4, Nano, Mega, Leonardo, Micro), the entire ESP32 family (S2, S3, C3, C6, H2, P4), Raspberry Pi Pico family, Teensy, Adafruit Feather/QT Py/Trinket lines, STM32 boards, BBC micro:bit, and the long tail of components people actually buy from Adafruit, SparkFun, Pimoroni, Mouser, DigiKey, and AliExpress.

**Why this matters now even though it's a v2+ ask:**
- The current `docs/PLAN.md` has a section called *"Scope as a feature"* that argues 4 boards × 5 archetypes is the product, not a limitation. **That pillar is in tension with this ambition.** Either the pillar evolves ("scope as a feature for v0+v1.5 only — broader scope is the v2+ destination") or it stays ("Volteux is permanently a curated tool"). This TODO surfaces the tension so the team makes the call explicitly instead of drifting.
- The landing page copy needs to set expectations correctly. Saying "AI Arduino starter kit" forever boxes the brand at "Arduino tutor." Saying "the AI for any maker hardware" tells a bigger story but requires us to actually deliver it eventually.
- Hardware breadth changes what the eval set needs to cover, what the component registry has to scale to, and what the LLM prompts need to know about. Decisions made now (registry shape, prompt structure, intent classifier output) lock-in or unlock the path forward.

**Pros:**
- TAM expansion: from "absolute beginner with starter kit" to "the entire maker community." Educational makerspaces, hobbyists, FRC/FIRST teams, hackathon participants.
- Brand becomes "the AI for maker hardware" rather than "the AI Arduino tutor" — much bigger market positioning.
- Aligns with the v2+ "custom complex projects" TODO above (drone, robotic arm, etc.) — those projects need broader hardware than 25 SKUs.
- Future-proofs the data model — if registry + schema are designed right, expansion is additive, not a rewrite.

**Cons:**
- **Direct tension with `PLAN.md`'s "scope as a feature" pillar.** Resolving requires a real conversation, not a unilateral landing-page change. Until resolved, the landing page should soft-frame the future ambition while being honest about today's actual scope.
- Component registry explosion: ~25 hand-authored components is manageable; ~2000 is a different problem. Needs either community contributions, automated import from supplier catalogs, or AI-assisted authoring with human review.
- Eval set explosion: every new board × archetype × component combination is a potential failure mode. Scaling the eval harness to thousands of cases is non-trivial.
- LLM hallucination risk grows with hardware breadth: more boards means more pin maps to confuse, more libraries to misuse, more incompatibilities to miss. The rules engine and Honest Gap framing become MORE critical, not less.
- Risk that broadening scope dilutes the "absolute beginner" wedge — beginners need narrow guidance, not "pick from 47 boards." Need to keep the empty-state and intent classifier opinionated even as the underlying support grows.

**Surfaces during:** Came up while reviewing the v0 landing page. Talia (UI track owner) noted the page reads as "Arduino-only forever" when the actual long-term ambition is much broader. That's the first signal that the plan's "scope as a feature" framing might be undersized for what the product wants to become.

**Depends on:**
- v0 + v1.5 ship and the team learns what works.
- A documented decision in `PLAN.md` (or a `VISION.md` file) that captures whether narrow scope is permanent (v0+v1.5+v2 are all curated) or transitional (v2+ broadens to long-tail hardware).
- Component registry scales beyond hand-authoring — likely needs a "schema for importing from supplier catalogs" + AI-assisted authoring pipeline.
- A community contribution model OR a supplier API integration (Adafruit, SparkFun, Mouser product feeds) that auto-populates registry candidates for human review.

**Pick up:**
1. **Before v1.5 wraps:** add a section to `PLAN.md` (or write a `VISION.md`) that explicitly addresses long-term hardware coverage. State whether the "scope as a feature" pillar applies forever or only to v0+v1.5. This is a strategy call, not a code call — Talia + Kai discuss together.
2. **Once v1.5 is stable:** if the answer is "yes, broaden scope," write a v2 plan for hardware breadth that includes registry scaling, eval harness scaling, and a community/supplier ingestion pipeline.
3. **In parallel with v2 design:** prototype a "long-tail hardware" support pass — pick ONE board outside the planned 4 (e.g. ESP32-S3 or Teensy 4.1) and try to get it through the existing pipeline. Surfaces what breaks, validates whether the architecture supports broadening.

**Note on the landing page:** Until this strategic decision lands, the landing page now reflects the broader ambition softly via the "Today: Arduino Uno · Coming soon: ESP32, Pi Pico, custom maker projects, 3D-printed parts, drones, robotics" scope strip. This is honest framing — sells the future without lying about today.
