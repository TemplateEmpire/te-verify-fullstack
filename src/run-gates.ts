import { execa } from "execa";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GateResult, Stack, StackEcosystem, Tier } from "./types.js";

export interface GateSpec {
  id: string;
  name: string;
  cwd: string;
  command: string;
  args: string[];
  timeoutMs?: number;
  env?: Record<string, string>;
  postProcess?: (result: GateResult) => GateResult;
}

export async function runCommandGate(spec: GateSpec): Promise<GateResult> {
  const start = Date.now();
  let result: GateResult;
  try {
    const execResult = await execa(spec.command, spec.args, {
      cwd: spec.cwd,
      timeout: spec.timeoutMs ?? 600_000,
      reject: false,
      env: { ...process.env, ...spec.env, CI: "true" },
    });
    result = {
      id: spec.id,
      name: spec.name,
      status: execResult.exitCode === 0 ? "PASS" : "FAIL",
      command: `${spec.command} ${spec.args.join(" ")}`,
      exitCode: execResult.exitCode ?? undefined,
      durationMs: Date.now() - start,
      stdoutTail: tailString(execResult.stdout ?? ""),
      stderrTail: tailString(execResult.stderr ?? ""),
    };
  } catch (err) {
    result = {
      id: spec.id,
      name: spec.name,
      status: "ERROR",
      command: `${spec.command} ${spec.args.join(" ")}`,
      durationMs: Date.now() - start,
      stderrTail: err instanceof Error ? err.message : String(err),
    };
  }

  if (spec.postProcess) {
    try {
      return spec.postProcess(result);
    } catch {
      return result;
    }
  }
  return result;
}

function tailString(s: string, max = 4000): string | undefined {
  if (!s) return undefined;
  return s.length > max ? `…${s.slice(-max)}` : s;
}

export function strictLintPostProcess(result: GateResult): GateResult {
  const text = `${result.stdoutTail ?? ""}\n${result.stderrTail ?? ""}`;
  const m = /\((\d+)\s+errors?\s*,\s*(\d+)\s+warnings?\s*\)/i.exec(text);
  if (!m) return result;
  const errors = parseInt(m[1], 10);
  const warnings = parseInt(m[2], 10);
  const metadata = { ...(result.metadata ?? {}), lintErrors: errors, lintWarnings: warnings };

  if (errors > 0 || warnings > 0) {
    return {
      ...result,
      status: "FAIL",
      name: `${result.name} — ${errors} err, ${warnings} warn`,
      metadata,
    };
  }
  return { ...result, metadata };
}

/**
 * Detect the stack the template is built on. Reads the most authoritative
 * manifest first (package.json) then falls back to per-language files.
 */
export function detectStack(templateRoot: string): { stack: Stack; ecosystem: StackEcosystem } {
  const has = (rel: string) => existsSync(join(templateRoot, rel));

  const pkgPath = join(templateRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps["next"])              return { stack: "nextjs",   ecosystem: "node" };
      if (deps["@nestjs/core"])      return { stack: "nestjs",   ecosystem: "node" };
      if (deps["@remix-run/react"])  return { stack: "remix",    ecosystem: "node" };
      if (deps["@sveltejs/kit"])     return { stack: "sveltekit", ecosystem: "node" };
      if (deps["nuxt"])              return { stack: "nuxt",     ecosystem: "node" };
      if (deps["astro"])             return { stack: "astro",    ecosystem: "node" };
      if (deps["express"])           return { stack: "express",  ecosystem: "node" };
    } catch { /* fall through */ }
  }

  if (has("artisan") || has("composer.json")) return { stack: "laravel",  ecosystem: "php" };
  if (has("manage.py"))                       return { stack: "django",   ecosystem: "python" };
  if (has("pyproject.toml") || has("requirements.txt")) {
    // FastAPI vs Django: look for `fastapi` import in source
    return { stack: "fastapi", ecosystem: "python" };
  }
  if (has("config/application.rb") || has("Gemfile")) return { stack: "rails",  ecosystem: "ruby" };
  if (has("Program.cs") || has("Startup.cs"))         return { stack: "aspnet", ecosystem: "dotnet" };
  if (has("pom.xml") || has("build.gradle"))          return { stack: "spring", ecosystem: "java" };
  if (has("mix.exs"))                                 return { stack: "phoenix", ecosystem: "elixir" };

  return { stack: "unknown", ecosystem: "unknown" };
}

/**
 * Infer tier (TL/TP/TX) from the template slug. Used to apply tier-specific
 * gate expectations in future (e.g. TX may require SSO config presence).
 */
export function detectTier(slug: string | undefined): Tier {
  if (!slug) return "unknown";
  const s = slug.toLowerCase();
  if (s.startsWith("tl"))   return "TL";
  if (s.startsWith("tp"))   return "TP";
  if (s.startsWith("tx"))   return "TX";
  return "unknown";
}

/**
 * Per-ecosystem gate command sets. Returns null when the ecosystem is not
 * yet implemented — caller emits SKIPPED gates with a clear message.
 */
export interface EcosystemGates {
  install: { command: string; args: string[]; timeoutMs: number } | null;
  typecheck: { command: string; args: string[]; timeoutMs: number } | null;
  lint: { command: string; args: string[]; timeoutMs: number } | null;
  test: { command: string; args: string[]; timeoutMs: number } | null;
  build: { command: string; args: string[]; timeoutMs: number } | null;
  audit: { command: string; args: string[]; timeoutMs: number } | null;
}

export function gatesForEcosystem(ecosystem: StackEcosystem): EcosystemGates | null {
  switch (ecosystem) {
    case "node":
      return {
        install:   { command: "pnpm", args: ["install", "--frozen-lockfile", "--prefer-offline"], timeoutMs: 600_000 },
        typecheck: { command: "pnpm", args: ["typecheck"], timeoutMs: 180_000 },
        lint:      { command: "pnpm", args: ["lint"], timeoutMs: 180_000 },
        // Buyer ZIPs intentionally do not ship the repository test harness.
        // Source tests run in template CI before packaging; ZIP verification
        // covers install/typecheck/lint/build/audit plus structural/compliance.
        test:      null,
        build:     { command: "pnpm", args: ["build"], timeoutMs: 900_000 },
        audit:     { command: "pnpm", args: ["audit", "--prod", "--audit-level=high"], timeoutMs: 60_000 },
      };
    // Stub adapters — caller emits SKIPPED with a clear "ecosystem N/A" message
    // and a TODO link. Adding these is a separate work item per ecosystem.
    case "php":
    case "python":
    case "ruby":
    case "dotnet":
    case "java":
    case "elixir":
    case "unknown":
      return null;
  }
}
