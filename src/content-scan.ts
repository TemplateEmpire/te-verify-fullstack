import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import type { ContentScan } from "./types.js";

const SCAN_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".astro", ".svelte", ".vue",
  ".md", ".mdx",
  ".css", ".scss",
  ".json", ".yaml", ".yml",
  ".html", ".erb", ".blade.php", ".html.heex",
  ".py", ".rb", ".php", ".cs", ".java", ".ex", ".exs",
]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", ".nuxt", ".svelte-kit",
  ".output", "dist", "out", "build",
  "vendor", "venv", ".venv", "__pycache__",
  "target", "bin", "obj", "_build", "deps",
]);

// Secret patterns. Same as te-verify; works across stacks.
const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "stripe-live",    regex: /sk_live_[a-zA-Z0-9]{20,}/ },
  { name: "stripe-test",    regex: /sk_test_[a-zA-Z0-9]{20,}/ },
  { name: "aws-access-key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "github-pat",     regex: /\bghp_[A-Za-z0-9]{36,}\b/ },
  { name: "anthropic-key",  regex: /\bsk-ant-[a-zA-Z0-9-]{20,}/ },
  { name: "openai-key",     regex: /\bsk-proj-[A-Za-z0-9]{20,}/ },
  { name: "generic-jwt",    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  // Full-stack-specific: actual database connection strings. The regex matches
  // any user:pass@host shape; placeholder filtering happens in scanContent()
  // (looks for `$`, `<`, `{`, `[`, or uppercase-only segments — those are
  // template syntax, not real credentials).
  { name: "postgres-uri",   regex: /\bpostgres(?:ql)?:\/\/[^@\s]+:[^@\s]+@[^/\s]+/ },
  { name: "mysql-uri",      regex: /\bmysql:\/\/[^@\s]+:[^@\s]+@[^/\s]+/ },
];

/**
 * Returns true when the matched user:password URI looks like a documentation
 * placeholder rather than a real leaked credential. Lets `.env.example`,
 * runtime-composer source (e.g. `${user}:${password}@host`), and HTML/MD
 * docs (`<user>:<pass>@host`, `USER:PASSWORD@host`) through without spam.
 */
function looksLikePlaceholder(match: string): boolean {
  // Template-literal / JSX / Mustache / shell-var / Liquid / bracket placeholders.
  if (/[$<\[{]/.test(match)) return true;
  // HTML-encoded angle brackets (`&lt;USER&gt;`) — common in shipped HTML docs.
  if (/&lt;|&gt;|&amp;/i.test(match)) return true;
  // Uppercase-only user OR pass segment (USER:PASSWORD, FOO_BAR:BAZ).
  const m = match.match(/:\/\/([^:]+):([^@]+)@/);
  if (m) {
    const [, user, pass] = m;
    if (/^[A-Z][A-Z0-9_]*$/.test(user)) return true;
    if (/^[A-Z][A-Z0-9_]*$/.test(pass)) return true;
  }
  return false;
}

const VENDOR_REGEX =
  /\b(Vercel|Cloudflare|AWS|Amazon Web Services|Stripe|Supabase|Google Analytics|Mixpanel|Segment|PostHog)\b/;

const LEGAL_PATH_REGEX = /[\\/](privacy|terms|cookies?|legal|gdpr|dmca|do-not-sell|accessibility|data-processing)[\\/]/i;

export function scanContent(templateRoot: string): ContentScan {
  const result: ContentScan = {
    bomFiles: [],
    mojibakeFiles: [],
    secrets: [],
    realVendorsInLegal: [],
  };

  walk(templateRoot, templateRoot, result);
  return result;
}

function walk(dir: string, templateRoot: string, out: ContentScan): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, templateRoot, out);
    } else if (entry.isFile() && SCAN_EXTENSIONS.has(extname(entry.name))) {
      scanFile(full, templateRoot, out);
    }
  }
}

function scanFile(path: string, templateRoot: string, out: ContentScan): void {
  let buffer: Buffer;
  try {
    buffer = readFileSync(path);
  } catch {
    return;
  }
  const rel = relative(templateRoot, path).replace(/\\/g, "/");

  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    out.bomFiles.push(rel);
  }

  const text = buffer.toString("utf8");

  if (/â€"|â€™|â€œ|â€|Ã©|Ã¨|Ã/.test(text)) {
    out.mojibakeFiles.push(rel);
  }

  const lines = text.split("\n");
  const isLegal = LEGAL_PATH_REGEX.test(`/${rel}/`);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    for (const { name, regex } of SECRET_PATTERNS) {
      const m = line.match(regex);
      if (!m) continue;
      // Postgres / MySQL URI matches: skip placeholder shapes (template
      // literals, angle-bracket placeholders, uppercase-only segments).
      // These are docs / compose defaults / runtime composers, not real leaks.
      if ((name === 'postgres-uri' || name === 'mysql-uri') && looksLikePlaceholder(m[0])) {
        continue;
      }
      out.secrets.push({
        file: rel,
        line: i + 1,
        match: `${name}: ${m[0].slice(0, 16)}…`,
      });
    }

    if (isLegal) {
      const m = line.match(VENDOR_REGEX);
      if (m) {
        out.realVendorsInLegal.push({
          file: rel,
          line: i + 1,
          match: m[0],
        });
      }
    }
  }
}
