import type { CSSProperties, ReactNode } from "react";
import type { Tweaks } from "../types";

interface TweaksPanelProps {
  tweaks: Tweaks;
  setTweak: <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => void;
  onClose: () => void;
}

const PANEL_STYLE: CSSProperties = {
  position: "fixed",
  bottom: 24,
  right: 24,
  width: 280,
  background: "var(--surface)",
  border: "1px solid var(--line-2)",
  borderRadius: 10,
  boxShadow: "var(--shadow-lg)",
  padding: 16,
  zIndex: 200,
  fontSize: 13,
};

export default function TweaksPanel({ tweaks, setTweak, onClose }: TweaksPanelProps) {
  return (
    <div style={PANEL_STYLE}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
        <strong style={{ flex: 1, fontFamily: "var(--display)", fontSize: 15 }}>Tweaks</strong>
        <button
          onClick={onClose}
          style={{
            background: "transparent",
            border: 0,
            color: "var(--ink-3)",
            cursor: "pointer",
            fontSize: 18,
            padding: 0,
            width: 24,
            height: 24,
          }}
        >
          ×
        </button>
      </div>

      <TweakRow label="Palette">
        <Segmented
          value={tweaks.palette}
          options={[
            { v: "violet", l: "Violet" },
            { v: "amber", l: "Amber" },
            { v: "mint", l: "Mint" },
          ]}
          onChange={(v) => setTweak("palette", v)}
        />
      </TweakRow>

      <TweakRow label="Density">
        <Segmented
          value={tweaks.density}
          options={[
            { v: "compact", l: "Compact" },
            { v: "default", l: "Default" },
            { v: "roomy", l: "Roomy" },
          ]}
          onChange={(v) => setTweak("density", v)}
        />
      </TweakRow>

      <TweakRow label="Display type">
        <Segmented
          value={tweaks.type}
          options={[
            { v: "exo", l: "Exo 2" },
            { v: "serif", l: "Serif" },
            { v: "mono", l: "Mono" },
          ]}
          onChange={(v) => setTweak("type", v)}
        />
      </TweakRow>

      <TweakRow label="Slogan font">
        <select
          value={tweaks.slogan}
          onChange={(e) => setTweak("slogan", e.target.value as Tweaks["slogan"])}
          style={{
            width: "100%",
            background: "var(--metal-input)",
            border: "1px solid var(--line-2)",
            color: "var(--ink)",
            padding: "7px 10px",
            borderRadius: 6,
            fontFamily: "var(--sans)",
            fontSize: 12,
          }}
        >
          <option value="exo">Exo 2 (default — modern geometric)</option>
          <option value="grotesk">Space Grotesk (friendly geometric)</option>
          <option value="bricolage">Bricolage Grotesque (editorial display)</option>
          <option value="geist">Geist (neutral confident)</option>
          <option value="instrument">Instrument Serif (high-contrast classical)</option>
          <option value="fragment">Fragment Mono (typewriter indie)</option>
          <option value="bungee">Bungee (chunky signage)</option>
        </select>
      </TweakRow>

      <TweakRow label="Use AI for refine summary">
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={tweaks.useAi}
            onChange={(e) => setTweak("useAi", e.target.checked)}
          />
          <span style={{ color: "var(--ink-3)", fontSize: 11 }}>
            Off = free / canned. On = stub today; will call Anthropic when wired.
          </span>
        </label>
      </TweakRow>
    </div>
  );
}

function TweakRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: ".1em",
          color: "var(--ink-3)",
          marginBottom: 6,
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

interface SegmentedProps<T extends string> {
  value: T;
  options: { v: T; l: string }[];
  onChange: (v: T) => void;
}

function Segmented<T extends string>({ value, options, onChange }: SegmentedProps<T>) {
  return (
    <div
      style={{
        display: "flex",
        background: "var(--bg)",
        border: "1px solid var(--line)",
        borderRadius: 6,
        padding: 2,
      }}
    >
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          style={{
            flex: 1,
            padding: "5px 4px",
            border: 0,
            background: value === o.v ? "var(--accent)" : "transparent",
            color: value === o.v ? "var(--bg)" : "var(--ink-2)",
            borderRadius: 4,
            fontSize: 11,
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          {o.l}
        </button>
      ))}
    </div>
  );
}
