/**
 * work_timing (w4531, docs/orchestrators.md "Where a request's wall time went"): where the wall time of the last N finished
 * requests went, in two parts. Part 1, the wait: from filing to the first worker turn on it, split by what the ledger log
 * said it waited for (capacity, a held machine, a pair, a usage hold, pre-emption, a gate, a person, else the dispatcher).
 * Part 2, the work: from that first turn to the close, split by what its workers' transcripts were doing at each moment
 * (a compile, an editor start, tests, a build, a bench ticket, a pair run, CI, a merge, a critic, a failed tool, a shell
 * wait, else implementation and thinking), and between turns by what the last turn ended on (blocked_on CI, a person, a
 * pair run, a check-in...). Several workers at once count once: each moment takes the busiest label any of them had.
 *
 * Pure apart from `readEvents`; the numbers are measured from the ledger and the transcripts, at their own resolution
 * (log lines to the minute, transcript events to the millisecond).
 */
import type { SessionInfo, TranscriptEvent, WorkItem } from '../shared/types.ts';

export const WAIT_CAUSES = ['dispatcher', 'capacity', 'held', 'pair', 'usage', 'preempt', 'gate', 'person'] as const;
export type WaitCause = (typeof WAIT_CAUSES)[number];

/** In-turn labels first (busiest first), then the between-turn ones; the order is the priority when workers overlap. */
export const WORK_CAUSES = [
  'failure', 'compile', 'editor', 'tests', 'build', 'bench', 'pair', 'ci', 'merge', 'review', 'wait', 'think',
  'gap_ci', 'gap_pair', 'gap_bench', 'gap_build', 'person', 'blocked', 'checkin', 'usage', 'preempt', 'idle', 'tail', 'none',
] as const;
export type WorkCause = (typeof WORK_CAUSES)[number];

export const WAIT_LABEL: Record<WaitCause, string> = {
  dispatcher: 'dispatcher decision (no other cause logged)',
  capacity: 'waiting for a sandbox, agent or editor slot',
  held: 'a machine held, offline, paused or full',
  pair: 'a pair run waiting for two computers',
  usage: 'a usage hold (Claude pool or token limit)',
  preempt: 'priority pre-emption or a paused worker',
  gate: 'blocked at filing (another request, PR or deploy first)',
  person: 'waiting on a person before any work',
};

export const WORK_LABEL: Record<WorkCause, string> = {
  failure: 'tool failures (calls that returned an error)',
  compile: 'Unity compiles and domain reloads (refresh_unity)',
  editor: 'editor start, restart and pinning',
  tests: 'local test runs',
  build: 'player and batch builds (unity-slot run, cargo build)',
  bench: 'bench tickets and timed legs',
  pair: 'pair and determinism runs (in turn)',
  ci: 'CI polled in turn (gh run watch, ff-pr status)',
  merge: 'merges and rebases (git merge, ff-pr push)',
  review: 'critic and review subagents',
  wait: 'other shell waits (until ... sleep)',
  think: 'implementation and agent thinking (model time, edits, reads, subagents)',
  gap_ci: 'between turns: CI wait (blocked_on ci:, merge_on_green)',
  gap_pair: 'between turns: pair run or hand-off report',
  gap_bench: 'between turns: bench or timed leg',
  gap_build: 'between turns: build or import check-in',
  person: 'between turns: waiting on a person',
  blocked: 'between turns: blocked on another request, PR or deploy',
  checkin: 'between turns: other check-ins (wake_me)',
  usage: 'between turns: usage limit stop',
  preempt: 'between turns: paused, pre-empted or interrupted',
  idle: 'between turns: no marker (hand-off to the orchestrator or dispatcher)',
  tail: 'after a worker\'s last turn, past TAIL_MS, until the close was recorded',
  none: 'no worker transcript covers it (before or after the workers)',
};

const PRI = new Map<WorkCause, number>(WORK_CAUSES.map((c, i) => [c, WORK_CAUSES.length - i]));

const MIN = 60_000;
/** An open turn with no event for this long is a process that stopped, not a long thought. */
const STOPPED_MS = 45 * MIN;
/**
 * w4531: the gap after a worker's last turn keeps that turn's hand-off label (CI, a person...) for at most this long; the
 * rest is `tail`. w4277 and w4296's worker ended on blocked_on CI at ffu #824, merged 2026-11-15 11:52Z, and their DONE
 * was recorded 46 h later: that was not CI (ffu's PR CI took 17.6 min median, measured 2026-11-17).
 */
export const TAIL_MS = 2 * 60 * MIN;

/** A ledger log line ("HH:MM text") with its date put back, walking forward from the filing day. */
export function datedLog(lines: readonly string[], createdAt: string): { t: number; text: string }[] {
  const filed = Date.parse(createdAt);
  let day = Date.UTC(new Date(filed).getUTCFullYear(), new Date(filed).getUTCMonth(), new Date(filed).getUTCDate());
  let prev = -1;
  const out: { t: number; text: string }[] = [];
  for (const line of lines) {
    const m = /^(\d\d):(\d\d) (.*)$/s.exec(line);
    if (!m) continue;
    const mins = Number(m[1]) * 60 + Number(m[2]);
    if (prev >= 0 && mins < prev) day += 86_400_000;
    prev = mins;
    out.push({ t: day + mins * MIN, text: m[3] });
  }
  // The log keeps its last 40 lines: when the first kept one reads earlier than the filing, it came days later.
  return out;
}

/** What a ledger log line says the request waits for, if anything (first match wins). */
export function waitCauseOf(text: string): WaitCause | 'start' | undefined {
  if (/started worker|sent to worker|resumed worker|: started .* in [a-z0-9-]+\/slot/i.test(text)) return 'start';
  if (/usage (limit|hold)|weekly (limit|stop)|stop line|5-hour|rate.?limit|pool (is )?(full|out)|out of (usage|tokens)/i.test(text)) return 'usage';
  if (/\bpair\b|two (computers|machines)|both legs/i.test(text)) return 'pair';
  if (/\bis held\b|but is held|crash hold|\bheld\b \(|offline|asleep|machine .*paused|paused machine|is busy|disk (is )?low/i.test(text)) return 'held';
  if (/queued for capacity|no computer with room|no free sandbox|no room|capacity|editor (limit|slot)|launches wait|agent slot/i.test(text)) return 'capacity';
  if (/pre-?empt|wrap(ped)? (it )?up|set aside|: paused:|outranked|higher priority/i.test(text)) return 'preempt';
  if (/blocked on|waits? (for|on) (pr|w\d|the merge|a deploy|deploy)|after w\d+ /i.test(text)) return 'gate';
  if (/\bquestion\b|waiting on input|needs you|approval|ask_person/i.test(text)) return 'person';
  return undefined;
}

const idWord = (id: string) => new RegExp(`\\b${id}\\b`, 'i');

/** When a worker first took it: the first message to one of its worker sessions that names it, else the log's start line. */
export function firstStartOf(w: WorkItem, events: ReadonlyMap<string, readonly TranscriptEvent[]>): number | undefined {
  const filed = Date.parse(w.createdAt);
  const re = idWord(w.id);
  let first: number | undefined;
  for (const [, evs] of events) {
    for (const e of evs) {
      if (e.kind !== 'user') continue;
      const t = Date.parse(e.t);
      if (t < filed - MIN) continue;
      if (!re.test(e.text)) continue;
      if (first === undefined || t < first) first = t;
      break;
    }
  }
  if (first !== undefined) return first;
  const start = datedLog(w.log, w.createdAt).find((l) => waitCauseOf(l.text) === 'start');
  if (start) return start.t;
  const links = Object.values(w.links ?? {}).map((l) => Date.parse(l.at)).filter((t) => t >= filed - MIN);
  return links.length ? Math.min(...links) : undefined;
}

/** When it closed: its last DONE, else its final outcome, else its last update. */
export function closeOf(w: WorkItem): number {
  const dones = Object.values(w.done ?? {}).map((d) => Date.parse(d.at)).filter(Number.isFinite);
  if (dones.length) return Math.max(...dones);
  if (w.finalOutcome?.at) return Date.parse(w.finalOutcome.at);
  return Date.parse(w.updatedAt);
}

/** Part 1: filing to first start, by what the log lines in between said. */
export function waitBreakdown(w: WorkItem, firstStart: number): Partial<Record<WaitCause, number>> {
  const filed = Date.parse(w.createdAt);
  const out: Partial<Record<WaitCause, number>> = {};
  const add = (c: WaitCause, ms: number) => {
    if (ms > 0) out[c] = (out[c] ?? 0) + ms;
  };
  const marks: { t: number; c: WaitCause }[] = [];
  for (const l of datedLog(w.log, w.createdAt)) {
    if (l.t < filed - MIN || l.t >= firstStart) continue;
    const c = waitCauseOf(l.text);
    if (c && c !== 'start') marks.push({ t: Math.max(l.t, filed), c });
  }
  if (w.queuedFor && Date.parse(w.queuedFor.at) < firstStart && Date.parse(w.queuedFor.at) >= filed) marks.push({ t: Date.parse(w.queuedFor.at), c: 'capacity' });
  marks.sort((a, b) => a.t - b.t);
  let cur: WaitCause = 'dispatcher';
  let t = filed;
  for (const m of marks) {
    add(cur, m.t - t);
    cur = m.c;
    t = m.t;
  }
  add(cur, firstStart - t);
  return out;
}

interface Span {
  from: number;
  to: number;
  cause: WorkCause;
}

const cmdOf = (input: unknown): string => {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  return typeof o.command === 'string' ? o.command : '';
};

/** What one tool call was doing. */
export function toolCauseOf(name: string, input: unknown, isError: boolean): WorkCause {
  if (isError) return 'failure';
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (name === 'Agent' || name === 'Task') return /critic|deep-thinker|code-analyst|review/i.test(String(o.subagent_type ?? '')) ? 'review' : 'think';
  if (/refresh_unity$/.test(name)) return 'compile';
  if (/(^|__)unity$|set_active_instance$/.test(name)) return 'editor';
  if (/run_tests$|get_test_job$/.test(name)) return 'tests';
  if (/request_pair$|message_pair$/.test(name)) return 'pair';
  if (/timed_run$|timed_place$/.test(name)) return 'bench';
  if (name !== 'Bash' && name !== 'PowerShell') return 'think';
  const c = cmdOf(input);
  if (/bench_queue|--timed\b/.test(c)) return 'bench';
  if (/determinism|_audit\.sh|crosscheck|crosscompare|hashcheck/.test(c)) return 'pair';
  if (/unity-slot run/.test(c)) return /runTests|-testPlatform|\btests?\b/i.test(c) ? 'tests' : 'build';
  if (/unity-bridge\.py\b.*\b(refresh|compile)/.test(c)) return 'compile';
  if (/\b(npm (run )?(test|prepush|typecheck)|node --test|cargo (test|nextest|clippy)|pytest|ffu-build-test|test_select|merge-gate-tests|playwright test|tsc -p)\b/.test(c)) return 'tests';
  if (/\bcargo build\b|BuildPlayer|build_player|-buildTarget|\bmsbuild\b|xcodebuild/.test(c)) return 'build';
  if (/gh run (watch|view)|gh pr checks|ff-pr (status|merge)/.test(c)) return 'ci';
  if (/\bgit (merge|rebase|pull)\b|ff-pr push/.test(c)) return 'merge';
  if (/\buntil\b[\s\S]*\bsleep\b|^\s*sleep \d/.test(c)) {
    // w4531: a loop waits on what it polls (w4529's pair leg: `until grep -q "^EXIT" "$TMPDIR/build.log"`, its player build)
    if (/build|pcache|\.app\b|\.exe\b/i.test(c)) return 'build';
    if (/ffnightly|relay|pair|lab\.lock|determinism/i.test(c)) return 'pair';
    if (/TestResults|test_job|test-results|\btests\b/i.test(c)) return 'tests';
    if (/gh (run|pr)\b/.test(c)) return 'ci';
    return 'wait';
  }
  return 'think';
}

/** What the gap after a turn waited on: the turn's last hand-off tool, else the result's words. */
export function gapCauseOf(turnTools: readonly { name: string; input: unknown }[], resultText: string): WorkCause {
  for (let i = turnTools.length - 1; i >= 0; i--) {
    const { name, input } = turnTools[i];
    const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    if (/blocked_on$/.test(name)) {
      const prs = Array.isArray(o.prs) ? o.prs.map(String) : [];
      if (prs.some((p) => p.startsWith('ci:')) || o.merge_on_green) return 'gap_ci';
      if (Array.isArray(o.reports) && o.reports.length) return 'gap_pair';
      return 'blocked';
    }
    if (/waiting_on_person$/.test(name)) return 'person';
    if (/request_pair$/.test(name)) return 'gap_pair';
    if (/timed_run$/.test(name)) return 'gap_bench';
    if (/wake_me$/.test(name)) {
      const note = String(o.note ?? '');
      if (/\bCI\b|checks|workflow|\bgh run\b/i.test(note)) return 'gap_ci';
      if (/bench|ticket|timed/i.test(note)) return 'gap_bench';
      if (/pair|\bleg\b/i.test(note)) return 'gap_pair';
      if (/build|import|compile|unity|player/i.test(note)) return 'gap_build';
      return 'checkin';
    }
  }
  if (/usage limit|rate limit|hit your limit|limit reached/i.test(resultText)) return 'usage';
  if (/: paused:|interrupted|pre-?empt/i.test(resultText)) return 'preempt';
  return 'idle';
}

/** The labelled spans of one session inside [from, to]. */
export function sessionSpans(events: readonly TranscriptEvent[], from: number, to: number): Span[] {
  const spans: Span[] = [];
  const push = (a: number, b: number, cause: WorkCause) => {
    const x = Math.max(a, from);
    const y = Math.min(b, to);
    if (y > x) spans.push({ from: x, to: y, cause });
  };
  const open = new Map<string, { t: number; name: string; input: unknown }>();
  let turnStart: number | undefined;
  let last = 0;
  let turnTools: { name: string; input: unknown }[] = [];
  let gapFrom: number | undefined;
  let gapCause: WorkCause = 'idle';
  const endTurn = (t: number, resultText: string) => {
    if (turnStart !== undefined) push(turnStart, t, 'think');
    gapFrom = t;
    gapCause = gapCauseOf(turnTools, resultText);
    turnStart = undefined;
    turnTools = [];
    open.clear();
  };
  for (const e of events) {
    const t = Date.parse(e.t);
    if (!Number.isFinite(t)) continue;
    // a turn whose process stopped without a result: it ended at its last event
    if (turnStart !== undefined && t - last > STOPPED_MS && open.size === 0) {
      endTurn(last, '');
      gapCause = 'preempt';
    }
    if (e.kind === 'user' && turnStart === undefined) {
      if (gapFrom !== undefined) push(gapFrom, t, gapCause);
      gapFrom = undefined;
      turnStart = t;
    } else if (e.kind === 'tool_use') {
      if (turnStart === undefined) turnStart = t;
      open.set(e.toolUseId, { t, name: e.name, input: e.input });
      if (!e.parentToolUseId) turnTools.push({ name: e.name, input: e.input });
    } else if (e.kind === 'tool_result') {
      const u = open.get(e.toolUseId);
      if (u) {
        push(u.t, t, toolCauseOf(u.name, u.input, e.isError));
        open.delete(e.toolUseId);
      }
    } else if (e.kind === 'result') {
      endTurn(t, e.text);
    }
    last = t;
  }
  if (turnStart !== undefined) push(turnStart, Math.min(last, to), 'think');
  else if (gapFrom !== undefined) {
    push(gapFrom, Math.min(to, gapFrom + TAIL_MS), gapCause);
    push(gapFrom + TAIL_MS, to, 'tail');
  }
  return spans;
}

/** Every moment of [from, to] once, under the busiest label any span has there; uncovered time is `none`. */
export function sweep(spans: readonly Span[], from: number, to: number): Partial<Record<WorkCause, number>> {
  const out: Partial<Record<WorkCause, number>> = {};
  const edges: { t: number; cause: WorkCause; d: 1 | -1 }[] = [];
  for (const s of spans) {
    edges.push({ t: s.from, cause: s.cause, d: 1 }, { t: s.to, cause: s.cause, d: -1 });
  }
  edges.sort((a, b) => a.t - b.t);
  const count = new Map<WorkCause, number>();
  const top = (): WorkCause => {
    let best: WorkCause = 'none';
    for (const [c, n] of count) if (n > 0 && PRI.get(c)! > PRI.get(best)!) best = c;
    return best;
  };
  let t = from;
  for (const e of edges) {
    const at = Math.min(Math.max(e.t, from), to);
    if (at > t) {
      const c = top();
      out[c] = (out[c] ?? 0) + (at - t);
      t = at;
    }
    count.set(e.cause, (count.get(e.cause) ?? 0) + e.d);
  }
  if (to > t) out.none = (out.none ?? 0) + (to - t);
  return out;
}

export interface RequestTiming {
  id: string;
  title: string;
  filed: number;
  start: number;
  closed: number;
  sessions: number;
  missing: number;
  wait: Partial<Record<WaitCause, number>>;
  work: Partial<Record<WorkCause, number>>;
}

export interface TimingArgs {
  last?: number;
  until?: string;
  rows?: boolean;
}

/** The finished (done) requests to measure: the newest `last` by close time, before `until`. */
export function pickFinished(items: readonly WorkItem[], a: TimingArgs): WorkItem[] {
  const until = a.until ? Date.parse(a.until) : Infinity;
  return items
    .filter((w) => w.status === 'done' && closeOf(w) < until)
    .sort((x, y) => closeOf(y) - closeOf(x))
    .slice(0, a.last ?? 50);
}

/** One request measured from its worker sessions' events. */
export function timeRequest(w: WorkItem, events: ReadonlyMap<string, readonly TranscriptEvent[]>, missing: number): RequestTiming | undefined {
  const start = firstStartOf(w, events);
  if (start === undefined) return undefined;
  const filed = Date.parse(w.createdAt);
  const closed = Math.max(closeOf(w), start);
  const spans = [...events.values()].flatMap((evs) => sessionSpans(evs, start, closed));
  return {
    id: w.id,
    title: w.title,
    filed,
    start: Math.max(start, filed),
    closed,
    sessions: events.size,
    missing,
    wait: start > filed ? waitBreakdown(w, start) : {},
    work: sweep(spans, start, closed),
  };
}

export const quantile = (xs: readonly number[], q: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] ?? s[0];
};

export const dur = (ms: number): string => {
  const m = Math.round(ms / MIN);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h${String(m % 60).padStart(2, '0')}` : `${(m / 1440).toFixed(1)}d`;
};

function causeTable<C extends string>(rows: readonly RequestTiming[], pick: (r: RequestTiming) => Partial<Record<C, number>>, causes: readonly C[], label: Record<C, string>): string[] {
  const total = rows.reduce((s, r) => s + Object.values<number>(pick(r) as Record<C, number>).reduce((a, b) => a + b, 0), 0);
  const lines = ['| cause | total | share | median | p90 | top requests |', '|---|---|---|---|---|---|'];
  const sums = causes.map((c) => ({ c, sum: rows.reduce((s, r) => s + (pick(r)[c] ?? 0), 0) })).filter((x) => x.sum > 0).sort((a, b) => b.sum - a.sum);
  for (const { c, sum } of sums) {
    const per = rows.map((r) => pick(r)[c] ?? 0);
    const top = [...rows].sort((a, b) => (pick(b)[c] ?? 0) - (pick(a)[c] ?? 0)).filter((r) => (pick(r)[c] ?? 0) > 0).slice(0, 4).map((r) => `${r.id} ${dur(pick(r)[c] ?? 0)}`);
    lines.push(`| ${label[c]} | ${dur(sum)} | ${total ? ((100 * sum) / total).toFixed(1) : '0'}% | ${dur(quantile(per, 0.5))} | ${dur(quantile(per, 0.9))} | ${top.join(', ')} |`);
  }
  return lines;
}

/** The answer: both parts' totals, median and p90, the causes by share, and (rows) one line per request. */
export function timingReport(rows: readonly RequestTiming[], skipped: readonly string[], a: TimingArgs): string {
  if (!rows.length) return `No finished request with a worker to measure${skipped.length ? ` (skipped: ${skipped.join(', ')})` : ''}.`;
  const waits = rows.map((r) => r.start - r.filed);
  const works = rows.map((r) => r.closed - r.start);
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const first = new Date(Math.min(...rows.map((r) => r.closed))).toISOString().slice(0, 16);
  const lastAt = new Date(Math.max(...rows.map((r) => r.closed))).toISOString().slice(0, 16);
  const out = [
    `# Wall time of the last ${rows.length} finished requests (closed ${first}Z to ${lastAt}Z), measured`,
    `Requests: ${rows.map((r) => r.id).join(', ')}.`,
    skipped.length ? `Skipped (no worker turn found): ${skipped.join(', ')}.` : '',
    rows.some((r) => r.missing) ? `Transcripts missing or too large for: ${rows.filter((r) => r.missing).map((r) => `${r.id} (${r.missing})`).join(', ')}; their time shows as "no worker transcript".` : '',
    '',
    `## Part 1: filing to the first worker turn`,
    `Total ${dur(sum(waits))}, mean ${dur(sum(waits) / rows.length)}, median ${dur(quantile(waits, 0.5))}, p90 ${dur(quantile(waits, 0.9))}, max ${dur(Math.max(...waits))}. Source: the ledger log lines between filing and the first turn (minute resolution; a log keeps its last 40 lines).`,
    ...causeTable(rows, (r) => r.wait, WAIT_CAUSES, WAIT_LABEL),
    '',
    `## Part 2: first worker turn to the close (last DONE)`,
    `Total ${dur(sum(works))}, mean ${dur(sum(works) / rows.length)}, median ${dur(quantile(works, 0.5))}, p90 ${dur(quantile(works, 0.9))}, max ${dur(Math.max(...works))}. Source: its worker sessions' transcript events; overlapping workers count once, under the busiest label.`,
    ...causeTable(rows, (r) => r.work, WORK_CAUSES, WORK_LABEL),
  ];
  if (a.rows) {
    out.push('', '## Per request', '| id | filed | wait | work | sessions | top work causes | title |', '|---|---|---|---|---|---|---|');
    for (const r of rows) {
      const top = (Object.entries(r.work) as [WorkCause, number][]).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([c, ms]) => `${c} ${dur(ms)}`);
      const wt = (Object.entries(r.wait) as [WaitCause, number][]).sort((x, y) => y[1] - x[1]).slice(0, 2).map(([c, ms]) => `${c} ${dur(ms)}`);
      out.push(`| ${r.id} | ${new Date(r.filed).toISOString().slice(5, 16).replace('T', ' ')} | ${dur(r.start - r.filed)}${wt.length ? ` (${wt.join(', ')})` : ''} | ${dur(r.closed - r.start)} | ${r.sessions} | ${top.join(', ')} | ${r.title.slice(0, 70).replace(/\|/g, '/')} |`);
    }
  }
  return out.filter((l, i, all) => l !== '' || all[i - 1] !== '').join('\n');
}

/** An event cut to what the measure reads, so fifty requests' transcripts fit in memory: no tool output, short texts. */
export function slimEvent(e: TranscriptEvent): TranscriptEvent {
  switch (e.kind) {
    case 'user':
      return { seq: e.seq, t: e.t, kind: 'user', from: e.from, text: e.text.slice(0, 4000) };
    case 'tool_use': {
      const o = (e.input && typeof e.input === 'object' ? e.input : {}) as Record<string, unknown>;
      const input: Record<string, unknown> = {};
      if (typeof o.command === 'string') input.command = o.command.slice(0, 600);
      for (const k of ['subagent_type', 'prs', 'reports', 'note'] as const) if (o[k] !== undefined) input[k] = o[k];
      if (o.merge_on_green) input.merge_on_green = true;
      return { seq: e.seq, t: e.t, kind: 'tool_use', toolUseId: e.toolUseId, name: e.name, input, parentToolUseId: e.parentToolUseId };
    }
    case 'tool_result':
      return { seq: e.seq, t: e.t, kind: 'tool_result', toolUseId: e.toolUseId, isError: e.isError, text: '' };
    case 'result':
      return { seq: e.seq, t: e.t, kind: 'result', ok: e.ok, text: e.text.slice(0, 2000), costUsd: e.costUsd, turns: e.turns, durationMs: e.durationMs };
    default:
      return e;
  }
}

/**
 * Measure the last finished requests. `readEvents` gives one session's events (undefined when it has none or it is too
 * large), and is called once per session.
 */
export async function workTiming(
  items: readonly WorkItem[],
  sessions: ReadonlyMap<string, SessionInfo>,
  readEvents: (sessionId: string) => Promise<readonly TranscriptEvent[] | undefined>,
  a: TimingArgs,
): Promise<string> {
  const cache = new Map<string, readonly TranscriptEvent[] | undefined>();
  const rows: RequestTiming[] = [];
  const skipped: string[] = [];
  for (const w of pickFinished(items, a)) {
    const events = new Map<string, readonly TranscriptEvent[]>();
    let missing = 0;
    for (const id of w.sessionIds) {
      const kind = sessions.get(id)?.kind;
      if (kind && kind !== 'worker') continue;
      if (!cache.has(id)) cache.set(id, await readEvents(id));
      const evs = cache.get(id);
      if (evs?.length) events.set(id, evs);
      else missing++;
    }
    const r = timeRequest(w, events, missing);
    if (r) rows.push(r);
    else skipped.push(w.id);
  }
  return timingReport(rows, skipped, a);
}
