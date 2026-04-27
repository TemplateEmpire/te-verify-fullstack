# te-verify-fullstack

Buyer-ZIP verification pipeline for Template Empire **full-stack** templates (TL Lite, TP Pro, TX Enterprise).
Sibling project of `te-verify` — same architecture, different surface area.

## Why a separate CLI?

The UI `te-verify` CLI assumes a static-export frontend kit: no DB, no auth, no Stripe, no docker-compose. Full-stack
templates ship as production applications and need different gates:

| Concern | UI `te-verify` | `te-verify-fullstack` |
|---|---|---|
| `static-export` check | yes | no — templates run a server |
| `compose-validity` | no | yes — buyer demo flow depends on docker-compose |
| `env-completeness` | basic | full — every documented env var must be referenced in source |
| `migrations-presence` | no | yes — non-base templates need an initial schema |
| `seed-presence` | no | yes — buyer-simulation requires demo data |
| Multi-ecosystem stacks | Node only | Node + PHP + Python + Ruby + .NET + Java + Elixir |
| Forbidden-paths list | UI variant | extended (vendor/, venv/, target/, etc.) |
| Gate 17 compliance | yes | yes — adapted for real cookies + DB |

## Two-phase pipeline

```
Phase 1 — Deterministic    ← THIS CLI (te-verify-fullstack)
Phase 2 — LLM review       ← te-verify-fullstack-review skill (12 specialists + 2 external CLIs)
```

The two phases are independent. Phase 1 always runs first; Phase 2 only runs once Phase 1 is clean (broken builds make
LLM findings noisy).

## Usage

```bash
# In Claude Code, prefer the skill — it runs Phase 1 + Phase 2 end-to-end.
"review tl01 v1.0.0"

# Standalone (Phase 1 only):
cd Z:/projects/te-verify-fullstack
pnpm dev "C:/path/to/tl01-kiln-saas-starter-nextjs-v1.0.0.zip"

# With a slug override (used for tier inference):
pnpm dev "<zip>" --slug tl04-velora-ecommerce-nextjs
```

Outputs to `verification/<slug>-<version>/`:

- `evidence.json` — full structured evidence (gates, findings, raw scans)
- `report.md` — human-readable summary with verdict

## Gates

Pristine-state (run before any command execution):

- `zip-inspect` — forbidden paths, required files (incl. COMPLIANCE.md), entry-count sanity
- `version-check` — ZIP filename ↔ manifest version ↔ CHANGELOG top heading agree
- `content-scan` — UTF-8 BOM, mojibake, secret patterns, real-vendor names in legal pages
- `structural` — docker-compose, .env.example completeness, migrations, seed, licence validator
- `compliance` — Gate 17: routes, SITE_CONFIG, cookie consent, GDPR rights, AI disclosure

Command gates (Node ecosystem first; others stubbed for now):

- `install` — `pnpm install --frozen-lockfile`
- `typecheck` — `pnpm typecheck`
- `lint` — `pnpm lint` (zero-warning policy via post-processor)
- `test` — `pnpm test -- --run`
- `build` — `pnpm build`
- `audit` — `pnpm audit --prod --audit-level=high`

## Adding a new ecosystem

1. Implement the command set in `src/run-gates.ts` → `gatesForEcosystem`.
2. Implement manifest version reading in `src/version-check.ts` → `readManifestVersion`.
3. Add ecosystem-specific paths to `src/structural-check.ts` (migrations, seed candidates).
4. Add ecosystem-specific paths to `src/compliance-scan.ts` (route detection).
5. Add to forbidden paths in `src/zip-inspect.ts` if relevant.

## Setup

```bash
cd Z:/projects/te-verify-fullstack
pnpm install
pnpm build       # compiles to dist/
pnpm typecheck   # verify no errors
```

## Status

Initial scaffold. Node-ecosystem gates implemented; PHP/Python/Ruby/.NET/Java/Elixir adapters return `SKIPPED`
gates with a clear "ecosystem not yet implemented" message — Phase 2 specialists must run command gates inline
for those stacks until adapters land.
