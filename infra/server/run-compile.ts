/**
 * Wrapper around the `arduino-cli compile` subprocess.
 *
 * Critical invariants:
 *   - `--build-path` and `--output-dir` are DIFFERENT directories
 *     (arduino-cli #2318 — sharing them produces empty artifacts on some
 *     versions; we don't share regardless of fix status).
 *   - `arduino-cli` is invoked via argument array, NEVER shell-interpolated.
 *     The hardened filename regex forbids leading-dash filenames, but
 *     defense in depth: argv-style invocation forecloses every shell-meta
 *     class.
 *   - The shared build cache (the AVR core's compiled objects) is reused
 *     across requests for warm-cache wins. The path is set ONCE at image
 *     build time via `arduino-cli config set build_cache.path` (in the
 *     Dockerfile), NOT per-invocation. The previous `--build-cache-path`
 *     CLI flag is deprecated in arduino-cli 1.4.x and was producing a
 *     deprecation warning on every cold compile that landed in `stderr`
 *     and would have been fed back to Sonnet's auto-repair turn.
 *
 * Returns the .hex artifact (base64) and `stderr` verbatim. The handler
 * surfaces stderr on compile failure so the LLM auto-repair turn (Unit 9)
 * gets the exact gcc message to feed back.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface RunCompileInput {
  /** Absolute path to the sketch directory (from sketch-fs.ts). */
  sketchDir: string;
  /** Fully Qualified Board Name, e.g. `arduino:avr:uno`. */
  fqbn: string;
}

export type RunCompileResult =
  | {
      ok: true;
      hex_b64: string;
      stderr: string;
    }
  | {
      ok: false;
      stderr: string;
    };

/**
 * Run `arduino-cli compile` against `sketchDir` and return the .hex artifact.
 *
 * The output directory and build path are siblings of the sketch directory
 * (already created by sketch-fs.ts under the per-request temp root).
 */
export async function runCompile(input: RunCompileInput): Promise<RunCompileResult> {
  const { sketchDir, fqbn } = input;
  // Place build/out as siblings of the sketch dir, all under the same
  // per-request temp root that sketch-fs.ts will rm -rf.
  const outDir = join(sketchDir, "..", "out");
  const buildPath = join(sketchDir, "..", "build");

  const proc = Bun.spawn(
    [
      "arduino-cli",
      "compile",
      "--fqbn",
      fqbn,
      "--output-dir",
      outDir,
      "--build-path",
      buildPath,
      "--warnings",
      "default",
      "--jobs",
      "2",
      "--no-color",
      sketchDir,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const stderr = (stderrText + (stdoutText ? `\n${stdoutText}` : "")).trim();

  if (exitCode !== 0) {
    return { ok: false, stderr };
  }

  // Read the resulting .hex. arduino-cli names it `<sketchdir>.ino.hex`.
  // Since the sketch dir is named `sketch`, the file is `sketch.ino.hex`.
  const hexPath = join(outDir, "sketch.ino.hex");
  try {
    const hex = await readFile(hexPath);
    return {
      ok: true,
      hex_b64: hex.toString("base64"),
      stderr,
    };
  } catch (err) {
    return {
      ok: false,
      stderr: `${stderr}\n\n[run-compile] expected artifact ${hexPath} not produced (${(err as Error).message})`,
    };
  }
}
