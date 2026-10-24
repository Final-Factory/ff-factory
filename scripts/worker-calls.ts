// How many model calls worker sessions make, and on what (w1478: "why are there 200 calls at all?"). Reads the CLI's own
// transcripts on THIS computer (~/.claude/projects/<project>/<session>.jsonl, the same route as spend-claude.ts), main
// thread only: one model call is one assistant message id, its context the input + cache read + cache write tokens.
// The before/after of w1478's cuts (docs/spend.md, "Model calls per session"): run it on sessions that started before
// a deploy and on sessions that started after it, on the same machine, and compare the lines it prints.
//
//   node scripts/worker-calls.ts [--root <projects dir>] [--match <dir regex>] [--since <ISO time>] [--until <ISO time>]
//                                [--days 4] [--json <file>]
//
// --match picks the project folders (default: worker sandboxes, `sandboxes-slot`); --since/--until keep sessions whose
// first call is in that window; --days skips files not written for that many days.
//
// w2018: it also splits each session's list-price dollars by phase (research before the first edit, implementing, after the
// first push; the same rules as the portal's meter, shared/spend.ts nextPhase) and counts its pushes, overall and for the
// requests that cost most (the request a session's first message names). The method: docs/spend.md, "Where a worker
// session's money goes, by phase".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PHASES, PHASE_LABEL, listUsd, nextPhase, type Phase } from '../shared/spend.ts';

interface Args {
  root: string;
  match: RegExp;
  since?: number;
  until?: number;
  days: number;
  json?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { root: path.join(os.homedir(), '.claude', 'projects'), match: /sandboxes-slot/, days: 4 };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    if (argv[i] === '--root') (a.root = v), i++;
    else if (argv[i] === '--match') (a.match = new RegExp(v)), i++;
    else if (argv[i] === '--since') (a.since = Date.parse(v)), i++;
    else if (argv[i] === '--until') (a.until = Date.parse(v)), i++;
    else if (argv[i] === '--days') (a.days = Number(v)), i++;
    else if (argv[i] === '--json') (a.json = v), i++;
    else throw new Error(`unknown option ${argv[i]}`);
  }
  return a;
}

type Tool = { name: string; input: Record<string, unknown>; id: string };
interface Call {
  ctx: number;
  tools: Tool[];
  t: number;
  /** List-price dollars of the call (w2018). */
  usd: number;
}

const READ_SHELL = /^\s*(cd [^&;]+&&\s*)?(cat|head|tail|sed -n|grep|rg|ls|find|wc|git (log|show|diff|status|grep|blame|rev-parse|branch|ls-files)|jq|du|stat)\b/;
const CI_POLL = /gh (pr checks|run (view|watch|list))|gh pr view [^|]*(statusCheck|mergeable|headRefOid|state)/;
const WAIT = /\b(until|sleep \d|timeout \d+ bash -c)|while .*sleep/;

/** What a call's tool use is, coarse: the buckets docs/spend.md reports. */
export function kindOf(t: Tool): string {
  const cmd = typeof t.input.command === 'string' ? t.input.command : '';
  if (t.name === 'Bash' || t.name === 'PowerShell') {
    if (/\bff-pr\b/.test(cmd)) return 'pr';
    if (CI_POLL.test(cmd)) return 'ci-poll';
    if (WAIT.test(cmd)) return 'wait';
    if (/gh pr (create|merge)|git (push|merge|commit)\b/.test(cmd)) return 'pr';
    if (READ_SHELL.test(cmd)) return 'read';
    return 'shell';
  }
  if (['Read', 'Grep', 'Glob'].includes(t.name)) return 'read';
  if (['Edit', 'Write', 'NotebookEdit'].includes(t.name)) return 'edit';
  if (t.name.startsWith('mcp__UnityMCP__') || t.name === 'ReadMcpResourceTool' || t.name === 'mcp__machine__unity') return 'unity';
  if (t.name === 'Agent' || t.name === 'Task') return 'subagent';
  if (t.name === 'Monitor' || t.name === 'TaskOutput') return 'wait';
  if (t.name === 'mcp__machine__blocked_on') return 'pr';
  return 'other';
}

/**
 * The request a session's first message is about: the brief's "Request: w123", an [about w123] line or a work-request header,
 * else the first request id the brief names (a guess: a brief can cite another request first; spend_report's split is exact).
 */
const REQUEST_ID = /(?:\bRequest(?: id)?:?|\[about|\[work request\])\s+(w\d+)/;
/** The request id of a session's first message (see REQUEST_ID). */
export const requestOf = (text: string): string | undefined => (REQUEST_ID.exec(text) ?? /\b(w\d{2,5})\b/.exec(text))?.[1];

function readCalls(file: string): { calls: Call[]; turns: number; waitsUnder30: number; blockedSleeps: number; request?: string } {
  const calls = new Map<string, Call>();
  let request: string | undefined;
  const started = new Map<string, number>();
  let turns = 0;
  let waitsUnder30 = 0;
  let blockedSleeps = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.isSidechain) continue;
    const m = e.message ?? {};
    const t = Date.parse(e.timestamp ?? '');
    if (e.type === 'assistant' && m.id && m.model && !String(m.model).includes('synthetic')) {
      const u = m.usage ?? {};
      const c = calls.get(m.id) ?? { ctx: 0, tools: [], t, usd: 0 };
      c.ctx = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      c.usd = listUsd(m.model, { in: u.input_tokens ?? 0, out: u.output_tokens ?? 0, cr: u.cache_read_input_tokens ?? 0, cw: u.cache_creation_input_tokens ?? 0, cw5: u.cache_creation?.ephemeral_5m_input_tokens ?? 0 });
      for (const b of m.content ?? []) {
        if (b.type !== 'tool_use') continue;
        c.tools.push({ name: b.name, input: b.input ?? {}, id: b.id });
        const k = kindOf(c.tools[c.tools.length - 1]);
        if (k === 'wait' || k === 'ci-poll') started.set(b.id, t);
      }
      calls.set(m.id, c);
    } else if (e.type === 'user') {
      if (typeof m.content === 'string' && !e.isMeta && !m.content.startsWith('<')) turns++;
      if (request === undefined && !e.isMeta) {
        const text = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content : []).map((b: { text?: string }) => b.text ?? '').join('\n');
        request = requestOf(text) ?? (text ? '' : undefined);
      }
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type !== 'tool_result') continue;
        const t0 = started.get(b.tool_use_id);
        if (t0 !== undefined && t - t0 < 30_000) waitsUnder30++;
        const text = typeof b.content === 'string' ? b.content : '';
        if (text.startsWith('<tool_use_error>Blocked:') && /sleep/.test(text.slice(0, 60))) blockedSleeps++;
      }
    }
  }
  return { calls: [...calls.values()], turns, waitsUnder30, blockedSleeps, ...(request ? { request } : {}) };
}

function subagentCalls(dir: string): { calls: number; ctx: number } {
  const sub = path.join(dir, 'subagents');
  let calls = 0;
  let ctx = 0;
  if (!fs.existsSync(sub)) return { calls, ctx };
  for (const f of fs.readdirSync(sub).filter((n) => n.endsWith('.jsonl'))) {
    const seen = new Map<string, number>();
    for (const line of fs.readFileSync(path.join(sub, f), 'utf8').split('\n')) {
      if (!line.includes('"assistant"')) continue;
      try {
        const e = JSON.parse(line);
        const u = e.message?.usage;
        if (e.type === 'assistant' && e.message?.id && u) seen.set(e.message.id, (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0));
      } catch {}
    }
    calls += seen.size;
    for (const v of seen.values()) ctx += v;
  }
  return { calls, ctx };
}

export interface Summary {
  sessions: number;
  calls: number;
  callsPerSession: number;
  medianCallsPerSession: number;
  callsPerTurn: number;
  contextPerCall: number;
  multiToolShare: number;
  readRunsOf5PlusShare: number;
  waitsUnder30sShare: number;
  blockedSleeps: number;
  prsOpened: number;
  prCallsPerPr: number;
  subagentCalls: number;
  subagentContextPerCall: number;
  byKind: Record<string, number>;
  /** w2018: list-price dollars by phase, and pushes per session. */
  phases: PhaseSplit;
  /** w2018: the same for the requests that cost most (a session counts for the request its first message names). */
  byRequest: ({ id: string } & PhaseSplit)[];
}

export interface PhaseSplit {
  usd: Record<Phase, number>;
  sessions: number;
  pushes: number;
  pushesMedian: number;
  pushesP90: number;
}

/** A session's dollars by phase and its pushes (w2018): each call is charged to the phase it ran in, then its tools move the phase. */
export function sessionPhases(calls: readonly Pick<Call, 'usd' | 'tools'>[]): { usd: Record<Phase, number>; pushes: number } {
  const usd = Object.fromEntries(PHASES.map((p) => [p, 0])) as Record<Phase, number>;
  let phase: Phase = 'research';
  let pushes = 0;
  for (const c of calls) {
    usd[phase] += c.usd;
    for (const t of c.tools) {
      const n = nextPhase(phase, t.name, t.input);
      phase = n.phase;
      if (n.push) pushes++;
    }
  }
  return { usd, pushes };
}

function split(rows: readonly { usd: Record<Phase, number>; pushes: number }[]): PhaseSplit {
  const usd = Object.fromEntries(PHASES.map((p) => [p, Math.round(100 * rows.reduce((a, r) => a + r.usd[p], 0)) / 100])) as Record<Phase, number>;
  const ps = rows.map((r) => r.pushes).sort((a, b) => a - b);
  return { usd, sessions: rows.length, pushes: ps.reduce((a, b) => a + b, 0), pushesMedian: ps[Math.floor(ps.length / 2)] ?? 0, pushesP90: ps[Math.min(ps.length - 1, Math.floor(ps.length * 0.9))] ?? 0 };
}

/** "research before the first edit $120 (14%), ...; 148 sessions, 400 pushes (a session: median 3, p90 9)". */
export function phaseText(p: PhaseSplit): string {
  const sum = PHASES.reduce((a, x) => a + p.usd[x], 0);
  const parts = PHASES.map((x) => `${PHASE_LABEL[x]} $${p.usd[x].toFixed(0)} (${sum > 0 ? Math.round((100 * p.usd[x]) / sum) : 0}%)`);
  return `${parts.join(', ')}; ${p.sessions} sessions, ${p.pushes} pushes (a session: median ${p.pushesMedian}, p90 ${p.pushesP90})`;
}

export function summarize(a: Args): Summary {
  const cutoff = Date.now() - a.days * 86_400_000;
  let n = 0, ctx = 0, multi = 0, inRuns = 0, under30 = 0, blocked = 0, prs = 0, prCalls = 0, turns = 0, subCalls = 0, subCtx = 0;
  const per: number[] = [];
  const kinds = new Map<string, number>();
  const phased: { usd: Record<Phase, number>; pushes: number; request?: string }[] = [];
  for (const proj of fs.readdirSync(a.root).filter((d) => a.match.test(d))) {
    const dir = path.join(a.root, proj);
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
      const p = path.join(dir, f);
      if (fs.statSync(p).mtimeMs < cutoff) continue;
      const s = readCalls(p);
      if (s.calls.length < 5) continue;
      const first = s.calls[0].t;
      if ((a.since !== undefined && first < a.since) || (a.until !== undefined && first >= a.until)) continue;
      per.push(s.calls.length);
      phased.push({ ...sessionPhases(s.calls), ...(s.request ? { request: s.request } : {}) });
      n += s.calls.length;
      turns += s.turns;
      under30 += s.waitsUnder30;
      blocked += s.blockedSleeps;
      const sub = subagentCalls(path.join(dir, f.replace(/\.jsonl$/, '')));
      subCalls += sub.calls;
      subCtx += sub.ctx;
      let run = 0;
      for (const c of [...s.calls, { ctx: 0, tools: [], t: 0, usd: 0 }]) {
        ctx += c.ctx;
        if (c.tools.length > 1) multi++;
        const ks = c.tools.map(kindOf);
        const k = !ks.length ? 'text' : new Set(ks).size === 1 ? ks[0] : 'mixed';
        if (c.tools.length) kinds.set(k, (kinds.get(k) ?? 0) + 1);
        else if (c.t) kinds.set('text', (kinds.get('text') ?? 0) + 1);
        if (ks.includes('pr')) prCalls++;
        if (ks.includes('ci-poll')) prCalls++;
        prs += c.tools.filter((t) => /gh pr create|ff-pr push[^\n]*--title/.test(String(t.input.command ?? ''))).length;
        if (ks.length && ks.every((x) => x === 'read')) run++;
        else {
          if (run >= 5) inRuns += run;
          run = 0;
        }
      }
    }
  }
  per.sort((x, y) => x - y);
  const pct = (x: number) => Math.round((1000 * x) / Math.max(n, 1)) / 10;
  return {
    sessions: per.length,
    calls: n,
    callsPerSession: Math.round(n / Math.max(per.length, 1)),
    medianCallsPerSession: per[Math.floor(per.length / 2)] ?? 0,
    callsPerTurn: Math.round((10 * n) / Math.max(turns, 1)) / 10,
    contextPerCall: Math.round(ctx / Math.max(n, 1)),
    multiToolShare: pct(multi),
    readRunsOf5PlusShare: pct(inRuns),
    waitsUnder30sShare: pct(under30),
    blockedSleeps: blocked,
    prsOpened: prs,
    prCallsPerPr: Math.round((10 * prCalls) / Math.max(prs, 1)) / 10,
    subagentCalls: subCalls,
    subagentContextPerCall: Math.round(subCtx / Math.max(subCalls, 1)),
    byKind: Object.fromEntries([...kinds].sort((x, y) => y[1] - x[1]).map(([k, v]) => [k, pct(v)])),
    phases: split(phased),
    byRequest: [...phased.reduce((m, x) => (x.request ? m.set(x.request, [...(m.get(x.request) ?? []), x]) : m), new Map<string, typeof phased>())]
      .map(([id, rows]) => ({ id, ...split(rows) }))
      .sort((x, y) => PHASES.reduce((a, p) => a + y.usd[p] - x.usd[p], 0))
      .slice(0, 10),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const a = parseArgs(process.argv.slice(2));
  const s = summarize(a);
  const kinds = Object.entries(s.byKind).map(([k, v]) => `${k} ${v}%`).join(', ');
  process.stdout.write(
    [
      `sessions ${s.sessions}, main-thread calls ${s.calls}: ${s.callsPerSession} a session (median ${s.medianCallsPerSession}), ${s.callsPerTurn} a turn, ${Math.round(s.contextPerCall / 1000)}k context a call`,
      `calls with more than one tool ${s.multiToolShare}%; in runs of 5+ read-only calls ${s.readRunsOf5PlusShare}%; waits/polls back in under 30 s ${s.waitsUnder30sShare}%; refused sleeps ${s.blockedSleeps}`,
      `PRs opened ${s.prsOpened}, PR-routine calls a PR ${s.prCallsPerPr}; subagent calls ${s.subagentCalls} at ${Math.round(s.subagentContextPerCall / 1000)}k context`,
      `by kind (share of calls): ${kinds}`,
      `by phase (list price): ${phaseText(s.phases)}`,
      ...s.byRequest.map((r) => `- ${r.id}: ${phaseText(r)}`),
    ].join('\n') + '\n',
  );
  if (a.json) fs.writeFileSync(a.json, JSON.stringify(s, null, 1));
}
