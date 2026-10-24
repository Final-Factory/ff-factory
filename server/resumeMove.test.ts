import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOVE_AFTER_MS, ROOM_WAIT, STAY_MARK, briefOf, moveDecision, movedPrompt, stayLine, type MoveFacts, type MoveRequest } from './resumeMove.ts';
import type { Computer } from './placement.ts';

// The fleet at 14:05Z on 2026-10-24 (w2046): BEAST full (6 of 6 agents mid-turn), the others idle.
const pc = (id: string, over: Partial<Computer> = {}): Computer => ({ id, online: true, live: 0, midTurn: 0, maxAgents: 6, sandboxes: 3, maxSandboxes: 3, freeSandboxes: 3, platform: 'win32', ...over });
const FLEET: Computer[] = [
  pc('beast', { live: 9, midTurn: 6, sandboxes: 6, maxSandboxes: 6, freeSandboxes: 0 }),
  pc('lothdesktop', { maxAgents: 6 }),
  pc('m5', { platform: 'darwin', freeSandboxes: 2, sandboxes: 2, maxSandboxes: 2, maxAgents: 4, noTimedRuns: 'a Mac kept free of exclusive tickets' }),
  pc('biscuit', { freeSandboxes: 1, sandboxes: 2, maxSandboxes: 2, maxAgents: 4 }),
  pc('lothlaptop', { freeSandboxes: 1, sandboxes: 1, maxSandboxes: 1, maxAgents: 2 }),
];
const req = (over: Partial<MoveRequest> = {}): MoveRequest => ({ id: 'w1891', priority: 'normal', kind: 'game', ...over });
const facts = (over: Partial<MoveFacts> = {}): MoveFacts => ({
  machine: 'beast',
  released: true,
  branch: 'w1891-roundrobin-belt-output',
  canSave: true,
  requests: [req()],
  places: FLEET,
  prefs: { prefer: ['beast', 'lothdesktop'] },
  ...over,
});

test('w1891 at 14:05Z: a released BEAST worker whose resume waits for a BEAST sandbox moves to the first computer with room in placement.prefer', () => {
  const d = moveDecision(facts());
  assert.ok('move' in d, JSON.stringify(d));
  assert.equal(d.move.to, 'lothdesktop');
  assert.match(d.move.why, /placement\.prefer/);
});

test('it never moves to its own computer, nor to one without a free sandbox already made, nor to a held one', () => {
  const places = FLEET.map((p) => (p.id === 'lothdesktop' ? { ...p, freeSandboxes: 0, sandboxes: 1 } : p));
  const d = moveDecision(facts({ places, prefs: { prefer: ['beast', 'lothdesktop'], hold: { biscuit: 'Ben testing' } } }));
  assert.ok('move' in d, JSON.stringify(d));
  assert.notEqual(d.move.to, 'beast');
  assert.notEqual(d.move.to, 'lothdesktop');
  assert.notEqual(d.move.to, 'biscuit');
});

test('w2013 leg 2: a pair leg never lands on the other leg\'s computer, and never on a Mac as a client', () => {
  const leg = req({ id: 'w2013', pair: { leg: 2, others: ['lothdesktop'] } });
  const d = moveDecision(facts({ requests: [leg], places: FLEET.filter((p) => ['beast', 'lothdesktop', 'm5'].includes(p.id)) }));
  assert.ok('none' in d, JSON.stringify(d));
  assert.match(d.none, /lothdesktop: w2013's other leg runs there/);
  assert.match(d.none, /m5: a Mac is never a pair run client/);
  const d2 = moveDecision(facts({ requests: [leg] }));
  assert.ok('move' in d2, JSON.stringify(d2));
  assert.ok(['biscuit', 'lothlaptop'].includes(d2.move.to), d2.move.to);
});

test('a cross-OS pair may move its host leg to a Mac, never a client leg', () => {
  const only = FLEET.filter((p) => ['beast', 'm5'].includes(p.id));
  const host = moveDecision(facts({ requests: [req({ pair: { leg: 1, others: ['lothdesktop'], crossOs: true } })], places: only }));
  assert.ok('move' in host && host.move.to === 'm5', JSON.stringify(host));
  const client = moveDecision(facts({ requests: [req({ pair: { leg: 2, others: ['lothdesktop'], crossOs: true } })], places: only }));
  assert.ok('none' in client, JSON.stringify(client));
});

test('a retried pair run\'s avoided computers are not tried', () => {
  const d = moveDecision(facts({ requests: [req({ pair: { leg: 2, others: ['lothdesktop'], avoid: ['biscuit'] } })] }));
  assert.ok('move' in d && d.move.to === 'lothlaptop', JSON.stringify(d));
});

test('timed work moves only to a computer that takes timed runs, small ones first, never the m5', () => {
  const d = moveDecision(facts({ requests: [req({ first: 'timed' })], places: FLEET.filter((p) => p.id !== 'lothdesktop' && p.id !== 'biscuit' && p.id !== 'lothlaptop') }));
  assert.ok('none' in d, JSON.stringify(d));
  const d2 = moveDecision(facts({ requests: [req({ first: 'timed' })] }));
  assert.ok('move' in d2 && d2.move.to !== 'm5', JSON.stringify(d2));
});

test('it stays, saying why, when the work truly needs its own computer', () => {
  const stays: [Partial<MoveFacts>, RegExp][] = [
    [{ benchHeld: true, released: false }, /bench lock/],
    [{ requests: [req({ pinned: ['beast'] })] }, /pinned to beast/],
    [{ requests: [req({ timedLeg: true })] }, /timed leg/],
    [{ branch: undefined }, /branch is not known/],
    [{ released: false, canSave: false, git: { upstream: 'origin/w1891-roundrobin-belt-output', ahead: 0, dirty: 2, untracked: 0 } }, /uncommitted work .* cannot save/],
    [{ released: false, git: { upstream: 'origin/w1891-roundrobin-belt-output', ahead: 3, dirty: 0, untracked: 0 } }, /3 commit\(s\) .* not pushed/],
    [{ released: false, git: { upstream: 'origin/master', ahead: 1, dirty: 0, untracked: 0 } }, /does not track its own remote branch/],
    [{ released: false, git: { dirty: 0, untracked: 0 } }, /no upstream/],
  ];
  for (const [over, why] of stays) {
    const d = moveDecision(facts(over));
    assert.ok('stay' in d, `${JSON.stringify(over)}: ${JSON.stringify(d)}`);
    assert.match(d.stay, why);
  }
});

test('uncommitted work its daemon saves, on a branch whose commits are pushed, moves', () => {
  const d = moveDecision(facts({ released: false, git: { upstream: 'origin/w1891-roundrobin-belt-output', ahead: 0, dirty: 4, untracked: 1 } }));
  assert.ok('move' in d, JSON.stringify(d));
});

test('a request pinned to other computers goes only there', () => {
  const d = moveDecision(facts({ requests: [req({ pinned: ['biscuit'] })] }));
  assert.ok('move' in d && d.move.to === 'biscuit', JSON.stringify(d));
});

test('work that needs only an agent seat moves to a computer with a seat, free sandbox or not', () => {
  const places = FLEET.map((p) => (p.id === 'beast' ? p : { ...p, freeSandboxes: 0, agentSeats: 2 }));
  const d = moveDecision(facts({ requests: [req({ kind: 'agent' })], places }));
  assert.ok('move' in d && d.move.to === 'lothdesktop', JSON.stringify(d));
});

test('with no other computer that has room, it waits as it is', () => {
  const places = FLEET.map((p) => ({ ...p, midTurn: p.maxAgents }));
  const d = moveDecision(facts({ places }));
  assert.ok('none' in d, JSON.stringify(d));
});

test('a reservation (placement.minPriority) keeps normal work off, high work goes', () => {
  const prefs = { prefer: ['beast', 'lothdesktop'], minPriority: { lothdesktop: 'high' as const } };
  const n = moveDecision(facts({ prefs }));
  assert.ok('move' in n && n.move.to !== 'lothdesktop', JSON.stringify(n));
  const h = moveDecision(facts({ prefs, requests: [req({ priority: 'high' })] }));
  assert.ok('move' in h && h.move.to === 'lothdesktop', JSON.stringify(h));
});

test('only waits for room on its own computer are moves: not an offline machine, not a placement under way', () => {
  assert.match('no sandbox on beast is free (its own, slot2, took other work after it was released: it waits on w1891: w2006 reporting); the next one to free there is its, ahead of new work', ROOM_WAIT);
  assert.match('6 agents mid-turn on beast, in sandboxes and standing agents together (its agent cap 6)', ROOM_WAIT);
  assert.match('2 agents mid-turn in sandbox beast/slot2 (max_agents_per_sandbox 2)', ROOM_WAIT);
  assert.match('no agent seat is free on beast (every sandbox has 2 agents); its work needs only a seat (w1098), and it takes the first that frees', ROOM_WAIT);
  assert.doesNotMatch('beast is offline: it is placed again once its daemon is back', ROOM_WAIT);
  assert.doesNotMatch('being placed again in beast/slot3', ROOM_WAIT);
  assert.ok(MOVE_AFTER_MS <= 30_000, 'the drain runs every 30 s: a move comes within a minute of the message');
  assert.ok(stayLine('x', 'y').includes(STAY_MARK));
});

test('the hand-off keeps the brief the old worker started from, without the harness\'s additions', () => {
  assert.equal(briefOf('Merge PR #2347 on green.\n\n---\nThe request as filed (w1891, ...)'), 'Merge PR #2347 on green.');
  assert.equal(briefOf(undefined), undefined);
  assert.match(briefOf('x'.repeat(7000))!, /1000 more characters/);
  const p = movedPrompt({ id: 'w1891', from: 'beast/slot2', to: 'lothdesktop/slot3', old: '0cd35068', hold: 'no sandbox on beast is free', why: 'first with room', brief: 'Merge PR #2347', report: 'still open: blocked on w2006' });
  assert.match(p, /moved, w2046/);
  assert.match(p, /0cd35068 on beast\/slot2/);
  assert.match(p, /Merge PR #2347/);
  assert.match(p, /blocked on w2006/);
});
