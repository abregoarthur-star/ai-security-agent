# Agent D — Architecture docs

**Status:** complete

## Files modified / created

| File | Action | Approx. lines (final) |
|---|---|---|
| `/Users/arthur/dj-abstract-ai-brain/docs/ARCHITECTURE-REFERENCE.md` | edited (3 surgical edits — no rewrite) | 458 (was 428; +30) |
| `/Users/arthur/ai-security-agent/docs/ARCHITECTURE.md` | created (new) | 132 |
| `/Users/arthur/ai-security-agent/.agents/agent-D-architecture-docs.md` | created (this file) | — |

`docs/` directory was created fresh under `ai-security-agent/` (did not exist before).

## Task 1 — Summary of changes to Brain's `docs/ARCHITECTURE-REFERENCE.md`

Edits were strictly additive — no removals, no section renames. Existing structure and tone preserved.

1. **New section near the top: "Three-tier AI-security fleet hierarchy"** — placed directly under the opening paragraph, before "Project Structure". ASCII diagram showing Brain → Security Agent → AI Security Agent → 6-repo portfolio, plus a prose note on the shared `AGENT_API_KEY`.

2. **API Routes table** — appended two rows to the existing `/security/*` block:
   - `GET /security/mcp-manifests` — serves Brain's tool surface as mcp-audit-shaped manifests (consumed by ai-security-agent's cron)
   - `GET /security/firewall/events` — recent `agent-firewall` activity log (consumed by `firewall_recent_events`)

3. **"AI Brain Tools (17)" section → "AI Brain Tools (21)"**:
   - Kept the original 17-tool list verbatim, split into a **Core tools (17)** sub-heading
   - Added **AI-security proxy tools (4)** sub-section listing `audit_mcp_server`, `diff_mcp_server`, `firewall_recent_events`, `run_self_test` with the `AI_SEC_AGENT_URL` / `AI_SEC_AGENT_KEY` env-var note
   - Added **Dual-path invariant** sub-section — explicit reminder that every tool must be registered in both `brain.js` AND `brain-tools-mcp.js`
   - Added **Known issue — SDK path broken on Railway** sub-section — documents the missing-native-binary issue and notes that Telegram + web chat both route through the legacy `queryAgent()` path in prod

4. **Security tooling companion-repos table** — added two rows and updated an existing one:
   - New row for `mcp-audit-action` (GitHub Action wrapper + SARIF)
   - New bottom row for `ai-security-agent` itself as the **Orchestrator** layer (lists the 7 exposed endpoints + env vars)
   - Updated the preamble paragraph to point at ai-security-agent as the tier-3 orchestration layer
   - Tweaked `agent-capability-inventory` and `prompt-genesis` rows to note their ai-security-agent endpoint wiring
   - Added SARIF 2.1.0 note to `mcp-audit` row (from 0.4.0)

## Task 2 — Key architectural decisions reflected in the new `ARCHITECTURE.md`

The doc was structured so a newcomer can understand the service's role in <10 min. Decisions explicitly surfaced:

- **Three-tier fleet position** up-top with a diagram that shows both directions of traffic (Brain → ai-security-agent proxy calls, and ai-security-agent cron → Brain `/security/*` callbacks). Consumer relationships with Security Agent's `/intel/ai-security` uplink are shown as a separate arrow.
- **npm-deps-not-CLI** stack choice is called out — all `@dj_abstract/*` repos are consumed as library imports, no `child_process` shelling out.
- **`src/tools/` vs `src/routes/` vs `src/index.js` separation** documented as convention — handlers are pure data-gathering, Express is mounted in one place only. Supports future MCP-transport reuse of the same handlers.
- **Endpoint table is phase-tagged** — each route annotated with which phase shipped it (1 / 2 / 3), so readers immediately see what's baseline vs recent.
- **Cron state shape** included inline — consumers reading the doc can understand exactly what `getLastScan()` returns without opening source.
- **Env-var table** separates "required always" from "required only when used" (e.g. `ANTHROPIC_API_KEY` only matters for `run_self_test`).
- **Portfolio-repo cross-reference table** names which ai-security-agent endpoint surfaces each repo — the main "which repo drives which endpoint" mental model a new contributor needs.
- **Phase roadmap table** inlined from task brief with the pending follow-ups (B-2 baseline persistence, Security Agent pull-consumer wiring).

## Ambiguities / gaps flagged for orchestrator review

1. **SDK-path-broken-on-Railway** is documented in Brain's doc as a current issue. I did not verify this claim in code (instructed not to speculate, but the brief stated this is current state). If the SDK path has since been patched, the sentence in the new "Known issue — SDK path broken on Railway" sub-section should be removed or reworded.

2. **Line counts** in the table above are approximate — not load-bearing for the task. If an exact count is needed, run `wc -l` on each file.

3. **`mcp-audit-action`** was already referenced in `~/security-agent/CLAUDE.md` but was missing from Brain's security-tooling table. I added a row for it because it's clearly part of the public portfolio; if Arthur wants Brain's doc limited to the original 6 repos for portfolio-framing reasons, that row can be dropped.

4. **Tool count (21)** reflects 17 core + 4 ai-sec proxies as stated in the brief. The `brain-tools-mcp.js` file comment says "16 tools" (excluding `execute_command` which lives on `brain-exec`). Both framings are correct from different angles — CLAUDE.md uses "17 brain tools" as the across-both-MCP-servers count, so I kept that convention for the core list and used 21 for the grand total including proxies.

5. **`AGENT_API_KEY` vs `API_KEY`** — `src/index.js` accepts either (`process.env.AGENT_API_KEY || process.env.API_KEY`). Documented the primary name as `AGENT_API_KEY` with a legacy-alias note, since that matches the brief and the Security Agent's tier-2 CLAUDE.md.

6. **No touching of code, commits, or pushes.** Confirmed. Did not modify `src/*`, `package.json`, or any file outside the three listed.

## Final message

agent D complete — Brain's architecture reference updated in place with three-tier hierarchy, 4 ai-security proxy tools, 2 new `/security/*` endpoints, SDK-path-broken-on-Railway caveat, and dual-path invariant; ai-security-agent's new `docs/ARCHITECTURE.md` covers position-in-fleet, endpoints (phase-tagged), cron, env vars, phase roadmap, and portfolio-repo cross-references. No code touched, no commits.
