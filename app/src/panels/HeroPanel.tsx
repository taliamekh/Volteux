// KAI-DONE (Unit 6): Added selectedPin state + pin info card. The state
// flows down into <HeroScene /> for the pin markers and back up via
// onPinClick. Selecting a pin also locks the Uno's selectedPart so the
// existing hotspot/callout stays consistent.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "../types";
import HeroScene, { type HeroSceneHandle } from "./HeroScene";
import { lookupBySku } from "../../../components/registry";

interface HeroPanelProps {
  project: Project;
  selectedPart: string | null;
  setSelectedPart: (id: string | null) => void;
  autoTour: boolean;
  setAutoTour: (v: boolean) => void;
}

// Pin direction colors — semantic, not decorative. Mirrors the registry's
// PinDirection union (loose lookup; unknown directions fall back to gray).
const PIN_DIRECTION_COLORS: Readonly<Record<string, string>> = {
  power_in: "#FF6B6B",
  ground: "#4A4A55",
  digital_io: "#4ECDC4",
  digital_input: "#7FD8C4",
  digital_output: "#7FD8C4",
  analog_input: "#A78BFA",
  pwm_output: "#FFB347",
  i2c_sda: "#F472B6",
  i2c_scl: "#F472B6",
};

// Find the Uno's part id for a given project so a pin selection can keep
// the existing hotspot consistent with the new pin sidebar.
function findUnoPartId(project: Project): string | null {
  const uno = project.parts.find((p) =>
    p.sku === "SKU 50" || p.sku === "50",
  );
  return uno ? uno.id : null;
}

export default function HeroPanel({
  project,
  selectedPart,
  setSelectedPart,
  autoTour,
  setAutoTour,
}: HeroPanelProps) {
  const heroRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<HeroSceneHandle | null>(null);
  const [selectedPin, setSelectedPin] = useState<string | null>(null);

  // Auto-tour cycles through hotspots every ~2.8s
  useEffect(() => {
    if (!autoTour) return;
    const ids = project.parts.map((p) => p.id);
    let idx = selectedPart ? ids.indexOf(selectedPart) : -1;
    const tick = () => {
      idx = (idx + 1) % ids.length;
      setSelectedPart(ids[idx]!);
    };
    const i = window.setInterval(tick, 2800);
    return () => window.clearInterval(i);
    // selectedPart intentionally excluded — we read it once at start
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTour, project.key]);

  // Clear the selected pin whenever the project itself changes.
  useEffect(() => {
    setSelectedPin(null);
  }, [project.key]);

  const partById = useMemo(() => {
    const m: Record<string, (typeof project.parts)[number]> = {};
    project.parts.forEach((p) => (m[p.id] = p));
    return m;
  }, [project]);

  const sel = selectedPart ? partById[selectedPart] : null;

  const unoMeta = useMemo(() => lookupBySku("50"), []);
  const selectedPinMeta = useMemo(() => {
    if (!selectedPin || !unoMeta) return null;
    return unoMeta.pin_metadata.find((p) => p.label === selectedPin) ?? null;
  }, [selectedPin, unoMeta]);

  const handlePinClick = (pin: string | null) => {
    setSelectedPin(pin);
    if (pin) {
      const unoId = findUnoPartId(project);
      if (unoId) setSelectedPart(unoId);
    }
  };

  // Place callout to the right of hotspot if hotspot is on the left half, else left of it.
  // The hotspots themselves are now rendered inside the 3D scene via drei <Html>,
  // but the existing Part.pos.x/y screen-percent values still drive callout placement
  // so the chrome keeps its familiar feel.
  const calloutPos = useMemo(() => {
    if (!sel) return null;
    const onRight = sel.pos.x > 55;
    const top = `calc(${sel.pos.y}% - 10px)`;
    if (onRight) {
      return { right: `calc(${100 - sel.pos.x}% + 24px)`, top, side: "right" as const };
    }
    return { left: `calc(${sel.pos.x}% + 24px)`, top, side: "left" as const };
  }, [sel]);

  const directionColor = selectedPinMeta
    ? PIN_DIRECTION_COLORS[selectedPinMeta.direction] ?? "#888"
    : "#888";

  return (
    <div className="hero">
      <div className="hero-canvas" ref={heroRef}>
        <HeroScene
          ref={sceneRef}
          parts={project.parts}
          selectedPart={selectedPart}
          setSelectedPart={setSelectedPart}
          setAutoTour={setAutoTour}
          selectedPin={selectedPin}
          onPinClick={handlePinClick}
        />

        {sel && calloutPos && (
          <div
            className={`callout ${calloutPos.side === "right" ? "right-side" : ""}`}
            style={{
              top: calloutPos.top,
              left: "left" in calloutPos ? calloutPos.left : undefined,
              right: "right" in calloutPos ? calloutPos.right : undefined,
            }}
          >
            <button className="close-x" onClick={() => setSelectedPart(null)} aria-label="Close">
              ×
            </button>
            <div className="label">
              {sel.id === "u1"
                ? "Microcontroller"
                : sel.id === "b1"
                  ? "Workspace"
                  : "Component"}
            </div>
            <div className="name">{sel.name}</div>
            <div className="blurb">{sel.desc}</div>
            <div className="pin-list">
              {sel.qty > 1 ? `${sel.qty}× ` : ""}
              {sel.sku}
            </div>
          </div>
        )}

        {selectedPin && (
          <div className="pin-info-card">
            <button
              className="close-x"
              onClick={() => setSelectedPin(null)}
              aria-label="Close pin info"
            >
              ×
            </button>
            <div className="pin-info-label">Pin {selectedPin}</div>
            {selectedPinMeta && (
              <>
                <div
                  className="pin-info-direction"
                  style={{ color: directionColor }}
                >
                  {selectedPinMeta.direction}
                </div>
                <div className="pin-info-description">
                  {selectedPinMeta.description}
                </div>
              </>
            )}
            {!selectedPinMeta && (
              <div className="pin-info-description">
                Pin metadata not available.
              </div>
            )}
          </div>
        )}

        <div className="hero-hint">
          <span className="dot" />
          <span>Click any part to learn what it does</span>
        </div>

        <button
          className="hero-tour"
          onClick={() => setAutoTour(!autoTour)}
          title={autoTour ? "Stop tour" : "Start tour"}
        >
          <span>{autoTour ? "Touring…" : "Tour parts"}</span>
          <span className="play-dot">
            {autoTour ? (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="5" width="4" height="14" />
                <rect x="14" y="5" width="4" height="14" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="6,4 20,12 6,20" />
              </svg>
            )}
          </span>
        </button>

        <div className="hero-controls">
          <button title="Reset" onClick={() => sceneRef.current?.resetCamera()}>
            ⤾ Reset
          </button>
        </div>
      </div>
    </div>
  );
}
