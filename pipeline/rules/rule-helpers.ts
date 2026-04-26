/**
 * Shared helpers for archetype-1 rules.
 *
 * Most rules walk `doc.connections[]` and need to dereference each
 * endpoint to its registry entry + pin metadata. The triplet
 *
 *   doc.components.find(c => c.id === endpoint.component_id)
 *     → lookupBySku(component.sku)
 *     → entry.pin_metadata.find(p => p.label === endpoint.pin_label)
 *
 * appeared verbatim across 8+ rule files (M-002 in the /ce:review pass).
 * `resolveEndpoint` collapses it to one pure function so the rule fixes
 * for COR-002 and COR-003 can be expressed as small predicates over the
 * resolved endpoint rather than rewritten lookup boilerplate.
 *
 * Pure function. No side effects. Registry is passed as a parameter so
 * tests can stub a different registry (mirrors the cross-consistency
 * gate's signature). Production callers omit and the canonical registry
 * is used.
 */

import type { VolteuxProjectDocument } from "../../schemas/document.zod.ts";
import {
  COMPONENTS,
  type ComponentRegistryEntry,
  type PinMetadata,
} from "../../components/registry.ts";

/** A component instance from the runtime document (`{id, sku, quantity}`). */
export type ComponentInstance = VolteuxProjectDocument["components"][number];

/** Endpoint shape used in connections — `{component_id, pin_label}`. */
export type Endpoint = { component_id: string; pin_label: string };

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
  const component = doc.components.find((c) => c.id === endpoint.component_id);
  if (!component) return null;
  const entry = registry[component.sku];
  if (!entry) return null;
  const pin = entry.pin_metadata.find((p) => p.label === endpoint.pin_label);
  return { component, entry, pin };
}
