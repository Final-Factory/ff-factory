// A machine's bench queue as the machine view shows it (w1835; lothsahn, 2026-10-23: "Please display on FF factory's
// webpage for the machine view whether each machine is in shared or exclusive lock mode"): its mode, who holds it and
// since when, and what waits. Read only, from the queue's files (machine/benchQueue.ts queueTickets), every stats report.
import fs from 'node:fs';
import path from 'node:path';
import type { BenchState, BenchTicketGlance } from '../shared/types.ts';
import { benchLockDir, pidAlive, readBenchLock } from './benchLock.ts';
import { benchQueueDir, queueTickets, type QueueTicket } from './benchQueue.ts';

/** The holders the report lists by name; a big shared group is a count past these. */
export const BENCH_STATE_MAX_RUNNING = 6;

/** bench_queue.py MAX_HOLD_MIN, for a ticket from before info.json carried max_min. */
const DEFAULT_MAX_MIN = { exclusive: 60, shared: 120 } as const;

/** bench_queue.py PRIORITIES: the queue sorts by these first (w1628). */
const PRIORITIES = ['urgent', 'high', 'normal', 'low'];

const readJson = (f: string): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return undefined;
  }
};

/** Each worker session's priority from priorities.json, which the daemon writes (machine/benchLock.ts writeBenchPriorities). */
function priorities(qdir: string): Record<string, string> {
  const sessions = (readJson(path.join(qdir, 'priorities.json'))?.sessions ?? {}) as Record<string, { priority?: string }>;
  return Object.fromEntries(Object.entries(sessions).map(([k, v]) => [k, String(v?.priority ?? '')]));
}

const num = (ticket: string) => Number(ticket.slice(1)) || 0;

/** The queue's own order (bench_queue.py order_key): priority, then its place (`pos`, a shared group's), then its number. */
function orderKey(t: QueueTicket, qdir: string, prios: Record<string, string>): [number, number, number] {
  const p = PRIORITIES.indexOf(prios[t.session ?? ''] ?? '');
  const pos = readJson(path.join(qdir, t.ticket, 'info.json'))?.pos;
  return [p < 0 ? PRIORITIES.indexOf('normal') : p, typeof pos === 'number' ? pos : num(t.ticket), num(t.ticket)];
}

const cmp = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function glance(t: QueueTicket): BenchTicketGlance {
  const since = t.granted ? t.granted.ts * 1000 : t.created ? Date.parse(t.created) : NaN;
  const until = t.granted ? since + (t.maxMin ?? DEFAULT_MAX_MIN[t.mode]) * 60_000 : NaN;
  return {
    ticket: t.ticket,
    mode: t.mode,
    what: t.what.slice(0, 120),
    ...(t.session ? { session: t.session } : {}),
    ...(t.requests?.length ? { requests: t.requests.slice(0, 4) } : {}),
    ...(t.host ? { host: t.host } : {}),
    ...(t.sandbox ? { sandbox: t.sandbox } : {}),
    ...(Number.isFinite(since) ? { since: new Date(since).toISOString() } : {}),
    ...(Number.isFinite(until) ? { until: new Date(until).toISOString() } : {}),
  };
}

/**
 * The bench queue's state under the worker root, or undefined without one. Revoked tickets count for nothing (their
 * holders are stopping); a granted exclusive one makes the mode exclusive, granted shared ones shared, and an old-style
 * lock (no ticket in its owner line, machine/benchLock.ts readBenchLock) exclusive too.
 */
export function readBenchState(root: string | undefined, now: number = Date.now(), alive: (pid: number) => boolean = pidAlive): BenchState | undefined {
  if (!root) return undefined;
  const lock = benchLockDir(root);
  const qdir = benchQueueDir(lock);
  const prios = priorities(qdir);
  const live = queueTickets(lock, alive).filter((t) => !t.revoked);
  const keys = new Map(live.map((t) => [t.ticket, orderKey(t, qdir, prios)]));
  const sorted = [...live].sort((a, b) => cmp(keys.get(a.ticket)!, keys.get(b.ticket)!));
  // Exclusive holders first: the one that sets the mode leads the list.
  const running = sorted.filter((t) => t.granted).sort((a, b) => (a.mode === b.mode ? 0 : a.mode === 'exclusive' ? -1 : 1));
  const waiting = sorted.filter((t) => !t.granted);
  const next = waiting.findIndex((t) => t.mode === 'exclusive');
  const old = readBenchLock(root, now, alive);
  const legacy = old && !/\[t\d{8}\]/.test(old.owner) ? { owner: old.owner, since: old.since } : undefined;
  const mode: BenchState['mode'] = legacy || running.some((t) => t.mode === 'exclusive') ? 'exclusive' : running.length ? 'shared' : 'free';
  return {
    mode,
    running: running.slice(0, BENCH_STATE_MAX_RUNNING).map(glance),
    runningCount: running.length,
    waiting: waiting.length,
    ...(next >= 0 ? { nextExclusive: { ...glance(waiting[next]), ahead: next } } : {}),
    ...(legacy ? { legacy } : {}),
  };
}
