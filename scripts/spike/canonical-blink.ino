// canonical-blink.ino — Day-1 baseline sketch for the Uno flash spike.
//
// Purpose: answer "is the BOARD even responsive to a freshly-flashed sketch
// at all?" in isolation from any LLM-emitted Servo / library complexity.
// If avrgirl-arduino reports a successful write+verify and the on-board
// LED on pin 13 is NOT blinking the distinctive 200ms-on / 800ms-off
// pattern below, the harness has surfaced a verify-mismatch-style false
// positive that should be captured verbatim in the spike report.
//
// The blink cadence is intentionally asymmetric (200/800, not 500/500) so
// the visual result is unambiguous — a pre-existing factory-burned bootloader
// blink (different timing) cannot be confused with this sketch running.
//
// Pin: 13 = on-board LED on every Uno R3 variant (genuine + clones).

void setup() {
  pinMode(13, OUTPUT);
}

void loop() {
  digitalWrite(13, HIGH);
  delay(200);
  digitalWrite(13, LOW);
  delay(800);
}
