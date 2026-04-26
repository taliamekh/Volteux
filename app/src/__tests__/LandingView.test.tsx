import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import LandingView from "../views/LandingView";

describe("LandingView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the tagline + Build it button + examples", () => {
    const { asFragment } = render(
      <LandingView
        onSubmit={vi.fn()}
        onSeeExample={vi.fn()}
        setHeaderCtaVisible={vi.fn()}
      />,
    );
    expect(screen.getByText("Type your idea.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Build it/i })).toBeInTheDocument();
    expect(asFragment()).toMatchSnapshot();
  });
});
