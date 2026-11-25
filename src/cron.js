/**
 * Daily MCP self-scan.
 *
 * 03:00 UTC daily (and once on boot): fetch Brain's MCP manifests, audit
 * each, diff against the last-seen baseline. Critical drift → Telegram alert
 * through Brain's /telegram/send.
 *
 * A scan that cannot do its job says so:
 *   - a server whose audit or diff fails keeps its old baseline, the error is
 *     recorded in the scan and alerted (once per distinct error);
 *   - a scan that fails outright is alerted the same way;
 *   - an alert that could not be delivered is recorded, and a critical-drift
 *     alert that was not delivered keeps the old baseline so the drift is
 *     found, and alerted, again on the next run;
 *   - missing Brain settings are recorded in the scan state, not skipped
 *     silently.
 *
 * State (baselines, last scan, last error, which errors were already
 * alerted) is kept in ${DATA_DIR}/baselines.json and read back on boot.
 * Reading and writing are best-effort: the scan keeps running without them.
 */

import cron from 'node-cron';
import path from 'node:path';
import { auditMcpServer } from './tools/audit-mcp-server.js';
import { diffMcpServer } from './tools/diff-mcp-server.js';
import { resolveDataDir } from './lib/data-dir.js';
import { jsonFile } from './lib/store.js';
import { sendTelegram, escapeHtml } from './lib/telegram.js';

const FETCH_TIMEOUT_MS = 30_000;

function summarizeReport(name, report) {
  const findings = report.findings || [];
  const bySev = findings.reduce((acc, f) => {
    acc[f.severity] = (acc[f.severity] || 0) + 1;
    return acc;
  }, {});
  const labels = (severity) => findings
    .filter((f) => f.severity === severity)
    .map((f) => `${f.ruleId}: ${f.title}`);
  return {
    name,
    tools: report.server?.counts?.tools ?? 0,
    findings: findings.length,
    bySeverity: bySev,
    criticals: labels('critical'),
    highs: labels('high'),
  };
}

/**
 * Build a scanner. Everything it touches outside the process is passed in,
 * so tests run it with a fake fetch and a scratch directory.
 */
export function createScanner({
  env = process.env,
  fetchImpl = (...args) => fetch(...args),
  audit = auditMcpServer,
  diff = (input) => diffMcpServer(input, { trusted: true }),
  dataDir = resolveDataDir(env),
  log = console,
} = {}) {
  const store = jsonFile(path.join(dataDir, 'baselines.json'), log);
  const baselineFile = store.file;

  const state = {
    baselines: new Map(),   // server name → last-seen mcp-audit report
    lastRun: null,          // start time of the last scan that completed
    lastAttempt: null,      // start time of the last scan, completed or not
    lastScan: null,         // output of the last completed scan
    lastError: null,        // { at, message, errors? } — why the last scan failed or was incomplete
    alertedErrors: [],      // error keys already sent to Telegram (one alert per distinct error)
    resets: [],             // baselines dropped by hand: { at, name, caller } (last 20)
    alerting: { configured: null, last: null },
  };
  let running = null;

  // ── persistence ────────────────────────────────────────────────────────────

  function hydrate() {
    const parsed = store.read();
    if (!parsed) {
      log.log(`[ai-sec-agent] no usable baseline file — cold start (looked at ${baselineFile})`);
      return;
    }
    if (typeof parsed !== 'object' || !parsed.baselines || typeof parsed.baselines !== 'object') {
      log.warn(`[ai-sec-agent] baseline file ${baselineFile} has unexpected shape — ignoring`);
      return;
    }
    for (const [name, report] of Object.entries(parsed.baselines)) state.baselines.set(name, report);
    // Files written before scan state was persisted carry baselines only.
    const saved = parsed.scanState;
    if (saved && typeof saved === 'object') {
      state.lastRun = saved.lastRun ?? null;
      state.lastAttempt = saved.lastAttempt ?? null;
      state.lastScan = saved.lastScan ?? null;
      state.lastError = saved.lastError ?? null;
      state.alertedErrors = Array.isArray(saved.alertedErrors) ? saved.alertedErrors : [];
      state.resets = Array.isArray(saved.resets) ? saved.resets : [];
      if (saved.alerting && typeof saved.alerting === 'object') state.alerting = saved.alerting;
    }
    log.log(`[ai-sec-agent] hydrated ${state.baselines.size} baseline(s) from ${baselineFile} (savedAt=${parsed.savedAt || 'unknown'}, lastRun=${state.lastRun || 'never'})`);
  }

  async function persist() {
    const { baselines, ...scanState } = state;
    const ok = await store.write({ savedAt: new Date().toISOString(), baselines: Object.fromEntries(baselines), scanState });
    if (ok) log.log(`[ai-sec-agent] persisted ${baselines.size} baseline(s) + scan state → ${baselineFile}`);
  }

  // ── Brain ──────────────────────────────────────────────────────────────────

  const brainBase = () => String(env.BRAIN_API_URL || '').replace(/\/$/, '');

  async function fetchBrainManifests() {
    const key = env.BRAIN_API_KEY;
    if (!brainBase()) throw new Error('BRAIN_API_URL not configured');
    if (!key) throw new Error('BRAIN_API_KEY not configured');
    const res = await fetchImpl(`${brainBase()}/security/mcp-manifests`, {
      headers: { 'x-api-key': key },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Brain manifest fetch: ${res.status} ${body.slice(0, 200)}`);
    }
    return await res.json();
  }

  /** Send one alert. Never throws; the outcome is returned and kept in state.alerting. */
  async function postTelegram(kind, message) {
    state.alerting.configured = !!(brainBase() && env.BRAIN_API_KEY);
    const outcome = await sendTelegram({ env, fetchImpl, kind, message, log });
    state.alerting.last = outcome;
    return outcome;
  }

  /**
   * Alert on each error not alerted before. An error stays "alerted" for as
   * long as it keeps happening; once it stops, the same error alerts again if
   * it comes back. An alert that was not delivered is tried again next run.
   */
  async function alertOnErrors(errors, startedAt, alerts) {
    const active = new Set(errors.map((e) => e.key));
    const already = new Set(state.alertedErrors.filter((k) => active.has(k)));
    for (const e of errors) {
      if (already.has(e.key)) continue;
      const outcome = await postTelegram(e.stage, [
        `⚠️ <b>AI-Sec self-scan — ${escapeHtml(e.headline)}</b>`,
        escapeHtml(e.message).slice(0, 600),
        e.note ? escapeHtml(e.note) : null,
        `Run: ${startedAt}`,
        'Repeats of this same error are not re-sent.',
      ].filter(Boolean).join('\n'));
      alerts.push({ ...outcome, error_key: e.key });
      if (outcome.ok) already.add(e.key);
    }
    state.alertedErrors = [...already];
  }

  // ── the scan ───────────────────────────────────────────────────────────────

  async function scan(trigger) {
    const startedAt = new Date().toISOString();
    state.lastAttempt = startedAt;
    state.alerting.configured = !!(brainBase() && env.BRAIN_API_KEY);
    log.log(`[ai-sec-agent] self-scan starting (${trigger}) at ${startedAt}`);
    const alerts = [];

    let manifests;
    try {
      manifests = await fetchBrainManifests();
      if (!manifests || typeof manifests !== 'object' || Array.isArray(manifests)) {
        throw new Error('Brain manifest fetch: response is not an object of manifests');
      }
    } catch (err) {
      log.error('[ai-sec-agent] self-scan failed:', err.message);
      state.lastError = { at: startedAt, message: err.message };
      await alertOnErrors([{
        key: `scan:${err.message}`,
        stage: 'scan-failed',
        headline: 'scan FAILED',
        message: err.message,
        note: 'No server was audited; baselines are unchanged.',
      }], startedAt, alerts);
      await persist();
      return { error: err.message, alerts };
    }

    const summaries = [];
    const diffSummaries = [];
    const errors = [];

    for (const [name, manifest] of Object.entries(manifests)) {
      if (name === 'asOf') continue;

      let report;
      try {
        report = await audit({ manifestData: manifest });
      } catch (err) {
        log.error(`[ai-sec-agent] audit failed for ${name}:`, err.message);
        errors.push({
          key: `audit:${name}:${err.message}`, stage: 'audit-failed', name,
          headline: `audit FAILED on ${name}`, message: err.message,
          note: 'This server was not checked; its baseline is unchanged.',
        });
        continue;
      }
      summaries.push(summarizeReport(name, report));

      const prior = state.baselines.get(name);
      let keepPrior = false;
      if (prior) {
        try {
          const dr = await diff({ baseline: prior, current: report });
          diffSummaries.push({ name, ...dr });
          const criticals = (dr.findings || []).filter((f) => f.severity === 'critical');
          if (criticals.length) {
            const outcome = await postTelegram('critical-drift', [
              `🚨 <b>AI-Sec self-scan — CRITICAL DRIFT on ${escapeHtml(name)}</b>`,
              ...criticals.slice(0, 5).map((f) => `• ${escapeHtml(`${f.ruleId}: ${f.title}`)}`),
              `Run: ${startedAt}`,
            ].join('\n'));
            alerts.push({ ...outcome, name });
            // Brain is configured but the alert did not go out: keep the old
            // baseline so the next run finds and reports this drift again.
            if (!outcome.ok && !outcome.skipped) keepPrior = true;
          }
        } catch (err) {
          log.error(`[ai-sec-agent] diff failed for ${name}:`, err.message);
          keepPrior = true;
          errors.push({
            key: `diff:${name}:${err.message}`, stage: 'diff-failed', name,
            headline: `diff FAILED on ${name}`, message: err.message,
            note: 'Drift on this server could not be checked. The previous baseline is kept.',
          });
        }
      }

      if (!keepPrior) state.baselines.set(name, report);
    }

    await alertOnErrors(errors, startedAt, alerts);

    const publicErrors = errors.map(({ stage, name, message }) => ({ stage, name, message }));
    state.lastRun = startedAt;
    state.lastScan = {
      trigger, startedAt,
      servers: summaries,
      diffs: diffSummaries,
      errors: publicErrors,
      alerts,
      alerting: { configured: state.alerting.configured },
    };
    state.lastError = errors.length
      ? { at: startedAt, message: errors.map((e) => `${e.headline}: ${e.message}`).join(' | '), errors: publicErrors }
      : null;
    log.log(`[ai-sec-agent] self-scan complete: ${JSON.stringify(summaries)}${errors.length ? ` — ${errors.length} error(s)` : ''}`);

    await persist();
    return state.lastScan;
  }

  /** One scan at a time: a trigger that arrives mid-scan gets that scan's result. */
  function runSelfScan({ trigger = 'cron' } = {}) {
    if (!running) running = scan(trigger).finally(() => { running = null; });
    return running;
  }

  /**
   * Drop one server's baseline, for when a diff keeps failing against it.
   * The next scan stores a fresh one without a drift check. Returns false
   * when there is no baseline by that name.
   */
  async function resetBaseline(name, caller) {
    if (!state.baselines.delete(name)) return false;
    state.resets = [...state.resets, { at: new Date().toISOString(), name, caller: caller || 'unknown' }].slice(-20);
    log.log(`[ai-sec-agent] baseline for ${name} reset by ${caller}`);
    await persist();
    return true;
  }

  function getLastScan() {
    return {
      lastRun: state.lastRun,
      lastAttempt: state.lastAttempt,
      lastScan: state.lastScan,
      lastError: state.lastError,
      alerting: state.alerting,
      resets: state.resets,
      baselines: [...state.baselines.keys()],
      baselineCount: state.baselines.size,
      baselineFile,
    };
  }

  hydrate();
  return { runSelfScan, getLastScan, resetBaseline, persist, state, baselineFile };
}

// ── the process-wide scanner ─────────────────────────────────────────────────

let shared;
const scanner = () => (shared ||= createScanner());

export const getLastScan = () => scanner().getLastScan();
export const runSelfScan = (opts) => scanner().runSelfScan(opts);
export const resetBaseline = (name, caller) => scanner().resetBaseline(name, caller);

export function startSchedule() {
  const s = scanner();
  cron.schedule('0 3 * * *', () => { s.runSelfScan({ trigger: 'cron-daily' }); }, { timezone: 'UTC' });
  // Run once on boot to establish the baseline and prove the path.
  setTimeout(() => s.runSelfScan({ trigger: 'boot' }), 5_000).unref?.();
  console.log(`[ai-sec-agent] self-scan schedule armed (daily 03:00 UTC, + boot run in 5s) · baseline file: ${s.baselineFile}`);
}
