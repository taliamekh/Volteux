import React from "react";

/**
 * Recipient for the "Tell us what happened" mailto link in the error
 * recovery card. Placeholder — change before public launch. Exported so the
 * tests (and a future settings sweep) can grep for the constant rather than
 * the literal string.
 */
export const FEEDBACK_EMAIL = "feedback@volteux.app";

// Truncation caps for the mailto body fields. Final encoded URL must stay
// under ~1.4KB so that Outlook desktop and Windows ShellExecute (which
// truncate `mailto:` near 2048 chars) can still open it.
const ERROR_MESSAGE_CAP = 200;
const HASH_CAP = 120;
const COMPONENT_STACK_FRAMES = 3;
const VISIBLE_MESSAGE_CAP = 120;

// Retry-thrash guard. If the user clicks "Try again" repeatedly within a
// short window (e.g., the underlying cause is non-transient — bad fixture,
// corrupted localStorage, persistently broken hash), we force a full page
// reload to break the loop. Without this, a non-transient throw would
// re-fire on every retry click and trap the user in the recovery card.
const MAX_RETRIES = 2; // 3rd retry forces reload (clicks 0, 1, 2 normal; click 3 reloads)
const RETRY_WINDOW_MS = 10_000;

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  info: React.ErrorInfo | null;
}

function truncate(input: string, cap: number): string {
  if (input.length <= cap) return input;
  return input.slice(0, cap - 1) + "…"; // single-char ellipsis to keep length predictable
}

function firstFramesOfComponentStack(stack: string | null | undefined, n: number): string {
  if (!stack) return "";
  // componentStack is a multi-line string; first frame is usually a leading
  // empty line + "    in Component …". Skip blank lines, take first n.
  const frames = stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return frames.slice(0, n).join("\n");
}

/**
 * Coerce an arbitrary thrown value (which may be anything via `throw "x"`,
 * `Promise.reject(123)`, etc.) into an Error instance. Centralized so the
 * window-level catchers (`error`, `unhandledrejection`) and the async path
 * all surface a uniform shape to the boundary's render.
 */
function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  if (value === null || value === undefined) return new Error("Unknown error.");
  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}

/**
 * Build the full `mailto:` URL for the "Tell us what happened" link. Pure;
 * exported so tests can drive it directly without mounting the boundary.
 */
export function buildMailtoHref(
  error: Error,
  info: React.ErrorInfo | null,
  hash: string,
  userAgent: string,
): string {
  const errorClass = error.name || "Error";
  const message = truncate(error.message ?? "", ERROR_MESSAGE_CAP);
  const truncatedHash = truncate(hash ?? "", HASH_CAP);
  const stack = firstFramesOfComponentStack(info?.componentStack ?? null, COMPONENT_STACK_FRAMES);

  const subject = `Volteux error: ${errorClass}`;
  const bodyLines = [
    `Error: ${errorClass}`,
    `Message: ${message}`,
    `Browser: ${userAgent}`,
    `Hash: ${truncatedHash}`,
    "Component stack:",
    stack,
  ];
  const body = bodyLines.join("\n");

  return `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export default class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  // Retry-thrash tracking. Lives outside React state because it's a
  // diagnostic concern, not render input.
  private retryTimestamps: number[] = [];

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null, info: null };
    this.handleRetry = this.handleRetry.bind(this);
    this.handleWindowError = this.handleWindowError.bind(this);
    this.handleUnhandledRejection = this.handleUnhandledRejection.bind(this);
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidMount(): void {
    // Extend the boundary's reach to async errors. Per CLAUDE.md "no silent
    // failures" + the U1 plan, the boundary is the surface for adapter
    // throws (unknown SKU, bad fixture). Many of those throws now happen
    // inside async IIFEs (mount-restore, hashchange handler) or setTimeout
    // callbacks (LoadingView's finishLoading), which native React error
    // boundaries do NOT see — they only catch render-time throws. The
    // window-level listeners route those into the same recovery card.
    if (typeof window !== "undefined") {
      window.addEventListener("error", this.handleWindowError);
      window.addEventListener("unhandledrejection", this.handleUnhandledRejection);
    }
  }

  componentWillUnmount(): void {
    if (typeof window !== "undefined") {
      window.removeEventListener("error", this.handleWindowError);
      window.removeEventListener("unhandledrejection", this.handleUnhandledRejection);
    }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Per CLAUDE.md "no silent failures": surface the original error and
    // component stack to dev tooling even though we swallow it for the user.
    // eslint-disable-next-line no-console
    console.error("Volteux error boundary caught:", error, info);
    this.setState({ info });
  }

  private handleWindowError(event: ErrorEvent): void {
    // Don't double-trigger if the boundary is already showing a card.
    if (this.state.error) return;
    const err = toError(event.error ?? event.message ?? "Window error");
    // eslint-disable-next-line no-console
    console.error("Volteux error boundary caught (async error):", err);
    this.setState({ error: err, info: null });
  }

  private handleUnhandledRejection(event: PromiseRejectionEvent): void {
    if (this.state.error) return;
    const err = toError(event.reason);
    // eslint-disable-next-line no-console
    console.error("Volteux error boundary caught (unhandled rejection):", err);
    this.setState({ error: err, info: null });
  }

  handleRetry(): void {
    const now = Date.now();
    // Drop timestamps outside the rolling window so a slow stream of retries
    // separated by minutes doesn't accidentally trigger a reload.
    this.retryTimestamps = this.retryTimestamps.filter((t) => now - t < RETRY_WINDOW_MS);
    this.retryTimestamps.push(now);

    if (this.retryTimestamps.length > MAX_RETRIES) {
      // Non-transient cause — break the loop with a hard reload. Wipes
      // hash on the way out so a corrupted shareable link can't immediately
      // re-trigger the same throw on next mount.
      if (typeof window !== "undefined") {
        window.location.replace(window.location.pathname + window.location.search);
      }
      return;
    }
    this.setState({ error: null, info: null });
  }

  render(): React.ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    const hash = typeof window !== "undefined" ? window.location.hash : "";
    const userAgent =
      typeof navigator !== "undefined" && typeof navigator.userAgent === "string"
        ? navigator.userAgent
        : "";
    const mailtoHref = buildMailtoHref(error, info, hash, userAgent);
    const visibleMessage = truncate(error.message ?? "Unknown error.", VISIBLE_MESSAGE_CAP);

    return (
      <div className="error-card-overlay" role="alert">
        <div className="error-card">
          <h2 className="error-card-title">Something didn&apos;t work.</h2>
          <p className="error-card-msg">{visibleMessage}</p>
          <div className="error-card-actions">
            <button
              type="button"
              className="error-card-btn error-card-btn-primary"
              onClick={this.handleRetry}
            >
              Try again
            </button>
            <a className="error-card-btn" href={mailtoHref}>
              Tell us what happened
            </a>
          </div>
        </div>
      </div>
    );
  }
}
