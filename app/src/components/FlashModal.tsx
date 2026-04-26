import { useEffect, useState } from "react";
import type { Project } from "../types";

interface FlashModalProps {
  open: boolean;
  onClose: () => void;
  project: Project | null;
}

const STEPS = [
  { id: "connect", label: "Connecting to your Uno", duration: 700 },
  { id: "compile", label: "Compiling your sketch", duration: 900 },
  { id: "upload", label: "Uploading to the board", duration: 1100 },
  { id: "verify", label: "Verifying", duration: 600 },
] as const;
type StepId = (typeof STEPS)[number]["id"] | "done";

export default function FlashModal({ open, onClose, project }: FlashModalProps) {
  const [active, setActive] = useState<number>(0);
  const [phase, setPhase] = useState<StepId>("connect");

  // Auto-advance through steps when modal opens; reset when it closes.
  useEffect(() => {
    if (!open) {
      setActive(0);
      setPhase("connect");
      return;
    }
    let cancelled = false;
    let i = 0;
    const tick = () => {
      if (cancelled) return;
      if (i < STEPS.length) {
        setActive(i);
        setPhase(STEPS[i]!.id);
        const dur = STEPS[i]!.duration;
        i++;
        window.setTimeout(tick, dur);
      } else {
        setActive(STEPS.length);
        setPhase("done");
      }
    };
    tick();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Esc closes
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const isDone = phase === "done";

  return (
    <div className="auth-overlay" onClick={onClose}>
      <div className="auth-modal flash-modal" onClick={(e) => e.stopPropagation()}>
        <button className="auth-close" onClick={onClose} aria-label="Close">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        <h2 className="auth-title">{isDone ? "Done!" : "Flashing your Uno"}</h2>
        <p className="auth-sub">
          {isDone
            ? `Your "${project?.title ?? "project"}" is now running on your board.`
            : `Sending "${project?.title ?? "your project"}" to your Arduino…`}
        </p>

        {!isDone ? (
          <div className="flash-stepper">
            {STEPS.map((s, i) => (
              <div
                key={s.id}
                className={`flash-step ${
                  i < active ? "complete" : i === active ? "active" : ""
                }`}
              >
                <div className="flash-step-icon" aria-hidden="true">
                  {i < active ? "✓" : i === active ? "•" : ""}
                </div>
                <div className="flash-step-label">{s.label}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flash-success">
            <div className="flash-success-mark" aria-hidden="true">
              <svg
                width="56"
                height="56"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <p>
              Unplug and replug your USB cable to keep watching it run, or close this and
              tweak the design.
            </p>
            <button className="auth-submit" onClick={onClose}>
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
