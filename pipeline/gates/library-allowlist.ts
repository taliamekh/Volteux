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
 * dot, hyphen, underscore. Extension must be one of the four C/C++ source
 * extensions arduino-cli understands. No path separators, no traversal,
 * no leading slash, no empty string.
 *
 * Origin: scope-guardian + security-lens findings F-004; mirrors the same
 * regex used inside the Compile API in Unit 6.
 */
export const ADDITIONAL_FILE_NAME_REGEX = /^[A-Za-z0-9_.-]+\.(ino|h|cpp|c)$/;

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
    if (!ADDITIONAL_FILE_NAME_REGEX.test(filename)) {
      violations.push({
        kind: "filename-allowlist",
        filename,
        reason: filenameViolationReason(filename),
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

function filenameViolationReason(filename: string): string {
  if (filename === "") return "empty filename";
  if (filename.includes("\0")) return "null byte in filename";
  if (filename.startsWith("/")) return "absolute path not allowed";
  if (filename.includes("..")) return "path traversal not allowed";
  if (filename.includes("/") || filename.includes("\\"))
    return "path separators not allowed (use a flat filename)";
  return `does not match ${ADDITIONAL_FILE_NAME_REGEX.source}`;
}
