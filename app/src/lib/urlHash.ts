// ============================================================
// Volteux — URL hash persistence (U8)
// ============================================================
// Encode/decode VolteuxProjectDocument <-> URL hash so a friend can
// be sent a link that restores the same project on load.
//
// - encode: JSON.stringify -> gzip (CompressionStream) -> base64-url ->
//   prefixed with "v1:" (versioned for future-proofing).
// - decode: reverse, then Zod-validate before returning. Returns null on
//   any failure — the caller falls back to the default fixture-load.
//
// Per CLAUDE.md "No silent failures": failures surface as `null` to the
// caller, which decides UX. We don't pretend the data is valid; we don't
// console.error and shrug. The bool of "did this restore work" is the
// caller's signal.

import {
  VolteuxProjectDocumentSchema,
  type VolteuxProjectDocument,
} from "../../../schemas/document.zod";

const HASH_PREFIX = "v1:";

// Decompression-bomb caps. A crafted gzip (a few KB on the wire) can decompress
// to gigabytes and freeze the victim's tab on a single click of a shared URL —
// see security review SEC-001. Real Volteux project documents serialize to
// ~3-10KB gzipped, ~30KB JSON. These caps leave plenty of room for archetype-2+
// growth while rejecting attacker payloads before they consume browser memory.
const MAX_HASH_INPUT_BYTES = 64 * 1024;       // ~64KB of base64 input
const MAX_DECOMPRESSED_BYTES = 1 * 1024 * 1024; // 1 MiB after gunzip

/**
 * Encode a project document into a URL-safe base64 string suitable for
 * window.location.hash. Uses CompressionStream("gzip") to keep small
 * documents short. Output is prefixed with "v1:" for future-proofing.
 *
 * Canonical-JSON principle (per
 * docs/solutions/security-issues/sha256-cache-key-canonical-json-serialization-2026-04-26.md):
 * always serialize via JSON.stringify(doc) — never concatenate fields.
 */
export async function encode(doc: VolteuxProjectDocument): Promise<string> {
  const json = JSON.stringify(doc);
  const stream = new Blob([json])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  const bytes = new Uint8Array(buf);
  // base64-encode then make URL-safe
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]!);
  const b64 = btoa(bin)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${HASH_PREFIX}${b64}`;
}

/**
 * Decode a "v1:<base64>" hash into a Zod-validated VolteuxProjectDocument.
 * Returns null on any failure — caller falls back to default fixture-load.
 * Never throws (per CLAUDE.md "No silent failures": failures surface as null
 * to the caller, which decides UX. We don't pretend the data is valid.)
 */
export async function decode(
  hash: string,
): Promise<VolteuxProjectDocument | null> {
  try {
    const stripped = hash.startsWith("#") ? hash.slice(1) : hash;
    if (!stripped.startsWith(HASH_PREFIX)) return null;
    const b64url = stripped.slice(HASH_PREFIX.length);
    if (!b64url) return null;
    // Reject oversized hashes before any allocation work. Crafted huge inputs
    // would blow up memory in atob() before decompression even starts.
    if (b64url.length > MAX_HASH_INPUT_BYTES) return null;
    // Restore padding + standard base64 alphabet
    const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const stream = new Blob([bytes])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    // Manually drain the decompressed stream so we can abort if it exceeds the
    // bomb cap before buffering the full payload — `Response(stream).text()`
    // would happily allocate gigabytes first and let Zod reject afterward.
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DECOMPRESSED_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    const text = new TextDecoder().decode(merged);
    const parsed: unknown = JSON.parse(text);
    const result = VolteuxProjectDocumentSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
