import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assess, heldSideKept, readSlotWork, type Place, type SlotRequest } from '../machine/unitySlots.ts';
import { editorSessions } from '../machine/benchRaise.ts';
import { writeBenchPriorities } from '../machine/benchLock.ts';
import { applyPairRaises, pairRaises, type PairState } from '../server/pairRaise.ts';
import type { Proc } from '../machine/unity.ts';
import type { BenchPriority, PairRaise, WorkPriority } from '../shared/types.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * w5341 (lothsahn, 2026-11-23: "When work needs a two machine run for any reason and it's already got a slot on one
 * machine, raise it a priority level for getting the other machine slot so that the pair can get running"): a pair run's
 * leg that holds no Unity slot while a leg on another machine holds one is sent one level up for its machine's slot gate;
 * the raise ends when the held side is let go; two half-held pairs never deadlock or swap sides.
 */

const T0 = Date.parse('2026-11-23T21:00:00Z');
const HUB = 'C:\\Program Files\\Unity\\Hub\\Editor\\6000.3.19f1\\Editor';
let nextPid = 9000;
const editorProc = (pid: number, project: string): Proc => ({ pid, ppid: 77777, name: 'Unity.exe', cmd: `"${HUB}\\Unity.exe" -projectPath ${project}` });
const waiter = (id: string, at: number, over: Partial<SlotRequest> = {}): SlotRequest => ({ id, holder: `pid:${id}`, count: 1, pid: nextPid++, label: `build ${id}`, session: `s-${id}`, createdAt: T0 + at * 1000, ...over });
const place = (id: string, over: Partial<Place> = {}): Place => ({ holder: `sandbox:${id}`, path: `D:\\work\\ffsb\\${id}`, editorUp: true, session: `editor:${id}`, ...over });

/** What the portal sends a machine (Agents.benchPriorities, then applyPairRaises), read the way the arbiter reads it. */
function sent(sessions: Record<string, BenchPriority>, pairs: PairState[]) {
  const out = structuredClone(sessions);
  applyPairRaises(out, pairs);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w5341-'));
  try {
    writeBenchPriorities(root, out, new Date(T0));
    const w = readSlotWork(root);
    return { out, priorityOf: w.priorityOf, pairOf: w.pairOf, requestsOf: w.requestsOf };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const pair = (work: string, since: string, priority: WorkPriority, legs: [string, string, boolean][]): PairState => ({ work, since, priority, legs: legs.map(([session, machine, holds]) => ({ session, machine, holds })) });

test('w5341 (a): a pair holding its side on A outranks older same-priority work for B\'s slot, and the reason says why', () => {
  // On B (limit 1): an editor of normal work holds the slot; n is an older normal build; leg2 of pair w9000 waits.
  const pairs = [pair('w9000', '2026-11-23T20:50:00Z', 'normal', [['leg1', 'A', true], ['leg2', 'B', false]])];
  const { out, priorityOf, pairOf } = sent({ leg2: { priority: 'normal', requests: ['w9000'] }, 's-n': { priority: 'normal', requests: ['w8000'] }, 'editor:x': { priority: 'normal', requests: ['w8001'] } }, pairs);
  assert.equal(out.leg2.priority, 'high', 'normal → high');
  assert.equal(out.leg2.pair?.half, 'waiting');
  const reqs = [waiter('n', 1), waiter('p', 9, { session: 'leg2' })];
  // The slot frees (x's editor stops): the raised leg gets it, not the older normal build.
  const a = assess({ platform: 'win32', procs: [], requests: reqs, places: [], limit: 1, now: T0 + 20_000, priorityOf, pairOf });
  assert.deepEqual(a.grant, ['p']);
  assert.deepEqual(a.waiting.map((w) => w.id), ['n']);
  // While x's editor holds it, the raised leg is first and its reason names the raise.
  const held = assess({ platform: 'win32', procs: [editorProc(10, 'D:\\work\\ffsb\\x')], requests: reqs, places: [place('x')], limit: 1, now: T0 + 20_000, priorityOf, pairOf });
  assert.equal(held.waiting[0].id, 'p');
  assert.match(held.waiting[0].why, /^raised one level \(normal → high\): pair half-held, w9000's other side holds a slot on A \(w5341\)/);
  // The raised level counts for w5324's preemption too: x's normal editor is lower than high.
  assert.deepEqual(held.preempt.map((x) => [x.holder, x.priority, x.forPriority]), [['sandbox:x', 'normal', 'high']]);
});

test('w5341 (b): no raise without a held side, with every side held, or with the legs on one machine', () => {
  assert.equal(pairRaises([pair('w1', 'x', 'normal', [['l1', 'A', false], ['l2', 'B', false]])]).size, 0, 'nothing held');
  assert.equal(pairRaises([pair('w1', 'x', 'normal', [['l1', 'A', true], ['l2', 'B', true]])]).size, 0, 'both held: it runs');
  assert.equal(pairRaises([pair('w1', 'x', 'normal', [['l1', 'A', true], ['l2', 'A', false]])]).size, 0, 'one machine: not a two-machine claim');
  const { out } = sent({ l2: { priority: 'normal', requests: ['w1'] } }, [pair('w1', 'x', 'normal', [['l1', 'A', false], ['l2', 'B', false]])]);
  assert.deepEqual(out.l2, { priority: 'normal', requests: ['w1'] });
});

test('w5341 (c): the raise ends when the held side is let go', () => {
  const sessions = { l2: { priority: 'urgent' as WorkPriority, requests: ['w2'] } };
  const held = sent(sessions, [pair('w2', 'x', 'urgent', [['l1', 'A', true], ['l2', 'B', false]])]);
  assert.equal(held.priorityOf('l2'), 'frantic', 'urgent → frantic');
  assert.deepEqual({ priority: held.out.l2.priority, level: held.out.l2.level }, { priority: 'urgent', level: 'release' }, 'frantic goes on the wire as urgent + release');
  const released = sent(sessions, [pair('w2', 'x', 'urgent', [['l1', 'A', false], ['l2', 'B', false]])]);
  assert.equal(released.priorityOf('l2'), 'urgent');
  assert.equal(released.pairOf('l2'), undefined);
  // frantic stays frantic
  const top = sent({ l2: { priority: 'urgent', level: 'release', requests: ['w3'] } }, [pair('w3', 'x', 'frantic', [['l1', 'A', true], ['l2', 'B', false]])]);
  assert.equal(top.priorityOf('l2'), 'frantic');
  assert.equal(top.out.l2.pair?.from, 'frantic');
});

test('w5341: the raise reaches the waiting leg\'s editor start, and a held side is marked held', () => {
  const pairs = [pair('w4', 'x', 'normal', [['l1', 'A', true], ['l2', 'B', false]])];
  const onB = sent({ l2: { priority: 'normal', requests: ['w4'] } }, pairs).out;
  const ed = editorSessions([{ session: 'l2', sandbox: 'slot2' }], onB)['editor:slot2'];
  assert.equal(ed.priority, 'high');
  assert.equal(ed.pair?.half, 'waiting');
  const onA = sent({ l1: { priority: 'normal', requests: ['w4'] } }, pairs).out;
  assert.deepEqual({ priority: onA.l1.priority, half: onA.l1.pair?.half, others: onA.l1.pair?.others }, { priority: 'normal', half: 'held', others: ['B'] });
});

test('w5341: a held side counts one level up as a victim, so the same raise cannot take it back, but a real frantic still can', () => {
  const held: PairRaise = { half: 'held', from: 'normal', work: 'w5', since: '2026-11-23T20:00:00Z', others: ['B'] };
  const procs = [editorProc(10, 'D:\\work\\ffsb\\a')];
  const run = (want: WorkPriority) => assess({ platform: 'win32', procs, requests: [waiter('w', 1)], places: [place('a')], limit: 1, now: T0 + 5000, priorityOf: (s) => (s === 's-w' ? want : 'normal'), pairOf: (s) => (s === 'editor:a' ? held : undefined) });
  assert.deepEqual(run('high').preempt, [], 'high is not above a held normal side');
  assert.deepEqual(run('urgent').preempt.map((p) => p.holder), ['sandbox:a']);
  assert.match(run('high').heldBy[0], /a pair's held side/);
});

test('w5341 (d): two pairs each holding the side the other needs neither deadlock nor swap sides: the older one goes first', () => {
  // A and B allow one editor each. P (older) holds A and waits for B; Q holds B and waits for A. All normal.
  const P = (a: boolean, b: boolean) => pair('wP', '2026-11-23T20:00:00Z', 'normal', [['p1', 'A', a], ['p2', 'B', b]]);
  const Q = (a: boolean, b: boolean) => pair('wQ', '2026-11-23T20:05:00Z', 'normal', [['q1', 'A', a], ['q2', 'B', b]]);
  const base = (ids: string[]) => Object.fromEntries(ids.map((s) => [s, { priority: 'normal' as WorkPriority, requests: [s.startsWith('p') ? 'wP' : 'wQ'] }]));
  const onA = (pairs: PairState[]) => {
    const m = sent(base(['p1', 'q1']), pairs).out;
    const s = { ...editorSessions([{ session: 'p1', sandbox: 'pa' }], m), ...m };
    const w = sent(s, []);
    return assess({ platform: 'win32', procs: [editorProc(10, 'D:\\work\\ffsb\\pa')], requests: [waiter('qa', 1, { session: 'q1', holder: 'sandbox:qa' })], places: [place('pa')], limit: 1, now: T0 + 5000, priorityOf: w.priorityOf, pairOf: w.pairOf });
  };
  const onB = (pairs: PairState[]) => {
    const m = sent(base(['p2', 'q2']), pairs).out;
    const s = { ...editorSessions([{ session: 'q2', sandbox: 'qb' }], m), ...m };
    const w = sent(s, []);
    return assess({ platform: 'win32', procs: [editorProc(11, 'D:\\work\\ffsb\\qb')], requests: [waiter('pb', 1, { session: 'p2', holder: 'sandbox:pb' })], places: [place('qb')], limit: 1, now: T0 + 5000, priorityOf: w.priorityOf, pairOf: w.pairOf });
  };
  const crossed = [P(true, false), Q(false, true)];
  // Both waiters are raised to high, but only the older pair takes the other's idle held side: no swap, no stand-off.
  assert.deepEqual(onA(crossed).preempt, [], "Q's raised leg never takes P's held side (P is older)");
  assert.deepEqual(onB(crossed).preempt.map((p) => [p.holder, p.priority, p.forPriority]), [['sandbox:qb', 'normal', 'high']], "P's raised leg takes Q's idle held side");
  // Q's side on B closed: P gets B's slot; Q now holds nothing, so neither is raised and nothing takes P's side on A.
  const after = [P(true, true), Q(false, false)];
  assert.equal(pairRaises(after).size, 0);
  assert.deepEqual(onA(after).preempt, [], 'no loop: Q waits at normal behind P, which runs');
  assert.equal(heldSideKept({ half: 'held', from: 'normal', work: 'wP', since: '2026-11-23T20:00:00Z', others: [] }, { half: 'waiting', from: 'normal', work: 'wQ', since: '2026-11-23T20:00:00Z', others: [] }), true, 'same start: the request id decides, one way only');
});
