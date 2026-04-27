import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import type { StructuralCheck } from "./types.js";

/**
 * Full-stack-specific structural gates. None of these execute commands; they're
 * filesystem checks against the extracted template. Mirrors the "Phase 2 LOCAL
 * VERIFY additional gates" listed in the te-verify-fullstack-review skill.
 */
export function structuralCheck(templateRoot: string): StructuralCheck {
  return {
    ...checkCompose(templateRoot),
    ...checkEnvExample(templateRoot),
    ...checkMigrations(templateRoot),
    ...checkSeed(templateRoot),
    ...checkLicenceValidator(templateRoot),
  };
}

// ── docker-compose ────────────────────────────────────────────────────

function checkCompose(templateRoot: string): Pick<
  StructuralCheck,
  "composePresent" | "composeFiles" | "composeParseErrors"
> {
  const candidates = [
    "docker-compose.yml",
    "docker-compose.yaml",
    "docker-compose.demo.yml",
    "docker-compose.demo.yaml",
    "docker-compose.prod.yml",
    "docker-compose.prod.yaml",
    "compose.yml",
    "compose.yaml",
  ];
  const composeFiles = candidates.filter((f) => existsSync(join(templateRoot, f)));
  const composeParseErrors: string[] = [];

  // We don't shell out to `docker compose config` — that requires Docker on the
  // runner. Instead we do a cheap structural check: file is non-empty, contains
  // a `services:` key, and YAML doesn't have obviously busted indentation.
  for (const f of composeFiles) {
    try {
      const text = readFileSync(join(templateRoot, f), "utf8");
      if (!/\bservices\s*:/m.test(text)) {
        composeParseErrors.push(`${f}: no \`services:\` key`);
      }
      if (/\t/.test(text)) {
        composeParseErrors.push(`${f}: contains tab characters (YAML requires spaces)`);
      }
    } catch (err) {
      composeParseErrors.push(
        `${f}: read error — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    composePresent: composeFiles.length > 0,
    composeFiles,
    composeParseErrors,
  };
}

// ── .env.example completeness ────────────────────────────────────────

function checkEnvExample(templateRoot: string): Pick<
  StructuralCheck,
  "envExamplePresent" | "envVarsDocumented" | "envVarsUnused"
> {
  const envPath = join(templateRoot, ".env.example");
  if (!existsSync(envPath)) {
    return { envExamplePresent: false, envVarsDocumented: 0, envVarsUnused: [] };
  }

  const text = readFileSync(envPath, "utf8");
  const documented = new Set<string>();
  for (const line of text.split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*)\s*=/.exec(line.trim());
    if (m) documented.add(m[1]);
  }

  // Cheap check: grep entire source tree for each var name
  const haystack = collectSourceText(templateRoot);
  const unused: string[] = [];
  for (const v of documented) {
    const re = new RegExp(`\\b${v}\\b`);
    if (!re.test(haystack)) unused.push(v);
  }

  return {
    envExamplePresent: true,
    envVarsDocumented: documented.size,
    envVarsUnused: unused,
  };
}

function collectSourceText(root: string): string {
  const SCAN_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".py", ".rb", ".php", ".cs", ".java", ".ex", ".exs",
    ".astro", ".svelte", ".vue", ".yml", ".yaml"]);
  const SKIP = new Set(["node_modules", ".git", ".next", ".nuxt", ".svelte-kit",
    ".output", "dist", "out", "build", "vendor", "venv", ".venv", "__pycache__",
    "target", "bin", "obj", "_build", "deps"]);

  const chunks: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && SCAN_EXT.has(extname(e.name))) {
        try { chunks.push(readFileSync(full, "utf8")); }
        catch { /* skip unreadable */ }
      }
    }
  };
  walk(root);
  return chunks.join("\n");
}

// ── migrations ────────────────────────────────────────────────────────

function checkMigrations(templateRoot: string): Pick<
  StructuralCheck,
  "migrationsPresent" | "migrationsCount"
> {
  const candidates = [
    "db/migrations",
    "drizzle",
    "src/lib/db/migrations", // Drizzle co-located under src/lib (TL00-BASE layout)
    "src/db/migrations",     // Drizzle co-located under src/db
    "prisma/migrations",
    "supabase/migrations",
    "database/migrations", // Laravel
    "migrations",          // FastAPI/Alembic, Django
    "db/migrate",          // Rails
    "priv/repo/migrations", // Phoenix
  ];
  for (const dir of candidates) {
    const full = join(templateRoot, dir);
    if (existsSync(full) && safeIsDir(full)) {
      const count = readdirSync(full).filter((n) => !n.startsWith(".")).length;
      if (count > 0) {
        return { migrationsPresent: true, migrationsCount: count };
      }
    }
  }
  return { migrationsPresent: false, migrationsCount: 0 };
}

function safeIsDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

// ── seed ──────────────────────────────────────────────────────────────

function checkSeed(templateRoot: string): Pick<
  StructuralCheck,
  "seedPresent" | "seedPath"
> {
  const candidates = [
    "db/seed.ts", "db/seed.js", "db/seed.mjs",
    "src/lib/db/seed.ts", "src/lib/db/seed.js", "src/lib/db/seed.mjs", // co-located under src/lib (TL00-BASE)
    "src/db/seed.ts", "src/db/seed.js", "src/db/seed.mjs",
    "prisma/seed.ts", "prisma/seed.js",
    "scripts/seed.ts", "scripts/seed.js",
    "database/seeders",      // Laravel directory
    "db/seeds",              // Rails
    "db/seeds.rb",
    "scripts/seed.py",
    "priv/repo/seeds.exs",   // Phoenix
  ];
  for (const c of candidates) {
    const full = join(templateRoot, c);
    if (existsSync(full)) {
      return { seedPresent: true, seedPath: c };
    }
  }
  return { seedPresent: false, seedPath: null };
}

// ── licence validator ─────────────────────────────────────────────────

function checkLicenceValidator(templateRoot: string): Pick<
  StructuralCheck,
  "licenceValidatorPresent" | "licencePlaceholderPresent"
> {
  const validatorCandidates = [
    "scripts/validate-licence.mjs",
    "scripts/validate-licence.js",
    "scripts/validate-licence.ts",
    "scripts/validate_licence.py",
    "scripts/validate_licence.rb",
    "bin/validate-licence",
  ];
  const validator = validatorCandidates.find((c) => existsSync(join(templateRoot, c)));

  const licenceJsonPath = join(templateRoot, "licence.json");
  let placeholder = false;
  if (existsSync(licenceJsonPath)) {
    try {
      const text = readFileSync(licenceJsonPath, "utf8");
      placeholder = /TE-XXXX-XXXX-XXXX/.test(text);
    } catch { /* unreadable */ }
  }

  return {
    licenceValidatorPresent: Boolean(validator),
    licencePlaceholderPresent: placeholder,
  };
}

/**
 * Path of any `licence.json` candidate — exposed so the CLI can grep for a
 * real key and treat that as a P0 (a real licence shipped to buyers).
 */
export function licenceJsonContainsRealKey(templateRoot: string): boolean {
  const p = join(templateRoot, "licence.json");
  if (!existsSync(p)) return false;
  try {
    const text = readFileSync(p, "utf8");
    if (/TE-XXXX-XXXX-XXXX/.test(text)) return false;
    // Any TE- prefix that is not the placeholder = real licence.
    return /TE-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/.test(text);
  } catch {
    return false;
  }
}

export { collectSourceText };
