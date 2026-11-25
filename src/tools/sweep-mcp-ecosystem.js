import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { auditMcpServer } from './audit-mcp-server.js';
import { badRequest } from '../lib/errors.js';
import { MAX_TARGETS, jsonFilesInsideRoot } from '../lib/policy.js';

/**
 * Sweep multiple MCP servers in parallel (bounded concurrency) and return
 * aggregated findings — the programmatic equivalent of the mcp-audit-sweep
 * methodology.
 *
 * Input shapes (exactly one required):
 *   { targets: [ <spec>, ... ] }
 *       where each <spec> is one of:
 *         { name?, manifestData: {...} }
 *         { name?, manifest: "file inside MANIFEST_ROOT" }
 *         { name?, stdio: "cmd ..." }            (off unless the server allows it)
 *         { name?, url: "https://...", bearer?, headers? }   (public addresses only)
 *       Each target goes through the same checks as audit_mcp_server; one
 *       that is refused is reported as failed and the rest still run.
 *   { baselinesDir: "dir inside MANIFEST_ROOT" }
 *       — reads all *.json files in the dir and treats each as inline manifestData.
 *         Relative paths are taken from MANIFEST_ROOT.
 *         Files that don't look like manifests (no `tools` array) are skipped.
 *
 * Options (top-level, optional):
 *   concurrency: integer, default 5, max 20
 *   fullReports: boolean, default false — if true, include each target's full
 *                mcp-audit report in the response (heavy; off for fleet sweeps)
 *
 * Response shape:
 *   {
 *     asOf: ISO8601,
 *     fleet: {
 *       scanned: N,
 *       succeeded: N,
 *       failed: N,
 *       totalTools: N,
 *       totalFindings: N,
 *       bySeverity: { critical, high, medium, low, info },
 *       serversWithAnyHigh: N,           // ≥1 high OR critical
 *       serversWithAnyCritical: N,
 *       topRules: [{ ruleId, count, severity }]   // top 10 by count
 *     },
 *     targets: [
 *       { name, ok: true,  tools, findings, bySeverity, criticals: [string], highs: [string] },
 *       { name, ok: false, error: "..." }
 *     ],
 *     reports?: { [name]: <full audit report> }   // only when fullReports=true
 *   }
 */
export async function sweepMcpEcosystem(input = {}, ctx = {}) {
  const env = ctx.env || process.env;
  if (typeof input !== 'object' || input === null) {
    throw badRequest('sweepMcpEcosystem: input must be an object');
  }

  const concurrency = clampInt(input.concurrency, 1, 20, 5);
  const fullReports = !!input.fullReports;

  const targets = await resolveTargets(input, env);
  if (!targets.length) {
    throw badRequest('sweepMcpEcosystem: no targets resolved from input');
  }
  if (targets.length > MAX_TARGETS) {
    throw badRequest(`sweepMcpEcosystem: at most ${MAX_TARGETS} targets per call`);
  }

  const startedAt = new Date().toISOString();
  const results = await runBatched(targets, concurrency, (t) => auditOne(t, ctx));

  return aggregate({ startedAt, results, fullReports });
}

// ── target resolution ────────────────────────────────────────────────────────

async function resolveTargets(input, env) {
  const { targets, baselinesDir } = input;
  const providedCount = [Array.isArray(targets) && targets.length, baselinesDir]
    .filter(Boolean).length;
  if (providedCount !== 1) {
    throw badRequest('sweepMcpEcosystem: provide exactly one of {targets[], baselinesDir}');
  }

  if (Array.isArray(targets)) {
    return targets.map((spec, i) => normalizeTarget(spec, i));
  }

  // baselinesDir: load every *.json directly in the directory as inline
  // manifestData. The directory and each file must really be inside MANIFEST_ROOT.
  const jsonFiles = await jsonFilesInsideRoot(baselinesDir, env, { depth: 0 });

  const loaded = [];
  for (const fullPath of jsonFiles) {
    const file = basename(fullPath);
    try {
      const raw = await readFile(fullPath, 'utf8');
      const data = JSON.parse(raw);
      // Only accept real manifests (must have a tools array). The mcp-audit-sweep
      // `baselines/` directory holds post-audit reports — those also have
      // `tools`, but the `reports/` dir is the intended source of raw manifests.
      if (!Array.isArray(data.tools)) continue;
      const name = data.server?.name || basename(file, '.json');
      loaded.push({ name, manifestData: data, _source: fullPath });
    } catch (err) {
      loaded.push({ name: basename(file, '.json'), _loadError: err.message });
    }
  }
  if (!loaded.length) {
    throw badRequest('sweepMcpEcosystem: no manifest-shaped JSON files found in baselinesDir');
  }
  return loaded;
}

function normalizeTarget(spec, idx) {
  if (!spec || typeof spec !== 'object') {
    return { name: `target-${idx}`, _invalid: 'spec must be an object' };
  }
  const { name, manifest, manifestData, stdio, url, bearer, headers } = spec;
  const modes = [manifest, manifestData, stdio, url].filter(Boolean);
  if (modes.length !== 1) {
    return {
      name: name || `target-${idx}`,
      _invalid: 'provide exactly one of {manifest, manifestData, stdio, url}',
    };
  }
  const derivedName =
    name ||
    manifestData?.server?.name ||
    (manifest && basename(String(manifest), '.json')) ||
    (stdio && String(stdio).split(/\s+/)[0]) ||
    url ||
    `target-${idx}`;
  return { name: derivedName, manifest, manifestData, stdio, url, bearer, headers };
}

// ── per-target audit ─────────────────────────────────────────────────────────

async function auditOne(target, ctx) {
  if (target._invalid) {
    return { name: target.name, ok: false, error: target._invalid };
  }
  if (target._loadError) {
    return { name: target.name, ok: false, error: `load failed: ${target._loadError}` };
  }

  try {
    // Same entry point, and so the same restrictions, as audit_mcp_server.
    const { manifest, manifestData, stdio, url, bearer, headers } = target;
    const report = await auditMcpServer({ manifest, manifestData, stdio, url, bearer, headers }, ctx);
    return { name: target.name, ok: true, report };
  } catch (err) {
    return { name: target.name, ok: false, error: err?.message || String(err) };
  }
}

// ── bounded-concurrency batch runner ─────────────────────────────────────────

async function runBatched(items, concurrency, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return out;
}

// ── aggregation ──────────────────────────────────────────────────────────────

function aggregate({ startedAt, results, fullReports }) {
  const fleet = {
    scanned: results.length,
    succeeded: 0,
    failed: 0,
    totalTools: 0,
    totalFindings: 0,
    bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    serversWithAnyHigh: 0,
    serversWithAnyCritical: 0,
    topRules: [],
  };
  const ruleCounts = new Map(); // ruleId → { count, severity }
  const targetSummaries = [];
  const reports = fullReports ? {} : undefined;

  for (const r of results) {
    if (!r.ok) {
      fleet.failed += 1;
      targetSummaries.push({ name: r.name, ok: false, error: r.error });
      continue;
    }

    fleet.succeeded += 1;
    const { report } = r;
    const findings = Array.isArray(report?.findings) ? report.findings : [];
    const toolCount = report?.server?.counts?.tools ?? (Array.isArray(report?.tools) ? report.tools.length : 0);

    fleet.totalTools += toolCount;
    fleet.totalFindings += findings.length;

    const bySev = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    const criticals = [];
    const highs = [];
    for (const f of findings) {
      const sev = String(f.severity || 'info').toLowerCase();
      if (!(sev in bySev)) bySev[sev] = 0;
      bySev[sev] += 1;
      if (sev in fleet.bySeverity) fleet.bySeverity[sev] += 1;

      const label = `${f.ruleId || f.id || 'unknown'}: ${f.title || ''}`.trim();
      if (sev === 'critical' && criticals.length < 10) criticals.push(label);
      if (sev === 'high' && highs.length < 10) highs.push(label);

      if (f.ruleId) {
        const prev = ruleCounts.get(f.ruleId) || { count: 0, severity: sev };
        prev.count += 1;
        // Keep the worst severity we've seen for this rule
        prev.severity = worstSeverity(prev.severity, sev);
        ruleCounts.set(f.ruleId, prev);
      }
    }

    if (bySev.critical > 0) fleet.serversWithAnyCritical += 1;
    if (bySev.critical > 0 || bySev.high > 0) fleet.serversWithAnyHigh += 1;

    targetSummaries.push({
      name: r.name,
      ok: true,
      tools: toolCount,
      findings: findings.length,
      bySeverity: bySev,
      criticals,
      highs,
    });

    if (fullReports) reports[r.name] = report;
  }

  fleet.topRules = Array.from(ruleCounts.entries())
    .map(([ruleId, v]) => ({ ruleId, count: v.count, severity: v.severity }))
    .sort((a, b) => b.count - a.count || a.ruleId.localeCompare(b.ruleId))
    .slice(0, 10);

  const result = { asOf: startedAt, fleet, targets: targetSummaries };
  if (fullReports) result.reports = reports;
  return result;
}

const SEV_ORDER = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
function worstSeverity(a, b) {
  const av = SEV_ORDER[a] ?? 0;
  const bv = SEV_ORDER[b] ?? 0;
  return av >= bv ? a : b;
}

function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
