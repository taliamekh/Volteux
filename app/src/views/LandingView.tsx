import { useEffect, useRef, useState } from "react";
import { examples } from "../data/projects";

interface LandingViewProps {
  onSubmit: (prompt: string) => void;
  onSeeExample: () => void;
  setHeaderCtaVisible: (v: boolean) => void;
  /**
   * Set when the previous build attempt failed (pipeline returned
   * Honest Gap, or transport/timeout). Renders a beginner-readable
   * banner above the prompt input. Cleared on next submit.
   */
  loadError?: {
    kind: string;
    headline: string;
    detail?: string;
  } | null;
  /** Optional retry callback — if provided, the banner shows a "Try again" button. */
  onRetry?: () => void;
}

export default function LandingView({
  onSubmit,
  onSeeExample,
  setHeaderCtaVisible,
  loadError,
  onRetry,
}: LandingViewProps) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const heroInputRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Sticky CTA when hero input scrolls out of view.
  useEffect(() => {
    if (!heroInputRef.current || !scrollRef.current) return;
    const obs = new IntersectionObserver(
      (entries) => entries.forEach((e) => setHeaderCtaVisible(!e.isIntersecting)),
      { root: scrollRef.current, threshold: 0 },
    );
    obs.observe(heroInputRef.current);
    return () => obs.disconnect();
  }, [setHeaderCtaVisible]);

  // Allow header CTA click to scroll back + focus the prompt input.
  useEffect(() => {
    (window as Window & { __volteux_focusInput?: () => void }).__volteux_focusInput = () => {
      scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      window.setTimeout(() => inputRef.current?.focus(), 400);
    };
  }, []);

  const submit = () => {
    const v = text.trim();
    if (!v) {
      inputRef.current?.focus();
      return;
    }
    onSubmit(v);
  };
  const submitExample = (s: string) => {
    setText(s);
    window.setTimeout(() => onSubmit(s), 280);
  };

  return (
    <div className="empty" ref={scrollRef}>
      <section className="landing-hero">
        <div className="orb orb-1" />
        <div className="orb orb-2" />

        <div className="eyebrow">
          <span className="pill">v0 · beta</span>
          <span>AI builds the hardware project you describe</span>
        </div>

        <h1 className="landing-tagline">
          Type your idea.
          <br />
          <span className="accent">We'll build it.</span>
        </h1>

        <p className="landing-sub">
          Describe what you want to make in the box below. We'll pick the parts, write the
          code, and teach you what every piece does.
        </p>

        {loadError && (
          <div className="landing-error" role="alert" aria-live="polite">
            <div className="landing-error-headline">{loadError.headline}</div>
            {loadError.detail && (
              <div className="landing-error-detail">{loadError.detail}</div>
            )}
            {onRetry && (
              <button className="landing-error-retry" onClick={onRetry}>
                Try again
              </button>
            )}
          </div>
        )}

        <div className="empty-input-wrap" ref={heroInputRef}>
          <input
            ref={inputRef}
            type="text"
            placeholder="e.g. a robot arm that waves when something gets close..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
          <button onClick={submit} disabled={!text.trim()}>
            Build it
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </button>
        </div>

        <div className="examples">
          <span className="example-label">Or try one of these</span>
          {examples.map((s, i) => (
            <button className="chip" key={i} onClick={() => submitExample(s)}>
              {s}
            </button>
          ))}
        </div>

        <button className="see-example" onClick={onSeeExample}>
          <span>or — see a finished project first</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="7" y1="17" x2="17" y2="7" />
            <polyline points="7 7 17 7 17 17" />
          </svg>
        </button>
      </section>

      <div className="trust-strip">
        <div className="trust-item">
          <span className="dot" /> Built for absolute beginners
        </div>
        <div className="trust-item">
          <span className="dot" /> Real code you can trust, fully commented
        </div>
        <div className="trust-item">
          <span className="dot" /> Flash to your board in one click
        </div>
      </div>

      <div className="scope-strip">
        <span className="scope-label">Today</span>
        <span>Arduino Uno</span>
        <span className="scope-divider">·</span>
        <span className="scope-label">Coming soon</span>
        <span>ESP32 · Pi Pico · custom maker projects · 3D-printed parts · drones · robotics</span>
      </div>

      <section className="landing-section">
        <div className="section-eyebrow">What you'll see</div>
        <h2 className="section-title">Four views of your project, generated in seconds</h2>
        <p className="section-sub">
          Every Volteux project gives you the same four panels — so you understand what you're
          building from every angle.
        </p>

        <div className="preview-grid">
          {[
            {
              icon: "polygon",
              title: "3D component view",
              desc: "An interactive scene of every part. Click a component to learn what it is and what it does.",
            },
            {
              icon: "rect",
              title: "Wiring diagram",
              desc: "A clean, color-coded breadboard layout you can copy when your real parts arrive.",
            },
            {
              icon: "chevrons",
              title: "Arduino sketch",
              desc: "The full C++ code with beginner-friendly comments explaining what every section does.",
            },
            {
              icon: "cart",
              title: "Parts to buy",
              desc: "An Adafruit cart pre-filled with exactly what you need. Already own something? Just check it off.",
            },
          ].map((c, i) => (
            <div className="preview-card" key={i}>
              <div className="icon">
                {c.icon === "polygon" && (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="12 2 2 7 12 12 22 7 12 2" />
                    <polyline points="2 17 12 22 22 17" />
                    <polyline points="2 12 12 17 22 12" />
                  </svg>
                )}
                {c.icon === "rect" && (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="6" width="18" height="12" rx="2" />
                    <path d="M7 6v12M11 6v12M15 6v12" />
                  </svg>
                )}
                {c.icon === "chevrons" && (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="16 18 22 12 16 6" />
                    <polyline points="8 6 2 12 8 18" />
                  </svg>
                )}
                {c.icon === "cart" && (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="9" cy="21" r="1" />
                    <circle cx="20" cy="21" r="1" />
                    <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
                  </svg>
                )}
              </div>
              <h3>{c.title}</h3>
              <p>{c.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-section">
        <div className="section-eyebrow">How it works</div>
        <h2 className="section-title">From idea to flashed Arduino in three steps</h2>
        <p className="section-sub">
          No prior electronics experience required. Volteux is built for the person who just
          opened their first kit.
        </p>

        <div className="steps-grid">
          {[
            {
              n: "01",
              h: "Tell us your idea",
              p: "Type what you want to build in plain English. \"A light that turns on when my hand is over it.\" Anything that fits an Arduino starter kit project.",
            },
            {
              n: "02",
              h: "We design it in seconds",
              p: "Volteux picks the right parts, writes your code, lays out the wiring, and renders an interactive view of the whole build.",
            },
            {
              n: "03",
              h: "Buy parts. Flash. Done.",
              p: "One click sends a pre-filled cart to your parts supplier. When your hardware arrives, plug in your board and click Flash — your code is on it in seconds.",
            },
          ].map((s, i) => (
            <div className="step-card" key={i}>
              <span className="num">{s.n}</span>
              <h3>{s.h}</h3>
              <p>{s.p}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="landing-footer">
        <div className="wordmark">
          Volteux<span className="dot">.</span>
        </div>
        <div>v0 · for absolute beginners</div>
        <div className="links">
          <a href="#">GitHub</a>
          <a href="#">How it works</a>
          <a href="#">Adafruit kit</a>
        </div>
      </footer>
    </div>
  );
}
