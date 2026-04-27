import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Evidence } from "./types.js";

export function writeEvidenceJson(outPath: string, evidence: Evidence): void {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(evidence, null, 2));
}

export function writeMarkdown(outPath: string, content: string): void {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, content);
}

export function renderMarkdownReport(e: Evidence): string {
  const L: string[] = [];
  const {
    template,
    environment,
    gates,
    findings,
    summary,
    zipInspection,
    contentScan,
    versionCheck,
    structuralCheck,
    complianceScan,
  } = e;

  L.push(`# TE-Verify Fullstack Report`);
  L.push("");
  L.push(`**ZIP:** \`${template.zipName}\` (${mb(template.zipSizeBytes)}, ${zipInspection.entryCount} entries)`);
  L.push(`**Package:** ${template.packageName ?? "(unknown)"} v${template.packageVersion ?? "?"}`);
  L.push(`**Stack:** ${template.stack} (${template.ecosystem})  **Tier:** ${template.tier}${template.slug ? `  **Slug:** ${template.slug}` : ""}`);
  L.push(`**SHA256:** \`${template.sha256}\``);
  L.push(`**Run at:** ${environment.runAt} on ${environment.platform}`);
  L.push(`**Node:** ${environment.node}${environment.pnpm ? ` | **pnpm:** ${environment.pnpm}` : ""}`);
  L.push("");
  L.push(`## Overall: ${summary.overall === "PASS" ? "PASS" : "FAIL"}`);
  L.push("");
  L.push(`| Metric | Value |`);
  L.push(`| --- | --- |`);
  L.push(`| Gates passed | ${summary.passed} / ${summary.totalGates} |`);
  L.push(`| Gates failed | ${summary.failed} |`);
  L.push(`| Gates errored | ${summary.errored} |`);
  L.push(`| Gates skipped | ${summary.skipped} |`);
  L.push(`| Findings — P0 | **${summary.p0}** |`);
  L.push(`| Findings — P1 | ${summary.p1} |`);
  L.push(`| Findings — P2 | ${summary.p2} |`);
  L.push(`| Findings — P3 | ${summary.p3} |`);
  L.push("");

  L.push(`## Version consistency`);
  L.push("");
  L.push(`| Source | Version |`);
  L.push(`| --- | --- |`);
  L.push(`| ZIP filename | ${versionCheck.zipFilenameVersion ?? "_(no \`-v{semver}\` token)_"} |`);
  L.push(`| Manifest | ${versionCheck.packageVersion ?? "_(not found)_"} |`);
  L.push(`| CHANGELOG.md top entry | ${versionCheck.changelogTopVersion ?? "_(not found)_"}${versionCheck.changelogTopDate ? ` — ${versionCheck.changelogTopDate}` : ""} |`);
  L.push("");

  L.push(`## Structural`);
  L.push("");
  L.push(`- docker-compose: ${structuralCheck.composePresent ? `present (${structuralCheck.composeFiles.join(", ")})` : "**MISSING**"}`);
  L.push(`- .env.example: ${structuralCheck.envExamplePresent ? `present (${structuralCheck.envVarsDocumented} vars; ${structuralCheck.envVarsUnused.length} unused)` : "**MISSING**"}`);
  L.push(`- Migrations: ${structuralCheck.migrationsPresent ? `${structuralCheck.migrationsCount} present` : "**none found**"}`);
  L.push(`- Seed: ${structuralCheck.seedPresent ? `\`${structuralCheck.seedPath}\`` : "**none found**"}`);
  L.push(`- Licence validator: ${structuralCheck.licenceValidatorPresent ? "present" : "**missing**"}`);
  L.push(`- Licence placeholder: ${structuralCheck.licencePlaceholderPresent ? "TE-XXXX-XXXX-XXXX" : "**missing or replaced with real key**"}`);
  L.push("");

  L.push(`## Compliance (Gate 17)`);
  L.push("");
  L.push(`- COMPLIANCE.md: ${complianceScan.complianceDocPresent ? "present" : "**missing**"}`);
  L.push(`- Routes: privacy=${b(complianceScan.routesFound.privacy)} terms=${b(complianceScan.routesFound.terms)} cookies=${b(complianceScan.routesFound.cookiePolicy)} a11y=${b(complianceScan.routesFound.accessibility)} dmca=${b(complianceScan.routesFound.dmca)} doNotSell=${b(complianceScan.routesFound.doNotSell)}`);
  L.push(`- SITE_CONFIG: legalEntity=${b(complianceScan.siteConfigFields.legalEntity)} regions=${b(complianceScan.siteConfigFields.regions)} compliance=${b(complianceScan.siteConfigFields.compliance)} cookieConsent=${b(complianceScan.siteConfigFields.cookieConsent)}`);
  L.push(`- Cookie consent: present=${b(complianceScan.cookieConsentPresent)} reject-all=${b(complianceScan.cookieConsentRejectAll)} GPC-handled=${b(complianceScan.cookieConsentGpcHandled)}`);
  L.push(`- Privacy: GDPR-rights=${complianceScan.privacyRightsCount}/7 DNT/GPC-disclosed=${b(complianceScan.privacyDntDisclosure)}`);
  if (complianceScan.aiSurfacesMissingDisclosure.length > 0) {
    L.push(`- AI surfaces missing "AI-generated" disclosure: ${complianceScan.aiSurfacesMissingDisclosure.length}`);
  }
  if (complianceScan.preCheckedMarketingConsent.length > 0) {
    L.push(`- Pre-checked marketing consent offenders: ${complianceScan.preCheckedMarketingConsent.length}`);
  }
  L.push("");

  L.push(`## Gates`);
  L.push("");
  for (const g of gates) {
    const icon =
      g.status === "PASS"    ? "PASS "
      : g.status === "FAIL"  ? "FAIL "
      : g.status === "ERROR" ? "ERR  "
      :                        "SKIP ";
    const dur = g.durationMs > 0 ? ` (${(g.durationMs / 1000).toFixed(1)}s)` : "";
    L.push(`- ${icon} \`${g.id}\` — ${g.name}${dur}`);
  }
  L.push("");

  if (findings.length > 0) {
    L.push(`## Findings`);
    L.push("");
    const byPriority: Record<string, typeof findings> = { P0: [], P1: [], P2: [], P3: [] };
    for (const f of findings) byPriority[f.priority].push(f);
    for (const pri of ["P0", "P1", "P2", "P3"] as const) {
      const rows = byPriority[pri];
      if (rows.length === 0) continue;
      L.push(`### ${pri} (${rows.length})`);
      L.push("");
      for (const f of rows) {
        L.push(`- **[${f.category}]** ${f.message}${f.evidence ? ` — \`${truncate(f.evidence, 120)}\`` : ""}`);
      }
      L.push("");
    }
  } else {
    L.push(`## Findings`);
    L.push("");
    L.push(`None. Clean run.`);
    L.push("");
  }

  L.push(`## Raw evidence summaries`);
  L.push("");
  L.push(`**ZIP inspection:** ${zipInspection.entryCount} entries, forbidden=${zipInspection.forbiddenFound.length}, missing=${zipInspection.missingRequired.length}, missingDirs=${zipInspection.missingDirs.length}${zipInspection.extremeEntryCount ? `, extreme=${zipInspection.extremeEntryCount}` : ""}`);
  L.push(`**Content scan:** bom=${contentScan.bomFiles.length}, mojibake=${contentScan.mojibakeFiles.length}, secrets=${contentScan.secrets.length}, realVendors=${contentScan.realVendorsInLegal.length}`);
  L.push(`**Version issues:** ${versionCheck.issues.length}`);
  L.push("");
  L.push(`_Full structured evidence in \`evidence.json\`. For Phase 2 LLM review, invoke the te-verify-fullstack-review skill in Claude Code._`);

  return L.join("\n");
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function b(v: boolean): string { return v ? "✓" : "✗"; }
