import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createSensorStore, SENSOR_LIMITS } from '../src/lib/sensor-events.js';
import { jsonFile } from '../src/lib/store.js';
import { scratch, listen, quiet, fakeFetch } from './helpers.js';

const KEYS = { brain: 'k-brain', 'lure-brain': 'k-lure-brain', 'lure-portfolio': 'k-lure-portfolio', 'lure-': 'k-empty' };
const ENV_KEYS = Object.entries(KEYS).map(([n, k]) => `${n}:${k}`).join(',');
const NOW = Date.parse('2026-11-25T12:00:00Z');

function setup(t, { env = {}, fetchImpl, now = () => NOW } = {}) {
  const dir = scratch(t);
  const fullEnv = { AGENT_API_KEYS: ENV_KEYS, DATA_DIR: dir, BRAIN_API_URL: 'https://brain.test', BRAIN_API_KEY: 'bk', ...env };
  const tg = fetchImpl || fakeFetch({ 'POST /telegram/send': () => ({ ok: true }) });
  const file = jsonFile(path.join(dir, 'sensor-events.json'), quiet);
  const sensors = createSensorStore({ env: fullEnv, fetchImpl: tg, now, log: quiet, file });
  const app = createApp({ env: fullEnv, sensors, log: () => {} });
  return { app, sensors, tg, file, dir, env: fullEnv };
}

const hit = (lure, extra = {}) => ({ lure, ts: new Date(NOW).toISOString(), ip: '203.0.113.9', ua: 'agent/1', method: 'GET', path: '/x', ...extra });

async function post(base, key, body) {
  const res = await fetch(`${base}/sensor/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test('a sensor key posts events; the site comes from the key, the kind from the lure', async (t) => {
  const { app, sensors } = setup(t);
  const { base } = await listen(t, app);
  const r = await post(base, KEYS['lure-brain'], { events: [hit('llms', { site: 'portfolio', kind: 'crawl', extra: 'dropped' })] });
  assert.equal(r.status, 202);
  assert.equal(r.body.accepted, 1);
  const [e] = sensors.list();
  assert.equal(e.site, 'brain');
  assert.equal(e.kind, 'instruction');
  assert.equal(e.extra, undefined);
});

test('only lure-* callers may post, and they may do nothing else', async (t) => {
  const { app } = setup(t);
  const { base } = await listen(t, app);
  assert.equal((await post(base, KEYS.brain, { events: [hit('llms')] })).status, 403);
  assert.equal((await post(base, 'wrong', { events: [hit('llms')] })).status, 401);
  assert.equal((await post(base, KEYS['lure-'], { events: [hit('llms')] })).status, 403);
  for (const route of ['/sensor/summary', '/sensor/events', '/ai-security/config', '/ai-security/posture']) {
    const res = await fetch(`${base}${route}`, { headers: { 'x-api-key': KEYS['lure-brain'] } });
    assert.equal(res.status, 403, route);
  }
  const ok = await fetch(`${base}/sensor/summary`, { headers: { 'x-api-key': KEYS.brain } });
  assert.equal(ok.status, 200);
});

test('a lure caller stays narrow even if CALLER_CAPABILITIES lists it with *', async (t) => {
  const { app } = setup(t, { env: { CALLER_CAPABILITIES: 'lure-brain=*' } });
  const { base } = await listen(t, app);
  const res = await fetch(`${base}/ai-security/config`, { headers: { 'x-api-key': KEYS['lure-brain'] } });
  assert.equal(res.status, 403);
});

test('unknown lures and non-objects are rejected; strings are cut', async (t) => {
  const { sensors } = setup(t);
  const out = await sensors.ingest('brain', [hit('made-up'), null, 'x', hit('robots', { ua: 'u'.repeat(1000), path: 'p'.repeat(1000) })]);
  assert.deepEqual({ a: out.accepted, r: out.rejected }, { a: 1, r: 3 });
  const [e] = sensors.list();
  assert.equal(e.ua.length, 300);
  assert.equal(e.path.length, 200);
});

test('at most 50 events are taken from one post', async (t) => {
  const { sensors } = setup(t);
  const many = Array.from({ length: 80 }, (_, i) => hit('robots', { ip: `10.0.0.${i}` }));
  const out = await sensors.ingest('brain', many);
  assert.equal(out.accepted, SENSOR_LIMITS.perPost);
});

test('a sensor clock far off is replaced by arrival time', async (t) => {
  const { sensors } = setup(t);
  await sensors.ingest('brain', [hit('llms', { ts: '2020-01-01T00:00:00Z' })]);
  assert.equal(sensors.list()[0].ts, new Date(NOW).toISOString());
});

test('alerts: crawl never, first instruction or bait per source per day once', async (t) => {
  const { sensors, tg } = setup(t);
  await sensors.ingest('brain', [hit('robots')]);
  await sensors.flush();
  assert.equal(tg.calls.length, 0, 'robots.txt hits do not alert');

  await sensors.ingest('brain', [hit('llms'), hit('bait-key')]);
  await sensors.ingest('brain', [hit('comment')]);
  await sensors.flush();
  assert.equal(tg.calls.length, 1, 'one alert per source per day');
  const msg = JSON.parse(tg.calls[0].init.body).message;
  assert.match(msg, /Agent lure tripped/);
  assert.match(msg, /llms\.txt/);

  await sensors.ingest('brain', [hit('llms', { ip: '198.51.100.1' })]);
  await sensors.ingest('portfolio', [hit('llms')]);
  await sensors.flush();
  assert.equal(tg.calls.length, 3, 'another source, or the same source on another site, alerts');
});

test('the next day the same source alerts again', async (t) => {
  let clock = NOW;
  const { sensors, tg } = setup(t, { now: () => clock });
  await sensors.ingest('brain', [hit('llms')]);
  clock += 86_400_000;
  await sensors.ingest('brain', [hit('llms', { ts: new Date(clock).toISOString() })]);
  await sensors.flush();
  assert.equal(tg.calls.length, 2);
});

test('the user agent is escaped in the alert', async (t) => {
  const { sensors, tg } = setup(t);
  await sensors.ingest('brain', [hit('llms', { ua: '<b>evil</b>' })]);
  await sensors.flush();
  const msg = JSON.parse(tg.calls[0].init.body).message;
  assert.ok(msg.includes('&lt;b&gt;evil&lt;/b&gt;'));
});

test('the hub answers at once when Telegram is slow or down', async (t) => {
  const { sensors } = setup(t, { fetchImpl: async () => { throw new Error('down'); } });
  const out = await sensors.ingest('brain', [hit('llms')]);
  assert.equal(out.alerts, 1);
  await sensors.flush();
  assert.equal(sensors.summary().lastAlert.ok, false);
});

test('events survive a restart; summary counts agent sources apart from crawlers', async (t) => {
  const { sensors, file, env } = setup(t);
  await sensors.ingest('brain', [hit('robots', { ip: '1.1.1.1' }), hit('robots', { ip: '2.2.2.2' }), hit('llms', { ip: '2.2.2.2' })]);
  await sensors.flush();
  const again = createSensorStore({ env, now: () => NOW, log: quiet, file, fetchImpl: fakeFetch({}) });
  const s = again.summary().sites.brain;
  assert.equal(s.total, 3);
  assert.equal(s.sources, 2);
  assert.equal(s.agentSources, 1);
  assert.deepEqual(s.byKind, { crawl: 2, instruction: 1 });
});

test('events older than 30 days are dropped on the next write', async (t) => {
  let clock = NOW;
  const { sensors } = setup(t, { now: () => clock });
  await sensors.ingest('brain', [hit('robots')]);
  clock += 31 * 86_400_000;
  await sensors.ingest('brain', [hit('robots', { ts: new Date(clock).toISOString() })]);
  assert.equal(sensors.list().length, 1);
});
