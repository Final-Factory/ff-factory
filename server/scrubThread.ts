// The start-up scrub's thread (w5613): it walks the data folder, reads, unzips, masks and zips each file and writes the
// masked copy beside it, so none of that holds the portal's event loop (a 10 s block over one big transcript after w5526's
// scrub version 3, measured on the portal 2026-11-25). The portal's own thread only swaps a masked copy in
// (server/scrubSecrets.ts commitScrubbed), in one turn, so nothing it appends to a file meanwhile is lost.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { parentPort, workerData } from 'node:worker_threads';
import { registerSecretValues } from './secrets.ts';
import { MAX_BYTES, emptyReport, redactFileText, scrubFiles, scrubTmp, type ScrubCommit, type ScrubReply } from './scrubSecrets.ts';

/** A file the portal rewrote while it was masked is read again, this many times, before it is named as not scrubbed. */
const TRIES = 3;

const port = parentPort!;
const { dataDir, values } = workerData as { dataDir: string; values: string[] };
// the vault's values, as the portal knows them now: the masks come out the same as on its own thread
registerSecretValues(values);

const reply = () => new Promise<ScrubReply>((resolve) => port.once('message', resolve));

/** The first `st.size` bytes of `file`, read through one descriptor, and its stat at that read. */
function readOnce(file: string): { raw: Buffer; st: fs.Stats } {
  const fd = fs.openSync(file, 'r');
  try {
    const st = fs.fstatSync(fd);
    const raw = Buffer.alloc(st.size);
    let at = 0;
    while (at < st.size) {
      const got = fs.readSync(fd, raw, at, st.size - at, at);
      if (!got) break;
      at += got;
    }
    return { raw: raw.subarray(0, at), st };
  } finally {
    fs.closeSync(fd);
  }
}

async function run() {
  const report = emptyReport();
  for (const file of scrubFiles([dataDir])) {
    const tmp = scrubTmp(file);
    try {
      if (fs.statSync(file).size > MAX_BYTES) {
        report.skipped.push(file);
        continue;
      }
      report.scanned++;
      let settled = false;
      for (let i = 0; i < TRIES && !settled; i++) {
        const gz = /\.gz$/i.test(file);
        const { raw, st } = readOnce(file);
        const { text, n } = redactFileText(path.basename(file), (gz ? zlib.gunzipSync(raw) : raw).toString('utf8'));
        if (!n) {
          settled = true;
          break;
        }
        fs.writeFileSync(tmp, gz ? zlib.gzipSync(text) : text, { mode: st.mode & 0o777 });
        if (process.getuid?.() === 0) fs.chownSync(tmp, st.uid, st.gid);
        const ask: ScrubCommit = { file, tmp, ino: st.ino, size: raw.length, mtimeMs: st.mtimeMs, n, gz };
        port.postMessage({ commit: ask });
        const r = await reply();
        if ('ok' in r) {
          report.files.push({ file, count: r.ok });
          report.total += r.ok;
          settled = true;
        } else if ('gone' in r) settled = true;
        else if ('error' in r) throw Object.assign(new Error('commit'), { code: r.error });
      }
      if (!settled) report.errors.push({ file, error: 'changed while it was scrubbed' });
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      // the message names the file and the system call, never its content
      report.errors.push({ file, error: (e as NodeJS.ErrnoException).code ?? (e as Error).name });
    }
  }
  port.postMessage({ done: report });
}

void run();
