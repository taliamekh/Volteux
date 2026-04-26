import { useEffect, useRef, useState } from "react";
import type { ChatMessage, Project } from "../types";

interface ChatPanelProps {
  project: Project;
  onRefine: (refinement: string) => void;
  refining: boolean;
  refineToast: string | null;
}

export default function ChatPanel({ project, onRefine, refining, refineToast }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastToastRef = useRef<string | null>(null);

  // Reset on new project
  useEffect(() => {
    const projectName = project?.title ?? "project";
    setMessages([
      {
        role: "assistant",
        kind: "intro",
        text: `Your ${projectName} is ready. Ask me to change anything — the parts, the timing, the behavior — and I'll update the design live.`,
      },
    ]);
    setText("");
    lastToastRef.current = null;
  }, [project?.key, project?.title]);

  // Append refine toast as the assistant's reply.
  useEffect(() => {
    if (!refineToast || refineToast === lastToastRef.current) return;
    lastToastRef.current = refineToast;
    setMessages((prev) => [...prev, { role: "assistant", kind: "update", text: refineToast }]);
  }, [refineToast]);

  // Auto-scroll on new messages.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, refining]);

  const send = (raw?: string) => {
    const v = (typeof raw === "string" ? raw : text).trim();
    if (!v || refining) return;
    setMessages((prev) => [...prev, { role: "user", text: v }]);
    setText("");
    onRefine(v);
  };

  const suggestions = project?.refineSuggestions ?? [];

  return (
    <aside className="chat-panel">
      <div className="chat-head">
        <div className="chat-head-l">
          <span className="chat-dot" />
          <strong>Chat with Volteux</strong>
        </div>
        <span className="chat-meta">refines your design live</span>
      </div>

      <div className="chat-scroll" ref={scrollRef}>
        {messages.map((m, i) => {
          const kind = m.role === "assistant" ? m.kind ?? "" : "";
          return (
            <div key={i} className={`chat-msg ${m.role} ${kind}`}>
              {m.role === "assistant" && (
                <div className="chat-avatar" aria-hidden="true">
                  V
                </div>
              )}
              <div className="chat-bubble">{m.text}</div>
            </div>
          );
        })}
        {refining && (
          <div className="chat-msg assistant typing">
            <div className="chat-avatar" aria-hidden="true">
              V
            </div>
            <div className="chat-bubble typing-bubble">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
      </div>

      {suggestions.length > 0 && (
        <div className="chat-quickreplies">
          {suggestions.map((s, i) => (
            <button
              key={i}
              className="chat-chip"
              onClick={() => send(s)}
              disabled={refining}
              title="Send as a chat message"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <form
        className="chat-input-row"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          type="text"
          className="chat-input"
          placeholder="Ask for a change — e.g. make the wave slower"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={refining}
        />
        <button
          type="submit"
          className="chat-send"
          disabled={refining || !text.trim()}
          aria-label="Send"
          title="Send"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </form>
    </aside>
  );
}
