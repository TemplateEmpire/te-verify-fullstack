import type { Stack } from "./types.js";

/**
 * Canonical full-stack family slugs, keyed by the two-digit family number that
 * prefixes a branded ZIP slug (TLNN). This is the product-table identity
 * (`products.slug`), NOT the branded codename in the ZIP filename
 * (e.g. "TL05-Calendo-Booking-NextJS"). Verified against the products table
 * (product_type = 'full_stack', sort_order = family number) on 2026-06-15.
 *
 * Two canonical identifiers are derived from this:
 *   product_family_slug = `${family}`              (e.g. "booking")
 *   product_slug        = `${family}-${stack}`     (e.g. "booking-nextjs")
 *
 * The store / release-readiness ingest joins certificate history by
 * product_slug, NOT product_family_slug: unrelated families share no slug, so
 * a family-level join would mix their histories. Keeping the two distinct here
 * mirrors that separation at the point evidence is produced.
 */
export const FAMILY_SLUG: Record<string, string> = {
  "01": "saas-starter",
  "02": "admin-dashboard",
  "03": "blog-cms",
  "04": "ecommerce",
  "05": "booking",
  "06": "project-management",
  "07": "social-community",
  "08": "ai-assistant",
  "09": "crm",
  "10": "marketplace",
};

/**
 * Extract the two-digit family number ("01".."10") from a slug. Matches a
 * `tlNN` token bounded by non-alphanumerics so "tl05-...", "TL05_x" and a bare
 * "tl05" all resolve, while "html05" or "settl05e" do not. Returns null when no
 * family token is present (non-TL slug, or a slug we cannot classify).
 */
export function detectFamilyId(slug: string): string | null {
  const match = /(?:^|[^a-z0-9])tl(\d{2})(?:[^a-z0-9]|$)/i.exec(slug);
  return match?.[1] ?? null;
}

/** Canonical product_family_slug for a family number, or null if unknown. */
export function familySlug(familyId: string | null | undefined): string | null {
  if (!familyId) return null;
  return FAMILY_SLUG[familyId] ?? null;
}

/**
 * Canonical product_slug = `${family}-${stack}` (e.g. "booking-nextjs").
 *
 * Returns null unless BOTH the family number resolves to a known family slug
 * AND the stack is a real (non-"unknown") stack. A partial slug is worse than
 * none here: a downstream consumer could post it as a join key, and
 * "booking-unknown" or a bare family slug would silently miss the right
 * certificate-history row.
 */
export function deriveProductSlug(
  familyId: string | null | undefined,
  stack: Stack,
): string | null {
  const family = familySlug(familyId);
  if (!family || stack === "unknown") return null;
  return `${family}-${stack}`;
}
