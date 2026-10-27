// w1962 (lothsahn: "a shared bench-queue ticket (an editor start, a build) must not wait for hours behind one exclusive
// timed ticket after another"): the daemon's half of the bound, for every copy of the game repo's bench_queue.py.
//
// Each ticket's helper decides under its own branch's copy of bench_queue.py, so the rule the game repo added in w1962
// (a shared ticket an exclusive turn has passed goes before every other exclusive ticket) holds only where both copies
// have it. What every copy does read at every decision is priorities.json, which this daemon writes (w1628). So the
// daemon raises the session of a shared ticket that an exclusive turn has passed to the top priority while it waits.
// Under every copy since w1628 that ticket then sorts before the exclusive tickets taken after it (and the high and
// normal ones taken before it), and under every copy since w1860 it counts against the holder: the 30-minute turn ends
// (w1832) instead of the priority hold keeping the lock. The exclusive guarantee is the queue's and does not change: a
// raised shared ticket still waits for the exclusive holder to go.
import type { BenchPriority, WorkPriority } from '../shared/types.ts';
import type { QueueTicket } from './benchQueue.ts';

/** The top of the queue's order (bench_queue.py PRIORITIES[0]). */
export const RAISE_TO: WorkPriority = 'urgent';

/** bench_queue.py PRIORITIES, highest first. */
const RANKS: WorkPriority[] = ['urgent', 'high', 'normal', 'low'];

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
 * The waiting shared tickets an exclusive turn has passed (w1962): one waiting while an exclusive ticket holds the lock,
 * whether it was taken during that turn or before it was granted, and one that an exclusive ticket taken after it
 * outranks (`sessions`: the priorities the queue reads, unraised), which would otherwise be granted before it. On
 * LothDesktop at 04:04Z on 2026-10-24 (measured) w1905's normal build had waited since 01:03Z behind w1789's high timed
 * leg, taken later, which itself waited behind a running shared group kept urgent by slot6's game players: no exclusive
 * held the lock, so the first case never marked it. A mark lasts while its ticket waits (`prev`, the last look's) and
 * goes when the ticket is granted, revoked or gone. `tickets`: the queue's live tickets (queueTickets).
 */
export function passedShared(tickets: QueueTicket[], prev: Record<string, PassedMark>, now: Date, sessions: Record<string, BenchPriority> = {}, placed: Record<string, string> = {}): Record<string, PassedMark> {
  const holders = tickets.filter((t) => t.mode === 'exclusive' && t.granted && !t.revoked);
  const rank = (t: QueueTicket) => RANKS.indexOf((t.session && sessions[t.session]?.priority) || 'normal');
  const num = (t: QueueTicket) => Number(t.ticket.replace(/\D/g, ''));
  const later = tickets.filter((t) => t.mode === 'exclusive' && !t.granted && !t.revoked);
  const out: Record<string, PassedMark> = {};
  for (const t of tickets) {
    if (t.mode !== 'shared' || t.granted || t.revoked) continue;
    const mark = prev[t.ticket];
    if (mark) {
      out[t.ticket] = mark;
      continue;
    }
    const h = holders.find((x) => !ridesAlong(t, x, placed)) ?? later.find((x) => num(x) > num(t) && rank(x) < rank(t) && !ridesAlong(t, x, placed));
    if (h) out[t.ticket] = { by: h.ticket, since: now.toISOString() };
  }
  return out;
}

/**
 * The sessions as priorities.json carries them (w1962): those of passed shared tickets raised to RAISE_TO while they
 * wait, each with `raisedFrom` (its own priority) and `raisedFor` (the ticket). A session with a live exclusive ticket
 * of its own is not raised: that would move its timed leg up too. A ticket with no session cannot be raised (a ticket
 * whose session priorities.json does not name counts as normal; it is named here when raised).
 */
export function raisedSessions(sessions: Record<string, BenchPriority>, tickets: QueueTicket[], passed: Record<string, PassedMark>): { sessions: Record<string, BenchPriority>; raised: string[] } {
  const timed = new Set(tickets.filter((t) => t.mode === 'exclusive' && !t.revoked && t.session).map((t) => t.session!));
  const out = { ...sessions };
  const raised: string[] = [];
  for (const t of tickets) {
    const s = t.session;
    if (!passed[t.ticket] || !s || timed.has(s) || out[s]?.raisedFor) continue;
    const base: BenchPriority = out[s] ?? { priority: 'normal', requests: t.requests ?? [] };
    if (base.priority === RAISE_TO) continue;
    out[s] = { ...base, priority: RAISE_TO, raisedFrom: base.priority, raisedFor: t.ticket };
    raised.push(t.ticket);
  }
  return { sessions: out, raised };
}

/** The editor starts' sessions (w1962): `editor:<sandbox>` at the highest priority of the worker sessions placed in that
 * sandbox (`placed`: session id and sandbox), with their requests; a sandbox with no known worker gets none (normal). */
export function editorSessions(placed: { session: string; sandbox?: string }[], sessions: Record<string, BenchPriority>): Record<string, BenchPriority> {
  const rank = (p: WorkPriority) => RANKS.indexOf(p);
  const out: Record<string, BenchPriority> = {};
  for (const { session, sandbox } of placed) {
    const p = sessions[session];
    if (!sandbox || !p) continue;
    const key = editorBenchSession(sandbox);
    const cur = out[key];
    if (!cur || rank(p.priority) < rank(cur.priority)) out[key] = { priority: p.priority, requests: [...new Set([...(p.requests ?? []), ...(cur?.requests ?? [])])].slice(0, 6) };
    else out[key] = { ...cur, requests: [...new Set([...cur.requests, ...(p.requests ?? [])])].slice(0, 6) };
  }
  return out;
}
