import { inventory } from '@dj_abstract/agent-capability-inventory';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Run the capability-inventory classifier against one or more MCP server
 * manifests (or mcp-audit report JSONs — the lib accepts both shapes).
 *
 * Accepts one of:
 *   { manifestData: object }       — single inline manifest
 *   { manifestData: object[] }     — multiple inline manifests (fleet inventory)
 *   { manifest: path }             — filesystem path to a manifest file or dir
 *   { manifest: path[] }           — multiple filesystem paths
 *
 * Returns the full inventory report:
 *   {
 *     generatedAt,
 *     servers: [{ name, tools[], capabilities[], sensitivities[], source, ... }],
 *     fleet: { servers, tools, capabilities, sensitivities, risk }
 *   }
 *
 * Inline manifests are staged to a tempdir because the library is filesystem-
 * driven (no in-memory entry point). We clean up the tempdir after the run.
 */
export async function capabilityInventory(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('capabilityInventory: input must be an object');
  }
  const { manifestData, manifest } = input;

  const hasInline = manifestData !== undefined;
  const hasPath = manifest !== undefined;
  if (hasInline === hasPath) {
    throw new Error('capabilityInventory: provide exactly one of {manifestData, manifest}');
  }

  // Filesystem path(s): pass straight through to the library.
  if (hasPath) {
    if (!(typeof manifest === 'string' || Array.isArray(manifest))) {
      throw new Error('capabilityInventory: manifest must be a string path or array of string paths');
    }
    if (Array.isArray(manifest) && !manifest.every((p) => typeof p === 'string' && p.length > 0)) {
      throw new Error('capabilityInventory: manifest array must contain non-empty string paths');
    }
    return await inventory(manifest);
  }

  // Inline manifest(s): stage each JSON to a tempdir, run, then clean up.
  const manifests = Array.isArray(manifestData) ? manifestData : [manifestData];
  if (manifests.length === 0) {
    throw new Error('capabilityInventory: manifestData array must be non-empty');
  }
  if (!manifests.every((m) => m && typeof m === 'object' && !Array.isArray(m))) {
    throw new Error('capabilityInventory: each manifestData entry must be an object');
  }

  const dir = await mkdtemp(join(tmpdir(), 'ai-sec-inventory-'));
  try {
    const paths = [];
    for (let i = 0; i < manifests.length; i++) {
      const m = manifests[i];
      // Derive a stable-ish filename from manifest name if present, else index.
      const rawName = m?.server?.name || m?.name || `manifest-${i}`;
      const slug = String(rawName).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || `manifest-${i}`;
      const path = join(dir, `${slug}-${i}.json`);
      await writeFile(path, JSON.stringify(m));
      paths.push(path);
    }
    return await inventory(paths);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
