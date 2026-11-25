import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * One JSON file under the data dir. Everything this service keeps —
 * baselines with scan state, and the self-test spend ledger — goes through
 * this. Reading and writing are best-effort and never throw: the service
 * keeps running on what it has in memory when the disk is unavailable.
 */
export function jsonFile(file, log = console) {
  return {
    file,
    /** The parsed content, or null when the file is missing or unreadable. */
    read() {
      try {
        if (!fs.existsSync(file)) return null;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        log.error(`[ai-sec-agent] could not read ${file}: ${err.message} — starting empty`);
        return null;
      }
    },
    /** Atomic: temp file + rename, so a crash mid-write cannot corrupt the file. */
    async write(data) {
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      try {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(tmp, JSON.stringify(data), 'utf8');
        await fsp.rename(tmp, file);
        return true;
      } catch (err) {
        log.error(`[ai-sec-agent] could not write ${file}: ${err.message} — continuing`);
        try { await fsp.unlink(tmp); } catch { /* noop */ }
        return false;
      }
    },
  };
}
