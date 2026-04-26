/**
 * Shared helper for archetype-1 connection-traversal rules.
 *
 * `resolveEndpoint(doc, endpoint)` collapses the three-step lookup
 * triplet (`doc.components.find` → `lookupBySku` → `entry.pin_metadata.find`)
 * that appeared verbatim across many rule files (M-002 in the
 * /ce:review pass).
 *
 * Migration policy (resolves M-001 from the v0.1-pipeline-io review):
 *   - Connection-traversal rules use `resolveEndpoint` —
 *     voltage-match, sensor-trig-output-pin, sensor-echo-input-pin,
 *     current-budget, and any future rule that walks `connections[]`.
 *   - Pure component-traversal rules (no-floating-pins, etc.) keep their
 *     direct `lookupBySku(c.sku)` call. They have no triplet
 *     boilerplate to collapse — `lookupBySku` already IS the helper —
 *     so wrapping it would add lines, not reduce them.
 *
 * Round-2 M2-001: a `resolveComponent` companion was added in round 1
 * with zero callers (current-budget actually uses `resolveEndpoint`,
 * no-floating-pins doesn't need it). Removed pending a real consumer.
 *
 * Pure function. No side effects. Registry is passed as a parameter so
 * tests can stub a different registry (mirrors the cross-consistency
 * gate's signature). Production callers omit and the canonical registry
 * is used.
 */

import type {
  VolteuxPin,
  VolteuxProjectDocument,
} from "../../schemas/document.zod.ts";
import {
  COMPONENTS,
  type ComponentRegistryEntry,
  type PinMetadata,
} from "../../components/registry.ts";

/** A component instance from the runtime document (`{id, sku, quantity}`). */
export type ComponentInstance = VolteuxProjectDocument["components"][number];

/** Registry shape the helper accepts (mirrors `cross-consistency.ts`). */
export type ComponentRegistry = Readonly<
  Record<string, ComponentRegistryEntry>
>;

/**
 * Resolution of an endpoint:
 *   - `component`: the runtime instance from `doc.components`
 *   - `entry`: the registry entry (static metadata: name, type, pin_metadata)
 *   - `pin`: the pin's metadata, or `undefined` if the pin label is not
 *     declared on the component (this is preserved as a non-null carrier
 *     so callers can distinguish "no such pin" from "no such component")
 */
export interface ResolvedEndpoint {
  component: ComponentInstance;
  entry: ComponentRegistryEntry;
  pin: PinMetadata | undefined;
}

/**
 * Look up an endpoint in the document. Returns `null` if the component is
 * not in `doc.components` or the SKU is not in the registry — both are
 * caught by the cross-consistency gate's checks (b) and (g), so a rule
 * that hits `null` here has been called on an already-malformed document
 * and should silently skip the iteration (the gate is what fails the
 * pipeline, not the rule).
 *
 * Returns `{component, entry, pin: undefined}` when the component + SKU
 * resolve but the pin label is not declared. Rules can choose to skip
 * (they can't reason about an unknown pin) or to surface the gap; cross-
 * consistency check (c) catches this case independently.
 *
 * Endpoint parameter type is `VolteuxPin` (the inferred type of
 * PinSchema in `schemas/document.zod.ts`). Round-2 R2-K-005 dropped a
 * local `Endpoint` alias that no rule file imported by name.
 */
export function resolveEndpoint(
  doc: VolteuxProjectDocument,
  endpoint: VolteuxPin,
  registry: ComponentRegistry = COMPONENTS,
): ResolvedEndpoint | null {
  const component = doc.components.find((c) => c.id === endpoint.component_id);
  if (!component) return null;
  const entry = registry[component.sku];
  if (!entry) return null;
  const pin = entry.pin_metadata.find((p) => p.label === endpoint.pin_label);
  return { component, entry, pin };
}
