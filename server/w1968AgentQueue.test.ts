import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentState, agentStateText } from '../shared/agentState.ts';
import { agentQueueAll, agentQueueFacts } from '../shared/queueWaits.ts';
import { cardStatus } from '../shared/workerCards.ts';
import type { BenchState, BenchTicketGlance, MachineStats, SessionInfo } from '../shared/types.ts';

// w1968 (lothsahn, 2026-10-24: "Why does Beast show an exclusive lock but a bunch of working runners? Shouldn't some of them
// be blocked?"): the runner and sandbox views read an agent's own bench tickets from the same queue waits list_work's Blocked
// uses (shared/queueWaits.ts), so a worker waiting in a bench queue shows Blocked on the lock and its holder says it holds it.

const NOW = Date.parse('2026-10-24T02:15:00Z');
const session = (id: string, o: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  kind: 'worker',
  title: `worker ${id}`,
  status: 'running',
  permissionMode: 'default',
  createdAt: '2026-10-24T01:00:00Z',
  lastActivityAt: '2026-10-24T02:14:00Z',
  turns: 3,
  costUsd: 1,
  pendingPermissions: [],
  machineId: 'beast',
  ...o,
});
const ticket = (t: Partial<BenchTicketGlance> & Pick<BenchTicketGlance, 'ticket' | 'mode'>): BenchTicketGlance => ({ what: 'timed A/B', ...t });
const time = (iso: string) => `${iso.slice(11, 16)} UTC`;

// BEAST at about 02:15Z: w1891's worker holds exclusive t00001009; w1908's worker waits for exclusive t00001010.
const holder = ticket({ ticket: 't00001009', mode: 'exclusive', session: '0cd35068', requests: ['w1891'], since: '2026-10-24T02:10:00Z' });
const waiter = { ...ticket({ ticket: 't00001010', mode: 'exclusive', session: '2005c734', requests: ['w1908'], since: '2026-10-24T02:12:00Z' }), ahead: 0 };
const bench = (b: Partial<BenchState>): BenchState => ({ mode: 'free', running: [], runningCount: 0, waiting: 0, ...b });
const beast = (b: BenchState): Record<string, Pick<MachineStats, 'bench' | 'unity'>> => ({ beast: { bench: b } });
const locked = beast(bench({ mode: 'exclusive', running: [holder], runningCount: 1, waiting: 1, waiters: [waiter] }));

test('w1968: a worker waiting in a bench queue reads Blocked on the lock; its holder reads as holding it', () => {
  const q = agentQueueAll(locked);
  const busy = { activeTool: { id: 't', name: 'Bash', since: '2026-10-24T02:12:00Z' } };
  const w = { ...session('2005c734', busy), ...agentQueueFacts('2005c734', q) };
  assert.equal(agentStateText(w, time, NOW), 'Blocked: waiting for the exclusive bench lock on beast (held by w1891 / t00001009 since 02:10 UTC, next in queue)');
  // The state stays mid-turn: only the label and its reason change, so capacity and the ledger's rules read it as before.
  assert.equal(agentState(w, time, NOW).state, 'working');
  const h = { ...session('0cd35068', busy), ...agentQueueFacts('0cd35068', q) };
  assert.equal(agentStateText(h, time, NOW), 'Working: holds the exclusive bench lock on beast (t00001009 for w1891, since 02:10 UTC)');
  // Between turns (its `bench_queue.py run` in a background job): the same.
  const idle = { ...session('2005c734', { status: 'idle', backgroundJobs: [{ type: 'bash', description: 'timed A/B' }] }), ...agentQueueFacts('2005c734', q) };
  assert.match(agentStateText(idle, time, NOW), /^Blocked: waiting for the exclusive bench lock on beast/);
  // Another agent on the machine, doing real work: Working, nothing said of the lock.
  const other = { ...session('aaaa1111', busy), ...agentQueueFacts('aaaa1111', q) };
  assert.equal(agentStateText(other, time, NOW), 'Working');
  // A stopped agent is Stopped, whatever a stale ticket says.
  assert.equal(agentState({ ...session('2005c734', { status: 'stopped' }), ...agentQueueFacts('2005c734', q) }, time, NOW).state, 'stopped');

  // The worker cards say the same.
  const card = cardStatus(session('2005c734', busy), { now: NOW, time, queue: q });
  assert.equal(card.status, 'blocked');
  assert.equal(card.doing, 'Waiting for the exclusive bench lock on beast (held by w1891 / t00001009 since 02:10 UTC, next in queue)');
  const held = cardStatus(session('0cd35068', busy), { now: NOW, time, queue: q });
  assert.deepEqual([held.status, held.doing], ['working', 'Holds the exclusive bench lock on beast (t00001009 for w1891, since 02:10 UTC)']);
  assert.deepEqual([cardStatus(session('aaaa1111', busy), { now: NOW, time, queue: q }).doing], ['Bash']);
});

test('w1968: once its ticket is granted the waiter reads Working and holds it; a shared wait says it is shared', () => {
  const granted = agentQueueAll(beast(bench({ mode: 'exclusive', running: [{ ...waiter, since: '2026-10-24T02:20:00Z' }], runningCount: 1 })));
  const w = { ...session('2005c734'), ...agentQueueFacts('2005c734', granted) };
  assert.equal(agentStateText(w, time, NOW), 'Working: holds the exclusive bench lock on beast (t00001010 for w1908, since 02:20 UTC)');
  assert.equal(agentStateText({ ...session('0cd35068'), ...agentQueueFacts('0cd35068', granted) }, time, NOW), 'Working');

  const shared = ticket({ ticket: 't00001008', mode: 'shared', session: 'bbbb2222', requests: ['w1908'], what: 'unity: build_player', since: '2026-10-24T02:00:00Z' });
  const q = agentQueueAll(beast(bench({ mode: 'shared', running: [shared], runningCount: 1, waiting: 1, waiters: [{ ...holder, ahead: 0 }] })));
  assert.match(agentStateText({ ...session('0cd35068'), ...agentQueueFacts('0cd35068', q) }, time, NOW), /^Blocked: waiting for the shared bench lock on beast \(a shared lock, held by 1 shared ticket: w1908 \/ t00001008/);
  assert.equal(agentStateText({ ...session('bbbb2222'), ...agentQueueFacts('bbbb2222', q) }, time, NOW), 'Working: holds a shared bench ticket on beast (t00001008 for w1908, since 02:00 UTC)');
  // No machine stats: as before.
  assert.equal(agentStateText({ ...session('0cd35068'), ...agentQueueFacts('0cd35068', undefined) }, time, NOW), 'Working');
});
