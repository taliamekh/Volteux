import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ErrorBoundary, { FEEDBACK_EMAIL, buildMailtoHref } from "../components/ErrorBoundary";

// React logs the synchronous render-time throw it caught at the boundary as
// an "uncaught error" message even when a boundary handles it. Suppress just
// that and the boundary's own diagnostic console.error so test output stays
// readable. The pattern mirrors test-setup.ts's R3F intrinsic filter:
// preserve the original console.error and forward anything we don't
// recognize.
function silenceExpectedReactErrors(): () => void {
  const original = console.error;
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    const first = args[0];
    if (typeof first === "string") {
      if (first.includes("Volteux error boundary caught")) return;
      if (first.includes("React will try to recreate")) return;
      if (first.includes("Consider adding an error boundary")) return;
      if (first.includes("The above error occurred")) return;
      if (first.includes("Uncaught") && first.includes("Error")) return;
    }
    if (first instanceof Error) return;
    original(...(args as Parameters<typeof console.error>));
  });
  return () => spy.mockRestore();
}

function Bomb({ message = "boom" }: { message?: string }): React.ReactElement {
  throw new Error(message);
}

function Safe({ label }: { label: string }): React.ReactElement {
  return <div>{label}</div>;
}

describe("ErrorBoundary", () => {
  let restoreConsole: () => void;

  beforeEach(() => {
    restoreConsole = silenceExpectedReactErrors();
  });

  afterEach(() => {
    restoreConsole();
  });

  it("renders children unchanged when no throw occurs", () => {
    render(
      <ErrorBoundary>
        <Safe label="hello world" />
      </ErrorBoundary>,
    );
    expect(screen.getByText("hello world")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders the recovery card when a child throws on mount", () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Something didn't work.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /tell us what happened/i })).toBeInTheDocument();
  });

  it("resets to children when 'Try again' is clicked and child no longer throws", () => {
    const { rerender } = render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    // Replace the throwing child with a safe one BEFORE clicking try-again,
    // so the next render doesn't immediately re-throw.
    rerender(
      <ErrorBoundary>
        <Safe label="recovered" />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("recovered")).toBeInTheDocument();
  });

  it("emits a well-formed mailto href containing diagnostic fields", () => {
    render(
      <ErrorBoundary>
        <Bomb message="something broke" />
      </ErrorBoundary>,
    );
    const link = screen.getByRole("link", { name: /tell us what happened/i }) as HTMLAnchorElement;
    const href = link.href;
    expect(href.startsWith(`mailto:${FEEDBACK_EMAIL}?`)).toBe(true);
    expect(href).toContain("subject=");
    expect(href).toContain("body=");

    const url = new URL(href);
    const body = url.searchParams.get("body") ?? "";
    expect(body).toContain("Error: Error");
    expect(body).toContain("something broke");
    // navigator.userAgent is whatever jsdom reports; assert at least the
    // literal token "jsdom" or "Mozilla" so we know the field made it in.
    const ua = navigator.userAgent;
    if (ua.length > 0) {
      // Match the first ~12 chars to avoid coupling tests to UA string drift.
      expect(body).toContain(ua.slice(0, Math.min(12, ua.length)));
    }
  });

  it("truncates a long error message in the visible card text", () => {
    const longMessage = "x".repeat(500);
    render(
      <ErrorBoundary>
        <Bomb message={longMessage} />
      </ErrorBoundary>,
    );
    // Find the message paragraph by class to read its rendered text length.
    const card = screen.getByRole("alert");
    const msg = card.querySelector(".error-card-msg");
    expect(msg).not.toBeNull();
    const visibleText = msg?.textContent ?? "";
    // VISIBLE_MESSAGE_CAP is 120 in the source.
    expect(visibleText.length).toBeLessThanOrEqual(120);
    expect(visibleText.length).toBeGreaterThan(0);
  });

  it("truncates an oversized location.hash in the mailto body", () => {
    const longHash = "#" + "y".repeat(400);
    const error = new Error("short");
    const href = buildMailtoHref(error, null, longHash, "test-agent");
    const url = new URL(href);
    const body = url.searchParams.get("body") ?? "";
    // Find the "Hash: " line and verify length stays in expected range
    // (label + cap of 120 chars + a couple chars for the ellipsis).
    const hashLine = body.split("\n").find((line) => line.startsWith("Hash:")) ?? "";
    expect(hashLine.length).toBeGreaterThan(0);
    expect(hashLine.length).toBeLessThanOrEqual(140);
  });

  it("keeps the encoded mailto URL under 1400 chars even with worst-case inputs", () => {
    const error = new Error("e".repeat(500));
    error.name = "WorstCaseError";
    const longHash = "#" + "h".repeat(400);
    const chromeUA =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
    const fakeInfo: React.ErrorInfo = {
      componentStack:
        "\n    in Bomb (at App.tsx:99)\n    in ErrorBoundary (at main.tsx:13)\n    in StrictMode (at main.tsx:11)\n    in App\n    in Root",
    };
    const href = buildMailtoHref(error, fakeInfo, longHash, chromeUA);
    expect(href.length).toBeLessThan(1400);
  });
});
