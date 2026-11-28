// w6432 (lothsahn): a frantic request never loses a game sandbox to lower work. On 2026-11-27 w6431 (frantic, the 0.50.0.118
// release) lost lothdesktop sandboxes three times: its start in slot1 failed and a move off offline m5 took slot1 for w6235
// (normal) six seconds later; a move off offline BEAST took slot5 for w5479 (normal); and fa2c6212 (w6430, normal) resumed
// into slot2, the sandbox it had just given up for w6431, because lothdesktop was at its agent cap and w3507's yield read only
// the computers where a free sandbox is all the queued work lacks. server/priorityReclaim.ts outrankedOn, server/placeAgain.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaceAgain } from './placeAgain.ts';
import { FAILED_START_MS, failedStartPressure, outrankedOn, rankOf, type Pressure } from './priorityReclaim.ts';
import type { Machine, MachineSandbox, SessionInfo, WorkPriority } from '../shared/types.ts';

const NOW = Date.parse('2026-11-27T15:28:00Z');
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const pressure = (work: string, priority: WorkPriority, o: Partial<Pressure> = {}): Pressure => ({ work, title: `${work} title`, priority, room: false, machines: [], preemptOn: [], ...o });

test('w6432: outrankedOn finds strictly higher queued game work a free sandbox there is for, its seat from a pre-emption included for urgent and frantic', () => {
  const normal = rankOf('normal');
  // lothdesktop at its agent cap: the frantic release lacks a sandbox and a seat there (preemptOn only).
  const frantic = pressure('w6431', 'frantic', { preemptOn: ['lothdesktop'] });
  assert.equal(outrankedOn([frantic], normal, 'lothdesktop')?.work, 'w6431');
  assert.equal(outrankedOn([frantic], normal, 'm3'), undefined, 'another computer is not its');
  assert.equal(outrankedOn([frantic], rankOf('frantic'), 'lothdesktop'), undefined, 'equal priority: first come first served, no hold');
  // high work is never pre-empted for, so a computer where it also lacks a seat is not held for it.
  assert.equal(outrankedOn([pressure('wH', 'high', { preemptOn: ['lothdesktop'] })], normal, 'lothdesktop'), undefined);
  assert.equal(outrankedOn([pressure('wH', 'high', { machines: ['lothdesktop'] })], normal, 'lothdesktop')?.work, 'wH');
  // The highest of several, whatever their order.
  const both = [pressure('wH', 'high', { machines: ['lothdesktop'] }), frantic, pressure('wU', 'urgent', { machines: ['lothdesktop'] })];
  assert.equal(outrankedOn(both, normal, 'lothdesktop')?.work, 'w6431');
  // A worker with no open request (rank -1) is outranked by low work too.
  assert.equal(outrankedOn([pressure('wL', 'low', { machines: ['lothdesktop'] })], rankOf(undefined), 'lothdesktop')?.work, 'wL');
});

test('w6432: a start that failed holds its computer as queued work does, for FAILED_START_MS', () => {
  const p = failedStartPressure('w6431', 'Release 0.50.0.118', 'frantic', 'lothdesktop');
  assert.deepEqual(p, { work: 'w6431', title: 'Release 0.50.0.118', priority: 'frantic', room: false, machines: ['lothdesktop'], preemptOn: ['lothdesktop'] });
  assert.equal(outrankedOn([p], rankOf('normal'), 'lothdesktop')?.work, 'w6431', 'the move of normal w6235 into lothdesktop/slot1 at 15:04Z is outranked');
  assert.equal(FAILED_START_MS, 10 * MIN);
});

function rig(sessions: SessionInfo[], sbs: MachineSandbox[], prio: Record<string, WorkPriority | undefined>, pr: () => Pressure[], failed: () => Pressure[] = () => []) {
  const machine = { id: 'lothdesktop', sandboxes: sbs } as unknown as Machine;
  return new PlaceAgain({
    sessions: () => sessions,
    machine: () => machine,
    machines: () => [machine],
    isLive: () => false,
    online: () => true,
    unityHolders: () => [],
    workOver: () => undefined,
    keepLive: () => undefined,
    queued: (id) => !!sessions.find((s) => s.id === id)?.queuedSend,
    stopLive: () => undefined,
    stopEditor: async () => undefined,
    switchBranch: async (_m, branch) => ({ notes: [`switched to ${branch}`] }),
    save: () => undefined,
    saveMachine: () => undefined,
    note: () => undefined,
    drain: () => undefined,
    now: () => NOW,
    pressure: pr,
    failedStarts: failed,
    priorityOf: (s) => prio[s.id],
    requestsOf: (s) => [`req-${s.id}`],
    tell: () => undefined,
  });
}

const worker = (id: string, sandbox: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  kind: 'worker',
  machineId: 'lothdesktop',
  machineSandbox: sandbox,
  title: id,
  status: 'stopped',
  permissionMode: 'default',
  createdAt: iso(NOW - 3600_000),
  lastActivityAt: iso(NOW - 6 * MIN),
  turns: 3,
  costUsd: 1,
  pendingPermissions: [],
  ...over,
});

const slot = (id: string, branch: string): MachineSandbox => ({
  id,
  branch: `sandbox/${id}`,
  base: 'origin/master',
  path: `/sb/${id}`,
  purpose: id,
  status: 'ready',
  createdAt: iso(NOW - 86_400_000),
  unity: { state: 'stopped' },
  sessionIds: [],
  git: { branch, dirty: 0, untracked: 0, at: iso(NOW - MIN) },
});

test('w6432: a released normal worker yields where frantic work waits for a sandbox and a seat, and claims no sandbox there', () => {
  // fa2c6212's case at about 15:28Z: released from slot2 for w6431, its queued message delivered once a seat freed, it went
  // back into slot2 while w6431 still waited (slot2 was being cleaned and start_agent was refused twice meanwhile).
  const fa = worker('fa2c6212', 'slot2', { placeReleased: { at: iso(NOW - 6 * MIN), sandbox: 'slot2', branch: 'w6430-flake', why: 'pre-empted for frantic queued work w6431 (w3507)' }, queuedSend: 'go on' });
  let pr = [pressure('w6431', 'frantic', { preemptOn: ['lothdesktop'] })];
  const p = rig([fa], [slot('slot2', 'w6430-flake')], { fa2c6212: 'normal' }, () => pr);
  p.tick(); // the pass reads the pressure
  assert.match(p.answer(fa) ?? '', /higher-priority queued work w6431 \(frantic\) takes the next free sandbox on lothdesktop first/);
  assert.ok(fa.placeReleased, 'still released: it did not take slot2 back');
  assert.equal(p.claimedBy('lothdesktop', 'slot2'), undefined, 'slot2 is not spoken for by fa2c6212, so it stays free for w6431');
  // Queued work of equal priority holds nothing: normal fa2c6212 goes back in.
  pr = [pressure('w6431', 'normal', { preemptOn: ['lothdesktop'] })];
  p.tick();
  assert.equal(p.answer(fa), undefined);
  assert.equal(fa.placeReleased, undefined, 'back in its own sandbox');
});

test('w6432: a start that failed holds the computer against a resume before any pass reads the queue', () => {
  const fa = worker('fa2c6212', 'slot1', { placeReleased: { at: iso(NOW - 6 * MIN), sandbox: 'slot1', branch: 'w6235-x', why: 'x' }, queuedSend: 'go on' });
  let failed = [failedStartPressure('w6431', 't', 'frantic', 'lothdesktop')];
  const p = rig([fa], [slot('slot1', 'w6235-x')], { fa2c6212: 'normal' }, () => [], () => failed);
  assert.match(p.answer(fa) ?? '', /w6431 \(frantic\)/);
  failed = [];
  assert.equal(p.answer(fa), undefined, 'the hold ends with the failed start');
});

test('w6432: outranking reads the pass\'s queued work and the failed starts together', () => {
  const p = rig([], [], {}, () => [pressure('wH', 'high', { machines: ['lothdesktop'] })], () => [failedStartPressure('w6431', 't', 'frantic', 'lothdesktop')]);
  assert.equal(p.outranking(rankOf('normal'), 'lothdesktop')?.work, 'w6431', 'a failed start counts at once, before any pass reads the queue');
  p.tick();
  assert.equal(p.outranking(rankOf('urgent'), 'm3'), undefined);
  assert.equal(p.outranking(rankOf('normal'), 'lothdesktop')?.work, 'w6431');
  assert.equal(p.outranking(rankOf('high'), 'lothdesktop')?.work, 'w6431');
  assert.equal(p.outranking(rankOf('frantic'), 'lothdesktop'), undefined);
});
