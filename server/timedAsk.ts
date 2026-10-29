// The ask before an exclusive bench ticket (w1969). lothsahn, 2026-10-24: "Why are these on the big machines and not
// scheduled for m3 or even biscuit? The scheduler should favor running exclusive locks on machines with a small number of
// slots", then "Maybe every time a worker needs an exclusive lock it should ask the dispatcher?"
//
// A timed leg runs in whatever sandbox its request got for its code work, so w1872's placement ("Next timed work", the
// smallest computer first) decides only where the request starts, from its words: w1908 held BEAST's exclusive ticket and
// w1891 waited behind it there, and w1789 waited on LothDesktop behind shared builds (the ledger, 2026-10-24 02:2xZ). So
// the decision moves to the moment it matters: before a worker on a big computer takes an exclusive ticket, it calls
// timed_place, and the portal says where the leg runs (decideTimedPlace): here, or on a small computer, where FF Factory
// files the leg as its own request (Orchestrators.fileTimedLeg) and the asking worker waits on its report. The verdict
// rides the bench priorities to the machine (priorities.json `timed_ask` and each session's `timed`), where the guard
// refuses a ticket-taking command until the worker has asked (checkTimedAsk). Placement from words stays as w1872 left it:
// it moves a whole request, most of whose turns are code work, while the ask moves only the leg (docs/machines.md, "Where a
// timed leg runs").
import { avoidOf, classOf, classRank, holdOf, hasRoom, type Computer, type PlacementPrefs } from './placement.ts';
import { bySize, notIdle, timedEligible } from './timedLegPlace.ts';
import type { TimedAskMark, TimedVerdict, TimedVerdictKind } from '../shared/types.ts';

/**
 * A computer at or under this many agent slots is small (a judgment, w1969). An exclusive turn idles every other slot of
 * its computer: up to 3 on the small ones of 2026-10-24 (LothLaptop 1, m3 and biscuit at 2 sandboxes of 2 agents), 5 on
 * BEAST (6 agents) and 9 on LothDesktop (10). Handing a leg off costs one worker's start and its builds on the small
 * computer, about one slot's work, so it pays where the turn would idle 5 or more.
 */
export const SMALL_TIMED_MAX_AGENTS = 4;

/**
 * w2442: big worker computers that take timed runs anyway. A run there holds the machine's exclusive bench ticket for each
 * turn, as on a small one; it is ranked after every small computer (timedRuns.ts rankTargets), so a run lands there when it
 * is asked for by name or no small one can take it.
 */
export const BIG_TIMED_RUNS: Readonly<Record<string, string>> = {
  lothdesktop: 'lothsahn, 2026-10-28 (w2442): "Move that job to another machine"; LothDesktop takes timed runs',
};

/** Whether a worker computer with `agents` agent slots takes timed runs by its size (w1996), or by name (w2442). */
export function timedRunSize(id: string, agents: number): boolean {
  return agents >= 1 && (agents <= SMALL_TIMED_MAX_AGENTS || !!BIG_TIMED_RUNS[id]);
}
// Since w2055 the leg rules go by size class (placement.ts sizeClass): a small or medium computer (1 to 3 agent slots) times
// where it is and takes legs; a large or xlarge one asks. SMALL_TIMED_MAX_AGENTS stays only for timed_run's worker
// computers (index.ts timedRunSmall), a player A/B that takes no slot.

/**
 * How long a computer that should take a timed leg may be unavailable (offline, asleep, its daemon gone) before the leg
 * stops waiting for it (w2048, lothsahn: "sometimes machines go offline. We should still allow timed runs on larger
 * machines if there are no other machines available to take them", then "Too long should also be based on how much work
 * is queued. If the fleet is idle it should wait far less than if the fleet is busy"). The same wait decides when a timed
 * run gives up on the computer that holds its baseline and plays every side again on another (timedRuns.ts retarget,
 * lothsahn: "rerun the baseline if a machine is offline or unavailable too long").
 *
 * What it rests on (the portal journal, 2026-10-17..24, read by w2048): a daemon's drops are blips of 1 to 30 s (a portal
 * deploy or a link flap; lothlaptop and biscuit dropped and reconnected dozens of times on 2026-10-24 12:02..13:49Z, none
 * longer than 30 s), and a daemon reconnects by itself within about a minute (machines.ts redeployDue redeploys after 2
 * min). The real outages last hours (m3 offline from 06:50Z to past 13:43Z the same day, asleep or at its login screen).
 * So an idle fleet waits 5 min: past every blip seen, and a fresh baseline then costs nothing anyone waits for. A busy one
 * waits 60 min: two full bench turns (the game repo's bench_queue.py caps a turn at 30 min), since a re-run there takes an
 * exclusive turn that idles a big computer's other slots while queued work waits (w1996: 5 idle on BEAST, 9 on
 * LothDesktop). Between, the wait grows with the load in a straight line. Config timing.unavailableIdleMinutes and
 * timing.unavailableBusyMinutes change both ends.
 */
export const TIMED_WAIT_IDLE_MIN = 5;
export const TIMED_WAIT_BUSY_MIN = 60;

/**
 * The fleet's load for the wait (w2048): the agents mid-turn plus the requests Queued for capacity, over the agent slots of
 * the computers online. One measure of both what runs and what waits: 2026-10-24 12:17Z had 10 requests Queued on a fleet
 * of about 25 slots, most of them mid-turn (busy); 13:25Z had 1 Queued with slots free (half idle). At or under 0.5 the
 * fleet counts as idle (half its slots free and nothing queued), at 1 or more as busy (every slot taken or a queue as
 * long as the free slots).
 */
export function fleetLoad(places: readonly Pick<Computer, 'online' | 'midTurn' | 'maxAgents'>[], queued: number): number {
  const slots = places.filter((p) => p.online).reduce((n, p) => n + p.maxAgents, 0);
  const busy = places.filter((p) => p.online).reduce((n, p) => n + p.midTurn, 0) + queued;
  return slots > 0 ? busy / slots : 1;
}

/** The timing settings (config timing, w2048): whole minutes. */
export interface TimedWaitSettings {
  unavailableIdleMinutes?: number;
  unavailableBusyMinutes?: number;
}

/** The wait for an unavailable computer at `load` (w2048, TIMED_WAIT_IDLE_MIN..TIMED_WAIT_BUSY_MIN), with why in words. */
export function unavailableWait(load: number, s: TimedWaitSettings = {}): { ms: number; why: string } {
  const idle = s.unavailableIdleMinutes ?? TIMED_WAIT_IDLE_MIN;
  const busy = Math.max(idle, s.unavailableBusyMinutes ?? TIMED_WAIT_BUSY_MIN);
  const f = Math.min(1, Math.max(0, (load - 0.5) / 0.5));
  const min = Math.round(idle + (busy - idle) * f);
  const pct = Math.round(load * 100);
  return { ms: min * 60_000, why: `${min} min, as the fleet is at ${pct}% load (mid-turn agents and Queued requests over the online slots: ${idle} min at 50% or less, ${busy} min at 100% or more; w2048)` };
}

/**
 * The wait bound of a timed leg's widening before w2048: a leg Queued this long on busy small computers widened to the big
 * ones. Since w2048 a leg waits for a small computer that is merely busy (online, its queue moving) as long as it takes,
 * and widens only when no small computer it may use is available (smallTimedStates). Kept for the history the ledger holds.
 */
export const TIMED_LEG_WAIT_MS = 60 * 60_000;

/** How long a verdict holds for its worker (an A/B investigation's legs span hours); asked again, the new one replaces it. */
export const TIMED_VERDICT_MS = 12 * 3_600_000;

/** A computer of the timing classes, small or medium (w2055: 1 to 3 agent slots): its exclusive turn idles at most 2 others. */
export const isSmallTimed = (c: Pick<Computer, 'maxAgents'>) => classRank(c) <= 1;

/** "lothlaptop (1 agent slot, 0 live)". */
export const sizeText = (c: Computer) => `${c.id} (${classOf(c)}, ${c.maxAgents} agent slot${c.maxAgents === 1 ? '' : 's'}, ${c.live} live${hasRoom(c) ? ', room now' : ', no room now'})`;

/** Why a small computer can or cannot take a timed leg now (w2048). */
export interface SmallState {
  id: string;
  /** able: online (or offline shorter than the wait, a blip), not held, with a game sandbox; the others cannot take it now. */
  state: 'able' | 'offline' | 'unable';
  why: string;
}

const hhmm = (iso: string) => `${iso.slice(11, 16)}Z`;

/**
 * Every small computer that takes timed runs (w1861: never m5), on `platform` when given, other than `here`, and whether it
 * can take a timed leg now (w2048): offline for at least `waitMs` (asleep, off the network, its daemon down) or unable (held
 * or avoided, no game sandbox) cannot; one online, or offline for less than the wait (a daemon's blip), can, busy or not.
 */
export function smallTimedStates(places: readonly Computer[], prefs: PlacementPrefs = {}, platform?: string, here?: string, now = Date.now(), waitMs = TIMED_WAIT_IDLE_MIN * 60_000): SmallState[] {
  const hold = holdOf(prefs);
  const avoid = avoidOf(prefs);
  return places
    .filter((p) => !p.noTimedRuns && isSmallTimed(p) && p.id !== here && (!platform || p.platform === platform))
    .map((p): SmallState => {
      if (hold.has(p.id)) return { id: p.id, state: 'unable', why: `${p.id} is held (${hold.get(p.id)})` };
      if (avoid.has(p.id)) return { id: p.id, state: 'unable', why: `${p.id} is avoided (${avoid.get(p.id)})` };
      if (p.maxSandboxes <= 0 || p.maxEditors === 0) return { id: p.id, state: 'unable', why: `${p.id} has no game sandbox` };
      if (!p.online) {
        const since = Date.parse(p.offlineSince ?? '');
        const gone = Number.isFinite(since) ? now - since : Number.POSITIVE_INFINITY;
        if (gone < waitMs) return { id: p.id, state: 'able', why: `${p.id} offline ${Math.max(1, Math.round(gone / 1000))} s, a blip so far` };
        return { id: p.id, state: 'offline', why: Number.isFinite(since) ? `${p.id} offline since ${hhmm(p.offlineSince!)} (${Math.round(gone / 60_000)} min)` : `${p.id} offline` };
      }
      return { id: p.id, state: 'able', why: `${p.id} online` };
    });
}

/** "lothlaptop offline since 06:50Z (420 min); biscuit has no game sandbox". */
export const unavailableText = (s: readonly SmallState[]) => s.filter((x) => x.state !== 'able').map((x) => x.why).join('; ');

/**
 * The small computers a timed leg from `here` may go to, best first: able (smallTimedStates: online, or offline shorter
 * than the wait), taking timed runs (w1861: never m5), on `platform` when given, not held or avoided, small; ranked as
 * w1872's timedRank (the fewest agent slots, the lowest editor limit, the fewest live agents), those with room first, an
 * offline one last. Room is not required: a busy small computer queues the leg.
 */
export function smallTimedRank(places: readonly Computer[], prefs: PlacementPrefs = {}, platform?: string, here?: string, now = Date.now(), waitMs?: number): Computer[] {
  const able = new Set(smallTimedStates(places, prefs, platform, here, now, waitMs).filter((s) => s.state === 'able').map((s) => s.id));
  const ok = places.filter((p) => able.has(p.id));
  const key = (p: Computer) => [p.online ? 0 : 1, hasRoom(p) ? 0 : 1, p.maxAgents, p.maxEditors ?? Number.MAX_SAFE_INTEGER, p.live];
  return [...ok].sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return a.id.localeCompare(b.id);
  });
}

/**
 * What a worker told to time on a big computer because no small one can is told to do (w2048, lothsahn: "Timings can't be
 * compared across machines at all. Every machine has wildly different performance").
 */
export const bigFallbackRules = (id: string) =>
  `Every number of this comparison comes from ${id}: run every side on ${id} (A and B, the baseline and the change), re-measure here any baseline that ran on another computer, and never compare with another computer's numbers. Your report says it ran on ${id}, a big computer, and why (the small computers above), and names ${id} as the computer all its numbers come from`;

/** What timed_place decided (w1969). */
export interface TimedPlaceDecision {
  verdict: TimedVerdictKind;
  /** elsewhere: the small computers the leg waits on, best first. */
  needs?: string[];
  /** elsewhere: the computer a Windows player A/B goes to by timed_run (w1946, w1996) instead of a leg. */
  timedRun?: string;
  /** elsewhere by timed_run because the worker named no `via` (w1996): the answer names the leg as the other choice. */
  choose?: boolean;
  /** here on a big computer because no small one can take it (w2048): the small computers and why each cannot. */
  bigFallback?: string;
  /** w2521: the leg must run on its `needs` alone and never widens to another computer. */
  pinned?: boolean;
  why: string;
}

export interface TimedPlaceInput {
  /** The asking worker's computer; undefined when the portal does not know it (the ask then passes). */
  here: Computer | undefined;
  places: readonly Computer[];
  prefs?: PlacementPrefs;
  /** The platform the leg needs ('win32', 'darwin'), or undefined for any OS (w1969: "Any OS is fine"). */
  platform?: string;
  /** Why the numbers must come from this computer (a side of the A/B already ran here, the brief names it). */
  sameMachine?: string;
  /** The urgent release lane's builder or the nightly's worker (BenchPriority.exempt): its machine is chosen for it. */
  exempt?: string;
  /**
   * 'timed_run': a Windows player A/B (w1946), timed by a computer that takes timed runs; 'leg': anything else timed (a snippet
   * timed in the editor, a Performance test, a Mac player), handed to a new worker on a small computer. Unset (w1996): a
   * timed_run computer when one is up, with the leg named as the other choice.
   */
  via?: 'leg' | 'timed_run';
  /**
   * The computers a timed_run can go to now, best first (server/timedRuns.ts windowsTargets: play-only, then small worker
   * computers; online, on a daemon that runs timed runs). Named playOnly before w1996, when only play-only ones took runs.
   */
  timedRun?: readonly string[];
  /** Now, and how long an offline small computer is waited for (w2048, unavailableWait): a shorter outage is a blip. */
  now?: number;
  waitMs?: number;
  /** The wait in words (unavailableWait's why). */
  waitWhy?: string;
  /** The asking worker's request is a timed leg already widened to the big computers (w2048): it times where it is. */
  widenedLeg?: string;
  /**
   * w2521: the one computer the leg must run on (timed_place's `machine`, the asking request's constraints, or "must run on X"
   * in its what, brief or same_machine) and why. It runs there or waits there, never anywhere else (server/machinePin.ts).
   */
  pinned?: { id: string; why: string };
}

/**
 * Where a timed leg runs (w1969), in order: the urgent release's or the nightly's own computer; a computer that takes no
 * timed runs sends it to a small one; the worker's reason for this computer keeps it (both sides of an A/B stay on one
 * machine); a small computer keeps it (its turn idles little); with no small computer online that takes it, here; else a
 * play-only computer by timed_run when the worker asked for that and one is up, else a leg queued for the small computers,
 * which waits for one rather than going to a big one (TIMED_LEG_WAIT_MS).
 */
export function decideTimedPlace(a: TimedPlaceInput): TimedPlaceDecision {
  const here = a.here;
  const os = a.platform === 'win32' ? ' on Windows' : a.platform === 'darwin' ? ' on macOS' : '';
  if (a.exempt) return { verdict: 'here', why: `the ${a.exempt === 'release' ? 'urgent release lane' : 'nightly'} times on its own computer (w1832)` };
  if (a.pinned) {
    // w2521: before every other rule, w2055's idle computer and same_machine included: a pin is a hardware need, not a cost.
    const id = a.pinned.id;
    if (here?.id === id) return { verdict: 'here', pinned: true, why: `it must run on ${id} (${a.pinned.why}), and this is ${id}` };
    const p = a.places.find((c) => c.id === id);
    const state = !p ? 'not known to the portal now' : !p.online ? 'offline now' : hasRoom(p) ? 'free now' : `busy now (${p.live} of ${p.maxAgents} agent slot${p.maxAgents === 1 ? '' : 's'} live)`;
    return { verdict: 'elsewhere', needs: [id], pinned: true, why: `it must run on ${id} only (${a.pinned.why}): the leg waits on ${id}, which is ${state}, and starts there by itself when ${id} can take it; it never falls back to another computer, however idle (w2521)` };
  }
  if (!here) return { verdict: 'here', why: 'the portal does not know this computer: time here as before' };
  const small = smallTimedRank(a.places, a.prefs, a.platform, here.id, a.now, a.waitMs);
  const smallText = small.map(sizeText).join(' > ');
  if (here.noTimedRuns) {
    if (!small.length) {
      // w2147 (lothsahn: "Stop asking to bring computers online ... Use and schedule resources based on what you have. Don't
      // ask for permission"): no small computer can take it now, so the leg is still filed, Queued for every computer that
      // takes timed runs (smallest first, offline ones included); timedLegStep re-places it each pass (w2055) and it starts
      // by itself on the first that fits. Never "ask an operator".
      const all = [...a.places].filter((c) => c.id !== here.id && !timedEligible(c, a.prefs ?? {}, a.platform)).sort(bySize).map((c) => c.id);
      return { verdict: 'elsewhere', needs: all, why: `${here.id} takes no timed runs (${here.noTimedRuns}; w1861) and no small computer${os} that takes them can take it now: the leg waits Queued${all.length ? ` for ${all.join(' > ')}` : ''} and starts by itself on the first that comes online or frees up, in the timing order (w2055; w2147: a capacity wait, never a question for a person)` };
    }
    return { verdict: 'elsewhere', needs: small.map((c) => c.id), why: `${here.id} takes no timed runs (${here.noTimedRuns}; w1861): the leg goes to ${smallText}` };
  }
  const sm = a.sameMachine?.replace(/\s+/g, ' ').trim();
  if (sm) return { verdict: 'here', why: `its numbers must come from ${here.id}: "${sm.slice(0, 200)}" (both sides of an A/B stay on one machine)` };
  if (isSmallTimed(here)) return { verdict: 'here', why: `${here.id} is a ${classOf(here)} computer (${here.maxAgents} agent slot${here.maxAgents === 1 ? '' : 's'}; small and medium, at most 3, time where they are, w2055): its exclusive turn idles little` };
  // w2055: an idle computer of any class takes timed work; the asker's own is idle when it is the only work there.
  if (here.online && here.live <= 1 && here.midTurn <= 1 && (here.editors ?? 0) - (here.idleEditors ?? 0) <= 1 && !here.benchLock && !here.benchQueue?.timed && !here.resumesWaiting && !here.legs?.length)
    return { verdict: 'here', why: `${here.id} (${classOf(here)}, ${here.maxAgents} agent slots) is idle but for this worker: its exclusive turn idles no other work (w2055: an idle computer of any class takes timed work)` };
  if (a.widenedLeg) {
    const why = `${a.widenedLeg} is a timed leg FF Factory widened to the big computers, as no small computer could take it (w2048)`;
    return { verdict: 'here', bigFallback: why, why: `${why}: time here. ${bigFallbackRules(here.id)}` };
  }
  const idles = `${here.id} has ${here.maxAgents} agent slots (${here.live} live now): an exclusive turn there idles all the others`;
  // w1996: a Windows player A/B is built here (shared tickets) and timed on a timed_run computer, so no worker or seat is
  // taken there and nothing is rebuilt; anything else timed goes as a leg to a new worker on a small computer.
  const play = a.via !== 'leg' && a.platform !== 'darwin' ? a.timedRun?.find((id) => id !== here.id) : undefined;
  // w2415 (lothsahn: "Why is biscuit free but not doing timed runs?"; his rule: before and after on one machine, any OS): an
  // A/B that names no OS goes as a leg to an idle computer of any class (biscuit builds and times both Linux players) rather
  // than wait behind a busy timed_run computer or idle this one. A Windows or Mac A/B keeps its OS.
  const idle = a.platform || a.via === 'timed_run' ? [] : [...a.places].filter((c) => c.id !== here.id && !timedEligible(c, a.prefs ?? {}) && !notIdle(c)).sort(bySize);
  const playBusy = play ? notIdle(a.places.find((c) => c.id === play) ?? { ...here, id: play, online: false }) : undefined;
  if (idle.length && (!play || playBusy) && !small.some((c) => !notIdle(c)))
    return { verdict: 'elsewhere', needs: idle.map((c) => c.id), why: `${idles}; it names no OS and ${idle.map(sizeText).join(' > ')} ${idle.length === 1 ? 'is' : 'are'} idle: the leg goes there, both sides built and timed on one machine (w2415)${playBusy ? `; not by timed_run: ${playBusy}` : ''}` };
  if (play) return { verdict: 'elsewhere', timedRun: play, ...(a.via ? {} : { choose: true }), why: `${idles}; a Windows player A/B goes to ${play} by timed_run, built here (w1946, w1996)` };
  if (!small.length) {
    const gone = unavailableText(smallTimedStates(a.places, a.prefs, a.platform, here.id, a.now, a.waitMs));
    const wait = a.waitWhy ? ` (an offline one is waited for ${a.waitWhy})` : '';
    const why = `no small computer${os} that takes timed runs can take it${gone ? `: ${gone}` : ''}${wait}; never m5`;
    return { verdict: 'here', bigFallback: why, why: `${idles}, but ${why}: time here on ${here.id}, a big computer (w2048). ${bigFallbackRules(here.id)}` };
  }
  return { verdict: 'elsewhere', needs: small.map((c) => c.id), why: `${idles}; small computers${os} take it: ${smallText}${small.some(hasRoom) ? '' : `; none has room now, so it queues there and waits while one is online (a big one only if none can take it, w2048)`}` };
}

/** The mark for computer `c` (w1969): a big computer that takes timed runs asks; a small one, or one that takes none, does not. */
export function timedAskMark(c: Computer | undefined): TimedAskMark | undefined {
  if (!c || c.noTimedRuns) return undefined;
  if (isSmallTimed(c)) return { required: false, why: `${c.id} is a ${classOf(c)} computer (${c.maxAgents} agent slots): timed legs run here without asking` };
  return { required: true, why: `${c.id} is a ${classOf(c)} computer (${c.maxAgents} agent slots): an exclusive turn here idles the others, so a worker asks where its timed leg runs first (timed_place, w1969)` };
}

// ------------------------------------------------------------------ the guard

/** Commands that wrap the one after them. */
const WRAPPERS = new Set(['nohup', 'time', 'exec', 'env', 'command', 'nice', 'stdbuf']);
const PYTHONS = /^(?:python(?:3(?:\.\d+)?)?|py)(?:\.exe)?$/i;
const SHELLS = /^(?:bash|sh)(?:\.exe)?$/i;
/** The game repo's bench scripts that take an exclusive timing ticket themselves (bench_lock --timing inside). */
const TIMED_SCRIPTS = /^(?:probe_ab(?:_win(?:_switches)?)?|cpu_budget_run|machine_bench|run_mp_frame_bench|zoom_run)\.sh$/i;

/** A command's segments at ;, &&, ||, | and newlines outside quotes. */
function segments(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: string | undefined;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === '\\' && q === '"' && i + 1 < cmd.length) {
        cur += c + cmd[++i];
        continue;
      }
      if (c === q) q = undefined;
      cur += c;
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === ';' || c === '\n' || c === '|' || c === '&') {
      out.push(cur);
      cur = '';
      if ((c === '|' || c === '&') && cmd[i + 1] === c) i++;
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const words = (seg: string) => (seg.match(/"(?:\\.|[^"\\])*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^"([\s\S]*)"$|^'([\s\S]*)'$/, (_m, a, b) => a ?? b));
const base = (w: string) => w.replace(/\\/g, '/').split('/').pop() ?? w;
const flag = (ws: readonly string[], name: string, value?: string) =>
  ws.some((w, i) => (value === undefined ? w === name || w.startsWith(`${name}=`) : w === `${name}=${value}` || (w === name && ws[i + 1] === value)));

/**
 * What exclusive timing ticket a shell command takes, or undefined (w1969): `bench_queue.py timed` (not `--release`),
 * `bench_queue.py run --mode exclusive` (not `--reason machine`), `unity-bridge.py ... --timed`, `bench_lock --timing`,
 * `unity-slot run --bench exclusive` (not `--bench-reason machine`), and the game repo's bench scripts that take one
 * (probe_ab_win.sh and the rest of TIMED_SCRIPTS) when run, not when read (`grep x probe_ab_win.sh` is no run). A seatbelt:
 * a script of the worker's own that calls these is not seen.
 */
export function timedTicketCommand(cmd: string, depth = 0): string | undefined {
  for (const seg of segments(cmd)) {
    let ws = words(seg.trim());
    for (;;) {
      while (ws.length && /^[A-Za-z_]\w*=/.test(ws[0])) ws = ws.slice(1);
      if (!ws.length) break;
      const w = base(ws[0]);
      if (WRAPPERS.has(w)) ws = ws.slice(1);
      else if (w === 'timeout') {
        ws = ws.slice(1);
        while (ws.length && ws[0].startsWith('-')) ws = ws.slice(ws[0] === '-s' || ws[0] === '-k' ? 2 : 1);
        ws = ws.slice(1);
      } else if (SHELLS.test(w)) {
        const c = ws.indexOf('-c');
        if (c >= 0 && depth < 3) {
          const inner = timedTicketCommand(ws[c + 1] ?? '', depth + 1);
          if (inner) return inner;
          ws = [];
        } else {
          ws = ws.slice(1);
          while (ws.length && ws[0].startsWith('-')) ws = ws.slice(1);
        }
      } else if (PYTHONS.test(w)) {
        ws = ws.slice(1);
        while (ws.length && ws[0].startsWith('-')) ws = ws.slice(ws[0] === '-X' || ws[0] === '-W' ? 2 : 1);
      } else break;
    }
    if (!ws.length) continue;
    const c = base(ws[0]);
    const rest = ws.slice(1);
    if (/^bench_queue\.py$/i.test(c)) {
      if (rest[0] === 'timed' && !rest.includes('--release')) return 'bench_queue.py timed';
      if (rest[0] === 'run' && flag(rest, '--mode', 'exclusive') && !flag(rest, '--reason', 'machine')) return 'bench_queue.py run --mode exclusive';
    } else if (/^unity-bridge\.py$/i.test(c)) {
      if (flag(rest, '--timed')) return 'unity-bridge.py --timed';
    } else if (c === 'bench_lock') {
      if (rest.includes('--timing')) return 'bench_lock --timing';
    } else if (/^unity[-_]slot(?:\.py)?$/i.test(c)) {
      if (flag(rest, '--bench', 'exclusive') && !flag(rest, '--bench-reason', 'machine') && !rest.includes('--preempt')) return 'unity-slot --bench exclusive';
      const dash = rest.indexOf('--');
      if (dash >= 0 && depth < 3) {
        const inner = timedTicketCommand(rest.slice(dash + 1).map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' '), depth + 1);
        if (inner) return inner;
      }
    } else if (TIMED_SCRIPTS.test(c)) return c;
  }
  return undefined;
}

/** What the guard reads for one worker session (machine/benchLock.ts readTimedAsk). */
export interface TimedAskState {
  mark?: TimedAskMark;
  verdict?: TimedVerdict;
  exempt?: string;
}

/**
 * The refusal for a shell command that takes an exclusive timing ticket before its worker asked where the leg runs
 * (w1969), else undefined. Passes: a command that takes none, a computer that does not ask (a small one; a daemon or
 * portal from before w1969 writes no mark), the release lane's and the nightly's workers, and a worker whose verdict is
 * "here" and still holds. A verdict of "elsewhere" refuses with where the leg went.
 */
export function checkTimedAsk(cmd: string, state: TimedAskState | undefined, now = Date.now()): string | undefined {
  const takes = timedTicketCommand(cmd);
  if (!takes || !state?.mark?.required || state.exempt) return undefined;
  const v = state.verdict && Date.parse(state.verdict.until) > now ? state.verdict : undefined;
  if (v?.verdict === 'here') return undefined;
  if (v?.verdict === 'elsewhere') {
    const where = v.timedRun ? `${v.timedRun} by timed_run: build the players here (shared tickets) and call timed_run (for a leg that is no Windows player A/B, call timed_place again with via "leg")` : v.leg ? `${v.leg}, the timed leg FF Factory filed for it, which runs on a small computer and reports to you` : 'a small computer';
    return `w1969: the dispatcher sent this timed leg to ${where} (${v.why}), so ${takes} takes no exclusive ticket here. If its numbers must come from this computer (a side of the A/B already ran here), call timed_place again with same_machine saying why.`;
  }
  return `w1969: ${takes} takes an exclusive bench ticket, and ${state.mark.why}. Call timed_place (what, brief, platform) first: it answers "here" (then run this again) or hands the leg to a small computer and blocks you on its report.`;
}
