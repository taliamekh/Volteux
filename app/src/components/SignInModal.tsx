import { useEffect, useRef, useState } from "react";
import type { User } from "../types";

interface SignInModalProps {
  onClose: () => void;
  onAuth: (user: User) => void;
}

type Mode = "signin" | "signup";
type BusyKind = "email" | "google" | "github" | null;

function initialsFor(str: string): string {
  const s = (str ?? "").trim();
  if (!s) return "U";
  const parts = s.split(/[@.\s]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "U") + (parts[1]?.[0] ?? "")).toUpperCase().slice(0, 2);
}

export default function SignInModal({ onClose, onAuth }: SignInModalProps) {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<BusyKind>(null);
  const [error, setError] = useState("");

  // Track in-flight fake-auth timers so close (Esc / backdrop / X) cancels them
  // instead of letting onAuth fire after the user dismissed the modal — see
  // julik review "signin-modal-async-vs-cancel" (P1, no silent failures).
  const authTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (authTimerRef.current !== null) {
        window.clearTimeout(authTimerRef.current);
        authTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submitEmail = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!email.trim() || !password.trim()) {
      setError("Please fill in both fields.");
      return;
    }
    setError("");
    setBusy("email");
    authTimerRef.current = window.setTimeout(() => {
      authTimerRef.current = null;
      onAuth({ email: email.trim(), initials: initialsFor(email), provider: "email" });
    }, 700);
  };

  const oauth = (provider: "google" | "github") => {
    setBusy(provider);
    authTimerRef.current = window.setTimeout(() => {
      authTimerRef.current = null;
      const fakeEmail = provider === "google" ? "you@gmail.com" : "you@users.noreply.github.com";
      onAuth({ email: fakeEmail, initials: initialsFor(fakeEmail), provider });
    }, 900);
  };

  return (
    <div className="auth-overlay" onClick={onClose}>
      <div className="auth-modal" onClick={(e) => e.stopPropagation()}>
        <button className="auth-close" onClick={onClose} aria-label="Close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        <div className="auth-brand">
          <span className="wordmark">
            Volteux<span className="dot">.</span>
          </span>
        </div>

        <h2 className="auth-title">{mode === "signin" ? "Welcome back" : "Create your account"}</h2>
        <p className="auth-sub">
          {mode === "signin"
            ? "Sign in to see your saved projects, parts lists, and flashed boards."
            : "Save every project you build, sync your parts cart, and pick up where you left off."}
        </p>

        <div className="auth-tabs">
          <button
            className={`auth-tab ${mode === "signin" ? "active" : ""}`}
            onClick={() => {
              setMode("signin");
              setError("");
            }}
          >
            Sign in
          </button>
          <button
            className={`auth-tab ${mode === "signup" ? "active" : ""}`}
            onClick={() => {
              setMode("signup");
              setError("");
            }}
          >
            Create account
          </button>
        </div>

        <div className="auth-oauth">
          <button className="oauth-btn" onClick={() => oauth("google")} disabled={!!busy}>
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.56c2.08-1.92 3.28-4.74 3.28-8.1z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.77c-.99.66-2.25 1.06-3.72 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.1V7.07H2.18A11 11 0 0 0 1 12c0 1.78.43 3.46 1.18 4.93l3.66-2.83z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.2 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.07l3.66 2.83C6.71 7.31 9.14 5.38 12 5.38z" />
            </svg>
            <span>{busy === "google" ? "Connecting…" : "Continue with Google"}</span>
          </button>

          <button className="oauth-btn" onClick={() => oauth("github")} disabled={!!busy}>
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
              <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56 0-.27-.01-1-.02-1.97-3.2.69-3.87-1.54-3.87-1.54-.52-1.33-1.27-1.69-1.27-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.24 3.34.95.1-.74.4-1.24.72-1.53-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.05 0 0 .97-.31 3.18 1.18.92-.26 1.91-.39 2.89-.39.98 0 1.97.13 2.89.39 2.21-1.49 3.18-1.18 3.18-1.18.62 1.59.23 2.76.11 3.05.74.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.13 0 1.54-.01 2.78-.01 3.16 0 .31.21.67.8.55C20.21 21.39 23.5 17.07 23.5 12 23.5 5.65 18.35.5 12 .5z" />
            </svg>
            <span>{busy === "github" ? "Connecting…" : "Continue with GitHub"}</span>
          </button>
        </div>

        <div className="auth-divider">
          <span>or with email</span>
        </div>

        <form onSubmit={submitEmail} className="auth-form">
          <label className="auth-field">
            <span>Email</span>
            <input
              type="email"
              autoFocus
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={!!busy}
            />
          </label>
          <label className="auth-field">
            <span>
              Password
              {mode === "signin" && (
                <button type="button" className="auth-forgot" onClick={(e) => e.preventDefault()}>
                  Forgot?
                </button>
              )}
            </span>
            <input
              type="password"
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              placeholder={mode === "signup" ? "8+ characters" : "Your password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={!!busy}
            />
          </label>

          {error && <div className="auth-error">{error}</div>}

          <button type="submit" className="auth-submit" disabled={!!busy}>
            {busy === "email"
              ? mode === "signin"
                ? "Signing in…"
                : "Creating…"
              : mode === "signin"
                ? "Sign in"
                : "Create account"}
          </button>
        </form>

        <div className="auth-footer">
          {mode === "signin" ? (
            <>
              New to Volteux?{" "}
              <button
                onClick={() => {
                  setMode("signup");
                  setError("");
                }}
              >
                Create an account
              </button>
            </>
          ) : (
            <>
              Already have one?{" "}
              <button
                onClick={() => {
                  setMode("signin");
                  setError("");
                }}
              >
                Sign in
              </button>
            </>
          )}
        </div>

        <div className="auth-legal">
          By continuing, you agree to Volteux's{" "}
          <a href="#" onClick={(e) => e.preventDefault()}>
            Terms
          </a>{" "}
          and{" "}
          <a href="#" onClick={(e) => e.preventDefault()}>
            Privacy Policy
          </a>
          .
        </div>
      </div>
    </div>
  );
}
