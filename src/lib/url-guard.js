/**
 * Outbound-request guard for URLs that a caller supplies.
 *
 * A caller-supplied URL may only reach a public internet address. Three
 * layers, because each one alone has a gap:
 *
 *   1. assertPublicUrl — http(s) only, and the host (a literal address or
 *      every address its name resolves to) must be public.
 *   2. A connect-time DNS lookup that refuses non-public addresses, so the
 *      address that was checked is the address that is connected to (a name
 *      that answers differently the second time gains nothing).
 *   3. Redirects are followed by hand, each hop checked again; credentials
 *      are dropped when a redirect leaves the origin.
 *
 * The libraries wrapped here (mcp-audit and the MCP SDK under it) call the
 * global fetch themselves, so the guard is applied by scope: inside
 * `guard.run(fn)` every global fetch goes through the guard, outside it the
 * global fetch is untouched. Requests to configured addresses (the Brain)
 * are made outside that scope and are not restricted.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import dns from 'node:dns';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { ToolError } from './errors.js';

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;

// ── address classification ───────────────────────────────────────────────────

const blocked = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8],        // "this network"
  ['10.0.0.0', 8],       // RFC 1918
  ['100.64.0.0', 10],    // carrier-grade NAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local, incl. the 169.254.169.254 metadata address
  ['172.16.0.0', 12],    // RFC 1918
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // documentation
  ['192.168.0.0', 16],   // RFC 1918
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // documentation
  ['203.0.113.0', 24],   // documentation
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved, incl. broadcast
]) blocked.addSubnet(prefix, bits, 'ipv4');
for (const [prefix, bits] of [
  ['::', 128],           // unspecified
  ['::1', 128],          // loopback
  ['64:ff9b::', 96],     // NAT64 — carries an IPv4 address
  ['64:ff9b:1::', 48],   // local-use NAT64
  ['2001::', 32],        // Teredo
  ['2001:db8::', 32],    // documentation
  ['2002::', 16],        // 6to4 — carries an IPv4 address
  ['fc00::', 7],         // unique local
  ['fe80::', 10],        // link-local
  ['ff00::', 8],         // multicast
]) blocked.addSubnet(prefix, bits, 'ipv6');

/** IPv4 address carried inside an IPv4-mapped or IPv4-compatible IPv6 address, else null. */
function embeddedIpv4(address) {
  const groups = expandIpv6(address);
  if (!groups) return null;
  const head = groups.slice(0, 5).every((g) => g === 0);
  if (!head) return null;
  if (groups[5] !== 0xffff && groups[5] !== 0) return null;
  if (groups[5] === 0 && groups[6] === 0 && groups[7] <= 1) return null; // :: and ::1 are handled by the list
  return `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
}

function expandIpv6(address) {
  let text = String(address).split('%')[0];
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const parts = tail.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
    text = `${text.slice(0, lastColon + 1)}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 0) return null;
  const groups = [...left, ...Array(fill).fill('0'), ...right].map((g) => Number.parseInt(g, 16));
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

/** True when an address must not be reached on a caller's behalf. Unparseable input is blocked. */
export function isBlockedAddress(address) {
  const text = String(address || '').split('%')[0];
  const family = net.isIP(text);
  if (family === 4) return blocked.check(text, 'ipv4');
  if (family === 6) {
    const v4 = embeddedIpv4(text);
    if (v4) return blocked.check(v4, 'ipv4');
    return blocked.check(text, 'ipv6');
  }
  return true;
}

// ── guard ────────────────────────────────────────────────────────────────────

const scope = new AsyncLocalStorage();
let installed = false;

/** Route global fetch through whichever guard is active in the current async scope. */
function install() {
  if (installed) return;
  installed = true;
  const original = globalThis.fetch;
  const patched = (input, init) => {
    const active = scope.getStore();
    return active ? active.guard.fetch(input, init, active) : original(input, init);
  };
  globalThis.fetch = patched;
}

const refuse = (message) => new ToolError(403, message, 'url_not_allowed');

export function createUrlGuard({
  isBlocked = isBlockedAddress,
  lookup = dns.lookup,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const lookupAll = (hostname) => new Promise((resolve, reject) => {
    lookup(hostname, { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)));
  });

  // Used by the socket layer at connect time: what is checked is what is used.
  function guardedLookup(hostname, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : (options || {});
    lookup(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return cb(err);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }];
      const bad = list.find((a) => isBlocked(a.address));
      if (bad || list.length === 0) {
        return cb(refuse(`url host ${hostname} resolves to a non-public address`));
      }
      if (opts.all) return cb(null, list);
      return cb(null, list[0].address, list[0].family);
    });
  }

  const dispatcher = new Agent({
    connect: { lookup: guardedLookup, timeout: 10_000 },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });

  /** Throws unless `raw` is an http(s) URL whose host is a public address. Returns the parsed URL. */
  async function assertPublicUrl(raw) {
    let url;
    try {
      url = raw instanceof URL ? raw : new URL(String(raw));
    } catch {
      throw new ToolError(400, 'url is not a valid URL', 'bad_url');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw refuse(`url scheme ${url.protocol} is not allowed (http and https only)`);
    }
    if (url.username || url.password) {
      throw refuse('url must not carry credentials');
    }
    // WHATWG URL parsing has already turned forms like 0x7f.1 or 2130706433 into dotted IPv4.
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!host) throw new ToolError(400, 'url has no host', 'bad_url');
    if (net.isIP(host)) {
      if (isBlocked(host)) throw refuse(`url host ${host} is not a public address`);
      return url;
    }
    let addresses;
    try {
      addresses = await lookupAll(host);
    } catch (err) {
      throw new ToolError(400, `url host ${host} could not be resolved (${err.code || err.message})`, 'bad_url');
    }
    if (!addresses.length || addresses.some((a) => isBlocked(a.address))) {
      throw refuse(`url host ${host} resolves to a non-public address`);
    }
    return url;
  }

  async function guardedFetch(input, init = {}, active = {}) {
    if (typeof input !== 'string' && !(input instanceof URL)) {
      throw refuse('guarded fetch accepts a URL or string only');
    }
    // Once the scope is over (finished or out of time) nothing more leaves it.
    // The error is an AbortError on purpose: retry loops in the libraries
    // (the SSE client reconnects every 3 s) stop on that and on nothing else.
    const over = () => new DOMException('the guarded request scope has ended', 'AbortError');
    if (active.signal?.aborted) throw over();
    let url = await assertPublicUrl(input);
    let method = String(init.method || 'GET').toUpperCase();
    let body = init.body;
    const headers = new Headers(init.headers || {});
    const signals = [init.signal, active.signal].filter(Boolean);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

    for (let hop = 0; ; hop++) {
      let res;
      try {
        res = await undiciFetch(url, {
          ...init,
          method,
          body,
          headers: Object.fromEntries(headers),
          signal,
          redirect: 'manual',
          dispatcher,
        });
      } catch (err) {
        // The connect-time refusal arrives wrapped as the cause of "fetch failed".
        for (let c = err; c; c = c.cause) if (c instanceof ToolError) throw c;
        if (active.signal?.aborted) throw over();
        throw err;
      }
      const location = res.headers.get('location');
      if (res.status < 300 || res.status > 399 || !location || init.redirect === 'manual') return res;
      await res.body?.cancel().catch(() => {});
      if (init.redirect === 'error') throw refuse('url redirected and redirects are disabled');
      if (hop >= MAX_REDIRECTS) throw refuse(`url redirected more than ${MAX_REDIRECTS} times`);

      const next = await assertPublicUrl(new URL(location, url));
      if (next.origin !== url.origin) {
        for (const name of ['authorization', 'cookie', 'proxy-authorization', 'mcp-session-id']) headers.delete(name);
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
        for (const name of ['content-type', 'content-length']) headers.delete(name);
      } else if (body != null && typeof body !== 'string' && !(body instanceof Uint8Array)) {
        throw refuse('url redirected a request whose body cannot be sent again');
      }
      url = next;
    }
  }

  const guard = {
    assertPublicUrl,
    fetch: guardedFetch,
    /**
     * Run fn with every global fetch inside it guarded. The scope has one
     * overall deadline, and when fn settles the scope is closed: anything the
     * libraries left running can make no further request.
     */
    async run(fn, { timeoutMs: deadline = timeoutMs } = {}) {
      install();
      const controller = new AbortController();
      let timer;
      // A library whose request was aborted may simply never settle, so the
      // deadline ends the wait itself as well as the requests.
      const expired = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ToolError(504, `the remote server did not finish answering within ${deadline} ms`, 'url_timeout'));
        }, deadline);
      });
      try {
        return await Promise.race([scope.run({ guard, signal: controller.signal }, fn), expired]);
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    },
    close: () => dispatcher.destroy(),
  };
  return guard;
}

let shared;
/** The process-wide guard with the real address rules. */
export function defaultUrlGuard() {
  if (!shared) shared = createUrlGuard();
  return shared;
}
