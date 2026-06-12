import { execa } from "execa";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";

import type { Conformance } from "./types.js";

// The full-stack runner passes "full_stack"; the UI-kit runner passes "ui_kit".
export type ConformanceProductType = "ui_kit" | "full_stack";

const RUN_SCRIPT = "scripts/run-conformance.mjs";

/**
 * Locate the canon repo that owns the pitfall-conformance engine.
 *
 * Priority: `TE_CANON_DIR` env → sibling `../canon` of this repo → cwd's
 * sibling. Returns the absolute path to run-conformance.mjs, or null if
 * canon isn't mounted (e.g. a fresh CI clone with no canon checkout) — in
 * which case conformance is skipped rather than failing the verify run.
 */
function resolveRunScript(): string | null {
  // This file is <repo>/src/conformance.ts (tsx) or <repo>/dist/conformance.js
  // (built); either way its parent's parent is the repo root.
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const candidates = [
    process.env.TE_CANON_DIR,
    resolve(repoRoot, "..", "canon"), // canon is a sibling of te-verify-fullstack
    resolve(process.cwd(), "..", "canon"),
  ].filter((d): d is string => Boolean(d));

  for (const dir of candidates) {
    const script = join(dir, RUN_SCRIPT);
    if (existsSync(script)) return script;
  }
  return null;
}

/**
 * Run the canon pitfall-conformance engine against an extracted template and
 * return its per-item checks for embedding in evidence.json.
 *
 * Canon owns the single source of truth for WHAT is checked (promoted
 * pitfalls + their inventory item numbers) and HOW (the detect specs); this
 * shells out to `run-conformance.mjs` and forwards the verbatim result. The
 * te-verify-fullstack-review skill copies these into the audit's
 * `summary_json.checks`.
 *
 * Never throws: conformance is additive evidence, not a gate of its own. If
 * canon is absent or the engine errors, returns null and the run continues.
 */
export async function runConformance(
  templateRoot: string,
  productType: ConformanceProductType,
): Promise<Conformance | null> {
  const script = resolveRunScript();
  if (!script) {
    console.log(
      pc.gray("Conformance: skipped (canon engine not found — set TE_CANON_DIR)"),
    );
    return null;
  }

  try {
    const { stdout } = await execa("node", [script, templateRoot, productType], {
      timeout: 60_000,
    });
    const parsed = JSON.parse(stdout) as {
      productType: string;
      engine: string;
      canonVersion?: string;
      checks?: Record<string, string>;
      summary?: Record<string, number>;
    };
    return {
      engine: parsed.engine,
      canonVersion: parsed.canonVersion,
      canonDir: dirname(dirname(script)), // <canon>/scripts/run-conformance.mjs → <canon>
      productType: parsed.productType,
      checks: parsed.checks ?? {},
      summary: parsed.summary ?? {},
    };
  } catch (err) {
    console.log(
      pc.yellow(
        `Conformance: engine error — ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    return null;
  }
}
