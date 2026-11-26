/**
 * w5950: enforcing w5942's moved-away check (Machines.warnMovedAway). A worker whose work moved to another computer
 * (SessionInfo.movedAway) but that its daemon still runs when it says hello again, or that a resume after its drop would
 * wake, acts on a request a newer worker carries: on 2026-11-25 beast came back at 06:20:26Z still running d732483b, whose
 * w5869 had moved to biscuit at 06:09:46Z, so w5869 had two live workers.
 *
 * Config `movedAwayWorkers` (an owner's setting, set_app_config, read live, no restart):
 * - "warn" (unset, the default): journal and report, as #1318 did; nothing is stopped or skipped.
 * - "on": such a worker is stopped (hello) or not resumed (resumeCutOff), its sandbox's work saved to a side branch, and
 *   the new worker told; but only when movedAwayVerdict below says every request it had is with a started new worker.
 * - "off": no check at all, the recovery switch (it needs nobody at any machine).
 *
 * The conditions are the w5949 review's (a)-(e), so enforcing never stops the only worker that holds a request:
 * (a) the w3425 check first: a move that never happened (the worker's own requests still list it) is undone, not enforced;
 * (b) a move whose new session failed to start (its request handed back, Queued with no worker) keeps the old one;
 * (c) each request it had must be linked to another worker, in another sandbox, that started: live on its daemon, or it
 *     ran a turn and holds the request between turns; not one that errored or was stopped on purpose;
 * (d) its sandbox's work is saved to a side branch (saveWork's holdPush), never pushed onto the branch the new worker
 *     carries, and only when no other agent works in that sandbox (Agents.retireMovedAway);
 * (e) the "Message them to continue" report past RESUME_WITHIN_MS names a moved-away worker's new worker instead.
 */

export type MovedAwayMode = 'off' | 'warn' | 'on';

/** The setting as read (unset or unknown is "warn"). */
export function movedAwayMode(v: unknown): MovedAwayMode {
  return v === 'off' || v === 'on' ? v : 'warn';
}

/** One other worker linked to a request the old worker was moved off. */
export interface HeirFacts {
  id: string;
  /** Its daemon reports its process running. */
  live: boolean;
  /** Its turns so far, and whether it is in one now. */
  turns: number;
  midTurn: boolean;
  status: string;
  stoppedOnPurpose?: boolean;
  /** It works in the old worker's own sandbox (then it is no other copy: heirOf leaves it out too). */
  sameSandbox: boolean;
}

/** A request the old worker had: open, moved off it (WorkItem.movedOff) and no longer listing it. */
export interface MovedRequest {
  id: string;
  heirs: HeirFacts[];
}

export interface MovedAwayFacts {
  /** Open requests that still list the old worker: the move never happened (w3425, awayMoveUndone). */
  stillHolds: string[];
  /** A move of it is under way (roomMoving, timedMoving): that move decides. */
  moving: boolean;
  moved: MovedRequest[];
}

export type MovedAwayVerdict =
  | { act: 'undo'; why: string }
  | { act: 'keep'; why: string }
  | { act: 'enforce'; heirs: { request: string; heir: string }[] };

/** Whether `h` is a new worker that started and holds its request, condition (c). */
export function startedHeir(h: HeirFacts): boolean {
  if (h.sameSandbox || h.status === 'error' || h.stoppedOnPurpose) return false;
  return h.live || h.midTurn || h.turns > 0;
}

/** What enforcing does with one moved-away worker. Only `enforce` stops or skips it. */
export function movedAwayVerdict(f: MovedAwayFacts): MovedAwayVerdict {
  if (f.stillHolds.length) return { act: 'undo', why: `its requests ${f.stillHolds.join(', ')} still list it, so the move never happened (w3425)` };
  if (f.moving) return { act: 'keep', why: 'a move of it is under way' };
  if (!f.moved.length) return { act: 'keep', why: 'no open request was moved off it' };
  const heirs: { request: string; heir: string }[] = [];
  for (const r of f.moved) {
    const h = r.heirs.find((x) => startedHeir(x) && x.live) ?? r.heirs.find(startedHeir);
    if (!h) {
      const why = r.heirs.length
        ? `${r.id}'s other worker(s) ${r.heirs.map((x) => x.id).join(', ')} have not started (or errored, or were stopped)`
        : `${r.id} has no other worker (its new session's start failed, or it is still Queued)`;
      return { act: 'keep', why: `${why}: it may be the only copy of that work` };
    }
    heirs.push({ request: r.id, heir: h.id });
  }
  return { act: 'enforce', heirs };
}
