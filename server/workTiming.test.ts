import { test } from 'node:test';
import assert from 'node:assert/strict';
import { datedLog, gapCauseOf, pickFinished, sessionSpans, sweep, TAIL_MS, timeRequest, toolCauseOf, waitBreakdown, waitCauseOf, workTiming } from './workTiming.ts';
import type { Requester, SessionInfo, TranscriptEvent, WorkItem } from '../shared/types.ts';

/** work_timing (w4531, server/workTiming.ts): where a finished request's wall time went, in two parts. */

const LOTH: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };
const T0 = Date.parse('2026-11-16T22:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const MIN = 60_000;

function item(id: string, patch: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    title: `Request ${id}`,
    brief: `Do ${id}.`,
    priority: 'normal',
    keys: [],
    requestedBy: LOTH,
    requesters: [LOTH],
    humanAsked: true,
    status: 'done',
    createdAt: at(0),
    updatedAt: at(500),
    sessionIds: [],
    overlaps: [],
    asks: 0,
    log: [],
    ...patch,
  } as WorkItem;
}

let seq = 0;
const ev = (min: number, e: Record<string, unknown>) => ({ seq: seq++, t: at(min), ...e }) as TranscriptEvent;
const user = (min: number, text: string) => ev(min, { kind: 'user', text, from: 'orchestrator' });
const use = (min: number, id: string, name: string, input: unknown = {}) => ev(min, { kind: 'tool_use', toolUseId: id, name, input });
const res = (min: number, id: string, isError = false) => ev(min, { kind: 'tool_result', toolUseId: id, isError, text: '' });
const result = (min: number, text = 'ok') => ev(min, { kind: 'result', ok: true, text, costUsd: 0, turns: 1, durationMs: 0 });

test('log lines get their dates back across midnight', () => {
  const d = datedLog(['22:00 filed by lothsahn', '23:50 queued for capacity', '00:10 dispatcher: started worker ab in m3/slot1'], at(0));
  assert.deepEqual(d.map((l) => l.t - T0), [0, 110 * MIN, 130 * MIN]);
});

test('what a log line says a request waits for', () => {
  assert.equal(waitCauseOf('dispatcher: started worker cc13 "x" in biscuit/slot1'), 'start');
  assert.equal(waitCauseOf('dispatcher: a leg queued for capacity on beast; beast has room but is held (Ben: crash hold)'), 'held');
  assert.equal(waitCauseOf('ledger: no capacity ping: no computer with room can take w2895 now'), 'capacity');
  assert.equal(waitCauseOf('queued: vault-ben-2 is at its 95% weekly stop line'), 'usage');
  assert.equal(waitCauseOf('pair run waits for two computers'), 'pair');
  assert.equal(waitCauseOf('note: nothing here'), undefined);
});

test('part 1 splits filing to first start by the log lines between', () => {
  const w = item('w1', { log: ['22:00 filed by lothsahn', '22:05 dispatcher: queued for capacity on m3', '22:40 m3 is offline', '23:00 dispatcher: started worker a in m3/slot1'] });
  const b = waitBreakdown(w, T0 + 60 * MIN);
  assert.deepEqual(b, { dispatcher: 5 * MIN, capacity: 35 * MIN, held: 20 * MIN });
});

test('tool calls are labelled by what they do', () => {
  assert.equal(toolCauseOf('mcp__UnityMCP__refresh_unity', {}, false), 'compile');
  assert.equal(toolCauseOf('mcp__machine__unity', { action: 'start' }, false), 'editor');
  assert.equal(toolCauseOf('mcp__UnityMCP__get_test_job', {}, false), 'tests');
  assert.equal(toolCauseOf('Bash', { command: 'unity-slot run --label build -- unity -buildTarget Linux64' }, false), 'build');
  assert.equal(toolCauseOf('Bash', { command: 'npm run prepush' }, false), 'tests');
  assert.equal(toolCauseOf('Bash', { command: 'git fetch origin && git merge origin/master' }, false), 'merge');
  assert.equal(toolCauseOf('Bash', { command: 'gh run watch 123' }, false), 'ci');
  assert.equal(toolCauseOf('Bash', { command: 'python scripts/bench/bench_queue.py timed --what x' }, false), 'bench');
  assert.equal(toolCauseOf('Bash', { command: 'until test -f x; do sleep 20; done' }, false), 'wait');
  assert.equal(toolCauseOf('Agent', { subagent_type: 'ff-agents:ui-critic' }, false), 'review');
  assert.equal(toolCauseOf('Read', {}, false), 'think');
  assert.equal(toolCauseOf('Bash', { command: 'ls' }, true), 'failure');
});

test('a gap after a turn takes what the turn handed off to', () => {
  assert.equal(gapCauseOf([{ name: 'mcp__machine__blocked_on', input: { prs: ['ci:Final-Factory/ff-factory#1'] } }], ''), 'gap_ci');
  assert.equal(gapCauseOf([{ name: 'mcp__machine__blocked_on', input: { prs: ['Final-Factory/x#2'] } }], ''), 'blocked');
  assert.equal(gapCauseOf([{ name: 'mcp__machine__waiting_on_person', input: {} }], ''), 'person');
  assert.equal(gapCauseOf([{ name: 'mcp__machine__wake_me', input: { note: 'check the player build' } }], ''), 'gap_build');
  assert.equal(gapCauseOf([], 'w1: paused: for w2'), 'preempt');
  assert.equal(gapCauseOf([], 'done'), 'idle');
});

test('one session: tools inside the turn, the CI gap between turns', () => {
  const evs = [
    user(10, 'w1: do it'),
    use(11, 'a', 'mcp__UnityMCP__refresh_unity'),
    res(14, 'a'),
    use(15, 'b', 'mcp__machine__blocked_on', { prs: ['ci:o/r#1'] }),
    res(15, 'b'),
    result(16),
    user(40, 'CI finished green'),
    result(45),
  ];
  const out = sweep(sessionSpans(evs, T0 + 10 * MIN, T0 + 45 * MIN), T0 + 10 * MIN, T0 + 45 * MIN);
  assert.deepEqual(out, { think: 8 * MIN, compile: 3 * MIN, gap_ci: 24 * MIN });
});

test('two workers at once count once, under the busier label', () => {
  const a = sessionSpans([user(0, 'w1'), use(0, 'x', 'mcp__UnityMCP__run_tests'), res(10, 'x'), result(10)], T0, T0 + 20 * MIN);
  const b = sessionSpans([user(0, 'w1'), result(20)], T0, T0 + 20 * MIN);
  assert.deepEqual(sweep([...a, ...b], T0, T0 + 20 * MIN), { tests: 10 * MIN, think: 10 * MIN });
});

test('a turn whose process stopped ends at its last event', () => {
  const evs = [user(0, 'w1'), use(1, 'a', 'Read'), res(2, 'a'), user(120, 'resumed'), result(121)];
  const out = sweep(sessionSpans(evs, T0, T0 + 121 * MIN), T0, T0 + 121 * MIN);
  assert.equal(out.preempt, 118 * MIN);
});

test('first start is the first message naming the request; close is its last DONE', () => {
  const w = item('w7', { sessionIds: ['s1'], done: { s1: { at: at(90), report: 'DONE: w7' } } });
  const evs = new Map([['s1', [user(-30, 'w6: other work'), result(-20), user(30, 'w7: brief'), result(90)]]]);
  const r = timeRequest(w, evs, 0)!;
  assert.equal(r.start - r.filed, 30 * MIN);
  assert.equal(r.closed - r.start, 60 * MIN);
  assert.deepEqual(r.wait, { dispatcher: 30 * MIN });
});

test('pickFinished takes the newest done requests by close time, before until', () => {
  const items = [
    item('w1', { done: { s: { at: at(10), report: '' } } }),
    item('w2', { done: { s: { at: at(30), report: '' } } }),
    item('w3', { status: 'cancelled' }),
    item('w4', { done: { s: { at: at(20), report: '' } } }),
  ];
  assert.deepEqual(pickFinished(items, { last: 2 }).map((w) => w.id), ['w2', 'w4']);
  assert.deepEqual(pickFinished(items, { until: at(25) }).map((w) => w.id), ['w4', 'w1']);
});

test('the report gives both parts, skips a request with no worker, and reads each session once', async () => {
  const items = [
    item('w1', { sessionIds: ['s1', 'orch'], done: { s1: { at: at(60), report: '' } } }),
    item('w2', { sessionIds: ['s1'], createdAt: at(100), done: { s1: { at: at(200), report: '' } } }),
    item('w3', { done: { x: { at: at(5), report: '' } } }),
  ];
  const sessions = new Map<string, SessionInfo>([['orch', { id: 'orch', kind: 'orchestrator' } as SessionInfo]]);
  const reads: string[] = [];
  const evs = [user(10, 'w1 go'), result(60), user(120, 'w2 go'), result(200)];
  const text = await workTiming(items, sessions, async (id) => (reads.push(id), id === 's1' ? evs : undefined), { rows: true });
  assert.deepEqual(reads, ['s1']);
  assert.match(text, /Part 1: filing to the first worker turn/);
  assert.match(text, /Part 2: first worker turn to the close/);
  assert.match(text, /Skipped \(no worker turn found\): w3/);
  assert.match(text, /\| w2 \|/);
});

test('a shell wait loop takes what it polls; the gap after the last turn keeps its label for TAIL_MS only', () => {
  assert.equal(toolCauseOf('Bash', { command: 'until grep -q "^EXIT" "$TMPDIR/build.log"; do sleep 20; done' }, false), 'build');
  assert.equal(toolCauseOf('Bash', { command: 'until test -f "$OUT/ffnightly.done"; do sleep 20; done' }, false), 'pair');
  assert.equal(toolCauseOf('Bash', { command: 'until test -s x.txt; do sleep 20; done' }, false), 'wait');
  const evs = [user(0, 'w1'), use(1, 'a', 'mcp__machine__blocked_on', { prs: ['ci:o/r#1'] }), res(1, 'a'), result(2)];
  const out = sweep(sessionSpans(evs, T0, T0 + 600 * MIN), T0, T0 + 600 * MIN);
  assert.deepEqual(out, { think: 2 * MIN, gap_ci: TAIL_MS, tail: 598 * MIN - TAIL_MS });
});
