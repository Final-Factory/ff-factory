// The local side of the per-test history (w4922, docs/test-history.md): the game repo's editor recorder
// (Assets/Editor/TestHistoryRecorder.cs) writes one JSON file per test run to the machine's spool, <root>/test-history/
// (FF_WORKER_ROOT, which every editor and worker shell FF Factory starts has), or, without that variable, to the project's
// own Library/FFTestHistory/. This sends each file to the portal as a `test_history` message and deletes it once the portal
// answers that it kept it (`test_history_ack` ok), so every local run reaches the database with no step of anyone's. A
// file the portal refused (unreadable) is deleted too; one never answered (an older portal, a dropped link) is sent again
// after RESEND_MS.
//
// A run writes <name>.running.json when it starts and replaces it with <name>.json when it ends. A running file whose
// recorder stopped writing STALE_MS ago (the editor crashed, was killed, or a batch run died) is sent as it is, and the
// portal records the run as incomplete with the results it had. A running file is also announced once at first sight
// (`test_history_started`), so the portal tags the run with the workers in its sandbox as it starts: its record may come
// after they have left.
import fs from 'node:fs';
import path from 'node:path';

export const SPOOL_DIR = path.join('Library', 'FFTestHistory');
/** The machine-wide spool under the worker root: a run in any project (a temp worktree too) lands here. */
export const ROOT_SPOOL_DIR = 'test-history';
/** Files sent per look: a backlog drains over a few looks and never fills the link at once. */
const PER_LOOK = 4;
const RESEND_MS = 30 * 60_000;
/** A running file untouched this long is a run that died: the recorder rewrites it at least once a minute while tests finish. */
export const STALE_MS = 2 * 60 * 60_000;
/** The portal takes 16 MB a message; a file past this is a broken one (the whole suite is about 3 MB). */
export const MAX_RECORD_BYTES = 12 * 1024 * 1024;
const NAME = /^[0-9TZ]{18,20}-[0-9a-f]{8}(\.running)?\.json$/;

export interface SpoolPlace {
  id: string;
  path: string;
}

export interface SpoolSend {
  (msg: { type: 'test_history'; sandbox: string; file: string; record: string } | { type: 'test_history_started'; sandbox: string; file: string }): boolean;
}

/** Path for comparing: forward slashes, no trailing slash, lower case on Windows. */
const norm = (p: string) => {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
};

/** The sandbox whose folder holds the project a record names, or '' (a temp worktree, another project). */
export function sandboxOfProject(project: string | undefined, places: readonly SpoolPlace[]): string {
  if (!project) return '';
  const p = norm(project);
  for (const pl of places) {
    const root = norm(pl.path);
    if (p === root || p.startsWith(`${root}/`)) return pl.id;
  }
  return '';
}

export class TestHistorySpool {
  /** Sent and not yet answered: "<sandbox>/<file>" → when, and the file's full path. */
  private readonly sent = new Map<string, { at: number; full: string }>();
  /** Running files announced to the portal, by full path. */
  private readonly announced = new Set<string>();
  private readonly places: () => SpoolPlace[];
  private readonly root: string | undefined;
  private readonly send: SpoolSend;
  private readonly log: (line: string) => void;
  private readonly now: () => number;

  constructor(o: { places: () => SpoolPlace[]; root?: string; send: SpoolSend; log?: (line: string) => void; now?: () => number }) {
    this.places = o.places;
    this.root = o.root;
    this.send = o.send;
    this.log = o.log ?? (() => {});
    this.now = o.now ?? Date.now;
  }

  private key(sandbox: string, file: string) {
    return `${sandbox}/${file}`;
  }

  /** The folders to look in: the machine's spool first, then each sandbox's Library spool. */
  private dirs(places: readonly SpoolPlace[]): { dir: string; sandbox?: string }[] {
    return [...(this.root ? [{ dir: path.join(this.root, ROOT_SPOOL_DIR) }] : []), ...places.map((p) => ({ dir: path.join(p.path, SPOOL_DIR), sandbox: p.id }))];
  }

  /** Send the oldest unsent files, a few in all. Answers how many it sent. */
  tick(): number {
    let budget = PER_LOOK;
    const now = this.now();
    const places = this.places();
    for (const d of this.dirs(places)) {
      if (budget <= 0) break;
      let names: string[];
      try {
        names = fs.readdirSync(d.dir).filter((n) => NAME.test(n)).sort();
      } catch {
        continue;
      }
      for (const file of names) {
        if (budget <= 0) break;
        const full = path.join(d.dir, file);
        try {
          const st = fs.statSync(full);
          if (file.endsWith('.running.json') && now - st.mtimeMs < STALE_MS) {
            if (!this.announced.has(full) && this.send({ type: 'test_history_started', sandbox: d.sandbox ?? this.sandboxOf(full, places), file })) this.announced.add(full);
            continue;
          }
          if (st.size > MAX_RECORD_BYTES) {
            this.log(`test history: ${full} is ${st.size} bytes, past ${MAX_RECORD_BYTES}: deleted unsent`);
            fs.rmSync(full, { force: true });
            continue;
          }
          const record = fs.readFileSync(full, 'utf8');
          let sandbox = d.sandbox;
          if (sandbox === undefined) {
            let project: string | undefined;
            try {
              project = (JSON.parse(record) as { project?: unknown }).project as string | undefined;
            } catch {
              // the portal refuses it, and the file goes
            }
            sandbox = sandboxOfProject(typeof project === 'string' ? project : undefined, places);
          }
          const k = this.key(sandbox, file);
          const had = this.sent.get(k);
          if (had && now - had.at < RESEND_MS) continue;
          if (!this.send({ type: 'test_history', sandbox, file, record })) return PER_LOOK - budget;
          this.sent.set(k, { at: now, full });
          budget--;
        } catch (e) {
          this.log(`test history: ${full}: ${(e as Error).message}`);
        }
      }
    }
    if (this.announced.size > 2000) this.announced.clear();
    if (this.sent.size > 2000) for (const [k, s] of this.sent) if (now - s.at > RESEND_MS) this.sent.delete(k);
    return PER_LOOK - budget;
  }

  /** The sandbox a machine-spool file's project is in, from its record ('' when unreadable). */
  private sandboxOf(full: string, places: readonly SpoolPlace[]): string {
    try {
      const project = (JSON.parse(fs.readFileSync(full, 'utf8')) as { project?: unknown }).project;
      return sandboxOfProject(typeof project === 'string' ? project : undefined, places);
    } catch {
      return '';
    }
  }

  /** The portal's answer: kept (or refused for good), so the file goes. */
  ack(sandbox: string, file: string, ok: boolean, error?: string) {
    if (!NAME.test(file)) return;
    const k = this.key(sandbox, file);
    const s = this.sent.get(k);
    this.sent.delete(k);
    if (!ok) this.log(`test history: the portal refused ${sandbox}/${file}: ${error ?? '?'}`);
    // An answer to a file this daemon did not send since it started: it can only be in the sandbox's Library spool or the
    // machine's spool.
    const full =
      s?.full ??
      [this.places().find((x) => x.id === sandbox), undefined]
        .map((p) => (p ? path.join(p.path, SPOOL_DIR, file) : this.root ? path.join(this.root, ROOT_SPOOL_DIR, file) : undefined))
        .find((f) => f && fs.existsSync(f));
    if (!full) return;
    try {
      fs.rmSync(full, { force: true });
    } catch (e) {
      this.log(`test history: could not delete ${full}: ${(e as Error).message}`);
    }
  }
}
