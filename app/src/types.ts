// ============================================================
// Volteux UI types
// ============================================================
// These types describe the SHAPE the UI consumes today (the canned
// project catalog under src/data/projects.ts). When Track 2's pipeline
// JSON is wired in (week 5-6 per docs/PLAN.md), some of these fields
// will be replaced by — or derived from — `schemas/document.zod.ts`.
// Until then this is the contract the UI components rely on.

import { z } from "zod";
import type { VolteuxProjectDocument } from "../../schemas/document.zod";

export type IconKind =
  | "board"
  | "sonar"
  | "servo"
  | "led"
  | "res"
  | "buzzer"
  | "eye";

export interface Position {
  x: number;
  y: number;
}

export interface Part {
  id: string;
  name: string;
  sku: string;
  price: number;
  qty: number;
  icon: IconKind;
  desc: string;
  pos: Position;
  /** Optional pulse animation on the 3D hotspot for this part. */
  pulse?: boolean;
}

export type WireColor =
  | "red"
  | "black"
  | "yellow"
  | "blue"
  | "green"
  | "purple";

export interface WiringConnection {
  from: string;
  to: string;
  color: WireColor;
  pin: string;
}

export interface Project {
  /** Stable key used for resets / equality checks. */
  key: string;
  board: string;
  confidence: number;
  title: string;
  blurb: string;
  parts: Part[];
  wiring: WiringConnection[];
  /**
   * Raw .ino source for the Monaco editor. Populated by the adapter from
   * `document.sketch.main_ino`.
   */
  sketchSource: string;
  /**
   * Raw schema-validated source document. Carries data the view-model
   * intentionally drops (breadboard_layout, raw connections, archetype
   * metadata) so panels and side-effects (URL hash persistence, Adafruit
   * cart URL) can read directly from the canonical schema instead of
   * reaching back to the fixture. Required: the adapter always populates
   * it; tests construct projects via `pipelineToProject(loadFixture())`.
   */
  document: VolteuxProjectDocument;
  refineSuggestions: string[];
}

// ---------- App-shell types ----------

export type ViewName = "landing" | "loading" | "result";

export type Palette = "violet" | "amber" | "mint";
export type Density = "compact" | "default" | "roomy";
export type DisplayType = "exo" | "serif" | "mono";
export type SloganFont =
  | "exo"
  | "grotesk"
  | "bricolage"
  | "geist"
  | "instrument"
  | "fragment"
  | "bungee";

export interface Tweaks {
  palette: Palette;
  density: Density;
  type: DisplayType;
  slogan: SloganFont;
  useAi: boolean;
}

// User shape persisted to localStorage. Validated via UserSchema.safeParse on
// load so a tampered or pre-schema-change entry returns null instead of
// blowing up downstream consumers via a JSON.parse-as-cast.
export const UserSchema = z.object({
  email: z.string(),
  initials: z.string(),
  provider: z.enum(["email", "google", "github"]),
});

export type User = z.infer<typeof UserSchema>;

export type ChatMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; kind?: "intro" | "update" };

export type ExpandedPanel = "code" | "wiring" | null;
