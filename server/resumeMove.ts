/**
 * A resuming worker whose computer is full moves to a computer with room (w2046, lothsahn, 2026-10-24: "We should not have
 * idle slots if there is queued work"). At 14:05Z on 2026-10-24 w1891's worker 0cd35068 (merge PR #2347) and w2013's
 * leg 2 worker 99862afa (the BEAST client of a two-machine check whose host already listened on lothdesktop/slot6) had
 * released their BEAST sandboxes, and their resumes waited for a BEAST sandbox while LothLaptop, LothDesktop (3 free), m5
 * (2 free) and biscuit (1 free) sat idle: a released worker was only ever placed again on its own machine (placeAgain.ts).
 *
 * Now a message that waits in the send queue only for room on its worker's computer (no free sandbox there, its agent cap,
 * its sandbox's seats) for MOVE_AFTER_MS moves the work instead: `moveDecision` picks the computer, as new work is placed
 * (pickComputer: placement.prefer, avoid, hold, minPriority, Live view and build lists, timed work on computers that take
 * it), and Agents.moveResume starts a fresh session there with a hand-off (its request, branch, its last report, the
 * brief its worker started from and the message that waited), stops the old worker and releases its sandbox at once
 * (lothsahn: "When it moves workers to another box, it should request they clean up and force those slots to be
 * released"). A conversation does not cross computers (its transcript is on the old one's disk), hence the fresh session.
 *
 * It stays only when the work truly needs its own computer, and its Queued line says why (`stay`, STAY_MARK): commits or
 * uncommitted work only that computer has, a timed run holding that computer's bench lock, a request pinned to it, or a
 * pair leg with nowhere else to go but the other leg's computer. The ledger flags any other such wait WRONG when another
 * computer that could take it has room (shared/workState.ts).
 */
import type { WorkPriority } from '../shared/types.ts';
import { forPriority, holdReason, lowestPriority, pickComputer, placeId, type Computer, type FirstKind, type NeedKind, type PlacementPrefs } from './placement.ts';

/**
 * How long a resume waits for room on its own computer before it moves (a judgment): long enough that a turn ending there
 * this moment frees it (the send queue's drain runs every 30 s, so a move comes 20 to 50 s after the message), short enough
 * for the request's "within a minute".
 */
export const MOVE_AFTER_MS = 20_000;

/** The mark a Queued line carries when its worker stays on its computer on purpose: the ledger does not flag it WRONG. */
export const STAY_MARK = 'it stays on its computer (w2046)';

/** The mark a Queued line carries when no other computer that could take it has room: no WRONG either. */
export const NONE_MARK = 'no other computer can take it now (w2046)';

/** The waits a move answers: room on the worker's own computer, not its machine (offline, outdated) nor a move under way. */
export const ROOM_WAIT = /^(no sandbox on |its branch .* is checked out in |no agent seat is free on |\d+ agents mid-turn )/;

/** One request the worker serves, as the decision reads it. */
export interface MoveRequest {
  id: string;
  priority: WorkPriority;
  kind: NeedKind;
  /** Work that goes to a list first (Live view, a build) or timed work (pickComputer's FirstKind). */
  first?: FirstKind;
  /** Computers the request is pinned to (WorkItem.queuedFor.needs, a leg's needs): it goes nowhere else. */
  pinned?: readonly string[];
  /** A timed leg handed to a small computer (WorkItem.timedLeg, w1969): both its sides are timed on one computer. */
  timedLeg?: boolean;
  /** A pair run's leg (WorkItem.pair.started): this worker's leg number (1 = host), the other legs' computers, cross-OS or not. */
  pair?: { leg: number; others: readonly string[]; crossOs?: boolean; avoid?: readonly string[] };
}

export interface MoveFacts {
  machine: string;
  /** Its sandbox went to other work while it waited (SessionInfo.placeReleased). */
  released: boolean;
  /** The branch its work is on (placeReleased.branch, else its sandbox's), when known. */
  branch?: string;
  /** Its own sandbox's git state, when that sandbox is still on its branch (what only this computer has). */
  git?: { ahead?: number; upstream?: string; dirty: number; untracked: number };
  /** Its daemon commits and pushes uncommitted work before a release (MachineManager.canSaveWork, w656). */
  canSave: boolean;
  /** A timed run from its sandbox holds its computer's bench lock now (benchLockIn). */
  benchHeld?: boolean;
  requests: readonly MoveRequest[];
  places: readonly Computer[];
  prefs: PlacementPrefs;
  /** The computer the last piece of new work went to (spread's turn-taking). */
  last?: string;
}

export type MoveDecision = { move: { to: string; why: string } } | { stay: string } | { none: string };

/**
 * Where a worker whose resume waits for room on its computer goes (`move`), why it must stay there (`stay`: the Queued line
 * says so and it is not WRONG), or why it waits as it is (`none`: no other computer that could take it has room now).
 */
export function moveDecision(f: MoveFacts): MoveDecision {
  const here = placeId(f.machine);
  if (!f.requests.length) return { none: 'it serves no open request' };
  if (f.benchHeld) return { stay: `a timed run from its sandbox holds ${here}'s bench lock: its numbers compare only with ${here}'s own` };
  const pin = f.requests.find((r) => r.pinned?.length && r.pinned.every((p) => placeId(p) === here));
  if (pin) return { stay: `${pin.id} is pinned to ${here}` };
  const leg = f.requests.find((r) => r.timedLeg);
  if (leg) return { stay: `${leg.id} is a timed leg (w1969): it builds and times both its sides on ${here}, and numbers from two computers do not compare` };
  if (!f.branch) return { stay: `its branch is not known, so its work may exist only on ${here}` };
  if (!f.released && f.git && f.git.dirty + f.git.untracked > 0 && !f.canSave) return { stay: `its sandbox has uncommitted work that ${here}'s daemon cannot save and push` };
  // Ahead counts only against its own remote branch: one tracking origin/master (or nothing) says nothing about what was pushed.
  const tracks = !!f.git?.upstream && f.git.upstream.replace(/^[^/]+\//, '') === f.branch;
  if (f.git && !tracks) return { stay: `its branch ${f.branch} does not track its own remote branch (${f.git.upstream ? `it tracks ${f.git.upstream}` : 'no upstream'}): its commits may exist only on ${here}` };
  if (f.git && (f.git.ahead ?? 0) > 0) return { stay: `${f.git.ahead} commit(s) on ${f.branch} are not pushed: only ${here} has them` };
  const kind: NeedKind = f.requests.some((r) => r.kind === 'game') ? 'game' : 'agent';
  const ids = f.requests.map((r) => r.id);
  const priority = lowestPriority(f.requests);
  const unfit = new Map<string, string>();
  for (const p of f.places) {
    if (p.id === here) continue;
    // A move starts at once: a sandbox it would first have to make (minutes) is no room for it.
    if (kind === 'game' && p.freeSandboxes < 1) unfit.set(p.id, 'no free sandbox made yet');
    const pinned = f.requests.find((r) => r.pinned?.length && !r.pinned.some((x) => placeId(x) === p.id));
    if (pinned) unfit.set(p.id, `${pinned.id} is pinned to ${pinned.pinned!.join(' or ')}`);
    const held = holdReason(p.id, f.prefs, ids);
    if (held) unfit.set(p.id, held);
    for (const r of f.requests) {
      if (!r.pair) continue;
      if (r.pair.others.some((o) => placeId(o) === p.id)) unfit.set(p.id, `${r.id}'s other leg runs there`);
      else if (r.pair.avoid?.some((o) => placeId(o) === p.id)) unfit.set(p.id, `${r.id}'s pair run avoids it`);
      else if (p.platform === 'darwin' && (r.pair.leg > 1 || !r.pair.crossOs)) unfit.set(p.id, 'a Mac is never a pair run client, and hosts only a cross-OS pair');
    }
  }
  const candidates = f.places.filter((p) => p.id !== here && !unfit.has(p.id));
  const first = f.requests.map((r) => r.first).find(Boolean) ?? false;
  const pick = pickComputer(candidates, f.last, forPriority(f.prefs, priority), kind, false, first);
  if (!pick) {
    const why = unfit.size ? `; ${[...unfit].map(([id, w]) => `${id}: ${w}`).join('; ')}` : '';
    return { none: `no other computer that could take it has ${kind === 'game' ? 'room' : 'an agent slot'} now${why}` };
  }
  return { move: { to: pick.pick.id, why: pick.why } };
}

/** The Queued line of a resume that stays on its computer on purpose. */
export const stayLine = (hold: string, why: string) => `${hold}; ${STAY_MARK}: ${why}`;

/** The brief a worker started from, without what the harness added after it (the request as filed, the handover). */
export function briefOf(first: string | undefined, max = 6000): string | undefined {
  if (!first?.trim()) return undefined;
  const cut = first.indexOf('\n\n---\n');
  const brief = (cut >= 0 ? first.slice(0, cut) : first).trim();
  return brief.length > max ? `${brief.slice(0, max)}… (${brief.length - max} more characters)` : brief;
}

/** The first lines of a moved request's new session, before the request as filed and the handover. */
export function movedPrompt(m: { id: string; from: string; to: string; old: string; hold: string; why: string; brief?: string; report?: string }): string {
  const lines = [
    `[moved, w2046] FF Factory moved ${m.id} to this computer: its worker ${m.old} on ${m.from} was about to resume, but ${m.hold}, and ${m.to} had room (${m.why}). lothsahn's rule: "We should not have idle slots if there is queued work". That worker is stopped and its sandbox released; you carry ${m.id} on from where it left off. The handover below says where its work is (its branch, pushed) and carries the message that was waiting for it.`,
  ];
  if (m.report) lines.push(`\nIts worker's last report:\n~~~text\n${m.report}\n~~~`);
  if (m.brief) lines.push(`\nThe brief its worker started from (the dispatcher's words then; where it names ${m.from} or that worker's sandbox, you are on ${m.to} now):\n~~~text\n${m.brief}\n~~~`);
  return lines.join('\n');
}
