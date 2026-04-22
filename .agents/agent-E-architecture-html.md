# Agent E — Architecture HTML

**Status:** complete

## What shipped

1. **`/Users/arthur/ai-security-agent/ARCHITECTURE.html`** — new file, **1325 lines**, self-contained. Mirrors Brain's visual system (same font stack, same CSS variable palette shape, same dark cyber/ops aesthetic) while carrying tier-3 content from `docs/ARCHITECTURE.md`.

2. **`/Users/arthur/ai-security-agent/src/index.js`** — additive edit, now 149 lines (was 142). Added:
   - `import path from 'node:path';` and `import { fileURLToPath } from 'node:url';` (lines 2-3)
   - `const __dirname = path.dirname(fileURLToPath(import.meta.url));` (line 14)
   - Public `GET /architecture` route (lines 18-21), placed **before** the `requireApiKey` helper and before any auth-gated routes — it sits right next to `/health` as another public route.

No existing route behavior was modified. `node --check src/index.js` passes.

## Design decisions

### Accent color — purple (`#a855f7`) + violet (`#8b5cf6`) support

- Tier-3 differentiator vs Brain (green/blue primary) and Security Agent (red). Matches the CAMS tab accent already used in Brain's frontend for "security operations" feel.
- Documented with a comment block at the top of the `<style>` tag (see `src/CLAUDE.md` visible lines 11-19 of `ARCHITECTURE.html`).
- Hover states, table row highlights, fleet-diagram "this service" emphasis, section border accent, and env-chip key text all use the tier-3 purple. Supporting colors (teal/gold/green/blue/red) match Brain's palette for cross-doc consistency.

### Structural deviations from Brain's template

- **`<table>` instead of div-grid for the endpoint + phase tables.** Brain's ARCHITECTURE.html avoids tables (it uses div-based `file-tree`, `env-bar`, `monitor-grid`). Here the content is genuinely tabular (method / route / purpose / phase), so I used semantic `<table>` + added a mobile collapse (`data-label` attr + `::before` content) that turns each row into a stacked card below 900px. Readability first; Brain's style guide isn't prescriptive enough to block this.
- **Media queries.** Brain's HTML uses `min-width: 960px` and doesn't collapse — the requirement asked for mobile readability, so added breakpoints at 900px and 560px (grid collapses, stats bar reflows, tables collapse into card rows, fleet diagram shrinks font).
- **Fleet diagram as styled `<pre>`.** The MD source uses ASCII art — kept the ASCII and just added span-level color coding (brain/sec/aisec/tool/note classes). Cleaner than re-drawing as SVG and preserves the source faithfully.
- **No "stats bar with 8 numbers."** Brain has 8 stat blocks; this doc has 6 (tools, posture routes, portfolio repos, phases shipped, daily cron, tiers) because that's what the content actually supports. Forcing 8 would have been padding.
- **No `PART 9 — future work` section.** Phase roadmap + known-issues cover it; didn't want to triple-document the same deferred work.

## Content coverage (mapped to `docs/ARCHITECTURE.md`)

| MD section | HTML part |
|---|---|
| Intro + Position in the fleet | PART 1 (with styled ASCII fleet diagram) |
| Stack + Internal layout | PART 2 (3-card stack summary + file-tree) |
| Endpoint reference | PART 3 (phase-tagged `<table>`) |
| Cron schedule + State shape | PART 4 (2 cron cards + code-block for state shape) |
| Environment variables | PART 5 (env-bar with required/optional chips) |
| Relationship with portfolio repos | PART 6 (7 repo-cards in 2-col grid) |
| Phase roadmap | PART 7 (status table) |
| Known issues / deferred | PART 8 (6 color-coded job-boxes) |

## Express route — exact placement

`src/index.js` lines 18-21:

```js
// ─── Architecture doc (public, no auth) ──────────────────────
app.get('/architecture', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'ARCHITECTURE.html'));
});
```

Sits between `app.use(express.json(...))` (line 16) and `/health` (line 24). Both are public; the `requireApiKey` helper is defined at line ~42 (unchanged) and only the `/tools/*`, `/ai-security/*`, and `/intel/*` routes below it pick up auth.

## Verify locally

```bash
cd /Users/arthur/ai-security-agent
npm run dev     # or: node src/index.js

# in another shell:
curl -sI  http://localhost:3100/architecture | head -3
curl -s   http://localhost:3100/architecture | head -c 500
```

Expected:
- `HTTP/1.1 200 OK`
- `Content-Type: text/html; charset=UTF-8`
- First bytes: `<!DOCTYPE html><html lang="en"><head>...<title>AI Security Agent // Tier 3 Architecture</title>`
- Full response ~55 KB.

Also open `http://localhost:3100/architecture` in a browser to visually confirm the purple accent renders and the mobile breakpoints behave (resize to <900px — table rows should stack, grids should single-column).

Once deployed, hit:
- `https://<railway-prod-url>/architecture` — should be public (no `x-api-key` needed)

## Ambiguities / notes

- **Current date in header set to 2026-04-22** (Phase 3 ship date from `docs/ARCHITECTURE.md`). Update on future phase ships.
- **Service version hardcoded to 0.1.0** to match `src/index.js` `/health` response; keep them in sync if bumped.
- **No syntax-highlighted code blocks** beyond the single state-shape snippet — kept visual budget clean. If more code samples land later, the `.code-block` class with `data-lang` attr handles them.
- Did **not** add a `/architecture` link anywhere else (no nav bar, no readme hint). Brain doesn't either — URL is discoverability-by-convention.

## Files touched

- `ARCHITECTURE.html` — new (1325 lines)
- `src/index.js` — +7 lines (3 imports/setup, 4-line route), no existing lines modified
- `.agents/agent-E-architecture-html.md` — this file

No other files modified. Nothing committed or pushed.
