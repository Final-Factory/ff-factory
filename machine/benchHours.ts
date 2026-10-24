// What a machine's exclusive bench tickets cost it, per UTC hour (w1996, shared/benchHours.ts), computed from the bench
// queue's own history: <FF_WORKER_ROOT>/tmp/bench.queue/history.jsonl (rotated to history.1.jsonl at 5 MB), one JSON
// line per event, written by the game repo's scripts/bench/bench_queue.py. Pure: lines in, rows out.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { BENCH_HOURS_MAX_REQUESTS, BENCH_HOURS_MAX_ROWS, HOUR_MS, hourStartIso, type BenchHourRow } from '../shared/benchHours.ts';
import { benchLockDir } from './benchLock.ts';
import { benchQueueDir } from './benchQueue.ts';

/** The events that end a ticket; keep, limit, limit-cancel, warn and legacy-free say nothing about who held what. */
const END_EVS = new Set(['release', 'gone', 'revoke', 'job-stopped', 'leave']);

interface Ticket {
  mode?: string;
  what: string;
  session: string;
  sandbox: string;
  requests: string[];
  take?: number;
  grant?: number;
  end?: number;
  waitedS?: number;
}

type Span = [number, number];

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/** The tickets of a history, by id, with the first take, grant and end seen (ms). A line that does not parse is skipped. */
function tickets(lines: Iterable<string>): Map<string, Ticket> {
  const evs: { ts: number; ev: string; d: Record<string, unknown> }[] = [];
  for (const line of lines) {
    if (!line || line.charCodeAt(0) !== 123) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const ev = d?.ev;
    const id = d?.ticket;
    if (typeof ev !== 'string' || typeof id !== 'string' || !id) continue;
    if (ev !== 'take' && ev !== 'grant' && !END_EVS.has(ev)) continue;
    const ts = typeof d.ts === 'number' ? d.ts * 1000 : Date.parse(str(d.at));
    if (!Number.isFinite(ts)) continue;
    evs.push({ ts, ev, d });
  }
  // two files read one after the other are in order already; sorting makes a rotated or merged pair safe (stable)
  evs.sort((a, b) => a.ts - b.ts);
  const out = new Map<string, Ticket>();
  for (const { ts, ev, d } of evs) {
    const id = String(d.ticket);
    let t = out.get(id);
    if (!t) out.set(id, (t = { what: '', session: '', sandbox: '', requests: [] }));
    if (!t.mode && (d.mode === 'shared' || d.mode === 'exclusive')) t.mode = d.mode;
    if (!t.what) t.what = str(d.what);
    if (!t.session) t.session = str(d.session);
    if (!t.sandbox) t.sandbox = str(d.sandbox);
    if (!t.requests.length && Array.isArray(d.requests)) t.requests = d.requests.filter((r): r is string => typeof r === 'string');
    if (ev === 'take') t.take ??= ts;
    else if (ev === 'grant') {
      t.grant ??= ts;
      if (typeof d.waited_s === 'number') t.waitedS ??= d.waited_s;
    } else t.end ??= ts;
  }
  return out;
}

/** The union of spans, in order and apart. */
function union(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const [s, e] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * The hours of [sinceMs, nowMs] in which a machine's bench queue had activity, oldest first (shared/benchHours.ts for the
 * fields). A ticket with a grant and no end is still held, counted up to nowMs; a hold is clipped to the window and split
 * across the UTC hours it spans. A sandbox is the ticket's `sandbox`, else its `what`.
 */
export function benchHours(lines: Iterable<string>, o: { sinceMs: number; nowMs: number }): BenchHourRow[] {
  const { sinceMs, nowMs } = o;
  if (!(nowMs > sinceMs)) return [];
  const all = [...tickets(lines).values()];
  // a ticket never seen to start is taken to have waited as long as its grant said (waited_s), else to have waited not at all
  const take = (t: Ticket) => t.take ?? (t.grant !== undefined ? t.grant - (t.waitedS ?? 0) * 1000 : undefined);
  const end = (t: Ticket) => t.end ?? nowMs;
  const box = (t: Ticket) => t.sandbox || t.what;

  const holds = all.filter((t) => t.mode === 'exclusive' && t.grant !== undefined);
  const shared = all.filter((t) => t.mode === 'shared' && take(t) !== undefined);

  const rows = new Map<number, { excl: number; holds: number; idle: number; wait: number; shared: number; byReq: Map<string, number> }>();
  const row = (h: number) => {
    let r = rows.get(h);
    if (!r) rows.set(h, (r = { excl: 0, holds: 0, idle: 0, wait: 0, shared: 0, byReq: new Map() }));
    return r;
  };
  /** Each hour [a, b) touches, with the part of it inside the span. */
  const perHour = (a: number, b: number, f: (hour: number, ms: number) => void) => {
    for (let h = Math.floor(a / HOUR_MS) * HOUR_MS; h < b; h += HOUR_MS) {
      const ms = overlap(a, b, h, h + HOUR_MS);
      if (ms > 0) f(h, ms);
    }
  };

  for (const t of holds) {
    const g = Math.max(t.grant!, sinceMs);
    const e = Math.min(end(t), nowMs);
    if (e <= g) continue;
    // sandboxes other than the holder's whose shared ticket was alive (taken to ended) at some point in the hold
    const others = new Set<string>();
    const req = t.requests.join(',') || '-';
    const waits: Span[] = [];
    for (const s of shared) {
      if (t.session && s.session === t.session) continue;
      const s0 = take(s)!;
      const s1 = end(s);
      if (s0 < e && s1 > g && box(s) && box(s) !== box(t)) others.add(box(s));
      // waiting is take to grant; a ticket that never got one waited until it ended
      const w1 = s.grant ?? s1;
      const ms = overlap(s0, w1, g, e);
      if (ms > 0) waits.push([Math.max(s0, g), Math.min(w1, e)]);
    }
    perHour(g, e, (h, ms) => {
      const r = row(h);
      r.excl += ms;
      r.holds += 1;
      r.idle += ms * others.size;
      r.byReq.set(req, (r.byReq.get(req) ?? 0) + ms);
    });
    for (const [a, b] of waits) perHour(a, b, (h, ms) => (row(h).wait += ms));
  }

  const granted: Span[] = [];
  for (const s of shared) {
    if (s.grant === undefined) continue;
    const a = Math.max(s.grant, sinceMs);
    const b = Math.min(end(s), nowMs);
    if (b > a) granted.push([a, b]);
  }
  for (const [a, b] of union(granted)) perHour(a, b, (h, ms) => (row(h).shared += ms));

  const sec = (ms: number) => Math.round(ms / 1000);
  const out: BenchHourRow[] = [];
  for (const h of [...rows.keys()].sort((a, b) => a - b)) {
    const r = rows.get(h)!;
    const byRequest: Record<string, number> = {};
    for (const [k, v] of [...r.byReq].sort((a, b) => b[1] - a[1])) byRequest[k] = sec(v);
    const row: BenchHourRow = { hour: hourStartIso(h), exclusiveS: sec(r.excl), holds: r.holds, idleSlotS: sec(r.idle), sharedWaitS: sec(r.wait), sharedS: sec(r.shared), byRequest };
    if (row.exclusiveS || row.holds || row.idleSlotS || row.sharedWaitS || row.sharedS) out.push(row);
  }
  return out;
}

/** The rows the daemon sends: the newest BENCH_HOURS_MAX_ROWS, each with its BENCH_HOURS_MAX_REQUESTS biggest requests. */
export function capBenchRows(rows: BenchHourRow[]): BenchHourRow[] {
  return rows.slice(-BENCH_HOURS_MAX_ROWS).map((r) => ({
    ...r,
    byRequest: Object.fromEntries(Object.entries(r.byRequest).sort((a, b) => b[1] - a[1]).slice(0, BENCH_HOURS_MAX_REQUESTS)),
  }));
}

/** The history files of a worker root, the rotated one first. */
export function benchHistoryFiles(root: string): string[] {
  const dir = benchQueueDir(benchLockDir(root));
  return [path.join(dir, 'history.1.jsonl'), path.join(dir, 'history.jsonl')];
}

/**
 * The last 72 hours (whole hours: the first one is not cut, so a later report never replaces a complete hour with a part
 * of one) of a root's bench history, or undefined when there is no history. Streams each file; keeps only the lines that
 * name a ticket's take, grant or end.
 */
export async function readBenchHours(root: string | undefined, nowMs = Date.now()): Promise<BenchHourRow[] | undefined> {
  if (!root) return undefined;
  const kept: string[] = [];
  let found = false;
  for (const file of benchHistoryFiles(root)) {
    let input: fs.ReadStream;
    try {
      if (!fs.statSync(file).isFile()) continue;
      input = fs.createReadStream(file, { encoding: 'utf8' });
    } catch {
      continue; // not there (a machine that never queued, or no rotation yet)
    }
    found = true;
    try {
      for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
        if (/"ev": ?"(?:take|grant|release|gone|revoke|job-stopped|leave)"/.test(line)) kept.push(line);
      }
    } catch {
      // a file that vanished or broke mid-read: what was read stands
    }
  }
  if (!found) return undefined;
  const sinceMs = Math.floor((nowMs - BENCH_HOURS_MAX_ROWS * HOUR_MS) / HOUR_MS) * HOUR_MS;
  return capBenchRows(benchHours(kept, { sinceMs, nowMs }));
}
