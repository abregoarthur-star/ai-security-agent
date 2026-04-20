# ai-security-agent

Orchestration + tool layer for the **detect → inventory → test → generate → defend** AI-agent security portfolio. Exposes [`@dj_abstract/mcp-audit`](https://www.npmjs.com/package/@dj_abstract/mcp-audit), [`@dj_abstract/agent-firewall`](https://www.npmjs.com/package/@dj_abstract/agent-firewall), and related tools as HTTP endpoints so other agents (Brain, Security Agent) can run AI-security checks without pulling the tools into their own dependency tree.

## Architecture

```
Brain (master)
   ↓
Security Agent (CVE / bounty / traditional cyber)
   ↓
AI Security Agent (this repo — owns AI-native security tooling)
   ↓
mcp-audit · prompt-eval · agent-firewall · prompt-genesis · agent-capability-inventory · mcp-audit-sweep
```

## Phase 1 — REST endpoints

| Route | Purpose |
|---|---|
| `GET /health` | Liveness probe. |
| `POST /tools/audit_mcp_server` | Run `mcp-audit` against `{ manifest \| stdio \| url }`. |
| `POST /tools/diff_mcp_server` | Diff two mcp-audit reports for rug-pull detection. |
| `POST /tools/firewall_recent_events` | Fetch recent agent-firewall events from Brain. |
| `GET /ai-security/posture` | Aggregated state of tracked surfaces. |

## Phase 2 (planned)

- Streamable HTTP MCP server at `/mcp` — Brain and Security Agent both mount it as a remote MCP server
- Cron-driven scans with baseline persistence (`mcp-audit diff` daily, full scan weekly, `prompt-eval` regression daily)
- Dashboard pane in Brain showing AI security posture

## License

MIT
