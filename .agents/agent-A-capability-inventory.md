# Agent A — capability_inventory

**Status:** complete

## What I built
- `src/tools/capability-inventory.js` — wraps `@dj_abstract/agent-capability-inventory`'s `inventory()` export. Accepts inline `manifestData` (object or array) by staging to a tempdir, or a filesystem `manifest` path (string or array) passed straight through to the library. Tempdir cleanup runs in `finally`.
- Smoke-tested locally against 5 cases (single inline, multi inline, empty input, both-keys error, null input). Classifier correctly tagged `execute_sql` as shell_exec and `send_telegram_message` as network_out in the test run.

## Library API discovered
Package `@dj_abstract/agent-capability-inventory` v0.1.0.
- **Main export (ESM):** `import { inventory } from '@dj_abstract/agent-capability-inventory'`
- **Signature:** `async inventory(inputs) -> { generatedAt, servers, fleet }`
  - `inputs`: a filesystem path (string) OR an array of paths. Each path is a file or directory; directories are recursively walked for `*.json` files, each parsed and classified.
  - Accepts both MCP manifest shape and `mcp-audit` report shape (looks at `manifest.tools` or `manifest.server?.tools`).
- **Return shape:**
  - `generatedAt` — ISO timestamp
  - `servers[]` — each `{ name, tools[], capabilities[], sensitivities[], source, ... }` (risk tags per tool: critical/high/medium/low/minimal)
  - `fleet` — `{ servers, tools, capabilities{}, sensitivities{}, risk{critical,high,medium,low,minimal} }`

**Key constraint:** the library is filesystem-driven. There is NO in-memory entry point. To accept `manifestData` inline (matching audit_mcp_server's pattern), the handler stages the JSON to a tempdir, runs `inventory()` against it, then cleans up.

## Input contract chosen for `capabilityInventory(input)`
Mirrors `auditMcpServer` as closely as possible:
- `{ manifestData: object }` — single inline manifest (wrapped in array internally)
- `{ manifestData: object[] }` — multiple inline manifests (each staged as its own file in one tempdir)
- `{ manifest: path | path[] }` — filesystem path(s) (file or directory), passed through directly

Exactly one of `manifestData` or `manifest` must be provided.

## Wiring instructions for src/index.js
Add import alongside other tool imports near the top:
```js
import { capabilityInventory } from './tools/capability-inventory.js';
```

Add the `tools` array entry in `/health`:
```js
tools: ['audit_mcp_server', 'diff_mcp_server', 'firewall_recent_events', 'run_self_test', 'capability_inventory'],
```

Add the route handler alongside the other `/tools/*` routes (same 400-on-error pattern; the handler returns 500-worthy errors as thrown exceptions — the global error handler catches those):
```js
app.post('/tools/capability_inventory', requireApiKey, async (req, res) => {
  try {
    const result = await capabilityInventory(req.body);
    res.json(result);
  } catch (err) {
    // Input/validation errors → 400; library failures surface via global handler as 500.
    res.status(400).json({ error: err.message });
  }
});
```

(If you want to distinguish library errors as 500 rather than 400, the handler throws `Error` with messages prefixed `capabilityInventory:` for input-validation; library errors propagate with whatever message the lib throws. Simplest: match the existing tools' behavior — 400 for any throw, consistent with `audit_mcp_server`.)

## Test commands
```bash
# 1. Health check — should list capability_inventory
curl -s http://localhost:3100/health | jq '.tools'

# 2. Single inline manifest (brain-tools shape)
curl -s -X POST http://localhost:3100/tools/capability_inventory \
  -H 'content-type: application/json' \
  -H "x-api-key: $AGENT_API_KEY" \
  -d '{
    "manifestData": {
      "server": { "name": "brain-tools" },
      "tools": [
        { "name": "get_user_profile", "description": "Fetch a user profile" },
        { "name": "execute_sql", "description": "Run a SQL query" }
      ]
    }
  }' | jq

# 3. Multiple inline manifests
curl -s -X POST http://localhost:3100/tools/capability_inventory \
  -H 'content-type: application/json' \
  -H "x-api-key: $AGENT_API_KEY" \
  -d '{
    "manifestData": [
      { "server": { "name": "s1" }, "tools": [{ "name": "list_files" }] },
      { "server": { "name": "s2" }, "tools": [{ "name": "send_telegram_message" }] }
    ]
  }' | jq '.fleet'

# 4. Filesystem path (if a manifest is on the server's filesystem)
curl -s -X POST http://localhost:3100/tools/capability_inventory \
  -H 'content-type: application/json' \
  -H "x-api-key: $AGENT_API_KEY" \
  -d '{"manifest": "/tmp/some-manifest.json"}' | jq '.fleet.risk'

# 5. Error path — neither/both provided
curl -s -X POST http://localhost:3100/tools/capability_inventory \
  -H 'content-type: application/json' \
  -H "x-api-key: $AGENT_API_KEY" \
  -d '{}' | jq   # → 400 with validation error
```

## Open questions / assumptions
- **Assumption:** Arthur's orchestrator wants the same `manifestData` convenience the `audit_mcp_server` endpoint offers, so remote callers don't have to pre-stage files on the ai-security-agent host. Backed by the "Follow the same input-pattern" instruction.
- **Assumption:** Accepting `manifestData` as either a single object OR an array of objects is a natural extension — the underlying `inventory()` already accepts an array of inputs, and fleet-wide inventory is the whole point of the tool.
- **Assumption:** Accepting a raw filesystem `manifest` path is safe here because the endpoint is API-key-gated. The lib already walks directories; we pass the path through unchanged.
- **Not wired:** Per instructions, `src/index.js` is untouched. Wiring snippet above.
