import { Fragment, useEffect, useState } from "react";

interface LoadingViewProps {
  prompt: string;
  onComplete: () => void;
}

interface Step {
  id: string;
  label: string;
  icon: string;
  duration: number;
}

const STEPS: Step[] = [
  { id: "read", label: "Reading your idea", icon: "📖", duration: 800 },
  { id: "parts", label: "Picking the parts", icon: "🔍", duration: 1500 },
  { id: "code", label: "Writing your sketch", icon: "✎", duration: 2200 },
  { id: "compile", label: "Compiling for Arduino", icon: "⚙", duration: 1500 },
  { id: "wire", label: "Checking the wiring", icon: "⎘", duration: 1200 },
];

export default function LoadingView({ prompt, onComplete }: LoadingViewProps) {
  const [active, setActive] = useState(0);
  const [statusText, setStatusText] = useState("Reading your idea…");

  useEffect(() => {
    let cancelled = false;
    let i = 0;

    const advance = () => {
      if (cancelled) return;
      const step = STEPS[i]!;
      setStatusText(`${step.label}…`);
      window.setTimeout(() => {
        if (cancelled) return;
        i++;
        if (i < STEPS.length) {
          setActive(i);
          advance();
        } else {
          setStatusText("Done. Loading your project…");
          window.setTimeout(() => !cancelled && onComplete(), 500);
        }
      }, step.duration);
    };
    advance();

    return () => {
      cancelled = true;
    };
  }, [onComplete]);

  return (
    <div className="progress-overlay">
      <div className="progress-prompt">{prompt}</div>
      <div className="progress-sub">This usually takes about 8 seconds.</div>

      <div className="stepper">
        {STEPS.map((s, i) => (
          <Fragment key={s.id}>
            <div className={`step ${i < active ? "complete" : i === active ? "active" : ""}`}>
              <div className="step-icon">{i < active ? "✓" : s.icon}</div>
              <div className="step-label">{s.label}</div>
            </div>
            {i < STEPS.length - 1 && (
              <div className={`step-connector ${i < active ? "done" : ""}`} />
            )}
          </Fragment>
        ))}
      </div>

      <div className="progress-status">{statusText}</div>
    </div>
  );
}
