/**
 * Per-request temp directory + sketch sanitization.
 *
 * Every compile request gets its own directory under `os.tmpdir()` named
 * `volteux-compile-<uuid>`. The directory holds:
 *   - sketch/<name>.ino   (the main sketch, written under a fixed name)
 *   - sketch/<extra>.{ino,h,cpp,c}   (additional files, after allowlist check)
 *
 * Cleanup is the caller's responsibility via the returned `cleanup()`
 * function — typically called from a `try { ... } finally { await cleanup(); }`
 * block in the request handler. A leaked temp dir per request would crash
 * the v0.2 VPS within hours of traffic.
 *
 * Filename validation imports `validateAdditionalFileName` from the
 * pipeline-side allowlist — single source of truth for the policy
 * (the cross-consistency gate runs the same predicate before reaching
 * the Compile API).
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateAdditionalFileName,
  type FilenameRejectionKind,
} from "../../pipeline/gates/library-allowlist.ts";

/** The fixed sketch directory name arduino-cli expects. */
const SKETCH_DIR_NAME = "sketch";
/** The fixed name we write the main sketch under. */
const MAIN_SKETCH_FILE = "sketch.ino";

export interface SketchDirInput {
  main_ino: string;
  additional_files?: Readonly<Record<string, string>>;
}

export type SketchDirError = {
  kind: "filename-allowlist";
  filename: string;
  reason: string;
  /** Structured rejection class — agent callers switch on this; W-001. */
  rejection_kind: FilenameRejectionKind | "reserved-name";
};

export interface SketchDirHandle {
  /** Absolute path to the sketch directory, suitable for `arduino-cli compile`. */
  path: string;
  /** Idempotent cleanup; safe to call multiple times. */
  cleanup: () => Promise<void>;
}

/**
 * Validate every additional_file key against the shared allowlist and
 * write the sketch to a per-request temp dir. Returns the directory handle
 * on success, or the first filename violation on failure.
 *
 * The validation step does NOT write anything — a single bad filename
 * fails the whole request before any disk I/O.
 */
export async function createPerRequestSketchDir(
  input: SketchDirInput,
): Promise<{ ok: true; handle: SketchDirHandle } | { ok: false; error: SketchDirError }> {
  const additional = input.additional_files ?? {};

  // Validate all filenames first (cheap; fail closed before disk I/O).
  for (const filename of Object.keys(additional)) {
    const rejection = validateAdditionalFileName(filename);
    if (rejection !== null) {
      return {
        ok: false,
        error: {
          kind: "filename-allowlist",
          filename,
          reason: rejection.reason,
          rejection_kind: rejection.kind,
        },
      };
    }
    // ADV-002 — reject any additional_files key that would overwrite the main
    // sketch. `validateAdditionalFileName` accepts "sketch.ino" (it matches
    // the regex), so without this guard the second writeFile would clobber
    // input.main_ino and arduino-cli would compile the wrong content while
    // the caller silently receives the wrong artifact.
    if (filename === MAIN_SKETCH_FILE) {
      return {
        ok: false,
        error: {
          kind: "filename-allowlist",
          filename,
          reason: `reserved name: would overwrite the main sketch file (${MAIN_SKETCH_FILE})`,
          rejection_kind: "reserved-name",
        },
      };
    }
  }

  // Create the per-request directory.
  const root = await mkdtemp(join(tmpdir(), "volteux-compile-"));
  const sketchDir = join(root, SKETCH_DIR_NAME);
  await mkdir(sketchDir, { recursive: true });

  // Write the main sketch + additional files (validation already passed).
  await writeFile(join(sketchDir, MAIN_SKETCH_FILE), input.main_ino, "utf8");
  for (const [filename, contents] of Object.entries(additional)) {
    await writeFile(join(sketchDir, filename), contents, "utf8");
  }

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    // Idempotent guard: skip if a previous call already succeeded.
    // REL-002 — set the flag AFTER `rm` succeeds, not before. If `rm`
    // throws (EIO/EROFS), we want subsequent calls to retry deletion
    // rather than silently no-op with the temp dir still on disk.
    if (cleaned) return;
    await rm(root, { recursive: true, force: true });
    cleaned = true;
  };

  return { ok: true, handle: { path: sketchDir, cleanup } };
}
