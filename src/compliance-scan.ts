import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { ComplianceScan } from "./types.js";

/**
 * Gate 17 deterministic checks. Mirrors the UI mechanical-review §20 but
 * adapted for full-stack templates (real cookies, real DB, real billing).
 *
 * Every check is filesystem + grep — no command execution. Findings here flow
 * into the Phase 2 specialists as known facts, not re-discoveries.
 */
export function complianceScan(templateRoot: string): ComplianceScan {
  const haystack = collectScannableText(templateRoot);

  return {
    routesFound: detectRoutes(templateRoot),
    siteConfigFields: detectSiteConfigFields(templateRoot, haystack),
    complianceDocPresent: existsSync(join(templateRoot, "COMPLIANCE.md")),
    cookieConsentPresent: hasCookieConsentComponent(haystack),
    cookieConsentRejectAll: hasRejectAllAtParity(haystack),
    cookieConsentGpcHandled: /navigator\.globalPrivacyControl/.test(haystack),
    privacyRightsCount: countGdprRights(templateRoot),
    privacyDntDisclosure: hasDntDisclosure(templateRoot),
    aiSurfacesScanned: [],
    aiSurfacesMissingDisclosure: detectAiSurfacesMissingDisclosure(templateRoot),
    preCheckedMarketingConsent: detectPreCheckedConsent(templateRoot),
  };
}

// ── helpers ───────────────────────────────────────────────────────────

const SCAN_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".astro", ".svelte", ".vue",
  ".py", ".rb", ".php", ".cs", ".java", ".ex", ".exs",
  ".html", ".erb", ".blade.php", ".html.heex", ".md"]);
const SKIP = new Set(["node_modules", ".git", ".next", ".nuxt", ".svelte-kit",
  ".output", "dist", "out", "build", "vendor", "venv", ".venv",
  "__pycache__", "target", "bin", "obj", "_build", "deps"]);

function collectScannableText(root: string): string {
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
        try { chunks.push(`<<FILE:${full}>>\n${readFileSync(full, "utf8")}`); }
        catch { /* skip */ }
      }
    }
  };
  walk(root);
  return chunks.join("\n");
}

function safeReadFiles(dir: string): string[] {
  try { return readdirSync(dir).filter((n) => !n.startsWith(".")); }
  catch { return []; }
}

/**
 * Probe Next.js App Router route groups for a given route slug.
 *
 * Route groups are directories named with parentheses — `app/(marketing)`,
 * `app/(legal)`, `app/(auth)` — and are routing-invisible (the parens segment
 * is removed from the URL). So `app/(marketing)/privacy/page.tsx` serves at
 * `/privacy` exactly like `app/privacy/page.tsx` does, and a Gate 17 grep
 * that only checks the unprefixed path emits a false negative.
 *
 * We scan one level deep under both `app/` and `src/app/` for any `(group)`
 * dir, then check for `(group)/<slug>/page.{tsx,ts,jsx,js}` underneath.
 * Groups can be nested (`app/(group)/(subgroup)/...`) but that pattern is
 * vanishingly rare for legal pages — single-level coverage handles 99% of
 * real templates without a recursive walk.
 */
function probeAppRouterRouteGroups(templateRoot: string, slug: string): boolean {
  const appDirs = ['src/app', 'app'];
  const pageExts = ['tsx', 'ts', 'jsx', 'js'];
  for (const appDir of appDirs) {
    const appPath = join(templateRoot, appDir);
    if (!existsSync(appPath) || !safeIsDir(appPath)) continue;
    let entries: string[];
    try {
      entries = readdirSync(appPath);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith('(') || !entry.endsWith(')')) continue;
      const groupPath = join(appPath, entry);
      if (!safeIsDir(groupPath)) continue;
      for (const ext of pageExts) {
        if (existsSync(join(groupPath, slug, `page.${ext}`))) return true;
      }
    }
  }
  return false;
}

function safeIsDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

// ── route detection ──────────────────────────────────────────────────

function detectRoutes(templateRoot: string): ComplianceScan["routesFound"] {
  // Search for route markers across stacks. We accept either:
  //   - `src/app/{route}/page.{ts,tsx,js,jsx}` (Next.js App Router)
  //   - `src/app/(group)/{route}/page.{ts,tsx,js,jsx}` (Next.js App Router route groups —
  //     `(marketing)`, `(legal)`, etc. — these are routing-invisible by design and
  //     resolve to the same URL, so the verifier MUST find them too)
  //   - `src/routes/{route}/+page.svelte` (SvelteKit)
  //   - `pages/{route}.vue` (Nuxt)
  //   - `src/pages/{route}.astro` (Astro)
  //   - `app/views/{route}/index.html.erb` (Rails)
  //   - `templates/{route}.html` (Django)
  //   - `resources/views/{route}.blade.php` (Laravel)
  //   - `{route}.html` anywhere (fallback)
  const probe = (slug: string): boolean => {
    const candidates = [
      `src/app/${slug}/page.tsx`,
      `src/app/${slug}/page.ts`,
      `src/app/${slug}/page.jsx`,
      `src/app/${slug}/page.js`,
      `app/${slug}/page.tsx`,
      `pages/${slug}.tsx`,
      `pages/${slug}.vue`,
      `src/pages/${slug}.astro`,
      `src/routes/${slug}/+page.svelte`,
      `templates/${slug}.html`,
      `resources/views/${slug}.blade.php`,
    ];
    if (candidates.some((c) => existsSync(join(templateRoot, c)))) return true;
    // Directory-based fallback
    const dirs = [
      `src/app/${slug}`,
      `app/views/${slug}`,
      `templates/${slug}`,
    ];
    if (dirs.some((d) => existsSync(join(templateRoot, d)) && safeIsDir(join(templateRoot, d)))) {
      return true;
    }
    // Next.js App Router route groups: `src/app/(group)/{slug}/page.{ext}`.
    // Route groups are routing-invisible — `(marketing)/privacy` resolves to
    // `/privacy` exactly like `app/privacy` does. We probe one level deep
    // looking for parenthesised dirs that contain `${slug}/page.{ext}`.
    if (probeAppRouterRouteGroups(templateRoot, slug)) return true;
    return false;
  };

  return {
    privacy:        probe("privacy"),
    terms:          probe("terms"),
    cookiePolicy:   probe("cookie-policy") || probe("cookies"),
    accessibility:  probe("accessibility"),
    dmca:           probe("dmca") || probe("copyright"),
    doNotSell:      probe("do-not-sell") || probe("do-not-sell-or-share"),
  };
}

// ── SITE_CONFIG detection ────────────────────────────────────────────

function detectSiteConfigFields(
  templateRoot: string,
  haystack: string,
): ComplianceScan["siteConfigFields"] {
  // Look for the canonical SITE_CONFIG file (UI uses `src/lib/site-config.ts`).
  // Full-stack may have stack-specific paths; we look in the haystack.
  return {
    legalEntity:   /\blegalEntity\s*:\s*\{/.test(haystack),
    regions:       /\bregions\s*:\s*\{[^}]*\b(uk|eu|us)\b/.test(haystack),
    compliance:    /\bcompliance\s*:\s*\{/.test(haystack)
                   || /\bdmca\s*:/.test(haystack)
                   || /\bccpa\s*:/.test(haystack),
    cookieConsent: /\bcookieConsent\s*:\s*\{/.test(haystack)
                   || /\bcookie_consent\s*:\s*\{/.test(haystack),
  };
}

// ── cookie consent ───────────────────────────────────────────────────

function hasCookieConsentComponent(haystack: string): boolean {
  return /CookieConsent|cookie-consent|cookieBanner|CookieBanner/.test(haystack);
}

function hasRejectAllAtParity(haystack: string): boolean {
  // Both labels must appear in the same component / file. Crude but effective:
  // require the strings within a few hundred chars of each other.
  const accept = /Accept[\s_-]?[Aa]ll/.exec(haystack);
  const reject = /Reject[\s_-]?[Aa]ll/.exec(haystack);
  if (!accept || !reject) return false;
  return Math.abs(accept.index - reject.index) < 4000;
}

// ── GDPR rights enumeration ──────────────────────────────────────────

const GDPR_RIGHTS = [
  /\baccess\b/i,
  /\b(rectif(?:y|ication)|correct)\b/i,
  /\b(eras(?:e|ure)|delet)/i,
  /\brestrict(?:ion)?\b/i,
  /\bportabil(?:ity)?\b/i,
  /\bobject(?:ion)?\b/i,
  /\b(automated[\s-]?decision|profiling)\b/i,
];

function countGdprRights(templateRoot: string): number {
  const body = readPageBody(templateRoot, "privacy");
  if (!body) return 0;
  return GDPR_RIGHTS.filter((re) => re.test(body)).length;
}

function hasDntDisclosure(templateRoot: string): boolean {
  const body = readPageBody(templateRoot, "privacy");
  if (!body) return false;
  return /(Do Not Track|Global Privacy Control|GPC)/i.test(body);
}

/**
 * Read the concatenated body of a route's page across every stack convention,
 * INCLUDING Next.js App Router route groups (`(marketing)/privacy/page.tsx`).
 * Returns "" if no source file is found.
 */
function readPageBody(templateRoot: string, slug: string): string {
  const candidates = [
    `src/app/${slug}/page.tsx`,
    `src/app/${slug}/page.ts`,
    `app/${slug}/page.tsx`,
    `src/routes/${slug}/+page.svelte`,
    `src/pages/${slug}.astro`,
    `pages/${slug}.vue`,
    `templates/${slug}.html`,
    `resources/views/${slug}.blade.php`,
    `app/views/pages/${slug}.html.erb`,
  ];
  let body = "";
  for (const c of candidates) {
    const full = join(templateRoot, c);
    if (existsSync(full)) {
      try { body += "\n" + readFileSync(full, "utf8"); }
      catch { /* skip */ }
    }
  }
  // Directory scan — picks up split-file pages (sections.tsx, etc.).
  for (const d of [`src/app/${slug}`, `app/views/pages/${slug}`]) {
    const full = join(templateRoot, d);
    if (existsSync(full) && safeIsDir(full)) {
      for (const f of safeReadFiles(full)) {
        try { body += "\n" + readFileSync(join(full, f), "utf8"); }
        catch { /* skip */ }
      }
    }
  }
  // Next.js App Router route groups: `(group)/<slug>/page.{ext}` (and any
  // sibling files in that directory).
  for (const appDir of ['src/app', 'app']) {
    const appPath = join(templateRoot, appDir);
    if (!existsSync(appPath) || !safeIsDir(appPath)) continue;
    let entries: string[] = [];
    try { entries = safeReadFiles(appPath); } catch { /* skip */ }
    for (const entry of entries) {
      if (!entry.startsWith('(') || !entry.endsWith(')')) continue;
      const groupRoute = join(appPath, entry, slug);
      if (existsSync(groupRoute) && safeIsDir(groupRoute)) {
        for (const f of safeReadFiles(groupRoute)) {
          try { body += "\n" + readFileSync(join(groupRoute, f), "utf8"); }
          catch { /* skip */ }
        }
      }
    }
  }
  return body;
}

// ── AI disclosure on AI-bearing surfaces ─────────────────────────────

function detectAiSurfacesMissingDisclosure(templateRoot: string): string[] {
  // Surfaces that, if present, MUST carry an AI-disclosure phrase.
  const candidates = [
    "src/app/dashboard/playground",
    "src/app/dashboard/prompt-builder",
    "src/app/dashboard/chat",
    "src/components/dashboard/ChatHeader.tsx",
    "src/app/playground",
    "src/app/chat",
    "app/dashboard/playground",
  ];
  const phrases = [/AI[\s-]?generated/i, /generated by AI/i, /\bAI\b.*\boutput\b/i];
  const missing: string[] = [];
  for (const c of candidates) {
    const full = join(templateRoot, c);
    if (!existsSync(full)) continue;
    let text = "";
    if (safeIsDir(full)) {
      for (const f of walkFlat(full)) {
        try { text += "\n" + readFileSync(f, "utf8"); }
        catch { /* skip */ }
      }
    } else {
      try { text = readFileSync(full, "utf8"); }
      catch { continue; }
    }
    if (text && !phrases.some((re) => re.test(text))) missing.push(c);
  }
  return missing;
}

function walkFlat(dir: string): string[] {
  const out: string[] = [];
  const visit = (d: string): void => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) visit(full);
      else if (e.isFile() && SCAN_EXT.has(extname(e.name))) out.push(full);
    }
  };
  visit(dir);
  return out;
}

// ── pre-checked marketing consent ────────────────────────────────────

function detectPreCheckedConsent(templateRoot: string): string[] {
  const offenders: string[] = [];
  const visit = (dir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) visit(full);
      else if (e.isFile() && SCAN_EXT.has(extname(e.name))) {
        try {
          const text = readFileSync(full, "utf8");
          // Look for marketing/newsletter checkboxes that are pre-checked
          if (/(marketing|newsletter|consent|opt[\s-]?in)/i.test(text) &&
              /defaultChecked\s*=\s*\{?\s*true|\bchecked\s*=\s*\{?\s*true|checked\s*:\s*true/.test(text)) {
            offenders.push(full);
          }
        } catch { /* skip */ }
      }
    }
  };
  visit(templateRoot);
  return offenders;
}
