import Editor from "@monaco-editor/react";
import type { Project } from "../types";

interface CodePanelProps {
  project: Project;
  onCopy: () => void;
  expanded?: boolean;
  onExpandToggle?: () => void;
}

export default function CodePanel({ project, onCopy, expanded, onExpandToggle }: CodePanelProps) {
  const lineCount = project.sketchSource.split("\n").length;
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
        <Editor
          height="100%"
          defaultLanguage="cpp"
          theme="vs-dark"
          value={project.sketchSource}
          options={{
            readOnly: true,
            minimap: { enabled: false },
            fontSize: 13,
            fontFamily: "JetBrains Mono, ui-monospace, monospace",
            lineNumbers: "on",
            scrollBeyondLastLine: false,
            padding: { top: 12, bottom: 12 },
            renderLineHighlight: "none",
            folding: false,
            wordWrap: "off",
            automaticLayout: true,
          }}
        />
      </div>
    </div>
  );
}
