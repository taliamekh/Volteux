/**
 * Shared mock-SDK infrastructure for `tests/llm/generate.test.ts` and
 * `tests/llm/classify.test.ts`. The two suites originally carried
 * byte-identical copies of these interfaces + builders.
 *
 * The mock simulates the parts of `Anthropic.messages.parse` the LLM
 * modules consume — handler queue, abort-signal short-circuit, error-vs-
 * response routing — without touching the network.
 */

import { APIUserAbortError } from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Mock SDK shapes
// ---------------------------------------------------------------------------

export interface MockUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
}

export interface MockMessageResponse {
  // The SDK calls outputFormat.parse(textBlock.text); we simulate that
  // by exposing `parsed_output` directly and `content` for completeness.
  parsed_output: unknown | null;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
  usage: MockUsage;
  content: ReadonlyArray<{ type: "text"; text: string }>;
}

export interface MockClientCallLog {
  model: string;
  max_tokens: number;
  system: unknown;
  messages: ReadonlyArray<{ role: "user" | "assistant"; content: unknown }>;
  output_config?: { format?: unknown };
}

export type MockHandler = (params: MockClientCallLog) =>
  | MockMessageResponse
  | Promise<MockMessageResponse>
  | Error
  | Promise<never>;

export interface MockSdk {
  messages: {
    parse: (
      params: unknown,
      opts?: { signal?: AbortSignal },
    ) => Promise<unknown>;
  };
  __calls: MockClientCallLog[];
}

/**
 * Build a mock Anthropic-shaped client. Each call invokes the next
 * handler in the queue. If a handler returns a value with
 * `parsed_output`, that's a success path; if it throws, that's a
 * failure path.
 *
 * The mock simulates the SDK's structured-output `parse` step: when
 * the handler returns `{ ...response, parsed_output: rawObj }`, we
 * propagate it as-is (the real SDK would have run `.parse()` and
 * succeeded); when it returns/throws an Error, the SDK-error path runs.
 */
export function makeMockSdk(handlers: MockHandler[]): MockSdk {
  const queue = [...handlers];
  const calls: MockClientCallLog[] = [];
  return {
    messages: {
      parse: async (params: unknown, opts?: { signal?: AbortSignal }) => {
        const p = params as MockClientCallLog;
        calls.push(p);
        const handler = queue.shift();
        if (handler === undefined) {
          throw new Error("mock SDK: no handler queued for this call");
        }
        // Simulate caller-cancellation BEFORE the handler runs.
        if (opts?.signal?.aborted === true) {
          throw new APIUserAbortError({ message: "aborted" });
        }
        const result = await handler(p);
        if (result instanceof Error) throw result;
        return result;
      },
    },
    __calls: calls,
  };
}

/**
 * Generic deps-builder helper. Each test suite passes its own
 * `defaultDeps` object (the production-shaped Deps interface filled with
 * sensible mock values); this helper merges in `overrides` and wires the
 * mock client into `client`.
 *
 * Returns `{ deps, sdk }` so tests can both construct the function under
 * test AND assert against `sdk.__calls`.
 */
export function makeDeps<TDeps extends { client: unknown }>(
  handlers: MockHandler[],
  defaultDeps: Omit<TDeps, "client">,
  overrides: Partial<TDeps> = {},
): { deps: TDeps; sdk: MockSdk } {
  const sdk = makeMockSdk(handlers);
  const deps = {
    ...defaultDeps,
    client: sdk,
    ...overrides,
  } as unknown as TDeps;
  return { deps, sdk };
}
