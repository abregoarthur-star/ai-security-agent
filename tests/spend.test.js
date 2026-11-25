import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSpendLedger } from '../src/lib/spend.js';
import { runSelfTest } from '../src/tools/run-self-test.js';
import { createApp } from '../src/app.js';
import { scratch, listen, quiet } from './helpers.js';

const INPUT = {
  target: { kind: 'anthropic', model: 'claude-x', systemPrompt: 'a long private prompt' },
  seedCorpus: [{ id: 's1', category: 'c', prompt: 'p' }],
};

/** What prompt-genesis selfTest() returns, reduced to the parts the ledger reads. */
const result = (tdUsd, nmUsd) => ({
  decision: 'HOLD',
  generation: {
    td: { attacks: 3, rejects: 1, costUsd: tdUsd, stoppedBy: 'count' },
    nm: { attacks: 3, rejects: 0, costUsd: nmUsd, stoppedBy: 'count' },
  },
  reports: { baseline: { results: [1] }, tdEval: { results: [1, 2, 3] }, nmEval: { results: [1, 2, 3] } },
});

function setup(t, { env = {}, start = '2026-11-24T10:00:00Z' } = {}) {
  const dataDir = scratch(t);
  const clock = { now: new Date(start) };
  const make = () => createSpendLedger({ env, dataDir, now: () => new Date(clock.now), log: quiet });
  const calls = [];
  let next = () => result(0.4, 0.3);
  const selfTest = async (args) => { calls.push(args); return next(); };
  const run = (ledger, extra = {}, caller = 'brain') => runSelfTest({ ...INPUT, ...extra }, { env, ledger, selfTest, caller });
  return { dataDir, clock, make, calls, run, setNext: (fn) => { next = fn; }, file: path.join(dataDir, 'self-test-spend.json') };
}

test('a run is recorded: who, what, models, rounds, cost and call counts', async (t) => {
  const { make, run, file } = setup(t);
  const ledger = make();
  const out = await run(ledger, { rounds: 5, generatorModel: 'claude-sonnet-5-5' });
  assert.equal(out.decision, 'HOLD', 'the result is passed through untouched');

  const s = ledger.summary();
  assert.equal(s.runs.length, 1);
  assert.deepEqual(s.runs[0], {
    at: '2026-11-24T10:00:00.000Z',
    caller: 'brain',
    target: { kind: 'anthropic', model: 'claude-x' },
    generatorModel: 'claude-sonnet-5-5',
    judgeModel: 'claude-haiku-4-5',
    rounds: 5,
    maxUsd: 3,
    ok: true,
    usd: 0.7,
    generation: { td: { attacks: 3, rejects: 1, costUsd: 0.4, stoppedBy: 'count' }, nm: { attacks: 3, rejects: 0, costUsd: 0.3, stoppedBy: 'count' } },
    evalCalls: 7,
    decision: 'HOLD',
  });
  assert.deepEqual(s.today, { date: '2026-11-24', usd: 0.7, runs: 1, evalCalls: 7, capUsd: 3, remainingUsd: 2.3, inFlightUsd: 0 });
  assert.deepEqual(s.days, [{ date: '2026-11-24', usd: 0.7, runs: 1, evalCalls: 7 }]);
  const onDisk = fs.readFileSync(file, 'utf8');
  assert.ok(!onDisk.includes('a long private prompt'), 'the target system prompt is not stored');
  assert.ok(!onDisk.includes('"seedCorpus"'));
});

test('the daily cap refuses a run whose maximum would pass it, before anything is spent', async (t) => {
  const { make, run, calls } = setup(t);
  const ledger = make();
  await run(ledger);                                   // spends 0.70; default cap 3.00
  // Default run could cost 2 × 1.50 = 3.00 → 0.70 + 3.00 > 3.00
  await assert.rejects(run(ledger), (e) => e.status === 429 && e.code === 'daily_cap' && /\$3\.00/.test(e.message) && /\$0\.70/.test(e.message));
  assert.equal(calls.length, 1, 'selfTest was not called');
  assert.equal(ledger.summary().runs.length, 1, 'a refused run is not a run');
  // A caller who lowers its own maximum fits: 0.70 + 2 × 1.00 ≤ 3.00
  await run(ledger, { maxCostUsdPerGen: 1 });
  assert.equal(calls.length, 2);
  assert.equal(ledger.today().usd, 1.4);
  // 1.40 + 2 × 0.80 = 3.00 is exactly the cap and is allowed; one cent more is not.
  await assert.rejects(run(ledger, { maxCostUsdPerGen: 0.81 }), (e) => e.code === 'daily_cap');
  await run(ledger, { maxCostUsdPerGen: 0.8 });
  assert.equal(calls.length, 3);
});

test('the cap comes from SELF_TEST_DAILY_CAP_USD; a bad value falls back to 3.00', async (t) => {
  const low = setup(t, { env: { SELF_TEST_DAILY_CAP_USD: '1' } });
  await assert.rejects(low.run(low.make()), (e) => e.code === 'daily_cap');   // 3.00 > 1.00
  await low.run(low.make(), { maxCostUsdPerGen: 0.5 });                         // 1.00 ≤ 1.00
  for (const bad of ['abc', '-5', '0', '', 'NaN', 'Infinity']) {
    const s = setup(t, { env: { SELF_TEST_DAILY_CAP_USD: bad } });
    assert.equal(s.make().today().capUsd, 3, `cap for "${bad}"`);
  }
  assert.equal(setup(t, { env: { SELF_TEST_DAILY_CAP_USD: '12.5' } }).make().today().capUsd, 12.5);
});

test('runs in flight count against the cap', async (t) => {
  const { make, run, setNext, calls } = setup(t);
  const ledger = make();
  let release;
  setNext(() => new Promise((resolve) => { release = () => resolve(result(0.1, 0.1)); }));
  const first = run(ledger);                            // holds 3.00 while it runs
  await new Promise((r) => setImmediate(r));
  assert.equal(ledger.today().inFlightUsd, 3);
  await assert.rejects(run(ledger, { maxCostUsdPerGen: 0.01 }), (e) => e.code === 'daily_cap');
  release();
  await first;
  assert.equal(calls.length, 1);
  assert.deepEqual([ledger.today().usd, ledger.today().inFlightUsd], [0.2, 0]);
});

test('a run that fails is recorded and counted at its maximum', async (t) => {
  const { make, run, setNext } = setup(t);
  const ledger = make();
  setNext(() => { throw new Error('provider 529 overloaded'); });
  await assert.rejects(run(ledger, { maxCostUsdPerGen: 0.5 }), /529/);
  const [entry] = ledger.summary().runs;
  assert.deepEqual([entry.ok, entry.usd, entry.estimated, entry.error], [false, 1, true, 'provider 529 overloaded']);
  assert.equal(ledger.today().usd, 1);
});

test('the ledger survives a restart, and so does the cap', async (t) => {
  const { make, run, calls } = setup(t);
  await run(make());
  const restarted = make();
  assert.equal(restarted.today().usd, 0.7);
  assert.equal(restarted.summary().runs.length, 1);
  await assert.rejects(run(restarted), (e) => e.code === 'daily_cap');
  assert.equal(calls.length, 1);
});

test('a new UTC day starts at zero; 30 days of daily totals are kept', async (t) => {
  const { make, run, clock } = setup(t, { start: '2026-10-01T23:30:00Z' });
  const ledger = make();
  for (let i = 0; i < 40; i++) {
    await run(ledger);
    assert.equal(ledger.today().usd, 0.7, `day ${i} starts from zero`);
    clock.now = new Date(clock.now.getTime() + 86_400_000);
  }
  const s = ledger.summary();
  assert.equal(s.days.length, 29, 'days older than 30 days are dropped (today has no run yet)');
  assert.equal(s.runs.length, 29);
  assert.equal(s.days[0].date, '2026-11-09');
  assert.equal(s.days.at(-1).date, '2026-10-12');
  assert.equal(s.today.usd, 0);
});

test('a corrupt or unwritable ledger file does not stop the service', async (t) => {
  const a = setup(t);
  fs.writeFileSync(a.file, '{broken');
  assert.equal(a.make().today().usd, 0);
  const ledger = createSpendLedger({ env: {}, dataDir: '/dev/null/nope', log: quiet });
  await runSelfTest(INPUT, { env: {}, ledger, selfTest: async () => result(0.2, 0.2), caller: 'brain' });
  assert.equal(ledger.today().usd, 0.4, 'still counted in memory');
});

const notAllowed = (e) => e.status === 400 && e.code === 'model_not_allowed' && /allowlist/.test(e.message);

test('generator and judge models: only allowlisted ones may be named', async (t) => {
  const { make, run, calls } = setup(t, { env: { SELF_TEST_DAILY_CAP_USD: '100' } });
  const ledger = make();
  // Default list: current Sonnet and Haiku, and the Groq models prompt-genesis prices.
  for (const extra of [
    { generatorModel: 'claude-sonnet-5-5', judgeModel: 'claude-haiku-5-5' },
    { generatorModel: 'groq:llama-3.3-70b-versatile' },
    { generatorModel: 'llama-3.1-8b-instant' },
    { generatorModel: 'groq:meta-llama/llama-4-scout-17b-16e-instruct' },
    {},                                                    // names none: the server's own defaults
  ]) await run(ledger, extra);
  assert.equal(calls.length, 5);
  assert.deepEqual([calls[4].generatorModel, calls[4].judgeModel], ['claude-sonnet-4-6', 'claude-haiku-4-5'], 'built-in defaults are unchanged');

  for (const extra of [
    { generatorModel: 'claude-opus-5-5' },
    { generatorModel: 'claude-opus-4-7' },
    { judgeModel: 'claude-opus-5-5' },
    { generatorModel: 'claude-sonnet-4-6' },               // not on the list when a caller names it
    { generatorModel: 'groq:claude-opus-5-5' },
    { generatorModel: 'evil:claude-sonnet-5-5:extra' },
    { generatorModel: { id: 'claude-sonnet-5-5' } },
    { judgeModel: 'CLAUDE-HAIKU-5-5' },
  ]) {
    await assert.rejects(run(ledger, extra), notAllowed, JSON.stringify(extra));
  }
  assert.equal(calls.length, 5, 'nothing ran, nothing was spent');
  assert.equal(ledger.summary().runs.length, 5);
});

test('the model allowlist comes from SELF_TEST_MODEL_ALLOWLIST when set', async (t) => {
  const env = { SELF_TEST_DAILY_CAP_USD: '100', SELF_TEST_MODEL_ALLOWLIST: ' claude-opus-5-5 , my-model ' };
  const { make, run, calls } = setup(t, { env });
  const ledger = make();
  await run(ledger, { generatorModel: 'claude-opus-5-5', judgeModel: 'my-model' });
  await assert.rejects(run(ledger, { generatorModel: 'claude-sonnet-5-5' }), notAllowed);
  assert.equal(calls.length, 1);
});

test('over HTTP: the caller is recorded, the ledger and today\'s spend are behind a key, a capped run is 429', async (t) => {
  const dataDir = scratch(t);
  const env = { AGENT_API_KEYS: 'brain:k1,security-agent:k2', DATA_DIR: dataDir };
  const ledger = createSpendLedger({ env, dataDir, log: quiet });
  const tools = { run_self_test: (body, ctx) => runSelfTest(body, { ...ctx, selfTest: async () => result(0.5, 0.25) }) };
  const { base } = await listen(t, createApp({ env, tools, ledger, scan: {}, log() {} }));
  const post = (key, body) => fetch(`${base}/tools/run_self_test`, { method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const get = (p, key) => fetch(base + p, { headers: key ? { 'x-api-key': key } : {} });

  const denied = await post('k2', { ...INPUT, generatorModel: 'claude-opus-5-5' });
  assert.equal(denied.status, 400);
  assert.equal((await denied.json()).code, 'model_not_allowed');

  assert.equal((await post('k2', INPUT)).status, 200);
  const refused = await post('k1', INPUT);
  assert.equal(refused.status, 429);
  assert.equal((await refused.json()).code, 'daily_cap');

  assert.equal((await get('/ai-security/spend')).status, 401);
  const spend = await (await get('/ai-security/spend', 'k1')).json();
  assert.equal(spend.today.usd, 0.75);
  assert.equal(spend.today.capUsd, 3);
  assert.deepEqual(spend.runs.map((r) => r.caller), ['security-agent']);

  const config = await (await get('/ai-security/config', 'k1')).json();
  assert.equal(config.selfTestSpendToday.usd, 0.75);
  assert.equal(config.limits.selfTestDailyCapUsd, 3);
  assert.ok(config.limits.selfTestModels.includes('claude-sonnet-5-5'));
  assert.ok(!JSON.stringify(await (await get('/health')).json()).includes('usd'), '/health says nothing about spend');
});

test('default settings: one default-size run with a Sonnet target fits in a day, a second is refused', async (t) => {
  const { make, run, calls, setNext } = setup(t, { env: {} });
  const ledger = make();
  assert.equal(ledger.today().capUsd, 3);
  setNext(() => result(1.5, 1.5));                       // both generation passes run to their $1.50 limit
  const sonnet = { target: { kind: 'anthropic', model: 'claude-sonnet-5-5' } };   // 30 rounds, $1.50 per pass by default
  await run(ledger, sonnet);
  assert.deepEqual([calls[0].rounds, calls[0].maxCostUsdPerGen], [30, 1.5]);
  await assert.rejects(run(ledger, sonnet), (e) => e.status === 429 && e.code === 'daily_cap');
  assert.equal(calls.length, 1);
});

test('default settings: the second default-size run is refused even when the first cost little', async (t) => {
  const { make, run, calls } = setup(t, { env: {} });
  const ledger = make();
  const sonnet = { target: { kind: 'anthropic', model: 'claude-sonnet-5-5' } };
  await run(ledger, sonnet);                             // recorded at $0.70
  await assert.rejects(run(ledger, sonnet), (e) => e.code === 'daily_cap');
  assert.equal(calls.length, 1);
});
