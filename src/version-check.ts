import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Stack, VersionCheck, VersionIssueKind } from "./types.js";

const SEMVER = /(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?)/;
const ZIP_FILENAME_VERSION =
  /-v(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?)(?:\.zip)?$/i;
const DATE_PATTERN = /(\d{4}-\d{2}-\d{2})/;

/**
 * Cross-reference version sources. Same logic as te-verify but reads version
 * from whichever manifest file the stack uses.
 *
 *   1. ZIP filename
 *   2. Manifest version (package.json | composer.json | pyproject.toml | Gemfile.lock | *.csproj | pom.xml | mix.exs)
 *   3. CHANGELOG top heading
 */
export function checkVersions(zipPath: string, templateRoot: string, stack: Stack): VersionCheck {
  const result: VersionCheck = {
    packageVersion: null,
    zipFilenameVersion: null,
    changelogTopVersion: null,
    changelogTopDate: null,
    issues: [],
  };

  // 1. Manifest version
  const manifestVersion = readManifestVersion(templateRoot, stack);
  if (manifestVersion.version) {
    result.packageVersion = manifestVersion.version;
  } else {
    result.issues.push({
      kind: "package-missing",
      message: manifestVersion.error ?? "No manifest with parseable version found",
    });
  }

  // 2. ZIP filename
  const fname = basename(zipPath);
  const fnameMatch = fname.replace(/\.zip$/i, "").match(ZIP_FILENAME_VERSION);
  if (fnameMatch) {
    result.zipFilenameVersion = fnameMatch[1];
  } else {
    result.issues.push({
      kind: "filename-no-version",
      message: `ZIP filename "${fname}" has no \`-v{semver}\` token`,
    });
  }

  // 3. CHANGELOG.md top entry
  const changelogPath = join(templateRoot, "CHANGELOG.md");
  if (!existsSync(changelogPath)) {
    result.issues.push({
      kind: "changelog-missing",
      message: "CHANGELOG.md not found",
    });
  } else {
    const text = readFileSync(changelogPath, "utf8");
    const lines = text.split("\n");
    let foundVersion = false;
    for (const line of lines) {
      if (/^#{1,3}\s/.test(line)) {
        const m = line.match(SEMVER);
        if (m) {
          result.changelogTopVersion = m[1];
          const dm = line.match(DATE_PATTERN);
          if (dm) result.changelogTopDate = dm[1];
          foundVersion = true;
          break;
        }
      }
    }
    if (!foundVersion) {
      result.issues.push({
        kind: "changelog-no-version-found",
        message: "CHANGELOG.md contains no heading with a parseable semver",
      });
    }
  }

  // 4. Cross-reference
  if (
    result.packageVersion &&
    result.zipFilenameVersion &&
    result.packageVersion !== result.zipFilenameVersion
  ) {
    result.issues.push({
      kind: "filename-mismatch",
      message: `ZIP filename version (${result.zipFilenameVersion}) ≠ manifest version (${result.packageVersion})`,
    });
  }

  if (
    result.packageVersion &&
    result.changelogTopVersion &&
    result.packageVersion !== result.changelogTopVersion
  ) {
    const isNaturalLag = isSameMinorButBehindOrEqual(
      result.changelogTopVersion,
      result.packageVersion,
    );
    result.issues.push({
      kind: isNaturalLag ? "changelog-lag" : "changelog-mismatch",
      message: isNaturalLag
        ? `CHANGELOG top entry (${result.changelogTopVersion}) lags manifest (${result.packageVersion}) — expected after an auto-bump.`
        : `CHANGELOG top entry (${result.changelogTopVersion}) ≠ manifest version (${result.packageVersion})`,
    });
  }

  return result;
}

function readManifestVersion(
  templateRoot: string,
  stack: Stack,
): { version: string | null; error?: string } {
  const tryRead = (rel: string): string | null => {
    const p = join(templateRoot, rel);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  };

  // Node-family manifests
  const pkgJson = tryRead("package.json");
  if (pkgJson) {
    try {
      const pkg = JSON.parse(pkgJson) as { version?: string };
      if (pkg.version) {
        const m = pkg.version.match(SEMVER);
        return m ? { version: m[1] } : { version: null, error: "package.json version not semver" };
      }
    } catch {
      return { version: null, error: "package.json malformed" };
    }
  }

  // PHP — Laravel
  const composer = tryRead("composer.json");
  if (composer) {
    try {
      const c = JSON.parse(composer) as { version?: string };
      if (c.version) {
        const m = c.version.match(SEMVER);
        if (m) return { version: m[1] };
      }
    } catch { /* fall through */ }
  }

  // Python — pyproject.toml (poetry/PEP 621). Crude regex; adequate for release gating.
  const pyproject = tryRead("pyproject.toml");
  if (pyproject) {
    const m = /^version\s*=\s*["']([^"']+)["']/m.exec(pyproject);
    if (m) {
      const sm = m[1].match(SEMVER);
      if (sm) return { version: sm[1] };
    }
  }

  // Ruby — Gemfile.lock has the gem versions; the template's own version usually
  // lives in `lib/<gem>/version.rb` or a VERSION file.
  const versionFile = tryRead("VERSION");
  if (versionFile) {
    const m = versionFile.match(SEMVER);
    if (m) return { version: m[1] };
  }

  // Elixir — mix.exs version field
  const mixExs = tryRead("mix.exs");
  if (mixExs) {
    const m = /version:\s*["']([^"']+)["']/.exec(mixExs);
    if (m) {
      const sm = m[1].match(SEMVER);
      if (sm) return { version: sm[1] };
    }
  }

  // .NET — first <Version> in any .csproj. We don't enumerate; users can adapt.
  // Java — pom.xml <version>. Same.

  return {
    version: null,
    error: `No recognised manifest with version found for stack=${stack}`,
  };
}

function isSameMinorButBehindOrEqual(candidate: string, reference: string): boolean {
  const parse = (v: string) => {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
    return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
  };
  const c = parse(candidate);
  const r = parse(reference);
  if (!c || !r) return false;
  if (c.major !== r.major) return false;
  if (c.minor !== r.minor) return false;
  return c.patch <= r.patch;
}

export const VERSION_PRIORITY: Record<VersionIssueKind, "P0" | "P1" | "P2"> = {
  "filename-mismatch": "P0",
  "changelog-mismatch": "P0",
  "changelog-lag": "P2",
  "package-missing": "P0",
  "changelog-missing": "P0",
  "changelog-no-version-found": "P1",
  "filename-no-version": "P2",
};
