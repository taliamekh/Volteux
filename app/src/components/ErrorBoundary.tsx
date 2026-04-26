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
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null, info: null };
    this.handleRetry = this.handleRetry.bind(this);
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Per CLAUDE.md "no silent failures": surface the original error and
    // component stack to dev tooling even though we swallow it for the user.
    // eslint-disable-next-line no-console
    console.error("Volteux error boundary caught:", error, info);
    this.setState({ info });
  }

  handleRetry(): void {
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
