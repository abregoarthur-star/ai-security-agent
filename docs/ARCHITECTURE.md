# Architecture — AI Security Agent

Tier 3 of the DJ Abstract multi-agent fleet. Owns the **AI-native security tooling portfolio** and exposes it as a single REST surface so Brain (tier 1) and Security Agent (tier 2) can consume AI-sec capabilities without bundling the toolkit into their own dependency trees.

> For quick-reference config see `CLAUDE.md`. For phase/implementation notes see `.agents/*.md`.

## Position in the fleet

```
Brain (master hub — tier 1)
  │  4 proxy tools: audit_mcp_server · diff_mcp_server
  │                 firewall_recent_events · run_self_test
  │     └─▶  ai-security-agent /tools/*
  │  cron callback: /security/mcp-manifests  ◀──┐
  │                 /security/firewall/events ◀─┤
  ▼                                              │
Security Agent (tier 2 — traditional CVE/bounty) │
  │  poll: /intel/ai-security (Phase 3 uplink)   │
  │     └─▶  ai-security-agent /intel/ai-security│
  ▼                                              │
AI Security Agent (tier 3 — this service) ──────┘
  │
  ├── npm: @dj_abstract/mcp-audit                   (detect)
  ├── npm: @dj_abstract/agent-firewall              (defend)
  ├── npm: @dj_abstract/agent-capability-inventory  (inventory)
  └── npm: @dj_abstract/prompt-genesis              (generate + selfTest orchestrator)
```

The tier separation mirrors enterprise orgs — a dedicated AI security team alongside the traditional security team — so tier-2 (CVE/bounty) and tier-3 (AI-native) can evolve independently. All three tiers authenticate to each other with a single shared `AGENT_API_KEY`.

## Stack

- **Runtime:** Node.js 20+ (ESM), Express 4
- **Dependencies:** imports the `@dj_abstract/*` portfolio as npm deps — no `child_process`, no shelling out to installed CLIs
- **Scheduling:** `node-cron`
- **Deployment:** Railway, Docker auto-build from `main`
- **Auth:** single shared `AGENT_API_KEY` header (`x-api-key`); Brain and Security Agent both hold the same key

## Internal layout

```
ai-security-agent/
├── src/
│   ├── index.js                # Express app, auth gate, route wiring
│   ├── cron.js                 # Daily self-scan schedule + in-memory baseline state
│   ├── tools/                  # One handler per /tools/* endpoint
│   │   ├── audit-mcp-server.js
│   │   ├── diff-mcp-server.js
│   │   ├── firewall-events.js
│   │   ├── run-self-test.js
│   │   ├── capability-inventory.js     (Phase 3)
│   │   └── sweep-mcp-ecosystem.js      (Phase 3)
│   └── routes/
│       └── ai-security-intel.js        # Consumer-ready snapshot for Security Agent
├── docs/
│   └── ARCHITECTURE.md         # This file
├── .agents/                    # Parallel-build coordination notes (per-phase)
├── package.json
└── README.md
```

Convention: everything under `src/tools/` is pure data-gathering (no Express coupling) so handlers can be reused by the cron and by future MCP-transport paths. `src/index.js` is the only file that mounts Express.

## Endpoint reference

All `/tools/*`, `/ai-security/*`, and `/intel/*` routes are gated on `x-api-key` when `AGENT_API_KEY` is set. `/health` is always public.

| Method | Route | Purpose | Phase |
|---|---|---|---|
| `GET` | `/health` | Liveness probe. Reveals env-var-set booleans + tool list; no secrets. | 1 |
| `POST` | `/tools/audit_mcp_server` | `@dj_abstract/mcp-audit` static scan of `{ manifest \| manifestData \| stdio \| url }`. | 1 |
| `POST` | `/tools/diff_mcp_server` | `mcp-audit diff` — rug-pull / drift between two reports. | 1 |
| `POST` | `/tools/firewall_recent_events` | Proxy to Brain's `/security/firewall/events`. Returns recent `agent-firewall` activity. | 1 |
| `POST` | `/tools/run_self_test` | Wraps `@dj_abstract/prompt-genesis` `selfTest()` — generate corpus, run through prompt-eval, return ship/hold decision. | 2 |
| `POST` | `/tools/capability_inventory` | `@dj_abstract/agent-capability-inventory` fleet tool catalog w/ sensitivity tags. Accepts inline `manifestData` or filesystem `manifest` path(s). | 3 |
| `POST` | `/tools/sweep_mcp_ecosystem` | Multi-target `mcp-audit` fan-out with bounded concurrency + fleet-level aggregation. Accepts `targets[]` or `baselinesDir`. | 3 |
| `GET` | `/ai-security/posture` | Raw cron-scan state + baseline count + last-scan timestamp. | 1 |
| `GET` | `/ai-security/last-scan` | Most recent scan summary (same shape as `getLastScan()`). | 1 |
| `POST` | `/ai-security/scan/trigger` | Manual scan kickoff — runs `runSelfScan({ trigger: 'manual' })`. | 1 |
| `GET` | `/intel/ai-security` | Consumer-ready snapshot: totals, per-server findings, high-priority findings, firewall 24h stats, freshness. Shaped for Security Agent polling. | 3 |

Request/response shapes for each tool live next to the handler in `src/tools/*.js` and in the phase notes under `.agents/`.

## Cron schedule

Managed by `src/cron.js::startSchedule()`, armed when Express starts listening.

| Schedule | Trigger | Purpose |
|---|---|---|
| `0 3 * * *` | Daily 03:00 UTC | Fetch Brain's MCP manifests via `GET /security/mcp-manifests`, audit `brain-tools` + `brain-exec`, diff against the in-memory baseline. Critical drift → Telegram alert via Brain's `POST /telegram/send`. |
| `+5s` after boot | One-shot | Establishes the baseline and proves the path end-to-end before the first cron fires. |

The baseline is rebuilt on every scan (last good scan becomes the new baseline) so drift detection is always relative to the most recent clean state.

### State shape (`src/cron.js`)

```js
{
  baselines: Map<serverName, mcpAuditReport>,  // in-memory, Phase B-1
  lastRun:   ISO8601 | null,
  lastScan:  { trigger, startedAt, servers[], diffs[] } | null,
  lastError: { at, message } | null,
}
```

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `AGENT_API_KEY` | When used | Shared key for Brain + Security Agent `/tools/*` calls. If unset, auth is disabled (dev only). Legacy alias `API_KEY` accepted. |
| `BRAIN_API_URL` | Required for cron | Brain production URL — cron uses this to fetch MCP manifests and post Telegram alerts. |
| `BRAIN_API_KEY` | Required for cron | Brain's API key for `/security/mcp-manifests`, `/security/firewall/events`, `/telegram/send`. |
| `ANTHROPIC_API_KEY` | Required for `run_self_test` | prompt-eval judge model. |
| `GROQ_API_KEY` | Required if Groq | Required when `run_self_test` uses Groq as generator or target. |
| `PORT` | Auto | Railway assigns; defaults to 3100 in dev. |

## Relationship with individual portfolio repos

Each portfolio repo remains independently maintained and published to npm / GitHub Marketplace. ai-security-agent is the **orchestration and runtime layer** — it doesn't replace the standalone tools.

| Repo | Role in fleet | ai-security-agent endpoint |
|---|---|---|
| [`mcp-audit`](https://github.com/abregoarthur-star/mcp-audit) ([npm](https://www.npmjs.com/package/@dj_abstract/mcp-audit)) | Static MCP analyzer; the `audit()` + `diff()` library | `audit_mcp_server`, `diff_mcp_server`, `sweep_mcp_ecosystem`, daily cron |
| [`mcp-audit-action`](https://github.com/abregoarthur-star/mcp-audit-action) | GitHub Action wrapper, SARIF upload | Out-of-band (used in CI on portfolio repos) |
| [`mcp-audit-sweep`](https://github.com/abregoarthur-star/mcp-audit-sweep) | Reproducible 30-server public audit | `sweep_mcp_ecosystem` dogfoods the same dataset via `baselinesDir` |
| [`agent-capability-inventory`](https://github.com/abregoarthur-star/agent-capability-inventory) ([npm](https://www.npmjs.com/package/@dj_abstract/agent-capability-inventory)) | Tool catalog + sensitivity tags | `capability_inventory` |
| [`prompt-eval`](https://github.com/abregoarthur-star/prompt-eval) ([npm](https://www.npmjs.com/package/@dj_abstract/prompt-eval)) | Runtime injection eval harness | Called transitively by `run_self_test` via `prompt-genesis selfTest()` |
| [`prompt-genesis`](https://github.com/abregoarthur-star/prompt-genesis) ([npm](https://www.npmjs.com/package/@dj_abstract/prompt-genesis)) | Adversarial corpus generator + `selfTest()` orchestrator | `run_self_test` |
| [`agent-firewall`](https://github.com/abregoarthur-star/agent-firewall) ([npm](https://www.npmjs.com/package/@dj_abstract/agent-firewall)) | Call-time defensive middleware (runs on Brain) | `firewall_recent_events` (proxies Brain's activity log) |

## Phase roadmap

| Phase | Status | Shipped | Scope |
|---|---|---|---|
| **Phase 1** | complete | 2026-04-20 | `audit_mcp_server`, `diff_mcp_server`, `firewall_recent_events`; posture + last-scan + manual-trigger endpoints |
| **Phase 2** | complete | 2026-04-20 | `run_self_test` — prompt-genesis `selfTest()` orchestration with ship/hold decision |
| **Phase B** | complete | 2026-04-20 | Daily self-scan cron (03:00 UTC + boot-run), in-memory baseline state, critical-drift Telegram alerts via Brain |
| **Phase 3** | complete | 2026-04-22 | `capability_inventory`, `sweep_mcp_ecosystem`, `/intel/ai-security` Security Agent uplink |
| **Phase B-2** | pending | — | Railway volume for baseline persistence across deploys |
| **Phase 3 follow-up** | pending | — | Full Security Agent integration: pull consumer wired into Security Agent's `src/intel.js` 5-min polling engine so `/intel/security` correlates CVE/bounty intel with AI-native posture |

## Known issues / deferred work

- **Baseline persistence** — currently in-memory only (Phase B-1). A Railway restart or redeploy wipes baselines, so the first post-restart scan just establishes a new baseline rather than flagging drift. Phase B-2 adds a Railway volume for cross-deploy persistence.
- **Supabase JWT rotation** — deferred, see `INCIDENT-RESPONSE-2026-04-21.md` for the mitigation plan.
- **Anthropic workspace migration** — scheduled week of 2026-04-27. Moves the fleet from a single master Anthropic API key to per-project scoped keys. `run_self_test` and any future Claude-calling tools here will need to be re-pointed at the new ai-security-agent-scoped key.
- **Health endpoint disclosure** — `/health` is public and reveals `*_set` booleans for every configured env var. This is intentional (fleet diagnostics) but means anyone hitting the URL learns which integrations are wired. No secret values are exposed.
- **`run_self_test` cost** — each call exercises prompt-genesis + prompt-eval end-to-end. Intended for on-demand CI-style use, not for user-facing chat loops.
