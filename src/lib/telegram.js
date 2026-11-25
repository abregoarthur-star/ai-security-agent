/**
 * Telegram alerts go through Brain's /telegram/send (Brain owns the bot).
 * One function for every sender here: the self-scan and the lure sensors.
 * Never throws; returns the outcome so callers can record it.
 */
const TELEGRAM_TIMEOUT_MS = 15_000;

export async function sendTelegram({ env = process.env, fetchImpl = fetch, kind, message, log = console }) {
  const at = new Date().toISOString();
  const base = String(env.BRAIN_API_URL || '').replace(/\/$/, '');
  const key = env.BRAIN_API_KEY;
  if (!base || !key) {
    log.warn(`[ai-sec-agent] alert not sent (${kind}): Brain is not configured`);
    return { kind, at, ok: false, skipped: 'BRAIN_API_URL / BRAIN_API_KEY not configured' };
  }
  try {
    const res = await fetchImpl(`${base}/telegram/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ message, from: 'AI Security Agent' }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
    if (res.ok) return { kind, at, ok: true, status: res.status };
    const body = await res.text().catch(() => '');
    log.error(`[ai-sec-agent] telegram post rejected (${kind}): ${res.status} ${body.slice(0, 200)}`);
    return { kind, at, ok: false, status: res.status, error: body.slice(0, 200) };
  } catch (err) {
    log.error(`[ai-sec-agent] telegram post failed (${kind}): ${err.message}`);
    return { kind, at, ok: false, error: err.message };
  }
}

export const escapeHtml = (text) => String(text).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
