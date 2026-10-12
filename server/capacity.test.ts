import test from 'node:test';
import assert from 'node:assert/strict';
import { capacityBlockProblem, capacityWaitIn, isGameRepo, needsOf, resolveNeeds } from '../shared/capacity.ts';
import { blockerProblem } from '../shared/blockers.ts';

const GAME_REPO = 'Final-Factory/FinalFactory';

test("w1089: the words the dispatcher used for w1084 to w1088 are a capacity wait; things a request really waits on are not", () => {
  for (const wait of [
    'a free sandbox: all in use except the m5\'s (Ben testing)',
    'waiting for a free sandbox',
    'no free sandbox on lothdesktop',
    'until a slot frees up',
    'all sandboxes busy',
    'every editor is in use',
    'waits for an editor',
    'RAM at 91%, launches wait until it drops',
    'the agent cap is reached',
    'waiting for capacity',
    'when a sandbox becomes free',
    'a free agent slot',
    'queued for a computer with room',
  ]) assert.equal(capacityWaitIn(wait), true, wait);
  for (const thing of [
    "w633's timing table",
    'after the nightly run',
    'w727 PR 1291 and w752 fix merged into develop',
    'CI on PR #12 finished',
    'a portal deploy',
    'lothdesktop coming back online',
    "lothsahn's Claude token at its weekly limit",
    'the sandbox cleanup is done (w900)',
    "w1089's editor fix lands",
    'the room-temperature sensor feed',
    '',
    undefined,
  ]) assert.equal(capacityWaitIn(thing), false, String(thing));
});

test('w1089: decide_work block refuses a capacity wait of any kind, a time most of all, and says to queue; a real wait still passes', () => {
  const facts = { now: Date.parse('2026-10-12T04:20:00Z'), work: () => undefined };
  const at = '2026-10-12T04:35:00Z';
  const refused = blockerProblem({ kind: 'time', until: at, what: 'a free sandbox: all in use except the m5\'s (Ben testing)' }, 'w1084', facts);
  assert.match(refused ?? '', /is a wait for capacity .* Queued, never Blocked on a time or a thing: use decide_work queue/);
  assert.match(blockerProblem({ kind: 'lock', ref: 'lab.lock', what: 'no free editor' }, 'w1', facts) ?? '', /decide_work queue/);
  assert.equal(blockerProblem({ kind: 'time', until: at, what: 'after the nightly run' }, 'w1084', facts), undefined);
});

test('w1089: a worker cannot call blocked_on for a capacity wait: the reply says it is Queued by itself', () => {
  assert.match(capacityBlockProblem('waiting for a free sandbox', 'worker') ?? '', /FF Factory queues it by itself: .* Do not call blocked_on for it/);
  assert.equal(capacityBlockProblem('w727 PR #1291 merged', 'worker'), undefined);
});

test('w1098: a request on a repository that is not the game\'s needs an agent slot only; unknown or the game: a game sandbox', () => {
  assert.equal(isGameRepo('https://github.com/Final-Factory/FinalFactory.git', GAME_REPO), true);
  assert.equal(isGameRepo('Final-Factory/ff-factory', GAME_REPO), false);
  const r = (o: Partial<Parameters<typeof resolveNeeds>[0]>) => resolveNeeds({ title: 'T', brief: 'B', ...o }, GAME_REPO);
  assert.equal(r({ repo: 'Final-Factory/ff-factory' }).needs, 'agent');
  assert.equal(r({ repo: 'Final-Factory/ffbox' }).needs, 'agent');
  assert.equal(r({ repo: 'Final-Factory/final-factory-agents' }).needs, 'agent');
  assert.equal(r({ repo: 'Final-Factory/FinalFactory' }).needs, 'game');
  // An explicit needs wins over the repo; no repo and nothing to go on is the stricter game.
  assert.equal(r({ repo: 'Final-Factory/ff-factory', needs: 'game' }).needs, 'game');
  assert.equal(r({}).needs, 'game');
  // The guess, only when the filer gave neither: a non-game repository named and no game word.
  assert.equal(r({ title: 'FF Factory: capacity waits show as Queued', brief: 'Repo Final-Factory/ff-factory: change the dispatcher.' }).needs, 'agent');
  assert.equal(r({ title: 'FFBox: answer the board check', brief: 'ffbox repo only.' }).needs, 'agent');
  assert.equal(r({ title: 'FF Factory page shows the Unity editor state', brief: 'Show a Unity editor badge.' }).needs, 'game', 'a game word wins: the stricter');
  assert.equal(r({ title: 'Fix the belt splitter desync (spec 098)', brief: 'Final-Factory/FinalFactory' }).needs, 'game');
  assert.equal(needsOf({}), 'game', 'a request filed before w1098');
  assert.equal(needsOf({ needs: 'agent' }), 'agent');
});
