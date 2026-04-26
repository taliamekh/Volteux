import { useEffect, useMemo, useRef } from "react";
import type { Project } from "../types";
import HeroScene, { type HeroSceneHandle } from "./HeroScene";

interface HeroPanelProps {
  project: Project;
  selectedPart: string | null;
  setSelectedPart: (id: string | null) => void;
  autoTour: boolean;
  setAutoTour: (v: boolean) => void;
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

  const partById = useMemo(() => {
    const m: Record<string, (typeof project.parts)[number]> = {};
    project.parts.forEach((p) => (m[p.id] = p));
    return m;
  }, [project]);

  const sel = selectedPart ? partById[selectedPart] : null;

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

  return (
    <div className="hero">
      <div className="hero-canvas" ref={heroRef}>
        <HeroScene
          ref={sceneRef}
          parts={project.parts}
          selectedPart={selectedPart}
          setSelectedPart={setSelectedPart}
          setAutoTour={setAutoTour}
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
              SKU {sel.sku}
            </div>
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
