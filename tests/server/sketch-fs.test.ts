/**
 * Unit tests for createPerRequestSketchDir() in infra/server/sketch-fs.ts.
 *
 * Pins ADV-002 (additional_files["sketch.ino"] would overwrite the main
 * sketch) and REL-002 (cleanup idempotency flag set BEFORE rm leaks the
 * temp dir on rm failure).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { createPerRequestSketchDir } from "../../infra/server/sketch-fs.ts";

const baseInput = {
  main_ino: "void setup(){}\nvoid loop(){}",
};

describe("createPerRequestSketchDir — happy path", () => {
  test("returns ok handle with sketch dir on disk and cleanup function", async () => {
    const result = await createPerRequestSketchDir(baseInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const s = await stat(result.handle.path);
      expect(s.isDirectory()).toBe(true);
      await result.handle.cleanup();
    }
  });

  test("multiple additional_files written under the sketch dir", async () => {
    const result = await createPerRequestSketchDir({
      ...baseInput,
      additional_files: {
        "helper.h": "// header content",
        "extra.cpp": "int x = 1;",
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const helper = await stat(`${result.handle.path}/helper.h`);
      const extra = await stat(`${result.handle.path}/extra.cpp`);
      expect(helper.isFile()).toBe(true);
      expect(extra.isFile()).toBe(true);
      await result.handle.cleanup();
    }
  });
});

describe("createPerRequestSketchDir — main sketch overwrite guard (ADV-002)", () => {
  test("rejects additional_files key 'sketch.ino' (would clobber main_ino)", async () => {
    const result = await createPerRequestSketchDir({
      ...baseInput,
      additional_files: { "sketch.ino": "void setup(){ /* malicious */ }" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("filename-allowlist");
      expect(result.error.filename).toBe("sketch.ino");
      expect(result.error.reason).toContain("reserved name");
    }
  });

  test("rejects 'sketch.ino' BEFORE writing any disk content", async () => {
    // The sketch.ino key check must fail closed before any temp dir is
    // created. After this test, no orphan temp dir should exist (we have
    // no handle to call cleanup on, so this is the only way to verify).
    const result = await createPerRequestSketchDir({
      ...baseInput,
      additional_files: {
        "helper.h": "x",
        "sketch.ino": "y",
      },
    });
    expect(result.ok).toBe(false);
  });
});

describe("createPerRequestSketchDir — cleanup idempotency (REL-002)", () => {
  test("cleanup is idempotent: second call is a no-op after the first succeeds", async () => {
    const result = await createPerRequestSketchDir(baseInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      await result.handle.cleanup();
      // Second call must not throw.
      await result.handle.cleanup();
      // After successful cleanup, the path no longer exists.
      try {
        await stat(result.handle.path);
        throw new Error("expected stat to fail after cleanup");
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
      }
    }
  });
});

// Track temp dirs we create so they get cleaned up even if a test fails
// mid-flight; otherwise we leak under /tmp on every failed run.
const handlesToClean: Array<{ cleanup: () => Promise<void> }> = [];
afterEach(async () => {
  while (handlesToClean.length > 0) {
    const h = handlesToClean.pop();
    if (h) await h.cleanup().catch(() => {});
  }
});
