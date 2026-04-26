import "@testing-library/jest-dom";
import { vi } from "vitest";
import * as React from "react";

// Monaco editor renders heavy non-deterministic DOM; replace with a simple <pre>.
vi.mock("@monaco-editor/react", () => ({
  default: ({ value }: { value?: string }) =>
    React.createElement("pre", { "data-testid": "monaco-editor" }, value ?? ""),
}));

// React-Three-Fiber Canvas requires WebGL context; replace with a stub div
// so child <Html>/<mesh> nodes can mount without crashing.
vi.mock("@react-three/fiber", async (importOriginal) => {
  const actual: object = await importOriginal();
  return {
    ...actual,
    Canvas: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", { "data-testid": "r3f-canvas" }, children),
  };
});
