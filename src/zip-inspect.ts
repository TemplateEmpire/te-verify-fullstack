import type { ZipInspection } from "./types.js";

// Forbidden in any release ZIP. Mirrors UI policy (release-pipeline §3.2/§3.3).
// Note: full-stack templates legitimately ship `db/` and `docker-compose.*.yml`.
const FORBIDDEN = [
  ".git",
  ".github",
  "node_modules",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".output",
  ".env",
  ".env.local",
  ".claude",
  "CLAUDE.md",
  "AGENTS.md",
  "GEMINI.md",
  ".serena",
  ".docs",
  "test-results",
  "playwright-report",
  "tsconfig.tsbuildinfo",
  // Vendored deps for non-Node ecosystems
  "vendor",       // PHP / Ruby
  "venv",         // Python
  ".venv",
  "__pycache__",
  "target",       // Java / Rust
  "bin",          // .NET
  "obj",          // .NET
  "_build",       // Elixir
  "deps",         // Elixir
];

// Required at the template root. Note Gate 17 adds COMPLIANCE.md.
const REQUIRED_FILES = [
  "README.md",
  "LICENCE.md",
  "INSTALLATION.md",
  "CUSTOMIZATION.md",
  "CHANGELOG.md",
  ".env.example",
  "COMPLIANCE.md",
];

// At least one source directory must exist.
const REQUIRED_ANY_DIRS: string[][] = [
  // Web frameworks: src/ for Node stacks; app/ + config/ for Rails; backend/ + frontend/ for split repos.
  ["src", "app", "backend", "lib", "pages"],
];

const MIN_EXPECTED_ENTRIES = 50;
const MAX_EXPECTED_ENTRIES = 20000;

export function inspectZipEntries(
  entries: string[],
  zipSizeBytes: number,
): ZipInspection {
  const entrySet = new Set(entries);

  const forbiddenFound: string[] = [];
  for (const f of FORBIDDEN) {
    const hit = entries.some((e) => e === f || e.startsWith(`${f}/`));
    if (hit) forbiddenFound.push(f);
  }

  const missingRequired = REQUIRED_FILES.filter((f) => !entrySet.has(f));
  const missingDirs = REQUIRED_ANY_DIRS
    .filter((group) => !group.some((d) => entries.some((e) => e === d || e.startsWith(`${d}/`))))
    .map((group) => `one-of(${group.join("|")})`);

  let extremeEntryCount: ZipInspection["extremeEntryCount"] = null;
  if (entries.length < MIN_EXPECTED_ENTRIES) extremeEntryCount = "too-few";
  else if (entries.length > MAX_EXPECTED_ENTRIES) extremeEntryCount = "too-many";

  return {
    forbiddenFound,
    missingRequired,
    missingDirs,
    sizeBytes: zipSizeBytes,
    entryCount: entries.length,
    extremeEntryCount,
  };
}
