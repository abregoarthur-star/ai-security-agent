import { audit } from '@dj_abstract/mcp-audit';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { badRequest } from '../lib/errors.js';
import { assertStdioAllowed, resolveInsideRoot, serializeInline } from '../lib/policy.js';
import { defaultUrlGuard } from '../lib/url-guard.js';

/**
 * Run a static security audit against an MCP server.
 * Accepts exactly one of:
 *   { manifestData: object }    — inline manifest JSON (the normal mode; size-limited)
 *   { manifest: path }          — a manifest file inside MANIFEST_ROOT on this server
 *   { url, bearer?, headers? }  — a remote HTTP/SSE MCP server at a public address
 *   { stdio: cmd }              — spawn a local MCP server; off unless ALLOW_STDIO_AUDIT=1
 *                                 and the command line is in STDIO_ALLOWLIST
 * Returns the full mcp-audit report.
 *
 * `ctx` is for tests and for callers inside this process: { env, guard, audit }.
 */
export async function auditMcpServer(spec, ctx = {}) {
  const env = ctx.env || process.env;
  const runAudit = ctx.audit || audit;
  if (!spec || (typeof spec !== 'object')) {
    throw badRequest('auditMcpServer: spec must be an object');
  }
  const { manifest, manifestData, stdio, url, bearer, headers } = spec;
  const provided = [manifest, manifestData, stdio, url].filter(Boolean);
  if (provided.length !== 1) {
    throw badRequest('auditMcpServer: provide exactly one of {manifest, manifestData, stdio, url}');
  }

  // Inline manifest: stage to a tempfile so mcp-audit's loadManifest() can read it.
  if (manifestData) {
    const text = serializeInline(manifestData);
    const dir = await mkdtemp(join(tmpdir(), 'ai-sec-audit-'));
    const path = join(dir, 'manifest.json');
    try {
      await writeFile(path, text);
      return await runAudit({ manifest: path });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  if (manifest) {
    return await runAudit({ manifest: await resolveInsideRoot(manifest, env) });
  }

  if (stdio) {
    return await runAudit({ stdio: assertStdioAllowed(stdio, env) });
  }

  if (typeof url !== 'string') throw badRequest('auditMcpServer: url must be a string');
  if (bearer !== undefined && typeof bearer !== 'string') throw badRequest('auditMcpServer: bearer must be a string');
  if (headers !== undefined && !isStringMap(headers)) throw badRequest('auditMcpServer: headers must be an object of strings');
  const guard = ctx.guard || defaultUrlGuard();
  const checked = await guard.assertPublicUrl(url);
  return await guard.run(() => runAudit({ url: checked.href, bearer, headers }));
}

function isStringMap(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every((v) => typeof v === 'string');
}
