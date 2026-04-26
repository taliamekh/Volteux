// canonical-servo.ino — Day-2 baseline sketch for the Uno flash spike.
//
// Purpose: the harder verification target. Servo's PWM timing exercises
// code paths that simple GPIO toggling does not — a hex that writes
// byte-correct via STK500v1 read-back but does NOT physically sweep the
// servo is the actual signal the spike is built to surface.
//
// Behavior: 2-second startup delay (lets the operator confirm the previous
// sketch stopped before this one starts), then a single 0 → 180 → 0
// sweep at 10ms per degree, then idle. One-shot rather than continuous
// so the visual result is unambiguous and a stuck servo doesn't masquerade
// as "running".
//
// Wiring per fixtures/generated/archetype-1/01-distance-servo.json:
//   servo VCC    → Uno 5V
//   servo GND    → Uno GND
//   servo Signal → Uno pin 9 (PWM-capable)

#include <Servo.h>

const int SERVO_PIN = 9;
const int STEP_DELAY_MS = 10;

Servo myServo;

void setup() {
  myServo.attach(SERVO_PIN);
  myServo.write(0);
  delay(2000);

  for (int angle = 0; angle <= 180; angle++) {
    myServo.write(angle);
    delay(STEP_DELAY_MS);
  }
  for (int angle = 180; angle >= 0; angle--) {
    myServo.write(angle);
    delay(STEP_DELAY_MS);
  }
}

void loop() {
  // Idle. The setup() one-shot sweep is the entire visible behavior;
  // re-flashing is the way to repeat the sweep.
}
