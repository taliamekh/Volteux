// Datasheet values sourced from HC-SR04 + SG90 manufacturer datasheets. Update when archetypes 2-5 ship.

export interface ConnectionSpec {
  from: string;
  fromPin: string;
  fromPinNum: string | number;
  to: string;
  toPin: string;
  toPinNum: string | number;
  wireColor: string;
  voltage: string;
  notes: string;
}

export interface ComponentSpec {
  [key: string]: string;
}

export interface ArchetypeSpec {
  connections: ConnectionSpec[];
  componentSpecs: Record<string, ComponentSpec>;
}

export const COMPONENT_SPECS: Record<string, ArchetypeSpec> = {
  "uno-ultrasonic-servo": {
    connections: [
      {
        from: "Uno",
        fromPin: "D7",
        fromPinNum: 7,
        to: "HC-SR04",
        toPin: "Trig",
        toPinNum: 1,
        wireColor: "#f59e0b",
        voltage: "5V TTL",
        notes:
          "Output from Uno. Minimum 10µs HIGH pulse triggers measurement.",
      },
      {
        from: "Uno",
        fromPin: "D8",
        fromPinNum: 8,
        to: "HC-SR04",
        toPin: "Echo",
        toPinNum: 2,
        wireColor: "#3b82f6",
        voltage: "5V TTL",
        notes:
          "Input to Uno. HIGH duration = round-trip time. distance = time / 58 (cm).",
      },
      {
        from: "Uno",
        fromPin: "5V",
        fromPinNum: "PWR",
        to: "HC-SR04",
        toPin: "VCC",
        toPinNum: 3,
        wireColor: "#ef4444",
        voltage: "5V DC",
        notes: "HC-SR04 operating range 4.5–5.5V. Current draw ~15mA.",
      },
      {
        from: "Uno",
        fromPin: "GND",
        fromPinNum: "GND",
        to: "HC-SR04",
        toPin: "GND",
        toPinNum: 4,
        wireColor: "#6b7280",
        voltage: "0V",
        notes: "Common ground. Connect before applying VCC.",
      },
      {
        from: "Uno",
        fromPin: "D9 (PWM)",
        fromPinNum: 9,
        to: "SG90 Servo",
        toPin: "Signal",
        toPinNum: "orange",
        wireColor: "#f97316",
        voltage: "5V PWM",
        notes: "50Hz PWM. 1ms = 0°, 1.5ms = 90°, 2ms = 180°.",
      },
      {
        from: "Uno",
        fromPin: "5V",
        fromPinNum: "PWR",
        to: "SG90 Servo",
        toPin: "VCC",
        toPinNum: "red",
        wireColor: "#ef4444",
        voltage: "5V DC",
        notes:
          "4.8–6V operating range. Stall current up to 750mA — use external supply for production.",
      },
      {
        from: "Uno",
        fromPin: "GND",
        fromPinNum: "GND",
        to: "SG90 Servo",
        toPin: "GND",
        toPinNum: "brown",
        wireColor: "#6b7280",
        voltage: "0V",
        notes: "Share ground with external servo supply if used.",
      },
    ],
    componentSpecs: {
      "HC-SR04": {
        voltage: "4.5–5.5V",
        current: "~15mA",
        range: "2cm – 400cm",
        frequency: "40kHz ultrasonic",
        triggerPulse: "≥10µs HIGH",
        echoPulse: "Proportional to distance",
      },
      "SG90 Servo": {
        voltage: "4.8–6V",
        idleCurrent: "~10mA",
        stallCurrent: "~750mA",
        pwmFrequency: "50Hz (20ms period)",
        pulseRange: "1ms (0°) to 2ms (180°)",
        torque: "1.8 kg/cm at 4.8V",
      },
    },
  },
  "esp32-audio-dashboard": {
    connections: [],
    componentSpecs: {},
  },
  "pico-rotary-oled": {
    connections: [],
    componentSpecs: {},
  },
  "esp32c3-dht-aio": {
    connections: [],
    componentSpecs: {},
  },
  "uno-photoresistor-led": {
    connections: [],
    componentSpecs: {},
  },
};
