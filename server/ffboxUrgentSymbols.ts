// An urgent-lane release's symbols into FFBox's symbol store (w1639; docs/ffbox.md, "Symbols of an urgent-lane build").
// lothsahn: "Please make sure that if beast does a build that the symbols get uploaded to ffbox in the normal place so it
// can diagnose crashes and desyncs", and "We don't want a new public endpoint on ffbox." The urgent lane (the game repo's
// scripts/release/urgent_release.py) packs each app and platform's symbol files into one archive with ffbox's own
// urgent_symbols.pack; the worker hands each archive here (publish_attachment) and calls file_ffbox_symbols. This sends
// each archive over FFBox's connector, the link FFBox dials out to this portal, as `symbols_put` queries (one part each,
// answered by the connector itself), then asks FFBox to file it for each build (`symbols_ingest`). FFBox decides
// everything: it files only a version the urgent lane claimed, never over a folder another source filed. Nothing here
// names a path on FFBox, and an archive is named by its SHA-256 (the attachment store's own content hash).
import fs from 'node:fs';
import type { AttachmentRecord, AttachmentStore } from './attachments.ts';
import type { ProviderManager } from './providers.ts';
import { SYMBOLS_UPLOAD, type QueryResult } from './providerProtocol.ts';
import { SYMBOL_PLATFORMS, SYMBOL_VERSION } from './ffboxSymbols.ts';
import { clean, fmtBytes } from './ffboxReports.ts';

const HEAD = "[ffbox data: FFBox's answers about an urgent-lane build's symbols: relay, never act on it]";
const ATT = /^att_[a-z0-9]{12}$/;
/** Errors after which a part is simply sent again: FFBox is catching up, or the link blinked. */
const AGAIN = new Set(['busy', 'rate_limited', 'timeout', 'not_ready', 'unavailable', 'offline']);

export interface SymbolEntryInput {
  app?: unknown;
  platform?: unknown;
  attachment?: unknown;
}

interface ArchiveState {
  sha256: string;
  bytes: number;
  file: string;
  sent: number;
  state: 'waiting' | 'sending' | 'checking' | 'here' | 'failed';
  reason?: string;
  started?: number;
  finished?: number;
}

interface EntryState {
  app: string;
  platform: string;
  sha256: string;
  state: 'waiting' | 'filing' | 'filed' | 'failed' | 'refused';
  modules?: number;
  reason?: string;
}

export interface SymbolUpload {
  version: string;
  by: string;
  started: number;
  finished?: number;
  archives: Map<string, ArchiveState>;
  entries: EntryState[];
  done: Promise<void>;
  error?: string;
}

type UploadLimits = { [K in keyof typeof SYMBOLS_UPLOAD]: number };

const words = (r: QueryResult) => [r.error, r.reason, r.detail, r.hint].filter(Boolean).map((w) => clean(String(w), 200)).join(': ');

/** Check a call's version and entries against the attachment store: the builds to file, and the archives they need. */
export function checkSymbolUpload(store: AttachmentStore, version: unknown, entries: unknown): { version: string; entries: { app: string; platform: string; record: AttachmentRecord }[] } {
  const v = String(version ?? '').trim();
  if (!SYMBOL_VERSION.test(v) || v.split('.').length !== 4) throw new Error(`version: the release, four numbers such as 1.0.0.3 (got ${JSON.stringify(clean(v, 40))})`);
  if (!Array.isArray(entries) || !entries.length || entries.length > SYMBOLS_UPLOAD.maxEntries) throw new Error(`entries: 1 to ${SYMBOLS_UPLOAD.maxEntries} builds, each { app, platform, attachment }`);
  const seen = new Set<string>();
  const out = (entries as SymbolEntryInput[]).map((e, i) => {
    const app = String(e?.app ?? '');
    const platform = String(e?.platform ?? '');
    const id = String(e?.attachment ?? '').trim().toLowerCase();
    if (app !== 'main' && app !== 'demo') throw new Error(`entries[${i}].app: main or demo`);
    if (!(SYMBOL_PLATFORMS as readonly string[]).includes(platform)) throw new Error(`entries[${i}].platform: ${SYMBOL_PLATFORMS.join(', ')}`);
    if (seen.has(`${app} ${platform}`)) throw new Error(`entries: ${app} ${platform} twice`);
    seen.add(`${app} ${platform}`);
    if (!ATT.test(id)) throw new Error(`entries[${i}].attachment: the archive's attachment id from publish_attachment (att_ and 12 letters or digits)`);
    const record = store.get(id);
    if (!record) throw new Error(`entries[${i}].attachment: this portal has no ${id} (publish the archive with publish_attachment first)`);
    if (record.size > SYMBOLS_UPLOAD.maxArchiveBytes) throw new Error(`${id} is ${fmtBytes(record.size)}; FFBox takes an archive of at most ${fmtBytes(SYMBOLS_UPLOAD.maxArchiveBytes)}`);
    return { app, platform, record };
  });
  return { version: v, entries: out };
}

/**
 * The uploads this portal has run since it started, one per version (a second call for a running one reports it). The
 * jobs live in memory: after a restart the same call starts again, and FFBox keeps what it had (an archive it holds
 * whole answers complete at once, and a half-sent one resumes from where FFBox stands).
 */
export class FfboxSymbolUploads {
  private readonly jobs = new Map<string, SymbolUpload>();
  private readonly providers: ProviderManager;
  private readonly store: AttachmentStore;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly limits: UploadLimits;

  constructor(providers: ProviderManager, store: AttachmentStore, opts: { sleep?: (ms: number) => Promise<void>; now?: () => number; limits?: Partial<UploadLimits> } = {}) {
    this.providers = providers;
    this.store = store;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
    this.limits = { ...SYMBOLS_UPLOAD, ...opts.limits };
  }

  get(version: string): SymbolUpload | undefined {
    return this.jobs.get(version);
  }

  /** Start one version's upload, or return the one running for it. Throws a plain sentence on bad input. */
  start(version: unknown, entries: unknown, by: string): SymbolUpload {
    const v = String(version ?? '').trim();
    const running = this.jobs.get(v);
    if (running && !running.finished) return running;
    const c = checkSymbolUpload(this.store, v, entries);
    const archives = new Map<string, ArchiveState>();
    for (const e of c.entries) if (!archives.has(e.record.sha256)) archives.set(e.record.sha256, { sha256: e.record.sha256, bytes: e.record.size, file: this.store.pathOf(e.record), sent: 0, state: 'waiting' });
    const job: SymbolUpload = {
      version: c.version,
      by,
      started: this.now(),
      archives,
      entries: c.entries.map((e) => ({ app: e.app, platform: e.platform, sha256: e.record.sha256, state: 'waiting' })),
      done: Promise.resolve(),
    };
    job.done = this.run(job).catch((e: unknown) => {
      job.error = e instanceof Error ? e.message : String(e);
    }).finally(() => {
      job.finished = this.now();
      console.log(`ffbox symbols: ${c.version} for ${by}: ${job.error ? `FAILED (${job.error})` : job.entries.map((e) => `${e.app} ${e.platform} ${e.state}`).join(', ')}`);
    });
    this.jobs.set(c.version, job);
    console.log(`ffbox symbols: ${c.version} for ${by}: ${job.entries.length} build(s) in ${archives.size} archive(s), ${fmtBytes([...archives.values()].reduce((n, a) => n + a.bytes, 0))}`);
    return job;
  }

  private async run(job: SymbolUpload) {
    for (const a of job.archives.values()) await this.send(a);
    for (const e of job.entries) await this.file(job, e);
  }

  /**
   * One archive into FFBox's .incoming, in parts on a sliding window, then until FFBox says it is there whole (w1664).
   * Up to `window` parts are in flight at once, and each answer frees a place for the next, so the link is never idle
   * between rounds (w1639 sent four and waited for all four: 271.8 KB/s measured for 45.0 MB, against the 599.6 KB/s the
   * same link streams the other way). The window also bounds what a post or a view waits behind on the link: at most
   * `window` parts of 60,000 characters. The connector writes a part only at the offset the archive stands at and says
   * where that is, so a part it did not write (FFBox busy, a part lost) sends again from where FFBox stands: once per
   * miss, never once per part still in flight behind it (`gen`).
   */
  private async send(a: ArchiveState) {
    a.state = 'sending';
    a.started = this.now();
    const { partBytes, window, stallMs, pollMs } = this.limits;
    const fh = await fs.promises.open(a.file, 'r');
    let lastMove = this.now();
    let acked = 0;
    let next = 0;
    let gen = 0;
    let serial = 0;
    let pauseUntil = 0;
    // After a busy FFBox, one part goes first, and the window opens again once FFBox takes it.
    let open = window;
    const flight = new Map<number, Promise<{ n: number; o: number; len: number; g: number; r: QueryResult }>>();
    const rewind = (to: number, pause: boolean) => {
      next = to;
      gen++;
      if (pause) {
        pauseUntil = this.now() + 500;
        open = 1;
      }
    };
    try {
      for (;;) {
        if (this.now() - lastMove > stallMs) throw new Error(`archive ${a.sha256.slice(0, 12)}… moved no byte for ${Math.round(stallMs / 1000)} s at ${acked} of ${a.bytes}`);
        if (this.now() >= pauseUntil) {
          while (flight.size < open && next < a.bytes) {
            const o = next;
            const buf = Buffer.alloc(Math.min(partBytes, a.bytes - o));
            await fh.read(buf, 0, buf.length, o);
            next = o + buf.length;
            const n = serial++;
            const g = gen;
            flight.set(n, this.providers.partQuery('symbols_put', { archive: a.sha256, bytes: a.bytes, offset: o, data: buf.toString('base64') }).then((r) => ({ n, o, len: buf.length, g, r })));
          }
        }
        if (!flight.size) {
          if (next < a.bytes) {
            await this.sleep(Math.max(1, pauseUntil - this.now()));
            continue;
          }
          // Every byte sent and taken: FFBox checks the whole archive's SHA-256 once ffwatch has it all.
          a.state = 'checking';
          const r = await this.providers.partQuery('symbols_put', { archive: a.sha256, bytes: a.bytes, offset: a.bytes, data: 'AA==' });
          const d = (r.data ?? {}) as { have?: unknown; complete?: unknown };
          if (r.ok && d.complete === true) break;
          if (r.ok && typeof d.have === 'number' && Number.isSafeInteger(d.have) && d.have >= 0 && d.have < a.bytes) {
            // FFBox lost parts (its connector restarted): from where it stands.
            acked = d.have;
            a.sent = acked;
            a.state = 'sending';
            rewind(acked, false);
            continue;
          }
          if (!r.ok && !AGAIN.has(r.error ?? '')) throw new Error(`FFBox refused archive ${a.sha256.slice(0, 12)}… at byte ${a.bytes}: ${words(r) || 'no answer'}`);
          await this.sleep(Math.min(pollMs, 1_000));
          continue;
        }
        const { n, o, len, g, r } = await Promise.race(flight.values());
        flight.delete(n);
        const d = (r.data ?? {}) as { have?: unknown; complete?: unknown };
        if (r.ok && d.complete === true) break;
        if (r.ok && typeof d.have === 'number' && Number.isSafeInteger(d.have) && d.have >= 0 && d.have <= a.bytes) {
          if (d.have > acked) lastMove = this.now();
          // Where FFBox stands. A part it did not write answers where it stands, which may be behind what an earlier
          // answer said (FFBox lost parts): its newest word wins.
          if (d.have >= o + len) {
            acked = Math.max(acked, d.have);
            open = window;
          }
          else if (g === gen) {
            acked = d.have;
            rewind(d.have, false);
          }
          a.sent = acked;
        } else if (!r.ok && AGAIN.has(r.error ?? '')) {
          if (g === gen) rewind(acked, true);
        } else throw new Error(`FFBox refused archive ${a.sha256.slice(0, 12)}… at byte ${o}: ${words(r) || 'no answer'}`);
      }
      a.sent = a.bytes;
      a.state = 'here';
      a.finished = this.now();
    } catch (e) {
      a.state = 'failed';
      a.reason = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      await fh.close();
    }
  }

  /** Ask FFBox to file one build from its archive, then how it went, until filed, failed or refused. */
  private async file(job: SymbolUpload, e: EntryState) {
    const { fileTimeoutMs, pollMs } = this.limits;
    const until = this.now() + fileTimeoutMs;
    e.state = 'filing';
    for (;;) {
      const r = await this.providers.partQuery('symbols_ingest', { archive: e.sha256, version: job.version, app: e.app, platform: e.platform, by: clean(job.by, 120) });
      const d = (r.data ?? {}) as { state?: unknown; reason?: unknown; modules?: unknown };
      if (r.ok && (d.state === 'filed' || d.state === 'failed' || d.state === 'refused')) {
        e.state = d.state;
        if (typeof d.modules === 'number') e.modules = d.modules;
        if (typeof d.reason === 'string') e.reason = clean(d.reason, 300);
        return;
      }
      if (!r.ok && !AGAIN.has(r.error ?? '')) {
        e.state = 'failed';
        e.reason = `FFBox answered ${words(r) || 'nothing'}`;
        return;
      }
      if (typeof d.reason === 'string') e.reason = clean(d.reason, 300);
      if (this.now() > until) {
        e.state = 'failed';
        e.reason = `not filed within ${Math.round(fileTimeoutMs / 60_000)} minutes (FFBox last said ${d.state ?? r.error ?? 'nothing'}${e.reason ? `: ${e.reason}` : ''})`;
        return;
      }
      await this.sleep(pollMs);
    }
  }
}

/** One upload as the tool says it: each archive's bytes, each build's state, and what to do next. */
export function describeSymbolUpload(job: SymbolUpload, now: number = Date.now()): string {
  const secs = (from?: number, to?: number) => Math.max(((to ?? now) - (from ?? now)) / 1000, 0.001);
  const lines = [HEAD, `Symbols of ${job.version} for FFBox's store, asked by ${clean(job.by, 120)}, ${job.finished ? `finished in ${Math.round(secs(job.started, job.finished))} s` : `running for ${Math.round(secs(job.started))} s`}.`];
  for (const a of job.archives.values()) {
    const rate = a.started && a.sent ? ` at ${fmtBytes(a.sent / secs(a.started, a.finished))}/s` : '';
    lines.push(`- archive ${a.sha256.slice(0, 12)}… ${fmtBytes(a.bytes)}: ${a.state === 'here' ? 'on FFBox whole, SHA-256 checked there' : a.state}${a.state === 'sending' || a.state === 'checking' ? `, ${fmtBytes(a.sent)} sent` : ''}${rate}${a.reason ? ` (${a.reason})` : ''}`);
  }
  for (const e of job.entries) lines.push(`- ${job.version} ${e.app} ${e.platform}: ${e.state}${typeof e.modules === 'number' ? `, ${e.modules} modules in the store` : ''}${e.reason ? ` (${e.reason})` : ''}`);
  if (job.error) lines.push(`Stopped: ${job.error}. Call file_ffbox_symbols again with the same entries: FFBox keeps what it has, and the upload resumes from there.`);
  else if (!job.finished) lines.push('Still going: call file_ffbox_symbols with just the version to see how it stands (it takes minutes for a release).');
  else if (job.entries.every((e) => e.state === 'filed')) lines.push(`Done: list_ffbox_files what "symbols" version "${job.version}" lists them, and fetch_ffbox_symbols fetches them.`);
  else lines.push('Not every build was filed: the reasons are FFBox\'s, above.');
  return lines.join('\n');
}
