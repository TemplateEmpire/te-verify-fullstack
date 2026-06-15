#!/usr/bin/env node
import { Command } from "commander";
import { execa } from "execa";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import pc from "picocolors";

import { complianceScan } from "./compliance-scan.js";
import { runConformance } from "./conformance.js";
import { scanContent } from "./content-scan.js";
import { cleanup, extractZip } from "./extract.js";
import { featureScopeScan } from "./feature-scope-scan.js";
import { deriveFindings } from "./findings.js";
import { deriveProductSlug, detectFamilyId, familySlug } from "./product-slug.js";
import { renderMarkdownReport, writeEvidenceJson, writeMarkdown } from "./report.js";
import {
  detectStack,
  detectTier,
  gatesForEcosystem,
  runCommandGate,
  strictLintPostProcess,
} from "./run-gates.js";
import { structuralCheck } from "./structural-check.js";
import type { Evidence, GateResult } from "./types.js";
import { checkVersions, VERSION_PRIORITY } from "./version-check.js";
import { inspectZipEntries } from "./zip-inspect.js";

const program = new Command();

program
  .name("te-verify-fullstack")
  .description("Template Empire full-stack template (TL/TP/TX) buyer-ZIP verification — Phase 1 deterministic gates only. For Phase 2 LLM review, use the te-verify-fullstack-review Claude Code skill.")
  .version("0.1.0")
  .argument("<zipPath>", "Path to the buyer ZIP")
  .option("-o, --out <dir>", "Output directory for evidence", "./verification")
  .option("--keep-temp", "Do not delete the extracted temp directory", false)
  .option(
    "--skip <gates>",
    "Comma-separated gate IDs to skip (install,typecheck,lint,test,build,audit)",
    "",
  )
  .option(
    "--slug <slug>",
    "Override slug detection (e.g. 'tl01-kiln-saas-starter-nextjs') — used for tier inference and report naming",
    "",
  )
  // Commander's `--no-foo` syntax: `options.install` defaults to `true` and
  // `--no-install` flips it to `false`. Do NOT pass a third-arg default here —
  // a literal `false` would override the implicit `true` and the command
  // gates (install / typecheck / lint / test / build / audit) would silently
  // skip on every invocation, making any ZIP look verifier-clean.
  .option("--no-install", "Skip install + all command gates (structural/compliance only)")
  .action(async (zipPath: string, options: CliOptions) => {
    const resolvedZip = resolve(zipPath);
    if (!existsSync(resolvedZip)) {
      console.error(pc.red(`ZIP not found: ${resolvedZip}`));
      process.exit(2);
    }

    console.log(pc.bold(pc.cyan(`\nte-verify-fullstack ${program.version()}`)));
    console.log(pc.gray(`ZIP: ${resolvedZip}`));

    // ── Extract ──
    console.log(pc.gray("Extracting…"));
    const { extractRoot, templateRoot, sha256, zipSizeBytes, entries } = extractZip(resolvedZip);
    console.log(pc.gray(`  extractRoot:  ${extractRoot}`));
    console.log(pc.gray(`  templateRoot: ${templateRoot}`));
    console.log(pc.gray(`  sha256:       ${sha256.slice(0, 16)}…`));
    console.log(pc.gray(`  entries:      ${entries.length} files`));

    let packageName: string | undefined;
    let packageVersion: string | undefined;
    try {
      const pkg = JSON.parse(readFileSync(join(templateRoot, "package.json"), "utf8"));
      packageName = pkg.name;
      packageVersion = pkg.version;
    } catch {
      /* non-Node template — version comes from version-check */
    }

    const detected = detectStack(templateRoot);
    const slug = options.slug || basename(templateRoot);
    const tier = detectTier(slug);
    const isBaseTemplate = /(^|[-_/])tl00[-_/]?base/i.test(slug);

    // Canonical product identity, derived from the branded slug's family number
    // and the detected stack. The branded `slug` above stays the internal key
    // (tier / family / base detection, run naming); these are the product-table
    // identities a downstream consumer joins on.
    const familyId = detectFamilyId(slug);
    const productFamilySlug = familySlug(familyId);
    const productSlug = deriveProductSlug(familyId, detected.stack);

    console.log(pc.gray(`  stack:        ${detected.stack} (${detected.ecosystem})`));
    console.log(pc.gray(`  tier:         ${tier}`));
    console.log(pc.gray(`  slug:         ${slug}${isBaseTemplate ? " (BASE — looser structural rules)" : ""}`));
    if (productSlug) {
      console.log(pc.gray(`  product:      ${productSlug}  (family ${productFamilySlug})`));
    }
    console.log("");

    // ── Pitfall conformance (canon engine, against the pristine extract) ──
    // Run before gates mutate the tree (install/build). This is the
    // full-stack runner, so productType is always "full_stack".
    const conformance = await runConformance(templateRoot, "full_stack");
    if (conformance) {
      const s = conformance.summary;
      console.log(
        pc.gray(
          `  conformance:  ${s.pass ?? 0} pass  ${s.fail ?? 0} fail  ${s.manual ?? 0} manual` +
            (conformance.canonVersion ? `  (canon ${conformance.canonVersion})` : ""),
        ),
      );
      console.log("");
    }

    const skipSet = new Set(
      options.skip.split(",").map((s) => s.trim()).filter(Boolean),
    );
    const gates: GateResult[] = [];

    // ── Pristine-state checks ──
    const zipInspection = inspectZipEntries(entries, zipSizeBytes);
    const zipPass =
      zipInspection.forbiddenFound.length === 0 &&
      zipInspection.missingRequired.length === 0 &&
      zipInspection.missingDirs.length === 0 &&
      zipInspection.extremeEntryCount === null;
    gates.push({
      id: "zip-inspect",
      name: "ZIP contents (forbidden / required / entry count)",
      status: zipPass ? "PASS" : "FAIL",
      durationMs: 0,
    });
    process.stdout.write(`  zip-inspect…    ${zipPass ? pc.green("✓") : pc.red("✗")}\n`);

    const versionCheck = checkVersions(resolvedZip, templateRoot, detected.stack);
    const versionPass =
      versionCheck.issues.length === 0 ||
      versionCheck.issues.every((i) => VERSION_PRIORITY[i.kind] === "P2");
    gates.push({
      id: "version-check",
      name: "Version consistency (filename ↔ manifest ↔ CHANGELOG)",
      status: versionPass ? "PASS" : "FAIL",
      durationMs: 0,
    });
    process.stdout.write(`  version-check…  ${versionPass ? pc.green("✓") : pc.red("✗")}\n`);

    const contentRes = scanContent(templateRoot);
    const contentPass =
      contentRes.bomFiles.length === 0 &&
      contentRes.mojibakeFiles.length === 0 &&
      contentRes.secrets.length === 0 &&
      contentRes.realVendorsInLegal.length === 0;
    gates.push({
      id: "content-scan",
      name: "Content scan (BOM / mojibake / secrets / vendor leaks)",
      status: contentPass ? "PASS" : "FAIL",
      durationMs: 0,
    });
    process.stdout.write(`  content-scan…   ${contentPass ? pc.green("✓") : pc.red("✗")}\n`);

    const structural = structuralCheck(templateRoot);
    const structuralPass =
      structural.composePresent &&
      structural.composeParseErrors.length === 0 &&
      structural.envExamplePresent &&
      structural.licenceValidatorPresent &&
      structural.licencePlaceholderPresent &&
      (isBaseTemplate || (structural.migrationsPresent && structural.seedPresent));
    gates.push({
      id: "structural",
      name: "Structural (compose / env / migrations / seed / licence)",
      status: structuralPass ? "PASS" : "FAIL",
      durationMs: 0,
    });
    process.stdout.write(`  structural…     ${structuralPass ? pc.green("✓") : pc.red("✗")}\n`);

    const compliance = complianceScan(templateRoot);
    const complianceP0Pass = compliance.cookieConsentPresent && compliance.cookieConsentRejectAll;
    gates.push({
      id: "compliance",
      name: "Compliance scaffold (Gate 17 — UK/EU/US)",
      status: complianceP0Pass ? "PASS" : "FAIL",
      durationMs: 0,
    });
    process.stdout.write(`  compliance…     ${complianceP0Pass ? pc.green("✓") : pc.red("✗")}\n`);

    const featureScopeSupported = detected.stack === "nextjs";
    const featureScope = featureScopeScan(templateRoot, slug, {
      enabled: featureScopeSupported,
    });
    const featureScopePass =
      featureScope.forbiddenRoutes.length === 0 &&
      featureScope.missingRequiredRoutes.length === 0;
    gates.push({
      id: "feature-scope",
      name: "Feature scope (family matrix route surfaces)",
      status: featureScopeSupported ? (featureScopePass ? "PASS" : "FAIL") : "SKIPPED",
      durationMs: 0,
      metadata: {
        familyId: featureScope.familyId,
        expectedCommerce: featureScope.expectedCommerce,
        scanner: featureScopeSupported ? "nextjs-app-router" : "unsupported-stack",
        stack: detected.stack,
        forbiddenRoutes: featureScope.forbiddenRoutes.length,
        missingRequiredRoutes: featureScope.missingRequiredRoutes.length,
      },
    });
    process.stdout.write(`  feature-scope…  ${featureScopePass ? pc.green("✓") : pc.red("✗")}\n`);

    // ── Command gates (ecosystem-aware) ──
    const ecosystemGates = gatesForEcosystem(detected.ecosystem);
    if (ecosystemGates && options.install !== false) {
      if (!skipSet.has("install") && ecosystemGates.install) {
        gates.push(await step("install", "install deps", templateRoot,
          ecosystemGates.install.command, ecosystemGates.install.args, ecosystemGates.install.timeoutMs));
      }
      if (!skipSet.has("typecheck") && ecosystemGates.typecheck) {
        gates.push(await step("typecheck", "typecheck", templateRoot,
          ecosystemGates.typecheck.command, ecosystemGates.typecheck.args, ecosystemGates.typecheck.timeoutMs));
      }
      if (!skipSet.has("lint") && ecosystemGates.lint) {
        gates.push(await step("lint", "lint", templateRoot,
          ecosystemGates.lint.command, ecosystemGates.lint.args, ecosystemGates.lint.timeoutMs,
          strictLintPostProcess));
      }
      if (!skipSet.has("test") && ecosystemGates.test) {
        gates.push(await step("test", "test", templateRoot,
          ecosystemGates.test.command, ecosystemGates.test.args, ecosystemGates.test.timeoutMs));
      }
      if (!skipSet.has("build") && ecosystemGates.build) {
        gates.push(await step("build", "build", templateRoot,
          ecosystemGates.build.command, ecosystemGates.build.args, ecosystemGates.build.timeoutMs));
      }
      if (!skipSet.has("audit") && ecosystemGates.audit) {
        gates.push(await step("audit", "audit", templateRoot,
          ecosystemGates.audit.command, ecosystemGates.audit.args, ecosystemGates.audit.timeoutMs));
      }
    } else if (!ecosystemGates) {
      const skipped: GateResult = {
        id: "ecosystem",
        name: `Ecosystem '${detected.ecosystem}' adapter not yet implemented — Phase 2 specialists must run command gates inline`,
        status: "SKIPPED",
        durationMs: 0,
      };
      gates.push(skipped);
      process.stdout.write(pc.yellow(`  command gates…  · skipped (${detected.ecosystem})\n`));
    }

    // ── Compose evidence ──
    const findings = deriveFindings({
      gates,
      zipInspection,
      contentScan: contentRes,
      versionCheck,
      structuralCheck: structural,
      complianceScan: compliance,
      featureScopeScan: featureScope,
      tier,
      isBaseTemplate,
    });
    const counts = countGates(gates);
    const pCounts = countFindings(findings);

    const evidence: Evidence = {
      version: "1.1.0",
      template: {
        zipPath: resolvedZip,
        zipName: basename(resolvedZip),
        zipSizeBytes,
        sha256,
        extractedAt: new Date().toISOString(),
        packageName,
        packageVersion,
        stack: detected.stack,
        ecosystem: detected.ecosystem,
        tier,
        slug,
        productFamilySlug: productFamilySlug ?? undefined,
        productSlug: productSlug ?? undefined,
      },
      environment: {
        node: process.version,
        pnpm: (await tryExec("pnpm", ["--version"])) ?? undefined,
        platform: `${process.platform} ${process.arch}`,
        runAt: new Date().toISOString(),
      },
      gates,
      zipInspection,
      contentScan: contentRes,
      versionCheck,
      structuralCheck: structural,
      complianceScan: compliance,
      featureScopeScan: featureScope,
      conformance: conformance ?? undefined,
      findings,
      summary: {
        totalGates: gates.length,
        passed: counts.pass,
        failed: counts.fail,
        errored: counts.error,
        skipped: counts.skipped,
        p0: pCounts.P0,
        p1: pCounts.P1,
        p2: pCounts.P2,
        p3: pCounts.P3,
        overall:
          counts.fail === 0 && counts.error === 0 && pCounts.P0 === 0 && pCounts.P1 === 0
            ? "PASS"
            : "FAIL",
      },
    };

    const runSlug = `${slug}-${packageVersion ?? new Date().toISOString().slice(0, 10)}`
      .replace(/[^a-zA-Z0-9.-]/g, "_");
    const outBase = resolve(options.out, runSlug);
    writeEvidenceJson(join(outBase, "evidence.json"), evidence);
    writeMarkdown(join(outBase, "report.md"), renderMarkdownReport(evidence));

    console.log("");
    console.log(pc.bold("Phase 1 summary:"));
    console.log(`  Gates:    ${pc.green(`${counts.pass} PASS`)}  ${pc.red(`${counts.fail} FAIL`)}  ${counts.error} ERR  ${counts.skipped} SKIP`);
    console.log(`  Findings: P0=${pc.red(String(pCounts.P0))}  P1=${pc.yellow(String(pCounts.P1))}  P2=${pCounts.P2}  P3=${pCounts.P3}`);
    console.log(`  Versions: zip=${versionCheck.zipFilenameVersion ?? "-"}  manifest=${versionCheck.packageVersion ?? "-"}  changelog=${versionCheck.changelogTopVersion ?? "-"}`);
    const overallColour = evidence.summary.overall === "PASS" ? pc.green : pc.red;
    console.log(`  Overall:  ${overallColour(pc.bold(evidence.summary.overall))}`);
    console.log("");
    console.log(pc.gray(`Evidence:  ${join(outBase, "evidence.json")}`));
    console.log(pc.gray(`Report:    ${join(outBase, "report.md")}`));

    console.log("");
    console.log(pc.cyan("Next: run Phase 2 LLM review via the Claude Code skill:"));
    console.log(pc.gray(`  In Claude Code, invoke the te-verify-fullstack-review skill with the release tag`));
    console.log(pc.gray(`  (e.g. "review tl01 v1.0.0") or hand it this ZIP path / template directory.`));

    if (!options.keepTemp) {
      cleanup(extractRoot);
    } else {
      console.log(pc.gray(`\nKept temp dir: ${extractRoot}`));
    }

    process.exit(evidence.summary.overall === "PASS" ? 0 : 1);
  });

interface CliOptions {
  out: string;
  keepTemp: boolean;
  skip: string;
  slug: string;
  install: boolean;
}

async function step(
  id: string,
  display: string,
  cwd: string,
  command: string,
  args: string[],
  timeoutMs: number,
  postProcess?: (r: GateResult) => GateResult,
): Promise<GateResult> {
  process.stdout.write(pc.gray(`  ${display}… `));

  // Pre-flight: when the gate is invoking `pnpm <script>` / `npm run <script>` /
  // `yarn <script>` and the package.json doesn't declare that script, mark the
  // gate SKIPPED rather than running it. Without this guard, the shell falls
  // through to the binary on PATH (e.g. `test` → Bash builtin) and reports
  // a confusing FAIL like `'--': unary operator expected`.
  const scriptName = scriptNameForCommand(command, args);
  if (scriptName && !packageHasScript(cwd, scriptName)) {
    const skipped: GateResult = {
      id,
      name: display,
      status: "SKIPPED",
      command: `${command} ${args.join(" ")}`,
      durationMs: 0,
      stderrTail: `package.json has no \`${scriptName}\` script`,
    };
    const dur = `(${(skipped.durationMs / 1000).toFixed(1)}s)`;
    process.stdout.write(`${pc.gray("·")} ${pc.gray(dur)}${pc.gray(" [skipped: no script]")}\n`);
    return skipped;
  }

  const result = await runCommandGate({
    id, name: display, cwd, command, args, timeoutMs, postProcess,
  });
  const icon =
    result.status === "PASS"    ? pc.green("✓")
    : result.status === "FAIL"  ? pc.red("✗")
    : result.status === "ERROR" ? pc.yellow("!")
    :                             pc.gray("·");
  const dur = `(${(result.durationMs / 1000).toFixed(1)}s)`;
  const suffix = result.name !== display ? pc.gray(` [${result.name.replace(display, "").trim()}]`) : "";
  process.stdout.write(`${icon} ${pc.gray(dur)}${suffix}\n`);
  return result;
}

/**
 * If `command + args` invokes a package.json script, return the script name.
 * Returns null for commands that aren't script-shaped (e.g. `pnpm install`,
 * `pnpm audit`, `npx tsc`).
 */
function scriptNameForCommand(command: string, args: string[]): string | null {
  // pnpm <script> [-- ...]
  if (command === "pnpm" || command === "npm" || command === "yarn") {
    const first = args[0];
    if (!first) return null;
    // Built-ins, never package.json scripts.
    const builtins = new Set([
      "install", "i", "add", "remove", "update", "audit", "exec", "run", "dlx",
      "outdated", "list", "ls", "publish", "pack", "store", "fetch", "rebuild",
    ]);
    if (builtins.has(first)) {
      // `pnpm run <script>` — the script name is the next arg.
      if (first === "run" && args[1]) return args[1];
      return null;
    }
    return first;
  }
  return null;
}

function packageHasScript(cwd: string, scriptName: string): boolean {
  try {
    const raw = readFileSync(join(cwd, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    return Boolean(pkg.scripts && pkg.scripts[scriptName]);
  } catch {
    return false;
  }
}

async function tryExec(cmd: string, args: string[]): Promise<string | null> {
  try {
    const r = await execa(cmd, args, { reject: false });
    return r.exitCode === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

function countGates(gates: GateResult[]) {
  return {
    pass: gates.filter((g) => g.status === "PASS").length,
    fail: gates.filter((g) => g.status === "FAIL").length,
    error: gates.filter((g) => g.status === "ERROR").length,
    skipped: gates.filter((g) => g.status === "SKIPPED").length,
  };
}

function countFindings(findings: { priority: string }[]) {
  return {
    P0: findings.filter((f) => f.priority === "P0").length,
    P1: findings.filter((f) => f.priority === "P1").length,
    P2: findings.filter((f) => f.priority === "P2").length,
    P3: findings.filter((f) => f.priority === "P3").length,
  };
}

program.parseAsync().catch((err) => {
  console.error(pc.red(`\nUnexpected error: ${err instanceof Error ? err.message : String(err)}`));
  if (err instanceof Error && err.stack) console.error(pc.gray(err.stack));
  process.exit(3);
});
