/**
 * GET /intel/ai-security — consolidated AI-native posture for Security Agent polling.
 *
 * Mirrors the Brain-side `GET /intel/*` pattern that Security Agent's `intel.js` already
 * knows how to consume. Returns a stable, side-effect-free snapshot built from:
 *   - The last self-scan state (via getLastScan() in src/cron.js)
 *   - Aggregated counts across all tracked MCP servers and findings
 *   - High-priority findings (critical + high), names/rules/titles only (no sensitive detail)
 *   - A freshness flag (stale if last scan > 48h ago)
 *   - Optional recent firewall event count from Brain (last 24h), best-effort
 *
 * No Express dependency here — this is pure data-gathering. The main index.js wraps
 * the returned object in a route handler, gated behind requireApiKey.
 */

import { getLastScan } from '../cron.js';
import { firewallRecentEvents } from '../tools/firewall-events.js';

const STALE_AFTER_MS = 48 * 60 * 60 * 1000; // 48h
const FIREWALL_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const HIGH_PRIORITY_SEVERITIES = new Set(['critical', 'high']);
const SCHEMA_VERSION = '1.0.0';

/**
 * Aggregate per-server summaries produced by cron.js::summarizeReport().
 * Each summary has shape: { name, tools, findings, bySeverity, criticals }
 */
function aggregateScan(lastScan) {
  const servers = Array.isArray(lastScan?.servers) ? lastScan.servers : [];

  const totals = {
    servers: servers.length,
    tools: 0,
    findings: 0,
    bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  };

  for (const s of servers) {
    totals.tools += Number(s.tools || 0);
    totals.findings += Number(s.findings || 0);
    const bs = s.bySeverity || {};
    for (const [sev, count] of Object.entries(bs)) {
      totals.bySeverity[sev] = (totals.bySeverity[sev] || 0) + Number(count || 0);
    }
  }

  return { totals, servers };
}

/**
 * Flatten to a compact list of high-priority finding identifiers.
 * cron.js::summarizeReport currently surfaces `criticals` as `"ruleId: title"` strings;
 * we preserve that shape for criticals and re-materialize name/rule/title triples
 * so consumers get stable field names even if the upstream summarizer evolves.
 */
function extractHighPriority(servers) {
  const out = [];
  for (const s of servers) {
    const criticals = Array.isArray(s.criticals) ? s.criticals : [];
    for (const entry of criticals) {
      // entry is "ruleId: title"
      const idx = typeof entry === 'string' ? entry.indexOf(':') : -1;
      const ruleId = idx >= 0 ? entry.slice(0, idx).trim() : null;
      const title = idx >= 0 ? entry.slice(idx + 1).trim() : String(entry || '');
      out.push({
        server: s.name,
        severity: 'critical',
        ruleId,
        title,
      });
    }
    // Soft-support a future `highs` field without breaking if absent.
    const highs = Array.isArray(s.highs) ? s.highs : [];
    for (const entry of highs) {
      const idx = typeof entry === 'string' ? entry.indexOf(':') : -1;
      const ruleId = idx >= 0 ? entry.slice(0, idx).trim() : null;
      const title = idx >= 0 ? entry.slice(idx + 1).trim() : String(entry || '');
      out.push({
        server: s.name,
        severity: 'high',
        ruleId,
        title,
      });
    }
  }
  return out;
}

function computeFreshness(lastRun) {
  if (!lastRun) {
    return { status: 'cold-boot', stale: true, ageMs: null, lastRun: null };
  }
  const ts = Date.parse(lastRun);
  if (Number.isNaN(ts)) {
    return { status: 'unknown', stale: true, ageMs: null, lastRun };
  }
  const ageMs = Date.now() - ts;
  return {
    status: ageMs > STALE_AFTER_MS ? 'stale' : 'fresh',
    stale: ageMs > STALE_AFTER_MS,
    ageMs,
    lastRun,
  };
}

/**
 * Best-effort firewall event count over the last 24h.
 * Never throws — returns { available: false, reason } on any failure so the
 * main intel payload is still useful if Brain is down or misconfigured.
 */
async function fetchFirewallEventCount() {
  // If Brain isn't wired up, skip silently.
  if (!process.env.BRAIN_API_URL) {
    return { available: false, reason: 'BRAIN_API_URL not configured' };
  }

  try {
    const since = new Date(Date.now() - FIREWALL_WINDOW_MS).toISOString();
    const payload = await firewallRecentEvents({ since, limit: 500 });

    // Brain may return either an array or { events: [...] } depending on version;
    // tolerate both shapes.
    const events = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.events)
        ? payload.events
        : [];

    // Bucket by outcome where available (block / warn / allow). Unknown falls through.
    const byOutcome = {};
    for (const e of events) {
      const key = String(e?.outcome || e?.action || e?.decision || 'unknown').toLowerCase();
      byOutcome[key] = (byOutcome[key] || 0) + 1;
    }

    return {
      available: true,
      windowHours: 24,
      since,
      total: events.length,
      byOutcome,
    };
  } catch (err) {
    return { available: false, reason: err.message };
  }
}

/**
 * Build the full AI-security intel snapshot.
 * Pure function of cron state + (best-effort) Brain firewall pull. No writes.
 */
export async function getAiSecurityIntel({ includeFirewall = true } = {}) {
  const asOf = new Date().toISOString();
  const scan = getLastScan();

  // Cold boot — no scan has landed yet (boot-run fires 5s after listen).
  if (!scan || !scan.lastRun) {
    const firewall = includeFirewall ? await fetchFirewallEventCount() : null;
    return {
      service: 'ai-security-agent',
      schemaVersion: SCHEMA_VERSION,
      asOf,
      status: 'no data yet',
      freshness: computeFreshness(null),
      baselineCount: scan?.baselineCount ?? 0,
      lastError: scan?.lastError ?? null,
      totals: {
        servers: 0,
        tools: 0,
        findings: 0,
        bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      },
      servers: [],
      highPriorityFindings: [],
      firewall,
    };
  }

  const { totals, servers } = aggregateScan(scan.lastScan);
  const highPriorityFindings = extractHighPriority(servers);
  const freshness = computeFreshness(scan.lastRun);
  const firewall = includeFirewall ? await fetchFirewallEventCount() : null;

  return {
    service: 'ai-security-agent',
    schemaVersion: SCHEMA_VERSION,
    asOf,
    status: scan.lastError ? 'degraded' : 'ok',
    freshness,
    lastRun: scan.lastRun,
    lastError: scan.lastError ?? null,
    baselineCount: scan.baselineCount ?? servers.length,
    trigger: scan.lastScan?.trigger ?? null,
    totals,
    // Per-server high-level posture. No raw finding bodies.
    servers: servers.map((s) => ({
      name: s.name,
      tools: s.tools,
      findings: s.findings,
      bySeverity: s.bySeverity || {},
    })),
    // Flat list, name/rule/title only — safe to forward to Security Agent.
    highPriorityFindings: highPriorityFindings.filter((f) =>
      HIGH_PRIORITY_SEVERITIES.has(f.severity)
    ),
    firewall,
  };
}
