import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaceAgain, RELEASE_AFTER_MS, farWhy, keptWhy, movedNote, placeFor, releaseStep, releaseWhy, releasedOn, savedNote, type PlaceFacts } from './placeAgain.ts';
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
  // Its daemon went away under it (w613): that hold comes first, for half an hour (w656).
  assert.equal(releaseStep(worker('w1', { ...far, heldSince: iso(NOW - 20 * MIN) }), sb, facts([w])), undefined);
  assert.ok(releaseStep(worker('w1', { ...far, heldSince: iso(NOW - 31 * MIN) }), sb, facts([w])), 'a hold past its half hour does not');
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
  // Its branch held in a sandbox another agent works in on that branch: it shares it, as before it stopped (w656).
  const held = sandbox('slot1', { sessionIds: ['w1', 'n1'] }, { branch: 'feature/w1' });
  assert.equal((placeFor(w, m([held, s3]), facts([w, n1], { liveIds: ['n1'] })) as { sandbox: MachineSandbox }).sandbox.id, 'slot1');
  // Its branch held in a sandbox it cannot use (uncommitted changes there): git allows it in one worktree only, so it waits.
  const dirtyHeld = sandbox('slot2', {}, { branch: 'feature/w1', dirty: 2 });
  assert.match((placeFor(w, m([taken, dirtyHeld, s3]), facts([w, n1], { liveIds: ['n1'] })) as { wait: string }).wait, /its branch feature\/w1 is checked out in pc\/slot2, which is in use/);
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

// ---------------------------------------------------------------- w656: sandboxes go back to the pool sooner

test('w656: after its daemon restarted under it, a worker keeps its sandbox half an hour, then a clean one is released', () => {
  const sb = sandbox('slot1');
  const held = (ago: number, over: Partial<SessionInfo> = {}) => worker('w1', { heldSince: iso(NOW - ago), ...over });
  assert.equal(releaseWhy(held(20 * MIN), NOW), undefined, 'within the hold');
  assert.equal(releaseStep(held(20 * MIN), sb, facts([held(20 * MIN)])), undefined);
  assert.equal(holdsSandbox(held(20 * MIN), NOW), true);
  const late = held(31 * MIN);
  assert.equal(holdsSandbox(late, NOW), true, 'past the hold it still keeps its sandbox until it is released');
  assert.deepEqual(releaseStep(late, sb, facts([late])), { do: 'release', why: 'its daemon restarted at 15:29 UTC and it has not resumed within 30 min', branch: 'feature/slot1' });
  // A near check-in still resumes it there; a far one says so.
  assert.equal(releaseStep(held(31 * MIN, { wakeAt: iso(NOW + 10 * MIN) }), sb, facts([late])), undefined);
  assert.match(releaseWhy(held(31 * MIN, { wakeAt: iso(NOW + 3 * 3600_000) }), NOW) ?? '', /^its check-in is 3.0 h away/);
  // Uncommitted work keeps it held, and list_sandboxes says why.
  assert.equal(releaseStep(late, sandbox('slot1', {}, { dirty: 2 }), facts([late])), undefined);
  assert.equal(holdsSandbox({ ...late, placeReleased: { at: iso(NOW), sandbox: 'slot1', branch: 'feature/slot1', why: 'x' } }, NOW), false, 'released: free');
});

test('w656: a worker whose requests are closed releases its sandbox at once, a fresh w613 hold or no check-in included', () => {
  const sb = sandbox('slot1');
  const over = 'its request is closed (w615 done)';
  const held = worker('w1', { heldSince: iso(NOW - 2 * MIN) });
  assert.deepEqual(releaseStep(held, sb, { ...facts([held]), workOver: over }), { do: 'release', why: 'its work is over: its request is closed (w615 done)', branch: 'feature/slot1' });
  const due = worker('w1', { releaseDue: { at: iso(NOW), why: 'stopped while idle: x' } });
  assert.equal(releaseStep(due, sb, { ...facts([due]), workOver: over })?.do, 'release');
  // A stopped worker holding nothing (no check-in, no hold, nothing due) has nothing to release: its sandbox is free already.
  assert.equal(releaseWhy(worker('w1'), NOW, over), undefined);
  assert.equal(holdsSandbox(worker('w1'), NOW), false);
  // A queued message resumes it now: no release.
  assert.equal(releaseWhy(worker('w1', { heldSince: iso(NOW - 2 * MIN), queuedSend: 'slot' }), NOW, over), undefined);
  // Alive and Idle with its work over: stopped at once, its sandbox released once it has stopped.
  const idle = worker('w1', { status: 'idle', lastActivityAt: iso(NOW - MIN) });
  assert.deepEqual(releaseStep(idle, sb, { ...facts([idle], { liveIds: ['w1'] }), workOver: over }), { do: 'stop', why: 'its work is over: its request is closed (w615 done)', due: true });
});

test('w656: stopped workers sharing a sandbox, each with a far check-in or its release due, release it together', () => {
  const sb = sandbox('slot1', { sessionIds: ['a1', 'b2'] });
  const a1 = worker('a1', { wakeAt: iso(NOW + 5 * 3600_000) });
  const b2 = worker('b2', { wakeAt: iso(NOW + 2 * 3600_000) });
  assert.equal(releaseStep(a1, sb, facts([a1, b2]))?.do, 'release', 'b2 is stopped with a far check-in too: it does not keep a1');
  assert.equal(releaseStep(b2, sb, facts([a1, b2]))?.do, 'release');
  const c3 = worker('c3', { releaseDue: { at: iso(NOW), why: 'stopped while idle: idle for 31 min with no check-in' } });
  assert.equal(releaseStep(a1, sb, facts([a1, c3]))?.do, 'release');
  // One whose check-in is near, or whose w613 hold still runs, keeps the sandbox for both.
  const near = worker('b2', { wakeAt: iso(NOW + 10 * MIN) });
  assert.match(keptWhy(a1, sb, facts([a1, near])) ?? '', /agent b2 works there too/);
  const fresh = worker('b2', { heldSince: iso(NOW - 5 * MIN) });
  assert.match(keptWhy(a1, sb, facts([a1, fresh])) ?? '', /agent b2 works there too/);
  // Each is placed again on their shared branch: the second joins the first there.
  const w = worker('b2', { placeReleased: { at: iso(NOW), sandbox: 'slot1', branch: 'feature/slot1', why: 'far' } });
  const back = worker('a1', { status: 'idle' });
  const p = placeFor(w, { id: 'pc', sandboxes: [sb, sandbox('slot2', {}, { dirty: 1 })] }, facts([w, back], { liveIds: ['a1'] }));
  assert.equal((p as { sandbox: MachineSandbox }).sandbox.id, 'slot1');
});

test('w656: an Idle worker with nothing pending is stopped after half an hour, then its clean sandbox is released', () => {
  const sb = sandbox('slot1');
  const idle = (ago: number) => worker('w1', { status: 'idle', lastActivityAt: iso(NOW - ago) });
  assert.equal(releaseStep(idle(20 * MIN), sb, facts([idle(20 * MIN)], { liveIds: ['w1'] })), undefined, 'recently active');
  const w = idle(RELEASE_AFTER_MS + MIN);
  assert.deepEqual(releaseStep(w, sb, facts([w], { liveIds: ['w1'] })), { do: 'stop', why: 'idle for 31 min with no check-in', due: true });
  // Something keeps it: unanswered messages or background tasks, uncommitted changes (keepLive), a permission, a queued message.
  assert.equal(releaseStep(w, sb, { ...facts([w], { liveIds: ['w1'] }), keepLive: 'its sandbox has 2 uncommitted change(s)' }), undefined);
  assert.equal(releaseStep({ ...w, queuedSend: 'x' }, sb, facts([w], { liveIds: ['w1'] })), undefined);
  assert.equal(releaseStep({ ...w, pendingPermissions: [{ requestId: 'r', toolName: 'Bash', input: {} } as unknown as SessionInfo['pendingPermissions'][number]] }, sb, facts([w], { liveIds: ['w1'] })), undefined);
  // Stopped with its release due: its sandbox is its until the pass releases it.
  const due = worker('w1', { releaseDue: { at: iso(NOW), why: 'idle for 31 min with no check-in' } });
  assert.equal(holdsSandbox(due, NOW), true);
  assert.equal(holdsItsPlace(due, NOW), false, 'nothing resumes it by itself: the ledger does not count it as coming back');
  assert.deepEqual(releaseStep(due, sb, facts([due])), { do: 'release', why: 'idle for 31 min with no check-in', branch: 'feature/slot1' });
  assert.equal(releaseStep(due, sandbox('slot1', {}, { untracked: 1 }), facts([due])), undefined, 'nothing is lost: untracked files keep it');
});

test('w656: the release pass marks what it stops, releases, clears the holds, says why one stays held, and tells the dispatcher', () => {
  const a = worker('a1', { status: 'idle', lastActivityAt: iso(NOW - 40 * MIN) });
  const b = worker('b2', { machineSandbox: 'slot2', heldSince: iso(NOW - 45 * MIN) });
  const c = worker('c3', { machineSandbox: 'slot3', heldSince: iso(NOW - 45 * MIN) });
  const machine = { id: 'pc', sandboxes: [sandbox('slot1', { sessionIds: ['a1'] }), sandbox('slot2', { sessionIds: ['b2'] }), sandbox('slot3', { sessionIds: ['c3'] }, { dirty: 3 })] } as unknown as Machine;
  const live = new Set(['a1']);
  const stopped: string[] = [];
  const freed: string[] = [];
  const notes: string[] = [];
  const p = new PlaceAgain({
    sessions: () => [a, b, c],
    machine: () => machine,
    isLive: (id) => live.has(id),
    online: () => true,
    unityHolders: () => [],
    workOver: () => undefined,
    keepLive: () => undefined,
    queued: () => false,
    stopLive: (id) => void stopped.push(id),
    stopEditor: async () => undefined,
    switchBranch: async () => ({ notes: [] }),
    save: () => undefined,
    saveMachine: () => undefined,
    note: (_id, text) => void notes.push(text),
    drain: () => undefined,
    freed: (what) => void freed.push(what),
    now: () => NOW,
  });
  const did = p.tick();
  assert.deepEqual(stopped, ['a1']);
  assert.equal(a.releaseDue?.why, 'idle for 40 min with no check-in');
  assert.equal(b.placeReleased?.why, 'its daemon restarted at 15:15 UTC and it has not resumed within 30 min');
  assert.equal(b.heldSince, undefined);
  assert.equal(c.placeReleased, undefined, 'uncommitted changes keep it held');
  assert.equal(p.keptLine(c), 'its sandbox stays held although its daemon restarted at 15:15 UTC and it has not resumed within 30 min: 3 uncommitted change(s) there');
  assert.deepEqual(freed, ['sandbox pc/slot2 released']);
  assert.equal(did.length, 2);
  // a1 has stopped: the next pass releases its sandbox.
  live.delete('a1');
  a.status = 'stopped';
  p.tick();
  assert.equal(a.placeReleased?.why, 'idle for 40 min with no check-in');
  assert.equal(a.releaseDue, undefined);
  assert.deepEqual(freed, ['sandbox pc/slot2 released', 'sandbox pc/slot1 released']);
});

test('w656: a dirty sandbox is saved by its daemon first, then released for every stopped worker there; a failed save keeps it held', async () => {
  const sb = sandbox('slot1', { sessionIds: ['a1', 'b2'] }, { dirty: 2, untracked: 1 });
  const a = worker('a1', { heldSince: iso(NOW - 45 * MIN) });
  const b = worker('b2', { wakeAt: iso(NOW + 5 * 3600_000) });
  // What decides: an older daemon cannot save, a save that just failed says why, one that can goes ahead.
  assert.match(keptWhy(a, sb, { ...facts([a, b]), canSave: false }) ?? '', /^2 uncommitted change\(s\) there \(FF Factory saves them before a release once this machine's daemon is updated\)$/);
  assert.equal(keptWhy(a, sb, { ...facts([a, b]), canSave: true }), undefined);
  assert.match(keptWhy(a, sb, { ...facts([a, b]), canSave: true, saveRefused: () => '41491 untracked files there' }) ?? '', /^its uncommitted work could not be saved: 41491 untracked files there$/);
  assert.deepEqual(releaseStep(a, sb, { ...facts([a, b]), canSave: true }), { do: 'release', why: 'its daemon restarted at 15:15 UTC and it has not resumed within 30 min', branch: 'feature/slot1', save: true });

  const machine = { id: 'pc', sandboxes: [sb] } as unknown as Machine;
  let answer: () => Promise<{ sha?: string; files: number; pushed: boolean; notes: string[] }> = async () => {
    throw new Error('41491 untracked files there, more than the 500 a save commits');
  };
  const saves: string[] = [];
  const notes: string[] = [];
  const freed: string[] = [];
  const p = new PlaceAgain({
    sessions: () => [a, b],
    machine: () => machine,
    isLive: () => false,
    online: () => true,
    unityHolders: () => [],
    workOver: () => undefined,
    keepLive: () => undefined,
    queued: () => false,
    stopLive: () => undefined,
    stopEditor: async () => undefined,
    switchBranch: async () => ({ notes: [] }),
    save: () => undefined,
    saveMachine: () => undefined,
    note: (id, text) => void notes.push(`${id}: ${text}`),
    drain: () => undefined,
    freed: (what) => void freed.push(what),
    canSave: () => true,
    saveWork: async (m, s, branch, message) => (saves.push(`${m}/${s} ${branch}: ${message.split('\n')[0]}`), answer()),
    now: () => NOW,
  });
  p.tick();
  p.tick();
  await Promise.all(p.pending);
  assert.deepEqual(saves, ["pc/slot1 feature/slot1: FF Factory: saved a1's uncommitted work before releasing pc/slot1 (w656)"], 'one save at a time per sandbox');
  assert.equal(a.placeReleased, undefined, 'a failed save keeps it held');
  assert.equal(p.keptLine(a), 'its sandbox stays held although its daemon restarted at 15:15 UTC and it has not resumed within 30 min: its uncommitted work could not be saved: 41491 untracked files there, more than the 500 a save commits');
  assert.equal(notes.length, 1);
  p.tick();
  await Promise.all(p.pending);
  assert.equal(saves.length, 1, 'not tried again within RETRY_FAILED_MS');

  // Saved: both stopped workers release it, each told what was saved; the dispatcher hears capacity may have freed.
  answer = async () => ({ sha: 'abc1234', files: 3, pushed: true, notes: ['committed 3 file(s) on feature/slot1 as abc1234', 'pushed feature/slot1'] });
  const later = new PlaceAgain({ ...(p as unknown as { d: ConstructorParameters<typeof PlaceAgain>[0] }).d });
  later.tick();
  await Promise.all(later.pending);
  assert.equal(saves.length, 2);
  for (const w of [a, b]) {
    assert.equal(w.placeReleased?.branch, 'feature/slot1', w.id);
    assert.deepEqual(w.savedWork, { sha: 'abc1234', files: 3, pushed: true, branch: 'feature/slot1', at: iso(NOW) });
  }
  assert.equal(a.heldSince, undefined);
  assert.match(b.placeReleased!.why, /^its check-in is 5.0 h away/);
  assert.deepEqual(freed, ['sandbox pc/slot1 released']);
  assert.match(notes.at(-1)!, /^b2: Its uncommitted work in pc\/slot1 was saved \(committed 3 file\(s\) on feature\/slot1 as abc1234; pushed feature\/slot1\)/);
  // It hears so when it resumes.
  assert.match(savedNote(a.savedWork!), /^\[saved\] While you were stopped, FF Factory committed your uncommitted work \(3 file\(s\), new ones included\) on your branch `feature\/slot1` as abc1234, and pushed it/);
  assert.match(savedNote(a.savedWork!), /`git reset HEAD~1` gives it back uncommitted/);
});

// ---------------------------------------------------------------- w846: a worker waiting on CI gives up its sandbox

test("w846: a worker waiting on CI with its editor stopped gives up its sandbox at once, branch kept; never with its editor on, a batch run in flight or commits not pushed; it stays released while CI runs and is placed again after, green or red", () => {
  const ci = 'it waits on CI (w836: CI on Final-Factory/FinalFactory#1354)';
  const sb = sandbox('slot1');
  const withCi = (f: PlaceFacts) => ({ ...f, ciWait: ci });
  // Stopped, its check-in cancelled by the block (w829 holds it): released now, not after 30 minutes, on its branch.
  const w = worker('w1');
  assert.equal(releaseStep(w, sb, facts([w])), undefined, 'without the CI gate it holds nothing to release');
  assert.deepEqual(releaseStep(w, sb, withCi(facts([w]))), { do: 'release', why: ci, branch: 'feature/slot1' });
  // A near check-in of its own (a poll it set anyway) does not keep it: the check-in places it again when it comes.
  const polling = worker('w1', { wakeAt: iso(NOW + 8 * MIN) });
  assert.equal(releaseStep(polling, sb, facts([polling])), undefined, 'today: an 8-minute poll holds the sandbox');
  assert.equal(releaseStep(polling, sb, withCi(facts([polling])))?.do, 'release');
  // Never with its editor on (lothsahn: "with their unity editors off"), a batch run of its in flight, or commits not pushed.
  for (const state of ['running', 'starting', 'crashed'] as const) assert.equal(releaseStep(w, sandbox('slot1', { unity: { state } }), withCi(facts([w]))), undefined, `editor ${state}`);
  assert.equal(releaseStep(w, sb, withCi(facts([w], { unityHolders: ['sandbox:slot1'] }))), undefined, 'batch run');
  assert.equal(releaseStep(w, sandbox('slot1', {}, { ahead: 2 }), withCi(facts([w]))), undefined, '2 commits its remote lacks');
  // Uncommitted work: its daemon commits and pushes it first (w656), or it stays held.
  assert.deepEqual(releaseStep(w, sandbox('slot1', {}, { dirty: 1 }), { ...withCi(facts([w])), canSave: true }), { do: 'release', why: ci, branch: 'feature/slot1', save: true });
  assert.equal(releaseStep(w, sandbox('slot1', {}, { dirty: 1 }), withCi(facts([w]))), undefined);
  // A message queued for it resumes it now: kept.
  assert.equal(releaseStep(worker('w1', { queuedSend: 'x' }), sb, withCi(facts([w]))), undefined);
  // Alive between turns: Idle, or with a near poll, it is stopped first (due), and the next pass releases it; editor on, never.
  const idle = worker('w1', { status: 'idle', lastActivityAt: iso(NOW - 2 * MIN) });
  assert.equal(releaseStep(idle, sb, facts([idle], { liveIds: ['w1'] })), undefined, 'idle 2 min, no CI gate: kept');
  assert.deepEqual(releaseStep(idle, sb, withCi(facts([idle], { liveIds: ['w1'] }))), { do: 'stop', why: ci, due: true });
  const poll = worker('w1', { status: 'idle', wakeAt: iso(NOW + 8 * MIN), lastActivityAt: iso(NOW - 2 * MIN) });
  assert.deepEqual(releaseStep(poll, sb, withCi(facts([poll], { liveIds: ['w1'] }))), { do: 'stop', why: ci, due: true });
  assert.equal(releaseStep(idle, sandbox('slot1', { unity: { state: 'running' } }), withCi(facts([idle], { liveIds: ['w1'] }))), undefined, 'editor on: not even stopped');
  assert.equal(releaseStep(worker('w1', { status: 'running' }), sb, withCi(facts([idle], { liveIds: ['w1'] }))), undefined, 'mid-turn');
  // Released: while CI runs it does not take its sandbox back, even with a check-in near.
  const rel = worker('w1', { wakeAt: iso(NOW + MIN), placeReleased: { at: iso(NOW - 20 * MIN), sandbox: 'slot1', branch: 'feature/slot1', why: ci } });
  assert.equal(releaseStep(rel, sb, withCi(facts([rel]))), undefined);
  // CI finished (green or red, the gate clears either way) and its resume is near: back to its own sandbox, still free.
  assert.deepEqual(releaseStep(rel, sb, facts([rel])), { do: 'reclaim' });
  // Its own took other work meanwhile: placed in another free one on this machine, switched to its branch (red: to fix it there).
  const other = worker('o1', { status: 'idle' });
  const m = { id: 'pc', sandboxes: [sandbox('slot1', {}, { branch: 'sandbox/slot1-new' }), sandbox('slot2', {}, { branch: 'sandbox/slot2-x' })] };
  const p = placeFor(rel, m, facts([rel, other], { liveIds: ['o1'] }));
  assert.ok('sandbox' in p && p.sandbox.id === 'slot2', JSON.stringify(p));
  assert.equal(rel.placeReleased!.branch, 'feature/slot1', 'its branch is what it is placed on');
});
