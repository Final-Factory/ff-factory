import { redactInPlace, redactValue } from './secrets.ts';
import { SnapshotFile, dataRecoveries, isObject, readJsonDurable, writeFileDurable, type Check } from './durable.ts';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import zlib from 'node:zlib';
import type { AppSettings, DelegationRequest, Machine, Sandbox, ServerEvent, SessionInfo, StandingAgent, TranscriptEvent, WorkItem } from '../shared/types.ts';
import { meterStates, type MeterStates } from './meterStates.ts';

/** Everything the UI hears about goes through here and out the WebSocket. */
export const bus = new EventEmitter<{ event: [ServerEvent] }>();
bus.setMaxListeners(100);
/**
 * Every event leaves with its secrets redacted (w1584): a streamed delta, a notice, a session's result or a work item's
 * log never shows a vault token or a token shape on a page. Transcript events are redacted when they are recorded.
 */
export const emit = (e: ServerEvent) => bus.emit('event', e.type === 'transcript' || e.type === 'machine_stats' ? e : redactValue(e));

interface Persisted {
  /**
   * Sandboxes the portal held itself before w510. None is made any more: the list stays in the file (an older build
   * needs it to read the file, and records are kept, not deleted) and is named once at startup if it is not empty.
   */
  sandboxes: Sandbox[];
  sessions: SessionInfo[];
  /** The dispatcher (docs/orchestrators.md); before per-person orchestrators, the one shared orchestrator. */
  orchestratorId?: string;
  standingAgents?: StandingAgent[];
  delegations?: DelegationRequest[];
  machines?: Machine[];
  settings?: AppSettings;
}

/** Why a parsed state.json is not a sane one (server/durable.ts falls back to an earlier version then). */
export const checkState: Check = (v) => {
  if (!isObject(v)) return 'not a JSON object';
  for (const k of ['sandboxes', 'sessions'] as const) if (!Array.isArray(v[k])) return `no ${k} list`;
  for (const k of ['standingAgents', 'delegations', 'machines'] as const) if (v[k] !== undefined && !Array.isArray(v[k])) return `${k} is not a list`;
  for (const k of ['sandboxes', 'sessions', 'standingAgents', 'delegations', 'machines'] as const) {
    if (((v[k] as unknown[] | undefined) ?? []).some((x) => !isObject(x) || typeof x.id !== 'string')) return `an entry of ${k} has no id`;
  }
  return undefined;
};

export const checkWork: Check = (v) => {
  if (!isObject(v)) return 'not a JSON object';
  if (v.items !== undefined && (!Array.isArray(v.items) || v.items.some((x) => !isObject(x) || typeof x.id !== 'string'))) return 'items is not a list of work items';
  if (v.seq !== undefined && typeof v.seq !== 'number') return 'seq is not a number';
  return undefined;
};

/** state.json: a write starts at most 200 ms after a change and at most once a second (4.5 MB at 7,000 sessions). */
const STATE_SAVE = { delayMs: 200, intervalMs: 1000 };
const WORK_SAVE = { delayMs: 300, intervalMs: 1000 };
/** The first read from a transcript's end (Store.tailText); each further one doubles. */
const TAIL_CHUNK = 64 * 1024;
/** Lines lastSeq looks back over, so a torn last line (a crash) does not read as an empty transcript. */
const LAST_LINES = 4;

/** A transcript's events from its text: the last `limit` lines when given; a line that does not parse (torn by a crash) is skipped. */
/** What a `gh pr create` call printed, and when (Store.prCreateResults). */
export interface PrCreateResult {
  at: string;
  text: string;
  isError: boolean;
}
/** A compressed transcript's tail file keeps its last lines up to this size (w2026). */
const TAIL_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Beside a compressed transcript, its last lines (`<id>.jsonl.gz.tail`, w2026): a tail read of a compressed transcript (every daemon
 * connect asks each of its sessions' last seq; the blocker watch and the ledger sweep read the last lines of idle workers) unzipped
 * the whole file synchronously, seconds each for a big one on the portal VM. The first line names the size of the .gz it was made
 * from (a tail file of another one is ignored) and whether it holds the whole transcript.
 */
export function writeTailFile(gzPath: string, text: string | Buffer) {
  try {
    const size = fs.statSync(gzPath).size;
    const buf = typeof text === 'string' ? Buffer.from(text) : text;
    let from = Math.max(0, buf.length - TAIL_FILE_BYTES);
    if (from > 0) from = buf.indexOf(0x0a, from) + 1 || buf.length;
    fs.writeFileSync(`${gzPath}.tail`, `${JSON.stringify({ of: size, whole: from === 0 })}\n${buf.toString('utf8', from)}`);
  } catch {
    // a tail file is only a shortcut
  }
}

function readTailFile(gzPath: string, lines: number): { text: string; whole: boolean } | undefined {
  try {
    const text = fs.readFileSync(`${gzPath}.tail`, 'utf8');
    const nl = text.indexOf('\n');
    const head = JSON.parse(text.slice(0, nl)) as { of?: number; whole?: boolean };
    if (head.of !== fs.statSync(gzPath).size) return undefined;
    const body = text.slice(nl + 1);
    if (head.whole) return { text: body, whole: true };
    return completeLines(Buffer.from(`\n${body}`)) >= lines ? { text: body, whole: false } : undefined;
  } catch {
    return undefined;
  }
}

const RESULT_MARK = '"kind":"result"';
/** A background parse gives the loop a turn after this many bytes (about 20 ms of JSON.parse on the portal VM, a guess). */
const PARSE_SLICE_BYTES = 2 * 1024 * 1024;
const gunzipAsync = (b: Buffer, o: zlib.ZlibOptions) => new Promise<Buffer>((ok, no) => zlib.gunzip(b, o, (e, r) => (e ? no(e) : ok(r))));
/** A turn of the event loop: timers, sockets and /api/health run before the caller goes on. */
export const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

function parseLines(text: string, limit?: number): TranscriptEvent[] {
  const lines = text.split('\n').filter(Boolean);
  const out: TranscriptEvent[] = [];
  for (const line of limit ? lines.slice(-limit) : lines) {
    try {
      // A crash can leave zero bytes where the last lines were; the next line then starts after them.
      out.push(JSON.parse(line.replace(/^\0+/, '')));
    } catch {
      // a torn last line after a crash; skip it
    }
  }
  return out;
}

/** Non-empty lines in `buf` after its first newline: the lines a tail read holds whole. */
function completeLines(buf: Buffer): number {
  let n = 0;
  let i = buf.indexOf(0x0a);
  while (i >= 0) {
    const next = buf.indexOf(0x0a, i + 1);
    const end = next < 0 ? buf.length : next;
    if (end > i + 1) n++;
    i = next;
  }
  return n;
}

/**
 * The durable record: sandboxes and session metadata in one JSON file (rewritten whole), transcripts as one
 * append-only JSONL per session. No database, so no native modules to build on the Windows host. The JSON files are
 * crash-safe (server/durable.ts): fsynced before they replace the old file, the last versions kept beside them, and a
 * damaged one replaced by the newest good version at load.
 */
export class Store {
  /** Sandboxes the portal held itself before w510 (Persisted.sandboxes): kept as they were, never used. */
  readonly leftoverSandboxes: Sandbox[] = [];
  readonly sessions = new Map<string, SessionInfo>();
  readonly standing = new Map<string, StandingAgent>();
  readonly delegations = new Map<string, DelegationRequest>();
  readonly machines = new Map<string, Machine>();
  /**
   * What a session's reply becomes before it is kept and shown (w1384): Agents sets it to put review media inline in a
   * personal orchestrator's replies (server/reviewMedia.ts inlineReviewMedia). The model's own conversation is unchanged.
   */
  assistantText?: (sessionId: string, text: string) => string;
  /** The work ledger (docs/orchestrators.md), kept in its own file, data/work.json. */
  readonly work = new Map<string, WorkItem>();
  /** The number of the last work item ("w12" is 12). */
  workSeq = 0;
  /** The dispatcher's session id (the key keeps its old name: it was the one shared orchestrator). */
  orchestratorId?: string;
  settings: AppSettings = { heartbeatMinutes: null };
  private readonly stateFile: SnapshotFile;
  private readonly workFile: SnapshotFile;
  private readonly transcriptDir: string;
  private readonly uploadDir: string;
  /** The context meter's tally per conversation, for the next process of the portal's own sessions (w1484). */
  readonly meters: MeterStates;
  private readonly seqs = new Map<string, number>();
  /** Transcripts whose last line this process has checked is complete (see appendLine). */
  private readonly tailChecked = new Set<string>();

  constructor(dataDir: string) {
    const file = path.join(dataDir, 'state.json');
    const workFile = path.join(dataDir, 'work.json');
    this.transcriptDir = path.join(dataDir, 'transcripts');
    this.uploadDir = path.join(dataDir, 'uploads');
    this.meters = meterStates(path.join(dataDir, 'meters'));
    fs.mkdirSync(this.transcriptDir, { recursive: true });
    this.stateFile = new SnapshotFile(file, () => JSON.stringify(this.persisted(), null, 2), { ...STATE_SAVE, label: 'state' });
    this.workFile = new SnapshotFile(workFile, () => JSON.stringify({ seq: this.workSeq, items: [...this.work.values()] }, null, 2), { ...WORK_SAVE, label: 'work ledger' });
    const p = readJsonDurable<Persisted>(file, { check: checkState });
    if (p) {
      this.leftoverSandboxes.push(...p.sandboxes);
      for (const s of p.sessions) this.sessions.set(s.id, s);
      this.orchestratorId = p.orchestratorId;
      for (const a of p.standingAgents ?? []) this.standing.set(a.id, a);
      for (const d of p.delegations ?? []) this.delegations.set(d.id, d);
      for (const m of p.machines ?? []) this.machines.set(m.id, { ...m, online: false });
      this.settings = { ...this.settings, ...p.settings };
    }
    const w = readJsonDurable<{ seq?: number; items?: WorkItem[] }>(workFile, { check: checkWork });
    if (w) {
      for (const item of w.items ?? []) this.work.set(item.id, item);
      // An older version restored after a crash may not know the last few numbers handed out: skip past them.
      const restored = dataRecoveries.some((r) => r.file === workFile && r.from);
      this.workSeq = (w.seq ?? 0) + (restored ? 100 : 0);
    }
    this.backfillResultTimes();
  }

  /**
   * Workers from before w1504 have a lastResult without lastResultAt: take it from their transcript's last result, for the
   * workers of open requests only (a person-wait their report names counts until a note or a merge after it,
   * shared/workState.ts personWaitSettled). Once: the field is saved with the session. How many it filled in.
   */
  backfillResultTimes(): number {
    const open = new Set<WorkItem['status']>(['new', 'question', 'queued', 'blocked', 'active', 'stalled']);
    const ids = new Set([...this.work.values()].filter((w) => open.has(w.status)).flatMap((w) => w.sessionIds));
    let n = 0;
    for (const id of ids) {
      const s = this.sessions.get(id);
      if (!s?.lastResult || s.lastResultAt) continue;
      try {
        const t = this.readTranscript(id, 2000).findLast((e) => e.kind === 'result')?.t;
        if (!t) continue;
        s.lastResultAt = t;
        n++;
      } catch (e) {
        console.warn(`store: no result time for ${id}: ${(e as Error).message}`);
      }
    }
    if (n) this.save();
    return n;
  }

  putSession(s: SessionInfo) {
    // A permission prompt's tool arguments, a result, a status detail: never a secret in state.json or on screen (w1584).
    redactInPlace(s);
    this.sessions.set(s.id, s);
    this.save();
    emit({ type: 'session', session: s });
  }

  removeSession(id: string) {
    this.sessions.delete(id);
    this.save();
    emit({ type: 'session_removed', id });
  }

  putStanding(a: StandingAgent) {
    redactInPlace(a);
    this.standing.set(a.id, a);
    this.save();
    emit({ type: 'standing', agent: a });
  }

  removeStanding(id: string) {
    this.standing.delete(id);
    this.save();
    emit({ type: 'standing_removed', id });
  }

  putDelegation(d: DelegationRequest) {
    redactInPlace(d);
    this.delegations.set(d.id, d);
    this.save();
    emit({ type: 'delegation', request: d });
  }

  /** Save a work item (data/work.json, its own file: state.json is rewritten on every session update). */
  putWork(w: WorkItem) {
    // Its log lines, DONE reports, [needs you] text and notes: never a secret in work.json or on screen (w1584).
    redactInPlace(w);
    this.work.set(w.id, w);
    this.saveWork();
    emit({ type: 'work', item: w });
  }

  /** Forget work items (pruning closed ones); no event: pages drop them at their next state. */
  dropWork(ids: string[]) {
    for (const id of ids) this.work.delete(id);
    if (ids.length) this.saveWork();
  }

  private saveWork() {
    this.workFile.changed();
  }

  putSettings(patch: Partial<AppSettings>) {
    this.settings = { ...this.settings, ...patch };
    this.save();
    emit({ type: 'settings', settings: this.settings });
    return this.settings;
  }

  putMachine(m: Machine) {
    this.machines.set(m.id, m);
    this.save();
    emit({ type: 'machine', machine: m });
  }

  removeMachine(id: string) {
    this.machines.delete(id);
    this.save();
    emit({ type: 'machine_removed', id });
  }

  /** Persist an event whose seq was assigned elsewhere (a machine daemon). A seq already on file is ignored. */
  appendFull(sessionId: string, e: TranscriptEvent) {
    const last = this.seqs.get(sessionId) ?? this.lastSeq(sessionId);
    if (e.seq <= last) return;
    e = redactValue(e); // never a Claude OAuth token on disk or on screen (server/secrets.ts)
    this.appendLine(sessionId, JSON.stringify(e));
    this.seqs.set(sessionId, e.seq);
    emit({ type: 'transcript', sessionId, event: e });
    this.noteActivity(sessionId, e);
    this.observe(sessionId, e);
  }

  /** Told of every event written to a transcript, whether the session runs here or on a machine (the spend record, w859). */
  onEvent?: (sessionId: string, e: TranscriptEvent) => void;
  private observe(sessionId: string, e: TranscriptEvent) {
    try {
      this.onEvent?.(sessionId, e);
    } catch (err) {
      console.warn(`transcript observer failed for ${sessionId}: ${(err as Error).message}`);
    }
  }

  /** How many result lines a session's transcript holds (a turn each): 1 right after a session's first turn ended. */
  countResults(sessionId: string, atMost = Infinity): number {
    // w2026: read in pieces and stop at `atMost` (the spend store only asks "more than one?"): a coordinator's gigabyte transcript
    // read whole and split held the event loop for seconds at a time.
    const f = this.transcriptPath(sessionId);
    let fd: number;
    try {
      fd = fs.openSync(f, 'r');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const text = this.transcriptText(sessionId);
      return text === undefined ? 0 : Math.min(atMost, text.split(RESULT_MARK).length - 1);
    }
    const mark = Buffer.from(RESULT_MARK);
    const buf = Buffer.alloc(1024 * 1024 + mark.length);
    let n = 0;
    let keep = 0;
    try {
      for (;;) {
        const got = fs.readSync(fd, buf, keep, buf.length - keep, null);
        if (got <= 0) break;
        const end = keep + got;
        for (let i = buf.indexOf(mark); i >= 0 && i + mark.length <= end; i = buf.indexOf(mark, i + mark.length)) if (++n >= atMost) return n;
        // carry the last bytes over, so a mark across two reads is found once
        keep = Math.min(mark.length - 1, end);
        buf.copy(buf, 0, end - keep, end);
        buf.fill(0, keep);
      }
    } finally {
      fs.closeSync(fd);
    }
    return n;
  }

  /**
   * The whole transcript for a background job (w2026), without holding the event loop: read and unzipped off the main thread and
   * parsed a few thousand lines at a time with a turn of the loop between. Undefined when it has none, or when it is larger than
   * `maxBytes` (on disk, or unzipped), which a background job then leaves alone: a 1.3 GB coordinator transcript read whole held
   * the loop for tens of seconds on every boot.
   */
  async readTranscriptAsync(sessionId: string, maxBytes: number): Promise<TranscriptEvent[] | undefined> {
    const f = this.transcriptPath(sessionId);
    let buf: Buffer;
    try {
      if ((await fs.promises.stat(f)).size > maxBytes) return undefined;
      buf = await fs.promises.readFile(f);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      try {
        if ((await fs.promises.stat(`${f}.gz`)).size > maxBytes / 4) return undefined;
        buf = await gunzipAsync(await fs.promises.readFile(`${f}.gz`), { maxOutputLength: maxBytes });
      } catch {
        return undefined;
      }
    }
    const out: TranscriptEvent[] = [];
    let at = 0;
    let since = 0;
    while (at < buf.length) {
      let nl = buf.indexOf(10, at);
      if (nl < 0) nl = buf.length;
      if (nl > at) {
        try {
          out.push(JSON.parse(buf.toString('utf8', at, nl).replace(/^\0+/, '')));
        } catch {
          // a torn line after a crash; skip it
        }
        since += nl - at;
      }
      at = nl + 1;
      if (since >= PARSE_SLICE_BYTES) {
        since = 0;
        await yieldLoop();
      }
    }
    return out;
  }

  private readonly pendingTools = new Map<string, { id: string; name: string; since: string }[]>();
  private readonly activitySaved = new Map<string, number>();

  /**
   * A session did something: an event (a tool call starting or ending, text, a result) or streamed output.
   * Moves lastActivityAt (saved at most every 15 s, at once when a tool call starts or ends) and keeps
   * activeTool: its oldest top-level tool call without a result yet, so a long foreground command reads
   * as "in a long command", not as silence. Works the same for sessions on a machine (their events land here).
   */
  noteActivity(sessionId: string, e?: TranscriptEvent) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const now = Date.now();
    let pending = this.pendingTools.get(sessionId) ?? [];
    const before = pending[0]?.id;
    if (e?.kind === 'tool_use' && !e.parentToolUseId) pending = [...pending, { id: e.toolUseId, name: e.name, since: e.t }];
    else if (e?.kind === 'tool_result') pending = pending.filter((p) => p.id !== e.toolUseId);
    else if (e?.kind === 'result' || e?.kind === 'error') pending = [];
    this.pendingTools.set(sessionId, pending);
    const toolChanged = pending[0]?.id !== before;
    if (!toolChanged && now - (this.activitySaved.get(sessionId) ?? 0) < 15_000) return;
    this.activitySaved.set(sessionId, now);
    s.lastActivityAt = new Date(now).toISOString();
    s.activeTool = pending[0];
    this.putSession(s);
  }

  /**
   * The seq of the transcript's last event (0: none), remembered for the rest of the process: every daemon connect asks it for
   * each session of that machine (machines.ts welcomeOf), and until w1377 each ask read the whole file, so a reconnect storm
   * read every transcript of every machine again and again (2026-10-15). A torn last line (a crash) is skipped.
   */
  lastSeq(sessionId: string): number {
    const n = this.seqs.get(sessionId);
    if (n !== undefined) return n;
    const last = this.readTranscript(sessionId, LAST_LINES).at(-1)?.seq ?? 0;
    this.seqs.set(sessionId, last);
    return last;
  }

  append(sessionId: string, e: DistributiveOmit<TranscriptEvent, 'seq' | 't'>): TranscriptEvent {
    if (e.kind === 'assistant' && this.assistantText) {
      try {
        e = { ...e, text: this.assistantText(sessionId, e.text) };
      } catch (err) {
        console.warn(`store: the reply filter failed for ${sessionId}; kept as written:`, (err as Error).message);
      }
    }
    const seq = this.nextSeq(sessionId);
    const full = redactValue({ ...e, seq, t: new Date().toISOString() } as TranscriptEvent);
    this.appendLine(sessionId, JSON.stringify(full));
    emit({ type: 'transcript', sessionId, event: full });
    this.noteActivity(sessionId, full);
    this.observe(sessionId, full);
    return full;
  }

  /** Rewrite one already-persisted event (used to record a permission decision). */
  amend(sessionId: string, seq: number, patch: Partial<TranscriptEvent>) {
    this.unzip(sessionId);
    const all = this.readTranscript(sessionId);
    const i = all.findIndex((e) => e.seq === seq);
    if (i < 0) return;
    all[i] = redactValue({ ...all[i], ...patch } as TranscriptEvent);
    writeFileDurable(this.transcriptPath(sessionId), all.map((e) => JSON.stringify(e)).join('\n') + '\n', { generations: 0 });
    emit({ type: 'transcript', sessionId, event: all[i] });
  }

  /** The last `limit` events (all without one). A limited read takes only the end of the file (tailText), whatever its size. */
  readTranscript(sessionId: string, limit?: number): TranscriptEvent[] {
    const text = limit && limit > 0 ? this.tailText(sessionId, limit) : this.transcriptText(sessionId);
    if (text === undefined) return [];
    return parseLines(text, limit);
  }

  /**
   * The events whose line `keep` takes, read from the start in pieces (w2007): a coordinator's transcript is past a gigabyte (Ben's
   * orchestrator's 1,306.6 MB, 2026-10-24), over the longest string Node makes (about 512 MB), so `readTranscript` throws on it. A line
   * is parsed only when `keep` takes its raw text, so a replay of the results and messages skips the tool output that fills the file.
   */
  async *scanTranscript(sessionId: string, keep: (line: string) => boolean): AsyncGenerator<TranscriptEvent> {
    const f = this.transcriptPath(sessionId);
    const gz = !fs.existsSync(f);
    if (gz && !fs.existsSync(`${f}.gz`)) return;
    const raw = fs.createReadStream(gz ? `${f}.gz` : f, { highWaterMark: 4 * 1024 * 1024 });
    const stream = gz ? raw.pipe(zlib.createGunzip()) : raw;
    const lineOf = (buf: Buffer, from: number, to: number) => {
      const line = buf.toString('utf8', from, to).replace(/^\0+/, '');
      if (!line || !keep(line)) return undefined;
      try {
        return JSON.parse(line) as TranscriptEvent;
      } catch {
        return undefined; // a torn line after a crash
      }
    };
    let rest = Buffer.alloc(0);
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
        let at = 0;
        for (let nl = buf.indexOf(10, at); nl >= 0; nl = buf.indexOf(10, at)) {
          const e = lineOf(buf, at, nl);
          if (e) yield e;
          at = nl + 1;
        }
        rest = Buffer.from(buf.subarray(at));
      }
    } finally {
      raw.destroy();
    }
    if (rest.length) {
      const e = lineOf(rest, 0, rest.length);
      if (e) yield e;
    }
  }

  /**
   * The results of the `gh pr create` calls a session made (w340's "opened by its own worker"), read from its transcript in pieces and
   * remembered with where the read stopped, so the next ask reads only what was appended since (w2026). The ledger sweep asked this
   * of every open request's workers and of every auto-closed request's, every five minutes and two minutes after each start, by
   * reading the last 2,000 or 100,000 lines of each transcript whole and synchronously: tens of seconds of a held event loop on
   * 2026-10-24, while the daemons' heartbeats and /api/health waited. The whole transcript is read, not its last lines.
   */
  async prCreateResults(sessionId: string): Promise<PrCreateResult[]> {
    const f = this.transcriptPath(sessionId);
    let file = f;
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(f);
    } catch {
      file = `${f}.gz`;
      try {
        st = await fs.promises.stat(file);
      } catch {
        this.prScans.delete(sessionId);
        return [];
      }
    }
    const gz = file !== f;
    let c = this.prScans.get(sessionId);
    if (c && c.file === file && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.results;
    // a new file, a compressed one (it never grows), one that shrank or was rewritten (amend): read from the start
    if (!c || c.file !== file || gz || st.size < c.offset) c = { file, size: 0, mtimeMs: 0, offset: 0, created: new Set(), results: [] };
    const raw = fs.createReadStream(file, { start: gz ? 0 : c.offset, highWaterMark: 1024 * 1024 });
    const stream = gz ? raw.pipe(zlib.createGunzip()) : raw;
    let offset = c.offset;
    let rest = Buffer.alloc(0);
    const line = (text: string) => {
      const create = text.includes('"kind":"tool_use"') && text.includes('create') && text.includes('gh');
      const result = !create && text.includes('"kind":"tool_result"') && text.includes('/pull/');
      if (!create && !result) return;
      let e: TranscriptEvent;
      try {
        e = JSON.parse(text.replace(/^\0+/, ''));
      } catch {
        return; // a torn line after a crash
      }
      if (e.kind === 'tool_use' && /bash/i.test(e.name) && /\bgh\s+pr\s+create\b/.test(String((e.input as { command?: unknown } | null)?.command ?? ''))) c.created.add(e.toolUseId);
      else if (e.kind === 'tool_result' && c.created.has(e.toolUseId)) c.results.push({ at: e.t, text: e.text, isError: !!e.isError });
    };
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
        let at = 0;
        for (let nl = buf.indexOf(10, at); nl >= 0; nl = buf.indexOf(10, at)) {
          if (nl > at) line(buf.toString('utf8', at, nl));
          at = nl + 1;
        }
        offset += at;
        rest = Buffer.from(buf.subarray(at));
      }
    } finally {
      raw.destroy();
    }
    // a line still being written stays for the next read (a plain file); a compressed one is whole
    if (gz && rest.length) line(rest.toString('utf8'));
    c.offset = gz ? 0 : offset;
    c.size = st.size;
    c.mtimeMs = st.mtimeMs;
    this.prScans.set(sessionId, c);
    return c.results;
  }

  /** The transcript's text, from its file or, once the data guard compressed it (server/dataGuard.ts), its .gz; undefined: none. */
  transcriptText(sessionId: string): string | undefined {
    const f = this.transcriptPath(sessionId);
    try {
      return fs.readFileSync(f, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    try {
      return zlib.gunzipSync(fs.readFileSync(`${f}.gz`)).toString('utf8');
    } catch {
      return undefined;
    }
  }

  /**
   * The end of a transcript holding at least its last `lines` non-empty lines (fewer only when the file has fewer), read
   * backwards from the end in growing chunks: the cost follows `lines`, not the file (w1377: a 300 MB transcript cost 0.36 s
   * for its last line, measured on BEAST, and the VM's two shared vCPUs are slower). The first, partial line of the chunk is
   * left out, so the text starts at a line (a newline is one byte in UTF-8, never inside a character). A compressed transcript
   * is read whole, as before: the data guard only compresses ones idle for a day.
   */
  tailText(sessionId: string, lines: number): string | undefined {
    return this.tail(sessionId, lines)?.text;
  }

  /** tailText, and whether the text is the whole transcript. */
  private tail(sessionId: string, lines: number): { text: string; whole: boolean } | undefined {
    const f = this.transcriptPath(sessionId);
    let fd: number;
    try {
      fd = fs.openSync(f, 'r');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      // compressed (idle a day, dataGuard.ts): its last lines from the tail file beside it, else the whole file once, and the tail file written for next time (w2026)
      const side = readTailFile(`${f}.gz`, lines);
      if (side) return side;
      const text = this.transcriptText(sessionId);
      if (text !== undefined) writeTailFile(`${f}.gz`, text);
      return text === undefined ? undefined : { text, whole: true };
    }
    try {
      const size = fs.fstatSync(fd).size;
      let start = size;
      let chunk = TAIL_CHUNK;
      let buf = Buffer.alloc(0);
      while (start > 0) {
        const from = Math.max(0, start - chunk);
        const part = Buffer.alloc(start - from);
        let got = 0;
        while (got < part.length) {
          const n = fs.readSync(fd, part, got, part.length - got, from + got);
          if (n <= 0) break;
          got += n;
        }
        buf = Buffer.concat([part.subarray(0, got), buf]);
        start = from;
        if (start > 0 && completeLines(buf) >= lines) break;
        chunk *= 2;
      }
      if (start > 0) buf = buf.subarray(buf.indexOf(0x0a) + 1);
      return { text: buf.toString('utf8'), whole: start === 0 };
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Whether the session has a transcript on disk, plain or compressed. */
  hasTranscript(sessionId: string): boolean {
    const f = this.transcriptPath(sessionId);
    return fs.existsSync(f) || fs.existsSync(`${f}.gz`);
  }

  /** Where each session's `gh pr create` scan stopped (prCreateResults). */
  private readonly prScans = new Map<string, { file: string; size: number; mtimeMs: number; offset: number; created: Set<string>; results: PrCreateResult[] }>();

  /** Transcripts the data guard compressed in this process: the next append to one restores its plain file. */
  private readonly compressed = new Set<string>();
  noteCompressed(sessionId: string) {
    this.compressed.add(sessionId);
  }

  /** A compressed transcript is written to again (the session was resumed): the plain file comes back first. */
  private unzip(sessionId: string) {
    const f = this.transcriptPath(sessionId);
    if (fs.existsSync(f) || !fs.existsSync(`${f}.gz`)) return;
    fs.writeFileSync(f, zlib.gunzipSync(fs.readFileSync(`${f}.gz`)));
    fs.rmSync(`${f}.gz`, { force: true });
    fs.rmSync(`${f}.gz.tail`, { force: true });
  }

  /**
   * Append one event line. The first append to a transcript in this process makes sure the file ends with a newline:
   * after a crash its last line can be torn, and the next event would otherwise be glued to it and lost.
   */
  private appendLine(sessionId: string, line: string) {
    const f = this.transcriptPath(sessionId);
    // A compressed transcript (server/dataGuard.ts) gets its plain file back before an append: on the first append of this process,
    // and again whenever the guard compressed it since (noteCompressed), so a stat per event is not needed.
    if (!this.tailChecked.has(sessionId) || this.compressed.delete(sessionId)) this.unzip(sessionId);
    let prefix = '';
    if (!this.tailChecked.has(sessionId)) {
      this.tailChecked.add(sessionId);
      const last = lastByte(f);
      prefix = last === undefined || last === 0x0a ? '' : '\n';
    }
    fs.appendFileSync(f, prefix + line + '\n');
  }

  deleteTranscript(sessionId: string) {
    this.seqs.delete(sessionId);
    fs.rmSync(this.transcriptPath(sessionId), { force: true });
    fs.rmSync(`${this.transcriptPath(sessionId)}.gz.tail`, { force: true });
    fs.rmSync(`${this.transcriptPath(sessionId)}.gz`, { force: true });
    this.deleteUploads(sessionId);
  }

  /** The images a session's transcript shows (they go with the transcript). */
  deleteUploads(sessionId: string) {
    fs.rmSync(path.join(this.uploadDir, safeId(sessionId)), { recursive: true, force: true });
  }

  /** Keep an image with a session (sent by the user, or returned by a tool); returns its id. */
  saveImage(sessionId: string, mediaType: string, data: string, id: string = randomUUID()): string {
    const ext = IMAGE_EXT[mediaType];
    if (!ext) throw new Error(`unsupported image type ${mediaType}`);
    const dir = path.join(this.uploadDir, safeId(sessionId));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${safeId(id)}.${ext}`), Buffer.from(data, 'base64'));
    return id;
  }

  /** The file behind an ImageRef, or undefined. */
  imagePath(sessionId: string, id: string): string | undefined {
    const dir = path.join(this.uploadDir, safeId(sessionId));
    for (const ext of Object.values(IMAGE_EXT)) {
      const f = path.join(dir, `${safeId(id)}.${ext}`);
      if (fs.existsSync(f)) return f;
    }
    return undefined;
  }

  /** Where the transcripts are (for search). */
  get transcriptsDir() {
    return this.transcriptDir;
  }

  /** Events from `seq` on (to show an older search hit in context). */
  readTranscriptFrom(sessionId: string, seq: number): TranscriptEvent[] {
    // From the end back to `seq` (w1377): a recent message costs a little of a long chat, not all of it.
    for (let n = 500; ; n *= 4) {
      const t = this.tail(sessionId, n);
      if (!t) return [];
      const events = parseLines(t.text);
      if (t.whole || (events[0] && events[0].seq <= seq)) return events.filter((e) => e.seq >= seq);
    }
  }

  /** One event by its seq (undefined: none), read from the end back to it. */
  eventAt(sessionId: string, seq: number): TranscriptEvent | undefined {
    return this.readTranscriptFrom(sessionId, seq).find((e) => e.seq === seq);
  }

  private transcriptPath(id: string) {
    return path.join(this.transcriptDir, `${id}.jsonl`);
  }

  private nextSeq(sessionId: string) {
    const n = this.lastSeq(sessionId);
    this.seqs.set(sessionId, n + 1);
    return n + 1;
  }

  /** Save state.json soon, in the background (STATE_SAVE). */
  save() {
    this.stateFile.changed();
  }

  /** Save now, on the main thread (shutdown, tests): state.json, and the work ledger when it has changes. */
  /**
   * Redact every session, standing agent, delegation and work item held (w1584): records saved before their store redacted
   * (a result or a log line with a token). Run at start, before the files are scrubbed. How many strings changed.
   */
  scrubSecrets(): number {
    let n = 0;
    for (const m of [this.sessions, this.standing, this.delegations]) for (const v of m.values()) n += redactInPlace(v);
    if (n) this.save();
    let w = 0;
    for (const v of this.work.values()) w += redactInPlace(v);
    if (w) this.saveWork();
    return n + w;
  }

  flush() {
    if (this.workFile.pending) this.workFile.flushSync();
    this.stateFile.flushSync();
  }

  /** Resolves once no background save is running or due (tests). */
  async saved() {
    await Promise.all([this.stateFile.idle(), this.workFile.idle()]);
  }

  private persisted(): Persisted {
    return {
      sandboxes: this.leftoverSandboxes,
      sessions: [...this.sessions.values()],
      orchestratorId: this.orchestratorId,
      standingAgents: [...this.standing.values()],
      delegations: [...this.delegations.values()],
      machines: [...this.machines.values()],
      settings: this.settings,
    };
  }
}

/** A file's last byte, or undefined when it is missing or empty. */
function lastByte(f: string): number | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(f, 'r');
    const size = fs.fstatSync(fd).size;
    if (!size) return undefined;
    const b = Buffer.alloc(1);
    fs.readSync(fd, b, 0, 1, size - 1);
    return b[0];
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

/** Ids become file names: keep them to [\w-]. */
const safeId = (id: string) => id.replace(/[^\w-]/g, '_');

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
