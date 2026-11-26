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

/**
 * w4738: how long a worker released while it waited (on CI, a pair run's partner, a person or a deploy: placeReleased.wait)
 * waits for a sandbox on its own computer before its resume moves (r290 fix 4). w4488's next step moved twice on 2026-11-17
 * (lothdesktop to m5 at 14:11Z, m5 to biscuit at 15:34Z), each move a fresh session that re-read its work (about 14 min, r290)
 * on a computer with one Unity slot. That day a sandbox freed on the computer a move left 1 to 12.1 min after each of five
 * moves (the portal journal), so 15 min covers what was measured; past it the move goes as before (w2046).
 */
export const HOME_WAIT_MS = 15 * 60_000;

/** The mark a Queued line carries while a released waiting worker waits for its own computer: the ledger does not flag it WRONG. */
export const HOME_MARK = 'it waits for a sandbox on its own computer (w4738)';

/**
 * The Queued line's addition while a resume waits for room on its own computer instead of moving (w4738), or undefined when
 * it may move: its sandbox was released while it waited (`released.wait`), its message has waited less than HOME_WAIT_MS, and
 * its computer is up (an away computer is w2544's, not this wait's). Strict priority still holds there: higher queued work
 * takes the next free sandbox first (w3507), and the wait ends at HOME_WAIT_MS whatever came first.
 */
export function homeWait(released: { wait?: boolean } | undefined, queuedAt: number, now: number): string | undefined {
  if (!released?.wait) return undefined;
  const until = queuedAt + HOME_WAIT_MS;
  if (now >= until) return undefined;
  return `${HOME_MARK}: its sandbox went to other work while it waited, and one there frees within minutes; it moves to a computer with room at ${new Date(until).toISOString().slice(11, 16)}Z if none has`;
}

/** w4738: why a computer with one Unity slot (pool.maxUnity 1, biscuit) is no move for UI-heavy work while another fits. */
export const ONE_EDITOR = 'one Unity slot: UI-heavy work moves to a computer with more (w4738)';

/** The waits a move answers: room on the worker's own computer, not its machine (offline, outdated) nor a move under way. */
export const ROOM_WAIT = /^(no sandbox on |its branch .* is checked out in |no agent seat is free on |\d+ agents mid-turn )/;

/**
 * w4238: a placement.hold on the worker's computer ("beast is on hold (Ben: crash hold, ...)"), as holdReason words it.
 * At 20:02Z on 2026-11-14 lothsahn answered w4125 (FFU rate mode) for Ben; its worker fb20b1ad had released beast/slot2 at
 * 03:59Z and its resume sat queued behind BEAST's crash hold for 5 hours while other computers had agent seats.
 */
export const HOLD_WAIT = /^\S+ is on hold \(/;

/**
 * Whether a resume held by its computer's hold moves like one held for room (w4238): only once its sandbox there went to
 * other work (`released`), so nothing of its work is only on that computer; a worker still in its sandbox waits out the hold
 * (often minutes: "quiet BEAST ~15 min"). moveDecision still keeps it there when it must stay (pinned, a timed leg, a bench lock).
 */
export const holdMoves = (hold: string, released: boolean) => released && HOLD_WAIT.test(hold);

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
  pair?: { leg: number; others: readonly string[]; crossOs?: boolean; avoid?: readonly string[]; live?: boolean };
  /** w4738: UI-heavy game work (stills, play mode, a Live view: shared/capacity.ts needsUi): no move to a one-editor computer while another fits. */
  ui?: boolean;
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
  /**
   * w2544: its computer has been offline or paused past the grace ("lothlaptop (offline 6 min)"). What only that computer
   * has can no longer be waited for, so its git state, bench lock and a timed leg's one-computer rule do not keep it there:
   * the new session's hand-off says what may be lost. A pin to it (its brief names it) and a pair run under way still hold.
   */
  away?: string;
  /**
   * w3601: computers whose last free sandbox is held for other work, with why: a Queued pair run (w1945, w3530) or timed
   * work (w1995), as start_agent reads it (Agents.heldFor). A game move does not take it: at 07:31:05Z on 2026-11-08 a room
   * move put w3335 in biscuit/slot2, freed at 07:30:39Z while beast was held for w3573's other leg, and the pair waited 23 min.
   * w5860: also a place held for another request's older or higher leg (Agents.legHoldProblem), and no move of either kind takes it.
   */
  held?: Readonly<Record<string, string>>;
}

export type MoveDecision = { move: { to: string; why: string } } | { stay: string } | { none: string } | { requeuePair: { id: string; why: string } };

/**
 * Where a worker whose resume waits for room on its computer goes (`move`), why it must stay there (`stay`: the Queued line
 * says so and it is not WRONG), or why it waits as it is (`none`: no other computer that could take it has room now).
 */
export function moveDecision(f: MoveFacts): MoveDecision {
  const here = placeId(f.machine);
  if (!f.requests.length) return { none: 'it serves no open request' };
  if (f.benchHeld && !f.away) return { stay: `a timed run from its sandbox holds ${here}'s bench lock: its numbers compare only with ${here}'s own` };
  // w2304: a leg of a pair run under way (no leg has reported) never moves alone: its game is joined to the other legs', and
  // w2271's client leg was moved three times mid-run (09:14Z, 09:45Z, 11:04Z on 2026-10-26), each move cutting the run. It
  // keeps its own sandbox; once that went to other work (released) what it ran there is gone, so the pair starts again whole.
  const live = f.requests.find((r) => r.pair?.live);
  if (live) {
    const others = live.pair!.others.length ? live.pair!.others.join(', ') : 'the other legs';
    if (!f.released) return { stay: `${live.id} is a pair run under way (w2304): leg ${live.pair!.leg} plays with ${others}, and a leg moved alone cuts the run` };
    return { requeuePair: { id: live.id, why: `leg ${live.pair!.leg}'s sandbox on ${here} went to other work mid-run, and a leg moved alone cuts the run (w2046 move refused)` } };
  }
  const pin = f.requests.find((r) => r.pinned?.length && r.pinned.every((p) => placeId(p) === here));
  if (pin) return { stay: `${pin.id} is pinned to ${here}` };
  const leg = f.requests.find((r) => r.timedLeg);
  if (leg && !f.away) return { stay: `${leg.id} is a timed leg (w1969): it builds and times both its sides on ${here}, and numbers from two computers do not compare` };
  if (!f.branch && !f.away) return { stay: `its branch is not known, so its work may exist only on ${here}` };
  if (!f.released && !f.away && f.git && f.git.dirty + f.git.untracked > 0 && !f.canSave) return { stay: `its sandbox has uncommitted work that ${here}'s daemon cannot save and push` };
  // Ahead counts only against its own remote branch: one tracking origin/master (or nothing) says nothing about what was pushed.
  const tracks = !!f.git?.upstream && f.git.upstream.replace(/^[^/]+\//, '') === f.branch;
  if (f.git && !f.away && !tracks) return { stay: `its branch ${f.branch} does not track its own remote branch (${f.git.upstream ? `it tracks ${f.git.upstream}` : 'no upstream'}): its commits may exist only on ${here}` };
  if (f.git && !f.away && (f.git.ahead ?? 0) > 0) return { stay: `${f.git.ahead} commit(s) on ${f.branch} are not pushed: only ${here} has them` };
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
    // w5860: an agent seat held for another request's older leg is no room for a move of seat-only work either.
    if (f.held?.[p.id]) unfit.set(p.id, f.held[p.id]!);
    for (const r of f.requests) {
      if (!r.pair) continue;
      if (r.pair.others.some((o) => placeId(o) === p.id)) unfit.set(p.id, `${r.id}'s other leg runs there`);
      else if (r.pair.avoid?.some((o) => placeId(o) === p.id)) unfit.set(p.id, `${r.id}'s pair run avoids it`);
      else if (p.platform === 'darwin' && r.pair.leg > 1) unfit.set(p.id, 'a Mac is never a pair run client (w665); it may host (w2282)');
    }
  }
  const candidates = f.places.filter((p) => p.id !== here && !unfit.has(p.id));
  const first = f.requests.map((r) => r.first).find(Boolean) ?? false;
  const prefs = forPriority(f.prefs, priority);
  // w4738: UI-heavy work does not move to a computer with one Unity slot (biscuit) while another fits: w4488's stills leg went
  // there at 15:34Z on 2026-11-17. Off an away computer (w2544) it may, when nothing else has room.
  const ui = kind === 'game' && f.requests.some((r) => r.ui);
  const one = (p: Computer) => ui && p.maxEditors !== undefined && p.maxEditors <= 1;
  let pick = pickComputer(candidates.filter((p) => !one(p)), f.last, prefs, kind, false, first);
  // w5328: pinned work has no other computer to prefer, so a one-Unity-slot pin (biscuit) is no reason to wait.
  if (!pick && (f.away || f.requests.some((r) => r.pinned?.length))) pick = pickComputer(candidates, f.last, prefs, kind, false, first);
  if (!pick) for (const p of candidates) if (one(p)) unfit.set(p.id, ONE_EDITOR);
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
export function movedPrompt(m: { id: string; from: string; to: string; old: string; hold: string; why: string; brief?: string; report?: string; lead?: string }): string {
  const lines = [
    m.lead ?? `[moved, w2046] FF Factory moved ${m.id} to this computer: its worker ${m.old} on ${m.from} was about to resume, but ${m.hold}, and ${m.to} had room (${m.why}). lothsahn's rule: "We should not have idle slots if there is queued work". That worker is stopped and its sandbox released; you carry ${m.id} on from where it left off. The handover below says where its work is (its branch, pushed) and carries the message that was waiting for it.`,
  ];
  if (m.report) lines.push(`\nIts worker's last report:\n~~~text\n${m.report}\n~~~`);
  if (m.brief) lines.push(`\nThe brief its worker started from (the dispatcher's words then; where it names ${m.from} or that worker's sandbox, you are on ${m.to} now):\n~~~text\n${m.brief}\n~~~`);
  return lines.join('\n');
}

/**
 * w5942: the waits for an agent seat on the worker's own computer by the portal's count, not for a sandbox. A seat there frees
 * when any turn there ends. Not a refusal by its daemon's count ("N agents mid-turn on X by its daemon's count"):
 * SessionManager.requeueRefused queues that message again with a fresh time on every refusal, so a wait measured from it had
 * no end (the w5949 review, B1: 391493b1 and f305bf10 were each refused 4 times 22 to 28 s apart at 06:46:39-06:47:53Z on
 * 2026-11-25), and a computer whose daemon refuses is not one a seat frees on soon.
 */
export const SEAT_WAIT = /^(no agent seat is free on |\d+ agents mid-turn (?!.* by its daemon's count))/;

/** The mark a Queued line carries while a warm worker waits for a seat on its own computer, or a moved request waits where it went (w5942): no WRONG. */
export const WARM_MARK = 'it keeps its conversation and waits on its own computer (w5942)';

/**
 * w5942: a resume that has its conversation (a worker that ran a turn: SessionInfo.turns > 0) and waits only for an agent seat
 * on its own computer waits there up to HOME_WAIT_MS before a fresh session elsewhere takes its work; one that never ran a turn
 * has nothing to lose and moves after MOVE_AFTER_MS as before. On 2026-11-25 aa98e369 (w5869), 793a23a8 (w5895) and 41a634be
 * (w5912) were each placed again in their own biscuit sandbox (which ends the w4738 wait), then moved 20 to 30 s later for
 * "4 agents mid-turn on biscuit (cap 4)", each a fresh session that read its work again from nothing. `queuedAt` is the
 * earliest the worker has waited so (MoveGuard.waitingSince), so a message sent again does not start the wait afresh.
 */
export function warmWait(turns: number | undefined, hold: string, queuedAt: number, now: number): string | undefined {
  if (!(turns && turns > 0) || !SEAT_WAIT.test(hold)) return undefined;
  const until = queuedAt + HOME_WAIT_MS;
  if (now >= until) return undefined;
  return `${WARM_MARK}: a seat there frees when a turn there ends; it moves to a computer with room at ${new Date(until).toISOString().slice(11, 16)}Z if none has`;
}

/**
 * w5942: the longest a computer whose daemon refused a start at its agent cap stays no target for a room move without news. It
 * is a target again at once when a start there goes through (MoveGuard.startedOn). The w5949 review measured beast's miscount
 * at 10 to 18 min on 2026-11-25 (refused at 06:37Z, again at 06:46-06:47Z, back at 06:55:06Z), past the first 5 min; a
 * reconnect is no news (beast reconnected between those refusals and its count stayed wrong). 30 min is a judgment: past the
 * longest measured, and the bound is the recovery that needs nobody.
 */
export const REFUSED_FOR_MS = 30 * 60_000;

/**
 * w5942: what the room moves remember between drains, so a request moves at most once per wait.
 *
 * - `moved`: when each request last moved (a room move or an away move). A room move of a request moved within HOME_WAIT_MS
 *   waits where it went instead: w5892 went c89b46d1 → c1e9dd0c → c89b46d1 and w5869 went biscuit → beast → biscuit →
 *   lothdesktop within the hour on 2026-11-25. An away move (its computer offline past w2544's grace) and urgent work are not
 *   held by it: those wait for nothing that frees.
 * - `refused`: computers whose daemon refused a start at its agent cap (machines.ts AGENT_CAP_REFUSAL). The portal counted
 *   beast at 2 of 6 mid-turn while its daemon counted 6 live, so moves kept choosing beast and its daemon kept refusing them
 *   (w5932's 60a433cb and d4f2c3ca, w5938's 76deb562, none of which ran a turn). Such a computer is no move target for
 *   REFUSED_FOR_MS.
 */
export class MoveGuard {
  private readonly moved = new Map<string, { at: number; to: string }>();
  private readonly refused = new Map<string, { at: number; why: string; what?: string }>();
  private readonly waiting = new Map<string, { since: number; turns: number }>();

  /**
   * The earliest a worker has waited for a seat at its present turn count (warmWait's start): a message queued again, or a
   * new one, does not start its wait afresh. A turn it runs starts the count again.
   */
  waitingSince(session: string, turns: number, queuedAt: number): number {
    const w = this.waiting.get(session);
    if (w && w.turns === turns && w.since <= queuedAt) return w.since;
    this.waiting.set(session, { since: queuedAt, turns });
    return queuedAt;
  }

  noteMove(ids: string[], to: string, now: number) {
    for (const id of ids) this.moved.set(id, { at: now, to });
  }

  /** Why a room move of these requests waits (one moved within HOME_WAIT_MS), or undefined. */
  movedLately(ids: string[], now: number): string | undefined {
    for (const id of ids) {
      const m = this.moved.get(id);
      if (!m) continue;
      if (now - m.at >= HOME_WAIT_MS) {
        this.moved.delete(id);
        continue;
      }
      return `${WARM_MARK}: ${id} moved to ${m.to} ${Math.round((now - m.at) / 60_000)} min ago and moves at most once per wait; it moves again at ${new Date(m.at + HOME_WAIT_MS).toISOString().slice(11, 16)}Z if no seat has freed`;
    }
    return undefined;
  }

  /** `what` says what was refused (w5976: a move's fresh session that did not start there); a daemon's cap refusal by default. */
  noteRefusal(machine: string, why: string, now: number, what?: string) {
    this.refused.set(machine, { at: now, why, ...(what ? { what } : {}) });
  }

  /** A start on `machine` went through: its daemon's count has room again, so it is a move target again. */
  startedOn(machine: string) {
    this.refused.delete(machine);
  }

  /** The computers no room move may go to now, with why (MoveFacts.held). */
  refusals(now: number): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, r] of this.refused) {
      if (now - r.at >= REFUSED_FOR_MS) this.refused.delete(id);
      else out[id] = `${r.what ?? 'its daemon refused a start at its agent cap'} ${Math.round((now - r.at) / 1000)} s ago (${r.what ? 'w5976' : 'w5942'}): ${r.why}`;
    }
    return out;
  }
}
