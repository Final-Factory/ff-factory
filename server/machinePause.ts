// A paused machine on the portal (w1532, docs/machines.md "Pausing a machine"). Its daemon reports the pause (machine/pause.ts);
// the portal then treats the machine as held (placement.hold: no new work, no resumes, Agents.placement()) and moves the
// work that was on it to other computers:
//
// - A worker mid-turn there is told to finish the step it is on, commit and push everything unfinished, and end its turn
//   with `<id>: handed back: branch <branch> pushed; <where it stopped>` (pauseNotice). Past PAUSE_GRACE_MS still mid-turn,
//   its turn is interrupted, and stopped if that does not end it.
// - When a worker's turn ends on a paused machine, its process is stopped, its sandbox's uncommitted work saved on its
//   branch and pushed (w656's save_work), and each request it was working on handed back (Orchestrators.handBack): taken off
//   it, Queued, with the branch and its note, and the dispatcher told to place it on another computer.
// - A worker between turns there is not woken for it. Its process (if any) is stopped, and its requests stay with it until
//   something would resume it (its check-in, CI, a person's reply): that message is held by the pause, so the request is
//   handed back then, carrying the message to the next worker (heldResume).
// Lothsahn (2026-10-19, w1532): "When pausing, workers should be instructed to finish up their work, commit anything
// unfinished, and hand their jobs back to the dispatcher to be scheduled on other computers."
import type { Machine, MachinePause, SessionInfo, WorkItem } from '../shared/types.ts';
import type { SaveResult } from './saveWork.ts';

/** How long a worker mid-turn has to hand back by itself before its turn is interrupted. */
export const PAUSE_GRACE_MS = { value: 15 * 60_000 };
/** After an interrupt, how long before the process is stopped outright. */
export const PAUSE_STOP_AFTER_MS = { value: 2 * 60_000 };
/**
 * A told worker whose turn ended without a hand-back line: how long its queued notice gets to start the next turn (the notice
 * reached a turn as it ended, so the CLI answers it as a turn of its own) before FF Factory hands its requests back itself.
 */
export const PAUSE_LINELESS_WAIT_MS = { value: 60_000 };

/** "beast is paused (someone is using this PC)": why a paused machine is held, as placement.hold names it. */
export const pauseWhy = (p: Pick<MachinePause, 'reason' | 'detail'>) => `paused from its tray app: ${p.reason === 'activity' ? 'someone is using it' : p.reason === 'schedule' ? 'outside its work schedule' : p.reason === 'manual' ? 'paused by hand' : 'paused'} (w1532)`;

/** The hold entries of the paused machines, to merge into config placement.hold. */
export function pauseHolds(machines: Iterable<Pick<Machine, 'id' | 'pause'>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of machines) if (m.pause?.paused) out[m.id] = pauseWhy(m.pause);
  return out;
}

/** A worker's own hand-back lines: `w342: handed back: branch sandbox/slot5-w342 pushed; the tests pass, the docs are left`. */
export function handedBackIn(text: string): Map<string, { line: string; branch?: string }> {
  const out = new Map<string, { line: string; branch?: string }>();
  for (const m of (text ?? '').matchAll(/^[\s*_>`-]*(w\d+)[*_`]*\s*[:—–-]\s*[*_`]*\s*handed back\b.*$/gim)) {
    const id = m[1].toLowerCase();
    if (out.has(id)) continue;
    const line = m[0].replace(/^[\s*_>`-]+/, '').trim();
    const b = /\bbranch\s+[`"']?([\w.\/-]+?)[`"']?(?=[\s;,)]|$)/i.exec(line);
    out.set(id, { line, ...(b ? { branch: b[1] } : {}) });
  }
  return out;
}

/** What a worker mid-turn on a paused machine is told (once). */
export function pauseNotice(machine: string, p: Pick<MachinePause, 'reason' | 'detail'>, requests: readonly string[], graceMin = Math.round(PAUSE_GRACE_MS.value / 60_000)): string {
  const ids = requests.length ? requests.join(', ') : 'your request';
  const example = requests[0] ?? 'wNNN';
  return [
    `[FF Factory] PAUSE: ${machine} was paused by its owner (${p.reason ?? 'paused'}: ${p.detail}), so FF Factory work leaves it now (w1532).`,
    'Finish the step you are on and start no new one. Then, before you end this turn:',
    '1. Commit everything unfinished on your branch (a WIP commit is fine; in a clone of your own, on that clone\'s branch) and push it.',
    '2. Release what you hold: a Unity batch slot, a bench or other lock, a player you started (`ff-leftovers end`).',
    `3. End your turn with one line per request (${ids}): \`${example}: handed back: branch <branch> pushed; <where you stopped and what is left>\`.`,
    'Open or merge nothing new now. The dispatcher places the request on another computer, whose worker picks it up from your pushed branch with your line as its note.',
    `If this turn still runs in ${graceMin} minutes, FF Factory interrupts it, saves the sandbox's uncommitted work as a WIP commit and hands the request back itself.`,
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
  /** Take the request off the worker, Queue it with the hand-back, and tell the dispatcher (Orchestrators.handBack). */
  handBack: (w: WorkItem, info: SessionInfo, h: HandBack) => void;
  now?: () => number;
  log: (line: string) => void;
}

/** One hand-back, as the ledger and the next worker see it (WorkItem.handedBack). */
export interface HandBack {
  machine: string;
  sandbox?: string;
  branch?: string;
  /** Why the machine is paused. */
  why: string;
  /** Its worker's own line, or what FF Factory says about where it stopped. */
  note: string;
  /** How it went: "by its worker", "forced after 15 min", "on a held resume". */
  how: string;
  /** What the save of its uncommitted work did. */
  saved?: string;
  /** The message that would have resumed it (a held resume), for the next worker. */
  message?: string;
}

export class MachinePauses {
  /** Workers told to hand back: when, on which machine, and whether their turn was interrupted. */
  private readonly told = new Map<string, { at: number; machine: string; interruptedAt?: number; lineless?: number }>();
  /** Workers being handed back right now (a save in flight): a second turn end or resume does not start another. */
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
    this.d.log(`pause: ${machineId} paused (${p.reason}: ${p.detail}): its workers hand their requests back`);
    this.sweep(machineId);
  }

  /** The machine runs again: nothing more is handed back; what was is placed by the dispatcher as usual. */
  onUnpause(machineId: string) {
    for (const [id, t] of this.told) if (t.machine === machineId) this.told.delete(id);
    this.d.log(`pause: ${machineId} unpaused: it takes work again`);
  }

  /** Every 30 s: a worker on a paused machine mid-turn and not told yet is told; one past its grace is interrupted, then stopped. */
  tick() {
    for (const [id, t] of this.told) if (!this.paused(t.machine)) this.told.delete(id);
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
      // Told, and its turn ended without a hand-back line: its notice may still start a turn of its own (PAUSE_LINELESS_WAIT_MS).
      if (t?.lineless !== undefined) {
        if (now - t.lineless < PAUSE_LINELESS_WAIT_MS.value && live) return;
        this.d.log(`pause: worker ${s.id} ended its turn without a hand-back line and did not answer the notice within ${Math.round(PAUSE_LINELESS_WAIT_MS.value / 1000)} s: FF Factory hands its requests back`);
        this.d.stop(s.id, `Stopped by FF Factory: ${s.machineId} is ${pauseWhy(p)}.`);
        void this.handBackAll(s, '', 'its worker ended its turn without a hand-back line', undefined, this.workingOn(s.id));
        return;
      }
      // Between turns: not woken; its process stops, and a resume of it later hands its requests back (heldResume).
      if (live && !this.handing.has(s.id)) this.d.stop(s.id, `Stopped by FF Factory: ${s.machineId} is ${pauseWhy(p)}. Its requests move to another computer when it would resume.`);
      return;
    }
    if (!t) {
      const ids = this.d.openRequestsOf(s.id).map((w) => w.id);
      this.told.set(s.id, { at: now, machine: s.machineId });
      this.d.log(`pause: told worker ${s.id} on ${s.machineId}/${s.machineSandbox ?? '?'} (${ids.join(', ') || 'no open request'}) to hand back`);
      this.d.tell(s.id, pauseNotice(s.machineId, p, ids));
      return;
    }
    if (!t.interruptedAt && now - t.at >= PAUSE_GRACE_MS.value) {
      t.interruptedAt = now;
      this.d.log(`pause: worker ${s.id} still mid-turn ${Math.round((now - t.at) / 60_000)} min after the pause notice: its turn is interrupted`);
      this.d.interrupt(s.id);
      return;
    }
    if (t.interruptedAt && now - t.interruptedAt >= PAUSE_STOP_AFTER_MS.value) {
      this.d.log(`pause: worker ${s.id} did not end its turn after the interrupt: stopped`);
      this.d.stop(s.id, `Stopped by FF Factory: ${s.machineId} is ${pauseWhy(p)} and the turn did not end when interrupted.`);
      void this.handBackAll(s, `its turn did not end ${Math.round((PAUSE_GRACE_MS.value + PAUSE_STOP_AFTER_MS.value) / 60_000)} min after the pause notice, so FF Factory stopped it`, 'forced (stopped)');
    }
  }

  /**
   * A worker's turn ended. On a paused machine its process stops, its work is saved and its requests are handed back:
   * those it named in a `handed back:` line, and every other it was working on (not those waiting on a gate or a person,
   * which hand back when they would resume).
   */
  turnEnded(s: SessionInfo, text: string): boolean {
    const p = this.paused(s.machineId);
    if (!p || s.kind !== 'worker') return false;
    const t = this.told.get(s.id);
    const lines = handedBackIn(text);
    // Told but no line: the notice may be queued behind the turn that just ended; the tick waits for it a while.
    if (t && !lines.size && !t.interruptedAt && t.lineless === undefined) {
      t.lineless = this.now();
      this.d.log(`pause: worker ${s.id} ended a turn without a hand-back line; its notice may be queued behind it: waiting up to ${Math.round(PAUSE_LINELESS_WAIT_MS.value / 1000)} s`);
      return true;
    }
    const how = lines.size ? 'by its worker' : t?.interruptedAt ? `forced: interrupted ${Math.round(PAUSE_GRACE_MS.value / 60_000)} min after the pause notice` : t ? 'its worker ended its turn without a hand-back line' : 'its turn ended after the pause';
    const picks = this.workingOn(s.id, lines);
    this.d.stop(s.id, `Stopped by FF Factory: ${s.machineId} is ${pauseWhy(p)}.${picks.length ? ` ${picks.map((w) => w.id).join(', ')} handed back to the dispatcher for another computer.` : ''}`);
    void this.handBackAll(s, '', how, undefined, picks, lines);
    return true;
  }

  /** The requests a worker hands back at a turn end: those its lines name, and those it was working on (not waiting on a gate or a person). */
  private workingOn(sessionId: string, lines: ReadonlyMap<string, unknown> = new Map()): WorkItem[] {
    return this.d.openRequestsOf(sessionId).filter((w) => lines.has(w.id) || w.status === 'active' || w.status === 'queued' || w.status === 'new');
  }

  /**
   * A message that would resume a worker on a paused machine (held by the pause): its open requests are handed back now,
   * the message carried to the next worker. True when it handed something back (the caller drops the message).
   */
  heldResume(s: SessionInfo, text: string): boolean {
    const p = this.paused(s.machineId);
    if (!p || s.kind !== 'worker' || this.handing.has(s.id)) return false;
    const reqs = this.d.openRequestsOf(s.id);
    if (!reqs.length) return false;
    if (this.d.isLive(s.id) && this.d.isMidTurn(s)) return false;
    void this.handBackAll(s, 'it was between turns when the machine paused; this is the message that would have resumed it', 'on a held resume', text, reqs);
    return true;
  }

  private async handBackAll(s: SessionInfo, defaultNote: string, how: string, message?: string, picks?: WorkItem[], lines = new Map<string, { line: string; branch?: string }>()) {
    if (this.handing.has(s.id)) return;
    const reqs = picks ?? this.d.openRequestsOf(s.id);
    this.told.delete(s.id);
    if (!reqs.length) return;
    this.handing.add(s.id);
    const p = this.paused(s.machineId);
    const why = p ? pauseWhy(p) : 'paused';
    try {
      const sbBranch = this.d.branchOf(s);
      let saved: string | undefined;
      if (this.d.save && sbBranch && s.machineSandbox) {
        try {
          const r = await this.d.save(s, sbBranch, `FF Factory: WIP saved from ${s.id} when ${s.machineId} was paused (w1532)\n\n${reqs.map((w) => w.id).join(', ')} handed back to the dispatcher: ${why}. \`git reset HEAD~1\` gives the work back uncommitted.`);
          saved = r.sha ? `its sandbox's uncommitted work (${r.files} file(s)) was saved as WIP commit ${r.sha.slice(0, 10)} on ${sbBranch}${r.pushed ? ' and pushed' : `, not pushed (${r.notes.join('; ')})`}` : `its sandbox had no uncommitted work on ${sbBranch}`;
        } catch (e) {
          saved = `its sandbox's uncommitted work could not be saved (${(e as Error).message}); what its worker pushed is what the next one gets`;
        }
      }
      for (const w of reqs) {
        const own = lines.get(w.id);
        const note = own?.line ?? (defaultNote || (w.outcome ? `its last report: ${w.outcome}` : 'no note'));
        const branch = own?.branch ?? sbBranch;
        this.d.log(`pause: ${w.id} handed back from worker ${s.id} on ${s.machineId}/${s.machineSandbox ?? '?'} (${how}); branch ${branch ?? 'unknown'}${saved ? `; ${saved}` : ''}`);
        this.d.handBack(w, s, { machine: s.machineId!, ...(s.machineSandbox ? { sandbox: s.machineSandbox } : {}), ...(branch ? { branch } : {}), why, note, how, ...(saved ? { saved } : {}), ...(message ? { message } : {}) });
      }
    } finally {
      this.handing.delete(s.id);
    }
  }
}
