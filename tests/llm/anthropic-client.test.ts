/**
 * Unit tests for `pipeline/llm/anthropic-client.ts`.
 *
 * The factory is intentionally tiny — three behaviours to cover:
 *
 *   1. `apiKey` opt is honoured (no env touched).
 *   2. Falls back to `process.env.ANTHROPIC_API_KEY` when `opts.apiKey`
 *      is omitted.
 *   3. Throws a clear, env-name-mentioning error when neither is set.
 *
 * Each test save/restores `process.env.ANTHROPIC_API_KEY` so the suite
 * stays hermetic — running this file in any order must not leak env
 * state into the gated integration tests in `generate.test.ts` /
 * `classify.test.ts`.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createAnthropicClient } from "../../pipeline/llm/anthropic-client.ts";

const ENV_KEY = "ANTHROPIC_API_KEY";

describe("createAnthropicClient", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = savedEnv;
    }
  });

  test("returns a client when opts.apiKey is provided (env not consulted)", () => {
    // Scrub env to prove `opts.apiKey` is the sole source.
    delete process.env[ENV_KEY];
    const client = createAnthropicClient({ apiKey: "test-key-from-opts" });
    expect(client).toBeDefined();
    // The Anthropic SDK exposes `apiKey` on the client; verify it
    // received the explicit override and not an empty string.
    expect((client as unknown as { apiKey: string }).apiKey).toBe(
      "test-key-from-opts",
    );
  });

  test("falls back to process.env.ANTHROPIC_API_KEY when opts.apiKey is omitted", () => {
    process.env[ENV_KEY] = "test-key-from-env";
    const client = createAnthropicClient();
    expect(client).toBeDefined();
    expect((client as unknown as { apiKey: string }).apiKey).toBe(
      "test-key-from-env",
    );
  });

  test("throws an env-named error when both opts.apiKey and the env var are unset", () => {
    delete process.env[ENV_KEY];
    expect(() => createAnthropicClient()).toThrow(/ANTHROPIC_API_KEY/);
  });

  test("throws when opts.apiKey is undefined AND env var is the empty string", () => {
    process.env[ENV_KEY] = "";
    expect(() => createAnthropicClient()).toThrow(/ANTHROPIC_API_KEY/);
  });
});
