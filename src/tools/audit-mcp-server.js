import { audit } from '@dj_abstract/mcp-audit';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Run a static security audit against an MCP server.
 * Accepts one of:
 *   { manifest: path }          — path to a manifest JSON on disk
 *   { manifestData: object }    — inline manifest JSON (preferred for remote callers)
 *   { stdio: cmd }              — spawn a local MCP server
 *   { url, bearer?, headers? }  — remote HTTP/SSE MCP server
 * Returns the full mcp-audit report.
 */
export async function auditMcpServer(spec) {
  if (!spec || (typeof spec !== 'object')) {
    throw new Error('auditMcpServer: spec must be an object');
  }
  const { manifest, manifestData, stdio, url, bearer, headers } = spec;
  const provided = [manifest, manifestData, stdio, url].filter(Boolean);
  if (provided.length !== 1) {
    throw new Error('auditMcpServer: provide exactly one of {manifest, manifestData, stdio, url}');
  }

  // Inline manifest: stage to a tempfile so mcp-audit's loadManifest() can read it.
  if (manifestData) {
    const dir = await mkdtemp(join(tmpdir(), 'ai-sec-audit-'));
    const path = join(dir, 'manifest.json');
    try {
      await writeFile(path, JSON.stringify(manifestData));
      return await audit({ manifest: path });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const connectSpec = manifest
    ? { manifest }
    : stdio
      ? { stdio }
      : { url, bearer, headers };

  return await audit(connectSpec);
}
