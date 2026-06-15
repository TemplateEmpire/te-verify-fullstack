import assert from "node:assert/strict";
import { deriveProductSlug, detectFamilyId, FAMILY_SLUG, familySlug } from "./product-slug.js";

// ── detectFamilyId: family number is extracted only from a bounded `tlNN` token.
assert.equal(detectFamilyId("TL05-Calendo-Booking-NextJS-v1.18.20"), "05");
assert.equal(detectFamilyId("tl01-kiln-saas-starter-nextjs"), "01");
assert.equal(detectFamilyId("TL10_Agora_Marketplace"), "10");
assert.equal(detectFamilyId("tl00-base"), "00");
assert.equal(detectFamilyId("tl07"), "07"); // bare token, end-of-string boundary
// Negatives: no family token, or `tl` not at a token boundary / not followed by 2 digits.
assert.equal(detectFamilyId("saas-starter-nextjs"), null);
assert.equal(detectFamilyId("abctl05"), null); // `tl` preceded by an alphanumeric
assert.equal(detectFamilyId("settler05"), null); // `tl` not followed by digits
assert.equal(detectFamilyId("tl5"), null); // single digit, not NN
assert.equal(detectFamilyId(""), null);

// ── familySlug: family number -> canonical product_family_slug (products.slug).
assert.equal(familySlug("01"), "saas-starter");
assert.equal(familySlug("05"), "booking");
assert.equal(familySlug("10"), "marketplace");
assert.equal(familySlug("99"), null); // unknown family number
assert.equal(familySlug(null), null);
assert.equal(familySlug(undefined), null);

// ── deriveProductSlug: canonical product_slug = `${family}-${stack}`.
assert.equal(deriveProductSlug("05", "nextjs"), "booking-nextjs");
assert.equal(deriveProductSlug("01", "nextjs"), "saas-starter-nextjs");
assert.equal(deriveProductSlug("10", "laravel"), "marketplace-laravel");
// A partial identity is worse than none: refuse on unknown stack / family / missing input.
assert.equal(deriveProductSlug("05", "unknown"), null);
assert.equal(deriveProductSlug("99", "nextjs"), null);
assert.equal(deriveProductSlug(null, "nextjs"), null);
assert.equal(deriveProductSlug(undefined, "nextjs"), null);

// ── The map is the full 10-family full-stack line, verified against the
// products table (product_type = 'full_stack', sort_order = family number).
const EXPECTED: Record<string, string> = {
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
assert.deepEqual(FAMILY_SLUG, EXPECTED);
assert.equal(Object.keys(FAMILY_SLUG).length, 10);

console.log("product-slug.test.ts: all assertions passed");
