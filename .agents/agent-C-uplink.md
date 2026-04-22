# Agent C — Security Agent uplink (/intel/ai-security)

**Status:** complete

## What I built

- New module: `/Users/arthur/ai-security-agent/src/routes/ai-security-intel.js`
  - Single exported async function `getAiSecurityIntel({ includeFirewall } = {})`
  - No Express dependency — pure data-gathering, mirrors the `src/tools/*.js` vs `src/index.js` separation the repo already uses
  - Reads `getLastScan()` from `src/cron.js` for the last self-scan state
  - Aggregates totals across all tracked MCP servers (servers / tools / findings / bySeverity)
  - Flattens high-priority findings to `{ server, severity, ruleId, title }` — no raw bodies
  - Computes a 48h freshness indicator with a dedicated `cold-boot` state for the pre-first-run case
  - Best-effort 24h firewall event count via the existing `src/tools/firewall-events.js` (wraps Brain's `/security/firewall/events`); failures downgrade to `{ available: false, reason }` so the intel payload is never blocked by Brain being down or misconfigured

No modifications to `src/index.js`, `src/cron.js`, or anything under `src/tools/`.

## Response shape

Example when a scan has run and Brain is reachable:

```json
{
  "service": "ai-security-agent",
  "schemaVersion": "1.0.0",
  "asOf": "2026-04-22T15:04:05.000Z",
  "status": "ok",
  "freshness": {
    "status": "fresh",
    "stale": false,
    "ageMs": 3600000,
    "lastRun": "2026-04-22T14:04:05.000Z"
  },
  "lastRun": "2026-04-22T14:04:05.000Z",
  "lastError": null,
  "baselineCount": 2,
  "trigger": "cron-daily",
  "totals": {
    "servers": 2,
    "tools": 17,
    "findings": 3,
    "bySeverity": { "critical": 0, "high": 1, "medium": 2, "low": 0, "info": 0 }
  },
  "servers": [
    { "name": "brain-tools", "tools": 16, "findings": 2, "bySeverity": { "high": 1, "medium": 1 } },
    { "name": "brain-exec",  "tools": 1,  "findings": 1, "bySeverity": { "medium": 1 } }
  ],
  "highPriorityFindings": [
    { "server": "brain-tools", "severity": "critical", "ruleId": "MCP-001", "title": "Lethal trifecta" }
  ],
  "firewall": {
    "available": true,
    "windowHours": 24,
    "since": "2026-04-21T15:04:05.000Z",
    "total": 42,
    "byOutcome": { "block": 5, "warn": 12, "allow": 25 }
  }
}
```

Cold boot (no scan yet):

```json
{
  "service": "ai-security-agent",
  "schemaVersion": "1.0.0",
  "asOf": "2026-04-22T15:04:05.000Z",
  "status": "no data yet",
  "freshness": { "status": "cold-boot", "stale": true, "ageMs": null, "lastRun": null },
  "baselineCount": 0,
  "lastError": null,
  "totals": { "servers": 0, "tools": 0, "findings": 0, "bySeverity": {"critical":0,"high":0,"medium":0,"low":0,"info":0} },
  "servers": [],
  "highPriorityFindings": [],
  "firewall": { "available": false, "reason": "BRAIN_API_URL not configured" }
}
```

### Field reference

| Field | Type | Notes |
|---|---|---|
| `service` | string | Always `ai-security-agent` |
| `schemaVersion` | string | Semver for consumer pinning. Bump on breaking changes. |
| `asOf` | ISO8601 | Response generation timestamp |
| `status` | string | `ok` / `degraded` (prior scan errored) / `no data yet` (cold boot) |
| `freshness.status` | string | `fresh` / `stale` / `cold-boot` / `unknown` |
| `freshness.stale` | boolean | true if `ageMs > 48h` or unknown/cold |
| `freshness.ageMs` | number\|null | Age of last scan in ms |
| `freshness.lastRun` | ISO8601\|null | Same as `lastRun` (convenience) |
| `lastRun` | ISO8601 | When the last scan started |
| `lastError` | object\|null | `{ at, message }` if last run failed |
| `baselineCount` | number | Baselines in memory (server count under watch) |
| `trigger` | string\|null | `cron-daily` / `boot` / `manual` |
| `totals.servers` | number | Tracked MCP servers |
| `totals.tools` | number | Sum of tools across all servers |
| `totals.findings` | number | Sum of findings across all servers |
| `totals.bySeverity` | object | Severity → count |
| `servers[]` | array | `{ name, tools, findings, bySeverity }` per server |
| `highPriorityFindings[]` | array | `{ server, severity, ruleId, title }` — critical + high only, no bodies |
| `firewall.available` | boolean | false if Brain isn't configured or returned an error |
| `firewall.total` | number | Event count in last 24h |
| `firewall.byOutcome` | object | Bucketed by `outcome`/`action`/`decision` (best-effort) |

## Wiring instructions for src/index.js

Add next to the other `/ai-security/*` routes. Gated on `requireApiKey` exactly like the existing posture route:

```js
// top of file, with the other imports
import { getAiSecurityIntel } from './routes/ai-security-intel.js';

// alongside /ai-security/posture etc.
app.get('/intel/ai-security', requireApiKey, async (_req, res) => {
  try {
    const intel = await getAiSecurityIntel();
    res.json(intel);
  } catch (err) {
    console.error('[ai-sec-agent] /intel/ai-security failed:', err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});
```

Optional query-string flag: if the orchestrator wants a lighter response that skips the Brain round-trip, pass `?noFirewall=1` and map it to `getAiSecurityIntel({ includeFirewall: false })`. Not required for v1.

## Security Agent side (if you started it)

Did **not** touch `~/security-agent/`. For the orchestrator to coordinate the pull side:

- Target endpoint: `GET {AI_SECURITY_AGENT_URL}/intel/ai-security`
- Auth header: `x-api-key: {AGENT_API_KEY}` (the same shared key Brain uses)
- Security Agent's `src/intel.js` already runs a polling engine; add a new step that fetches this URL on the existing 5-min cron and stashes the payload alongside its CVE/bounty intel so `/intel/security` can correlate AI-native posture with traditional vuln intel.
- Recommended env vars on Security Agent: `AI_SECURITY_AGENT_URL`, `AI_SECURITY_AGENT_API_KEY` (or reuse `BRAIN_API_KEY` if Arthur wants one shared key across the tier).
- Suggested cadence: same 5-min cron as CVE polling; the ai-security-agent scan itself is daily, so polling more often is cheap (in-memory read + optional Brain call) but not data-additive — 15 min is plenty.

## Test commands

Local dev (backend on `:3100`):

```bash
# Without api key (auth disabled or unset) — should succeed when AGENT_API_KEY unset
curl -s http://localhost:3100/intel/ai-security | jq

# With api key
curl -s -H "x-api-key: $AGENT_API_KEY" http://localhost:3100/intel/ai-security | jq

# Missing/wrong key when AGENT_API_KEY is set — expect 401
curl -i http://localhost:3100/intel/ai-security
curl -i -H "x-api-key: wrong" http://localhost:3100/intel/ai-security

# Production
curl -s -H "x-api-key: $AGENT_API_KEY" \
  https://ai-security-agent-production.up.railway.app/intel/ai-security | jq

# Sanity — trigger a manual scan first, then poll
curl -s -X POST -H "x-api-key: $AGENT_API_KEY" \
  http://localhost:3100/ai-security/scan/trigger | jq
curl -s -H "x-api-key: $AGENT_API_KEY" http://localhost:3100/intel/ai-security | jq '.freshness, .totals'
```

## Open questions / assumptions

- **Assumption:** cron.js's `summarizeReport()` currently exposes `criticals` (array of `"ruleId: title"`). I parse that format and also soft-support a future `highs` field if/when cron.js starts emitting it. If the orchestrator wants high findings surfaced today, cron.js needs a 1-line addition: `highs: findings.filter(f => f.severity === 'high').map(f => \`${f.ruleId}: ${f.title}\`)`. Flagging — did not modify cron.js per scope.
- **Assumption:** firewall event payload shape from Brain is tolerant — I handle both `[...]` and `{ events: [...] }` and bucket by `outcome`/`action`/`decision` (first non-empty wins). If Brain's shape is strictly known, we can tighten this.
- **Route path:** I placed the route at `/intel/ai-security` per the task brief. There's also an existing `/ai-security/posture` which is similar but not identical; the two can coexist (posture = raw cron state, intel = consumer-safe aggregated snapshot with firewall + freshness).
- **No-firewall fallback:** If Brain's `/security/firewall/events` is slow, the endpoint will be slow too. Consider a timeout/AbortController wrapper if latency becomes an issue; not added in v1 to keep changes minimal.

## Freshness logic

- `STALE_AFTER_MS = 48h`
- `lastRun = null` (cold boot, before the boot-run scan lands 5s after listen) → `freshness.status = "cold-boot"`, `stale = true`, overall `status = "no data yet"`
- `lastRun` unparseable → `freshness.status = "unknown"`, `stale = true`
- `ageMs > 48h` → `freshness.status = "stale"`, `stale = true`
- otherwise → `freshness.status = "fresh"`, `stale = false`

This mirrors Security Agent's existing freshness conventions (feed poll timestamps) so their `intel.js` can treat `stale: true` as a trigger to surface a "scan overdue" warning in the next correlation window.
