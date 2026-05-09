# Agent F — Phase B-2 Baseline Persistence

**Status:** complete

## What shipped

Phase B-2 makes the daily MCP self-scan's baseline state survive Railway redeploys. Before today, `state.baselines` was an in-memory `Map` rebuilt from scratch on every cold boot — drift went undetected for one full cycle after every deploy. After this change, baselines are written to `${DATA_DIR}/baselines.json` (Railway volume at `/data`) atomically after every successful scan and hydrated on the next boot.

## Files modified

| Path | Change |
|---|---|
| `/Users/arthur/ai-security-agent/src/cron.js` | Added `DATA_DIR` resolution (`process.env.DATA_DIR` → `/data` if it exists → `os.tmpdir()`), `hydrateBaselines()` synchronous loader on module load, `persistBaselines()` atomic temp+rename writer called after every successful `runSelfScan`, and `baselineFile` field on `getLastScan()` for diagnostics. All failures log + continue — the cron stays alive even when persistence is unavailable. |
| `/Users/arthur/ai-security-agent/src/index.js` | Added two keys to the `/health` env block: `DATA_DIR_set: !!process.env.DATA_DIR` (boolean) and `DATA_DIR_path: process.env.DATA_DIR \|\| '<unset>'` (raw value — path is config, not secret, matches the booleans-only-where-secret rule). |
| `/Users/arthur/ai-security-agent/railway.toml` | Added a comment block explaining that the volume must be created in the Railway dashboard (TOML doesn't natively declare volumes inline) and pointing at `DATA_DIR` + `docs/ARCHITECTURE.md`. Build/deploy blocks unchanged. |
| `/Users/arthur/ai-security-agent/docs/ARCHITECTURE.md` | Updated the `src/cron.js` tree comment, the cron schedule table, the state-shape block, the env-vars table (added `DATA_DIR` row), the phase roadmap (Phase B-2 → complete 2026-04-19), and the known-issues "Baseline persistence" bullet. |
| `/Users/arthur/ai-security-agent/CLAUDE.md` | Added `DATA_DIR` to the env-vars table and rewrote the Deployment paragraph to mention the Railway volume mount. |
| `/Users/arthur/ai-security-agent/ARCHITECTURE.html` | Updated 6 lines: file-tree comment, cron-job "Diff against …" line, Boot One-Shot job items + badges, state-shape inline comment, phase roadmap row (pending → complete + green badge), env-chip section (added `DATA_DIR` chip), known-issues "Baseline Persistence" tile (orange/pending → green/shipped). |

## `railway.toml` volume mount syntax

Railway's TOML format doesn't natively declare volumes — `[[deploy.volumes]]` and `[mounts]` are not stable, documented forms in the TOML schema, and the Brain repo (`~/dj-abstract-ai-brain/railway.json`) configures its `/data` volume entirely through the Railway dashboard with no config-file declaration. I followed that pattern: the `railway.toml` carries a comment-block marker, but the actual volume must be created in the Railway dashboard:

> Service → Settings → Volumes → New Volume → mount path = `/data`

This matches the Brain pattern exactly.

## Atomic write + error handling

```
1. Build payload  { savedAt: ISO8601, baselines: Object.fromEntries(state.baselines) }
2. mkdir DATA_DIR (recursive, idempotent)
3. Write to       ${BASELINE_FILE}.${pid}.${Date.now()}.tmp
4. fsp.rename()   tmp → BASELINE_FILE  (atomic on POSIX)
5. Any failure:   log [ai-sec-agent] failed to persist… and try-unlink the tmp; do NOT throw
```

Hydration is synchronous on module load (uses `fs.readFileSync` once) so the boot scan and the `/health` endpoint both see the persisted baselines from the very first request. If the file is missing → `cold start` log. If the file is present but corrupt JSON → log + continue with empty map (verified locally — see Test commands).

## Test commands

### Local — module loads without `/data` (cold start)
```bash
cd ~/ai-security-agent
node -e "import('./src/cron.js').then(m => console.log(m.getLastScan()))"
# expect: "no baseline file found — cold start (looked at /var/folders/.../baselines.json)"
# expect: baselineCount=0, baselineFile points at os.tmpdir()/baselines.json
```

### Local — hydrate-on-boot round-trip
```bash
node -e "
const fs = require('node:fs');
fs.mkdirSync('/tmp/aisec-b2-test', {recursive:true});
fs.writeFileSync('/tmp/aisec-b2-test/baselines.json', JSON.stringify({
  savedAt: new Date().toISOString(),
  baselines: { 'fake-server': { findings: [], server: { counts: { tools: 1 } } } }
}));"

node -e "process.env.DATA_DIR = '/tmp/aisec-b2-test';
  import('./src/cron.js').then(m => {
    const s = m.getLastScan();
    console.log(s.baselineCount === 1 ? 'PASS hydrate' : 'FAIL');
  });"
# verified locally → PASS
```

### Local — corrupt file fallback
```bash
node -e "
const fs = require('node:fs');
fs.mkdirSync('/tmp/aisec-b2-bad', {recursive:true});
fs.writeFileSync('/tmp/aisec-b2-bad/baselines.json', '{ not valid json');"

node -e "process.env.DATA_DIR = '/tmp/aisec-b2-bad';
  import('./src/cron.js').then(m => {
    console.log(m.getLastScan().baselineCount === 0 ? 'PASS fallback' : 'FAIL');
  });"
# verified locally → PASS (logs the parse error and continues with empty map)
```

### Railway — post-deploy verification
```bash
# 1. /health surfaces the new keys
curl -s https://<railway-url>/health | jq '.env | {DATA_DIR_set, DATA_DIR_path}'
# expect: {"DATA_DIR_set": true, "DATA_DIR_path": "/data"}

# 2. /ai-security/last-scan surfaces baselineFile
curl -s -H "x-api-key: $AGENT_API_KEY" https://<railway-url>/ai-security/last-scan | jq
# expect: { ..., "baselineFile": "/data/baselines.json", "baselineCount": 2 }  (after 5s boot scan)

# 3. Tail Railway logs and look for one of:
#    [ai-sec-agent] no baseline file found — cold start (looked at /data/baselines.json)        ← first deploy after Phase B-2
#    [ai-sec-agent] hydrated 2 baseline(s) from /data/baselines.json (savedAt=...)              ← every subsequent deploy
#    [ai-sec-agent] persisted 2 baseline(s) → /data/baselines.json                              ← after each successful scan
```

### Drift survival regression
1. Deploy once → log shows `cold start` then `persisted 2 baseline(s)` after the +5s boot scan.
2. Trigger a redeploy (push any unrelated change).
3. Boot log on the new deploy must show `hydrated 2 baseline(s) from /data/baselines.json` — that's the proof B-2 works.

## Open questions / assumptions

- **Volume creation is manual.** Arthur needs to create the volume via the Railway dashboard (Service → Settings → Volumes, mount path `/data`). The `railway.toml` carries the marker comment but does not auto-provision the volume. If Railway later adds first-class TOML volume syntax we can switch over.
- **`DATA_DIR` env var must be set on Railway** to `/data`. Without it, the cron will fall back to `os.tmpdir()` even on Railway, defeating the purpose. The `/health` endpoint surfaces `DATA_DIR_set` + `DATA_DIR_path` so this is verifiable in one curl.
- **Single-instance assumption.** Atomic-rename write is correct for a single Railway service replica. If we ever scale to multiple instances we'll need a real datastore (Postgres, Upstash) — flagged for the next phase if/when it comes up.
- **Disk size.** `state.baselines` for 2 servers (brain-tools + brain-exec) is ~10–50KB serialized. The default Railway volume (1GB) is overkill; not worth tuning.
- **No deletion logic.** A baseline stays in the map forever until overwritten by a same-named scan. If a server is renamed or removed, the stale entry sticks around. Not a problem at fleet size 2; can add a prune step later.

## Reminders for Arthur — required actions on Railway

1. **Create the volume** in the Railway dashboard for the `ai-security-agent` service:
   - Service → Settings → Volumes → New Volume
   - Mount path: `/data`
   - Size: default (1GB) is fine
2. **Set the env var** in the Railway dashboard:
   - `DATA_DIR=/data`
3. **Verify after deploy** with the three curl commands in the "Railway — post-deploy verification" section above. The boot-log line is the cleanest signal — it explicitly says either "cold start" or "hydrated N baseline(s)".

## Constraints respected

- No commits or pushes (orchestrator handles that).
- No `npm install` — only Node built-ins (`node:fs`, `node:fs/promises`, `node:os`, `node:path`).
- No tools / routes / unrelated files touched. Only `cron.js`, `index.js` (`/health` block only), `railway.toml`, the two architecture docs, and `CLAUDE.md`.
- Service continues to work in local dev where `/data` doesn't exist — verified via the cold-start and bad-file-fallback test commands above.
- Atomic writes only (write to `${BASELINE_FILE}.${pid}.${Date.now()}.tmp` + `fsp.rename`).
