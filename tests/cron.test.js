import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createScanner } from '../src/cron.js';
import { getAiSecurityIntel } from '../src/routes/ai-security-intel.js';
import { scratch, fakeFetch, quiet, MANIFEST } from './helpers.js';

const ENV = { BRAIN_API_URL: 'https://brain.example', BRAIN_API_KEY: 'brain-secret' };

const manifests = (extraTools = []) => ({
  'brain-tools': { ...MANIFEST, name: 'brain-tools', tools: [...MANIFEST.tools, ...extraTools] },
  'brain-exec': { ...MANIFEST, name: 'brain-exec', tools: [{ name: 'execute_command', description: 'Run a shell command', inputSchema: { type: 'object' } }] },
  asOf: '2026-11-24T00:00:00Z',
});

function setup(t, { routes = {}, env = ENV, ...rest } = {}) {
  const dataDir = scratch(t);
  const sent = [];
  const fetchImpl = fakeFetch({
    'GET /security/mcp-manifests': () => manifests(),
    'POST /telegram/send': (_u, init) => { sent.push(JSON.parse(init.body).message); return { ok: true, sent: true }; },
    ...routes,
  });
  const make = (more = {}) => createScanner({ env, fetchImpl, dataDir, log: quiet, ...rest, ...more });
  return { dataDir, sent, fetchImpl, make, file: path.join(dataDir, 'baselines.json') };
}

test('a clean scan stores baselines, emits highs, and sends nothing', async (t) => {
  const { make, sent, fetchImpl } = setup(t);
  const scanner = make();
  const out = await scanner.runSelfScan({ trigger: 'test' });
  assert.deepEqual(out.servers.map((s) => s.name), ['brain-tools', 'brain-exec']);
  for (const s of out.servers) {
    assert.ok(Array.isArray(s.highs), 'highs is emitted');
    assert.equal(s.highs.length, s.bySeverity.high || 0);
    assert.equal(s.criticals.length, s.bySeverity.critical || 0);
  }
  assert.deepEqual(out.errors, []);
  assert.equal(scanner.getLastScan().baselineCount, 2);
  assert.equal(scanner.getLastScan().lastError, null);
  assert.equal(sent.length, 0);
  // Every outbound request carries a timeout signal and the Brain key.
  for (const call of fetchImpl.calls) {
    assert.ok(call.init.signal instanceof AbortSignal, `${call.key} has a timeout`);
    assert.equal(call.init.headers['x-api-key'], 'brain-secret');
  }
});

test('highs reach /intel/ai-security as high-priority findings', async () => {
  const report = { server: { counts: { tools: 1 } }, findings: [
    { severity: 'high', ruleId: 'r/high', title: 'A high one' },
    { severity: 'critical', ruleId: 'r/crit', title: 'A critical one' },
    { severity: 'low', ruleId: 'r/low', title: 'low' },
  ] };
  const scanner = createScanner({
    env: ENV, dataDir: '/nonexistent-dir-for-test', log: quiet,
    fetchImpl: fakeFetch({ 'GET /security/mcp-manifests': () => ({ only: MANIFEST }) }),
    audit: async () => report,
  });
  scanner.persist = async () => {};
  const out = await scanner.runSelfScan();
  assert.deepEqual(out.servers[0].highs, ['r/high: A high one']);
  assert.deepEqual(out.servers[0].criticals, ['r/crit: A critical one']);
});

test('diff failure: the old baseline is kept, the error is recorded and alerted once', async (t) => {
  let failDiff = false;
  const { make, sent, file } = setup(t);
  const scanner = make({
    diff: async (input) => {
      if (failDiff && input.current.server.name.includes('brain-tools')) throw new Error('diff exploded <on> purpose');
      return { findings: [] };
    },
    audit: async ({ manifestData }) => ({ server: { name: manifestData.name, counts: { tools: manifestData.tools.length } }, findings: [], stamp: stamp++ }),
  });
  let stamp = 1;

  await scanner.runSelfScan();
  const first = scanner.state.baselines.get('brain-tools');
  const firstExec = scanner.state.baselines.get('brain-exec');

  failDiff = true;
  const out = await scanner.runSelfScan();
  assert.equal(scanner.state.baselines.get('brain-tools'), first, 'the failed server keeps its old baseline');
  assert.notEqual(scanner.state.baselines.get('brain-exec'), firstExec, 'the other server is refreshed as usual');
  assert.deepEqual(out.errors, [{ stage: 'diff-failed', name: 'brain-tools', message: 'diff exploded <on> purpose' }]);
  assert.match(scanner.getLastScan().lastError.message, /diff FAILED on brain-tools/);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /diff FAILED on brain-tools/);
  assert.match(sent[0], /diff exploded &lt;on&gt; purpose/, 'text is escaped for Telegram HTML');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).baselines['brain-tools'].stamp, first.stamp, 'and on disk');

  // Same error again: recorded, not re-sent.
  await scanner.runSelfScan();
  await scanner.runSelfScan();
  assert.equal(sent.length, 1);
  assert.ok(scanner.getLastScan().lastError);

  // Recovers, then fails again: that is a new occurrence and alerts again.
  failDiff = false;
  await scanner.runSelfScan();
  assert.equal(scanner.getLastScan().lastError, null);
  assert.notEqual(scanner.state.baselines.get('brain-tools'), first);
  failDiff = true;
  await scanner.runSelfScan();
  assert.equal(sent.length, 2);
});

test('audit failure on one server does not stop the others and is reported', async (t) => {
  const { make, sent } = setup(t);
  const scanner = make({
    audit: async ({ manifestData }) => {
      if (manifestData.name === 'brain-exec') throw new Error('audit blew up');
      return { server: { counts: { tools: 1 } }, findings: [] };
    },
  });
  const out = await scanner.runSelfScan();
  assert.deepEqual(out.servers.map((s) => s.name), ['brain-tools']);
  assert.deepEqual(out.errors, [{ stage: 'audit-failed', name: 'brain-exec', message: 'audit blew up' }]);
  assert.equal(scanner.state.baselines.has('brain-exec'), false);
  assert.equal(sent.length, 1);
});

test('a scan that fails outright alerts once per distinct error', async (t) => {
  let status = 502;
  const { make, sent } = setup(t, {
    routes: { 'GET /security/mcp-manifests': () => (status === 200 ? manifests() : new Response('upstream down', { status })) },
  });
  const scanner = make();

  const out = await scanner.runSelfScan();
  assert.match(out.error, /Brain manifest fetch: 502/);
  assert.match(scanner.getLastScan().lastError.message, /502/);
  assert.equal(scanner.getLastScan().lastRun, null, 'lastRun is the last completed scan');
  assert.ok(scanner.getLastScan().lastAttempt);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /scan FAILED/);

  await scanner.runSelfScan();
  await scanner.runSelfScan();
  assert.equal(sent.length, 1, 'the same error is not re-sent');

  status = 500;
  await scanner.runSelfScan();
  assert.equal(sent.length, 2, 'a different error is');

  status = 200;
  await scanner.runSelfScan();
  assert.equal(scanner.getLastScan().lastError, null);
  status = 500;
  await scanner.runSelfScan();
  assert.equal(sent.length, 3, 'and so is the same error after a recovery');
});

test('Telegram: a non-2xx answer is recorded, and the alert is tried again next run', async (t) => {
  let telegramStatus = 503;
  const { make, sent } = setup(t, {
    routes: {
      'GET /security/mcp-manifests': () => new Response('nope', { status: 500 }),
      'POST /telegram/send': (_u, init) => {
        if (telegramStatus !== 200) return new Response('{"error":"Telegram not configured"}', { status: telegramStatus });
        sent.push(JSON.parse(init.body).message);
        return { ok: true };
      },
    },
  });
  const scanner = make();
  const out = await scanner.runSelfScan();
  assert.equal(out.alerts.length, 1);
  assert.equal(out.alerts[0].ok, false);
  assert.equal(out.alerts[0].status, 503);
  assert.deepEqual(
    { ok: scanner.getLastScan().alerting.last.ok, status: scanner.getLastScan().alerting.last.status },
    { ok: false, status: 503 },
  );
  assert.equal(sent.length, 0);

  telegramStatus = 200;
  await scanner.runSelfScan();
  assert.equal(sent.length, 1, 'delivered on the next run');
  await scanner.runSelfScan();
  assert.equal(sent.length, 1);
});

test('Telegram: a network error is recorded, not thrown', async (t) => {
  const { make } = setup(t, {
    routes: {
      'GET /security/mcp-manifests': () => new Response('nope', { status: 500 }),
      'POST /telegram/send': () => { throw new Error('socket hang up'); },
    },
  });
  const scanner = make();
  const out = await scanner.runSelfScan();
  assert.equal(out.alerts[0].ok, false);
  assert.equal(out.alerts[0].error, 'socket hang up');
});

test('missing Brain settings are recorded in the scan state', async (t) => {
  const { make, fetchImpl } = setup(t, { env: {} });
  const scanner = make();
  const out = await scanner.runSelfScan();
  assert.equal(out.error, 'BRAIN_API_URL not configured');
  const state = scanner.getLastScan();
  assert.equal(state.alerting.configured, false);
  assert.match(state.alerting.last.skipped, /not configured/);
  assert.equal(state.lastError.message, 'BRAIN_API_URL not configured');
  assert.equal(fetchImpl.calls.length, 0);
});

test('critical drift alerts; if the alert is not delivered the old baseline is kept so it is found again', async (t) => {
  let extra = [];
  let telegramOk = false;
  const { make, sent } = setup(t, {
    routes: {
      'GET /security/mcp-manifests': () => manifests(extra),
      'POST /telegram/send': (_u, init) => {
        if (!telegramOk) return new Response('rate limited', { status: 429 });
        sent.push(JSON.parse(init.body).message);
        return { ok: true };
      },
    },
  });
  const scanner = make(); // real mcp-audit audit + diff
  await scanner.runSelfScan();
  const first = scanner.state.baselines.get('brain-tools');

  extra = [{ name: 'run_shell_command', description: 'Execute a shell command', inputSchema: { type: 'object' } }];
  const out = await scanner.runSelfScan();
  const drift = out.diffs.find((d) => d.name === 'brain-tools');
  assert.ok(drift.findings.some((f) => f.severity === 'critical'), 'the diff sees a critical change');
  assert.equal(out.alerts.find((a) => a.kind === 'critical-drift').ok, false);
  assert.equal(scanner.state.baselines.get('brain-tools'), first, 'baseline kept because nobody was told');

  telegramOk = true;
  await scanner.runSelfScan();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /CRITICAL DRIFT on brain-tools/);
  assert.notEqual(scanner.state.baselines.get('brain-tools'), first, 'baseline advances once the alert is out');

  await scanner.runSelfScan();
  assert.equal(sent.length, 1, 'no repeat once the baseline has moved');
});

test('scan state survives a restart', async (t) => {
  let status = 200;
  const { make, sent, file } = setup(t, {
    routes: { 'GET /security/mcp-manifests': () => (status === 200 ? manifests() : new Response('down', { status })) },
  });
  const a = make();
  await a.runSelfScan({ trigger: 'first' });
  status = 500;
  await a.runSelfScan({ trigger: 'second' });
  assert.equal(sent.length, 1);
  const before = a.getLastScan();

  const b = make(); // a new process reading the same directory
  const after = b.getLastScan();
  assert.equal(after.baselineCount, 2);
  assert.equal(after.lastRun, before.lastRun);
  assert.equal(after.lastAttempt, before.lastAttempt);
  assert.deepEqual(after.lastScan, before.lastScan);
  assert.deepEqual(after.lastError, before.lastError);
  assert.equal(after.lastScan.trigger, 'first');

  // The restarted process knows the error was already alerted.
  await b.runSelfScan();
  assert.equal(sent.length, 1);

  // And the intel route, built from restored state, reports it.
  const intel = await getAiSecurityIntel({ includeFirewall: false, scan: after });
  assert.equal(intel.status, 'degraded');
  assert.equal(intel.totals.servers, 2);

  assert.ok(!fs.readFileSync(file, 'utf8').includes('brain-secret'), 'no key in the state file');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['baselines.json'], 'no temp files left behind');
});

test('a baselines file written before scan state was persisted still loads', async (t) => {
  const { make, file } = setup(t);
  fs.writeFileSync(file, JSON.stringify({ savedAt: '2026-11-23T03:00:00Z', baselines: { 'brain-tools': { tools: [], findings: [] } } }));
  const scanner = make();
  assert.equal(scanner.getLastScan().baselineCount, 1);
  assert.equal(scanner.getLastScan().lastRun, null);
});

test('a corrupt state file is ignored, not fatal', async (t) => {
  const { make, file } = setup(t);
  fs.writeFileSync(file, '{not json');
  const scanner = make();
  assert.equal(scanner.getLastScan().baselineCount, 0);
  const out = await scanner.runSelfScan();
  assert.equal(out.servers.length, 2);
});

test('an unwritable data dir does not fail the scan', async (t) => {
  const { fetchImpl } = setup(t);
  const scanner = createScanner({ env: ENV, fetchImpl, dataDir: '/dev/null/nope', log: quiet });
  const out = await scanner.runSelfScan();
  assert.equal(out.servers.length, 2);
});

test('two triggers at once share one scan', async (t) => {
  const { make, fetchImpl } = setup(t);
  const scanner = make();
  const [a, b] = await Promise.all([scanner.runSelfScan(), scanner.runSelfScan()]);
  assert.equal(a, b);
  assert.equal(fetchImpl.calls.filter((c) => c.key === 'GET /security/mcp-manifests').length, 1);
});

test('resetting one baseline: recorded with the caller, survives a restart, next scan starts fresh', async (t) => {
  let failDiff = true;
  const { make, sent } = setup(t);
  const opts = {
    diff: async (input) => {
      if (failDiff && input.current.server.name === 'brain-tools') throw new Error('baseline unreadable');
      return { findings: [] };
    },
    audit: async ({ manifestData }) => ({ server: { name: manifestData.name, counts: { tools: 1 } }, findings: [] }),
  };
  const scanner = make(opts);
  await scanner.runSelfScan();
  await scanner.runSelfScan();                              // diff fails: the baseline is stuck
  assert.ok(scanner.getLastScan().lastError);
  const stuck = scanner.state.baselines.get('brain-tools');

  assert.equal(await scanner.resetBaseline('no-such-server', 'brain'), false);
  assert.equal(await scanner.resetBaseline('brain-tools', 'brain'), true);
  assert.deepEqual(scanner.getLastScan().baselines, ['brain-exec']);
  const [reset] = scanner.getLastScan().resets;
  assert.deepEqual([reset.name, reset.caller], ['brain-tools', 'brain']);
  assert.ok(!Number.isNaN(Date.parse(reset.at)));

  const restarted = make(opts);                             // persisted at once
  assert.deepEqual(restarted.getLastScan().baselines, ['brain-exec']);
  assert.deepEqual(restarted.getLastScan().resets.map((r) => r.caller), ['brain']);

  await restarted.runSelfScan();                            // no baseline → no diff → clean, new baseline
  assert.equal(restarted.getLastScan().lastError, null);
  assert.notEqual(restarted.state.baselines.get('brain-tools'), stuck);
  assert.equal(restarted.getLastScan().baselineCount, 2);
  assert.equal(sent.length, 1, 'only the original failure was alerted');
});

test('the reset route needs a key, names the caller, and answers 404 for an unknown server', async (t) => {
  const { createApp } = await import('../src/app.js');
  const { listen } = await import('./helpers.js');
  const { make } = setup(t);
  const scanner = make();
  await scanner.runSelfScan();
  const env = { AGENT_API_KEYS: 'brain:k1,security-agent:k2', CALLER_CAPABILITIES: 'security-agent=intel|posture' };
  const app = createApp({ env, scan: scanner, ledger: { today: () => ({}) }, log() {} });
  const { base } = await listen(t, app);
  const post = (name, key) => fetch(`${base}/ai-security/baselines/${encodeURIComponent(name)}/reset`, { method: 'POST', headers: key ? { 'x-api-key': key } : {} });

  assert.equal((await post('brain-tools')).status, 401);
  assert.equal((await post('brain-tools', 'k2')).status, 403, 'a caller without the scan capability');
  assert.equal((await post('nope', 'k1')).status, 404);
  assert.equal((await post('../../etc/passwd', 'k1')).status, 404, 'a name is only ever a key in the baseline map');
  const ok = await post('brain-tools', 'k1');
  assert.equal(ok.status, 200);
  assert.deepEqual([(await ok.json()).by, scanner.getLastScan().resets[0].caller], ['brain', 'brain']);
  assert.deepEqual(scanner.getLastScan().baselines, ['brain-exec']);

  const lastScan = await (await fetch(`${base}/ai-security/last-scan`, { headers: { 'x-api-key': 'k1' } })).json();
  assert.equal(lastScan.resets[0].name, 'brain-tools');
});
