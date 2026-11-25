/**
 * Spend ledger for run_self_test — the only thing this service does that
 * costs money. Every run is recorded, and a daily dollar cap across all
 * runs is enforced before a run starts.
 *
 * Cost is what prompt-genesis reports for the run: the two generation
 * passes (each capped at maxCostUsdPerGen) and the evaluation calls (target
 * and judge; a target that reports no token usage contributes 0). Both are
 * recorded and both count toward the day. Only generation has a hard limit,
 * so the worst case reserved before a run is 2 × maxCostUsdPerGen; evaluation
 * on the allowlisted models is cents and is added when the run reports it.
 *
 * Days are UTC. The ledger keeps 30 days.
 */
import path from 'node:path';
import { resolveDataDir } from './data-dir.js';
import { ToolError } from './errors.js';
import { limits } from './policy.js';
import { jsonFile } from './store.js';

const KEEP_DAYS = 30;
const round = (usd) => Math.round(usd * 1e6) / 1e6;
const dayOf = (date) => date.toISOString().slice(0, 10);

export function createSpendLedger({
  env = process.env,
  dataDir = resolveDataDir(env),
  now = () => new Date(),
  log = console,
} = {}) {
  const file = jsonFile(path.join(dataDir, 'self-test-spend.json'), log);
  const saved = file.read();
  const days = saved?.days && typeof saved.days === 'object' ? saved.days : {};   // 'YYYY-MM-DD' → { usd, runs, evalCalls }
  const runs = Array.isArray(saved?.runs) ? saved.runs : [];
  let reserved = 0;   // worst-case cost of runs in flight

  const capUsd = () => limits(env).selfTestDailyCapUsd;
  const todayUsd = () => days[dayOf(now())]?.usd || 0;

  function prune() {
    const cutoff = dayOf(new Date(now().getTime() - (KEEP_DAYS - 1) * 86_400_000));
    for (const day of Object.keys(days)) if (day < cutoff) delete days[day];
    while (runs.length && runs[0].at.slice(0, 10) < cutoff) runs.shift();
  }

  /**
   * Run `fn` (the self-test) under the cap. Refuses with 429 when today's
   * recorded spend, plus runs already in flight, plus this run's maximum
   * would pass the daily cap. Records the run either way.
   */
  async function charge({ caller, target, generatorModel, judgeModel, rounds, maxCostUsdPerGen }, fn) {
    const maxUsd = 2 * maxCostUsdPerGen;   // two generation passes
    const spent = todayUsd();
    if (spent + reserved + maxUsd > capUsd() + 1e-9) {
      throw new ToolError(429,
        `self-test refused: the daily spend cap is $${capUsd().toFixed(2)}, $${(spent + reserved).toFixed(2)} is already spent or committed today, `
        + `and this run could cost up to $${maxUsd.toFixed(2)}. Lower maxCostUsdPerGen or try again after 00:00 UTC.`,
        'daily_cap');
    }

    const entry = {
      at: now().toISOString(),
      caller: caller || 'unknown',
      target: { kind: target?.kind ?? null, model: target?.model ?? null },
      generatorModel, judgeModel, rounds,
      maxUsd: round(maxUsd),
    };
    reserved += maxUsd;
    try {
      const result = await fn();
      const gen = result?.generation || {};
      const reports = result?.reports || {};
      const count = (report) => (Array.isArray(report?.results) ? report.results.length : 0);
      const generationUsd = round((Number(gen.td?.costUsd) || 0) + (Number(gen.nm?.costUsd) || 0));
      const evaluationUsd = round(Number(result?.evaluation?.costUsd) || 0);
      Object.assign(entry, {
        ok: true,
        usd: round(generationUsd + evaluationUsd),   // what the day's total and the cap count
        generationUsd,
        evaluationUsd,
        generation: { td: gen.td ?? null, nm: gen.nm ?? null },
        evaluation: result?.evaluation ?? null,
        evalCalls: count(reports.baseline) + count(reports.tdEval) + count(reports.nmEval),
        decision: result?.decision ?? null,
      });
      return result;
    } catch (err) {
      // What a failed run spent is unknown, so the cap counts its maximum.
      Object.assign(entry, { ok: false, usd: round(maxUsd), estimated: true, evalCalls: 0, error: String(err?.message || err).slice(0, 300) });
      throw err;
    } finally {
      reserved -= maxUsd;
      const day = (days[entry.at.slice(0, 10)] ||= { usd: 0, runs: 0, evalCalls: 0 });
      day.usd = round(day.usd + entry.usd);
      day.runs += 1;
      day.evalCalls += entry.evalCalls;
      runs.push(entry);
      prune();
      log.log(`[spend] self-test by ${entry.caller}: $${entry.usd.toFixed(4)}${entry.estimated ? ' (failed; counted at its maximum)' : ''} — today $${todayUsd().toFixed(4)} of $${capUsd().toFixed(2)}`);
      await file.write({ savedAt: now().toISOString(), days, runs });
    }
  }

  function today() {
    const date = dayOf(now());
    const d = days[date] || { usd: 0, runs: 0, evalCalls: 0 };
    return { date, ...d, capUsd: capUsd(), remainingUsd: round(Math.max(0, capUsd() - d.usd - reserved)), inFlightUsd: round(reserved) };
  }

  function summary() {
    prune();
    return {
      today: today(),
      note: 'usd = generationUsd + evaluationUsd, both as reported by prompt-genesis. Evaluation covers target and judge calls billed to this service; a target that reports no token usage (http, brain, groq, together) contributes 0. Before a run the cap reserves 2 × maxCostUsdPerGen (generation only), so evaluation can take a day slightly past the cap. A failed run is counted at that reserved maximum. Runs recorded before prompt-genesis 0.4.0 carry generation cost only.',
      days: Object.keys(days).sort().reverse().map((date) => ({ date, ...days[date] })),
      runs: [...runs].reverse(),
      file: file.file,
    };
  }

  return { charge, today, summary };
}
