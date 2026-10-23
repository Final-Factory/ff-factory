// A machine's bench queue as the machine view shows it (w1835; lothsahn, 2026-10-23: "Please display on FF factory's
// webpage for the machine view whether each machine is in shared or exclusive lock mode"): its mode, who holds it and
// since when, and what waits. Read only, from the queue's files (machine/benchQueue.ts queueTickets), every stats report.
// Since w1829 and w1832 also each turn's deadline and warning, the release and nightly marks, and what a turn closed.
import fs from 'node:fs';
import path from 'node:path';
import type { BenchState, BenchTicketGlance } from '../shared/types.ts';
import { benchLockDir, pidAlive, readBenchLock } from './benchLock.ts';
import { benchQueueDir, queueTickets, type QueueTicket } from './benchQueue.ts';
import { closedFile } from './benchTurn.ts';

/** The holders the report lists by name; a big shared group is a count past these. */
export const BENCH_STATE_MAX_RUNNING = 6;

/** bench_queue.py turn_min: an exclusive ticket's turn, at most MAX_HOLD_MIN (30); one from before w1832 keeps its max_min
 * (OLD_MAX_MIN, 60). */
const TURN_MIN = 30;
const OLD_TURN_MIN = 60;

/** bench_queue.py PRIORITIES: the queue sorts by these first (w1628). */
const PRIORITIES = ['urgent', 'high', 'normal', 'low'];

const readJson = (f: string): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return undefined;
  }
};

interface Marks {
  sessions: Record<string, { priority: string; exempt?: 'release' | 'nightly' }>;
  singleWorker: boolean;
  /** The file is v 2 (the marks are this daemon's); before it, any pre-empt ticket counts as the urgent release. */
  v2: boolean;
}

/** priorities.json, which the daemon writes (machine/benchLock.ts writeBenchPriorities): each worker session's priority and
 * exempt mark, and whether this machine runs one worker (bench_queue.py read_priorities: the marks count from v 2). */
function marks(qdir: string): Marks {
  const f = readJson(path.join(qdir, 'priorities.json'));
  const v2 = typeof f?.v === 'number' && f.v >= 2;
  const raw = (f?.sessions ?? {}) as Record<string, { priority?: string; exempt?: string }>;
  const sessions = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => {
      const exempt: Marks['sessions'][string]['exempt'] = v2 && (v?.exempt === 'release' || v?.exempt === 'nightly') ? v.exempt : undefined;
      return [k, { priority: String(v?.priority ?? ''), ...(exempt ? { exempt } : {}) }];
    }),
  );
  return { sessions, singleWorker: v2 && f?.single_worker === true, v2 };
}

const num = (ticket: string) => Number(ticket.slice(1)) || 0;

/** The queue's own order (bench_queue.py order_key): priority, then its place (`pos`, a shared group's), then its number. */
function orderKey(t: QueueTicket, info: Record<string, unknown> | undefined, m: Marks): [number, number, number] {
  const p = PRIORITIES.indexOf(m.sessions[t.session ?? '']?.priority ?? '');
  const pos = info?.pos;
  return [p < 0 ? PRIORITIES.indexOf('normal') : p, typeof pos === 'number' ? pos : num(t.ticket), num(t.ticket)];
}

const cmp = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const iso = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString() : undefined);

/** bench_queue.py is_urgent_release: a pre-empt ticket counts as the urgent release lane's only from the session the
 * daemon marks release (or with a file from before the marks); any other waits like an exclusive ticket. */
function urgentRelease(t: QueueTicket, info: Record<string, unknown> | undefined, m: Marks): boolean {
  return info?.preempt === true && t.mode === 'exclusive' && (m.sessions[t.session ?? '']?.exempt === 'release' || !m.v2);
}

/**
 * A holder's deadline counts while one of the waiters that set it still waits (`live`): the queue drops a deadline only
 * at a waiter's look (bench_queue.py _enforce_limits), so once they all left, limit.json lingers until the next one comes.
 */
function limitHolds(lim: Record<string, unknown>, live: Set<string>): boolean {
  const names = [...(Array.isArray(lim.waiters) ? lim.waiters : []), lim.by, lim.release].filter((x): x is string => typeof x === 'string');
  return !names.length || names.some((n) => live.has(n));
}

function glance(t: QueueTicket, info: Record<string, unknown> | undefined, m: Marks, live: Set<string>): BenchTicketGlance {
  const since = t.granted ? t.granted.ts * 1000 : t.created ? Date.parse(t.created) : NaN;
  const exempt = m.sessions[t.session ?? '']?.exempt;
  const preempt = urgentRelease(t, info, m);
  const raw = (t.limit ?? {}) as Record<string, unknown>;
  const lim = (limitHolds(raw, live) ? raw : {}) as { deadline?: unknown; warned?: unknown; why?: unknown; release?: unknown };
  const deadline = typeof lim.deadline === 'number' ? lim.deadline * 1000 : NaN;
  const warned = typeof lim.warned === 'number' ? lim.warned * 1000 : NaN;
  const turnMin = t.mode === 'exclusive' ? (t.turnMin ? Math.min(t.turnMin, TURN_MIN) : (t.maxMin ?? OLD_TURN_MIN)) : undefined;
  // bench_queue.py never_limited: an exempt ticket, the urgent release lane's or one on a single-worker machine has no turn
  const limited = !exempt && !preempt && !m.singleWorker;
  // w1860: a holder that outranks every waiter keeps the lock (keep.json), while one of those waiters still waits; no
  // deadline and no turn's end apply then, so no countdown is shown that would not fire
  const keep = t.granted && limited && !Number.isFinite(deadline) && t.keep && Array.isArray(t.keep.waiters) && t.keep.waiters.some((n) => live.has(n)) ? t.keep : undefined;
  const until = Number.isFinite(deadline) ? deadline : t.granted && limited && turnMin && !keep ? since + turnMin * 60_000 : NaN;
  const out: BenchTicketGlance = {
    ticket: t.ticket,
    mode: t.mode,
    what: t.what.slice(0, 120),
    ...(t.session ? { session: t.session } : {}),
    ...(t.requests?.length ? { requests: t.requests.slice(0, 4) } : {}),
    ...(t.host ? { host: t.host } : {}),
    ...(t.sandbox ? { sandbox: t.sandbox } : {}),
  };
  const s = iso(since);
  if (s) out.since = s;
  const u = t.granted ? iso(until) : undefined;
  if (u) out.until = u;
  if (turnMin) out.turnMin = turnMin;
  const d = t.granted ? iso(deadline) : undefined;
  if (d) {
    out.deadline = d;
    const w = iso(warned);
    if (w) out.warned = w;
    if (typeof lim.why === 'string' && lim.why) out.why = lim.why.slice(0, 160);
    if (lim.release) out.release = true;
  }
  if (exempt) out.exempt = exempt;
  if (preempt) out.preempt = true;
  const ks = keep ? iso(typeof keep.since === 'number' ? keep.since * 1000 : since) : undefined;
  if (keep && ks) out.keeps = { since: ks, ...(keep.why ? { why: String(keep.why).slice(0, 160) } : {}), ...(keep.priority ? { priority: String(keep.priority) } : {}) };
  return out;
}

/** The sandboxes an exclusive turn keeps closed (w1829: its guard's file, machine/benchTurn.ts writeClosedFile). */
function closedEditors(root: string): string[] {
  return Object.keys(readJson(closedFile(root)) ?? {}).sort();
}

/**
 * The bench queue's state under the worker root, or undefined without one. Revoked tickets count for nothing (their
 * holders are stopping); a granted exclusive one makes the mode exclusive, granted shared ones shared, and an old-style
 * lock (no ticket in its owner line, machine/benchLock.ts readBenchLock) exclusive too. `playersClosed`: the game players
 * this machine's exclusive turn asked to quit (machine/benchTurn.ts, which keeps them in memory).
 */
export function readBenchState(root: string | undefined, now: number = Date.now(), alive: (pid: number) => boolean = pidAlive, playersClosed = 0): BenchState | undefined {
  if (!root) return undefined;
  const lock = benchLockDir(root);
  const qdir = benchQueueDir(lock);
  const m = marks(qdir);
  const live = queueTickets(lock, alive).filter((t) => !t.revoked);
  const infos = new Map(live.map((t) => [t.ticket, readJson(path.join(qdir, t.ticket, 'info.json'))]));
  const keys = new Map(live.map((t) => [t.ticket, orderKey(t, infos.get(t.ticket), m)]));
  const sorted = [...live].sort((a, b) => cmp(keys.get(a.ticket)!, keys.get(b.ticket)!));
  // Exclusive holders first: the one that sets the mode leads the list.
  const running = sorted.filter((t) => t.granted).sort((a, b) => (a.mode === b.mode ? 0 : a.mode === 'exclusive' ? -1 : 1));
  const waiting = sorted.filter((t) => !t.granted);
  // A waiting urgent release goes ahead of every waiter, and nobody else starts meanwhile (bench_queue.py evaluate).
  const urgent = waiting.findIndex((t) => urgentRelease(t, infos.get(t.ticket), m));
  const next = urgent >= 0 ? urgent : waiting.findIndex((t) => t.mode === 'exclusive');
  const waiters = new Set(waiting.map((t) => t.ticket));
  const old = readBenchLock(root, now, alive);
  const legacy = old && !/\[t\d{8}\]/.test(old.owner) ? { owner: old.owner, since: old.since } : undefined;
  const mode: BenchState['mode'] = legacy || running.some((t) => t.mode === 'exclusive') ? 'exclusive' : running.length ? 'shared' : 'free';
  const editors = mode === 'exclusive' ? closedEditors(root) : [];
  const players = mode === 'exclusive' ? playersClosed : 0;
  const g = (t: QueueTicket) => glance(t, infos.get(t.ticket), m, waiters);
  return {
    mode,
    running: running.slice(0, BENCH_STATE_MAX_RUNNING).map(g),
    runningCount: running.length,
    waiting: waiting.length,
    ...(next >= 0 ? { nextExclusive: { ...g(waiting[next]), ahead: urgent >= 0 ? 0 : next } } : {}),
    ...(legacy ? { legacy } : {}),
    ...(m.singleWorker ? { singleWorker: true } : {}),
    ...(editors.length || players ? { closed: { editors, players } } : {}),
  };
}
