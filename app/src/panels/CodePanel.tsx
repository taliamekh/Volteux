import type { Project } from "../types";

interface CodePanelProps {
  project: Project;
  onCopy: () => void;
  expanded?: boolean;
  onExpandToggle?: () => void;
}

export default function CodePanel({ project, onCopy, expanded, onExpandToggle }: CodePanelProps) {
  const lineCount = project.code.length;
  return (
    <div className={`panel flex-grow code-panel ${expanded ? "panel-expanded" : ""}`}>
      <div className="panel-head">
        <h3>Code</h3>
        <span className="meta">{lineCount} lines · auto-generated</span>
        <button className="icon-btn-sm" onClick={onCopy} title="Copy code">
          copy
        </button>
        <button
          className="icon-btn-sm"
          onClick={onExpandToggle}
          title={expanded ? "Exit expanded view" : "Open larger"}
          aria-label={expanded ? "Exit expanded view" : "Open larger"}
        >
          {expanded ? "↙" : "↗"}
        </button>
      </div>
      <div className="sketch-body">
        {project.code.map((line, i) => (
          <div className="sketch-line" key={i}>
            <span className="ln">{line.kind === "blank" ? "" : i + 1}</span>
            <span className="code">
              {line.kind === "com" && <span className="com">{line.text}</span>}
              {line.kind === "raw" &&
                line.parts.map((p, j) =>
                  p.k ? (
                    <span key={j} className={p.k}>
                      {p.t}
                    </span>
                  ) : (
                    <span key={j}>{p.t}</span>
                  ),
                )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
