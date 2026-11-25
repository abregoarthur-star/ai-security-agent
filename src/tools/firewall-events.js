const TIMEOUT_MS = 15_000;

/**
 * Fetch recent agent-firewall events from Brain's security endpoint.
 * Returns blocked/warned calls for audit-trail analysis.
 */
export async function firewallRecentEvents({ since, limit = 50 } = {}, ctx = {}) {
  const env = ctx.env || process.env;
  const fetchImpl = ctx.fetch || fetch;
  const brainUrl = env.BRAIN_API_URL;
  const apiKey = env.BRAIN_API_KEY;

  if (!brainUrl) {
    throw new Error('firewallRecentEvents: BRAIN_API_URL not configured');
  }

  const qs = new URLSearchParams();
  if (since) qs.set('since', String(since).slice(0, 64));
  const n = Number.parseInt(limit, 10);
  if (Number.isFinite(n) && n > 0) qs.set('limit', String(Math.min(n, 500)));

  const res = await fetchImpl(`${brainUrl.replace(/\/$/, '')}/security/firewall/events?${qs}`, {
    headers: apiKey ? { 'x-api-key': apiKey } : {},
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`firewallRecentEvents: Brain returned ${res.status} ${res.statusText}`);
  }

  return await res.json();
}
