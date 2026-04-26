/**
 * Honest Gap formatter — Unit 6.
 *
 * Pure function. Takes a `PipelineFailure` and the original user prompt;
 * returns a `VolteuxHonestGap` shape suitable for the UI to render
 * verbatim. No I/O, no async, no env reads.
 *
 *   formatHonestGap(failure, prompt) → VolteuxHonestGap
 *
 * The schema's `VolteuxHonestGap` type is the single source of truth for
 * the shape (`{scope, missing_capabilities, explanation}`). We never
 * redefine it here.
 *
 * **Per-kind decision matrix** (from plan § Key Technical Decisions):
 *
 * | Failure kind     | scope         | explanation style                                                  |
 * |------------------|---------------|--------------------------------------------------------------------|
 * | out-of-scope     | out-of-scope  | "Your idea needs <missing>, which v0 does not support."            |
 * | schema-failed    | out-of-scope  | "I tried twice but couldn't shape this idea into a valid project." |
 * | compile-failed   | partial       | "I built the wiring + parts list, but the sketch wouldn't compile."|
 * | rules-red        | partial       | "I built the wiring + sketch, but flagged a safety issue."         |
 * | xconsist-failed  | partial       | "I built the parts list but the wiring referenced things that don't exist." |
 * | transport        | out-of-scope  | "I couldn't reach the build server. Try again in a minute."        |
 * | truncated        | out-of-scope  | "The sketch I tried to write was too long for one response."       |
 * | aborted          | out-of-scope  | "This run was cancelled before completion."                        |
 *
 * Each kind has its own builder so a future change (e.g., richer
 * `compile_stderr`-aware copy) is local. The dispatcher uses
 * `assertNeverPipelineFailureKind` to catch new literals at compile-time.
 */

import type {
  VolteuxHonestGap,
  VolteuxHonestGapScope,
} from "../schemas/document.zod.ts";
import {
  assertNeverPipelineFailureKind,
  type PipelineFailure,
  type PipelineFailureKind,
} from "./index.ts";

// ---------------------------------------------------------------------------
// Per-kind explanation builders (small pure functions)
// ---------------------------------------------------------------------------

function buildOutOfScopeExplanation(failure: PipelineFailure): string {
  // The classifier reasoning, when present, names the missing capability
  // in the model's own words. Fall back to a generic line otherwise.
  const reasoning = failure.classifier_reasoning ?? "";
  const trimmed = reasoning.trim().slice(0, 200);
  if (trimmed.length === 0) {
    return "Your idea needs hardware or capabilities that v0 does not support yet. v0.1 covers the Arduino Uno + HC-SR04 ultrasonic sensor + SG90 micro-servo archetype only.";
  }
  return `Your idea needs hardware or capabilities that v0 does not support yet. ${trimmed}`;
}

function buildSchemaFailedExplanation(_failure: PipelineFailure): string {
  return "I tried twice but couldn't shape this idea into a valid project document. Try rewording your description with more concrete details about what you want the device to do.";
}

function buildCompileFailedExplanation(failure: PipelineFailure): string {
  // Trim stderr to the first line for beginner-readability; the full
  // stderr lives in the trace.
  const stderr = (failure.compile_stderr ?? failure.errors[0] ?? "").trim();
  const firstLine = stderr.split("\n")[0]?.slice(0, 200) ?? "";
  if (firstLine.length === 0) {
    return "I built the wiring + parts list, but the Arduino sketch I generated wouldn't compile. The sketch is in your trace if you want to inspect it.";
  }
  return `I built the wiring + parts list, but the Arduino sketch I generated wouldn't compile: ${firstLine}`;
}

function buildRulesRedExplanation(failure: PipelineFailure): string {
  const firstViolation = failure.errors[0]?.slice(0, 200) ?? "";
  if (firstViolation.length === 0) {
    return "I built the wiring + sketch, but the safety/correctness rules engine flagged a problem. Look at the trace for the specific rule.";
  }
  return `I built the wiring + sketch, but flagged a safety or correctness issue: ${firstViolation}`;
}

function buildXconsistFailedExplanation(failure: PipelineFailure): string {
  const firstError = failure.errors[0]?.slice(0, 200) ?? "";
  if (firstError.length === 0) {
    return "I built the parts list but the wiring referenced things that don't exist (a pin, a component, or a SKU). Look at the trace for details.";
  }
  return `I built the parts list but the wiring referenced things that don't exist: ${firstError}`;
}

function buildTransportExplanation(_failure: PipelineFailure): string {
  return "I couldn't reach the build server. Try again in a minute. If it keeps failing, your network or the Compile API may be down.";
}

function buildTruncatedExplanation(_failure: PipelineFailure): string {
  return "The Arduino sketch I tried to write was too long for one response. Try a simpler description, or break the project into smaller pieces.";
}

function buildAbortedExplanation(_failure: PipelineFailure): string {
  return "This run was cancelled before completion. Re-run the same prompt to try again.";
}

// ---------------------------------------------------------------------------
// Per-kind scope dispatch
// ---------------------------------------------------------------------------

function scopeForKind(kind: PipelineFailureKind): VolteuxHonestGapScope {
  switch (kind) {
    case "out-of-scope":
      return "out-of-scope";
    case "schema-failed":
      return "out-of-scope";
    case "compile-failed":
      return "partial";
    case "rules-red":
      return "partial";
    case "xconsist-failed":
      return "partial";
    case "transport":
      return "out-of-scope";
    case "truncated":
      return "out-of-scope";
    case "aborted":
      return "out-of-scope";
    default:
      assertNeverPipelineFailureKind(kind);
  }
}

// ---------------------------------------------------------------------------
// missing_capabilities builders
// ---------------------------------------------------------------------------

/**
 * The schema's `HonestGap` requires `missing_capabilities` to be an
 * array of non-empty strings (`z.array(z.string().min(1))`); the array
 * itself may be empty, but each element must be non-empty if present.
 *
 * For `partial` and `out-of-scope` scopes we always populate at least
 * one capability so the UI has something to render. For `transport`/
 * `aborted`/`truncated` (also out-of-scope), the "missing" is more like
 * "infra to reach"; we use a short stable list so the UI doesn't need
 * to special-case empty arrays.
 */
function missingCapabilitiesForKind(
  kind: PipelineFailureKind,
  failure: PipelineFailure,
): ReadonlyArray<string> {
  switch (kind) {
    case "out-of-scope": {
      // Pull the classifier's own assessment if available; else generic.
      const reasoning = failure.classifier_reasoning ?? "";
      if (reasoning.trim().length > 0) {
        return [reasoning.trim().slice(0, 200)];
      }
      return ["archetype-1 hardware (Uno + HC-SR04 + SG90 servo)"];
    }
    case "schema-failed":
      return ["a clearly-shaped project description that maps to archetype 1"];
    case "compile-failed":
      return ["a sketch that compiles cleanly with arduino-cli"];
    case "rules-red":
      return ["safety/correctness compliance with the archetype-1 rule set"];
    case "xconsist-failed":
      return ["referential integrity between components, wiring, and sketch"];
    case "transport":
      return ["a reachable Compile API"];
    case "truncated":
      return ["a sketch that fits within the model's response budget"];
    case "aborted":
      return ["completion of the run"];
    default:
      assertNeverPipelineFailureKind(kind);
  }
}

// ---------------------------------------------------------------------------
// Per-kind explanation dispatch
// ---------------------------------------------------------------------------

function explanationForKind(
  kind: PipelineFailureKind,
  failure: PipelineFailure,
): string {
  switch (kind) {
    case "out-of-scope":
      return buildOutOfScopeExplanation(failure);
    case "schema-failed":
      return buildSchemaFailedExplanation(failure);
    case "compile-failed":
      return buildCompileFailedExplanation(failure);
    case "rules-red":
      return buildRulesRedExplanation(failure);
    case "xconsist-failed":
      return buildXconsistFailedExplanation(failure);
    case "transport":
      return buildTransportExplanation(failure);
    case "truncated":
      return buildTruncatedExplanation(failure);
    case "aborted":
      return buildAbortedExplanation(failure);
    default:
      assertNeverPipelineFailureKind(kind);
  }
}

// ---------------------------------------------------------------------------
// Public dispatcher
// ---------------------------------------------------------------------------

/**
 * Format a `PipelineFailure` into the schema's `VolteuxHonestGap` shape.
 *
 * Pure function — no I/O, no async, no env reads. The `prompt` parameter
 * is currently unused by every per-kind builder; it stays in the
 * signature so a future contributor can incorporate it without changing
 * the call sites (e.g., a `compile-failed` builder could quote a
 * relevant sketch fragment from the prompt).
 */
export function formatHonestGap(
  failure: PipelineFailure,
  // Unused at v0.1; reserved for future per-kind builders that may
  // quote the prompt back to the user.
  _prompt: string,
): VolteuxHonestGap {
  return {
    scope: scopeForKind(failure.kind),
    missing_capabilities: [...missingCapabilitiesForKind(failure.kind, failure)],
    explanation: explanationForKind(failure.kind, failure),
  };
}
