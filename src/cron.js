/**
 * Daily MCP self-scan cron.
 *
 * 3am daily (and once on boot): fetch Brain's MCP manifests, audit each,
 * diff against the last-seen baseline. Critical drift → Telegram alert via
 * Brain's /telegram/send endpoint.
 *
 * Phase B-2: baselines now persist to ${DATA_DIR}/baselines.json (Railway
 * volume mounted at /data). On boot we hydrate state.baselines from disk;
 * after every successful scan we atomic-write back. Read/write failures log
 * and continue — persistence is best-effort, the cron must keep running
 * even when the volume is unavailable (local dev, volume not mounted, etc).
 */

import cron from 'node-cron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { auditMcpServer } from './tools/audit-mcp-server.js';
import { diffMcpServer } from './tools/diff-mcp-server.js';

// Persistence config — Railway sets DATA_DIR=/data; locally we fall back to
// os.tmpdir() so tests + dev runs don't crash trying to touch /data.
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : os.tmpdir());
const BASELINE_FILE = path.join(DATA_DIR, 'baselines.json');

// In-memory baseline + last-scan state, hydrated from disk on boot (Phase B-2)
const state = {
  baselines: new Map(),   // server name → last-seen mcp-audit report
  lastRun: null,          // timestamp
  lastScan: null,         // full scan output (for /ai-security/last-scan route)
  lastError: null,
};

// Load baselines synchronously on module load so the boot scan sees them.
function hydrateBaselines() {
  try {
    if (!fs.existsSync(BASELINE_FILE)) {
      console.log(`[ai-sec-agent] no baseline file found — cold start (looked at ${BASELINE_FILE})`);
      return;
    }
    const raw = fs.readFileSync(BASELINE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.baselines && typeof parsed.baselines === 'object') {
      for (const [name, report] of Object.entries(parsed.baselines)) {
        state.baselines.set(name, report);
      }
      console.log(`[ai-sec-agent] hydrated ${state.baselines.size} baseline(s) from ${BASELINE_FILE} (savedAt=${parsed.savedAt || 'unknown'})`);
    } else {
      console.warn(`[ai-sec-agent] baseline file ${BASELINE_FILE} has unexpected shape — ignoring`);
    }
  } catch (err) {
    console.error(`[ai-sec-agent] failed to read baselines from ${BASELINE_FILE}: ${err.message} — continuing with empty map`);
  }
}

hydrateBaselines();

// Atomic write: temp file + rename, so a crash mid-write can't corrupt the
// baseline file. Errors log and return; persistence is best-effort.
async function persistBaselines() {
  const payload = {
    savedAt: new Date().toISOString(),
    baselines: Object.fromEntries(state.baselines),
  };
  const tmpFile = `${BASELINE_FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.writeFile(tmpFile, JSON.stringify(payload), 'utf8');
    await fsp.rename(tmpFile, BASELINE_FILE);
    console.log(`[ai-sec-agent] persisted ${state.baselines.size} baseline(s) → ${BASELINE_FILE}`);
  } catch (err) {
    console.error(`[ai-sec-agent] failed to persist baselines to ${BASELINE_FILE}: ${err.message} — continuing`);
    // Best-effort cleanup of temp file; ignore failure.
    try { await fsp.unlink(tmpFile); } catch { /* noop */ }
  }
}

export function getLastScan() {
  return {
    lastRun: state.lastRun,
    lastScan: state.lastScan,
    lastError: state.lastError,
    baselineCount: state.baselines.size,
    baselineFile: BASELINE_FILE,
  };
}

async function fetchBrainManifests() {
  const base = process.env.BRAIN_API_URL;
  const key = process.env.BRAIN_API_KEY;
  if (!base) throw new Error('BRAIN_API_URL not configured');
  if (!key)  throw new Error('BRAIN_API_KEY not configured');
  const res = await fetch(`${base}/security/mcp-manifests`, {
    headers: { 'x-api-key': key },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Brain manifest fetch: ${res.status} ${body.slice(0, 200)}`);
  }
  return await res.json();
}

async function postTelegram(message) {
  const base = process.env.BRAIN_API_URL;
  const key = process.env.BRAIN_API_KEY;
  if (!base || !key) return;
  try {
    await fetch(`${base}/telegram/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ message }),
    });
  } catch (err) {
    console.error('[ai-sec-agent] telegram post failed:', err.message);
  }
}

function summarizeReport(name, report) {
  const findings = report.findings || [];
  const bySev = findings.reduce((acc, f) => {
    acc[f.severity] = (acc[f.severity] || 0) + 1;
    return acc;
  }, {});
  return {
    name,
    tools: report.server?.counts?.tools ?? 0,
    findings: findings.length,
    bySeverity: bySev,
    criticals: findings.filter(f => f.severity === 'critical').map(f => `${f.ruleId}: ${f.title}`),
  };
}

export async function runSelfScan({ trigger = 'cron' } = {}) {
  const startedAt = new Date().toISOString();
  console.log(`[ai-sec-agent] self-scan starting (${trigger}) at ${startedAt}`);

  try {
    const manifests = await fetchBrainManifests();
    const summaries = [];
    const diffSummaries = [];

    for (const [name, manifest] of Object.entries(manifests)) {
      if (name === 'asOf') continue;
      const report = await auditMcpServer({ manifestData: manifest });
      summaries.push(summarizeReport(name, report));

      const prior = state.baselines.get(name);
      if (prior) {
        try {
          const dr = await diffMcpServer({ baseline: prior, current: report });
          diffSummaries.push({ name, ...dr });
          // Alert on any critical diff finding
          const criticals = (dr.findings || []).filter(f => f.severity === 'critical');
          if (criticals.length) {
            const lines = [
              `🚨 <b>AI-Sec self-scan — CRITICAL DRIFT on ${name}</b>`,
              ...criticals.slice(0, 5).map(f => `• ${f.ruleId}: ${f.title}`),
              `Run: ${startedAt}`,
            ];
            await postTelegram(lines.join('\n'));
          }
        } catch (err) {
          console.error(`[ai-sec-agent] diff failed for ${name}:`, err.message);
        }
      }

      // Always refresh the baseline to the latest good scan
      state.baselines.set(name, report);
    }

    state.lastRun = startedAt;
    state.lastScan = { trigger, startedAt, servers: summaries, diffs: diffSummaries };
    state.lastError = null;
    console.log(`[ai-sec-agent] self-scan complete: ${JSON.stringify(summaries)}`);

    // Phase B-2: persist after every successful scan so a redeploy can
    // hydrate the next boot. Failures log + continue (see persistBaselines).
    await persistBaselines();

    return state.lastScan;

  } catch (err) {
    console.error('[ai-sec-agent] self-scan failed:', err.message);
    state.lastError = { at: startedAt, message: err.message };
    return { error: err.message };
  }
}

export function startSchedule() {
  // Daily at 3am UTC
  cron.schedule('0 3 * * *', () => runSelfScan({ trigger: 'cron-daily' }));
  // Run once on boot to establish baseline and prove the path
  setTimeout(() => runSelfScan({ trigger: 'boot' }), 5_000);
  console.log(`[ai-sec-agent] self-scan schedule armed (daily 03:00 UTC, + boot run in 5s) · baseline file: ${BASELINE_FILE}`);
}
