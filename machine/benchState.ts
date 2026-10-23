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

/** bench_queue.py turn_min: an exclusive ticket's turn, for one from before w1832 its max_min (OLD_MAX_MIN, 60). */
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
  return { sessions, singleWorker: v2 && f?.single_worker === true };
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

function glance(t: QueueTicket, info: Record<string, unknown> | undefined, m: Marks): BenchTicketGlance {
  const since = t.granted ? t.granted.ts * 1000 : t.created ? Date.parse(t.created) : NaN;
  const exempt = m.sessions[t.session ?? '']?.exempt;
  const preempt = info?.preempt === true && t.mode === 'exclusive';
  const lim = (t.limit ?? {}) as { deadline?: unknown; warned?: unknown; why?: unknown; release?: unknown };
  const deadline = typeof lim.deadline === 'number' ? lim.deadline * 1000 : NaN;
  const warned = typeof lim.warned === 'number' ? lim.warned * 1000 : NaN;
  const turnMin = t.mode === 'exclusive' ? (t.turnMin ?? t.maxMin ?? OLD_TURN_MIN) : undefined;
  // bench_queue.py never_limited: an exempt ticket, the urgent release lane's or one on a single-worker machine has no turn
  const limited = !exempt && !preempt && !m.singleWorker;
  const until = Number.isFinite(deadline) ? deadline : t.granted && limited && turnMin ? since + turnMin * 60_000 : NaN;
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
  const next = waiting.findIndex((t) => t.mode === 'exclusive');
  const old = readBenchLock(root, now, alive);
  const legacy = old && !/\[t\d{8}\]/.test(old.owner) ? { owner: old.owner, since: old.since } : undefined;
  const mode: BenchState['mode'] = legacy || running.some((t) => t.mode === 'exclusive') ? 'exclusive' : running.length ? 'shared' : 'free';
  const editors = mode === 'exclusive' ? closedEditors(root) : [];
  const players = mode === 'exclusive' ? playersClosed : 0;
  const g = (t: QueueTicket) => glance(t, infos.get(t.ticket), m);
  return {
    mode,
    running: running.slice(0, BENCH_STATE_MAX_RUNNING).map(g),
    runningCount: running.length,
    waiting: waiting.length,
    ...(next >= 0 ? { nextExclusive: { ...g(waiting[next]), ahead: next } } : {}),
    ...(legacy ? { legacy } : {}),
    ...(m.singleWorker ? { singleWorker: true } : {}),
    ...(editors.length || players ? { closed: { editors, players } } : {}),
  };
}
