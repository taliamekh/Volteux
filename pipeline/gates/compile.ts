/**
 * Pipeline-side compile gate. POSTs a sketch to the local Compile API
 * (default `http://localhost:8787`) and surfaces the result with a
 * discriminated failure union so the orchestrator (Unit 9) can route
 * each `kind` to the right recovery:
 *
 *   transport     — server unreachable (ECONNREFUSED, DNS, socket reset)
 *   timeout       — request aborted before response
 *   auth          — server returned 401 (bad/missing secret)
 *   bad-request   — server's zValidator rejected the request body (400)
 *   rate-limited  — server returned 429
 *   compile-error — 200 with `{ok: false, stderr}` from arduino-cli
 *
 * `transport`/`timeout`/`auth`/`rate-limited` are infra failures Unit 9
 * surfaces without retry. `compile-error` and `bad-request` are worth
 * one repair turn through `generate()`.
 *
 * The gate import-paths the same `validateAdditionalFileName` and
 * `ADDITIONAL_FILE_NAME_REGEX` as the server (single source of truth) so
 * pipeline-side rejection happens BEFORE the network hop. The actual
 * cross-consistency gate already runs the predicate; this gate trusts
 * its caller to have done that.
 */

import type { GateResult, Severity } from "../types.ts";

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
}

export type CompileGateFailureKind =
  | "transport"
  | "timeout"
  | "auth"
  | "bad-request"
  | "rate-limited"
  | "compile-error";

/**
 * Discriminated failure union — extends `GateResult` with a `kind` field.
 * The orchestrator switches on `kind` to decide retry behavior.
 */
export type CompileGateResult =
  | { ok: true; value: CompileGateValue }
  | {
      ok: false;
      severity: Severity;
      kind: CompileGateFailureKind;
      message: string;
      errors: ReadonlyArray<string>;
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
      kind: "rate-limited",
      message: "compile-api rate-limited (429)",
      errors: [],
    };
  }
  if (response.status === 400) {
    const body = (await safeJson(response)) as
      | { error?: string; reason?: string; filename?: string; message?: string }
      | null;
    return {
      ok: false,
      severity: "red",
      kind: "bad-request",
      message: body?.message ?? body?.reason ?? "compile-api rejected request shape",
      errors: body ? [JSON.stringify(body)] : [],
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

  const body = (await safeJson(response)) as
    | {
        ok: boolean;
        artifact_b64?: string;
        stderr?: string;
        cache_hit?: boolean;
        error?: string;
      }
    | null;

  if (!body) {
    return {
      ok: false,
      severity: "red",
      kind: "transport",
      message: "compile-api returned non-JSON 200 response",
      errors: [],
    };
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

  if (!body.artifact_b64) {
    return {
      ok: false,
      severity: "red",
      kind: "transport",
      message: "compile-api 200 ok=true response missing artifact_b64",
      errors: [],
    };
  }

  return {
    ok: true,
    value: {
      hex_b64: body.artifact_b64,
      stderr: body.stderr ?? "",
      cache_hit: Boolean(body.cache_hit),
    },
  };
}

/**
 * Type-narrowing helper used by tests: returns the `GateResult` shape that
 * `pipeline/types.ts` defines, dropping the discriminated `kind`. Useful
 * when feeding the result into a generic gate orchestrator that doesn't
 * yet know about CompileGateResult's richer kinds.
 */
export function toGateResult(result: CompileGateResult): GateResult<CompileGateValue> {
  if (result.ok) return { ok: true, value: result.value };
  return {
    ok: false,
    severity: result.severity,
    message: result.message,
    errors: result.errors,
  };
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
