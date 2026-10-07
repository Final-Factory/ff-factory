import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaceAgain, RELEASE_AFTER_MS, farWhy, keptWhy, movedNote, placeFor, releaseStep, releasedOn, type PlaceFacts } from './placeAgain.ts';
import { agentStateText, holdsItsPlace, holdsSandbox } from '../shared/agentState.ts';
import { isLiveAgent } from '../shared/fleet.ts';
import type { Machine, MachineSandbox, SessionInfo } from '../shared/types.ts';

const NOW = Date.parse('2026-10-07T16:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

const worker = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  kind: 'worker',
  machineId: 'pc',
  machineSandbox: 'slot1',
  title: id,
  status: 'stopped',
  permissionMode: 'default',
  createdAt: iso(NOW - 3600 * 1000),
  lastActivityAt: iso(NOW - 20 * MIN),
  turns: 3,
  costUsd: 1,
  pendingPermissions: [],
  ...over,
});

const sandbox = (id: string, over: Partial<MachineSandbox> = {}, git: Partial<NonNullable<MachineSandbox['git']>> = {}): MachineSandbox => ({
  id,
  branch: `sandbox/${id}`,
  base: 'origin/develop',
  path: `/sb/${id}`,
  purpose: id,
  status: 'ready',
  createdAt: iso(NOW - 86_400_000),
  unity: { state: 'stopped' },
  sessionIds: [],
  git: { branch: `feature/${id}`, dirty: 0, untracked: 0, at: iso(NOW - MIN), ...git },
  ...over,
});

const facts = (sessions: SessionInfo[], o: Partial<PlaceFacts> & { liveIds?: string[] } = {}): PlaceFacts => ({
  sessions,
  live: (id) => (o.liveIds ?? []).includes(id),
  unityHolders: o.unityHolders ?? [],
  now: NOW,
});

test('place again (w640): how far a check-in has to be, and stale check-ins of finished work', () => {
  assert.equal(farWhy({ wakeAt: iso(NOW + RELEASE_AFTER_MS - MIN) }, NOW), undefined, 'within the threshold it keeps its sandbox');
  assert.match(farWhy({ wakeAt: iso(NOW + RELEASE_AFTER_MS + MIN) }, NOW) ?? '', /^its check-in is 31 min away, at 16:31 UTC$/);
  assert.match(farWhy({ wakeAt: iso(NOW + 10 * 3600_000) }, NOW) ?? '', /^its check-in is 10 h away, at tomorrow 02:00 UTC$/);
  assert.equal(farWhy({ wakeAt: iso(NOW + 2 * 3600_000), queuedSend: 'x' }, NOW), undefined, 'a queued message resumes it now');
  assert.equal(farWhy({}, NOW), undefined, 'no check-in: it holds nothing to release');
  assert.equal(farWhy({ wakeAt: iso(NOW - 10 * MIN) }, NOW), undefined, 'an overdue check-in is not ahead');
  assert.match(farWhy({ wakeAt: iso(NOW + 5 * MIN) }, NOW, 'its request is closed (w598 done)') ?? '', /is for work that is over: its request is closed \(w598 done\)/);
});

test('place again (w640): a stopped worker with a far check-in releases a clean sandbox; what keeps one held', () => {
  const far = { wakeAt: iso(NOW + 9 * 3600_000) };
  const w = worker('w1', far);
  const sb = sandbox('slot1');
  const step = releaseStep(w, sb, facts([w]));
  assert.deepEqual(step, { do: 'release', why: 'its check-in is 9.0 h away, at tomorrow 01:00 UTC', branch: 'feature/slot1' });
  assert.equal(releaseStep(worker('w1', { wakeAt: iso(NOW + 20 * MIN) }), sb, facts([w])), undefined, 'a near check-in holds');
  // Nothing in the worktree may be lost: uncommitted, untracked, a git state older than its last work.
  assert.match(keptWhy(w, sandbox('slot1', {}, { dirty: 2 }), facts([w])) ?? '', /2 uncommitted change/);
  assert.match(keptWhy(w, sandbox('slot1', {}, { untracked: 3 }), facts([w])) ?? '', /3 untracked file/);
  assert.match(keptWhy(w, sandbox('slot1', {}, { at: iso(NOW - 30 * MIN) }), facts([w])) ?? '', /not been read since the worker last worked/);
  assert.match(keptWhy(w, sandbox('slot1', { git: undefined }), facts([w])) ?? '', /not known yet/);
  assert.match(keptWhy(w, sandbox('slot1', {}, { branch: 'detached HEAD' }), facts([w])) ?? '', /not on a branch/);
  assert.match(keptWhy(w, sandbox('slot1', { status: 'creating' }), facts([w])) ?? '', /is creating/);
  // A Unity batch run of that sandbox, or another agent working there on the same branch.
  assert.match(keptWhy(w, sb, facts([w], { unityHolders: ['sandbox:slot1'] })) ?? '', /batch run/);
  const other = worker('o1', { status: 'idle' });
  assert.match(keptWhy(w, sb, facts([w, other], { liveIds: ['o1'] })) ?? '', /agent o1 works there too/);
  // Its daemon went away while it was mid-turn (w613): that hold comes first.
  assert.equal(releaseStep(worker('w1', { ...far, heldSince: iso(NOW - 3600_000) }), sb, facts([w])), undefined);
  assert.ok(releaseStep(worker('w1', { ...far, heldSince: iso(NOW - 25 * 3600_000) }), sb, facts([w])), 'a hold past its day does not');
  // Its requests are over: a near check-in is stale too.
  assert.equal(releaseStep(worker('w1', { wakeAt: iso(NOW + 5 * MIN) }), sb, { ...facts([w]), workOver: 'its request is closed (w598 done)' })?.do, 'release');
});

test('place again (w640): a Waiting worker with only a far check-in is stopped first; one with a job or unanswered work is not', () => {
  const w = worker('w1', { status: 'idle', wakeAt: iso(NOW + 3 * 3600_000) });
  const sb = sandbox('slot1');
  assert.equal(releaseStep(w, sb, facts([w], { liveIds: ['w1'] }))?.do, 'stop');
  assert.equal(releaseStep(w, sb, { ...facts([w], { liveIds: ['w1'] }), keepLive: 'it has unanswered messages or background tasks' }), undefined);
  const job = worker('w1', { status: 'idle', wakeAt: w.wakeAt, backgroundJobs: [{ type: 'bash', description: 'CI on PR #1098' }] });
  assert.equal(releaseStep(job, sb, facts([job], { liveIds: ['w1'] })), undefined, 'a running job keeps it');
  assert.equal(releaseStep(worker('w1', { status: 'running', wakeAt: w.wakeAt }), sb, facts([w], { liveIds: ['w1'] })), undefined, 'mid-turn');
});

test('place again (w640): a released worker frees its sandbox for others, the ledger still counts it, and it takes the sandbox back near its check-in', () => {
  const released = worker('w1', { wakeAt: iso(NOW + 9 * 3600_000), placeReleased: { at: iso(NOW), sandbox: 'slot1', branch: 'feature/slot1', why: 'its check-in is 9.0 h away' } });
  assert.equal(holdsItsPlace(released, NOW), true, 'it will come back: the ledger leaves its request alone');
  assert.equal(holdsSandbox(released, NOW), false, 'but its sandbox is free');
  assert.equal(isLiveAgent(released), false);
  assert.match(agentStateText(released, undefined, NOW), /^Stopped \(resumes at check-in tomorrow 01:00 UTC; its sandbox is released \(its check-in is 9.0 h away\): it is placed again when it resumes\)$/);
  // Its check-in is near again: back to its own sandbox, while that is free and on its branch.
  const near = { ...released, wakeAt: iso(NOW + 10 * MIN) };
  const sb = sandbox('slot1');
  assert.deepEqual(releaseStep(near, sb, facts([near])), { do: 'reclaim' });
  assert.equal(releaseStep(near, sandbox('slot1', {}, { branch: 'sandbox/slot1-w635' }), facts([near])), undefined, 'switched for other work');
  const other = worker('n1', { status: 'idle' });
  assert.equal(releaseStep(near, sb, facts([near, other], { liveIds: ['n1'] })), undefined, 'another worker took it');
  assert.equal(releaseStep(released, sb, facts([released])), undefined, 'still far: stays released');
});

test('place again (w640): where a released worker resumes: its own sandbox, another free one, or it waits', () => {
  const w = worker('w1', { placeReleased: { at: iso(NOW), sandbox: 'slot1', branch: 'feature/w1', why: 'its check-in is 9.0 h away' } });
  const m = (sbs: MachineSandbox[]): Pick<Machine, 'id' | 'sandboxes'> => ({ id: 'pc', sandboxes: sbs });
  const own = sandbox('slot1', { sessionIds: ['w1'] }, { branch: 'feature/w1' });
  assert.equal((placeFor(w, m([own, sandbox('slot2')]), facts([w])) as { sandbox: MachineSandbox }).sandbox.id, 'slot1', 'its own first');
  // Its own took other work: another free one, an editor that is not running first; one with uncommitted files never.
  const taken = sandbox('slot1', { sessionIds: ['w1', 'n1'] }, { branch: 'sandbox/slot1-w635' });
  const n1 = worker('n1', { status: 'running' });
  const s2 = sandbox('slot2', { unity: { state: 'running' } });
  const s3 = sandbox('slot3');
  const s4 = sandbox('slot4', {}, { dirty: 1 });
  const p = placeFor(w, m([taken, s2, s3, s4]), facts([w, n1], { liveIds: ['n1'] }));
  assert.equal((p as { sandbox: MachineSandbox }).sandbox.id, 'slot3');
  // A free sandbox already on its branch needs no switch.
  const onIt = sandbox('slot5', {}, { branch: 'feature/w1' });
  assert.equal((placeFor(w, m([taken, s3, onIt]), facts([w, n1], { liveIds: ['n1'] })) as { sandbox: MachineSandbox }).sandbox.id, 'slot5');
  // Its branch held in a sandbox in use: git allows it in one worktree only, so it waits.
  const held = sandbox('slot1', { sessionIds: ['w1', 'n1'] }, { branch: 'feature/w1' });
  assert.match((placeFor(w, m([held, s3]), facts([w, n1], { liveIds: ['n1'] })) as { wait: string }).wait, /its branch feature\/w1 is checked out in pc\/slot1, which is in use/);
  // Nothing free: it waits, ahead of new work.
  assert.match((placeFor(w, m([taken]), facts([w, n1], { liveIds: ['n1'] })) as { wait: string }).wait, /no sandbox on pc is free .*ahead of new work/);
  // A sandbox a new worker was just started in (its brief waits for it) is not free either.
  const fresh = worker('n2', { machineSandbox: 'slot3', turns: 0, createdAt: iso(NOW - 5 * MIN) });
  assert.match((placeFor(w, m([taken, s3]), facts([w, n1, fresh], { liveIds: ['n1'] })) as { wait: string }).wait, /no sandbox/);
  // Claimed for another waiting worker, or one a placement just failed in: skipped.
  assert.match((placeFor(w, m([taken, s3]), facts([w, n1], { liveIds: ['n1'] }), new Map([['slot3', 'w2']])) as { wait: string }).wait, /no sandbox/);
  assert.match((placeFor(w, m([taken, s3]), facts([w, n1], { liveIds: ['n1'] }), new Map(), (x) => x === 'slot3') as { wait: string }).wait, /no sandbox/);
});

test('place again (w640): waiting resumes claim the free sandboxes before new work, oldest id first; the moved note', () => {
  const rel = (id: string): SessionInfo => worker(id, { placeReleased: { at: iso(NOW), sandbox: 'slot1', branch: `feature/${id}`, why: 'far' } });
  const w1 = rel('a1');
  const w2 = rel('b2');
  const n1 = worker('n1', { status: 'running' });
  const machine = { id: 'pc', sandboxes: [sandbox('slot1', { sessionIds: ['a1', 'b2', 'n1'] }), sandbox('slot2')] } as unknown as Machine;
  const queued = new Set(['a1', 'b2']);
  const p = new PlaceAgain({
    sessions: () => [w1, w2, n1],
    machine: () => machine,
    isLive: (id) => id === 'n1',
    online: () => true,
    unityHolders: () => [],
    workOver: () => undefined,
    keepLive: () => undefined,
    queued: (id) => queued.has(id),
    stopLive: () => undefined,
    stopEditor: async () => undefined,
    switchBranch: async () => ({ notes: [] }),
    save: () => undefined,
    saveMachine: () => undefined,
    note: () => undefined,
    drain: () => undefined,
    now: () => NOW,
  });
  assert.equal(p.claimedBy('pc', 'slot2'), 'a1');
  assert.deepEqual(p.waiting('pc'), ['b2'], 'b2 waits for the next one to free');
  // The worker learns where it is now from its next message.
  const note = movedNote({ id: 'pc' }, { sandbox: 'slot1', path: 'D:\\ffsb\\slot1', at: iso(NOW), why: 'its check-in is 9.0 h away', branch: 'feature/a1' }, { id: 'slot2', path: 'D:\\ffsb\\slot2' });
  assert.match(note, /^\[moved\] While you were stopped your sandbox pc\/slot1 went to other work/);
  assert.match(note, /You work in sandbox pc\/slot2 now: `D:\\ffsb\\slot2`, on your branch `feature\/a1`/);
  assert.match(note, /set_active_instance again/);
  // A sandbox still on a released worker's branch must be switched before new work starts there.
  const left = sandbox('slot1', { sessionIds: ['a1'] }, { branch: 'feature/a1' });
  assert.equal(releasedOn(left, [w1], () => false)?.id, 'a1');
  assert.equal(releasedOn(sandbox('slot1', {}, { branch: 'sandbox/slot1-w9' }), [w1], () => false), undefined);
});

test('place again (w640): a resume goes straight back to its own sandbox when that is still free and on its branch; else it waits or moves', async () => {
  const w = worker('w1', { placeReleased: { at: iso(NOW), sandbox: 'slot1', branch: 'feature/w1', why: 'far' } });
  const own = sandbox('slot1', { sessionIds: ['w1'] }, { branch: 'feature/w1' });
  const machine = { id: 'pc', sandboxes: [own] } as unknown as Machine;
  let online = true;
  const switched: string[] = [];
  const saved: string[] = [];
  let drained = 0;
  const p = new PlaceAgain({
    sessions: () => [w],
    machine: () => machine,
    isLive: () => false,
    online: () => online,
    unityHolders: () => [],
    workOver: () => undefined,
    keepLive: () => undefined,
    queued: () => false,
    stopLive: () => undefined,
    stopEditor: async () => undefined,
    switchBranch: async (_m, branch, sb) => (switched.push(`${sb}:${branch}`), { notes: [`switched to ${branch}`] }),
    save: (s) => saved.push(s.id),
    saveMachine: () => undefined,
    note: () => undefined,
    drain: () => void drained++,
    now: () => NOW,
  });
  online = false;
  assert.match(p.answer(w) ?? '', /pc is offline/);
  online = true;
  assert.equal(p.answer(w), undefined, 'its own sandbox, as it left it: it goes now');
  assert.equal(w.placeReleased, undefined);
  assert.deepEqual(switched, []);
  // Switched away and left free since: switched back, in place.
  w.placeReleased = { at: iso(NOW), sandbox: 'slot1', branch: 'feature/w1', why: 'far' };
  own.git = { branch: 'sandbox/slot1-w9', dirty: 0, untracked: 0, at: iso(NOW) };
  assert.match(p.answer(w) ?? '', /being placed again in pc\/slot1 \(switching it to its branch feature\/w1\)/);
  assert.match(p.answer(w) ?? '', /being placed again in pc\/slot1$/, 'once');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(switched, ['slot1:feature/w1']);
  assert.equal(w.placeReleased, undefined);
  assert.equal(w.machineSandbox, 'slot1');
  assert.equal(w.movedFrom, undefined, 'not moved: no note');
  assert.equal(drained, 1);
});
