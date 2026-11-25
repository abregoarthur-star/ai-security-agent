/**
 * What a caller may make this server do, decided in one place.
 *
 *   stdio    — spawning a process: off unless ALLOW_STDIO_AUDIT=1, and then
 *              only for command lines listed in STDIO_ALLOWLIST.
 *   paths    — server-side files: only inside MANIFEST_ROOT.
 *   inline   — manifestData: size-limited.
 *   limits   — run_self_test rounds and spend per run: capped by the server
 *              (the daily cap across runs is lib/spend.js).
 *
 * Every function takes `env` so tests can state a configuration without
 * touching process.env.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolveManifestRoot } from './data-dir.js';
import { ToolError, badRequest, forbidden, tooLarge } from './errors.js';

// ── numbers from env ─────────────────────────────────────────────────────────

function positiveNumber(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Fixed limits. Not configurable: nothing has needed them to be.
export const MAX_MANIFEST_BYTES = 1_000_000;   // one inline manifest or report
export const MAX_TARGETS = 50;                 // manifests per sweep or inventory call

// Models a caller may name as generator or judge when SELF_TEST_MODEL_ALLOWLIST
// is unset: the current Sonnet and Haiku, and the Groq models prompt-genesis prices.
const SELF_TEST_DEFAULT_MODELS = [
  'claude-sonnet-5-5', 'claude-haiku-5-5',
  'llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'meta-llama/llama-4-scout-17b-16e-instruct',
];

function envList(raw, fallback) {
  const list = String(raw || '').split(',').map((m) => m.trim()).filter(Boolean);
  return list.length ? list : fallback;
}

/** The limits an operator sets. A missing or bad value falls back to the default. */
export function limits(env = process.env) {
  return {
    selfTestMaxRounds: Math.floor(positiveNumber(env.SELF_TEST_MAX_ROUNDS, 30)),
    selfTestMaxCostUsdPerGen: positiveNumber(env.SELF_TEST_MAX_COST_USD_PER_GEN, 1.5),
    selfTestDailyCapUsd: positiveNumber(env.SELF_TEST_DAILY_CAP_USD, 3),
    selfTestModels: envList(env.SELF_TEST_MODEL_ALLOWLIST, SELF_TEST_DEFAULT_MODELS),
  };
}

// ── stdio ────────────────────────────────────────────────────────────────────

const squash = (s) => String(s).trim().split(/\s+/).join(' ');

/**
 * STDIO_ALLOWLIST is a comma-separated list of complete command lines.
 * A request is allowed only when its whole command line equals one of them
 * (runs of whitespace aside). Matching the command name alone would be no
 * restriction at all: `node` or `npx` with free arguments runs anything.
 */
export function stdioAllowlist(env = process.env) {
  return String(env.STDIO_ALLOWLIST || '').split(',').map(squash).filter(Boolean);
}

/** Returns the command line to spawn, or throws 403. */
export function assertStdioAllowed(stdio, env = process.env) {
  if (env.ALLOW_STDIO_AUDIT !== '1') {
    throw forbidden('stdio audits are disabled on this server (they run a command on it). Send the manifest inline as manifestData instead.', 'stdio_disabled');
  }
  let line;
  if (typeof stdio === 'string') {
    line = squash(stdio);
  } else if (stdio && typeof stdio === 'object' && typeof stdio.command === 'string') {
    if (stdio.env && Object.keys(stdio.env).length) {
      throw forbidden('stdio audits may not set environment variables', 'stdio_not_allowed');
    }
    const args = Array.isArray(stdio.args) ? stdio.args : [];
    if (!args.every((a) => typeof a === 'string' && !/\s/.test(a))) {
      throw forbidden('stdio arguments must be strings without whitespace', 'stdio_not_allowed');
    }
    line = squash([stdio.command, ...args].join(' '));
  } else {
    throw badRequest('stdio must be a command string');
  }
  if (!line || /["'\\]/.test(line)) {
    // Quoting would let two different argument lists share one spelling.
    throw forbidden('stdio command is not on the allowlist', 'stdio_not_allowed');
  }
  if (!stdioAllowlist(env).includes(line)) {
    throw forbidden('stdio command is not on the allowlist', 'stdio_not_allowed');
  }
  return line;
}

// ── server-side paths ────────────────────────────────────────────────────────

const within = (root, target) => target === root || target.startsWith(root + path.sep);

/**
 * Resolve a caller-named path to a real path inside MANIFEST_ROOT, or throw.
 * Relative paths are taken from the root. Anything that points outside it —
 * by `..`, by an absolute path, or through a symlink — is refused with the
 * same message whether or not the target exists.
 */
export async function resolveInsideRoot(input, env = process.env) {
  if (typeof input !== 'string' || !input || input.includes('\0')) {
    throw badRequest('path must be a non-empty string');
  }
  const root = resolveManifestRoot(env);
  const outside = () => forbidden('path is outside the allowed manifest directory', 'path_not_allowed');
  const lexical = path.resolve(root, input);
  if (!within(root, lexical)) throw outside();

  let realRoot;
  try {
    realRoot = await fsp.realpath(root);
  } catch {
    throw new ToolError(404, 'the manifest directory does not exist on this server', 'path_not_found');
  }
  let real;
  try {
    real = await fsp.realpath(lexical);
  } catch {
    throw new ToolError(404, 'no such file in the manifest directory', 'path_not_found');
  }
  if (!within(realRoot, real)) throw outside();
  return real;
}

/**
 * Every *.json file under a caller-named path (a file, or a directory walked
 * to `depth`), each one checked to be really inside the root. Entries that
 * escape through a symlink are left out rather than followed.
 */
export async function jsonFilesInsideRoot(input, env = process.env, { depth = 4, max = 500 } = {}) {
  const start = await resolveInsideRoot(input, env);
  const realRoot = await fsp.realpath(resolveManifestRoot(env));
  const out = [];

  async function walk(real, level) {
    const st = await fsp.stat(real);
    if (st.isFile()) {
      if (out.length >= max) throw tooLarge(`more than ${max} files`);
      out.push(real);
      return;
    }
    if (!st.isDirectory() || level > depth) return;
    for (const entry of (await fsp.readdir(real)).sort()) {
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      let child;
      try {
        child = await fsp.realpath(path.join(real, entry));
      } catch {
        continue; // dangling link
      }
      if (!within(realRoot, child)) continue;
      const cst = await fsp.stat(child);
      if (cst.isDirectory()) await walk(child, level + 1);
      else if (cst.isFile() && path.extname(child) === '.json') await walk(child, level + 1);
    }
  }

  await walk(start, 0);
  return out;
}

// ── inline data ──────────────────────────────────────────────────────────────

/** Serialise inline JSON once, refusing anything over the limit. Returns the JSON text. */
export function serializeInline(data, label = 'manifestData') {
  if (!data || typeof data !== 'object') throw badRequest(`${label} must be an object`);
  const text = JSON.stringify(data);
  if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) {
    throw tooLarge(`${label} is larger than ${MAX_MANIFEST_BYTES} bytes`);
  }
  return text;
}

// ── run_self_test ────────────────────────────────────────────────────────────

/**
 * Refuse a generator or judge model a caller named that is not on the list
 * ("groq:<id>" is matched on <id>). A request that names no model gets the
 * server's own default and is not checked: the caller did not choose it.
 */
export function assertModelAllowed(model, role, env = process.env) {
  if (model === undefined || model === null || model === '') return;
  const list = limits(env).selfTestModels;
  const id = typeof model === 'string' && model.includes(':') ? model.split(':').slice(1).join(':') : model;
  if (typeof model !== 'string' || !list.includes(id)) {
    throw badRequest(`${role} "${String(model).slice(0, 80)}" is not on this server's model allowlist (${list.join(', ')})`, 'model_not_allowed');
  }
}

// What a request gets when it names no value (unchanged from before the caps existed).
const SELF_TEST_DEFAULT_ROUNDS = 30;
const SELF_TEST_DEFAULT_COST_USD_PER_GEN = 1.5;

/** A caller may lower rounds and the spend cap, never raise them past the server's maxima. */
export function clampSelfTest({ rounds, maxCostUsdPerGen } = {}, env = process.env) {
  const { selfTestMaxRounds, selfTestMaxCostUsdPerGen } = limits(env);
  const askedRounds = Number(rounds);
  const askedCost = Number(maxCostUsdPerGen);
  return {
    rounds: Math.min(
      Number.isFinite(askedRounds) && askedRounds >= 1 ? Math.floor(askedRounds) : SELF_TEST_DEFAULT_ROUNDS,
      selfTestMaxRounds,
    ),
    maxCostUsdPerGen: Math.min(
      Number.isFinite(askedCost) && askedCost > 0 ? askedCost : SELF_TEST_DEFAULT_COST_USD_PER_GEN,
      selfTestMaxCostUsdPerGen,
    ),
  };
}
