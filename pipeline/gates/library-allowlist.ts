/**
 * Library and filename allowlist enforcement.
 *
 * Three orthogonal checks, all enforced BEFORE the compile gate (so we never
 * spend a compile slot on a sketch that should be rejected):
 *
 *   1. `sketch.libraries[]` contains only library names in the per-archetype
 *      allowlist.
 *   2. Every `#include <header.h>` parsed from the sketch source maps to a
 *      library in the per-archetype allowlist (libraries[] is advisory; the
 *      real signal is what arduino-cli will auto-resolve).
 *   3. Every key in `sketch.additional_files` matches the strict allowlist
 *      regex (`^[A-Za-z0-9_.-]+\.(ino|h|cpp|c)$`) — no path separators, no
 *      traversal, no null bytes. Defense-in-depth against the arduino-cli
 *      sandbox bypass risk (#758) — same policy lives in the Compile API.
 *
 * These checks are consumed by the cross-consistency gate (Unit 4) and
 * mirrored by the Compile API server (Unit 6).
 */

import type { VolteuxArchetypeId } from "../../schemas/document.zod.ts";

/**
 * Per-archetype library allowlist. v0.1 ships only archetype 1; v1.5 will
 * grow this map.
 *
 * Origin: docs/PLAN.md § "Library allowlist".
 */
export const ARCHETYPE_LIBRARIES: Readonly<
  Record<VolteuxArchetypeId, ReadonlyArray<string>>
> = {
  "uno-ultrasonic-servo": ["Servo"],
  // v1.5 archetypes — empty in v0.1; the intent classifier routes them to
  // Honest Gap before they ever reach this gate, so the empty arrays here
  // are a safety net, not the active allowlist.
  "esp32-audio-dashboard": [],
  "pico-rotary-oled": [],
  "esp32c3-dht-aio": [],
  "uno-photoresistor-led": [],
};

/**
 * Map of `<header.h>` → library name. The key insight: arduino-cli auto-
 * resolves includes, so the LLM might emit `#include <Servo.h>` with an
 * empty `libraries[]` array and the compile would still succeed. We treat
 * the include as the authoritative signal.
 *
 * Standard Arduino-core headers (built into the AVR core, no external
 * library needed) are mapped to the empty string and skipped during the
 * allowlist intersection.
 */
const HEADER_TO_LIBRARY: Readonly<Record<string, string>> = {
  // External libraries
  "Servo.h": "Servo",
  // v1.5 (placeholder mappings; included so the allowlist parser doesn't
  // surface them as "unknown header" — the per-archetype allowlist is what
  // actually rejects them on archetype 1)
  "WiFi.h": "WiFi",
  "WiFiManager.h": "WiFiManager",
  "ESPAsyncWebServer.h": "ESPAsyncWebServer",
  "LittleFS_esp32.h": "LittleFS_esp32",
  "ArduinoJson.h": "ArduinoJson",
  "Adafruit_SSD1306.h": "Adafruit_SSD1306",
  "Adafruit_GFX.h": "Adafruit_GFX",
  "Encoder.h": "Encoder",
  "Adafruit_MQTT.h": "Adafruit_MQTT_Library",
  "Adafruit_MQTT_Client.h": "Adafruit_MQTT_Library",
  "DHT.h": "DHT_sensor_library",
  "Adafruit_NeoPixel.h": "Adafruit_NeoPixel",

  // Arduino-core built-ins (no external library; map to empty string)
  "Arduino.h": "",
  "Wire.h": "",
  "SPI.h": "",
  "EEPROM.h": "",
  "SoftwareSerial.h": "",
};

/**
 * Strict regex for `additional_files` keys. Filename only: alphanumerics,
 * dot, hyphen, underscore. First character MUST be alphanumeric or
 * underscore (rejects leading dash and leading dot). Extension MUST be one
 * of the four C/C++ source extensions arduino-cli understands.
 *
 * Consecutive dots like `test..h` are rejected by `validateAdditionalFileName`
 * (a primary check run BEFORE this regex). Do not rely on the regex alone —
 * `[A-Za-z0-9_.-]*` accepts repeated dots.
 *
 * `.ino` files in additional_files are accepted by THIS regex but
 * rejected by `validateAdditionalFileName` with `kind:"reserved-name"`
 * (round-2 ADV-R2-002). arduino-cli compiles ALL `.ino` files in the
 * sketch directory as ONE translation unit (Arduino IDE's "tabs"
 * concept), so any `.ino` in additional_files (Sketch.ino, another.ino,
 * etc.) is a multi-translation-unit injection vector. Routing the
 * rejection via `reserved-name` rather than `bad-extension` preserves
 * the agent-switchable semantic — agents can distinguish "you tried to
 * inject a second sketch" from "you used a wrong extension."
 *
 * Sandbox bypass surface (arduino-cli #758): `arduino-cli.yaml`,
 * `sketch.json`, `library.properties`, `hardware/platform.txt` would
 * override the platform recipe and execute arbitrary commands. Each is
 * rejected by `validateAdditionalFileName` with `kind:"sandbox-bypass"`
 * before the regex check fires (round-2 AN-R2-002 — round-1 collapsed
 * these into the generic `bad-extension` kind).
 *
 * SINGLE SOURCE OF TRUTH. The Compile API (`infra/server/sketch-fs.ts`)
 * imports this constant + `validateAdditionalFileName`. Defense in depth
 * comes from running the predicate at TWO sites (cross-consistency gate
 * before the compile slot, server before invoking arduino-cli), not from
 * defining it twice. Two literal copies were the bug SEC-002 + ADV-003
 * demonstrated.
 *
 * Origin: scope-guardian + security-lens findings F-004 (initial allowlist);
 * SEC-002 + ADV-003 hardened the leading-character anchor and consecutive-dot
 * rejection; ADV-R2-002 added the `.ino`-as-reserved-name primary check
 * + AN-R2-002 split sandbox-bypass into its own kind.
 */
export const ADDITIONAL_FILE_NAME_REGEX =
  /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.(ino|h|cpp|c)$/;

/**
 * Validate an `additional_files` key against the filename allowlist.
 *
 * Returns `null` on pass. Returns a human-readable reason string on fail.
 *
 * Layered checks (each fails closed):
 *   1. Empty string                      — shouldn't reach here, but cheap to verify.
 *   2. Null byte                         — POSIX path string with a NUL is undefined behavior.
 *   3. Path traversal (`..`)             — primary check (was dead code before SEC-002 / ADV-003 fix;
 *                                          the old regex accepted `test..h`, so this branch was never
 *                                          reached). Now runs BEFORE the regex.
 *   4. Path separator (`/` or `\`)       — disallowed; filenames are flat.
 *   5. Leading slash                     — absolute paths disallowed.
 *   6. Regex                             — alphanumeric/underscore-led, allowed extension.
 *
 * On regex failure, the reason names the regex source so future contributors
 * can grep `ADDITIONAL_FILE_NAME_REGEX` and find this site.
 */
/**
 * Discriminated rejection class. Agent callers (Unit 9 orchestrator,
 * eval harness, smoke script) switch on `kind` rather than parsing the
 * free-text `reason` string. Closes W-001 from the v0.1-pipeline-io
 * review pass.
 *
 * Round-2 review surfaced two missing kinds that escaped via wider local
 * unions (M2-004 / R2-K-007 / AC-010 + AN-R2-002): `reserved-name` was
 * defined locally in `sketch-fs.ts` and emitted over the wire without
 * appearing in this canonical type; `sandbox-bypass` was collapsed into
 * `bad-extension` even though sandbox-bypass filenames warrant a distinct
 * agent-side response. This union now lists ALL six values that the
 * server can emit; agent-side `switch (kind)` is exhaustive over the
 * canonical set.
 *
 *   `empty`             — the name is the empty string
 *   `null-byte`         — POSIX path string with a literal NUL byte
 *   `consecutive-dots`  — `..` anywhere in the name (path traversal /
 *                         extension obfuscation)
 *   `path-separator`    — `/` or `\` in the name (flat names only)
 *   `bad-extension`     — fails the regex (leading dash, leading dot,
 *                         non-allowed extension, non-alphanumeric chars)
 *   `sandbox-bypass`    — name explicitly matches an arduino-cli sandbox
 *                         override surface (`arduino-cli.yaml`,
 *                         `sketch.json`, `library.properties`,
 *                         `platform.txt`, etc.); reported separately so
 *                         agents can surface to operator immediately
 *                         rather than feeding to LLM auto-repair
 *   `reserved-name`     — name would overwrite a reserved filesystem
 *                         entry the server creates (e.g., `sketch.ino`
 *                         main sketch). Wider context: `sketch-fs.ts`.
 */
export type FilenameRejectionKind =
  | "empty"
  | "null-byte"
  | "consecutive-dots"
  | "path-separator"
  | "bad-extension"
  | "sandbox-bypass"
  | "reserved-name";

/**
 * Known arduino-cli sandbox override surfaces. Each is structurally
 * blocked by the extension allowlist regex (none ends in `.h|.cpp|.c`),
 * but emitting `sandbox-bypass` instead of `bad-extension` gives agent
 * callers a discrete signal that a known dangerous name was attempted.
 *
 * Origin: arduino-cli #758 sandbox bypass. Round-2 AN-R2-002 split this
 * out from the generic bad-extension catch-all.
 */
const SANDBOX_BYPASS_NAMES = new Set([
  "arduino-cli.yaml",
  "sketch.json",
  "sketch.yaml",
  "library.properties",
  "platform.txt",
  "boards.txt",
  "programmers.txt",
]);

/**
 * Structured result of a filename allowlist check.
 *
 * `kind` is the agent-switchable enum; `reason` is the human-readable
 * message preserved for log surfaces and beginner-facing error copy.
 */
export interface FilenameRejection {
  kind: FilenameRejectionKind;
  reason: string;
}

/**
 * Validate an `additional_files` key against the allowlist.
 *
 * Returns `null` on pass, or a {kind, reason} pair on fail. Both fields
 * are populated; agent callers should switch on `kind` while log/UI
 * surfaces should display `reason`.
 *
 * Layered checks (each fails closed):
 *   1. Empty string
 *   2. Null byte
 *   3. Consecutive dots (`..`) — primary check; ADV-003 fix
 *   4. Path separator (`/` or `\`)
 *   5. Regex (alphanumeric/underscore-led, allowed extension; SEC-002 fix)
 */
export function validateAdditionalFileName(
  name: string,
): FilenameRejection | null {
  if (name === "")
    return { kind: "empty", reason: "empty filename" };
  if (name.includes("\0"))
    return { kind: "null-byte", reason: "null byte in filename" };
  if (name.includes(".."))
    return {
      kind: "consecutive-dots",
      reason:
        "consecutive dots not allowed (path traversal or extension obfuscation)",
    };
  if (name.includes("/") || name.includes("\\"))
    return {
      kind: "path-separator",
      reason: "path separators not allowed (use a flat filename)",
    };
  // Note: a `startsWith("/")` check used to live here as a "leading slash"
  // guard but it is unreachable — any name beginning with "/" contains "/"
  // and is caught by the path-separator check above.
  // Known sandbox-bypass surfaces — emit a distinct kind so agents can
  // surface to operator immediately rather than feeding to LLM auto-repair.
  // Comparison is case-insensitive (some filesystems are case-insensitive
  // and `Arduino-cli.yaml` would still be processed by arduino-cli).
  if (SANDBOX_BYPASS_NAMES.has(name.toLowerCase()))
    return {
      kind: "sandbox-bypass",
      reason: `${name} is a known arduino-cli sandbox-override surface`,
    };
  // ADV-R2-002 — reject any `.ino` in additional_files as a reserved
  // name. arduino-cli compiles ALL `.ino` files in the sketch directory
  // as one translation unit, so `Sketch.ino`, `another.ino`, `foo.INO`,
  // etc. are all multi-translation-unit injection vectors. Comparison
  // is case-insensitive — some filesystems case-fold and arduino-cli
  // treats both `.ino` and `.INO` as compilable.
  if (name.toLowerCase().endsWith(".ino"))
    return {
      kind: "reserved-name",
      reason:
        "additional_files cannot include .ino files (arduino-cli would compile them as additional translation units; the main sketch is the single sketch_main_ino field)",
    };
  if (!ADDITIONAL_FILE_NAME_REGEX.test(name))
    return {
      kind: "bad-extension",
      reason: `does not match ${ADDITIONAL_FILE_NAME_REGEX.source}`,
    };
  return null;
}

/**
 * C preprocessor Phase 2: splice logical source lines by deleting every
 * backslash-newline pair. The compiler does this BEFORE Phase 3 (tokenization
 * and comment stripping), so `#include \⏎<WiFi.h>` is a valid include
 * directive. Without this splice, the include parser regex wouldn't see the
 * directive and the allowlist could be silently bypassed.
 *
 * Splice deletes the backslash and the newline outright (matches the C
 * preprocessor exactly). Character offsets shrink — that's fine; downstream
 * uses are not line-number-sensitive in v0.1.
 */
function spliceLineContinuations(source: string): string {
  return source.replace(/\\\r?\n/g, "");
}

/**
 * Strip C/C++ line and block comments from source, replacing them with
 * spaces so character offsets are preserved (helps any future line-number
 * reporting). False-positive `#include` matches inside string literals
 * are handled separately by `parseIncludes` via a line-start anchor.
 */
export function stripComments(source: string): string {
  let result = source;
  // Block comments first (greedy across newlines)
  result = result.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, " "),
  );
  // Then line comments
  result = result.replace(/\/\/[^\n]*/g, (match) =>
    match.replace(/./g, " "),
  );
  return result;
}

/**
 * Extract every `#include <header>` or `#include "header"` from a single
 * source string. Pipeline:
 *   1. Splice line continuations (C preprocessor Phase 2 — security: SEC-001)
 *   2. Strip block + line comments (so commented-out includes don't match)
 *   3. Match `#include` ONLY at line start (after optional whitespace).
 *      C preprocessor directives must begin a logical line, so `#include`
 *      appearing inside a string literal — which always sits after some
 *      `=`/`(`/etc. on the same logical line — is naturally excluded by
 *      this anchor. C strings cannot contain a literal newline (only the
 *      `\n` escape sequence), so the line-start anchor is sufficient
 *      protection against false-positive matches inside string constants.
 *
 * Returns an array of header names (e.g., `["Servo.h", "Wire.h"]`).
 */
export function parseIncludes(source: string): ReadonlyArray<string> {
  const spliced = spliceLineContinuations(source);
  const stripped = stripComments(spliced);
  // `m` flag: ^ matches start of each line; `gm` walks every directive.
  const re = /^[ \t]*#[ \t]*include[ \t]*[<"]([^>"\s]+)[>"]/gm;
  const headers: string[] = [];
  for (const match of stripped.matchAll(re)) {
    if (match[1]) headers.push(match[1]);
  }
  return headers;
}

/**
 * Map a parsed header to its declared library name. Returns:
 *   - the library name (string, possibly "") if the header is known
 *   - `undefined` if the header is not in the map (treated as "unknown
 *     library" — flagged by the allowlist gate)
 */
export function headerToLibrary(header: string): string | undefined {
  return HEADER_TO_LIBRARY[header];
}

/** Result type for each individual allowlist check. */
export type AllowlistViolation =
  | {
      kind: "filename-allowlist";
      filename: string;
      reason: string;
      /** The structured rejection class (closes W-001 from review). */
      rejection_kind: FilenameRejectionKind;
    }
  | {
      kind: "library-not-in-allowlist";
      library: string;
      source: "libraries-field" | `include:${string}`;
    }
  | {
      kind: "unknown-header";
      header: string;
      file: string;
    }
  | {
      kind: "include-without-libraries-declaration";
      header: string;
      library: string;
      file: string;
    };

export interface AllowlistInput {
  archetype_id: VolteuxArchetypeId;
  main_ino: string;
  additional_files: Readonly<Record<string, string>>;
  libraries: ReadonlyArray<string>;
}

/**
 * Run all three allowlist checks. Returns the (possibly empty) list of
 * violations. The cross-consistency gate (Unit 4) calls this and folds
 * the results into its overall result.
 *
 * Pure function. Order of returned violations: filename violations first
 * (we'd want to abort early on those), then library violations.
 */
export function runAllowlistChecks(
  input: AllowlistInput,
): ReadonlyArray<AllowlistViolation> {
  const violations: AllowlistViolation[] = [];

  // (1) Filename allowlist for additional_files keys
  for (const filename of Object.keys(input.additional_files)) {
    const rejection = validateAdditionalFileName(filename);
    if (rejection !== null) {
      violations.push({
        kind: "filename-allowlist",
        filename,
        reason: rejection.reason,
        rejection_kind: rejection.kind,
      });
    }
  }

  // (2) Per-archetype library allowlist for the libraries[] field
  const allowlist = ARCHETYPE_LIBRARIES[input.archetype_id] ?? [];
  const allowedSet = new Set(allowlist);
  for (const library of input.libraries) {
    if (!allowedSet.has(library)) {
      violations.push({
        kind: "library-not-in-allowlist",
        library,
        source: "libraries-field",
      });
    }
  }

  // (3) Per-archetype library allowlist via #include parsing.
  // Skip files that already failed the filename allowlist — we don't trust
  // their content. Also skip the contents of *known-bad* additional_files,
  // but still scan main_ino and well-named additional files.
  const filesToScan: ReadonlyArray<{ name: string; source: string }> = [
    { name: "main_ino", source: input.main_ino },
    ...Object.entries(input.additional_files)
      .filter(([name]) => ADDITIONAL_FILE_NAME_REGEX.test(name))
      .map(([name, source]) => ({ name, source })),
  ];

  const declaredLibraries = new Set(input.libraries);

  for (const file of filesToScan) {
    for (const header of parseIncludes(file.source)) {
      const library = headerToLibrary(header);
      if (library === undefined) {
        violations.push({
          kind: "unknown-header",
          header,
          file: file.name,
        });
        continue;
      }
      // Empty string = Arduino-core built-in, no allowlist entry needed
      if (library === "") continue;
      if (!allowedSet.has(library)) {
        violations.push({
          kind: "library-not-in-allowlist",
          library,
          source: `include:${file.name}`,
        });
        continue;
      }
      // Library is in the per-archetype allowlist, but the LLM also has to
      // declare it in libraries[] explicitly. arduino-cli would auto-resolve
      // the include even with libraries: [], but the document's libraries[]
      // field becomes misleading and the v0.5 eval harness will key on it.
      if (!declaredLibraries.has(library)) {
        violations.push({
          kind: "include-without-libraries-declaration",
          header,
          library,
          file: file.name,
        });
      }
    }
  }

  return violations;
}
