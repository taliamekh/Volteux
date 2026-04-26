/**
 * Honest Gap formatter — Unit 6 commit-1 stub.
 *
 * Commit-2 lands the per-kind builders, scope dispatch, and
 * missing_capabilities defaults. This stub exports the public
 * `formatHonestGap` signature so `pipeline/index.ts` type-checks
 * during the scaffold commit; it returns a placeholder shape that
 * tests will replace once the real implementation lands.
 */

import type { VolteuxHonestGap } from "../schemas/document.zod.ts";
import type { PipelineFailure } from "./index.ts";

export function formatHonestGap(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _failure: PipelineFailure,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _prompt: string,
): VolteuxHonestGap {
  // Commit-2 replaces this with the real per-kind builder dispatch.
  throw new Error(
    "formatHonestGap is a commit-1 stub; commit-2 lands the real per-kind builders",
  );
}
