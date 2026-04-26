import type { Project, WireColor } from "../types";

interface WiringPanelProps {
  project: Project;
  expanded?: boolean;
  onExpandToggle?: () => void;
}

const WIRE_COLORS: Record<WireColor, string> = {
  red: "#C8302C",
  black: "#1A1814",
  yellow: "#D9B43C",
  blue: "#3A6FB8",
  green: "#5DA34A",
  purple: "#9B6FE0",
};

export default function WiringPanel({ project, expanded, onExpandToggle }: WiringPanelProps) {
  const hasServo = project.parts.some((p) => p.id === "sg90");
  const hasBuzzer = project.parts.some((p) => p.id === "buzzer");
  const sensorLabel = project.parts.find((p) => p.id === "hcsr04")
    ? "HC-SR04"
    : project.parts.find((p) => p.id === "pir")
      ? "PIR"
      : "SENSOR";

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
          viewBox="0 0 480 200"
          preserveAspectRatio="xMidYMid meet"
          xmlns="http://www.w3.org/2000/svg"
        >
          <rect x="20" y="30" width="440" height="130" rx="8" fill="#FBFAF6" stroke="#C7BFB0" />

          <g fill="#9A938A" fontSize="7" fontFamily="monospace" textAnchor="middle">
            <text x="50" y="25">1</text>
            <text x="80" y="25">5</text>
            <text x="110" y="25">10</text>
            <text x="140" y="25">15</text>
            <text x="170" y="25">20</text>
            <text x="200" y="25">25</text>
            <text x="230" y="25">30</text>
          </g>
          <g fill="#9A938A" fontSize="8" fontFamily="monospace">
            <text x="10" y="50">a</text>
            <text x="10" y="64">b</text>
            <text x="10" y="78">c</text>
            <text x="10" y="92">d</text>
            <text x="10" y="120">e</text>
            <text x="10" y="134">f</text>
            <text x="10" y="148">g</text>
          </g>

          <rect x="20" y="100" width="440" height="6" fill="#E5DFD3" />

          {[50, 64, 78, 92, 116, 130, 144].map((y, ri) => (
            <g key={ri} fill="#9A938A">
              {Array.from({ length: 13 }, (_, ci) => (
                <circle key={ci} cx={50 + ci * 15} cy={y} r="1.4" />
              ))}
            </g>
          ))}

          <g transform="translate(110,45)">
            <rect x="0" y="0" width="80" height="48" rx="2" fill="#1A4A82" stroke="#0A2940" />
            <circle cx="20" cy="22" r="10" fill="#A8A095" />
            <circle cx="20" cy="22" r="6" fill="#3A3530" />
            <circle cx="60" cy="22" r="10" fill="#A8A095" />
            <circle cx="60" cy="22" r="6" fill="#3A3530" />
            <text x="40" y="42" fill="#FBFAF6" fontSize="5" textAnchor="middle" fontFamily="monospace">
              {sensorLabel}
            </text>
          </g>

          {hasServo ? (
            <g transform="translate(280,40)">
              <rect x="0" y="0" width="44" height="36" rx="2" fill="#3A4255" />
              <circle cx="22" cy="14" r="8" fill="#FBFAF6" />
              <text x="22" y="32" fill="#E8E2D5" fontSize="5" textAnchor="middle" fontFamily="monospace">
                SG90
              </text>
            </g>
          ) : (
            <g transform="translate(290,55)">
              <circle cx="14" cy="14" r="10" fill="#FFE066" stroke="#C9B27A" />
              <text x="14" y="40" fill="#5C564E" fontSize="5" textAnchor="middle" fontFamily="monospace">
                LED
              </text>
            </g>
          )}

          <g strokeWidth="2" fill="none">
            <path d="M 130 45 Q 130 18 280 18 Q 280 40 280 40" stroke="#C8302C" strokeLinecap="round" />
            <path d="M 145 45 Q 145 14 295 14 Q 295 40 295 40" stroke="#1A1814" strokeLinecap="round" />
            <path d="M 160 45 Q 160 25 195 25 Q 195 110 230 140" stroke="#D9B43C" strokeLinecap="round" />
            <path d="M 175 45 Q 175 30 210 30 Q 210 125 245 150" stroke="#3A6FB8" strokeLinecap="round" />
            <path d="M 280 60 Q 250 80 200 110 Q 180 125 165 145" stroke="#5DA34A" strokeLinecap="round" />
            {hasBuzzer && <path d="M 300 75 Q 280 95 220 130" stroke="#9B6FE0" strokeLinecap="round" />}
          </g>

          <g transform="translate(20,180)" fontSize="8" fontFamily="monospace" fill="#9A938A">
            {project.wiring.slice(0, 5).map((w, i) => (
              <g key={i} transform={`translate(${i * 90}, 0)`}>
                <circle cx="6" cy="0" r="3" fill={WIRE_COLORS[w.color] ?? "#888"} />
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
