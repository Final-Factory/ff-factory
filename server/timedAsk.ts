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
import { avoidOf, holdOf, hasRoom, type Computer, type PlacementPrefs } from './placement.ts';
import type { TimedAskMark, TimedVerdict, TimedVerdictKind } from '../shared/types.ts';

/**
 * A computer at or under this many agent slots is small (a judgment, w1969). An exclusive turn idles every other slot of
 * its computer: up to 3 on the small ones of 2026-10-24 (LothLaptop 1, m3 and biscuit at 2 sandboxes of 2 agents), 5 on
 * BEAST (6 agents) and 9 on LothDesktop (10). Handing a leg off costs one worker's start and its builds on the small
 * computer, about one slot's work, so it pays where the turn would idle 5 or more.
 */
export const SMALL_TIMED_MAX_AGENTS = 4;

/**
 * How long a timed leg waits for a small computer before any computer that takes timed runs may take it (w1969; a
 * judgment from the bench queue's own numbers): a turn there lasts 30 minutes at most (the game repo's bench_queue.py
 * turn_min cap, machine/benchLock.ts turnMinOf), so 60 minutes is two full turns ahead of it. Past that the leg's needs
 * widen to the big computers too (Orchestrators.timedLegBound), with a log line saying so.
 */
export const TIMED_LEG_WAIT_MS = 60 * 60_000;

/** How long a verdict holds for its worker (an A/B investigation's legs span hours); asked again, the new one replaces it. */
export const TIMED_VERDICT_MS = 12 * 3_600_000;

export const isSmallTimed = (c: Pick<Computer, 'maxAgents'>) => c.maxAgents <= SMALL_TIMED_MAX_AGENTS;

/** "lothlaptop (1 agent slot, 0 live)". */
export const sizeText = (c: Computer) => `${c.id} (${c.maxAgents} agent slot${c.maxAgents === 1 ? '' : 's'}, ${c.live} live${hasRoom(c) ? ', room now' : ', no room now'})`;

/**
 * The small computers a timed leg from `here` may go to, best first: online, taking timed runs (w1861: never m5), on
 * `platform` when given, not held or avoided, small; ranked as w1872's timedRank (the fewest agent slots, the lowest editor
 * limit, the fewest live agents), those with room first. Room is not required: a busy small computer queues the leg.
 */
export function smallTimedRank(places: readonly Computer[], prefs: PlacementPrefs = {}, platform?: string, here?: string): Computer[] {
  const hold = holdOf(prefs);
  const avoid = avoidOf(prefs);
  const ok = places.filter((p) => p.online && !p.noTimedRuns && isSmallTimed(p) && p.id !== here && !hold.has(p.id) && !avoid.has(p.id) && (!platform || p.platform === platform));
  const key = (p: Computer) => [hasRoom(p) ? 0 : 1, p.maxAgents, p.maxEditors ?? Number.MAX_SAFE_INTEGER, p.live];
  return [...ok].sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return a.id.localeCompare(b.id);
  });
}

/** What timed_place decided (w1969). */
export interface TimedPlaceDecision {
  verdict: TimedVerdictKind;
  /** elsewhere: the small computers the leg waits on, best first. */
  needs?: string[];
  /** elsewhere: the play-only computer a player A/B goes to by timed_run (w1946) instead of a leg. */
  timedRun?: string;
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
  /** 'timed_run': a player A/B that a play-only computer can take (w1946). */
  via?: 'leg' | 'timed_run';
  /** The play-only computers online on a daemon that runs timed runs (server/timedRuns.ts targets). */
  playOnly?: readonly string[];
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
  if (!here) return { verdict: 'here', why: 'the portal does not know this computer: time here as before' };
  const small = smallTimedRank(a.places, a.prefs, a.platform, here.id);
  const smallText = small.map(sizeText).join(' > ');
  if (here.noTimedRuns) {
    if (!small.length) return { verdict: 'elsewhere', needs: [], why: `${here.id} takes no timed runs (${here.noTimedRuns}; w1861) and no small computer${os} that takes them is online: ask an operator` };
    return { verdict: 'elsewhere', needs: small.map((c) => c.id), why: `${here.id} takes no timed runs (${here.noTimedRuns}; w1861): the leg goes to ${smallText}` };
  }
  const sm = a.sameMachine?.replace(/\s+/g, ' ').trim();
  if (sm) return { verdict: 'here', why: `its numbers must come from ${here.id}: "${sm.slice(0, 200)}" (both sides of an A/B stay on one machine)` };
  if (isSmallTimed(here)) return { verdict: 'here', why: `${here.id} is a small computer (${here.maxAgents} agent slot${here.maxAgents === 1 ? '' : 's'}, at most ${SMALL_TIMED_MAX_AGENTS}): its exclusive turn idles little` };
  const idles = `${here.id} has ${here.maxAgents} agent slots (${here.live} live now): an exclusive turn there idles all the others`;
  if (!small.length) return { verdict: 'here', why: `${idles}, but no small computer${os} that takes timed runs is online (never m5): time here` };
  const play = a.via === 'timed_run' && a.platform !== 'darwin' ? a.playOnly?.[0] : undefined;
  if (play) return { verdict: 'elsewhere', timedRun: play, why: `${idles}; a player A/B goes to the play-only computer ${play} by timed_run (w1946)` };
  return { verdict: 'elsewhere', needs: small.map((c) => c.id), why: `${idles}; small computers${os} take it: ${smallText}${small.some(hasRoom) ? '' : `; none has room now, so it queues there (a big one only after ${TIMED_LEG_WAIT_MS / 60_000} min)`}` };
}

/** The mark for computer `c` (w1969): a big computer that takes timed runs asks; a small one, or one that takes none, does not. */
export function timedAskMark(c: Computer | undefined): TimedAskMark | undefined {
  if (!c || c.noTimedRuns) return undefined;
  if (isSmallTimed(c)) return { required: false, why: `${c.id} is a small computer (${c.maxAgents} agent slots): timed legs run here without asking` };
  return { required: true, why: `${c.id} has ${c.maxAgents} agent slots: an exclusive turn here idles the others, so a worker asks where its timed leg runs first (timed_place, w1969)` };
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
    const where = v.timedRun ? `the play-only computer ${v.timedRun}: build the players here (shared tickets) and call timed_run` : v.leg ? `${v.leg}, the timed leg FF Factory filed for it, which runs on a small computer and reports to you` : 'a small computer';
    return `w1969: the dispatcher sent this timed leg to ${where} (${v.why}), so ${takes} takes no exclusive ticket here. If its numbers must come from this computer (a side of the A/B already ran here), call timed_place again with same_machine saying why.`;
  }
  return `w1969: ${takes} takes an exclusive bench ticket, and ${state.mark.why}. Call timed_place (what, brief, platform) first: it answers "here" (then run this again) or hands the leg to a small computer and blocks you on its report.`;
}
