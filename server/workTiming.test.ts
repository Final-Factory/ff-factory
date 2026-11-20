import { test } from 'node:test';
import assert from 'node:assert/strict';
import { datedLog, gapCauseOf, movedOffCut, sessionsOf, stillOpenCauseOf, pickFinished, sessionSpans, sweep, TAIL_MS, timeRequest, toolCauseOf, waitBreakdown, waitCauseOf, workTiming } from './workTiming.ts';
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

// w4927: the spans r341 (w4921) found with no cause, rebuilt from the ledger and the transcripts of w4698, w4285 and w4517.
const iso = (s: string) => `${s}:00.000Z`;
const evAt = (t: string, e: Record<string, unknown>) => ({ seq: seq++, t: iso(t), ...e }) as TranscriptEvent;
const done = (t: string, text: string) => evAt(t, { kind: 'result', ok: true, text, costUsd: 0, turns: 1, durationMs: 0 });
const ask = (t: string, text: string) => evAt(t, { kind: 'user', text, from: 'orchestrator' });
const H = 60 * MIN;
const ymdhm = (t: number) => new Date(t).toISOString().slice(0, 16);

test("log lines after silent days take their dates from the request's own timestamps", () => {
  const lines = [
    '11:24 filed by FF Factory for ben at low priority',
    '12:22 worker 22f57c94: w4698: still open: waiting on Ben to decide how ships at y 40 should treat the gate',
    '04:13 ben: note: Ben answered (2026-11-20): leave it',
    '04:15 closed as done: worker 22f57c94 said DONE: w4698',
  ];
  // the forward walk alone puts the 11-20 lines on 11-19
  assert.deepEqual(datedLog(lines, iso('2026-11-18T11:24')).map((l) => ymdhm(l.t)).slice(2), ['2026-11-19T04:13', '2026-11-19T04:15']);
  const anchors = ['2026-11-18T11:24', '2026-11-18T12:22', '2026-11-20T04:13', '2026-11-20T04:15'].map((s) => Date.parse(iso(s)));
  assert.deepEqual(datedLog(lines, iso('2026-11-18T11:24'), anchors).map((l) => ymdhm(l.t)), ['2026-11-18T11:24', '2026-11-18T12:22', '2026-11-20T04:13', '2026-11-20T04:15']);
  // an unpinned line between two pins days apart sits beside the nearer one: the widest gap is the silent one
  const two = datedLog(
    ['16:03 the orchestration worker: w4517: still open: offline', '04:17 ask_person to lothsahn let through', '06:11 lothsahn: note: move it'],
    iso('2026-11-17T07:30'),
    [iso('2026-11-18T16:03'), iso('2026-11-20T06:11')].map(Date.parse),
  );
  assert.deepEqual(two.map((l) => ymdhm(l.t)), ['2026-11-18T16:03', '2026-11-20T04:17', '2026-11-20T06:11']);
});

test('a still-open line names what the request waits for', () => {
  assert.equal(stillOpenCauseOf('waiting on Ben to decide how fleet ships at y 40 should treat the pillars'), 'person');
  assert.equal(stillOpenCauseOf('waiting on lothsahn to pick a layout'), 'person');
  assert.equal(stillOpenCauseOf('blocked on CI on #3889'), 'gap_ci');
  assert.equal(stillOpenCauseOf('LothLaptop is offline; its update waits on timer t-f5fd52b4'), 'blocked');
  assert.equal(stillOpenCauseOf('blocked on w4622 reporting'), 'blocked');
  assert.equal(stillOpenCauseOf('queued for capacity on m5'), 'queued');
  assert.equal(stillOpenCauseOf('a check-in at 05:00 reads the build'), 'checkin');
  assert.equal(stillOpenCauseOf('the second half of the panel is next'), undefined);
  assert.equal(gapCauseOf([], 'Done with w4284.\n\nw4285 (pick a name): still open: waiting on Ben to pick one of the three', 'w4285'), 'person');
  assert.equal(gapCauseOf([], 'w4285: still open: waiting on Ben to pick', 'w4284'), undefined, "another request's line is not this one's: w4284 keeps its own cause");
  assert.equal(gapCauseOf([{ name: 'mcp__machine__blocked_on', input: { request: 'w4274', prs: ['ci:Final-Factory/ffu#826'] } }], 'w4274: still open: blocked on CI on Final-Factory/ffu#826', 'w4298'), undefined);
  assert.equal(gapCauseOf([{ name: 'mcp__machine__blocked_on', input: { request: 'w4298', prs: ['Final-Factory/ffu#819'] } }], 'w4298: still open: blocked on PR Final-Factory/ffu#819 merging', 'w4298'), 'blocked');
  assert.equal(gapCauseOf([], 'all done', 'w4298'), 'idle', 'a turn that names no request is still this one');
});

test('w4698: a worker that ended on "still open: waiting on Ben" with no tool is waiting on a person, not idle', () => {
  const w = item('w4698', {
    createdAt: iso('2026-11-18T11:24'),
    updatedAt: iso('2026-11-20T04:15'),
    sessionIds: ['s1'],
    done: { s1: { at: iso('2026-11-20T04:15'), report: 'DONE: w4698' } },
    notes: [
      { at: iso('2026-11-18T12:22'), by: 'ben', text: "Already on Ben's Waiting tab. His answer will come on that card." },
      { at: iso('2026-11-20T04:13'), by: 'ben', text: "Ben's answer: leave it" },
    ],
    findings: [{ at: iso('2026-11-18T12:22'), by: 's1', text: 'Nothing left to release.\n\nw4698: still open: waiting on Ben to decide how ships should treat the pillars' }],
    log: [
      '11:24 filed by FF Factory for ben at low priority',
      '11:44 dispatcher: started worker s1 "w4698: ..." in m5/slot3',
      '12:22 worker s1: w4698: still open: waiting on Ben to decide how ships at y 40 should treat the pillars',
      "12:22 [needs you] sent to ben's orchestrator: w4698: still open: waiting on Ben to decide",
      "12:22 ben: note: Already on Ben's Waiting tab. (not in a turn of theirs)",
      "04:13 ben: note: Ben's answer (2026-11-20): leave it",
      '04:15 worker s1: w4698 is finished.',
      '04:15 closed as done: worker s1 said DONE: w4698',
    ],
  });
  const events = new Map([['s1', [
    ask('2026-11-18T11:44', 'w4698: fleet vs gate'),
    done('2026-11-18T12:22', 'w4698: still open: waiting on Ben to decide'),
    ask('2026-11-20T04:13', 'Ben answered: leave it'),
    done('2026-11-20T04:15', 'DONE: w4698'),
  ]]]);
  const r = timeRequest(w, events, 0)!;
  assert.equal(r.work.person, Date.parse(iso('2026-11-20T04:13')) - Date.parse(iso('2026-11-18T12:22')));
  assert.equal((r.work.idle ?? 0) + (r.work.tail ?? 0) + (r.work.none ?? 0), 0);
});

test("w4285: a shared worker's still-open line, a [needs you] and a stall keep a person wait across four silent days", () => {
  const w = item('w4285', {
    createdAt: iso('2026-11-15T04:30'),
    updatedAt: iso('2026-11-20T04:00'),
    sessionIds: ['ce5e021a'],
    done: { ce5e021a: { at: iso('2026-11-20T04:00'), report: 'DONE: w4285' } },
    notes: [{ at: iso('2026-11-20T03:47'), by: 'lothsahn', text: 'the second one' }],
    log: [
      '04:30 filed for lothsahn',
      '04:31 dispatcher: sent to worker ce5e021a "w4285: ..." in lothdesktop/slot2',
      "05:10 [needs you] sent to lothsahn's orchestrator: w4285: pick one of the three names",
      '11:42 stalled by the ledger cleanup: no worker turn for 3 h',
      '03:42 ask_person to lothsahn let through: which name?',
      '03:47 lothsahn: note: the second one',
      '03:47 dispatcher: sent to worker ce5e021a "w4285: ..."',
      '04:00 closed as done: worker ce5e021a said DONE: w4285',
    ],
  });
  const events = new Map([['ce5e021a', [
    ask('2026-11-15T04:31', 'w4285: name it'),
    evAt('2026-11-15T05:10', { kind: 'tool_use', toolUseId: 'p', name: 'mcp__machine__waiting_on_person', input: {} }),
    evAt('2026-11-15T05:10', { kind: 'tool_result', toolUseId: 'p', isError: false, text: '' }),
    done('2026-11-15T05:11', 'w4285: still open: waiting on Lothsahn to pick'),
    // its turns for w4284, the request it also held, end on w4285's line with no hand-off tool
    ask('2026-11-15T07:30', 'w4284: next leg'),
    done('2026-11-15T08:02', 'DONE: w4284\n\nw4285 (names): still open: waiting on Lothsahn to pick one'),
    ask('2026-11-20T03:47', 'Lothsahn answered w4285'),
    done('2026-11-20T04:00', 'DONE: w4285'),
  ]]]);
  const r = timeRequest(w, events, 0)!;
  const total = r.closed - r.start;
  assert.ok((r.work.person ?? 0) > total - 2 * H, `person ${(r.work.person ?? 0) / H} h of ${total / H} h`);
  assert.equal((r.work.idle ?? 0) + (r.work.tail ?? 0) + (r.work.stalled ?? 0) + (r.work.none ?? 0), 0);
});

test('w4517: an offline machine, a move and a queue between turns are blocked and queued, from the log and the reports', () => {
  const w = item('w4517', {
    createdAt: iso('2026-11-17T07:30'),
    updatedAt: iso('2026-11-20T06:14'),
    sessionIds: ['b451589a'],
    done: { b451589a: { at: iso('2026-11-20T06:14'), report: 'DONE: w4517' } },
    notes: [{ at: iso('2026-11-20T06:11'), by: 'lothsahn', text: 'move it somewhere else' }],
    findings: [
      { at: iso('2026-11-17T07:35'), by: 'b451589a', text: 'PR #994 is up.\n\nw4517: still open: LothLaptop is offline; its step waits for it to come back online' },
      { at: iso('2026-11-18T16:03'), by: 'ops-worker', text: 'LothLaptop is still offline.' },
    ],
    log: [
      '03:18 taken off worker b451589a: moved: it moves to m5',
      '03:19 dispatcher: blocked on lothlaptop coming back online',
      '04:31 unblocked: lothlaptop coming back online cleared',
      '06:05 dispatcher: queued for capacity on lothlaptop',
      '16:03 the orchestration worker: w4517: still open: LothLaptop is offline; the rollout waits until it is back online.',
      '06:11 lothsahn: note: move it somewhere else',
      '06:11 dispatcher: sent to worker b451589a "w4517: ..." in lothdesktop/slot2',
      '06:14 closed as done: worker b451589a said DONE: w4517',
    ],
  });
  const events = new Map([['b451589a', [
    ask('2026-11-17T07:31', 'w4517: roll it out'),
    done('2026-11-17T07:35', 'PR #994 is up.'),
    ask('2026-11-20T06:11', 'w4517: lothsahn says move it'),
    done('2026-11-20T06:14', 'DONE: w4517'),
  ]]]);
  const r = timeRequest(w, events, 0)!;
  const d = (a: string, b: string) => Date.parse(iso(b)) - Date.parse(iso(a));
  assert.equal(r.work.blocked, d('2026-11-17T07:35', '2026-11-18T03:18') + d('2026-11-18T03:19', '2026-11-18T04:31') + d('2026-11-18T16:03', '2026-11-20T06:11'));
  assert.equal(r.work.queued, MIN + d('2026-11-18T06:05', '2026-11-18T16:03'));
  // between the unblock and the queue nothing was pending: the worker's gap with no marker
  assert.equal(r.work.idle, d('2026-11-18T04:31', '2026-11-18T06:05'));
});

test('a turn opened without a user event closes the gap; a transcript that ends mid-turn is a stopped process, not uncovered', () => {
  const end = T0 + 600 * MIN;
  const a = sessionSpans([user(0, 'go'), result(10, 'still working'), ev(40, { kind: 'assistant', text: 'the background build finished' }), result(50)], T0, end);
  assert.deepEqual(sweep(a, T0, end), { think: 20 * MIN, idle: 30 * MIN + TAIL_MS, tail: 550 * MIN - TAIL_MS });
  const b = sessionSpans([user(0, 'go'), use(5, 'x', 'Read'), res(6, 'x')], T0, end);
  assert.deepEqual(sweep(b, T0, end), { think: 6 * MIN, preempt: TAIL_MS, tail: 594 * MIN - TAIL_MS });
});

test("w4712: a person's wait that names CI in what they decide is a person wait; a CI wait still is CI", () => {
  assert.equal(stillOpenCauseOf('waiting on lothsahn to decide whether to drop both CI savings, do only the main.yml push filter'), 'person');
  assert.equal(stillOpenCauseOf('waiting on CI on #1051'), 'gap_ci');
  assert.equal(stillOpenCauseOf('blocked on CI on Final-Factory/ff-factory#1051'), 'gap_ci');
  assert.equal(stillOpenCauseOf('the PR merges by itself on green'), 'gap_ci');
  assert.equal(stillOpenCauseOf('waiting on w4259 to report'), 'blocked');
});

test('w4423: a worker the request was moved off is read up to its move, so its turns are not filing-to-first-turn', async () => {
  const w = item('w1', {
    createdAt: at(0),
    updatedAt: at(300),
    sessionIds: ['s2'],
    movedOff: { s1: at(100) },
    done: { s2: { at: at(300), report: 'DONE: w1' } },
  });
  assert.deepEqual(sessionsOf(w), ['s1', 's2']);
  const s1 = [user(5, 'w1 go'), result(20, 'w1: still open: waiting on Ben to pick'), user(150, 'w9 other work'), result(160)];
  assert.deepEqual(movedOffCut(w, 's1', s1).map((e) => e.t), [at(5), at(20)]);
  const sessions = new Map<string, SessionInfo>();
  const text = await workTiming([w], sessions, async (id) => (id === 's1' ? s1 : id === 's2' ? [user(200, 'w1 resume'), result(300, 'DONE: w1')] : undefined), { rows: true });
  // the first turn is s1's at 5 min, not s2's at 200
  assert.match(text, /\| w1 \| [^|]+\| 5m /);
});

test('w4423/w4298: a last turn that waits on a person holds until the next worker, not TAIL_MS then tail', () => {
  const w = item('w1', {
    createdAt: at(0),
    updatedAt: at(600),
    sessionIds: ['s2'],
    movedOff: { s1: at(100) },
    done: { s2: { at: at(600), report: 'DONE: w1' } },
  });
  const s1 = [user(5, 'w1 go'), result(20, 'w1: still open: waiting on Ben to pick')];
  const s2 = [user(500, 'w1 resume'), result(600, 'DONE: w1')];
  const r = timeRequest(w, new Map([['s1', s1], ['s2', s2]]), 0)!;
  assert.equal(r.work.person, 480 * MIN);
  assert.equal((r.work.tail ?? 0) + (r.work.idle ?? 0) + (r.work.none ?? 0), 0);
  // an idle last turn still decays to tail after TAIL_MS
  const idle = sweep(sessionSpans([user(0, 'w1'), result(2)], T0, T0 + 600 * MIN), T0, T0 + 600 * MIN);
  assert.equal(idle.tail, 598 * MIN - TAIL_MS);
});

test('w4298: a later turn of a shared worker that hands off another request keeps this one\'s hold', () => {
  const evs = [
    user(0, 'w4298 go'),
    result(10, 'w4298: still open: blocked on PR Final-Factory/ffu#819 merging'),
    user(20, 'w4274 go'),
    result(30, 'w4274: still open: blocked on CI on Final-Factory/ffu#826'),
  ];
  const s = sweep(sessionSpans(evs, T0, T0 + 600 * MIN, 'w4298'), T0, T0 + 600 * MIN);
  assert.equal(s.tail ?? 0, 0);
  assert.equal(s.blocked, 590 * MIN - 10 * MIN);
  // the other request itself still reads its own CI wait
  const o = sweep(sessionSpans(evs, T0, T0 + 600 * MIN, 'w4274'), T0, T0 + 600 * MIN);
  assert.equal(o.gap_ci, TAIL_MS);
});
