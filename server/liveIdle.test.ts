// w1746: which Live views are idle long enough to have their editor closed, and the portal's sweep around it
// (server/liveIdle.ts). The daemon's half (save and quit) is server/liveIdleMachine.test.ts; both ends together are
// server/liveIdleDaemon.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveIdleCloser, idleClosedPart, liveIdleBlock, liveIdleStatusLine, type LiveIdleView } from './liveIdle.ts';
import type { MachineSandbox, SessionInfo } from '../shared/types.ts';

const NOW = Date.parse('2026-10-22T14:00:00Z');
const min = (n: number) => n * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const view = (o: Partial<LiveIdleView> = {}): LiveIdleView => ({ liveId: 'l1', sessionId: 'w1', machineId: 'beast', sandbox: 'slot5', startedAtMs: NOW - min(360), viewers: 0, ...o });
const sandbox = (o: Partial<MachineSandbox> = {}): MachineSandbox =>
  ({ id: 'slot5', branch: 'w1466-urso', base: 'origin/master', path: 'F:/ffw/sandboxes/slot5', purpose: 'slot5', status: 'ready', createdAt: iso(NOW - min(600)), unity: { state: 'running', pid: 4242 }, sessionIds: ['w1'], ...o }) as MachineSandbox;
const session = (o: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id: 'w1', kind: 'worker', status: 'idle', machineId: 'beast', machineSandbox: 'slot5', lastActivityAt: iso(NOW - min(20)), pendingPermissions: [], ...o }) as SessionInfo;
const facts = (o: { sb?: MachineSandbox; sessions?: SessionInfo[]; wake?: boolean } = {}) => ({ sandbox: o.sb ?? sandbox(), sessions: o.sessions ?? [session()], wakePending: () => !!o.wake });

test('w1746: a Live view idle 15 minutes (no turn, job, check-in or viewer) has its editor closed', () => {
  assert.equal(liveIdleBlock(view(), facts(), NOW, 15), undefined);
  assert.equal(liveIdleBlock(view(), facts({ sessions: [session({ lastActivityAt: iso(NOW - min(10)) })] }), NOW, 15), 'idle 10 of 15 min');
  assert.equal(liveIdleBlock(view(), facts(), NOW, 30), 'idle 20 of 30 min', 'the minutes are the setting');
  assert.match(liveIdleBlock(view(), facts(), NOW, 0) ?? '', /off/);
});

test('w1746: a viewer watching, or watching until a moment ago, or a knob moved: no close', () => {
  assert.equal(liveIdleBlock(view({ viewers: 1 }), facts(), NOW, 15), '1 page watching');
  assert.equal(liveIdleBlock(view({ watchedAt: NOW - min(5) }), facts(), NOW, 15), 'idle 5 of 15 min');
  assert.equal(liveIdleBlock(view({ touchedAt: NOW - min(2) }), facts(), NOW, 15), 'idle 2 of 15 min');
});

test('w1746: a turn, a running tool, a background job, a permission or a check-in in that sandbox: no close', () => {
  const block = (s: Partial<SessionInfo>, wake = false) => liveIdleBlock(view(), facts({ sessions: [session(s)], wake }), NOW, 15);
  assert.equal(block({ status: 'running' }), 'w1 is mid-turn');
  assert.equal(block({ activeTool: { id: 't1', name: 'Bash', since: iso(NOW - min(30)) } }), 'w1 is running Bash');
  assert.equal(block({ backgroundTasks: 1 }), 'w1 has a background job running');
  assert.equal(block({ wakeAt: iso(NOW + min(90)) }), `w1 has a check-in pending (${iso(NOW + min(90))})`);
  assert.equal(block({}, true), 'w1 has a check-in pending');
  // The other worker sharing the sandbox counts too.
  assert.equal(liveIdleBlock(view(), facts({ sessions: [session(), session({ id: 'w2', status: 'starting' })] }), NOW, 15), 'w2 is mid-turn');
  // An editor not running, or closed already, is not closed again.
  assert.equal(liveIdleBlock(view(), facts({ sb: sandbox({ unity: { state: 'starting' } }) }), NOW, 15), 'its editor is starting');
  assert.equal(liveIdleBlock(view(), facts({ sb: sandbox({ unity: { state: 'stopped' }, idleClosed: { at: iso(NOW), minutes: 15 } }) }), NOW, 15), 'its editor is closed already');
});

function closer(o: { answer?: string; minutes?: number } = {}) {
  let sb = sandbox();
  let s = session();
  let now = NOW;
  const v = view();
  const asked: { liveId: string; minutes: number }[] = [];
  const sent: { id: string; text: string }[] = [];
  const logs: string[] = [];
  const c = new LiveIdleCloser({
    minutes: () => o.minutes ?? 15,
    views: () => [v],
    sandbox: () => sb,
    session: () => s,
    wakePending: () => false,
    canClose: () => true,
    close: async (view, minutes) => {
      asked.push({ liveId: view.liveId, minutes });
      const text = o.answer ?? 'closed (saved Assets/Scenes/Look.unity and the assets first)';
      if (text.startsWith('closed')) sb = sandbox({ unity: { state: 'stopped' }, idleClosed: { at: iso(now), minutes, saved: ['Assets/Scenes/Look.unity'] } });
      return text;
    },
    send: (id, text) => sent.push({ id, text }),
    log: (l) => logs.push(l),
    now: () => now,
  });
  const settle = () => new Promise((r) => setTimeout(r, 5));
  return {
    c,
    v,
    asked,
    sent,
    logs,
    settle,
    set sb(x: MachineSandbox) {
      sb = x;
    },
    get sb() {
      return sb;
    },
    set session(x: SessionInfo) {
      s = x;
    },
    advance: (ms: number) => (now += ms),
  };
}

test('w1746: the sweep asks once, logs the close, wakes the worker once when a person opens the view, and logs the reopen', async () => {
  const k = closer();
  await k.c.sweep();
  await k.settle();
  assert.deepEqual(k.asked, [{ liveId: 'l1', minutes: 15 }]);
  assert.match(k.logs[0], /^live idle: beast\/slot5: w1's Live view idle 15 min: editor closed \(saved/);
  await k.c.sweep();
  await k.settle();
  assert.equal(k.asked.length, 1, 'a closed editor is not asked again');
  assert.equal(idleClosedPart(k.sb), 'editor closed: idle 15 min; reopens on resume (closed 14:00Z, saved Assets/Scenes/Look.unity first)');

  // Resume by a viewer: the worker is woken once, whatever the number of pages.
  k.c.viewerOpened(k.v, 'Ben');
  k.c.viewerOpened(k.v, 'Ben');
  assert.equal(k.sent.length, 1);
  assert.equal(k.sent[0].id, 'w1');
  assert.match(k.sent[0].text, /^\[live view\] Ben opened your Live view/);

  // The daemon reopened it at that turn: the sweep logs it, and a later close can wake the worker again.
  k.sb = sandbox({ unity: { state: 'starting' } });
  await k.c.sweep();
  assert.match(k.logs.at(-1)!, /^live idle: beast\/slot5: its editor opened again \(unity starting\)$/);
});

test('w1746: a skipped close (unsaved changes it could not save) is logged and asked again only after another idle period', async () => {
  const k = closer({ answer: 'skipped: 1 untitled scene has unsaved changes (saving would ask where)' });
  await k.c.sweep();
  await k.settle();
  assert.match(k.logs[0], /editor skipped: 1 untitled scene/);
  k.advance(min(5));
  await k.c.sweep();
  await k.settle();
  assert.equal(k.asked.length, 1);
  k.advance(min(11));
  await k.c.sweep();
  await k.settle();
  assert.equal(k.asked.length, 2);
});

test('w1746: a viewer opening a view whose editor runs wakes nobody', () => {
  const k = closer();
  k.c.viewerOpened(k.v, 'Ben');
  assert.equal(k.sent.length, 0);
});

test('w1746: system_status says the rule and the editors closed now', () => {
  const m = [{ id: 'beast', sandboxes: [sandbox({ idleClosed: { at: '2026-10-22T14:00:00.000Z', minutes: 15 } }), sandbox({ id: 'slot3' })] }];
  assert.equal(liveIdleStatusLine(true, 15, m), 'Live view idle close: a Live view idle 15 min has its editor closed (live.idleCloseMinutes); editor closed: idle; reopens on resume: beast/slot5 (since 14:00Z).');
  assert.equal(liveIdleStatusLine(true, 15, [{ id: 'beast', sandboxes: [] }]), 'Live view idle close: a Live view idle 15 min has its editor closed (live.idleCloseMinutes); no editor closed now.');
  assert.equal(liveIdleStatusLine(false, 15, m), undefined);
});
