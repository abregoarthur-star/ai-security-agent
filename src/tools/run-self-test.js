/**
 * Phase 2 — run_self_test
 *
 * Wraps prompt-genesis@0.3.0's `selfTest()` export. Return shape mirrors
 * the frozen contract 1:1 (see project_ai_security_agent.md memory).
 *
 * Stub was removed 2026-04-20 after rounds=3 smoke test passed the other
 * terminal's validation. Real path is live. n=30 scale validation will
 * happen as a separate exercise post-swap.
 */

import { selfTest } from '@dj_abstract/prompt-genesis';

export async function runSelfTest(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('runSelfTest: input must be an object');
  }
  const { target, seedCorpus, rounds, generatorModel, judgeModel, maxCostUsdPerGen } = input;

  if (!target) throw new Error('runSelfTest: target is required');
  if (!Array.isArray(seedCorpus) || seedCorpus.length === 0) {
    throw new Error('runSelfTest: seedCorpus must be a non-empty array');
  }

  return await selfTest({
    target,
    seedCorpus,
    rounds:         rounds || 30,
    generatorModel: generatorModel || 'claude-sonnet-4-6',
    judgeModel:     judgeModel || 'claude-haiku-4-5',
    maxCostUsdPerGen: maxCostUsdPerGen || 1.50,
  });
}
