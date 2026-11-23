// w5260 (lothsahn): an urgent or frantic worker between turns keeps its sandbox, and a released one's resume that finds no
// sandbox on its computer frees one from lower work instead of sitting Queued. w5186 (frantic, the Build 63 release waited on
// it) ended its turn blocked on CI at 10:18Z on 2026-11-23, beast/slot5 was released, normal w5252 and w5253 took both free
// beast sandboxes at about 11:3x, CI cleared at 11:46Z and its resume sat Queued until a person moved it at 11:57Z, handed
// over on another worker's branch. server/placeAgain.ts (keepWhy, resumePressure, resumeFreeing, workerBranch, moveBranchOf).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaceAgain, keepWhy, moveBranchOf, occupies, workerBranch } from './placeAgain.ts';
import type { Pressure } from './priorityReclaim.ts';
import type { Machine, MachineSandbox, SessionInfo, WorkPriority } from '../shared/types.ts';

const T0 = Date.parse('2026-11-23T11:46:00Z');
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const worker = (id: string, sandbox: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  kind: 'worker',
  machineId: 'beast',
  machineSandbox: sandbox,
  title: id,
  status: 'stopped',
  permissionMode: 'default',
  createdAt: iso(T0 - 3600_000),
  lastActivityAt: iso(T0 - 5 * MIN),
  turns: 3,
  costUsd: 1,
  pendingPermissions: [],
  ...over,
});

const sandbox = (id: string, branch: string, sessionIds: string[]): MachineSandbox => ({
  id,
  branch: `sandbox/${id}`,
  base: 'origin/master',
  path: `/sb/${id}`,
  purpose: id,
  status: 'ready',
  createdAt: iso(T0 - 86_400_000),
  unity: { state: 'stopped' },
  sessionIds,
  git: { branch, dirty: 0, untracked: 0, ahead: 0, at: iso(T0 - MIN) },
});

/** A PlaceAgain over beast: `ci` is the set of workers whose requests wait on CI; `clock` moves the time. */
function rig(sessions: SessionInfo[], sbs: MachineSandbox[], prio: Record<string, WorkPriority | undefined>, o: { live?: string[]; ci?: string[]; pressure?: Pressure[]; resumePreempt?: string[] } = {}) {
  const told: { id: string; text: string }[] = [];
  const events: { work: string; sandbox: string; released: boolean; preempt: boolean }[] = [];
  const live = new Set(o.live ?? []);
  const ci = new Set(o.ci ?? []);
  const clock = { now: T0, soon: 0 };
  const machine = { id: 'beast', sandboxes: sbs } as unknown as Machine;
  const p = new PlaceAgain({
    sessions: () => sessions,
    machine: () => machine,
    machines: () => [machine],
    isLive: (id) => live.has(id),
    online: () => true,
    unityHolders: () => [],
    workOver: () => undefined,
    ciWait: (s) => (ci.has(s.id) ? `its request waits on CI on Final-Factory/FinalFactory#4212` : undefined),
    keepLive: () => undefined,
    queued: (id) => !!sessions.find((s) => s.id === id)?.queuedSend,
    stopLive: (id) => live.delete(id),
    stopEditor: async () => undefined,
    switchBranch: async (_m, branch) => ({ notes: [`switched to ${branch}`] }),
    save: () => undefined,
    saveMachine: () => undefined,
    note: () => undefined,
    drain: () => undefined,
    soon: () => void clock.soon++,
    now: () => clock.now,
    pressure: () => o.pressure ?? [],
    priorityOf: (s) => prio[s.id],
    requestsOf: (s) => (s.id === 'f' ? ['w5186'] : [`req-${s.id}`]),
    resumePreempt: (s) => (o.resumePreempt ?? []).includes(s.id),
    reclaimed: (e) => events.push({ work: e.work, sandbox: e.sandbox, released: e.released, preempt: e.preempt }),
    tell: (id, text) => void told.push({ id, text }),
  });
  return { p, live, ci, clock, told, events };
}

test('w5260: a frantic worker blocked on CI keeps its sandbox while normal work waits, and resumes there the moment CI clears', () => {
  assert.equal(keepWhy('normal'), undefined);
  assert.equal(keepWhy('high'), undefined);
  assert.match(keepWhy('urgent') ?? '', /urgent or frantic worker keeps its sandbox/);
  assert.match(keepWhy('frantic') ?? '', /its work is frantic/);
  for (const [prio, kept] of [['frantic', true], ['urgent', true], ['normal', false]] as const) {
    // Idle after ending its turn blocked on CI, its editor stopped and nothing unpushed (w846 released it at once).
    const f = worker('f', 'slot5', { status: 'idle', lastActivityAt: iso(T0 - 90 * MIN) });
    const n = worker('n', 'slot2', { status: 'idle', lastActivityAt: iso(T0 - MIN) });
    const sbs = [sandbox('slot5', 'w5186-burst-power-icon', ['f']), sandbox('slot2', 'w5252-work', ['n'])];
    // Normal work is Queued with no room on beast (w5253 in the incident).
    const r = rig([f, n], sbs, { f: prio, n: 'normal' }, { live: ['f', 'n'], ci: ['f'], pressure: [{ work: 'w5253', title: 'normal work', priority: 'normal', room: false, machines: ['beast'], preemptOn: [] }] });
    r.p.tick();
    // Its process may stop (it holds nothing then but its sandbox), as for anyone waiting on CI.
    assert.equal(r.live.has('f'), false, `${prio}: stopped while it waits`);
    f.status = 'stopped';
    r.clock.now += MIN;
    r.p.tick();
    r.clock.now += 30 * MIN;
    r.p.tick();
    if (!kept) {
      assert.equal(f.placeReleased?.sandbox, 'slot5', 'normal work is released while it waits on CI (w846), as before');
      continue;
    }
    assert.equal(f.placeReleased, undefined, `${prio}: never released while it waits`);
    assert.equal(occupies(f, false, r.clock.now), true, `${prio}: its sandbox is not free for new work`);
    assert.equal(r.p.claimedBy('beast', 'slot5'), undefined, 'and not claimed for another released worker');
    assert.match(r.p.stayWhy(f) ?? '', /urgent or frantic worker keeps its sandbox/, 'a message resumes it there and nowhere else');
    // CI clears: the gate's message is queued, and it resumes in place: nothing to place, nothing to wait for.
    r.ci.delete('f');
    f.queuedSend = iso(r.clock.now);
    assert.equal(r.p.answer(f), undefined, 'not released: the drain resumes it in its own sandbox at once');
    assert.equal(r.p.tick().some((l) => /\bf\b.*released|released .* of f/.test(l)), false);
    assert.equal(f.placeReleased, undefined);
  }
});

test('w5260: strictly higher work still takes an urgent worker\'s sandbox; equal work does not', () => {
  for (const [want, taken] of [['frantic', true], ['urgent', false]] as const) {
    const u = worker('u', 'slot1', { status: 'idle' });
    const r = rig([u], [sandbox('slot1', 'w1-work', ['u'])], { u: 'urgent' }, { live: ['u'], pressure: [{ work: 'wF', title: 'frantic', priority: want, room: false, machines: ['beast'], preemptOn: [] }] });
    r.p.tick();
    assert.equal(!r.live.has('u'), taken, `${want} work ${taken ? 'takes' : 'does not take'} it`);
    if (!taken) continue;
    u.status = 'stopped';
    r.p.tick();
    assert.equal(u.placeReleased?.sandbox, 'slot1');
  }
});

test('w5260: a released frantic resume with every sandbox on its computer held by normal work frees one within a minute, idle first', () => {
  // w5186: released at 10:18Z while it waited on CI; its message came at 11:46Z, both beast sandboxes held by idle normal work.
  const f = worker('f', 'slot5', { placeReleased: { at: iso(T0 - 88 * MIN), sandbox: 'slot5', branch: 'w5186-burst-power-icon', why: 'waits on CI', wait: true }, queuedSend: iso(T0) });
  const a = worker('a', 'slot5', { status: 'idle', lastActivityAt: iso(T0 - 2 * MIN) });
  const b = worker('b', 'slot2', { status: 'idle', lastActivityAt: iso(T0 - 20 * MIN) });
  const sbs = [sandbox('slot5', 'regress/2026-11-23-station-flight', ['a']), sandbox('slot2', 'w5253-work', ['b'])];
  const r = rig([f, a, b], sbs, { f: 'frantic', a: 'normal', b: 'normal' }, { live: ['a', 'b'] });
  assert.match(r.p.answer(f) ?? '', /no sandbox on beast is free/, 'it waits for a sandbox as before');
  // Its resume asks first (Agents.roomMove, 20 s after the message): a sandbox held by idle lower work is freed for it.
  r.clock.now += 20_000;
  assert.match(r.p.resumeFreeing(f) ?? '', /beast\/slot2 on its computer, held by idle normal work, is freed for it next \(w5260\)/);
  assert.equal(r.clock.soon, 1, 'the release pass runs soon, not a minute away');
  // The pass (5 s later): the longest-idle normal holder is stopped for it, never a frantic one's own branch lost.
  r.clock.now += 5_000;
  const first = r.p.tick();
  assert.ok(first.some((l) => /taking beast\/slot2 of b \(normal\) for frantic w5186/.test(l)), first.join('\n'));
  assert.ok(first.some((l) => /^stopped b \(taken for the frantic resume of w5186 \(w5260\)\)/.test(l)), first.join('\n'));
  assert.equal(r.live.has('a'), true, 'only one sandbox is taken');
  assert.match(r.p.resumeFreeing(f) ?? '', /beast\/slot2 on its computer is being freed for it/);
  // Stopped, the next pass (run soon) releases it, and the sandbox is spoken for by the frantic resume.
  b.status = 'stopped';
  r.clock.now += 5_000;
  const second = r.p.tick();
  assert.ok(second.some((l) => /^released beast\/slot2 of b/.test(l)), second.join('\n'));
  assert.equal(b.placeReleased?.branch, 'w5253-work', 'the normal worker keeps its own branch');
  assert.equal(r.p.claimedBy('beast', 'slot2'), 'f', 'the freed sandbox is the frantic resume\'s, ahead of any other');
  // The next drain places it there, on its own branch: well within a minute of CI clearing.
  assert.match(r.p.answer(f) ?? '', /being placed again in beast\/slot2/);
  assert.ok(r.clock.now - T0 < MIN, `placed ${(r.clock.now - T0) / 1000} s after CI cleared`);
  assert.deepEqual(r.events.map((e) => [e.work, e.sandbox, e.released]), [['w5186', 'slot2', false], ['w5186', 'slot2', true]]);
  // The released normal worker does not claim its sandbox back meanwhile.
  b.queuedSend = iso(r.clock.now);
  assert.notEqual(r.p.claimedBy('beast', 'slot2'), 'b');
});

test('w5260: with no idle lower holder, a frantic resume pre-empts mid-turn normal work at a safe point only once it has nowhere to move', () => {
  for (const stuck of [false, true]) {
    const f = worker('f', 'slot5', { placeReleased: { at: iso(T0 - 88 * MIN), sandbox: 'slot5', branch: 'w5186-burst-power-icon', why: 'waits on CI', wait: true }, queuedSend: iso(T0) });
    const n = worker('n', 'slot5', { status: 'running' });
    const r = rig([f, n], [sandbox('slot5', 'w5252-work', ['n'])], { f: 'frantic', n: 'normal' }, { live: ['n'], resumePreempt: stuck ? ['f'] : [] });
    assert.equal(r.p.resumeFreeing(f), undefined, 'nothing idle to free: Agents.roomMove moves it to a computer with room first');
    r.p.tick();
    if (!stuck) {
      assert.equal(r.told.length, 0, 'a turn is not pre-empted while a move may still place it');
      continue;
    }
    assert.equal(r.told.length, 1);
    assert.equal(r.told[0].id, 'n');
    assert.match(r.told[0].text, /PRE-EMPTED \(w3507\)/);
    assert.match(r.told[0].text, /never stop in the middle of a git command, a merge, a push or a release step/);
    assert.equal(r.live.has('n'), true, 'never interrupted');
  }
});

test('w5260: stop_agent move_to hands a released worker over on its own branch, not its old sandbox\'s', () => {
  const sb = sandbox('slot5', 'regress/2026-11-23-station-flight', ['other']);
  const released = worker('f', 'slot5', { placeReleased: { at: iso(T0), sandbox: 'slot5', branch: 'w5186-burst-power-icon', why: 'waits on CI' } });
  assert.equal(workerBranch(released, sb), 'w5186-burst-power-icon');
  assert.equal(workerBranch(worker('g', 'slot5'), sb), 'regress/2026-11-23-station-flight', 'a worker in its sandbox: the sandbox\'s branch');
  assert.equal(workerBranch(worker('g', 'slot5'), { ...sb, git: { ...sb.git!, branch: 'detached HEAD' } }), 'sandbox/slot5');
  const pr = { repo: 'Final-Factory/FinalFactory', number: 4212, head: 'w5186-burst-power-icon', state: 'open' as const };
  assert.deepEqual(moveBranchOf('w5186-burst-power-icon', { prs: [pr] }), { branch: 'w5186-burst-power-icon', line: 'Its open pull request: Final-Factory/FinalFactory#4212 (branch w5186-burst-power-icon). ' });
  assert.equal(moveBranchOf(undefined, { prs: [pr] }).branch, 'w5186-burst-power-icon', 'its open pull request\'s head when its branch is unknown');
  assert.deepEqual(moveBranchOf(undefined, { prs: [{ ...pr, state: 'merged' }] }), { line: '' });
});
