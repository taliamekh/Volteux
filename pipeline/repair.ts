/**
 * Cross-gate repair helper — Unit 6 commit-1 stub.
 *
 * Commit-3 lands the real repair-prompt template loader, gate-specific
 * stem extraction, structured prior-doc digest, and dispatch through
 * the injected `gen` function. This stub exports the public `repair`
 * signature so `pipeline/index.ts`'s `defaultPipelineDeps()` type-checks
 * during the scaffold commit.
 */

import type { GenerateResult } from "./llm/generate.ts";
import type { VolteuxProjectDocument } from "../schemas/document.zod.ts";
import type { PipelineFailureKind } from "./index.ts";

export interface RepairableFailure {
  kind: PipelineFailureKind;
  message: string;
  errors: ReadonlyArray<string>;
}

export async function repair(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _failure: RepairableFailure,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _prior_doc: VolteuxProjectDocument,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _prompt: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _gen: (
    prompt: string,
    opts?: { signal?: AbortSignal },
  ) => Promise<GenerateResult>,
): Promise<GenerateResult> {
  // Commit-3 replaces this with the real prompt-template-driven
  // gen() invocation.
  throw new Error(
    "repair is a commit-1 stub; commit-3 lands the real repair-prompt template + dispatch",
  );
}
