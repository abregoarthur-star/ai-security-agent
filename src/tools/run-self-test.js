/**
 * Phase 2 — run_self_test
 *
 * Wraps prompt-genesis's `selfTest()` export. Return shape mirrors
 * the frozen contract 1:1 (see project_ai_security_agent.md memory).
 *
 * Each run spends real money on model calls, so the two inputs that set the
 * size of the bill — `rounds` and `maxCostUsdPerGen` — are capped by the
 * server (SELF_TEST_MAX_ROUNDS, SELF_TEST_MAX_COST_USD_PER_GEN). A caller may
 * ask for less, never for more. Every run goes through the spend ledger
 * (ctx.ledger, lib/spend.js), which enforces the daily cap and records it.
 */

import { selfTest } from '@dj_abstract/prompt-genesis';
import { badRequest } from '../lib/errors.js';
import { assertModelAllowed, clampSelfTest } from '../lib/policy.js';
import { defaultUrlGuard } from '../lib/url-guard.js';

// Target kinds that make this server call an address the caller names.
const URL_TARGET_KINDS = new Set(['http', 'brain']);

export async function runSelfTest(input, ctx = {}) {
  const env = ctx.env || process.env;
  if (!input || typeof input !== 'object') {
    throw badRequest('runSelfTest: input must be an object');
  }
  const { target, seedCorpus, rounds, generatorModel, judgeModel, maxCostUsdPerGen } = input;

  if (!target || typeof target !== 'object') throw badRequest('runSelfTest: target is required');
  if (!Array.isArray(seedCorpus) || seedCorpus.length === 0) {
    throw badRequest('runSelfTest: seedCorpus must be a non-empty array');
  }
  // The models the run will use, named or default, must be on the allowlist.
  const models = { generatorModel: generatorModel || 'claude-sonnet-5-5', judgeModel: judgeModel || 'claude-haiku-5-5' };
  assertModelAllowed(models.generatorModel, 'generatorModel', env);
  assertModelAllowed(models.judgeModel, 'judgeModel', env);
  if (URL_TARGET_KINDS.has(target.kind)) {
    if (typeof target.url !== 'string') throw badRequest(`runSelfTest: target.url is required for kind "${target.kind}"`);
    await (ctx.guard || defaultUrlGuard()).assertPublicUrl(target.url);
  }

  const capped = clampSelfTest({ rounds, maxCostUsdPerGen }, env);
  if ((rounds && Number(rounds) !== capped.rounds) || (maxCostUsdPerGen && Number(maxCostUsdPerGen) !== capped.maxCostUsdPerGen)) {
    console.log(`[run_self_test] request limits lowered to the server maxima: rounds=${capped.rounds} maxCostUsdPerGen=${capped.maxCostUsdPerGen}`);
  }

  if (!ctx.ledger) throw new Error('runSelfTest: no spend ledger — refusing to run untracked');
  const run = {
    target,
    seedCorpus,
    rounds:         capped.rounds,
    ...models,
    maxCostUsdPerGen: capped.maxCostUsdPerGen,
  };
  return await ctx.ledger.charge({ ...run, caller: ctx.caller }, () => (ctx.selfTest || selfTest)(run));
}
