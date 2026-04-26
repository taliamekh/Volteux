import type { Project, WireColor } from "../types";
import { lookupBySku, type ComponentRegistryEntry } from "../../../components/registry";
import {
  COL_COUNT,
  ORIGIN_X,
  ROWS,
  TOP_ROW_Y,
  ROW_SPACING,
  COL_SPACING,
  CHANNEL,
  WIRE_COLORS as HOLE_WIRE_COLORS,
  holeToXY,
  parseHole,
  shiftHole,
  type Hole,
} from "./breadboard-geometry";
import fixtureJson from "../../../fixtures/uno-ultrasonic-servo.json";
import { VolteuxProjectDocumentSchema } from "../../../schemas/document.zod";

// ---------------------------------------------------------------
// v0 plumbing shim: load the document directly from the fixture so
// this panel can read raw `breadboard_layout` + `connections` (the
// adapter at `app/src/data/adapter.ts` deliberately doesn't carry
// these forward — they're rendering concerns, not view-model state).
// U8 will pass `document` via props; once that lands this import is
// deleted and the panel reads from `props.project.document`.
// ---------------------------------------------------------------
const fixtureDoc = VolteuxProjectDocumentSchema.parse(fixtureJson);

interface WiringPanelProps {
  project: Project;
  expanded?: boolean;
  onExpandToggle?: () => void;
}

// Legacy WireColor (UI-internal) → hex. Kept for the legend dots,
// which still render from the adapter's `project.wiring`.
const LEGEND_COLORS: Record<WireColor, string> = {
  red: "#C8302C",
  black: "#1A1814",
  yellow: "#D9B43C",
  blue: "#3A6FB8",
  green: "#5DA34A",
  purple: "#9B6FE0",
};

// Geometry constants for the off-board Uno stub.
const UNO_X = -10;
const UNO_Y = 56;
const UNO_W = 24;
const UNO_H = 168;
const UNO_PIN_X = UNO_X + UNO_W; // right edge of the Uno stub
const UNO_LEFT_EDGE_STUB_X = 18; // where wires emerge before entering the board

// SVG palette (board color, channel, hole dots, labels). These mirror the
// existing breadboard aesthetic; design tokens are used for outer-panel chrome.
const BOARD_FILL = "#FBFAF6";
const BOARD_STROKE = "#C7BFB0";
const CHANNEL_FILL = "#E5DFD3";
const HOLE_FILL = "#9A938A";
const LABEL_FILL = "#9A938A";
const COMPONENT_FOOTPRINT_STROKE = "#5C564E";
const COMPONENT_LABEL_FILL = "#3A3530";
const FALLBACK_COMPONENT_FILL = "#D1CCC0";
const SENSOR_FILL = "#1A4A82";
const SERVO_FILL = "#3A4255";
const UNKNOWN_WIRE = "#888";

// The viewBox y for the bottom of the breadboard background rect.
const BOARD_TOP = 30;
const BOARD_BOTTOM = 215;
const CHANNEL_Y = TOP_ROW_Y + 5 * ROW_SPACING - 2; // 118
const CHANNEL_H = CHANNEL - 4; // 12

// The hole-XY for the rightmost column of the board, used to width the bg rect.
const BOARD_LEFT = 20;
const BOARD_RIGHT = ORIGIN_X + (COL_COUNT - 1) * COL_SPACING + 10; // 561 + buffer

interface PlacedPin {
  pinLabel: string;
  hole: Hole;
  xy: { x: number; y: number };
}

interface PlacedComponent {
  componentId: string;
  entry: ComponentRegistryEntry;
  anchor: Hole;
  pins: PlacedPin[];
  /** Bounding box of all the pin holes (for the footprint rect). */
  bbox: { x: number; y: number; w: number; h: number };
}

/**
 * Component-type → fill color for the footprint rect. Mirrors the
 * existing artistic SVG palette so the visual feel doesn't change.
 */
function fillForType(entry: ComponentRegistryEntry): string {
  switch (entry.type) {
    case "sensor":
      return SENSOR_FILL;
    case "actuator":
      return SERVO_FILL;
    default:
      return FALLBACK_COMPONENT_FILL;
  }
}

// Component labels sit BELOW the footprint on the cream board background,
// so they always use the dark ink color regardless of footprint type.
function componentLabelFill(): string {
  return COMPONENT_LABEL_FILL;
}

/**
 * Place every breadboard_layout entry that belongs on the board (i.e.
 * not the Uno, which is rendered as an off-board stub). Returns a map
 * keyed by component_id for fast wire-endpoint lookup.
 */
function placeOnBoard(): Map<string, PlacedComponent> {
  const placed = new Map<string, PlacedComponent>();
  for (const layoutEntry of fixtureDoc.breadboard_layout.components) {
    const compRef = fixtureDoc.components.find(
      (c) => c.id === layoutEntry.component_id,
    );
    if (!compRef) continue;
    const entry = lookupBySku(compRef.sku);
    if (!entry) {
      console.warn(
        `Wiring: skipping breadboard_layout entry — unknown SKU '${compRef.sku}'`,
      );
      continue;
    }
    // The Uno is rendered as an off-board stub; skip it here.
    if (entry.type === "mcu") continue;

    const anchor = parseHole(layoutEntry.anchor_hole);
    if (!anchor) {
      console.warn(
        `Wiring: skipping breadboard_layout entry — invalid anchor_hole '${layoutEntry.anchor_hole}'`,
      );
      continue;
    }

    const pins: PlacedPin[] = [];
    for (const pl of entry.pin_layout) {
      const h = shiftHole(anchor, pl.row_offset, pl.column_offset);
      if (!h) continue;
      pins.push({ pinLabel: pl.label, hole: h, xy: holeToXY(h) });
    }

    if (pins.length === 0) continue;

    // Bounding box around all pins, with a little padding.
    const xs = pins.map((p) => p.xy.x);
    const ys = pins.map((p) => p.xy.y);
    const minX = Math.min(...xs) - 6;
    const maxX = Math.max(...xs) + 6;
    const minY = Math.min(...ys) - 8;
    const maxY = Math.max(...ys) + 8;

    placed.set(layoutEntry.component_id, {
      componentId: layoutEntry.component_id,
      entry,
      anchor,
      pins,
      bbox: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
    });
  }
  return placed;
}

/**
 * For the Uno (off-board), we don't have real hole positions — wires
 * emerge from the right edge of the stub at vertical offsets keyed to
 * each pin label. Use a stable hash over pin labels to keep positions
 * deterministic across renders.
 */
function unoPinY(pinLabel: string): number {
  // Distribute pins evenly down the Uno stub.
  // We use a deterministic ordering based on the pin's index in the
  // registry's pin_metadata array.
  const unoEntry = lookupBySku("50");
  if (!unoEntry) return UNO_Y + UNO_H / 2;
  const idx = unoEntry.pin_metadata.findIndex((p) => p.label === pinLabel);
  if (idx < 0) return UNO_Y + UNO_H / 2;
  // Map idx (0..N-1) into the vertical range [UNO_Y+8, UNO_Y+UNO_H-8].
  const n = unoEntry.pin_metadata.length;
  if (n <= 1) return UNO_Y + UNO_H / 2;
  return UNO_Y + 8 + (idx / (n - 1)) * (UNO_H - 16);
}

/**
 * Resolve a connection endpoint (component_id + pin_label) to an SVG
 * point. Returns `null` if the endpoint is unknown — caller skips that
 * polyline and warns.
 */
function endpointXY(
  componentId: string,
  pinLabel: string,
  placed: Map<string, PlacedComponent>,
): { x: number; y: number } | null {
  const compRef = fixtureDoc.components.find((c) => c.id === componentId);
  if (!compRef) return null;
  const entry = lookupBySku(compRef.sku);
  if (!entry) return null;
  // Off-board Uno: emerge from the stub's right edge.
  if (entry.type === "mcu") {
    return { x: UNO_PIN_X, y: unoPinY(pinLabel) };
  }
  const placedComp = placed.get(componentId);
  if (!placedComp) return null;
  const pin = placedComp.pins.find((p) => p.pinLabel === pinLabel);
  if (!pin) return null;
  return pin.xy;
}

/**
 * Quadratic-Bezier path between two points with a slight upward arc for
 * readability. Mirrors the curve style of the previous artistic SVG.
 */
function curvedPath(
  a: { x: number; y: number },
  b: { x: number; y: number },
): string {
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  // Lift the control point above the midpoint by 10% of horizontal span,
  // capped so very short wires don't loop too high.
  const lift = Math.min(20, Math.abs(b.x - a.x) * 0.1 + 6);
  const cy = midY - lift;
  return `M ${a.x} ${a.y} Q ${midX} ${cy} ${b.x} ${b.y}`;
}

export default function WiringPanel({ project, expanded, onExpandToggle }: WiringPanelProps) {
  const placed = placeOnBoard();

  return (
    <div className={`panel flex-grow wire-panel ${expanded ? "panel-expanded" : ""}`}>
      <div className="panel-head">
        <h3>Wiring diagram</h3>
        <span className="meta">Top-down · color-coded</span>
        <button
          className="icon-btn-sm"
          onClick={onExpandToggle}
          title={expanded ? "Exit expanded view" : "Open larger"}
          aria-label={expanded ? "Exit expanded view" : "Open larger"}
        >
          {expanded ? "↙" : "↗"}
        </button>
      </div>
      <div className="breadboard-body">
        <svg
          className="breadboard-svg"
          viewBox="0 0 600 280"
          preserveAspectRatio="xMidYMid meet"
          xmlns="http://www.w3.org/2000/svg"
        >
          {/* Breadboard backing */}
          <rect
            x={BOARD_LEFT}
            y={BOARD_TOP}
            width={BOARD_RIGHT - BOARD_LEFT}
            height={BOARD_BOTTOM - BOARD_TOP}
            rx="8"
            fill={BOARD_FILL}
            stroke={BOARD_STROKE}
          />

          {/* Center channel */}
          <rect
            x={BOARD_LEFT}
            y={CHANNEL_Y}
            width={BOARD_RIGHT - BOARD_LEFT}
            height={CHANNEL_H}
            fill={CHANNEL_FILL}
          />

          {/* Column numbers (every 5) */}
          <g
            fill={LABEL_FILL}
            fontSize="7"
            fontFamily="monospace"
            textAnchor="middle"
          >
            {[1, 5, 10, 15, 20, 25, 30].map((c) => {
              const x = ORIGIN_X + (c - 1) * COL_SPACING;
              return (
                <text key={c} x={x} y={BOARD_TOP - 6}>
                  {c}
                </text>
              );
            })}
          </g>

          {/* Row labels */}
          <g fill={LABEL_FILL} fontSize="8" fontFamily="monospace">
            {ROWS.map((r, i) => {
              const inBottomHalf = i >= 5;
              const y = TOP_ROW_Y + i * ROW_SPACING + (inBottomHalf ? CHANNEL : 0) + 3;
              return (
                <text key={r} x={BOARD_LEFT - 8} y={y}>
                  {r}
                </text>
              );
            })}
          </g>

          {/* Hole grid */}
          <g fill={HOLE_FILL}>
            {ROWS.map((r, ri) => {
              const inBottomHalf = ri >= 5;
              const y = TOP_ROW_Y + ri * ROW_SPACING + (inBottomHalf ? CHANNEL : 0);
              return (
                <g key={r}>
                  {Array.from({ length: COL_COUNT }, (_, ci) => {
                    const x = ORIGIN_X + ci * COL_SPACING;
                    return <circle key={ci} cx={x} cy={y} r="1.6" />;
                  })}
                </g>
              );
            })}
          </g>

          {/* Off-board Uno stub */}
          <g>
            <rect
              x={UNO_X}
              y={UNO_Y}
              width={UNO_W}
              height={UNO_H}
              rx="3"
              fill="#1E5C8A"
              stroke="#0A2940"
            />
            <text
              x={UNO_X + UNO_W / 2}
              y={UNO_Y + UNO_H / 2}
              fill="#FBFAF6"
              fontSize="6"
              fontFamily="monospace"
              textAnchor="middle"
              transform={`rotate(-90 ${UNO_X + UNO_W / 2} ${UNO_Y + UNO_H / 2})`}
            >
              UNO
            </text>
          </g>

          {/* Placed components (footprint + pin dots + label) */}
          <g>
            {Array.from(placed.values()).map((pc) => {
              const fill = fillForType(pc.entry);
              const labelFill = componentLabelFill();
              return (
                <g key={pc.componentId}>
                  <rect
                    x={pc.bbox.x}
                    y={pc.bbox.y}
                    width={pc.bbox.w}
                    height={pc.bbox.h}
                    rx="2"
                    fill={fill}
                    stroke={COMPONENT_FOOTPRINT_STROKE}
                    strokeWidth="0.6"
                    opacity="0.92"
                  />
                  {pc.pins.map((pin) => (
                    <circle
                      key={pin.pinLabel}
                      cx={pin.xy.x}
                      cy={pin.xy.y}
                      r="2.2"
                      fill="#2A2520"
                      stroke="#FBFAF6"
                      strokeWidth="0.5"
                    />
                  ))}
                  <text
                    x={pc.bbox.x + pc.bbox.w / 2}
                    y={pc.bbox.y + pc.bbox.h + 9}
                    fill={labelFill}
                    fontSize="6"
                    fontFamily="monospace"
                    textAnchor="middle"
                  >
                    {pc.entry.name.split(" ")[0] ?? pc.entry.name}
                  </text>
                </g>
              );
            })}
          </g>

          {/* Wires */}
          <g fill="none" strokeWidth="1.4" strokeLinecap="round">
            {fixtureDoc.connections.map((conn, i) => {
              const a = endpointXY(conn.from.component_id, conn.from.pin_label, placed);
              const b = endpointXY(conn.to.component_id, conn.to.pin_label, placed);
              if (!a || !b) {
                console.warn(
                  `Wiring: skipping connection — unknown component '${
                    !a ? conn.from.component_id : conn.to.component_id
                  }'`,
                );
                return null;
              }
              const stroke = conn.wire_color
                ? (HOLE_WIRE_COLORS[conn.wire_color] ?? UNKNOWN_WIRE)
                : UNKNOWN_WIRE;
              // For Uno endpoints: route via the left-edge stub for cleaner lines.
              const aIsUno = a.x === UNO_PIN_X;
              const bIsUno = b.x === UNO_PIN_X;
              if (aIsUno || bIsUno) {
                const stubX = UNO_LEFT_EDGE_STUB_X;
                const stub = aIsUno
                  ? { x: stubX, y: a.y }
                  : { x: stubX, y: b.y };
                const start = aIsUno ? a : b;
                const end = aIsUno ? b : a;
                const points = `${start.x},${start.y} ${stub.x},${stub.y} ${end.x},${end.y}`;
                return (
                  <polyline
                    key={i}
                    points={points}
                    stroke={stroke}
                  />
                );
              }
              return (
                <path
                  key={i}
                  d={curvedPath(a, b)}
                  stroke={stroke}
                />
              );
            })}
          </g>

          {/* Legend (first 5 wires) */}
          <g
            transform={`translate(${BOARD_LEFT}, 250)`}
            fontSize="8"
            fontFamily="monospace"
            fill={LABEL_FILL}
          >
            {project.wiring.slice(0, 5).map((w, i) => (
              <g key={i} transform={`translate(${i * 110}, 0)`}>
                <circle cx="6" cy="0" r="3" fill={LEGEND_COLORS[w.color] ?? UNKNOWN_WIRE} />
                <text x="14" y="3">
                  {w.from} → {w.to}
                </text>
              </g>
            ))}
          </g>
        </svg>
      </div>
    </div>
  );
}
