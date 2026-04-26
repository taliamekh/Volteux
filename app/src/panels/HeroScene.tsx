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

import { forwardRef, useImperativeHandle, useRef } from "react";
import { Canvas } from "@react-three/fiber";
import { Box, Cylinder, Html, OrbitControls, Plane, Sphere } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { IconKind, Part } from "../types";

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

// ---------- Per-part mesh ----------

interface PartMeshProps {
  part: Part;
}

function PartMesh({ part }: PartMeshProps) {
  switch (part.icon) {
    case "board":
      // Arduino Uno: blue PCB. Breadboard (also `board`) is rendered
      // separately as a static cream slab below — see <BreadboardSlab/>.
      return (
        <Box args={[2, 0.18, 1.4]} castShadow receiveShadow>
          <meshStandardMaterial color={COLORS.pcbBlue} roughness={0.55} metalness={0.1} />
        </Box>
      );

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
  return (
    <Box args={[3.2, 0.15, 1.6]} position={[0.2, 0.075, 0]} receiveShadow>
      <meshStandardMaterial color={COLORS.breadboardCream} roughness={0.85} />
    </Box>
  );
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
}

const HeroScene = forwardRef<HeroSceneHandle, HeroSceneProps>(function HeroScene(
  { parts, selectedPart, setSelectedPart, setAutoTour },
  ref,
) {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);

  useImperativeHandle(ref, () => ({
    resetCamera: () => {
      controlsRef.current?.reset();
    },
  }));

  return (
    <Canvas
      camera={{ position: [3, 2.5, 4], fov: 45 }}
      dpr={[1, 2]}
      flat
      style={{ width: "100%", height: "100%", touchAction: "none" }}
    >
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
        const isBreadboard = part.sku === "239";
        // Prefer SKU-keyed positions (unique per component); fall back to
        // icon-keyed (some icons cover multiple SKUs); then a hard default.
        // Falling back to the icon table when a SKU is missing here is
        // acceptable because the adapter throws on truly unknown SKUs at
        // the parts-list boundary (`pipelineToProject` in `data/adapter.ts`).
        const pos = POSITIONS_BY_SKU[part.sku] ?? POSITIONS_BY_ICON[part.icon] ?? [0, 0.2, 0];
        const hotspotY =
          HOTSPOT_Y_OFFSET_BY_SKU[part.sku] ?? HOTSPOT_Y_OFFSET_BY_ICON[part.icon] ?? 0.5;
        const isActive = selectedPart === part.id;

        return (
          <group key={part.id} position={pos}>
            {!isBreadboard && <PartMesh part={part} />}
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
