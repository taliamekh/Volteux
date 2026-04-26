import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import LoadingView from "../views/LoadingView";

describe("LoadingView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
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
});
