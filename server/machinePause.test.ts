import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MachinePauses, PAUSE_DAEMON_KILL_MS, PAUSE_GRACE_MS, PAUSE_STOP_AFTER_MS, SAVE_RETRY_FOR_MS, SAVE_RETRY_MS, handedBackIn, pauseHolds, pauseNotice, pauseWhy, type HandBack, type PauseDeps } from './machinePause.ts';
import { holdReason, pickComputer, roomNow, type Computer } from './placement.ts';
import { handoverNote } from './work.ts';
import type { Machine, MachinePause, SessionInfo, WorkItem } from '../shared/types.ts';
import type { SaveResult } from './saveWork.ts';

// w1532 (lothsahn, 2026-10-19): a paused machine is held the way placement.hold holds one (no new work, no resumes).
// w2443 (lothsahn, 2026-10-27): "Pausing a machine should stop existing runs on that machine. They should terminate in a minute
// or two." and "The worker harness should be authoritative and if the worker is nonresponsive, should kill the worker after a
// few minutes." Its workers are told to push and stop, interrupted at 60 s, stopped at 75 s; their requests wait Blocked on
// the pause and resume in their own sandboxes on the unpause (server/machinePause.ts; the daemon's own end: machine/pauseStop.ts).

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
    block: (w, s, h) => {
      handed.push({ w: w.id, s: s.id, h });
      w.status = 'blocked';
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

test('w2443: a worker\'s pause lines are read by request id, with the branch it names; a w1532 hand-back line still reads', () => {
  const text = 'Pushed.\n\n**w2443: still open: paused on beast;** branch `sandbox/slot5-w2443` pushed; the daemon side is done\nw88 - handed back: nothing to push';
  const got = handedBackIn(text);
  assert.deepEqual(got.get('w2443'), { line: 'w2443: still open: paused on beast;** branch `sandbox/slot5-w2443` pushed; the daemon side is done', branch: 'sandbox/slot5-w2443' });
  assert.deepEqual(got.get('w88'), { line: 'w88 - handed back: nothing to push' });
  assert.equal(handedBackIn('w12: still open: CI').size, 0);
});

test('w2443: the pause notice says stop now, push in one call, the line, and the 60 s deadline', () => {
  const n = pauseNotice('beast', PAUSED, ['w1532']);
  assert.match(n, /^\[FF Factory\] PAUSE: beast was paused by its owner \(activity: someone is using this PC/);
  assert.match(n, /stops now \(w2443\): you have 60 seconds/);
  assert.match(n, /Commit everything unfinished on your branch as a WIP commit and push it/);
  assert.match(n, /Never force-push, merge or open a pull request now/);
  assert.match(n, /`w1532: still open: paused on beast; branch <branch> pushed; <where you stopped and what is left>`/);
  assert.match(n, /Blocked on beast's pause: when beast runs again you are resumed here, in your own sandbox/);
  assert.match(n, /If this turn still runs in 60 seconds, FF Factory interrupts it, stops your process and every process it started/);
  assert.ok(PAUSE_GRACE_MS.value + PAUSE_STOP_AFTER_MS.value < PAUSE_DAEMON_KILL_MS && PAUSE_DAEMON_KILL_MS <= 120_000, 'the portal stops a worker before the daemon ends it, all within two minutes');
});

test('w2443: at a pause, a worker mid-turn is told once; one between turns is stopped, not woken; a stopped one is left alone', () => {
  const t = world();
  t.worker('mid1', { live: true, mid: true, requests: [['w1', 'active']] });
  t.worker('idle1', { live: true, requests: [['w2', 'blocked']] });
  t.worker('gone1', { requests: [['w3', 'blocked']] });
  const p = new MachinePauses(t.d);
  t.pause(PAUSED);
  p.onPause('beast');
  assert.deepEqual(t.told.map(([id]) => id), ['mid1']);
  assert.match(t.told[0][1], /w1: still open: paused on beast/);
  assert.deepEqual(t.stopped, ['idle1'], 'the live idle worker is stopped; its request keeps its gate and its resume waits for the unpause');
  assert.equal(t.handed.length, 0, 'nothing is blocked before a turn ends');
  p.tick();
  assert.equal(t.told.length, 1, 'told once');
});

test('w2443, LothLaptop live check (2026-10-29): a worker between turns with nothing pending is saved and Blocked; one a person, check-in or message resumes is not', async () => {
  const t = world();
  // w2494's target: it ended its turn with a background job going, so no check-in or message would ever resume it.
  t.worker('bg1', { live: true, requests: [['w1', 'active']] });
  t.worker('person1', { live: true, requests: [['w2', 'active']] });
  t.sessions.get('person1')!.waitingOn = { who: 'lothsahn', what: 'decide', at: '2026-10-29T00:00:00Z' };
  t.worker('wake1', { live: true, requests: [['w3', 'active']] });
  t.sessions.get('wake1')!.wakeAt = '2026-10-29T01:30:00Z';
  t.worker('msg1', { live: true, requests: [['w4', 'active']] });
  t.sessions.get('msg1')!.queuedSend = 'CI finished';
  const p = new MachinePauses(t.d);
  t.pause(PAUSED);
  p.onPause('beast');
  await settle();
  await settle();
  assert.deepEqual(t.stopped.sort(), ['bg1', 'msg1', 'person1', 'wake1'], 'every live worker there is stopped');
  assert.equal(t.told.length, 0, 'none is woken');
  assert.deepEqual(t.handed.map((x) => x.w), ['w1'], 'only the one nothing else would resume is Blocked on the pause');
  assert.equal(t.handed[0].h.how, 'stopped between turns');
  assert.match(t.handed[0].h.saved!, /saved as WIP commit abc1234def on sandbox\/slot5-w1532 and pushed/);
  assert.equal(t.work.get('w1')!.status, 'blocked');
  assert.equal(t.work.get('w3')!.status, 'active', 'its check-in, held by the pause, resumes it');
  p.tick();
  await settle();
  assert.equal(t.handed.length, 1, 'blocked once');
});

test('w2443: a worker that stops by itself: stopped, its sandbox saved, its request Blocked on the pause with its branch and line', async () => {
  const t = world();
  t.worker('mid1', { live: true, mid: true, requests: [['w1', 'active'], ['w9', 'blocked']] });
  const p = new MachinePauses(t.d);
  t.pause(PAUSED);
  p.onPause('beast');
  t.mid.delete('mid1');
  assert.equal(p.turnEnded(t.sessions.get('mid1')!, 'Pushed.\nw1: still open: paused on beast; branch feature/x pushed; tests written, the UI is left'), true);
  await settle();
  await settle();
  assert.deepEqual(t.stopped, ['mid1']);
  assert.deepEqual(t.saved, ['slot5@sandbox/slot5-w1532'], 'the sandbox branch is saved (its own push is in feature/x)');
  assert.deepEqual(t.handed.map((x) => x.w), ['w1'], 'w9 waits on its own gate as it was');
  const h = t.handed[0].h;
  assert.equal(h.branch, 'feature/x', 'the branch its line names');
  assert.equal(h.how, 'by its worker');
  assert.match(h.note, /^w1: still open: paused on beast; branch feature\/x pushed/);
  assert.match(h.saved!, /saved as WIP commit abc1234def on sandbox\/slot5-w1532 and pushed/);
  assert.equal(t.work.get('w1')!.status, 'blocked');
});

test('w2443, LothLaptop live check (2026-10-28): a save the daemon refuses while the worker\'s process still runs is tried again until it lands', async () => {
  // Worker 8cf0b0be's save came 5 s after the interrupt, was refused ("agent 8cf0b0be runs in sandbox slot1") and was never tried again.
  const t = world();
  t.worker('mid1', { live: true, mid: true, requests: [['w1', 'active']] });
  let refusals = 2;
  const waited: number[] = [];
  t.d.save = async (i, branch): Promise<SaveResult> => {
    if (refusals-- > 0) throw new Error(`agent ${i.id} runs in sandbox ${i.machineSandbox}`);
    t.saved.push(`${i.machineSandbox}@${branch}`);
    return { sha: 'abc1234def5678', files: 1, pushed: true, notes: [] };
  };
  t.d.wait = async (ms) => void waited.push(ms);
  const p = new MachinePauses(t.d);
  t.pause(PAUSED);
  p.onPause('beast');
  t.mid.delete('mid1');
  p.turnEnded(t.sessions.get('mid1')!, '');
  for (let i = 0; i < 10; i++) await settle();
  assert.deepEqual(waited, [SAVE_RETRY_MS, SAVE_RETRY_MS]);
  assert.deepEqual(t.saved, ['slot5@sandbox/slot5-w1532']);
  assert.match(t.handed[0].h.saved!, /saved as WIP commit abc1234def on sandbox\/slot5-w1532 and pushed/);
  // Another failure is not waited on, and a refusal that never ends gives up in time.
  const u = world();
  u.worker('mid2', { live: true, mid: true, requests: [['w2', 'active']] });
  let tries = 0;
  u.d.save = async (i) => {
    tries++;
    throw new Error(`agent ${i.id} runs in sandbox slot5`);
  };
  u.d.wait = async () => {};
  const q = new MachinePauses(u.d);
  u.pause(PAUSED);
  q.onPause('beast');
  u.mid.delete('mid2');
  q.turnEnded(u.sessions.get('mid2')!, '');
  for (let i = 0; i < 60; i++) await settle();
  assert.equal(tries, SAVE_RETRY_FOR_MS / SAVE_RETRY_MS + 1);
  assert.match(u.handed[0].h.saved!, /could not be saved \(agent mid2 runs in sandbox slot5\)/);
});

test('w2443: a nonresponsive worker (ignores the notice and the interrupt) is interrupted at 60 s and stopped at 75 s, its work saved and Blocked', async () => {
  const t = world();
  t.worker('mid1', { live: true, mid: true, requests: [['w1', 'active']] });
  const p = new MachinePauses(t.d);
  t.pause(PAUSED);
  p.onPause('beast');
  t.tick(PAUSE_GRACE_MS.value - 5000);
  p.tick();
  assert.deepEqual(t.interrupted, []);
  t.tick(5000);
  p.tick();
  assert.deepEqual(t.interrupted, ['mid1'], 'interrupted at 60 s');
  t.tick(PAUSE_STOP_AFTER_MS.value - 5000);
  p.tick();
  assert.deepEqual(t.stopped, [], 'not yet');
  t.tick(5000);
  p.tick();
  await settle();
  await settle();
  assert.deepEqual(t.stopped, ['mid1'], 'the interrupt did not end the turn: stopped (the daemon ends what is left of its tree at 90 s)');
  assert.deepEqual(t.saved, ['slot5@sandbox/slot5-w1532']);
  assert.deepEqual(t.handed.map((x) => [x.w, x.h.how, x.h.branch]), [['w1', 'forced (stopped)', 'sandbox/slot5-w1532']]);
  p.tick();
  assert.equal(t.handed.length, 1, 'blocked once');
});

test('w2443: a worker whose process the daemon ended (no turn end) is still Blocked on the pause', async () => {
  const t = world();
  t.worker('mid1', { live: true, mid: true, requests: [['w1', 'active']] });
  const p = new MachinePauses(t.d);
  t.pause(PAUSED);
  p.onPause('beast');
  t.live.delete('mid1');
  t.mid.delete('mid1');
  p.tick();
  await settle();
  await settle();
  assert.deepEqual(t.handed.map((x) => [x.w, x.h.how]), [['w1', 'its process ended']]);
});

test('w2443: an interrupted turn that ends is Blocked as forced; an unpause before a turn ends blocks nothing', async () => {
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
  assert.equal(t.handed[0].h.how, 'forced: interrupted 60 s after the pause notice');
  assert.match(t.handed[0].h.note, /its last report: w1: still open: tests/);
  t.pause({ paused: false, detail: 'running: no schedule set' });
  p.onUnpause('beast');
  t.mid.delete('mid2');
  assert.equal(p.turnEnded(t.sessions.get('mid2')!, 'Done.'), false, 'running again: a turn end is a turn end');
  assert.equal(t.handed.length, 1);
});

test('w2443: a resume the pause holds waits for the unpause; the stale pause notice is dropped', () => {
  const t = world();
  t.worker('gone1', { requests: [['w3', 'blocked']] });
  const p = new MachinePauses(t.d);
  assert.equal(p.heldResume(t.sessions.get('gone1')!, '[ci] green'), false, 'running: nothing held');
  t.pause(PAUSED);
  assert.equal(p.heldResume(t.sessions.get('gone1')!, '[ci] PR #12: every check passed'), false, 'it waits in the queue for the unpause');
  assert.equal(p.heldResume(t.sessions.get('gone1')!, pauseNotice('beast', PAUSED, ['w3'])), true, 'the notice for a turn that is over is dropped');
  assert.equal(t.handed.length, 0);
});

test('w1532: the next worker\'s handover names the hand-back, its branch, the note and the waiting message', () => {
  const note = handoverNote({ id: 'w3' }, { related: [], handedBack: { at: '2026-10-19T14:05:00.000Z', from: 'beast/slot5', session: 'gone1', branch: 'sandbox/slot5-w3', why: 'paused from its tray app: someone is using it (w1532)', note: 'its last report: w3: still open: CI', how: 'on a held resume', saved: 'its sandbox had no uncommitted work on sandbox/slot5-w3', message: '[ci] PR #12: every check passed' } });
  assert.match(note, /Handed back \(w1532\): w3 was taken off worker gone1 on beast\/slot5 at 2026-10-19 14:05 UTC, because that machine is paused from its tray app: someone is using it \(w1532\) \(on a held resume\)\. Continue from its branch sandbox\/slot5-w3/);
  assert.match(note, /The message that was waiting for it when it was handed back, now yours:\n~~~text\n\[ci\] PR #12: every check passed\n~~~/);
});
