/**
 * Status-event emitter for the v0 Uno flash spike harness.
 *
 *   formatStatusLine(event) → "STEP=<id> STATUS=<state> [DETAIL=<...>]"
 *   buildStatusEmitter(deps) → { emit(event): void }
 *
 * The Node harness emits one status line per state transition on STDERR
 * in the format above. `app/src/components/FlashModal.tsx` consumes this
 * verbatim — Talia's post-spike integration parses each stderr line for
 * the 4 step IDs (`connect | compile | upload | verify`) and renders
 * them through her existing 4-step stepper.
 *
 * Format choice. Plain `KEY=VALUE KEY=VALUE` (not JSON) so the
 * serializer is grep-friendly during hands-on debugging — Kai's Day-1
 * iteration loop is `bun run spike:flash 2>&1 | tee /tmp/spike.log`,
 * and `grep STEP=` should yield one line per state change. JSON-Lines
 * would also work but adds shell-quoting friction during iteration.
 *
 * Stream discipline. Status events go on STDERR; the final
 * `{ok: true|false, ...}` SpikeResult goes on STDOUT as a single JSON
 * line. This separation lets `bun run spike:flash > result.json` capture
 * just the outcome while the operator watches stderr for progress.
 *
 * **Throwing is NOT crossed here.** This module's only failure mode is
 * a write to stderr failing — Bun handles that internally; we don't try
 * to recover. There is no `try/catch` in `emit()`.
 *
 * **Wire-contract uniformity with Talia's batch.** The `SpikeStepEvent`
 * type lives in `spike-types.ts` so her `FlashModal.tsx` integration
 * imports the same definition the harness emits. Forward-compatible
 * field additions (`progress_pct`, `byte_offset`) are allowed; renames
 * or removals are breaks and require schema-discipline joint signoff.
 */

import type { SpikeStepEvent } from "./spike-types.ts";

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/**
 * Render one status event to a single line in the agreed format:
 *   STEP=<id> STATUS=<state> [DETAIL=<...>] [REASON=<...>]
 *
 * Whitespace, newlines, and `=` characters in `detail`/`reason` would
 * break the parse on Talia's side. We replace them with single spaces
 * so the line stays parseable; the underlying message content survives
 * verbatim minus the whitespace normalization. Verbatim error strings
 * are still captured in the JSON-line `SpikeResult` written to stdout
 * (which IS the source of truth for diagnostic content).
 */
export function formatStatusLine(event: SpikeStepEvent): string {
  const parts = [`STEP=${event.step}`, `STATUS=${event.state}`];
  if (event.detail !== undefined) {
    parts.push(`DETAIL=${sanitizeForLine(event.detail)}`);
  }
  if (event.reason !== undefined) {
    parts.push(`REASON=${sanitizeForLine(event.reason)}`);
  }
  return parts.join(" ");
}

/**
 * Replace newlines, tabs, and excess whitespace with single spaces so
 * the KEY=VALUE format stays single-line. The `=` character is allowed
 * in values because the parser only splits on the FIRST `=` of each
 * key. Quotes are NOT added — Talia's integration treats values as raw
 * strings and the production stderr is human-readable, not shell-eval-d.
 */
function sanitizeForLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Emitter (DI shape; testable)
// ---------------------------------------------------------------------------

export interface StatusEmitterDeps {
  /** Sink for one formatted status line. Production wires `console.error`. */
  write: (line: string) => void;
}

export interface StatusEmitter {
  emit(event: SpikeStepEvent): void;
}

/**
 * Construct a status emitter. Pure factory; no env reads. Tests pass an
 * in-memory `write` that captures lines into an array; production wires
 * `(line) => console.error(line)` so events land on stderr.
 *
 * The DI shape mirrors `buildGenerator(deps)` and `buildApp(deps)` —
 * the harness builds its emitter once at startup and threads it through
 * the run-spike orchestrator so each state transition is a single
 * `emitter.emit({...})` call.
 */
export function buildStatusEmitter(deps: StatusEmitterDeps): StatusEmitter {
  return {
    emit(event: SpikeStepEvent): void {
      deps.write(formatStatusLine(event));
    },
  };
}

/**
 * Convenience: a stderr-bound emitter built around `console.error`.
 * Production wiring uses this; tests build their own in-memory emitter
 * with `buildStatusEmitter({write: lines.push.bind(lines)})`.
 */
export function defaultStatusEmitter(): StatusEmitter {
  return buildStatusEmitter({
    write: (line) => {
      // eslint-disable-next-line no-console -- this IS the spike's status sink
      console.error(line);
    },
  });
}
