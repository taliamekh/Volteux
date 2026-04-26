// ============================================================
// Volteux — Hero 3D scene (R3F)
// ============================================================
// Replaces the placeholder SVG hero (see HeroPanel's prior `SceneSvg`).
// Renders the 5 archetype-1 components as drei primitive meshes on a
// flat workspace plane, with click-to-select hotspots overlaid via
// `<Html>`. No `.glb` loading: production models are a separate
// visual-identity work-stream (see
// docs/plans/2026-04-26-001-feat-v01-ui-track1-completion-plan.md).
//
// StrictMode-safe: every resource is owned by drei primitives that
// handle their own lifecycle. No `useEffect` resource allocation in
// the scene tree.
//
// KAI-DONE (Unit 6): Replaced the Uno's flat <Box> with <UnoBoardMesh>
// (PCB + USB-B + DC barrel + ICSP + reset + on-board LED) and added
// <PinMarkers> dots at programmatic header positions. Click a pin →
// selectedPin propagates up to HeroPanel for a sidebar callout.
//
// KAI-DONE (Unit 7): Added <Wire3D> primitive (CatmullRomCurve3 +
// tubeGeometry), per-component drag override map, pointer-driven
// drag handlers on HC-SR04 (SKU 3942) and SG90 (SKU 169), and routed
// every `doc.connections[]` entry into a tube whose endpoints recompute
// from the live override map. Uno is intentionally non-draggable.
//
// KAI-DONE (Unit 8): Camera dolly via @react-spring/three. On selectedPin
// change, the camera lerps 15% toward the pin's world position over
// 400ms (easeOutCubic). When selectedPin is null, the camera returns to
// its origin. OrbitControls is disabled mid-spring to avoid input fight.

import {
  forwardRef,
  Suspense,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Box, Cylinder, Html, OrbitControls, Plane, Sphere } from "@react-three/drei";
import { useSpring, easings } from "@react-spring/three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { ThreeEvent } from "@react-three/fiber";
import type { IconKind, Part } from "../types";
import {
  BOARD_DIMENSIONS,
  calculatePinPositions,
  getPinAnchor,
  type BoardKey,
} from "../data/board-data";
import { lookupBySku } from "../../../components/registry";
import { WIRE_COLORS } from "./breadboard-geometry";
import type { VolteuxProjectDocument } from "../../../schemas/document.zod";

// KAI-NOTE: GLTF modelPath passthrough not yet wired — add when first
// archetype ships a GLTF asset. Pin marker positions already come from
// calculatePinPositions(), so swapping in a GLTF body later doesn't move
// the pin dots.

// ---------- Material palette (mirrors the prior SVG hero) ----------

const COLORS = {
  pcbBlue: "#1E5C8A",       // Uno PCB
  breadboardCream: "#FBFAF6",
  sensorBlue: "#1A4A82",    // HC-SR04 body
  servoDark: "#3A4255",     // SG90 housing
  servoArm: "#FAF8F4",      // light arm
  ledWarm: "#FFE066",       // LED dome
  resistorBeige: "#D9C9A6", // resistor body
  buzzerDark: "#2A2F3D",    // buzzer can
  pirDome: "#A6B0BF",       // PIR dome (lighter)
  workspace: "#23293B",     // subtle dark plane that blends with --bg
  // Uno sub-mesh palette
  unoSilver: "#B8BCC2",     // USB-B, DC barrel housings
  unoBlack: "#1A1C20",      // ICSP header plastic
  unoReset: "#D8DBE0",      // reset button cap
  unoLedOn: "#7CFFA8",      // on-board "L" LED
  pinGold: "#FFD166",       // pin marker default
  pinGoldHot: "#FF8C00",    // pin marker selected
} as const;

// Per-SKU positions for the 5 archetype-1 parts. SKU is unique per
// component (icon is not — the Uno and breadboard both map to `board`),
// so SKU-keyed lookup is the source of truth and the icon-keyed table
// below is a fallback for components not yet enumerated here.
// Y is height above the workspace plane (which sits at y=0).
const POSITIONS_BY_SKU: Readonly<Record<string, [number, number, number]>> = {
  "50":   [-1.6, 0.1, -0.4],    // Arduino Uno (off-board, to the left)
  "3942": [-0.6, 0.3, 0.5],     // HC-SR04 sits on the breadboard, left
  "169":  [1.4, 0.32, 0.2],     // SG90 servo on the right
  "239":  [0.2, 0.075, 0.0],    // breadboard centered (matches BreadboardSlab pos)
  "758":  [0.2, 0.05, 0.6],     // jumper wires laid flat on the breadboard
};

// Rough per-SKU hotspot Y-offset so the `<Html>` floats above the part.
const HOTSPOT_Y_OFFSET_BY_SKU: Readonly<Record<string, number>> = {
  "50":   0.35,
  "3942": 0.55,
  "169":  0.65,
  "239":  0.20,
  "758":  0.15,
};

// Index-based positions for the 5 archetype-1 parts. Y is height above
// the workspace plane (which sits at y=0). The plan calls for visual
// adjustment, not pixel projection from the 2D `pos.x/pos.y` (which are
// SVG screen percentages).
//
// Kept as a fallback for parts whose SKU isn't in `POSITIONS_BY_SKU`
// (e.g., future archetypes that emit components not yet enumerated
// above). Two SKUs can share an icon (`board` covers both Uno and
// breadboard), which is why the SKU-keyed table is preferred.
const POSITIONS_BY_ICON: Readonly<Record<IconKind, [number, number, number]>> = {
  board: [-1.6, 0.1, -0.4],   // Arduino Uno (off-board, to the left)
  sonar: [-0.6, 0.3, 0.5],    // HC-SR04 sits on the breadboard
  servo: [1.4, 0.32, 0.2],    // SG90 sits on the right
  led: [0.5, 0.22, 0.3],
  res: [0.2, 0.05, 0.6],      // resistor lays flat on the breadboard
  buzzer: [-0.2, 0.18, 0.5],
  eye: [-0.3, 0.22, 0.4],     // PIR motion sensor
};

// Rough hotspot Y-offset above each mesh so the `<Html>` floats above the part.
const HOTSPOT_Y_OFFSET_BY_ICON: Readonly<Record<IconKind, number>> = {
  board: 0.35,
  sonar: 0.55,
  servo: 0.65,
  led: 0.45,
  res: 0.25,
  buzzer: 0.45,
  eye: 0.55,
};

/**
 * Strip the display-only "SKU " prefix that the parts adapter adds to
 * `Part.sku` (see `app/src/data/adapter.ts` ~line 254). Pure helper so
 * the lookup tables can be keyed by raw SKU (matching the registry).
 *
 * Cluster B follow-up: the `Part.sku` shape ("SKU 239" vs `{display, id}`)
 * is a typed-lookup footgun TypeScript can't catch. Mitigated locally
 * with this helper; structural fix is out of scope for this unit.
 */
function skuKey(prefixed: string): string {
  return prefixed.startsWith("SKU ") ? prefixed.slice(4) : prefixed;
}

// ---------- Uno board sub-mesh ----------
//
// Replaces the prior single <Box>. PCB base sits centered on the group
// origin; sub-features are positioned relative to that base. Dimensions
// are approximate — goal is recognizability, not photo-accuracy.
//
// KAI-NOTE: PCB base reuses the legacy [2, 0.18, 1.4] dimensions to keep
// the existing POSITIONS_BY_SKU offset valid; sub-feature positions are
// hand-tuned to read correctly at the default camera angle.
//
// KAI-NOTE: texture loading deferred — public/textures/uno-top.jpg not
// yet delivered. Wrapped in <Suspense fallback={null}> so a future
// useTexture() call won't cascade-fail the build. For now we use a flat
// pcbBlue material.
function UnoBoardMesh() {
  return (
    <Suspense fallback={null}>
      <group>
        {/* PCB base — width 2, depth 1.4, thin slab. */}
        <Box args={[2, 0.18, 1.4]} castShadow receiveShadow>
          <meshStandardMaterial color={COLORS.pcbBlue} roughness={0.55} metalness={0.1} />
        </Box>

        {/* USB-B port — front-left edge, sticks out beyond the PCB. */}
        <Box args={[0.32, 0.26, 0.42]} position={[-0.78, 0.15, -0.82]} castShadow>
          <meshStandardMaterial color={COLORS.unoSilver} roughness={0.4} metalness={0.7} />
        </Box>

        {/* DC barrel jack — front edge, near (but right of) the USB. */}
        <Cylinder
          args={[0.13, 0.13, 0.32, 24]}
          rotation={[Math.PI / 2, 0, 0]}
          position={[-0.78, 0.16, -0.36]}
          castShadow
        >
          <meshStandardMaterial color={COLORS.unoBlack} roughness={0.6} metalness={0.4} />
        </Cylinder>

        {/* ICSP header — small black block on the right side. */}
        <Box args={[0.18, 0.08, 0.22]} position={[0.78, 0.13, 0.18]} castShadow>
          <meshStandardMaterial color={COLORS.unoBlack} roughness={0.7} />
        </Box>

        {/* Reset button — small light cap near the front-right. */}
        <Cylinder
          args={[0.06, 0.06, 0.07, 16]}
          position={[0.62, 0.13, -0.55]}
          castShadow
        >
          <meshStandardMaterial color={COLORS.unoReset} roughness={0.5} />
        </Cylinder>

        {/* On-board "L" LED — small emissive sphere near pin 13. */}
        <Sphere args={[0.04, 16, 12]} position={[0.32, 0.13, 0.42]}>
          <meshStandardMaterial
            color={COLORS.unoLedOn}
            emissive={COLORS.unoLedOn}
            emissiveIntensity={0.6}
            roughness={0.3}
          />
        </Sphere>
      </group>
    </Suspense>
  );
}

// ---------- Pin markers ----------

interface PinMarkersProps {
  boardKey: BoardKey;
  selectedPin: string | null;
  onPinClick: (pin: string) => void;
}

/**
 * Render one small sphere per board pin at its calculated header position.
 *
 * Positions come from `calculatePinPositions(boardKey)` (real 2.54 mm
 * pitch geometry). Coordinates are in the board's own local space, so
 * this component is meant to be nested inside the board's transform
 * group. KAI-NOTE: we scale Z down by 0.2 to bring the wide 2.6→5.4 cm
 * Z-range into the 1.4-deep PCB outline used by the legacy mesh.
 */
function PinMarkers({ boardKey, selectedPin, onPinClick }: PinMarkersProps) {
  const positions = calculatePinPositions(boardKey);
  // KAI-NOTE: board-data.ts lays pins out at "real" 2.54 mm pitch (Z spans
  // ~5 cm), but our legacy PCB box is only 1.4 deep. Compress the Z axis
  // so all pins sit on the visible PCB slab.
  const zSquish = 0.22;
  const yLift = 0.12; // sit on top of the PCB

  const handlePointerOver = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (typeof document !== "undefined") {
      document.body.style.cursor = "pointer";
    }
  };
  const handlePointerOut = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (typeof document !== "undefined") {
      document.body.style.cursor = "";
    }
  };

  return (
    <group>
      {Object.entries(positions).map(([label, pos]) => {
        const selected = selectedPin === label;
        return (
          <Sphere
            key={label}
            args={[0.04, 12, 8]}
            position={[pos.x, yLift, pos.z * zSquish]}
            onPointerDown={(e) => {
              e.stopPropagation();
              onPinClick(label);
            }}
            onPointerOver={handlePointerOver}
            onPointerOut={handlePointerOut}
          >
            <meshStandardMaterial
              color={selected ? COLORS.pinGoldHot : COLORS.pinGold}
              roughness={0.4}
              metalness={0.5}
              emissive={selected ? COLORS.pinGoldHot : "#000000"}
              emissiveIntensity={selected ? 0.4 : 0}
            />
          </Sphere>
        );
      })}
    </group>
  );
}

// ---------- Pin callout (3D) ----------

interface PinCalloutProps {
  boardKey: BoardKey;
  pin: string;
}

/**
 * Floating <Html> callout positioned above the selected pin's world
 * coordinate. Reads `pin_metadata` directly from the registry so the
 * label / direction / description stay in sync with track-2 data.
 */
function PinCallout({ boardKey, pin }: PinCalloutProps) {
  const positions = calculatePinPositions(boardKey);
  const pos = positions[pin];
  if (!pos) return null;

  // Resolve metadata via the registry's canonical SKU (Uno = "50").
  // Other boards aren't in the registry yet — fall back to label only.
  const sku = boardKey === "uno" ? "50" : null;
  const entry = sku ? lookupBySku(sku) : undefined;
  const meta = entry?.pin_metadata.find((p) => p.label === pin);

  const zSquish = 0.22;
  return (
    <Html
      position={[pos.x, 0.45, pos.z * zSquish]}
      center
      zIndexRange={[20, 0]}
      style={{ pointerEvents: "none" }}
    >
      <div className="pin-callout-3d">
        <div className="pin-callout-label">{pin}</div>
        {meta && (
          <>
            <div className="pin-callout-direction">{meta.direction}</div>
            <div className="pin-callout-description">{meta.description}</div>
          </>
        )}
      </div>
    </Html>
  );
}

// ---------- Per-part mesh ----------

interface PartMeshProps {
  part: Part;
}

function PartMesh({ part }: PartMeshProps) {
  switch (part.icon) {
    case "board":
      // Arduino Uno: composed sub-mesh. Breadboard (also `board`) is
      // rendered separately as a static cream slab below — see
      // <BreadboardSlab/>.
      return <UnoBoardMesh />;

    case "sonar":
      // HC-SR04: rectangular blue PCB with two cylindrical "eyes" on top.
      return (
        <group>
          <Box args={[1.2, 0.4, 0.5]} castShadow receiveShadow>
            <meshStandardMaterial color={COLORS.sensorBlue} roughness={0.5} />
          </Box>
          <Cylinder args={[0.18, 0.18, 0.18, 24]} position={[-0.32, 0.28, 0]}>
            <meshStandardMaterial color="#A8A095" roughness={0.7} />
          </Cylinder>
          <Cylinder args={[0.18, 0.18, 0.18, 24]} position={[0.32, 0.28, 0]}>
            <meshStandardMaterial color="#A8A095" roughness={0.7} />
          </Cylinder>
        </group>
      );

    case "servo": {
      // SG90: cylindrical-ish body (rendered as a box for a flat servo
      // case look) + horn arm that sticks out the top.
      return (
        <group>
          <Box args={[0.7, 0.6, 0.45]} castShadow receiveShadow>
            <meshStandardMaterial color={COLORS.servoDark} roughness={0.55} />
          </Box>
          <Cylinder args={[0.22, 0.22, 0.08, 24]} position={[0, 0.34, 0]}>
            <meshStandardMaterial color={COLORS.servoArm} roughness={0.4} />
          </Cylinder>
          <Box args={[0.15, 0.05, 1]} position={[0, 0.4, 0]}>
            <meshStandardMaterial color={COLORS.servoArm} roughness={0.4} />
          </Box>
        </group>
      );
    }

    case "eye":
      // PIR motion sensor: short cylinder with a lighter dome on top.
      return (
        <group>
          <Cylinder args={[0.3, 0.4, 0.2, 24]} castShadow receiveShadow>
            <meshStandardMaterial color={COLORS.servoDark} roughness={0.6} />
          </Cylinder>
          <Sphere args={[0.28, 24, 16]} position={[0, 0.18, 0]}>
            <meshStandardMaterial color={COLORS.pirDome} roughness={0.4} />
          </Sphere>
        </group>
      );

    case "led":
      return (
        <Sphere args={[0.2, 24, 16]} castShadow>
          <meshStandardMaterial
            color={COLORS.ledWarm}
            emissive={COLORS.ledWarm}
            emissiveIntensity={0.35}
            roughness={0.3}
          />
        </Sphere>
      );

    case "res":
      // Through-hole resistor: thin cylinder lying flat.
      return (
        <Cylinder
          args={[0.06, 0.06, 0.6, 16]}
          rotation={[0, 0, Math.PI / 2]}
          castShadow
        >
          <meshStandardMaterial color={COLORS.resistorBeige} roughness={0.7} />
        </Cylinder>
      );

    case "buzzer":
      return (
        <Cylinder args={[0.3, 0.3, 0.3, 24]} castShadow receiveShadow>
          <meshStandardMaterial color={COLORS.buzzerDark} roughness={0.7} />
        </Cylinder>
      );
  }
}

// ---------- Static breadboard slab ----------
//
// The breadboard is the workspace surface, not a "part" the user clicks.
// It still appears in the parts list (and gets a hotspot above it), but
// the mesh is rendered once below the other components.
function BreadboardSlab() {
  // Reference dims so unused-import elision doesn't strip the import in
  // future refactors when this component starts using BoardKey-derived
  // sizing. Keeps board-data.ts as the geometric source of truth for
  // every solid object in the scene.
  void BOARD_DIMENSIONS;
  return (
    <Box args={[3.2, 0.15, 1.6]} position={[0.2, 0.075, 0]} receiveShadow>
      <meshStandardMaterial color={COLORS.breadboardCream} roughness={0.85} />
    </Box>
  );
}

// ---------- 3D wire primitive ----------

interface Wire3DProps {
  start: [number, number, number];
  end: [number, number, number];
  color: string;
}

/**
 * A single 3D wire rendered as a tube along a CatmullRomCurve3 with
 * three control points: start → midpoint-arched-up → end. The arch
 * height scales with the straight-line distance (so longer wires curve
 * more) but is clamped to a minimum so very-short wires still read as
 * curves rather than flat rods. Schema-side wire color names map via
 * `WIRE_COLORS`; unknown colors fall back to grey at the call site.
 */
function Wire3D({ start, end, color }: Wire3DProps) {
  // Serialize start/end so the memo key is structurally stable across
  // renders (array identities flip every render in the parent).
  const startKey = `${start[0]},${start[1]},${start[2]}`;
  const endKey = `${end[0]},${end[1]},${end[2]}`;
  const curve = useMemo(() => {
    const startVec = new THREE.Vector3(start[0], start[1], start[2]);
    const endVec = new THREE.Vector3(end[0], end[1], end[2]);
    const length = startVec.distanceTo(endVec);
    const archHeight = Math.max(0.4, 0.3 * length);
    const mid = new THREE.Vector3()
      .addVectors(startVec, endVec)
      .multiplyScalar(0.5);
    mid.y += archHeight;
    return new THREE.CatmullRomCurve3([startVec, mid, endVec]);
    // startKey / endKey capture the actual numeric content; eslint can't
    // see through the serialization but the dependency is correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startKey, endKey]);

  return (
    <mesh>
      <tubeGeometry args={[curve, 16, 0.018, 8, false]} />
      <meshStandardMaterial color={color} roughness={0.5} />
    </mesh>
  );
}

// ---------- Drag bookkeeping ----------

/** SKUs of components that can be dragged in the 3D scene. */
const DRAGGABLE_SKUS = new Set<string>(["3942", "169"]);

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  baseDx: number;
  baseDz: number;
  partId: string;
}

// KAI-NOTE: world-unit conversion is approximate; a proper unproject
// against the active camera would respect FOV + distance, but for v1.5
// drag the rough scalar below tracks the cursor closely enough at the
// default camera distance. Tune in v2 once the camera dolly lands.
const DRAG_PIXELS_PER_UNIT = 1 / 4; // i.e. 1 world unit ~ 4% of viewport width
const DRAG_SNAP = 0.254; // one breadboard hole pitch

// KAI-NOTE: per-pin 3D anchors deferred — we use a single anchor point
// per draggable part (sitting just above the part's body). The handoff
// calls for per-pin anchors along the bottom edge of HC-SR04 / SG90,
// but routing N wires from each part to its pin headers is a v2 concern.
const PART_PIN_ANCHOR_OFFSET: Readonly<Record<string, [number, number, number]>> = {
  "3942": [0, 0.4, 0], // HC-SR04: above PCB, between the two transducers
  "169": [0, 0.4, 0], // SG90: above the case, near the horn
};

/** Apply a numeric snap to the nearest multiple of `step`. */
function snapTo(v: number, step: number): number {
  return Math.round(v / step) * step;
}

// ---------- Camera dolly ----------

const CAMERA_ORIGIN = new THREE.Vector3(3, 2.5, 4);
const DOLLY_LERP_AMOUNT = 0.15; // lerp 15 % toward pin
const DOLLY_DURATION_MS = 400;
// Re-enable OrbitControls once the spring is within this much of either end.
const SPRING_SETTLE_EPSILON = 0.001;

interface CameraDollyProps {
  /** World-space target the camera should dolly toward. Null = origin. */
  target: [number, number, number] | null;
  /** Live ref to OrbitControls so we can pause it mid-transition. */
  controlsRef: React.MutableRefObject<OrbitControlsImpl | null>;
}

/**
 * Animates the active R3F camera from its current position toward a
 * point that is 15 % of the way to `target` over 400 ms. When `target`
 * is null, eases the camera back to CAMERA_ORIGIN. OrbitControls is
 * disabled while the spring is mid-flight to avoid input fight.
 *
 * Must be rendered inside <Canvas/> — uses `useThree` and `useFrame`.
 */
function CameraDolly({ target, controlsRef }: CameraDollyProps) {
  const { camera } = useThree();
  // The "from" position is captured once per target change so the lerp
  // basis stays stable through the animation.
  const fromRef = useRef(camera.position.clone());
  const toRef = useRef(camera.position.clone());

  // Recompute from/to whenever `target` changes. We snapshot the camera's
  // current position as the spring start (so rapid pin clicks resume from
  // wherever the previous transition left off — last click wins).
  useEffect(() => {
    fromRef.current.copy(camera.position);
    if (target) {
      const targetVec = new THREE.Vector3(target[0], target[1], target[2]);
      // Lerp 15 % from current toward target so the dolly is a nudge, not a slam.
      toRef.current
        .copy(camera.position)
        .lerp(targetVec, DOLLY_LERP_AMOUNT);
    } else {
      toRef.current.copy(CAMERA_ORIGIN);
    }
    // camera.position is read imperatively each render — depend on target only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const [{ t }, api] = useSpring(() => ({
    t: 0,
    config: { duration: DOLLY_DURATION_MS, easing: easings.easeOutCubic },
  }));

  useEffect(() => {
    // Reset to 0 (start) and animate to 1 (end) on every target change.
    api.set({ t: 0 });
    api.start({ t: 1 });
  }, [target, api]);

  useFrame(() => {
    const v = t.get();
    camera.position.lerpVectors(fromRef.current, toRef.current, v);
    // Pause OrbitControls while mid-transition; re-enable when settled.
    const controls = controlsRef.current;
    if (controls) {
      const settled = v < SPRING_SETTLE_EPSILON || v > 1 - SPRING_SETTLE_EPSILON;
      if (settled && !controls.enabled) controls.enabled = true;
      else if (!settled && controls.enabled) controls.enabled = false;
    }
  });

  return null;
}

// ---------- Scene API exposed to HeroPanel ----------

export interface HeroSceneHandle {
  resetCamera: () => void;
}

export interface HeroSceneProps {
  parts: Part[];
  selectedPart: string | null;
  setSelectedPart: (id: string | null) => void;
  setAutoTour: (v: boolean) => void;
  selectedPin: string | null;
  onPinClick: (pin: string | null) => void;
  /**
   * Schema-validated source document. When present, drives 3D wire
   * rendering from `doc.connections[]`. Undefined in test-only paths
   * where the project is constructed without a backing document.
   */
  doc?: VolteuxProjectDocument;
}

const HeroScene = forwardRef<HeroSceneHandle, HeroSceneProps>(function HeroScene(
  { parts, selectedPart, setSelectedPart, setAutoTour, selectedPin, onPinClick, doc },
  ref,
) {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const dragRef = useRef<DragState | null>(null);

  // Per-part XZ override applied on top of the base POSITIONS_BY_SKU
  // entry. Y is unchanged — drags are floor-plan only. Storing as a
  // Map keeps the Unit-4-equivalent shape used by the SVG drag layer.
  const [dragOverrides, setDragOverrides] = useState<
    ReadonlyMap<string, [number, number]>
  >(() => new Map());

  useImperativeHandle(ref, () => ({
    resetCamera: () => {
      controlsRef.current?.reset();
    },
  }));

  // Resolve the live world position for a part id (base + override).
  // Used both for rendering the part group and for resolving wire
  // endpoints anchored to that part.
  const resolvePartPosition = (partId: string): [number, number, number] | null => {
    const part = parts.find((p) => p.id === partId);
    if (!part) return null;
    const sku = skuKey(part.sku);
    const base =
      POSITIONS_BY_SKU[sku] ?? POSITIONS_BY_ICON[part.icon] ?? [0, 0.2, 0];
    const override = dragOverrides.get(partId);
    if (!override) return [base[0], base[1], base[2]];
    return [base[0] + override[0], base[1], base[2] + override[1]];
  };

  // Resolve a 3D world point for one end of a wire. Uno endpoints
  // resolve via the registry's pin geometry; HC-SR04 / SG90 endpoints
  // use a single per-part anchor offset above the body (KAI-NOTE in
  // PART_PIN_ANCHOR_OFFSET above).
  const resolveEndpoint = (
    componentId: string,
    pinLabel: string,
  ): [number, number, number] | null => {
    const part = parts.find((p) => p.id === componentId);
    if (!part) return null;
    const sku = skuKey(part.sku);
    const partPos = resolvePartPosition(componentId);
    if (!partPos) return null;

    if (sku === "50") {
      const anchor = getPinAnchor("uno", pinLabel);
      if (!anchor) return null;
      // Compress the Z axis the same way PinMarkers does so wires hit
      // the visible pin spheres rather than the wide "real" geometry.
      const zSquish = 0.22;
      return [
        partPos[0] + anchor.three.x,
        partPos[1] + anchor.three.y,
        partPos[2] + anchor.three.z * zSquish,
      ];
    }

    const offset = PART_PIN_ANCHOR_OFFSET[sku];
    if (!offset) return null;
    return [partPos[0] + offset[0], partPos[1] + offset[1], partPos[2] + offset[2]];
  };

  const wires = useMemo(() => {
    if (!doc) return [];
    type WireSpec = {
      key: string;
      start: [number, number, number];
      end: [number, number, number];
      color: string;
    };
    const out: WireSpec[] = [];
    doc.connections.forEach((c, i) => {
      const start = resolveEndpoint(c.from.component_id, c.from.pin_label);
      const end = resolveEndpoint(c.to.component_id, c.to.pin_label);
      if (!start || !end) return;
      const colorName = c.wire_color ?? "white";
      const color = WIRE_COLORS[colorName] ?? "#888";
      out.push({ key: `${i}-${c.from.component_id}-${c.to.component_id}`, start, end, color });
    });
    return out;
    // resolveEndpoint closes over `parts` and `dragOverrides`; the
    // referenced inputs are listed explicitly so React picks up drag
    // updates. eslint can't follow the closure capture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, parts, dragOverrides]);

  // Resolve the dolly target — selected pin's world position. Returns null
  // when nothing is selected so the dolly eases back to camera origin.
  const dollyTarget = useMemo<[number, number, number] | null>(() => {
    if (!selectedPin) return null;
    // Find the Uno's part to anchor pin positions to its world transform.
    const uno = parts.find((p) => skuKey(p.sku) === "50");
    if (!uno) return null;
    const unoPos = resolvePartPosition(uno.id);
    if (!unoPos) return null;
    const positions = calculatePinPositions("uno");
    const pinPos = positions[selectedPin];
    if (!pinPos) return null;
    const zSquish = 0.22;
    return [unoPos[0] + pinPos.x, unoPos[1] + 0.12, unoPos[2] + pinPos.z * zSquish];
    // resolvePartPosition closes over `parts` and `dragOverrides`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPin, parts, dragOverrides]);

  return (
    <Canvas
      camera={{ position: [3, 2.5, 4], fov: 45 }}
      dpr={[1, 2]}
      flat
      style={{ width: "100%", height: "100%", touchAction: "none" }}
    >
      <CameraDolly target={dollyTarget} controlsRef={controlsRef} />
      <ambientLight intensity={0.6} />
      <directionalLight position={[5, 5, 5]} intensity={0.8} castShadow />

      {/* Workspace plane — keeps the scene grounded visually. */}
      <Plane args={[8, 8]} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <meshStandardMaterial color={COLORS.workspace} roughness={0.95} />
      </Plane>

      <BreadboardSlab />

      {parts.map((part) => {
        // The breadboard's mesh is rendered as <BreadboardSlab/> above;
        // we still want its hotspot for the click-to-learn workflow.
        const isBreadboard = part.sku === "SKU 239";
        // Prefer SKU-keyed positions (unique per component); fall back to
        // icon-keyed (some icons cover multiple SKUs); then a hard default.
        // The prefix-strip is intentional: the adapter formats `Part.sku`
        // as a display string ("SKU 239"). Falling back to the icon table
        // when a SKU is missing here is acceptable because the adapter
        // throws on truly unknown SKUs at the parts-list boundary
        // (`pipelineToProject` in `data/adapter.ts`).
        const sku = skuKey(part.sku);
        const pos = resolvePartPosition(part.id) ??
          POSITIONS_BY_SKU[sku] ??
          POSITIONS_BY_ICON[part.icon] ??
          [0, 0.2, 0];
        const hotspotY =
          HOTSPOT_Y_OFFSET_BY_SKU[sku] ?? HOTSPOT_Y_OFFSET_BY_ICON[part.icon] ?? 0.5;
        const isActive = selectedPart === part.id;
        const isUno = sku === "50";
        const isDraggable = DRAGGABLE_SKUS.has(sku);

        const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
          if (!isDraggable) return;
          e.stopPropagation();
          const existing = dragOverrides.get(part.id) ?? [0, 0];
          dragRef.current = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            baseDx: existing[0],
            baseDz: existing[1],
            partId: part.id,
          };
          (e.target as Element).setPointerCapture?.(e.pointerId);
          if (controlsRef.current) controlsRef.current.enabled = false;
        };
        const handlePointerMove = (e: ThreeEvent<PointerEvent>) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== e.pointerId || drag.partId !== part.id) return;
          e.stopPropagation();
          const dxPx = e.clientX - drag.startX;
          const dyPx = e.clientY - drag.startY;
          const dxWorld = (dxPx / window.innerWidth) * (1 / DRAG_PIXELS_PER_UNIT);
          // Screen-Y maps to scene-Z (camera looks down at the workspace).
          const dzWorld = (dyPx / window.innerHeight) * (1 / DRAG_PIXELS_PER_UNIT);
          const nextDx = snapTo(drag.baseDx + dxWorld, DRAG_SNAP);
          const nextDz = snapTo(drag.baseDz + dzWorld, DRAG_SNAP);
          setDragOverrides((prev) => {
            const next = new Map(prev);
            next.set(part.id, [nextDx, nextDz]);
            return next;
          });
        };
        const endDrag = (e: ThreeEvent<PointerEvent>) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== e.pointerId || drag.partId !== part.id) return;
          e.stopPropagation();
          (e.target as Element).releasePointerCapture?.(e.pointerId);
          if (controlsRef.current) controlsRef.current.enabled = true;
          dragRef.current = null;
        };

        return (
          <group
            key={part.id}
            position={pos}
            onPointerDown={isDraggable ? handlePointerDown : undefined}
            onPointerMove={isDraggable ? handlePointerMove : undefined}
            onPointerUp={isDraggable ? endDrag : undefined}
            onPointerCancel={isDraggable ? endDrag : undefined}
          >
            {!isBreadboard && <PartMesh part={part} />}
            {/* Pin markers + selected-pin callout live inside the Uno's
                transform group so they inherit its position. */}
            {isUno && (
              <>
                <PinMarkers
                  boardKey="uno"
                  selectedPin={selectedPin}
                  onPinClick={(pin) => {
                    setAutoTour(false);
                    // Selecting a pin keeps the Uno's hotspot consistent.
                    setSelectedPart(part.id);
                    onPinClick(pin);
                  }}
                />
                {selectedPin && <PinCallout boardKey="uno" pin={selectedPin} />}
              </>
            )}
            <Html
              position={[0, hotspotY, 0]}
              center
              zIndexRange={[10, 0]}
              style={{ pointerEvents: "auto" }}
            >
              <button
                type="button"
                className={`hotspot ${part.pulse && !selectedPart ? "pulse" : ""} ${
                  isActive ? "active" : ""
                }`}
                title={part.name}
                aria-label={part.name}
                style={{ cursor: isDraggable ? "grab" : "default" }}
                onClick={(e) => {
                  e.stopPropagation();
                  setAutoTour(false);
                  setSelectedPart(isActive ? null : part.id);
                }}
              />
            </Html>
          </group>
        );
      })}

      {wires.map((w) => (
        <Wire3D key={w.key} start={w.start} end={w.end} color={w.color} />
      ))}

      <OrbitControls
        ref={controlsRef}
        enablePan={false}
        enableDamping
        maxPolarAngle={Math.PI / 2.1}
        minDistance={2.5}
        maxDistance={10}
      />
    </Canvas>
  );
});

export default HeroScene;
