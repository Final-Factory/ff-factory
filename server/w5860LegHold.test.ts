import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEG_HOLD_MS } from '../shared/capacity.ts';
import type { SessionInfo, WorkItem } from '../shared/types.ts';
import { moveDecision, type MoveFacts, type MoveRequest } from './resumeMove.ts';
import type { Computer } from './placement.ts';
import { putRequests, T0, twoComputers } from './orchestratorsTestKit.ts';

// w5860, 2026-11-26: w5833 (high) had a leg Queued for biscuit from 23:50Z (decide_work queue with needs, w1863), and freed
// biscuit places went to later work of the same priority (w5855, w5859). lothsahn (w4620): every queue is strict priority,
// then oldest first. Here pc stands for biscuit and beast for BEAST.

const LATER = '2026-09-28T10:00:00.000Z';

async function legOnPc(t: Parameters<typeof twoComputers>[0]) {
  const env = await twoComputers(t);
  putRequests(env.store, [
    { id: 'w5833', title: 'Fix the dispatcher', priority: 'high', status: 'active', legs: [{ at: T0, needs: ['pc'], what: 'run it on biscuit' }] },
    { id: 'w5855', priority: 'high', createdAt: LATER },
    { id: 'w5856', priority: 'urgent', createdAt: LATER },
  ]);
  return env;
}

test('w5860: a computer\'s free sandbox is held for an older leg of the same priority: a later start is refused, a higher one and the leg\'s own request are not', async (t) => {
  const { store, agents, dispatcher, call } = await legOnPc(t);
  const later = await call(dispatcher().info, 'start_agent', { work_id: 'w5855', prompt: 'Fix it', title: 'fix', sandbox: 'pc/alpha' });
  assert.equal(later.isError, true, later.text);
  assert.match(later.text, /pc's next free sandbox is held for w5833's leg "Fix the dispatcher" \(high, filed 09:00 UTC, its leg queued for pc since 09:00 UTC\).*strict priority, then oldest first \(w4620, w5860\)/);
  assert.deepEqual(store.work.get('w5855')!.sessionIds, []);
  // Higher priority goes first; the leg's own request takes its place; another computer is not held.
  assert.equal(agents.legHoldProblem('pc', store.work.get('w5856')), undefined);
  assert.equal(agents.legHoldProblem('pc', store.work.get('w5833')), undefined);
  assert.equal(agents.legHoldProblem('beast', store.work.get('w5855')), undefined);
  // Older work of the same priority is ahead of the leg's request, so it is not held either.
  const older = { ...store.work.get('w5855')!, createdAt: '2026-09-28T08:00:00.000Z' };
  assert.equal(agents.legHoldProblem('pc', older), undefined);
  // The room move's held map (heldFor) reads it too.
  assert.match(agents.heldFor('pc', store.work.get('w5855')!) ?? '', /held for w5833's leg/);
});

test('w5860: the leg hold lapses LEG_HOLD_MS after the computer\'s room began, and goes once the leg is dropped', async (t) => {
  const { store, agents, o } = await legOnPc(t);
  const w = store.work.get('w5855')!;
  const now = o.now().getTime();
  const facts = agents.roomFacts.bind(agents);
  agents.roomFacts = () => ({ ...facts(), since: { 'game:pc': now - LEG_HOLD_MS + 60_000 } });
  assert.ok(agents.legHoldProblem('pc', w), 'held inside the window');
  agents.roomFacts = () => ({ ...facts(), since: { 'game:pc': now - LEG_HOLD_MS } });
  assert.equal(agents.legHoldProblem('pc', w), undefined, 'lapsed');
  agents.roomFacts = facts;
  store.work.get('w5833')!.legs = [];
  assert.equal(agents.legHoldProblem('pc', w), undefined, 'dropped');
});

test('w5860: work needing only an agent seat is held off the seat a leg waits for only when that is the last seat', async (t) => {
  const { store, agents } = await legOnPc(t);
  const w = store.work.get('w5855')!;
  const places = agents.places.bind(agents);
  agents.places = () => places().map((p) => (p.id === 'pc' ? { ...p, maxAgents: 1, midTurn: 0 } : p));
  assert.match(agents.legHoldProblem('pc', w, 'seat') ?? '', /pc's next agent slot is held for w5833's leg/);
  agents.places = () => places().map((p) => (p.id === 'pc' ? { ...p, maxAgents: 4, midTurn: 0 } : p));
  assert.equal(agents.legHoldProblem('pc', w, 'seat'), undefined, 'a seat to spare');
});

test('w5860: a moved request is pinned to the computers its legs wait for (w5857 at 00:23Z, Queued for beast or biscuit, went to held lothdesktop)', async (t) => {
  const { store, agents } = await twoComputers(t);
  putRequests(store, [{ id: 'w5857', priority: 'urgent', status: 'active', legs: [{ at: T0, needs: ['beast', 'pc'], what: 'keep it off lothdesktop' }] }]);
  const info = { id: 'aaaa1111', machineId: 'beast', machineSandbox: 'slot1' } as SessionInfo;
  const f = (agents as unknown as { moveFacts(i: SessionInfo, r: WorkItem[]): MoveFacts }).moveFacts(info, [store.work.get('w5857')!]);
  assert.deepEqual(f.requests[0]!.pinned, ['beast', 'pc']);
});

// The fleet at 00:23Z on 2026-11-26: BEAST at its agent cap, lothdesktop idle (held by lothsahn's words, never in config).
const pc = (id: string, over: Partial<Computer> = {}): Computer => ({ id, online: true, live: 0, midTurn: 0, maxAgents: 6, sandboxes: 3, maxSandboxes: 3, freeSandboxes: 3, platform: 'linux', ...over });
const FLEET: Computer[] = [
  pc('beast', { live: 7, midTurn: 6, sandboxes: 6, maxSandboxes: 6, freeSandboxes: 1 }),
  pc('lothdesktop', { platform: 'win32' }),
  pc('biscuit', { freeSandboxes: 0, maxAgents: 4, midTurn: 4 }),
];
const facts = (r: Partial<MoveRequest>, over: Partial<MoveFacts> = {}): MoveFacts => ({
  machine: 'beast', released: false, branch: 'w5857-desync', canSave: true, places: FLEET, prefs: { prefer: ['beast', 'lothdesktop', 'biscuit'] },
  requests: [{ id: 'w5857', priority: 'urgent', kind: 'game', ...r }],
  ...over,
});

test('w5860 guard: the agent-cap move keeps a pinned request on the computers its legs wait for, and takes it nowhere else', () => {
  const free = moveDecision(facts({}));
  assert.ok('move' in free && free.move.to === 'lothdesktop', `without a pin it went to lothdesktop: ${JSON.stringify(free)}`);
  const pinned = moveDecision(facts({ pinned: ['beast', 'biscuit'] }));
  assert.ok(!('move' in pinned), JSON.stringify(pinned));
});

test('w5860: a move of seat-only work skips a computer held for another request (a leg), as a game move does', () => {
  const held = { lothdesktop: "lothdesktop's next agent slot is held for w5833's leg" };
  for (const kind of ['agent', 'game'] as const) {
    const d = moveDecision(facts({ kind }, { held }));
    assert.ok(!('move' in d) || d.move.to !== 'lothdesktop', `${kind}: ${JSON.stringify(d)}`);
  }
});

test('w5860 guard: a computer on placement.hold takes no move of any kind (the agent-cap move reads the hold)', () => {
  for (const kind of ['agent', 'game'] as const) {
    const d = moveDecision(facts({ kind }, { prefs: { prefer: ['beast', 'lothdesktop', 'biscuit'], hold: { lothdesktop: 'lothsahn: hold new work on LothDesktop' } } }));
    assert.ok(!('move' in d) || d.move.to !== 'lothdesktop', `${kind}: ${JSON.stringify(d)}`);
  }
});
