import "@testing-library/jest-dom";
import { vi } from "vitest";
import * as React from "react";

// HeroScene renders R3F intrinsic elements (<ambientLight>, <directionalLight>,
// <group>, <meshStandardMaterial>, etc.) directly inside the (mocked) <Canvas>.
// In a real R3F tree those go to the WebGL reconciler, but inside our jsdom
// stub they look like unknown lowercase HTML tags and React logs a warning per
// element on every render. Filter just those messages so test output stays
// readable; everything else still surfaces normally. React passes the tag/prop
// name as a printf-style arg (`Warning: <%s />`), so we check the full
// formatted message after substitution.
const R3F_INTRINSIC_NAMES = [
  "ambientLight",
  "directionalLight",
  "spotLight",
  "pointLight",
  "hemisphereLight",
  "group",
  "mesh",
  "primitive",
  "meshStandardMaterial",
  "meshBasicMaterial",
  "meshPhysicalMaterial",
];
const R3F_PROP_NAMES = ["castShadow", "receiveShadow"];
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
  const first = args[0];
  if (typeof first === "string") {
    // React formats warnings with %s placeholders; rebuild the substituted
    // string to match against. (We don't need full printf — just %s.)
    let composed = first;
    let idx = 1;
    composed = composed.replace(/%s/g, () => String(args[idx++] ?? ""));
    if (R3F_INTRINSIC_NAMES.some((name) => composed.includes(`<${name}`))) return;
    if (R3F_INTRINSIC_NAMES.some((name) => composed.includes(`The tag ${name}`))) return;
    if (R3F_PROP_NAMES.some((p) => composed.includes(p))) return;
  }
  originalConsoleError(...args);
};

// jsdom doesn't implement IntersectionObserver — LandingView's sticky-CTA
// effect uses it. Stub a no-op constructor so the effect doesn't throw.
class IntersectionObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}
(globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver =
  IntersectionObserverStub as unknown as typeof IntersectionObserver;

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

// drei components (OrbitControls, Html, Box, Cylinder, Sphere, Plane) call
// `useThree()` internally. With our Canvas mocked to a plain <div> there's no
// R3F context, so they throw. Stub each one to a minimal renderable so the
// snapshot stays stable and the surrounding HeroPanel chrome still gets tested.
// OrbitControls is forwarded a ref by HeroScene; use forwardRef to avoid the
// "Function components cannot be given refs" warning during tests.
vi.mock("@react-three/drei", async (importOriginal) => {
  const actual: object = await importOriginal();
  const OrbitControlsStub = React.forwardRef<unknown, Record<string, unknown>>(
    function OrbitControlsStub(_props, _ref) {
      return null;
    },
  );
  // R3F primitive children (`<meshStandardMaterial>`, etc.) emit React
  // "unrecognized tag" warnings in jsdom because they're meant for the WebGL
  // reconciler. Drop children entirely from the mesh-shaped drei wrappers so
  // only the surrounding component chrome ends up in the snapshot.
  const NullStub = () => null;
  return {
    ...actual,
    OrbitControls: OrbitControlsStub,
    Html: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", { "data-testid": "drei-html" }, children),
    Box: NullStub,
    Cylinder: NullStub,
    Sphere: NullStub,
    Plane: NullStub,
  };
});
