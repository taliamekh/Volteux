// ============================================================
// Volteux — fixture loader (U1)
// ============================================================
// Loads the canonical archetype-1 fixture, validates it against the
// VolteuxProjectDocument Zod schema, and returns the parsed document.
// Validation throws on any schema violation — "Zod is law" (CLAUDE.md).
//
// This is the v0 stand-in for what Track 2's pipeline will emit at runtime
// (see docs/PLAN.md weeks 5-7). Until the live pipeline lands, the UI
// consumes from here so it can be developed and demoed independently.

import {
  VolteuxProjectDocumentSchema,
  type VolteuxProjectDocument,
} from "../../../schemas/document.zod";
import fixtureJson from "../../../fixtures/uno-ultrasonic-servo.json";

/**
 * Load the default archetype-1 fixture (Uno + HC-SR04 + SG90 + breadboard +
 * jumper wires). Throws if the JSON file drifts out of schema.
 */
export function loadDefaultFixture(): VolteuxProjectDocument {
  return VolteuxProjectDocumentSchema.parse(fixtureJson);
}
