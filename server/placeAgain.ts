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
 * A worker that ends its turn with nothing left for it to do in its sandbox, because it waits only on a deploy, a person,
 * another request or a pull request merging (w890, lothsahn: "We should not wait for a worker waiting for a deploy.
 * Update FF Factory to free the slot immediately once work is done"), releases it at once, as one waiting on CI does
 * (w846): `waitOn`, below.
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
import { unityInstanceName } from '../shared/unityInstance.ts';
import type { WorkPriority } from '../shared/types.ts';
import { PREEMPT_STANDS_MS, RECLAIM_STANDS_MS, pickReclaim, preemptNotice, preemptResume, protectedUntil, rankOf, topPriority, type Pressure, type SandboxHolders } from './priorityReclaim.ts';

/**
 * A stopped worker's check-in further away than this releases its sandbox. Moving it costs a few minutes when it comes
 * back (measured and sourced, docs/machines.md "Placing work"): an editor stop (at most 30 s), a fetch and switch (2 s
 * fetch, under a second for the 85 files of a typical branch), a warm editor start (78-83 s to a live bridge) and a
 * recompile of what differs (a full one took 37 s on the M3). Half an hour is ten times that.
 */
export const RELEASE_AFTER_MS = 30 * 60_000;

/**
 * How long a worker whose Live view is up keeps its process, its sandbox and its editor while it waits on a person (w1582):
 * after its last activity, a working day and a half. Ben, on four art requests that waited on him in the Live view: "The
 * live views aren't working". The release pass had stopped each about 6 minutes after its turn ended (w890) and released
 * its sandbox 4 minutes later, so his words reached no agent and the editor behind the view went to other work. Past this
 * the release goes ahead as before, and the view ends with it (liveLost): its next message asks it to stage the view again.
 * The length is a guess: long enough for a wait overnight, short enough that a forgotten view frees its editor in a day.
 */
export const LIVE_HOLD_MS = 12 * 60 * 60_000;

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
const releasable = (o: SessionInfo, f: PlaceFacts) => !f.live(o.id) && o.status === 'stopped' && !o.placeReleased && !o.pendingPermissions.length && !!(releaseWhy(o, f.now, f.over?.(o)) ?? (o.queuedSend ? undefined : (f.waitOf?.(o) ?? f.reclaiming?.(o.id))));

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
  /** w2358: what an agent there waits on (CI, a deploy, a person, a request), for the others in a sandbox: it releases too. */
  waitOf?: (s: SessionInfo) => string | undefined;
  /** w2358: whether an agent's open work is all not the game's (w1098): it sits on an agent seat, not in the game tree. */
  agentOnly?: (s: SessionInfo) => boolean;
  /** Why the last save of a sandbox failed, while it is not tried again (RETRY_FAILED_MS), or undefined. */
  saveRefused?: (sandbox: string) => string | undefined;
  /** w3507: why an agent's sandbox is being taken for higher queued work, for the others in it: it releases too. */
  reclaiming?: (id: string) => string | undefined;
  /**
   * w3843: the agents occupying each sandbox (occupiedIn), set where nothing changes them while it is read (PlaceAgain.claims):
   * usable() looked through every session of the machine for each waiting worker and sandbox.
   */
  occupied?: ReadonlyMap<string, readonly string[]>;
  /**
   * w3855: `sessions` by sandbox, in their order, set by the release pass (no step there moves an agent to another sandbox):
   * keptWhy looked through every session of the machine for each worker it asked about.
   */
  bySandbox?: ReadonlyMap<string, readonly SessionInfo[]>;
}

/** w3855: the sessions of `f` in sandbox `sb`, in their order (bySandbox when the caller grouped them). */
const inSandbox = (f: PlaceFacts, sb: string): readonly SessionInfo[] => (f.bySandbox ? (f.bySandbox.get(sb) ?? []) : f.sessions.filter((o) => o.machineSandbox === sb));

/** w3855: `f` with its sessions grouped by sandbox (PlaceFacts.bySandbox). */
export function groupedBySandbox(f: PlaceFacts): PlaceFacts {
  const by = new Map<string, SessionInfo[]>();
  for (const o of f.sessions) if (o.machineSandbox) (by.get(o.machineSandbox) ?? by.set(o.machineSandbox, []).get(o.machineSandbox)!).push(o);
  return { ...f, bySandbox: by };
}

/** w3843: the ids of the agents occupying each sandbox of `f` (occupies), by sandbox id. */
export function occupiedIn(f: PlaceFacts): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const o of f.sessions) if (o.machineSandbox && occupies(o, f.live(o.id), f.now)) (out.get(o.machineSandbox) ?? out.set(o.machineSandbox, []).get(o.machineSandbox)!).push(o.id);
  return out;
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
  // w1983: unread (its daemon's 2-minute read failed or has not come; lothdesktop/slot5 still said so 10 min after 2e29f29e
  // was stopped at 04:26Z on 2026-10-24): a daemon that saves reads it itself in the save (releaseStep: save), which commits
  // only what is there and refuses, with git's own reason, on another branch.
  if (!g && !f.canSave) return 'its git state is not known yet';
  // The stop that made its release due writes a line of its own (it moves lastActivityAt): the work is what counts (w890,
  // measured live on 2026-10-10: stop 19:29:40Z, release 19:31:40Z, waiting for the daemon's next 2-minute git read).
  if (g && Date.parse(g.at ?? '') < Date.parse(s.releaseDue?.workedAt ?? s.lastActivityAt)) return 'its git state has not been read since the worker last worked';
  const over = f.over?.(s);
  // w2358: a pair leg leaves its sandbox on the commit it ran (biscuit/slot2, d54d715f, w2281 done: "the sandbox is on
  // detached HEAD", held from 2026-10-26 11:08Z on). With nothing uncommitted and its work over, nothing of it is there:
  // the commit stays in the worktree's HEAD reflog, and the release names it.
  if (g && g.branch === 'detached HEAD' && !(over && !dirtyOf(sb))) return 'it is not on a branch';
  if (g && g.branch === '?') return 'it is not on a branch';
  const other = inSandbox(f, sb.id).find((o) => o.id !== s.id && occupies(o, f.live(o.id), f.now) && !releasable(o, f));
  // w2358: for a worker whose work is over, another agent there keeps the sandbox by itself (free() counts it), and a
  // Unity batch run of that sandbox is that agent's (the holder is per sandbox, not per worker: beast/slot2's bfa0f5c7,
  // w2311 and w2325 done, was held by "a Unity batch run of that sandbox is in flight" beside w2337's worker).
  if (over && other) return undefined;
  if (f.unityHolders.includes(`sandbox:${sb.id}`)) return 'a Unity batch run of that sandbox is in flight';
  if (other) return `agent ${other.id} works there too, on the same branch`;
  if (g && !dirtyOf(sb)) return undefined;
  // Its daemon commits and pushes them first (w656), unless its last try failed a moment ago.
  const refused = f.saveRefused?.(sb.id);
  if (refused) return `its uncommitted work could not be saved: ${refused}`;
  if (!g) return undefined;
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

/**
 * Why a worker that waits on something nobody in its sandbox can move may give up its sandbox now (w890), or undefined:
 * its requests wait on a deploy, a person, another request or a pull request merging (`waitOn`, Agents.waitOn), and its
 * branch has no commit its remote lacks. lothsahn, on w889 holding m3's only sandbox after its PR merged while it waited
 * for the portal deploy and a token permission: "Why is w889 holding a slot? It's done with its work and it should free
 * the slot." Unlike CI (ciReleaseWhy), a running editor does not keep it: nothing is about to be read or fixed in it, and
 * the placement that takes the sandbox stops the editor first (as for any release, w656). A Unity batch run of its, and
 * uncommitted work the daemon cannot save, still keep it (keptWhy). The block, the person or the deploy resumes it; it is
 * then placed again like any released worker.
 */
export function waitReleaseWhy(sb: MachineSandbox, waitOn: string | undefined): string | undefined {
  if (!waitOn || (sb.git?.ahead ?? 0) > 0) return undefined;
  return waitOn;
}

/**
 * w3855: a released worker that takes no step whatever its waits, holds and work say (releaseStep): live, a message queued, or
 * no check-in still to come. The release pass skips reading those for it (every released worker the store keeps, most of them).
 */
export const staysReleased = (s: Pick<SessionInfo, 'wakeAt' | 'queuedSend'>, live: boolean, now: number) =>
  live || !s.wakeAt || !!s.queuedSend || Date.parse(s.wakeAt) <= now - OVERDUE_MS;

export function releaseStep(s: SessionInfo, sb: MachineSandbox | undefined, f: PlaceFacts & { workOver?: string; keepLive?: string; claimedBy?: string; ciWait?: string; waitOn?: string; liveHold?: string; pairHold?: string; reclaim?: string }): ReleaseStep {
  if (s.kind !== 'worker' || !s.machineId || !s.machineSandbox || !sb) return undefined;
  // Its Live view is up while it waits on a person (w1582, LIVE_HOLD_MS): neither stopped nor released, so the person's
  // words reach it at once and the editor behind the view stays its. Its work being over ends the hold (Agents.liveHold).
  if (f.liveHold && !s.placeReleased) return undefined;
  // A leg of a pair run under way (w2305): neither stopped nor released until the run is over or re-queued, whatever its
  // check-in, its wait on its partner or its idle time say (Agents.pairHold).
  if (f.pairHold && !s.placeReleased) return undefined;
  const live = f.live(s.id);
  const far = farWhy(s, f.now, f.workOver);
  // Waiting on CI (w846), else on a deploy, a person or another request (w890): its sandbox may go at once.
  const ci = ciReleaseWhy(sb, f.ciWait) ?? waitReleaseWhy(sb, f.waitOn);
  if (s.placeReleased) {
    // While its CI runs, or it waits on a deploy or a person, it stays released (w846, w890): its check-in, its unblock or a message places it again.
    if (f.ciWait || f.waitOn) return undefined;
    // Its check-in is near again: back to its own sandbox, while that is still free and on its branch.
    if (staysReleased(s, live, f.now) || far) return undefined;
    if (s.placeReleased.sandbox !== sb.id || sb.status !== 'ready' || sb.git?.branch !== s.placeReleased.branch || (f.claimedBy && f.claimedBy !== s.id)) return undefined;
    const taken = inSandbox(f, sb.id).some((o) => o.id !== s.id && occupies(o, f.live(o.id), f.now));
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
    // w3507: higher queued work takes its sandbox (server/priorityReclaim.ts): whatever its check-in or idle time, but never
    // with a background job of its running (stopping its process would end it).
    if (!step && f.reclaim && !(st.state === 'between_turns' && st.kind === 'job')) step = { do: 'stop', why: f.reclaim, due: true };
    return step && (f.agentOnly?.(s) || !keptWhy(s, sb, f)) ? step : undefined;
  }
  if (s.status !== 'stopped' || s.pendingPermissions.length) return undefined;
  // Waiting on CI, a deploy or a person (w846, w890): released whatever its check-in, which places it again when it comes.
  // w3507: or higher queued work takes it (priorityReclaim.ts): its unpushed commits stay in the machine's repository, and the
  // switch that hands the sandbox over pushes them first (switchBranch), so they need not be pushed before.
  const why = (s.queuedSend ? undefined : ci) ?? releaseWhy(s, f.now, f.workOver) ?? (s.queuedSend ? undefined : f.reclaim);
  if (!why) return undefined;
  // w2358: a worker on an agent seat (w1098: dafd0fe0's w2191 beside d54d715f in biscuit/slot2) has no work in the game
  // tree: what is there (its branch, uncommitted files, a batch run) is the sandbox's other agents', never its to keep.
  if (f.agentOnly?.(s)) return { do: 'release', why, branch: sb.git?.branch ?? sb.branch };
  if (keptWhy(s, sb, f)) return undefined;
  // w1983: with its git state unread, the save reads it (keptWhy): on the sandbox's own branch.
  return { do: 'release', why, branch: sb.git?.branch ?? sb.branch, ...(dirtyOf(sb) || !sb.git ? { save: true } : {}) };
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
  if (f.occupied) return !(f.occupied.get(sb.id) ?? []).some((id) => id !== s.id);
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

/**
 * Where a released worker whose work is not the game's resumes on machine `m` (w1135, the w1098 rule: FF Factory, FFBox or
 * another repo's work runs in its own clone and needs an agent seat, not a game sandbox): its own sandbox while it has a
 * seat (fewer than `max` agents there), else the sandbox with the most seats free; nothing is switched or stopped there.
 * b3327616 (w1097, ff-factory work) waited for a free lothdesktop sandbox on 2026-10-12 while 7 of its 10 seats were free.
 */
export function seatFor(s: SessionInfo, m: Pick<Machine, 'id' | 'sandboxes'>, f: PlaceFacts, max: number): { sandbox: MachineSandbox } | { wait: string } {
  const sbs = (m.sandboxes ?? []).filter((sb) => sb.status === 'ready' && !sb.lingering?.some((l) => l.sessionId !== s.id));
  const agents = (sb: MachineSandbox) => f.sessions.filter((o) => o.id !== s.id && o.machineSandbox === sb.id && occupies(o, f.live(o.id), f.now)).length;
  const own = sbs.find((x) => x.id === s.placeReleased!.sandbox);
  if (own && agents(own) < max) return { sandbox: own };
  const other = sbs.filter((x) => agents(x) < max).sort((a, b) => agents(a) - agents(b) || a.id.localeCompare(b.id))[0];
  return other ? { sandbox: other } : { wait: `no agent seat is free on ${m.id} (every sandbox has ${max} agents); its work needs only a seat (w1098), and it takes the first that frees` };
}

/** The line that tells a worker its uncommitted work was committed for it before its sandbox was released (w656). */
export function savedNote(w: NonNullable<SessionInfo['savedWork']>): string {
  return `[saved] While you were stopped, FF Factory committed your uncommitted work (${w.files} file(s), new ones included) on your branch \`${w.branch}\` as ${w.sha}, ${w.pushed ? 'and pushed it' : 'not pushed yet (the next switch away pushes it)'}, so your sandbox could take other work. \`git reset HEAD~1\` gives it back uncommitted if that commit is still on top; or keep it and go on.`;
}

/**
 * The line that tells a worker its Live view ended while it was stopped (w1582), put before the message that resumes it:
 * the person may be opening the view to steer the art, and only the agent can stage it again.
 */
export function liveLostNote(l: NonNullable<SessionInfo['liveLost']>): string {
  const knobs = l.materials.length ? `materials ${JSON.stringify(l.materials)}, ` : '';
  return `[live view] Your Live view ended while you were stopped (${utcTime(l.at)}): your sandbox was released because ${l.why}, so the view could no longer show your game. The person may be opening it now to steer the art by talking to you. Before you answer, stage it again: your sandbox's editor up (mcp__machine__unity start), the scene and the asset on screen in play mode, the HUD hidden, the camera where they should look; then live_view start (${knobs}fps ${l.fps}, width ${l.width}) and say in your reply that it is streaming again.`;
}

/** The line that tells a moved worker where it is now, put before the message that resumes it. */
export function movedNote(m: Pick<Machine, 'id'>, from: NonNullable<SessionInfo['movedFrom']>, to: Pick<MachineSandbox, 'id' | 'path'>): string {
  const branch = from.branch;
  // w1135: work that is not the game's resumes on an agent seat, beside whoever works in that sandbox now.
  if (from.shared) {
    const where = from.sandbox === to.id ? `You resume in it again, beside the agent that works there now` : `You resume in sandbox ${m.id}/${to.id} (\`${to.path}\`), beside the agent that works there`;
    return `[moved] While you were stopped your sandbox ${m.id}/${from.sandbox} went to other work (it was released because ${from.why}). Your work is not the game's, so it needs only an agent seat, not a free sandbox (w1098). ${where}. Its game tree is that agent's, on its own branch: do not edit, commit, stash, switch branches or start Unity there. Work in your own clone in your temp folder, as before; your game branch \`${branch}\` is untouched. Then carry on.`;
  }
  return `[moved] While you were stopped your sandbox ${m.id}/${from.sandbox} went to other work (it was released because ${from.why}). You work in sandbox ${m.id}/${to.id} now: \`${to.path}\`, on your branch \`${branch}\`, checked out here with all its commits. Work only in this folder from now on; \`${from.path}\` is another worker's. Your Unity editor is this sandbox's (\`${unityInstanceName(to.path)}\`): set_active_instance again with that name before any Unity call; its first start here recompiles what differs. Then carry on.`;
}

export interface PlaceAgainDeps {
  sessions: () => Iterable<SessionInfo>;
  machine: (id: string) => Machine | undefined;
  /** Every machine, for the save of sandboxes nobody holds (w2358, orphanSave); absent in tests that do not need it. */
  machines?: () => Iterable<Machine>;
  isLive: (id: string) => boolean;
  online: (machineId: string) => boolean;
  /** Unity slot holders with a batch run granted or waiting on the machine ("sandbox:<id>"). */
  unityHolders: (machineId: string) => string[];
  /** Why its work is over (its requests closed or with another worker), or undefined. */
  workOver: (s: SessionInfo) => string | undefined;
  /** Why it waits on CI (its requests blocked on a CI gate, Agents.ciWait, w846), or undefined. */
  ciWait?: (s: SessionInfo) => string | undefined;
  /** Why it waits on a deploy, a person, another request or a pull request merging, nothing else (Agents.waitOn, w890), or undefined. */
  waitOn?: (s: SessionInfo) => string | undefined;
  /**
   * Which of two released workers waiting for a sandbox resumes first (w1099): by their requests' priority, then the oldest
   * request (Agents.resumeOrder). Unset, or a tie: session id order.
   */
  order?: (a: SessionInfo, b: SessionInfo) => number;
  /**
   * Whether a worker's open requests are all work that is not the game's (w1098 `needs: 'agent'`: FF Factory, FFBox, another
   * repo's), so it resumes on an agent seat (seatFor), not a game sandbox (w1135). Unset: every worker is game work.
   */
  agentOnly?: (s: SessionInfo) => boolean;
  /**
   * Sandboxes of a machine kept for a worker on its way there (w1668: an urgent release's builder moving into slot1,
   * BuildPlans.seats): sandbox to session id. Nobody else is placed there meanwhile, and no new work starts there.
   */
  reserved?: (machineId: string) => ReadonlyMap<string, string>;
  /** How many agents a sandbox of the machine takes (its pool's max_agents_per_sandbox; default 2). */
  seats?: (machineId: string) => number;
  /** Run the release pass again soon (a worker was just stopped to release its sandbox: w890 frees it within a minute of its turn's end). */
  soon?: () => void;
  /** Runs a release pass (w2026): AgentManager indexes the requests by worker for its length, so workOver, ciWait and waitOn read a worker's own requests, not all of them. */
  pass?: <T>(run: () => T) => T;
  /** Why a live idle worker must keep its process, its check-in aside (Agents.keepIdle without the wake), or undefined. */
  keepLive: (id: string) => string | undefined;
  /** Why it keeps its process and sandbox for its Live view while it waits on a person (Agents.liveHold, w1582), or undefined. */
  liveHold?: (s: SessionInfo) => string | undefined;
  /** Why it keeps its sandbox as a leg of a pair run under way (Agents.pairHold, w2305), or undefined. */
  pairHold?: (s: SessionInfo) => string | undefined;
  /**
   * Its sandbox was released (or it is released) while a Live view of it runs (w1582): stop the view, which would otherwise
   * show whatever that sandbox's editor shows next, another worker's game included, and record it so its next message asks
   * it to stage the view again (SessionInfo.liveLost). Nothing when it has no view.
   */
  liveLost?: (s: SessionInfo, why: string) => void;
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
  /**
   * w3507 (server/priorityReclaim.ts): queued game work by priority, with the computers one free sandbox would make room on.
   * Read once a pass: claims() and answer() read the pass's copy, since computing it reads free(), which reads claims().
   */
  pressure?: () => readonly Pressure[];
  /**
   * w3588: each Queued pair run (Agents.pairPlan) with the computers where one free sandbox lets it start, read once a pass
   * as pressure is. A released worker of no higher priority yields such a computer to it: it neither claims it nor holds it
   * again for its check-in.
   */
  pairWants?: () => readonly PairWant[];
  /** w3507: the highest priority of a worker's open requests, or undefined for none. */
  priorityOf?: (s: SessionInfo) => WorkPriority | undefined;
  /** w3507: why a worker's sandbox is never taken for higher work now (a pair or timed leg, the release lane, a bench lock, a Live view, ...), or undefined. */
  reclaimHold?: (s: SessionInfo, sb: MachineSandbox) => string | undefined;
  /** w3507: a sandbox was taken for queued work (released, or a mid-turn worker asked to yield): the ledger lines and the orchestrators'. */
  reclaimed?: (e: { work: string; machine: string; sandbox: string; sessions: SessionInfo[]; why: string; preempt: boolean; released: boolean }) => void;
  /** w3507: why no sandbox may be taken for queued work `work`, for its Queued line (undefined: it took one or has room). */
  reclaimNone?: (work: string, why: string | undefined) => void;
  /** w3507: a message to a worker (a mid-turn one reads it between tool calls; a released one's waits in the send queue). */
  tell?: (sessionId: string, text: string) => void;
  /** w3507: a worker's open request ids, for the line a pre-empted worker ends its turn with. */
  requestsOf?: (s: SessionInfo) => string[];
}

/** w3507: a reclaimed worker is placed again: its protection (RECLAIM_PROTECT_MS) counts from now. */
function backFrom(s: SessionInfo, now: number) {
  if (s.reclaimed && !s.reclaimed.backAt) s.reclaimed.backAt = new Date(now).toISOString();
}

/** w3507: a sandbox being taken for queued work: the request, its priority, the workers there, since when. */
interface Reclaim {
  work: string;
  priority: WorkPriority;
  machine: string;
  sandbox: string;
  sessions: string[];
  at: number;
  preempt: boolean;
  why: string;
  /** Its sandbox was released (the ledger heard it once). */
  released?: boolean;
}

/** w3588: a Queued pair run and the computers where one free sandbox lets it start (PlaceAgainDeps.pairWants). */
export interface PairWant {
  work: string;
  priority: WorkPriority | undefined;
  machines: string[];
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
  /**
   * During a release pass, each machine's claims, computed once (w2026): the pass asked claimedBy for every released worker,
   * and each ask sorted all the machine's waiting workers again (37 s stalls of the portal on 2026-10-24, its stall profile:
   * tick > claimedBy > claims > facts). A machine's entry goes when the pass does something there.
   */
  private claimsMemo?: Map<string, Map<string, string>>;
  /**
   * w3843: within a claims memo, each machine's placed sessions (facts().sessions), grouped in one pass over the store. After
   * the 2026-11-09 13:03Z restart every facts() filtered all of the store's sessions again (stall profile: facts, 10-17 s
   * portal blocks); a pass asked it hundreds of times. Goes with claimsMemo: a machine's entry with its claims.
   */
  private sessionsMemo?: Map<string, SessionInfo[]>;
  /** w3843: d.agentOnly by session within a claims memo (it reads the ledger, which nothing in a memo changes: a send runs outside it). */
  private agentOnlyMemo?: Map<string, boolean>;
  /** w3843: bumped by every change answer() and a placement make (placing, failed, a worker back in place): a drain's memo goes. */
  private changes = 0;
  /** w3507: the pass's queued game work (PlaceAgainDeps.pressure), read by claims() and answer() between passes. */
  private pressureNow: readonly Pressure[] = [];
  /** w3588: the pass's Queued pair runs that one free sandbox would start (PlaceAgainDeps.pairWants). */
  private pairsNow: readonly PairWant[] = [];
  /** w3507: sandboxes being taken for queued work, by request id. */
  private readonly reclaims = new Map<string, Reclaim>();
  /** w3507: "<machine>/<sandbox>" to when a reclaim of it lapsed without freeing it: another is tried (RECLAIM_STANDS_MS). */
  private readonly missed = new Map<string, number>();

  constructor(d: PlaceAgainDeps) {
    this.d = d;
  }

  private now() {
    return (this.d.now ?? Date.now)();
  }

  private facts(machineId: string): PlaceFacts {
    return {
      sessions: this.sessionsOn(machineId),
      live: this.d.isLive,
      unityHolders: this.d.unityHolders(machineId),
      now: this.now(),
      over: this.d.workOver,
      waitOf: (s) => this.d.ciWait?.(s) ?? this.d.waitOn?.(s),
      ...(this.d.agentOnly ? { agentOnly: this.agentOnly } : {}),
      ...(this.d.canSave ? { canSave: this.d.canSave(machineId) } : {}),
      saveRefused: (sandbox) => {
        const x = this.saveFailed.get(`${machineId}/${sandbox}`);
        return x && this.now() - x.at < RETRY_FAILED_MS ? x.why : undefined;
      },
      reclaiming: (id) => this.reclaimOf(id)?.why,
    };
  }

  /** The sessions placed on `machineId`, in store order: grouped once per claims memo (w3843), else filtered now. */
  private sessionsOn(machineId: string): SessionInfo[] {
    const memo = this.sessionsMemo;
    if (!this.claimsMemo || !memo) return [...this.d.sessions()].filter((s) => s.machineId === machineId && s.machineSandbox);
    const had = memo.get(machineId);
    if (had) return had;
    if (!memo.size) {
      for (const s of this.d.sessions()) if (s.machineId && s.machineSandbox) (memo.get(s.machineId) ?? memo.set(s.machineId, []).get(s.machineId)!).push(s);
      const all = memo.get(machineId) ?? [];
      memo.set(machineId, all);
      return all;
    }
    // Its entry went (releasePass did something there): only its own sessions are read again.
    const out = [...this.d.sessions()].filter((s) => s.machineId === machineId && s.machineSandbox);
    memo.set(machineId, out);
    return out;
  }

  /** w3843: how many placement changes answer() and placements have made: a caller's memo of places and claims goes when it moves. */
  get gen(): number {
    return this.changes;
  }

  /** w3843: within a claims memo, everything computed goes (a worker was sent, moved or placed): the next asks compute afresh. */
  claimsChanged(): void {
    this.claimsMemo?.clear();
    this.sessionsMemo?.clear();
    this.agentOnlyMemo?.clear();
  }

  /** d.agentOnly, read once per session within a claims memo (w3843: Agents.workIdsOf scans every request for each ask). */
  private readonly agentOnly = (s: SessionInfo): boolean => {
    const read = this.d.agentOnly;
    if (!read) return false;
    const memo = this.agentOnlyMemo;
    if (!memo) return read(s);
    let v = memo.get(s.id);
    if (v === undefined) memo.set(s.id, (v = read(s)));
    return v;
  };

  private failedIn(id: string) {
    return (sandbox: string) => this.now() - (this.failed.get(`${id}/${sandbox}`) ?? -Infinity) < RETRY_FAILED_MS;
  }

  /**
   * Sandboxes of a machine spoken for by released workers waiting to resume: those being placed, then for each worker
   * whose message waits (by its requests' priority, then the oldest request, w1099; then id), the sandbox it would get.
   * Not free for new work (Agents.free).
   */
  claims(machineId: string): Map<string, string> {
    const memo = this.claimsMemo?.get(machineId);
    if (memo) return memo;
    const m = this.d.machine(machineId);
    const out = new Map<string, string>();
    if (!m) return out;
    for (const [id, p] of this.placing) if (p.machine === machineId) out.set(p.sandbox, id);
    for (const [sandbox, id] of this.d.reserved?.(machineId) ?? []) if (!out.has(sandbox)) out.set(sandbox, id);
    const read = this.facts(machineId);
    // Nothing below changes who occupies a sandbox: the occupants are read once (w3843).
    const f: PlaceFacts = { ...read, occupied: occupiedIn(read) };
    // A worker on work that is not the game's takes an agent seat, never a game sandbox (w1135): it claims none.
    const waiting = f.sessions.filter((s) => s.placeReleased && !f.live(s.id) && !this.placing.has(s.id) && this.d.queued(s.id) && !this.agentOnly(s) && !this.yieldsTo(s, machineId)).sort((a, b) => (this.d.order?.(a, b) ?? 0) || a.id.localeCompare(b.id));
    for (const s of waiting) {
      const p = placeFor(s, m, f, out, this.failedIn(s.id));
      if ('sandbox' in p) out.set(p.sandbox.id, s.id);
    }
    this.claimsMemo?.set(machineId, out);
    return out;
  }

  /**
   * w3507: the higher queued work a released worker on `machineId` waits behind, or undefined: queued game work of strictly
   * higher priority that a free sandbox there would make room for. Its resume claims no sandbox there meanwhile.
   */
  private yieldsTo(s: SessionInfo, machineId: string): Pressure | PairWant | undefined {
    if ((!this.pressureNow.length && !this.pairsNow.length) || !this.d.priorityOf) return undefined;
    const mine = rankOf(this.d.priorityOf(s));
    // w3588: a pair run the sandbox would start goes first from its own priority up, as its hold does against single work
    // (w1945). Live on 2026-11-08: beast/slot1 was released at 05:34:53Z with w3562 (high) holding biscuit for one leg and
    // fitting beast for the other, and at 05:35:15Z d3f81fb1 held it again for its check-in; pairs were never in pressure.
    return this.pressureNow.find((p) => rankOf(p.priority) > mine && p.machines.includes(machineId)) ?? this.pairsNow.find((p) => rankOf(p.priority) >= mine && p.machines.includes(machineId));
  }

  /** Whether any agent occupies the sandbox "<machine>/<sandbox>" now (a process, mid-turn, a permission open, its place held). */
  private occupiedNow(key: string): boolean {
    const [machine, sandbox] = key.split('/');
    const f = this.facts(machine);
    return f.sessions.some((o) => o.machineSandbox === sandbox && occupies(o, f.live(o.id), f.now));
  }

  /** The released worker a sandbox is spoken for by, or undefined. */
  claimedBy(machineId: string, sandbox: string): string | undefined {
    return this.claims(machineId).get(sandbox);
  }

  /** Released workers of a machine whose resume waits for a sandbox there (none is free for them). */
  waiting(machineId: string): string[] {
    const claimed = new Set(this.claims(machineId).values());
    return this.facts(machineId).sessions.filter((s) => s.placeReleased && !this.d.isLive(s.id) && this.d.queued(s.id) && !claimed.has(s.id) && !this.agentOnly(s)).map((s) => s.id);
  }

  /**
   * Why a stopped worker whose sandbox could be released still holds it, for its line in list_sandboxes: "its sandbox
   * stays held although its work is over (…): 2 uncommitted change(s) there". Undefined when nothing would release it
   * (its resume is near, its w613 hold still runs, it released it, or it is not stopped).
   */
  keptLine(s: SessionInfo): string | undefined {
    if (s.kind !== 'worker' || !s.machineId || !s.machineSandbox || s.placeReleased || s.status !== 'stopped' || this.d.isLive(s.id)) return undefined;
    const sb = this.d.machine(s.machineId)?.sandboxes?.find((x) => x.id === s.machineSandbox);
    const why = sb && (ciReleaseWhy(sb, this.d.ciWait?.(s)) ?? waitReleaseWhy(sb, this.d.waitOn?.(s)) ?? releaseWhy(s, this.now(), this.d.workOver(s)));
    const kept = why && (this.d.pairHold?.(s) ?? this.d.liveHold?.(s) ?? keptWhy(s, sb, this.facts(s.machineId)));
    return kept ? `its sandbox stays held although ${why}: ${kept}` : undefined;
  }

  /**
   * The release pass (every minute): release the sandboxes of stopped workers whose resume is far, stop the process of
   * a worker between turns with only a far check-in (the next pass releases it), and give a released worker its sandbox back
   * when its check-in nears and that is still free. Returns what it did, for the log and tests.
   */
  tick(): string[] {
    return this.withClaimsMemo(() => (this.d.pass ? this.d.pass(() => this.releasePass()) : this.releasePass()));
  }

  /**
   * Runs `fn` with each machine's claims computed once (w2044): Agents.places asks free() twice for every sandbox, and each
   * ask computed the machine's claims again, every session in the store filtered and sorted each time (1.0-1.1 s portal
   * blocks on 2026-10-24, stall profile: places > free > claimedBy > claims > facts). Inside a memo already (the release
   * pass), it adds none, so the pass's own invalidation stays.
   */
  withClaimsMemo<T>(fn: () => T): T {
    if (this.claimsMemo) return fn();
    this.claimsMemo = new Map();
    this.sessionsMemo = new Map();
    this.agentOnlyMemo = new Map();
    try {
      return fn();
    } finally {
      this.claimsMemo = undefined;
      this.sessionsMemo = undefined;
      this.agentOnlyMemo = undefined;
    }
  }

  /** w3843: runs `fn` as outside any claims memo (it changes placement); a memo it ran in is empty after it. */
  withoutClaimsMemo<T>(fn: () => T): T {
    const had = !!this.claimsMemo;
    this.claimsMemo = undefined;
    this.sessionsMemo = undefined;
    this.agentOnlyMemo = undefined;
    try {
      return fn();
    } finally {
      if (had) {
        this.claimsMemo = new Map();
        this.sessionsMemo = new Map();
        this.agentOnlyMemo = new Map();
      }
    }
  }

  private releasePass(): string[] {
    const did: string[] = [];
    const freed = new Set<string>();
    let stoppedDue = false;
    const byMachine = new Map<string, PlaceFacts>();
    const targets = this.reclaimPass(did);
    for (const s of [...this.d.sessions()]) {
      if (s.kind !== 'worker' || !s.machineId || !s.machineSandbox) continue;
      const m = this.d.machine(s.machineId);
      const sb = m?.sandboxes?.find((x) => x.id === s.machineSandbox);
      if (!m || !sb) continue;
      let f = byMachine.get(m.id);
      if (!f) byMachine.set(m.id, (f = groupedBySandbox(this.facts(m.id))));
      const live = this.d.isLive(s.id);
      // Released with a view still up (released before w1582, or the portal took the view back from its daemon): it ends.
      // Stopped past its hold (LIVE_HOLD_MS) with its sandbox still its (unsaved work keeps it): it ends too, so a view nobody
      // came back to does not keep the sandbox's editor from its idle stop (the daemon counts a running view as activity).
      if (!live && s.placeReleased) this.d.liveLost?.(s, s.placeReleased.why);
      else if (!live && s.status === 'stopped' && !(this.now() - Date.parse(s.lastActivityAt) < LIVE_HOLD_MS)) this.d.liveLost?.(s, `nobody came back to it within ${LIVE_HOLD_MS / 3_600_000} h`);
      if (s.placeReleased && staysReleased(s, live, f.now)) continue;
      const step = releaseStep(s, sb, { ...f, workOver: this.d.workOver(s), ciWait: this.d.ciWait?.(s), waitOn: this.d.waitOn?.(s), keepLive: live ? this.d.keepLive(s.id) : undefined, liveHold: this.d.liveHold?.(s), pairHold: this.d.pairHold?.(s), claimedBy: s.placeReleased ? this.claimedBy(m.id, sb.id) : undefined, reclaim: targets.get(s.id)?.why });
      if (!step) continue;
      // Its sessions stay grouped (sessionsMemo): no step moves a worker to another machine or sandbox in the pass.
      this.claimsMemo?.delete(m.id);
      if (step.do === 'stop') {
        // Stopped while Idle: its sandbox stays its until the next pass releases it, its worktree clean (w656).
        if (step.due) {
          s.releaseDue = { at: new Date(this.now()).toISOString(), why: step.why, workedAt: s.lastActivityAt };
          this.d.save(s);
          stoppedDue = true;
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
        this.reclaimDone(s, targets.get(s.id));
        this.d.save(s);
        this.d.note(s.id, `Its sandbox ${m.id}/${sb.id} is released for other work while it waits: ${step.why}, and its worktree is clean (branch ${step.branch}). When it resumes it is placed again, back here if this sandbox is still free.`);
        this.d.liveLost?.(s, step.why);
        did.push(`released ${m.id}/${sb.id} of ${s.id} (${step.why})`);
        freed.add(`${m.id}/${sb.id}`);
      } else {
        if (this.yieldsTo(s, m.id)) continue;
        delete s.placeReleased;
        backFrom(s, this.now());
        this.d.save(s);
        did.push(`${s.id} holds ${m.id}/${sb.id} again: its check-in is near`);
      }
    }
    this.orphanSave(did);
    for (const line of did) console.log(`place again: ${line}`);
    // A worker stopped to release its sandbox is released by the next pass: do not leave that a minute away (w890).
    if (stoppedDue) this.d.soon?.();
    // Queued work may take them now: the dispatcher hears it (w656, Orchestrators.capacityMayHaveFreed).
    // Only a sandbox nobody occupies now is capacity (w1089: slot5 was announced released while two agents were Working in it).
    const free = [...freed].filter((key) => !this.occupiedNow(key));
    if (free.length) this.d.freed?.(`sandbox${free.length > 1 ? 'es' : ''} ${free.join(', ')} released`);
    return did;
  }

  /** w3507: the standing reclaim whose sandbox worker `id` is in, or undefined. */
  private reclaimOf(id: string): Reclaim | undefined {
    for (const r of this.reclaims.values()) if (r.sessions.includes(id)) return r;
    return undefined;
  }

  /**
   * w3507: take a sandbox for queued game work that has no room (server/priorityReclaim.ts). Reads the pass's pressure
   * (kept for claims() and answer() until the next pass), ends reclaims whose work left the queue or that stood too long,
   * picks a sandbox for each request with none standing, highest priority first, and asks a mid-turn worker to yield once.
   * Returns the workers to stop or release this pass, each with why.
   */
  private reclaimPass(did: string[]): Map<string, Reclaim> {
    this.pressureNow = this.d.pressure?.() ?? [];
    this.pairsNow = this.d.pairWants?.() ?? [];
    this.claimsMemo?.clear();
    // The room it read counted the claims of released workers that now yield to it (yieldsTo): read it again without them,
    // or a sandbox one of them would have claimed looks taken and another worker's is freed for nothing.
    if (this.pressureNow.some((p) => !p.room) || this.pairsNow.length) {
      this.pressureNow = this.d.pressure?.() ?? [];
      this.pairsNow = this.d.pairWants?.() ?? [];
      this.claimsMemo?.clear();
    }
    const out = new Map<string, Reclaim>();
    if (!this.d.pressure || !this.d.priorityOf) return out;
    const now = this.now();
    const queued = new Map(this.pressureNow.map((p) => [p.work, p]));
    const byId = new Map([...this.d.sessions()].map((s) => [s.id, s]));
    for (const [work, r] of this.reclaims) {
      const stands = queued.has(work) && now - r.at < (r.preempt ? PREEMPT_STANDS_MS : RECLAIM_STANDS_MS);
      if (stands) continue;
      this.reclaims.delete(work);
      // It did not free the sandbox in time: another holder is tried for the request (RECLAIM_STANDS_MS).
      if (queued.has(work) && r.sessions.some((id) => !byId.get(id)?.placeReleased)) this.missed.set(`${r.machine}/${r.sandbox}`, now);
    }
    // A pre-empted worker: its turn's end releases it while its urgent work still waits; once that is gone, it carries on.
    for (const s of byId.values()) {
      if (!s.preempted || s.placeReleased) continue;
      const r = this.reclaimOf(s.id);
      if (r) continue;
      const p = queued.get(s.preempted.for);
      const mid = BUSY.has(s.status) || s.pendingPermissions.length > 0;
      if (p && !mid && s.machineId && s.machineSandbox) {
        const back: Reclaim = { work: p.work, priority: p.priority, machine: s.machineId, sandbox: s.machineSandbox, sessions: [s.id], at: now, preempt: true, why: `paused for urgent ${p.work}, which takes its sandbox (w3507)` };
        out.set(s.id, back);
        continue;
      }
      if (p) continue;
      const was = s.preempted.for;
      delete s.preempted;
      this.d.save(s);
      this.d.tell?.(s.id, `[FF Factory] Carry on (w3507): urgent ${was} no longer needs your sandbox. Carry on where you are; you keep your sandbox.`);
      did.push(`${s.id} carries on: urgent ${was} no longer needs its sandbox`);
    }
    for (const r of this.reclaims.values()) for (const id of r.sessions) if (!byId.get(id)?.placeReleased) out.set(id, r);
    let holders: SandboxHolders[] | undefined;
    const taken = new Set([...this.reclaims.values()].map((r) => `${r.machine}/${r.sandbox}`));
    for (const p of [...this.pressureNow].sort((a, b) => rankOf(b.priority) - rankOf(a.priority))) {
      if (p.room || this.reclaims.has(p.work)) {
        if (p.room) this.d.reclaimNone?.(p.work, undefined);
        continue;
      }
      holders ??= this.holders(now);
      const pick = pickReclaim(p, holders.filter((h) => !taken.has(`${h.machine}/${h.sandbox}`)));
      if ('none' in pick) {
        this.d.reclaimNone?.(p.work, pick.none);
        continue;
      }
      const preempt = 'preempt' in pick;
      const h = preempt ? pick.preempt : pick.reclaim;
      const key = `${h.machine}/${h.sandbox}`;
      taken.add(key);
      const reqs = h.sessions.map((s) => `${s.id} (${h.priority ?? 'no open request'})`).join(', ');
      const why = `${preempt ? 'pre-empted' : 'taken'} for ${p.priority} queued work ${p.work} (w3507)`;
      const r: Reclaim = { work: p.work, priority: p.priority, machine: h.machine, sandbox: h.sandbox, sessions: h.sessions.map((s) => s.id), at: now, preempt, why };
      this.reclaims.set(p.work, r);
      if (preempt) {
        for (const s of h.sessions) {
          s.preempted = { at: new Date(now).toISOString(), for: p.work, sandbox: key };
          this.d.save(s);
          this.d.tell?.(s.id, preemptNotice(p, key, this.d.requestsOf?.(s) ?? []));
        }
      } else for (const s of h.sessions) out.set(s.id, r);
      this.d.reclaimed?.({ work: p.work, machine: h.machine, sandbox: h.sandbox, sessions: h.sessions, why, preempt, released: false });
      did.push(`${preempt ? 'asked' : 'taking'} ${key} of ${reqs} ${preempt ? 'to yield ' : ''}for ${p.priority} ${p.work}`);
    }
    return out;
  }

  /**
   * w3507: the occupied sandboxes of the computers queued work presses on, as pickReclaim reads them: their occupants'
   * priority, whether one is mid-turn, and what keeps them (Agents.reclaimHold, a Live view or pair run, a protection, a
   * move or Unity batch run under way, a reclaim of it that did not free it).
   */
  private holders(now: number): SandboxHolders[] {
    const out: SandboxHolders[] = [];
    const machines = new Set(this.pressureNow.flatMap((p) => [...p.machines, ...p.preemptOn]));
    for (const mid of machines) {
      const m = this.d.machine(mid);
      if (!m || !this.d.online(mid)) continue;
      const f = this.facts(mid);
      for (const sb of m.sandboxes ?? []) {
        const sessions = f.sessions.filter((s) => s.machineSandbox === sb.id && !s.placeReleased && occupies(s, f.live(s.id), now));
        if (!sessions.length) continue;
        const key = `${mid}/${sb.id}`;
        const missed = this.missed.get(key);
        let blocked = sb.status !== 'ready' ? `the sandbox is ${sb.status}` : f.unityHolders.includes(`sandbox:${sb.id}`) ? 'a Unity batch run of it is in flight' : missed && now - missed < RECLAIM_STANDS_MS ? 'a reclaim of it did not free it' : undefined;
        for (const s of sessions) {
          if (blocked) break;
          const until = protectedUntil(s);
          blocked =
            s.kind !== 'worker' ? `${s.kind} ${s.id} is there`
            : s.status === 'starting' ? `${s.id} is starting`
            : this.placing.has(s.id) ? `${s.id} is being moved`
            : s.queuedSend ? `a message is resuming ${s.id}`
            : this.d.pairHold?.(s) ? `${s.id} runs a pair leg`
            : this.d.liveHold?.(s) ? `${s.id} keeps a Live view`
            : until && until > now ? `${s.id} was moved for higher work ${s.reclaimed?.for} and is protected until ${new Date(until).toISOString().slice(11, 16)}Z`
            : this.d.reclaimHold?.(s, sb);
        }
        const priority = topPriority(sessions.map((s) => this.d.priorityOf?.(s)));
        out.push({ machine: mid, sandbox: sb.id, sessions, priority, midTurn: sessions.some((s) => BUSY.has(s.status) || s.pendingPermissions.length > 0), ...(blocked ? { blocked } : {}), activeAt: Math.max(...sessions.map((s) => Date.parse(s.lastActivityAt) || 0)), editorStopped: sb.unity.state === 'stopped' });
      }
    }
    return out;
  }

  /** w3507: a worker's sandbox was released for queued work: its bounce count, its resume if it was asked to yield, the ledger's line once. */
  private reclaimDone(s: SessionInfo, r: Reclaim | undefined) {
    const pre = s.preempted;
    if (!r && !pre) return;
    const work = r?.work ?? pre!.for;
    s.reclaimed = { at: new Date(this.now()).toISOString(), for: work, count: (s.reclaimed?.count ?? 0) + 1, ...(pre ? { preempted: true } : {}) };
    if (pre) {
      delete s.preempted;
      this.d.tell?.(s.id, preemptResume(work));
    }
    if (r && !r.released) {
      r.released = true;
      const sessions = r.sessions.map((id) => [...this.d.sessions()].find((o) => o.id === id)).filter((o): o is SessionInfo => !!o);
      this.d.reclaimed?.({ work, machine: r.machine, sandbox: r.sandbox, sessions, why: r.why, preempt: r.preempt, released: true });
    }
  }

  /**
   * w2358: save the uncommitted changes in sandboxes nobody holds, onto the branch they are on, so they are room again.
   * Measured 2026-10-27 ~08:05Z: beast/slot1 (10 .mat files on w2276-pair-host) and beast/slot3 (Assets/Scenes/main.unity on
   * sandbox/slot3-w2341, written after d2d9c644's release had saved nothing) showed FREE, but a start there was refused by
   * the branch switch and a resume skipped them (usable), so ten queued requests and a waiting worker sat beside them.
   * Saved, never discarded: committed on its own branch and pushed (saveWork refuses master, main and develop, and too
   * much untracked output); a released worker on that branch gets it back when it resumes there. Only with the editor
   * closed (an open one may write again), no Unity batch run, no agent there and no claim on it.
   */
  private orphanSave(did: string[]) {
    if (!this.d.saveWork || !this.d.machines) return;
    for (const m of this.d.machines()) {
      if (!this.d.online(m.id) || (this.d.canSave && !this.d.canSave(m.id))) continue;
      let f: PlaceFacts | undefined;
      for (const sb of m.sandboxes ?? []) {
        const g = sb.git;
        if (sb.status !== 'ready' || !g || g.dirty <= 0 || sb.unity.state !== 'stopped' || sb.lingering?.length) continue;
        if (g.branch === 'detached HEAD' || g.branch === '?') continue;
        const key = `${m.id}/${sb.id}`;
        f ??= this.facts(m.id);
        if (this.saving.has(key) || f.saveRefused?.(sb.id) || f.unityHolders.includes(`sandbox:${sb.id}`)) continue;
        // As free() reads it: a stopped worker there that holds nothing (its work over, never released) does not keep its
        // changes unsaved while the sandbox shows FREE but takes nobody; it is told of the save as a released one is.
        if (f.sessions.some((o) => o.machineSandbox === sb.id && (occupies(o, f!.live(o.id), f!.now) || (!o.placeReleased && o.status !== 'stopped')))) continue;
        if (this.claimedBy(m.id, sb.id)) continue;
        this.saving.add(key);
        const p = this.saveOrphan(m, sb, g.branch).finally(() => {
          this.saving.delete(key);
          this.pending.delete(p);
        });
        this.pending.add(p);
        did.push(`saving the ${g.dirty} uncommitted change(s) left in ${key} on ${g.branch}, which no worker holds, so it is room again (w2358)`);
      }
    }
  }

  private async saveOrphan(m: Machine, sb: MachineSandbox, branch: string) {
    const key = `${m.id}/${sb.id}`;
    try {
      const res = await this.d.saveWork!(m.id, sb.id, branch, `FF Factory: saved the uncommitted work left in ${key} (w2358)\n\nNo worker held the sandbox, and a new start there would have been refused over it. \`git reset HEAD~1\` gives the work back uncommitted.`);
      this.saveFailed.delete(key);
      const at = new Date(this.now()).toISOString();
      for (const o of this.d.sessions()) {
        if (o.machineId !== m.id || (o.placeReleased ? o.placeReleased.branch !== branch : o.machineSandbox !== sb.id)) continue;
        if (res.sha) o.savedWork = { sha: res.sha, files: res.files, pushed: res.pushed, branch, at };
        this.d.save(o);
        this.d.note(o.id, `Uncommitted work left on its branch ${branch} in ${key} after its release was saved there (${res.notes.join('; ')}): it is yours when you resume.`);
      }
      console.log(`place again: saved the uncommitted work left in ${key} on ${branch} (${res.notes.join('; ')})`);
      if (!this.occupiedNow(key)) this.d.freed?.(`sandbox ${key} saved and free`);
    } catch (e) {
      const why = (e as Error).message;
      this.saveFailed.set(key, { at: this.now(), why });
      console.warn(`place again: saving the uncommitted work left in ${key} failed: ${why}`);
    }
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
        this.reclaimDone(o, this.reclaimOf(o.id));
        this.d.save(o);
        this.d.note(o.id, `Its uncommitted work in ${key} was saved (${res.notes.join('; ')}) and the sandbox is released for other work while it waits: ${why}. When it resumes it is placed again on its branch ${step.branch}, back here if this sandbox is still free.`);
        this.d.liveLost?.(o, why);
      }
      console.log(`place again: saved and released ${key} of ${group.map((o) => o.id).join(', ')} (${res.notes.join('; ')})`);
      // The save took a moment: an agent may have been started or resumed in the sandbox meanwhile (w1089).
      if (!this.occupiedNow(key)) this.d.freed?.(`sandbox ${key} released`);
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
    if (this.agentOnly(info)) return this.seat(info, m);
    const ahead = this.yieldsTo(info, m.id);
    if (ahead && !('room' in ahead)) return `Queued pair run ${ahead.work} (${ahead.priority ?? 'normal'}) starts with the next free sandbox on ${m.id}, so it takes it first (w3588); it is placed again after`;
    if (ahead) return `higher-priority queued work ${ahead.work} (${ahead.priority}) takes the next free sandbox on ${m.id} first (w3507); it is placed again after`;
    const f = this.facts(m.id);
    const taken = this.claims(m.id);
    const p = placeFor(info, m, f, taken, this.failedIn(info.id));
    if ('wait' in p) return p.wait;
    const sb = p.sandbox;
    if (sb.id === info.machineSandbox && sb.git?.branch === r.branch) {
      this.changes++;
      delete info.placeReleased;
      backFrom(info, this.now());
      this.d.save(info);
      return undefined;
    }
    void this.move(info, m, sb);
    return `being placed again in ${m.id}/${sb.id}${sb.git?.branch !== r.branch ? ` (switching it to its branch ${r.branch})` : ''}`;
  }

  /**
   * A released worker on work that is not the game's resumes now on an agent seat (w1135, seatFor): its record moves to the
   * sandbox (its own, or the one with the most seats free), with no branch switch and no editor stopped, and its first
   * message says it works beside that sandbox's agent, in its own clone. Undefined: it may go now; else why it waits.
   */
  private seat(info: SessionInfo, m: Machine): string | undefined {
    const r = info.placeReleased!;
    const p = seatFor(info, m, this.facts(m.id), this.d.seats?.(m.id) ?? 2);
    if ('wait' in p) return p.wait;
    const sb = p.sandbox;
    this.changes++;
    const from = info.machineSandbox!;
    const back = from === sb.id && sb.git?.branch === r.branch;
    if (!back) {
      const old = m.sandboxes?.find((x) => x.id === from);
      info.movedFrom = { sandbox: from, path: old?.path ?? from, at: new Date(this.now()).toISOString(), why: r.why, branch: r.branch, shared: true };
    }
    if (from !== sb.id) {
      info.machineSandbox = sb.id;
      for (const x of m.sandboxes ?? []) x.sessionIds = x.id === sb.id ? [...x.sessionIds.filter((i) => i !== info.id), info.id] : x.sessionIds.filter((i) => i !== info.id);
      this.d.saveMachine(m);
    }
    delete info.placeReleased;
    backFrom(info, this.now());
    this.d.save(info);
    const where = back ? `back in its own sandbox ${m.id}/${sb.id}` : `on an agent seat in ${m.id}/${sb.id}, beside the agent there (its work is not the game's, w1098)`;
    this.d.note(info.id, `Placed again ${where}; its game branch ${r.branch} is untouched.`);
    this.d.report?.(`[machines] ${info.id} "${info.title}" resumes ${where}: it had released its sandbox (${r.why}).`);
    console.log(`place again: ${info.id} placed ${where}`);
    return undefined;
  }

  /** Put a released worker in `sb` on its branch: stop the editor there, switch, then move its record and deliver. */
  private async move(info: SessionInfo, m: Machine, sb: MachineSandbox) {
    const r = info.placeReleased!;
    this.placing.set(info.id, { machine: m.id, sandbox: sb.id });
    this.changes++;
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
      backFrom(info, this.now());
      this.d.save(info);
      const where = from === sb.id ? `back in its own sandbox ${m.id}/${sb.id}` : `in ${m.id}/${sb.id} (its own, ${from}, has other work)`;
      this.d.note(info.id, `Placed again ${where} on its branch ${r.branch}${notes.length ? ` (${notes.join('; ')})` : ''}.`);
      this.d.report?.(`[machines] ${info.id} "${info.title}" resumes ${where}, on its branch ${r.branch}: it had released its sandbox (${r.why}).`);
      console.log(`place again: ${info.id} placed ${where} on ${r.branch}`);
    } catch (e) {
      const why = (e as Error).message;
      this.failed.set(`${info.id}/${sb.id}`, this.now());
      this.changes++;
      this.d.note(info.id, `Could not place it again in ${m.id}/${sb.id}: ${why}. Another free sandbox is tried next, this one again in ${RETRY_FAILED_MS / 60_000} min.`);
      console.warn(`place again: ${info.id} into ${m.id}/${sb.id} failed: ${why}`);
    } finally {
      this.placing.delete(info.id);
      this.changes++;
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
