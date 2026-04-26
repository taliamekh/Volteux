import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
} from "vitest";
import { encode, decode } from "../lib/urlHash";
import { loadDefaultFixture } from "../data/fixtures";

// ----------------------------------------------------------------------------
// jsdom shim for Blob.prototype.stream + Blob.prototype.arrayBuffer
// ----------------------------------------------------------------------------
// jsdom's Blob (as of jsdom 25.x) implements neither `.stream()` nor
// `.arrayBuffer()` nor `.text()`. The production `encode` in
// `app/src/lib/urlHash.ts` calls `new Blob([json]).stream()`, which works in
// every real browser but blows up under jsdom with
// "(intermediate value).stream is not a function".
//
// This shim is a test-environment polyfill — it does NOT modify production
// code and is local to this file (test-setup.ts is shared infra and off-
// limits per Cluster C scope).
//
// Implementation notes:
// - jsdom stores blob bytes at `Symbol(impl)._buffer` (a Node Buffer). We
//   reach into that internal slot directly. This is brittle to jsdom version
//   bumps, but the alternatives (FileReader, copying through Node's Blob) all
//   have worse trade-offs: FileReader's async scheduling deadlocks under
//   `vi.useFakeTimers()`, and Node's Blob constructor calls `String(part)` on
//   non-Node-Blob inputs, producing `"[object Blob]"` instead of the bytes.
// - The `_buffer` is a Node Buffer, but vitest runs Node and jsdom in
//   separate realms — so `instanceof Uint8Array` is false in the test realm
//   even though Buffer extends Uint8Array. We duck-type via numeric `length`
//   and use `Uint8Array.from()` to copy bytes across the realm boundary.
beforeAll(() => {
  const proto = Blob.prototype as unknown as {
    stream?: () => ReadableStream<Uint8Array>;
    arrayBuffer?: () => Promise<ArrayBuffer>;
  };
  if (typeof proto.stream === "function") return;

  const getImplBuffer = (blob: Blob): ArrayLike<number> | null => {
    const symbols = Object.getOwnPropertySymbols(blob);
    for (const s of symbols) {
      if (s.description === "impl") {
        // any: reaching into a jsdom internal slot — no public type for it.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const impl = (blob as any)[s];
        if (
          impl &&
          typeof impl === "object" &&
          "_buffer" in impl &&
          impl._buffer != null &&
          typeof impl._buffer.length === "number"
        ) {
          return impl._buffer as ArrayLike<number>;
        }
      }
    }
    return null;
  };

  proto.arrayBuffer = function (this: Blob): Promise<ArrayBuffer> {
    const buf = getImplBuffer(this);
    if (!buf) {
      return Promise.reject(
        new Error(
          "urlHash test shim: failed to read jsdom Blob internal _buffer",
        ),
      );
    }
    const out = Uint8Array.from(buf);
    return Promise.resolve(out.buffer);
  };

  proto.stream = function (this: Blob): ReadableStream<Uint8Array> {
    const self = this;
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const buf = await self.arrayBuffer();
        controller.enqueue(new Uint8Array(buf));
        controller.close();
      },
    });
  };
});

// ----------------------------------------------------------------------------
// Test helpers
// ----------------------------------------------------------------------------

/**
 * Mirrors the gzip + base64-url step of `encode`, but accepts a raw string
 * payload instead of a `VolteuxProjectDocument`. Used to synthesize bad-but-
 * structurally-valid hashes (e.g., gzip of garbage JSON, gzip of a >1 MiB
 * payload) that exercise the deeper `decode` failure branches.
 */
async function gzipToBase64Url(payload: string): Promise<string> {
  const stream = new Blob([payload])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return btoa(bin)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Base64-url-encode arbitrary bytes (no gzip). */
function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return btoa(bin)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

// Convention deviation, justified:
// The other test files in this folder wrap every `describe` in
// `vi.useFakeTimers()` / `vi.useRealTimers()` for "consistency / harmless
// overhead." For this file it is NOT harmless — fake timers stall the async
// I/O scheduling that CompressionStream / DecompressionStream / our
// Blob.stream shim depend on, causing every async test to time out at 5s.
// Real timers here, no React rendering happens so there's nothing to hang.
describe("urlHash", () => {
  describe("encode + decode round-trip", () => {
    it("decode(encode(doc)) deep-equals doc", async () => {
      const doc = loadDefaultFixture();
      const hash = await encode(doc);
      const restored = await decode(hash);
      expect(restored).toEqual(doc);
    });

    it("encode produces a string with the v1: prefix", async () => {
      const doc = loadDefaultFixture();
      const hash = await encode(doc);
      expect(hash.startsWith("v1:")).toBe(true);
    });

    it("encode produces a URL-safe body (no +, /, =)", async () => {
      const doc = loadDefaultFixture();
      const hash = await encode(doc);
      // The body after "v1:" must use only the URL-safe base64 alphabet
      // (A-Z, a-z, 0-9, -, _) with no padding.
      expect(hash).toMatch(/^v1:[A-Za-z0-9_-]+$/);
    });

    it("decode tolerates a leading '#' (window.location.hash convention)", async () => {
      const doc = loadDefaultFixture();
      const hash = await encode(doc);
      const withHash = await decode("#" + hash);
      const withoutHash = await decode(hash);
      expect(withHash).toEqual(withoutHash);
      expect(withHash).toEqual(doc);
    });
  });

  describe("decode error paths (all resolve to null, never throw)", () => {
    it("returns null for a wrong version prefix", async () => {
      await expect(decode("v2:abc")).resolves.toBeNull();
    });

    it("returns null when there is no prefix at all", async () => {
      await expect(decode("abc")).resolves.toBeNull();
    });

    it("returns null for v1: with an empty body", async () => {
      await expect(decode("v1:")).resolves.toBeNull();
    });

    it("returns null for an oversized base64 body (> MAX_HASH_INPUT_BYTES)", async () => {
      // MAX_HASH_INPUT_BYTES is 64 * 1024. One byte over the cap must hit
      // the early-reject branch BEFORE any atob() / decompression happens.
      // CRITICAL: a generic "decode → null" assertion would still pass even
      // if the early-reject was removed — atob succeeds on a long run of 'A's
      // (valid base64 of zero bytes), DecompressionStream errors on the first
      // chunk (no gzip header), and the outer catch returns null. To prove
      // the security cap actually fired, spy on atob and assert it was not
      // called.
      const oversized = "v1:" + "A".repeat(64 * 1024 + 1);
      const atobSpy = vi.spyOn(globalThis, "atob");
      try {
        await expect(decode(oversized)).resolves.toBeNull();
        expect(atobSpy).not.toHaveBeenCalled();
      } finally {
        atobSpy.mockRestore();
      }
    });

    it("returns null for malformed base64 (atob throws, caught by outer try)", async () => {
      // "!!!" contains characters outside the base64 alphabet — atob will
      // throw an InvalidCharacterError, which the catch swallows to null.
      await expect(decode("v1:!!!")).resolves.toBeNull();
    });

    it("returns null when base64 decodes but body is not gzip", async () => {
      // Valid base64 of plain ASCII bytes — atob succeeds, but
      // DecompressionStream("gzip") errors on the first chunk because there's
      // no gzip header. The reader.read() rejection propagates into the catch.
      const notGzipBytes = new TextEncoder().encode("hello world, not gzip");
      const hash = "v1:" + bytesToBase64Url(notGzipBytes);
      await expect(decode(hash)).resolves.toBeNull();
    });

    it("returns null when gzip decompresses to non-JSON text", async () => {
      // Valid gzip wrapping a string that isn't JSON — JSON.parse throws,
      // caught and converted to null.
      const b64 = await gzipToBase64Url("not json {{");
      await expect(decode("v1:" + b64)).resolves.toBeNull();
    });

    it("returns null when JSON parses but fails Zod validation", async () => {
      // Valid gzip + valid JSON, but the object doesn't match
      // VolteuxProjectDocumentSchema (missing every required field).
      // safeParse returns { success: false }, which decode maps to null.
      const garbage = JSON.stringify({ unrelated: "object", wire_color: 42 });
      const b64 = await gzipToBase64Url(garbage);
      await expect(decode("v1:" + b64)).resolves.toBeNull();
    });

    it("returns null when decompressed payload exceeds MAX_DECOMPRESSED_BYTES (1 MiB)", async () => {
      // gzip compresses a long run of identical characters extremely well —
      // ~2 MiB of 'x' characters compresses to a few KB on the wire, well
      // under the MAX_HASH_INPUT_BYTES cap. The bomb-cap reader loop in
      // decode should abort once `total` crosses 1 MiB and return null.
      const bombPayload = "x".repeat(2 * 1024 * 1024);
      const b64 = await gzipToBase64Url(bombPayload);
      // Sanity: the gzipped + base64-url'd payload itself should be small
      // enough to slip past the input-size check (otherwise we'd be testing
      // the wrong branch).
      expect(b64.length).toBeLessThan(64 * 1024);
      await expect(decode("v1:" + b64)).resolves.toBeNull();

      // SEC-002 KNOWN LIMITATION: this assertion verifies the BEHAVIOR
      // (decode returns null when the payload would decompress past the
      // bomb cap) but cannot distinguish the bomb-cap reader-loop branch
      // (urlHash.ts:94) from the generic outer catch (line 110). An attempt
      // to spy on `JSON.parse` and assert it was not called surfaced a
      // jsdom + DecompressionStream interaction (test-environment shim
      // emits the gzipped input as a single chunk; jsdom's DecompressionStream
      // appears to produce less than the full 2 MiB output in some cases),
      // which would either always-pass or always-fail the spy assertion
      // without actually proving the production branch fired. A more
      // durable distinction test would need either a real-browser run or
      // a structurally-different payload (e.g., a >1 MiB but Zod-valid doc
      // whose deserialization would succeed if the cap were removed) and
      // is filed as a v0.1 follow-up. Production behavior is unchanged
      // and verified by manual testing in a real browser.
    });
  });
});
