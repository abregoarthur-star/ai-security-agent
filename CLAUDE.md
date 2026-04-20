# AI Security Agent

Orchestration + tool layer for the AI-agent security portfolio. Phase 1: REST API that exposes `mcp-audit`, `mcp-audit diff`, and `agent-firewall` queries as HTTP endpoints. Phase 2+: Streamable HTTP MCP server at `/mcp` so Brain and Security Agent consume the same shared surface.

## Hierarchy

```
Brain (master hub)
   ↓
Security Agent (CVE / bounty / traditional cyber)
   ↓
AI Security Agent (NEW — owns all AI-sec tooling)
   ↓
mcp-audit · prompt-eval · agent-firewall · prompt-genesis · agent-capability-inventory · mcp-audit-sweep
```

Separation of concerns mirrors real-world enterprises: a dedicated AI security team alongside the traditional security team.

## Stack

Node.js 20 + Express (ESM). Deployed to Railway. Imports `@dj_abstract/mcp-audit` and `@dj_abstract/agent-firewall` as npm deps — no child_process.

## Phase 1 routes

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness probe. |
| `POST` | `/tools/audit_mcp_server` | Run `mcp-audit` against `{ manifest | stdio | url }`. |
| `POST` | `/tools/diff_mcp_server` | Diff two mcp-audit reports for rug-pull detection. |
| `POST` | `/tools/firewall_recent_events` | Fetch recent agent-firewall events from Brain. |
| `GET` | `/ai-security/posture` | Aggregated state of tracked surfaces (Phase 2 will populate). |

All `/tools/*` and `/ai-security/*` routes gated on `x-api-key` if `API_KEY` is set.

## Phase 2 — MCP transport

Expose the same tools as an MCP server over Streamable HTTP at `/mcp` using `@modelcontextprotocol/sdk`. Brain mounts it as a third MCP server alongside `brain-tools` + `brain-exec`. Security Agent calls it over HTTP with `x-api-key`.

## Phase 2 — crons

- Daily: `mcp-audit diff` vs yesterday's baseline on Brain's `brain-tools` + `brain-exec` → critical findings → Telegram alert + Brain push
- Weekly: full `mcp-audit scan` → refresh baseline
- Hourly: pull `/security/firewall/events` from Brain, summarize block patterns
- Daily: `prompt-eval` regression against Brain SDK path, alert on defense-rate drop > 5pts
- Weekly: `mcp-audit-sweep` disclosure-ETA watcher (6 findings' 2026-07-17 public date)

## Env vars

| Var | Purpose |
|---|---|
| `PORT` | HTTP listen port (Railway assigns). |
| `API_KEY` | Shared key for Brain + Security Agent to call `/tools/*`. If unset, auth is disabled (dev only). |
| `BRAIN_API_URL` | Brain prod URL — used by `firewallRecentEvents`. |
| `BRAIN_API_KEY` | Brain's API key for `/security/firewall/events`. |
| `ANTHROPIC_API_KEY` | Reserved for Phase 2 summarization crons. |

## Development

```bash
npm install
npm run dev        # --watch reload on Node 20+
curl -s http://localhost:3100/health | jq
```

## Deployment

Railway, auto-deploy on push to `main`. Volume not required for Phase 1 (no persisted state yet — cron results in Phase 2 will need one).

## Portfolio framing

This repo is the "runtime AI security" pane of glass. Hiring managers at Lakera / Protect AI / HiddenLayer / BigID recognize the pattern: a dedicated service that aggregates the detection toolkit behind one interface and feeds it into the existing security workflow. It's exactly the shape a commercial AI-AppSec product takes internally.
