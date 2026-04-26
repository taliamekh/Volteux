import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import FlashModal from "../components/FlashModal";
import { pipelineToProject } from "../data/adapter";
import { loadDefaultFixture } from "../data/fixtures";
import type { Project } from "../types";

// Step durations from FlashModal.tsx STEPS:
//   connect 700, compile 900, upload 1100, verify 600 → total 3,300 ms.
// After TOTAL_DURATION ms `phase` becomes "done" and the success view
// replaces the stepper.
const STEP_DURATIONS = {
  connect: 700,
  compile: 900,
  upload: 1100,
  verify: 600,
} as const;
const TOTAL_DURATION =
  STEP_DURATIONS.connect +
  STEP_DURATIONS.compile +
  STEP_DURATIONS.upload +
  STEP_DURATIONS.verify;

/**
 * Advance fake timers and flush React state updates triggered by setTimeout
 * callbacks. The auto-advance chain in FlashModal schedules the next tick from
 * inside the previous tick's setTimeout, so each advance can synchronously
 * call setState — wrapping in `act` keeps React happy and avoids the
 * "not wrapped in act(...)" warning that would otherwise spam the test output.
 */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("FlashModal", () => {
  let project: Project;

  beforeEach(() => {
    vi.useFakeTimers();
    project = pipelineToProject(loadDefaultFixture());
  });

  afterEach(() => {
    // Drain any pending fake timers BEFORE restoring real timers — otherwise
    // a leftover handle could leak into the next test file in the same
    // worker, breaking files like urlHash.test.ts that explicitly require
    // real timers for CompressionStream/DecompressionStream async I/O.
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("renders the connect step on initial open", () => {
    render(<FlashModal open={true} onClose={vi.fn()} project={project} />);

    // First step label is rendered and visible in the stepper.
    expect(screen.getByText("Connecting to your Uno")).toBeInTheDocument();
    // Title is the in-flight title, not the success title.
    expect(screen.getByText("Flashing your Uno")).toBeInTheDocument();
    // Success-view marker ("Done!" h2) is NOT shown yet.
    expect(screen.queryByText("Done!")).not.toBeInTheDocument();
  });

  it("renders nothing when open={false}", () => {
    const { container } = render(
      <FlashModal open={false} onClose={vi.fn()} project={project} />,
    );
    // Nothing rendered — the early `return null` at line 60.
    expect(container.firstChild).toBeNull();
  });

  it("auto-advances through all four steps and reaches the success view", async () => {
    const { container } = render(
      <FlashModal open={true} onClose={vi.fn()} project={project} />,
    );

    // Step 0 ("connect") starts active immediately on mount.
    const stepEls = () =>
      Array.from(container.querySelectorAll(".flash-step")) as HTMLElement[];
    expect(stepEls()[0]?.className).toContain("active");

    // Advance past step 0 → step 1 ("compile") active.
    await advance(STEP_DURATIONS.connect);
    expect(stepEls()[0]?.className).toContain("complete");
    expect(stepEls()[1]?.className).toContain("active");

    // Advance past step 1 → step 2 ("upload") active.
    await advance(STEP_DURATIONS.compile);
    expect(stepEls()[1]?.className).toContain("complete");
    expect(stepEls()[2]?.className).toContain("active");

    // Advance past step 2 → step 3 ("verify") active.
    await advance(STEP_DURATIONS.upload);
    expect(stepEls()[2]?.className).toContain("complete");
    expect(stepEls()[3]?.className).toContain("active");

    // Advance past step 3 → success view replaces the stepper.
    await advance(STEP_DURATIONS.verify);
    expect(screen.getByText("Done!")).toBeInTheDocument();
    // Stepper is no longer in the DOM.
    expect(container.querySelector(".flash-stepper")).toBeNull();
  });

  it("done view includes the project title", async () => {
    render(<FlashModal open={true} onClose={vi.fn()} project={project} />);
    await advance(TOTAL_DURATION);
    // The fixture maps to "Waving robot arm" in pipelineToProject.
    expect(screen.getByText(/Waving robot arm/)).toBeInTheDocument();
  });

  it("done view falls back to 'project' when project={null}", async () => {
    render(<FlashModal open={true} onClose={vi.fn()} project={null} />);
    await advance(TOTAL_DURATION);
    // The success copy uses `project?.title ?? "project"`. Match the literal
    // wrapped-in-quotes fallback so we're sure the null path was taken.
    expect(screen.getByText(/Your "project" is now running on your board\./)).toBeInTheDocument();
  });

  it("calls onClose when Escape is pressed while open", () => {
    const onClose = vi.fn();
    render(<FlashModal open={true} onClose={onClose} project={project} />);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose for Escape when open={false}", () => {
    const onClose = vi.fn();
    // Renders nothing AND the Esc useEffect short-circuits before subscribing
    // (line 52: `if (!open) return;`). Exercises the early-exit branch — no
    // listener is registered, so the keydown is a no-op.
    render(<FlashModal open={false} onClose={onClose} project={project} />);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("removes the Esc listener when the modal closes (cleanup path)", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <FlashModal open={true} onClose={onClose} project={project} />,
    );

    // Sanity: while open, Esc fires onClose.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    // Close the modal — runs the cleanup at line 57 (removeEventListener).
    rerender(<FlashModal open={false} onClose={onClose} project={project} />);

    // After close, dispatching Esc must NOT invoke onClose again — the
    // listener was removed by the cleanup.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the backdrop is clicked", () => {
    const onClose = vi.fn();
    const { container } = render(
      <FlashModal open={true} onClose={onClose} project={project} />,
    );

    const backdrop = container.querySelector(".auth-overlay");
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does NOT call onClose when the modal body is clicked", () => {
    const onClose = vi.fn();
    const { container } = render(
      <FlashModal open={true} onClose={onClose} project={project} />,
    );

    const body = container.querySelector(".flash-modal");
    expect(body).not.toBeNull();
    fireEvent.click(body!);

    // The body's onClick calls e.stopPropagation(), so the backdrop's
    // onClick={onClose} never fires.
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose when the close button is clicked", () => {
    const onClose = vi.fn();
    render(<FlashModal open={true} onClose={onClose} project={project} />);

    const closeBtn = screen.getByRole("button", { name: /Close/i });
    fireEvent.click(closeBtn);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("resets to step 0 when the modal is closed and reopened (timer cleanup)", async () => {
    const onClose = vi.fn();
    const { container, rerender } = render(
      <FlashModal open={true} onClose={onClose} project={project} />,
    );

    // Advance ~1,000 ms — past step 0 (700 ms), so step 1 ("compile") should
    // be active. A stale tick at fake-clock T=1,600 ms is queued (i=2
    // setActive call) from the first session's setTimeout chain.
    await advance(1_000);
    let steps = Array.from(
      container.querySelectorAll(".flash-step"),
    ) as HTMLElement[];
    expect(steps[1]?.className).toContain("active");

    // Close — runs the cleanup at line 47 (`cancelled = true`) which prevents
    // any pending tick from updating state, AND triggers the reset branch
    // (lines 24-27: setActive(0) + setPhase("connect")).
    rerender(<FlashModal open={false} onClose={onClose} project={project} />);

    // Reopen — the auto-advance effect runs again from a clean state.
    rerender(<FlashModal open={true} onClose={onClose} project={project} />);

    // Step 0 ("Connecting to your Uno") is active again, NOT step 1.
    steps = Array.from(
      container.querySelectorAll(".flash-step"),
    ) as HTMLElement[];
    expect(steps[0]?.className).toContain("active");
    expect(steps[1]?.className).not.toContain("active");
    expect(steps[1]?.className).not.toContain("complete");

    // CRITICAL: drain the stale tick from the first session. The first
    // session queued a setTimeout at fake-clock T=1,600 ms. We're at
    // T=1,000 ms; advancing 600 ms reaches T=1,600 ms where that stale
    // handle fires. If the `cancelled`-flag scope ever broke (e.g., a
    // refactor pulled `tick` out of the useEffect closure), the stale
    // tick would call setActive(2)/setPhase("upload") on the new session
    // and clobber step 0. The new session's first tick was queued at
    // T=1,000+700=1,700 ms, so 600 ms is past the stale handle but
    // before the new session's first transition — step 0 must still
    // be active.
    await advance(600);
    steps = Array.from(
      container.querySelectorAll(".flash-step"),
    ) as HTMLElement[];
    expect(steps[0]?.className).toContain("active");
  });

  it("Esc mid-step does not let the queued tick update state after close", async () => {
    // Scenario from julik-frontend-races: the timer chain queues the next
    // tick before the current tick returns. If Esc fires mid-step and the
    // parent responds by setting open={false}, the queued tick fires
    // AFTER the close cleanup. The `cancelled = true` flag must short-
    // circuit it (FlashModal.tsx line 32) — otherwise setActive/setPhase
    // run against a now-closed (return-null) tree.
    const onClose = vi.fn();
    const { container, rerender } = render(
      <FlashModal open={true} onClose={onClose} project={project} />,
    );

    // Mid-step-0: the next tick is queued at T=700 ms but hasn't fired.
    await advance(500);

    // Esc → onClose. Real-world parents respond by setting open={false}.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(<FlashModal open={false} onClose={onClose} project={project} />);

    // Advance past the queued tick. With the cancelled flag working, the
    // tick is a no-op. Without it, React would log a setState-on-closed-
    // tree warning (FlashModal returns null at line 60 when !open).
    // Since the modal is closed, the rendered output is empty — assert
    // that nothing flash-modal-related is in the DOM and that no further
    // onClose invocations happened from spurious state-driven re-renders.
    await advance(1_000);
    expect(container.querySelector(".flash-modal")).toBeNull();
    expect(container.querySelector(".flash-stepper")).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
