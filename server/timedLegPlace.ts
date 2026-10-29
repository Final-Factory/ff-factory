/**
 * Where a Queued timed leg goes next (w2055). lothsahn, 2026-10-24: "If timing runs arrive and small machines (single slot)
 * are working on non timing work, the dispatcher should pre-empt their existing work and move it to make space for the
 * timing work if it's possible for the existing worker to push their work and swap to a new machine", "This is much better
 * than just adding the work to an open slot on a busy large machine", then the order this follows: "Timing should prefer
 * small, then medium, etc. if machines are all busy, queue timing runs up on small machines and make them wait vs
 * scheduling them on shared boxes, unless high or urgent priority", "If all small machines are offline, don't wait for them
 * to come online", and "By free machine you mean idle... Doing no other work. Free might imply an empty slot."
 *
 * Each blockerWatch pass (Orchestrators.timedLegBound) asks timedLegStep for every Queued, un-started leg:
 *  1. an IDLE computer (notIdle: no other work on it at all, an empty slot alone is not enough), by size class, small first,
 *     then medium, large, xlarge: the leg starts there;
 *  2. else a computer of the base class (the smallest class with a computer online that takes timed work; small while any
 *     small one is up) whose only work is workers that can move (Occupant.move, decided by Agents.preemptFacts): they move
 *     (w2046's moveForRoom), and the leg starts in the slot they free;
 *  3. else a high or urgent leg widens at once to the computers that take timed runs, big ones included (w2048's
 *     fallback); a normal or low one waits Queued on the base class's computers, never on a busy shared one.
 * The class's computers are those that take timed work at all (timedEligible): never m5 (w1861), not held or avoided,
 * with a game sandbox, on the leg's platform. A computer offline for less than the blip window (TIMED_WAIT_IDLE_MIN, 5 min:
 * every daemon drop the journal showed on 2026-10-24 was under 30 s) still counts as up; one gone longer does not, so its
 * class is skipped until it comes back, re-checked every pass.
 */
import type { WorkPriority } from '../shared/types.ts';
import { avoidOf, busyReasons, classOf, classRank, classText, holdOf, SIZE_CLASSES, type Computer, type PlacementPrefs, type SizeClass } from './placement.ts';

/** A worker that holds a sandbox on a computer, and whether it can leave it for a timed leg (Agents.preemptFacts). */
export interface Occupant {
  session: string;
  /** The open requests it serves. */
  requests: readonly string[];
  /** Movable: the computer it moves to (moveDecision's pick). */
  move?: string;
  /** Movable: it serves no open request, so its sandbox is released and it goes nowhere. */
  release?: boolean;
  /** Not movable: why (mid-turn, uncommitted work, a build in flight, a timed run of its own...). */
  stays?: string;
}

export const movable = (o: Occupant) => !!o.move || !!o.release;

export interface LegInput {
  id: string;
  priority: WorkPriority;
  /** The platform it needs ('win32', 'darwin'), or undefined for any. */
  platform?: string;
  places: readonly Computer[];
  prefs?: PlacementPrefs;
  /** The workers holding a sandbox on each computer, by machine id. */
  occupants: Readonly<Record<string, readonly Occupant[]>>;
  now: number;
  /** How long an offline computer still counts as up (a daemon's blip). */
  blipMs: number;
}

export type LegStep =
  | { start: string; why: string }
  | { preempt: string; moves: Occupant[]; why: string }
  | { widen: string[]; why: string }
  | { wait: string[]; why: string };

/** Why `c` takes no timed leg at all, or undefined (w1861 never m5, held or avoided, no game sandbox, another platform). */
export function timedEligible(c: Computer, prefs: PlacementPrefs = {}, platform?: string): string | undefined {
  if (c.noTimedRuns) return `${c.id} takes no timed runs (${c.noTimedRuns})`;
  if (platform && c.platform !== platform) return `${c.id} is not on ${platform}`;
  const hold = holdOf(prefs).get(c.id);
  if (hold) return `${c.id} is held (${hold})`;
  const avoid = avoidOf(prefs).get(c.id);
  if (avoid) return `${c.id} is avoided (${avoid})`;
  if (c.maxSandboxes <= 0 || c.maxEditors === 0) return `${c.id} has no game sandbox`;
  return undefined;
}

/**
 * Why `c` is not idle, or undefined when it is (w2055, lothsahn: "Doing no other work"): online, no agent live there, no
 * editor or Unity run but those left open in sandboxes no worker holds (idleEditors), no timed run holding or queued on its
 * bench, no released worker waiting to come back to it, no leg the ledger holds for it, and a sandbox to start in.
 */
export function notIdle(c: Computer): string | undefined {
  if (!c.online) return `${c.id} is offline`;
  if (c.live > 0 || c.midTurn > 0) return `${c.id} runs other work (${Math.max(c.live, c.midTurn)} agent${Math.max(c.live, c.midTurn) === 1 ? '' : 's'} live)`;
  const editors = (c.editors ?? 0) - (c.idleEditors ?? 0);
  if (editors > 0) return `${c.id} runs other work (${editors} Unity process${editors === 1 ? '' : 'es'} in use)`;
  if (c.benchLock) return `a timed run holds ${c.id}'s bench lock (${c.benchLock.owner})`;
  if (c.benchQueue?.timed) return `${c.benchQueue.timed} timed run(s) wait on ${c.id}'s bench`;
  if (c.resumesWaiting) return `${c.resumesWaiting} released worker(s) wait to come back to ${c.id}`;
  if (c.legs?.length) return `the ledger holds ${c.legs.map((l) => l.id).join(', ')} for ${c.id}`;
  const busy = busyReasons(c);
  if (busy.length) return `${c.id}: ${busy.join('; ')}`;
  return undefined;
}

/** Smallest class first, then fewer slots, a lower editor limit, the id. */
export const bySize = (a: Computer, b: Computer) => classRank(a) - classRank(b) || a.maxAgents - b.maxAgents || (a.maxEditors ?? 0) - (b.maxEditors ?? 0) || a.id.localeCompare(b.id);

/** Up for the timing order: online, or offline shorter than the blip window. */
export function upNow(c: Computer, now: number, blipMs: number): boolean {
  if (c.online) return true;
  const since = Date.parse(c.offlineSince ?? '');
  return Number.isFinite(since) && now - since < blipMs;
}

/** The smallest class with a computer up that takes timed work, and its computers (smallest first). */
export function baseClass(places: readonly Computer[], prefs: PlacementPrefs, platform: string | undefined, now: number, blipMs: number): { cls?: SizeClass; ids: string[]; skipped: string[] } {
  const ok = places.filter((c) => !timedEligible(c, prefs, platform)).sort(bySize);
  const skipped: string[] = [];
  for (const cls of SIZE_CLASSES) {
    const all = ok.filter((c) => classOf(c) === cls);
    if (!all.length) continue;
    const up = all.filter((c) => upNow(c, now, blipMs));
    if (up.length) return { cls, ids: up.map((c) => c.id), skipped };
    skipped.push(`every ${cls} computer is offline (${all.map((c) => c.id).join(', ')})`);
  }
  return { ids: [], skipped };
}

/** Why `c`'s workers can or cannot all leave it now; undefined when they all can (and there is one to move). */
function preemptWhy(c: Computer, occ: readonly Occupant[]): string | undefined {
  if (!c.online) return `${c.id} is offline`;
  if (c.benchLock) return `a timed run holds ${c.id}'s bench lock`;
  if (c.benchQueue?.timed) return `${c.benchQueue.timed} timed run(s) wait on ${c.id}'s bench`;
  if (c.resumesWaiting) return `released workers wait to come back to ${c.id}`;
  if (c.legs?.length) return `the ledger holds ${c.legs.map((l) => l.id).join(', ')} for ${c.id}`;
  if (!occ.length) return `${c.id} has no worker to move (${notIdle(c) ?? 'idle'})`;
  if (c.live > occ.length) return `${c.id} runs agents outside its sandboxes`;
  const stuck = occ.filter((o) => !movable(o));
  if (stuck.length) return stuck.map((o) => `worker ${o.session.slice(0, 8)} on ${c.id} (${o.requests.join(', ') || 'no request'}) stays: ${o.stays}`).join('; ');
  return undefined;
}

/** The next step for a Queued timed leg (w2055): see the file's comment for the order. */
export function timedLegStep(a: LegInput): LegStep {
  const prefs = a.prefs ?? {};
  const os = a.platform === 'win32' ? ' on Windows' : a.platform === 'darwin' ? ' on macOS' : '';
  const ok = a.places.filter((c) => !timedEligible(c, prefs, a.platform)).sort(bySize);
  // 1. An idle computer of any class, small first.
  const idle = ok.find((c) => !notIdle(c));
  const busy = ok.filter((c) => c.online && notIdle(c)).map((c) => notIdle(c)!);
  if (idle) return { start: idle.id, why: `${classText(idle)} is idle (no other work on it), the first idle computer${os} by size, small first (w2055)${busy.length ? `; not idle: ${busy.join('; ')}` : ''}` };
  const base = baseClass(a.places, prefs, a.platform, a.now, a.blipMs);
  const skipped = base.skipped.length ? `; ${base.skipped.join('; ')}, so the next class is used (w2055: "If all small machines are offline, don't wait for them")` : '';
  if (!base.cls) return { wait: [], why: `no computer${os} that takes timed runs is up (never m5)${skipped}: it waits Queued until one comes back` };
  // 2. Pre-empt movable work off a computer of the base class.
  const why: string[] = [];
  for (const c of ok.filter((x) => base.ids.includes(x.id))) {
    const occ = a.occupants[c.id] ?? [];
    const no = preemptWhy(c, occ);
    if (no) {
      why.push(no);
      continue;
    }
    const moves = [...occ];
    return {
      preempt: c.id,
      moves,
      why: `no computer${os} that takes timed runs is idle; ${classText(c)} is the first ${base.cls} one whose work can move: ${moves.map((o) => `worker ${o.session.slice(0, 8)} (${o.requests.join(', ') || 'no open request'}) ${o.move ? `moves to ${o.move}` : 'is released (it serves no open request)'}`).join('; ')} (w2055)${skipped}`,
    };
  }
  const freed = why.length ? `; none can be freed: ${why.join('; ')}` : '';
  // 3. High or urgent: the big computers' fallback at once (w2048); normal or low: wait on the base class.
  if (a.priority === 'high' || a.priority === 'urgent') {
    const all = ok.filter((c) => upNow(c, a.now, a.blipMs)).map((c) => c.id);
    return { widen: all, why: `it is ${a.priority} priority and no computer${os} that takes timed runs is idle or can be freed${freed}${skipped}: it may go to any computer that takes timed runs, big ones included (w2048 fallback): ${all.join(' > ')}` };
  }
  return { wait: base.ids, why: `no computer${os} that takes timed runs is idle or can be freed${freed}${skipped}: at ${a.priority} priority it waits Queued on the ${base.cls} computers (${base.ids.join(', ')}), not on a busy shared one (w2055)` };
}

/** Whether a leg's needs reach past the timing classes (large or xlarge): its worker then times there as w2048's fallback. */
export const reachesBig = (ids: readonly string[], places: readonly Computer[]) => ids.some((id) => {
  const c = places.find((p) => p.id === id);
  return !!c && classRank(c) >= 2;
});

const osText = (platform?: string) => (platform === 'win32' ? ' on Windows' : platform === 'darwin' ? ' on macOS' : '');

/**
 * Why timed work may not start on `target` when it is first placed (w2168, lothsahn: "Please file a fix to understand and
 * fix why this got placed as ordinary work, as BEAST was about to start doing exclusive runs which really lowers our ability
 * to develop"): the timing order holds at start_agent too, not only for a Queued leg. While a computer that takes timed runs
 * is idle (notIdle), the first idle one by size gets it; `target` passes only when it is that one, or idle itself and of
 * the same class or smaller. With no idle computer the start goes on (a leg then waits Queued and pre-empts, w2055).
 */
export function timedStartProblem(id: string, target: string, places: readonly Computer[], prefs: PlacementPrefs = {}, platform?: string): string | undefined {
  const ok = places.filter((c) => !timedEligible(c, prefs, platform)).sort(bySize);
  const idle = ok.find((c) => !notIdle(c));
  if (!idle || idle.id === target) return undefined;
  const here = ok.find((c) => c.id === target);
  if (here && !notIdle(here) && classRank(here) <= classRank(idle)) return undefined;
  const why = here ? (notIdle(here) ?? `${classText(here)} is bigger`) : `${target} takes no timed runs here`;
  return `${id} is timed work, and ${classText(idle)} is idle: the first idle computer${osText(platform)} that takes timed runs, by size, small first. Start it there (start_agent with machine "${idle.id}"), with its code work: not on ${target} (${why}). The timing order (w2055, w2168): an idle computer first, smallest class first; then pre-emption of movable work on a small one; then, for high or urgent work only, the big computers. lothsahn: "BEAST was about to start doing exclusive runs which really lowers our ability to develop".`;
}

/**
 * Where a started timed leg that only waits for its exclusive bench ticket on a big computer (large or xlarge) goes instead
 * (w2168): the first idle small or medium computer that takes timed runs, smallest first; undefined while none is idle. Its
 * worker is moved between turns only (Agents.timedLegRelocateFor checks that), never mid-turn, and the leg starts again there.
 */
export function timedRelocateStep(from: string, places: readonly Computer[], prefs: PlacementPrefs = {}, platform?: string, waits = 'for an exclusive bench ticket'): { to: string; why: string } | undefined {
  const here = places.find((c) => c.id === from);
  if (!here || classRank(here) < 2) return undefined;
  const idle = places.filter((c) => !timedEligible(c, prefs, platform) && classRank(c) <= 1 && !notIdle(c)).sort(bySize)[0];
  if (!idle) return undefined;
  return { to: idle.id, why: `${classText(idle)} became idle while it waited on ${classText(here)} ${waits}, which would idle every other slot there; a timed leg runs on the smallest idle computer${osText(platform)} (w2055, w2168)` };
}

/**
 * A Queued timed leg pinned to its computers (w2521, server/machinePin.ts): timedLegStep among those alone, and never a
 * widen: with none idle or freeable, or all offline, it waits on them, however idle another computer is.
 */
export function pinnedLegStep(a: LegInput, pin: { ids: readonly string[]; why: string }): LegStep {
  const ids = pin.ids.map((id) => id.toLowerCase());
  const step = timedLegStep({ ...a, places: a.places.filter((c) => ids.includes(c.id)) });
  if ('start' in step || 'preempt' in step) return step;
  const on = ids.join(' or ');
  return { wait: [...ids], why: `it must run on ${on} only (${pin.why}): it waits Queued on ${on} and starts there by itself when ${ids.length > 1 ? 'one' : 'it'} can take it, never on another computer, however idle (w2521); ${step.why}` };
}
