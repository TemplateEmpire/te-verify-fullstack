import { existsSync, readdirSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import type { FeatureScopeScan } from "./types.js";

type ExpectedCommerce = FeatureScopeScan["expectedCommerce"];

const FAMILY_COMMERCE: Record<string, ExpectedCommerce> = {
  "01": "subscription",
  "02": "none",
  "03": "none",
  "04": "payment",
  "05": "none",
  "06": "none",
  "07": "none",
  "08": "none",
  "09": "none",
  "10": "marketplace",
};

/**
 * Deterministic feature-scope scan for TL family drift.
 *
 * This intentionally checks App Router source paths, not arbitrary strings,
 * so API docs or shared inactive services do not false-positive. The purpose
 * is to catch buyer-visible route surfaces that contradict the authoritative
 * feature matrix.
 */
export function featureScopeScan(templateRoot: string, slug?: string): FeatureScopeScan {
  const familyId = detectFamilyId(slug ?? basename(templateRoot));
  const expectedCommerce = familyId ? FAMILY_COMMERCE[familyId] ?? "unknown" : "unknown";
  const routes = collectAppRoutes(templateRoot);
  const forbiddenRoutes: FeatureScopeScan["forbiddenRoutes"] = [];
  const missingRequiredRoutes: FeatureScopeScan["missingRequiredRoutes"] = [];

  if (expectedCommerce === "none" || expectedCommerce === "payment" || expectedCommerce === "marketplace") {
    for (const route of routes) {
      const normalized = route.route;
      if (normalized === "/pricing") {
        forbiddenRoutes.push({
          ...route,
          reason: "Lite feature matrix does not include SaaS pricing for this family",
        });
      }
      if (normalized === "/billing" || normalized.startsWith("/billing/")) {
        forbiddenRoutes.push({
          ...route,
          reason: "Lite feature matrix does not include subscription billing pages for this family",
        });
      }
      if (normalized === "/api/billing" || normalized.startsWith("/api/billing/")) {
        forbiddenRoutes.push({
          ...route,
          reason: "Lite feature matrix does not include subscription billing API routes for this family",
        });
      }
    }
  }

  if (expectedCommerce === "subscription") {
    requireRoute(routes, "/api/billing/checkout", "Subscription SaaS kits must expose checkout", missingRequiredRoutes);
    requireRoute(routes, "/api/billing/plans", "Subscription SaaS kits must expose plans", missingRequiredRoutes);
    requireRoute(routes, "/billing", "Subscription SaaS kits must expose billing UI", missingRequiredRoutes);
    requireRoute(routes, "/pricing", "Subscription SaaS kits must expose pricing UI", missingRequiredRoutes);
  } else if (expectedCommerce === "payment") {
    requireRoute(routes, "/api/store/checkout", "E-commerce kits must expose store checkout", missingRequiredRoutes);
  } else if (expectedCommerce === "marketplace") {
    requireRoute(routes, "/api/marketplace/checkout", "Marketplace kits must expose split-payment checkout", missingRequiredRoutes);
  }

  return {
    familyId,
    expectedCommerce,
    forbiddenRoutes,
    missingRequiredRoutes,
  };
}

function detectFamilyId(slug: string): string | null {
  const match = /(?:^|[^a-z0-9])tl(\d{2})(?:[^a-z0-9]|$)/i.exec(slug);
  return match?.[1] ?? null;
}

interface AppRoute {
  route: string;
  path: string;
}

function collectAppRoutes(templateRoot: string): AppRoute[] {
  const roots = [join(templateRoot, "src", "app"), join(templateRoot, "app")];
  const routes: AppRoute[] = [];

  for (const root of roots) {
    if (!existsSync(root)) continue;
    walk(root, root, routes);
  }

  return routes;
}

function walk(root: string, dir: string, routes: AppRoute[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      walk(root, full, routes);
      continue;
    }

    if (!entry.isFile()) continue;
    if (!/^(page|route)\.(tsx?|jsx?)$/.test(entry.name)) continue;

    const route = toRoute(relative(root, full));
    routes.push({
      route,
      path: relative(root, full).split(sep).join("/"),
    });
  }
}

function toRoute(relativePath: string): string {
  const parts = relativePath.split(sep);
  parts.pop();

  const visible = parts
    .filter((part) => part && !/^\(.+\)$/.test(part))
    .map((part) => {
      if (/^\[\.\.\..+\]$/.test(part)) return `:${part.slice(4, -1)}*`;
      if (/^\[.+\]$/.test(part)) return `:${part.slice(1, -1)}`;
      return part;
    });

  return `/${visible.join("/")}`.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

function requireRoute(
  routes: AppRoute[],
  route: string,
  reason: string,
  missingRequiredRoutes: FeatureScopeScan["missingRequiredRoutes"],
): void {
  if (!routes.some((candidate) => candidate.route === route)) {
    missingRequiredRoutes.push({ route, reason });
  }
}
