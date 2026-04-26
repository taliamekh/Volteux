/**
 * Zod schema for the Wokwi assertions.json DSL (v0.5 — Unit 1).
 *
 * The DSL is layered (state-at-timestamp + duration-only + optional
 * serial-regex). Per the v0.5 plan § Key Technical Decisions:
 *
 *   - **state assertions** catch the strongest failure modes (servo never
 *     moves, threshold inverted): a snapshot at `at_ms` checks one or
 *     more named runtime targets against an expected value or numeric
 *     range.
 *   - **duration-only assertions** catch the cheapest failure mode
 *     (sketch crashes immediately): the simulator runs for `run_for_ms`
 *     and the runner asserts no panic / no halt / etc.
 *   - **serial_regex** is OPTIONAL secondary signal in hand-authored
 *     bundles; rejected as a primary contract because regex over the
 *     sketch's source-text is brittle to refactors.
 *
 * The runner evaluates layered passes — every `state` assertion must pass
 * AND every `duration` assertion must pass AND every `serial_regex` (if
 * present) must pass. The full DSL is fed verbatim through the cache-key
 * canonical-envelope hash (`sha256(JSON.stringify({...}))`) so a behavior
 * tweak invalidates the cache by construction.
 *
 * **Why JSON over YAML.** Tooling consistency: Zod parses JSON natively,
 * canonical-envelope hash composes via `JSON.stringify`, and the v0.5
 * cache-key contract requires a single deterministic string. YAML's
 * structural ambiguity (anchors, types, quoting) breaks the cache-key
 * invariant.
 *
 * **Why we don't accept arbitrary `expect` keys at the schema level.**
 * Each known runtime target gets its own field with a tight value/range
 * shape, so a typo in an assertion file fails Zod-validation at load
 * time — long before the simulation runs. This mirrors the
 * c-preprocessor learning: replicate the downstream pipeline's
 * interpretation BEFORE matching. Unknown targets surface as a Zod
 * issue, not as a silent simulation pass against nothing.
 *
 * @see docs/plans/2026-04-27-003-feat-v05-wokwi-behavior-axis-plan.md
 *      § Unit 1 § Files (assertions.zod.ts entry).
 * @see docs/solutions/security-issues/sha256-cache-key-canonical-json-serialization-2026-04-26.md
 *      — single-envelope JSON.stringify for the assertions hash component.
 * @see docs/solutions/best-practices/c-preprocessor-modelling-in-llm-output-gates-2026-04-25.md
 *      — assertions fire against runtime state, not source-text patterns.
 */

import { z } from "zod";

/**
 * Numeric range form: `{min, max}` inclusive on both ends. The
 * canonical layered shape — used for analog targets like `servo_angle`
 * (degrees) where the assertion specifies a tolerance band rather than
 * an exact value. Conservative defaults during impl: ±10° around the
 * target.
 */
const NumericRangeSchema = z
  .object({
    min: z.number(),
    max: z.number(),
  })
  .strict()
  .refine((r) => r.min <= r.max, {
    message: "range.min must be <= range.max",
  });

/**
 * The set of supported `state` runtime targets. Whitelist-shaped: a
 * future runtime sensor adds a literal here + a corresponding evaluator
 * branch. Tight schema today; expanded in tandem with the assertion
 * evaluator's switch statement.
 *
 * Targets:
 *   - `servo_angle` — Servo library output angle in degrees (0..180).
 *     Numeric range form. The strongest archetype-1 behavior signal.
 *   - `gpio_high` — boolean: whether a named GPIO pin is HIGH at the
 *     snapshot. Used for LED / digital-output assertions.
 *   - `serial_contains` — boolean: whether the serial buffer accumulated
 *     up to `at_ms` contains the given substring. Coarser than
 *     `serial_regex` but cheaper to validate.
 *
 * Each target carries its own value shape. Adding a new target requires:
 *   (1) extending this discriminated union with the new key,
 *   (2) a new switch arm in the assertion evaluator (run.ts),
 *   (3) a parallel mock pin/runtime channel in the unit test scaffold.
 */
const StateExpectSchema = z
  .object({
    /** Servo angle in degrees. Range form. */
    servo_angle: NumericRangeSchema.optional(),
    /**
     * GPIO pin's HIGH/LOW state at the snapshot. Pin name follows
     * Wokwi's naming (e.g., `D13`, `A0`). Boolean form.
     */
    gpio_high: z
      .object({
        pin: z.string().min(1),
        value: z.boolean(),
      })
      .strict()
      .optional(),
    /**
     * Substring expected in the serial buffer accumulated up to `at_ms`.
     * Case-sensitive. For richer matching, use `serial_regex` at the
     * top level.
     */
    serial_contains: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (e) =>
      e.servo_angle !== undefined ||
      e.gpio_high !== undefined ||
      e.serial_contains !== undefined,
    { message: "state.expect must declare at least one runtime target" },
  );

const StateAssertionSchema = z
  .object({
    /** Simulation timestamp in milliseconds. Non-negative. */
    at_ms: z.number().int().min(0),
    /** Layered runtime targets to check at `at_ms`. */
    expect: StateExpectSchema,
  })
  .strict();

/**
 * Duration-only assertion. The simulator runs for `run_for_ms` and the
 * runner asserts the post-condition. Today the only post-condition is
 * `no_crash: true` — the cheapest meaningful behavior signal. Future
 * extensions go here without breaking existing bundles (every field is
 * optional, but at least one MUST be set per `.refine`).
 */
const DurationExpectSchema = z
  .object({
    /**
     * Sketch ran for the full `run_for_ms` without panic / halt / kernel
     * exception. The simulator's "no crash" signal is the cheapest behavior
     * assertion — when this fails, the sketch is structurally broken in a
     * way that no other assertion can recover.
     */
    no_crash: z.boolean().optional(),
  })
  .strict()
  .refine((e) => e.no_crash !== undefined, {
    message: "duration.expect must declare at least one post-condition",
  });

const DurationAssertionSchema = z
  .object({
    /** How long the simulator runs before the post-condition is checked. */
    run_for_ms: z.number().int().min(1),
    expect: DurationExpectSchema,
  })
  .strict();

/**
 * Serial-output regex assertion. Optional secondary signal — rejected as
 * primary contract because source-text changes drift the regex without
 * altering behavior. `must_match: true` requires the pattern to appear;
 * `must_match: false` requires it to NOT appear.
 *
 * The pattern is parsed via `new RegExp(pattern, "m")` at evaluation
 * time. A malformed pattern surfaces at evaluation as a runner failure
 * (kind: "transport") with a clear message — invalid-pattern bundles
 * should never reach production but the runner is defensive.
 */
const SerialRegexAssertionSchema = z
  .object({
    /** A JS regex source string. The `m` flag is implicit. */
    pattern: z.string().min(1),
    /** True: must match. False: must NOT match. */
    must_match: z.boolean(),
  })
  .strict();

/**
 * Top-level assertions DSL. All three arrays are optional but at least
 * one assertion MUST be present overall (an empty bundle would silently
 * pass every simulation). The runner enforces this layered conjunction:
 * pass = ALL state assertions pass AND ALL duration assertions pass AND
 * ALL serial_regex assertions pass.
 */
export const WokwiAssertionsSchema = z
  .object({
    state: z.array(StateAssertionSchema).optional(),
    duration: z.array(DurationAssertionSchema).optional(),
    serial_regex: z.array(SerialRegexAssertionSchema).optional(),
  })
  .strict()
  .refine(
    (a) =>
      (a.state?.length ?? 0) +
        (a.duration?.length ?? 0) +
        (a.serial_regex?.length ?? 0) >
      0,
    { message: "assertions must declare at least one of state/duration/serial_regex" },
  );

export type WokwiAssertions = z.infer<typeof WokwiAssertionsSchema>;
export type StateAssertion = z.infer<typeof StateAssertionSchema>;
export type DurationAssertion = z.infer<typeof DurationAssertionSchema>;
export type SerialRegexAssertion = z.infer<typeof SerialRegexAssertionSchema>;
export type StateExpect = z.infer<typeof StateExpectSchema>;
