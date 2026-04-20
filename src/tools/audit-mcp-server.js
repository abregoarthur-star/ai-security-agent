import { audit } from '@dj_abstract/mcp-audit';

/**
 * Run a static security audit against an MCP server.
 * Accepts one of: { manifest: path }, { stdio: cmd }, or { url, bearer?, headers? }.
 * Returns the full mcp-audit report (findings + server snapshot + counts).
 */
export async function auditMcpServer(spec) {
  if (!spec || (typeof spec !== 'object')) {
    throw new Error('auditMcpServer: spec must be an object with one of {manifest, stdio, url}');
  }
  const { manifest, stdio, url, bearer, headers } = spec;
  const provided = [manifest, stdio, url].filter(Boolean);
  if (provided.length !== 1) {
    throw new Error('auditMcpServer: provide exactly one of {manifest, stdio, url}');
  }

  const connectSpec = manifest
    ? { manifest }
    : stdio
      ? { stdio }
      : { url, bearer, headers };

  const report = await audit(connectSpec);
  return report;
}
