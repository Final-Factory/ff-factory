// The timing machine's side of timed_run (w1946, shared/timedRun.ts). A play-only computer (no editor, no sandbox, no
// worker) gets a run from the portal as data: the pieces of each player, the save and the settings. Its daemon fetches the
// pieces it lacks over its own link, lays each player out in the install's player slot (slot1-0, slot1-1: the folders its
// firewall step already allows, w576), holds the machine's exclusive bench ticket for the whole run, and plays each leg of
// the game repo's interleaved A/B (scripts/bench/probe_ab_win.sh) with the fixed arguments of legArgs. What comes back is
// the logs in probe_ab_win.sh's layout, so its tables read them as they are. Nothing else is run: no command, no script,
// only the build's own finalfactory.exe, one leg at a time, each within its time bound.
//
// The ticket: a play-only machine has no game checkout and no python, so the daemon writes its ticket in the queue's own
// format (<root>/tmp/bench.queue/tNNNNNNNN, bench.lock/owner; machine/benchQueue.ts reads it), the holder being the daemon
// itself. Only it takes tickets there; it still waits while a live ticket of anyone else's is in the queue, or a person plays.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import type { AttachmentRef } from '../shared/types.ts';
import { legArgs, legOrder, legTimeoutS, perfSummaryOf, summaryTable, timedArgsProblem, timedSettingsOf, variantNameProblem, TIMED_SLOTS, type LegSummary, type Piece, type TimedRunOrder, type TimedRunReport, type TimedVariant } from '../shared/timedRun.ts';
import { fetchAttachment } from './attachments.ts';
import { benchLockDir, pidAlive } from './benchLock.ts';
import { benchQueueDir, queueTickets, type TicketState } from './benchQueue.ts';
import { sendChunks } from './review.ts';
import { PLAYER_EXE } from './timedRunPack.ts';


export interface TimedRunnerDeps {
  root: string;
  portalUrl: string;
  token: string;
  send: (m: TimedRunReport) => void;
  log: (line: string) => void;
  /** Why no leg may start now (a person plays here), or undefined. */
  personBusy: () => string | undefined;
  /** A person's last key or click here (epoch ms), when the tray reports it. */
  lastInputAt?: () => number | undefined;
  /** The game's saves folder (default: the Windows player's, under LocalLow). */
  savesDir?: string;
  /** Tests: fetch a piece into `dest`. */
  fetchPiece?: (ref: AttachmentRef, dest: string) => Promise<void>;
  /** Tests: start a leg's player. */
  spawnPlayer?: (exe: string, args: string[], cwd: string) => ChildProcess;
  /** Tests: the waits between looks (ms). */
  pollMs?: number;
  /** Most bytes of pieces kept between runs (default 8 GB). */
  cacheMaxBytes?: number;
  /**
   * w1996: this is a worker computer (it has sandboxes and the game repo's bench queue), not a play-only one. Its exclusive
   * ticket is taken through the bench queue (bench_queue.py hold --reason timing, with the asking worker's session, so the
   * queue's order, turn limits and BenchTurn's quiet machine apply), and its legs borrow a sandbox's player-slot pair that no
   * live lease holds, only during its turn. Undefined on a play-only computer (the ticket written by hand, its own slots).
   */
  worker?: TimedWorkerDeps;
}

/** A queue ticket as the runner uses one (machine/benchQueue.ts BenchTicket). */
export interface RunTicket {
  wait(ms?: number, onLine?: (line: string) => void): Promise<TicketState>;
  state(): TicketState;
  release(): void;
}

export interface TimedWorkerDeps {
  /** The sandbox ids whose player-slot pairs (slotK-0, slotK-1) are this computer's (the pool's sandboxes). */
  sandboxIds: () => string[];
  /** Take the exclusive timing ticket for the run, owned by `ownerPid`; undefined with why when the queue cannot be used. */
  ticket: (o: { what: string; session: string; maxMin: number; ownerPid: number }) => { ticket?: RunTicket; why?: string };
  /** The process the ticket and the slot leases follow; ended after the run (default: a small node child of this daemon). */
  owner?: () => { pid: number; end: () => void };
  /** The slot pool's root (default <root>/players: the folders the firewall step allows). */
  slotsRoot?: string;
  /** The longest a turn is planned for before the ticket is given back and taken again (default TURN_PLAN_MS). */
  turnPlanMs?: number;
}

/**
 * The part of the bench queue's 30-minute exclusive turn (the game repo's bench_queue.py MAX_HOLD_MIN, w1832) a timed run on
 * a worker computer plans its legs into: no leg starts that would end past it, by the longest leg so far. The queue warns
 * at 25 minutes, so the run gives the ticket back before any warning and queues again for the rest (w1996).
 */
export const TURN_PLAN_MS = 24 * 60_000;

/** The node child that owns a run's ticket and leases: it ends when this daemon does (w1996, so BenchTurn spares only it). */
export function spawnOwner(): { pid: number; end: () => void } {
  const parent = process.pid;
  const c = spawn(process.execPath, ['-e', `setInterval(()=>{try{process.kill(${parent},0)}catch{process.exit(0)}},2000)`], { stdio: 'ignore', windowsHide: true });
  return { pid: c.pid ?? process.pid, end: () => c.kill() };
}

const HOST = () => os.hostname().toLowerCase();

/** A lease file that holds a slot now (player_slots.py live_leases/_live: a live pid on this host, or a fresh remote one). */
function liveLease(file: string, alive: (pid: number) => boolean, now: number): boolean {
  try {
    const l = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number; host?: string; time?: number };
    if (now / 1000 - Number(l.time ?? 0) > 12 * 3600) return false;
    if (String(l.host ?? '').toLowerCase() !== HOST()) return true;
    return Number.isInteger(l.pid) && alive(l.pid!);
  } catch {
    return false;
  }
}

/** Whether no live lease holds slot `dir` (game repo scripts/nightly/player_slots.py's layout: <slot>/leases/*.json). */
export function slotFree(dir: string, alive: (pid: number) => boolean = pidAlive, now = Date.now()): boolean {
  const leases = path.join(dir, 'leases');
  if (!fs.existsSync(leases)) return true;
  return !fs.readdirSync(leases).some((n) => n.endsWith('.json') && liveLease(path.join(leases, n), alive, now));
}

/** A sandbox pair a run borrows: its slot folders, and the lease files to remove after the turn. */
export interface BorrowedPair {
  sandbox: string;
  slots: string[];
  leases: string[];
}

/**
 * Borrow the player-slot pair of a sandbox here that no live lease holds (w1996), for `n` builds: lease each slot to
 * `ownerPid` as player_slots.py does (so no launch takes it meanwhile) and mark it with a fingerprint no build has, so
 * the sandbox's next launch refills it. Undefined when every pair is in use.
 */
export function borrowPair(slotsRoot: string, sandboxIds: string[], n: number, o: { ownerPid: number; run: string; session: string }, alive: (pid: number) => boolean = pidAlive, now = Date.now()): BorrowedPair | undefined {
  for (const sb of sandboxIds) {
    if (!/^slot\d+$/.test(sb)) continue;
    const slots = [0, 1].slice(0, Math.max(1, n)).map((p) => path.join(slotsRoot, `${sb}-${p}`));
    if (!slots.every((d) => slotFree(d, alive, now))) continue;
    const leases: string[] = [];
    for (const d of slots) {
      fs.mkdirSync(path.join(d, 'leases'), { recursive: true });
      const f = path.join(d, 'leases', `${HOST()}-${o.ownerPid}-${randomHex()}.json`);
      fs.writeFileSync(f, JSON.stringify({ pid: o.ownerPid, host: HOST(), sandbox: `timed run ${o.run}`, sha: '', build: `timed-run:${o.run}`, time: now / 1000, when: new Date(now).toISOString().slice(0, 19), session: o.session }));
      leases.push(f);
    }
    return { sandbox: sb, slots, leases };
  }
  return undefined;
}

const randomHex = () => createHash('sha256').update(`${process.pid}-${Date.now()}-${Math.random()}`).digest('hex').slice(0, 8);

/**
 * Put build folder `src` (laid out by layOut) into slot `slot`'s player folder by hard links (a copy across volumes), unless
 * it holds that build from an earlier turn. A player folder of another build goes first (renamed aside, then removed: a
 * rename fails while a player runs from it, and then this throws). The slot's marker names the run's build, so
 * player_slots.py, matching sha and fingerprint, never takes it for one of its own.
 */
export function linkInto(src: string, slot: string, files: { path: string }[], key: string, run: string): 'kept' | 'linked' {
  const dst = path.join(slot, 'player');
  const marker = path.join(slot, 'slot.json');
  const fp = `timed-run:${key}`;
  let m: { fingerprint?: string } | undefined;
  try {
    m = JSON.parse(fs.readFileSync(marker, 'utf8'));
  } catch {
    m = undefined;
  }
  if (m?.fingerprint === fp && files.every((f) => fs.existsSync(path.join(dst, f.path)))) return 'kept';
  if (fs.existsSync(dst)) {
    const trash = path.join(slot, `trash-${Date.now()}-timed`);
    fs.renameSync(dst, trash);
    fs.rmSync(trash, { recursive: true, force: true });
  }
  const now = Date.now() / 1000;
  fs.writeFileSync(marker, JSON.stringify({ sha: '', fingerprint: fp, state: 'filling', source: `timed run ${run}`, filled: now, used: now }));
  for (const f of files) {
    const from = path.join(src, f.path);
    const to = path.join(dst, f.path);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
      fs.linkSync(from, to);
    } catch {
      fs.copyFileSync(from, to);
    }
  }
  fs.writeFileSync(marker, JSON.stringify({ sha: '', fingerprint: fp, state: 'ready', source: `timed run ${run}`, filled: now, used: now }));
  return 'linked';
}

/** The Windows player's saves folder (GameDataPaths.Saves: persistentDataPath/UserData/saves). */
export const windowsSavesDir = () => path.join(os.homedir(), 'AppData', 'LocalLow', 'Never Games', 'finalfactory', 'UserData', 'saves');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The machine's mean CPU load over `ms`, all cores, percent. */
export async function cpuLoad(ms: number): Promise<number> {
  const snap = () => os.cpus().reduce((a, c) => ({ idle: a.idle + c.times.idle, all: a.all + c.times.idle + c.times.user + c.times.sys + c.times.irq + c.times.nice }), { idle: 0, all: 0 });
  const a = snap();
  await sleep(ms);
  const b = snap();
  const all = b.all - a.all;
  return all > 0 ? 100 * (1 - (b.idle - a.idle) / all) : 0;
}

// ------------------------------------------------------------------ the ticket

/** A live ticket of someone else's in the queue (a bench_queue.py holder), or undefined. */
export function foreignTicket(root: string, alive: (pid: number) => boolean = pidAlive): string | undefined {
  const t = queueTickets(benchLockDir(root), alive).find((x) => x.pid !== process.pid);
  return t ? `${t.ticket} ${t.mode} "${t.what}"` : undefined;
}

/** Take the exclusive ticket in the queue's format, held by this daemon process; returns its name. */
export function takeTicket(root: string, info: { what: string; session: string; requests: string[]; maxMin: number }, now = Date.now()): string {
  const lock = benchLockDir(root);
  const qdir = benchQueueDir(lock);
  fs.mkdirSync(qdir, { recursive: true });
  const last = fs.readdirSync(qdir).filter((n) => /^t\d{8}$/.test(n)).map((n) => Number(n.slice(1))).reduce((a, b) => Math.max(a, b), 0);
  const name = `t${String(last + 1).padStart(8, '0')}`;
  const dir = path.join(qdir, name);
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date(now).toISOString();
  fs.writeFileSync(path.join(dir, 'info.json'), JSON.stringify({ pid: process.pid, owner_pid: process.pid, mode: 'exclusive', what: info.what, session: info.session, requests: info.requests, host: os.hostname(), created: at, max_min: info.maxMin, reason: 'timing', timed_run: true }));
  fs.writeFileSync(path.join(dir, 'granted'), JSON.stringify({ at, ts: Math.floor(now / 1000) }));
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner'), `${info.what} [${name}]\n`);
  return name;
}

/** Let the ticket go (the lock's owner line only when it is still ours). */
export function releaseTicket(root: string, name: string) {
  const lock = benchLockDir(root);
  fs.rmSync(path.join(benchQueueDir(lock), name), { recursive: true, force: true });
  try {
    if (fs.readFileSync(path.join(lock, 'owner'), 'utf8').includes(`[${name}]`)) fs.rmSync(lock, { recursive: true, force: true });
  } catch {
    // no owner line
  }
}

// ------------------------------------------------------------------ laying a player out

/** The key of a build: its files and pieces. A slot already holding it is used as it is. */
export const buildKey = (v: Pick<TimedVariant, 'files' | 'pieces'>) =>
  createHash('sha256')
    .update(JSON.stringify([v.files.map((f) => [f.path, f.size]), v.pieces.map((p) => p.sha256)]))
    .digest('hex');

/** A path from the order, checked to stay inside the player folder. */
function inside(dir: string, rel: string): string {
  const p = path.resolve(dir, rel);
  if (!p.startsWith(path.resolve(dir) + path.sep) || rel.includes('\0')) throw new Error(`a file outside the player folder: ${rel}`);
  return p;
}

/** Write a build into `dir` from the cached pieces, unless it holds that build already. */
export async function layOut(v: Pick<TimedVariant, 'files' | 'pieces'>, dir: string, cache: string): Promise<'kept' | 'written'> {
  const key = buildKey(v);
  const mark = path.join(dir, '.timed-build');
  if (fs.existsSync(mark) && fs.readFileSync(mark, 'utf8').trim() === key && v.files.every((f) => fs.statSync(inside(dir, f.path), { throwIfNoEntry: false })?.size === f.size)) return 'kept';
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of v.files) {
    const p = inside(dir, f.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '');
    if (f.size) fs.truncateSync(p, f.size);
  }
  for (const piece of v.pieces) {
    const src = await fs.promises.open(path.join(cache, piece.sha256), 'r');
    try {
      let at = 0;
      for (const part of piece.parts) {
        const out = await fs.promises.open(inside(dir, part.path), 'r+');
        try {
          const buf = Buffer.alloc(Math.min(4 * 1024 * 1024, Math.max(1, part.length)));
          for (let done = 0; done < part.length; ) {
            const n = Math.min(buf.length, part.length - done);
            await src.read(buf, 0, n, at + done);
            await out.write(buf, 0, n, part.offset + done);
            done += n;
          }
        } finally {
          await out.close();
        }
        at += part.length;
      }
    } finally {
      await src.close();
    }
  }
  fs.writeFileSync(mark, key);
  return 'written';
}

/** Keep the cache under `max` bytes: the oldest pieces go first, never one of `keep`. */
export function trimCache(cache: string, max: number, keep: Set<string>) {
  const all = (fs.existsSync(cache) ? fs.readdirSync(cache) : []).map((n) => ({ n, st: fs.statSync(path.join(cache, n)) })).sort((a, b) => a.st.mtimeMs - b.st.mtimeMs);
  let total = all.reduce((s, x) => s + x.st.size, 0);
  for (const x of all) {
    if (total <= max) break;
    if (keep.has(x.n)) continue;
    fs.rmSync(path.join(cache, x.n), { force: true });
    total -= x.st.size;
  }
}

// ------------------------------------------------------------------ a .tar.gz of the results

function tarHeader(name: string, size: number, mtime: number): Buffer {
  const h = Buffer.alloc(512);
  const put = (s: string, off: number, len: number) => h.write(s.slice(0, len), off, len, 'utf8');
  const oct = (n: number, len: number) => n.toString(8).padStart(len - 1, '0') + '\0';
  put(name, 0, 100);
  put(oct(0o644, 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12);
  put(oct(Math.floor(mtime / 1000), 12), 136, 12);
  h.fill(0x20, 148, 156);
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

/** Write `files` (name inside the archive, path here) as a gzipped ustar archive. Names stay under 100 characters. */
export async function writeTarGz(files: { name: string; file: string }[], dest: string): Promise<void> {
  async function* gen() {
    for (const f of files) {
      const st = fs.statSync(f.file);
      yield tarHeader(f.name, st.size, st.mtimeMs);
      for await (const c of fs.createReadStream(f.file)) yield c as Buffer;
      const pad = (512 - (st.size % 512)) % 512;
      if (pad) yield Buffer.alloc(pad);
    }
    yield Buffer.alloc(1024);
  }
  await pipeline(Readable.from(gen()), createGzip(), fs.createWriteStream(dest));
}

// ------------------------------------------------------------------ the runner

export class TimedRunner {
  private readonly queue: TimedRunOrder[] = [];
  private current?: string;
  private readonly uploads = new Map<string, (u: { uploadId: string; chunkBytes?: number }) => void>();
  private readonly d: TimedRunnerDeps;

  constructor(d: TimedRunnerDeps) {
    this.d = d;
  }

  /** The runs here, running first: the hello names them, so the portal sends none twice. */
  active(): string[] {
    return [...(this.current ? [this.current] : []), ...this.queue.map((o) => o.id)];
  }

  /** Whether a run holds the machine now: the daemon's own clean-up waits meanwhile (disk work the legs would measure). */
  busy(): boolean {
    return !!this.current;
  }

  enqueue(o: TimedRunOrder) {
    if (this.active().includes(o.id)) return;
    this.queue.push(o);
    this.d.send({ type: 'timed_run_status', id: o.id, state: 'queued', line: this.current ? `queued behind ${this.current}` : 'starting' });
    void this.next();
  }

  /** The portal opened the upload of a run's results. */
  uploadReady(id: string, uploadId: string, chunkBytes?: number) {
    this.uploads.get(id)?.({ uploadId, chunkBytes });
  }

  private async next() {
    if (this.current) return;
    const o = this.queue.shift();
    if (!o) return;
    this.current = o.id;
    try {
      await this.run(o);
    } catch (e) {
      this.d.log(`timed run ${o.id}: ${(e as Error).message}`);
      this.d.send({ type: 'timed_run_done', id: o.id, ok: false, error: (e as Error).message, summary: '', legs: [] });
    } finally {
      this.current = undefined;
      void this.next();
    }
  }

  private status(id: string, state: Extract<TimedRunReport, { type: 'timed_run_status' }>['state'], line: string) {
    this.d.log(`timed run ${id}: ${line}`);
    this.d.send({ type: 'timed_run_status', id, state, line });
  }

  private async run(o: TimedRunOrder) {
    // The portal checked it; this daemon checks again what it would run: the switches, the numbers, the names.
    const s = timedSettingsOf({ rounds: o.settings?.rounds, sample_s: o.settings?.sampleS, settle_s: o.settings?.settleS, res: o.settings?.res });
    if (typeof s === 'string') throw new Error(`refused: ${s}`);
    o.settings = s;
    if (!/^tr_[0-9a-f]{10}$/.test(o.id)) throw new Error('refused: a run id that is not tr_ and 10 hex digits');
    for (const v of o.variants) {
      const why = variantNameProblem(v.name) ?? timedArgsProblem(v.args);
      if (why) throw new Error(`refused: ${why}`);
    }
    const root = this.d.root;
    const cache = path.join(root, 'timing', 'cache');
    const runDir = path.join(root, 'timing', 'runs', o.id);
    fs.mkdirSync(cache, { recursive: true });
    fs.mkdirSync(runDir, { recursive: true });
    // 1. The pieces this machine lacks (a piece is checked against its SHA-256 as it arrives).
    const want = new Map<string, Piece | { sha256: string; size: number }>();
    for (const v of o.variants) for (const p of v.pieces) want.set(p.sha256, p);
    want.set(o.save.sha256, { sha256: o.save.sha256, size: o.save.size });
    const missing = [...want.values()].filter((p) => fs.statSync(path.join(cache, p.sha256), { throwIfNoEntry: false })?.size !== p.size);
    const mb = (n: number) => `${(n / 1024 ** 2).toFixed(0)} MB`;
    this.status(o.id, 'fetching', `fetching ${missing.length} of ${want.size} pieces (${mb(missing.reduce((s, p) => s + p.size, 0))}; the rest are here from earlier runs)`);
    const fetchPiece = this.d.fetchPiece ?? ((ref: AttachmentRef, dest: string) => fetchAttachment(this.d.portalUrl, this.d.token, ref, dest));
    for (const p of missing) {
      const id = p.sha256 === o.save.sha256 ? o.save.id : o.pieceIds[p.sha256];
      if (!id) throw new Error(`the order names no attachment for piece ${p.sha256.slice(0, 12)}…`);
      await fetchPiece({ id, name: p.sha256, size: p.size, sha256: p.sha256, kind: 'file', mediaType: 'application/octet-stream' }, path.join(cache, p.sha256));
    }
    const now = new Date();
    for (const sha of want.keys()) fs.utimesSync(path.join(cache, sha), now, now);
    // 2. Each distinct build laid out; names that share a build share it. A play-only computer lays them into its own slot
    // pair (TIMED_SLOTS) now; a worker computer (w1996) lays them beside the slots and links them into a borrowed sandbox
    // pair only during its turn, since those slots are its sandboxes' own.
    const worker = this.d.worker?.sandboxIds().length ? this.d.worker : undefined;
    const buildOf = new Map<string, number>();
    const builds = new Map<string, number>();
    const buildDirs: string[] = [];
    for (const v of o.variants) {
      const key = buildKey(v);
      let i = builds.get(key);
      if (i === undefined) {
        i = builds.size;
        if (i >= TIMED_SLOTS.length) throw new Error(`more than ${TIMED_SLOTS.length} different builds; a timed run times at most ${TIMED_SLOTS.length} (one build may carry several names with their own args)`);
        builds.set(key, i);
        const dir = worker ? path.join(root, 'timing', 'builds', `b${i}`) : path.join(root, 'players', TIMED_SLOTS[i], 'player');
        buildDirs.push(dir);
        const how = await layOut(v, dir, cache);
        this.status(o.id, 'fetching', `${v.name}: ${how === 'kept' ? 'already' : 'laid out'} in ${worker ? `timing/builds/b${i}` : TIMED_SLOTS[i]}`);
      }
      buildOf.set(v.name, i);
    }
    const buildFiles = new Map<number, TimedVariant['files']>();
    for (const v of o.variants) buildFiles.set(buildOf.get(v.name)!, v.files);
    // 3. The save, under this run's name, beside the person's own saves (never one of theirs).
    const savesDir = this.d.savesDir ?? windowsSavesDir();
    fs.mkdirSync(savesDir, { recursive: true });
    const saveName = `ffa-timed-${o.id}`;
    const saveFile = path.join(savesDir, `${saveName}.zip`);
    fs.copyFileSync(path.join(cache, o.save.sha256), saveFile);
    const legs: LegSummary[] = [];
    const contention: string[] = [];
    const poll = this.d.pollMs ?? 15_000;
    const order = legOrder(o.variants.map((v) => v.name), o.settings.rounds);
    try {
      if (!worker) {
        // 4. The exclusive ticket, once nobody else holds one and nobody plays here.
        let ticket: string | undefined;
        try {
          for (let waited = 0; ; waited++) {
            const why = this.d.personBusy() ?? (foreignTicket(root) ? `another ticket is in this machine's bench queue (${foreignTicket(root)})` : undefined);
            if (!why) break;
            if (waited % 20 === 0) this.status(o.id, 'waiting', `waiting: ${why}`);
            await sleep(poll);
          }
          ticket = takeTicket(root, { what: `timed run ${o.id}: ${o.what}`, session: o.session, requests: o.requests, maxMin: Math.ceil((order.length * legTimeoutS(o.settings)) / 60) + 5 });
          this.status(o.id, 'running', `holds the exclusive bench ticket ${ticket}: ${order.length} legs`);
          // 5. The legs.
          for (const leg of order) {
            const v = o.variants.find((x) => x.name === leg.variant)!;
            await this.personWait(o, `before ${leg.variant} round ${leg.round}`, poll);
            legs.push(await this.leg(o, v, leg.round, path.join(buildDirs[buildOf.get(v.name)!], PLAYER_EXE), saveName, runDir, contention));
          }
        } finally {
          if (ticket) releaseTicket(root, ticket);
        }
      } else {
        await this.workerTurns(o, worker, order, { buildOf, buildDirs, buildFiles, saveName, runDir, contention, legs, poll });
      }
    } finally {
      fs.rmSync(saveFile, { force: true });
    }
    // 6. The logs back, in probe_ab_win.sh's layout.
    const summary = summaryTable(legs);
    fs.writeFileSync(path.join(runDir, 'summary.tsv'), summary + '\n');
    fs.writeFileSync(path.join(runDir, 'contention.txt'), contention.join('\n') + '\n');
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ id: o.id, what: o.what, requests: o.requests, settings: o.settings, variants: o.variants.map((v) => ({ name: v.name, args: v.args, build: buildOf.get(v.name), files: v.files.length, bytes: v.files.reduce((s, f) => s + f.size, 0) })), machine: os.hostname(), cpus: os.cpus().length, cpu: os.cpus()[0]?.model, memGB: Math.round(os.totalmem() / 1024 ** 3), legs }, null, 2));
    const files: { name: string; file: string }[] = [];
    const walk = (rel: string) => {
      for (const e of fs.readdirSync(path.join(runDir, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(r);
        else files.push({ name: `${o.id}/${r}`, file: path.join(runDir, r) });
      }
    };
    walk('');
    const tar = path.join(root, 'timing', 'runs', `${o.id}.tar.gz`);
    await writeTarGz(files, tar);
    const st = fs.statSync(tar);
    const sha256 = await sha256Of(tar);
    const ready = new Promise<{ uploadId: string; chunkBytes?: number }>((resolve, reject) => {
      this.uploads.set(o.id, resolve);
      setTimeout(() => reject(new Error('the portal opened no upload for the results in 10 minutes')), 600_000).unref();
    });
    const ok = legs.some((l) => l.ok);
    this.d.send({ type: 'timed_run_done', id: o.id, ok, ...(ok ? {} : { error: 'no leg produced numbers (see each leg\'s note)' }), summary, legs, result: { name: `timed-${o.id}.tar.gz`, size: st.size, sha256 } });
    this.status(o.id, 'uploading', `sending the logs (${mb(st.size)})`);
    try {
      const u = await ready;
      const url = `${this.d.portalUrl.replace(/\/+$/, '')}/machine/attachments/uploads/${encodeURIComponent(u.uploadId)}`;
      const body = await sendChunks(url, this.d.token, tar, st.size, u.chunkBytes, {}, (b) => !!b.attachment);
      this.d.send({ type: 'timed_run_result', id: o.id, attachmentId: String((body.attachment as { id: string }).id) });
    } catch (e) {
      this.d.send({ type: 'timed_run_result', id: o.id, error: (e as Error).message });
    } finally {
      this.uploads.delete(o.id);
      trimCache(cache, this.d.cacheMaxBytes ?? 8 * 1024 ** 3, new Set(want.keys()));
      trimRuns(path.join(root, 'timing', 'runs'), 10);
    }
  }

  /** Wait while a person plays here (w1894), saying so every 20 looks. */
  private async personWait(o: TimedRunOrder, when: string, poll: number) {
    for (let waited = 0; this.d.personBusy(); waited++) {
      if (waited % 20 === 0) this.status(o.id, 'waiting', `paused ${when}: ${this.d.personBusy()}`);
      await sleep(poll);
    }
  }

  /**
   * A worker computer's turns (w1996): take the exclusive timing ticket through the bench queue, borrow a free sandbox
   * pair, play the legs that fit in the turn (TURN_PLAN_MS, by the longest leg so far), give the pair and the ticket back,
   * and queue again for the rest. A revoked turn (the queue's limit, an urgent release) ends the turn after its leg; the
   * rest are played in the next one.
   */
  private async workerTurns(
    o: TimedRunOrder,
    w: TimedWorkerDeps,
    order: { variant: string; round: number }[],
    x: { buildOf: Map<string, number>; buildDirs: string[]; buildFiles: Map<number, TimedVariant['files']>; saveName: string; runDir: string; contention: string[]; legs: LegSummary[]; poll: number },
  ) {
    const owner = (w.owner ?? spawnOwner)();
    const plan = w.turnPlanMs ?? TURN_PLAN_MS;
    const slotsRoot = w.slotsRoot ?? path.join(this.d.root, 'players');
    let longest = legTimeoutS(o.settings) * 1000;
    let seen = false;
    let next = 0;
    try {
      for (let turn = 1; next < order.length; turn++) {
        await this.personWait(o, 'before its turn', x.poll);
        const t = w.ticket({ what: `timed run ${o.id}: ${o.what}`, session: o.session, maxMin: 30, ownerPid: owner.pid });
        if (!t.ticket) throw new Error(`no bench queue ticket here: ${t.why ?? 'unknown'}`);
        const ticket = t.ticket;
        let pair: BorrowedPair | undefined;
        try {
          this.status(o.id, 'waiting', `turn ${turn}: queued for this computer's exclusive bench ticket (${order.length - next} legs left)`);
          const s = await ticket.wait(Infinity, (line) => this.status(o.id, 'waiting', `turn ${turn}: ${line}`.slice(0, 280)));
          if (s.kind !== 'granted') throw new Error(`the bench queue did not grant the ticket: ${s.line}`);
          // The turn's quiet machine (BenchTurn) asks the other players to quit; their leases end with them.
          // A pair whose player folder cannot be replaced (a player still runs from it, which Windows refuses) is given
          // back and skipped for this turn; the others are tried, then the busy ones again, for 5 minutes.
          const busy = new Set<string>();
          for (let waited = 0; ; waited++) {
            pair = borrowPair(slotsRoot, w.sandboxIds().filter((id) => !busy.has(id)), x.buildDirs.length, { ownerPid: owner.pid, run: o.id, session: o.session });
            if (pair) {
              try {
                for (let i = 0; i < x.buildDirs.length; i++) linkInto(x.buildDirs[i], pair.slots[i], x.buildFiles.get(i)!, fs.readFileSync(path.join(x.buildDirs[i], '.timed-build'), 'utf8').trim(), o.id);
                break;
              } catch (e) {
                for (const f of pair.leases) fs.rmSync(f, { force: true });
                busy.add(pair.sandbox);
                this.status(o.id, 'waiting', `turn ${turn}: ${pair.sandbox}'s player slots are in use (${(e as Error).message.slice(0, 120)}); trying another`);
                pair = undefined;
                continue;
              }
            }
            if (waited * x.poll > 5 * 60_000) throw new Error(`no sandbox's player-slot pair here came free within 5 minutes of the turn (${w.sandboxIds().join(', ')})`);
            if (waited % 4 === 0) this.status(o.id, 'waiting', `turn ${turn}: holds ${s.ticket}; waiting for a free player-slot pair`);
            busy.clear();
            await sleep(x.poll);
          }
          const start = Date.now();
          let ran = 0;
          this.status(o.id, 'running', `turn ${turn}: holds the exclusive bench ticket ${s.ticket}, legs in ${pair.sandbox}'s player slots: ${order.length - next} legs left`);
          while (next < order.length) {
            // a turn plays at least one leg; another only when, by the longest leg so far, it ends within the plan
            if (ran > 0 && Date.now() - start + longest > plan) break;
            if (ticket.state().kind !== 'granted') break;
            const leg = order[next];
            const v = o.variants.find((y) => y.name === leg.variant)!;
            await this.personWait(o, `before ${leg.variant} round ${leg.round}`, x.poll);
            const t0 = Date.now();
            x.legs.push(await this.leg(o, v, leg.round, path.join(pair.slots[x.buildOf.get(v.name)!], 'player', PLAYER_EXE), x.saveName, x.runDir, x.contention));
            longest = seen ? Math.max(longest, Date.now() - t0) : Date.now() - t0;
            seen = true;
            next++;
            ran++;
            if (ticket.state().kind !== 'granted') {
              x.contention.push(`${new Date().toISOString()} turn ${turn} ended by the bench queue after ${leg.variant} round ${leg.round}: ${ticket.state().line}`);
              break;
            }
          }
        } finally {
          for (const f of pair?.leases ?? []) fs.rmSync(f, { force: true });
          ticket.release();
        }
        if (next < order.length) this.status(o.id, 'waiting', `turn ${turn} gave its ticket back after ${next} of ${order.length} legs (a turn is at most 30 minutes, w1832); queued again for the rest`);
      }
    } finally {
      owner.end();
    }
  }

  /** One leg: the quiet wait, the player with its fixed arguments and time bound, its CPU every 2 s, its numbers. */
  private async leg(o: TimedRunOrder, v: TimedVariant, round: number, exe: string, saveName: string, runDir: string, contention: string[]): Promise<LegSummary> {
    const out = path.join(runDir, v.name, `round${round}`);
    fs.mkdirSync(out, { recursive: true });
    // Quiet: other load on this machine under 25% for 5 s, waiting 2 minutes at most (quiet_gate.sh waits 5 and goes on).
    let load = 100;
    for (let i = 0; i < 24 && (load = await cpuLoad(this.d.pollMs ? 10 : 5000)) >= 25; i++);
    const mem = () => Math.round(100 * (1 - os.freemem() / os.totalmem()));
    contention.push(`${new Date().toISOString()} ${v.name} round ${round} start: cpu=${load.toFixed(0)}% ram=${mem()}%${load >= 25 ? ' (still busy after 2 minutes: ran anyway)' : ''}`);
    const logFile = path.join(out, 'player.log');
    const args = legArgs(o.settings, v, round, saveName, logFile);
    const inputBefore = this.d.lastInputAt?.();
    const start = Date.now();
    const csv = [`"time","cpuPct","memPct"`];
    let running = true;
    const sampler = (async () => {
      while (running) {
        const c = await cpuLoad(this.d.pollMs ? 10 : 2000);
        csv.push(`"${new Date().toISOString()}",${c.toFixed(1)},${mem()}`);
      }
    })();
    // w1996: the asking worker's session, so a worker computer's bench turn (machine/benchTurn.ts) spares the run's own player
    const env = { ...process.env, FF_SESSION_ID: o.session };
    const child = (this.d.spawnPlayer ?? ((e, a, cwd) => spawn(e, a, { cwd, env, stdio: 'ignore', windowsHide: false })))(exe, args, path.dirname(exe));
    const bound = legTimeoutS(o.settings) * 1000;
    const code = await new Promise<number | string>((resolve) => {
      const timer = setTimeout(() => {
        if (child.pid && process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        else child.kill('SIGKILL');
        resolve('timeout');
      }, bound);
      child.on('error', (e) => (clearTimeout(timer), resolve(`error: ${e.message}`)));
      child.on('exit', (c) => (clearTimeout(timer), resolve(c ?? -1)));
    });
    running = false;
    await sampler;
    const seconds = Math.round((Date.now() - start) / 1000);
    fs.writeFileSync(path.join(out, 'cpu.csv'), csv.join('\n') + '\n');
    fs.writeFileSync(path.join(out, 'launch.txt'), `${exe} ${args.join(' ')}\nexit ${code} after ${seconds} s\n`);
    contention.push(`${new Date().toISOString()} ${v.name} round ${round} end after ${seconds}s: exit ${code}`);
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    const nums = perfSummaryOf(log);
    const cpus = csv.slice(1).map((l) => Number(l.split(',')[1])).filter(Number.isFinite);
    const inputAfter = this.d.lastInputAt?.();
    const touched = inputAfter !== undefined && inputAfter !== inputBefore && inputAfter >= start;
    const note = code === 'timeout' ? `ended at its ${Math.round(bound / 1000)} s bound` : typeof code === 'string' ? code : !nums ? `no PerfSummary in player.log (exit ${code})` : touched ? 'a person used this computer during the leg' : undefined;
    return { variant: v.name, round, ok: !!nums && code !== 'timeout', seconds, ...(nums ?? {}), ...(cpus.length ? { cpuPct: cpus.reduce((a, b) => a + b, 0) / cpus.length } : {}), ...(note ? { note } : {}) };
  }
}

async function sha256Of(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const c of fs.createReadStream(file)) h.update(c as Buffer);
  return h.digest('hex');
}

/** Keep the newest `keep` runs' folders and archives. */
function trimRuns(dir: string, keep: number) {
  const ids = fs.readdirSync(dir).filter((n) => !n.endsWith('.tar.gz')).map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const x of ids.slice(keep)) {
    fs.rmSync(path.join(dir, x.n), { recursive: true, force: true });
    fs.rmSync(path.join(dir, `${x.n}.tar.gz`), { force: true });
  }
}
