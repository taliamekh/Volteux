import { useEffect, useState } from "react";
import ResizableRow from "../components/ResizableRow";
import HeroPanel from "../panels/HeroPanel";
import WiringPanel from "../panels/WiringPanel";
import CodePanel from "../panels/CodePanel";
import PartsPanel from "../panels/PartsPanel";
import ChatPanel from "./ChatPanel";
import type { ExpandedPanel, Project } from "../types";

interface ResultViewProps {
  project: Project;
  onRefine: (refinement: string) => void;
  refining: boolean;
  onFlash: () => void;
  refineToast: string | null;
}

export default function ResultView({
  project,
  onRefine,
  refining,
  onFlash,
  refineToast,
}: ResultViewProps) {
  const [selectedPart, setSelectedPart] = useState<string | null>(null);
  const [autoTour, setAutoTour] = useState(false);
  const [owned, setOwned] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState<ExpandedPanel>(null);

  // Reset on new project
  useEffect(() => {
    setSelectedPart(null);
    setAutoTour(false);
    setOwned({});
    setExpanded(null);
  }, [project.key]);

  // Esc closes the expanded panel
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const toggleExpand = (which: NonNullable<ExpandedPanel>) => () => {
    setExpanded((prev) => (prev === which ? null : which));
  };

  const copyCode = () => {
    const code = project.code
      .map((l) => {
        if (l.kind === "com") return l.text;
        if (l.kind === "blank") return "";
        return l.parts.map((p) => p.t).join("");
      })
      .join("\n");
    navigator.clipboard?.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <>
      <div className="result-grid">
        <ResizableRow className="top-row" initialWeights={[7, 3]} minPx={300}>
          <HeroPanel
            project={project}
            selectedPart={selectedPart}
            setSelectedPart={setSelectedPart}
            autoTour={autoTour}
            setAutoTour={setAutoTour}
          />
          <ChatPanel
            project={project}
            onRefine={onRefine}
            refining={refining}
            refineToast={refineToast}
          />
        </ResizableRow>

        <ResizableRow className="bottom-panels" initialWeights={[1, 1, 1.15]} minPx={280}>
          <CodePanel
            project={project}
            expanded={expanded === "code"}
            onExpandToggle={toggleExpand("code")}
            onCopy={copyCode}
          />
          <WiringPanel
            project={project}
            expanded={expanded === "wiring"}
            onExpandToggle={toggleExpand("wiring")}
          />
          <PartsPanel project={project} owned={owned} setOwned={setOwned} />
        </ResizableRow>
      </div>

      {expanded && (
        <div
          className="panel-expand-backdrop"
          onClick={() => setExpanded(null)}
          aria-label="Close expanded view"
        />
      )}

      <div className="footer-cta">
        <div className="footer-meta">
          <span className="item">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 12l2 2 4-4" />
              <circle cx="12" cy="12" r="9" />
            </svg>
            Compiled (3.2 KB)
          </span>
          <span className="item">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 12l2 2 4-4" />
              <circle cx="12" cy="12" r="9" />
            </svg>
            Wiring checked
          </span>
        </div>
        <button className="btn-share">Share</button>
        <button className="btn-flash" onClick={onFlash}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
          Flash to my Uno
        </button>
      </div>

      {copied && (
        <div className="toast visible">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          Code copied to clipboard
        </div>
      )}
    </>
  );
}
