// spend_export (w2653, docs/spend.md "The export"): the spend record as CSV for an analyst worker, read-only, for any time
// range. Granted per request the way ledger reading is (WorkItem.spendRead, from its person's orchestrator). It names no
// account beyond what the record calls a session's person and carries no secret: no tokens, keys or account labels.
//
// Four views:
// - summary: the requests closed done in the range (count, sum, mean and median of the workers' own dollars and of the
//   coordinators'), and the sessions started in the range by role, model and effort (count, output tokens, dollars).
// - requests: each request closed in the range or active in it, with its whole-life cost split into the workers' own and the
//   coordinators' (SpendStore.splitOf: exact, no subtraction left to the reader), its status and when it was filed and closed.
// - sessions: each session active in the range with its role, machine, sandbox, model and effort (each recorded or inferred),
//   their changes, and its whole-life tokens and dollars.
// - turns: the live turn log (data/spend-turns, from w2653's deploy on) cut exactly to the range, grouped by request, session,
//   model, effort, role or day, or one row per turn.
import fs from 'node:fs';
import path from 'node:path';
import type { SpendStore, TurnLine } from './spend.ts';
import { isCoordinatorRole, type RequestSpend, type SessionSpend, type SpendRole } from '../shared/spend.ts';
import { sumTok, zeroTok, addTok, scaleTok, type Tok } from '../shared/spend.ts';

export const EXPORT_VIEWS = ['summary', 'requests', 'sessions', 'turns'] as const;
export type ExportView = (typeof EXPORT_VIEWS)[number];
export const EXPORT_GROUPS = ['request', 'session', 'model', 'effort', 'role', 'day', 'none'] as const;
export type ExportGroup = (typeof EXPORT_GROUPS)[number];
export const EXPORT_ROLES = ['worker', 'dispatcher', 'personal', 'ops', 'standing'] as const satisfies readonly SpendRole[];

export interface ExportArgs {
  view?: ExportView;
  since?: string;
  until?: string;
  group_by?: ExportGroup;
  role?: SpendRole;
  offset?: number;
  limit?: number;
}

/** A page stops at this many characters, as read_work's does. */
export const EXPORT_MAX_CHARS = 40_000;
const DAY = 86_400_000;

/** The time a range bound names: an ISO time with a zone, or a UTC date. */
function parseBound(v: string | undefined, fallback: number, name: string): number {
  if (v === undefined || v === '') return fallback;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new Error(`${name} is not a time: "${v}" (an ISO time with a zone, e.g. 2026-10-24T07:20:00Z, or a date, 2026-10-24, read as UTC)`);
  if (/T\d/.test(v) && !/(Z|[+-]\d\d:?\d\d)$/i.test(v)) throw new Error(`${name} needs a zone: "${v}Z" for UTC`);
  return t;
}

const iso = (t: number) => new Date(t).toISOString();
const usd = (n: number) => (Math.round(n * 10_000) / 10_000).toString();
const int = (n: number) => Math.round(n).toString();
function csv(v: string | number | undefined): string {
  if (v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const row = (cells: (string | number | undefined)[]) => cells.map(csv).join(',');
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** The run a session is counted under: its first (what it was started on); `changes` says when it moved. */
export function firstRun(s: SessionSpend) {
  const r = s.runs?.[0];
  return { model: r?.model ?? 'unknown', effort: r?.effort ?? 'unknown', src: r?.src ?? 'inferred' };
}

/** The live turn log's lines in [since, until). */
export function readTurns(dir: string, since: number, until: number): TurnLine[] {
  const out: TurnLine[] = [];
  const from = new Date(since);
  let y = from.getUTCFullYear();
  let mo = from.getUTCMonth();
  for (;;) {
    const start = Date.UTC(y, mo, 1);
    if (start >= until) break;
    const file = path.join(dir, `${y}-${String(mo + 1).padStart(2, '0')}.jsonl`);
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      /* no turns that month */
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let t: TurnLine;
      try {
        t = JSON.parse(line) as TurnLine;
      } catch {
        continue; // a line cut short by a crash
      }
      const at = Date.parse(t.at);
      if (at >= since && at < until) out.push(t);
    }
    if (++mo === 12) [y, mo] = [y + 1, 0];
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** The first turn the log holds, for the header: before it, only the views that read spend.json reach. */
function logStart(dir: string): string | undefined {
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d\d\.jsonl$/.test(f)).sort();
  } catch {
    return undefined;
  }
  for (const f of files) {
    const first = fs.readFileSync(path.join(dir, f), 'utf8').split('\n', 1)[0];
    try {
      return (JSON.parse(first) as TurnLine).at;
    } catch {
      /* try the next month */
    }
  }
  return undefined;
}

/** A request's worker sessions' runs, "model/effort (recorded|inferred)", each once. */
function workerRuns(store: SpendStore, r: RequestSpend): { sessions: number; runs: string } {
  const seen = new Set<string>();
  let n = 0;
  for (const [sid, rs] of Object.entries(r.sessions)) {
    if (isCoordinatorRole(rs.role)) continue;
    n++;
    for (const run of store.sessions.get(sid)?.runs ?? []) seen.add(`${run.model ?? 'unknown'}/${run.effort ?? 'unknown'} (${run.src})`);
  }
  return { sessions: n, runs: [...seen].sort().join('; ') };
}

interface Page {
  head: string[];
  columns: string[];
  rows: string[];
}

function page(p: Page, offset: number, limit: number): string {
  const total = p.rows.length;
  const lines = [...p.head, row(p.columns)];
  let len = lines.reduce((a, l) => a + l.length + 1, 0);
  let i = offset;
  for (; i < total && i < offset + limit; i++) {
    const l = p.rows[i];
    if (len + l.length + 1 > EXPORT_MAX_CHARS && i > offset) break;
    lines.push(l);
    len += l.length + 1;
  }
  lines.push(i < total ? `# rows ${offset + 1}-${i} of ${total}; the next page: offset ${i}` : `# rows ${total ? offset + 1 : 0}-${i} of ${total}, the last page`);
  return lines.join('\n');
}

export function spendExport(store: SpendStore, a: ExportArgs, nowMs = Date.now()): string {
  const until = parseBound(a.until, nowMs, 'until');
  const since = parseBound(a.since, until - 7 * DAY, 'since');
  if (since >= until) throw new Error(`since (${iso(since)}) must come before until (${iso(until)})`);
  const view = a.view ?? 'summary';
  const offset = Math.max(0, Math.floor(a.offset ?? 0));
  const limit = Math.min(2000, Math.max(1, Math.floor(a.limit ?? 500)));
  const S = iso(since);
  const U = iso(until);
  const inRange = (t: string | undefined) => t !== undefined && t >= S && t < U;
  const head = [`# spend_export view=${view} since=${S} until=${U}${a.role ? ` role=${a.role}` : ''} (w2653, docs/spend.md "The export")`];
  const roleOk = (r: SpendRole) => !a.role || r === a.role;

  if (view === 'requests') {
    head.push(
      '# Requests closed in the range, or open and active in it. Dollars and tokens are over each request\'s whole life: worker_* is its workers\' own (SpendStore.splitOf), coord_usd its coordinators\'. status is the ledger\'s as last synced; closed_at is when the record first saw it closed.',
    );
    const rows: string[] = [];
    for (const r of [...store.requests.values()].sort((x, y) => (x.firstAt < y.firstAt ? -1 : 1))) {
      const active = !r.closedAt && r.lastAt >= S && r.firstAt < U;
      if (!inRange(r.closedAt) && !active) continue;
      const { workers, coordination } = store.splitOf(r);
      const w = workerRuns(store, r);
      rows.push(row([r.id, r.title, r.kind, r.status, r.person, r.filedAt, r.firstAt, r.lastAt, r.closedAt, usd(workers.usd), usd(coordination.usd), usd(r.total.usd), int(workers.in), int(workers.out), int(workers.cr), int(workers.cw), usd(r.estimated.usd), Math.round(r.turns * 100) / 100, w.sessions, w.runs]));
    }
    return page({ head, columns: ['id', 'title', 'kind', 'status', 'person', 'filed_at', 'first_at', 'last_at', 'closed_at', 'worker_usd', 'coord_usd', 'total_usd', 'worker_in', 'worker_out', 'worker_cache_read', 'worker_cache_write', 'estimated_usd', 'turns', 'worker_sessions', 'worker_runs'], rows }, offset, limit);
  }

  if (view === 'sessions') {
    head.push(
      '# Sessions active in the range. Tokens and dollars are over each session\'s whole life. model, effort and src are what it started on (src recorded: the process said so; inferred: a default or the model that billed most); runs lists every change.',
    );
    const rows: string[] = [];
    for (const s of [...store.sessions.values()].sort((x, y) => (x.firstAt < y.firstAt ? -1 : 1))) {
      if (!(s.firstAt < U && s.lastAt >= S) || !roleOk(s.role)) continue;
      const f = firstRun(s);
      const runs = (s.runs ?? []).map((r) => `${r.at} ${r.model ?? 'unknown'}/${r.effort ?? 'unknown'} ${r.src}`).join('; ');
      const reqs = Object.entries(s.requests)
        .sort((x, y) => y[1] - x[1])
        .map(([id, v]) => `${id}:${usd(v)}`)
        .join(';');
      rows.push(row([s.id, s.role, s.machine, s.sandbox, s.person, s.firstAt, s.lastAt, f.model, f.effort, f.src, Math.max(0, (s.runs?.length ?? 1) - 1), runs, s.turns, int(s.total.in), int(s.total.out), int(s.total.cr), int(s.total.cw), usd(s.total.usd), usd(s.estimated.usd), reqs]));
    }
    return page({ head, columns: ['session', 'role', 'machine', 'sandbox', 'person', 'first_at', 'last_at', 'model', 'effort', 'src', 'changes', 'runs', 'turns', 'in', 'out', 'cache_read', 'cache_write', 'usd', 'estimated_usd', 'requests_usd'], rows }, offset, limit);
  }

  if (view === 'turns') {
    const start = logStart(store.turnDir);
    head.push(`# The live turn log cut to the range: each turn whole, a request's share by its weight. The log starts ${start ?? '(empty)'}; turns before it are in the requests and sessions views only.`);
    const turns = readTurns(store.turnDir, since, until).filter((t) => roleOk(t.role));
    const g = a.group_by ?? 'request';
    if (g === 'none') {
      const rows = turns.map((t) => {
        const tot = sumTok(Object.values(t.models));
        return row([t.at, t.s, t.role, t.m, t.sb, t.model, t.effort, t.src, t.req.map(([id, w]) => `${id}:${Math.round(w * 1000) / 1000}`).join(';'), int(tot.in), int(tot.out), int(tot.cr), int(tot.cw), usd(tot.usd), t.est ? 1 : 0]);
      });
      return page({ head, columns: ['at', 'session', 'role', 'machine', 'sandbox', 'model', 'effort', 'src', 'requests', 'in', 'out', 'cache_read', 'cache_write', 'usd', 'estimated'], rows }, offset, limit);
    }
    const groups = new Map<string, { turns: number; tok: Tok; est: number; sessions: Set<string> }>();
    const put = (k: string, tok: Tok, f: number, sid: string, est: boolean) => {
      const e = groups.get(k) ?? { turns: 0, tok: zeroTok(), est: 0, sessions: new Set<string>() };
      e.turns += f;
      e.tok = addTok(e.tok, scaleTok(tok, f));
      if (est) e.est += tok.usd * f;
      e.sessions.add(sid);
      groups.set(k, e);
    };
    for (const t of turns) {
      const tok = sumTok(Object.values(t.models));
      if (g === 'request') for (const [id, w] of t.req.length ? t.req : [['(none)', 1] as [string, number]]) put(id, tok, w, t.s, !!t.est);
      else put(g === 'session' ? t.s : g === 'model' ? (t.model ?? 'unknown') : g === 'effort' ? `${t.effort ?? 'unknown'}` : g === 'role' ? t.role : t.at.slice(0, 10), tok, 1, t.s, !!t.est);
    }
    const rows = [...groups.entries()].sort((x, y) => y[1].tok.usd - x[1].tok.usd).map(([k, e]) => row([k, Math.round(e.turns * 100) / 100, e.sessions.size, int(e.tok.in), int(e.tok.out), int(e.tok.cr), int(e.tok.cw), usd(e.tok.usd), usd(e.est)]));
    return page({ head, columns: [g, 'turns', 'sessions', 'in', 'out', 'cache_read', 'cache_write', 'usd', 'estimated_usd'], rows }, offset, limit);
  }

  // summary
  head.push('# Requests closed done in the range: their whole-life cost, the workers\' own (splitOf) and the coordinators\'. Sessions started in the range by role, model and effort they started on: whole-life output tokens and dollars.');
  const lines = [...head, row(['section', 'kind', 'count', 'worker_usd_sum', 'worker_usd_mean', 'worker_usd_median', 'coord_usd_sum', 'total_usd_sum'])];
  const done = [...store.requests.values()].filter((r) => r.status === 'done' && inRange(r.closedAt));
  const byKind = new Map<string, RequestSpend[]>([['(all)', done]]);
  for (const r of done) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r]);
  for (const [k, rs] of byKind) {
    const w = rs.map((r) => store.splitOf(r));
    const wu = w.map((x) => x.workers.usd);
    lines.push(row(['done_requests', k, rs.length, usd(wu.reduce((x, y) => x + y, 0)), usd(mean(wu)), usd(median(wu)), usd(w.reduce((x, y) => x + y.coordination.usd, 0)), usd(rs.reduce((x, y) => x + y.total.usd, 0))]));
  }
  lines.push(row(['section', 'role', 'model', 'effort', 'count', 'recorded', 'inferred', 'out_sum', 'out_mean', 'out_median', 'usd_sum', 'usd_mean', 'usd_median']));
  const bySess = new Map<string, SessionSpend[]>();
  for (const s of store.sessions.values()) {
    if (!inRange(s.firstAt) || !roleOk(s.role)) continue;
    const f = firstRun(s);
    const k = `${s.role}\u0000${f.model}\u0000${f.effort}`;
    bySess.set(k, [...(bySess.get(k) ?? []), s]);
  }
  for (const [k, ss] of [...bySess.entries()].sort()) {
    const [role, model, effort] = k.split('\u0000');
    const outs = ss.map((s) => s.total.out);
    const us = ss.map((s) => s.total.usd);
    const rec = ss.filter((s) => firstRun(s).src === 'recorded').length;
    lines.push(row(['sessions', role, model, effort, ss.length, rec, ss.length - rec, int(outs.reduce((x, y) => x + y, 0)), int(mean(outs)), int(median(outs)), usd(us.reduce((x, y) => x + y, 0)), usd(mean(us)), usd(median(us))]));
  }
  return lines.join('\n');
}
