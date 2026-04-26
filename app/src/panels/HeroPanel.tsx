import { useEffect, useMemo, useRef } from "react";
import type { Project } from "../types";

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
        <SceneSvg project={project} />

        {project.parts.map((p) => (
          <button
            key={p.id}
            className={`hotspot ${p.pulse && !selectedPart ? "pulse" : ""} ${selectedPart === p.id ? "active" : ""}`}
            style={{ top: `${p.pos.y}%`, left: `${p.pos.x}%` }}
            title={p.name}
            onClick={() => {
              setAutoTour(false);
              setSelectedPart(selectedPart === p.id ? null : p.id);
            }}
            aria-label={p.name}
          />
        ))}

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
              {sel.id === "uno"
                ? "Microcontroller"
                : sel.id === "bb"
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
          <button title="Reset">⤾ Reset</button>
          <button title="Zoom in">＋</button>
          <button title="Zoom out">−</button>
        </div>
      </div>
    </div>
  );
}

// Static stylized scene — placeholder until the React-Three-Fiber 3D scene
// lands (see docs/PLAN.md, Track 1 weeks 1-2). Visual fidelity is identical
// to the design prototype.
function SceneSvg({ project }: { project: Project }) {
  const hasServo = project.parts.some((p) => p.id === "sg90");
  const sensorLabel = project.parts.find((p) => p.id === "hcsr04")
    ? "HC-SR04"
    : project.parts.find((p) => p.id === "pir")
      ? "PIR"
      : "SENSOR";

  return (
    <svg
      className="hero-svg"
      viewBox="0 0 600 500"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="boardGrad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#1E5C8A" />
          <stop offset="100%" stopColor="#0F3D5F" />
        </linearGradient>
        <linearGradient id="bbGrad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#FBFAF6" />
          <stop offset="100%" stopColor="#E8E2D2" />
        </linearGradient>
        <linearGradient id="servoGrad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#3A4255" />
          <stop offset="100%" stopColor="#1E2230" />
        </linearGradient>
        <radialGradient id="floor" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="rgba(0,0,0,0)" />
          <stop offset="100%" stopColor="rgba(0,0,0,0.18)" />
        </radialGradient>
      </defs>

      <ellipse cx="300" cy="450" rx="240" ry="40" fill="url(#floor)" />

      {/* Breadboard */}
      <g transform="translate(110,260)">
        <rect x="0" y="6" width="380" height="120" rx="6" fill="#A8A095" opacity=".4" />
        <rect x="0" y="0" width="380" height="120" rx="6" fill="url(#bbGrad)" stroke="#C7BFB0" />
        <rect x="0" y="56" width="380" height="8" fill="#D6CFBF" />
        {[14, 26, 38, 82, 94, 106].map((y, i) => (
          <g key={i} fill="#9A938A">
            {Array.from({ length: 24 }, (_, j) => (
              <circle key={j} cx={20 + j * 15} cy={y} r="1.6" />
            ))}
          </g>
        ))}
      </g>

      {/* Arduino Uno */}
      <g transform="translate(60,90)">
        <rect x="6" y="10" width="180" height="120" rx="6" fill="rgba(0,0,0,.15)" />
        <rect x="0" y="0" width="180" height="120" rx="6" fill="url(#boardGrad)" />
        <rect x="-12" y="20" width="24" height="34" rx="2" fill="#B8B5AE" />
        <rect x="-10" y="22" width="20" height="30" fill="#5C564E" />
        <rect x="-8" y="70" width="22" height="22" rx="2" fill="#1A1814" />
        <rect x="80" y="50" width="42" height="50" rx="2" fill="#1A1814" />
        <text x="101" y="80" fill="#5C564E" fontSize="9" textAnchor="middle" fontFamily="monospace">
          ATmega
        </text>
        <rect x="20" y="6" width="140" height="8" fill="#1A1814" />
        <g fill="#C9B27A">
          {Array.from({ length: 13 }, (_, i) => (
            <rect key={i} x={22 + i * 7} y="8" width="3" height="4" />
          ))}
        </g>
        <rect x="40" y="106" width="120" height="8" fill="#1A1814" />
        <g fill="#C9B27A">
          {Array.from({ length: 8 }, (_, i) => (
            <rect key={i} x={42 + i * 7} y="108" width="3" height="4" />
          ))}
        </g>
        <circle cx="160" cy="40" r="3" fill="#7AC74F" />
        <circle cx="160" cy="50" r="3" fill="#E26A2C" />
        <text
          x="90"
          y="64"
          fill="#FAF8F4"
          fontSize="9"
          fontFamily="serif"
          fontStyle="italic"
          textAnchor="middle"
          opacity=".75"
        >
          ARDUINO UNO
        </text>
      </g>

      {/* Sensor */}
      <g transform="translate(180,225)">
        <rect x="4" y="8" width="120" height="40" rx="3" fill="rgba(0,0,0,.18)" />
        <rect x="0" y="0" width="120" height="44" rx="3" fill="#1A4A82" />
        <circle cx="32" cy="22" r="16" fill="#A8A095" stroke="#5C564E" strokeWidth="1.5" />
        <circle cx="32" cy="22" r="11" fill="#3A3530" />
        <circle cx="32" cy="22" r="6" fill="#1A1814" />
        <circle cx="88" cy="22" r="16" fill="#A8A095" stroke="#5C564E" strokeWidth="1.5" />
        <circle cx="88" cy="22" r="11" fill="#3A3530" />
        <circle cx="88" cy="22" r="6" fill="#1A1814" />
        <text x="60" y="40" fill="#FAF8F4" fontSize="6" textAnchor="middle" fontFamily="monospace" opacity=".7">
          {sensorLabel}
        </text>
      </g>

      {/* Servo or LED */}
      {hasServo ? (
        <g transform="translate(380,205)">
          <rect x="6" y="10" width="80" height="64" rx="3" fill="rgba(0,0,0,.18)" />
          <rect x="0" y="0" width="80" height="68" rx="3" fill="url(#servoGrad)" />
          <circle cx="40" cy="20" r="14" fill="#FAF8F4" stroke="#5C564E" strokeWidth="1" />
          <rect x="38" y="6" width="4" height="28" rx="1" fill="#FAF8F4" stroke="#5C564E" strokeWidth=".5" />
          <circle cx="40" cy="20" r="3" fill="#5C564E" />
          <text x="40" y="55" fill="#E8E2D5" fontSize="6" textAnchor="middle" fontFamily="monospace" opacity=".6">
            SG90
          </text>
        </g>
      ) : (
        <g transform="translate(400,210)">
          <circle cx="30" cy="30" r="22" fill="#FFF6CF" opacity="0.4" />
          <circle cx="30" cy="30" r="14" fill="#FFE066" stroke="#C9B27A" strokeWidth="1" />
          <line x1="30" y1="44" x2="30" y2="62" stroke="#5C564E" strokeWidth="2" />
        </g>
      )}

      {/* Connection wires (visual) */}
      <g strokeWidth="2" fill="none" opacity=".75">
        <path d="M 175 145 Q 200 200 215 245" stroke="#C8302C" />
        <path d="M 175 158 Q 195 215 245 250" stroke="#1A1814" />
        <path d="M 175 105 Q 220 160 270 245" stroke="#D9B43C" />
        <path d="M 175 118 Q 250 170 300 245" stroke="#3A6FB8" />
      </g>
    </svg>
  );
}
