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
