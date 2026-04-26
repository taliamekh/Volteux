---
title: "feat: v0.1-pipeline orchestrator + tracing + acceptance harness (Units 6, 7, 8)"
type: feat
status: active
date: 2026-04-27
origin: docs/plans/2026-04-26-001-feat-v01-pipeline-llm-units-3-4-5-plan.md
---

# feat: v0.1-pipeline orchestrator + tracing + acceptance harness (Units 6, 7, 8)

## Overview

Close v0.1-pipeline-io by replacing the smoke-script scaffolding with a real orchestrator + observability layer + acceptance harness, split across three PRs to keep diffs reviewable per CLAUDE.md's one-line-PR-description rule. Foundation already shipped on `feat/v01-pipeline-llm`: PR #1 (schema/gates/rules; 142 tests), PR #2 (Compile API + Docker + foundation review fixes; 235/235 tests), PR #3 (LLM half: generate/classify/smoke + 11 review-fix commits + 1 learning doc; 17 commits, 332/332 tests).

This batch lands the next three units of the v0.1-pipeline-io plan:

1. **Unit 6 — Orchestrator + CLI + Honest Gap + cross-gate auto-repair.** `pipeline/index.ts` with `buildPipeline(deps)` + `runPipeline(prompt, opts?)` and an 8-literal `PipelineFailureKind` discriminated union. `pipeline/cli.ts` Bun entry honouring `--json` / `--dry-run` and distinct exit codes. `pipeline/honest-gap.ts` formatter that produces the `{scope, missing_capabilities, explanation}` shape from any failure kind. `pipeline/repair.ts` cross-gate auto-repair: when compile/rules/xconsist fail, compose a repair prompt and trigger one fresh `generate()` turn; bounded; never infinite-loops. The orchestrator REPLACES `scripts/v01-pipeline-io-smoke.ts`; the smoke prompt files migrate into Unit 8's calibration set.
2. **Unit 7 — JSON-lines trace writer + cost tracker + observability.** `pipeline/trace.ts` writes events to `traces/<run-id>.jsonl` (`llm_call`, `gate_outcome`, `honest_gap`, `compile_call`, `repair_attempt`, `pipeline_summary`). Scrubs SDK error messages per residual finding #18 before persisting (redacts `sk-ant-api03-*` API keys, request bodies, header values; preserves kind + status + ZodIssue paths). Composite hashes (`prompt_version_hash`, `trace_event_hash`) use single-envelope `JSON.stringify` per the sha256 learning. `pipeline/cost.ts` ships a `CostTracker` accumulating $/run from `usage` fields. The orchestrator emits trace events through a `TraceWriter` dep injected via DI.
3. **Unit 8 — Acceptance harness + 30-prompt calibration set + `fixtures/generated/`.** `tests/acceptance/prompts/archetype-1/*.txt` carries 30 prompts (5 sealed holdout via frontmatter). `tests/acceptance/run.ts` is a CLI runner with 3-axis scoring v0.1: schema-validity, compile-pass, rules-clean (behavior-correctness is v0.5 Wokwi-only — explicitly out of scope). `fixtures/generated/archetype-1/*.json` is regenerated outputs for Talia's UI snapshots. Acceptance gate: schema-validity ≥ 99%, compile-pass ≥ 95%, rules-clean ≥ 90% per origin doc § Success Criteria week-7 milestone.

End-state: an implementer can run `bun run compile:up &` and `bun run pipeline -- "<prompt>"` to see the full v0.1 pipeline produce a `VolteuxProjectDocument` + `.hex` artifact, with structured failure paths through Honest Gap and a JSON-lines trace per run; or run `bun run acceptance` to grade the 30-prompt calibration set against three v0.1 axes and write regenerated fixtures for Talia.

## Problem Frame

PR #3's smoke script (`scripts/v01-pipeline-io-smoke.ts`) is throwaway scaffolding that proved the LLM half + Compile API can interoperate end-to-end across three modules. It is not the pipeline. It does not surface Honest Gap, does not emit trace events, does not auto-repair across gates, has no acceptance discipline (no tuning/holdout split, no scoring axes, no regenerated fixtures), and burns ~$0.27/run on five hand-written prompts that are not held out from prompt iteration. The orchestrator's design has been deferred long enough that delaying further would let speculation about `repair()` shape, trace schema, or scoring matrix harden into ad-hoc ergonomics.

The non-obvious constraints driving this batch:

- **Unit 6's orchestrator must wrap the existing modules without re-litigating their contracts.** The `buildX(deps)` factory, in-flight-Promise lazy init with `__testing` namespace reset, discriminated failure-kind unions with `assertNever*` exhaustiveness guards, canonical-JSON envelope at hash boundaries, wire-contract uniformity (`{ok: false, kind, ...}`), and the no-silent-failures discipline are now load-bearing across 4+ modules. The orchestrator inherits each pattern; it does not reinvent any.
- **Unit 7's trace writer is the next high-risk site for cache-key-style serialization bugs.** Composite hashes combining prompt content + archetype id + timestamp + usage + gate outcomes are exactly the canonical-envelope hazard that the sha256 learning documented. The trace writer also scrubs SDK error messages, which previously got forwarded verbatim into `errors[]` (residual security finding #18) — Sonnet 4xx response bodies sometimes echo the API key or request payload, both of which would persist to disk without scrubbing.
- **Unit 8 is the first acceptance-discipline surface in the codebase.** The 5 sealed holdout prompts are the bar between "we tuned to pass our own tests" and "the pipeline generalizes." The split must be enforced by frontmatter, not by convention, so the meta-harness (v0.9) cannot accidentally tune against holdout. Behavior-correctness is explicitly v0.5-Wokwi territory; this batch ships 3-axis scoring and documents the missing axis as an audit-trail comment in `tests/acceptance/run.ts` so a future contributor doesn't think it was forgotten.

## Requirements Trace

- **R1** — `bun run pipeline -- "<prompt>"` produces schema-valid JSON for ≥4/5 archetype-1 prompts. **This batch ships R1's entry point** (Unit 6 CLI) and **the calibration measurement** (Unit 8 acceptance run); the gate threshold is ≥4/5 on tuning + ≥1/2 on holdout (Unit 8 acceptance gate).
- **R2** — Each emitted JSON compiles to a real `.hex` via Compile API. Already shipped (Compile API in PR #2; pipeline/gates/compile.ts wraps it). Unit 6's `runPipeline()` calls `runCompileGate` after the schema/xconsist/rules gates pass; Unit 8's acceptance scoring uses compile-pass as one of three axes.
- **R3** — Out-of-scope prompts route to a structured Honest Gap. **Unit 6 ships the formatter** (`pipeline/honest-gap.ts`); **Unit 8 verifies it** with explicit out-of-scope acceptance prompts (load cell, mains voltage, archetype-2-but-WiFi).
- **R4** — Schema, compile, rules, cross-consistency, intent classifier all functional and individually testable. Already shipped (PR #1 + PR #2 + PR #3); Unit 6's orchestrator composes them into one entry point.
- **R6** — Schema in `schemas/document.zod.ts` is the single source of truth. **No schema change in this batch — preserved.** Unit 7's trace events reference `VolteuxArchetypeId` and `VolteuxHonestGap` types; reuse, never redeclare.
- **R7** — Pipeline output includes JSON-lines traces shaped for v0.5 eval. **Unit 7 ships this** (`pipeline/trace.ts`).
- **Origin Unit 9 (plan 002 + plan 2026-04-26-001 § Deferred to Separate Tasks)** — orchestrator + Bun CLI + JSON-lines tracing. Resolved as Units 6 + 7 of THIS plan (split for diff size).
- **Origin Unit 10 (plan 002)** — acceptance prompts (3 tuning + 2 holdout) + 30-prompt calibration set + `fixtures/generated/` for Talia. Resolved as Unit 8 of THIS plan.
- **Origin doc § Success Criteria week-7 milestone** — schema-validity ≥ 99%, compile-pass ≥ 95%, rules-clean ≥ 90%. Unit 8 ships the harness; the actual numbers come from running it.
- **Residual #18 (security)** — SDK errors scrubbed before persistence. Closed by Unit 7.
- **Residual #20 (architectural)** — truncation retry policy. Resolved here as "surface as Honest Gap; no retry" (see Key Technical Decisions). Closed by Unit 6.
- **Residual #29 (testing)** — regression-net 6-gate test missing. Closed by Unit 6 verification (full pipeline gated integration test).

## Scope Boundaries

- **No Wokwi behavior simulation.** That's v0.5. The behavior-correctness axis is documented as the missing 4th axis in `tests/acceptance/run.ts` but is not implemented; current acceptance scores 3 axes only.
- **No meta-harness proposer.** That's v0.9. Trace events are shaped to be eval-harness-readable so the proposer can consume them without a re-shape pass, but no proposer code lands here.
- **No UI integration.** Talia's track owns it; Unit 8 produces `fixtures/generated/archetype-1/*.json` for Talia's UI snapshot tests, but this batch does not touch any code under a UI directory.
- **No archetypes 2-5.** v1.5. The orchestrator's classifier-then-generate flow only routes archetype-1; out-of-scope (any other archetype, or `null`) lands in Honest Gap.
- **No VPS deploy of the Compile API.** v0.2. Unit 8's acceptance harness assumes `bun run compile:up &` is running locally before the run starts; the pre-flight check fails fast if not.
- **No new schema fields.** R6 invariant. The `VolteuxHonestGap` type already exists in `schemas/document.zod.ts`; the orchestrator's Honest Gap formatter constructs it via that type, not a new shape.
- **No CI changes.** Eval-CI gating policy lands with the eval harness in v0.5. v0.1 is local-only.
- **No changes to `pipeline/llm/sdk-helpers.ts` shape.** Unit 6 imports `extractMessage`, `isStructuredOutputParseError`, etc., but does not modify the helper. Test-utility extensions (e.g., a shared SDK-error mock builder for scrub-policy tests) are added under `tests/llm/test-helpers.ts` if useful, never inside the production helper module.
- **No `pipeline/llm/{generate,classify}.ts` migration to `__testing` namespace.** The lazy-init learning prescribes the namespace form for NEW modules; the LLM modules' `_resetDefaultDepsForTest()` standalone form stays as documented. Unit 6's `pipeline/index.ts` ships the namespace form directly so the precedent for new pipeline modules is set.

### Deferred to Separate Tasks

- **Wokwi behavior simulation + 4th scoring axis**: v0.5. Parked in `tests/acceptance/run.ts` header comment so the next implementer sees the gap immediately.
- **Meta-harness proposer (v0.9)**: consumes Unit 7's traces; no work in this batch.
- **VPS deploy of the Compile API**: v0.2 (`infra/deploy.md` already drafted).
- **`pipeline/llm/{generate,classify}.ts` `__testing` namespace migration**: opportunistic; do when next touching either file. Tracked in the lazy-init learning doc.
- **Residual review finding #14 (`ClassifyResult.errors` plan-vs-impl)**: cosmetic; defer to v0.5 cleanup.
- **Residual review finding #17 (SDK deep import)**: SDK-version-conditional; defer to v0.5 cleanup.
- **CORS handling for the Compile API**: v1.0 when Talia integrates; documented in `infra/deploy.md`.
- **Multi-archetype acceptance set**: v1.5 — when archetypes 2-5 land, the calibration set grows. v0.1 covers archetype 1 only.

## Context & Research

### Relevant Code and Patterns

- `infra/server/compile-api.ts` — the `buildApp(deps) + startServer()` DI shape Unit 6 mirrors as `buildPipeline(deps) + runPipeline(prompt, opts?)`. Same factory-vs-side-effecting-boot split. Tests construct deps inline at the `buildPipeline` call site so a future production caller cannot import a public test-only type.
- `pipeline/llm/generate.ts` — `buildGenerator(deps)` factory + lazy-init in-flight-Promise + `_resetDefaultDepsForTest()` reset. Unit 6's `defaultPipelineDeps()` mirrors the in-flight-Promise shape but exposes the namespace form (`__testing.resetDefaultPipelineDeps()`) per the lazy-init learning's forward-going recommendation.
- `pipeline/llm/classify.ts` — same pattern as generate; `IntentClassificationSchema` reuses `ARCHETYPE_IDS` from the schema; threshold filter (`confidence ≥ 0.6` AND `archetype_id === "uno-ultrasonic-servo"`) lives in the orchestrator (this batch's Unit 6), not in `classify()`.
- `pipeline/gates/compile.ts` — `CompileGateFailureKind` 7-literal discriminated union + `assertNeverCompileGateFailureKind` exhaustiveness guard. Unit 6 imports the renamed symbol; the legacy name `assertNeverFailureKind` no longer exists. `CompileGateValue` carries `latency_ms`, `hex_size_bytes`, `cache_hit`, `toolchain_version_hash` for trace events.
- `pipeline/gates/library-allowlist.ts` — `FilenameRejectionKind` enum (7 literals) + `{kind, reason}` structured-rejection shape. Reference for "agent-switchable kind, human-readable reason" idiom that Unit 6's `PipelineFailureKind → HonestGap` formatter consumes when surfacing filename rejections.
- `pipeline/gates/cross-consistency.ts` — `runCrossConsistencyGate(doc)` returns `GateResult<void>`; the per-check structured detail is currently stringified into `errors: ReadonlyArray<string>`. Unit 6 consumes the stringified form unchanged. Plan 002 § Agent-Native Gap 1 / KT-002 / AC-004 deferred the `GateResult.errors` discriminated-union refactor to whenever `pipeline/repair.ts` lands — that's THIS batch — but the refactor is out of scope here too: Unit 6's `repair()` only needs `kind` granularity at the gate boundary, not per-check sub-discriminators. Defer formally to v0.5.
- `pipeline/rules/index.ts` — `runRules(doc)` returns `{red, amber, blue, attempts}`; `red.length > 0` is the orchestrator's gate signal. `amber`/`blue` carry forward as warnings on the final `runPipeline()` success result.
- `pipeline/types.ts` — `Severity = "red" | "amber" | "blue"` and `GateResult<TValue>`. Unit 6's `PipelineResult` uses `severity: "red"` on every failure (matches all sibling failure surfaces).
- `infra/server/cache.ts` — `cacheKey()` uses single-envelope `JSON.stringify` for SHA-256 input. Unit 7's trace-event composite hashes (`prompt_version_hash`, `trace_event_hash`) use the same shape. The module also exposes `__testing.resetMemoizedHash()` — the namespace pattern Unit 6 + Unit 7 ship.
- `pipeline/llm/sdk-helpers.ts` — `extractMessage`, `extractZodIssues`, `isStructuredOutputParseError`, `makeOutputFormat`. Unit 6 imports `extractMessage` for the orchestrator's failure-context construction; Unit 7's scrub policy operates on the same string surface, so any change to extraction must consider scrub side-effects.
- `scripts/v01-pipeline-io-smoke.ts` — soon-to-be-deleted; the patterns Unit 6 inherits: `--json` (machine-readable output), `--dry-run` (skip LLM + pre-flight), distinct exit codes (0/1/2), `TRACE_PATH=<path>` on stderr, sequential per-prompt loop. The 5 prompt files at `scripts/smoke-prompts/*.txt` migrate into Unit 8's calibration set as the trivial sub-cases (4 archetype-1 + 1 misspelled). `scripts/measure-prompt-tokens.ts` stays — it's a separate one-off.
- `schemas/document.zod.ts` — `VolteuxHonestGap` type and `HonestGapSchema` already exist. Unit 6's `pipeline/honest-gap.ts` returns `VolteuxHonestGap` shape verbatim; never redefines it.

### Institutional Learnings

- `docs/solutions/logic-errors/lazy-init-singleton-in-flight-promise-bun-test-isolation-2026-04-26.md` — required reading for Unit 6. `defaultPipelineDeps()` MUST follow the in-flight-Promise pattern + `__testing` namespace test reset (the learning's prescribed forward-going naming convention). Three test shapes lock the contract: (1) object-identity dedup under concurrent `Promise.all`, (2) synchronous-promise-reference test pinning `function` not `async function`, (3) reset test proving the escape hatch evicts.
- `docs/solutions/security-issues/sha256-cache-key-canonical-json-serialization-2026-04-26.md` — REQUIRED reading for Unit 7. Trace-event composite hashes (`prompt_version_hash`, `trace_event_hash`) must use single-envelope `JSON.stringify`, never separator-byte concatenation. The canonical-envelope rule applies to ANY composite hash key with user-controlled string fields.
- `docs/solutions/best-practices/c-preprocessor-modelling-in-llm-output-gates-2026-04-25.md` — required reading for Units 6 and 8. Apply to any orchestrator gate-wrapping where static-vs-runtime divergence is possible (Unit 6's repair-prompt construction must replicate the schema/registry primer that `generate()` uses, never a divergent description) AND to Unit 8's any prompt-content static analysis or behavior-assertion shape (the acceptance prompts feed `generate()` whose static prompt gating is downstream — calibration prompts must replicate the C-preprocessor-equivalent semantics of what the LLM will actually receive).

### External References

| Surface | Reference (verified by predecessor plans) | Key takeaway for this batch |
|---|---|---|
| Anthropic SDK | `@anthropic-ai/sdk@~0.91.1` (already pinned) | Patch-only pin per `pipeline/llm/sdk-helpers.ts` STRUCTURED_OUTPUT_PARSE_ERROR_PREFIX rationale. A future SDK minor may break `isStructuredOutputParseError`; Unit 6 has no direct exposure (sdk-helpers.ts owns it) but the orchestrator's failure routing inherits the brittleness — listed as a residual risk in Unit 6's risk table. |
| JSON Lines spec | jsonlines.org | Each line a self-contained JSON object; `\n`-delimited; no trailing comma; the file is append-only. Unit 7's trace writer writes one line per event. |
| Hetzner CX22 RTT | ~25-50ms typical from Apple Silicon dev workstation | Not relevant in v0.1 (local Compile API), but `runCompileGate`'s 30s timeout already accommodates v0.2 deploy without per-deploy tuning. |

### Slack / Organizational Context

Not searched. No Slack tools were wired into this workspace; the prompt did not request Slack research; predecessor plans did not surface organizational context relevant to orchestrator/observability/acceptance work that isn't already captured in CLAUDE.md and docs/PLAN.md.

## Key Technical Decisions

- **`PipelineFailureKind` is an 8-literal discriminated union with `assertNeverPipelineFailureKind` exhaustiveness guard.** Literals: `"out-of-scope" | "schema-failed" | "compile-failed" | "rules-red" | "xconsist-failed" | "transport" | "truncated" | "aborted"`. **Justification (each literal demands distinct downstream handling):**
  - `out-of-scope` — classifier returned `archetype_id === null` OR `confidence < 0.6` OR `archetype_id !== "uno-ultrasonic-servo"`. Routes to Honest Gap with `scope: "out-of-scope"`. No retry meaningful.
  - `schema-failed` — `generate()` returned `kind: "schema-failed"` after its local auto-repair turn. Cross-gate `repair()` does NOT retry generate again on this kind (generate already burned 2 calls); routes to Honest Gap.
  - `compile-failed` — `runCompileGate` returned `kind: "compile-error"` (200 OK with stderr). One cross-gate `repair()` turn worth attempting (re-prompt `generate()` with `stderr` as failure context). After one repair, escalate to Honest Gap.
  - `rules-red` — `runRules` returned `red.length > 0`. One cross-gate `repair()` turn worth attempting (re-prompt with rule violations). After one repair, escalate to Honest Gap.
  - `xconsist-failed` — `runCrossConsistencyGate` returned `{ok: false}`. One cross-gate `repair()` turn worth attempting (re-prompt with structured per-check errors). After one repair, escalate to Honest Gap.
  - `transport` — any infra failure (Anthropic transport, Compile API unreachable, fetch reject, DNS, socket reset, generate `kind: "transport"`, classify `kind: "transport"`, compile `kind: "transport"|"timeout"|"auth"|"bad-request"|"rate-limit"|"queue-full"`). Surfaces without retry — infra is the orchestrator's caller's problem (CLI exits 2, test asserts failure shape). Routes to Honest Gap with infra-specific `explanation`.
  - `truncated` — `generate()` returned `kind: "truncated"`. Decision (residual #20): **surface as Honest Gap; no retry**. Retrying with same prompt won't help (truncation indicates the prompt asked for more than `max_tokens=16000`). The "retry once with `max_tokens: 32000`" alternative was considered and rejected: 32k is also a hard ceiling and a 16k → 32k retry doubles cost on the failing path; the Sonnet 4.6 max output is 64k but our prompts that hit 16k already indicate prompt-tuning is needed, not larger output. Calibration prompts (Unit 8) include one `>16k expected` case to verify the truncation surface.
  - `aborted` — `AbortSignal` fired (caller cancelled mid-pipeline). Distinct from `transport` because the failure is caller-driven; Honest Gap formatter emits a different `explanation` ("This run was cancelled before completion.") because the user's experience differs.
  - **Why 8, not 5 or 10:** every literal corresponds to a distinct handling decision in `repair()` (retry vs no-retry, different repair-prompt construction) AND a distinct Honest Gap `explanation`. Collapsing `out-of-scope` and `xconsist-failed` would lose the routing decision for the classifier; collapsing `transport` and `aborted` would lose the explanation differentiation. Adding kinds (`auth-failed`, `rate-limited`, `queue-full`) would re-export sub-discriminators the orchestrator does not act on differently — they all roll up to `transport`'s "infra is the caller's problem" handling. The `repair()` decision matrix below makes this concrete.

  | Failure kind | `repair()` action | Honest Gap `scope` | Honest Gap `explanation` style |
  |---|---|---|---|
  | `out-of-scope` | none | `out-of-scope` | "Your idea needs <missing>, which v0 does not support." |
  | `schema-failed` | none (generate already retried) | `out-of-scope` | "I tried twice but couldn't shape this idea into a valid project." |
  | `compile-failed` | re-call `generate()` with stderr context (≤1 turn) | `partial` | "I built the wiring + parts list, but the sketch wouldn't compile." |
  | `rules-red` | re-call `generate()` with rule violations (≤1 turn) | `partial` | "I built the wiring + sketch, but flagged a safety issue." |
  | `xconsist-failed` | re-call `generate()` with per-check errors (≤1 turn) | `partial` | "I built the parts list but the wiring referenced things that don't exist." |
  | `transport` | none | `out-of-scope` | "I couldn't reach the build server. Try again in a minute." |
  | `truncated` | none | `out-of-scope` | "The sketch I tried to write was too long for one response." |
  | `aborted` | none | `out-of-scope` | "This run was cancelled before completion." |

- **`buildPipeline(deps) + runPipeline(prompt, opts?)` factory pattern, no module-level singleton, in-flight-Promise lazy init.** Mirrors `buildGenerator(deps) + generate(prompt, opts?)` from `pipeline/llm/generate.ts`. `defaultPipelineDeps()` reads ANTHROPIC_API_KEY indirectly through `defaultGenerateDeps()` + `defaultClassifyDeps()`, plus `COMPILE_API_URL` + `COMPILE_API_SECRET` from env at call time (never at module load). Tests construct `buildPipeline(mockDeps)` directly.

- **`defaultPipelineDeps()` exposes `__testing.resetDefaultPipelineDeps()` (namespace form, not standalone).** Per the lazy-init learning's forward-going prescription. Unit 6 is a NEW module; ship the namespace form directly. Three test shapes (object-identity, sync-promise-reference, reset) replicate the test suite at `tests/llm/defaults.test.ts`.

- **`pipeline/repair.ts` is bounded and never infinite-loops.** Cross-gate auto-repair triggers AT MOST ONCE per `runPipeline` invocation, regardless of how many gates fail in sequence. The repair counter lives on the orchestrator's per-run state, NOT the closure deps. After one repair attempt, any subsequent gate failure (including the SAME gate failing again) routes to Honest Gap — the orchestrator does not let the repair attempt itself trigger another repair on a later gate. **Why bounded at 1, not 2 or N:** generate() already does its own auto-repair (≤2 model calls); the cross-gate repair adds a 3rd Sonnet call worst case. A 4th would push per-run cost past $0.20 with diminishing returns; calibration data in Unit 8 will validate the bound, and v0.5 may calibrate it differently.

- **The `repair()` helper composes a fresh user turn carrying the failing-gate's structured errors, NOT a multi-turn replay.** Pattern mirrors `pipeline/llm/generate.ts`'s in-function auto-repair: the cached system blocks are unchanged; the user turn carries `{prior_doc_summary, gate_kind, errors}` where `prior_doc_summary` is a 200-char digest of the failing document (NOT the full JSON, which would dominate tokens). The repair-prompt template lives at `pipeline/prompts/repair-archetype-1.md` so the meta-harness (v0.9) can edit it; same header comment shape as `archetype-1-system.md`.

- **`pipeline/honest-gap.ts` returns the schema's `VolteuxHonestGap` shape (`{scope, missing_capabilities, explanation}`) verbatim.** Single source of truth is `schemas/document.zod.ts`'s `HonestGapSchema`. `pipeline/honest-gap.ts` exports `formatHonestGap(failure: PipelineFailure): VolteuxHonestGap` as a pure function; takes a `PipelineFailure` (the `{ok: false, kind, ...}` discriminated union) and a `prompt: string`, returns the schema shape. Each kind has a dedicated explanation builder (8 small functions, one per literal). The decision matrix above defines the per-kind `scope` and `explanation` style.

- **Trace events are JSON-Lines, append-only, one event per line, no trailing commas.** File path: `traces/<run-id>.jsonl`. `<run-id>` is `${ISO-timestamp-slug}-${8-char-uuid-suffix}` per the smoke script's existing pattern. Each event has `{ts, run_id, event, ...payload}` where `event` is one of `"llm_call" | "gate_outcome" | "compile_call" | "honest_gap" | "repair_attempt" | "pipeline_summary"`. The first event is `pipeline_summary` with `prompt`, `prompt_sha256`, `prompt_version_hash`, `git_sha`, `started_at`; the last is a second `pipeline_summary` with `outcome`, `cost_usd`, `total_latency_ms`, `ended_at`. The double-`pipeline_summary` shape is intentional: a partial trace (process killed mid-run) still has the start-event so the eval harness can detect incompleteness without parsing the whole file.

- **`prompt_version_hash` and any composite trace-event hash use single-envelope `JSON.stringify` per the sha256 learning.** The fields included in `prompt_version_hash`: `{archetype_id, system_prompt_source_sha256, schema_primer_sha256, fewshot_source_sha256_or_null, repair_prompt_sha256, model, max_tokens}`. Single `JSON.stringify` envelope, single `hash.update()` call. The trace writer's regression test injects NUL bytes into each user-controlled field independently and asserts collision-free hashes (mirrors the cache-key learning's prevention #3).

- **Trace writer scrubs SDK error messages before persistence (residual #18).** Scrub policy lives in `pipeline/trace.ts` as a pure `scrubSdkError(message: string): string` function. Redacts:
  - API keys: regex `/sk-ant-api03-[A-Za-z0-9_-]{20,}/g` → `<redacted-anthropic-key>`.
  - Bearer tokens: regex `/Bearer [A-Za-z0-9._\-]{20,}/gi` → `Bearer <redacted>`.
  - HTTP request body fragments emitted by SDK 4xx errors: any `"messages":\s*\[.*?\]` block in the message → `"messages":<redacted-request-body>`.
  - Header value echoes: any `"authorization":\s*"[^"]*"` → `"authorization":"<redacted>"`.
  Preserves: `kind` literal, HTTP status, ZodIssue paths (`issues[].path[]`), error class name. **Scrub-misses are surfaced, not silent.** If the raw message contains a substring matching a known sensitive shape (e.g., `^sk-ant-api03-` anywhere AFTER scrub), the trace writer emits a stderr WARN line `[trace] WARN: scrub may have missed a sensitive token in event=<event> at <file>:<line>` and writes a placeholder event marking the field as redacted-and-unverified. **Why surface, not silently double-scrub:** double-scrubbing would mask the regex gap; the WARN forces investigation when a new SDK error shape lands.

- **`CostTracker` accumulates $/run from `usage` fields using committed per-model rates.** Rates table at `pipeline/cost.ts` top-of-file:
  - Sonnet 4.6: input $3/MTok, cache_write $3.75/MTok, cache_read $0.30/MTok, output $15/MTok.
  - Haiku 4.5: input $1/MTok, cache_write $1.25/MTok, cache_read $0.10/MTok, output $5/MTok.
  Per-call cost = `(input_tokens × input_rate + cache_creation × cache_write_rate + cache_read × cache_read_rate + output_tokens × output_rate) / 1_000_000`. Compile API calls cost $0 for v0.1 (local Docker; the per-call cost docstring documents v0.2 VPS runtime as "<$0.001 per compile" for forward visibility). The accumulated cost is emitted on the final `pipeline_summary` event AND printed on stderr per `--json` mode contract.

- **Acceptance harness scores 3 axes only (v0.1).** Schema-validity (`runSchemaGate(generate(prompt).doc).ok`), compile-pass (`runCompileGate(...).ok`), rules-clean (`runRules(doc).red.length === 0`). Behavior-correctness is v0.5 Wokwi. The acceptance script's `--axes` flag is omitted (don't expose a knob the harness can't honor); the v0.5 axis comes via a planned "behavior" scoring function and a `--with-wokwi` flag that this batch documents in the file header but does NOT implement. Acceptance gate: schema-validity ≥ 99%, compile-pass ≥ 95%, rules-clean ≥ 90% on the 25 tuning prompts; ≥1/2 success on the 5 sealed holdout prompts (passing means both schema-valid AND compile-pass — rules-clean is informational on holdout to avoid coupling to the rule set during the gate).

- **Calibration set is 30 prompts: 25 tuning + 5 sealed holdout, partition enforced via frontmatter.** Each prompt file is a small frontmatter + body shape: `--- holdout: false expected_kind: ok|out-of-scope expected_archetype: uno-ultrasonic-servo|null --- <prompt body>`. The acceptance runner sorts by frontmatter `holdout: true|false`. **Holdout enforcement:** the meta-harness (v0.9) reads only `holdout: false` files; Unit 8 ships a unit test in `tests/acceptance/run.test.ts` that asserts the runner refuses to print holdout prompt bodies in `--tuning-only` mode, so a future contributor cannot accidentally peek. Initial 5 holdout prompts are committed sealed; the file headers document the freeze date and the rule "do NOT modify this prompt or its expected_* fields without breaking holdout discipline; if the holdout needs refresh, treat as a v0.5 calibration cycle."

- **`fixtures/generated/archetype-1/*.json` is regenerated on every `bun run acceptance --regen-fixtures` and committed via PR.** Talia's UI snapshot tests consume these. The acceptance runner writes one JSON file per tuning prompt named `${prompt_filename_without_ext}.json` (e.g., `01-distance-servo.json`). The runner skips holdout prompts in regen mode. **Cache discipline:** `defaultGenerateDeps()` reads ONLY from `pipeline/prompts/`, never from `fixtures/`, so regenerating fixtures cannot invalidate the prompt cache (the discipline established in PR #3 is preserved here). Unit 8's regen step is documented as a separate command from the scoring run so iterations don't burn fixture writes.

- **Smoke script + smoke-prompts deletion is part of Unit 6's PR.** `scripts/v01-pipeline-io-smoke.ts` and the 5 files at `scripts/smoke-prompts/*.txt` are removed. The 5 prompts migrate into `tests/acceptance/prompts/archetype-1/` under `tuning/` with `holdout: false` and the appropriate `expected_*` frontmatter. Unit 6's PR description includes the migration mapping (5 lines) so reviewers can verify each smoke prompt landed somewhere.

- **CLI flag vocabulary inherited from smoke script.** `--json` (machine-readable output to stdout; stderr stays for progress + TRACE_PATH marker), `--dry-run` (skip Anthropic + pre-flight; emit canonical happy-path), distinct exit codes (0 = OK / pipeline produced .hex, 1 = pre-flight fail, 2 = pipeline failed inside boundaries). Unit 6's `pipeline/cli.ts` adds `--prompt <text>` (or positional `--`-style) and `--repair=off` (disable cross-gate repair, useful for traces of clean failures). Unit 8's `tests/acceptance/run.ts` adds `--regen-fixtures`, `--tuning-only`, `--holdout-only`, `--json` (same payload shape).

- **Pre-flight checks: `/api/health` + `ANTHROPIC_API_KEY`.** Unit 6's CLI runs both before any LLM call (mirrors smoke script's pre-flight). Unit 8's acceptance runner runs both before iterating prompts. `/api/health` failure → exit 1 with stderr `"Compile API unreachable at <url>; run 'bun run compile:up' first"`. Missing API key → exit 1 with stderr `"ANTHROPIC_API_KEY is not set; export it before running 'bun run pipeline'"`. The CLI never logs the API key; the pre-flight only checks `non-empty`.

- **Regression-net 6-gate test (residual #29) lands as part of Unit 6's verification.** The integration test at `tests/pipeline.test.ts` runs `runPipeline("a robot that waves when something gets close")` against the live Compile API (gated by `VOLTEUX_COMPILE_SERVER_LIVE=1`), asserts ok-true outcome, asserts trace file written with all 6 gate-outcome events, asserts no `"unknown gate"` events, and asserts the `pipeline_summary` cost is non-zero and below $0.20 (cost ceiling sanity check). Without this test, the orchestrator's all-gates-wired guarantee is honor-system; with it, a regression that drops the rules gate (or any gate) fails CI as soon as the integration test runs.

- **No `bun run compile:up &` inside `bun test`.** The integration test is gated by `VOLTEUX_COMPILE_SERVER_LIVE=1` AND a `before` hook pings `/api/health`; if not reachable, the suite skips with a clear log line. Spinning up Docker inside the test runner would couple test isolation to docker-engine availability and add ~30s startup per `bun test` run.

## Open Questions

### Resolved During Planning

- **`PipelineFailureKind` literal set** → 8 literals: `"out-of-scope" | "schema-failed" | "compile-failed" | "rules-red" | "xconsist-failed" | "transport" | "truncated" | "aborted"` + `assertNeverPipelineFailureKind`. Justified per the decision matrix above.
- **Truncation retry policy (residual #20)** → surface as Honest Gap; no retry. The "retry once with `max_tokens: 32000`" alternative was considered and rejected (cost vs information gain tradeoff).
- **Cross-gate repair bound** → 1 attempt per `runPipeline` invocation, regardless of which gate fails or in which order. After 1 repair, the next failure routes to Honest Gap unconditionally.
- **`pipeline/honest-gap.ts` shape** → reuses `VolteuxHonestGap` from `schemas/document.zod.ts`. No new schema field; no new type definition. Per-kind `explanation` builders live as 8 small pure functions.
- **Trace event shape** → JSON-Lines; double-`pipeline_summary` (start + end) so partial traces are detectable; composite hashes via single-envelope JSON.stringify; SDK error scrubbing per the policy in Key Technical Decisions; scrub-misses surface as stderr WARN.
- **CostTracker rates** → committed per-model in `pipeline/cost.ts` top-of-file using current Anthropic public pricing for Sonnet 4.6 and Haiku 4.5. Compile API local cost is $0 in v0.1.
- **Acceptance scoring axes** → 3 axes (schema-validity, compile-pass, rules-clean). Behavior-correctness is v0.5 Wokwi; documented as missing axis in `tests/acceptance/run.ts` header.
- **Holdout split** → 5 of 30 prompts; partition enforced via per-file frontmatter `holdout: true|false`; runner refuses to print holdout in `--tuning-only`.
- **Smoke script disposition** → `scripts/v01-pipeline-io-smoke.ts` and `scripts/smoke-prompts/*.txt` are deleted in Unit 6's PR; the 5 prompts migrate to `tests/acceptance/prompts/archetype-1/tuning/` with appropriate frontmatter.
- **`__testing` namespace form for new modules (Unit 6 + Unit 7)** → both ship the namespace form directly, per the lazy-init learning's forward-going prescription. The LLM modules' standalone `_resetDefaultDepsForTest()` form is NOT migrated as part of this batch.
- **No schema change** → R6 invariant preserved; `VolteuxHonestGap` already exists; reuse, never redeclare.
- **Cross-consistency gate's `errors` discriminated-union refactor** → deferred to v0.5 (this batch does not need per-check sub-discriminators; the orchestrator only switches at the gate boundary, and Unit 6's repair-prompt construction handles the stringified shape).

### Deferred to Implementation

- **Exact wording of the 8 per-kind Honest Gap `explanation` strings.** The decision matrix above gives the *style* per kind ("Your idea needs <missing>, which v0 does not support."); the final beginner-readable copy lands during implementation against real failure outputs. Tests assert SHAPE (`scope`, `missing_capabilities` non-empty for `partial`/`out-of-scope`, `explanation` non-empty), not exact strings.
- **Whether the `prior_doc_summary` 200-char digest in the repair prompt should be the literal first 200 chars or a structured extract** (e.g., `{archetype_id, board.fqbn, components_count, libraries.length}`). Decision when first repair-prompt is written; the integration test's repair scenario will surface which form Sonnet treats best.
- **`--regen-fixtures` partial-failure behavior.** If the runner is mid-regen and one prompt fails, does it write the partial fixtures or roll back? Decision when implementing; lean toward write-what-passed + log failures, since the fixtures directory is committed via PR review anyway.

## Output Structure

```text
volteux/
├── pipeline/
│   ├── index.ts                                # NEW — buildPipeline(deps) + runPipeline(prompt, opts?) + PipelineFailureKind + assertNeverPipelineFailureKind
│   ├── cli.ts                                  # NEW — Bun CLI entry; --json, --dry-run, --repair=off; reads env at call time
│   ├── honest-gap.ts                           # NEW — formatHonestGap(failure, prompt) → VolteuxHonestGap
│   ├── repair.ts                               # NEW — cross-gate auto-repair; bounded ≤1 turn per runPipeline
│   ├── trace.ts                                # NEW — JSON-Lines writer; scrubSdkError; canonical-envelope hashes; __testing namespace
│   ├── cost.ts                                 # NEW — CostTracker + per-model rates
│   └── prompts/
│       └── repair-archetype-1.md               # NEW — version-controlled repair-prompt template
├── scripts/
│   ├── v01-pipeline-io-smoke.ts                # DELETE — replaced by pipeline/cli.ts
│   └── smoke-prompts/                          # DELETE — migrated into tests/acceptance/prompts/archetype-1/tuning/
├── tests/
│   ├── pipeline.test.ts                        # NEW — Unit 6 unit + integration tests; 6-gate regression test (residual #29)
│   ├── pipeline-defaults.test.ts               # NEW — defaultPipelineDeps() in-flight-Promise + reset; mirrors tests/llm/defaults.test.ts
│   ├── pipeline-exhaustiveness.test.ts         # NEW — sibling // @ts-expect-error for PipelineFailureKind
│   ├── honest-gap.test.ts                      # NEW — per-kind formatter shape tests
│   ├── repair.test.ts                          # NEW — bounded-repair tests; counter never exceeds 1
│   ├── trace.test.ts                           # NEW — JSON-Lines shape, scrub policy, canonical-envelope hash collision tests
│   ├── cost.test.ts                            # NEW — accumulator math tests
│   └── acceptance/
│       ├── run.ts                              # NEW (Unit 8) — CLI runner; --regen-fixtures, --tuning-only, --holdout-only, --json
│       ├── run.test.ts                         # NEW (Unit 8) — runner unit tests + holdout-print refusal test
│       └── prompts/
│           └── archetype-1/
│               ├── tuning/                     # 25 .txt files with frontmatter
│               │   ├── 01-distance-servo.txt   # MIGRATED from scripts/smoke-prompts/
│               │   ├── 02-pet-bowl.txt         # MIGRATED
│               │   ├── 03-wave-on-approach.txt # MIGRATED
│               │   ├── 04-doorbell-style.txt   # MIGRATED
│               │   ├── 05-misspelled.txt       # MIGRATED
│               │   ├── 06-…25-….txt            # 20 NEW (mix of in-scope variants + 4 explicit out-of-scope)
│               └── holdout/                    # 5 .txt files; sealed via frontmatter; never read by meta-harness
│                   └── h01-…h05-….txt
├── fixtures/
│   └── generated/
│       └── archetype-1/                        # Regenerated by Unit 8; committed; consumed by Talia's UI snapshots
│           └── *.json                          # one per tuning prompt
├── traces/                                     # gitignored; trace writer output (already in .gitignore)
├── docs/
│   └── plans/
│       └── 2026-04-27-001-feat-v01-pipeline-units-6-7-8-plan.md   # THIS FILE
└── package.json                                # MODIFY — add scripts: pipeline, acceptance, acceptance:regen
```

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Orchestrator end-to-end (Unit 6 + Unit 7 wiring)

```mermaid
sequenceDiagram
    participant CLI as pipeline/cli.ts
    participant Pipe as pipeline/index.ts (runPipeline)
    participant Trace as pipeline/trace.ts
    participant Cost as pipeline/cost.ts
    participant Cls as pipeline/llm/classify.ts
    participant Gen as pipeline/llm/generate.ts
    participant Schema as pipeline/gates/schema.ts
    participant XC as pipeline/gates/cross-consistency.ts
    participant Rules as pipeline/rules/index.ts
    participant Comp as pipeline/gates/compile.ts
    participant Repair as pipeline/repair.ts
    participant HG as pipeline/honest-gap.ts

    CLI->>Pipe: runPipeline(prompt, {signal})
    Pipe->>Trace: open(run_id) + emit pipeline_summary(start)
    Pipe->>Cls: classify(prompt)
    Cls-->>Pipe: ClassifyResult
    Pipe->>Trace: emit llm_call(classify, usage)
    Pipe->>Cost: track(classify.usage, "haiku-4-5")
    Note over Pipe: archetype_id !== "uno-ultrasonic-servo" OR confidence < 0.6 OR null → out-of-scope
    Pipe->>HG: formatHonestGap({kind:"out-of-scope"}, prompt)
    Pipe->>Trace: emit honest_gap(scope, missing_capabilities, explanation)
    Pipe->>Trace: emit pipeline_summary(end, outcome="out-of-scope", cost_usd)
    Pipe-->>CLI: {ok: false, kind:"out-of-scope", honest_gap}

    rect rgb(240,240,240)
        Note over Pipe: in-scope path
        Pipe->>Gen: generate(prompt)
        Gen-->>Pipe: GenerateResult
        Pipe->>Trace: emit llm_call(generate, usage)
        Pipe->>Cost: track(generate.usage, "sonnet-4-6")
        Pipe->>Schema: runSchemaGate(doc)
        Pipe->>Trace: emit gate_outcome(schema, ok)
        Pipe->>XC: runCrossConsistencyGate(doc)
        Pipe->>Trace: emit gate_outcome(xconsist, ok)
        Pipe->>Rules: runRules(doc)
        Pipe->>Trace: emit gate_outcome(rules, red_count)
        Pipe->>Comp: runCompileGate({fqbn, sketch_main_ino, additional_files, libraries})
        Pipe->>Trace: emit compile_call(latency_ms, cache_hit, hex_size)
    end

    alt any gate failed AND repair_count == 0
        Pipe->>Repair: repair(failure, doc, prompt, generate)
        Repair->>Gen: generate(prompt + repair user turn)
        Gen-->>Repair: GenerateResult
        Repair->>Trace: emit repair_attempt(gate_kind, before/after summary)
        Repair-->>Pipe: new doc OR fall-through
        Note over Pipe: re-run gates from schema → compile
    end

    alt success
        Pipe->>Trace: emit pipeline_summary(end, outcome="ok", cost_usd, total_latency_ms)
        Pipe-->>CLI: {ok: true, doc, hex_b64, cost_usd, run_id}
    else final failure
        Pipe->>HG: formatHonestGap(failure, prompt)
        Pipe->>Trace: emit honest_gap(...)
        Pipe->>Trace: emit pipeline_summary(end, outcome=failure.kind, cost_usd)
        Pipe-->>CLI: {ok: false, kind, honest_gap, cost_usd, run_id}
    end
```

### `runPipeline` decision flow (Unit 6)

```text
runPipeline(prompt, opts):
  validate prompt (empty / >5000 chars → throw — IS the contract)
  open trace; emit pipeline_summary(start); cost = new CostTracker()
  classify_result = await classify(prompt)
  cost.track(classify_result.usage, "haiku-4-5"); trace.llm_call(classify_result)
  if !classify_result.ok → return failure({kind: "transport"|"sdk-error"|"abort"|"schema-failed" → mapped to "transport" or "schema-failed" or "aborted"})
  if classify_result.archetype_id === null OR archetype_id !== "uno-ultrasonic-servo" OR confidence < 0.6
    → return failure({kind: "out-of-scope", reason: classify_result.reasoning})

  attempt = 0
  current_prompt_messages = [{ role: "user", content: prompt }]
  loop while attempt ≤ 1:
    gen_result = await generate(prompt) if attempt == 0
                else await generateWithRepair(prompt, prior_doc, repair_context)
    cost.track(gen_result.usage, "sonnet-4-6"); trace.llm_call(gen_result)
    if !gen_result.ok → return failure(map kind → PipelineFailureKind)
    doc = gen_result.doc

    schema_result = runSchemaGate(doc); trace.gate_outcome("schema", schema_result)
    if !schema_result.ok and attempt == 0 → repair_context = {kind:"schema-failed"}; attempt++; continue
    if !schema_result.ok → return failure({kind: "schema-failed"})

    xc_result = runCrossConsistencyGate(doc); trace.gate_outcome("xconsist", xc_result)
    if !xc_result.ok and attempt == 0 → repair_context = {kind:"xconsist-failed", errors: xc_result.errors}; attempt++; continue
    if !xc_result.ok → return failure({kind: "xconsist-failed"})

    rules_outcome = runRules(doc); trace.gate_outcome("rules", rules_outcome.red.length)
    if rules_outcome.red.length > 0 and attempt == 0 → repair_context = {kind:"rules-red", red: rules_outcome.red}; attempt++; continue
    if rules_outcome.red.length > 0 → return failure({kind: "rules-red"})

    compile_result = await runCompileGate({fqbn, sketch_main_ino, additional_files, libraries})
    trace.compile_call(compile_result)
    if !compile_result.ok:
      compile_kind = compile_result.kind
      if compile_kind === "compile-error" and attempt == 0 → repair_context = {kind:"compile-failed", stderr: compile_result.errors}; attempt++; continue
      if compile_kind === "compile-error" → return failure({kind: "compile-failed"})
      → return failure({kind: "transport"})  // auth/timeout/queue-full/rate-limit/bad-request all roll up

    return success({doc, hex_b64: compile_result.value.hex_b64, amber: rules_outcome.amber, blue: rules_outcome.blue, cost_usd: cost.total(), run_id})
  end loop
  // unreachable — both attempts handle all gate-failure paths
```

### Trace event schema (Unit 7)

```text
{ts: "2026-04-27T10:23:45.123Z", run_id: "<run-id>", event: "pipeline_summary",
  prompt: "<verbatim user prompt>", prompt_sha256: "<hex>",
  prompt_version_hash: "<sha256 of canonical envelope>",
  git_sha: "<short hash>", started_at: "<ts>"}

{ts, run_id, event: "llm_call", model: "claude-sonnet-4-6"|"claude-haiku-4-5",
  attempt: 1|2, usage: {input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens},
  outcome: "ok"|"schema-failed"|"truncated"|"transport"|"sdk-error"|"abort", latency_ms}

{ts, run_id, event: "gate_outcome", gate: "schema"|"xconsist"|"rules",
  ok: boolean, errors_count: number, red_count?: number, amber_count?: number, blue_count?: number}

{ts, run_id, event: "compile_call", ok: boolean, kind?: CompileGateFailureKind,
  cache_hit: boolean, hex_size_bytes: number, latency_ms: number,
  toolchain_version_hash: string, errors_count?: number}

{ts, run_id, event: "honest_gap", scope: "full"|"partial"|"out-of-scope",
  missing_capabilities: ["..."], explanation: "...", trigger_kind: PipelineFailureKind}

{ts, run_id, event: "repair_attempt", trigger_kind: PipelineFailureKind,
  prior_doc_digest: "<200-char>", repair_prompt_sha256: "<hex>", outcome: "ok"|"failed"}

{ts, run_id, event: "pipeline_summary", outcome: "ok"|PipelineFailureKind,
  cost_usd: number, total_latency_ms: number, ended_at: "<ts>"}
```

## Implementation Units

- [ ] **Unit 6: Orchestrator + CLI + Honest Gap + cross-gate auto-repair**

**Goal:** Ship `pipeline/index.ts` with `buildPipeline(deps)` + `runPipeline(prompt, opts?)` and an 8-literal `PipelineFailureKind` discriminated union with `assertNeverPipelineFailureKind` exhaustiveness guard. Ship `pipeline/cli.ts` Bun entry inheriting smoke-script flag vocabulary. Ship `pipeline/honest-gap.ts` formatter producing `VolteuxHonestGap` shape from any failure kind. Ship `pipeline/repair.ts` cross-gate repair helper bounded to ≤1 attempt per `runPipeline` invocation. Delete `scripts/v01-pipeline-io-smoke.ts` and `scripts/smoke-prompts/`.

**Requirements:** R1, R3, R4, residual #20, residual #29.

**Dependencies:** PR #1 + PR #2 + PR #3 (all shipped). Independent of Units 7 and 8 within this batch BUT Unit 7's `TraceWriter` interface is consumed by Unit 6 — recommend landing Unit 7's `pipeline/trace.ts` shape stub (interface + no-op writer) early in Unit 6's PR or in a tiny shared commit so the orchestrator's deps shape is final from the start. Pragmatic landing order: Unit 6 ships with `TraceWriter = NoopTraceWriter` injected as the production default; Unit 7's PR swaps `defaultPipelineDeps()` to use the real writer.

**Files:**
- Create: `pipeline/index.ts` — exports `PipelineFailureKind` literal-union type, `PipelineResult` discriminated union, `PipelineDeps` interface, `buildPipeline(deps): (prompt, opts?) => Promise<PipelineResult>` factory, `runPipeline(prompt, opts?)` convenience, `defaultPipelineDeps()` lazy in-flight-Promise factory, `__testing.resetDefaultPipelineDeps()` reset, and `assertNeverPipelineFailureKind(kind: never): never` exhaustiveness guard. **Discriminated failure kinds (Files entry, not buried in Approach):**
  - `"out-of-scope"` — classifier returned `null`, `confidence < 0.6`, or non-archetype-1 ID. Routes to Honest Gap with `scope: "out-of-scope"`.
  - `"schema-failed"` — `generate()` returned `kind: "schema-failed"` after its 2-call local repair. No further repair.
  - `"compile-failed"` — `runCompileGate` returned `kind: "compile-error"`. Cross-gate `repair()` worth one turn.
  - `"rules-red"` — `runRules(doc).red.length > 0`. Cross-gate `repair()` worth one turn.
  - `"xconsist-failed"` — `runCrossConsistencyGate(doc)` returned `{ok: false}`. Cross-gate `repair()` worth one turn.
  - `"transport"` — any infra failure (network, Compile API unreachable, all `compile.kind ∈ {auth,bad-request,rate-limit,queue-full,timeout,transport}`, `generate.kind === "transport"|"sdk-error"`, `classify.kind === "transport"|"sdk-error"`). No retry.
  - `"truncated"` — `generate()` returned `kind: "truncated"`. No retry; surfaces as Honest Gap.
  - `"aborted"` — `AbortSignal` fired (caller cancelled). No retry; differentiated explanation.
- Create: `pipeline/cli.ts` — Bun CLI entry. Accepts `--prompt <text>` or positional argument; `--json` (machine-readable stdout); `--dry-run` (skip Anthropic + pre-flight; emit canonical happy-path); `--repair=off` (disable cross-gate repair). Reads `ANTHROPIC_API_KEY` and `COMPILE_API_URL` at call time. Stdout = payload (table or JSON); stderr = progress + `TRACE_PATH=<path>` deterministic marker + pre-flight error messages. Exit codes: 0 = OK (pipeline produced .hex), 1 = pre-flight failed, 2 = pipeline failed inside boundaries. **No global state; no module-load throw.**
- Create: `pipeline/honest-gap.ts` — exports `formatHonestGap(failure: PipelineFailure, prompt: string): VolteuxHonestGap`. Returns the schema's `{scope, missing_capabilities, explanation}` shape verbatim. 8 per-kind explanation builders as small pure functions. Each builder takes the failure context (e.g., the `stderr` for `compile-failed`, the rule name for `rules-red`) and produces a beginner-readable explanation.
- Create: `pipeline/repair.ts` — exports `repair(failure: PipelineFailure, prior_doc: VolteuxProjectDocument, prompt: string, gen: (prompt: string, opts?) => Promise<GenerateResult>): Promise<GenerateResult>`. Composes a fresh user turn carrying `{prior_doc_summary, gate_kind, errors}` + the `pipeline/prompts/repair-archetype-1.md` template. Bounded by the orchestrator's per-run counter, not by internal state.
- Create: `pipeline/prompts/repair-archetype-1.md` — version-controlled repair-prompt template. Same meta-harness header comment as `archetype-1-system.md`. Contains the per-gate repair instruction stems (4: schema, xconsist, rules, compile) that the runtime fills with structured error data.
- Create: `tests/pipeline.test.ts` — `buildPipeline(mockDeps)` unit tests + gated 6-gate integration test (residual #29).
- Create: `tests/pipeline-defaults.test.ts` — three test shapes for `defaultPipelineDeps()` (object-identity, sync-promise-reference, reset) per the lazy-init learning.
- Create: `tests/pipeline-exhaustiveness.test.ts` — `// @ts-expect-error` switch test for `PipelineFailureKind`.
- Create: `tests/honest-gap.test.ts` — per-kind formatter shape tests; assert non-empty `explanation`, correct `scope`, non-empty `missing_capabilities` for `partial`/`out-of-scope`.
- Create: `tests/repair.test.ts` — bounded-repair tests; assert counter never exceeds 1; assert second-failure-after-repair routes to Honest Gap unconditionally.
- Modify: `package.json` — add `"pipeline": "bun pipeline/cli.ts"`. **Remove** `"smoke"` script.
- Delete: `scripts/v01-pipeline-io-smoke.ts`, `scripts/smoke-prompts/01-distance-servo.txt` ... `05-misspelled.txt`.

**Approach:**
- The orchestrator's `runPipeline` follows the decision flow in High-Level Technical Design verbatim. Per-run state: `repair_count = 0`, `cost_tracker`, `trace_writer`, `prior_doc?`. After a repair, the gate sequence (schema → xconsist → rules → compile) re-runs against the new doc; the counter prevents a second repair.
- `defaultPipelineDeps()` reuses `defaultGenerateDeps()` and `defaultClassifyDeps()` rather than constructing fresh Anthropic clients. Inherits the in-flight-Promise discipline transitively. Exposes `__testing.resetDefaultPipelineDeps()` which resets ONLY this module's slot — does NOT recursively reset the LLM modules' slots (those have their own resets).
- `pipeline/honest-gap.ts` is pure: no I/O, no async, no env reads. Each per-kind builder is a small function `buildExplanationForX(failure: PipelineFailure & {kind: "x"}, prompt: string): string` and the dispatcher is a single switch with `assertNeverPipelineFailureKind` as the default.
- `pipeline/repair.ts` is composition over recursion: takes a `gen` function injected by the orchestrator (so tests can inject mocks); never imports `pipeline/llm/generate.ts` directly. Bound enforcement lives in the orchestrator, not in `repair.ts`.
- The CLI is small (~80 LOC). Pre-flight checks reuse the smoke-script's `preflightHealthCheck` and `preflightApiKeyCheck` shape (copy them into `pipeline/cli.ts` with attribution comment; do not re-export from the about-to-be-deleted smoke script).

**Patterns to follow:**
- `pipeline/llm/generate.ts` — `buildGenerator(deps)` factory + lazy-init in-flight-Promise.
- `pipeline/llm/classify.ts` — `assertNeverClassifyFailureKind` exhaustiveness guard placement and JSDoc.
- `infra/server/cache.ts` — `__testing` namespace form for test-only resets.
- `pipeline/gates/compile.ts` — `CompileGateFailureKind` discriminated union shape; never throw on infra failure (return `{ok: false, kind, ...}` always).
- `docs/solutions/logic-errors/lazy-init-singleton-in-flight-promise-bun-test-isolation-2026-04-26.md` — `defaultPipelineDeps()` MUST follow the in-flight-Promise pattern + namespace-form test reset.
- `docs/solutions/best-practices/c-preprocessor-modelling-in-llm-output-gates-2026-04-25.md` — gate-wrapping discipline; the repair-prompt construction must replicate the schema/registry primer that `generate()` uses, never a divergent description.

**Test scenarios:**
- *Happy path (mocked)* — `buildPipeline(mockDeps)` with classify→sonnet-archetype-1, generate→canonical-fixture-shape, all gates pass, compile→`{ok: true, hex_b64}`. Assert `{ok: true, doc, hex_b64, cost_usd, run_id}` and trace contains 1× `llm_call`(haiku) + 1× `llm_call`(sonnet) + 4× `gate_outcome` + 1× `compile_call` + 2× `pipeline_summary` (start + end).
- *Happy path (mocked, with repair)* — first generate produces a doc that fails compile-error; repair turn produces a doc that passes; assert `repair_attempt` event in trace, `repair_count` reaches 1 and stops.
- *Edge case (out-of-scope)* — classify returns `archetype_id: null, confidence: 0.95`. Pipeline returns `{ok: false, kind: "out-of-scope", honest_gap: {scope: "out-of-scope", explanation, missing_capabilities}}`. No `generate()` call attempted (mock asserts zero invocations).
- *Edge case (low confidence)* — classify returns `archetype_id: "uno-ultrasonic-servo", confidence: 0.45`. Routes same as `out-of-scope`. No generate call.
- *Edge case (wrong archetype)* — classify returns `archetype_id: "esp32-audio-dashboard", confidence: 0.92`. Routes to `out-of-scope`; explanation names archetype-2 as v1.5.
- *Error path (mocked, schema-failed)* — generate returns `kind: "schema-failed"` after its own 2-call retry. Pipeline returns `{ok: false, kind: "schema-failed"}`. **NO cross-gate repair** (generate already retried).
- *Error path (mocked, compile-failed → repair)* — first compile returns `kind: "compile-error"`; repair fires; second generate produces a fix; second compile passes; assert `{ok: true}` and `trace.repair_attempt.outcome === "ok"`.
- *Error path (mocked, compile-failed → repair fails)* — first compile fails; repair fires; second compile also fails; assert `{ok: false, kind: "compile-failed"}` and `repair_count === 1` (no infinite loop).
- *Error path (mocked, rules-red → repair)* — first rules outcome has 1 red; repair fires; second outcome clean; assert ok.
- *Error path (mocked, transport)* — classify returns `kind: "transport"`. Routes to `{kind: "transport"}` Honest Gap. No generate call. Assert distinct explanation from `out-of-scope`.
- *Error path (mocked, truncated)* — generate returns `kind: "truncated"`. Routes to `{kind: "truncated"}` Honest Gap. No retry.
- *Error path (mocked, aborted)* — caller passes pre-fired AbortSignal; classify aborts. Routes to `{kind: "aborted"}` Honest Gap with cancellation explanation.
- *Edge case (input validation)* — `runPipeline("")` throws synchronously (mirrors generate/classify); no API call attempted.
- *Edge case (DI deps override)* — `buildPipeline({...mockDeps, generate: alternateGen})` uses the override. Production callers via `runPipeline` see defaults.
- *Exhaustiveness guard* — `tests/pipeline-exhaustiveness.test.ts` adds a non-existent literal to a sibling switch; tsc must fail with `// @ts-expect-error`.
- *Lazy-init contract* — three tests at `tests/pipeline-defaults.test.ts`: object-identity dedup under `Promise.all([def(), def()])`, sync-promise-reference (`first === second` from two synchronous calls), reset evicts.
- *Integration (gated by VOLTEUX_COMPILE_SERVER_LIVE=1 + ANTHROPIC_API_KEY) — 6-gate regression net (closes residual #29)* — `runPipeline("a robot that waves when something gets close")` against live Compile API; assert `ok: true`, trace file written, exactly 4 `gate_outcome` events (schema, xconsist, rules) + 1 `compile_call` + 2 `llm_call` + 2 `pipeline_summary`; assert `cost_usd > 0` AND `cost_usd < 0.20`.
- *Integration (gated, repair end-to-end)* — uses a deliberate prompt that triggers compile-error; assert `repair_attempt` fires once, second compile is cache-hit (toolchain hash unchanged), final outcome ok or compile-failed (deterministic with model variation noted).
- *CLI (mocked stdio)* — `--dry-run` produces canonical-happy-path JSON to stdout, `TRACE_PATH=<path>` to stderr, exit 0. `--json` against a known mocked outcome produces the agreed payload shape.

**Verification:**
- `bun test tests/pipeline.test.ts tests/pipeline-defaults.test.ts tests/pipeline-exhaustiveness.test.ts tests/honest-gap.test.ts tests/repair.test.ts` is green.
- Integration test passes against `bun run compile:up &` + a real `ANTHROPIC_API_KEY`.
- `bun run pipeline -- "a robot that waves when something gets close"` produces a `VolteuxProjectDocument` summary on stdout + `TRACE_PATH=...` on stderr + exit 0.
- `bun run pipeline -- --json -- "<known out-of-scope prompt>"` produces a JSON envelope `{ok: false, kind: "out-of-scope", honest_gap: {...}, cost_usd, run_id}` and exit 2.
- Smoke script and `scripts/smoke-prompts/` are deleted from the tree; `bun run smoke` no longer exists in `package.json`. `git log --diff-filter=D --name-only` confirms.
- `tsc --noEmit --strict` is clean; the exhaustiveness guard test fails compile if a literal is missing from any switch.

---

- [ ] **Unit 7: JSON-Lines trace writer + cost tracker + observability**

**Goal:** Ship `pipeline/trace.ts` with a `TraceWriter` interface + `defaultTraceWriter` factory + canonical-envelope hash helpers + SDK-error scrub policy + scrub-miss surfacing. Ship `pipeline/cost.ts` with `CostTracker` and committed per-model rates. Wire both into `pipeline/index.ts`'s `defaultPipelineDeps()` (Unit 6 may have shipped with `NoopTraceWriter`; this unit's PR swaps in the real writer).

**Requirements:** R7, residual #18.

**Dependencies:** Unit 6 (consumes `TraceWriter` interface; the PR can land first with `NoopTraceWriter` and Unit 7 swaps it). Independent of Unit 8.

**Files:**
- Create: `pipeline/trace.ts` — exports `TraceWriter` interface (`{open(run_id), emit(event), close()}`), `NoopTraceWriter`, `defaultTraceWriter(opts?)` factory, `computePromptVersionHash({...inputs}): string` helper, `scrubSdkError(message: string): {clean: string, miss: boolean}` helper, `__testing.resetDefaults()` reset. **No discriminated failure-kind union** — the writer is best-effort: file-write failures are caught and emit a stderr WARN (matches smoke script's trace-write try/catch pattern; never crashes the orchestrator).
- Create: `pipeline/cost.ts` — exports `CostTracker` class (`track(usage, model)`, `total(): number`, `breakdown(): {sonnet, haiku, compile}`), per-model rate constants, `__testing.snapshotRates()` for test verification.
- Create: `tests/trace.test.ts` — covers JSON-Lines shape, scrub policy, canonical-envelope hash collision tests (NUL-byte injection per the sha256 learning's prevention #3), scrub-miss WARN surfacing, double-`pipeline_summary` shape on partial-write.
- Create: `tests/cost.test.ts` — accumulator math tests; per-model rate snapshot test.
- Modify: `pipeline/index.ts` — `defaultPipelineDeps()` switches `traceWriter: NoopTraceWriter` to `traceWriter: defaultTraceWriter()`. The mock-deps shape in tests stays `NoopTraceWriter` so unit tests don't write real files.
- Modify: `.gitignore` — already has `traces/`; verify and document inline if any new artifact directory is needed.

**Approach:**
- `TraceWriter` interface: `{open(run_id: string): Promise<void>; emit(event: TraceEvent): Promise<void>; close(): Promise<void>}`. `defaultTraceWriter` opens `traces/<run-id>.jsonl` with `{ flag: "a" }` (append-only) and flushes per-emit (each `emit` is one `write` call — JSON-Lines is line-oriented and small, so per-line flushing avoids partial events on crash).
- `TraceEvent` is a discriminated union over the 6 event kinds in High-Level Technical Design § Trace event schema. Each kind has its own type; the writer's `emit` is generic over the union.
- `computePromptVersionHash` builds the canonical envelope `JSON.stringify({archetype_id, system_prompt_source_sha256, schema_primer_sha256, fewshot_source_sha256_or_null, repair_prompt_sha256, model, max_tokens})` and runs `createHash("sha256").update(canonical).digest("hex").slice(0, 16)`. Single `JSON.stringify`, single `update` — never separator-byte concat.
- `scrubSdkError` returns `{clean, miss: boolean}`. The `miss` flag is true when the cleaned string still contains a regex match for any sensitive shape (`^sk-ant-api03-` substring, `Bearer [A-Za-z0-9...]{20,}`, or a JSON `"messages":` block). The trace writer's `emit` checks `miss` and writes a stderr WARN line + writes the event with `<scrub-miss-detected>` placeholder for the impacted field.
- `CostTracker.track(usage, model)` accumulates costs internally. Per-model rates table is committed in source; a `breakdown()` accessor returns `{sonnet, haiku, compile}` cents-precision sub-totals for the trace's `pipeline_summary` event.
- Trace-write failures (`Bun.write` reject, `mkdir` failure) are caught at the `defaultTraceWriter`'s `emit` boundary; the writer logs `[trace] WARN: write to <path> failed: <message>` on stderr and continues — the orchestrator never sees the failure as a return value, mirroring the smoke script's discipline.

**Patterns to follow:**
- `infra/server/cache.ts` — single-envelope `JSON.stringify` for SHA-256 input; `__testing.resetMemoizedHash()` namespace form.
- `pipeline/llm/sdk-helpers.ts` `extractMessage` — pure string extraction; the scrub function operates on its output.
- `scripts/v01-pipeline-io-smoke.ts` `writeTraceFile` boundary — try/catch at the writer, log on failure, never propagate.
- `docs/solutions/security-issues/sha256-cache-key-canonical-json-serialization-2026-04-26.md` — required reading; canonical-envelope rule + NUL-byte injection test matrix.

**Test scenarios:**
- *Happy path* — `defaultTraceWriter` writes one JSON object per line; the file ends with `\n`; reading the file with `JSON.parse` line-by-line succeeds.
- *Happy path (start + end summary)* — open(run_id) writes `pipeline_summary(start)`; close() writes `pipeline_summary(end)`; the file has exactly two `pipeline_summary` events with matching `run_id`.
- *Edge case (partial write)* — open + 2 events + abrupt process kill; the file has start `pipeline_summary` + 2 events; the eval harness can detect missing end-event.
- *Edge case (canonical-envelope hash collision matrix)* — `computePromptVersionHash` with NUL injected into each input field independently produces distinct hashes (`fqbn = "...\0X"` vs `model = "X"` etc., for each user-controlled string field); mirror the cache-key test matrix from the sha256 learning.
- *Edge case (scrub: API key)* — `scrubSdkError("APIError: 401 {\"key\":\"sk-ant-api03-AAAAAA...XXXXXX\"}")` returns `{clean: "...<redacted-anthropic-key>...", miss: false}`.
- *Edge case (scrub: Bearer token)* — `scrubSdkError("...Authorization: Bearer abc123def456ghi789jkl0...")` redacts.
- *Edge case (scrub: HTTP request body fragment)* — `scrubSdkError("APIError: 400 {\"messages\":[{\"role\":\"user\",\"content\":\"sensitive prompt\"}]}")` redacts the messages block.
- *Error path (scrub miss)* — `scrubSdkError("sk-XX-newer-prefix-not-in-regex")` returns `{clean, miss: true}`; writer emits stderr WARN AND writes `<scrub-miss-detected>` placeholder.
- *Error path (trace write fail)* — `defaultTraceWriter` with a write-only-disabled path; assert WARN on stderr and orchestrator continues.
- *Edge case (cost: cache hit)* — `track({input_tokens: 100, output_tokens: 50, cache_creation: 0, cache_read: 1000}, "sonnet-4-6")` accumulates `100*$3/MTok + 50*$15/MTok + 1000*$0.30/MTok`.
- *Edge case (cost: cache miss + creation)* — `track({input_tokens: 1500, output_tokens: 200, cache_creation: 3000, cache_read: 0}, "sonnet-4-6")` accumulates correctly.
- *Edge case (cost: zero usage)* — `track({input_tokens: 0, output_tokens: 0, cache_creation: 0, cache_read: 0}, "haiku-4-5")` accumulates 0.
- *Lazy-init contract* — `defaultTraceWriter` (if it has any module-level state) follows the in-flight-Promise pattern. If purely stateless (likely), document the absence of state in the file header.
- *Integration (gated)* — full `runPipeline()` run produces a trace file under `traces/`; reading it back parses; the `pipeline_summary.cost_usd` matches `CostTracker.total()`.

**Verification:**
- `bun test tests/trace.test.ts tests/cost.test.ts` is green.
- A trace file written by an integration run is valid JSON-Lines (each line parses; final line is `pipeline_summary` end-event).
- A trace file from a deliberately-killed run (kill -9 mid-pipeline) has the start `pipeline_summary` but no end-event; the eval harness can detect this gap.
- `bun run pipeline -- "<prompt>"` writes a trace; the trace contains no API-key or Bearer-token literal substring (test-driven by injecting a synthetic SDK error in mocked mode and asserting the persisted bytes are scrubbed).
- `tsc --noEmit --strict` is clean.

---

- [ ] **Unit 8: Acceptance harness + 30-prompt calibration set + `fixtures/generated/`**

**Goal:** Ship `tests/acceptance/run.ts` CLI runner with 3-axis scoring and frontmatter-enforced holdout discipline. Author 30 archetype-1 prompts (25 tuning + 5 sealed holdout) each with frontmatter declaring `holdout`, `expected_kind`, `expected_archetype`. Generate `fixtures/generated/archetype-1/*.json` via `bun run acceptance --regen-fixtures` for Talia's UI snapshot consumption. Document v0.5 Wokwi 4th-axis as the explicitly-missing scoring axis.

**Requirements:** R1 (acceptance gate), R3 (out-of-scope routing verification), R7 (trace events from acceptance runs feed the eval harness in v0.5).

**Dependencies:** Unit 6 (consumes `runPipeline`). Unit 7 (consumes `TraceWriter` for per-prompt traces). Both must land before Unit 8's PR. Unit 8 can land in parallel with Unit 7 if Unit 7's `TraceWriter` interface stub is committed early.

**Files:**
- Create: `tests/acceptance/run.ts` — CLI runner. Iterates `tests/acceptance/prompts/archetype-1/{tuning,holdout}/*.txt`; per prompt: parse frontmatter; run `runPipeline(prompt)`; score 3 axes; compare `expected_kind`/`expected_archetype` against actual outcome; aggregate. Flags: `--json` (machine-readable), `--tuning-only`, `--holdout-only`, `--regen-fixtures` (writes `fixtures/generated/archetype-1/*.json` for tuning prompts only). Exit codes: 0 = gates pass, 1 = pre-flight fail, 2 = gates fail. **No discriminated failure-kind union for the runner** — it's a top-level CLI; failures within a single prompt's pipeline run are already discriminated by `PipelineFailureKind`; the runner aggregates them into `{schema_validity, compile_pass, rules_clean, expected_match}` per-prompt scores plus a final aggregate.
- Create: `tests/acceptance/run.test.ts` — runner unit tests; the holdout-print refusal test; per-axis scoring tests.
- Create: `tests/acceptance/prompts/archetype-1/tuning/*.txt` — 25 prompts with frontmatter. 5 migrate from `scripts/smoke-prompts/`; 20 are NEW. Mix:
  - **In-scope variants (≥17):** "robot that waves when something gets close", "distance-triggered servo arm", "pet bowl proximity sensor", "doorbell that moves a flag", "automated greeting wave", "object detector with motion response", figurative-language variants ("I want my dog to set off a flag when she gets near her bowl"), beginner-typo variants ("a robut that wavs wen sumthing gets close"), educational re-wordings ("teach my Arduino to detect distance and react"), additional plausible homework framings. Each carries `expected_kind: ok`, `expected_archetype: uno-ultrasonic-servo`.
  - **In-scope edge (1-2):** prompts that will produce LARGE sketches (lots of Serial.println, multiple servo positions); good for triggering `truncated` exploration. `expected_kind: ok` (these should still pass; truncation is a residual risk being measured).
  - **Out-of-scope (≥6):** "a scale that weighs my packages" (load cell), "control my house lights from my phone" (mains voltage / smart home), "a temperature display that texts me" (archetype 4 = v1.5), "play music when motion is detected" (audio = archetype 2), "RGB strip that pulses with the music" (NeoPixel = archetype 5), "an OLED menu I can scroll through" (archetype 3 = v1.5). Each carries `expected_kind: out-of-scope`, `expected_archetype: null`.
- Create: `tests/acceptance/prompts/archetype-1/holdout/*.txt` — 5 SEALED prompts; frontmatter `holdout: true` plus a 1-line freeze comment. Mix: 3 in-scope (1 typo, 1 figurative, 1 plain), 2 out-of-scope (1 obvious, 1 borderline-tempting like "an automated waterer for my plant" which is HX711-adjacent).
- Create: `fixtures/generated/archetype-1/.gitkeep` — directory placeholder; populated by `bun run acceptance --regen-fixtures`.
- Create: `tests/acceptance/run.test.ts` — runner unit tests.
- Modify: `package.json` — add `"acceptance": "bun tests/acceptance/run.ts"` and `"acceptance:regen": "bun tests/acceptance/run.ts --regen-fixtures --tuning-only"`.

**Approach:**
- Frontmatter parser is small (~30 LOC): expects `--- key: value\nkey: value\n--- ` followed by prompt body. Strict — any malformed frontmatter is a runner-level fail-loud (not a per-prompt outcome).
- Scoring per prompt: run `runPipeline(prompt)`; record `{prompt_filename, expected_kind, expected_archetype, actual_kind, actual_archetype, schema_validity, compile_pass, rules_clean, cost_usd, latency_ms, trace_path}`. Aggregate over tuning: `{schema_validity_rate, compile_pass_rate, rules_clean_rate, expected_match_rate}`. Holdout aggregation is separate: `{passed (schema-valid AND compile-pass): N/5, expected_match_rate}`.
- Acceptance gate logic: `schema_validity_rate >= 0.99 AND compile_pass_rate >= 0.95 AND rules_clean_rate >= 0.90` on tuning AND `holdout_passed >= 1` on the 5 holdout prompts. Exit 2 on gate fail; exit 0 on pass.
- `--regen-fixtures` mode: for each tuning prompt where `runPipeline().ok === true`, write `fixtures/generated/archetype-1/${filename_without_ext}.json` containing the `doc` (NOT the `hex_b64`; the hex is too large for fixtures and Talia doesn't need it). Holdout prompts are NEVER regenerated (preserves seal). On any tuning prompt where `runPipeline` returns `{ok: false}`, the runner logs but does NOT write the fixture — the failed prompt's prior fixture (if present) stays put; the PR review surfaces the gap.
- Holdout-print refusal: in `--tuning-only` mode AND in `--regen-fixtures` mode, the runner asserts `holdout: false` for every prompt it processes; any holdout-frontmatter prompt encountered triggers a runner-level error "holdout discipline violation: encountered holdout=true prompt in tuning-only run". The unit test ships a synthetic holdout prompt placed in the tuning directory (under a temp test fixture) and asserts the runner errors.
- Trace files from acceptance runs land at `traces/acceptance-<run-id>/<prompt-filename>.jsonl` (one trace per prompt). The directory naming distinguishes them from CLI runs for downstream eval-harness consumption.

**Patterns to follow:**
- `pipeline/cli.ts` (Unit 6) — flag vocabulary, exit codes, stdout/stderr discipline.
- `scripts/v01-pipeline-io-smoke.ts` — sequential per-prompt loop (no `Promise.all`); pre-flight checks.
- `docs/solutions/best-practices/c-preprocessor-modelling-in-llm-output-gates-2026-04-25.md` — calibration prompts must replicate the C-preprocessor-equivalent semantics of what the LLM will actually receive; out-of-scope prompts must trigger out-of-scope routing without depending on a brittle keyword that the system prompt could later strip.

**Test scenarios:**
- *Happy path (mocked)* — runner with mocked `runPipeline` always returning `ok: true`; assert aggregate scores 100% on all 3 axes; exit 0.
- *Happy path (real frontmatter parser)* — feed a sample prompt file `--- holdout: false\nexpected_kind: ok\nexpected_archetype: uno-ultrasonic-servo\n---\na robot that waves when something gets close` and assert the parsed object.
- *Edge case (frontmatter malformed)* — missing `---` close → runner exits 1 with stderr message naming the file.
- *Edge case (frontmatter unknown key)* — `expected_kink: ok` (typo) → runner errors at parse time.
- *Edge case (holdout-print refusal in --tuning-only)* — synthetic holdout prompt placed into tuning dir for the test → runner errors with "holdout discipline violation".
- *Edge case (holdout-print refusal in --regen-fixtures)* — same synthetic case; assert the regen mode also refuses.
- *Error path (pre-flight)* — Compile API down → exit 1 BEFORE iterating any prompt.
- *Error path (one prompt fails compile)* — mocked one-of-25 prompts returns `compile-failed`; aggregate `compile_pass_rate = 24/25 = 0.96` (passes 0.95); exit 0.
- *Error path (gate fail: schema-validity below threshold)* — mocked 2-of-25 prompts return schema-failed; aggregate `schema_validity_rate = 23/25 = 0.92` (fails 0.99); exit 2; stderr names the failing axis.
- *Error path (gate fail: holdout 0/5)* — mocked all 5 holdout return `compile-failed`; exit 2; stderr "holdout 0/5 — gate requires ≥1".
- *Edge case (fixture regen on success)* — `--regen-fixtures --tuning-only` with all-success mock; assert 25 JSON files written under `fixtures/generated/archetype-1/`; assert each file is valid `VolteuxProjectDocumentSchema` parse.
- *Edge case (fixture regen on partial failure)* — `--regen-fixtures --tuning-only` with 24-success + 1-fail mock; assert 24 files written + the 1 failed prompt's prior fixture (if any) untouched + stderr names the failing prompt.
- *Edge case (out-of-scope expected, out-of-scope actual)* — prompt with `expected_kind: out-of-scope` runs through pipeline and gets `out-of-scope` outcome; counts as `expected_match: true`; does NOT count against `compile_pass_rate` (out-of-scope prompts are excluded from compile-pass denominator since they never reach compile).
- *Edge case (out-of-scope expected, in-scope actual)* — `expected_kind: out-of-scope` but pipeline returns ok; counts as `expected_match: false`; NEVER auto-passes the gate via "ok" outcome.
- *Edge case (in-scope expected, out-of-scope actual)* — `expected_kind: ok` but pipeline returns out-of-scope; counts as `expected_match: false`; flagged in stderr as "classifier rejected an in-scope prompt — possible regression".
- *Integration (gated by VOLTEUX_COMPILE_SERVER_LIVE=1 + ANTHROPIC_API_KEY)* — full run against live Compile API; assert exit code per actual outcome (the test's purpose is to surface regressions in the calibration set, not to lock to a specific score). Documented as "WARN-only in CI; informational locally".

**Verification:**
- `bun test tests/acceptance/run.test.ts` is green.
- `bun run acceptance --tuning-only --json` against a `bun run compile:up &` and a real API key produces a JSON report containing 25 prompt outcomes + aggregate axis rates.
- `bun run acceptance:regen` writes 25 JSON files under `fixtures/generated/archetype-1/`; each parses with `VolteuxProjectDocumentSchema`.
- Holdout prompts have file headers documenting the freeze date and the rule "do NOT modify without breaking holdout discipline".
- `tests/acceptance/run.ts` header documents the 4th-axis (Wokwi behavior-correctness) as the v0.5-pending scoring dimension.
- `fixtures/generated/archetype-1/.gitkeep` is committed; the directory exists for Talia's UI snapshot tests to consume.
- A v0.5 contributor adding the 4th axis can do so without re-shaping the existing 3-axis aggregate (the runner's score struct uses optional fields for forward compatibility).

## System-Wide Impact

- **Interaction graph:** Three new top-level entry points (`pipeline/cli.ts`, `tests/acceptance/run.ts`, plus `runPipeline` as a library export). One new outbound edge to the local filesystem (`traces/<run-id>.jsonl`); one to `fixtures/generated/archetype-1/*.json`. Removes one entry point (`scripts/v01-pipeline-io-smoke.ts`). The orchestrator's classify→generate→[gates]→compile call graph is the FIRST place in the codebase where all six gates compose; previously each was tested in isolation or via the smoke script's loose sequencing.
- **Error propagation:** Every gate failure either flows through `PipelineFailureKind` and the Honest Gap formatter OR is bubbled to the orchestrator caller as `{ok: false, kind, ...}`. The CLI translates this to a distinct exit code (0/1/2). Bare throws cross the function boundary ONLY at input-validation guards (empty prompt, oversize prompt) — same contract as `generate()` and `classify()`.
- **State lifecycle risks:**
  - Trace files: append-only writes; one file per run; gitignored (`traces/`). Trace-write failures are caught and logged; never crash the orchestrator. Risk: a long-running `acceptance` run with 30 prompts produces 30 trace files; bounded growth, no eviction needed at v0.1 dev volume. v0.5 may add eviction.
  - `fixtures/generated/` is committed via PR review; partial regen on failure leaves stale files until the next successful regen — documented in PR template guidance.
  - `defaultPipelineDeps()` in-flight-Promise lazy init: covered by the same three-test contract that `pipeline/llm/{generate,classify}.ts` use; `__testing.resetDefaultPipelineDeps()` is the test-only escape.
- **API surface parity:**
  - `pipeline/index.ts` exports `runPipeline` as the canonical library entry (Talia's track may import it once UI integration lands in v1.0; until then no external consumer).
  - `pipeline/honest-gap.ts` exports `formatHonestGap` as a pure function; if Talia later wants to format an Honest Gap from a UI-detected error, the import path is stable.
  - `pipeline/trace.ts` exports `TraceEvent` as a discriminated union — once committed, downstream consumers (eval harness in v0.5; meta-harness in v0.9) depend on the shape; field additions are backwards-compatible (consumers ignore unknown fields), but renames or removals require coordinated edits.
- **Integration coverage:** Unit-level mocks won't catch the orchestrator's gate-sequencing bugs (e.g., the schema gate returning `ok: true` but the document being malformed in a way only cross-consistency catches; a missing await on the trace `emit`). The 6-gate gated integration test at `tests/pipeline.test.ts` is the cross-unit coverage; it MUST run on every PR that touches `pipeline/index.ts`, `pipeline/repair.ts`, or any gate/rules module. PR template line documents the requirement; eval CI gating is v0.5.
- **Unchanged invariants:**
  - `schemas/document.zod.ts` — no schema change; `VolteuxHonestGap` reused as-is.
  - `pipeline/llm/{generate,classify}.ts` — public API unchanged; `defaultPipelineDeps()` consumes `defaultGenerateDeps()` + `defaultClassifyDeps()` without mutating either. Their `_resetDefaultDepsForTest()` standalone form is NOT migrated in this batch (deferred opportunistically).
  - `pipeline/gates/*.ts` and `pipeline/rules/*.ts` — public APIs unchanged; the orchestrator consumes them via existing exports.
  - `infra/server/*.ts` and `infra/Dockerfile` — unchanged. Compile API contract is locked per origin doc.
  - `components/registry.ts` — only authoritative source for static component metadata; this batch reads from it transitively (via `generate()`'s schema primer); never writes.
  - The 11 archetype-1 rules' severity assignments are LOCKED.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| **`@anthropic-ai/sdk` SDK minor-version bump breaks `isStructuredOutputParseError`.** The detection relies on a hardcoded prefix string per `pipeline/llm/sdk-helpers.ts`. The orchestrator's failure routing inherits the brittleness even though it doesn't import the helper directly. | Pin remains `~0.91.1` (patch-only). Regression test in `tests/llm/sdk-helpers.test.ts` is the canary — Unit 6's PR description includes a checklist item "verify sdk-helpers regression test still green." If a future SDK introduces a typed `StructuredOutputParseError`, prefer that over the prefix-string fallback (sdk-helpers.ts header documents the migration path). |
| **Cross-gate `repair()` may produce a doc that fails a DIFFERENT gate than the one that triggered repair.** E.g., compile-failed → repair → schema-failed on the new doc. The bound is per-`runPipeline`, not per-gate, so this routes to Honest Gap as `schema-failed`. | Documented as expected behavior. Acceptance harness (Unit 8) measures the repair success rate per failing-gate-kind; if rates are pathological (e.g., 0% for schema-failed-after-repair), the v0.9 meta-harness can tune the repair-prompt template. The bound prevents infinite loops regardless. |
| **Trace file size blows up on long-running acceptance runs.** 30 prompts × ~10 events/prompt × ~500 bytes/event = ~150kB per acceptance run. Bounded. | No eviction at v0.1; documented in `pipeline/trace.ts` header. v0.5 may add per-run-directory size cap or compression. |
| **Scrub policy regex misses a future SDK error shape.** SDK 0.92+ may surface API keys in a different format (e.g., a new prefix), or wrap response bodies differently. | Scrub-miss surfaces as stderr WARN (NOT a silent pass per CLAUDE.md no-silent-failures). Unit 7's test matrix is extended whenever a new sensitive shape is observed. The WARN line is greppable so reviewers and CI can detect missed scrubs. |
| **Holdout discipline can be silently violated by manually editing a holdout prompt.** Frontmatter doesn't prevent file edits. | Unit 8 ships a `tests/acceptance/run.test.ts` test that snapshots the SHA-256 of every holdout prompt file and asserts it against a committed `tests/acceptance/holdout-fingerprints.json`. Editing a holdout file fails the test, forcing the PR author to acknowledge the change OR regenerate the fingerprints (which is itself reviewable). Optional but recommended; skip if the contributor consensus is the comment is enough. |
| **`defaultPipelineDeps()` in-flight-Promise lazy init concurrent-init race.** If two test files invoke it concurrently, both could pass the null check. | Mirrors the lazy-init learning's exact contract: cached promise, plain (non-async) outer function, three-test suite proves the shape. The learning's prevention #1 (object-identity dedup test) lands as part of `tests/pipeline-defaults.test.ts`. |
| **`pipeline/repair.ts` decision logic is novel — first cross-gate repair surface in the codebase.** Wrong decision matrix → wrong cost/quality tradeoff. | Decision matrix documented in Key Technical Decisions with per-kind justification. Unit 8's acceptance run measures repair success rate per kind; v0.9 meta-harness can tune the matrix from data. The bound (≤1 repair) prevents catastrophic cost runaway during the calibration period. |
| **`fixtures/generated/` regeneration produces stochastic outputs.** Sonnet 4.6 is deterministic per-prompt only with `temperature=0` (which `generate.ts` does NOT explicitly set; SDK default is 1.0). Regenerating fixtures may produce diffs that aren't real regressions. | Documented in `tests/acceptance/run.ts` header: "regenerated fixtures may differ across runs without indicating a regression; PR review compares the SHAPE not the exact JSON; Talia's UI snapshot tests use shape-tolerant assertions, not exact-string match." If shape-tolerance proves insufficient, set `temperature=0` in the regen mode only — but be explicit in the trace event. |
| **Acceptance harness gate failures are eval-harness-blind.** Without v0.5's eval CI policy, a contributor who runs the harness locally can ignore exit code 2 and merge anyway. | The PR template line "have you run `bun run acceptance` locally? Paste the aggregate axis line." raises the friction. v0.5 lifts to eval-CI gating per CLAUDE.md. |
| **JSON-Lines events grow when new gate kinds are added.** Forward compatibility risk if events are missing fields readers expect. | All consumers (Unit 8 runner, future eval harness, meta-harness) treat unknown event types and unknown fields as ignorable; the trace writer's `TraceEvent` union is open to additive extension. Renames or removals require a coordinated edit per CLAUDE.md schema discipline (the trace event shape isn't a Zod schema yet, but is contract-equivalent — when v0.5 lands, consider promoting `TraceEvent` to a Zod schema for stricter contract-checking). |
| **The 30-prompt calibration set may not reflect real beginner phrasings.** Unit 8's authors are pipeline engineers, not 14-year-olds. | The 5 holdout prompts include 1 typo + 1 figurative + 1 borderline-tempting on purpose — exactly the cases beginners produce. Calibration set is treated as a v0.1 baseline; v0.5 expands using prompts captured from the friend-demo (origin doc § Week 10-12 milestone). |

## Documentation / Operational Notes

- **No update to `docs/PLAN.md` or `CLAUDE.md` in this batch.** PLAN.md's pipeline architecture diagram already shows orchestrator wiring; the v0.1-pipeline plan reference link is correct. CLAUDE.md's track ownership and schema discipline are unchanged.
- **`pipeline/prompts/repair-archetype-1.md` ships with the meta-harness header comment** (`<!-- This prompt is consumed by the meta-harness in v0.9. Edit via PR; the proposer reads the latest committed version. -->`). v0.9's proposer expects it; do not move or rename without coordination.
- **`tests/acceptance/run.ts` header documents the v0.5 4th-axis (Wokwi behavior-correctness)** explicitly so a future contributor doesn't think it was forgotten.
- **`fixtures/generated/archetype-1/` is committed**; the regen step is a separate command (`bun run acceptance:regen`) so iterations don't burn fixture writes. Talia's UI snapshot tests consume these fixtures; coordinate before any rename or directory move.
- **Trace artifacts under `traces/`** are gitignored; the path is documented in CLAUDE.md indirectly via the gitignore. v0.5 may centralize trace consumption (eval harness reads from a known location).
- **PR template addition**: "Have you run `bun run pipeline -- '<sample>'` and `bun run acceptance` locally? Paste the aggregate axis line and the trace path." Without enforceable check, the manual gate is honor-system; the PR template line raises the friction of skipping it. Lifts to eval-CI in v0.5.
- **Cost watch**: a full acceptance run is ~30 prompts × ~$0.05 Sonnet + ~$0.005 Haiku ≈ $1.65/run. Expect 5-10 runs during Unit 8 iteration ≈ $10-15 total. Document in `tests/acceptance/run.ts` header.
- **`bun run pipeline` per-prompt cost**: ~$0.05 Sonnet + ~$0.005 Haiku + $0 local compile ≈ $0.055/prompt. Cross-gate repair adds ~$0.05. Documented in `pipeline/cli.ts` header; visible in trace `pipeline_summary.cost_usd` per run.

## Sources & References

- **Predecessor plans:**
  - `docs/plans/2026-04-26-001-feat-v01-pipeline-llm-units-3-4-5-plan.md` (Units 3-5 just shipped; § Scope Boundaries names Unit 9 / Unit 10 as next batches resolved into Units 6-8 of this plan)
  - `docs/plans/2026-04-25-002-feat-v01-pipeline-io-llm-and-compile-api-plan.md` (predecessor; § Deferred to Separate Tasks contains the original Unit 9 / Unit 10 sketches)
  - `docs/plans/2026-04-25-001-feat-v01-pipeline-archetype-1-plan.md` (original predecessor; § Success Criteria carries the eval-harness 4-axis contract — behavior-correctness is v0.5 Wokwi-only; this batch ships 3-axis)
- **Project source-of-truth:** `docs/PLAN.md` (v0 success gates; locked Compile API contract; Honest Gap shape `{scope, missing_capabilities, explanation}` from § Definitions)
- **Track ownership and conventions:** `CLAUDE.md` (Track 2 = Kai = pipeline; schema discipline; no-silent-failures; one-line-PR-description rule)
- **Compound learnings (REQUIRED reading per Unit):**
  - Unit 6: `docs/solutions/logic-errors/lazy-init-singleton-in-flight-promise-bun-test-isolation-2026-04-26.md` (deps factory) + `docs/solutions/best-practices/c-preprocessor-modelling-in-llm-output-gates-2026-04-25.md` (gate-wrapping discipline)
  - Unit 7: `docs/solutions/security-issues/sha256-cache-key-canonical-json-serialization-2026-04-26.md` (canonical-envelope rule for trace event hashes)
  - Unit 8: `docs/solutions/best-practices/c-preprocessor-modelling-in-llm-output-gates-2026-04-25.md` (calibration prompts must replicate downstream semantics)
- **Existing code consumed by this batch:**
  - `pipeline/llm/generate.ts`, `pipeline/llm/classify.ts`, `pipeline/llm/sdk-helpers.ts`, `pipeline/llm/anthropic-client.ts`
  - `pipeline/gates/schema.ts`, `pipeline/gates/cross-consistency.ts`, `pipeline/gates/compile.ts`, `pipeline/gates/library-allowlist.ts`
  - `pipeline/rules/index.ts`
  - `pipeline/types.ts`, `schemas/document.zod.ts`, `components/registry.ts`
  - `infra/server/cache.ts` (canonical-envelope precedent), `infra/server/compile-api.ts` (DI shape precedent)
  - `scripts/v01-pipeline-io-smoke.ts` (CLI flag vocabulary; deleted in Unit 6's PR)
- **Anthropic public pricing** (committed into `pipeline/cost.ts` rate constants): Sonnet 4.6 input $3 / cache_write $3.75 / cache_read $0.30 / output $15 per MTok; Haiku 4.5 input $1 / cache_write $1.25 / cache_read $0.10 / output $5 per MTok.
- **JSON Lines spec:** [jsonlines.org](https://jsonlines.org) — line-delimited JSON; each line a self-contained JSON object; append-only.
