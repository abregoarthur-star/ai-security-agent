import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { safeEqual, loadAgentKeys, loadCapabilities } from '../src/lib/auth.js';
import { listen } from './helpers.js';

const scan = { getLastScan: () => ({ lastRun: null }), runSelfScan: async () => ({ ok: true }) };
const ledger = { today: () => ({ usd: 0 }), summary: () => ({ today: { usd: 0 }, days: [], runs: [] }), charge: async (_run, fn) => fn() };
const tools = { echo_tool: async (body, ctx) => ({ got: body, caller: ctx.caller }) };

async function start(t, env, extra = {}) {
  const lines = [];
  const app = createApp({ env, tools, scan, ledger, intel: async () => ({ ok: true }), log: (l) => lines.push(l), ...extra });
  const { base } = await listen(t, app);
  const call = (path, { key, method = 'GET', body } = {}) => fetch(base + path, {
    method,
    headers: { ...(key ? { 'x-api-key': key } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { call, lines };
}

const PROTECTED = [
  ['POST', '/tools/echo_tool'],
  ['GET', '/intel/ai-security'],
  ['GET', '/ai-security/posture'],
  ['GET', '/ai-security/last-scan'],
  ['POST', '/ai-security/scan/trigger'],
  ['GET', '/ai-security/config'],
  ['GET', '/ai-security/spend'],
];

test('no keys configured: every protected route answers 503, in any NODE_ENV', async (t) => {
  for (const NODE_ENV of [undefined, 'development', 'production']) {
    const { call } = await start(t, { NODE_ENV });
    for (const [method, path] of PROTECTED) {
      const res = await call(path, { method, key: 'anything', body: method === 'POST' ? {} : undefined });
      assert.equal(res.status, 503, `${method} ${path} (NODE_ENV=${NODE_ENV})`);
      assert.equal((await res.json()).error, 'auth_not_configured');
    }
    assert.equal((await call('/health')).status, 200);
  }
});

test('missing or wrong key: 401', async (t) => {
  const { call } = await start(t, { AGENT_API_KEYS: 'brain:brain-key-1' });
  for (const [method, path] of PROTECTED) {
    assert.equal((await call(path, { method })).status, 401, `${method} ${path} no key`);
    assert.equal((await call(path, { method, key: 'brain-key-2' })).status, 401, `${method} ${path} wrong key`);
  }
  assert.equal((await call('/tools/echo_tool', { method: 'POST', key: 'brain-key-' })).status, 401, 'prefix of a key');
  assert.equal((await call('/tools/echo_tool', { method: 'POST', key: 'brain-key-1x' })).status, 401, 'key plus a byte');
});

test('per-caller and legacy keys are accepted and the caller name is logged', async (t) => {
  const { call, lines } = await start(t, {
    AGENT_API_KEYS: 'brain:brain-key-1, security-agent:sec-key-2',
    AGENT_API_KEY: 'old-shared-key',
  });
  for (const [key, caller] of [['brain-key-1', 'brain'], ['sec-key-2', 'security-agent'], ['old-shared-key', 'legacy']]) {
    const res = await call('/tools/echo_tool', { method: 'POST', key, body: { a: 1 } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { got: { a: 1 }, caller });
    assert.ok(lines.includes(`[auth] ${caller} → POST /tools/echo_tool`), `log line for ${caller}`);
  }
  assert.ok(!lines.join('\n').includes('brain-key-1'), 'a key value is never logged');
});

test('API_KEY alone still works as caller legacy', async (t) => {
  const { call } = await start(t, { API_KEY: 'only-key' });
  assert.equal((await call('/ai-security/posture', { key: 'only-key' })).status, 200);
});

test('/health is public and carries no configuration', async (t) => {
  const { call } = await start(t, { AGENT_API_KEYS: 'brain:brain-key-1', AGENT_API_KEY: 'old', DATA_DIR: '/somewhere' });
  const body = await (await call('/health')).json();
  assert.deepEqual(Object.keys(body).sort(), ['service', 'status', 'tools', 'uptime', 'version']);
  assert.equal(body.status, 'ok');
  assert.deepEqual(body.tools, ['echo_tool']);
  assert.ok(!JSON.stringify(body).includes('brain'));
});

test('the default app advertises the six tools on /health', async (t) => {
  const app = createApp({ env: {}, scan, ledger, log() {} });
  const { base } = await listen(t, app);
  const body = await (await fetch(`${base}/health`)).json();
  assert.deepEqual(body.tools, ['audit_mcp_server', 'diff_mcp_server', 'firewall_recent_events', 'run_self_test', 'capability_inventory', 'sweep_mcp_ecosystem']);
  assert.match(body.version, /^\d+\.\d+\.\d+/);
});

test('/ai-security/config needs a key and lists names, never key values', async (t) => {
  const { call } = await start(t, { AGENT_API_KEYS: 'brain:brain-key-1', AGENT_API_KEY: 'old-shared-key', BRAIN_API_KEY: 'brain-secret' });
  const res = await call('/ai-security/config', { key: 'brain-key-1' });
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text);
  assert.deepEqual(body.callers, ['brain', 'legacy']);
  assert.equal(body.env.BRAIN_API_KEY_set, true);
  for (const secret of ['brain-key-1', 'old-shared-key', 'brain-secret']) assert.ok(!text.includes(secret));
});

test('capabilities: unrestricted by default, narrowed per caller by CALLER_CAPABILITIES', async (t) => {
  const { call, lines } = await start(t, {
    AGENT_API_KEYS: 'brain:brain-key-1,security-agent:sec-key-2',
    CALLER_CAPABILITIES: 'security-agent=intel|posture',
  });
  assert.equal((await call('/intel/ai-security', { key: 'sec-key-2' })).status, 200);
  assert.equal((await call('/ai-security/posture', { key: 'sec-key-2' })).status, 200);
  assert.equal((await call('/tools/echo_tool', { method: 'POST', key: 'sec-key-2', body: {} })).status, 403);
  assert.equal((await call('/ai-security/scan/trigger', { method: 'POST', key: 'sec-key-2' })).status, 403);
  assert.ok(lines.some((l) => l.includes('security-agent DENIED POST /tools/echo_tool')));
  assert.equal((await call('/tools/echo_tool', { method: 'POST', key: 'brain-key-1', body: {} })).status, 200);
  assert.equal((await call('/ai-security/scan/trigger', { method: 'POST', key: 'brain-key-1' })).status, 200);
});

test('an oversized body is refused with 413, and only after the key check', async (t) => {
  const { call } = await start(t, { AGENT_API_KEYS: 'brain:brain-key-1' });
  const big = { blob: 'x'.repeat(5.5 * 1024 * 1024) };
  assert.equal((await call('/tools/echo_tool', { method: 'POST', body: big })).status, 401);
  assert.equal((await call('/tools/echo_tool', { method: 'POST', key: 'brain-key-1', body: big })).status, 413);
});

test('safeEqual compares values of any length without throwing', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', 'abc'), false);
  assert.equal(safeEqual('a'.repeat(10_000), 'abc'), false);
});

test('key and capability parsing ignores malformed entries', () => {
  assert.deepEqual(loadAgentKeys({ AGENT_API_KEYS: 'a:1, :2, b, c: ,d:4:5' }), { a: '1', d: '4:5' });
  assert.deepEqual(Object.keys(loadCapabilities({ CALLER_CAPABILITIES: 'x=intel|scan,bad,y=' })), ['x']);
});
