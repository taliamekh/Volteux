/**
 * Gate 4 — Cross-consistency gate.
 *
 * Runs 8 deterministic referential-integrity checks on a parsed
 * VolteuxProjectDocument. Each check is a named function so tests can
 * target them individually. The gate signature accepts the registry as a
 * parameter (not a singleton import) so tests can swap a stub registry
 * for checks (e) and (g).
 *
 * The 8 checks are labeled (a)-(h) per origin doc § Definitions:
 *   (a) every components[].id is unique
 *   (b) every connection's component_ids exist in components[]
 *   (c) every connection's pin_label exists in the source component's pin_metadata
 *   (d) every breadboard_layout entry's component_id exists in components[]
 *   (e) every component requiring layout (mcu/sensor/actuator/display/passive)
 *       has a breadboard_layout entry
 *   (f) board.fqbn is the canonical FQBN for board.type
 *   (g) every components[].sku resolves against the registry
 *   (h) sketch's library use is in the per-archetype allowlist
 *       (delegates to runAllowlistChecks)
 *
 * Severity is `red` for any failure — referential integrity violations
 * cannot be safely passed downstream regardless of the failure class.
 */

import type { VolteuxProjectDocument } from "../../schemas/document.zod.ts";
import {
  COMPONENTS,
  TYPES_REQUIRING_LAYOUT,
  type ComponentRegistryEntry,
  type ComponentType,
} from "../../components/registry.ts";
import type { GateResult } from "../types.ts";
import { runAllowlistChecks } from "./library-allowlist.ts";

/**
 * Canonical FQBN per board type. Used by check (f). The schema validates
 * board.type against the enum; this gate validates that board.fqbn matches
 * the canonical string for that type.
 */
const FQBN_BY_TYPE: Readonly<
  Record<VolteuxProjectDocument["board"]["type"], string>
> = {
  uno: "arduino:avr:uno",
  "esp32-wroom": "esp32:esp32:esp32",
  "esp32-c3": "esp32:esp32:esp32c3",
  "pi-pico": "rp2040:rp2040:rpipico",
};

const TYPES_REQUIRING_LAYOUT_SET: ReadonlySet<ComponentType> = new Set(
  TYPES_REQUIRING_LAYOUT,
);

/** Single-check result — used internally by the gate. */
type CheckResult =
  | { ok: true; check: string }
  | { ok: false; check: string; message: string };

/** Registry shape the gate accepts (reads as a Map of SKU -> entry). */
export type ComponentRegistry = Readonly<
  Record<string, ComponentRegistryEntry>
>;

/**
 * The default registry — the production source of truth. Tests may pass
 * a stub registry to drive checks (e) and (g) independently.
 */
export const DEFAULT_REGISTRY: ComponentRegistry = COMPONENTS;

// -----------------------------------------------------------------------------
// Individual checks (a) - (h)
// -----------------------------------------------------------------------------

/** (a) Every `components[].id` is unique. */
export function checkUniqueComponentIds(
  doc: VolteuxProjectDocument,
): CheckResult {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const c of doc.components) {
    if (seen.has(c.id)) dupes.add(c.id);
    seen.add(c.id);
  }
  if (dupes.size > 0) {
    return {
      ok: false,
      check: "a",
      message: `duplicate component id(s): ${[...dupes].join(", ")}`,
    };
  }
  return { ok: true, check: "a" };
}

/**
 * (b) Every `connections[].from.component_id` and
 * `connections[].to.component_id` exists in `components[]`.
 */
export function checkConnectionComponentsExist(
  doc: VolteuxProjectDocument,
): CheckResult {
  const ids = new Set(doc.components.map((c) => c.id));
  const missing = new Set<string>();
  for (const conn of doc.connections) {
    if (!ids.has(conn.from.component_id)) missing.add(conn.from.component_id);
    if (!ids.has(conn.to.component_id)) missing.add(conn.to.component_id);
  }
  if (missing.size > 0) {
    return {
      ok: false,
      check: "b",
      message: `connection references unknown component id(s): ${[...missing].join(", ")}`,
    };
  }
  return { ok: true, check: "b" };
}

/**
 * (c) Every `pin_label` in a connection exists in the source component's
 * `pin_metadata`. Requires registry lookup (component types are in the
 * registry, not the runtime JSON).
 */
export function checkConnectionPinLabelsExist(
  doc: VolteuxProjectDocument,
  registry: ComponentRegistry,
): CheckResult {
  const issues: string[] = [];
  for (const conn of doc.connections) {
    for (const endpoint of [conn.from, conn.to] as const) {
      const component = doc.components.find(
        (c) => c.id === endpoint.component_id,
      );
      if (!component) continue; // (b) catches this
      const entry = registry[component.sku];
      if (!entry) continue; // (g) catches this
      const validLabels = new Set(entry.pin_metadata.map((p) => p.label));
      if (validLabels.size === 0) continue; // wires/breadboard have no pins
      if (!validLabels.has(endpoint.pin_label)) {
        issues.push(
          `connection [${conn.from.component_id}.${conn.from.pin_label} -> ${conn.to.component_id}.${conn.to.pin_label}]: ${endpoint.component_id} (sku ${component.sku}) has no pin "${endpoint.pin_label}"`,
        );
      }
    }
  }
  if (issues.length > 0) {
    return {
      ok: false,
      check: "c",
      message: issues[0] + (issues.length > 1 ? ` (+${issues.length - 1} more)` : ""),
    };
  }
  return { ok: true, check: "c" };
}

/**
 * (d) Every `breadboard_layout.components[].component_id` exists in
 * `components[]`.
 */
export function checkBreadboardLayoutComponentsExist(
  doc: VolteuxProjectDocument,
): CheckResult {
  const ids = new Set(doc.components.map((c) => c.id));
  const missing = new Set<string>();
  for (const layout of doc.breadboard_layout.components) {
    if (!ids.has(layout.component_id)) missing.add(layout.component_id);
  }
  if (missing.size > 0) {
    return {
      ok: false,
      check: "d",
      message: `breadboard_layout references unknown component id(s): ${[...missing].join(", ")}`,
    };
  }
  return { ok: true, check: "d" };
}

/**
 * (e) Every component requiring layout (mcu/sensor/actuator/display/passive)
 * has a corresponding `breadboard_layout.components[]` entry. Wires and
 * breadboards are excluded — wires aren't placed, and the breadboard IS
 * the layout surface.
 */
export function checkAllRequiredComponentsAreLaidOut(
  doc: VolteuxProjectDocument,
  registry: ComponentRegistry,
): CheckResult {
  const laidOut = new Set(
    doc.breadboard_layout.components.map((c) => c.component_id),
  );
  const missing: string[] = [];
  for (const c of doc.components) {
    const entry = registry[c.sku];
    if (!entry) continue; // (g) catches this
    if (!TYPES_REQUIRING_LAYOUT_SET.has(entry.type)) continue;
    if (!laidOut.has(c.id)) {
      missing.push(`${c.id} (${entry.type}: ${entry.name})`);
    }
  }
  if (missing.length > 0) {
    return {
      ok: false,
      check: "e",
      message: `components missing breadboard_layout entries: ${missing.join(", ")}`,
    };
  }
  return { ok: true, check: "e" };
}

/** (f) `board.fqbn` matches the canonical FQBN for `board.type`. */
export function checkBoardFqbn(doc: VolteuxProjectDocument): CheckResult {
  const expected = FQBN_BY_TYPE[doc.board.type];
  if (doc.board.fqbn !== expected) {
    return {
      ok: false,
      check: "f",
      message: `board.fqbn "${doc.board.fqbn}" does not match canonical FQBN "${expected}" for board.type "${doc.board.type}"`,
    };
  }
  return { ok: true, check: "f" };
}

/** (g) Every `components[].sku` resolves against the registry. */
export function checkAllSkusInRegistry(
  doc: VolteuxProjectDocument,
  registry: ComponentRegistry,
): CheckResult {
  const unknown = new Set<string>();
  for (const c of doc.components) {
    if (!registry[c.sku]) unknown.add(`${c.id}=${c.sku}`);
  }
  if (unknown.size > 0) {
    return {
      ok: false,
      check: "g",
      message: `components reference unknown SKU(s): ${[...unknown].join(", ")}`,
    };
  }
  return { ok: true, check: "g" };
}

/**
 * (h) Every library used (libraries[] field + #include parsed from sketch)
 * is in the per-archetype allowlist. Filename allowlist for additional_files
 * keys is also enforced here. Delegates to runAllowlistChecks.
 */
export function checkLibraryAllowlist(
  doc: VolteuxProjectDocument,
): CheckResult {
  const violations = runAllowlistChecks({
    archetype_id: doc.archetype_id,
    main_ino: doc.sketch.main_ino,
    additional_files: doc.sketch.additional_files ?? {},
    libraries: doc.sketch.libraries,
  });
  if (violations.length > 0) {
    const first = violations[0]!;
    const summary =
      first.kind === "filename-allowlist"
        ? `filename "${first.filename}" rejected: ${first.reason}`
        : first.kind === "library-not-in-allowlist"
          ? `library "${first.library}" not in archetype "${doc.archetype_id}" allowlist (source: ${first.source})`
          : `unknown header "${first.header}" in ${first.file}`;
    return {
      ok: false,
      check: "h",
      message:
        summary +
        (violations.length > 1 ? ` (+${violations.length - 1} more)` : ""),
    };
  }
  return { ok: true, check: "h" };
}

// -----------------------------------------------------------------------------
// Gate runner
// -----------------------------------------------------------------------------

/**
 * Run all 8 cross-consistency checks. Registry is passed as a parameter so
 * tests can stub it; production callers omit and the DEFAULT_REGISTRY is
 * used.
 */
export function runCrossConsistencyGate(
  doc: VolteuxProjectDocument,
  registry: ComponentRegistry = DEFAULT_REGISTRY,
): GateResult<void> {
  const results: CheckResult[] = [
    checkUniqueComponentIds(doc),
    checkConnectionComponentsExist(doc),
    checkConnectionPinLabelsExist(doc, registry),
    checkBreadboardLayoutComponentsExist(doc),
    checkAllRequiredComponentsAreLaidOut(doc, registry),
    checkBoardFqbn(doc),
    checkAllSkusInRegistry(doc, registry),
    checkLibraryAllowlist(doc),
  ];

  const failed = results.filter(
    (r): r is { ok: false; check: string; message: string } => !r.ok,
  );

  if (failed.length === 0) {
    return { ok: true, value: undefined };
  }

  return {
    ok: false,
    severity: "red",
    message: `Cross-consistency gate found ${failed.length} violation(s) across ${failed.map((f) => `(${f.check})`).join(", ")}`,
    errors: failed.map((f) => `[check ${f.check}] ${f.message}`),
  };
}
