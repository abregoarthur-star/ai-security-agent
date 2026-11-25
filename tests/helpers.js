import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A scratch directory removed when the test ends. */
export function scratch(t, prefix = 'ai-sec-test-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Start an Express app (or any request listener) on a loopback port. */
export async function listen(t, app, host = '127.0.0.1') {
  const http = await import('node:http');
  const server = http.createServer(app);
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, host, resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  const { port } = server.address();
  return { server, port, base: `http://${host.includes(':') ? `[${host}]` : host}:${port}` };
}

export const quiet = { log() {}, warn() {}, error() {} };

export const MANIFEST = {
  name: 'demo',
  version: '1.0.0',
  tools: [{ name: 'get_weather', description: 'Weather for a city', inputSchema: { type: 'object', properties: { city: { type: 'string' } } } }],
  resources: [],
  prompts: [],
};

/** A fetch stand-in: routes is { 'METHOD path': (url, init) => Response | object }. Records calls. */
export function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const u = new URL(String(url));
    const key = `${(init.method || 'GET').toUpperCase()} ${u.pathname}`;
    calls.push({ key, url: String(url), init });
    const handler = routes[key];
    if (!handler) return new Response('not found', { status: 404 });
    const out = await handler(u, init);
    return out instanceof Response ? out : Response.json(out);
  };
  impl.calls = calls;
  return impl;
}
