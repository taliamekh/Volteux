import { z } from "zod";

/**
 * VolteuxProjectDocument — the JSON contract Track 2 (Pipeline) emits and
 * Track 1 (UI) consumes. This Zod schema is the SINGLE SOURCE OF TRUTH;
 * `schemas/document.schema.json` is generated from it via `bun run gen:schema`.
 *
 * Schema discipline (CLAUDE.md): every change requires both Kai's and Talia's
 * signatures on the commit AND a new entry in `schemas/CHANGELOG.md`.
 *
 * Origin: docs/PLAN.md § "v0 JSON schema (draft)".
 *
 * Note on the schema/registry split: runtime `components[]` entries carry
 * ONLY `{id, sku, quantity}`. Static metadata (name, type, education_blurb,
 * model_url, pin_metadata, pin_layout) lives in `components/registry.ts` and
 * is dereferenced by the cross-consistency gate + the UI at render time.
 */

const ARCHETYPE_IDS = [
  "uno-ultrasonic-servo",
  "esp32-audio-dashboard",
  "pico-rotary-oled",
  "esp32c3-dht-aio",
  "uno-photoresistor-led",
] as const;

const BOARD_TYPES = ["uno", "esp32-wroom", "esp32-c3", "pi-pico"] as const;

const WIRE_COLORS = [
  "red",
  "black",
  "yellow",
  "blue",
  "green",
  "white",
  "orange",
] as const;

const ROTATIONS = [0, 90, 180, 270] as const;

const HONEST_GAP_SCOPES = ["full", "partial", "out-of-scope"] as const;

/** A single pin reference in a `connections[]` entry. */
const PinSchema = z
  .object({
    component_id: z.string().min(1, "component_id must be non-empty"),
    pin_label: z.string().min(1, "pin_label must be non-empty"),
  })
  .strict();

/** Top-level board metadata. The board's SKU also appears in `components[]`. */
const BoardSchema = z
  .object({
    sku: z.string().min(1, "Adafruit SKU must be non-empty"),
    name: z.string().min(1),
    type: z.enum(BOARD_TYPES),
    fqbn: z
      .string()
      .min(1, "arduino-cli FQBN must be non-empty (e.g., arduino:avr:uno)"),
  })
  .strict();

/**
 * A runtime component reference. This is intentionally minimal — static
 * metadata lives in `components/registry.ts`.
 */
const ComponentRefSchema = z
  .object({
    id: z.string().min(1, "stable component id used in connections + layout"),
    sku: z
      .string()
      .min(1, "Adafruit SKU; must exist in components/registry.ts (verified by cross-consistency gate)"),
    quantity: z.number().int().min(1),
  })
  .strict();

const ConnectionSchema = z
  .object({
    from: PinSchema,
    to: PinSchema,
    purpose: z
      .string()
      .min(1, "beginner-readable explanation of why this connection exists"),
    wire_color: z.enum(WIRE_COLORS).optional(),
  })
  .strict();

const BreadboardComponentSchema = z
  .object({
    component_id: z.string().min(1),
    /** Breadboard hole using row/column convention: a-e upper, f-j lower, columns 1-30. */
    anchor_hole: z
      .string()
      .regex(
        /^[a-j][0-9]{1,2}$/,
        "anchor_hole must match /^[a-j][0-9]{1,2}$/ (e.g., 'e15')",
      ),
    /** Rotation applied to the component's footprint at the anchor_hole. */
    rotation: z.union([
      z.literal(0),
      z.literal(90),
      z.literal(180),
      z.literal(270),
    ]),
  })
  .strict();

const BreadboardLayoutSchema = z
  .object({
    components: z
      .array(BreadboardComponentSchema)
      .min(1, "breadboard_layout.components[] must have at least one entry"),
  })
  .strict();

const SketchSchema = z
  .object({
    main_ino: z
      .string()
      .min(1, "sketch.main_ino must be non-empty Arduino C++ source"),
    /** filename -> contents, e.g. data/index.html for LittleFS (v1.5+). */
    additional_files: z.record(z.string(), z.string()).optional(),
    /**
     * Library Manager names, e.g. 'Servo'. Per-archetype allowlist enforced by
     * the cross-consistency gate. Empty array is valid (sketches with no #includes).
     */
    libraries: z.array(z.string().min(1)),
  })
  .strict();

/**
 * Optional external setup metadata. v0.1 honors `needs_wifi` and
 * `needs_aio_credentials`; the other fields are v1.5 (archetypes 2 + 4).
 *
 * The schema permits v1.5 fields on archetype 1 by design (locked schema);
 * the rules engine `no-v15-fields-on-archetype-1` flags them as amber.
 */
const ExternalSetupSchema = z
  .object({
    needs_wifi: z.boolean().optional(),
    needs_aio_credentials: z.boolean().optional(),
    /** v1.5 — WiFiManager portal SSID. */
    captive_portal_ssid: z.string().min(1).optional(),
    /** v1.5 — Adafruit IO feed names for archetype 4. */
    aio_feed_names: z.array(z.string().min(1)).optional(),
    /** v1.5 — e.g. audio-meter.local for archetype 2. */
    mdns_name: z.string().min(1).optional(),
  })
  .strict();

const HonestGapSchema = z
  .object({
    scope: z.enum(HONEST_GAP_SCOPES),
    missing_capabilities: z.array(z.string().min(1)),
    explanation: z
      .string()
      .min(1, "beginner-readable Honest Gap message"),
  })
  .strict();

/**
 * The full document. `.strict()` is critical — unknown top-level fields
 * fail parse, forcing LLM discipline.
 */
export const VolteuxProjectDocumentSchema = z
  .object({
    archetype_id: z.enum(ARCHETYPE_IDS),
    board: BoardSchema,
    components: z
      .array(ComponentRefSchema)
      .min(1, "components[] must have at least one entry (the board)"),
    connections: z
      .array(ConnectionSchema)
      .min(1, "connections[] must have at least one entry"),
    breadboard_layout: BreadboardLayoutSchema,
    sketch: SketchSchema,
    external_setup: ExternalSetupSchema,
    honest_gap: HonestGapSchema.optional(),
  })
  .strict();

export type VolteuxProjectDocument = z.infer<
  typeof VolteuxProjectDocumentSchema
>;
export type VolteuxBoard = z.infer<typeof BoardSchema>;
export type VolteuxComponentRef = z.infer<typeof ComponentRefSchema>;
export type VolteuxConnection = z.infer<typeof ConnectionSchema>;
export type VolteuxBreadboardComponent = z.infer<
  typeof BreadboardComponentSchema
>;
export type VolteuxSketch = z.infer<typeof SketchSchema>;
export type VolteuxExternalSetup = z.infer<typeof ExternalSetupSchema>;
export type VolteuxHonestGap = z.infer<typeof HonestGapSchema>;
export type VolteuxArchetypeId = (typeof ARCHETYPE_IDS)[number];
export type VolteuxBoardType = (typeof BOARD_TYPES)[number];
export type VolteuxWireColor = (typeof WIRE_COLORS)[number];
export type VolteuxRotation = (typeof ROTATIONS)[number];
export type VolteuxHonestGapScope = (typeof HONEST_GAP_SCOPES)[number];

export {
  ARCHETYPE_IDS,
  BOARD_TYPES,
  WIRE_COLORS,
  ROTATIONS,
  HONEST_GAP_SCOPES,
  PinSchema,
  BoardSchema,
  ComponentRefSchema,
  ConnectionSchema,
  BreadboardComponentSchema,
  BreadboardLayoutSchema,
  SketchSchema,
  ExternalSetupSchema,
  HonestGapSchema,
};
