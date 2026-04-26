import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import ResultView from "../views/ResultView";
import { pipelineToProject } from "../data/adapter";
import { loadDefaultFixture } from "../data/fixtures";

describe("ResultView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders all panels for the default fixture", () => {
    const project = pipelineToProject(loadDefaultFixture());
    const { asFragment, container } = render(
      <ResultView
        project={project}
        onRefine={vi.fn()}
        refining={false}
        onFlash={vi.fn()}
        refineToast={null}
      />,
    );
    // Sanity assertions
    expect(screen.getByText(/Code/)).toBeInTheDocument();
    expect(screen.getByText(/Wiring diagram/)).toBeInTheDocument();
    expect(screen.getByText(/What you'll need/)).toBeInTheDocument();
    expect(screen.getByText(/Chat with Volteux/)).toBeInTheDocument();
    expect(container.querySelectorAll(".part").length).toBeGreaterThanOrEqual(4);

    expect(asFragment()).toMatchSnapshot();
  });
});
