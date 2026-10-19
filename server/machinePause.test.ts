import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MachinePauses, PAUSE_GRACE_MS, PAUSE_LINELESS_WAIT_MS, PAUSE_STOP_AFTER_MS, handedBackIn, pauseHolds, pauseNotice, pauseWhy, type HandBack, type PauseDeps } from './machinePause.ts';
import { holdReason, pickComputer, roomNow, type Computer } from './placement.ts';
import { handoverNote } from './work.ts';
import type { Machine, MachinePause, SessionInfo, WorkItem } from '../shared/types.ts';
import type { SaveResult } from './saveWork.ts';

// w1532 (lothsahn, 2026-10-19): "When pausing, workers should be instructed to finish up their work, commit anything
// unfinished, and hand their jobs back to the dispatcher to be scheduled on other computers." A paused machine is held the
// way placement.hold holds one (no new work, no resumes), and its workers hand back (server/machinePause.ts).

const PAUSED: MachinePause = { paused: true, reason: 'activity', detail: 'someone is using this PC: work resumes 90 min after the last key or click (at 15:30 if nobody touches it)' };

test('w1532: a paused machine is held: never picked for new work, named in the room, and nothing resumes there', () => {
  const holds = pauseHolds([{ id: 'beast', pause: PAUSED }, { id: 'lothdesktop', pause: { paused: false, detail: 'running: no schedule set' } }, { id: 'm5' }]);
  assert.deepEqual(holds, { beast: 'paused from its tray app: someone is using it (w1532)' });
  const pc = (id: string): Computer => ({ id, live: 0, midTurn: 0, maxAgents: 10, freeSandboxes: 3, sandboxes: 3, maxSandboxes: 6, memTotalBytes: 64e9, memUsedBytes: 8e9, online: true }) as unknown as Computer;
  const places = [pc('beast'), pc('lothdesktop')];
  for (let i = 0; i < 4; i++) assert.equal(pickComputer(places, i % 2 ? 'lothdesktop' : 'beast', { hold: holds })?.pick.id, 'lothdesktop', 'beast has the room and is never picked while paused');
  const room = roomNow(places, { hold: holds });
  assert.deepEqual(room.held.map((h) => [h.id, h.why]), [['beast', 'paused from its tray app: someone is using it (w1532)']]);
  assert.match(holdReason('beast', { hold: holds })!, /^beast is paused from its tray app: someone is using it \(w1532\): nothing resumes there until it runs again/);
  assert.match(holdReason('m5', { hold: { m5: 'Ben testing' } })!, /m5 is on hold \(Ben testing\): nothing resumes there until the hold is lifted \(placement\.hold\)/, 'a config hold reads as before');
  assert.equal(pauseWhy({ reason: 'schedule', detail: '' }), 'paused from its tray app: outside its work schedule (w1532)');
});

test('w1532: a worker\'s hand-back lines are read by request id, with the branch it names', () => {
  const text = 'Pushed.\n\n**w1532: handed back:** branch `sandbox/slot5-w1532` pushed; the daemon side is done, the web view is left\nw88 - handed back: nothing to push';
  const got = handedBackIn(text);
  assert.deepEqual(got.get('w1532'), { line: 'w1532: handed back:** branch `sandbox/slot5-w1532` pushed; the daemon side is done, the web view is left', branch: 'sandbox/slot5-w1532' });
  assert.deepEqual(got.get('w88'), { line: 'w88 - handed back: nothing to push' });
  assert.equal(handedBackIn('w12: still open: CI').size, 0);
});

test('w1532: the pause notice says what to do, in order, and how the line is written', () => {
  const n = pauseNotice('beast', PAUSED, ['w1532']);
  assert.match(n, /^\[FF Factory\] PAUSE: beast was paused by its owner \(activity: someone is using this PC/);
  assert.match(n, /Finish the step you are on and start no new one/);
  assert.match(n, /Commit everything unfinished on your branch \(a WIP commit is fine/);
  assert.match(n, /`w1532: handed back: branch <branch> pushed; <where you stopped and what is left>`/);
  assert.match(n, /in 15 minutes, FF Factory interrupts it/);
});

const NOW = Date.parse('2026-10-19T14:00:00Z');

function world() {
  const machines = new Map<string, Machine>([
    ['beast', { id: 'beast', online: true, sandboxes: [{ id: 'slot5', branch: 'sandbox/slot5', git: { branch: 'sandbox/slot5-w1532' } }] } as unknown as Machine],
    ['lothdesktop', { id: 'lothdesktop', online: true } as unknown as Machine],
  ]);
  const sessions = new Map<string, SessionInfo>();
  const live = new Set<string>();
  const mid = new Set<string>();
  const work = new Map<string, WorkItem>();
  const log: string[] = [];
  const told: [string, string][] = [];
  const stopped: string[] = [];
  const interrupted: string[] = [];
  const saved: string[] = [];
  const handed: { w: string; s: string; h: HandBack }[] = [];
  let now = NOW;
  const d: PauseDeps = {
    machines: () => machines.values(),
    machine: (id) => machines.get(id),
    workersOn: (id) => [...sessions.values()].filter((s) => s.machineId === id),
    session: (id) => sessions.get(id),
    isLive: (id) => live.has(id),
    isMidTurn: (i) => mid.has(i.id),
    openRequestsOf: (id) => [...work.values()].filter((w) => w.sessionIds.includes(id) && ['new', 'queued', 'blocked', 'active'].includes(w.status)),
    tell: (id, text) => void told.push([id, text]),
    interrupt: (id) => void interrupted.push(id),
    stop: (id) => {
      stopped.push(id);
      live.delete(id);
      mid.delete(id);
    },
    save: async (i, branch): Promise<SaveResult> => {
      saved.push(`${i.machineSandbox}@${branch}`);
      return { sha: 'abc1234def5678', files: 2, pushed: true, notes: [] };
    },
    branchOf: (i) => machines.get(i.machineId!)?.sandboxes?.find((x) => x.id === i.machineSandbox)?.git?.branch,
    handBack: (w, s, h) => {
      handed.push({ w: w.id, s: s.id, h });
      w.sessionIds = w.sessionIds.filter((x) => x !== s.id);
      w.status = 'queued';
    },
    now: () => now,
    log: (l) => void log.push(l),
  };
  const worker = (id: string, o: { live?: boolean; mid?: boolean; requests?: [string, WorkItem['status']][] } = {}) => {
    sessions.set(id, { id, kind: 'worker', title: `${o.requests?.[0]?.[0] ?? 'x'}: job`, machineId: 'beast', machineSandbox: 'slot5' } as SessionInfo);
    if (o.live) live.add(id);
    if (o.mid) mid.add(id);
    for (const [wid, status] of o.requests ?? []) work.set(wid, { id: wid, title: wid, status, sessionIds: [id], outcome: `${wid}: still open: tests` } as unknown as WorkItem);
  };
  const pause = (p: MachinePause | undefined) => {
    machines.get('beast')!.pause = p;
  };
  const tick = (ms: number) => void (now += ms);
  return { d, machines, sessions, work, log, told, stopped, interrupted, saved, handed, worker, pause, tick, live, mid };
}

const settle = () => new Promise((r) => setImmediate(r));

test('w1532: at a pause, a worker mid-turn is told once; one between turns is stopped, not woken; a stopped one is left alone', () => {
  const t = world();
  t.worker('mid1', { live: true, mid: true, requests: [['w1', 'active']] });
  t.worker('idle1', { live: true, requests: [['w2', 'blocked']] });
  t.worker('gone1', { requests: [['w3', 'blocked']] });
  const p = new MachinePauses(t.d);
  t.pause(PAUSED);
  p.onPause('beast');
  assert.deepEqual(t.told.map(([id]) => id), ['mid1']);
  assert.match(t.told[0][1], /w1: handed back: branch <branch> pushed/);
  assert.deepEqual(t.stopped, ['idle1'], 'the live idle worker is stopped; its request stays with it until it would resume');
  assert.equal(t.handed.length, 0, 'nothing is handed back before a turn ends or a resume is held');
  p.tick();
  assert.equal(t.told.length, 1, 'told once');
});

test('w1532: a worker that hands back by itself: stopped, its sandbox saved, each request handed back with its branch and line', async () => {
  const t = world();
  t.worker('mid1', { live: true, mid: true, requests: [['w1', 'active'], ['w9', 'blocked']] });
  const p = new MachinePauses(t.d);
  t.pause(PAUSED);
  p.onPause('beast');
  t.mid.delete('mid1');
  assert.equal(p.turnEnded(t.sessions.get('mid1')!, 'Done for now.\nw1: handed back: branch feature/x pushed; tests written, the UI is left'), true);
  await settle();
  await settle();
  assert.deepEqual(t.stopped, ['mid1']);
  assert.deepEqual(t.saved, ['slot5@sandbox/slot5-w1532'], 'the sandbox branch is saved (its own push is in feature/x)');
  assert.deepEqual(t.handed.map((x) => x.w), ['w1'], 'w9 waits on a gate: it hands back when it would resume, not now');
  const h = t.handed[0].h;
  assert.equal(h.branch, 'feature/x', 'the branch its line names');
  assert.equal(h.how, 'by its worker');
  assert.match(h.note, /^w1: handed back: branch feature\/x pushed; tests written/);
  assert.match(h.saved!, /saved as WIP commit abc1234def on sandbox\/slot5-w1532 and pushed/);
  assert.equal(h.why, 'paused from its tray app: someone is using it (w1532)');
});

test('w1532: a worker still mid-turn 15 minutes after the notice is interrupted, then stopped and handed back by FF Factory', async () => {
  const t = world();
  t.worker('mid1', { live: true, mid: true, requests: [['w1', 'active']] });
  const p = new MachinePauses(t.d);
  t.pause(PAUSED);
  p.onPause('beast');
  t.tick(PAUSE_GRACE_MS.value - 1000);
  p.tick();
  assert.deepEqual(t.interrupted, []);
  t.tick(1000);
  p.tick();
  assert.deepEqual(t.interrupted, ['mid1'], 'interrupted at 15 minutes');
  t.tick(PAUSE_STOP_AFTER_MS.value);
  p.tick();
  await settle();
  await settle();
  assert.deepEqual(t.stopped, ['mid1'], 'the interrupt did not end the turn: stopped');
  assert.deepEqual(t.handed.map((x) => [x.w, x.h.how, x.h.branch]), [['w1', 'forced (stopped)', 'sandbox/slot5-w1532']]);
});

test('w1532: an interrupted turn that ends hands back as forced; an unpause before it ends hands nothing back', async () => {
  const t = world();
  t.worker('mid1', { live: true, mid: true, requests: [['w1', 'active']] });
  t.worker('mid2', { live: true, mid: true, requests: [['w2', 'active']] });
  const p = new MachinePauses(t.d);
  t.pause(PAUSED);
  p.onPause('beast');
  t.tick(PAUSE_GRACE_MS.value);
  p.tick();
  t.mid.delete('mid1');
  p.turnEnded(t.sessions.get('mid1')!, 'Interrupted.');
  await settle();
  await settle();
  assert.equal(t.handed[0].h.how, 'forced: interrupted 15 min after the pause notice');
  assert.match(t.handed[0].h.note, /its last report: w1: still open: tests/);
  t.pause({ paused: false, detail: 'running: no schedule set' });
  p.onUnpause('beast');
  t.mid.delete('mid2');
  assert.equal(p.turnEnded(t.sessions.get('mid2')!, 'Done.'), false, 'running again: a turn end is a turn end');
  assert.equal(t.handed.length, 1);
});

test('w1532: a resume the pause holds hands the request back with the message; not paused, or no open request, it waits as before', async () => {
  const t = world();
  t.worker('gone1', { requests: [['w3', 'blocked']] });
  t.worker('empty', {});
  const p = new MachinePauses(t.d);
  assert.equal(p.heldResume(t.sessions.get('gone1')!, '[ci] green'), false, 'running: no hand-back');
  t.pause(PAUSED);
  assert.equal(p.heldResume(t.sessions.get('empty')!, 'hello'), false, 'nothing to hand back: the message waits for the unpause');
  assert.equal(p.heldResume(t.sessions.get('gone1')!, '[ci] PR #12: every check passed'), true);
  await settle();
  await settle();
  assert.deepEqual(t.handed.map((x) => [x.w, x.h.how, x.h.message]), [['w3', 'on a held resume', '[ci] PR #12: every check passed']]);
  assert.match(t.handed[0].h.note, /between turns when the machine paused/);
  assert.equal(p.heldResume({ ...t.sessions.get('gone1')!, kind: 'orchestrator' } as SessionInfo, 'x'), false, 'only workers hand back');
});

test('w1532: the next worker\'s handover names the hand-back, its branch, the note and the waiting message', () => {
  const note = handoverNote({ id: 'w3' }, { related: [], handedBack: { at: '2026-10-19T14:05:00.000Z', from: 'beast/slot5', session: 'gone1', branch: 'sandbox/slot5-w3', why: 'paused from its tray app: someone is using it (w1532)', note: 'its last report: w3: still open: CI', how: 'on a held resume', saved: 'its sandbox had no uncommitted work on sandbox/slot5-w3', message: '[ci] PR #12: every check passed' } });
  assert.match(note, /Handed back \(w1532\): w3 was taken off worker gone1 on beast\/slot5 at 2026-10-19 14:05 UTC, because that machine is paused from its tray app: someone is using it \(w1532\) \(on a held resume\)\. Continue from its branch sandbox\/slot5-w3/);
  assert.match(note, /The message that was waiting for it when it was handed back, now yours:\n~~~text\n\[ci\] PR #12: every check passed\n~~~/);
});

test('w1532: a told worker whose turn ends before it read the notice gets the queued turn to hand back; silent for a minute, FF Factory hands back', async () => {
  // The notice reached the turn as it ended (measured in the beast demo: the step's result, then the notice as its own turn).
  const t = world();
  t.worker('mid1', { live: true, mid: true, requests: [['w1', 'active']] });
  t.worker('mid2', { live: true, mid: true, requests: [['w2', 'active']] });
  const p = new MachinePauses(t.d);
  t.pause(PAUSED);
  p.onPause('beast');
  t.mid.delete('mid1');
  t.mid.delete('mid2');
  p.turnEnded(t.sessions.get('mid1')!, 'Waited 40 s.');
  p.turnEnded(t.sessions.get('mid2')!, 'Waited 40 s.');
  p.tick();
  assert.deepEqual([t.stopped, t.handed], [[], []], 'not stopped, nothing handed back: the notice is still to come');
  t.mid.add('mid1');
  p.tick();
  t.mid.delete('mid1');
  p.turnEnded(t.sessions.get('mid1')!, 'Pushed.\nw1: handed back: branch sandbox/slot5-w1 pushed; half done');
  await settle();
  await settle();
  assert.deepEqual(t.handed.map((x) => [x.w, x.h.how, x.h.branch]), [['w1', 'by its worker', 'sandbox/slot5-w1']]);
  t.tick(PAUSE_LINELESS_WAIT_MS.value);
  p.tick();
  await settle();
  await settle();
  assert.deepEqual(t.handed.map((x) => [x.w, x.h.how]), [['w1', 'by its worker'], ['w2', 'its worker ended its turn without a hand-back line']], 'mid2 never answered: handed back by FF Factory');
  assert.ok(t.stopped.includes('mid2'));
});
