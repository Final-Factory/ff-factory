/**
 * Sandboxes are not held for workers that come back much later (w640, Lothsahn: "Can we not reserve slots for workers
 * that resume a long time from now?"). A worker in a machine sandbox that is stopped with its check-in more than
 * RELEASE_AFTER_MS away, or whose requests are over, releases its sandbox when its worktree is clean: the sandbox counts
 * as free and may take other work. When its check-in comes, or someone messages it, it is placed again like new work:
 * its own sandbox if that is still free and on its branch; otherwise a free sandbox on its machine, switched to its
 * branch; otherwise its message waits in the send queue, and the next sandbox to free there is claimed for it before any
 * new work. A Waiting worker with only a far check-in (its process up, nothing running) is stopped first, so the same
 * applies to it. docs/machines.md, "Placing work".
 *
 * Nothing is lost: only a clean worktree (no uncommitted change, no untracked file) is released, its branch stays in the
 * machine's repository (worktrees share it), and a switch away pushes commits no remote has first (switchBranch). A
 * moved worker resumes its own conversation (Claude Code finds a session by its id in any project folder: measured on
 * 2026-10-07 with the CLI 2.1.292 and the Agent SDK's 2.1.284) and its next message says where it is now.
 */
import { agentState, holdsSandbox, HOLD_PLACE_MS, OVERDUE_MS, utcTime } from '../shared/agentState.ts';
import type { Machine, MachineSandbox, SessionInfo } from '../shared/types.ts';

/**
 * A stopped worker's check-in further away than this releases its sandbox. Moving it costs a few minutes when it comes
 * back (measured and sourced, docs/machines.md "Placing work"): an editor stop (at most 30 s), a fetch and switch (2 s
 * fetch, under a second for the 85 files of a typical branch), a warm editor start (78-83 s to a live bridge) and a
 * recompile of what differs (a full one took 37 s on the M3). Half an hour is ten times that.
 */
export const RELEASE_AFTER_MS = 30 * 60_000;

/** A sandbox a placement failed in is not tried again for this long (another is tried first). */
export const RETRY_FAILED_MS = 10 * 60_000;

const BUSY = new Set(['running', 'starting', 'waiting_permission']);

const span = (ms: number) => {
  const min = Math.round(ms / 60_000);
  return min < 90 ? `${min} min` : `${(min / 60).toFixed(min < 600 ? 1 : 0)} h`;
};

/** A worker created this recently that has not run a turn yet is about to start (its brief waits for its sandbox). */
const STARTING_MS = 60 * 60_000;

/**
 * Whether `s` keeps a sandbox from other work: a process there, mid-turn, a permission open, its place held (w640), or
 * a new worker whose brief has not run yet (start_agent into a sandbox still being created).
 */
export const occupies = (s: SessionInfo, live: boolean, now: number = Date.now()) =>
  live || BUSY.has(s.status) || s.pendingPermissions.length > 0 || holdsSandbox(s, now) || (s.turns === 0 && !s.sdkSessionId && !s.placeReleased && !s.wakeAt && now - Date.parse(s.createdAt) < STARTING_MS);

/**
 * Why a worker's resume is far enough off that its sandbox need not wait for it, or undefined: its check-in is more
 * than RELEASE_AFTER_MS away, or (any check-in still ahead) its requests are over (`workOver`). A message queued for it
 * means it resumes now; no check-in ahead means it holds nothing anyway.
 */
export function farWhy(s: Pick<SessionInfo, 'wakeAt' | 'queuedSend'>, now: number, workOver?: string): string | undefined {
  if (s.queuedSend || !s.wakeAt) return undefined;
  const at = Date.parse(s.wakeAt);
  if (!Number.isFinite(at) || at <= now - OVERDUE_MS) return undefined;
  if (workOver) return `its check-in at ${utcTime(s.wakeAt, now)} is for work that is over: ${workOver}`;
  return at - now > RELEASE_AFTER_MS ? `its check-in is ${span(at - now)} away, at ${utcTime(s.wakeAt, now)}` : undefined;
}

/** Facts about a machine the release and the placement read. */
export interface PlaceFacts {
  /** Agents in the machine's sandboxes, with whether each has a process. */
  sessions: readonly SessionInfo[];
  live: (id: string) => boolean;
  /** Unity slot holders with a batch run granted or waiting there ("sandbox:<id>", w469). */
  unityHolders: readonly string[];
  now: number;
}

/**
 * Why `sb` stays with `s` although its resume is far, or undefined when it may be released: the sandbox not ready, its
 * git state not read since the worker's last activity, uncommitted or untracked files, a Unity batch run of its in
 * flight, or another agent working there on the same branch.
 */
export function keptWhy(s: SessionInfo, sb: MachineSandbox, f: PlaceFacts): string | undefined {
  if (sb.status !== 'ready') return `the sandbox is ${sb.status}`;
  const g = sb.git;
  if (!g) return 'its git state is not known yet';
  if (Date.parse(g.at ?? '') < Date.parse(s.lastActivityAt)) return 'its git state has not been read since the worker last worked';
  if (g.branch === 'detached HEAD' || g.branch === '?') return 'it is not on a branch';
  if (g.dirty > 0) return `${g.dirty} uncommitted change(s) there`;
  if ((g.untracked ?? 0) > 0) return `${g.untracked} untracked file(s) there`;
  if (f.unityHolders.includes(`sandbox:${sb.id}`)) return 'a Unity batch run of that sandbox is in flight';
  const other = f.sessions.find((o) => o.id !== s.id && o.machineSandbox === sb.id && occupies(o, f.live(o.id), f.now));
  if (other) return `agent ${other.id} works there too, on the same branch`;
  return undefined;
}

/** Whether a stopped worker's w613 hold (its daemon went away mid-turn) still keeps its sandbox: that comes first. */
const heldNow = (s: SessionInfo, now: number) => !!s.heldSince && now - Date.parse(s.heldSince) < HOLD_PLACE_MS;

/**
 * What the release pass does for one worker: release its sandbox (stopped), stop its process first (alive with only
 * a far check-in), take its sandbox back (its check-in is near again and the sandbox is still free and on its branch),
 * or nothing.
 */
export type ReleaseStep = { do: 'release'; why: string; branch: string } | { do: 'stop'; why: string } | { do: 'reclaim' } | undefined;

export function releaseStep(s: SessionInfo, sb: MachineSandbox | undefined, f: PlaceFacts & { workOver?: string; keepLive?: string; claimedBy?: string }): ReleaseStep {
  if (s.kind !== 'worker' || !s.machineId || !s.machineSandbox || !sb) return undefined;
  const live = f.live(s.id);
  const far = farWhy(s, f.now, f.workOver);
  if (s.placeReleased) {
    // Its check-in is near again: back to its own sandbox, while that is still free and on its branch.
    if (live || far || !s.wakeAt || s.queuedSend || Date.parse(s.wakeAt) <= f.now - OVERDUE_MS) return undefined;
    if (s.placeReleased.sandbox !== sb.id || sb.status !== 'ready' || sb.git?.branch !== s.placeReleased.branch || (f.claimedBy && f.claimedBy !== s.id)) return undefined;
    const taken = f.sessions.some((o) => o.id !== s.id && o.machineSandbox === sb.id && occupies(o, f.live(o.id), f.now));
    return taken ? undefined : { do: 'reclaim' };
  }
  if (!far) return undefined;
  if (live) {
    // Only a check-in pending: no job running, nothing queued, nothing unanswered (keepLive), no permission open.
    const st = agentState(s, undefined, f.now);
    if (s.status !== 'idle' || st.state !== 'waiting' || st.kind !== 'timer' || s.pendingPermissions.length || f.keepLive) return undefined;
    return keptWhy(s, sb, f) ? undefined : { do: 'stop', why: far };
  }
  if (s.status !== 'stopped' || heldNow(s, f.now)) return undefined;
  if (keptWhy(s, sb, f)) return undefined;
  return { do: 'release', why: far, branch: sb.git!.branch };
}

/**
 * Whether a released worker `s` may be placed in `sb`: ready, no other agent there, not claimed for another, no
 * uncommitted change (a switch refuses one), no Unity batch run, and not a sandbox a placement just failed in.
 */
function usable(s: SessionInfo, sb: MachineSandbox, f: PlaceFacts, taken: ReadonlyMap<string, string>, failed: (sandbox: string) => boolean): boolean {
  if (sb.status !== 'ready') return false;
  const by = taken.get(sb.id);
  if (by && by !== s.id) return false;
  if ((sb.git?.dirty ?? 0) > 0 || f.unityHolders.includes(`sandbox:${sb.id}`) || failed(sb.id)) return false;
  return !f.sessions.some((o) => o.id !== s.id && o.machineSandbox === sb.id && occupies(o, f.live(o.id), f.now));
}

/**
 * Where a released worker resumes on machine `m`, or why it waits: its own sandbox when usable (as it is, on its
 * branch, or switched back to it), else another usable one, an editor that is not running first (it is stopped for the
 * switch). Its branch checked out in a sandbox it cannot use (git allows a branch in one worktree only) means it waits.
 */
export function placeFor(s: SessionInfo, m: Pick<Machine, 'id' | 'sandboxes'>, f: PlaceFacts, taken: ReadonlyMap<string, string> = new Map(), failed: (sandbox: string) => boolean = () => false): { sandbox: MachineSandbox } | { wait: string } {
  const r = s.placeReleased!;
  const sbs = m.sandboxes ?? [];
  const ok = (sb: MachineSandbox) => usable(s, sb, f, taken, failed);
  const own = sbs.find((x) => x.id === r.sandbox);
  if (own && ok(own)) return { sandbox: own };
  const holder = sbs.find((x) => x.git?.branch === r.branch);
  if (holder && ok(holder)) return { sandbox: holder };
  if (holder) return { wait: `its branch ${r.branch} is checked out in ${m.id}/${holder.id}, which is in use; it goes there or elsewhere once that frees` };
  const rank = (x: MachineSandbox) => (x.unity.state === 'stopped' ? 0 : 1);
  const other = sbs.filter(ok).sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))[0];
  if (other) return { sandbox: other };
  return { wait: `no sandbox on ${m.id} is free (its own, ${r.sandbox}, took other work after it was released: ${r.why}); the next one to free there is its, ahead of new work` };
}

/** The line that tells a moved worker where it is now, put before the message that resumes it. */
export function movedNote(m: Pick<Machine, 'id'>, from: NonNullable<SessionInfo['movedFrom']>, to: Pick<MachineSandbox, 'id' | 'path'>): string {
  const branch = from.branch;
  return `[moved] While you were stopped your sandbox ${m.id}/${from.sandbox} went to other work (it was released because ${from.why}). You work in sandbox ${m.id}/${to.id} now: \`${to.path}\`, on your branch \`${branch}\`, checked out here with all its commits. Work only in this folder from now on; \`${from.path}\` is another worker's. Your Unity editor is this sandbox's (\`${to.id}@<hash>\`): read mcpforunity://instances and set_active_instance again before any Unity call; its first start here recompiles what differs. Then carry on.`;
}

export interface PlaceAgainDeps {
  sessions: () => Iterable<SessionInfo>;
  machine: (id: string) => Machine | undefined;
  isLive: (id: string) => boolean;
  online: (machineId: string) => boolean;
  /** Unity slot holders with a batch run granted or waiting on the machine ("sandbox:<id>"). */
  unityHolders: (machineId: string) => string[];
  /** Why its work is over (its requests closed or with another worker), or undefined. */
  workOver: (s: SessionInfo) => string | undefined;
  /** Why a live idle worker must keep its process, its check-in aside (Agents.keepIdle without the wake), or undefined. */
  keepLive: (id: string) => string | undefined;
  /** Whether a message to it waits in the send queue. */
  queued: (id: string) => boolean;
  stopLive: (id: string, why: string) => void;
  stopEditor: (machineId: string, sandbox: string) => Promise<unknown>;
  switchBranch: (machineId: string, branch: string, sandbox: string) => Promise<{ notes: string[] }>;
  save: (s: SessionInfo) => void;
  saveMachine: (m: Machine) => void;
  note: (sessionId: string, text: string) => void;
  /** Deliver what waits in the send queue (SessionManager.drain). */
  drain: () => void;
  report?: (text: string) => void;
  now?: () => number;
}

export class PlaceAgain {
  private readonly d: PlaceAgainDeps;
  /** Placements under way: session id to the machine and sandbox it is being put in. */
  private readonly placing = new Map<string, { machine: string; sandbox: string }>();
  /** "<session>/<sandbox>" to when a placement there failed. */
  private readonly failed = new Map<string, number>();

  constructor(d: PlaceAgainDeps) {
    this.d = d;
  }

  private now() {
    return (this.d.now ?? Date.now)();
  }

  private facts(machineId: string): PlaceFacts {
    return { sessions: [...this.d.sessions()].filter((s) => s.machineId === machineId && s.machineSandbox), live: this.d.isLive, unityHolders: this.d.unityHolders(machineId), now: this.now() };
  }

  private failedIn(id: string) {
    return (sandbox: string) => this.now() - (this.failed.get(`${id}/${sandbox}`) ?? -Infinity) < RETRY_FAILED_MS;
  }

  /**
   * Sandboxes of a machine spoken for by released workers waiting to resume: those being placed, then for each worker
   * whose message waits (in id order), the sandbox it would get. Not free for new work (Agents.free).
   */
  claims(machineId: string): Map<string, string> {
    const m = this.d.machine(machineId);
    const out = new Map<string, string>();
    if (!m) return out;
    for (const [id, p] of this.placing) if (p.machine === machineId) out.set(p.sandbox, id);
    const f = this.facts(machineId);
    const waiting = f.sessions.filter((s) => s.placeReleased && !f.live(s.id) && !this.placing.has(s.id) && this.d.queued(s.id)).sort((a, b) => a.id.localeCompare(b.id));
    for (const s of waiting) {
      const p = placeFor(s, m, f, out, this.failedIn(s.id));
      if ('sandbox' in p) out.set(p.sandbox.id, s.id);
    }
    return out;
  }

  /** The released worker a sandbox is spoken for by, or undefined. */
  claimedBy(machineId: string, sandbox: string): string | undefined {
    return this.claims(machineId).get(sandbox);
  }

  /** Released workers of a machine whose resume waits for a sandbox there (none is free for them). */
  waiting(machineId: string): string[] {
    const claimed = new Set(this.claims(machineId).values());
    return this.facts(machineId).sessions.filter((s) => s.placeReleased && !this.d.isLive(s.id) && this.d.queued(s.id) && !claimed.has(s.id)).map((s) => s.id);
  }

  /**
   * Why a stopped worker whose resume is far still holds its sandbox (uncommitted files, its w613 hold, …), for its
   * line in list_sandboxes, or undefined (its resume is near, it released it, or it is not stopped).
   */
  keptLine(s: SessionInfo): string | undefined {
    if (s.kind !== 'worker' || !s.machineId || !s.machineSandbox || s.placeReleased || s.status !== 'stopped' || this.d.isLive(s.id)) return undefined;
    const sb = this.d.machine(s.machineId)?.sandboxes?.find((x) => x.id === s.machineSandbox);
    const now = this.now();
    if (!sb || !farWhy(s, now, this.d.workOver(s))) return undefined;
    if (heldNow(s, now)) return 'its daemon went away while it was mid-turn (kept a day, w613)';
    return keptWhy(s, sb, this.facts(s.machineId));
  }

  /**
   * The release pass (every minute): release the sandboxes of stopped workers whose resume is far, stop the process of
   * a Waiting worker with only a far check-in (the next pass releases it), and give a released worker its sandbox back
   * when its check-in nears and that is still free. Returns what it did, for the log and tests.
   */
  tick(): string[] {
    const did: string[] = [];
    const byMachine = new Map<string, PlaceFacts>();
    for (const s of [...this.d.sessions()]) {
      if (s.kind !== 'worker' || !s.machineId || !s.machineSandbox) continue;
      const m = this.d.machine(s.machineId);
      const sb = m?.sandboxes?.find((x) => x.id === s.machineSandbox);
      if (!m || !sb) continue;
      let f = byMachine.get(m.id);
      if (!f) byMachine.set(m.id, (f = this.facts(m.id)));
      const live = this.d.isLive(s.id);
      const step = releaseStep(s, sb, { ...f, workOver: this.d.workOver(s), keepLive: live ? this.d.keepLive(s.id) : undefined, claimedBy: s.placeReleased ? this.claimedBy(m.id, sb.id) : undefined });
      if (!step) continue;
      if (step.do === 'stop') {
        this.d.stopLive(s.id, step.why);
        did.push(`stopped ${s.id} (${step.why}): its sandbox ${m.id}/${sb.id} is released once it has stopped`);
      } else if (step.do === 'release') {
        s.placeReleased = { at: new Date(this.now()).toISOString(), sandbox: sb.id, branch: step.branch, why: step.why };
        this.d.save(s);
        this.d.note(s.id, `Its sandbox ${m.id}/${sb.id} is released for other work while it waits: ${step.why}, and its worktree is clean (branch ${step.branch}). When it resumes it is placed again, back here if this sandbox is still free.`);
        did.push(`released ${m.id}/${sb.id} of ${s.id} (${step.why})`);
      } else {
        delete s.placeReleased;
        this.d.save(s);
        did.push(`${s.id} holds ${m.id}/${sb.id} again: its check-in is near`);
      }
    }
    for (const line of did) console.log(`place again: ${line}`);
    return did;
  }

  /**
   * SessionManager.placeFull for a released worker about to start (machines.ts): undefined when it may go now (back in
   * its own sandbox on its branch, its release over), else why its message waits (being placed in another sandbox, its
   * machine offline, or no sandbox free there). A free sandbox found starts the move in the background; the send queue
   * delivers the message once it is done.
   */
  answer(info: SessionInfo): string | undefined {
    const r = info.placeReleased;
    if (!r || !info.machineId || this.d.isLive(info.id)) return undefined;
    const busy = this.placing.get(info.id);
    if (busy) return `being placed again in ${busy.machine}/${busy.sandbox}`;
    const m = this.d.machine(info.machineId);
    if (!m) return undefined;
    if (!this.d.online(m.id)) return `${m.id} is offline: it is placed again once its daemon is back`;
    const f = this.facts(m.id);
    const taken = this.claims(m.id);
    const p = placeFor(info, m, f, taken, this.failedIn(info.id));
    if ('wait' in p) return p.wait;
    const sb = p.sandbox;
    if (sb.id === info.machineSandbox && sb.git?.branch === r.branch) {
      delete info.placeReleased;
      this.d.save(info);
      return undefined;
    }
    void this.move(info, m, sb);
    return `being placed again in ${m.id}/${sb.id}${sb.git?.branch !== r.branch ? ` (switching it to its branch ${r.branch})` : ''}`;
  }

  /** Put a released worker in `sb` on its branch: stop the editor there, switch, then move its record and deliver. */
  private async move(info: SessionInfo, m: Machine, sb: MachineSandbox) {
    const r = info.placeReleased!;
    this.placing.set(info.id, { machine: m.id, sandbox: sb.id });
    try {
      // A switch under a running editor stops Unity on "The open scene(s) have been modified externally" (macOS), and
      // Windows refuses to rewrite files the editor holds open: the daemon refuses it on both.
      if (sb.unity.state !== 'stopped') await this.d.stopEditor(m.id, sb.id);
      const notes = sb.git?.branch === r.branch ? [] : (await this.d.switchBranch(m.id, r.branch, sb.id)).notes;
      const fresh = this.d.machine(m.id) ?? m;
      const from = info.machineSandbox!;
      if (from !== sb.id) {
        const old = fresh.sandboxes?.find((x) => x.id === from);
        info.movedFrom = { sandbox: from, path: old?.path ?? from, at: new Date(this.now()).toISOString(), why: r.why, branch: r.branch };
        info.machineSandbox = sb.id;
        for (const x of fresh.sandboxes ?? []) x.sessionIds = x.id === sb.id ? [...x.sessionIds.filter((i) => i !== info.id), info.id] : x.sessionIds.filter((i) => i !== info.id);
        this.d.saveMachine(fresh);
      }
      delete info.placeReleased;
      this.d.save(info);
      const where = from === sb.id ? `back in its own sandbox ${m.id}/${sb.id}` : `in ${m.id}/${sb.id} (its own, ${from}, has other work)`;
      this.d.note(info.id, `Placed again ${where} on its branch ${r.branch}${notes.length ? ` (${notes.join('; ')})` : ''}.`);
      this.d.report?.(`[machines] ${info.id} "${info.title}" resumes ${where}, on its branch ${r.branch}: it had released its sandbox (${r.why}).`);
      console.log(`place again: ${info.id} placed ${where} on ${r.branch}`);
    } catch (e) {
      const why = (e as Error).message;
      this.failed.set(`${info.id}/${sb.id}`, this.now());
      this.d.note(info.id, `Could not place it again in ${m.id}/${sb.id}: ${why}. Another free sandbox is tried next, this one again in ${RETRY_FAILED_MS / 60_000} min.`);
      console.warn(`place again: ${info.id} into ${m.id}/${sb.id} failed: ${why}`);
    } finally {
      this.placing.delete(info.id);
      this.d.drain();
    }
  }
}

/** The branch a sandbox a released worker left on its branch is switched to for new work (handOver): its own, fresh. */
export const handOverBranch = (sandbox: string, name: string, prefixed?: string) => prefixed ?? `sandbox/${sandbox}-${name}`;

/** The released worker whose branch `sb` is still on, so new work must not start there before a switch, or undefined. */
export function releasedOn(sb: MachineSandbox, sessions: Iterable<SessionInfo>, live: (id: string) => boolean): SessionInfo | undefined {
  for (const s of sessions) if (s.placeReleased && s.machineSandbox === sb.id && !live(s.id) && sb.git?.branch === s.placeReleased.branch) return s;
  return undefined;
}

export const RELEASE_WAKE_NOTE = ` Your check-in is more than ${RELEASE_AFTER_MS / 60_000} min away, so while you are stopped your sandbox may take other work, but only if your worktree is clean: commit your work (and commit or remove untracked files) before you end this turn, or it stays held for you. Your branch stays yours; when you resume you may be in another sandbox on this machine, and the message says which.`;
