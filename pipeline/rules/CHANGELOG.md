# Rules Engine CHANGELOG

Tracks severity changes for rules in `pipeline/rules/`.

**Discipline (per `docs/plans/2026-04-25-001-feat-v01-pipeline-archetype-1-plan.md`
Risks table — "Rule severity self-tuning during weeks 3-4"):** any severity
downgrade during weeks 3-4 of v0.1-pipeline implementation requires:
1. An explicit `// SEVERITY DOWNGRADED ON YYYY-MM-DD: <evidence-the-issue-is-benign>`
   comment in the rule file
2. A new entry in this CHANGELOG explaining what evidence supports the change

Without this discipline the acceptance gate becomes self-validating: Kai writes
the rules + the prompts; downgrading a stuck rule is the path of least
resistance to "passing" the milestone. Treat severity changes with the same
friction as schema changes.

---

## v0.1 — 2026-04-25 — Initial severity assignments

11 archetype-1 rules registered. Severity assignments locked before week 3.

| Rule | Severity | Rationale |
|------|----------|-----------|
| `voltage-match` | red | Wrong voltage damages components or produces undefined behavior |
| `current-budget` | amber | Close to limit works intermittently — flag, don't block |
| `breadboard-rail-discipline` | blue | Cosmetic, but worth noting for beginners |
| `no-floating-pins` | red | Floating signal pins produce nondeterministic sensor output |
| `wire-color-discipline` | amber | Works either way; convention helps beginner mental models |
| `pin-uniqueness` | red | Two outputs on one MCU pin is electrically destructive |
| `servo-pwm-pin` | amber | Non-PWM pins work via Servo library but jitter visibly |
| `sensor-trig-output-pin` | red | HC-SR04 Trig must be a digital output; otherwise sketch can't drive it |
| `sensor-echo-input-pin` | red | HC-SR04 Echo must be a digital input; pulseIn() requires it |
| `sketch-references-pins` | red | Wiring/code mismatch produces silent failure (the failure mode this tool exists to prevent) |
| `no-v15-fields-on-archetype-1` | amber | LLM confusion signal; closes v0.1 schema-v1.5-emit-policy decision |

Closes the unresolved decision in `docs/PLAN.md` "Schema v1.5 fields emitted
in v0: fail or warn?" — implementation is **allow at schema, warn at rule**.
