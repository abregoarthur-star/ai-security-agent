import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { auditMcpServer } from '../src/tools/audit-mcp-server.js';
import { diffMcpServer } from '../src/tools/diff-mcp-server.js';
import { capabilityInventory } from '../src/tools/capability-inventory.js';
import { sweepMcpEcosystem } from '../src/tools/sweep-mcp-ecosystem.js';
import { runSelfTest } from '../src/tools/run-self-test.js';
import { clampSelfTest, assertStdioAllowed } from '../src/lib/policy.js';
import { createApp } from '../src/app.js';
import { scratch, listen, MANIFEST } from './helpers.js';

const refused = (status, code) => (err) => err.status === status && (!code || err.code === code);
const neverAudit = async () => { throw new Error('the audit library must not be reached'); };

// ── stdio ────────────────────────────────────────────────────────────────────

test('stdio is off by default', async () => {
  await assert.rejects(auditMcpServer({ stdio: 'node server.js' }, { env: {}, audit: neverAudit }), refused(403, 'stdio_disabled'));
  // An allowlist alone does not switch it on.
  await assert.rejects(
    auditMcpServer({ stdio: 'node server.js' }, { env: { STDIO_ALLOWLIST: 'node server.js' }, audit: neverAudit }),
    refused(403, 'stdio_disabled'),
  );
});

test('stdio, when enabled, runs only a command line that is on the allowlist', async () => {
  const env = { ALLOW_STDIO_AUDIT: '1', STDIO_ALLOWLIST: 'node /app/mcp/server.js, npx -y @acme/mcp' };
  const seen = [];
  const audit = async (spec) => { seen.push(spec); return { findings: [] }; };

  await auditMcpServer({ stdio: 'node   /app/mcp/server.js' }, { env, audit });
  await auditMcpServer({ stdio: { command: 'npx', args: ['-y', '@acme/mcp'] } }, { env, audit });
  assert.deepEqual(seen, [{ stdio: 'node /app/mcp/server.js' }, { stdio: 'npx -y @acme/mcp' }]);

  for (const stdio of [
    'node',                                   // the command name alone
    'node /app/mcp/server.js --extra',        // extra argument
    'node -e require("child_process")',       // same command, other arguments
    'npx -y @evil/pkg',
    'sh -c "node /app/mcp/server.js"',
    "node '/app/mcp/server.js'",              // quoting is refused, not interpreted
    { command: 'node', args: ['/app/mcp/server.js'], env: { NODE_OPTIONS: '--require /tmp/x.js' } },
    { command: 'node', args: ['/app/mcp/server.js extra'] },
  ]) {
    await assert.rejects(auditMcpServer({ stdio }, { env, audit: neverAudit }), refused(403, 'stdio_not_allowed'), JSON.stringify(stdio));
  }
  assert.throws(() => assertStdioAllowed('node x', { ALLOW_STDIO_AUDIT: '1' }), refused(403), 'enabled with an empty allowlist allows nothing');
});

test('a refused stdio request answers 403 over HTTP', async (t) => {
  const app = createApp({ env: { AGENT_API_KEYS: 'brain:k1' }, log() {}, scan: {}, ledger: {} });
  const { base } = await listen(t, app);
  const res = await fetch(`${base}/tools/audit_mcp_server`, {
    method: 'POST', headers: { 'x-api-key': 'k1', 'content-type': 'application/json' },
    body: JSON.stringify({ stdio: 'node -e 1' }),
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'stdio_disabled');
});

// ── paths ────────────────────────────────────────────────────────────────────

function rootWithFiles(t) {
  const base = scratch(t);
  const root = path.join(base, 'manifests');
  fs.mkdirSync(path.join(root, 'fleet'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ok.json'), JSON.stringify(MANIFEST));
  fs.writeFileSync(path.join(root, 'fleet', 'a.json'), JSON.stringify({ ...MANIFEST, name: 'a' }));
  fs.writeFileSync(path.join(base, 'secret.json'), JSON.stringify({ ...MANIFEST, name: 'SECRET', tools: [{ name: 'read_secret_file', description: 'x' }] }));
  fs.symlinkSync(path.join(base, 'secret.json'), path.join(root, 'link.json'));
  fs.symlinkSync(path.join(base, 'secret.json'), path.join(root, 'fleet', 'link.json'));
  fs.symlinkSync(base, path.join(root, 'updir'));
  return { base, root, env: { MANIFEST_ROOT: root } };
}

test('manifest path: a file inside the root is audited', async (t) => {
  const { root, env } = rootWithFiles(t);
  for (const p of ['ok.json', path.join(root, 'ok.json'), 'fleet/../ok.json']) {
    const report = await auditMcpServer({ manifest: p }, { env });
    assert.equal(report.server.counts.tools, 1, p);
  }
});

test('manifest path: traversal, absolute paths and symlinks out of the root are refused', async (t) => {
  const { base, env } = rootWithFiles(t);
  for (const p of [
    '../secret.json',
    'fleet/../../secret.json',
    path.join(base, 'secret.json'),
    '/etc/passwd',
    '~/.ssh/id_rsa',                // not expanded: a name inside the root, which does not exist
    'link.json',                    // symlink to a file outside
    'updir/secret.json',            // symlinked directory to outside
  ]) {
    await assert.rejects(auditMcpServer({ manifest: p }, { env, audit: neverAudit }), (e) => e.status === 403 || e.status === 404, p);
  }
  await assert.rejects(auditMcpServer({ manifest: 'link.json' }, { env, audit: neverAudit }), refused(403, 'path_not_allowed'));
  // The same answer whether or not the outside target exists.
  const a = await auditMcpServer({ manifest: '/etc/passwd' }, { env, audit: neverAudit }).catch((e) => e.message);
  const b = await auditMcpServer({ manifest: '/etc/no-such-file-here' }, { env, audit: neverAudit }).catch((e) => e.message);
  assert.equal(a, b);
});

test('the default root is a dedicated directory under the data dir', async (t) => {
  const data = scratch(t);
  fs.writeFileSync(path.join(data, 'baselines.json'), JSON.stringify(MANIFEST));
  await assert.rejects(auditMcpServer({ manifest: path.join(data, 'baselines.json') }, { env: { DATA_DIR: data }, audit: neverAudit }), refused(403));
  fs.mkdirSync(path.join(data, 'manifests'));
  fs.writeFileSync(path.join(data, 'manifests', 'm.json'), JSON.stringify(MANIFEST));
  const report = await auditMcpServer({ manifest: 'm.json' }, { env: { DATA_DIR: data } });
  assert.equal(report.server.counts.tools, 1);
});

test('diff: file paths are held to the root; objects pass', async (t) => {
  const { base, env } = rootWithFiles(t);
  await assert.rejects(diffMcpServer({ baseline: path.join(base, 'secret.json'), current: MANIFEST }, { env }), refused(403));
  await assert.rejects(diffMcpServer({ baseline: MANIFEST, current: '/etc/passwd' }, { env }), refused(403));
  const out = await diffMcpServer({ baseline: 'ok.json', current: MANIFEST }, { env });
  assert.ok(out && typeof out === 'object');
});

test('sweep baselinesDir: held to the root, symlinked files skipped', async (t) => {
  const { base, env } = rootWithFiles(t);
  await assert.rejects(sweepMcpEcosystem({ baselinesDir: base }, { env }), refused(403));
  await assert.rejects(sweepMcpEcosystem({ baselinesDir: '..' }, { env }), refused(403));
  await assert.rejects(sweepMcpEcosystem({ baselinesDir: 'updir' }, { env }), refused(403));
  await assert.rejects(sweepMcpEcosystem({ baselinesDir: '~' }, { env }), (e) => e.status === 404);
  const out = await sweepMcpEcosystem({ baselinesDir: 'fleet' }, { env });
  assert.deepEqual(out.targets.map((x) => x.name), ['a']);
  assert.ok(!JSON.stringify(out).includes('SECRET'));
});

test('sweep targets: each one is checked; a refused target fails alone', async (t) => {
  const { base, env } = rootWithFiles(t);
  const out = await sweepMcpEcosystem({
    targets: [
      { name: 'inline', manifestData: MANIFEST },
      { name: 'escape', manifest: path.join(base, 'secret.json') },
      { name: 'spawn', stdio: 'node -e 1' },
      { name: 'metadata', url: 'http://169.254.169.254/latest/meta-data/' },
    ],
  }, { env });
  assert.deepEqual(out.targets.map((x) => [x.name, x.ok]), [['inline', true], ['escape', false], ['spawn', false], ['metadata', false]]);
  assert.equal(out.fleet.succeeded, 1);
});

test('capability inventory: paths held to the root, symlinks out of it left out', async (t) => {
  const { base, root, env } = rootWithFiles(t);
  await assert.rejects(capabilityInventory({ manifest: base }, { env }), refused(403));
  await assert.rejects(capabilityInventory({ manifest: ['ok.json', '../secret.json'] }, { env }), refused(403));
  await assert.rejects(capabilityInventory({ manifest: 'link.json' }, { env }), refused(403));
  const out = await capabilityInventory({ manifest: root }, { env });
  assert.deepEqual(out.servers.map((s) => s.name).sort(), ['a', 'demo']);
  assert.ok(!JSON.stringify(out).includes('SECRET'));
});

// ── inline size ──────────────────────────────────────────────────────────────

test('inline manifestData is allowed, up to a size limit', async () => {
  const report = await auditMcpServer({ manifestData: MANIFEST }, { env: {} });
  assert.equal(report.server.counts.tools, 1);
  const big = { ...MANIFEST, tools: [{ name: 't', description: 'x'.repeat(1_000_001) }] };
  await assert.rejects(auditMcpServer({ manifestData: big }, { env: {}, audit: neverAudit }), refused(413));
  await assert.rejects(diffMcpServer({ baseline: MANIFEST, current: big }, { env: {} }), refused(413));
  await assert.rejects(capabilityInventory({ manifestData: [MANIFEST, big] }, { env: {} }), refused(413));
  await assert.rejects(sweepMcpEcosystem({ targets: Array(51).fill({ manifestData: MANIFEST }) }, { env: {} }), refused(400));
  await assert.rejects(capabilityInventory({ manifestData: Array(51).fill(MANIFEST) }, { env: {} }), refused(400));
});

// ── run_self_test ────────────────────────────────────────────────────────────

test('self-test limits: a caller may lower them, never raise them', () => {
  assert.deepEqual(clampSelfTest({}, {}), { rounds: 30, maxCostUsdPerGen: 1.5 });
  assert.deepEqual(clampSelfTest({ rounds: 100, maxCostUsdPerGen: 500 }, {}), { rounds: 30, maxCostUsdPerGen: 1.5 });
  assert.deepEqual(clampSelfTest({ rounds: 3, maxCostUsdPerGen: 0.25 }, {}), { rounds: 3, maxCostUsdPerGen: 0.25 });
  for (const bad of [-5, 0, 'abc', Infinity, null, NaN, '1e9']) {
    const out = clampSelfTest({ rounds: bad, maxCostUsdPerGen: bad }, {});
    assert.ok(out.rounds >= 1 && out.rounds <= 30, `rounds for ${bad}`);
    assert.ok(out.maxCostUsdPerGen > 0 && out.maxCostUsdPerGen <= 1.5, `cost for ${bad}`);
  }
  const env = { SELF_TEST_MAX_ROUNDS: '5', SELF_TEST_MAX_COST_USD_PER_GEN: '0.40' };
  assert.deepEqual(clampSelfTest({}, env), { rounds: 5, maxCostUsdPerGen: 0.4 });
  assert.deepEqual(clampSelfTest({ rounds: 9, maxCostUsdPerGen: 9 }, env), { rounds: 5, maxCostUsdPerGen: 0.4 });
  // Raising the server maximum does not change what a request without values gets.
  assert.deepEqual(clampSelfTest({}, { SELF_TEST_MAX_ROUNDS: '100', SELF_TEST_MAX_COST_USD_PER_GEN: '10' }), { rounds: 30, maxCostUsdPerGen: 1.5 });
  // A bad server setting falls back to the default maximum.
  assert.deepEqual(clampSelfTest({ rounds: 99 }, { SELF_TEST_MAX_ROUNDS: 'lots' }), { rounds: 30, maxCostUsdPerGen: 1.5 });
});

test('run_self_test passes the capped values on (no model is called)', async () => {
  const seen = [];
  const selfTest = async (args) => { seen.push(args); return { decision: 'HOLD' }; };
  const ledger = { charge: async (_run, fn) => fn() };
  const ctx = { env: {}, selfTest, ledger };
  const input = { target: { kind: 'anthropic', model: 'm' }, seedCorpus: [{ id: 's1', category: 'c', prompt: 'p' }] };
  await runSelfTest({ ...input, rounds: 100, maxCostUsdPerGen: 50 }, ctx);
  await runSelfTest({ ...input, rounds: 2, maxCostUsdPerGen: 0.1 }, ctx);
  assert.deepEqual(seen.map((a) => [a.rounds, a.maxCostUsdPerGen]), [[30, 1.5], [2, 0.1]]);
  // A target that makes the server call a private address is refused before any spend.
  for (const target of [{ kind: 'http', url: 'http://127.0.0.1:3005/query' }, { kind: 'brain' }, { kind: 'http', url: 'http://10.0.0.5/' }]) {
    await assert.rejects(runSelfTest({ ...input, target }, ctx), (e) => e.status === 403 || e.status === 400);
  }
  assert.equal(seen.length, 2);
  // Without a ledger nothing runs.
  await assert.rejects(runSelfTest(input, { env: {}, selfTest }), /no spend ledger/);
  assert.equal(seen.length, 2);
});
