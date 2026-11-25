import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditMcpServer } from './tools/audit-mcp-server.js';
import { diffMcpServer } from './tools/diff-mcp-server.js';
import { firewallRecentEvents } from './tools/firewall-events.js';
import { runSelfTest } from './tools/run-self-test.js';
import { capabilityInventory } from './tools/capability-inventory.js';
import { sweepMcpEcosystem } from './tools/sweep-mcp-ecosystem.js';
import { getAiSecurityIntel } from './routes/ai-security-intel.js';
import { getLastScan, runSelfScan, resetBaseline } from './cron.js';
import { createAuth, loadAgentKeys, loadCapabilities, SENSOR_PREFIX } from './lib/auth.js';
import { createSensorStore } from './lib/sensor-events.js';
import { resolveDataDir, resolveManifestRoot } from './lib/data-dir.js';
import { limits, stdioAllowlist } from './lib/policy.js';
import { createSpendLedger } from './lib/spend.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { version: VERSION } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

// One entry per /tools/* route. The name is the route, the capability a
// caller needs, and what /health advertises.
const TOOLS = {
  audit_mcp_server: auditMcpServer,
  diff_mcp_server: diffMcpServer,
  firewall_recent_events: firewallRecentEvents,
  run_self_test: runSelfTest,
  capability_inventory: capabilityInventory,
  sweep_mcp_ecosystem: sweepMcpEcosystem,
};

/**
 * Build the Express app. Nothing here listens or schedules, so tests can
 * build one with their own keys, tools and scan functions.
 */
export function createApp({
  env = process.env,
  tools = TOOLS,
  scan = { getLastScan, runSelfScan, resetBaseline },
  intel = getAiSecurityIntel,
  ledger = createSpendLedger({ env }),
  sensors = createSensorStore({ env }),
  log = (line) => console.log(line),
} = {}) {
  const auth = createAuth({ keys: loadAgentKeys(env), capabilities: loadCapabilities(env), log });
  if (!auth.configured) {
    console.warn('[auth] no AGENT_API_KEYS / AGENT_API_KEY configured — every protected route will answer 503');
  }

  const app = express();
  app.disable('x-powered-by');
  // Parsed only after the key check, so an unauthenticated request cannot make the server read a large body.
  const json = express.json({ limit: '5mb' });

  // ─── Public: architecture doc and liveness ───────────────────
  app.get('/architecture', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'ARCHITECTURE.html'));
  });

  // Liveness only. Configuration detail is on GET /ai-security/config (authenticated).
  app.get('/health', (_req, res) => {
    res.json({
      service: 'ai-security-agent',
      version: VERSION,
      status: 'ok',
      uptime: process.uptime(),
      tools: Object.keys(tools),
    });
  });

  // ─── Tool endpoints ──────────────────────────────────────────
  for (const [name, run] of Object.entries(tools)) {
    app.post(`/tools/${name}`, auth.gate(name), json, async (req, res) => {
      try {
        res.json(await run(req.body, { env, caller: req.caller, ledger }));
      } catch (err) {
        const status = Number.isInteger(err.status) ? err.status : 400;
        if (status === 403) log(`[policy] ${req.caller} refused on ${name}: ${err.code || err.message}`);
        res.status(status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
      }
    });
  }

  // ─── Security Agent uplink ───────────────────────────────────
  app.get('/intel/ai-security', auth.gate('intel'), async (_req, res) => {
    try {
      res.json(await intel());
    } catch (err) {
      console.error('[ai-sec-agent] /intel/ai-security failed:', err);
      res.status(500).json({ error: 'internal_error', message: err.message });
    }
  });

  // ─── Lure sensors (agent-lure) ───────────────────────────────
  // Only callers named lure-<site> may post (see auth.js); the site is taken
  // from the key name, never from the body.
  app.post('/sensor/events', auth.gate('sensor'), express.json({ limit: '64kb' }), async (req, res) => {
    const site = req.caller.slice(SENSOR_PREFIX.length);
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(site)) return res.status(403).json({ error: 'forbidden', message: 'sensor key name must be lure-<site>' });
    const out = await sensors.ingest(site, req.body?.events);
    res.status(202).json(out);
  });

  app.get('/sensor/events', auth.gate('posture'), (req, res) => {
    res.json({ events: sensors.list({ site: req.query.site, kind: req.query.kind, limit: req.query.limit }) });
  });

  app.get('/sensor/summary', auth.gate('posture'), (_req, res) => {
    res.json(sensors.summary());
  });

  // ─── Aggregated posture (for dashboards) ─────────────────────
  app.get('/ai-security/posture', auth.gate('posture'), (_req, res) => {
    res.json({ service: 'ai-security-agent', asOf: new Date().toISOString(), ...scan.getLastScan() });
  });

  app.get('/ai-security/last-scan', auth.gate('posture'), (_req, res) => {
    res.json(scan.getLastScan());
  });

  app.post('/ai-security/scan/trigger', auth.gate('scan'), async (_req, res) => {
    try {
      res.json(await scan.runSelfScan({ trigger: 'manual' }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Drop one server's baseline (a diff that keeps failing against it). Recorded with the caller.
  app.post('/ai-security/baselines/:name/reset', auth.gate('scan'), async (req, res) => {
    const done = await scan.resetBaseline(req.params.name, req.caller);
    if (!done) return res.status(404).json({ error: `no baseline named "${req.params.name}"` });
    res.json({ reset: req.params.name, by: req.caller, note: 'the next scan stores a new baseline without a drift check' });
  });

  // ─── Self-test spend: today, 30 days of daily totals, each run ─────
  app.get('/ai-security/spend', auth.gate('admin'), (_req, res) => {
    res.json(ledger.summary());
  });

  // ─── Configuration (what /health used to show, now behind a key) ─────
  // Names and yes/no only — never a secret value.
  app.get('/ai-security/config', auth.gate('admin'), (req, res) => {
    res.json({
      caller: req.caller,
      callers: auth.callers,
      legacy_key_set: !!(env.AGENT_API_KEY || env.API_KEY),
      capabilities_restricted_for: Object.keys(loadCapabilities(env)),
      env: {
        BRAIN_API_URL_set: !!env.BRAIN_API_URL,
        BRAIN_API_KEY_set: !!env.BRAIN_API_KEY,
        ANTHROPIC_API_KEY_set: !!env.ANTHROPIC_API_KEY,
        GROQ_API_KEY_set: !!env.GROQ_API_KEY,
        DATA_DIR_set: !!env.DATA_DIR,
      },
      dataDir: resolveDataDir(env),
      manifestRoot: resolveManifestRoot(env),
      stdio: { enabled: env.ALLOW_STDIO_AUDIT === '1', allowlisted: stdioAllowlist(env).length },
      limits: limits(env),
      selfTestSpendToday: ledger.today(),
    });
  });

  // ─── Errors ──────────────────────────────────────────────────
  app.use((err, _req, res, _next) => {
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'request body too large' });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'request body is not valid JSON' });
    console.error('[ai-sec-agent] unhandled error:', err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
