import { z } from "zod";

// Stacks that ship as full-stack templates. NJS is the launch wave; the rest
// are scheduled. Adapters that aren't yet wired return SKIPPED gates with a
// "stack not yet implemented" message rather than crashing.
export const StackSchema = z.enum([
  "nextjs",        // NJS — Next.js App Router (launch wave)
  "nestjs",        // NST — NestJS API + admin
  "express",       // EXP — Express + React/Vue
  "remix",         // RMX — Remix
  "sveltekit",     // SKT — SvelteKit
  "nuxt",          // NXT — Nuxt
  "astro",         // AST — Astro
  "laravel",       // LRV — Laravel (PHP)
  "django",        // DJG — Django (Python)
  "fastapi",       // FAP — FastAPI (Python)
  "rails",         // RLS — Rails (Ruby)
  "aspnet",        // ASP — ASP.NET (.NET)
  "spring",        // SPR — Spring Boot (Java)
  "phoenix",       // PHX — Phoenix (Elixir)
  "unknown",
]);
export type Stack = z.infer<typeof StackSchema>;

export const StackEcosystemSchema = z.enum([
  "node",
  "php",
  "python",
  "ruby",
  "dotnet",
  "java",
  "elixir",
  "unknown",
]);
export type StackEcosystem = z.infer<typeof StackEcosystemSchema>;

export const TierSchema = z.enum(["TL", "TP", "TX", "unknown"]);
export type Tier = z.infer<typeof TierSchema>;

export const GateStatusSchema = z.enum(["PASS", "FAIL", "SKIPPED", "ERROR"]);
export type GateStatus = z.infer<typeof GateStatusSchema>;

export const PrioritySchema = z.enum(["P0", "P1", "P2", "P3"]);
export type Priority = z.infer<typeof PrioritySchema>;

export const GateResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: GateStatusSchema,
  command: z.string().optional(),
  exitCode: z.number().optional(),
  durationMs: z.number(),
  stdoutTail: z.string().optional(),
  stderrTail: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type GateResult = z.infer<typeof GateResultSchema>;

export const FindingSchema = z.object({
  id: z.string(),
  priority: PrioritySchema,
  category: z.string(),
  message: z.string(),
  evidence: z.string().optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const ZipInspectionSchema = z.object({
  forbiddenFound: z.array(z.string()),
  missingRequired: z.array(z.string()),
  missingDirs: z.array(z.string()),
  sizeBytes: z.number(),
  entryCount: z.number(),
  extremeEntryCount: z.enum(["too-few", "too-many"]).nullable(),
});
export type ZipInspection = z.infer<typeof ZipInspectionSchema>;

export const ContentScanSchema = z.object({
  bomFiles: z.array(z.string()),
  mojibakeFiles: z.array(z.string()),
  secrets: z.array(
    z.object({ file: z.string(), line: z.number(), match: z.string() }),
  ),
  realVendorsInLegal: z.array(
    z.object({ file: z.string(), line: z.number(), match: z.string() }),
  ),
});
export type ContentScan = z.infer<typeof ContentScanSchema>;

export const VersionIssueKindSchema = z.enum([
  "filename-no-version",
  "filename-mismatch",
  "changelog-missing",
  "changelog-no-version-found",
  "changelog-mismatch",
  "changelog-lag",
  "package-missing",
]);
export type VersionIssueKind = z.infer<typeof VersionIssueKindSchema>;

export const VersionCheckSchema = z.object({
  packageVersion: z.string().nullable(),
  zipFilenameVersion: z.string().nullable(),
  changelogTopVersion: z.string().nullable(),
  changelogTopDate: z.string().nullable(),
  issues: z.array(
    z.object({
      kind: VersionIssueKindSchema,
      message: z.string(),
    }),
  ),
});
export type VersionCheck = z.infer<typeof VersionCheckSchema>;

// ── Full-stack-specific structural checks ──────────────────────────────

export const StructuralCheckSchema = z.object({
  // Docker compose: at least one of demo/prod docker-compose files parses cleanly
  composePresent: z.boolean(),
  composeFiles: z.array(z.string()),
  composeParseErrors: z.array(z.string()),
  // .env.example exists and every documented var is referenced in source
  envExamplePresent: z.boolean(),
  envVarsDocumented: z.number(),
  envVarsUnused: z.array(z.string()),
  // Migrations directory non-empty (TL00-BASE may be empty; non-base templates should have at least one)
  migrationsPresent: z.boolean(),
  migrationsCount: z.number(),
  // Seed script for the demo flow (db/seed.{ts,js,py,rb} or framework-specific)
  seedPresent: z.boolean(),
  seedPath: z.string().nullable(),
  // Licence validator + placeholder licence.json
  licenceValidatorPresent: z.boolean(),
  licencePlaceholderPresent: z.boolean(),
});
export type StructuralCheck = z.infer<typeof StructuralCheckSchema>;

// ── Gate 17 — UK / EU / US compliance scaffold ─────────────────────────

export const ComplianceScanSchema = z.object({
  // Required compliance routes (resolves source path patterns)
  routesFound: z.object({
    privacy: z.boolean(),
    terms: z.boolean(),
    cookiePolicy: z.boolean(),
    accessibility: z.boolean(),
    dmca: z.boolean(),
    doNotSell: z.boolean(),
  }),
  // SITE_CONFIG schema fields
  siteConfigFields: z.object({
    legalEntity: z.boolean(),
    regions: z.boolean(),
    compliance: z.boolean(),
    cookieConsent: z.boolean(),
  }),
  // COMPLIANCE.md at repo root
  complianceDocPresent: z.boolean(),
  // Cookie consent component with Accept-all + Reject-all parity
  cookieConsentPresent: z.boolean(),
  cookieConsentRejectAll: z.boolean(),
  cookieConsentGpcHandled: z.boolean(),
  // Privacy page enumerates GDPR rights
  privacyRightsCount: z.number(),
  privacyDntDisclosure: z.boolean(),
  // AI disclosure on AI-bearing surfaces
  aiSurfacesScanned: z.array(z.string()),
  aiSurfacesMissingDisclosure: z.array(z.string()),
  // Marketing consent NOT pre-checked
  preCheckedMarketingConsent: z.array(z.string()),
});
export type ComplianceScan = z.infer<typeof ComplianceScanSchema>;

// ── Template-family feature scope ───────────────────────────────────────────

export const FeatureScopeScanSchema = z.object({
  familyId: z.string().nullable(),
  expectedCommerce: z.enum(["subscription", "none", "payment", "marketplace", "unknown"]),
  forbiddenRoutes: z.array(
    z.object({
      route: z.string(),
      path: z.string(),
      reason: z.string(),
    }),
  ),
  missingRequiredRoutes: z.array(
    z.object({
      route: z.string(),
      reason: z.string(),
    }),
  ),
});
export type FeatureScopeScan = z.infer<typeof FeatureScopeScanSchema>;

export const EvidenceSchema = z.object({
  version: z.literal("1.0.0"),
  template: z.object({
    zipPath: z.string(),
    zipName: z.string(),
    zipSizeBytes: z.number(),
    sha256: z.string(),
    extractedAt: z.string(),
    packageName: z.string().optional(),
    packageVersion: z.string().optional(),
    stack: StackSchema,
    ecosystem: StackEcosystemSchema,
    tier: TierSchema,
    slug: z.string().optional(),
  }),
  environment: z.object({
    node: z.string(),
    pnpm: z.string().optional(),
    platform: z.string(),
    runAt: z.string(),
  }),
  gates: z.array(GateResultSchema),
  zipInspection: ZipInspectionSchema,
  contentScan: ContentScanSchema,
  versionCheck: VersionCheckSchema,
  structuralCheck: StructuralCheckSchema,
  complianceScan: ComplianceScanSchema,
  featureScopeScan: FeatureScopeScanSchema,
  findings: z.array(FindingSchema),
  summary: z.object({
    totalGates: z.number(),
    passed: z.number(),
    failed: z.number(),
    skipped: z.number(),
    errored: z.number(),
    p0: z.number(),
    p1: z.number(),
    p2: z.number(),
    p3: z.number(),
    overall: z.enum(["PASS", "FAIL"]),
  }),
});
export type Evidence = z.infer<typeof EvidenceSchema>;
