<!-- This prompt is consumed by the meta-harness in v0.9. Edit via PR; the proposer reads the latest committed version. -->
<!-- Template format: 4 fenced gate-specific stems below. The runtime selects the matching stem and substitutes the placeholders {{prior_doc_summary}} and {{errors_block}}. Edits should preserve the placeholders verbatim. -->

# Cross-gate repair instructions

Your previous attempt produced a JSON document that passed the structured-output schema but failed a downstream gate. The schema/registry primer above is unchanged; correct only the specific failure noted below. JSON only — no markdown fences, no prose.

## Stem: schema

This stem is reserved. Schema failures are auto-repaired inside generate(); cross-gate repair never fires for schema-failed.

## Stem: xconsist

Prior document summary: {{prior_doc_summary}}

The cross-consistency gate found referential-integrity violations between your components, wiring, and sketch. Each error names the failing check (a-h) per the gate's labeling. Fix every listed violation in your next attempt:

{{errors_block}}

Common fixes:
- (a) duplicate component ids: rename the duplicates so each `components[].id` is unique.
- (b) connection references unknown component id: ensure every `connections[].from.component_id` and `to.component_id` matches a `components[].id`.
- (c) connection references unknown pin label: pin labels must exist in the source component's `pin_metadata` per the registry.
- (d) breadboard_layout references unknown component id: every layout entry's `component_id` must match a `components[].id`.
- (e) component missing breadboard_layout entry: every sensor/actuator/display/passive needs a layout placement (the breadboard itself does not).
- (f) board.fqbn does not match canonical FQBN for board.type: for board.type "uno", fqbn must be "arduino:avr:uno".
- (g) component references unknown SKU: only use SKUs from the registry primer; do not invent SKUs.
- (h) library not in archetype allowlist OR sketch #include not declared in libraries[]: keep both the `libraries[]` field and the `#include` directives in sync; only Servo and the Arduino-built-in libraries are permitted for archetype 1.

Return a corrected JSON document.

## Stem: rules

Prior document summary: {{prior_doc_summary}}

The archetype-1 rules engine flagged red violations on your previous output. Each rule has a stable ID; fix every listed violation:

{{errors_block}}

Common red rules and how to satisfy them:
- voltage-match: ensure every connection's voltage rails are compatible (HC-SR04 needs 5V, the Uno provides 5V; do not wire HC-SR04 to 3.3V).
- current-budget: the Uno's 5V regulator can only source ~500mA; the SG90 servo's stall current is ~700mA. Acknowledge that direct USB power is sufficient for this archetype but flag if drawing over budget.
- breadboard-rail-discipline: the breadboard's red/blue rails must be powered consistently; do not split power and ground across columns.
- no-floating-pins: every used MCU pin must have a defined direction in the sketch (`pinMode(pin, INPUT)` or `pinMode(pin, OUTPUT)`).
- wire-color-discipline: red is power, black is ground, signal wires use the documented colors per the system prompt.
- pin-uniqueness: no two component pins drive the same Uno pin.
- servo-pwm-pin: the SG90 servo signal must connect to a PWM-capable Uno pin (3, 5, 6, 9, 10, or 11).
- sensor-trig-output-pin: the HC-SR04 Trig pin connects to an Uno digital output pin.
- sensor-echo-input-pin: the HC-SR04 Echo pin connects to an Uno digital input pin.
- sketch-references-pins: every pin number used in the sketch must be declared in the connections.
- no-v15-fields-on-archetype-1: do not emit `external_setup.captive_portal_ssid`, `aio_feed_names`, or `mdns_name`.

Return a corrected JSON document.

## Stem: compile

Prior document summary: {{prior_doc_summary}}

The arduino-cli compile failed on your previous attempt. The compile error stderr is below; fix the sketch source so it compiles cleanly. Keep the wiring + parts list unchanged unless the compile error specifically requires a wiring change.

{{errors_block}}

Common compile failures:
- missing #include: every header used in the sketch needs an `#include <Library.h>` at the top.
- undeclared identifier: ensure every variable, constant, and pin is declared before use.
- type mismatch: Arduino's `int`, `byte`, `unsigned long` distinctions matter; check function signatures.
- function signature mismatch: `Serial.begin(baud)` takes one argument; `pinMode(pin, mode)` takes two.

Return a corrected JSON document with the fixed sketch.
