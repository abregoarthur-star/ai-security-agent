import express from 'express';
import { auditMcpServer } from './tools/audit-mcp-server.js';
import { diffMcpServer } from './tools/diff-mcp-server.js';
import { firewallRecentEvents } from './tools/firewall-events.js';

const PORT = process.env.PORT || 3100;
const app = express();
app.use(express.json({ limit: '5mb' }));

// ─── Health ──────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    service: 'ai-security-agent',
    version: '0.1.0',
    status: 'ok',
    uptime: process.uptime(),
    tools: ['audit_mcp_server', 'diff_mcp_server', 'firewall_recent_events'],
    env: {
      AGENT_API_KEY_set: !!(process.env.AGENT_API_KEY || process.env.API_KEY),
      AGENT_API_KEY_len: (process.env.AGENT_API_KEY || process.env.API_KEY || '').length,
      BRAIN_API_URL_set: !!process.env.BRAIN_API_URL,
      BRAIN_API_KEY_set: !!process.env.BRAIN_API_KEY,
    },
  });
});

// ─── Auth (shared key with Brain/Security Agent) ─────────────
function requireApiKey(req, res, next) {
  const expected = process.env.AGENT_API_KEY || process.env.API_KEY;
  if (!expected) return next();
  const got = req.header('x-api-key');
  if (got !== expected) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// ─── Tool endpoints ──────────────────────────────────────────
app.post('/tools/audit_mcp_server', requireApiKey, async (req, res) => {
  try {
    const report = await auditMcpServer(req.body);
    res.json(report);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/tools/diff_mcp_server', requireApiKey, async (req, res) => {
  try {
    const result = await diffMcpServer(req.body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/tools/firewall_recent_events', requireApiKey, async (req, res) => {
  try {
    const events = await firewallRecentEvents(req.body);
    res.json(events);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Aggregated posture (for dashboards) ─────────────────────
app.get('/ai-security/posture', requireApiKey, async (_req, res) => {
  res.json({
    service: 'ai-security-agent',
    asOf: new Date().toISOString(),
    surfaces: {
      // Populated by the scheduler once crons run; empty on first boot.
      tracked: [],
      findings: [],
    },
    note: 'Phase 1 scaffold. Cron-driven scan results land here in Phase 2.',
  });
});

// ─── Global error handler ────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[ai-sec-agent] unhandled error:', err);
  res.status(500).json({ error: 'internal_error', message: err.message });
});

app.listen(PORT, () => {
  console.log(`[ai-sec-agent] listening on :${PORT}`);
});
