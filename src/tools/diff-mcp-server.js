import { diff } from '@dj_abstract/mcp-audit';

/**
 * Diff two mcp-audit reports to detect rug-pulls and capability drift.
 * Accepts { baseline, current } as either file paths or parsed report objects.
 */
export async function diffMcpServer({ baseline, current }) {
  if (!baseline || !current) {
    throw new Error('diffMcpServer: requires {baseline, current}');
  }
  const result = await diff(baseline, current);
  return result;
}
