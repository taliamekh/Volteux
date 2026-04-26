import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

describe("sanity", () => {
  it("renders a div via Testing Library", () => {
    render(<div>hello</div>);
    expect(screen.getByText("hello")).toBeInTheDocument();
  });
});
