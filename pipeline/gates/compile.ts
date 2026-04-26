/**
 * Pipeline-side compile gate. POSTs a sketch to the local Compile API
 * (default `http://localhost:8787`) and surfaces the result with a
 * discriminated failure union so the orchestrator (Unit 9) can route
 * each `kind` to the right recovery:
 *
 *   transport     — server unreachable (ECONNREFUSED, DNS, socket reset,
 *                   unexpected non-200 status, malformed 200 body)
 *   timeout       — request aborted before response (AbortController fired)
 *   auth          — server returned 401 (bad/missing secret)
 *   bad-request   — server's zValidator rejected the request body (400)
 *   rate-limit    — server returned 429
 *   queue-full    — server returned 503 with queue-full envelope; the gate
 *                   surfaces the server's `Retry-After` header value as
 *                   `retry_after_s` so the orchestrator can honour it
 *                   (round-2 AN-R2-001 + AC-011: round-1 dropped the
 *                   header silently and routed 503 to `transport`)
 *   compile-error — 200 with `{ok: false, stderr}` from arduino-cli
 *
 * `transport`/`timeout`/`auth`/`rate-limit`/`queue-full` are infra
 * failures Unit 9 surfaces without retry (queue-full is worth a delayed
 * retry honouring `retry_after_s`). `compile-error` and `bad-request`
 * are worth one repair turn through `generate()`.
 *
 * Wire contract (server response) uses the SAME hyphenated codes as the
 * TS `kind` literals. The custom `zValidator` hook on the server side
 * normalizes Zod's default 400 envelope so every server response uses the
 * same `{ok: false, error, ...}` shape with `error` matching one of the
 * `CompileGateFailureKind` literals (minus `transport`/`timeout`, which
 * are client-side conditions).
 *
 * This gate trusts its caller (cross-consistency gate) to have already
 * run `validateAdditionalFileName` against any `additional_files` keys.
 * The Compile API server runs the same predicate independently as
 * defense-in-depth, so the network hop is safe even if the caller
 * skipped pre-validation.
 */

import { z } from "zod";
import type { Severity } from "../types.ts";

const DEFAULT_BASE_URL = process.env.COMPILE_API_URL ?? "http://localhost:8787";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface CompileRequest {
  fqbn: string;
  sketch_main_ino: string;
  additional_files?: Readonly<Record<string, string>>;
  libraries?: ReadonlyArray<string>;
}

export interface CompileGateValue {
  hex_b64: string;
  stderr: string;
  cache_hit: boolean;
  /**
   * Wall-clock duration of the gate call (request + server-side compile +
   * response) in milliseconds. Cheap to populate (Date.now() around the
   * fetch). Unit 9's trace writer emits this as `compile_call.latency_ms`
   * so the eval harness (v0.5) and meta-harness proposer (v0.9) can
   * detect prompt regressions that grow sketch complexity.
   *
   * W-002 telemetry surface.
   */
  latency_ms: number;
  /**
   * Decoded length of `hex_b64` in bytes. Proxy for sketch complexity;
   * useful as a regression signal when the LLM's output grows.
   * W-002.
   */
  hex_size_bytes: number;
  /**
   * The toolchain hash the server fingerprinted at boot. A cache_hit:true
   * result with a different toolchain_version_hash than the orchestrator
   * last saw is the signal that the server was rebuilt — Unit 9 can
   * decide whether to invalidate any local cached state. The server
   * exposes this on `/api/health` for cold detection too.
   *
   * Required (round-2 AC-013): the server emits this on every success
   * response (cache hit + cold compile). The Zod schema below enforces
   * this — a missing `toolchain_version_hash` from the server is a
   * contract violation surfaced as `kind: "transport"` rather than
   * silently delivering a CompileGateValue with `undefined` here. W-002.
   */
  toolchain_version_hash: string;
}

export type CompileGateFailureKind =
  | "transport"
  | "timeout"
  | "auth"
  | "bad-request"
  | "rate-limit"
  | "queue-full"
  | "compile-error";

/**
 * Server response shapes — Zod schemas, not raw `as` casts. Per CLAUDE.md
 * "Zod is law at every external boundary," HTTP response JSON is a
 * boundary. Each branch is liberal (`.passthrough()`) so a future server
 * adding fields doesn't break the gate, but every field the gate keys on
 * is structurally validated.
 */
const SuccessResponseSchema = z
  .object({
    ok: z.literal(true),
    artifact_b64: z.string(),
    artifact_kind: z.string().optional(),
    stderr: z.string().optional(),
    cache_hit: z.boolean().optional(),
    /**
     * Server emits this on every success response so the orchestrator
     * can detect cross-deploy toolchain changes. Required (round-2
     * AC-013): a missing field is a server contract violation, not a
     * normal case to silently coerce to `undefined`.
     */
    toolchain_version_hash: z.string(),
  })
  .passthrough();

const ErrorResponseSchema = z
  .object({
    ok: z.literal(false),
    error: z.string().optional(),
    message: z.string().optional(),
    reason: z.string().optional(),
    filename: z.string().optional(),
    /** Present on `filename-allowlist` 400 — agent-switchable enum (W-001). */
    rejection_kind: z.string().optional(),
    /** Present only on `bad-request` 400 from zValidator hook. */
    issues: z.array(z.unknown()).optional(),
    stderr: z.string().optional(),
    /** Present on `internal-error` 500 — for log correlation (round-2 AN-R2-003). */
    request_id: z.string().optional(),
  })
  .strict();

const ResponseEnvelopeSchema = z.union([
  SuccessResponseSchema,
  ErrorResponseSchema,
]);

type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/**
 * Discriminated failure union — extends `GateResult` with a `kind` field.
 * The orchestrator switches on `kind` to decide retry behavior.
 *
 * `retry_after_s` is populated only on `kind: "queue-full"` and reflects
 * the server's `Retry-After` header value (round-2 AN-R2-001 + AC-011).
 */
export type CompileGateResult =
  | { ok: true; value: CompileGateValue }
  | {
      ok: false;
      severity: Severity;
      kind: CompileGateFailureKind;
      message: string;
      errors: ReadonlyArray<string>;
      retry_after_s?: number;
    };

export interface RunCompileGateOptions {
  /** Override the API base URL (e.g., for tests). */
  baseUrl?: string;
  /** Override the bearer secret (e.g., for tests). */
  secret?: string;
  /** Override the fetch implementation (e.g., for tests). */
  fetch?: typeof fetch;
  /** Request timeout in ms (default 30s). */
  timeoutMs?: number;
}

/**
 * Submit a compile request to the local Compile API.
 *
 * Returns a discriminated `CompileGateResult` matching the contract in
 * the v0.1-pipeline-io plan. The function never throws on infra failure —
 * every transport-level error is mapped to a `{ok: false, kind: "transport"}`
 * result so the orchestrator's switch statement never has to wrap calls
 * in try/catch.
 */
export async function runCompileGate(
  req: CompileRequest,
  opts: RunCompileGateOptions = {},
): Promise<CompileGateResult> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const secret = opts.secret ?? process.env.COMPILE_API_SECRET ?? "";
  const fetchImpl = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/api/compile`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        fqbn: req.fqbn,
        sketch_main_ino: req.sketch_main_ino,
        additional_files: req.additional_files ?? {},
        libraries: req.libraries ?? [],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted =
      (err as Error).name === "AbortError" ||
      (err as { code?: string }).code === "ABORT_ERR";
    if (aborted) {
      return {
        ok: false,
        severity: "red",
        kind: "timeout",
        message: `compile request timed out after ${timeoutMs}ms`,
        errors: [],
      };
    }
    return {
      ok: false,
      severity: "red",
      kind: "transport",
      message: `compile-api unreachable at ${baseUrl}: ${(err as Error).message}`,
      errors: [(err as Error).message],
    };
  }
  clearTimeout(timer);

  if (response.status === 401) {
    return {
      ok: false,
      severity: "red",
      kind: "auth",
      message: "compile-api rejected bearer secret (401)",
      errors: [],
    };
  }
  if (response.status === 429) {
    return {
      ok: false,
      severity: "red",
      kind: "rate-limit",
      message: "compile-api rate-limited (429)",
      errors: [],
    };
  }
  if (response.status === 503) {
    // Round-2 AN-R2-001 + AC-011: the server emits 503 with a
    // {ok:false, error:"queue-full", message} envelope and a
    // `Retry-After` header. The round-1 gate routed this to a generic
    // `transport` and silently dropped the header — Unit 9 had no way
    // to honour the server's backoff hint.
    const errBody = await parseErrorResponse(response);
    const retryAfter = parseRetryAfter(response.headers.get("Retry-After"));
    return {
      ok: false,
      severity: "red",
      kind: "queue-full",
      message:
        errBody?.message ?? "compile-api queue is at capacity (503)",
      errors: [],
      ...(retryAfter !== undefined ? { retry_after_s: retryAfter } : {}),
    };
  }
  if (response.status === 400) {
    const errBody = await parseErrorResponse(response);
    return {
      ok: false,
      severity: "red",
      kind: "bad-request",
      message:
        errBody?.message ?? errBody?.reason ?? "compile-api rejected request shape",
      errors: structuredBadRequestErrors(errBody),
    };
  }

  if (response.status !== 200) {
    return {
      ok: false,
      severity: "red",
      kind: "transport",
      message: `compile-api returned unexpected status ${response.status}`,
      errors: [String(response.status)],
    };
  }

  const parsed = await parseEnvelope(response);
  // Exhaustive switch — round-2 R2-K-003: the previous if/if/else chain
  // would silently fall through to `parsed.value` if a future variant
  // were added to EnvelopeParseResult. assertNeverFailureKind (added in
  // round 1 but unused) enforces compile-time exhaustiveness.
  let body: z.infer<typeof ResponseEnvelopeSchema>;
  switch (parsed.kind) {
    case "non-json":
      return {
        ok: false,
        severity: "red",
        kind: "transport",
        message: "compile-api returned non-JSON 200 response",
        errors: [],
      };
    case "schema-failed":
      return {
        ok: false,
        severity: "red",
        kind: "transport",
        message: `compile-api 200 response failed envelope schema: ${parsed.summary || "no specific issue path"}`,
        errors: [parsed.summary],
      };
    case "ok":
      body = parsed.value;
      break;
    default:
      return assertNeverEnvelopeKind(parsed);
  }

  if (!body.ok) {
    return {
      ok: false,
      severity: "red",
      kind: "compile-error",
      message: "arduino-cli compile failed",
      errors: [body.stderr ?? ""],
    };
  }

  // hex_b64 length is 4*ceil(n/3); decoded bytes ≈ length * 3 / 4 minus
  // padding. We compute the decoded byte count via the formula rather
  // than allocating a Buffer (telemetry hot path).
  const hex_size_bytes = decodedBase64Length(body.artifact_b64);

  return {
    ok: true,
    value: {
      hex_b64: body.artifact_b64,
      stderr: body.stderr ?? "",
      cache_hit: Boolean(body.cache_hit),
      latency_ms: Date.now() - startedAt,
      hex_size_bytes,
      // toolchain_version_hash is required by SuccessResponseSchema, so
      // a successful parse guarantees it's present. Type narrowing
      // confirms it's a string here.
      toolchain_version_hash: body.toolchain_version_hash,
    },
  };
}

/**
 * Parse the `Retry-After` header. RFC 7231 allows a delay in seconds
 * (integer) or an HTTP date. Round-2: the server emits seconds, so we
 * only handle that form. Returns `undefined` if the header is missing,
 * non-numeric, or negative — the caller surfaces the failure without
 * `retry_after_s` rather than fabricating a default.
 */
function parseRetryAfter(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const parsed = Number.parseInt(headerValue, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

/**
 * Compute the decoded byte length of a base64 string without allocating
 * a Buffer. Base64 encodes 3 input bytes as 4 output chars; trailing
 * `=` chars subtract decoded bytes. The formula `len*3/4 - padding`
 * is exact for valid base64 (length divisible by 4).
 *
 * Round-2 M2-005: malformed input (length not divisible by 4 with no
 * padding) produces a floor-truncated estimate, which is an acceptable
 * silent degradation since this is a telemetry signal feeding W-002,
 * not a safety gate. The server always emits valid base64 (Bun's
 * Buffer.toString('base64') produces canonical output), so the
 * malformed-input case isn't reachable from the production server.
 */
function decodedBase64Length(b64: string): number {
  const len = b64.length;
  if (len === 0) return 0;
  let padding = 0;
  if (b64.endsWith("==")) padding = 2;
  else if (b64.endsWith("=")) padding = 1;
  return Math.floor((len * 3) / 4) - padding;
}

/**
 * Compile-time exhaustiveness guard for the EnvelopeParseResult union.
 * Mirrors the pattern of assertNeverFailureKind for CompileGateFailureKind.
 * Round-2 R2-K-003: the consumer's switch needs this to catch a future
 * 4th variant at compile time rather than silently falling through to
 * `parsed.value = undefined`.
 *
 * Returns the never-typed value as a CompileGateResult so the consumer's
 * switch type-checks; in practice unreachable.
 */
function assertNeverEnvelopeKind(value: never): CompileGateResult {
  throw new Error(`Unhandled EnvelopeParseResult kind: ${JSON.stringify(value)}`);
}

/**
 * Parse the response body through ResponseEnvelopeSchema. Returns a
 * tagged result so the caller can produce diagnostic messages that
 * distinguish "non-JSON" from "JSON but malformed envelope". The 200
 * success branch requires `artifact_b64` (enforced by
 * SuccessResponseSchema), so a 200-with-no-artifact returns `kind:
 * "schema-failed"` with the Zod summary inline.
 */
type EnvelopeParseResult =
  | { kind: "non-json" }
  | { kind: "schema-failed"; summary: string }
  | { kind: "ok"; value: z.infer<typeof ResponseEnvelopeSchema> };

async function parseEnvelope(response: Response): Promise<EnvelopeParseResult> {
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return { kind: "non-json" };
  }
  const result = ResponseEnvelopeSchema.safeParse(raw);
  if (result.success) return { kind: "ok", value: result.data };
  const summary = result.error.issues
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("; ");
  return { kind: "schema-failed", summary };
}

/**
 * Parse a 4xx body through ErrorResponseSchema. The 400 envelope is
 * looser than the 200 success envelope (zValidator may emit `issues`
 * without `error`); we accept any error-shaped body without forcing the
 * field set so a future contributor can add a field without breaking
 * the gate.
 */
async function parseErrorResponse(
  response: Response,
): Promise<ErrorResponse | null> {
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return null;
  }
  const result = ErrorResponseSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/**
 * Project a bad-request error body into structured `errors[]` for the
 * orchestrator's auto-repair turn. AC-002: previously this was
 * `JSON.stringify(body)` — a single opaque blob Sonnet would have to
 * re-parse. Now: each ZodIssue (if present) becomes its own string with
 * the path and message, suitable for verbatim feeding to the LLM.
 */
function structuredBadRequestErrors(
  body: ErrorResponse | null,
): ReadonlyArray<string> {
  if (!body) return [];
  if (Array.isArray(body.issues) && body.issues.length > 0) {
    return body.issues.map((issue) => formatIssue(issue));
  }
  if (body.reason) return [body.reason];
  if (body.message) return [body.message];
  return [];
}

function formatIssue(issue: unknown): string {
  if (
    issue &&
    typeof issue === "object" &&
    "path" in issue &&
    "message" in issue
  ) {
    const i = issue as { path: ReadonlyArray<unknown>; message: unknown };
    const path = Array.isArray(i.path) ? i.path.join(".") : String(i.path);
    return `${path}: ${String(i.message)}`;
  }
  return JSON.stringify(issue);
}

/**
 * Compile-time exhaustiveness guard for `CompileGateFailureKind` switches.
 *
 * Usage in callers (e.g., Unit 9's repair() helper):
 *
 *   switch (result.kind) {
 *     case "transport":     ...; break;
 *     case "timeout":       ...; break;
 *     case "auth":          ...; break;
 *     case "bad-request":   ...; break;
 *     case "rate-limit":    ...; break;
 *     case "compile-error": ...; break;
 *     default: assertNeverFailureKind(result.kind);
 *   }
 *
 * If a future change adds a 7th kind to the union without updating the
 * switch, tsc fails at the `default:` site rather than letting the case
 * silently fall through. Mirrors the pattern already used in
 * `pipeline/gates/cross-consistency.ts` for `AllowlistViolation`.
 */
export function assertNeverFailureKind(kind: never): never {
  throw new Error(`Unhandled CompileGateFailureKind: ${String(kind)}`);
}
