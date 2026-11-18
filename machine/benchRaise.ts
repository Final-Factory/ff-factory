// w4620 (lothsahn, 2026-11-17: "Why is urgent work in a queue behind non urgent work? ... The factory should be using
// strict priority queues"): every queue serves frantic > urgent > high > normal > low, first come first served only within
// one priority, shared and exclusive tickets alike. w1962 here raised the session of a shared ticket that an exclusive turn
// had passed to urgent in priorities.json (lothsahn: "a shared bench-queue ticket (an editor start, a build) must not wait
// for hours behind one exclusive timed ticket after another"); that jumped the ticket across priorities and is gone. What
// stays: the passed marks, now only a display of who waited behind whom at one priority, the editor starts' sessions
// (`editor:<sandbox>`, w1962) and the sandbox helpers. A release is filed at the top priority (`release` in w4620, `frantic` since w4710), with no handling of its own
// (lothsahn, w4620: "not have special handling for releases"): the portal sends it as `{ priority: 'urgent', level:
// 'release' }`, so a copy of bench_queue.py from before w4620 still sorts it first; read `level ?? priority`.
import { asWorkPriority, type BenchPriority, type WorkPriority } from '../shared/types.ts';
import type { QueueTicket } from './benchQueue.ts';

/** The queue's order, highest first (bench_queue.py PRIORITIES from w4620). */
const RANKS: WorkPriority[] = ['frantic', 'urgent', 'high', 'normal', 'low'];

/** A session's effective priority: `level` (frantic, sent as `release`: BENCH_TOP_LEVEL) when the portal sent one, else `priority`. */
const effective = (p: BenchPriority | undefined): string => p?.level ?? p?.priority ?? 'low';

/** Position in RANKS, 0 the highest; a priority the queue does not know counts as low. */
const rankOf = (p: string): number => {
  const w = asWorkPriority(p); // w4710: `release` (the wire's level, and the name before w4710) is frantic
  const i = w ? RANKS.indexOf(w) : -1;
  return i < 0 ? RANKS.length - 1 : i;
};

/** A shared ticket an exclusive turn has passed (w1962): `by` is that exclusive ticket, `since` when the daemon saw it. */
export interface PassedMark {
  by: string;
  since: string;
}

/** The daemon's own session for an editor start's ticket in sandbox `id` (w1962): its bench_queue.py ticket carries it
 * (FF_BENCH_SESSION), so the start waits at its sandbox's worker's priority and can be raised on its own. */
export const editorBenchSession = (id: string) => `editor:${id}`;

const LIFE_PREFIXES = ['running editor ', 'running player '];

/** The sandbox whose folder holds `p` (bench_queue.py sandbox_of_path, w2413): the name after its last `sandboxes` folder,
 * else ''. Either slash; a Windows drive path in any case. */
export function sandboxOfPath(p: string | undefined): string {
  let parts = String(p ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length && /^[a-z]:$/i.test(parts[0])) parts = parts.map((x) => x.toLowerCase());
  for (let i = parts.length - 2; i >= 0; i--) if (parts[i] === 'sandboxes') return parts[i + 1];
  return '';
}

/** bench_queue.py rides_along (w2413 own_sandboxes): the life ticket of an editor in one of an exclusive ticket's own
 * sandboxes (its ticket's, its checkout's, and the one its session is placed in now, `placed`), or of a player of its own
 * worker, never holds that exclusive ticket back, so its turn passes nothing. Names match whole: slot22 is not slot2. */
function ridesAlong(t: QueueTicket, ex: QueueTicket, placed: Record<string, string> = {}): boolean {
  if (t.mode !== 'shared' || ex.mode !== 'exclusive' || !LIFE_PREFIXES.some((p) => t.what.startsWith(p))) return false;
  if (ex.session && t.session === ex.session) return true;
  const theirs = (t.sandbox || sandboxOfPath(t.cwd)).toLowerCase();
  const own = [ex.sandbox, sandboxOfPath(ex.cwd), ex.session ? placed[ex.session] : undefined].filter(Boolean).map((x) => x!.toLowerCase());
  return !!theirs && own.includes(theirs);
}

/**
 * The waiting shared tickets an exclusive turn has passed (w1962, w4620): one waiting while a granted, unrevoked exclusive
 * ticket holds the lock whose priority is not higher than its own, which is unfairness within one priority. A holder of a
 * higher priority passes nothing: that is the strict order working. `sessions`: the priorities the queue reads (a ticket
 * whose session they do not name counts as low). A mark lasts while its ticket waits (`prev`, the last look's) and goes
 * when the ticket is granted, revoked or gone. `tickets`: the queue's live tickets (queueTickets).
 */
export function passedShared(tickets: QueueTicket[], prev: Record<string, PassedMark>, now: Date, sessions: Record<string, BenchPriority> = {}, placed: Record<string, string> = {}): Record<string, PassedMark> {
  const holders = tickets.filter((t) => t.mode === 'exclusive' && t.granted && !t.revoked);
  const rank = (t: QueueTicket) => rankOf(effective(t.session ? sessions[t.session] : undefined));
  const out: Record<string, PassedMark> = {};
  for (const t of tickets) {
    if (t.mode !== 'shared' || t.granted || t.revoked) continue;
    const mark = prev[t.ticket];
    if (mark) {
      out[t.ticket] = mark;
      continue;
    }
    const h = holders.find((x) => rank(x) >= rank(t) && !ridesAlong(t, x, placed));
    if (h) out[t.ticket] = { by: h.ticket, since: now.toISOString() };
  }
  return out;
}

/**
 * Raises nothing any more (w4620; it did to `urgent` for a passed shared ticket, w1962): the sessions come back as they
 * are and `raised` is empty. The passed marks stay as a display of who waited behind whom at one priority; the game
 * repo's bench_queue.py orders within one priority first come first served itself. Kept for machine/daemon.ts.
 */
export function raisedSessions(sessions: Record<string, BenchPriority>, _tickets: QueueTicket[], _passed: Record<string, PassedMark>): { sessions: Record<string, BenchPriority>; raised: string[] } {
  return { sessions, raised: [] };
}

/** The editor starts' sessions (w1962): `editor:<sandbox>` at the highest priority of the worker sessions placed in that
 * sandbox (`placed`: session id and sandbox), with their requests and the top worker's `level`; a sandbox with no known
 * worker gets none (low, w4620). */
export function editorSessions(placed: { session: string; sandbox?: string }[], sessions: Record<string, BenchPriority>): Record<string, BenchPriority> {
  const out: Record<string, BenchPriority> = {};
  for (const { session, sandbox } of placed) {
    const p = sessions[session];
    if (!sandbox || !p) continue;
    const key = editorBenchSession(sandbox);
    const cur = out[key];
    if (!cur || rankOf(effective(p)) < rankOf(effective(cur))) out[key] = { priority: p.priority, ...(p.level ? { level: p.level } : {}), requests: [...new Set([...(p.requests ?? []), ...(cur?.requests ?? [])])].slice(0, 6) };
    else out[key] = { ...cur, requests: [...new Set([...cur.requests, ...(p.requests ?? [])])].slice(0, 6) };
  }
  return out;
}
