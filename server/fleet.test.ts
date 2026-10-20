import test from 'node:test';
import assert from 'node:assert/strict';
import { capacityLine, chatLedger, chatMatters, fleetOf, slotCall, type PersonWait } from '../shared/fleet.ts';
import type { LiveViewInfo, Machine, MachineSandbox, SessionInfo, SessionStatus, SystemStats, WorkItem } from '../shared/types.ts';

const T = '2026-09-29T10:00:00.000Z';

const session = (id: string, status: SessionStatus, where: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  kind: 'worker',
  title: id,
  status,
  permissionMode: 'bypassPermissions',
  createdAt: T,
  lastActivityAt: T,
  turns: 0,
  costUsd: 0,
  pendingPermissions: [],
  ...where,
});

const machineSandbox = (id: string, purpose: string, sessionIds: string[] = [], unity: MachineSandbox['unity']['state'] = 'stopped'): MachineSandbox => ({
  id,
  branch: `sandbox/${id}`,
  base: 'origin/develop',
  path: `D:/work/ffsb/${id}`,
  purpose,
  status: 'ready',
  createdAt: T,
  unity: { state: unity },
  sessionIds,
  git: { branch: `feature/${id}`, dirty: 0, untracked: 0, at: T },
});

const machine = (id: string, extra: Partial<Machine> = {}): Machine => ({
  id,
  host: id,
  purpose: 'unused',
  status: 'ready',
  online: true,
  repoPath: 'D:/work/mainrepo',
  home: 'C:/Users/dev',
  portalUrl: 'https://portal.example',
  sessionIds: [],
  createdAt: T,
  ...extra,
});

const system = { hostname: 'BEAST', platform: 'win32 10.0.26100' } as SystemStats;

test('fleet: the host first, then each machine, with sandboxes and their live agents (w536: no main-clone agents)', () => {
  const sessions = [
    session('ask', 'waiting_permission', { machineId: 'lothdesktop', machineSandbox: 'sb1', pendingPermissions: [{ requestId: 'r', toolName: 'Bash', input: {}, createdAt: T }] }),
    session('duty', 'running', { machineId: 'lothdesktop', kind: 'standing', standingId: 'st' }),
  ];
  const fleet = fleetOf({
    system,
    sessions,
    machines: [
      machine('lothdesktop', {
        name: 'LothDesktop',
        platform: 'win32',
        sandboxRoot: 'D:/work/ffsb',
        maxSandboxes: 3,
        sessionIds: ['ask', 'duty'],
        sandboxes: [machineSandbox('sb2', 'unused'), machineSandbox('sb1', 'Nightly e2e', ['ask'], 'running')],
      }),
      machine('m3', { online: false }),
    ],
  });

  assert.deepEqual(
    fleet.map((c) => [c.key, c.name, c.host]),
    [
      ['host', 'BEAST', true],
      ['lothdesktop', 'LothDesktop', false],
      ['m3', 'm3', false],
    ],
  );

  const [host, loth, m3] = fleet;
  // The portal's own host, with no daemon of its own: it holds no sandboxes (w510).
  assert.deepEqual(host.sandboxes, []);
  assert.equal(capacityLine(host), 'orchestrators only');
  assert.deepEqual([host.live, host.busy, host.attention], [0, 0, 0]);

  // A machine sandbox is keyed "<machine>/<id>" and shows the branch git reports; in-use sandboxes first.
  assert.deepEqual(loth.sandboxes.map((s) => [s.key, s.branch, s.free]), [['lothdesktop/sb1', 'feature/sb1', false], ['lothdesktop/sb2', 'feature/sb2', true]]);
  assert.equal(loth.sandboxes[0].attention, 1);
  assert.equal(capacityLine(loth), '2/3 sandboxes · 1/2 editors');
  // Its sandboxes' agents; the standing agent has its own list.
  assert.deepEqual([loth.live, loth.busy, loth.attention], [1, 1, 1]);

  // No sandbox_root: it takes no workers (w536).
  assert.equal(m3.online, false);
  assert.equal(capacityLine(m3), 'no sandboxes');
});

test('fleet: a sandbox with a live agent is never free; its label says nothing about use (w575); what it does is its agents’ titles', () => {
  const fleet = fleetOf({
    system,
    sessions: [session('idle', 'idle', { machineId: 'lothdesktop', machineSandbox: 'spare', title: 'w513: LothDesktop fresh install' }), session('busy', 'running', { machineId: 'lothdesktop', machineSandbox: 'spare', title: 'w575: titles follow the job' })],
    machines: [
      machine('lothdesktop', {
        sandboxRoot: 'D:/work/ffsb',
        sessionIds: ['idle', 'busy'],
        sandboxes: [machineSandbox('spare', 'unused', ['idle', 'busy']), machineSandbox('named', 'Shader work'), machineSandbox('empty', '')],
      }),
    ],
  });
  assert.deepEqual(fleet[1].sandboxes.map((s) => [s.key, s.free]).sort(), [['lothdesktop/empty', true], ['lothdesktop/named', true], ['lothdesktop/spare', false]]);
  // The Working agent's title first.
  assert.deepEqual(fleet[1].sandboxes.find((s) => s.id === 'spare')!.doing, ['w575: titles follow the job', 'w513: LothDesktop fresh install']);
});

test('fleet: the portal with no daemon of its own and no stats is "This host", running the orchestrators only (w510)', () => {
  const [host] = fleetOf({ sessions: [], machines: [] });
  assert.equal(host.name, 'This host');
  assert.equal(capacityLine(host), 'orchestrators only');
});

// ---------------------------------------------------------------- w1430: the chats that matter now, and the slot's call

const NOW = Date.parse('2026-10-17T16:00:00.000Z');
const ago = (m: number) => new Date(NOW - m * 60_000).toISOString();
const BEN = { userId: 'ben', displayName: 'Ben' };
const item = (id: string, status: WorkItem['status'], sessionIds: string[], extra: Partial<WorkItem> = {}): WorkItem => ({
  id,
  title: id,
  brief: '',
  priority: 'normal',
  keys: [],
  requestedBy: BEN,
  requesters: [BEN],
  humanAsked: true,
  status,
  createdAt: ago(600),
  updatedAt: ago(10),
  sessionIds,
  overlaps: [],
  asks: 0,
  log: [],
  ...extra,
});
const at = (sb: string) => ({ machineId: 'lothdesktop', machineSandbox: sb });
const ledgerOf = (sessions: SessionInfo[], work: WorkItem[]) => chatLedger(work, new Map(sessions.map((s) => [s.id, s])), NOW);

test('w1430: a chat matters now when it runs, has its own work going, holds its sandbox, or is the current worker of an open request', () => {
  const sessions = [
    session('busy', 'running', at('slot2')),
    session('asks', 'waiting_permission', { ...at('slot2'), pendingPermissions: [{ requestId: 'r', toolName: 'Bash', input: {}, createdAt: ago(1) }] }),
    session('ci', 'idle', { ...at('slot3'), backgroundJobs: [{ type: 'local_bash', description: 'CI on PR #1851' }] }),
    session('checkin', 'stopped', { ...at('slot3'), wakeAt: ago(-20) }),
    // Finished: idle with nothing pending, its request done.
    session('finished', 'idle', at('slot2')),
    // Stopped on a closed request, and stopped on none.
    session('closed', 'stopped', at('slot1')),
    session('loose', 'stopped', at('slot4')),
    // w1325: 6e7c4ceb was replaced by fff83521, which waits on Ben, stopped.
    session('6e7c4ceb', 'stopped', { machineId: 'beast', machineSandbox: 'slot4' }),
    session('fff83521', 'stopped', { ...at('slot1'), waitingOn: { who: 'Ben', what: 'Drag the fin colour in the Live view', at: ago(9), request: 'w1325' } }),
    // An open request whose worker stopped without saying anything: still on an open request.
    session('quiet', 'stopped', at('slot3')),
    // A stalled request is not open.
    session('failed', 'error', at('slot4')),
  ];
  const work = [
    item('w1', 'done', ['finished']),
    item('w2', 'done', ['closed']),
    item('w1325', 'active', ['6e7c4ceb', 'fff83521'], { links: { '6e7c4ceb': { at: ago(500), how: 'sent' }, fff83521: { at: ago(400), how: 'sent' } } }),
    item('w3', 'active', ['quiet']),
    item('w4', 'stalled', ['failed']),
  ];
  const ledger = ledgerOf(sessions, work);
  const shown = sessions.filter((s) => chatMatters(s, ledger, NOW)).map((s) => s.id);
  assert.deepEqual(shown, ['busy', 'asks', 'ci', 'checkin', 'fff83521', 'quiet']);
  // The request's current worker is its latest that still holds it: not the one it moved from.
  assert.deepEqual([...ledger.current.entries()].sort(), [['fff83521', ['w1325']], ['quiet', ['w3']]]);
});

test('w1430: a worker waits on a person when its request is Waiting on input for what it asked, not for a permission, an approval or the dispatcher', () => {
  const sessions = [
    session('knob', 'stopped', { ...at('slot1'), waitingOn: { who: 'Ben', what: 'Drag the knob', at: ago(9), request: 'w1325' } }),
    session('report', 'idle', { ...at('slot2'), lastResult: 'Stills are up.\n\nw7: still open: waiting on Ben to OK the look' }),
    session('perm', 'waiting_permission', { ...at('slot3'), pendingPermissions: [{ requestId: 'r', toolName: 'Bash', input: {}, createdAt: ago(1) }] }),
    session('asked', 'idle', at('slot4')),
  ];
  const work = [
    item('w1325', 'active', ['knob']),
    item('w7', 'active', ['report']),
    item('w8', 'active', ['perm']),
    item('w9', 'question', ['asked'], { question: { text: 'Which one?', at: ago(5) } }),
  ];
  const waits = ledgerOf(sessions, work).waits;
  assert.deepEqual(
    [...waits.values()].map((w) => [w.session.id, w.request, w.on]),
    [
      ['knob', 'w1325', ['Ben']],
      ['report', 'w7', ['Ben']],
    ],
  );
});

test('w1430: the slot calls the viewer to the Live view when the worker that waits on them streams one, else only says it asked (w1521)', () => {
  const knob = session('knob', 'stopped', at('slot1'));
  const wait = (on: string[]): PersonWait => ({ session: knob, request: 'w1325', on });
  const place = (waits: PersonWait[]) => ({ shown: [knob], older: [], waits });
  const view = (state: LiveViewInfo['state'], sessionId = 'knob'): LiveViewInfo => ({ liveId: 'l1', sessionId, machineId: 'lothdesktop', sandbox: 'slot1', state, detail: '', fps: 15, width: 960, materials: ['heatExchangerMaterial'], startedAt: ago(12), updatedAt: ago(0), frames: 100 });
  const ben = { userId: 'ben', displayName: 'Ben' };
  const call = slotCall(place([wait(['Ben'])]), [view('live')], ben);
  assert.deepEqual(call && { ...call, session: call.session.id }, { kind: 'live', session: 'knob', request: 'w1325', label: 'Live view: go' });
  // A view that is holding (the game reloading scripts) still opens it, whatever the name's case; a stopped one does not.
  assert.equal(slotCall(place([wait(['Ben'])]), [view('holding')], { userId: 'BEN', displayName: 'ben' })?.label, 'Live view: go');
  assert.equal(slotCall(place([wait(['Ben'])]), [view('stopped')], ben)?.label, 'Asked you');
  assert.equal(slotCall(place([wait(['Ben'])]), undefined, ben)?.kind, 'asked');
  // Someone else's wait, nobody signed in, or no wait and no view: no call.
  assert.equal(slotCall(place([wait(['Lothsahn'])]), [view('live', 'other')], ben), undefined);
  assert.equal(slotCall(place([wait(['Ben'])]), [view('live')], undefined), undefined);
  assert.equal(slotCall(place([]), [], ben), undefined);
});

test('w1430: a Live view up while its worker is between turns calls the person who asked for that worker, declared or not', () => {
  const view = (sessionId: string): LiveViewInfo => ({ liveId: 'l1', sessionId, machineId: 'lothdesktop', sandbox: 'slot4', state: 'live', detail: '', fps: 15, width: 960, materials: ['VfxComet'], startedAt: ago(12), updatedAt: ago(0), frames: 100 });
  const comet = session('comet', 'idle', { ...at('slot4'), requestedBy: BEN });
  const ben = { userId: 'ben', displayName: 'Ben' };
  const call = slotCall({ shown: [comet], older: [], waits: [] }, [view('comet')], ben);
  assert.deepEqual(call && { ...call, session: call.session.id }, { kind: 'live', session: 'comet', label: 'Live view: go' });
  // Mid-turn, it is the worker's move: no amber call, only the quiet button (w1599); asked by someone else, it is theirs.
  assert.equal(slotCall({ shown: [{ ...comet, status: 'running' }], older: [], waits: [] }, [view('comet')], ben)?.kind, 'watch');
  assert.equal(slotCall({ shown: [comet], older: [], waits: [] }, [view('comet')], { userId: 'lothsahn', displayName: 'Lothsahn' }), undefined);
  // Handed over (lastRequestedBy) counts as asked.
  assert.equal(slotCall({ shown: [{ ...comet, requestedBy: undefined, lastRequestedBy: BEN }], older: [], waits: [] }, [view('comet')], ben)?.kind, 'live');
});

test("w1599: a Live view up shows everyone who may watch it a quiet button; only the person it waits on gets the amber call", () => {
  const view = (sessionId: string, state: LiveViewInfo['state'] = 'live'): LiveViewInfo => ({ liveId: 'l1', sessionId, machineId: 'lothdesktop', sandbox: 'slot4', state, detail: '', fps: 15, width: 960, materials: ['VfxComet'], startedAt: ago(12), updatedAt: ago(0), frames: 100 });
  const comet = session('comet', 'idle', { ...at('slot4'), requestedBy: BEN });
  const place = (shown = [comet]) => ({ shown, older: [], waits: [] });
  const lothsahn = { userId: 'lothsahn', displayName: 'Lothsahn', role: 'owner' as const };
  const ben = { userId: 'ben', displayName: 'Ben', role: 'member' as const };
  const stranger = { userId: 'zed', displayName: 'Zed', role: 'member' as const };
  // An owner, on someone else's request: the same label, kind 'watch' (the page draws it quiet).
  const watch = slotCall(place(), [view('comet')], lothsahn);
  assert.deepEqual(watch && { ...watch, session: watch.session.id }, { kind: 'watch', session: 'comet', label: 'Live view: go' });
  // The requester's call is unchanged: amber while the worker is between turns...
  assert.equal(slotCall(place(), [view('comet')], ben)?.kind, 'live');
  // ...and the requester's own view while the worker runs, or an owner's on a view that waits on the requester, is quiet.
  assert.equal(slotCall(place([{ ...comet, status: 'running' }]), [view('comet')], ben)?.kind, 'watch');
  assert.equal(slotCall(place([{ ...comet, status: 'running' }]), [view('comet')], lothsahn)?.kind, 'watch');
  const waits = [{ session: comet, request: 'w1325', on: ['Ben'] }];
  assert.equal(slotCall({ shown: [comet], older: [], waits }, [view('comet')], ben)?.kind, 'live');
  assert.equal(slotCall({ shown: [comet], older: [], waits }, [view('comet')], lothsahn)?.kind, 'watch');
  // A member who did not ask for the worker sees none, and neither does anyone when the view is stopped or absent.
  assert.equal(slotCall(place(), [view('comet')], stranger), undefined);
  assert.equal(slotCall(place(), [view('comet', 'stopped')], lothsahn), undefined);
  assert.equal(slotCall(place(), undefined, lothsahn), undefined);
  assert.equal(slotCall(place(), [view('other')], lothsahn), undefined);
  assert.equal(slotCall(place(), [view('comet')], undefined), undefined);
});

test('w1430: fleetOf lists the chats that matter now per slot, the person-waiting one first, and folds the rest, the newest first', () => {
  const sessions = [
    session('busy', 'running', { ...at('slot1'), lastActivityAt: ago(1) }),
    session('knob', 'stopped', { ...at('slot1'), lastActivityAt: ago(30), waitingOn: { who: 'Ben', what: 'Drag the knob', at: ago(30), request: 'w1325' } }),
    session('old1', 'stopped', { ...at('slot1'), lastActivityAt: ago(300) }),
    session('old2', 'idle', { ...at('slot1'), lastActivityAt: ago(40) }),
    session('old3', 'stopped', { ...at('slot2'), lastActivityAt: ago(100) }),
  ];
  const [, loth] = fleetOf(
    {
      system,
      sessions,
      work: [item('w1325', 'active', ['knob']), item('w2', 'done', ['old2'])],
      machines: [machine('lothdesktop', { sandboxRoot: 'D:/work/ffsb', sessionIds: sessions.map((s) => s.id), sandboxes: [machineSandbox('slot1', 'slot1', ['old1', 'busy', 'knob', 'old2']), machineSandbox('slot2', 'slot2', ['old3'])] })],
    },
    undefined,
    NOW,
  );
  const slot1 = loth.sandboxes.find((s) => s.id === 'slot1')!.agents;
  assert.deepEqual(slot1.shown.map((s) => s.id), ['knob', 'busy']);
  assert.deepEqual(slot1.older.map((s) => s.id), ['old2', 'old1']);
  assert.deepEqual(slot1.waits.map((w) => [w.session.id, w.on]), [['knob', ['Ben']]]);
  // What placement reads is unchanged: the idle one is still a live process, the stopped ones a count.
  assert.deepEqual([slot1.live.map((s) => s.id), slot1.stopped], [['busy', 'old2'], 2]);
  const slot2 = loth.sandboxes.find((s) => s.id === 'slot2')!;
  assert.deepEqual([slot2.agents.shown.length, slot2.agents.older.length, slot2.free], [0, 1, true]);
  // Without the ledger (a server-side caller), only the live and returning chats are listed.
  const [, bare] = fleetOf({ system, sessions, machines: [machine('lothdesktop', { sandboxRoot: 'D:/work/ffsb', sandboxes: [machineSandbox('slot1', 'slot1', ['old1', 'busy', 'knob', 'old2'])] })] }, undefined, NOW);
  assert.deepEqual(bare.sandboxes[0].agents.shown.map((s) => s.id), ['busy']);
});

test('w1504: the slot badge clears with the ledger: w1243 blocked on w1438 after Ben answered shows no "Asked you" on beast/slot1', () => {
  const report = 'w1243: still open: waiting on Ben to route the two-peer run for PR #1699 to a Windows machine; then merge';
  const sessions = [
    session('26d27a69', 'stopped', { machineId: 'beast', machineSandbox: 'slot1', lastResult: report, lastResultAt: ago(3000), lastActivityAt: ago(30) }),
    session('0db9f8a2', 'stopped', { machineId: 'beast', machineSandbox: 'slot1', lastResult: 'w1243: still open: the big-save A/B in the overnight BEAST window', lastResultAt: ago(2000) }),
  ];
  const links = { '26d27a69': { at: ago(4000), how: 'sent' as const }, '0db9f8a2': { at: ago(3500), how: 'sent' as const } };
  const ben = { userId: 'ben', displayName: 'Ben' };
  const callOf = (w: WorkItem) => {
    const ledger = ledgerOf(sessions, [w]);
    return slotCall({ shown: sessions, older: [], waits: [...ledger.waits.values()] }, [], ben);
  };
  // Before Ben answered: the slot says 26d27a69 asked him.
  const asked = callOf(item('w1243', 'active', ['26d27a69', '0db9f8a2'], { links }));
  assert.deepEqual([asked?.label, asked?.session.id, asked?.request], ['Asked you', '26d27a69', 'w1243']);
  // Ben's note, then the block on w1438: no call.
  const notes = [{ at: ago(1000), by: 'Ben', text: 'Run it overnight on BEAST with nothing else running' }];
  const blocked = { kind: 'request' as const, ref: 'w1438', what: "w1438's perf benches finishing", at: ago(60), by: 'dispatcher' };
  assert.equal(callOf(item('w1243', 'blocked', ['26d27a69', '0db9f8a2'], { links, notes, blocked })), undefined);
  // PR #1699 merged after the report, no note: no call either.
  const prs = [{ repo: 'Final-Factory/FinalFactory', number: 1699, state: 'merged' as const, at: ago(2900) }];
  assert.equal(callOf(item('w1243', 'active', ['26d27a69', '0db9f8a2'], { links, prs })), undefined);
});
