import AdmZip from "adm-zip";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ExtractResult {
  extractRoot: string;       // Top of extraction (for cleanup)
  templateRoot: string;      // Directory containing the template root
  sha256: string;
  zipSizeBytes: number;
  entries: string[];         // Relative paths inside the template (wrapper folder stripped)
}

/**
 * Extract a buyer ZIP to a temp directory. Mirrors te-verify's extract flow —
 * detects single-top-level-folder wrappers (e.g. `tl01-kiln-saas-starter-nextjs-1.0.0/`)
 * and strips them so downstream gates see the same paths the buyer does.
 */
export function extractZip(zipPath: string): ExtractResult {
  const buffer = readFileSync(zipPath);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const zipSizeBytes = statSync(zipPath).size;

  const extractRoot = join(
    tmpdir(),
    `te-verify-fs-${Date.now()}-${sha256.slice(0, 8)}`,
  );
  mkdirSync(extractRoot, { recursive: true });

  const zip = new AdmZip(buffer);
  zip.extractAllTo(extractRoot, /* overwrite */ true);

  const allEntries = zip.getEntries();

  const firstSegments = new Set<string>();
  for (const entry of allEntries) {
    const first = entry.entryName.replace(/\\/g, "/").split("/")[0];
    if (first) firstSegments.add(first);
  }

  let templateRoot = extractRoot;
  let wrapper = "";
  if (firstSegments.size === 1) {
    const candidate = [...firstSegments][0];
    const candidatePath = join(extractRoot, candidate);
    try {
      if (statSync(candidatePath).isDirectory()) {
        templateRoot = candidatePath;
        wrapper = `${candidate}/`;
      }
    } catch {
      /* not a real dir; treat as flat */
    }
  }

  const entries = allEntries
    .map((e) => e.entryName.replace(/\\/g, "/"))
    .filter((n) => n.startsWith(wrapper) && n !== wrapper)
    .map((n) => n.slice(wrapper.length))
    .map((n) => n.replace(/\/$/, ""))
    .filter((n) => n.length > 0);

  return { extractRoot, templateRoot, sha256, zipSizeBytes, entries };
}

export function cleanup(extractRoot: string): void {
  rmSync(extractRoot, { recursive: true, force: true });
}
