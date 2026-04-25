/**
 * Static component metadata — the SINGLE authoritative source per CLAUDE.md
 * § Schema discipline. Anywhere else that names a component (pipeline prompts,
 * rules, UI 3D scene, Adafruit cart) is consuming, never authoritative.
 *
 * v0.1-pipeline scope: 5 components for archetype 1 (Uno + HC-SR04 + servo
 * + breadboard + jumper wires). v1.5 will grow to ~25 components across all
 * archetypes.
 *
 * The runtime JSON contract (`schemas/document.zod.ts`) carries only
 * `{id, sku, quantity}` per component instance. The cross-consistency gate
 * (`pipeline/gates/cross-consistency.ts`) verifies every emitted SKU resolves
 * against `COMPONENTS` here.
 */

/** Component category — used by check (e) of the cross-consistency gate. */
export type ComponentType =
  | "mcu"
  | "sensor"
  | "actuator"
  | "display"
  | "passive"
  | "wire";

/** Pin direction classification — used by rules (sensor-trig-output-pin etc.). */
export type PinDirection =
  | "power_in"
  | "ground"
  | "digital_io"
  | "digital_input"
  | "digital_output"
  | "analog_input"
  | "pwm_output"
  | "i2c_sda"
  | "i2c_scl"
  | "spi_mosi"
  | "spi_miso"
  | "spi_sck"
  | "uart_rx"
  | "uart_tx"
  | "passive";

/**
 * Per-pin metadata. The `anchor` field is a 2D coordinate inside the
 * component's 3D model used by the UI's click-to-label feature; the
 * pipeline doesn't read it but the registry shape must match what the UI
 * expects (this is the shared surface between tracks).
 */
export interface PinMetadata {
  label: string;
  description: string;
  direction: PinDirection;
  /** Voltage requirement in volts. Used by the voltage-match rule. */
  voltage?: number;
  /** Current draw or sink in milliamps. Used by the current-budget rule. */
  current_ma?: number;
  /** 3D model anchor coordinates {x, y, z} in model-local space (UI consumer). */
  anchor?: { x: number; y: number; z: number };
}

/**
 * Per-pin breadboard layout offset. Combined with the `anchor_hole` and
 * `rotation` from the runtime document, the UI computes which breadboard
 * hole each pin lands in. The cross-consistency gate uses this to verify
 * connection holes are reachable.
 */
export interface PinLayout {
  label: string;
  /** Column offset from the anchor hole (0 = anchor column). */
  column_offset: number;
  /** Row offset from the anchor hole (0 = anchor row). */
  row_offset: number;
}

export interface ComponentRegistryEntry {
  /** Adafruit SKU as a string (matches the runtime JSON's `components[].sku`). */
  sku: string;
  /** Beginner-readable product name. */
  name: string;
  type: ComponentType;
  /**
   * One-paragraph beginner-friendly explanation of what the component does
   * and why it's part of the project. Surfaced by the 3D click-to-label
   * feature (Talia's track) and embedded in the LLM system prompt as
   * grounding context (Kai's track).
   */
  education_blurb: string;
  /** Path to the 3D glTF model, served by the UI. */
  model_url: string;
  pin_metadata: ReadonlyArray<PinMetadata>;
  pin_layout: ReadonlyArray<PinLayout>;
  /**
   * Maximum total current the component can source/sink across all I/O pins.
   * Used by the current-budget rule for boards. Optional for non-MCU
   * components (sensors/actuators report per-pin current in `pin_metadata`).
   */
  max_current_ma?: number;
}

/**
 * The registry. Keys are Adafruit SKU strings (matches the runtime JSON's
 * `components[].sku` field). `as const` so the keys are literal types.
 */
export const COMPONENTS = {
  // -------------------------------------------------------------------------
  // SKU 50 — Arduino Uno R3 (the board for archetype 1)
  // -------------------------------------------------------------------------
  "50": {
    sku: "50",
    name: "Arduino Uno R3",
    type: "mcu",
    education_blurb:
      "The brain of your project. Runs your sketch (the C++ code), reads from sensors, and controls things like servos and LEDs through its pins.",
    model_url: "/models/uno-r3.glb",
    max_current_ma: 200, // ATmega328P aggregate I/O limit
    pin_metadata: [
      {
        label: "5V",
        description: "5-volt power output. Use this to power small sensors and the servo.",
        direction: "power_in",
        voltage: 5,
        current_ma: 500,
        anchor: { x: 0.55, y: 0.05, z: 0.0 },
      },
      {
        label: "3.3V",
        description: "3.3-volt power output. Use for sensors that need 3.3V instead of 5V.",
        direction: "power_in",
        voltage: 3.3,
        current_ma: 50,
        anchor: { x: 0.5, y: 0.05, z: 0.0 },
      },
      {
        label: "GND",
        description: "Ground. Every component connects to ground to complete the circuit.",
        direction: "ground",
        anchor: { x: 0.45, y: 0.05, z: 0.0 },
      },
      {
        label: "GND2",
        description: "Second ground pin. Same as the other GND.",
        direction: "ground",
        anchor: { x: 0.4, y: 0.05, z: 0.0 },
      },
      // Digital pins 2-13. Pins 3, 5, 6, 9, 10, 11 are PWM-capable (~ in Arduino IDE).
      { label: "2", description: "Digital pin 2.", direction: "digital_io", anchor: { x: 0.0, y: 0.95, z: 0.0 } },
      { label: "3", description: "Digital pin 3 (PWM).", direction: "pwm_output", anchor: { x: 0.05, y: 0.95, z: 0.0 } },
      { label: "4", description: "Digital pin 4.", direction: "digital_io", anchor: { x: 0.1, y: 0.95, z: 0.0 } },
      { label: "5", description: "Digital pin 5 (PWM).", direction: "pwm_output", anchor: { x: 0.15, y: 0.95, z: 0.0 } },
      { label: "6", description: "Digital pin 6 (PWM).", direction: "pwm_output", anchor: { x: 0.2, y: 0.95, z: 0.0 } },
      { label: "7", description: "Digital pin 7.", direction: "digital_io", anchor: { x: 0.25, y: 0.95, z: 0.0 } },
      { label: "8", description: "Digital pin 8.", direction: "digital_io", anchor: { x: 0.3, y: 0.95, z: 0.0 } },
      { label: "9", description: "Digital pin 9 (PWM). Common pick for the servo.", direction: "pwm_output", anchor: { x: 0.35, y: 0.95, z: 0.0 } },
      { label: "10", description: "Digital pin 10 (PWM).", direction: "pwm_output", anchor: { x: 0.4, y: 0.95, z: 0.0 } },
      { label: "11", description: "Digital pin 11 (PWM).", direction: "pwm_output", anchor: { x: 0.45, y: 0.95, z: 0.0 } },
      { label: "12", description: "Digital pin 12.", direction: "digital_io", anchor: { x: 0.5, y: 0.95, z: 0.0 } },
      { label: "13", description: "Digital pin 13. Has the on-board LED.", direction: "digital_io", anchor: { x: 0.55, y: 0.95, z: 0.0 } },
      // Analog pins
      { label: "A0", description: "Analog input pin 0.", direction: "analog_input", anchor: { x: 0.7, y: 0.05, z: 0.0 } },
      { label: "A1", description: "Analog input pin 1.", direction: "analog_input", anchor: { x: 0.75, y: 0.05, z: 0.0 } },
      { label: "A2", description: "Analog input pin 2.", direction: "analog_input", anchor: { x: 0.8, y: 0.05, z: 0.0 } },
      { label: "A3", description: "Analog input pin 3.", direction: "analog_input", anchor: { x: 0.85, y: 0.05, z: 0.0 } },
      { label: "A4", description: "Analog input pin 4 (also I2C SDA).", direction: "i2c_sda", anchor: { x: 0.9, y: 0.05, z: 0.0 } },
      { label: "A5", description: "Analog input pin 5 (also I2C SCL).", direction: "i2c_scl", anchor: { x: 0.95, y: 0.05, z: 0.0 } },
    ],
    pin_layout: [
      // The Uno doesn't sit on the breadboard like a chip — it sits beside it
      // and uses jumper wires. Layout entries are placeholders for the UI's
      // 3D placement; the breadboard renderer treats the Uno specially.
      { label: "5V", column_offset: 0, row_offset: 0 },
      { label: "GND", column_offset: 0, row_offset: 1 },
    ],
  },

  // -------------------------------------------------------------------------
  // SKU 3942 — HC-SR04 Ultrasonic Distance Sensor
  // -------------------------------------------------------------------------
  "3942": {
    sku: "3942",
    name: "HC-SR04 Ultrasonic Distance Sensor",
    type: "sensor",
    education_blurb:
      "Sends out an ultrasonic chirp and listens for the echo. The Arduino measures how long the echo took, which tells you how far away an object is.",
    model_url: "/models/hc-sr04.glb",
    pin_metadata: [
      {
        label: "VCC",
        description: "Power. Connect to the Arduino's 5V pin.",
        direction: "power_in",
        voltage: 5,
        current_ma: 15,
        anchor: { x: 0.0, y: 0.5, z: 0.0 },
      },
      {
        label: "Trig",
        description:
          "Trigger. The Arduino sends a short HIGH pulse here to make the sensor chirp.",
        direction: "digital_input",
        voltage: 5,
        anchor: { x: 0.33, y: 0.5, z: 0.0 },
      },
      {
        label: "Echo",
        description:
          "Echo. Goes HIGH while the sound is traveling. The Arduino measures how long it stays HIGH to compute distance.",
        direction: "digital_output",
        voltage: 5,
        anchor: { x: 0.66, y: 0.5, z: 0.0 },
      },
      {
        label: "GND",
        description: "Ground. Connect to the Arduino's GND.",
        direction: "ground",
        anchor: { x: 1.0, y: 0.5, z: 0.0 },
      },
    ],
    pin_layout: [
      { label: "VCC", column_offset: 0, row_offset: 0 },
      { label: "Trig", column_offset: 1, row_offset: 0 },
      { label: "Echo", column_offset: 2, row_offset: 0 },
      { label: "GND", column_offset: 3, row_offset: 0 },
    ],
  },

  // -------------------------------------------------------------------------
  // SKU 169 — Micro Servo SG90
  // -------------------------------------------------------------------------
  "169": {
    sku: "169",
    name: "Micro Servo SG90",
    type: "actuator",
    education_blurb:
      "A small motor that turns to a specific angle (0° to 180°). Great for making things wave, point, or open and close.",
    model_url: "/models/sg90.glb",
    pin_metadata: [
      {
        label: "VCC",
        description:
          "Power (red wire). Connect to the Arduino's 5V pin. The Uno can power one small servo directly.",
        direction: "power_in",
        voltage: 5,
        current_ma: 150, // peak current; idle is much lower
        anchor: { x: 0.5, y: 0.0, z: 0.0 },
      },
      {
        label: "GND",
        description: "Ground (brown or black wire). Connect to the Arduino's GND.",
        direction: "ground",
        anchor: { x: 0.0, y: 0.0, z: 0.0 },
      },
      {
        label: "Signal",
        description:
          "Signal (yellow or orange wire). Connect to a PWM-capable Arduino pin (3, 5, 6, 9, 10, or 11).",
        direction: "digital_input",
        voltage: 5,
        anchor: { x: 1.0, y: 0.0, z: 0.0 },
      },
    ],
    pin_layout: [
      { label: "GND", column_offset: 0, row_offset: 0 },
      { label: "VCC", column_offset: 1, row_offset: 0 },
      { label: "Signal", column_offset: 2, row_offset: 0 },
    ],
  },

  // -------------------------------------------------------------------------
  // SKU 239 — Full Sized Premium Breadboard - 830 Tie Points
  // -------------------------------------------------------------------------
  "239": {
    sku: "239",
    name: "Full Sized Breadboard (830 tie points)",
    type: "passive",
    education_blurb:
      "A reusable plastic board with hundreds of holes. Push wires and component legs into the holes to make connections without soldering. Two long rails on each side carry power and ground; the middle is split into rows that connect across.",
    model_url: "/models/breadboard-830.glb",
    pin_metadata: [],
    pin_layout: [],
  },

  // -------------------------------------------------------------------------
  // SKU 758 — Premium Male/Male Jumper Wires - 40 x 6"
  // -------------------------------------------------------------------------
  "758": {
    sku: "758",
    name: "Male/Male Jumper Wires (40 x 6 inch)",
    type: "wire",
    education_blurb:
      "Pre-cut wires with metal pins on both ends. Plug them into the breadboard and Arduino headers to connect things together. Comes in 10 colors — use red for power, black for ground, and pick others for signal lines.",
    model_url: "/models/jumper-wires.glb",
    pin_metadata: [],
    pin_layout: [],
  },
} as const satisfies Readonly<Record<string, ComponentRegistryEntry>>;

/** Convenience lookup keyed by SKU. Returns `undefined` if the SKU is unknown. */
export function lookupBySku(sku: string): ComponentRegistryEntry | undefined {
  return (COMPONENTS as Readonly<Record<string, ComponentRegistryEntry>>)[sku];
}

/** All known SKUs as a Set, useful for the cross-consistency gate. */
export const KNOWN_SKUS: ReadonlySet<string> = new Set(Object.keys(COMPONENTS));
