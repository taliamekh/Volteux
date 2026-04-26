// ============================================================
// Volteux — pipeline-client (live pipeline integration)
// ============================================================
// Calls the local pipeline-api server (default http://127.0.0.1:8788)
// via the Vite dev proxy at /api/pipeline. Returns the discriminated
// PipelineResult shape verbatim — same union the orchestrator emits —
// so the UI's `App.tsx` can switch on `result.ok` and route to either
// success-render OR Honest Gap UI.
//
// Failure modes:
//   - HTTP transport (network down, proxy mis-configured) → throws
//     `PipelineClientError` with kind="transport".
//   - HTTP non-2xx with a structured `{ok: false, error, message}` body
//     (400 bad-request, 503 queue-full, 500 internal-error) → throws
//     `PipelineClientError` with kind matching the server's `error`.
//   - HTTP 2xx with the pipeline's discriminated union → returns it as-is.
//     The caller distinguishes pipeline success vs Honest Gap via `result.ok`.
//
// The client does NOT validate the response body against the Zod schema;
// the server already emits Zod-validated content. Re-validation in the
// browser would double the cost without catching anything new.

// We don't import `PipelineResult` from `pipeline/` directly because the
// pipeline module re-exports types from `pipeline/rules/index.ts` whose
// internal imports use `.ts` extensions — that drags in
// `allowImportingTsExtensions` semantics the app/ tsconfig doesn't carry.
// Instead, mirror the wire-shape locally. This is a CONTRACT — the
// pipeline-api server emits the full `PipelineResult` shape and the
// browser consumes only the fields below; if the server adds a field,
// the browser sees it as an unknown property (forward-compatible).
import type {
  VolteuxProjectDocument,
  VolteuxHonestGap,
} from "../../../schemas/document.zod";

export interface PipelineSuccess {
  ok: true;
  doc: VolteuxProjectDocument;
  hex_b64: string;
  cost_usd: number;
  run_id: string;
  /** Non-blocking warnings; the UI may surface as info chips. */
  amber: ReadonlyArray<unknown>;
  blue: ReadonlyArray<unknown>;
}

export interface PipelineFailure {
  ok: false;
  severity: "red";
  /**
   * `PipelineFailureKind` from the pipeline. Kept as `string` here so
   * the frontend doesn't have to recompile when the literal set
   * evolves; the LandingView's per-kind copy fallback handles unknown
   * kinds gracefully.
   */
  kind: string;
  message: string;
  errors: ReadonlyArray<string>;
  honest_gap: VolteuxHonestGap;
  cost_usd: number;
  run_id: string;
}

export type PipelineResult = PipelineSuccess | PipelineFailure;

export type PipelineClientErrorKind =
  | "transport"
  | "bad-request"
  | "queue-full"
  | "internal-error"
  | "unexpected-status";

export class PipelineClientError extends Error {
  public readonly kind: PipelineClientErrorKind;
  public readonly status?: number;

  public constructor(kind: PipelineClientErrorKind, message: string, status?: number) {
    super(message);
    this.name = "PipelineClientError";
    this.kind = kind;
    this.status = status;
  }
}

interface FetchPipelineOptions {
  /** Override the API base URL. Default is empty (relative; goes through Vite proxy). */
  baseUrl?: string;
  /** Caller-cancellation signal forwarded to fetch. */
  signal?: AbortSignal;
  /** Override the global fetch (used by tests). */
  fetch?: typeof fetch;
}

/**
 * Submit a prompt to the live pipeline. Returns the full PipelineResult
 * (success OR Honest Gap) on a successful HTTP response. Throws
 * PipelineClientError on transport / 4xx / 5xx that the pipeline-api
 * itself surfaced (vs the pipeline's own structured failure).
 */
export async function fetchPipeline(
  prompt: string,
  opts: FetchPipelineOptions = {},
): Promise<PipelineResult> {
  const baseUrl = opts.baseUrl ?? "";
  const fetchImpl = opts.fetch ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/api/pipeline`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
      signal: opts.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PipelineClientError(
      "transport",
      `pipeline-api unreachable at ${baseUrl || window.location.origin}/api/pipeline: ${message}`,
    );
  }

  // The server emits the same JSON shape on success and on its own (non-pipeline)
  // failures. Parse first, then discriminate by HTTP status + the body's `error` field.
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PipelineClientError(
      "unexpected-status",
      `pipeline-api returned non-JSON body (status ${response.status})`,
      response.status,
    );
  }

  if (response.status === 400) {
    const message =
      isApiErrorBody(body) && typeof body.message === "string"
        ? body.message
        : "request rejected";
    throw new PipelineClientError("bad-request", message, 400);
  }
  if (response.status === 503) {
    const message =
      isApiErrorBody(body) && typeof body.message === "string"
        ? body.message
        : "another pipeline run is in progress";
    throw new PipelineClientError("queue-full", message, 503);
  }
  if (response.status === 500) {
    throw new PipelineClientError("internal-error", "pipeline-api internal error", 500);
  }
  if (!response.ok) {
    throw new PipelineClientError(
      "unexpected-status",
      `pipeline-api returned HTTP ${response.status}`,
      response.status,
    );
  }

  // Successful response: pass through the pipeline's discriminated union verbatim.
  return body as PipelineResult;
}

interface ApiErrorBody {
  ok: false;
  error?: string;
  message?: string;
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    (value as { ok?: unknown }).ok === false
  );
}
