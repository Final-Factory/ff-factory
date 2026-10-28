// timed_run on the portal (w1946; docs/machines.md, "A play-only timing machine"). lothsahn, 2026-10-23: "Can the portal
// do builds on one machine and then use this other with an exclusive lock for benchmarks?", then "File it: play-only
// timing machine, builds elsewhere, exclusive lock there", within "I don't want a unilateral way into machines... just
// build scoped commands for the functionality needed".
//
// Three named steps and nothing else: the worker's daemon asks for a plan (which pieces of its builds the portal lacks;
// machine/timedRunPack.ts) and sends those as attachments over its own link; `go` hands the run, as data, to a play-only
// computer's daemon (`timed_run`, machine/timedRunner.ts), which plays the fixed legs under its own exclusive bench ticket;
// its logs come back as one attachment, which goes to the worker with the table in a message. No command, script or path
// of the worker's reaches the timing machine: the order names pieces by hash, a save, -ff switches and bounded numbers.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { AttachmentStore } from './attachments.ts';
import { publicRef } from './attachments.ts';
import { readJsonDurable, writeJsonDurable } from './durable.ts';
import type { AttachmentRef, Machine } from '../shared/types.ts';
import { legOrder, MAX_VARIANTS, PIECE_MAX_BYTES, runBoundMinutes, timedArgsProblem, timedSettingsOf, variantNameProblem, type LegSummary, type Piece, type TimedRunOrder, type TimedSettings, type TimedVariant } from '../shared/timedRun.ts';

export type TimedRunState = 'uploading' | 'queued' | 'sent' | 'running' | 'done' | 'failed';

export interface TimedRunRecord {
  id: string;
  session: string;
  requests: string[];
  what: string;
  /** The worker's computer, which sends the pieces. */
  from: string;
  /** The play-only computer that runs it. */
  machine: string;
  state: TimedRunState;
  /** What its daemon last said ("fetching 12 of 40 pieces", "holds the exclusive bench ticket t00000003"). */
  line?: string;
  createdAt: string;
  updatedAt: string;
  /** Until it is done: what the timing machine gets. */
  order?: TimedRunOrder;
  /** Each upload the plan opened, by its id: the piece's SHA-256. */
  uploads?: Record<string, string>;
  sentBytes?: number;
  totalBytes?: number;
  legs?: LegSummary[];
  summary?: string;
  result?: string;
  error?: string;
  /** w2048: the computers it left because each stayed unavailable past the wait, with why ("lothlaptop offline 64 min"). */
  movedFrom?: string[];
  /** w2048: when its worker was told that its computer is gone past the wait and no other takes the run. */
  toldStuck?: string;
  /** w2411: its rounds, kept for its result's message once the order is gone (a later delivery builds it again). */
  rounds?: number;
  /** w2411: the worker its result went to (`moved`: its request moved there from the worker that filed it), and the message. */
  delivered?: { to: string; at: string; moved?: boolean; uuid?: string };
  /** w2411: a result no worker holds a request of now: kept here and handed to the next worker its request gets (tick). */
  undelivered?: { since: string; why: string };
  /** w2414: when its daemon could not fetch its pieces (the portal had lost their grant) and the portal sent it again once. */
  refetched?: string;
}

/**
 * w2411: where a message about a run went. Void: to the worker that filed it (the old contract). `to`: that worker, the
 * message's id in its conversation or send queue; `keep`: no worker holds its request now, so a result waits for one.
 */
export type TimedDelivery = void | { to: string; moved?: boolean; uuid?: string } | { keep: string };

/** How long a result waits for a worker on its request before it is given up (w2411); its logs stay as long as the store keeps them. */
export const UNDELIVERED_KEEP_MS = 3 * 86_400_000;

export interface TimedRunDeps {
  dataDir: string;
  store: AttachmentStore;
  machines: () => Machine[];
  isOnline: (id: string) => boolean;
  /** Whether its daemon's hello offered timed runs. */
  offers: (id: string) => boolean;
  post: (id: string, msg: unknown) => boolean;
  /**
   * Message the worker (the table, and the logs as an attachment when there are some). w2411: `run` names the run and its
   * requests, so the message goes to the worker on the request now (server/timedDelivery.ts), not only to `session`, the
   * one that filed it; `result` marks the run's result, which is kept when no worker holds its request.
   */
  deliver: (session: string, text: string, files: AttachmentRef[], run?: { id: string; requests: string[]; result?: boolean }) => Promise<TimedDelivery>;
  /** w2411: a line for each of the run's requests' logs (a run that can never report, a result given up). */
  note?: (requests: string[], line: string) => void;
  log?: (line: string) => void;
  now?: () => number;
  /**
   * w1996: which other computers take a timed run beside the play-only ones: a small worker computer that takes timed runs
   * (at most SMALL_TIMED_MAX_AGENTS agent slots, never m5), with its agent slots for the order. Default: none.
   */
  smallWorker?: (m: Machine) => { agents: number } | undefined;
  /**
   * w1996: why a person holds a computer (placement.hold, a tray pause: holdReason), or undefined. A held computer is shown
   * but never picked for a new run (lothsahn holds LothLaptop while he uses it; an exclusive turn would close his editor).
   */
  held?: (id: string) => string | undefined;
  /**
   * w2048: how long a run waits for its computer while that one is unavailable (offline, or not on a daemon that runs timed
   * runs) before it moves to another and plays every build there again, the baseline included (timedAsk.ts unavailableWait:
   * scaled by the fleet's load). Default: never moves.
   */
  unavailableWait?: () => { ms: number; why: string };
}

/** What kind of timing computer a target is (w1996): one that only plays the game, or a small worker computer. */
export type TimedTargetKind = 'play-only' | 'small';

export interface TimedTarget {
  id: string;
  kind: TimedTargetKind;
  online: boolean;
  offers: boolean;
  runs: TimedRunRecord[];
  why: string;
  platform?: string;
  agents: number;
  /** A person's hold on it (deps.held): no new run goes there until it is lifted. */
  held?: string;
}

/**
 * The order targets are picked in when none is named (w1996): computers nobody holds first, then online ones that run timed runs, play-only before
 * small worker computers (a play-only turn idles nobody), then the fewest runs ahead, the fewest agent slots, the id.
 */
export function rankTargets(all: readonly TimedTarget[]): TimedTarget[] {
  const key = (t: TimedTarget) => [t.held ? 1 : 0, t.online && t.offers ? 0 : 1, t.kind === 'play-only' ? 0 : 1, t.runs.length, t.agents];
  return [...all].sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return a.id.localeCompare(b.id);
  });
}

/** A piece nobody used for this long leaves the portal's store (the timing machine keeps its own copies). */
export const PIECE_KEEP_MS = 3 * 86_400_000;
/** Runs kept on record after they ended. */
const KEEP_RUNS = 50;
const SHA = /^[0-9a-f]{64}$/;

/** Whether a computer is play-only (w1946): it takes timed runs and no worker. */
export const isPlayOnly = (m: Pick<Machine, 'playOnly'>) => !!m.playOnly?.trim();

interface Saved {
  runs: TimedRunRecord[];
  /** Each piece the portal holds: its attachment id and when a run last used it. */
  pieces: Record<string, { id: string; usedAt: string }>;
}

/** Why a variant from the worker's daemon is refused, or undefined (the timing machine checks the paths again). */
export function variantProblem(v: TimedVariant): string | undefined {
  const name = variantNameProblem(v?.name);
  if (name) return name;
  const args = timedArgsProblem(v.args);
  if (args) return `${v.name}: ${args}`;
  if (!Array.isArray(v.files) || !v.files.length || !Array.isArray(v.pieces) || !v.pieces.length) return `${v.name}: no files`;
  const sizes = new Map<string, number>();
  for (const f of v.files) {
    const p = String(f?.path ?? '');
    if (!p || p.length > 240 || p.startsWith('/') || /(^|\/)\.\.?(\/|$)|\\|:|\0/.test(p) || !Number.isSafeInteger(f.size) || f.size < 0) return `${v.name}: a bad file entry (${p.slice(0, 60)})`;
    sizes.set(p, f.size);
  }
  if (!sizes.has('finalfactory.exe')) return `${v.name}: no finalfactory.exe at the build's top`;
  const covered = new Map<string, number>();
  for (const pc of v.pieces as Piece[]) {
    if (!SHA.test(String(pc?.sha256)) || !Number.isSafeInteger(pc.size) || pc.size <= 0 || pc.size > PIECE_MAX_BYTES || !Array.isArray(pc.parts)) return `${v.name}: a bad piece`;
    let sum = 0;
    for (const part of pc.parts) {
      const size = sizes.get(String(part?.path));
      if (size === undefined || !Number.isSafeInteger(part.offset) || !Number.isSafeInteger(part.length) || part.offset < 0 || part.length < 0 || part.offset + part.length > size) return `${v.name}: a piece names a file outside the build or past its end`;
      sum += part.length;
      covered.set(part.path, (covered.get(part.path) ?? 0) + part.length);
    }
    if (sum !== pc.size) return `${v.name}: a piece's parts do not add up to its size`;
  }
  for (const [p, size] of sizes) if ((covered.get(p) ?? 0) !== size) return `${v.name}: ${p} is not wholly in its pieces`;
  return undefined;
}

/** w2414: the daemon's words when the portal refuses it a piece (machine/attachments.ts fetchAttachment). */
const NO_GRANT = /no such attachment for this machine/;

export class TimedRuns {
  private readonly file: string;
  private readonly d: TimedRunDeps;
  private readonly runs = new Map<string, TimedRunRecord>();
  private pieces: Saved['pieces'] = {};

  constructor(d: TimedRunDeps) {
    this.d = d;
    this.file = path.join(d.dataDir, 'timed-runs.json');
    const saved = readJsonDurable<Saved>(this.file);
    for (const r of saved?.runs ?? []) this.runs.set(r.id, r);
    this.pieces = saved?.pieces ?? {};
  }

  private now = () => (this.d.now ?? Date.now)();
  private iso = () => new Date(this.now()).toISOString();

  private save() {
    const ended = [...this.runs.values()].filter((r) => (r.state === 'done' || r.state === 'failed') && !r.undelivered).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    for (const r of ended.slice(KEEP_RUNS)) this.runs.delete(r.id);
    writeJsonDurable(this.file, { runs: [...this.runs.values()], pieces: this.pieces } satisfies Saved, { indent: 1 });
  }

  get(id: string) {
    return this.runs.get(id);
  }

  list(): TimedRunRecord[] {
    return [...this.runs.values()];
  }

  /** The runs a computer holds now (sent, queued or running there). */
  runsOn(id: string): TimedRunRecord[] {
    return this.list().filter((r) => r.machine === id && r.state !== 'done' && r.state !== 'failed');
  }

  /**
   * The computers a timed run can go to, for the Capacity block, timed_place and the tool: the play-only ones (w1946) and,
   * since w1996, the small worker computers that take timed runs (deps.smallWorker), each with its state and its runs.
   */
  targets(): TimedTarget[] {
    const out: TimedTarget[] = [];
    for (const m of this.d.machines()) {
      const small = isPlayOnly(m) ? undefined : this.d.smallWorker?.(m);
      if (!isPlayOnly(m) && !small) continue;
      const held = this.d.held?.(m.id);
      out.push({ ...(held ? { held } : {}), id: m.id, kind: isPlayOnly(m) ? 'play-only' : 'small', online: this.d.isOnline(m.id), offers: this.d.offers(m.id), why: isPlayOnly(m) ? m.playOnly!.trim() : `a small worker computer (${small!.agents} agent slot${small!.agents === 1 ? '' : 's'})`, runs: this.runsOn(m.id), ...(m.platform ? { platform: m.platform } : {}), agents: small?.agents ?? 0 });
    }
    return out;
  }

  /** The Windows targets in pick order (rankTargets): a timed run plays Windows players (probe_ab_win.sh's legs). */
  windowsTargets(): TimedTarget[] {
    return rankTargets(this.targets().filter((t) => t.platform !== 'darwin' && t.platform !== 'linux'));
  }

  /**
   * Where a run goes: the computer named, else the computer the same request's (or session's) last run used when it can take
   * one now (w2048, lothsahn: "Timings can't be compared across machines at all": a second run elsewhere would not compare
   * with the first), else the first Windows target (rankTargets).
   */
  private target(named: unknown, who?: { session: string; requests: string[] }): string {
    const all = this.windowsTargets();
    if ((named === undefined || named === '') && who) {
      const prev = this.list()
        .filter((r) => r.session === who.session || r.requests.some((q) => who.requests.includes(q)))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
      const t = prev && all.find((x) => x.id === prev.machine);
      if (t && t.online && t.offers && !t.held) return t.id;
    }
    if (named !== undefined && named !== '') {
      const t = all.find((x) => x.id.toLowerCase() === String(named).toLowerCase());
      if (!t) throw new Error(`${String(named)} takes no timed run (w1946, w1996: a play-only computer, or a small worker computer that takes timed runs, on Windows: a run plays Windows players); the ones that do: ${all.map((x) => x.id).join(', ') || 'none yet'}`);
      if (t.held) throw new Error(`${t.id} is held (${t.held}): no timed run goes there until the hold is lifted; leave machine unset for the next one, or call timed_place again with via "leg"`);
      return t.id;
    }
    const first = all.find((x) => !x.held);
    if (!first && all.length) throw new Error(`every computer that takes a timed run is held now (${all.map((x) => `${x.id}: ${x.held}`).join('; ')}); call timed_place again with via "leg"`);
    if (first) return first.id; // offline: the run waits for it, and the answer says so
    throw new Error('no computer takes a timed run now (w1946, w1996: a play-only computer, or a small Windows worker computer that takes timed runs); time on your own computer with the bench queue instead (scripts/bench/probe_ab_win.sh)');
  }

  /** The plan step: check the builds, open an upload for each piece the portal lacks. Answers JSON for the daemon. */
  plan(from: string, who: { session: string; requests: string[]; what: string; uploadedBy?: string }, a: Record<string, unknown>): string {
    const variants = (Array.isArray(a.variants) ? a.variants : []) as TimedVariant[];
    if (!variants.length || variants.length > MAX_VARIANTS) throw new Error(`builds: 1 to ${MAX_VARIANTS}`);
    for (const v of variants) {
      const why = variantProblem(v);
      if (why) throw new Error(`builds: ${why}`);
    }
    if (new Set(variants.map((v) => v.name)).size !== variants.length) throw new Error('builds: each name once');
    const settings = timedSettingsOf(a);
    if (typeof settings === 'string') throw new Error(settings);
    const s = a.save as { name?: unknown; size?: unknown; sha256?: unknown } | undefined;
    if (!s || !SHA.test(String(s.sha256)) || !Number.isSafeInteger(s.size) || Number(s.size) <= 0 || Number(s.size) > PIECE_MAX_BYTES) throw new Error('save: a .zip save of at most 64 MB');
    const machine = this.target(a.machine, who);
    const id = `tr_${randomBytes(5).toString('hex')}`;
    const need = new Map<string, number>();
    for (const v of variants) for (const p of v.pieces) need.set(p.sha256, p.size);
    need.set(String(s.sha256), Number(s.size));
    const uploads: Record<string, string> = {};
    const out: { sha256: string; uploadId: string; chunkBytes: number }[] = [];
    let total = 0;
    for (const [sha, size] of need) {
      total += size;
      const have = this.pieces[sha];
      if (have && this.d.store.get(have.id)?.sha256 === sha) continue;
      const u = this.d.store.begin({ name: `timed-piece-${sha.slice(0, 16)}`, size, sha256: sha, machineId: from, source: `timed run ${id} (${who.what})`, ...(who.uploadedBy ? { uploadedBy: who.uploadedBy } : {}) });
      uploads[u.uploadId] = sha;
      out.push({ sha256: sha, uploadId: u.uploadId, chunkBytes: u.chunkBytes });
    }
    const order: TimedRunOrder = { id, what: who.what, requests: who.requests, session: who.session, variants: variants.map((v) => ({ name: v.name, args: v.args ?? [], files: v.files, pieces: v.pieces })), save: { id: '', name: String(s.name ?? 'save.zip').slice(0, 120), size: Number(s.size), sha256: String(s.sha256) }, pieceIds: {}, settings };
    this.runs.set(id, { id, session: who.session, requests: who.requests, what: who.what, from, machine, state: 'uploading', createdAt: this.iso(), updatedAt: this.iso(), order, uploads, totalBytes: total });
    this.save();
    this.d.log?.(`timed run ${id}: ${who.what} from ${from} for ${machine}: ${variants.length} builds, ${out.length} of ${need.size} pieces to send`);
    return JSON.stringify({ runId: id, machine, uploads: out });
  }

  /** The go step: every piece is in the store; hand the run to its machine (or queue it until that one is online). */
  go(session: string, a: Record<string, unknown>): string {
    const r = this.runs.get(String(a.runId ?? ''));
    if (!r || r.session !== session) throw new Error('no such timed run of yours (plan it again: call timed_run)');
    if (r.state !== 'uploading' || !r.order) throw new Error(`timed run ${r.id} is ${r.state} already`);
    const uploaded = (a.uploaded ?? {}) as Record<string, unknown>;
    for (const sha of Object.values(r.uploads ?? {})) {
      const rec = this.d.store.get(String(uploaded[sha] ?? ''));
      if (rec?.sha256 !== sha) throw new Error(`timed run ${r.id}: piece ${sha.slice(0, 12)}… did not arrive; call timed_run again`);
      this.pieces[sha] = { id: rec.id, usedAt: this.iso() };
    }
    const o = r.order;
    const shas = new Set([...o.variants.flatMap((v) => v.pieces.map((p) => p.sha256))]);
    for (const sha of shas) {
      const have = this.pieces[sha];
      if (!have || this.d.store.get(have.id)?.sha256 !== sha) throw new Error(`timed run ${r.id}: piece ${sha.slice(0, 12)}… is not on the portal; call timed_run again`);
      o.pieceIds[sha] = have.id;
      have.usedAt = this.iso();
    }
    const save = this.pieces[o.save.sha256];
    if (!save || this.d.store.get(save.id)?.sha256 !== o.save.sha256) throw new Error(`timed run ${r.id}: the save did not arrive; call timed_run again`);
    o.save.id = save.id;
    save.usedAt = this.iso();
    r.sentBytes = Number(a.sentBytes) || 0;
    delete r.uploads;
    this.set(r, 'queued', 'waiting for its machine');
    this.dispatch(r);
    const legs = legOrder(o.variants.map((v) => v.name), o.settings.rounds).length;
    const bound = runBoundMinutes(o.settings, o.variants.length);
    const mb = (n: number) => `${(n / 1024 ** 2).toFixed(0)} MB`;
    const where = (r.state as TimedRunState) === 'sent' ? `handed to ${r.machine}` : `queued for ${r.machine}, which is ${this.d.isOnline(r.machine) ? 'connected but not on a daemon that runs timed runs yet (it is updated by itself once idle)' : 'offline'}: it starts when ${r.machine} is back`;
    return `Timed run ${r.id} ${where}: ${o.variants.map((v) => v.name).join(' vs ')}, ${legs} legs of ${o.settings.settleS} s settle + ${o.settings.sampleS} s sample on ${o.settings.res}, under ${r.machine}'s exclusive bench ticket. Sent ${mb(r.sentBytes)} of ${mb(r.totalBytes ?? 0)} (the rest was on the portal from earlier runs). FF Factory messages you with the table and the logs (timed-${r.id}.tar.gz in your Inbox: probe_ab_win.sh's layout, so scripts/bench/probe_table.py and ab_stop.py read it) when it ends; its bound is about ${bound} min. End your turn now with a wake_me check-in of ${bound + 15} minutes as the fallback; do not wait in the foreground.`;
  }

  private set(r: TimedRunRecord, state: TimedRunState, line?: string) {
    r.state = state;
    if (line !== undefined) r.line = line;
    r.updatedAt = this.iso();
    this.save();
  }

  /** Send a queued run to its machine when it is online and runs timed runs. */
  private dispatch(r: TimedRunRecord) {
    if (r.state !== 'queued' || !r.order || !this.d.isOnline(r.machine) || !this.d.offers(r.machine)) return;
    // w2411: a queued run waits for its computer whoever holds its request; it ends only when what it plays is gone
    const gone = this.goneFrom(r.order);
    if (gone) {
      r.error = `the build it needs is gone from the portal (${gone}), so it can never run; call timed_run again to send the builds`;
      this.d.note?.(r.requests, `timed run ${r.id} for ${r.machine} FAILED before it started: ${r.error}. Nobody waits on it any more.`);
      this.d.log?.(`timed run ${r.id}: ${r.error}`);
      void this.finish(r, 'failed');
      return;
    }
    this.grantPieces(r);
    if (this.d.post(r.machine, { type: 'timed_run', order: r.order })) this.set(r, 'sent', `sent to ${r.machine}`);
  }

  /**
   * w2414: let a run's machine fetch its pieces and save. Grants live in the portal's memory for 6 h (attachments.ts
   * GRANT_MS), and a daemon fetches a run's pieces only when the run's turn comes, so a portal restart, or a long wait
   * behind other runs, left tr_e93675645e's pieces refused ("no such attachment for this machine"). So every hello and
   * every report of a run still going grants them again.
   */
  private grantPieces(r: TimedRunRecord) {
    if (r.order) this.d.store.grant(r.machine, [...Object.values(r.order.pieceIds), r.order.save.id]);
  }

  /** w2411: what of a run's order the portal's store no longer has (its pieces and save, by sha), or undefined. */
  private goneFrom(o: TimedRunOrder): string | undefined {
    const want: [string, string][] = [...Object.entries(o.pieceIds), [o.save.sha256, o.save.id]];
    const gone = want.filter(([sha, id]) => this.d.store.get(id)?.sha256 !== sha);
    if (!gone.length) return undefined;
    return `${gone.length} of its ${want.length} pieces deleted, ${gone.slice(0, 3).map(([sha]) => `${sha.slice(0, 12)}…`).join(', ')}${gone.some(([sha]) => sha === o.save.sha256) ? ', the save among them' : ''}`;
  }

  /** A daemon said hello: what it runs now; runs sent to it before and not among them are sent again (it restarted). */
  onHello(machineId: string, active: string[] | undefined) {
    // w2218: a run its daemon still holds that the portal no longer waits for there (finished, failed, moved or unknown)
    // is stopped, so its ticket goes back whether or not the worker that sent it is still there to notice.
    for (const id of active ?? []) {
      const why = this.notHere(machineId, id);
      if (why) this.cancelOn(machineId, id, why);
    }
    for (const r of this.runs.values()) {
      if (r.machine !== machineId) continue;
      // w2414: a run its daemon still holds (queued there behind others) fetches its pieces later: its grant may be gone
      if (r.state === 'sent' || r.state === 'running') this.grantPieces(r);
      if ((r.state === 'sent' || r.state === 'running') && !(active ?? []).includes(r.id)) this.set(r, 'queued', `${machineId}'s daemon restarted: sent again`);
      if (r.state === 'queued') this.dispatch(r);
    }
  }

  /** What a timing machine's daemon reports of a run. */
  onReport(machineId: string, m: { type: string; id?: string; state?: string; line?: string; ok?: boolean; error?: string; summary?: string; legs?: LegSummary[]; result?: { name?: string; size?: number; sha256?: string }; attachmentId?: string }) {
    const r = this.runs.get(String(m.id ?? ''));
    if (!r || r.machine !== machineId || r.state === 'done' || r.state === 'failed') {
      // w2218: a run still reporting progress that the portal no longer waits for there is stopped (its ticket goes back)
      const why = m.type === 'timed_run_status' && m.state !== 'uploading' ? this.notHere(machineId, String(m.id ?? '')) : undefined;
      if (why) this.cancelOn(machineId, String(m.id), why);
      return;
    }
    if (m.type === 'timed_run_status') {
      if (r.state !== 'uploading') this.grantPieces(r);
      this.set(r, m.state === 'running' ? 'running' : r.state === 'queued' ? 'sent' : r.state, String(m.line ?? '').slice(0, 300));
      return;
    }
    if (m.type === 'timed_run_done') {
      // w2414: its daemon was refused its pieces (a grant the portal lost) while the portal still has them: send it once
      // more, granted, rather than fail a run that never played; a second refusal fails it with words that say to redo it
      if (m.ok !== true && NO_GRANT.test(String(m.error ?? '')) && r.order && !this.goneFrom(r.order)) {
        if (!r.refetched) {
          r.refetched = this.iso();
          this.d.log?.(`timed run ${r.id}: ${machineId} could not fetch its pieces (${String(m.error).slice(0, 120)}); granted and sent again`);
          this.set(r, 'queued', `its pieces were refused to ${machineId}: granted and sent again`);
          this.dispatch(r);
          return;
        }
        m.error = `${String(m.error).slice(0, 200)}; it never played, twice: call timed_run again to redo it`;
      }
      r.legs = Array.isArray(m.legs) ? m.legs.slice(0, 200) : [];
      r.summary = String(m.summary ?? '').slice(0, 20_000);
      if (m.error) r.error = String(m.error).slice(0, 500);
      const res = m.result;
      if (res && SHA.test(String(res.sha256)) && Number.isSafeInteger(res.size) && Number(res.size) > 0) {
        try {
          const u = this.d.store.begin({ name: `timed-${r.id}.tar.gz`, size: res.size, sha256: res.sha256, machineId, source: `timed run ${r.id} on ${machineId}` });
          this.d.post(machineId, { type: 'timed_run_upload', id: r.id, uploadId: u.uploadId, chunkBytes: u.chunkBytes });
          this.set(r, 'running', 'sending its logs');
          return;
        } catch (e) {
          r.error = `its logs could not come back: ${(e as Error).message}`;
        }
      }
      void this.finish(r, m.ok === true ? 'done' : 'failed');
      return;
    }
    if (m.type === 'timed_run_result') {
      const rec = m.attachmentId ? this.d.store.get(String(m.attachmentId)) : undefined;
      if (rec && rec.name === `timed-${r.id}.tar.gz`) r.result = rec.id;
      else r.error = [r.error, `its logs did not come back${m.error ? `: ${String(m.error).slice(0, 200)}` : ''}`].filter(Boolean).join('; ');
      void this.finish(r, r.legs?.some((l) => l.ok) ? 'done' : 'failed');
    }
  }

  /** w2218: why the portal no longer waits for run `id` on `machineId` (it never knew it, finished it or moved it), or undefined. */
  private notHere(machineId: string, id: string): string | undefined {
    if (!/^tr_[0-9a-f]{10}$/.test(id)) return undefined;
    const r = this.runs.get(id);
    if (!r) return 'the portal has no such run';
    if (r.machine !== machineId) return `the portal moved it to ${r.machine}`;
    if (r.state === 'done' || r.state === 'failed') return `the portal already ended it (${r.state}${r.error ? `: ${r.error.slice(0, 120)}` : ''})`;
    return undefined;
  }

  /**
   * w2442: stop run `id` at a worker's ask (lothsahn, 2026-10-28: "Stop w2434's timing run on LothLaptop now"). Before it
   * was sent it just ends; sent or running, its daemon is told to end its leg's player and give its ticket back
   * (machine/timedRunner.ts cancel), now or on its next hello. Its worker gets the usual FAILED result with `why`.
   * `may` says whether the asking worker may stop it; undefined when it may.
   */
  cancel(id: string, why: string, may: (r: TimedRunRecord) => string | undefined): string {
    const r = this.runs.get(id);
    if (!r) throw new Error(`the portal has no timed run ${id}`);
    const refused = may(r);
    if (refused) throw new Error(refused);
    if (r.state === 'done' || r.state === 'failed') return `timed run ${id} on ${r.machine} already ended (${r.state}${r.error ? `: ${r.error.slice(0, 120)}` : ''})`;
    const held = r.state === 'sent' || r.state === 'running';
    const was = r.state;
    r.error = `cancelled: ${why}`;
    this.d.log?.(`timed run ${id}: cancelled (w2442) while ${was} on ${r.machine}: ${why}`);
    void this.finish(r, 'failed');
    if (held) this.cancelOn(r.machine, r.id, `cancelled: ${why}`);
    return `timed run ${id} cancelled (it was ${was} on ${r.machine})${held ? `: ${r.machine}'s daemon ends its leg's player and gives its bench ticket back${this.d.isOnline(r.machine) ? ' now' : ' when it says hello'}` : ''}; its worker ${r.session.slice(0, 8)} is told why`;
  }

  /** w2218: tell `machineId`'s daemon to stop run `id` and give its ticket back (machine/timedRunner.ts cancel); an offline one is told on its hello. */
  private cancelOn(machineId: string, id: string, why: string) {
    const sent = this.d.isOnline(machineId) && this.d.post(machineId, { type: 'timed_run_cancel', id, why });
    this.d.log?.(`timed run ${id}: ${sent ? `told ${machineId} to stop it` : `${machineId} is told to stop it when it says hello`}: ${why}`);
  }

  /** Tell the worker how it went, with the logs. */
  private async finish(r: TimedRunRecord, state: 'done' | 'failed') {
    if (r.order) r.rounds = r.order.settings.rounds;
    delete r.order;
    this.set(r, state);
    await this.deliverResult(r);
  }

  /** The result's message (w2411: built again for a later delivery, so it is not kept). */
  private resultText(r: TimedRunRecord, rec: { id: string } | undefined): string {
    const legs = r.legs ?? [];
    const ok = legs.filter((l) => l.ok).length;
    return [
      `[timed run ${r.id} on ${r.machine}] ${r.state === 'done' ? 'done' : 'FAILED'}: ${ok} of ${legs.length} legs with numbers${r.error ? `; ${r.error}` : ''}.`,
      ...(r.summary ? ['', r.summary] : []),
      '',
      rec
        ? `The logs are in your Inbox as timed-${r.id}.tar.gz (attachment ${rec.id}; fetch_attachment gets it again): tar -xzf it into $TMPDIR, then python scripts/bench/probe_table.py "$TMPDIR/${r.id}"/*/round* (probe_ab_win.sh's layout; ab_stop.py reads it too). contention.txt has each leg's start load; run.json the machine and settings. Numbers are from ${r.machine} alone: compare them only with ${r.machine}'s own.`
        : 'No logs came back.',
      `It ran under ${r.machine}'s exclusive bench ticket${r.rounds ? ` (${r.rounds} rounds, order flipped on even rounds)` : ''}. If you set a wake_me check-in for it, cancel_wake it now.`,
      `Every number in it comes from ${r.machine}: compare them only with each other or with other runs on ${r.machine}, never with another computer's (w2048, lothsahn: "Timings can't be compared across machines at all"); your report names ${r.machine}.${r.movedFrom?.length ? ` It moved here from ${r.movedFrom.join('; ')}, so every build, the baseline included, was played again here.` : ''}`,
    ].join('\n');
  }

  /**
   * Hand an ended run's result to the worker on its request now (w2411), or keep it for the next one: tick() tries a kept
   * one again until a worker holds its request, for UNDELIVERED_KEEP_MS.
   */
  private async deliverResult(r: TimedRunRecord) {
    if (this.delivering.has(r.id)) return;
    this.delivering.add(r.id);
    const rec = r.result ? this.d.store.get(r.result) : undefined;
    let out: TimedDelivery;
    try {
      out = await this.d.deliver(r.session, this.resultText(r, rec), rec ? [publicRef(rec)] : [], { id: r.id, requests: r.requests, result: true });
    } catch (e) {
      // kept: tried again on the next tick, whoever holds its request then
      out = { keep: `its message could not be sent: ${(e as Error).message}` };
      this.d.log?.(`timed run ${r.id}: could not tell worker ${r.session}: ${(e as Error).message}`);
    }
    if (out && 'keep' in out) {
      if (!r.undelivered) this.d.log?.(`timed run ${r.id}: result kept for its request's next worker: ${out.keep}`);
      r.undelivered = { since: r.undelivered?.since ?? this.iso(), why: out.keep.slice(0, 300) };
    } else {
      r.delivered = { to: out?.to ?? r.session, at: this.iso(), ...(out?.moved ? { moved: true } : {}), ...(out?.uuid ? { uuid: out.uuid } : {}) };
      delete r.undelivered;
    }
    this.delivering.delete(r.id);
    this.save();
  }

  /** The runs whose result is on its way to a worker now (deliverResult), so a tick does not send it twice. */
  private readonly delivering = new Set<string>();

  /**
   * w2411: a message FF Factory dropped from a worker's send queue (its request had moved off that worker, w2079): when it
   * was a run's result, it goes again, to the worker on the request now. True when it was one.
   */
  dropped(uuid: string): boolean {
    if (!uuid) return false;
    const r = [...this.runs.values()].find((x) => x.delivered?.uuid === uuid);
    if (!r) return false;
    this.d.log?.(`timed run ${r.id}: its result to worker ${r.delivered!.to} was dropped (its request moved off it): sent again`);
    delete r.delivered;
    r.undelivered = { since: this.iso(), why: `its message to worker ${r.session} was dropped` };
    void this.deliverResult(r);
    return true;
  }

  /** A message about a run that is not its result (moved, stuck): to the worker on its request now; dropped when there is none. */
  private tell(r: TimedRunRecord, text: string) {
    void this.d.deliver(r.session, text, [], { id: r.id, requests: r.requests }).catch((e) => this.d.log?.(`timed run ${r.id}: could not tell worker ${r.session}: ${(e as Error).message}`));
  }

  /** When each target was first seen unavailable by tick (w2048); its offline time comes from Machine.lastSeen when known. */
  private unavailableSince = new Map<string, number>();

  /**
   * w2048 (lothsahn: "The dispatcher should have a rule to rerun the baseline if a machine is offline or unavailable too
   * long"): a run Queued for a computer unavailable past the wait (deps.unavailableWait, scaled by the fleet's load) moves to
   * the first other Windows target that is online, runs timed runs and is not held. The run's order holds every build, so
   * the baseline is played again there with the change and every number comes from the one computer; the worker is told
   * that its earlier numbers from the computer left behind do not compare. Returns the runs moved, for the log.
   */
  retarget(): string[] {
    const wait = this.d.unavailableWait?.();
    const now = this.now();
    const all = this.windowsTargets();
    for (const t of all) {
      if (t.online && t.offers) this.unavailableSince.delete(t.id);
      else if (!this.unavailableSince.has(t.id)) {
        const seen = Date.parse(this.d.machines().find((m) => m.id === t.id)?.lastSeen ?? '');
        this.unavailableSince.set(t.id, !t.online && Number.isFinite(seen) ? seen : now);
      }
    }
    if (!wait) return [];
    const moved: string[] = [];
    for (const r of this.runs.values()) {
      if (r.state !== 'queued' || !r.order) continue;
      const since = this.unavailableSince.get(r.machine);
      if (since === undefined || now - since < wait.ms) continue;
      const to = all.find((t) => t.id !== r.machine && t.online && t.offers && !t.held);
      const from = r.machine;
      const why = `${from} ${this.d.isOnline(from) ? 'connected but not running timed runs' : 'offline'} for ${Math.round((now - since) / 60_000)} min, past the wait of ${wait.why}`;
      if (!to) {
        // No other computer takes it: the worker may time it itself, on its big computer if need be (timed_place, w2048).
        if (r.toldStuck) continue;
        r.toldStuck = this.iso();
        this.set(r, 'queued', `waiting for ${from}: ${why}; no other computer takes a timed run now`);
        this.d.log?.(`timed run ${r.id}: stuck on ${from} (w2048): ${why}; no other target; worker told to ask timed_place`);
        this.tell(r, `[timed run ${r.id}] still queued for ${from}: ${why}, and no other computer that takes a timed run can take it now. It stays queued and goes out if ${from} comes back. To time it now instead, call timed_place again with via "leg": with no small computer available it answers "here", and you time every side on your own computer (all of its numbers from that one computer, the baseline re-measured there).`);
        continue;
      }
      r.movedFrom = [...(r.movedFrom ?? []), `${from}: ${why}`];
      r.machine = to.id;
      this.set(r, 'queued', `moved from ${from} (w2048): ${why}`);
      this.d.log?.(`timed run ${r.id}: moved from ${from} to ${to.id} (w2048 baseline re-run): ${why}`);
      this.tell(r, `[timed run ${r.id}] moved from ${from} to ${to.id} (w2048): ${why}. It plays every build again on ${to.id}, your baseline included, so all of its numbers come from ${to.id}. Compare them with no number measured on ${from} or any other computer (lothsahn: "Timings can't be compared across machines at all"); your report names ${to.id} as the computer they come from.`);
      this.dispatch(r);
      moved.push(r.id);
    }
    return moved;
  }

  /** Every few minutes: move a run off a computer gone too long (w2048), give up on a run far past its bound, and let old pieces go from the portal's store. */
  tick() {
    this.retarget();
    const now = this.now();
    for (const r of this.runs.values()) {
      if (r.state === 'done' || r.state === 'failed') continue;
      const s: TimedSettings | undefined = r.order?.settings;
      const bound = (s ? runBoundMinutes(s, r.order!.variants.length) : 60) + (r.state === 'uploading' ? 60 : 120);
      if (now - Date.parse(r.updatedAt) > bound * 60_000) {
        r.error = r.state === 'uploading' ? 'its pieces never all arrived' : `nothing heard from ${r.machine} for ${bound} min (${r.line ?? r.state})`;
        const held = r.state === 'sent' || r.state === 'running';
        void this.finish(r, 'failed');
        // w2218: its daemon may still hold the run and its exclusive ticket; it stops now, or on its next hello
        if (held) this.cancelOn(r.machine, r.id, `the portal gave up on it: ${r.error}`);
      }
    }
    // w2411: a result kept for its request's next worker goes once one holds it; given up after UNDELIVERED_KEEP_MS
    for (const r of this.runs.values()) {
      if (!r.undelivered) continue;
      if (now - Date.parse(r.undelivered.since) > UNDELIVERED_KEEP_MS) {
        this.d.note?.(r.requests, `timed run ${r.id}'s result was given up: no worker held the request for ${Math.round(UNDELIVERED_KEEP_MS / 3_600_000)} h (${r.undelivered.why})${r.result ? `; its logs are attachment ${r.result} while the portal keeps them` : ''}`);
        this.d.log?.(`timed run ${r.id}: result given up after ${Math.round(UNDELIVERED_KEEP_MS / 3_600_000)} h undelivered: ${r.undelivered.why}`);
        delete r.undelivered;
        this.save();
        continue;
      }
      void this.deliverResult(r);
    }
    // w2411: a run still waiting keeps every piece it plays, however long its computer stays away
    const waiting = new Set([...this.runs.values()].flatMap((r) => (r.order ? [...Object.keys(r.order.pieceIds), r.order.save.sha256] : [])));
    const old = Object.entries(this.pieces).filter(([sha, p]) => !waiting.has(sha) && now - Date.parse(p.usedAt) > PIECE_KEEP_MS);
    if (old.length) {
      this.d.store.forget(old.map(([, p]) => p.id));
      for (const [sha] of old) delete this.pieces[sha];
      this.save();
    }
  }

  /** The Capacity block's line: each computer that takes timed runs (play-only first, w1946; small workers, w1996) and its runs. */
  capacityLine(): string | undefined {
    const t = this.windowsTargets();
    if (!t.length) return undefined;
    return `Timed-run computers (w1946, w1996: a Windows player A/B built where its worker is goes there with timed_run, under that computer's exclusive ticket): ${t.map((x) => `${x.id} (${x.kind === 'play-only' ? 'play-only' : `small, ${x.agents} agent slot${x.agents === 1 ? '' : 's'}`}, ${x.held ? `held (${x.held}), ` : ''}${x.online ? (x.offers ? 'online' : 'online, daemon too old for timed runs') : 'offline'}${x.runs.length ? `; ${x.runs.length} run(s): ${x.runs.map((r) => `${r.id} ${r.state}`).join(', ')}` : '; free'})`).join(', ')}.`;
  }
}
