// KAI-DONE: Per-archetype wiring spec table rendered below the schematic
// when the panel is expanded. Reads doc.archetype_id, looks up the spec
// block in COMPONENT_SPECS, and filters spec connections to those that
// match an actual entry in doc.connections.

import { COMPONENT_SPECS, type ConnectionSpec } from "../data/component-specs";
import { lookupBySku } from "../../../components/registry";
import type { VolteuxProjectDocument } from "../../../schemas/document.zod";

interface WiringSpecTableProps {
  doc: VolteuxProjectDocument;
}

const MONO_STYLE = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: "12px",
} as const;

/**
 * Lowercased, whitespace-collapsed name. Used to make component-name
 * matching robust against the registry's verbose names ("Arduino Uno R3",
 * "HC-SR04 Ultrasonic Distance Sensor", "Micro Servo SG90") vs. the
 * spec table's short names ("Uno", "HC-SR04", "SG90 Servo").
 */
function normalizeName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Returns true if `specName` and `registryName` refer to the same
 * component. We tokenize the spec name and check that every non-trivial
 * token appears in the registry name. This catches:
 *   "Uno"        ⊆ "Arduino Uno R3"
 *   "HC-SR04"    ⊆ "HC-SR04 Ultrasonic Distance Sensor"
 *   "SG90 Servo" ⊆ "Micro Servo SG90"
 */
function componentNameMatches(specName: string, registryName: string): boolean {
  const reg = normalizeName(registryName);
  const tokens = normalizeName(specName).split(" ").filter((t) => t.length > 0);
  if (tokens.length === 0) return false;
  return tokens.every((tok) => reg.includes(tok));
}

/**
 * Normalize a pin label so spec-side variants ("D7", "D9 (PWM)") match
 * the schema-side variants ("7", "9"). Strips:
 *   - parenthetical suffix: "D9 (PWM)" → "D9"
 *   - leading "D" before a digit: "D7" → "7"
 *   - trailing digit on GND: "GND2" → "GND" (Uno has both)
 */
function normalizePin(pin: string): string {
  let p = pin.trim().replace(/\s*\([^)]*\)\s*$/, "");
  p = p.toUpperCase();
  if (/^D\d+$/.test(p)) p = p.slice(1);
  if (/^GND\d+$/.test(p)) p = "GND";
  return p;
}

function pinMatches(specPin: string, docPin: string): boolean {
  if (specPin === docPin) return true;
  return normalizePin(specPin) === normalizePin(docPin);
}

/**
 * Check whether a single spec connection corresponds to any connection
 * in `doc.connections`. We allow either direction (spec.from might map
 * to doc.to and vice-versa) because the document's source/destination
 * orientation is editorial, not directional in any electrical sense.
 */
function specConnectionAppearsInDoc(
  spec: ConnectionSpec,
  doc: VolteuxProjectDocument,
): boolean {
  const idToName = new Map<string, string>();
  for (const c of doc.components) {
    const entry = lookupBySku(c.sku);
    if (entry) idToName.set(c.id, entry.name);
  }

  for (const conn of doc.connections) {
    const fromName = idToName.get(conn.from.component_id);
    const toName = idToName.get(conn.to.component_id);
    if (!fromName || !toName) continue;

    const forward =
      componentNameMatches(spec.from, fromName) &&
      componentNameMatches(spec.to, toName) &&
      pinMatches(spec.fromPin, conn.from.pin_label) &&
      pinMatches(spec.toPin, conn.to.pin_label);
    const reverse =
      componentNameMatches(spec.from, toName) &&
      componentNameMatches(spec.to, fromName) &&
      pinMatches(spec.fromPin, conn.to.pin_label) &&
      pinMatches(spec.toPin, conn.from.pin_label);
    if (forward || reverse) return true;
  }
  return false;
}

export default function WiringSpecTable({ doc }: WiringSpecTableProps) {
  const spec = COMPONENT_SPECS[doc.archetype_id];

  if (!spec || spec.connections.length === 0) {
    return (
      <div className="wiring-spec-table-container">
        <div className="wiring-spec-empty">
          Specs not yet documented for this archetype.
        </div>
      </div>
    );
  }

  const matchedConnections = spec.connections.filter((c) =>
    specConnectionAppearsInDoc(c, doc),
  );

  if (matchedConnections.length === 0) {
    return (
      <div className="wiring-spec-table-container">
        <div className="wiring-spec-empty">
          Specs not yet documented for this archetype.
        </div>
      </div>
    );
  }

  return (
    <div className="wiring-spec-table-container">
      <section className="wiring-spec-connections">
        <h4 className="wiring-spec-heading">Connections</h4>
        <table className="wiring-spec-table" style={MONO_STYLE}>
          <thead>
            <tr>
              <th>From</th>
              <th>From Pin</th>
              <th>To</th>
              <th>To Pin</th>
              <th>Voltage</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {matchedConnections.map((c, i) => (
              <tr
                key={`${c.from}-${c.fromPin}-${c.to}-${c.toPin}-${i}`}
                className="wiring-spec-row"
                data-wire-color={c.wireColor}
                style={{ borderLeft: `3px solid ${c.wireColor}` }}
              >
                <td>{c.from}</td>
                <td>{c.fromPin}</td>
                <td>{c.to}</td>
                <td>{c.toPin}</td>
                <td>{c.voltage}</td>
                <td>{c.notes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="wiring-spec-cards">
        <h4 className="wiring-spec-heading">Component datasheets</h4>
        <div className="wiring-spec-card-grid">
          {Object.entries(spec.componentSpecs).map(([name, rows]) => (
            <article key={name} className="wiring-spec-card">
              <header className="wiring-spec-card-head">{name}</header>
              <dl className="wiring-spec-card-body" style={MONO_STYLE}>
                {Object.entries(rows).map(([k, v]) => (
                  <div key={k} className="wiring-spec-card-row">
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
