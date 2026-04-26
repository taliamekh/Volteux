import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import LoadingView from "../views/LoadingView";

/**
 * Advance fake timers and flush React state updates triggered by setTimeout
 * callbacks. The chain in LoadingView schedules each next step from inside
 * the previous tick's setTimeout, so each advance can synchronously call
 * setState. The async form (`advanceTimersByTimeAsync` inside `await act`)
 * lets React's scheduler drain microtasks between ticks — matches the
 * pattern used in FlashModal.test.tsx for the same chained-recursive
 * setTimeout shape, avoiding reliance on synchronous-fake-clock semantics
 * that could change across Vitest releases.
 */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("LoadingView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    // Drain any pending fake timers BEFORE restoring real timers — otherwise
    // a leftover handle could leak into the next test file in the same
    // worker, breaking files like urlHash.test.ts that explicitly require
    // real timers for CompressionStream/DecompressionStream async I/O.
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("renders the prompt + first step active", () => {
    const { asFragment } = render(
      <LoadingView prompt="a robot arm that waves" onComplete={vi.fn()} />,
    );
    expect(screen.getByText(/robot arm/i)).toBeInTheDocument();
    // "Reading your idea" appears in both the active step label and the
    // status line below the stepper — assert at least one is present.
    expect(screen.getAllByText(/Reading your idea/i).length).toBeGreaterThanOrEqual(1);
    expect(asFragment()).toMatchSnapshot();
  });

  it("advances through every step in the chain", async () => {
    const { container } = render(
      <LoadingView prompt="step chain test" onComplete={vi.fn()} />,
    );

    // Step 0 ("read") is active on initial render. The stepper renders 5
    // steps; the first should have class containing "active", others not.
    // Use classList.contains() rather than exact-string match to avoid
    // coupling to the trailing-space artifact of the ternary empty-string
    // branch (would silently break on any whitespace-trim refactor).
    const stepsAtStart = container.querySelectorAll(".step");
    expect(stepsAtStart).toHaveLength(5);
    expect(stepsAtStart[0]?.classList.contains("active")).toBe(true);
    expect(stepsAtStart[1]?.classList.contains("active")).toBe(false);
    expect(stepsAtStart[1]?.classList.contains("complete")).toBe(false);

    // Advance past step 0 (800 ms) → step 1 ("parts") becomes active.
    await advance(800);
    const stepsAfterRead = container.querySelectorAll(".step");
    expect(stepsAfterRead[0]?.classList.contains("complete")).toBe(true);
    expect(stepsAfterRead[1]?.classList.contains("active")).toBe(true);

    // Advance past step 1 (1500 ms) → step 2 ("code") becomes active.
    await advance(1500);
    const stepsAfterParts = container.querySelectorAll(".step");
    expect(stepsAfterParts[1]?.classList.contains("complete")).toBe(true);
    expect(stepsAfterParts[2]?.classList.contains("active")).toBe(true);

    // Advance past step 2 (2200 ms) → step 3 ("compile") becomes active.
    await advance(2200);
    const stepsAfterCode = container.querySelectorAll(".step");
    expect(stepsAfterCode[2]?.classList.contains("complete")).toBe(true);
    expect(stepsAfterCode[3]?.classList.contains("active")).toBe(true);

    // Advance past step 3 (1500 ms) → step 4 ("wire") becomes active.
    await advance(1500);
    const stepsAfterCompile = container.querySelectorAll(".step");
    expect(stepsAfterCompile[3]?.classList.contains("complete")).toBe(true);
    expect(stepsAfterCompile[4]?.classList.contains("active")).toBe(true);

    // Advance past step 4 (1200 ms) → all steps complete; status flips to
    // the "done" message before the trailing 500 ms onComplete delay.
    await advance(1200);
    expect(screen.getByText("Done. Loading your project…")).toBeInTheDocument();
  });

  it("calls onComplete exactly once after the full timer chain", async () => {
    const onComplete = vi.fn();
    render(<LoadingView prompt="completion test" onComplete={onComplete} />);

    // 5 step durations (800 + 1500 + 2200 + 1500 + 1200 = 7200 ms) plus the
    // trailing 500 ms delay before onComplete fires = 7700 ms total.
    await advance(7700);

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("does not call onComplete after early unmount mid-chain", async () => {
    const onComplete = vi.fn();
    const { unmount } = render(
      <LoadingView prompt="unmount test" onComplete={onComplete} />,
    );

    // Mid-step-1 (1000 ms < 800 + 1500), then unmount before the chain
    // completes — exercises the inner `if (cancelled) return` guard at
    // LoadingView.tsx line 36 inside the per-step setTimeout callback.
    await advance(1000);
    unmount();

    // Advance well past the full 7700 ms total — the cleanup function's
    // `cancelled = true` guard should prevent any onComplete invocation.
    await advance(10000);

    expect(onComplete).not.toHaveBeenCalled();
  });

  it("does not call onComplete when unmount happens during the trailing 500 ms tail", async () => {
    // Per julik-frontend-races JFR-04: the mid-chain unmount test above
    // exercises the inner-step guard (line 36), but NOT the tail guard at
    // LoadingView.tsx line 43 (`!cancelled && onComplete()` inside the
    // 500 ms post-chain delay). Cover that path explicitly so a regression
    // that flipped or removed the tail guard would be caught.
    const onComplete = vi.fn();
    const { unmount } = render(
      <LoadingView prompt="tail-unmount test" onComplete={onComplete} />,
    );

    // Advance through all 5 steps (7,200 ms total). The trailing 500 ms
    // onComplete timer is queued but has NOT fired yet.
    await advance(7200);
    expect(onComplete).not.toHaveBeenCalled();

    // Unmount during the 500 ms tail window — sets cancelled=true.
    unmount();

    // Fire the tail timer. The `!cancelled && onComplete()` guard must
    // skip the call; otherwise onComplete fires on an unmounted parent.
    await advance(500);

    expect(onComplete).not.toHaveBeenCalled();
  });

  it("marks the first connector as done after the first step completes", async () => {
    const { container } = render(
      <LoadingView prompt="connector test" onComplete={vi.fn()} />,
    );

    // Connectors render between steps — 4 connectors for 5 steps. None should
    // be `done` initially.
    const connectorsAtStart = container.querySelectorAll(".step-connector");
    expect(connectorsAtStart).toHaveLength(4);
    expect(connectorsAtStart[0]?.classList.contains("done")).toBe(false);

    // After step 0 finishes (800 ms), the first connector picks up the
    // `done` class because `i < active` is true for index 0 when active === 1.
    await advance(800);
    const connectorsAfter = container.querySelectorAll(".step-connector");
    expect(connectorsAfter[0]?.classList.contains("done")).toBe(true);
  });
});
