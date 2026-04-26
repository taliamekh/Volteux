---
title: "feat: v0.1-pipeline-io LLM half — Sonnet generate, Haiku classify, smoke wiring (Units 3, 4, 5)"
type: feat
status: active
date: 2026-04-26
origin: docs/plans/2026-04-25-002-feat-v01-pipeline-io-llm-and-compile-api-plan.md
---

# feat: v0.1-pipeline-io LLM half — Sonnet generate, Haiku classify, smoke wiring (Units 3, 4, 5)

## Overview

Land the LLM half of v0.1-pipeline-io as three independently-exercisable modules plus a wiring-proof smoke script. Units 1 and 2 of plan 002 (Compile API + Docker image; `resolveEndpoint` helper + COR-002 / COR-003 rule fixes) already shipped on `feat/v01-pipeline-io` (16 commits, 235/235 tests green; PR #2 against `main`). This batch closes the remaining three units of plan 002 in the numbering that plan uses:

1. **Unit 3 — `generate()` (Sonnet 4.6).** `messages.parse()` + `zodOutputFormat(VolteuxProjectDocumentSchema)` with a versioned system prompt at `pipeline/prompts/archetype-1-system.md`, prompt caching on the system+schema block, and a single auto-repair retry that carries prior assistant content + Zod errors as a fresh user turn (no prefill). Returns a discriminated `GenerateFailureKind` union (5 kinds + `assertNeverGenerateFailureKind`) on failure.
2. **Unit 4 — `classify()` (Haiku 4.5).** Small structured-output call returning `{archetype_id|null, confidence, reasoning, usage}`. Threshold filtering lives in the caller (Unit 9 orchestrator). Returns a discriminated `ClassifyFailureKind` union (4 kinds + `assertNeverClassifyFailureKind`) on failure.
3. **Unit 5 — Wiring smoke script (`scripts/v01-pipeline-io-smoke.ts`).** 5 hand-written archetype-1 prompts run sequentially through `classify → generate → schema → cross-consistency → rules → compile`. Pre-flights `/api/health` so a missing container doesn't burn Sonnet tokens. Honours `kind: "queue-full"` from `runCompileGate` (skip prompt, log load-shed). Acceptance: ≥3/5 produce schema-valid `VolteuxProjectDocument` + non-empty `.hex` artifact.

End state: an implementer can run `bun run compile:up &` and `bun run smoke` to see all six gates wired across three new modules. Unit 9 (next batch) replaces the smoke script with a proper orchestrator + Honest Gap formatter + JSON-lines tracer.

## Problem Frame

Plan 002's foundation pieces (Compile API, schema gate, library + cross-consistency gates, 11 rules) already validate `VolteuxProjectDocument` shapes that Talia's UI track consumes via fixtures. The pipeline still has no input edge (intent + LLM) and no integration proof that all six gates can interoperate end-to-end. Without this batch, Unit 9's orchestrator design happens against speculation rather than working components — exactly the kind of upstream drift the round-1 + round-2 `/ce:review` passes on plan 002 spent two cycles correcting.

The non-obvious constraint: the LLM modules must be designed so Unit 9's orchestrator (auto-repair across gates, cross-gate retry policy, Honest Gap formatting, trace writing) can wrap them without re-litigating contracts. That means every failure surface this batch produces is a `kind` literal that Unit 9 can switch on — no free-text reason strings; no bare throws crossing the function boundary except for input-validation guards (empty / oversize prompt) where throwing IS the contract.

A second non-obvious constraint comes from the round-2 review: the `buildApp(deps) + startServer()` DI pattern in `infra/server/compile-api.ts` is now load-bearing. Plan 002 § Unit 3 referenced "shared `anthropic-client.ts` that throws at module load if API key missing." That collides with the DI discipline. This plan resolves the collision: **no module-load throws, no module-level singleton client; `buildGenerator(deps)` and `buildClassifier(deps)` are pure factories with thin convenience wrappers.**

## Requirements Trace

- **R1** — `bun run pipeline -- "<prompt>"` produces schema-valid JSON for ≥4/5 archetype-1 prompts (this batch advances; Unit 9 lands the CLI; Unit 10 is the gate)
- **R2** — Each emitted JSON compiles to a real `.hex` via Compile API (Unit 5 smoke script demonstrates 3+/5 end-to-end)
- **R3** — Out-of-scope prompts route to a structured Honest Gap (Unit 4 ships the classifier; Unit 9 wires the formatter)
- **R4** — Schema, compile, rules, cross-consistency, intent classifier all functional and individually testable (this batch ships the classifier + LLM generation, Units 1 and 2 already shipped the others)
- **R6** — Schema in `schemas/document.zod.ts` is the single source of truth (no schema change in this batch — preserved)
- **R7** — Pipeline output includes JSON-lines traces shaped for v0.5 eval (Unit 9 next batch; this batch hooks `usage` into the `GenerateOk` / `ClassifyOk` shapes so the orchestrator can emit `llm_call` events)
- **Origin Unit 3 (plan 002)** — Sonnet 4.6 generation with `zodOutputFormat`, 1h prompt cache on the system+schema block, auto-repair retry shape
- **Origin Unit 4 (plan 002)** — Haiku 4.5 classifier with `{archetype_id|null, confidence, reasoning}`
- **Origin Unit 5 (plan 002)** — Smoke wiring script demonstrating 3+/5 prompts end-to-end

## Scope Boundaries

- **No orchestrator.** `pipeline/index.ts`, `pipeline/cli.ts`, `pipeline/honest-gap.ts`, `pipeline/repair.ts`, `pipeline/trace.ts` all defer to the next batch (Unit 9 of plan 002). The smoke script is throwaway scaffolding that stands in for the orchestrator at this milestone.
- **No acceptance gate.** Holdout discipline (3 tuning + 2 holdout) and the 30-prompt calibration set are Unit 10. This batch ships a 5-prompt smoke test against the wiring; passing 3/5 is the bar, not 4/5 + ≥1/2 holdout.
- **No avrgirl WebUSB spike.** Talia's parallel hardware track owns it. The Compile API produces `.hex` regardless of which library wins.
- **No VPS deploy.** `infra/Dockerfile` + `infra/deploy.md` already shipped in Unit 1. Hetzner CX22 provisioning is v0.2.
- **No Wokwi behavior eval, no meta-harness, no UI integration, no archetypes 2-5.** v0.5, v0.9, v1.0, v1.5 respectively.
- **No CI changes.** Eval CI policy lands with the eval harness in v0.5. v0.1 is local-only.
- **No new helper exports from `pipeline/rules/rule-helpers.ts`.** Plan 002 round-2 review (M-R2-002) removed `resolveComponent` as dead code; this batch does not need it. If Units 3-5 think they want a new rule helper, they must justify it against an actual call site — and none of these three units exercises rule helpers directly. They consume the existing `runRules()` aggregate.

### Deferred to Separate Tasks

- **Unit 9 — orchestrator + Bun CLI + JSON-lines tracing**: next batch. Auto-repair across gates, Honest Gap formatter, trace writer, cross-gate retry policy.
- **Unit 10 — acceptance prompts (3 tuning + 2 holdout) + 30-prompt calibration set + `fixtures/generated/` for Talia**: final batch of v0.1.
- **VPS deploy of the Compile API**: v0.2.
- **Multi-archetype classifier prompt**: v1.5 — when archetypes 2-5 land, the classifier gains 4 more positive routing targets. v0 lists all 5 in the prompt for negative-routing clarity but only archetype 1 is in scope for accept.

## Context & Research

### Relevant Code and Patterns

- [infra/server/compile-api.ts](../../infra/server/compile-api.ts) — the `buildApp(deps) + startServer()` DI pattern Units 3 and 4 mirror. `CompileApiDeps` interface, `_internalTestHooks` underscore-prefixed parameter, factory returns the constructed app, separate `startServer()` reads env. Tests construct the bundle inline at the `buildApp` call site so a future production caller can't import a public test-only type.
- [pipeline/gates/compile.ts](../../pipeline/gates/compile.ts) — the `CompileGateFailureKind` discriminated union with 7 literals + `assertNeverFailureKind` exhaustiveness guard. Pattern: every `kind` is a hyphenated lowercase literal that matches the wire-level error code; `errors: ReadonlyArray<string>` for structured detail; `severity: Severity` from `pipeline/types.ts`; `retry_after_s` is an optional field on `queue-full` only. `EnvelopeParseResult` + `assertNeverEnvelopeKind` is the inner-switch parallel pattern when a function consumes its own discriminated union locally.
- [pipeline/gates/library-allowlist.ts](../../pipeline/gates/library-allowlist.ts) — the `FilenameRejectionKind` enum (`"empty" | "null-byte" | "consecutive-dots" | "path-separator" | "bad-extension" | "sandbox-bypass" | "reserved-name"`) plus the `{kind, reason}` structured-rejection shape. Agent callers switch on `kind`; UI/log surfaces display `reason`. Units 3-5 produce `kind` values the orchestrator (Unit 9) will switch on — same pattern, same discipline.
- [infra/server/cache.ts](../../infra/server/cache.ts) — the canonical-JSON envelope at the hash boundary. Any composite hash key, prompt-version digest, or signature input that combines user-controlled fields must serialize a single `JSON.stringify` envelope object — never separator-byte concatenation. Round-2 verified the NUL-collision attack against the prior `\0`-delimited approach.
- [pipeline/types.ts](../../pipeline/types.ts) — `Severity = "red" | "amber" | "blue"` and `GateResult<TValue>`. Generate / classify return shapes are not `GateResult` (they predate the gate phase) but the `severity` field on failures matches the same 3-tier vocabulary so downstream uniformity holds.
- [schemas/document.zod.ts](../../schemas/document.zod.ts) — exports `ARCHETYPE_IDS` (5 string literals) and `VolteuxProjectDocumentSchema`. The classifier's `IntentClassificationSchema` reuses `z.enum(ARCHETYPE_IDS).nullable()` — single source of truth for archetype identifiers.
- [components/registry.ts](../../components/registry.ts) — the system prompt's schema/registry primer block reads pin metadata + SKU descriptions from this file at module load. The registry is the only authoritative source.
- [.env.example](../../.env.example) — already declares `ANTHROPIC_API_KEY`, `COMPILE_API_URL`, `COMPILE_API_SECRET`. No new env vars in this batch.
- [package.json](../../package.json) — already pins `@anthropic-ai/sdk@^0.91.1`, `hono@^4`, `@hono/zod-validator@^0.4`, `p-limit@^7`, `zod@^3`. No dep changes in this batch; only `scripts` additions (`smoke`, `generate:probe`, `measure:prompt-tokens`).

### Institutional Learnings

- [docs/solutions/best-practices/c-preprocessor-modelling-in-llm-output-gates-2026-04-25.md](../solutions/best-practices/c-preprocessor-modelling-in-llm-output-gates-2026-04-25.md) — "replicate the downstream tool's transformation pipeline before matching." Applies to LLM prompt construction in Unit 3: the cached-prefix block boundary is exactly this kind of static-vs-runtime divergence point. The Anthropic SDK transforms `system` blocks (concatenation rules, whitespace, the `cache_control` boundary). If `generate()` puts the auto-repair instruction **inside** the cached system block (rather than as a fresh user turn after it), every retry mutates the prefix and `cache_read_input_tokens` drops to 0 silently — exactly the static-vs-runtime drift class the learning prevents.
- [docs/solutions/security-issues/sha256-cache-key-canonical-json-serialization-2026-04-26.md](../solutions/security-issues/sha256-cache-key-canonical-json-serialization-2026-04-26.md) — "canonical-envelope rule: any composite hash key with user-controlled string fields must serialize a single envelope via `JSON.stringify`, not separator-byte concatenation." Applies to Unit 3 only if the implementer derives a SHA-256 prompt-version digest that combines the system prompt source + the `archetype_id` + any user-controlled value. This batch deliberately does NOT derive such a digest in code (Unit 9 does for the trace writer); the principle is documented here so the Unit 9 author cannot accidentally reintroduce the NUL-collision class.

### External References

| Surface | Reference (verified by plan 002 on 2026-04-25) | Key takeaway for this batch |
|---|---|---|
| Anthropic SDK current latest | [github.com/anthropics/anthropic-sdk-typescript/releases](https://github.com/anthropics/anthropic-sdk-typescript/releases) | `0.91.1` already installed via plan 002 Unit 1. No structured-output API breaks 0.86 → 0.91. |
| Structured outputs canonical pattern | [platform.claude.com/docs/build-with-claude/structured-outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs.md) | `client.messages.parse({ output_config: { format: zodOutputFormat(Schema) }})`. Read result from `r.parsed_output`. SDK throws on Zod parse failure — the function must `try/catch` to map to `{ok: false, kind: "schema-failed"}`. |
| Prompt caching minimums | [platform.claude.com/docs/build-with-claude/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md) | Sonnet 4.6: ≥2048 prefix tokens; Haiku 4.5: ≥4096. Verify via `response.usage.cache_read_input_tokens`. |
| Auto-repair retry shape | not in upstream docs | Internally documented. The "fresh user turn carrying prior assistant content + ZodIssues, NOT assistant-prefill" pattern works on every Anthropic model version. The probe (does Sonnet 4.6+ reject prefill?) just documents observed behavior; it does not gate the implementation. |

### Slack / Organizational Context

Not searched (no Slack tools wired up in this workspace, and not requested by the user).

## Key Technical Decisions

- **`buildGenerator(deps)` + `buildClassifier(deps)` factory pattern, no module-level singleton client.** Plan 002 § Unit 3 specified "shared `anthropic-client.ts` that throws at module load." Round-2 review's no-silent-failures + DI discipline (and the now-load-bearing `buildApp(deps) + startServer()` precedent in `infra/server/compile-api.ts`) argue against this. **Resolution:** `pipeline/llm/anthropic-client.ts` exports `createAnthropicClient(opts?: { apiKey?: string }): Anthropic` as a factory that reads `ANTHROPIC_API_KEY` at call time only when `opts.apiKey` is omitted. No throw at module load; no exported singleton; the env-missing case throws when the factory is invoked, which happens inside `defaultGenerateDeps()` / `defaultClassifyDeps()` — invoked once on first `generate(prompt)` / `classify(prompt)` call. Tests that use `buildGenerator(mockDeps)` directly never touch env. The convenience wrapper still fails fast for the 99% case where a developer mistypes the env var. **Why:** the round-2 round-1 patterns are now load-bearing — the LLM modules must conform or testability drifts asymmetrically (Compile API tests inject deps; Sonnet tests would have to mock the SDK module via `mock.module` and that's the wrong shape).
- **`GenerateFailureKind` is a 5-literal discriminated union with `assertNeverGenerateFailureKind` exhaustiveness guard.** Plan 002's `{ok:false, kind: "schema-failed" | "truncated"}` is too narrow — round-1 + round-2 reviews on the Compile API forced `CompileGateFailureKind` from 5 → 6 → 7 literals (`transport`, `timeout`, `auth`, `bad-request`, `rate-limit`, `compile-error`, `queue-full`) because the orchestrator needs distinct recovery per kind. Generate has analogous distinctions: schema-failed (LLM emitted invalid JSON; one repair turn worth it), truncated (`stop_reason === "max_tokens"`; retry won't help, surface as Honest Gap), transport (network throw; surface as infra error, no retry), sdk-error (SDK threw outside parse — rate limit, server 5xx; the SDK has its own retry but if it gives up, surface), abort (AbortController fired; caller cancelled). 5 literals + `assertNeverGenerateFailureKind` so a future 6th kind fails compile-time at every switch site rather than silently falling through. **Why information preservation, not premature abstraction:** the SDK naturally surfaces these 5 distinct signals; mapping to a 2-way `validation | infra` union throws away information Unit 9's `repair()` will need.
- **`ClassifyFailureKind` is a 4-literal discriminated union with `assertNeverClassifyFailureKind` exhaustiveness guard.** `transport`, `sdk-error`, `abort`, `schema-failed`. No `truncated` kind: classify's `max_tokens: 1024` is ~5× the typical response shape, and a truncation here is structurally the same as a malformed response (the Zod parse fails inside the SDK). Document the no-truncated decision in `classify.ts` so a future contributor doesn't add a kind literal that has no real condition firing it.
- **No canonical-envelope hash derived in this batch.** `generate()` and `classify()` do not compute SHA-256 digests over composite user-controlled fields. The system prompt is a single string the SDK transmits verbatim; cache_control identifies the prefix boundary; no hash key is derived in TypeScript code. The cross-reference to `docs/solutions/security-issues/sha256-cache-key-canonical-json-serialization-2026-04-26.md` exists in the `Patterns to follow` of every unit so when Unit 9's trace writer adds a `prompt_version_hash` field, the author cannot silently introduce the NUL-collision class. **Why:** the cheapest discipline is the discipline you don't have to apply — when no composite hash exists, no canonical envelope is needed. Adding one prematurely is YAGNI.
- **Wire-contract uniformity: every Anthropic-bound failure surface returns `{ok: boolean, ...}`.** Both `generate()` and `classify()` use this discriminator, matching the Compile API contract and the `runCompileGate` shape. Bare `throw` crossing the function boundary is forbidden EXCEPT for input-validation guards: empty prompt and oversize prompt both throw because throwing IS the contract for "the caller passed garbage" — no recovery is meaningful, the test asserts `expect(() => generate("")).toThrow`, and the orchestrator (Unit 9) must validate inputs before invoking. Document this boundary explicitly in both function headers.
- **No silent failures.** Per [CLAUDE.md](../../CLAUDE.md): every error path either surfaces through a `{ok: false, kind: ...}` return or throws at an input-validation guard. Token-count measurement, padding decisions, retry billing checks, cache-engagement assertions all need an observable signal. Cache-warming sub-decisions: when the first integration run measures `input_tokens < 2048`, the implementer pads (the default per plan 002) and writes the measurement into the prompt header — that's the observable signal. If the implementer writes the ADR comment instead, the cost projection is the observable signal. Both are caught at PR review.
- **System prompt loaded from `pipeline/prompts/archetype-1-system.md` at module load by the factory's caller, not per-call.** The default factory `defaultGenerateDeps()` reads the file synchronously (Bun supports it) and embeds it in the deps. Edits to the prompt source take effect on next `bun run` invocation; no rebuild needed; the v0.9 meta-harness reads this file to propose edits. **Header comment on every prompt source file:** `<!-- This prompt is consumed by the meta-harness in v0.9. Edit via PR; the proposer reads the latest committed version. -->` plus the measured-tokens stamp the implementer adds after the first integration run.
- **Padding-as-default for Sonnet's 1h cache (resolved from plan 002's deferred question).** Plan 002 deferred the measure-vs-pad question. Resolution: padding is the default. The first integration test logs `usage.input_tokens` and the implementer either confirms ≥2048 (no padding needed; document the value) or pads with the canonical fixture inlined in `pipeline/prompts/archetype-1-fewshot.md` (a sibling file the system prompt builder concatenates as a third block) until the measurement clears 2048. **Choosing "no cache" requires an explicit ADR comment in `pipeline/prompts/archetype-1-system.md` containing a cost projection (per-call delta × estimated v0.5 eval volume × N weeks until v0.5 lands).** The measurement script lives at `scripts/measure-prompt-tokens.ts` (one-off, NOT part of `bun test`); it constructs the deps the same way `defaultGenerateDeps()` does, makes one Anthropic call with a trivial user prompt, and prints `usage.input_tokens`. The implementer runs it once and writes the value into the prompt header. **Why:** the round-2 + round-1 patterns are now established; "defer the choice" was the plan-002 default but the meta-harness (v0.9) needs a baseline value committed in source — kicking the can past v0.5 forces a v0.9 emergency calibration session.
- **Padding source discipline: a frozen committed string, NOT `fs.readFileSync("fixtures/uno-ultrasonic-servo.json")` at module load.** If Unit 10 commits `fixtures/generated/*.json` produced by `generate()` and the cached prompt reads any file under `fixtures/` at module load, regenerating fixtures invalidates the cache silently. The padding source revs only via PR. Concretely: the few-shot example lives inline in `pipeline/prompts/archetype-1-fewshot.md` as a hand-frozen string; `defaultGenerateDeps()` reads only `archetype-1-system.md` and `archetype-1-fewshot.md` (when present) — never anything under `fixtures/`.
- **Haiku 4.5 prompt cache will NOT engage; cost projection captured in this plan.** Cache requires ≥4096 tokens; the classifier prompt is ~500-800. Padding to 4096 would 5×-8× the prompt size for a 6× higher cache-write cost on the first call and `0.1×` reads thereafter. **Cost projection (resolved from plan 002's deferred question):** Haiku 4.5 input ~$1/MTok, output ~$5/MTok. Per uncached call ≈ 800 input + 100 output tokens = $0.0008 + $0.0005 = $0.0013/call. v0.5 eval CI runs ~30 prompts × 5 PRs/week × 4 weeks until v0.5 ≈ 600 calls/month → **~$0.78/month classifier-only.** Padding to 4096 would shrink the read cost by 90% but add a one-time write penalty per cache TTL window, and at 600 calls/month the savings is ≤$0.50/month. Decision: do not engage the cache. Re-evaluate if v0.5 eval volume blows past 5000 prompts/month — at that volume the padding becomes worth it. Document in `pipeline/prompts/intent-classifier-system.md` header so future contributors don't add `cache_control` and wonder why nothing engages.
- **Threshold filter (`confidence ≥ 0.6`) lives in the orchestrator, not in `classify()`.** `classify()` returns `{archetype_id, confidence, reasoning, usage}` exactly as the model emits it. The orchestrator (next batch) treats `archetype_id === null` as the dominant out-of-scope signal and applies the secondary `confidence < 0.6` filter. Input-validation cost guards (empty / >5000-char prompt) live local to `classify()`; calibration thresholds live in the caller. **Why:** baking the threshold into `classify()` would put the calibration knob in two places — Unit 10's calibration would have to update both `classify.ts` and the orchestrator.
- **Auto-repair cache discipline inside `generate()`.** The retry sends the prior assistant content as one assistant turn and the ZodIssues as a new user turn — both *after* the cached system+schema block. Cache control sits on the LAST system block; user/assistant turns after it do not invalidate the prefix. Unit 3's tests assert `cache_read_input_tokens > 0` AND `cache_creation_input_tokens === 0` on the retry call. The pair proves both that the cache was hit AND that no second cache-creation was triggered. **Cache-discipline failure mode to avoid:** if the implementer accidentally puts the auto-repair instruction *inside* the cached system block (rather than as a fresh user turn), every retry mutates the prefix and `cache_read_input_tokens` silently drops to 0. The compound learning's principle (replicate the downstream pipeline before matching) is the structural mirror of this trap.
- **Smoke script handles `kind: "queue-full"` as a load-shed signal, not a sketch problem.** When `runCompileGate` returns `{ok: false, kind: "queue-full", retry_after_s}`, the smoke script logs `QUEUE_FULL` outcome with the `retry_after_s` value and skips the prompt — it does NOT retry, because retry is orchestrator territory (Unit 9). Treats `queue-full` separately from `compile-error` in the summary table because the sketch was never attempted. The five smoke prompts run sequentially under `pLimit(2)` server-side, so queue-full should be unreachable in practice; the handling exists as defense-in-depth + a documented case for Unit 9 to lift.
- **arduino-cli #2318 (`--build-path` / `--output-dir` collision): resolved.** Plan 002 deferred this. Unit 1's Dockerfile already runs a canary compile during image build that would fail if the collision broke against `arduino-cli@1.4.1` + AVR core 1.8.6. The canary is the build-time verification; runtime check is unnecessary. Removed from open questions.
- **`max_tokens: 16000` for `generate()`: confirmed.** Plan 002 deferred the verification. Calibration: the canonical fixture (`fixtures/uno-ultrasonic-servo.json`) is ~3kB JSON ≈ ~1k output tokens. 16000 gives ~16× headroom, generous but not extravagant — a verbose archetype-2 (audio dashboard) document with embedded LittleFS HTML strings would land closer to ~4k tokens, still inside 16k. Truncation surfaces as a distinct `kind: "truncated"`, so over-allocation does not blur error classes. Locked at 16000; revisit only if a v1.5 archetype regularly truncates.
- **Hand-rolled rate limiter location: confirmed (server-side only, custom middleware before zValidator).** Plan 002 deferred this; Unit 1 already settled it (per ADV-R2-003 in round-2). The pipeline-side `runCompileGate` and the LLM modules `generate()` / `classify()` do not implement client-side rate limiting in this batch — Unit 9's orchestrator is the right layer if a client-side budget is wanted later. Documented so generate / classify callers do not accidentally re-implement.

## Open Questions

### Resolved During Planning

- **Module-load throw vs DI factory tension** → `buildGenerator(deps)` + `buildClassifier(deps)` factories with `defaultGenerateDeps()` / `defaultClassifyDeps()` convenience that read env at call time. No module-load throws.
- **`GenerateFailureKind` literal set** → 5 literals: `schema-failed | truncated | transport | sdk-error | abort` + `assertNeverGenerateFailureKind`.
- **`ClassifyFailureKind` literal set** → 4 literals: `transport | sdk-error | abort | schema-failed` + `assertNeverClassifyFailureKind`. No `truncated`.
- **Sonnet cache engagement: measure vs pad** → padding is the default. Measurement script `scripts/measure-prompt-tokens.ts` (one-off). ADR comment goes in `archetype-1-system.md` header if the implementer chooses no-cache (must include cost projection).
- **arduino-cli #2318 verify-during-build canary or runtime check** → settled by Unit 1's Dockerfile canary; no runtime check needed.
- **`max_tokens` for `generate()`** → confirmed at 16000. Calibration note added.
- **Hand-rolled rate limiter location** → server-side only via custom middleware before zValidator. No client-side re-implementation.
- **Haiku cache engagement (cost projection)** → do not engage. Projected cost ≤ $0.78/month at v0.5 eval volume; padding savings ≤ $0.50/month and not worth the complexity. Re-evaluate if eval volume > 5000 prompts/month.
- **Where does the threshold filter live (`classify()` or caller)** → caller (orchestrator, Unit 9). `classify()` returns raw model output.
- **Smoke script handling of `queue-full`** → log + skip prompt, treat as separate-from-compile-error outcome in the summary table, do not retry (orchestrator territory).
- **Should classifier failures auto-repair?** → no. The classifier is deterministic enough that a parse failure is a real bug; surface as `kind: "schema-failed"` and let the orchestrator decide retry policy.

### Deferred to Implementation

- **Whether assistant-prefill is rejected by Sonnet 4.6+.** The predecessor plan asserted yes; current Anthropic docs do not confirm. Unit 3's first integration run includes a probe (deliberately constructs an assistant-prefilled message and records the API's response). The multi-turn shape we ship works regardless of the probe's outcome — the probe just documents whether the assertion still holds. Result captured in the `tests/llm/generate.test.ts` header.
- **Whether the `generate:smoke` and `classify:smoke` package.json scripts add real value vs `bun run smoke`.** Plan 002 had `generate:smoke`. Useful for ad-hoc iteration on the prompt source without running the full pipeline. Decide during implementation based on whether any prompt-tuning happens in this batch (probably yes once measurement lands); add a one-line shim if so.
- **Final shape of the smoke summary table when ≥1 prompts hit `QUEUE_FULL`.** Unreachable on a healthy 1-developer workstation but the print format must round-trip through the trace digest hash. Decide when implementing the table renderer; the structure is fixed (one row per prompt, columns: classify / generate / schema / xc / rules / compile / outcome / cache_hit / latency_ms).

## Output Structure

```text
volteux/
├── pipeline/
│   ├── llm/
│   │   ├── anthropic-client.ts             # NEW — createAnthropicClient(opts?) factory; no module-load throw
│   │   ├── generate.ts                     # NEW — buildGenerator(deps), generate(), GenerateFailureKind, assertNeverGenerateFailureKind
│   │   └── classify.ts                     # NEW — buildClassifier(deps), classify(), ClassifyFailureKind, assertNeverClassifyFailureKind
│   └── prompts/
│       ├── archetype-1-system.md           # NEW — version-controlled prompt source for generate()
│       ├── archetype-1-fewshot.md          # NEW (conditional) — frozen few-shot string IF padding needed for cache
│       └── intent-classifier-system.md     # NEW — version-controlled prompt source for classify()
├── scripts/
│   ├── v01-pipeline-io-smoke.ts            # NEW — sequential 5-prompt wiring proof; pre-flight /api/health; queue-full aware
│   ├── measure-prompt-tokens.ts            # NEW — one-off, NOT in bun test; logs usage.input_tokens for archetype-1-system.md header
│   └── smoke-prompts/                      # NEW — 5 hand-written archetype-1 smoke prompts (committed)
│       ├── 01-distance-servo.txt
│       ├── 02-pet-bowl.txt
│       ├── 03-wave-on-approach.txt
│       ├── 04-doorbell-style.txt
│       └── 05-misspelled.txt
├── tests/
│   └── llm/
│       ├── generate.test.ts                # NEW — buildGenerator(mockDeps) unit tests; gated integration (ANTHROPIC_API_KEY)
│       └── classify.test.ts                # NEW — buildClassifier(mockDeps) unit tests; gated integration
├── package.json                            # MODIFY — add scripts: smoke, measure:prompt-tokens, generate:smoke (optional)
└── traces/                                 # gitignored — smoke-<run-id>.txt outputs (not committed)
```

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Module surfaces and DI shape (mirroring `buildApp(deps) + startServer()`)

```text
pipeline/llm/anthropic-client.ts:
  export createAnthropicClient(opts?: { apiKey?: string }): Anthropic
    // factory: reads env only when opts.apiKey omitted. No module-level singleton. No throw at module load.

pipeline/llm/generate.ts:
  export interface GenerateDeps {
    client: Anthropic
    systemPromptSource: string       // raw archetype-1-system.md content
    fewshotSource?: string           // raw archetype-1-fewshot.md content (when padding engaged)
    schemaPrimer: string             // built from VolteuxProjectDocumentSchema + COMPONENTS at deps construction
    model: string                    // default "claude-sonnet-4-6"
    maxTokens: number                // default 16000
  }
  export type GenerateFailureKind = "schema-failed" | "truncated" | "transport" | "sdk-error" | "abort"
  export type GenerateResult =
    | { ok: true; doc: VolteuxProjectDocument; usage: AnthropicUsage }
    | { ok: false; severity: "red"; kind: GenerateFailureKind; message: string; errors: ReadonlyArray<string | ZodIssue> }
  export function buildGenerator(deps: GenerateDeps): (prompt: string) => Promise<GenerateResult>
  export function generate(prompt: string, opts?: { deps?: Partial<GenerateDeps> }): Promise<GenerateResult>
    // convenience wrapper: builds defaultGenerateDeps() lazily, applies opts.deps overrides, calls factory
  export function assertNeverGenerateFailureKind(kind: never): never

pipeline/llm/classify.ts:
  export interface ClassifyDeps {
    client: Anthropic
    systemPromptSource: string       // raw intent-classifier-system.md content
    model: string                    // default "claude-haiku-4-5"
    maxTokens: number                // default 1024
  }
  export type ClassifyFailureKind = "transport" | "sdk-error" | "abort" | "schema-failed"
  export type ClassifyResult =
    | { ok: true; archetype_id: VolteuxArchetypeId | null; confidence: number; reasoning: string; usage: AnthropicUsage }
    | { ok: false; severity: "red"; kind: ClassifyFailureKind; message: string; errors: ReadonlyArray<string> }
  export function buildClassifier(deps: ClassifyDeps): (prompt: string) => Promise<ClassifyResult>
  export function classify(prompt: string, opts?: { deps?: Partial<ClassifyDeps> }): Promise<ClassifyResult>
  export function assertNeverClassifyFailureKind(kind: never): never
```

### Auto-repair retry message construction inside `generate()` (sketch only)

> *Pseudo-code shows the intended message ordering; the implementer should not copy-paste. The point is the cache boundary: retry sends a fresh user turn carrying ZodIssues, never an assistant prefill. The cached prefix is the system block; turns after it do not invalidate the prefix.*

```text
generate(userPrompt):
  attempt 1:
    messages = [
      system: [archetype-1-system.md content, schema+registry primer, fewshot? + cache_control on LAST block]
      user:   userPrompt
    ]
    try:
      response = client.messages.parse({ messages, output_config: zodOutputFormat(Schema), max_tokens: 16000 })
      if response.parsed_output:
        return { ok: true, doc: response.parsed_output, usage: response.usage }
    catch SDK_throw_on_zod_parse_failure as e:
      capture (response.content as priorAssistant, e.issues as zodIssues)
    if response.stop_reason === "max_tokens":
      return { ok: false, kind: "truncated", message, errors: [] }

  attempt 2 (auto-repair, local to generate()):
    messages = [
      system: [unchanged — cache hit expected; cache_creation_input_tokens === 0 on this call]
      user:   userPrompt
      assistant: priorAssistant            # NOT a prefill; this is a completed turn
      user:   "Your previous output failed schema validation: <zodIssues>. Return a corrected JSON document. JSON only."
    ]
    try:
      response = client.messages.parse(...)
      if response.parsed_output: return { ok: true, doc, usage }
    catch SDK_throw as e:
      return { ok: false, kind: "schema-failed", errors: e.issues }
    if response.stop_reason === "max_tokens":
      return { ok: false, kind: "truncated", errors: [] }

  on transport throw at any attempt:
    return { ok: false, kind: "transport", message: "anthropic-sdk fetch failed", errors: [err.message] }
  on AbortController fire at any attempt:
    return { ok: false, kind: "abort", message: "generate aborted", errors: [] }
```

The local auto-repair retry is bounded to ≤2 model calls. Cross-gate retries (schema fail → re-call `generate()`, compile fail → re-call `generate()`) are Unit 9's `repair()` helper.

### Smoke script wiring (Unit 5 integration proof)

```mermaid
sequenceDiagram
    participant Smoke as scripts/v01-pipeline-io-smoke.ts
    participant Health as GET /api/health
    participant Cls as pipeline/llm/classify.ts
    participant Gen as pipeline/llm/generate.ts
    participant SchemaG as pipeline/gates/schema.ts (shipped)
    participant XCons as pipeline/gates/cross-consistency.ts (shipped)
    participant Rules as pipeline/rules/index.ts (shipped)
    participant CompG as pipeline/gates/compile.ts (shipped)
    participant API as Compile API server (shipped)

    Smoke->>Health: pre-flight ping
    Health-->>Smoke: 200 healthy | 503 degraded | timeout
    Note over Smoke: not 200 → exit 1, "Compile API unreachable; run bun run compile:up first"

    loop sequential per prompt (no Promise.all)
        Smoke->>Cls: classify(prompt)
        Cls-->>Smoke: {archetype_id, confidence, ...} | {ok: false, kind}
        Note over Smoke: archetype_id !== "uno-ultrasonic-servo" OR confidence < 0.6 → record OUT_OF_SCOPE; continue
        Smoke->>Gen: generate(prompt)
        Gen-->>Smoke: {ok: true, doc, usage} | {ok: false, kind}
        Note over Smoke: not ok → record GENERATE_FAILED(kind); continue
        Smoke->>SchemaG: runSchemaGate(doc)
        SchemaG-->>Smoke: {ok: true} | {ok: false}
        Smoke->>XCons: runCrossConsistencyGate(doc)
        Smoke->>Rules: runRules(doc)
        Smoke->>CompG: runCompileGate({fqbn, sketch_main_ino, additional_files, libraries})
        CompG->>API: POST /api/compile
        API-->>CompG: 200 ok | 200 compile-error | 503 queue-full | 4xx
        CompG-->>Smoke: {ok: true, value: {hex_b64, cache_hit, latency_ms, ...}} | {ok: false, kind}
        Note over Smoke: kind === "queue-full" → record QUEUE_FULL(retry_after_s); continue (do NOT retry)
    end

    Smoke-->>Smoke: print summary table; sha256(table) → trace digest
    Note over Smoke: exit 0 if ≥3/5 OK rows; else exit 1
```

## Implementation Units

- [ ] **Unit 3: Anthropic client factory + `generate()` (Sonnet 4.6) with auto-repair**

**Goal:** Ship `pipeline/llm/anthropic-client.ts` (factory; no module-level singleton; no module-load throw) and `pipeline/llm/generate.ts` (Sonnet 4.6 generation with `zodOutputFormat`, prompt caching, single auto-repair retry, discriminated `GenerateFailureKind` union with exhaustiveness guard). Mirror the `buildApp(deps) + startServer()` DI shape from `infra/server/compile-api.ts`.

**Requirements:** R1, R3, R7. Auto-repair shape mirrors plan 002's contract for Unit 9 to consume.

**Dependencies:** Plan 002 Units 1 + 2 (already shipped — schema, gates, rules with COR-002/COR-003 closed). Independent of Unit 4 (parallelizable).

**Files:**
- Create: [pipeline/llm/anthropic-client.ts](../../pipeline/llm/anthropic-client.ts) — exports `createAnthropicClient(opts?: { apiKey?: string }): Anthropic`. The factory reads `ANTHROPIC_API_KEY` at call time only when `opts.apiKey` is omitted. **No module-level singleton.** **No module-load throw.** File header explicitly states "do not log the Authorization header, the API key, or `process.env`" so any contributor adding logging sees the rule before doing the wrong thing. Exports nothing else — the client is the only public surface.
- Create: [pipeline/llm/generate.ts](../../pipeline/llm/generate.ts) — exports `GenerateDeps` interface, `GenerateFailureKind` literal-union type, `GenerateResult` discriminated union, `buildGenerator(deps): (prompt) => Promise<GenerateResult>` factory, `generate(prompt, opts?)` convenience, and `assertNeverGenerateFailureKind(kind: never): never` exhaustiveness guard. The exhaustiveness guard mirrors `assertNeverFailureKind` in `pipeline/gates/compile.ts:506`. **Discriminated failure kinds (Files entry, not buried in Approach):**
  - `"schema-failed"` — SDK throws on `zodOutputFormat` parse failure; one repair turn worth attempting before this surfaces
  - `"truncated"` — `stop_reason === "max_tokens"`; retry with same prompt won't help
  - `"transport"` — SDK threw before/after fetch (network error, DNS, socket reset, fetch rejection)
  - `"sdk-error"` — SDK threw inside its own retry-exhaustion path (rate limit retried-out, server 5xx retried-out)
  - `"abort"` — `AbortController` signal fired (caller cancelled)
- Create: [pipeline/prompts/archetype-1-system.md](../../pipeline/prompts/archetype-1-system.md) — version-controlled prompt source. Header comment `<!-- This prompt is consumed by the meta-harness in v0.9. Edit via PR; the proposer reads the latest committed version. -->` + an empty `<!-- system+schema primer measured at N tokens on YYYY-MM-DD; cache engages: yes/no -->` line for the implementer to fill after the first integration run. Initial content: archetype 1 description, the registry's 5 components by SKU + name + role (read from `components/registry.ts` at `defaultGenerateDeps()` construction time, NOT pasted into the prompt source — the prompt source documents what the schema primer should contain, and the schema primer is built dynamically), the canonical wiring shape, JSON-only constraint, "do not invent SKUs" + "do not include v1.5 fields" guardrails.
- Create (conditional, only if measurement triggers padding): [pipeline/prompts/archetype-1-fewshot.md](../../pipeline/prompts/archetype-1-fewshot.md) — frozen few-shot example string. Hand-edited; revs only via PR; NOT read from `fixtures/` at module load.
- Create: [tests/llm/generate.test.ts](../../tests/llm/generate.test.ts) — `buildGenerator(mockDeps)` unit tests + `ANTHROPIC_API_KEY`-gated integration tests. Test file header captures the assistant-prefill probe result after first integration run.
- Create: [scripts/measure-prompt-tokens.ts](../../scripts/measure-prompt-tokens.ts) — one-off, NOT in `bun test`. Constructs deps via `defaultGenerateDeps()`, makes one Anthropic call with a trivial user prompt, prints `usage.input_tokens` and exits 0. Used once after Unit 3 lands; the implementer writes the value into `archetype-1-system.md` header.
- Modify: [package.json](../../package.json) — add `"measure:prompt-tokens": "bun scripts/measure-prompt-tokens.ts"`. Optionally add `"generate:smoke": "bun -e 'await (await import(\"./pipeline/llm/generate.ts\")).generate(\"a robot that waves when something gets close\")'"`.

**Approach:**
- The shared `anthropic-client.ts` file is small (~30 LOC). Factory pattern, no singleton. Inline doc header documents the no-log discipline.
- `defaultGenerateDeps()` is internal to `generate.ts`. It reads `archetype-1-system.md` and (when present) `archetype-1-fewshot.md` synchronously via `Bun.file().text()`, builds the schema+registry primer string by enumerating SKUs from `COMPONENTS` and listing pin metadata, and constructs the deps. Lazily invoked on first `generate(prompt)` call so importing the module does not touch env or file system.
- `buildGenerator(deps)` returns a closure. The closure constructs the messages array with the system prompt as a multi-block array (so `cache_control: { type: "ephemeral", ttl: "1h" }` can sit on the LAST block) and invokes `client.messages.parse({ ..., output_config: { format: zodOutputFormat(VolteuxProjectDocumentSchema) } })`.
- Auto-repair retry: bounded to ≤2 model calls inside the closure. The retry message construction follows the shape in the High-Level Technical Design — a fresh user turn carrying ZodIssues, never an assistant-prefill.
- `usage` field on success carries `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` for Unit 9's trace writer.
- Empty / oversize (`>5000`-char) prompts throw at the function boundary before any API call.
- Failure-kind mapping inside the closure: a `try/catch` per attempt catches SDK throws; the catch handler discriminates by `error.constructor.name` and HTTP status (when available) to decide `schema-failed | sdk-error | transport`. `AbortController` signal → `abort`. `stop_reason === "max_tokens"` (when the API returns successfully but the parse never reached an `parsed_output`) → `truncated`. Default switch falls through to `assertNeverGenerateFailureKind`.

**Patterns to follow:**
- The `buildApp(deps) + startServer()` DI shape in [infra/server/compile-api.ts](../../infra/server/compile-api.ts:174). Same factory-vs-side-effecting-boot split. Same `_internalTestHooks` discipline if test-only knobs are needed (e.g., a deterministic clock for retry billing) — they should not be needed for Unit 3.
- The `CompileGateFailureKind` discriminated union + `assertNeverFailureKind` pattern in [pipeline/gates/compile.ts](../../pipeline/gates/compile.ts:88,506). Hyphenated lowercase literals; `errors: ReadonlyArray<string>` (or `ReadonlyArray<ZodIssue>` for `schema-failed`); `severity: "red"` on every failure.
- The `FilenameRejectionKind` enum + `{kind, reason}` structured-rejection shape in [pipeline/gates/library-allowlist.ts](../../pipeline/gates/library-allowlist.ts:171). Agent-switchable kind, human-readable reason.
- [docs/solutions/best-practices/c-preprocessor-modelling-in-llm-output-gates-2026-04-25.md](../solutions/best-practices/c-preprocessor-modelling-in-llm-output-gates-2026-04-25.md) — the cached-prefix block boundary is the static-vs-runtime divergence point. The auto-repair retry must place the new user turn AFTER the cached system block; placing the auto-repair instruction inside the cached block silently invalidates the cache. This learning's principle is the structural mirror of that trap.
- [docs/solutions/security-issues/sha256-cache-key-canonical-json-serialization-2026-04-26.md](../solutions/security-issues/sha256-cache-key-canonical-json-serialization-2026-04-26.md) — applies as a guardrail: this batch deliberately does NOT derive any SHA-256 over user-controlled fields. If a future contributor adds a `prompt_version_hash` to the trace event in Unit 9, they must use a single `JSON.stringify` envelope, not separator-byte concatenation.

**Test scenarios:**
- *Happy path (mocked)* — `buildGenerator(mockDeps)` where mock returns canonical-fixture-shaped `parsed_output` → `{ok: true, doc}` after exactly 1 call.
- *Happy path (mocked)* — first call returns Zod-parse-error throw; second call returns valid `parsed_output` → `{ok: true, doc}` after exactly 2 calls. Assert message order: system blocks → user (original prompt) → assistant (prior content) → user (errors). No `assistant`-suffixed last message.
- *Error path (mocked, `schema-failed`)* — both calls throw on Zod parse → `{ok: false, kind: "schema-failed", errors: ZodIssue[]}` after exactly 2 calls; no infinite retry.
- *Error path (mocked, `truncated`)* — first call returns `stop_reason === "max_tokens"` with no `parsed_output` → `{ok: false, kind: "truncated"}` after exactly 1 call; no retry (truncation is not a schema error).
- *Error path (mocked, `transport`)* — mock SDK throws `TypeError: fetch failed` → `{ok: false, kind: "transport", errors: ["fetch failed"]}`.
- *Error path (mocked, `sdk-error`)* — mock SDK throws `APIError: 529 Overloaded` after its own retry exhaustion → `{ok: false, kind: "sdk-error"}`.
- *Error path (mocked, `abort`)* — caller passes a pre-fired AbortSignal via `opts.signal` → `{ok: false, kind: "abort"}`.
- *Edge case (input validation)* — `generate("")` throws synchronously (or rejects with a thrown Error); no API call is made (mock asserts zero invocations).
- *Edge case (input validation)* — `generate("x".repeat(5001))` throws synchronously; no API call is made.
- *Edge case (DI)* — `buildGenerator({...mockDeps, model: "claude-sonnet-4-6-future"})` uses the override; production callers using `generate()` see `claude-sonnet-4-6` as the default.
- *Exhaustiveness guard* — TypeScript fails to compile a hand-rolled switch in a sibling test file that adds a new literal to `GenerateFailureKind` without updating the switch (asserted via `// @ts-expect-error` test).
- *Integration (gated by `ANTHROPIC_API_KEY`)* — `generate("a robot that waves when something gets close")` returns `{ok: true, doc}` with `doc.archetype_id === "uno-ultrasonic-servo"` and `doc.sketch.libraries === ["Servo"]`. Generated `doc` passes `runSchemaGate`, `runCrossConsistencyGate`, AND `runRules` (red bucket empty).
- *Integration (gated, cache verification)* — second call within 1h returns `usage.cache_read_input_tokens > 0`. **On the auto-repair retry call, assert BOTH `usage.cache_read_input_tokens > 0` AND `usage.cache_creation_input_tokens === 0`** — the pair proves both that the cache was hit AND that no second cache-creation was triggered. Skipped with a clear log line if first-run measurement showed `< 2048` and the implementer chose no-cache (the ADR comment in the prompt header is the audit trail).
- *Integration (gated, prefill probe)* — deliberately constructs a message with assistant-prefill and records the API's response (accept or reject); writes the result into the test file header for future contributors. Outcome does not gate the test.
- *Integration (gated, regression net)* — generated `doc` for at least one of three known-good prompts passes all six gates including `runCompileGate` against a live Compile API. Future prompt edits that break downstream gates fail this test.

**Verification:**
- `bun test tests/llm/generate.test.ts` is green; integration tests skip cleanly when `ANTHROPIC_API_KEY` is unset.
- `bun run measure:prompt-tokens` prints a numeric `input_tokens` value; the implementer writes it into `pipeline/prompts/archetype-1-system.md` header in the format `<!-- system+schema primer measured at 1847 tokens on 2026-05-02; cache engages: no — padded with frozen fewshot in next commit -->` (or `cache engages: yes` if ≥2048).
- `pipeline/prompts/archetype-1-system.md` carries the meta-harness header comment so v0.9's proposer can read it without ceremony.
- `tsc --noEmit --strict` is clean; the exhaustiveness guard test compiles correctly.
- The PR description includes the measurement value AND the chosen path (cached / padded-and-cached / no-cache + cost projection ADR).

---

- [ ] **Unit 4: Intent classifier (Haiku 4.5)**

**Goal:** Ship `pipeline/llm/classify.ts` with `buildClassifier(deps)` factory + `classify()` convenience. Returns raw model output (no threshold filter inside; filter lives in orchestrator). Returns a discriminated `ClassifyFailureKind` union (4 literals + `assertNeverClassifyFailureKind`). Document the no-cache decision and cost projection in the prompt header.

**Requirements:** R3 (out-of-scope routing). Sets up Unit 9's orchestrator.

**Dependencies:** `pipeline/llm/anthropic-client.ts` from Unit 3 (the shared factory). Schema's `ARCHETYPE_IDS` enum (already shipped). Independent of Unit 3's `generate.ts` for unit tests; can land in parallel with Unit 3 once `anthropic-client.ts` exists.

**Files:**
- Create: [pipeline/llm/classify.ts](../../pipeline/llm/classify.ts) — exports `IntentClassificationSchema = z.object({ archetype_id: z.enum(ARCHETYPE_IDS).nullable(), confidence: z.number().min(0).max(1), reasoning: z.string() })`, `ClassifyDeps` interface, `ClassifyFailureKind` literal-union, `ClassifyResult` discriminated union, `buildClassifier(deps): (prompt) => Promise<ClassifyResult>` factory, `classify(prompt, opts?)` convenience, and `assertNeverClassifyFailureKind(kind: never): never` exhaustiveness guard. **Discriminated failure kinds (Files entry, not buried in Approach):**
  - `"transport"` — SDK threw before/after fetch
  - `"sdk-error"` — SDK threw inside its own retry-exhaustion
  - `"abort"` — `AbortController` signal fired
  - `"schema-failed"` — SDK threw on `zodOutputFormat` parse failure (model returned an invalid `archetype_id` or malformed shape). NOT auto-repaired in this batch (Unit 9 decides).
  - **No `"truncated"` kind**: `max_tokens: 1024` is ~5× the response shape; truncation is structurally indistinguishable from malformed shape; documented in `classify.ts` so a future contributor doesn't add a literal that has no condition firing it.
- Create: [pipeline/prompts/intent-classifier-system.md](../../pipeline/prompts/intent-classifier-system.md) — short version-controlled prompt; same meta-harness header comment as `archetype-1-system.md`. Lists all 5 archetypes by ID + a one-sentence description so the model can map free-form prompts. Out-of-scope examples (load cell, mains voltage, smart home, archetype-4-but-v1.5) are explicit. Header captures the no-cache decision: `<!-- Haiku 4.5 cache requires ≥4096 tokens; this prompt is ~600 tokens so cache_control is intentionally not applied. Cost projection: ~$0.0013/call × ~600 calls/month at v0.5 eval volume ≈ $0.78/month. Re-evaluate if eval volume > 5000 prompts/month. -->`.
- Create: [tests/llm/classify.test.ts](../../tests/llm/classify.test.ts) — `buildClassifier(mockDeps)` unit tests + `ANTHROPIC_API_KEY`-gated integration tests.

**Approach:**
- Same DI pattern as Unit 3: `defaultClassifyDeps()` reads `intent-classifier-system.md` synchronously via `Bun.file()`, constructs deps lazily on first `classify(prompt)` call, no module-load throw.
- `IntentClassificationSchema`'s `archetype_id` reuses `ARCHETYPE_IDS` from `schemas/document.zod.ts` wrapped in `.nullable()`. Single source of truth for the 5 IDs.
- `classify()` returns the raw model output. The `≥0.6` confidence threshold is NOT applied here. Two-stage filter in Unit 9: `result.archetype_id === null` is the dominant out-of-scope signal; `result.confidence < 0.6` is the secondary filter.
- `max_tokens: 1024` is plenty for the small response.
- Empty prompt rejected at function boundary; `>5000`-char prompt also rejected (hard cap to avoid LLM-cost surprises during dev).
- No auto-repair on classify failure. The classifier is deterministic enough that a parse failure is a real bug; surface as `kind: "schema-failed"` with the SDK's ZodIssues in `errors`.
- `usage` field on success carries the same fields as `generate()` for Unit 9's trace writer. `cache_read_input_tokens` is expected to be 0 (no cache engaged).

**Patterns to follow:**
- Same DI shape as Unit 3's `buildGenerator(deps)`. Same factory-vs-singleton discipline. Same `assertNeverClassifyFailureKind` exhaustiveness guard pattern.
- The "small Zod schema with `.nullable()` for out-of-scope routing" idiom — explicit `null` is the strongest out-of-scope signal.
- [docs/solutions/best-practices/c-preprocessor-modelling-in-llm-output-gates-2026-04-25.md](../solutions/best-practices/c-preprocessor-modelling-in-llm-output-gates-2026-04-25.md) — same principle as Unit 3 (cached-prefix discipline) but inverted: this unit deliberately has no cache, so the trap doesn't apply. Documenting the no-cache decision in the header is the analogue of the audit-trail discipline the learning recommends for static-vs-runtime divergence points.

**Test scenarios:**
- *Happy path (mocked)* — `buildClassifier(mockDeps)` returns a closure; closure called with a known prompt invokes `client.messages.parse` exactly once and returns `{ok: true, archetype_id: "uno-ultrasonic-servo", confidence: 0.85, reasoning: "..."}`.
- *Happy path (mocked, raw output preserved)* — mock returns `{archetype_id: "uno-ultrasonic-servo", confidence: 0.4}` → `classify()` returns this raw; no filtering inside the function.
- *Happy path (mocked, null routing)* — mock returns `{archetype_id: null, confidence: 0.95}` → `classify()` returns the null verbatim.
- *Error path (mocked, `schema-failed`)* — mock SDK throws on Zod parse (model returned `archetype_id: "unknown-archetype"`) → `{ok: false, kind: "schema-failed", errors}` after exactly 1 call; no retry.
- *Error path (mocked, `transport`)* — mock SDK throws fetch error → `{ok: false, kind: "transport"}`.
- *Error path (mocked, `sdk-error`)* — mock SDK throws after retry exhaustion → `{ok: false, kind: "sdk-error"}`.
- *Error path (mocked, `abort`)* — pre-fired AbortSignal → `{ok: false, kind: "abort"}`.
- *Edge case (input validation)* — `classify("")` throws synchronously; no API call.
- *Edge case (input validation)* — `classify("x".repeat(5001))` throws synchronously; no API call.
- *Exhaustiveness guard* — TypeScript fails to compile a sibling switch that adds a new literal to `ClassifyFailureKind` without handling it.
- *Integration (gated)* — `classify("a robot that waves when something gets close")` → `{archetype_id: "uno-ultrasonic-servo", confidence: ≥0.7, reasoning: <non-empty>}`.
- *Integration (gated)* — `classify("I want to measure how close my dog gets to the food bowl")` → `archetype_id: "uno-ultrasonic-servo"` (free-form variant; tests figurative-language mapping).
- *Integration (gated)* — `classify("a scale that weighs my packages")` → `archetype_id: null`; `reasoning` mentions "load cell" or "weight".
- *Integration (gated)* — `classify("control my house lights from my phone")` → `archetype_id: null`; mains voltage / smart-home out of scope.
- *Integration (gated)* — `classify("a temperature display that texts me")` → `archetype_id: null` (matches archetype 4, v1.5; v0 routes to null rather than misroute to archetype 1).
- *Integration (gated, no cache)* — `classify(prompt)` returns `usage.cache_read_input_tokens === 0` AND `usage.cache_creation_input_tokens === 0` — confirms the no-cache decision. If either field is non-zero, the implementer accidentally wired `cache_control` and the test fails.

**Verification:**
- `bun test tests/llm/classify.test.ts` is green.
- Manual measurement: 10 hand-classified prompts (5 archetype-1, 5 out-of-scope) → ≥9/10 correct. If <9/10, surface the failures; either iterate the system prompt OR escalate to Talia for a button-based picker fallback OR defer calibration to Unit 10's 30-prompt set.
- `pipeline/prompts/intent-classifier-system.md` header documents the no-cache decision + cost projection + 5-archetype enumeration.
- `tsc --noEmit --strict` clean; exhaustiveness guard test compiles correctly.

---

- [ ] **Unit 5: Demo wiring smoke test (`scripts/v01-pipeline-io-smoke.ts`)**

**Goal:** Prove the three new units interoperate end-to-end with the four foundation gates before Unit 9's orchestrator lands. 5 hand-written archetype-1 prompts run sequentially through `classify → generate → schema → cross-consistency → rules → compile`. Acceptance: ≥3/5 produce schema-valid `VolteuxProjectDocument` + non-empty `.hex` artifact. Pre-flight `/api/health`. Honour `kind: "queue-full"` from `runCompileGate` as a load-shed signal.

**Requirements:** R1, R2, R3, R4 (all advanced; this is the wiring milestone, not the acceptance gate).

**Dependencies:** Units 3 and 4. (Plan 002's Unit 2 — rule fixes — has already shipped.) Foundation gates already shipped.

**Files:**
- Create: [scripts/v01-pipeline-io-smoke.ts](../../scripts/v01-pipeline-io-smoke.ts) — Bun script: parses argv, runs 5 prompts sequentially, prints per-prompt outcome table, writes `traces/smoke-<run-id>.txt` (gitignored), prints `sha256(table)` digest to stdout, exits 0 if ≥3/5 OK, 1 otherwise.
- Create: [scripts/smoke-prompts/01-distance-servo.txt](../../scripts/smoke-prompts/01-distance-servo.txt) — `"turn a servo when an HC-SR04 detects something close"`
- Create: [scripts/smoke-prompts/02-pet-bowl.txt](../../scripts/smoke-prompts/02-pet-bowl.txt) — `"I want to measure how close my dog gets to the food bowl"`
- Create: [scripts/smoke-prompts/03-wave-on-approach.txt](../../scripts/smoke-prompts/03-wave-on-approach.txt) — `"a robot that waves when something gets close"`
- Create: [scripts/smoke-prompts/04-doorbell-style.txt](../../scripts/smoke-prompts/04-doorbell-style.txt) — `"a doorbell that moves a flag when someone walks up"`
- Create: [scripts/smoke-prompts/05-misspelled.txt](../../scripts/smoke-prompts/05-misspelled.txt) — `"a robut that waves wen sumthing gets close"`
- Modify: [package.json](../../package.json) — add `"smoke": "bun scripts/v01-pipeline-io-smoke.ts"`.
- Modify: [.gitignore](../../.gitignore) — add `traces/`. (If `.gitignore` already excludes it, no change.)
- **Failure-kind-aware outcome enum (Files entry, not buried in Approach):** the script emits one of these structured outcomes per prompt: `OK | OUT_OF_SCOPE | CLASSIFY_FAILED(kind) | GENERATE_FAILED(kind) | SCHEMA_FAILED | XCONSIST_FAILED | RULES_RED(count) | COMPILE_FAILED(kind) | QUEUE_FULL(retry_after_s)`. The outcome enum is expressed as a TypeScript discriminated union local to the script (not exported); the orchestrator (Unit 9) defines its own outcome shape and need not consume this one.

**Approach:**
- The script is a sequential loop:
  1. Read the 5 prompts from `scripts/smoke-prompts/`.
  2. Pre-flight: `GET /api/health` against `COMPILE_API_URL`. If non-200 (or fetch throws), print "Compile API unreachable at <url>; run `bun run compile:up` first" and exit 1 BEFORE any Anthropic call. Saves the dev from burning Sonnet tokens chasing a missing container.
  3. Pre-flight: assert `ANTHROPIC_API_KEY` is set (or print error + exit 1 before any prompt).
  4. For each prompt:
     - `await classify(prompt)`
     - On `kind: "transport" | "sdk-error" | "abort" | "schema-failed"` → record `CLASSIFY_FAILED(kind)`; continue.
     - If `archetype_id !== "uno-ultrasonic-servo"` OR `confidence < 0.6` → record `OUT_OF_SCOPE`; continue. (The `confidence < 0.6` filter is applied in the script even though `classify()` returns raw output — this is the orchestrator behavior at smoke scale.)
     - `await generate(prompt)`. On `kind: ...` → record `GENERATE_FAILED(kind)`; continue.
     - `runSchemaGate(doc)`. On `!ok` → record `SCHEMA_FAILED`; continue.
     - `runCrossConsistencyGate(doc)`. On `!ok` → record `XCONSIST_FAILED`; continue.
     - `runRules(doc)`. On `red.length > 0` → record `RULES_RED(red.length)`; continue.
     - `await runCompileGate({fqbn, sketch_main_ino, additional_files, libraries})`.
     - On `kind: "queue-full"` → record `QUEUE_FULL(retry_after_s)`; **do NOT retry**; continue.
     - On other compile failure → record `COMPILE_FAILED(kind)`; continue.
     - On success → record `OK(hex_size_bytes, cache_hit, latency_ms)`.
- Print the summary table at the end. Columns: prompt # | classify outcome | generate outcome | schema | xc | rules red count | compile outcome | hex bytes | cache_hit | latency_ms.
- Compute `sha256(JSON.stringify(table))` and print as the "smoke run hash" — the wiring proof that goes in the PR description.
- Write the table to `traces/smoke-<run-id>.txt` for human inspection (gitignored).
- Strict serial execution. `await` each prompt's full pipeline before starting the next; no `Promise.all`. The Compile API's `pLimit(2)` would interleave concurrent compiles and the cache (keyed on sketch content) could serve A's stderr to B's caller if Sonnet emitted byte-identical sketches for two different prompts. Sequentiality also keeps the per-prompt outcome table interpretable.
- **Failure-kind-aware exhaustiveness:** the outcome-printing switch uses the imported `assertNeverGenerateFailureKind`, `assertNeverClassifyFailureKind`, and `assertNeverFailureKind` (the existing one for `CompileGateFailureKind`) so a future kind addition fails compile-time at the smoke script too.
- These 5 smoke prompts are reused (or rewritten) when Unit 10 authors the proper acceptance set — they are throwaway scaffolding aligned with the smoke script's lifetime.

**Patterns to follow:**
- Plan 002 Unit 5's sequential-execution + pre-flight discipline.
- The compound learning's tests-first-then-fix discipline applied to the smoke script: the 5 prompts and the outcome enum exist before the runner code does.
- The `assertNeverFailureKind` exhaustiveness pattern from [pipeline/gates/compile.ts](../../pipeline/gates/compile.ts:506) — the script's outcome-print switch must call all three assertNever helpers.
- [docs/solutions/best-practices/c-preprocessor-modelling-in-llm-output-gates-2026-04-25.md](../solutions/best-practices/c-preprocessor-modelling-in-llm-output-gates-2026-04-25.md) — the script's "fail informatively, not silently" principle is the structural mirror: every gate failure produces a discriminated outcome the table can render.

**Test scenarios:**
<!-- Smoke script is integration-only; not part of `bun test`. Test scenarios capture the cross-unit behaviors the script must demonstrate. -->
- *Acceptance criterion (integration only)* — `bun run compile:up &` then `bun run smoke` produces a table with ≥3/5 OK rows. The PR description includes the printed `sha256` hash as the wiring proof.
- *Failure mode (Compile API down)* — running `bun run smoke` *without* `compile:up` prints "Compile API unreachable at <url>" and exits 1 BEFORE any Anthropic calls (verified by leaving `ANTHROPIC_API_KEY` unset and observing the script exits with the missing-container message, not the missing-key message).
- *Failure mode (no API key)* — running with `compile:up` running but no `ANTHROPIC_API_KEY` exits with a clear missing-key error after the health check passes.
- *Edge case (out-of-scope misclassification)* — if any of the 5 prompts unexpectedly classifies as null (e.g., the misspelled one), the script records `OUT_OF_SCOPE` and that counts as a failure for the ≥3/5 gate. Surfaces as a real signal: either iterate the prompt OR iterate the classifier.
- *Edge case (queue-full)* — manually inject queue-full by running `bun run smoke` against a Compile API artificially load-shedding (test hook: temporarily set `MAX_QUEUE_DEPTH=0` in a fork of the server). Script records `QUEUE_FULL(retry_after_s)`, prints the `retry_after_s` value in the table, exits 0 if remaining prompts ≥3 OK or 1 otherwise. **Smoke script does NOT retry queue-full** (orchestrator territory).
- *Edge case (cache hit)* — second consecutive `bun run smoke` invocation (same prompts, same toolchain hash) should show `cache_hit: true` for prompts that previously succeeded. Latency drops from ~3-8s to <100ms per compile. Useful proof that cache works.
- *Cross-unit integration (the failure modes the smoke script exists to surface):*
  - LLM emits `Servo` in `libraries[]` but no `#include <Servo.h>` in `sketch.main_ino` → cross-consistency check (h) catches `unknown header` (no — only when *include* is present without library; in this direction it passes). Compile gate may still succeed (arduino-cli auto-resolves). Recorded as `OK` if compile succeeds; not a bug per the schema.
  - LLM emits `#include <Servo.h>` but `libraries[]` is empty → cross-consistency check (h) emits `include-without-libraries-declaration` → recorded as `XCONSIST_FAILED`. Confirms the existing gate fires under LLM pressure.
  - LLM emits a sketch that calls `Servo.attach(99)` (out-of-range pin) → no rule catches it (`sketch-references-pins` finds `99` outside the 0-19 pin space; `current-budget` doesn't fire); compile passes. Recorded as `OK` in the smoke gate, but the residual gap is logged for Unit 10's calibration set design. v0.5 Wokwi behavior eval catches runtime correctness.
  - LLM emits a sketch with HC-SR04.GND not connected (ungrounded sensor, ADV-005) → all rules pass per the existing gap. Recorded as `OK`; residual gap logged for Unit 10. ADV-005 closure is a separate batch.
- *Edge case (exhaustiveness regression)* — the script's outcome-print switch must call `assertNeverGenerateFailureKind`, `assertNeverClassifyFailureKind`, and `assertNeverFailureKind` at the default branch of each kind switch. A future kind addition fails compile-time before the script can ship a silent fall-through.

**Verification:**
- `bun run compile:up &` starts the container; `bun run smoke` produces the summary table; ≥3/5 rows are OK.
- The PR description includes the printed `sha256` hash. Without the hash, the manual-only gate is honor-system; the PR-template line raises the friction of skipping it.
- Reviewer checklist item (added to PR template once this batch lands): "Have you run `bun run smoke` locally? Paste the hash."
- The script writes nothing to disk except `traces/smoke-<run-id>.txt`. Avoids accidental fixture commits before Unit 10.
- `tsc --noEmit --strict` clean. The three `assertNever*` calls in the outcome-print switch compile.

## System-Wide Impact

- **Interaction graph:** Three new outbound edges to external systems — Anthropic API (Sonnet via `generate()`, Haiku via `classify()`) and the local Compile API HTTP endpoint (already wired in Unit 1; smoke script is the new caller). Three new internal modules consumed by the future Unit 9 orchestrator: `classify()`, `generate()`, `runCompileGate()` (already shipped). No new schema fields, no new gate signatures, no new callbacks/observers/middleware.
- **Error propagation:** `generate()` and `classify()` return `{ok: false, kind: ...}` on validation / SDK / abort failures. They throw ONLY at the input-validation boundary (empty / oversize prompt). No bare `throw` crossing the function boundary on infra failure — the SDK throw is caught and mapped to a `kind` literal. Unit 9's orchestrator translates these into Honest Gap; this batch's smoke script renders them in the outcome enum.
- **State lifecycle risks:**
  - No persistent state introduced in this batch. The factory-vs-singleton DI pattern eliminates module-level state.
  - The Anthropic SDK manages its own connection pool; one client per `buildGenerator(deps)` call, but `generate()` convenience reuses the result of `defaultGenerateDeps()` once it's lazily built. No connection-pooling concerns at v0.1 scale.
  - Smoke script writes one line per run to `traces/smoke-<run-id>.txt` (gitignored). No buildup unless the dev forgets to clean periodically — documented in `infra/deploy.md` for v0.2 (cron eviction not in scope here).
- **API surface parity:**
  - The schema (`schemas/document.zod.ts`) is unchanged.
  - The Compile API contract is locked from Unit 1; no changes here.
  - The `generate()` and `classify()` return shapes carry `usage` so Unit 9's orchestrator can emit `llm_call` trace events without re-fetching.
  - **All three failure-kind unions (`GenerateFailureKind`, `ClassifyFailureKind`, `CompileGateFailureKind`) use hyphenated lowercase literals.** Wire-contract uniformity across the three outbound systems.
- **Integration coverage:** Unit-level mocks won't catch ordering bugs across the three new modules. The smoke script (Unit 5) is the cross-unit integration coverage in this batch; Unit 9's `tests/pipeline.test.ts` will replace it with a proper test suite.
- **Unchanged invariants:**
  - `components/registry.ts` is the only authoritative source of static component metadata. `generate()`'s schema primer enumerates the registry as grounding context; the registry source remains the single edit point.
  - The Honest Gap shape `{scope, missing_capabilities, explanation}` from origin doc § Definitions is NOT introduced in this batch — Unit 9's `pipeline/honest-gap.ts` formalizes it. Smoke script surfaces failures as the discriminated outcome enum.
  - `GateResult<TValue>` from `pipeline/types.ts` is unchanged. `generate()` and `classify()` deliberately do NOT use `GateResult` because they predate the gate phase; they use their own `{ok, ...}` discriminated unions with `kind` literals — same shape, same `severity` vocabulary.
  - The 11 archetype-1 rules' severity assignments and conditions are LOCKED. This batch does not touch any rule.
  - The `buildApp(deps) + startServer()` DI shape in `infra/server/compile-api.ts` is unchanged; Units 3 and 4 mirror it without modifying it.
  - The `FilenameRejectionKind` enum in `pipeline/gates/library-allowlist.ts` is unchanged; this batch produces parallel `kind` literal unions (`GenerateFailureKind`, `ClassifyFailureKind`) following the same agent-switchable discipline.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| **`ANTHROPIC_API_KEY` not available with $5/day cap** — without a separate dev key, integration tests skip silently (and never run before merge) or burn unmonitored cost. | Resolve before starting Unit 3. Generate a dedicated dev key in Anthropic Workspaces; set a $5/day usage alert; add to local `.env`. `.env.example` already documents this; `pipeline/llm/anthropic-client.ts` repeats it in the file header. Production v0.2 deploy uses a different key with its own alert. |
| **Sonnet 4.6 prompt caching might not engage if system+schema primer is < 2048 tokens** — plan 002 deferred the measurement; this plan resolves to "padding-as-default." | First integration run logs `usage.input_tokens`. If <2048: pad with the frozen `archetype-1-fewshot.md` source until ≥2048 OR write the no-cache ADR comment with cost projection. Decision is documented in `archetype-1-system.md` header so reviewers can verify which path was taken. The cost impact of "no cache" is tolerable at v0.1 dev volume (~100 calls/day at full Sonnet pricing ≈ $5-15/day); for v0.5 eval CI volumes, padding is the right answer. |
| **Auto-repair retry shape (no prefill) is internally documented; not in upstream Anthropic docs** — Sonnet 4.6+ returning 400 on assistant-prefill is asserted in plan 002 but not verified. | Unit 3's first integration run includes a probe (deliberately constructs a message with assistant-prefill and records the API's response). The multi-turn shape we ship works on every model version regardless of the probe outcome. Result documented in the test file header so future contributors see the latest observed behavior. |
| **Cache-discipline trap: auto-repair instruction inside the cached system block silently invalidates the prefix.** Cache-read drops to 0 with no compile-time signal. | Test scenario asserts `cache_creation_input_tokens === 0` AND `cache_read_input_tokens > 0` on the auto-repair retry call. The pair is the only way to detect silent re-create. Plus the High-Level Technical Design's pseudo-code explicitly places `cache_control` on the LAST system block, with the auto-repair turn AFTER all system blocks. The compound learning's principle (replicate the downstream pipeline) is the framing — placing user content inside the cached block is the structural mirror of the C-preprocessor SEC-001 trap. |
| **DI pattern adoption costs more than singleton in test code** — the round-2 review pattern mandates DI, but the round-1 plan's singleton is simpler. | The `buildApp(deps)` precedent already exists, and Unit 9's orchestrator (next batch) will need to inject mock generate / classify deps to test cross-gate retry policy without burning Anthropic tokens in CI. Adopting DI now means Unit 9's tests don't have to mock-module-rewrite three files — they construct the deps inline. The "singleton is simpler" argument is locally cheaper but globally more expensive. |
| **`GenerateFailureKind` 5-literal union is wider than plan 002's 2-literal** — more switch sites for Unit 9 to maintain. | The exhaustiveness guard (`assertNeverGenerateFailureKind`) makes maintenance compile-time-checked rather than runtime-checked. Plan 002's 2-literal narrowness was already insufficient: round-1 + round-2 review on the Compile API forced `CompileGateFailureKind` from 5 → 7 literals because Unit 9 needs distinct recovery per kind. The same reasoning applies to generate / classify; preempt the round-3 expansion by shipping the right literal set the first time. |
| **Smoke script burns Anthropic budget on each run** (~5 prompts × ~$0.05 per Sonnet call ≈ $0.25/run; ~$0.005 per Haiku call ≈ $0.025/run; total ~$0.27/run). | Document the per-run cost in `scripts/v01-pipeline-io-smoke.ts` header. The script runs sequentially; cancellable mid-run via Ctrl-C. A `--dry-run` flag that only calls `classify()` (~$0.025 total) is a nice-to-have for iteration. |
| **Smoke summary counts a prompt as `OK` even when residual rule gaps slipped through** (ADV-005 ungrounded sensor; ADV-007 duplicate breadboard layout; COR-001 anchor_hole column-0). Beginner could flash a non-functional board. | Smoke milestone is a wiring proof, not a correctness proof. The friend-demo gate (week 10-12) requires Wokwi behavior eval (v0.5) and the avrgirl spike (Talia, parallel). Documented explicitly in the System-Wide Impact section so this batch's reviewer sees the gate language. |
| **Haiku 4.5 SDK behavior could differ from Sonnet** — different rate limits, different retry semantics. | The SDK's retry logic is shared across models. The 4-literal `ClassifyFailureKind` union (no `truncated`) is the only model-specific shape; document the no-truncated decision in `classify.ts` so a future contributor doesn't add a literal that has no real condition firing it. If Haiku 5.x drops in v0.5 with truncation behavior, add `"truncated"` to `ClassifyFailureKind` and update the exhaustiveness guard — the change is mechanical. |
| **Padding source (`archetype-1-fewshot.md`) reads from `fixtures/` accidentally during a future refactor** — would silently invalidate the cache. | `defaultGenerateDeps()` only reads from `pipeline/prompts/`. A grep in CI or a code review checklist item catches `fs.readFileSync.*fixtures` in `pipeline/llm/`. The rule is documented in the prompt source headers and in `pipeline/llm/generate.ts`. |
| **TypeScript `strict` mode catches the exhaustiveness guards but the integration tests can run despite them** — a test that hits a Compile API that returns a malformed shape might dispatch on a stringly-typed fallback rather than the discriminated union. | The `runCompileGate` schema parsing already rejects malformed responses with `kind: "transport"` (per round-2 AC-013). `generate()` and `classify()` similarly map SDK throws to `transport | sdk-error` rather than passing through. Integration tests that expect specific kinds use exact-match assertions. |

## Documentation / Operational Notes

- **Updates to `docs/PLAN.md` and `CLAUDE.md`:** None needed in this batch. The pipeline plan reference link in `CLAUDE.md` remains correct (it points to the predecessor plan; this plan is a continuation, not a replacement).
- **`pipeline/prompts/archetype-1-system.md` and `pipeline/prompts/intent-classifier-system.md`:** both ship with the meta-harness header comment `<!-- This prompt is consumed by the meta-harness in v0.9. Edit via PR; the proposer reads the latest committed version. -->`. The v0.9 proposer expects to find these; do not move or rename without coordination.
- **First-run measurement of `usage.input_tokens` for Sonnet:** record in `pipeline/prompts/archetype-1-system.md` header. Format: `<!-- system+schema primer measured at 1847 tokens on 2026-05-02; cache engages: yes (≥2048) | no — padded with frozen fewshot in next commit | no — see ADR below for cost projection -->`.
- **Cost projection for Haiku no-cache decision:** captured in `pipeline/prompts/intent-classifier-system.md` header. Format: `<!-- Haiku 4.5 cache requires ≥4096 tokens; this prompt is ~600 tokens so cache_control is intentionally not applied. Cost projection: ~$0.0013/call × ~600 calls/month at v0.5 eval volume ≈ $0.78/month. Re-evaluate if eval volume > 5000 prompts/month. -->`.
- **No CI changes:** v0.1 is local-only per origin doc § Eval CI policy.
- **Cost watch (carried from predecessor plan):** Sonnet generation ~$0.05-0.15/call without cache, ~$0.01-0.03 with 1h cache. Haiku classifier ~$0.001/call. Smoke run ~$0.27/run; expect 5-10 runs during Unit 5 iteration ≈ ~$2.70 total.
- **`infra/deploy.md` already documents** v0.2 Hetzner CX22 provisioning, secret rotation, CORS-for-v1.0-UI gap. No changes here.
- **PR template addition (Documentation Plan):** add a checklist item "Have you run `bun run smoke` locally? Paste the SHA-256 hash from stdout." Goes in `.github/PULL_REQUEST_TEMPLATE.md` after this batch lands so future PRs touching `pipeline/llm/`, `pipeline/prompts/`, or `scripts/v01-pipeline-io-smoke.ts` can be reviewed against an actual wiring proof.

## Sources & References

- **Origin plan (Units 3, 4, 5 of plan 002):** [docs/plans/2026-04-25-002-feat-v01-pipeline-io-llm-and-compile-api-plan.md](2026-04-25-002-feat-v01-pipeline-io-llm-and-compile-api-plan.md). Units 1 + 2 already shipped (16 commits, 235/235 tests green; PR #2 to `main`).
- **Predecessor plan (foundation):** [docs/plans/2026-04-25-001-feat-v01-pipeline-archetype-1-plan.md](2026-04-25-001-feat-v01-pipeline-archetype-1-plan.md).
- **Compound learning (cached-prefix + agent-switchable + canonical-envelope principles):** [docs/solutions/best-practices/c-preprocessor-modelling-in-llm-output-gates-2026-04-25.md](../solutions/best-practices/c-preprocessor-modelling-in-llm-output-gates-2026-04-25.md).
- **Compound learning (canonical-JSON envelope at hash boundary):** [docs/solutions/security-issues/sha256-cache-key-canonical-json-serialization-2026-04-26.md](../solutions/security-issues/sha256-cache-key-canonical-json-serialization-2026-04-26.md).
- **Round-2 `/ce:review` session digest** (the patterns this plan inherits): `.context/compound-engineering/ce-review/20260425-225256-b7c36938/` — 12 reviewer-persona JSON files. The DI pattern (`buildApp + startServer`), `pLimit` queue cap, `assertNeverFailureKind` exhaustiveness guards, hyphenated wire codes, structured-rejection `{kind, reason}`, NUL-collision canonical-envelope, `Retry-After` propagation, and `bearerAuth` custom hooks all originated or solidified in this round.
- **Origin design (full project context):** [docs/PLAN.md](../PLAN.md) (§ Pipeline Architecture, § Compile API contract, § Library allowlist, § Definitions, § Track 2).
- **Track ownership and conventions:** [CLAUDE.md](../../CLAUDE.md).
- **Anthropic SDK structured outputs:** [platform.claude.com/docs/build-with-claude/structured-outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs.md) (verified 2026-04-25 by plan 002).
- **Anthropic prompt caching minimums:** [platform.claude.com/docs/build-with-claude/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md) (Sonnet 4.6 ≥2048 tokens; Haiku 4.5 ≥4096; verified 2026-04-25).
- **Anthropic SDK current release:** [github.com/anthropics/anthropic-sdk-typescript/releases](https://github.com/anthropics/anthropic-sdk-typescript/releases) (`0.91.1` already pinned in `package.json`).
- **Live infra (already shipped) used by smoke script:**
  - [infra/server/compile-api.ts](../../infra/server/compile-api.ts) — Compile API server (Hono, bearer auth, pLimit, queue-full 503).
  - [pipeline/gates/compile.ts](../../pipeline/gates/compile.ts) — pipeline-side `runCompileGate` (7-kind discriminated union + `assertNeverFailureKind`).
  - [pipeline/gates/schema.ts](../../pipeline/gates/schema.ts), [pipeline/gates/cross-consistency.ts](../../pipeline/gates/cross-consistency.ts), [pipeline/gates/library-allowlist.ts](../../pipeline/gates/library-allowlist.ts), [pipeline/rules/index.ts](../../pipeline/rules/index.ts) — foundation gates.
- **Local skills referenced:**
  - `~/.claude/skills/claude-api/SKILL.md` (Anthropic SDK patterns).
  - `~/.claude/skills/cost-aware-llm-pipeline/SKILL.md` (`CostTracker` shape that the trace format will mirror in Unit 9).
