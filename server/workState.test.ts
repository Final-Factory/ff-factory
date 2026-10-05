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

test('workState: queued: not dispatched, queued for capacity, or a message held for a free slot', () => {
  assert.equal(one(item('w1', { status: 'new' }))?.why, 'waiting for the dispatcher to decide it');
  assert.equal(one(item('w2', { status: 'queued' }))?.why, 'the dispatcher queued it for capacity');
  const held = one(item('w3', { sessionIds: ['a'] }), [session('a', { status: 'stopped' })], [], { a: 'all 4 slots busy' });
  assert.deepEqual([held?.state, held?.why], ['queued', 'a message to a waits for a free agent slot (all 4 slots busy)']);
});

test('workState: merged, follow-up pending, with the cleanup\'s reason', () => {
  const pr = { repo: 'Final-Factory/FinalFactory', number: 1024, state: 'merged' as const, at: ago(4) };
  const w = item('w342', { sessionIds: ['a'], prs: [pr], log: ['01:50 PR #1024 merged; still open: its brief asks for a step after the merge (a check, an audit, a verification)'] });
  const f = one(w, [session('a')]);
  assert.deepEqual([f?.state, f?.why], ['followup', 'its brief asks for a step after the merge (a check, an audit, a verification)']);
  assert.match(one({ ...w, log: [] })!.why, /has not said yet/);
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
  const moved = workLiveAll([item('w15', { sessionIds: ['a'], createdAt: ago(10) }), item('w16', { sessionIds: ['a'], createdAt: ago(1) })], { session: () => session('a', { status: 'running' }), now: NOW });
  assert.equal(moved.get('w15')?.why, 'its worker a moved on to w16');
});

test('workState: counts per state', () => {
  const n = liveCounts([{ state: 'working', why: '' }, { state: 'stalled', why: '' }, { state: 'stalled', why: '' }]);
  assert.deepEqual(n, { working: 1, waiting: 0, queued: 0, followup: 0, stalled: 2 });
});
