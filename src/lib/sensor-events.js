import path from 'node:path';
import { resolveDataDir } from './data-dir.js';
import { jsonFile } from './store.js';
import { sendTelegram, escapeHtml } from './telegram.js';

/**
 * Lure-sensor events (from @dj_abstract/agent-lure sensors on fleet services).
 *
 * Trust rules — a sensor key is the only thing that writes here:
 *   - the site is the caller's key name, never a field of the body, so one
 *     sensor's key cannot write events for another site;
 *   - the kind comes from the lure name, so a sensor cannot relabel a crawl
 *     hit as an agent;
 *   - every string is cut to a fixed length and unknown fields are dropped.
 *
 * Alerting: the first instruction or bait hit from a source (ip + user agent)
 * on a site, per UTC day, goes to Telegram. Crawl hits (robots.txt Disallow)
 * are stored and counted but never alert — every scanner on the internet
 * takes them.
 */

export const LURE_KINDS = {
  robots: 'crawl',
  fragment: 'crawl',
  llms: 'instruction',
  comment: 'instruction',
  error: 'instruction',
  'bait-endpoint': 'bait',
  'bait-key': 'bait',
};

const WHERE = {
  robots: 'a path named only as Disallow in robots.txt',
  fragment: 'part of an instruction lure path',
  llms: 'an instruction in llms.txt',
  comment: 'an instruction in an HTML comment',
  error: 'an instruction in an error message',
  'bait-endpoint': 'the fake admin endpoint',
  'bait-key': 'the fake API key',
};

export const SENSOR_LIMITS = { perPost: 50, keep: 5000, keepDays: 30 };
const DAY_MS = 86_400_000;
const cut = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);

export function createSensorStore({
  env = process.env,
  fetchImpl = (...a) => fetch(...a),
  now = () => Date.now(),
  log = console,
  file = jsonFile(path.join(resolveDataDir(env), 'sensor-events.json'), log),
} = {}) {
  const saved = file.read() || {};
  const state = {
    events: Array.isArray(saved.events) ? saved.events : [],
    alerted: saved.alerted && typeof saved.alerted === 'object' ? saved.alerted : {},
    lastAlert: saved.lastAlert || null,
  };
  let writing = Promise.resolve();
  let alerting = Promise.resolve();

  const persist = () => {
    writing = writing.then(() => file.write(state));
    return writing;
  };

  function clean(site, raw, receivedAt) {
    if (!raw || typeof raw !== 'object') return null;
    const lure = typeof raw.lure === 'string' ? raw.lure : '';
    if (!LURE_KINDS[lure]) return null;
    const ts = Date.parse(raw.ts);
    return {
      site,
      lure,
      kind: LURE_KINDS[lure],
      // A sensor clock more than a day off is not trusted; use arrival time.
      ts: Number.isFinite(ts) && Math.abs(ts - receivedAt) < DAY_MS ? new Date(ts).toISOString() : new Date(receivedAt).toISOString(),
      receivedAt: new Date(receivedAt).toISOString(),
      ip: cut(raw.ip, 64),
      ua: cut(raw.ua, 300),
      method: cut(raw.method, 10),
      path: cut(raw.path, 200),
      referer: cut(raw.referer, 200),
    };
  }

  function prune(at) {
    const cutoff = at - SENSOR_LIMITS.keepDays * DAY_MS;
    state.events = state.events.filter((e) => Date.parse(e.receivedAt) >= cutoff).slice(-SENSOR_LIMITS.keep);
    const today = new Date(at).toISOString().slice(0, 10);
    for (const [k, day] of Object.entries(state.alerted)) if (day !== today) delete state.alerted[k];
  }

  function alertMessage(e) {
    const lines = [
      `🪤 <b>Agent lure tripped</b> — ${escapeHtml(e.site)}`,
      `${e.kind === 'bait' ? 'Used' : 'Followed'} ${WHERE[e.lure]} (${e.kind})`,
      `From: ${escapeHtml(e.ip || 'unknown')}`,
      `UA: ${escapeHtml(e.ua || '(none)')}`,
      `${escapeHtml(e.method || '')} ${escapeHtml(e.path || '')}`,
    ];
    return lines.join('\n');
  }

  /**
   * Take a batch from one sensor. Returns counts; alerts are sent in the
   * background so the sensor gets its answer at once (see flush()).
   */
  async function ingest(site, events) {
    const at = now();
    const list = Array.isArray(events) ? events.slice(0, SENSOR_LIMITS.perPost) : [];
    const accepted = [];
    for (const raw of list) {
      const e = clean(site, raw, at);
      if (e) accepted.push(e);
    }
    const rejected = (Array.isArray(events) ? events.length : 0) - accepted.length;
    if (!accepted.length) return { accepted: 0, rejected };

    prune(at);
    state.events.push(...accepted);
    const today = new Date(at).toISOString().slice(0, 10);
    const toAlert = [];
    for (const e of accepted) {
      if (e.kind === 'crawl') continue;
      const key = `${e.site}|${e.ip}|${e.ua}`;
      if (state.alerted[key] === today) continue;
      state.alerted[key] = today;
      toAlert.push(e);
    }
    await persist();

    for (const e of toAlert) {
      alerting = alerting.then(async () => {
        state.lastAlert = await sendTelegram({ env, fetchImpl, kind: 'sensor', message: alertMessage(e), log });
      });
    }
    alerting = alerting.then(persist);
    return { accepted: accepted.length, rejected, alerts: toAlert.length };
  }

  function list({ site, kind, limit = 100 } = {}) {
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return state.events
      .filter((e) => (!site || e.site === site) && (!kind || e.kind === kind))
      .slice(-n)
      .reverse();
  }

  /** Counts per site and kind, distinct sources, last 24 h and all kept. */
  function summary() {
    const at = now();
    const sites = {};
    for (const e of state.events) {
      const s = (sites[e.site] ||= { total: 0, last24h: 0, byKind: {}, byLure: {}, sources: new Set(), agentSources: new Set(), lastAt: null });
      s.total++;
      if (at - Date.parse(e.receivedAt) < DAY_MS) s.last24h++;
      s.byKind[e.kind] = (s.byKind[e.kind] || 0) + 1;
      s.byLure[e.lure] = (s.byLure[e.lure] || 0) + 1;
      const src = `${e.ip}|${e.ua}`;
      s.sources.add(src);
      if (e.kind !== 'crawl') s.agentSources.add(src);
      s.lastAt = e.receivedAt;
    }
    const out = {};
    for (const [name, s] of Object.entries(sites)) {
      out[name] = { ...s, sources: s.sources.size, agentSources: s.agentSources.size };
    }
    return { asOf: new Date(at).toISOString(), keptDays: SENSOR_LIMITS.keepDays, events: state.events.length, sites: out, lastAlert: state.lastAlert };
  }

  return { ingest, list, summary, flush: () => alerting.then(() => writing) };
}
