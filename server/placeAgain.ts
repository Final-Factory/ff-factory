/**
 * Sandboxes are not held for workers that come back much later (w640, Lothsahn: "Can we not reserve slots for workers
 * that resume a long time from now?"; w656: "Yes. Do both", after every sandbox was held on 2026-10-07 while agent
 * slots sat free). A worker in a machine sandbox that is stopped with its check-in more than RELEASE_AFTER_MS away, whose
 * requests are over, whose w613 hold (its daemon went away under it) is HOLD_PLACE_MS old, or that FF Factory stopped
 * while idle (releaseDue), releases its sandbox when its worktree is clean: the sandbox counts as free and may take
 * other work. Stopped workers sharing one sandbox release it together. When its check-in comes, or someone messages it, it is placed again like new work:
 * its own sandbox if that is still free and on its branch; otherwise a free sandbox on its machine, switched to its
 * branch; otherwise its message waits in the send queue, and the next sandbox to free there is claimed for it before any
 * new work. A worker between turns with only a far check-in (its process up, nothing running) is stopped first, so the same
 * applies to it, and so is one Idle (alive, nothing pending at all) for RELEASE_AFTER_MS. docs/machines.md, "Placing work".
 *
 * Nothing is lost: only a clean worktree (no uncommitted change, no untracked file) is released, its branch stays in the
 * machine's repository (worktrees share it), and a switch away pushes commits no remote has first (switchBranch). A
 * dirty one is first saved by its daemon (w656, server/saveWork.ts): committed on the worker's branch and pushed; one it
 * cannot save (too many or too big untracked files, an older daemon) stays held, and list_sandboxes says why. A
 * moved worker resumes its own conversation (Claude Code finds a session by its id in any project folder: measured on
 * 2026-10-07 with the CLI 2.1.292 and the Agent SDK's 2.1.284) and its next message says where it is now.
 */
import { agentState, holdsSandbox, HOLD_PLACE_MS, OVERDUE_MS, utcTime } from '../shared/agentState.ts';

export { HOLD_PLACE_MS };
import type { Machine, MachineSandbox, SessionInfo } from '../shared/types.ts';
import type { SaveResult } from './saveWork.ts';

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

/**
 * Why a stopped worker's sandbox may be released now (w640, w656), or undefined: its work is over (at once, whatever
 * else holds it), else its w613 hold is over and nothing near resumes it, its check-in is far (farWhy), or FF Factory
 * stopped it while idle (releaseDue). A queued message resumes it now, and a near check-in keeps it. A worker with none
 * of these holds nothing to release.
 */
export function releaseWhy(s: Pick<SessionInfo, 'wakeAt' | 'queuedSend' | 'heldSince' | 'releaseDue'>, now: number, workOver?: string): string | undefined {
  if (s.queuedSend) return undefined;
  const wakeAhead = !!s.wakeAt && Date.parse(s.wakeAt) > now - OVERDUE_MS;
  if (!wakeAhead && !s.heldSince && !s.releaseDue) return undefined;
  if (workOver) return wakeAhead ? farWhy(s, now, workOver) : `its work is over: ${workOver}`;
  const far = farWhy(s, now);
  if (wakeAhead && !far) return undefined;
  if (s.heldSince) {
    const at = Date.parse(s.heldSince);
    if (now - at < HOLD_PLACE_MS) return undefined;
    return far ?? `its daemon restarted at ${utcTime(s.heldSince, now)} and it has not resumed within ${HOLD_PLACE_MS / 60_000} min`;
  }
  return far ?? s.releaseDue?.why;
}

/** Whether `o` is stopped with its own release due, so it keeps no other stopped worker there from releasing (w656). */
const releasable = (o: SessionInfo, f: PlaceFacts) => !f.live(o.id) && o.status === 'stopped' && !o.placeReleased && !o.pendingPermissions.length && !!releaseWhy(o, f.now, f.over?.(o));

/** Facts about a machine the release and the placement read. */
export interface PlaceFacts {
  /** Agents in the machine's sandboxes, with whether each has a process. */
  sessions: readonly SessionInfo[];
  live: (id: string) => boolean;
  /** Unity slot holders with a batch run granted or waiting there ("sandbox:<id>", w469). */
  unityHolders: readonly string[];
  now: number;
  /** Why an agent's work is over (Agents.workOver), for the others in a sandbox; none means not over. */
  over?: (s: SessionInfo) => string | undefined;
  /** Its daemon saves uncommitted work before a release (w656); false: it cannot yet, undefined: not asked. */
  canSave?: boolean;
  /** Why the last save of a sandbox failed, while it is not tried again (RETRY_FAILED_MS), or undefined. */
  saveRefused?: (sandbox: string) => string | undefined;
}

/**
 * Why `sb` stays with `s` although its resume is far, or undefined when it may be released: the sandbox not ready, its
 * git state not read since the worker's last activity, uncommitted or untracked files, a Unity batch run of its in
 * flight, or another agent working there on the same branch. Another stopped agent there whose own release is due does
 * not count: they release it together (w656).
 */
export function keptWhy(s: SessionInfo, sb: MachineSandbox, f: PlaceFacts): string | undefined {
  if (sb.status !== 'ready') return `the sandbox is ${sb.status}`;
  const g = sb.git;
  if (!g) return 'its git state is not known yet';
  if (Date.parse(g.at ?? '') < Date.parse(s.lastActivityAt)) return 'its git state has not been read since the worker last worked';
  if (g.branch === 'detached HEAD' || g.branch === '?') return 'it is not on a branch';
  if (f.unityHolders.includes(`sandbox:${sb.id}`)) return 'a Unity batch run of that sandbox is in flight';
  const other = f.sessions.find((o) => o.id !== s.id && o.machineSandbox === sb.id && occupies(o, f.live(o.id), f.now) && !releasable(o, f));
  if (other) return `agent ${other.id} works there too, on the same branch`;
  if (!dirtyOf(sb)) return undefined;
  // Its daemon commits and pushes them first (w656), unless its last try failed a moment ago.
  const refused = f.saveRefused?.(sb.id);
  if (refused) return `its uncommitted work could not be saved: ${refused}`;
  if (f.canSave) return undefined;
  const later = f.canSave === false ? " (FF Factory saves them before a release once this machine's daemon is updated)" : '';
  return g.dirty > 0 ? `${g.dirty} uncommitted change(s) there${later}` : `${g.untracked} untracked file(s) there${later}`;
}

/** Whether a sandbox's worktree has anything uncommitted or untracked, as its daemon last read it. */
const dirtyOf = (sb: MachineSandbox) => (sb.git?.dirty ?? 0) > 0 || (sb.git?.untracked ?? 0) > 0;

/**
 * What the release pass does for one worker: release its sandbox (stopped), stop its process first (alive with only
 * a far check-in, or Idle with nothing pending for RELEASE_AFTER_MS or its work over: `due`, so its sandbox stays its
 * until released), take its sandbox back (its check-in is near again and the sandbox is still free and on its branch),
 * or nothing.
 */
export type ReleaseStep = { do: 'release'; why: string; branch: string; save?: boolean } | { do: 'stop'; why: string; due?: boolean } | { do: 'reclaim' } | undefined;

/**
 * Why a worker waiting on CI (w846) may give up its sandbox now, or undefined: its requests wait on a CI gate (`ciWait`,
 * Agents.ciWait), its editor is stopped, and its branch has no commit its remote lacks. lothsahn: "When they're waiting
 * for GithubCI with their unity editors off, they should free the slot." The gate clears when the checks finish, green
 * or red (server/blockerWatch.ts), and its worker is resumed within minutes, placed again as any released worker is.
 */
export function ciReleaseWhy(sb: MachineSandbox, ciWait: string | undefined): string | undefined {
  if (!ciWait || sb.unity.state !== 'stopped' || (sb.git?.ahead ?? 0) > 0) return undefined;
  return ciWait;
}

export function releaseStep(s: SessionInfo, sb: MachineSandbox | undefined, f: PlaceFacts & { workOver?: string; keepLive?: string; claimedBy?: string; ciWait?: string }): ReleaseStep {
  if (s.kind !== 'worker' || !s.machineId || !s.machineSandbox || !sb) return undefined;
  const live = f.live(s.id);
  const far = farWhy(s, f.now, f.workOver);
  const ci = ciReleaseWhy(sb, f.ciWait);
  if (s.placeReleased) {
    // While its CI runs it stays released (w846): its check-in or its unblock places it again.
    if (f.ciWait) return undefined;
    // Its check-in is near again: back to its own sandbox, while that is still free and on its branch.
    if (live || far || !s.wakeAt || s.queuedSend || Date.parse(s.wakeAt) <= f.now - OVERDUE_MS) return undefined;
    if (s.placeReleased.sandbox !== sb.id || sb.status !== 'ready' || sb.git?.branch !== s.placeReleased.branch || (f.claimedBy && f.claimedBy !== s.id)) return undefined;
    const taken = f.sessions.some((o) => o.id !== s.id && o.machineSandbox === sb.id && occupies(o, f.live(o.id), f.now));
    return taken ? undefined : { do: 'reclaim' };
  }
  if (live) {
    // Nothing running, nothing queued, nothing unanswered (keepLive), no permission open.
    if (s.status !== 'idle' || s.pendingPermissions.length || s.queuedSend || f.keepLive) return undefined;
    const st = agentState(s, undefined, f.now);
    let step: ReleaseStep;
    // Only a check-in pending, and it is far (or for work that is over).
    if (st.state === 'between_turns') step = st.kind === 'timer' && far ? { do: 'stop', why: far } : st.kind === 'timer' && ci ? { do: 'stop', why: ci, due: true } : undefined;
    else if (st.state === 'idle') {
      // Idle with nothing pending at all (w656: w650 waiting for a deploy, with no check-in): a message resumes it.
      const idle = f.now - Date.parse(s.lastActivityAt);
      const why = f.workOver ? `its work is over: ${f.workOver}` : ci ?? (idle >= RELEASE_AFTER_MS ? `idle for ${span(idle)} with no check-in` : undefined);
      step = why ? { do: 'stop', why, due: true } : undefined;
    }
    return step && !keptWhy(s, sb, f) ? step : undefined;
  }
  if (s.status !== 'stopped' || s.pendingPermissions.length) return undefined;
  // Waiting on CI (w846): released whatever its check-in, which places it again when it comes.
  const why = (s.queuedSend ? undefined : ci) ?? releaseWhy(s, f.now, f.workOver);
  if (!why || keptWhy(s, sb, f)) return undefined;
  return { do: 'release', why, branch: sb.git!.branch, ...(dirtyOf(sb) ? { save: true } : {}) };
}

/** Whether `sb` is on `branch`: an agent there works on that branch, as the released worker did with it (w656). */
const sameBranch = (sb: MachineSandbox, branch: string) => sb.git?.branch === branch;

/**
 * Whether a released worker `s` may be placed in `sb`: ready, no other agent there, not claimed for another, no
 * uncommitted change (a switch refuses one), no Unity batch run, and not a sandbox a placement just failed in.
 */
function usable(s: SessionInfo, sb: MachineSandbox, f: PlaceFacts, taken: ReadonlyMap<string, string>, failed: (sandbox: string) => boolean): boolean {
  if (sb.status !== 'ready') return false;
  // Another agent's old host still runs there while its daemon stops it (w799).
  if (sb.lingering?.some((l) => l.sessionId !== s.id)) return false;
  const by = taken.get(sb.id);
  if (by && by !== s.id) return false;
  if ((sb.git?.dirty ?? 0) > 0 || f.unityHolders.includes(`sandbox:${sb.id}`) || failed(sb.id)) return false;
  // Agents there on its own branch share it (w656: stopped workers of one sandbox released it together); new work in a
  // released sandbox is always switched to a fresh branch first (handOverBranch).
  if (sameBranch(sb, s.placeReleased!.branch)) return true;
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

/** The line that tells a worker its uncommitted work was committed for it before its sandbox was released (w656). */
export function savedNote(w: NonNullable<SessionInfo['savedWork']>): string {
  return `[saved] While you were stopped, FF Factory committed your uncommitted work (${w.files} file(s), new ones included) on your branch \`${w.branch}\` as ${w.sha}, ${w.pushed ? 'and pushed it' : 'not pushed yet (the next switch away pushes it)'}, so your sandbox could take other work. \`git reset HEAD~1\` gives it back uncommitted if that commit is still on top; or keep it and go on.`;
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
  /** Why it waits on CI (its requests blocked on a CI gate, Agents.ciWait, w846), or undefined. */
  ciWait?: (s: SessionInfo) => string | undefined;
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
  /** Sandboxes were released: capacity may have freed for queued work (w656). */
  freed?: (what: string) => void;
  /** Whether the machine's daemon saves uncommitted work (MachineManager.canSaveWork, w656). */
  canSave?: (machineId: string) => boolean;
  /** Commit and push a sandbox's uncommitted work on a branch, on its machine (MachineManager.saveWork, w656). */
  saveWork?: (machineId: string, sandbox: string, branch: string, message: string, sessionId?: string) => Promise<SaveResult>;
  report?: (text: string) => void;
  now?: () => number;
}

export class PlaceAgain {
  private readonly d: PlaceAgainDeps;
  /** Placements under way: session id to the machine and sandbox it is being put in. */
  private readonly placing = new Map<string, { machine: string; sandbox: string }>();
  /** "<session>/<sandbox>" to when a placement there failed. */
  private readonly failed = new Map<string, number>();
  /** "<machine>/<sandbox>" saves under way (w656). */
  private readonly saving = new Set<string>();
  /** "<machine>/<sandbox>" to when and why its last save failed. */
  private readonly saveFailed = new Map<string, { at: number; why: string }>();
  /** Saves under way, for tests to wait on. */
  readonly pending = new Set<Promise<void>>();

  constructor(d: PlaceAgainDeps) {
    this.d = d;
  }

  private now() {
    return (this.d.now ?? Date.now)();
  }

  private facts(machineId: string): PlaceFacts {
    return {
      sessions: [...this.d.sessions()].filter((s) => s.machineId === machineId && s.machineSandbox),
      live: this.d.isLive,
      unityHolders: this.d.unityHolders(machineId),
      now: this.now(),
      over: this.d.workOver,
      ...(this.d.canSave ? { canSave: this.d.canSave(machineId) } : {}),
      saveRefused: (sandbox) => {
        const x = this.saveFailed.get(`${machineId}/${sandbox}`);
        return x && this.now() - x.at < RETRY_FAILED_MS ? x.why : undefined;
      },
    };
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
   * Why a stopped worker whose sandbox could be released still holds it, for its line in list_sandboxes: "its sandbox
   * stays held although its work is over (…): 2 uncommitted change(s) there". Undefined when nothing would release it
   * (its resume is near, its w613 hold still runs, it released it, or it is not stopped).
   */
  keptLine(s: SessionInfo): string | undefined {
    if (s.kind !== 'worker' || !s.machineId || !s.machineSandbox || s.placeReleased || s.status !== 'stopped' || this.d.isLive(s.id)) return undefined;
    const sb = this.d.machine(s.machineId)?.sandboxes?.find((x) => x.id === s.machineSandbox);
    const why = sb && (ciReleaseWhy(sb, this.d.ciWait?.(s)) ?? releaseWhy(s, this.now(), this.d.workOver(s)));
    const kept = why && keptWhy(s, sb, this.facts(s.machineId));
    return kept ? `its sandbox stays held although ${why}: ${kept}` : undefined;
  }

  /**
   * The release pass (every minute): release the sandboxes of stopped workers whose resume is far, stop the process of
   * a worker between turns with only a far check-in (the next pass releases it), and give a released worker its sandbox back
   * when its check-in nears and that is still free. Returns what it did, for the log and tests.
   */
  tick(): string[] {
    const did: string[] = [];
    const freed = new Set<string>();
    const byMachine = new Map<string, PlaceFacts>();
    for (const s of [...this.d.sessions()]) {
      if (s.kind !== 'worker' || !s.machineId || !s.machineSandbox) continue;
      const m = this.d.machine(s.machineId);
      const sb = m?.sandboxes?.find((x) => x.id === s.machineSandbox);
      if (!m || !sb) continue;
      let f = byMachine.get(m.id);
      if (!f) byMachine.set(m.id, (f = this.facts(m.id)));
      const live = this.d.isLive(s.id);
      const step = releaseStep(s, sb, { ...f, workOver: this.d.workOver(s), ciWait: this.d.ciWait?.(s), keepLive: live ? this.d.keepLive(s.id) : undefined, claimedBy: s.placeReleased ? this.claimedBy(m.id, sb.id) : undefined });
      if (!step) continue;
      if (step.do === 'stop') {
        // Stopped while Idle: its sandbox stays its until the next pass releases it, its worktree clean (w656).
        if (step.due) {
          s.releaseDue = { at: new Date(this.now()).toISOString(), why: step.why };
          this.d.save(s);
        }
        this.d.stopLive(s.id, step.why);
        did.push(`stopped ${s.id} (${step.why}): its sandbox ${m.id}/${sb.id} is released once it has stopped`);
      } else if (step.do === 'release' && step.save) {
        const key = `${m.id}/${sb.id}`;
        if (this.saving.has(key) || !this.d.saveWork) continue;
        this.saving.add(key);
        const p = this.saveThenRelease(s, m, sb, step).finally(() => {
          this.saving.delete(key);
          this.pending.delete(p);
        });
        this.pending.add(p);
        did.push(`saving the uncommitted work in ${key} of ${s.id} before releasing it (${step.why})`);
      } else if (step.do === 'release') {
        s.placeReleased = { at: new Date(this.now()).toISOString(), sandbox: sb.id, branch: step.branch, why: step.why };
        delete s.releaseDue;
        delete s.heldSince;
        this.d.save(s);
        this.d.note(s.id, `Its sandbox ${m.id}/${sb.id} is released for other work while it waits: ${step.why}, and its worktree is clean (branch ${step.branch}). When it resumes it is placed again, back here if this sandbox is still free.`);
        did.push(`released ${m.id}/${sb.id} of ${s.id} (${step.why})`);
        freed.add(`${m.id}/${sb.id}`);
      } else {
        delete s.placeReleased;
        this.d.save(s);
        did.push(`${s.id} holds ${m.id}/${sb.id} again: its check-in is near`);
      }
    }
    for (const line of did) console.log(`place again: ${line}`);
    // Queued work may take them now: the dispatcher hears it (w656, Orchestrators.capacityMayHaveFreed).
    if (freed.size) this.d.freed?.(`sandbox${freed.size > 1 ? 's' : ''} ${[...freed].join(', ')} released`);
    return did;
  }

  /**
   * Commit and push what is uncommitted in `sb` on the worker's branch (its daemon, w656), then release the sandbox for
   * it and for every other stopped worker there whose release is due, each told what was saved. A save that fails
   * keeps the sandbox held: list_sandboxes says why, and it is tried again after RETRY_FAILED_MS.
   */
  private async saveThenRelease(s: SessionInfo, m: Machine, sb: MachineSandbox, step: { why: string; branch: string }) {
    const key = `${m.id}/${sb.id}`;
    try {
      const res = await this.d.saveWork!(m.id, sb.id, step.branch, `FF Factory: saved ${s.id}'s uncommitted work before releasing ${key} (w656)\n\nIts sandbox was released because ${step.why}. \`git reset HEAD~1\` gives the work back uncommitted.`, s.id);
      this.saveFailed.delete(key);
      const f = this.facts(m.id);
      const group = f.sessions.filter((o) => o.machineSandbox === sb.id && (o.id === s.id || releasable(o, f)));
      const at = new Date(this.now()).toISOString();
      for (const o of group) {
        if (f.live(o.id) || o.placeReleased || o.queuedSend) continue;
        const why = releaseWhy(o, f.now, f.over?.(o)) ?? step.why;
        o.placeReleased = { at, sandbox: sb.id, branch: step.branch, why };
        if (res.sha) o.savedWork = { sha: res.sha, files: res.files, pushed: res.pushed, branch: step.branch, at };
        delete o.releaseDue;
        delete o.heldSince;
        this.d.save(o);
        this.d.note(o.id, `Its uncommitted work in ${key} was saved (${res.notes.join('; ')}) and the sandbox is released for other work while it waits: ${why}. When it resumes it is placed again on its branch ${step.branch}, back here if this sandbox is still free.`);
      }
      console.log(`place again: saved and released ${key} of ${group.map((o) => o.id).join(', ')} (${res.notes.join('; ')})`);
      this.d.freed?.(`sandbox ${key} released`);
    } catch (e) {
      const why = (e as Error).message;
      const was = this.saveFailed.get(key);
      this.saveFailed.set(key, { at: this.now(), why });
      if (was?.why !== why) this.d.note(s.id, `Its sandbox ${key} stays held: its uncommitted work could not be saved (${why}). Nothing was changed there; FF Factory tries again in ${RETRY_FAILED_MS / 60_000} min.`);
      console.warn(`place again: saving ${key} of ${s.id} failed: ${why}`);
    }
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
