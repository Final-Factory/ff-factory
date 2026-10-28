// A paused machine on the portal (w1532, w2443; docs/machines.md "Pausing a machine"). Its daemon reports the pause
// (machine/pause.ts) and enforces it by itself (machine/pauseStop.ts: timed runs cancelled at once, editors, players and any
// worker still running ended by PAUSE_DAEMON_KILL_MS); the portal treats the machine as held (placement.hold: no new work,
// no resumes, Agents.placement()) and gets its workers to stop, push and quit within a minute or two:
//
// - A worker mid-turn there is told to commit and push its work in progress now and end its turn with
//   `<id>: still open: paused on <machine>; branch <branch> pushed; <where it stopped>` (pauseNotice). Past PAUSE_GRACE_MS
//   still mid-turn, its turn is interrupted, and PAUSE_STOP_AFTER_MS later its process (and every process under it) is stopped.
// - When a worker's turn ends on a paused machine (or its process is gone), its process is stopped, its sandbox's uncommitted
//   work saved on its branch and pushed (w656's save_work), and each request it was working on is Blocked on the machine's
//   pause (Orchestrators.pausedOff): when the machine runs again the blocker watch resumes that worker in its own sandbox,
//   as after an offline machine (w2433). A pair run's leg there starts the run again elsewhere, its partner told (w2304).
// - A worker between turns there is not woken for it. Its process (if any) is stopped; a message that would resume it (its
//   check-in, CI, a person's reply) waits in the send queue for the unpause (the machine hold, w1376).
// Lothsahn (2026-10-27, w2443): "Pausing a machine should stop existing runs on that machine. They should terminate in a
// minute or two. Please make this fix so that pausing the machine gets workers to stop, upload, and quit quickly", and "The
// worker harness should be authoritative and if the worker is nonresponsive, should kill the worker after a few minutes.
// There's no way it should keep running". (w1532 handed the work to other computers after up to 17 minutes.)
import type { Machine, MachinePause, SessionInfo, WorkItem } from '../shared/types.ts';
import type { SaveResult } from './saveWork.ts';

/**
 * How long a worker mid-turn has to push and end its turn by itself before its turn is interrupted (w2443: "a minute or two"
 * for everything; one commit-and-push call and a last line are two model calls, 20 to 40 s at a worker's context).
 */
export const PAUSE_GRACE_MS = { value: 60_000 };
/** After an interrupt, how long before its process and every process under it are stopped outright. */
export const PAUSE_STOP_AFTER_MS = { value: 15_000 };
/** How often the portal looks (Agents' pause tick): a 30 s look let the deadline slip by up to 30 s. */
export const PAUSE_TICK_MS = 5_000;
/**
 * The daemon's own deadline (machine/pauseStop.ts), after the pause: whatever FF Factory started there that still runs
 * (a worker the portal did not reach, an editor, a player, a batch build) is ended, the portal or no portal.
 */
export const PAUSE_DAEMON_KILL_MS = 90_000;

/** "beast is paused (someone is using this PC)": why a paused machine is held, as placement.hold names it. */
export const pauseWhy = (p: Pick<MachinePause, 'reason' | 'detail'>) => `paused from its tray app: ${p.reason === 'activity' ? 'someone is using it' : p.reason === 'schedule' ? 'outside its work schedule' : p.reason === 'manual' ? 'paused by hand' : 'paused'} (w1532)`;

/** The hold entries of the paused machines, to merge into config placement.hold. */
export function pauseHolds(machines: Iterable<Pick<Machine, 'id' | 'pause'>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of machines) if (m.pause?.paused) out[m.id] = pauseWhy(m.pause);
  return out;
}

/**
 * A worker's own lines at a pause: `w342: still open: paused on beast; branch sandbox/slot5-w342 pushed; the docs are left`
 * (w2443), or w1532's `w342: handed back: branch ... pushed; ...`.
 */
export function handedBackIn(text: string): Map<string, { line: string; branch?: string }> {
  const out = new Map<string, { line: string; branch?: string }>();
  for (const m of (text ?? '').matchAll(/^[\s*_>`-]*(w\d+)[*_`]*\s*[:—–-]\s*[*_`]*\s*(?:handed back|still open:\s*[*_`]*\s*paused)\b.*$/gim)) {
    const id = m[1].toLowerCase();
    if (out.has(id)) continue;
    const line = m[0].replace(/^[\s*_>`-]+/, '').trim();
    const b = /\bbranch\s+[`"']?([\w.\/-]+?)[`"']?(?=[\s;,)]|$)/i.exec(line);
    out.set(id, { line, ...(b ? { branch: b[1] } : {}) });
  }
  return out;
}

/** What a worker mid-turn on a paused machine is told (once). */
export function pauseNotice(machine: string, p: Pick<MachinePause, 'reason' | 'detail'>, requests: readonly string[], graceSec = Math.round(PAUSE_GRACE_MS.value / 1000)): string {
  const ids = requests.length ? requests.join(', ') : 'your request';
  const example = requests[0] ?? 'wNNN';
  return [
    `[FF Factory] PAUSE: ${machine} was paused by its owner (${p.reason ?? 'paused'}: ${p.detail}). Everything FF Factory runs there stops now (w2443): you have ${graceSec} seconds.`,
    'Stop what you are doing; start no new step, build, test or wait. In ONE shell call, now:',
    '1. Commit everything unfinished on your branch as a WIP commit and push it (`git add -A && git commit -m "WIP: paused" && git push`; in a clone of your own, on that clone\'s branch). Never force-push, merge or open a pull request now.',
    `2. Then end your turn with one line per request (${ids}): \`${example}: still open: paused on ${machine}; branch <branch> pushed; <where you stopped and what is left>\`.`,
    `Your request stays yours, Blocked on ${machine}'s pause: when ${machine} runs again you are resumed here, in your own sandbox. Your editor, players and timed runs there are closed by FF Factory; nothing else to release.`,
    `If this turn still runs in ${graceSec} seconds, FF Factory interrupts it, stops your process and every process it started, and saves the sandbox's uncommitted work as a WIP commit itself.`,
  ].join('\n');
}

export interface PauseDeps {
  machines: () => Iterable<Machine>;
  machine: (id: string) => Machine | undefined;
  /** The worker sessions on a machine. */
  workersOn: (machineId: string) => SessionInfo[];
  session: (id: string) => SessionInfo | undefined;
  isLive: (id: string) => boolean;
  isMidTurn: (info: SessionInfo) => boolean;
  /** The open requests a worker serves (its current ones). */
  openRequestsOf: (sessionId: string) => WorkItem[];
  /** A system message into a worker's running turn. */
  tell: (sessionId: string, text: string) => void;
  interrupt: (sessionId: string) => void;
  /** Stop its process (history kept); `why` goes into its conversation. */
  stop: (sessionId: string, why: string) => void;
  /** Commit and push the sandbox's uncommitted work on its branch (w656); undefined when it cannot (no daemon support, no sandbox). */
  save?: (info: SessionInfo, branch: string, message: string) => Promise<SaveResult>;
  /** The sandbox's branch now. */
  branchOf: (info: SessionInfo) => string | undefined;
  /**
   * Block the request on the machine's pause, its worker's own gate (Orchestrators.pausedOff, w2443): resumed in its own
   * sandbox when the machine runs again; a pair run's leg starts the run again elsewhere.
   */
  block: (w: WorkItem, info: SessionInfo, h: HandBack) => void;
  now?: () => number;
  /** A pause between save attempts (tests make it instant). */
  wait?: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

/**
 * The daemon refuses a save while the sandbox's agent process still runs ("agent 8cf0b0be runs in sandbox slot1", w656). On
 * LothLaptop's live check (2026-10-28) the one save came 5 s after the interrupt, before the process was gone, and the WIP was
 * never pushed: try again every SAVE_RETRY_MS until the daemon's 90 s sweep has surely ended it.
 */
export const SAVE_RETRY_MS = 5_000;
export const SAVE_RETRY_FOR_MS = 120_000;

/** One hand-back (a move, w1600) or a pause's block (w2443), as the ledger and the next worker see it (WorkItem.handedBack). */
export interface HandBack {
  machine: string;
  sandbox?: string;
  branch?: string;
  /** Why the machine is paused. */
  why: string;
  /** Its worker's own line, or what FF Factory says about where it stopped. */
  note: string;
  /** How it went: "by its worker", "forced (stopped)". */
  how: string;
  /** What the save of its uncommitted work did. */
  saved?: string;
  /** The message that would have resumed it (a held resume), for the next worker. */
  message?: string;
  /**
   * A move, not a pause (w1600, stop_agent move_to): the computer it goes to. `why` is then the move's reason, said as is
   * ("its Live view goes to beast"), not the machine's pause.
   */
  to?: string;
}

export class MachinePauses {
  /** Workers told to stop: when, on which machine, and whether their turn was interrupted. */
  private readonly told = new Map<string, { at: number; machine: string; interruptedAt?: number }>();
  /** Workers whose requests are Blocked on this pause already (machine id): a second turn end or a stop does not block again. */
  private readonly blocked = new Map<string, string>();
  /** Workers being saved and blocked right now (a save in flight). */
  private readonly handing = new Set<string>();
  private readonly now: () => number;

  private readonly d: PauseDeps;

  constructor(d: PauseDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
  }

  paused(machineId: string | undefined): MachinePause | undefined {
    const p = machineId ? this.d.machine(machineId)?.pause : undefined;
    return p?.paused ? p : undefined;
  }

  /** The machine was paused: its workers mid-turn are told, its live idle ones stopped. */
  onPause(machineId: string) {
    const p = this.paused(machineId);
    if (!p) return;
    this.d.log(`pause: ${machineId} paused (${p.reason}: ${p.detail}): its workers push and stop within ${Math.round((PAUSE_GRACE_MS.value + PAUSE_STOP_AFTER_MS.value) / 1000)} s (w2443)`);
    this.sweep(machineId);
  }

  /** The machine runs again: the requests Blocked on its pause resume through the blocker watch (their gates clear). */
  onUnpause(machineId: string) {
    for (const [id, t] of this.told) if (t.machine === machineId) this.told.delete(id);
    for (const [id, m] of this.blocked) if (m === machineId) this.blocked.delete(id);
    this.d.log(`pause: ${machineId} unpaused: it takes work again, and the requests Blocked on its pause resume in their own sandboxes`);
  }

  /** Every PAUSE_TICK_MS: a worker on a paused machine mid-turn and not told yet is told; one past its grace is interrupted, then stopped. */
  tick() {
    for (const [id, t] of this.told) if (!this.paused(t.machine)) this.told.delete(id);
    for (const [id, m] of this.blocked) if (!this.paused(m)) this.blocked.delete(id);
    for (const m of this.d.machines()) if (m.pause?.paused) this.sweep(m.id);
  }

  private sweep(machineId: string) {
    for (const s of this.d.workersOn(machineId)) this.sweepOne(s);
  }

  private sweepOne(s: SessionInfo) {
    const p = this.paused(s.machineId);
    if (!p || !s.machineId) return;
    const live = this.d.isLive(s.id);
    const t = this.told.get(s.id);
    const now = this.now();
    if (!live || !this.d.isMidTurn(s)) {
      // Told, and its turn is over with no turn end seen (its process died: the daemon's own deadline, a crash, a kill): the
      // requests it was working on are Blocked on the pause all the same.
      if (t && !this.blocked.has(s.id) && !this.handing.has(s.id)) {
        if (live) this.d.stop(s.id, `Stopped by FF Factory: ${s.machineId} is ${pauseWhy(p)}.`);
        this.d.log(`pause: worker ${s.id} on ${s.machineId} is no longer mid-turn and gave no turn end: its requests are Blocked on the pause`);
        void this.blockAll(s, 'its process ended before it wrote its line', t.interruptedAt ? 'forced (its process ended after the interrupt)' : 'its process ended', this.workingOn(s.id));
        return;
      }
      // Between turns: not woken. Its process stops; a message that would resume it waits for the unpause (the machine hold).
      if (live && !this.handing.has(s.id)) this.d.stop(s.id, `Stopped by FF Factory: ${s.machineId} is ${pauseWhy(p)}. A message that would resume you waits until it runs again.`);
      return;
    }
    if (!t) {
      const ids = this.d.openRequestsOf(s.id).map((w) => w.id);
      this.told.set(s.id, { at: now, machine: s.machineId });
      this.d.log(`pause: told worker ${s.id} on ${s.machineId}/${s.machineSandbox ?? '?'} (${ids.join(', ') || 'no open request'}) to push and stop`);
      this.d.tell(s.id, pauseNotice(s.machineId, p, ids));
      return;
    }
    if (!t.interruptedAt && now - t.at >= PAUSE_GRACE_MS.value) {
      t.interruptedAt = now;
      this.d.log(`pause: worker ${s.id} still mid-turn ${Math.round((now - t.at) / 1000)} s after the pause notice: its turn is interrupted`);
      this.d.interrupt(s.id);
      return;
    }
    if (t.interruptedAt && now - t.interruptedAt >= PAUSE_STOP_AFTER_MS.value) {
      this.d.log(`pause: worker ${s.id} did not end its turn ${Math.round((now - t.interruptedAt) / 1000)} s after the interrupt: stopped with every process under it`);
      this.d.stop(s.id, `Stopped by FF Factory: ${s.machineId} is ${pauseWhy(p)} and the turn did not end when interrupted.`);
      void this.blockAll(s, `its turn did not end ${Math.round((now - t.at) / 1000)} s after the pause notice, so FF Factory stopped it`, 'forced (stopped)', this.workingOn(s.id));
    }
  }

  /**
   * A worker's turn ended. On a paused machine its process stops, its work is saved and the requests it was working on are
   * Blocked on the pause: those its lines name, and every other it was working on (not those waiting on a gate or a person,
   * which wait as they were; their resume is held until the unpause).
   */
  turnEnded(s: SessionInfo, text: string): boolean {
    const p = this.paused(s.machineId);
    if (!p || s.kind !== 'worker') return false;
    const t = this.told.get(s.id);
    const lines = handedBackIn(text);
    const how = lines.size ? 'by its worker' : t?.interruptedAt ? `forced: interrupted ${Math.round(PAUSE_GRACE_MS.value / 1000)} s after the pause notice` : t ? 'its worker ended its turn without its line' : 'its turn ended after the pause';
    const picks = this.workingOn(s.id, lines);
    this.d.stop(s.id, `Stopped by FF Factory: ${s.machineId} is ${pauseWhy(p)}.${picks.length ? ` ${picks.map((w) => w.id).join(', ')} wait${picks.length === 1 ? 's' : ''} Blocked on its pause, and you are resumed here when it runs again.` : ''}`);
    void this.blockAll(s, '', how, picks, lines);
    return true;
  }

  /** The requests a worker leaves at a pause: those its lines name, and those it was working on (not waiting on a gate or a person). */
  private workingOn(sessionId: string, lines: ReadonlyMap<string, unknown> = new Map()): WorkItem[] {
    return this.d.openRequestsOf(sessionId).filter((w) => lines.has(w.id) || w.status === 'active' || w.status === 'queued' || w.status === 'new' || w.status === 'stalled');
  }

  /**
   * A message that would resume a worker on a paused machine (held by the pause, w1376). The pause notice itself, queued
   * behind the turn it was meant for, is dropped (that turn's end stopped the worker already). Anything else waits in the
   * send queue for the unpause: false.
   */
  heldResume(s: SessionInfo, text: string): boolean {
    if (!this.paused(s.machineId) || s.kind !== 'worker') return false;
    return /^\[FF Factory\] PAUSE:/.test(text);
  }

  private async blockAll(s: SessionInfo, defaultNote: string, how: string, picks: WorkItem[], lines = new Map<string, { line: string; branch?: string }>()) {
    if (this.handing.has(s.id) || (s.machineId && this.blocked.get(s.id) === s.machineId)) return;
    this.told.delete(s.id);
    if (s.machineId) this.blocked.set(s.id, s.machineId);
    this.handing.add(s.id);
    const p = this.paused(s.machineId);
    const why = p ? pauseWhy(p) : 'paused';
    try {
      const sbBranch = this.d.branchOf(s);
      let saved: string | undefined;
      if (this.d.save && sbBranch && s.machineSandbox) {
        try {
          const message = `FF Factory: WIP saved from ${s.id} when ${s.machineId} was paused (w2443)\n\n${picks.map((w) => w.id).join(', ') || 'Its work'} waits Blocked on the pause: ${why}. Its worker carries on from it when the machine runs again.`;
          const wait = this.d.wait ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
          let r: SaveResult | undefined;
          for (let tries = 0; ; tries++) {
            try {
              r = await this.d.save(s, sbBranch, message);
              break;
            } catch (e) {
              if (!/runs in sandbox/.test((e as Error).message) || (tries + 1) * SAVE_RETRY_MS > SAVE_RETRY_FOR_MS) throw e;
              await wait(SAVE_RETRY_MS);
            }
          }
          saved = r.sha ? `its sandbox's uncommitted work (${r.files} file(s)) was saved as WIP commit ${r.sha.slice(0, 10)} on ${sbBranch}${r.pushed ? ' and pushed' : `, not pushed (${r.notes.join('; ')})`}` : `its sandbox had no uncommitted work on ${sbBranch}`;
        } catch (e) {
          saved = `its sandbox's uncommitted work could not be saved (${(e as Error).message}); it is still in the sandbox`;
        }
      }
      for (const w of picks) {
        const own = lines.get(w.id);
        const note = own?.line ?? (defaultNote || (w.outcome ? `its last report: ${w.outcome}` : 'no note'));
        const branch = own?.branch ?? sbBranch;
        this.d.log(`pause: ${w.id} Blocked on ${s.machineId}'s pause, its worker ${s.id} in ${s.machineId}/${s.machineSandbox ?? '?'} (${how}); branch ${branch ?? 'unknown'}${saved ? `; ${saved}` : ''}`);
        this.d.block(w, s, { machine: s.machineId!, ...(s.machineSandbox ? { sandbox: s.machineSandbox } : {}), ...(branch ? { branch } : {}), why, note, how, ...(saved ? { saved } : {}) });
      }
    } finally {
      this.handing.delete(s.id);
    }
  }
}
