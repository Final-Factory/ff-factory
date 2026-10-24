import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_HOLD_MS, PlaceAgain, RELEASE_AFTER_MS, farWhy, keptWhy, liveLostNote, movedNote, placeFor, releaseStep, releaseWhy, releasedOn, savedNote, waitReleaseWhy, type PlaceFacts } from './placeAgain.ts';
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
  ...(o.canSave !== undefined ? { canSave: o.canSave } : {}),
  ...(o.saveRefused ? { saveRefused: o.saveRefused } : {}),
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
  // w1983: a daemon that saves reads it itself in the save (lothdesktop/slot5, 2026-10-24: unread 10 min after its worker stopped).
  const unread = sandbox('slot1', { git: undefined });
  assert.equal(keptWhy(w, unread, facts([w], { canSave: true })), undefined);
  assert.deepEqual(releaseStep(w, unread, facts([w], { canSave: true })), { do: 'release', why: 'its check-in is 9.0 h away, at tomorrow 01:00 UTC', branch: unread.branch, save: true });
  assert.match(keptWhy(w, unread, facts([w], { canSave: true, saveRefused: () => 'git status failed' })) ?? '', /could not be saved: git status failed/);
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
  // w1099: with an order (Agents.resumeOrder: its request's priority, then age), b2 on a high request goes first.
  const byPriority = new PlaceAgain({ ...(p as unknown as { d: ConstructorParameters<typeof PlaceAgain>[0] }).d, order: (x, y) => (x.id === 'b2' ? -1 : y.id === 'b2' ? 1 : 0) });
  assert.equal(byPriority.claimedBy('pc', 'slot2'), 'b2');
  assert.deepEqual(byPriority.waiting('pc'), ['a1']);
  // The worker learns where it is now from its next message.
  const note = movedNote({ id: 'pc' }, { sandbox: 'slot1', path: 'D:\\ffsb\\slot1', at: iso(NOW), why: 'its check-in is 9.0 h away', branch: 'feature/a1' }, { id: 'slot2', path: 'D:\\ffsb\\slot2' });
  assert.match(note, /^\[moved\] While you were stopped your sandbox pc\/slot1 went to other work/);
  assert.match(note, /You work in sandbox pc\/slot2 now: `D:\\ffsb\\slot2`, on your branch `feature\/a1`/);
  assert.match(note, /`slot2@[0-9a-f]{8}`\): set_active_instance again with that name/);
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

// ---------------------------------------------------------------- w890: a worker waiting on a deploy or a person gives up its sandbox at once

// What Agents.waitOn says for each kind of wait (server/orchestrators.test.ts builds them from the ledger).
const WAITS = {
  deploy: 'it waits on w889: a portal deploy, after the merge',
  person: 'it waits on w889: Ben to act',
  request: 'it waits on w889: w633 finishing',
  pr: 'it waits on w889: PR Final-Factory/ff-factory#281 merging',
};

for (const [kind, wait] of Object.entries(WAITS)) {
  test(`w890: a worker that ends its turn waiting on ${kind} frees its sandbox at once, whatever its check-in; it is stopped first when alive, and stays released until it resumes`, () => {
    const sb = sandbox('slot1');
    const withWait = (f: PlaceFacts) => ({ ...f, waitOn: wait });
    // Stopped: released now, not after 30 minutes, on its branch; a near poll of its own does not keep it.
    const w = worker('w1');
    assert.equal(releaseStep(w, sb, facts([w])), undefined, 'without the wait it holds nothing to release');
    assert.deepEqual(releaseStep(w, sb, withWait(facts([w]))), { do: 'release', why: wait, branch: 'feature/slot1' });
    const polling = worker('w1', { wakeAt: iso(NOW + 8 * MIN) });
    assert.equal(releaseStep(polling, sb, withWait(facts([polling])))?.do, 'release');
    // An editor left running does not keep it (nothing is about to be fixed in it; the next placement stops it, w656).
    assert.equal(releaseStep(w, sandbox('slot1', { unity: { state: 'running' } }), withWait(facts([w])))?.do, 'release');
    // Alive and Idle the minute its turn ended: stopped (due), the next pass releases it. No 30-minute idle wait.
    const idle = worker('w1', { status: 'idle', lastActivityAt: iso(NOW - MIN) });
    assert.equal(releaseStep(idle, sb, facts([idle], { liveIds: ['w1'] })), undefined, 'idle 1 min, no wait: kept');
    assert.deepEqual(releaseStep(idle, sb, withWait(facts([idle], { liveIds: ['w1'] }))), { do: 'stop', why: wait, due: true });
    const poll = worker('w1', { status: 'idle', wakeAt: iso(NOW + 8 * MIN), lastActivityAt: iso(NOW - MIN) });
    assert.deepEqual(releaseStep(poll, sb, withWait(facts([poll], { liveIds: ['w1'] }))), { do: 'stop', why: wait, due: true });
    // Released: it does not take its sandbox back for a near check-in while it waits; once the wait ends it does as before.
    const rel = worker('w1', { wakeAt: iso(NOW + MIN), placeReleased: { at: iso(NOW - 20 * MIN), sandbox: 'slot1', branch: 'feature/slot1', why: wait } });
    assert.equal(releaseStep(rel, sb, withWait(facts([rel]))), undefined);
    assert.deepEqual(releaseStep(rel, sb, facts([rel])), { do: 'reclaim' });
  });
}

test('w890: never released: unsaved work, commits no remote has, a batch run, a message waiting, a worker mid-turn or with work it needs, a permission open, or a wait that is a time or a machine', () => {
  const wait = WAITS.deploy;
  const withWait = (f: PlaceFacts) => ({ ...f, waitOn: wait });
  const w = worker('w1');
  const sb = sandbox('slot1');
  // Unsaved work: its daemon commits and pushes it first (w656), or the sandbox stays held and says why.
  assert.deepEqual(releaseStep(w, sandbox('slot1', {}, { dirty: 1 }), { ...withWait(facts([w])), canSave: true }), { do: 'release', why: wait, branch: 'feature/slot1', save: true });
  assert.deepEqual(releaseStep(w, sandbox('slot1', {}, { untracked: 2 }), { ...withWait(facts([w])), canSave: true }), { do: 'release', why: wait, branch: 'feature/slot1', save: true });
  assert.equal(releaseStep(w, sandbox('slot1', {}, { dirty: 1 }), withWait(facts([w]))), undefined, 'its daemon cannot save: held');
  assert.equal(releaseStep(w, sandbox('slot1', {}, { dirty: 1 }), { ...withWait(facts([w])), canSave: true, saveRefused: () => '41491 untracked files' }), undefined, 'its last save failed: held');
  assert.match(new PlaceAgain(deps([w], sandbox('slot1', {}, { dirty: 1 }), { waitOn: () => wait })).keptLine(w) ?? '', /^its sandbox stays held although it waits on w889: a portal deploy, after the merge: 1 uncommitted change\(s\) there/);
  // Its PR merged or pushed: a commit its remote lacks keeps it (a branch with no upstream reads 0, as for CI).
  assert.equal(releaseStep(w, sandbox('slot1', {}, { ahead: 1 }), withWait(facts([w]))), undefined);
  assert.equal(waitReleaseWhy(sandbox('slot1', {}, { ahead: 3 }), wait), undefined);
  assert.equal(waitReleaseWhy(sb, undefined), undefined);
  // A git state older than its last work, or no git state, or the sandbox not ready.
  assert.equal(releaseStep(w, sandbox('slot1', {}, { at: iso(NOW - 30 * MIN) }), withWait(facts([w]))), undefined);
  assert.equal(releaseStep(w, sandbox('slot1', { git: undefined }), withWait(facts([w]))), undefined);
  assert.equal(releaseStep(w, sandbox('slot1', { status: 'creating' }), withWait(facts([w]))), undefined);
  // A Unity batch run of that sandbox in flight, or another agent working there.
  assert.equal(releaseStep(w, sb, withWait(facts([w], { unityHolders: ['sandbox:slot1'] }))), undefined, 'batch run');
  const other = worker('o1', { status: 'idle' });
  assert.equal(releaseStep(w, sb, withWait(facts([w, other], { liveIds: ['o1'] }))), undefined, 'another agent works there');
  // A message queued for it resumes it now.
  assert.equal(releaseStep(worker('w1', { queuedSend: 'x' }), sb, withWait(facts([w]))), undefined);
  // Mid-turn (running, starting, a permission open): not stopped, not released.
  for (const status of ['running', 'starting', 'waiting_permission'] as const) {
    const busy = worker('w1', { status });
    assert.equal(releaseStep(busy, sb, withWait(facts([busy], { liveIds: ['w1'] }))), undefined, status);
  }
  const asking = worker('w1', { status: 'stopped', pendingPermissions: [{ id: 'p', toolName: 'Bash', input: {}, at: iso(NOW) } as never] });
  assert.equal(releaseStep(asking, sb, withWait(facts([asking]))), undefined, 'a permission open');
  // A live worker with a job or unanswered work it needs (keepLive), or with a job running (between turns): kept alive.
  const idle = worker('w1', { status: 'idle', lastActivityAt: iso(NOW - MIN) });
  assert.equal(releaseStep(idle, sb, { ...withWait(facts([idle], { liveIds: ['w1'] })), keepLive: 'it has unanswered messages or background tasks' }), undefined);
  const job = worker('w1', { status: 'idle', backgroundTasks: 1, lastActivityAt: iso(NOW - MIN) });
  assert.equal(releaseStep(job, sb, withWait(facts([job], { liveIds: ['w1'] }))), undefined, 'a running job is work in progress');
  // No wait, no release: a time, a machine, a lock or a usage limit never reach waitOn (Agents.waitOn), so it holds as before.
  assert.equal(releaseStep(idle, sb, facts([idle], { liveIds: ['w1'] })), undefined);
  assert.equal(releaseStep(w, sb, facts([w])), undefined);
});

test('w890: the release pass schedules the next pass at once when it stops a worker to release its sandbox, so the sandbox frees within a minute of the turn end', () => {
  const a = worker('a1', { status: 'idle', lastActivityAt: iso(NOW - MIN) });
  const live = new Set(['a1']);
  let soon = 0;
  const freed: string[] = [];
  const machine = { id: 'pc', sandboxes: [sandbox('slot1', { sessionIds: ['a1'] })] } as unknown as Machine;
  const p = new PlaceAgain({
    sessions: () => [a],
    machine: () => machine,
    isLive: (id) => live.has(id),
    online: () => true,
    unityHolders: () => [],
    workOver: () => undefined,
    waitOn: () => WAITS.deploy,
    keepLive: () => undefined,
    queued: () => false,
    stopLive: (id) => {
      live.delete(id);
      a.status = 'stopped';
    },
    stopEditor: async () => undefined,
    switchBranch: async () => ({ notes: [] }),
    save: () => undefined,
    saveMachine: () => undefined,
    note: () => undefined,
    drain: () => undefined,
    freed: (what) => void freed.push(what),
    soon: () => void soon++,
    now: () => NOW,
  });
  assert.match(p.tick().join('\n'), /^stopped a1 \(it waits on w889: a portal deploy, after the merge\)/);
  assert.equal(soon, 1);
  assert.equal(a.releaseDue?.why, WAITS.deploy);
  // The follow-up pass releases it; nothing more to schedule.
  assert.match(p.tick().join('\n'), /released pc\/slot1 of a1/);
  assert.equal(soon, 1);
  assert.equal(a.placeReleased?.why, WAITS.deploy);
  assert.deepEqual(freed, ['sandbox pc/slot1 released']);
  // A wait that ended while it was released: a message places it again, as any released worker.
  assert.equal(p.keptLine(a), undefined);
});

/** The dependencies of a PlaceAgain with one machine and the given workers' sandbox, for the tests that read keptLine. */
function deps(sessions: SessionInfo[], sb: MachineSandbox, o: Partial<ConstructorParameters<typeof PlaceAgain>[0]> = {}): ConstructorParameters<typeof PlaceAgain>[0] {
  return {
    sessions: () => sessions,
    machine: () => ({ id: 'pc', sandboxes: [sb] }) as unknown as Machine,
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
    note: () => undefined,
    drain: () => undefined,
    now: () => NOW,
    ...o,
  };
}

test("w890 (measured live): the stop's own transcript line does not make the git state stale, so a stopped worker's sandbox is released on the next pass, not after the daemon's next 2-minute git read", () => {
  const wait = WAITS.deploy;
  // Live, 2026-10-10: stopped 19:29:40Z, released 19:31:40Z. The stop wrote a line (lastActivityAt 19:29:41), the git state
  // read at 19:29:00 was "older than the last activity", and the pass waited for the next read.
  const worked = iso(NOW - 3 * MIN);
  const stoppedAt = iso(NOW - 5_000);
  const git = { at: iso(NOW - MIN) };
  const w = worker('w1', { lastActivityAt: stoppedAt, releaseDue: { at: iso(NOW - 10_000), why: wait, workedAt: worked } });
  assert.deepEqual(releaseStep(w, sandbox('slot1', {}, git), { ...facts([w]), waitOn: wait }), { do: 'release', why: wait, branch: 'feature/slot1' });
  // Without the record (an older release due, or work after it) the old rule holds.
  const plain = worker('w1', { lastActivityAt: stoppedAt, releaseDue: { at: iso(NOW - 10_000), why: wait } });
  assert.equal(releaseStep(plain, sandbox('slot1', {}, git), { ...facts([plain]), waitOn: wait }), undefined);
  // And git read before the work itself is still stale.
  assert.equal(releaseStep(w, sandbox('slot1', {}, { at: iso(NOW - 4 * MIN) }), { ...facts([w]), waitOn: wait }), undefined);
  // The pass records the last work when it stops a worker.
  const a = worker('a1', { status: 'idle', lastActivityAt: worked });
  const p = new PlaceAgain(deps([a], sandbox('slot1', { sessionIds: ['a1'] }), { isLive: () => true, waitOn: () => wait }));
  p.tick();
  assert.equal(a.releaseDue?.workedAt, worked);
});

test('w1089: no capacity ping for a sandbox that is taken again: an agent started in it while its daemon saved the work, or another working there, keeps it from being announced as released', async () => {
  // slot1: a1 (stopped, held) released after a save; during the save a new worker c3 starts in the same sandbox and runs.
  const sb = sandbox('slot1', { sessionIds: ['a1'] }, { dirty: 2 });
  const a = worker('a1', { heldSince: iso(NOW - 45 * MIN) });
  const c = worker('c3', { status: 'running' });
  const sessions: SessionInfo[] = [a];
  const live = new Set<string>();
  const machine = { id: 'pc', sandboxes: [sb] } as unknown as Machine;
  const freed: string[] = [];
  const p = new PlaceAgain({
    sessions: () => sessions,
    machine: () => machine,
    isLive: (id) => live.has(id),
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
    note: () => undefined,
    drain: () => undefined,
    freed: (what) => void freed.push(what),
    canSave: () => true,
    saveWork: async () => {
      // The dispatcher puts the next worker in the sandbox while the commit and push run.
      sessions.push(c);
      live.add('c3');
      return { sha: 'abc1234', files: 2, pushed: true, notes: ['committed 2 file(s)'] };
    },
    now: () => NOW,
  });
  p.tick();
  await Promise.all(p.pending);
  assert.equal(a.placeReleased?.branch, 'feature/slot1', 'a1 itself is released');
  assert.deepEqual(freed, [], 'but the sandbox is not free: c3 works in it, so the dispatcher is not told it freed');

  // The plain path (no save) also checks the sandbox is free after the pass: two stopped workers, the second one's sandbox shared with a live agent.
  const sbB = sandbox('slot2', { sessionIds: ['b2', 'd4'] });
  const b = worker('b2', { machineSandbox: 'slot2', heldSince: iso(NOW - 45 * MIN) });
  const d = worker('d4', { machineSandbox: 'slot2', status: 'running' });
  const live2 = new Set(['d4']);
  const freed2: string[] = [];
  const q = new PlaceAgain({
    sessions: () => [b, d],
    machine: () => ({ id: 'pc', sandboxes: [sbB] }) as unknown as Machine,
    isLive: (id) => live2.has(id),
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
    note: () => undefined,
    drain: () => undefined,
    freed: (what) => void freed2.push(what),
    now: () => NOW,
  });
  q.tick();
  assert.equal(b.placeReleased, undefined, 'a live agent there keeps the sandbox held (keptWhy), as before');
  assert.deepEqual(freed2, []);
});

// ---------------------------------------------------------------- w1135: work that is not the game's resumes on an agent seat

test('w1135: a released worker on work that is not the game\'s (b3327616, ff-factory work) resumes at once on an agent seat beside another agent, claims no game sandbox and switches nothing; it waits only when every sandbox is full', () => {
  const b = worker('b33', { machineSandbox: 'slot5', placeReleased: { at: iso(NOW), sandbox: 'slot5', branch: 'sandbox/slot1-w1063', why: 'it waits on lothsahn: deploy the portal' } });
  const g = worker('g1', { placeReleased: { at: iso(NOW), sandbox: 'slot9', branch: 'feature/g1', why: 'far' } });
  // Every sandbox has one agent working in it (lothdesktop at 15:36Z: 6 of 6 sandboxes in use, 3 of 10 agents mid-turn).
  const a5 = worker('a5', { machineSandbox: 'slot5', status: 'running' });
  const a6 = worker('a6', { machineSandbox: 'slot6', status: 'running' });
  const machine = { id: 'pc', sandboxes: [sandbox('slot5', { sessionIds: ['a5'] }, { branch: 'sandbox/slot5-w1134' }), sandbox('slot6', { sessionIds: ['a6'] })] } as unknown as Machine;
  const switched: string[] = [];
  const stopped: string[] = [];
  const notes: string[] = [];
  const d: ConstructorParameters<typeof PlaceAgain>[0] = {
    sessions: () => [b, g, a5, a6],
    machine: () => machine,
    isLive: (id) => id === 'a5' || id === 'a6',
    online: () => true,
    unityHolders: () => [],
    workOver: () => undefined,
    keepLive: () => undefined,
    queued: (id) => id === 'b33' || id === 'g1',
    stopLive: () => undefined,
    stopEditor: async (_m, sb) => void stopped.push(sb),
    switchBranch: async (_m, branch, sb) => (switched.push(`${sb}:${branch}`), { notes: [] }),
    save: () => undefined,
    saveMachine: () => undefined,
    note: (_id, text) => void notes.push(text),
    drain: () => undefined,
    now: () => NOW,
  };
  // Before (every worker is game work): it waits for a game sandbox, and counts as waiting for one.
  const before = new PlaceAgain(d);
  assert.match(before.answer({ ...b }) ?? '', /no sandbox on pc is free/);
  assert.deepEqual(before.waiting('pc'), ['b33', 'g1']);
  const p = new PlaceAgain({ ...d, agentOnly: (s) => s.id === 'b33', seats: () => 2 });
  assert.deepEqual(p.waiting('pc'), ['g1'], 'it waits for no sandbox; the game worker still does');
  assert.equal(p.answer(b), undefined, 'the bug: it waited for a free sandbox while seats were free');
  assert.equal(b.placeReleased, undefined);
  assert.equal(b.machineSandbox, 'slot5', 'its own sandbox has a seat: beside a5');
  assert.deepEqual([switched, stopped], [[], []], "nothing is switched or stopped: a5's game tree stays a5's");
  assert.equal(b.movedFrom?.shared, true);
  assert.match(notes.at(-1) ?? '', /on an agent seat in pc\/slot5, beside the agent there/);
  const said = movedNote({ id: 'pc' }, b.movedFrom!, { id: 'slot5', path: 'D:\\ffsb\\slot5' });
  assert.match(said, /needs only an agent seat, not a free sandbox \(w1098\)\. You resume in it again, beside the agent that works there now\./);
  assert.match(said, /do not edit, commit, stash, switch branches or start Unity there/);
  assert.match(said, /your game branch `sandbox\/slot1-w1063` is untouched/);
  // Its own sandbox full (2 agents): the one with a seat. Every sandbox full: it waits for a seat.
  const c = worker('c', { machineSandbox: 'slot5', placeReleased: { at: iso(NOW), sandbox: 'slot5', branch: 'b/c', why: 'far' } });
  const a5b = worker('a5b', { machineSandbox: 'slot5', status: 'running' });
  const q = new PlaceAgain({ ...d, sessions: () => [c, a5, a5b, a6], isLive: (id) => id !== 'c', agentOnly: () => true, seats: () => 2 });
  assert.equal(q.answer(c), undefined);
  assert.equal(c.machineSandbox, 'slot6');
  const e = worker('e', { machineSandbox: 'slot5', placeReleased: { at: iso(NOW), sandbox: 'slot5', branch: 'b/e', why: 'far' } });
  const a6b = worker('a6b', { machineSandbox: 'slot6', status: 'running' });
  const full = new PlaceAgain({ ...d, sessions: () => [e, a5, a5b, a6, a6b], isLive: (id) => id !== 'e', agentOnly: () => true, seats: () => 2 });
  assert.match(full.answer(e) ?? '', /no agent seat is free on pc/);
});

// ---------------------------------------------------------------- w1582: a Live view keeps its worker staged while it waits on a person

test('w1582: a worker whose Live view is up while it waits on Ben is neither stopped nor released; without the hold the w890 release goes ahead', () => {
  const wait = WAITS.person;
  const hold = 'its Live view is up while it waits on Ben (w1582: held for 12 h after its last activity)';
  const sb = sandbox('slot1', { unity: { state: 'running' } });
  // Live, 2026-10-19 (portal journal): c522aec6 (w1465) declared its wait on Ben at 19:29Z, was stopped at 19:35Z and its
  // sandbox released at 19:39Z, with Ben's Live view on it. The same worker, idle, with and without the hold:
  const idle = worker('w1', { status: 'idle', lastActivityAt: iso(NOW - 6 * MIN) });
  assert.deepEqual(releaseStep(idle, sb, { ...facts([idle], { liveIds: ['w1'] }), waitOn: wait }), { do: 'stop', why: wait, due: true }, 'before w1582: stopped');
  assert.equal(releaseStep(idle, sb, { ...facts([idle], { liveIds: ['w1'] }), waitOn: wait, liveHold: hold }), undefined, 'held: not stopped');
  const stopped = worker('w1');
  assert.deepEqual(releaseStep(stopped, sb, { ...facts([stopped]), waitOn: wait }), { do: 'release', why: wait, branch: 'feature/slot1' });
  assert.equal(releaseStep(stopped, sb, { ...facts([stopped]), waitOn: wait, liveHold: hold }), undefined, 'held: not released');
  // keptLine says why, for list_sandboxes.
  assert.equal(new PlaceAgain(deps([stopped], sb, { waitOn: () => wait, liveHold: () => hold })).keptLine(stopped), `its sandbox stays held although ${wait}: ${hold}`);
});

test('w1582: the release pass ends the Live view of a released worker, and of a stopped one past the hold; a held one keeps it', () => {
  const lost: string[] = [];
  const liveLost = (s: SessionInfo, why: string) => void lost.push(`${s.id}: ${why}`);
  // Released with its view still up (as the four were on 2026-10-19): the view ends, so it never shows the next worker's game.
  const rel = worker('r1', { placeReleased: { at: iso(NOW - 20 * MIN), sandbox: 'slot1', branch: 'feature/slot1', why: WAITS.person } });
  new PlaceAgain(deps([rel], sandbox('slot1'), { liveLost })).tick();
  assert.deepEqual(lost, [`r1: ${WAITS.person}`]);
  // Released by this pass: the view ends with the release.
  lost.length = 0;
  const w = worker('w1');
  const p = new PlaceAgain(deps([w], sandbox('slot1', { sessionIds: ['w1'] }), { waitOn: () => WAITS.person, liveLost }));
  assert.match(p.tick().join('\n'), /released pc\/slot1 of w1/);
  assert.deepEqual(lost, [`w1: ${WAITS.person}`]);
  // Stopped, its sandbox still its (unsaved work), nobody back within the hold: it ends, so the editor may idle-stop.
  lost.length = 0;
  const old = worker('o1', { lastActivityAt: iso(NOW - LIVE_HOLD_MS - MIN) });
  new PlaceAgain(deps([old], sandbox('slot1', {}, { dirty: 1 }), { liveLost })).tick();
  assert.deepEqual(lost, ['o1: nobody came back to it within 12 h']);
  // Held: the view stays.
  lost.length = 0;
  const held = worker('h1', { lastActivityAt: iso(NOW - 2 * 3600_000) });
  new PlaceAgain(deps([held], sandbox('slot1', { sessionIds: ['h1'] }), { waitOn: () => WAITS.person, liveHold: () => 'held', liveLost })).tick();
  assert.deepEqual(lost, []);
});

test('w1582: the resumed worker is asked to stage its Live view again with the same knobs, fps and width', () => {
  const text = liveLostNote({ at: iso(NOW - 3600_000), why: WAITS.person, materials: ['WardenMaterial'], fps: 30, width: 1920 });
  assert.match(text, /^\[live view\] Your Live view ended while you were stopped \([^)]+\): your sandbox was released because it waits on w889: Ben to act/);
  assert.match(text, /live_view start \(materials \["WardenMaterial"\], fps 30, width 1920\)/);
  assert.match(text, /mcp__machine__unity start/);
});

test('w1668: slot1 kept for an urgent release builder on its way there is spoken for: no released worker is placed there, and its own former worker resumes elsewhere', () => {
  // lothsahn: "Let's make sure that urgent builds always get scheduled in slot1 on whatever machine they run in so that it uses caches as warm as possible."
  const nightly = worker('n1', { status: 'stopped', machineSandbox: 'slot1', placeReleased: { at: iso(NOW - MIN), sandbox: 'slot1', branch: 'feature/slot1', why: 'the urgent release builds there' } });
  // After the move slot1 is on the builder's branch, and n1's branch is checked out nowhere.
  const both = { id: 'pc', sandboxes: [sandbox('slot1', {}, { branch: 'w1700-rel' }), sandbox('slot2', {}, { branch: 'feature/slot2' })] } as unknown as Machine;
  const p = new PlaceAgain({ ...deps([nightly], sandbox('slot1')), machine: () => both, queued: () => true, reserved: () => new Map([['slot1', 'builder']]) });
  assert.equal(p.claimedBy('pc', 'slot1'), 'builder');
  assert.equal(p.claimedBy('pc', 'slot2'), 'n1', 'its own slot1 is the builder\'s: it goes to slot2');
  const none = new PlaceAgain({ ...deps([nightly], sandbox('slot1')), machine: () => both, queued: () => true });
  assert.equal(none.claimedBy('pc', 'slot1'), 'n1', 'without the reservation it would go back to slot1');
});
