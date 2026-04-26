/**
 * no-v15-fields-on-archetype-1 — fires when the LLM emits any v1.5
 * external_setup field (`captive_portal_ssid`, `aio_feed_names`,
 * `mdns_name`) on an archetype-1 document.
 *
 * Why amber: the schema permits these fields (the schema is locked at
 * v0; v1.5 archetypes will need them). But on archetype 1 (Uno + servo
 * + ultrasonic, no WiFi), they're meaningless and indicate the LLM
 * confused archetypes. Surfacing as a warning lets the demo proceed
 * while making the issue visible in traces; v0.2 may tighten to red
 * after measurement.
 *
 * Closes the v0 unresolved-decision: "schema v1.5 fields emitted in v0:
 * fail or warn?" — this rule is the warn implementation.
 * See schemas/CHANGELOG.md v0.1 entry.
 */

import type {
  VolteuxExternalSetup,
  VolteuxProjectDocument,
} from "../../../schemas/document.zod.ts";
import type { Rule, RuleResult } from "../../types.ts";

const V15_FIELDS: ReadonlyArray<keyof VolteuxExternalSetup> = [
  "captive_portal_ssid",
  "aio_feed_names",
  "mdns_name",
];

export const noV15FieldsOnArchetype1Rule: Rule<VolteuxProjectDocument> = {
  id: "no-v15-fields-on-archetype-1",
  severity: "amber",
  description:
    "Archetype 1 (Uno+servo+HC-SR04, no WiFi) should not include v1.5 external_setup fields",
  check(doc): RuleResult {
    if (doc.archetype_id !== "uno-ultrasonic-servo") return { passed: true };

    const present: string[] = [];
    for (const field of V15_FIELDS) {
      const value = doc.external_setup[field];
      if (value === undefined) continue;
      if (Array.isArray(value) && value.length === 0) continue;
      if (value === "") continue;
      present.push(field);
    }

    if (present.length > 0) {
      return {
        passed: false,
        severity: "amber",
        message: `Archetype 1 has no WiFi or cloud features, but the document includes v1.5 field(s): ${present.join(", ")}. The LLM may have confused archetypes.`,
        context: { v15_fields_present: present },
      };
    }
    return { passed: true };
  },
};
