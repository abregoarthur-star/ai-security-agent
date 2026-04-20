/**
 * Fetch recent agent-firewall events from Brain's security endpoint.
 * Returns blocked/warned calls for audit-trail analysis.
 */
export async function firewallRecentEvents({ since, limit = 50 } = {}) {
  const brainUrl = process.env.BRAIN_API_URL;
  const apiKey = process.env.BRAIN_API_KEY;

  if (!brainUrl) {
    throw new Error('firewallRecentEvents: BRAIN_API_URL not configured');
  }

  const qs = new URLSearchParams();
  if (since) qs.set('since', since);
  if (limit) qs.set('limit', String(limit));

  const res = await fetch(`${brainUrl}/security/firewall/events?${qs}`, {
    headers: apiKey ? { 'x-api-key': apiKey } : {},
  });

  if (!res.ok) {
    throw new Error(`firewallRecentEvents: Brain returned ${res.status} ${res.statusText}`);
  }

  return await res.json();
}
