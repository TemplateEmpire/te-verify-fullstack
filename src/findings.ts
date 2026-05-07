import { VERSION_PRIORITY } from "./version-check.js";
import type {
  ComplianceScan,
  ContentScan,
  FeatureScopeScan,
  Finding,
  GateResult,
  Priority,
  StructuralCheck,
  VersionCheck,
  ZipInspection,
} from "./types.js";

/**
 * Deterministic P0/P1/P2/P3 mapping. Same triage discipline as te-verify;
 * fullstack-specific findings layered on top via structural and compliance scans.
 */
export function deriveFindings(input: {
  gates: GateResult[];
  zipInspection: ZipInspection;
  contentScan: ContentScan;
  versionCheck: VersionCheck;
  structuralCheck: StructuralCheck;
  complianceScan: ComplianceScan;
  featureScopeScan: FeatureScopeScan;
  tier: string;
  isBaseTemplate: boolean;
}): Finding[] {
  const findings: Finding[] = [];
  let counter = 0;
  const nextId = (): string => `F-${String(++counter).padStart(3, "0")}`;

  // ── Gate failures ──
  for (const g of input.gates) {
    if (g.status === "FAIL" || g.status === "ERROR") {
      findings.push({
        id: nextId(),
        priority: gatePriority(g.id),
        category: "Phase Gate",
        message: `${g.name} (${g.status})`,
        evidence: truncate(g.stderrTail ?? g.stdoutTail ?? ""),
      });
    }
  }

  // ── Packaging ──
  for (const p of input.zipInspection.forbiddenFound) {
    findings.push({ id: nextId(), priority: "P0", category: "Packaging",
      message: `Forbidden path in ZIP: ${p}` });
  }
  for (const f of input.zipInspection.missingRequired) {
    findings.push({ id: nextId(), priority: "P0", category: "Packaging",
      message: `Required file missing: ${f}` });
  }
  for (const d of input.zipInspection.missingDirs) {
    findings.push({ id: nextId(), priority: "P0", category: "Packaging",
      message: `Required directory missing: ${d}` });
  }
  if (input.zipInspection.sizeBytes > 50 * 1024 * 1024) {
    findings.push({ id: nextId(), priority: "P1", category: "Packaging",
      message: `ZIP size ${mb(input.zipInspection.sizeBytes)} exceeds 50 MB threshold` });
  }
  if (input.zipInspection.extremeEntryCount === "too-few") {
    findings.push({ id: nextId(), priority: "P0", category: "Packaging",
      message: `ZIP has only ${input.zipInspection.entryCount} entries — looks incomplete` });
  } else if (input.zipInspection.extremeEntryCount === "too-many") {
    findings.push({ id: nextId(), priority: "P1", category: "Packaging",
      message: `ZIP has ${input.zipInspection.entryCount} entries — unusually large, verify nothing leaked` });
  }

  // ── Content integrity ──
  for (const f of input.contentScan.bomFiles) {
    findings.push({ id: nextId(), priority: "P0", category: "Content",
      message: `UTF-8 BOM detected: ${f}` });
  }
  for (const f of input.contentScan.mojibakeFiles) {
    findings.push({ id: nextId(), priority: "P0", category: "Content",
      message: `Mojibake byte sequence: ${f}` });
  }
  for (const s of input.contentScan.secrets) {
    findings.push({ id: nextId(), priority: "P0", category: "Security",
      message: `Possible secret: ${s.match}`, evidence: `${s.file}:${s.line}` });
  }
  for (const v of input.contentScan.realVendorsInLegal) {
    findings.push({ id: nextId(), priority: "P0", category: "Content",
      message: `Real vendor name in legal page: ${v.match}`, evidence: `${v.file}:${v.line}` });
  }

  // ── Version consistency ──
  for (const issue of input.versionCheck.issues) {
    findings.push({ id: nextId(), priority: VERSION_PRIORITY[issue.kind],
      category: "Versioning", message: issue.message });
  }

  // ── Structural (full-stack only) ──
  const sc = input.structuralCheck;
  if (!sc.composePresent) {
    findings.push({ id: nextId(), priority: "P1", category: "Structural",
      message: "No docker-compose.*.yml found — buyer cannot follow standard demo bootstrap" });
  }
  for (const err of sc.composeParseErrors) {
    findings.push({ id: nextId(), priority: "P1", category: "Structural",
      message: `docker-compose parse issue: ${err}` });
  }
  if (!sc.envExamplePresent) {
    findings.push({ id: nextId(), priority: "P0", category: "Structural",
      message: ".env.example missing — buyer has no template for environment configuration" });
  }
  if (sc.envVarsUnused.length > 0) {
    findings.push({ id: nextId(), priority: "P2", category: "Structural",
      message: `${sc.envVarsUnused.length} env var(s) documented in .env.example are not referenced in source: ${sc.envVarsUnused.slice(0, 5).join(", ")}${sc.envVarsUnused.length > 5 ? ", …" : ""}` });
  }
  if (!sc.migrationsPresent && !input.isBaseTemplate) {
    findings.push({ id: nextId(), priority: "P1", category: "Structural",
      message: "No migrations directory or migrations are empty — non-base templates need an initial schema" });
  }
  if (!sc.seedPresent && !input.isBaseTemplate) {
    findings.push({ id: nextId(), priority: "P1", category: "Structural",
      message: "No seed script found — buyer simulation test will fail without demo data" });
  }
  if (!sc.licenceValidatorPresent) {
    findings.push({ id: nextId(), priority: "P0", category: "Licence",
      message: "No licence validator script found (scripts/validate-licence.{mjs,js,ts,py,rb})" });
  }
  if (sc.licenceValidatorPresent && !sc.licencePlaceholderPresent) {
    findings.push({ id: nextId(), priority: "P0", category: "Licence",
      message: "licence.json missing or contains a non-placeholder key (must ship as TE-XXXX-XXXX-XXXX)" });
  }

  // ── Compliance (Gate 17) ──
  const cs = input.complianceScan;
  for (const [route, present] of Object.entries(cs.routesFound) as Array<[string, boolean]>) {
    if (!present) {
      const required = ["privacy", "terms", "cookiePolicy", "accessibility"];
      const usOnly = ["dmca", "doNotSell"];
      const priority: Priority = required.includes(route) ? "P1" :
                                 usOnly.includes(route) ? "P3" : "P2";
      findings.push({ id: nextId(), priority, category: "Compliance",
        message: `Compliance route /${route} not found in source` });
    }
  }
  if (!cs.siteConfigFields.legalEntity) {
    findings.push({ id: nextId(), priority: "P1", category: "Compliance",
      message: "SITE_CONFIG.legalEntity not found — registered-entity disclosures cannot render" });
  }
  if (!cs.siteConfigFields.regions) {
    findings.push({ id: nextId(), priority: "P1", category: "Compliance",
      message: "SITE_CONFIG.regions not found — region-conditional links cannot gate properly" });
  }
  if (!cs.siteConfigFields.compliance) {
    findings.push({ id: nextId(), priority: "P1", category: "Compliance",
      message: "SITE_CONFIG.compliance block not found (dmca/ccpa/modernSlavery)" });
  }
  if (!cs.siteConfigFields.cookieConsent) {
    findings.push({ id: nextId(), priority: "P1", category: "Compliance",
      message: "SITE_CONFIG.cookieConsent block not found (categories/version/gpc)" });
  }
  if (!cs.complianceDocPresent) {
    findings.push({ id: nextId(), priority: "P2", category: "Compliance",
      message: "COMPLIANCE.md missing at template root — buyer-facing scaffold map" });
  }
  if (!cs.cookieConsentPresent) {
    findings.push({ id: nextId(), priority: "P0", category: "Compliance",
      message: "No cookie-consent component found — required for EU/UK/US compliance" });
  } else {
    if (!cs.cookieConsentRejectAll) {
      findings.push({ id: nextId(), priority: "P0", category: "Compliance",
        message: "Cookie-consent component lacks Reject-All at parity with Accept-All (ePrivacy parity rule)" });
    }
    if (!cs.cookieConsentGpcHandled) {
      findings.push({ id: nextId(), priority: "P1", category: "Compliance",
        message: "Cookie consent does not honour navigator.globalPrivacyControl (US state-privacy rule)" });
    }
  }
  if (cs.privacyRightsCount < 7) {
    findings.push({ id: nextId(), priority: "P2", category: "Compliance",
      message: `Privacy page enumerates only ${cs.privacyRightsCount}/7 GDPR rights individually` });
  }
  if (!cs.privacyDntDisclosure) {
    findings.push({ id: nextId(), priority: "P2", category: "Compliance",
      message: "Privacy page lacks Do Not Track / Global Privacy Control disclosure (CalOPPA)" });
  }
  for (const surface of cs.aiSurfacesMissingDisclosure) {
    findings.push({ id: nextId(), priority: "P1", category: "Compliance",
      message: `AI surface ${surface} lacks visible AI-generated disclosure (EU AI Act)` });
  }
  for (const offender of cs.preCheckedMarketingConsent) {
    findings.push({ id: nextId(), priority: "P1", category: "Compliance",
      message: `Pre-checked marketing/consent input found: ${offender} (GDPR/UK GDPR Art 4(11) requires affirmative action)` });
  }

  // ── Feature scope (template-family contract) ──
  const fs = input.featureScopeScan;
  for (const offender of fs.forbiddenRoutes) {
    findings.push({ id: nextId(), priority: "P1", category: "Feature Scope",
      message: `${offender.route} should not ship for TL${fs.familyId ?? "??"} (${fs.expectedCommerce}) — ${offender.reason}`,
      evidence: offender.path });
  }
  for (const missing of fs.missingRequiredRoutes) {
    findings.push({ id: nextId(), priority: "P1", category: "Feature Scope",
      message: `${missing.route} is required for TL${fs.familyId ?? "??"} (${fs.expectedCommerce}) — ${missing.reason}` });
  }

  // ── Lint strict ──
  const lintGate = input.gates.find((g) => g.id === "lint");
  if (lintGate?.metadata) {
    const errors = Number(lintGate.metadata.lintErrors ?? 0);
    const warnings = Number(lintGate.metadata.lintWarnings ?? 0);
    if (errors > 0) {
      findings.push({ id: nextId(), priority: "P1", category: "Lint",
        message: `${errors} lint error(s) — zero tolerance per quality gate` });
    }
    if (warnings > 0) {
      findings.push({ id: nextId(), priority: "P1", category: "Lint",
        message: `${warnings} lint warning(s) — zero tolerance per quality gate` });
    }
  }

  return findings;
}

function gatePriority(gateId: string): Priority {
  const p0Gates = new Set([
    "install", "build", "audit",
    "zip-inspect", "content-scan", "version-check",
  ]);
  if (gateId === "feature-scope") return "P1";
  if (p0Gates.has(gateId)) return "P0";
  return "P1";
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function truncate(s: string, max = 500): string {
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
