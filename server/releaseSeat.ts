/**
 * An urgent release builds in its build computer's slot1 (w1668). lothsahn, 2026-10-21: "Let's make sure that urgent builds
 * always get scheduled in slot1 on whatever machine they run in so that it uses caches as warm as possible."
 *
 * Why it pays (Documentation/Release-Lanes.md in the game repo, "Where the time goes", measured on 1.0.0.3): a release
 * builds in its builder's own sandbox (urgent_release.py builds the checkout it runs from), and a Library that never built
 * a target compiles every shader for it: 1.0.0.3 in LothDesktop's slot3, whose Library had built only Windows, spent
 * 2485 s on Mac and 2899 s on Linux against 925 s on Windows. The sandboxes rotate, so each urgent release could land in
 * another cold one. One fixed sandbox per build computer keeps its Library's caches for every target, release to release.
 *
 * The builder is moved, never the build: build_plan (server/buildPlans.ts) asks a builder that is not in slot1 to end its
 * turn, and FF Factory then (Agents.seatRelease, one step per look, every 30 s):
 *   1. empties slot1 of other game work. A worker between turns is stopped and its sandbox released for it (uncommitted
 *      work committed and pushed first, w656): it resumes in another sandbox on this computer, on its branch, like any
 *      released worker (server/placeAgain.ts). A worker mid-turn is asked to commit, push and end its turn, and after
 *      SEAT_GRACE_MS it is stopped the same way: lothsahn (w1656), "It was supposed to kick work off the machine".
 *      A worker whose work needs only an agent seat (w1098: FF Factory or FFBox work in its own clone) stays: the switch
 *      does not touch its clone. A Unity batch run in slot1 (a test run or player build of the worker that was there) is
 *      waited for: switching a worktree under it would break it.
 *   2. moves the builder: its own sandbox goes to a fresh hand-over branch (git allows one branch in one worktree), slot1
 *      to the builder's branch, its record to slot1; its next message says where it is now (placeAgain movedNote).
 * Why move it and not wait or build where it is: a cold Mac and Linux build costs about 59 minutes more (estimated by
 * w1639's worker from 1.0.0.3); the move costs a turn's end, a commit and two branch switches (about a minute), and a
 * mid-turn worker in slot1 at most SEAT_GRACE_MS more. When slot1 cannot be emptied within SEAT_GIVE_UP_MS (a batch run that
 * keeps going), the builder builds where it is, told why, rather than wait on.
 */
import type { MachineSandbox, SessionInfo } from '../shared/types.ts';

/** The sandbox an urgent release builds in, on whichever build computer it runs (lothsahn, w1668: "slot1"). */
export const RELEASE_SANDBOX = 'slot1';
/** How long a worker mid-turn in slot1 has to end its turn before it is stopped (w1668). */
export const SEAT_GRACE_MS = 2 * 60_000;
/** How long the builder waits for slot1 before it builds where it is (w1668). */
export const SEAT_GIVE_UP_MS = 10 * 60_000;

/** A seat being taken: on the build plan. */
export interface Seat {
  sandbox: string;
  since: number;
  /** Workers mid-turn in the sandbox asked to end their turn, and when. */
  told: Record<string, number>;
  /** It ended: the builder is there, or there is no such sandbox. */
  done?: string;
  /** It gave up: the builder builds where it is. */
  gaveUp?: string;
  /** What it waited for at its last step. */
  waiting?: string;
}

export interface SeatFacts {
  builder: SessionInfo;
  /** The release sandbox's record on the build computer, or undefined when it has none. */
  target: MachineSandbox | undefined;
  /** The workers recorded in that sandbox (the builder left out). */
  others: readonly SessionInfo[];
  live: (id: string) => boolean;
  midTurn: (s: SessionInfo) => boolean;
  /** Its open work needs only an agent seat (w1098): it may stay beside the build. */
  agentOnly: (s: SessionInfo) => boolean;
  /** Unity slot holders on the computer ("sandbox:<id>"). */
  unityHolders: readonly string[];
  seat: Seat;
  now: number;
}

export type ClearStep =
  | { do: 'tell'; id: string }
  | { do: 'interrupt'; id: string }
  | { do: 'stop'; id: string }
  | { do: 'release'; id: string; branch: string; save: boolean };

export type SeatAction =
  | { do: 'done'; why: string }
  | { do: 'give-up'; why: string }
  | { do: 'clear'; steps: ClearStep[]; why: string }
  | { do: 'wait'; why: string }
  | { do: 'stop-builder' }
  | { do: 'move' };

const dirty = (sb: MachineSandbox) => (sb.git?.dirty ?? 0) > 0 || (sb.git?.untracked ?? 0) > 0;

/** The next step towards the builder working in the release sandbox (the header). Pure: Agents.seatRelease does it. */
export function seatAction(f: SeatFacts): SeatAction {
  const { builder: b, target: sb, seat } = f;
  if (!sb) return { do: 'done', why: `there is no ${seat.sandbox} on ${b.machineId}: the build runs where its builder is` };
  if (b.machineSandbox === sb.id) return { do: 'done', why: `the builder is in ${b.machineId}/${sb.id}` };
  const waited = f.now - seat.since;
  const steps: ClearStep[] = [];
  const waits: string[] = [];
  for (const o of f.others) {
    if (o.id === b.id || o.placeReleased || f.agentOnly(o)) continue;
    const live = f.live(o.id);
    // A stopped one is released even when it holds nothing now: its record still says slot1, and a resume there would
    // find the builder's branch checked out.
    if (live && (f.midTurn(o) || o.pendingPermissions.length)) {
      const asked = seat.told[o.id];
      if (asked === undefined) steps.push({ do: 'tell', id: o.id });
      else if (f.now - asked >= SEAT_GRACE_MS) steps.push({ do: 'interrupt', id: o.id });
      waits.push(`${o.id} is mid-turn there${asked === undefined ? '' : ` (asked to end its turn ${Math.round((f.now - asked) / 1000)} s ago)`}`);
    } else if (live) {
      steps.push({ do: 'stop', id: o.id });
      waits.push(`${o.id} is being stopped`);
    } else {
      const branch = sb.git?.branch;
      if (!branch || branch === 'detached HEAD' || branch === '?') waits.push(`${sb.id}'s branch is not known yet`);
      else steps.push({ do: 'release', id: o.id, branch, save: dirty(sb) });
    }
  }
  if (f.unityHolders.includes(`sandbox:${sb.id}`)) waits.push(`a Unity batch run of ${sb.id} is in flight`);
  if (sb.status !== 'ready') waits.push(`${sb.id} is ${sb.status}${sb.statusDetail ? ` (${sb.statusDetail})` : ''}`);
  if (waits.length && waited >= SEAT_GIVE_UP_MS) return { do: 'give-up', why: `${seat.sandbox} was not free after ${Math.round(waited / 60_000)} min: ${waits.join('; ')}` };
  if (steps.length) return { do: 'clear', steps, why: waits.join('; ') || 'emptying it' };
  if (waits.length) return { do: 'wait', why: waits.join('; ') };
  if (f.live(b.id)) return f.midTurn(b) || b.pendingPermissions.length ? { do: 'wait', why: 'the builder is mid-turn: it moves once its turn ends' } : { do: 'stop-builder' };
  return { do: 'move' };
}

/** What a worker mid-turn in the release sandbox is told (once). */
export function seatNotice(machine: string, sandbox: string, what: string): string {
  return `[FF Factory] URGENT RELEASE (w1668): ${what} builds in ${machine}/${sandbox}, this sandbox, whose Library is kept warm for release builds (lothsahn: "urgent builds always get scheduled in slot1"). Commit what is unfinished on your branch now (a WIP commit is fine), push it, stop your editor, and end your turn within ${SEAT_GRACE_MS / 60_000} minutes; after that FF Factory stops you. Nothing committed is lost: when the build is done you resume in another sandbox on ${machine}, on your branch, and the message says where.`;
}

/** What the builder is told once it is in the release sandbox, or when it builds where it is. */
export function seatedNotice(machine: string, sandbox: string, what: string): string {
  return `[FF Factory] You are in ${machine}/${sandbox} now (w1668: urgent release builds run there, its Library warm from the last release). Run \`build_plan start\` (release: true) again, then build ${what} here.`;
}

export function gaveUpNotice(machine: string, sandbox: string, why: string): string {
  return `[FF Factory] ${machine}/${sandbox} could not be emptied for the release build (w1668): ${why}. Do not wait for it: \`build_plan start\` (release: true) again and build where you are. The run's library line says which targets start cold.`;
}
