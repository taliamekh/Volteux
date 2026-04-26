---
module: pipeline-gates
date: 2026-04-25
problem_type: best_practice
component: tooling
severity: high
applies_when: >
  Writing static-analysis gates or pre-flight checks against LLM-generated
  C/C++ source — or any language whose preprocessor mutates token boundaries
  before the compiler's main parse phase.
symptoms:
  - Allowlist or lint rules silently pass sketches that contain a disallowed
    `#include` written with a backslash-newline line continuation
    (e.g. `#include \⏎<WiFi.h>`); the directive is invisible to a naive
    regex but the C preprocessor (and arduino-cli) resolve it normally.
  - Allowlist rules fire false-positive violations on `#include` text that
    appears inside a C string literal, blocking valid sketches and
    triggering unnecessary LLM auto-repair retries (3-6× the per-prompt
    token cost).
  - A document's `sketch.libraries[]` field diverges silently from the
    `#include` directives actually present in the source, because the gate
    only checks one direction. Downstream consumers (UI parts list,
    Adafruit cart, eval harness) treat `libraries[]` as authoritative and
    make incorrect decisions with no error signal.
tags:
  - llm-output-validation
  - c-preprocessor
  - static-analysis
  - allowlist
  - regex-parsing
  - security
  - pipeline-gates
  - arduino-cli
related_components:
  - testing_framework
  - documentation
---

# C-preprocessor pipeline modelling in LLM-output static gates

## Context

Volteux's pipeline validates LLM-generated Arduino sketches before they
reach the arduino-cli compile API. Defense-in-depth requires a library
allowlist gate that fires *before* a compile slot is consumed. The gate
lives in [`pipeline/gates/library-allowlist.ts`](../../../pipeline/gates/library-allowlist.ts)
and enforces three properties:

1. `sketch.libraries[]` contains only archetype-permitted libraries.
2. Every `#include` directive in the source resolves to a permitted library.
3. `sketch.additional_files` keys match a safe-filename regex.

A multi-persona review pass (`/ce:review` on commits 0879969..5408d42 of
branch `feat/v01-pipeline`) surfaced three coupled findings in
`parseIncludes()`. Security-lens, adversarial, and testing reviewers each
flagged a different facet, but all three trace to the same root cause:
**the regex-based static analyzer did not replicate the relevant stages of
the C preprocessor pipeline before pattern matching.** The compiler
processes source through a defined sequence of translation phases; skipping
any phase creates a gap between what the gate sees and what the compiler
actually processes.

This learning generalizes the lesson so the next gate Kai writes (the
Compile API in Unit 6, or any future archetype's allowlist) starts with
the right model.

**See also:**
- [docs/plans/2026-04-25-001-feat-v01-pipeline-archetype-1-plan.md](../../plans/2026-04-25-001-feat-v01-pipeline-archetype-1-plan.md)
  Unit 4 — design intent for `library-allowlist.ts` (the original
  comment-stripping strategy was necessary but insufficient).
- [docs/PLAN.md](../../PLAN.md) § "Library allowlist" + § "Definitions"
  check (h) — the strategic rationale and the cross-consistency contract
  these findings extend.

## Guidance

When writing regex-based static analysis over C/C++ source — especially
for security-critical property enforcement — replicate the C preprocessor
pipeline in the same order the compiler does:

### 1. Phase 2 first: splice line continuations

The C preprocessor's Phase 2 deletes every `\<newline>` pair before
tokenization or comment stripping. This means `#include \⏎<WiFi.h>` and
even `#in\⏎clude <WiFi.h>` are valid directives the compiler resolves.
Any pattern match over un-spliced source can be bypassed with a
backslash-newline anywhere in the directive.

Implement this as a single `replace(/\\\r?\n/g, "")` and run it first,
before comment stripping.

### 2. Then strip comments

Block comments (`/* ... */`) and line comments (`// ...`) must be stripped
*after* splicing and before directive matching. An `#include` that appears
only inside a comment must not fire the allowlist check. Replace comment
text with spaces rather than deleting it outright so character offsets
remain stable for any future diagnostic reporting.

### 3. Use a line-start anchor (`^` under the `m` flag) to distinguish directives from string literals

**Do not** attempt to strip or balance string literals before matching
`#include`. That approach conflicts with the legitimate quoted-include
syntax (`#include "header.h"`) and requires escaped-quote handling that
adds surface area without buying anything.

C preprocessor directives must begin a logical line (after optional
whitespace). C strings cannot contain a literal newline (only the `\n`
escape sequence). Therefore `#include` appearing inside a string literal
like `"Error: #include <WiFi.h> not supported"` always sits mid-line,
preceded by a `=`, `(`, or similar token. A `^[ \t]*#` pattern with the
`m` flag matches only at line start and naturally excludes string-literal
content.

The practical form:

```js
/^[ \t]*#[ \t]*include[ \t]*[<"]([^>"\s]+)[>"]/gm
```

This also handles `#include "header.h"` (quoted form) without special-casing
the two include syntaxes.

### 4. Cross-check the declared library list against parsed includes in BOTH directions

The allowlist gate must run two checks, not one:

- **Declared but not permitted:** `libraries[]` names a library that is
  not in the per-archetype allowlist. (The original check.)
- **Included but not declared:** a parsed `#include` resolves to an
  allowlist-permitted library that is *not* named in `libraries[]`.
  arduino-cli auto-resolves includes, so the compile succeeds either way
  — but the document's `libraries[]` field becomes misleading and
  downstream consumers (eval harness, UI parts list, Adafruit cart
  generator) treat it as authoritative.

Both directions must fail with a violation. The `include-without-libraries-declaration`
violation kind enforces the second direction.

## Why This Matters

**Security (SEC-001).** A single backslash-newline in an LLM-emitted sketch
bypasses the allowlist gate entirely. The compiler processes the directive;
the gate does not see it. Because the Volteux LLM output path is susceptible
to prompt injection from a future user-facing surface, an adversarial input
could cause the LLM to emit a forbidden library directive (e.g., `WiFi.h`
for network access) in a form the allowlist gate misses. The directive
passes the gate, passes the compile gate, and is flashed to a real Uno.

The allowlist is not the last line of defense — the arduino-cli sandbox on
the compile server is — but defense-in-depth is the whole reason this gate
exists. A bypassable defense layer is worse than none, because it creates
false confidence.

**Correctness and cost (ADV-001).** Without a line-start anchor, any
string constant that mentions `#include` — a diagnostic message, a
comment preserved in a string, a URL fragment — triggers a false-positive
`library-not-in-allowlist` violation. The pipeline's auto-repair loop
retries with the LLM 3-4 times per failure. At Sonnet pricing, each
unnecessary retry costs roughly 3-6× the token cost of a clean first-pass
generation. Across many prompts this is a real operational cost, not a
theoretical one.

**Contract integrity (T-001).** The document schema's `sketch.libraries[]`
field is the authoritative declaration of which external libraries the
sketch depends on. The UI's parts list, the Adafruit cart prefill, and the
v0.5 eval harness all consume it. If the gate permits an `#include`
without a corresponding `libraries[]` entry, the field silently lies about
the sketch's dependencies. Downstream consumers make incorrect decisions
(wrong parts list, broken cart, wrong eval assertions) without any error
signal.

## When to Apply

Apply this guidance whenever:

- You write regex-based static analysis over C or C++ source for any
  security or contract-enforcement purpose.
- You build an allowlist gate that intercepts LLM-generated code before
  it reaches a compiler or interpreter.
- You validate a structured field (`libraries[]`, `imports[]`,
  `dependencies[]`) whose values must agree with what appears in the
  source text — in both directions.
- You extend this gate to new archetypes, new header mappings, or new
  allowlist rules.

The general principle extends to any language whose tokenization pipeline
has pre-tokenization transformation phases (line continuation, trigraph
replacement, include nesting). For most web languages (JS/TS, Python)
these phases do not exist and comment stripping plus literal-aware
matching is sufficient. For C/C++, Phase 2 is the additional mandatory
step.

## Examples

### SEC-001: Backslash-newline line continuation bypass

**Attack payload (both forms are valid C preprocessor input):**

```c
// Form 1: continuation across the header
#include \
<WiFi.h>

// Form 2: continuation splits the keyword itself
#in\
clude <WiFi.h>
```

**Old `parseIncludes` — the bypass works:**

```typescript
// Before: no Phase 2 splicing. Regex runs on raw source.
// `stripComments` is a pre-existing helper that blanks // and /* */ runs.
export function parseIncludes(source: string): ReadonlyArray<string> {
  const stripped = stripComments(source);              // Phase 2 skipped
  const re = /#\s*include\s*[<"]([^>"\s]+)[>"]/g;     // no line anchor
  const headers: string[] = [];
  for (const match of stripped.matchAll(re)) {
    if (match[1]) headers.push(match[1]);
  }
  return headers;
  // Neither attack payload above matches → gate passes → WiFi.h reaches compiler
}
```

**Fixed `parseIncludes` — the bypass is closed:**

```typescript
// Phase 2: delete every \<newline> pair before anything else
function spliceLineContinuations(source: string): string {
  return source.replace(/\\\r?\n/g, "");
}

export function parseIncludes(source: string): ReadonlyArray<string> {
  const spliced = spliceLineContinuations(source);    // Phase 2 first
  const stripped = stripComments(spliced);            // then comment strip
  const re = /^[ \t]*#[ \t]*include[ \t]*[<"]([^>"\s]+)[>"]/gm; // line-anchored
  const headers: string[] = [];
  for (const match of stripped.matchAll(re)) {
    if (match[1]) headers.push(match[1]);
  }
  return headers;
  // After splicing, both attack forms become "#include <WiFi.h>" → gate catches it
}
```

### ADV-001: String literal false positive

**Sketch that triggered the false positive:**

```c
const char msg[] = "Error: #include <WiFi.h> not supported on this board";

void setup() { Serial.begin(9600); }
void loop()  { Serial.println(msg); }
```

**Old regex (no line anchor, `g` flag only):**

```typescript
const re = /#\s*include\s*[<"]([^>"\s]+)[>"]/g;
// Matches "#include <WiFi.h>" inside the string literal
// → false-positive library-not-in-allowlist violation
// → auto-repair loop retries 3-4× → ~6× token cost
```

**Fixed regex (`^` anchor, `gm` flags):**

```typescript
const re = /^[ \t]*#[ \t]*include[ \t]*[<"]([^>"\s]+)[>"]/gm;
// ^ only matches at line start. The string literal's #include
// is mid-line (after `= "`), so it never matches.
// → no false positive → no unnecessary retry
```

### T-001: Missing cross-check — include without libraries[] declaration

**Sketch that exposed the gap:**

```c
#include <Servo.h>   // present in source

// document's libraries field: []  ← empty; LLM forgot to declare it
```

arduino-cli auto-resolves `Servo.h` regardless of `libraries[]`, so the
compile passes. The old gate only checked the other direction (library
declared but not in allowlist). The `libraries[]` field silently
contradicted the sketch.

**Old `runAllowlistChecks` (one-directional check only):**

```typescript
const allowedSet = new Set(allowlist);

// Only checks: if declared in libraries[], is it in the allowlist?
for (const library of input.libraries) {
  if (!allowedSet.has(library)) {
    violations.push({
      kind: "library-not-in-allowlist",
      library,
      source: "libraries-field",
    });
  }
}
// No check in the other direction: does every #include appear in libraries[]?
```

**Fixed `runAllowlistChecks` (bidirectional):**

```typescript
const declaredLibraries = new Set(input.libraries);

for (const header of parseIncludes(file.source)) {
  const library = headerToLibrary(header);
  if (library === undefined) {
    violations.push({ kind: "unknown-header", header, file: file.name });
    continue;
  }
  if (library === "") continue;   // Arduino-core built-in, no declaration needed
  if (!allowedSet.has(library)) {
    violations.push({
      kind: "library-not-in-allowlist",
      library,
      source: `include:${file.name}`,
    });
    continue;
  }
  // NEW: allowed library that the LLM forgot to put in libraries[]
  if (!declaredLibraries.has(library)) {
    violations.push({
      kind: "include-without-libraries-declaration",
      header,
      library,
      file: file.name,
    });
  }
}
// Both directions are now enforced: declared ⊆ allowed AND included ⊆ declared
```

## Tests added

[`tests/gates/library-allowlist.test.ts`](../../../tests/gates/library-allowlist.test.ts)
covers each finding:

- **SEC-001** — three line-continuation scenarios (single-segment, multi-segment
  splitting `#include` itself, CRLF variant)
- **ADV-001** — four string-literal scenarios (double-quoted, single-quoted,
  escaped quote inside string, real `#include` after a string)
- **T-001** — three cross-check scenarios (forbidden by missing declaration,
  Arduino-core built-in exempt, canonical case still passes)

Plan reference for the original (insufficient) test scenario that
prompted reflection: Unit 4 in the plan listed only `// #include <Evil.h>`
(commented-out line) — that was the line-comment case, not the
string-literal case or the line-continuation case.
