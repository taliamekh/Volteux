/**
 * Anthropic SDK client factory.
 *
 *   createAnthropicClient(opts?) → Anthropic
 *
 * Pure factory: reads `ANTHROPIC_API_KEY` from `process.env` ONLY when
 * `opts.apiKey` is omitted, and ONLY at call time. There is NO module-level
 * singleton, NO module-load throw, NO cached client — each call constructs
 * a fresh client. Mirrors the `buildApp(deps) + startServer()` discipline
 * in `infra/server/compile-api.ts`: pure construction is one function;
 * env-reading is a separate concern.
 *
 * **Logger discipline (do not log secrets).** Never log the
 * `Authorization` header, the API key, or `process.env`. The Anthropic
 * SDK has its own request logger which is OFF by default — do not enable
 * it. If a contributor adds logging here, redact the API key first.
 *
 * **Why a factory, not a singleton.** Plan 002 § Unit 3 originally called
 * for a shared module-load singleton that throws when the env var is
 * missing. Round-2 review on the Compile API made `buildApp(deps)` the
 * load-bearing DI shape; a singleton here would force `generate()` /
 * `classify()` tests to use `mock.module(...)` instead of constructing
 * deps inline. Tests construct deps directly via `buildGenerator(deps)`;
 * the convenience `generate()` lazily builds defaults via
 * `defaultGenerateDeps()`, which calls this factory once. The env-missing
 * case throws at first call, not module load.
 *
 * **Dev-key discipline.** `.env.example` documents the
 * `ANTHROPIC_API_KEY` env var. Use a separate dev key with a $5/day
 * usage alert; production keys (v0.2 deploy) MUST be a different key.
 */

import Anthropic from "@anthropic-ai/sdk";

export interface CreateAnthropicClientOptions {
  /**
   * Override the API key. Tests pass a fake key here when they want to
   * exercise the real SDK against a mocked transport. Production callers
   * omit this; the factory then reads `process.env.ANTHROPIC_API_KEY`.
   */
  apiKey?: string;
}

/**
 * Construct an Anthropic SDK client.
 *
 * Throws `Error("ANTHROPIC_API_KEY is not set")` if neither
 * `opts.apiKey` nor `process.env.ANTHROPIC_API_KEY` is provided. The
 * throw happens AT CALL TIME, never at module load.
 */
export function createAnthropicClient(
  opts: CreateAnthropicClientOptions = {},
): Anthropic {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
  if (apiKey === "") {
    throw new Error(
      "ANTHROPIC_API_KEY is not set — populate it in .env (see .env.example)",
    );
  }
  return new Anthropic({ apiKey });
}
