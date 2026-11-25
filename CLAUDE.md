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

Node.js 22 + Express (ESM). Deployed to Railway (Dockerfile, `npm ci`). Imports `@dj_abstract/mcp-audit`, `@dj_abstract/agent-capability-inventory` and `@dj_abstract/prompt-genesis` as npm deps. `src/app.js` builds the Express app (`createApp`, no side effects — tests build their own); `src/index.js` only listens and starts the schedule. Shared rules live in `src/lib/`: `auth.js` (keys, capabilities), `policy.js` (stdio, paths, sizes, self-test caps), `url-guard.js` (caller-supplied URLs), `spend.js` (self-test ledger and daily cap), `store.js` (the one JSON-file store both the scan state and the ledger use), `data-dir.js`.

## Phase 1 routes

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness probe (public): service, version, status, uptime, tool names. No configuration detail. |
| `POST` | `/ai-security/baselines/:name/reset` | Authenticated (`scan`). Drops one server's baseline when a diff keeps failing against it; recorded in scan state (`resets`) with the caller. The next scan stores a new baseline without a drift check. |
| `GET` | `/ai-security/spend` | Authenticated. Self-test spend: today against the cap, 30 days of daily totals, each run. |
| `GET` | `/ai-security/config` | Authenticated. Caller names, which env vars are set (yes/no), data dir, limits. Never a secret value. |
| `POST` | `/tools/audit_mcp_server` | Run `mcp-audit` against `{ manifestData | manifest | url | stdio }` — see "What a caller can make the server do". |
| `POST` | `/tools/diff_mcp_server` | Diff two mcp-audit reports for rug-pull detection. |
| `POST` | `/tools/firewall_recent_events` | Fetch recent agent-firewall events from Brain. |
| `GET` | `/ai-security/posture` | Aggregated state of tracked surfaces (Phase 2 will populate). |

| `POST` | `/sensor/events` | Lure-sensor intake ([agent-lure](https://github.com/abregoarthur-star/agent-lure)). Only callers named `lure-<site>` (capability `sensor`); body `{ events: [...] }`, ≤50 per post, 64 KB. |
| `GET` | `/sensor/events` | Authenticated (`posture`). Latest events, `?site=&kind=&limit=` (≤500). |
| `GET` | `/sensor/summary` | Authenticated (`posture`). Per site: totals, last 24 h, by kind and lure, distinct sources, sources that took an agent lure. |

All `/tools/*`, `/intel/*`, `/sensor/*` and `/ai-security/*` routes need `x-api-key`. Callers come from `AGENT_API_KEYS` (`name:key,name:key`) plus `AGENT_API_KEY` / `API_KEY` as caller `legacy`. **With no key configured every one of these routes answers 503, in every environment** — set a key to develop locally. Wrong or missing key → 401. Each request logs the caller name.

## What a caller can make the server do

A valid key is not full trust (`src/lib/policy.js`, `src/lib/url-guard.js`). A refusal is a 403 with a `code`.

- **`manifestData` (inline)** — the normal mode. Limited to 1 MB each, 50 per sweep or inventory call (constants in `policy.js`).
- **`stdio`** — runs a command on this server. Off unless `ALLOW_STDIO_AUDIT=1`, and then only for a complete command line listed in `STDIO_ALLOWLIST` (comma-separated; the whole line must match — a command name alone would allow `node -e …`). The spawned process inherits this service's environment (that is mcp-audit's behaviour), so list only commands you trust with its secrets.
- **File paths** (`manifest`, `baselinesDir`, string `baseline`/`current` in a diff, inventory paths) — only inside `MANIFEST_ROOT` (default `<data dir>/manifests`), checked after resolving symlinks. Relative paths are taken from that root; `~` is not expanded.
- **`url`** (and a self-test `target.url`) — http(s) only, public addresses only: loopback, RFC 1918, link-local (169.254.169.254 included), CGNAT, IPv6 loopback / unique-local / link-local and IPv4-mapped forms are refused. For audits the check is repeated when the connection is made and on every redirect, and the whole audit has a 30-second deadline. Requests to the configured `BRAIN_API_URL` are not subject to this.
- **`run_self_test`** — `rounds` and `maxCostUsdPerGen` are capped by `SELF_TEST_MAX_ROUNDS` / `SELF_TEST_MAX_COST_USD_PER_GEN`; a caller may lower them, never raise them. `generatorModel` and `judgeModel` must be on `SELF_TEST_MODEL_ALLOWLIST` (400 `model_not_allowed`); the check is on the model the run will use, so the built-in defaults (`claude-sonnet-5-5`, `claude-haiku-5-5`) are held to it too. On top of that a **daily cap** (`SELF_TEST_DAILY_CAP_USD`, UTC day): a run is refused (429, `daily_cap`) when today's recorded spend plus runs in flight plus this run's maximum (2 × `maxCostUsdPerGen`) would pass it. With the default $3.00 cap that is one default-size run a day.
- **Capabilities** — `CALLER_CAPABILITIES` (`name=cap|cap,name=*`) narrows a caller to named capabilities: the six tool names, `intel`, `posture`, `scan`, `admin`. A caller not listed may use everything.

## Lure sensors (`src/lib/sensor-events.js`)

Fleet services run an agent-lure sensor that reports here. A sensor's key is named `lure-<site>` in `AGENT_API_KEYS` (e.g. `lure-brain`, `lure-portfolio`); such a caller may **only** post events, whatever `CALLER_CAPABILITIES` says, and no other caller may post (`auth.js`). Sensor keys sit on public services, so this keeps a leaked one harmless.

- The site is the key name minus `lure-`, never a body field; the kind (`crawl` / `instruction` / `bait`) is derived from the lure name; unknown lures are dropped, strings cut, a sensor clock more than a day off is replaced by arrival time.
- Kept in `<data dir>/sensor-events.json`: 30 days, at most 5,000 events.
- **Telegram** (through Brain's `/telegram/send`, `src/lib/telegram.js`, shared with the self-scan): the first `instruction` or `bait` hit per source (ip + user agent) per site per UTC day. `crawl` hits (robots Disallow, path fragments) never alert. The alert is sent in the background; the sensor gets its 202 at once.
- Lab-measured on Claude Haiku 5.5 (2026-11-25): attack-task agents 10/10 caught even with a system-prompt defence against page instructions, benign agents 0/10, non-LLM crawlers 0 false alarms. The live false-alarm count started at deploy.

## Spend ledger (`src/lib/spend.js`)

`run_self_test` is the only thing here that costs money. Every run is recorded in `<data dir>/self-test-spend.json`: time, caller, target kind and model, generator and judge models, rounds, cost, call counts; plus daily totals for 30 days. Read it at `GET /ai-security/spend`; today's figure is also in `GET /ai-security/config`. The dollar figure is `generationUsd` + `evaluationUsd`, both as reported by prompt-genesis (0.4.0+); evaluation is the target and judge calls, and a target that reports no token usage (`http`, `brain`, `groq`, `together`) contributes 0. Both count toward the day. The cap's pre-run worst case is still 2 × `maxCostUsdPerGen` — only generation has a hard limit — so evaluation (cents on the allowlisted models) can take a day slightly past the cap. A run that fails is counted at its maximum, because what it spent is unknown. Without a volume the ledger, and so the daily cap's memory, resets on every redeploy.

## Daily self-scan (`src/cron.js`)

03:00 UTC and once on boot. State — baselines, last scan, last error, which errors were already alerted — is in `<data dir>/baselines.json` and survives a restart when the data dir does. A server whose audit or diff fails keeps its old baseline; the error is in `lastScan.errors` / `lastError` and goes to Telegram **once per distinct error** (again if it recurs after a clean run). A scan that fails outright alerts the same way. A Telegram send that fails is recorded (`alerting.last`, `lastScan.alerts`) and retried on the next run; an undelivered critical-drift alert keeps the old baseline so the drift is found again. `createScanner()` takes its fetch, audit, diff and data dir as arguments for tests.

## Tests

`npm test` — node:test, no network (loopback servers only), no model calls. CI runs it, and `npm audit --audit-level=high` fails the job.

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
| `AGENT_API_KEYS` | Per-caller keys, `brain:<key>,security-agent:<key>`. |
| `AGENT_API_KEY` / `API_KEY` | One shared key, caller `legacy`. With neither this nor `AGENT_API_KEYS`, protected routes answer 503. |
| `CALLER_CAPABILITIES` | Optional. `name=cap|cap,…`; unlisted callers may use everything. |
| `MANIFEST_ROOT` | Directory callers may name files in. Default `<data dir>/manifests`. |
| `ALLOW_STDIO_AUDIT`, `STDIO_ALLOWLIST` | `1` plus a comma-separated list of complete command lines. Default: stdio audits off. |
| `SELF_TEST_MAX_ROUNDS`, `SELF_TEST_MAX_COST_USD_PER_GEN` | Server-side caps for `run_self_test`. Defaults 30 and 1.50. |
| `SELF_TEST_DAILY_CAP_USD` | Daily dollar cap across all `run_self_test` runs. Default 3.00. |
| `SELF_TEST_MODEL_ALLOWLIST` | Comma-separated generator / judge models a caller may name. Default `claude-sonnet-5-5`, `claude-haiku-5-5`, `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`, `meta-llama/llama-4-scout-17b-16e-instruct`. |
| `BRAIN_API_URL` | Brain prod URL — used by `firewallRecentEvents`. |
| `BRAIN_API_KEY` | Brain's API key for `/security/firewall/events`. |
| `ANTHROPIC_API_KEY` | Reserved for Phase 2 summarization crons. |
| `DATA_DIR` | Persistence directory (baselines + scan state). **Railway only** — set to `/data` and mount a volume at the same path. Unset → `/data` if it exists, else `os.tmpdir()`. Mirrors the Brain pattern. |

## Development

```bash
npm install
AGENT_API_KEY=dev-key npm run dev   # a key is required: without one every protected route is 503
npm test
curl -s http://localhost:3100/health | jq
```

## Deployment

Railway (project `romantic-beauty`, service `ai-security-agent`), auto-deploy on push to `main`.

> **Volume attached 2026-11-24:** `/data` with `DATA_DIR=/data` — baselines, the self-test spend ledger and sensor events persist across redeploys.

Phase B-2 planned a Railway volume mounted at `/data` (configured in the Railway dashboard — Service → Settings → Volumes) for baseline persistence; set `DATA_DIR=/data` on the service so `src/cron.js` reads/writes `${DATA_DIR}/baselines.json` across redeploys.

## Portfolio framing

This repo is the "runtime AI security" pane of glass. Hiring managers at Lakera / Protect AI / HiddenLayer / BigID recognize the pattern: a dedicated service that aggregates the detection toolkit behind one interface and feeds it into the existing security workflow. It's exactly the shape a commercial AI-AppSec product takes internally.
