/**
 * Shared helpers for archetype-1 rules.
 *
 * Two helpers, two distinct call patterns:
 *
 *   1. `resolveEndpoint(doc, endpoint)` — for CONNECTION-TRAVERSAL rules
 *      that walk `doc.connections[]` and need to dereference each
 *      endpoint to {component, entry, pin}. Collapses the three-step
 *      lookup triplet (find → lookupBySku → find-pin) that appeared
 *      verbatim across many rule files (M-002 in the /ce:review pass).
 *
 *   2. `resolveComponent(doc, component_id)` — for connection-traversal
 *      rules that need only {component, entry} for one side WITHOUT a
 *      pin label (e.g., the "I just need to know if this is the MCU"
 *      check). Same backing logic as `resolveEndpoint` minus the pin
 *      lookup.
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
 * Pure functions. No side effects. Registry is passed as a parameter so
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

/**
 * Endpoint shape used in connections — `{component_id, pin_label}`. Aliased
 * from `VolteuxPin` (derived from PinSchema in `schemas/document.zod.ts`)
 * so a future schema change to the pin shape automatically widens this
 * helper rather than letting the two definitions silently drift.
 */
export type Endpoint = VolteuxPin;

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
 */
export function resolveEndpoint(
  doc: VolteuxProjectDocument,
  endpoint: Endpoint,
  registry: ComponentRegistry = COMPONENTS,
): ResolvedEndpoint | null {
  const resolved = resolveComponent(doc, endpoint.component_id, registry);
  if (!resolved) return null;
  const pin = resolved.entry.pin_metadata.find(
    (p) => p.label === endpoint.pin_label,
  );
  return { ...resolved, pin };
}

/**
 * Resolve a component instance + registry entry by `component_id`.
 * Returns `null` if the component is not in `doc.components` or its SKU
 * is not in the registry — both caught by cross-consistency checks (b)
 * and (g), so a rule that hits `null` is operating on an
 * already-malformed document and should silently skip the iteration.
 *
 * Used by connection-traversal rules that need only {component, entry}
 * without a pin label (e.g., current-budget needs to confirm one side
 * is the MCU before keying off the pin label literally).
 */
export interface ResolvedComponent {
  component: ComponentInstance;
  entry: ComponentRegistryEntry;
}

export function resolveComponent(
  doc: VolteuxProjectDocument,
  componentId: string,
  registry: ComponentRegistry = COMPONENTS,
): ResolvedComponent | null {
  const component = doc.components.find((c) => c.id === componentId);
  if (!component) return null;
  const entry = registry[component.sku];
  if (!entry) return null;
  return { component, entry };
}
