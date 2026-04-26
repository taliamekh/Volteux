import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
// `screen` used by the empty-state assertion below.
import WiringSpecTable from "../panels/WiringSpecTable";
import fixtureJson from "../../../fixtures/uno-ultrasonic-servo.json";
import {
  VolteuxProjectDocumentSchema,
  type VolteuxProjectDocument,
} from "../../../schemas/document.zod";
import { COMPONENT_SPECS } from "../data/component-specs";

const canonicalDoc: VolteuxProjectDocument =
  VolteuxProjectDocumentSchema.parse(fixtureJson);

describe("WiringSpecTable", () => {
  it("renders one row per spec connection that appears in the canonical fixture", () => {
    const { container } = render(<WiringSpecTable doc={canonicalDoc} />);
    const rows = container.querySelectorAll("tbody tr");
    expect(rows.length).toBe(7);
  });

  it("uses each connection's wireColor as the left-border style", () => {
    const { container } = render(<WiringSpecTable doc={canonicalDoc} />);
    const rows = Array.from(container.querySelectorAll("tbody tr"));
    const expectedColors =
      COMPONENT_SPECS["uno-ultrasonic-servo"]!.connections.map(
        (c) => c.wireColor,
      );
    rows.forEach((row, i) => {
      // JSDOM normalizes the inline `border-left` hex to `rgb(...)`, so
      // we round-trip via the data attribute we wrote alongside the
      // style. The style attribute itself is verified to be present.
      expect(row.getAttribute("data-wire-color")).toBe(expectedColors[i]);
      expect(row.getAttribute("style")).toMatch(/border-left:\s*3px\s+solid/);
    });
  });

  it("renders the empty state when archetype has no spec block populated", () => {
    const docWithoutSpecs: VolteuxProjectDocument = {
      ...canonicalDoc,
      archetype_id: "esp32-audio-dashboard",
    };
    render(<WiringSpecTable doc={docWithoutSpecs} />);
    expect(
      screen.getByText(/Specs not yet documented for this archetype\./),
    ).toBeInTheDocument();
  });

  it("omits spec connections that have no matching entry in doc.connections", () => {
    // Build a doc with only one connection (s1.VCC -> u1.5V).
    const slimDoc: VolteuxProjectDocument = {
      ...canonicalDoc,
      connections: [canonicalDoc.connections[0]!],
    };
    const { container } = render(<WiringSpecTable doc={slimDoc} />);
    const rows = container.querySelectorAll("tbody tr");
    // Two spec rows describe (Uno 5V <-> HC-SR04 VCC); both still match
    // by direction. But only one (HC-SR04 VCC) is in doc.connections, so
    // we expect at most one row (the HC-SR04 5V one) — not the SG90 5V one.
    expect(rows.length).toBe(1);
    expect(container.textContent).toContain("HC-SR04");
    expect(container.textContent).not.toContain("Echo");
  });

  it("renders both component datasheet cards for the canonical fixture", () => {
    const { container } = render(<WiringSpecTable doc={canonicalDoc} />);
    const cardHeaders = Array.from(
      container.querySelectorAll(".wiring-spec-card-head"),
    ).map((el) => el.textContent);
    expect(cardHeaders).toContain("HC-SR04");
    expect(cardHeaders).toContain("SG90 Servo");
  });
});
