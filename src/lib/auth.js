import crypto from 'node:crypto';

/**
 * Per-caller API keys.
 *
 *   AGENT_API_KEYS = "brain:<key>,security-agent:<key>"
 *   AGENT_API_KEY / API_KEY = one shared key, known as caller "legacy"
 *
 * With no key configured at all, every protected route answers 503 — in
 * every environment. A local developer sets a key like anyone else.
 */
export function loadAgentKeys(env = process.env) {
  const keys = {};
  for (const pair of String(env.AGENT_API_KEYS || '').split(',')) {
    const i = pair.indexOf(':');
    if (i > 0) {
      const name = pair.slice(0, i).trim();
      const key = pair.slice(i + 1).trim();
      if (name && key) keys[name] = key;
    }
  }
  const legacy = env.AGENT_API_KEY || env.API_KEY;
  if (legacy) keys.legacy = legacy;
  return keys;
}

/**
 * What each caller may do. Everything is allowed for every caller unless
 * CALLER_CAPABILITIES narrows it:
 *
 *   CALLER_CAPABILITIES = "security-agent=intel|posture,brain=*"
 *
 * A caller not named there keeps "*". Capability names are the tool names
 * plus intel, posture, scan and admin (see app.js).
 */
export function loadCapabilities(env = process.env) {
  const map = {};
  for (const entry of String(env.CALLER_CAPABILITIES || '').split(',')) {
    const i = entry.indexOf('=');
    if (i <= 0) continue;
    const name = entry.slice(0, i).trim();
    const caps = entry.slice(i + 1).split('|').map((c) => c.trim()).filter(Boolean);
    if (name && caps.length) map[name] = new Set(caps);
  }
  return map;
}

/** Callers named lure-<site> are lure sensors; the site is the rest of the name. */
export const SENSOR_PREFIX = 'lure-';

const digest = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest();

/** Constant-time comparison that does not reveal the length of either side. */
export function safeEqual(a, b) {
  return crypto.timingSafeEqual(digest(a), digest(b));
}

export function createAuth({
  keys = loadAgentKeys(),
  capabilities = loadCapabilities(),
  log = (line) => console.log(line),
} = {}) {
  const names = Object.keys(keys);

  function identify(presented) {
    if (!presented) return null;
    let caller = null;
    // No early exit: every configured key is compared on every request.
    for (const name of names) {
      if (safeEqual(keys[name], presented) && caller === null) caller = name;
    }
    return caller;
  }

  function can(caller, capability) {
    const allowed = capabilities[caller];
    // Sensor keys (callers named lure-<site>) live on public services; they
    // may only post events, whether or not CALLER_CAPABILITIES names them.
    if (caller.startsWith(SENSOR_PREFIX)) return capability === 'sensor';
    if (capability === 'sensor') return false;
    if (!allowed) return true;
    return allowed.has('*') || allowed.has(capability);
  }

  /** Express middleware: authenticate, then check the route's capability. */
  function gate(capability) {
    return (req, res, next) => {
      if (names.length === 0) {
        return res.status(503).json({
          error: 'auth_not_configured',
          message: 'No API key is configured on this service (set AGENT_API_KEYS or AGENT_API_KEY). All protected routes are closed until one is.',
        });
      }
      const caller = identify(req.header('x-api-key'));
      if (!caller) return res.status(401).json({ error: 'unauthorized' });
      req.caller = caller;
      if (!can(caller, capability)) {
        log(`[auth] ${caller} DENIED ${req.method} ${req.path} (needs ${capability})`);
        return res.status(403).json({ error: 'forbidden', message: `caller "${caller}" may not use ${capability}` });
      }
      log(`[auth] ${caller} → ${req.method} ${req.path}`);
      next();
    };
  }

  return { gate, identify, can, callers: names, configured: names.length > 0 };
}
