#!/usr/bin/env bun
/**
 * Regenerate `schemas/document.schema.json` from the Zod source of truth.
 *
 *   bun run gen:schema           # write the JSON Schema
 *   bun run verify:schema-current  # exit 1 if the committed JSON Schema is stale
 *
 * The committed JSON Schema is for documentation/UI consumers that don't
 * import Zod. CI should run `verify:schema-current` to prevent drift.
 */

import { writeFileSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { VolteuxProjectDocumentSchema } from "./document.zod.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(HERE, "document.schema.json");

const jsonSchema = zodToJsonSchema(VolteuxProjectDocumentSchema, {
  name: "VolteuxProjectDocument",
  $refStrategy: "root",
  // zod-to-json-schema's max target is draft/2019-09. PLAN.md § "v0 JSON
  // schema (draft)" currently declares draft/2020-12 — drift documented in
  // schemas/CHANGELOG.md v0.1 for joint-signoff resolution. The structural
  // output here is compatible with both drafts (no `unevaluatedProperties`,
  // no recursive refs); validators using either draft behave identically.
  target: "jsonSchema2019-09",
});

const serialized = JSON.stringify(jsonSchema, null, 2) + "\n";

const checkMode = process.argv.includes("--check");

if (checkMode) {
  let onDisk: string;
  try {
    onDisk = readFileSync(OUT_PATH, "utf8");
  } catch {
    console.error(
      `[verify:schema-current] ${OUT_PATH} does not exist. Run 'bun run gen:schema'.`,
    );
    process.exit(1);
  }
  if (onDisk !== serialized) {
    console.error(
      `[verify:schema-current] ${OUT_PATH} is stale. Run 'bun run gen:schema' and commit.`,
    );
    process.exit(1);
  }
  console.log(
    `[verify:schema-current] ${OUT_PATH} is up to date with document.zod.ts.`,
  );
  process.exit(0);
}

writeFileSync(OUT_PATH, serialized);
console.log(`[gen:schema] Wrote ${OUT_PATH} (${serialized.length} bytes).`);
