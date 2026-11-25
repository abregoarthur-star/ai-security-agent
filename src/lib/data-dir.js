import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where persistent files live. Unchanged rule: DATA_DIR env, else /data if
 * it exists (a Railway volume mounted there), else the OS temp dir.
 */
export function resolveDataDir(env = process.env) {
  return env.DATA_DIR || (fs.existsSync('/data') ? '/data' : os.tmpdir());
}

/** The only directory callers may name server-side files in. */
export function resolveManifestRoot(env = process.env) {
  return path.resolve(env.MANIFEST_ROOT || path.join(resolveDataDir(env), 'manifests'));
}
