// ============================================================
// Volteux UI types
// ============================================================
// These types describe the SHAPE the UI consumes today (the canned
// project catalog under src/data/projects.ts). When Track 2's pipeline
// JSON is wired in (week 5-6 per docs/PLAN.md), some of these fields
// will be replaced by — or derived from — `schemas/document.zod.ts`.
// Until then this is the contract the UI components rely on.

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

export type CodeSegmentKind = "kw" | "fn" | "str" | "com" | "num" | "";

export interface CodeSegment {
  k: CodeSegmentKind;
  t: string;
}

export type CodeLine =
  | { kind: "com"; text: string }
  | { kind: "blank" }
  | { kind: "raw"; parts: CodeSegment[] };

export interface Project {
  /** Stable key used for resets / equality checks. */
  key: string;
  /** Original prompt the user typed (or the canned example). */
  prompt?: string;
  /** Keywords used by the local matcher — UI-only metadata (legacy). */
  match: string[];
  board: string;
  confidence: number;
  title: string;
  blurb: string;
  parts: Part[];
  wiring: WiringConnection[];
  code: CodeLine[];
  /**
   * Raw .ino source for the Monaco editor (U4). Populated by the adapter
   * from `document.sketch.main_ino`. Keep `code` populated alongside as a
   * U1-window fallback until U4 lands.
   */
  sketchSource: string;
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

export interface User {
  email: string;
  initials: string;
  provider: "email" | "google" | "github";
}

export type ChatMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; kind?: "intro" | "update" };

export type ExpandedPanel = "code" | "wiring" | null;
