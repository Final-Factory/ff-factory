import test from 'node:test';
import assert from 'node:assert/strict';
import { fleetOf } from '../shared/fleet.ts';
import type { Machine, MachineSandbox, SessionInfo, SessionStatus, WorkItem } from '../shared/types.ts';
import {
  cardStatus,
  cardsSummary,
  filterCards,
  filterChoices,
  groupCounts,
  plainTitle,
  readFilter,
  readMode,
  shortAge,
  sortCards,
  toolName,
  workerCards,
  writeFilter,
  writeMode,
  type WorkerCard,
} from '../shared/workerCards.ts';

// The Overview's Workers mode (w1837): which workers get a card, what status each says, the board's order, its filters,
// and what the browser remembers.

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const ago = (m: number) => new Date(NOW - m * 60_000).toISOString();
const BEN = { userId: 'ben', displayName: 'Ben' };
const LOTH = { userId: 'lothsahn', displayName: 'Lothsahn' };

const session = (id: string, status: SessionStatus, where: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  kind: 'worker',
  title: id,
  status,
  permissionMode: 'bypassPermissions',
  createdAt: ago(120),
  lastActivityAt: ago(5),
  turns: 3,
  costUsd: 0,
  pendingPermissions: [],
  ...where,
});

const item = (id: string, status: WorkItem['status'], sessionIds: string[], extra: Partial<WorkItem> = {}): WorkItem => ({
  id,
  title: id,
  brief: '',
  priority: 'normal',
  keys: [],
  requestedBy: BEN,
  requesters: [BEN],
  humanAsked: true,
  status,
  createdAt: ago(600),
  updatedAt: ago(10),
  sessionIds,
  overlaps: [],
  asks: 0,
  log: [],
  ...extra,
});

const sandbox = (id: string, sessionIds: string[]): MachineSandbox => ({
  id,
  branch: `w-${id}`,
  base: 'origin/master',
  path: `V:/ffw/sandboxes/${id}`,
  purpose: id,
  status: 'ready',
  createdAt: ago(600),
  unity: { state: 'stopped' },
  sessionIds,
});

const machine = (id: string, name: string, sandboxes: MachineSandbox[]): Machine => ({
  id,
  name,
  host: id,
  purpose: 'unused',
  status: 'ready',
  online: true,
  repoPath: 'V:/ffw/repo',
  home: 'C:/Users/dev',
  portalUrl: 'https://portal.example',
  sessionIds: [],
  createdAt: ago(6000),
  sandboxes,
});

test('w1837: the title drops its request id, tool names drop their MCP server, and ages are a few characters', () => {
  assert.equal(plainTitle('w1837: Overview toggle: compact per-worker card view'), 'Overview toggle: compact per-worker card view');
  assert.equal(plainTitle('W12 - fix the belt'), 'fix the belt');
  assert.equal(plainTitle('Nightly on BEAST'), 'Nightly on BEAST');
  assert.equal(toolName('mcp__machine__read_work'), 'read_work');
  assert.equal(toolName('mcp__claude_ai_Gmail__search'), 'search');
  assert.equal(toolName('Bash'), 'Bash');
  assert.equal(shortAge(ago(0), NOW), 'now');
  assert.equal(shortAge(new Date(NOW - 45_000).toISOString(), NOW), '45s');
  assert.equal(shortAge(ago(12), NOW), '12m');
  assert.equal(shortAge(ago(190), NOW), '3h');
  assert.equal(shortAge(ago(60 * 50), NOW), '2d');
});

test('w1837: a card says Needs you for a permission, Working mid-turn with its tool, and who a person-wait is on', () => {
  const perm = cardStatus(session('a', 'waiting_permission', { pendingPermissions: [{ requestId: 'r', toolName: 'mcp__machine__unity', input: {}, createdAt: ago(3) }] }), { now: NOW });
  assert.deepEqual(perm, { status: 'needs_you', word: 'Needs you', doing: 'Asks to use unity', since: ago(3) });

  const busy = cardStatus(session('b', 'running', { turnOpenSince: ago(20), activeTool: { id: 't', name: 'Bash', since: ago(2) } }), { now: NOW });
  assert.deepEqual(busy, { status: 'working', word: 'Working', doing: 'Bash', tool: true, since: ago(20) });

  const waits = session('c', 'stopped', { waitingOn: { who: 'Ben', what: 'approve the stills', at: ago(40) } });
  assert.deepEqual(cardStatus(waits, { waitsOn: ['Ben'], me: 'ben', now: NOW }), { status: 'waiting', word: 'Asked you', doing: 'Approve the stills', since: ago(40) });
  assert.equal(cardStatus(waits, { waitsOn: ['Ben'], me: 'Lothsahn', now: NOW }).word, 'Waits on Ben');
});

test('w1837: between turns a card is Working on its job or check-in, Queued or Blocked on a held message, Blocked on its request gates', () => {
  const ci = cardStatus(session('a', 'idle', { backgroundJobs: [{ type: 'local_bash', description: 'CI on PR #551' }], lastResultAt: ago(4) }), { now: NOW });
  assert.equal(ci.status, 'working');
  assert.equal(ci.doing, 'CI on PR #551');
  assert.equal(ci.since, ago(4));

  const checkIn = cardStatus(session('b', 'stopped', { wakeAt: new Date(NOW + 20 * 60_000).toISOString(), wakeNote: 'look at the build' }), { now: NOW, time: () => '12:20' });
  // Its own check-in and nothing else: Back at, never Working (the ledger's word) nor Stopped (the machine view's), w1837's critic.
  assert.deepEqual([checkIn.status, checkIn.word, checkIn.doing], ['due_back', 'Back at 12:20', 'Check-in: look at the build']);
  const alive = cardStatus(session('b2', 'idle', { wakeAt: new Date(NOW + 5 * 60_000).toISOString() }), { now: NOW, time: () => '12:05' });
  assert.deepEqual([alive.status, alive.word, alive.doing], ['due_back', 'Back at 12:05', 'Its own check-in']);

  assert.equal(cardStatus(session('c', 'idle', { queuedSend: 'waiting for a free agent slot', queuedOn: 'capacity' }), { now: NOW }).status, 'queued');
  assert.equal(cardStatus(session('d', 'idle', { queuedSend: 'its machine is offline', queuedOn: 'machine' }), { now: NOW }).status, 'blocked');
  assert.equal(cardStatus(session('e', 'idle', { hostFailure: { at: ago(9), error: 'spawn failed' }, machineId: 'm3/slot1' }), { now: NOW }).since, ago(9));

  // A request blocked on CI (blocked_on): Blocked since the gate was set, whatever check-in its worker left behind.
  const s = session('f', 'stopped', { lastResultAt: ago(30) });
  const w = item('w9', 'blocked', ['f'], { blocked: { kind: 'ci', ref: 'Final-Factory/ff-factory#551', what: 'CI on #551', at: ago(25), by: 'f' } });
  const st = cardStatus(s, { work: w, live: { state: 'blocked', why: 'CI on #551', waitsOn: ['CI on Final-Factory/ff-factory#551'] }, now: NOW });
  assert.deepEqual([st.status, st.word, st.doing, st.since], ['blocked', 'Blocked', 'Waits for CI on Final-Factory/ff-factory#551', ago(25)]);

  assert.equal(cardStatus(session('g', 'idle'), { now: NOW }).status, 'idle');
  // Its request is Stalled (nothing works on it, nothing waits on a person): the ledger's red state.
  const stalled = cardStatus(session('g2', 'stopped'), { live: { state: 'stalled', why: 'g2 stopped 3h ago, nothing waits on a person' }, now: NOW });
  assert.deepEqual([stalled.status, stalled.word, stalled.doing], ['stalled', 'Stalled', 'Its request is stalled: g2 stopped 3h ago, nothing waits on a person']);
  assert.equal(cardStatus(session('h', 'stopped'), { now: NOW }).status, 'stopped');
  assert.equal(cardStatus(session('i', 'error', { statusDetail: 'crashed' }), { now: NOW }).status, 'error');
});

test('w1837: the board reads a person first, then working, then queued or blocked, then idle; the longest in a state first', () => {
  const c = (id: string, status: WorkerCard['status'], group: WorkerCard['group'], m: number) => ({ id, status, group, since: ago(m) });
  const order = sortCards([
    c('idle', 'idle', 'resting', 50),
    c('stop', 'stopped', 'resting', 500),
    c('due', 'due_back', 'held', 300),
    c('stall', 'stalled', 'held', 2),
    c('q', 'queued', 'held', 5),
    c('blk', 'blocked', 'held', 1),
    c('new-work', 'working', 'working', 2),
    c('old-work', 'working', 'working', 90),
    c('asked', 'waiting', 'person', 60),
    c('perm', 'needs_you', 'person', 1),
    c('tie-b', 'working', 'working', 90),
  ]).map((x) => x.id);
  assert.deepEqual(order, ['perm', 'asked', 'old-work', 'tie-b', 'new-work', 'stall', 'blk', 'q', 'due', 'idle', 'stop']);
});

test('w1837: filters by group, person (any case) and machine; counts and choices for the bar', () => {
  const card = (id: string, group: WorkerCard['group'], person: string | undefined, machineId: string, machine: string) => ({ id, group, person, machineId, machine });
  const cards = [card('a', 'working', 'Ben', 'beast', 'BEAST'), card('b', 'person', 'Lothsahn', 'lothdesktop', 'LothDesktop'), card('c', 'working', 'Lothsahn', 'beast', 'BEAST'), card('d', 'resting', undefined, 'm3', 'm3')];
  const ids = (list: { id: string }[]) => list.map((x) => x.id);
  assert.deepEqual(ids(filterCards(cards, { groups: [] })), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids(filterCards(cards, { groups: ['working', 'person'] })), ['a', 'b', 'c']);
  assert.deepEqual(ids(filterCards(cards, { groups: [], person: 'lothsahn' })), ['b', 'c']);
  assert.deepEqual(ids(filterCards(cards, { groups: ['working'], person: 'Lothsahn', machine: 'beast' })), ['c']);
  assert.deepEqual(groupCounts(cards), { person: 1, working: 2, held: 0, resting: 1 });
  assert.deepEqual(filterChoices(cards), {
    people: ['Ben', 'Lothsahn'],
    machines: [
      { id: 'beast', name: 'BEAST' },
      { id: 'lothdesktop', name: 'LothDesktop' },
      { id: 'm3', name: 'm3' },
    ],
  });
});

test('w1837: the mode and the filters the browser remembers: the machine view and no filter unless picked, anything odd dropped', () => {
  assert.equal(readMode(null), 'machines');
  assert.equal(readMode('nonsense'), 'machines');
  assert.equal(readMode(writeMode('workers')), 'workers');
  assert.equal(writeMode('machines'), null, 'the default stores nothing');

  assert.deepEqual(readFilter(null), { groups: [] });
  assert.deepEqual(readFilter('{not json'), { groups: [] });
  assert.deepEqual(readFilter('{"groups":["held","bogus","person"],"person":7,"machine":"beast"}'), { groups: ['person', 'held'], machine: 'beast' });
  const f = { groups: ['resting' as const, 'person' as const], person: 'Ben', machine: 'm3' };
  assert.deepEqual(readFilter(writeFilter(f)), { groups: ['person', 'resting'], person: 'Ben', machine: 'm3' });
  assert.equal(writeFilter({ groups: [] }), null, 'no filter stores nothing');
});

test('w1837: one card per worker the machine view lists, with its request, person, PR, Live view and place', () => {
  const sessions = [
    session('s-work', 'running', { title: 'w10: Belt splitter fix', machineId: 'beast', machineSandbox: 'slot1', turnOpenSince: ago(8), costUsd: 3.2 }),
    session('s-ask', 'stopped', { title: 'w11: Bloom pass', machineId: 'lothdesktop', machineSandbox: 'slot2', waitingOn: { who: 'Lothsahn', what: 'pick a look', at: ago(30), request: 'w11' } }),
    session('s-done', 'idle', { title: 'w9: Old work', machineId: 'beast', machineSandbox: 'slot1', lastActivityAt: ago(300) }),
    session('s-free', 'idle', { title: 'Untitled', machineId: 'lothdesktop', machineSandbox: 'slot3' }),
    // No request, finished its turn, but its Live view is up for Ben's knobs: the machine view's "Live view: go" (w1430).
    session('s-view', 'idle', { title: 'Comet look', machineId: 'beast', machineSandbox: 'slot4', requestedBy: BEN }),
  ];
  const work = [
    item('w10', 'active', ['s-work'], { title: 'Splitters lose items when a belt backs up', prs: [{ repo: 'Final-Factory/FinalFactory', number: 2290, url: 'https://github.com/x/2290', state: 'open' }] }),
    item('w11', 'active', ['s-ask'], { title: 'Bloom', requestedBy: LOTH, requesters: [LOTH] }),
    item('w9', 'done', ['s-done']),
  ];
  const fleet = fleetOf(
    {
      sessions,
      work,
      machines: [machine('beast', 'BEAST', [sandbox('slot1', ['s-work', 's-done']), sandbox('slot4', ['s-view'])]), machine('lothdesktop', 'LothDesktop', [sandbox('slot2', ['s-ask']), sandbox('slot3', ['s-free'])])],
      system: undefined,
      machineStats: {},
    },
    undefined,
    NOW,
  );
  const view = (sessionId: string) => ({ liveId: sessionId, sessionId, machineId: 'beast', sandbox: 'slot1', state: 'live' as const, detail: '', fps: 10, width: 1280, materials: [], startedAt: ago(10), updatedAt: ago(0), frames: 100 });
  const cards = workerCards(fleet, { work, views: [view('s-work'), view('s-view')], me: 'Lothsahn', now: NOW });
  // The finished chat on a closed request and the idle one with no request are folded away in the machine view: no card.
  assert.deepEqual(
    cards.map((c) => [c.id, c.status, c.word, c.title, c.request, c.person, `${c.machine}/${c.sandbox}`]),
    [
      ['s-ask', 'waiting', 'Asked you', 'Bloom pass', 'w11', 'Lothsahn', 'LothDesktop/slot2'],
      ['s-view', 'waiting', 'Waits on Ben', 'Comet look', undefined, 'Ben', 'BEAST/slot4'],
      ['s-work', 'working', 'Working', 'Belt splitter fix', 'w10', 'Ben', 'BEAST/slot1'],
    ],
  );
  const busy = cards.find((c) => c.id === 's-work')!;
  assert.equal(busy.live, true);
  assert.deepEqual(busy.pr, { repo: 'Final-Factory/FinalFactory', number: 2290, url: 'https://github.com/x/2290', state: 'open' });
  assert.equal(busy.requestTitle, 'Splitters lose items when a belt backs up');
  assert.equal(busy.costUsd, 3.2);
  assert.equal(busy.machineId, 'beast');
  assert.equal(cards.find((c) => c.id === 's-ask')!.live, false);
});

test('w1837: a doing line is a sentence, but a tool keeps its own name', () => {
  assert.equal(cardStatus(session('a', 'idle', { queuedSend: 'waits for a free agent slot', queuedOn: 'capacity' }), { now: NOW }).doing, 'A queued message (waits for a free agent slot)');
  assert.equal(cardStatus(session('b', 'running', { activeTool: { id: 't', name: 'mcp__machine__run_tests', since: ago(6) } }), { now: NOW }).doing, 'run_tests');
});

test('w1837: the header counts the same cards as the chips', () => {
  const g = (group: WorkerCard['group']) => ({ group });
  assert.equal(cardsSummary([g('working'), g('working'), g('person'), g('held'), g('resting')]), '5 workers · 2 working · 1 needs a person · 1 held up');
  assert.equal(cardsSummary([g('working')]), '1 worker · 1 working');
  assert.equal(cardsSummary([]), '0 workers · 0 working');
});
