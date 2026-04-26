import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
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
import { assignBusOffsets, routeWire, type Connection } from "../data/route-wire";
import WiringSpecTable from "./WiringSpecTable";
import fixtureJson from "../../../fixtures/uno-ultrasonic-servo.json";
import {
  VolteuxProjectDocumentSchema,
  type VolteuxProjectDocument,
} from "../../../schemas/document.zod";

// Fallback document for the brief render window before `project.document`
// is populated by the adapter (and for any test that constructs a Project
// without a document). U8 made `project.document` available; we prefer it
// when present and fall back to the fixture so the panel never crashes.
const fixtureDoc: VolteuxProjectDocument =
  VolteuxProjectDocumentSchema.parse(fixtureJson);

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
function placeOnBoard(doc: VolteuxProjectDocument): Map<string, PlacedComponent> {
  const placed = new Map<string, PlacedComponent>();
  for (const layoutEntry of doc.breadboard_layout.components) {
    const compRef = doc.components.find(
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
 * Per-component drag offset, applied at render time to the component's
 * footprint and to its resolved pin coordinates. Render-only state —
 * the underlying `doc.breadboard_layout` is never mutated (CLAUDE.md
 * § Schema discipline).
 */
interface DragOffset {
  readonly dx: number;
  readonly dy: number;
}

type DragOverrides = ReadonlyMap<string, DragOffset>;

/**
 * Resolve a connection endpoint (component_id + pin_label) to an SVG
 * point. Applies any active drag override for non-MCU components.
 * Returns `null` if the endpoint is unknown — caller skips that wire
 * and warns.
 */
function endpointXY(
  doc: VolteuxProjectDocument,
  componentId: string,
  pinLabel: string,
  placed: Map<string, PlacedComponent>,
  dragOverrides: DragOverrides,
): { x: number; y: number } | null {
  const compRef = doc.components.find((c) => c.id === componentId);
  if (!compRef) return null;
  const entry = lookupBySku(compRef.sku);
  if (!entry) return null;
  // Off-board Uno: emerge from the stub's right edge. Uno is not draggable.
  if (entry.type === "mcu") {
    return { x: UNO_PIN_X, y: unoPinY(pinLabel) };
  }
  const placedComp = placed.get(componentId);
  if (!placedComp) return null;
  const pin = placedComp.pins.find((p) => p.pinLabel === pinLabel);
  if (!pin) return null;
  const override = dragOverrides.get(componentId);
  if (!override) return pin.xy;
  return { x: pin.xy.x + override.dx, y: pin.xy.y + override.dy };
}

interface DragState {
  readonly pointerId: number;
  readonly componentId: string;
  readonly startClientX: number;
  readonly startClientY: number;
  readonly baseDx: number;
  readonly baseDy: number;
}

export default function WiringPanel({ project, expanded, onExpandToggle }: WiringPanelProps) {
  const doc = project.document ?? fixtureDoc;
  const placed = placeOnBoard(doc);

  const [dragOverrides, setDragOverrides] = useState<ReadonlyMap<string, DragOffset>>(
    () => new Map(),
  );
  const dragRef = useRef<DragState | null>(null);

  const updateOverride = (componentId: string, next: DragOffset): void => {
    setDragOverrides((prev) => {
      const out = new Map(prev);
      out.set(componentId, next);
      return out;
    });
  };

  const handlePointerDown = (
    e: ReactPointerEvent<SVGGElement>,
    componentId: string,
  ): void => {
    const base = dragOverrides.get(componentId) ?? { dx: 0, dy: 0 };
    dragRef.current = {
      pointerId: e.pointerId,
      componentId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      baseDx: base.dx,
      baseDy: base.dy,
    };
    // Pointer capture lets us keep receiving move/up events even if the
    // pointer leaves the <g>'s hitbox mid-drag.
    e.currentTarget.setPointerCapture(e.pointerId);
    e.stopPropagation();
  };

  const handlePointerMove = (e: ReactPointerEvent<SVGGElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    // Screen-pixel delta. The SVG scales via viewBox; for the small drags
    // typical of bench layout edits this 1:1 mapping is acceptable for v1.5
    // (see plan §Unit 4 simplification note).
    const rawDx = drag.baseDx + (e.clientX - drag.startClientX);
    const rawDy = drag.baseDy + (e.clientY - drag.startClientY);
    const dx = Math.round(rawDx / COL_SPACING) * COL_SPACING;
    const dy = Math.round(rawDy / ROW_SPACING) * ROW_SPACING;
    const current = dragOverrides.get(drag.componentId);
    if (current && current.dx === dx && current.dy === dy) return;
    updateOverride(drag.componentId, { dx, dy });
  };

  const handlePointerEnd = (e: ReactPointerEvent<SVGGElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    dragRef.current = null;
  };

  const isDragging = dragRef.current !== null;

  // Bus-offset assignments are derived once per render from the doc's
  // connections. `assignBusOffsets` is deterministic, so the same
  // connection set yields the same slot map each render.
  const connections: Connection[] = doc.connections.map((c) => ({
    fromId: c.from.component_id,
    fromPin: c.from.pin_label,
    toId: c.to.component_id,
    toPin: c.to.pin_label,
  }));
  const busOffsets = assignBusOffsets(connections);

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

          {/* Placed components (footprint + pin dots + label). Each
              component's <g> is draggable; the Uno is rendered as a
              non-draggable off-board stub above and is not in `placed`. */}
          <g>
            {Array.from(placed.values()).map((pc) => {
              const fill = fillForType(pc.entry);
              const labelFill = componentLabelFill();
              const override = dragOverrides.get(pc.componentId);
              const transform = override
                ? `translate(${override.dx} ${override.dy})`
                : undefined;
              const dragging =
                isDragging && dragRef.current?.componentId === pc.componentId;
              const cursor = dragging ? "grabbing" : "grab";
              return (
                <g
                  key={pc.componentId}
                  transform={transform}
                  style={{ cursor, touchAction: "none" }}
                  onPointerDown={(e) => handlePointerDown(e, pc.componentId)}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerEnd}
                  onPointerCancel={handlePointerEnd}
                >
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

          {/* Wires — strict Manhattan routing via routeWire(). Bus
              offsets keep parallel wires from drawing on top of each
              other. Uno endpoints get an explicit elbow through the
              left-edge stub before entering the Manhattan body. */}
          <g fill="none" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            {doc.connections.map((conn, i) => {
              const a = endpointXY(
                doc,
                conn.from.component_id,
                conn.from.pin_label,
                placed,
                dragOverrides,
              );
              const b = endpointXY(
                doc,
                conn.to.component_id,
                conn.to.pin_label,
                placed,
                dragOverrides,
              );
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

              const key: Connection = {
                fromId: conn.from.component_id,
                fromPin: conn.from.pin_label,
                toId: conn.to.component_id,
                toPin: conn.to.pin_label,
              };
              const busOffset =
                busOffsets.get(
                  `${key.fromId} ${key.fromPin} ${key.toId} ${key.toPin}`,
                ) ?? 0;

              const aIsUno = a.x === UNO_PIN_X;
              const bIsUno = b.x === UNO_PIN_X;

              let d: string;
              if (aIsUno || bIsUno) {
                // Preserve the off-board elbow: go horizontally from the
                // Uno's right edge to UNO_LEFT_EDGE_STUB_X at the same Y,
                // then hand off to the Manhattan router for the rest.
                const unoEnd = aIsUno ? a : b;
                const otherEnd = aIsUno ? b : a;
                const stubStart = { x: UNO_LEFT_EDGE_STUB_X, y: unoEnd.y };
                const tail = routeWire(stubStart, otherEnd, busOffset);
                // routeWire output starts with "M sx sy ..."; we already have
                // an M at the Uno end, so strip the leading "M sx sy " from
                // the tail and append the rest.
                const tailRest = tail.startsWith(`M ${stubStart.x} ${stubStart.y}`)
                  ? tail.slice(`M ${stubStart.x} ${stubStart.y}`.length).trimStart()
                  : tail;
                d = `M ${unoEnd.x} ${unoEnd.y} H ${stubStart.x}${tailRest ? " " + tailRest : ""}`;
              } else {
                d = routeWire(a, b, busOffset);
              }

              return <path key={i} d={d} stroke={stroke} />;
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
        {expanded && <WiringSpecTable doc={doc} />}
      </div>
    </div>
  );
}
