// A longer exclusive bench turn a person approved (w3186; docs/orchestrators.md "A longer bench turn a person approved").
// ben on w3159, 2026-11-06: "Give each overload run a one-off 60-minute exclusive turn on biscuit, with the ffu test runners
// paused". The 30-minute turn (w1832, lothsahn's rule) stays the default; a person's own orchestrator records an exception
// for one request on one machine in that person's turn, with their verbatim words (Orchestrators.grantBenchTurn). The portal
// then marks the request's worker sessions on that machine `exempt: 'approved'` in the bench_priorities it sends
// (agents.ts benchPriorities), the daemon writes the mark into priorities.json, and the game repo's bench_queue.py gives
// those sessions' exclusive tickets the approved minutes, their clock started once the machine's CI jobs drained. The daemon
// pauses the machine's CI runners for any timed holder and continues them when it lets go, dies or is revoked (w3112,
// machine/benchRunners.ts). A worker never writes the mark: priorities.json is the daemon's, rewritten every minute.
import type { ApprovedBenchMark, BenchGrant, BenchState, WorkItem } from '../shared/types.ts';

export const BENCH_GRANT_MAX_TURNS = 4;
/** bench_queue.py APPROVED_MAX_MIN: the longest turn an approval gives. */
export const BENCH_GRANT_MAX_MIN = 240;
/** The default turn (bench_queue.py MAX_TURN_MIN): an approval asks for longer. */
export const BENCH_TURN_MIN = 30;
export const BENCH_GRANT_DAYS = 7;
export const BENCH_GRANT_MAX_DAYS = 30;

/** The grant on `w` that holds on `machine` now, if any (not ended, not expired). */
export function liveGrant(w: WorkItem, machine: string, now: number): BenchGrant | undefined {
  return (w.benchGrants ?? []).find((g) => !g.ended && g.machine === machine && Date.parse(g.expires) > now);
}

/** What priorities.json carries for it (bench_queue.py approved_mark reads it). */
export function approvedMark(w: WorkItem, g: BenchGrant): ApprovedBenchMark {
  return { grant: g.id, by: g.by.displayName, request: w.id, turns: g.turns, turn_min: g.minutes, used: [...g.used] };
}

/** "w3159.b1: 2 turns of 60 min on biscuit, 1 used, approved by ben (2026-11-06): "…"" */
export function grantLine(g: BenchGrant): string {
  const state = g.ended ? `ended ${g.ended.slice(0, 16).replace('T', ' ')}Z: ${g.endedWhy ?? ''}` : `${g.used.length} used${g.used.length ? ` (${g.used.join(', ')})` : ''}, expires ${g.expires.slice(0, 10)}`;
  return `${g.id}: ${g.turns} exclusive turn${g.turns === 1 ? '' : 's'} of ${g.minutes} min on ${g.machine}, ${state}; approved by ${g.by.displayName} ${g.at.slice(0, 10)}: "${g.words}"`;
}

/** The input checks; answers the problem in words, or nothing. */
export function grantProblem(a: { turns?: number; minutes?: number; expiresDays?: number }): string | undefined {
  if (!Number.isInteger(a.turns) || a.turns! < 1 || a.turns! > BENCH_GRANT_MAX_TURNS) return `turns: 1 to ${BENCH_GRANT_MAX_TURNS}`;
  if (!Number.isInteger(a.minutes) || a.minutes! <= BENCH_TURN_MIN || a.minutes! > BENCH_GRANT_MAX_MIN) return `minutes: more than the ${BENCH_TURN_MIN}-minute turn everyone has, at most ${BENCH_GRANT_MAX_MIN}`;
  if (a.expiresDays !== undefined && (!Number.isInteger(a.expiresDays) || a.expiresDays < 1 || a.expiresDays > BENCH_GRANT_MAX_DAYS)) return `expires_days: 1 to ${BENCH_GRANT_MAX_DAYS}`;
  return undefined;
}

export interface GrantCount {
  /** Tickets newly counted as a turn. */
  took: string[];
  /** Set when the grant ends now. */
  ended?: string;
}

/**
 * Count the turns a grant's sessions took, from the machine's bench state (the daemon's stats, w1835): an exclusive holder
 * of one of `sessions` that bench_queue.py took under the approval (its glance `approved`) is a turn, while turns are left.
 * Once every turn was taken and none of them still holds, the grant ends. With no bench state (an older or offline daemon)
 * nothing is counted. Mutates `g`.
 */
export function countGrant(g: BenchGrant, bench: BenchState | undefined, sessions: ReadonlySet<string>, now: number): GrantCount {
  const out: GrantCount = { took: [] };
  if (!g.ended && Date.parse(g.expires) <= now) {
    out.ended = `it expired with ${g.used.length} of ${g.turns} turns used`;
  } else if (bench && !g.ended) {
    for (const t of bench.running) {
      if (t.mode !== 'exclusive' || !t.approved || !t.session || !sessions.has(t.session) || g.used.includes(t.ticket)) continue;
      if (g.used.length >= g.turns) break;
      g.used.push(t.ticket);
      out.took.push(t.ticket);
    }
    const holding = bench.running.some((t) => g.used.includes(t.ticket));
    if (g.used.length >= g.turns && !holding) out.ended = `its ${g.turns} turn${g.turns === 1 ? '' : 's'} (${g.used.join(', ')}) were used`;
  }
  if (out.ended) {
    g.ended = new Date(now).toISOString();
    g.endedWhy = out.ended;
  }
  return out;
}
