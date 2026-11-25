import { diff } from '@dj_abstract/mcp-audit';
import { badRequest } from '../lib/errors.js';
import { resolveInsideRoot, serializeInline } from '../lib/policy.js';

/**
 * Diff two mcp-audit reports to detect rug-pulls and capability drift.
 * Accepts { baseline, current }, each either a parsed report object (the
 * normal mode) or the path of a report file inside MANIFEST_ROOT.
 */
export async function diffMcpServer(input, ctx = {}) {
  const env = ctx.env || process.env;
  const { baseline, current } = input || {};
  if (!baseline || !current) {
    throw badRequest('diffMcpServer: requires {baseline, current}');
  }
  const side = async (value, label) => {
    if (typeof value === 'string') return await resolveInsideRoot(value, env);
    if (ctx.trusted !== true) serializeInline(value, label);
    return value;
  };
  return await (ctx.diff || diff)(await side(baseline, 'baseline'), await side(current, 'current'));
}
