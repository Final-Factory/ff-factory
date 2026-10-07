import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asksAPerson, liveCounts, servedBy, workLive, workLiveAll, type WorkLiveFacts } from '../shared/workState.ts';
import type { Requester, SessionInfo, WorkItem } from '../shared/types.ts';

const NOW = Date.parse('2026-10-05T06:00:00Z');
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const LOTH: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };

const item = (id: string, o: Partial<WorkItem> = {}): WorkItem => ({
  id,
  title: `Request ${id}`,
  brief: 'Do it.',
  priority: 'normal',
  keys: [],
  requestedBy: LOTH,
  requesters: [LOTH],
  humanAsked: true,
  status: 'active',
  createdAt: ago(48),
  updatedAt: ago(1),
  sessionIds: [],
  overlaps: [],
  asks: 0,
  log: [],
  ...o,
});
const session = (id: string, o: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  kind: 'worker',
  title: `worker ${id}`,
  status: 'idle',
  permissionMode: 'default',
  createdAt: ago(48),
  lastActivityAt: ago(2),
  turns: 3,
  costUsd: 1,
  pendingPermissions: [],
  ...o,
});
const facts = (items: WorkItem[], sessions: SessionInfo[], queued: Record<string, string> = {}): WorkLiveFacts => ({
  items,
  session: (id) => sessions.find((s) => s.id === id),
  queuedSend: (id) => queued[id],
  now: NOW,
});
const one = (w: WorkItem, sessions: SessionInfo[] = [], others: WorkItem[] = [], queued: Record<string, string> = {}) => workLive(w, facts([w, ...others], sessions, queued));

test('workState: working while a worker it serves is mid-turn (running, starting, in a long command), or FFBox runs it', () => {
  const w = item('w1', { sessionIds: ['a'] });
  assert.equal(one(w, [session('a', { status: 'running' })])?.state, 'working');
  assert.match(one(w, [session('a', { status: 'running', activeTool: { id: 't', name: 'Bash', since: ago(0.5) } })])!.why, /in Bash since 30 min ago/);
  assert.equal(one(w, [session('a', { status: 'starting' })])?.state, 'working');
  assert.equal(one(item('w2', { ffbox: { requestId: 'r', state: 'accepted', class: 'fenced', sentAt: ago(1), conversation: '812' } }))?.why, 'on FFBox (conversation 812)');
  assert.equal(one(item('w3', { status: 'stalled', stalled: { at: ago(1), kind: 'idle', reason: 'quiet 24 h' }, sessionIds: ['a'] }), [session('a', { status: 'running' })])?.state, 'working', 'a stalled request a worker picked up again is working');
  assert.equal(one(item('w4', { status: 'done', sessionIds: ['a'] }), [session('a', { status: 'running' })]), undefined, 'closed: no live state');
});

test('workState: a worker on several requests works on the one it was last sent, and those linked to it since', () => {
  // Before w418 nothing recorded the sends: the newer request stands in (w342 → w414, worker 49c5dc06).
  const w342 = item('w342', { sessionIds: ['49c5dc06'], createdAt: ago(30), prs: [{ repo: 'Final-Factory/FinalFactory', number: 1024, state: 'merged', at: ago(4) }] });
  const w414 = item('w414', { sessionIds: ['49c5dc06'], createdAt: ago(3) });
  const s = [session('49c5dc06', { status: 'running' })];
  assert.deepEqual([...servedBy('49c5dc06', [w342, w414])], ['w414']);
  const all = workLiveAll([w342, w414], { session: (id) => s.find((x) => x.id === id), now: NOW });
  assert.equal(all.get('w414')?.state, 'working');
  assert.notEqual(all.get('w342')?.state, 'working', 'w342 is not working any more');
  // Recorded sends win over creation times; a decide_work link after the last send shares the worker.
  const a = item('w10', { sessionIds: ['b'], createdAt: ago(5), links: { b: { at: ago(1), how: 'sent' } } });
  const b = item('w11', { sessionIds: ['b'], createdAt: ago(2), links: { b: { at: ago(4), how: 'sent' } } });
  const c = item('w12', { sessionIds: ['b'], createdAt: ago(0.5), links: { b: { at: ago(0.5), how: 'linked' } } });
  const old = item('w13', { sessionIds: ['b'], createdAt: ago(0.4), links: { b: { at: ago(3), how: 'linked' } } });
  assert.deepEqual([...servedBy('b', [a, b, c, old])].sort(), ['w10', 'w12']);
  // A closed request does not count.
  assert.deepEqual([...servedBy('b', [{ ...a, status: 'done' }, b])], ['w11']);
});

test('workState: waiting on input, and on whom', () => {
  const pending = one(item('w1', { status: 'new', approval: { state: 'pending' } }));
  assert.deepEqual([pending?.state, pending?.waitsOn], ['waiting', ['a reviewer']]);
  const q = one(item('w2', { status: 'question', requestedBy: BEN, requesters: [BEN, LOTH], question: { text: 'Which save?', at: ago(1) } }));
  assert.deepEqual([q?.state, q?.waitsOn, q?.why], ['waiting', ['Ben'], "the dispatcher's question: Which save?"]);
  assert.deepEqual(one(item('w3', { flag: { kind: 'design', text: 'Wider belts?', at: ago(1), for: [BEN] } }))?.waitsOn, ['Ben']);
  const perm = one(item('w4', { sessionIds: ['a'] }), [session('a', { status: 'waiting_permission', requestedBy: LOTH, pendingPermissions: [{ requestId: 'p', toolName: 'Bash', input: {}, createdAt: ago(0.1) }] })]);
  assert.deepEqual([perm?.state, perm?.why, perm?.waitsOn], ['waiting', 'a waits for permission to use Bash', ['Lothsahn']]);
  const asked = one(item('w5', { sessionIds: ['a'] }), [session('a', { lastResult: 'Two ways to do it. Needs your decision: A or B.' })]);
  assert.deepEqual([asked?.state, asked?.why], ['waiting', 'a stopped asking for a decision']);
  assert.equal(asksAPerson('Merged as #9. Should I also bump the version?'), true);
  assert.equal(asksAPerson('Done: merged as #9, nothing left.'), false);
});

test('w643: Queued is capacity only: queued for capacity, or a message held for a free slot; not dispatched yet is Working (the dispatcher has it)', () => {
  const fresh = one(item('w1', { status: 'new', updatedAt: ago(0.1) }));
  assert.deepEqual([fresh?.state, fresh?.why], ['working', 'the dispatcher has it to decide, since 6 min ago']);
  const q = one(item('w2', { status: 'queued' }));
  assert.deepEqual([q?.state, q?.why, q?.roomOn], ['queued', 'queued for capacity', undefined]);
  const held = one(item('w3', { sessionIds: ['a'] }), [session('a', { status: 'stopped' })], [], { a: 'all 4 slots busy' });
  assert.deepEqual([held?.state, held?.why], ['queued', 'a message to a waits for a free agent slot (all 4 slots busy)']);
  // The page has no send queue: the session's own copy says it (SessionInfo.queuedSend), and what holds it.
  const w4 = item('w4', { sessionIds: ['a'] });
  const own = workLive(w4, { items: [w4], session: () => session('a', { queuedSend: '4 agents mid-turn on lothdesktop' }), now: NOW });
  assert.equal(own?.state, 'queued');
});

test('w643: a machine with room: nothing is wrongly Queued; a request queued anyway is flagged with the computers that have room', () => {
  const w = item('w634', { status: 'queued', queuedFor: { at: ago(1) } });
  const full = workLive(w, { items: [w], session: () => undefined, room: [], now: NOW });
  assert.deepEqual([full?.state, full?.why, full?.roomOn], ['queued', 'queued for capacity: no computer that could take it has room', undefined], 'a real shortage: Queued, quietly');
  const room = workLive(w, { items: [w], session: () => undefined, room: ['lothdesktop'], now: NOW });
  assert.equal(room?.state, 'queued', 'the stored status stays; the line says it is wrong');
  assert.deepEqual(room?.roomOn, ['lothdesktop']);
  assert.match(room!.why, /but lothdesktop has room: the dispatcher should start it, or block it/);
  // It needs a computer that is busy: the room elsewhere does not count.
  const mac = { ...w, queuedFor: { at: ago(1), needs: ['m5'] } };
  assert.deepEqual(workLive(mac, { items: [mac], session: () => undefined, room: ['lothdesktop'], now: NOW })?.roomOn, undefined);
  assert.deepEqual(workLive(mac, { items: [mac], session: () => undefined, room: ['M5'], now: NOW })?.roomOn, ['M5']);
  // Nothing else is ever Queued while there is room: every other open status reads another state.
  const others = workLiveAll(
    [item('a1', { status: 'new' }), item('a2', { status: 'blocked', blocked: { kind: 'deploy', what: 'the next portal deploy', at: ago(2), by: 'dispatcher' } }), item('a3', { status: 'question', question: { text: 'Which save?', at: ago(1) } }), item('a4'), item('a5', { status: 'new', approval: { state: 'pending' } })],
    { session: () => undefined, room: ['lothdesktop'], now: NOW },
  );
  assert.deepEqual([...others.values()].map((l) => l.state), ['working', 'blocked', 'waiting', 'stalled', 'waiting']);
});

test('w643: Blocked names its blocker, for every kind; a message held for its machine is Blocked on that machine', () => {
  const b = (blocked: WorkItem['blocked']) => one(item('w9', { status: 'blocked', blocked }));
  const at = ago(2);
  const cases: [WorkItem['blocked'], string][] = [
    [{ kind: 'request', ref: 'w633', what: "w633's timing table", at, by: 'dispatcher' }, 'w633 finishing'],
    [{ kind: 'request', ref: 'w633', on: 'report', what: "w633's timing table", at, by: 'dispatcher' }, 'w633 reporting'],
    [{ kind: 'deploy', what: 'the next portal deploy', at, by: 'dispatcher', sha: 'abc1234' }, 'a portal deploy'],
    [{ kind: 'deploy', ref: 'lothdesktop', what: 'the worker update', at, by: 'dispatcher' }, "lothdesktop's update"],
    [{ kind: 'machine', ref: 'm5', what: 'the M5 asleep', at, by: 'dispatcher' }, 'm5 coming back online'],
    [{ kind: 'usage', ref: 'ben@example.com', what: "Ben's weekly limit", at, by: 'dispatcher' }, "ben@example.com's usage limit"],
    [{ kind: 'lock', ref: 'lab.lock', holder: 'w633', what: 'the nightly lab', at, by: 'dispatcher' }, 'lab.lock (held by w633)'],
    [{ kind: 'time', until: '2026-10-05T09:30:00.000Z', what: 'after the nightly run', at, by: 'dispatcher' }, '09:30 UTC'],
    [{ kind: 'ci', ref: 'Final-Factory/ff-factory#205', what: "#205's CI", at, by: 'dispatcher' }, 'CI on Final-Factory/ff-factory#205'],
  ];
  for (const [blocked, name] of cases) {
    const l = b(blocked);
    assert.deepEqual([l?.state, l?.waitsOn], ['blocked', [name]], blocked!.kind);
    assert.match(l!.why, new RegExp(`^${blocked!.what.replace(/[()]/g, '.')} \\(since 2 h ago, set by dispatcher\\)$`));
  }
  const held = one(item('w3', { sessionIds: ['a'] }), [session('a', { status: 'stopped', machineId: 'lothdesktop', queuedSend: 'its daemon is outdated', queuedOn: 'machine' })]);
  assert.deepEqual([held?.state, held?.waitsOn], ['blocked', ['lothdesktop']]);
  // Its worker mid-turn on it wins: it is being worked.
  assert.equal(one(item('w9', { status: 'blocked', blocked: cases[0][0], sessionIds: ['a'] }), [session('a', { status: 'running' })])?.state, 'working');
});

test('workState: merged, follow-up pending, with the cleanup\'s reason', () => {
  const pr = { repo: 'Final-Factory/FinalFactory', number: 1024, state: 'merged' as const, at: ago(4) };
  const w = item('w342', { sessionIds: ['a'], prs: [pr], log: ['01:50 PR #1024 merged; still open: its brief asks for a step after the merge (a check, an audit, a verification)'] });
  const f = one(w, [session('a')]);
  assert.deepEqual([f?.state, f?.why], ['followup', 'its brief asks for a step after the merge (a check, an audit, a verification)']);
  assert.match(one({ ...w, log: [] })!.why, /has not said yet/);
  assert.match(one({ ...w, log: ['01:00 PR #1024 merged; still open: PR #1030 is open'] })!.why, /has not said yet/, 'a reason naming a PR as open is out of date once none is');
  assert.equal(one({ ...w, status: 'stalled', stalled: { at: ago(1), kind: 'unsure', reason: 'follow-up unconfirmed' } })?.why, 'unsure: follow-up unconfirmed', "the cleanup's stall wins over the follow-up");
  assert.equal(one({ ...w, prs: [pr, { ...pr, number: 1030, state: 'open' }] })?.state, 'stalled', 'an open PR is not a follow-up');
});

test('workState: stalled at once when nothing works on it and nothing waits on a person, with the reason', () => {
  const w10 = item('w10', { sessionIds: ['a'] });
  const s = one(w10, [session('a', { status: 'stopped', lastActivityAt: ago(80), lastResult: 'Pushed the fix.' })]);
  assert.deepEqual([s?.state, s?.why], ['stalled', 'a stopped 3 d ago, nothing waits on a person']);
  assert.match(one(w10, [session('a', { status: 'idle', lastActivityAt: ago(5) })])!.why, /a finished its turn 5 h ago/);
  assert.equal(one(item('w11'))?.why, 'no worker was ever started for it');
  assert.equal(one(item('w12', { sessionIds: ['gone'] }))?.why, 'its workers are gone');
  assert.equal(one(item('w13', { stalled: { at: ago(1), kind: 'cut-off', reason: 'a usage limit' }, status: 'stalled' }))?.why, 'cut-off: a usage limit');
  assert.equal(one(item('w14', { prs: [{ repo: 'r/r', number: 7, state: 'open' }] }))?.why, 'PR #7 is open and no worker is on it');
  assert.equal(one(item('w14', { sessionIds: ['a'], prs: [{ repo: 'r/r', number: 7, state: 'open' }] }), [session('a', { lastActivityAt: ago(1) })])?.why, 'a finished its turn 1 h ago; PR #7 is open, nothing waits on a person', 'its worker is on it, idle');
  const moved = workLiveAll([item('w15', { sessionIds: ['a'], createdAt: ago(10) }), item('w16', { sessionIds: ['a'], createdAt: ago(1) })], { session: () => session('a', { status: 'running' }), now: NOW });
  assert.equal(moved.get('w15')?.why, 'its worker a moved on to w16');
});

test('workState: counts per state', () => {
  const n = liveCounts([{ state: 'working', why: '' }, { state: 'stalled', why: '' }, { state: 'stalled', why: '' }]);
  assert.deepEqual(n, { working: 1, waiting: 0, queued: 0, blocked: 0, followup: 0, stalled: 2 });
});
