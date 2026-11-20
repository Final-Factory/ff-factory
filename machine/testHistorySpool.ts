// The local side of the per-test history (w4922, docs/test-history.md): the game repo's editor recorder
// (Assets/Editor/TestHistoryRecorder.cs) writes one JSON file per test run to <sandbox>/Library/FFTestHistory/. This sends
// each file to the portal as a `test_history` message and deletes it once the portal answers that it kept it
// (`test_history_ack` ok), so a worker's every local run reaches the database with no step of its own. A file the portal
// refused (unreadable) is deleted too; one never answered (an older portal, a dropped link) is sent again after RESEND_MS.
import fs from 'node:fs';
import path from 'node:path';

export const SPOOL_DIR = path.join('Library', 'FFTestHistory');
/** Files sent per look: a sandbox's backlog drains over a few looks and never fills the link at once. */
const PER_LOOK = 4;
const RESEND_MS = 30 * 60_000;
/** The portal takes 16 MB a message; a file past this is a broken one (the whole suite is about 3 MB). */
export const MAX_RECORD_BYTES = 12 * 1024 * 1024;
const NAME = /^[0-9TZ]{18,20}-[0-9a-f]{8}\.json$/;

export interface SpoolPlace {
  id: string;
  path: string;
}

export interface SpoolSend {
  (msg: { type: 'test_history'; sandbox: string; file: string; record: string }): boolean;
}

export class TestHistorySpool {
  private readonly sent = new Map<string, number>();
  private readonly places: () => SpoolPlace[];
  private readonly send: SpoolSend;
  private readonly log: (line: string) => void;
  private readonly now: () => number;

  constructor(o: { places: () => SpoolPlace[]; send: SpoolSend; log?: (line: string) => void; now?: () => number }) {
    this.places = o.places;
    this.send = o.send;
    this.log = o.log ?? (() => {});
    this.now = o.now ?? Date.now;
  }

  private key(sandbox: string, file: string) {
    return `${sandbox}/${file}`;
  }

  /** Send the oldest unsent files of every sandbox, a few in all. Answers how many it sent. */
  tick(): number {
    let budget = PER_LOOK;
    const now = this.now();
    for (const p of this.places()) {
      if (budget <= 0) break;
      const dir = path.join(p.path, SPOOL_DIR);
      let names: string[];
      try {
        names = fs.readdirSync(dir).filter((n) => NAME.test(n)).sort();
      } catch {
        continue;
      }
      for (const file of names) {
        if (budget <= 0) break;
        const k = this.key(p.id, file);
        const at = this.sent.get(k);
        if (at !== undefined && now - at < RESEND_MS) continue;
        const full = path.join(dir, file);
        try {
          const size = fs.statSync(full).size;
          if (size > MAX_RECORD_BYTES) {
            this.log(`test history: ${p.id}/${file} is ${size} bytes, past ${MAX_RECORD_BYTES}: deleted unsent`);
            fs.rmSync(full, { force: true });
            continue;
          }
          const record = fs.readFileSync(full, 'utf8');
          if (!this.send({ type: 'test_history', sandbox: p.id, file, record })) return PER_LOOK - budget;
          this.sent.set(k, now);
          budget--;
        } catch (e) {
          this.log(`test history: ${p.id}/${file}: ${(e as Error).message}`);
        }
      }
    }
    if (this.sent.size > 2000) for (const [k, at] of this.sent) if (now - at > RESEND_MS) this.sent.delete(k);
    return PER_LOOK - budget;
  }

  /** The portal's answer: kept (or refused for good), so the file goes. */
  ack(sandbox: string, file: string, ok: boolean, error?: string) {
    if (!NAME.test(file)) return;
    const p = this.places().find((x) => x.id === sandbox);
    this.sent.delete(this.key(sandbox, file));
    if (!ok) this.log(`test history: the portal refused ${sandbox}/${file}: ${error ?? '?'}`);
    if (!p) return;
    try {
      fs.rmSync(path.join(p.path, SPOOL_DIR, file), { force: true });
    } catch (e) {
      this.log(`test history: could not delete ${sandbox}/${file}: ${(e as Error).message}`);
    }
  }
}
