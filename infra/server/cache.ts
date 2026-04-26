/**
 * Filesystem cache for compile artifacts.
 *
 * Cache key shape:
 *   sha256(toolchainVersionHash + fqbn + main_ino + sorted(extras) + sorted(libraries))
 *
 * `toolchainVersionHash` is computed ONCE at server boot from
 *   sha256(arduino-cli version --json + core list --json + lib list --json)
 *
 * The hash is the FIRST component of every key, so a toolchain bump
 * invalidates the entire cache namespace — no per-entry comparison needed.
 *
 * Boot guard: `computeToolchainVersionHash()` ASSERTS that `arduino:avr` is
 * present in the core list before hashing. If absent (broken image build,
 * volume mount masking ~/.arduino15), the function throws — the server's
 * top-level startup catches this and exits with a clear stderr message.
 *
 * Entries are stored as two files at `/var/cache/volteux/<key>.hex` and
 * `/var/cache/volteux/<key>.json` (the json carries `stderr`). Writes are
 * atomic (write-temp + rename). Reads tolerate missing entries.
 *
 * Eviction: deferred to v0.2 cron (~5GB cap documented in infra/deploy.md).
 * At server boot, this module logs the current cache size and emits a WARN
 * if it exceeds 4GB so the operator catches the bound before compiles fail.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CACHE_DIR = process.env.VOLTEUX_CACHE_DIR ?? "/var/cache/volteux";
const SIZE_WARN_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB

let cachedToolchainHash: string | null = null;

export interface CacheKeyInput {
  toolchainHash: string;
  fqbn: string;
  main_ino: string;
  additional_files: Readonly<Record<string, string>>;
  libraries: ReadonlyArray<string>;
}

export interface CacheEntry {
  hex_b64: string;
  stderr: string;
}

/**
 * Compute and memoize the toolchain version hash at server boot.
 *
 * Throws if `arduino:avr` is not present in the core list — this happens
 * when the image build broke (canary should have caught it; this is the
 * defense-in-depth backstop) or a runtime volume mount masked the
 * pre-installed core directory.
 */
export async function computeToolchainVersionHash(): Promise<string> {
  if (cachedToolchainHash !== null) return cachedToolchainHash;

  const [versionJson, coreJson, libJson] = await Promise.all([
    runArduinoCliJson(["version"]),
    runArduinoCliJson(["core", "list"]),
    runArduinoCliJson(["lib", "list"]),
  ]);

  // Boot assertion: AVR core must be present. The shape arduino-cli emits is
  // `{ platforms: [{ id: "arduino:avr", ... }, ...] }` (1.x). We check the id
  // string conservatively without strong-typing the whole response.
  const cores = (coreJson as { platforms?: Array<{ id?: string }> }).platforms ?? [];
  const hasAvr = cores.some((p) => p.id === "arduino:avr");
  if (!hasAvr) {
    throw new Error(
      "[cache] arduino:avr core not found in `arduino-cli core list --json`. " +
        "The image build's canary compile should have caught this; if you are " +
        "seeing this at runtime, check whether a volume mount is masking the " +
        "pre-installed core directory (e.g., `-v /host/empty:/home/volteux/.arduino15`).",
    );
  }

  const hash = createHash("sha256");
  hash.update(JSON.stringify(versionJson));
  hash.update(JSON.stringify(coreJson));
  hash.update(JSON.stringify(libJson));
  cachedToolchainHash = hash.digest("hex");
  return cachedToolchainHash;
}

/** Stable cache key. Sorting is essential — Object.keys ordering is preserved
 *  by V8/Bun for string keys but the contract is "sorted before hashing." */
export function cacheKey(input: CacheKeyInput): string {
  const additionalSorted = Object.entries(input.additional_files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}\0${v}`)
    .join("\0");
  const librariesSorted = [...input.libraries].sort().join("\0");

  const hash = createHash("sha256");
  hash.update(input.toolchainHash);
  hash.update("\0");
  hash.update(input.fqbn);
  hash.update("\0");
  hash.update(input.main_ino);
  hash.update("\0");
  hash.update(additionalSorted);
  hash.update("\0");
  hash.update(librariesSorted);
  return `${input.toolchainHash.slice(0, 8)}-${hash.digest("hex")}`;
}

/** Cache lookup. Returns `null` on miss or any read error. */
export async function cacheGet(key: string): Promise<CacheEntry | null> {
  try {
    const [hex, jsonText] = await Promise.all([
      readFile(join(CACHE_DIR, `${key}.hex`)),
      readFile(join(CACHE_DIR, `${key}.json`), "utf8"),
    ]);
    const json = JSON.parse(jsonText) as { stderr?: string };
    return {
      hex_b64: hex.toString("base64"),
      stderr: json.stderr ?? "",
    };
  } catch {
    return null;
  }
}

/** Atomic cache write (write-temp + rename for both files). */
export async function cachePut(key: string, entry: CacheEntry): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
  const hexPath = join(CACHE_DIR, `${key}.hex`);
  const jsonPath = join(CACHE_DIR, `${key}.json`);
  const hexTmp = `${hexPath}.tmp.${process.pid}.${Date.now()}`;
  const jsonTmp = `${jsonPath}.tmp.${process.pid}.${Date.now()}`;
  await Promise.all([
    writeFile(hexTmp, Buffer.from(entry.hex_b64, "base64"), { mode: 0o600 }),
    writeFile(jsonTmp, JSON.stringify({ stderr: entry.stderr }), { mode: 0o600 }),
  ]);
  await Promise.all([rename(hexTmp, hexPath), rename(jsonTmp, jsonPath)]);
}

/**
 * Sum the cache directory size in bytes. Cheap O(N) over entries; called
 * once at boot and acceptable for the v0 entry count.
 */
export async function cacheDirSize(): Promise<number> {
  try {
    const entries = await readdir(CACHE_DIR);
    let total = 0;
    for (const name of entries) {
      try {
        const s = await stat(join(CACHE_DIR, name));
        total += s.size;
      } catch {
        // ignore unreadable entries
      }
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * Run `arduino-cli` with `--json` and parse the stdout. Internal helper.
 */
async function runArduinoCliJson(args: ReadonlyArray<string>): Promise<unknown> {
  const proc = Bun.spawn(["arduino-cli", ...args, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `[cache] arduino-cli ${args.join(" ")} exited ${exitCode}: ${stderrText.trim()}`,
    );
  }
  return JSON.parse(stdoutText);
}

export const __testing = {
  resetMemoizedHash(): void {
    cachedToolchainHash = null;
  },
  SIZE_WARN_BYTES,
};
