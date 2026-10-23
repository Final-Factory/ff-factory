// w1838: a Live view says "go" only when it can be used, says what it waits on otherwise, and a view whose editor stopped
// some other way than the idle close comes back when a person opens it (shared/liveReady.ts, server/live.ts, server/liveIdle.ts,
// machine/live.ts). Ben, 2026-10-23: "don't show the live view go sticker thing on the slot. Only show that when it's ready".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { liveReady } from '../shared/liveReady.ts';
import { slotCall } from '../shared/fleet.ts';
import { LIVE_STALL_MS, LiveHub } from './live.ts';
import { LIVE_WAKE_AGAIN_MS, LiveIdleCloser, type LiveIdleView } from './liveIdle.ts';
import { LiveSession, type LiveState } from '../machine/live.ts';
import type { LiveViewInfo, MachineSandbox, SessionInfo } from '../shared/types.ts';

const at = '2026-10-23T07:07:00.000Z';
const view = (o: Partial<LiveViewInfo> = {}): LiveViewInfo => ({ liveId: 'l1', sessionId: 'c1b21df6', machineId: 'beast', sandbox: 'slot5', state: 'live', detail: '', fps: 15, width: 960, materials: ['VfxUrsoBallistaPadArcs'], startedAt: at, updatedAt: at, frames: 10, ...o });
const sb = (state: MachineSandbox['unity']['state'], o: Partial<MachineSandbox> = {}) => ({ unity: { state, ...(o.unity ?? {}) }, ...(o.idleClosed ? { idleClosed: o.idleClosed } : {}) }) as Pick<MachineSandbox, 'unity' | 'idleClosed'>;

test('w1838: only a view that streams is "go"; every other state says what it waits on', () => {
  const cases: [string, ReturnType<typeof liveReady>][] = [
    ['go', liveReady(view(), { sandbox: sb('running') })],
    ['starting', liveReady(view({ state: 'starting' }), { sandbox: sb('running') })],
    // Ben's case: beast/slot5 held with its editor stopped by its worker at 07:07Z, then under the w1836 release build.
    ['editor-stopped', liveReady(view({ state: 'holding', detail: 'the sandbox editor is not running' }), { sandbox: sb('stopped'), session: { status: 'stopped' } })],
    ['held', liveReady(view({ state: 'holding', detail: 'the sandbox editor is not running', hold: 'building since 07:40Z (Urgent hotfix release, the dispatcher for w1836; w1606): no new work until it is done' }), { sandbox: sb('stopped') })],
    ['idle-closed', liveReady(view({ state: 'holding' }), { sandbox: sb('stopped', { idleClosed: { at, minutes: 15 } }) })],
    ['queued', liveReady(view({ state: 'holding' }), { sandbox: sb('starting', { unity: { state: 'starting', detail: 'queued in the bench queue: 1 ahead (w1785 bench)' } }) })],
    ['queued', liveReady(view({ state: 'holding' }), { sandbox: sb('stopped', { unity: { state: 'stopped', detail: 'queued start not made: not started: needs 1, 0 free (3 of 3 in use)' } }) })],
    ['editor-starting', liveReady(view({ state: 'holding' }), { sandbox: sb('starting', { unity: { state: 'starting', detail: 'loading' } }) })],
    ['no-play', liveReady(view({ state: 'holding', detail: 'the game is not in play mode (no agent channel)' }), { sandbox: sb('running') })],
    ['stalled', liveReady(view({ state: 'holding', detail: 'no frame from the game for 12 s (its editor may be busy, minimized or hung)' }), { sandbox: sb('running') })],
    ['holding', liveReady(view({ state: 'holding', detail: 'the game stopped streaming (left play mode, or a script reload); showing the last frame' }), { sandbox: sb('running') })],
  ];
  for (const [kind, r] of cases) {
    assert.equal(r.kind, kind, `${kind}: ${r.badge}`);
    assert.equal(r.ready, kind === 'go', kind);
    assert.equal(r.badge === 'Live view: go', kind === 'go', `${kind} badge: ${r.badge}`);
    if (kind !== 'go') assert.ok(r.why && r.back, `${kind} says why and what brings it back`);
    // Never the old promise over a view whose knobs cannot answer.
    assert.doesNotMatch(`${r.why} ${r.back}`, /knobs still work/);
  }
  // The badges are distinct, so the slot says which.
  const badges = new Map(cases.map(([k, r]) => [k, r.badge]));
  assert.equal(new Set(badges.values()).size, badges.size);
  assert.equal(badges.get('held'), 'Live view: paused for a build');
  assert.equal(badges.get('editor-stopped'), 'Live view: editor stopped');
  // A worker mid-turn is on it; one between turns is woken by an opening, and after a wake the panel says who and when.
  assert.match(liveReady(view({ state: 'holding' }), { sandbox: sb('stopped'), session: { status: 'running' } }).back, /mid-turn/);
  assert.match(liveReady(view({ state: 'holding' }), { sandbox: sb('stopped'), session: { status: 'stopped' } }).back, /^Opening it asks its worker to start the editor/);
  assert.match(liveReady(view({ state: 'holding', wake: { at: '2026-10-23T07:50:00Z', who: 'Ben' } }), { sandbox: sb('stopped') }).back, /^Ben opened it at 07:50Z: its worker was asked/);
  // A bench lock or a pause is named for what it is.
  assert.equal(liveReady(view({ state: 'holding', hold: "its bench lock is held since 07:00Z (w1785 bench): a timed run" }), { sandbox: sb('stopped') }).badge, 'Live view: waiting on a timed run');
  // Frames flowing win over a machine record that has not caught up.
  assert.equal(liveReady(view(), { sandbox: sb('stopped') }).kind, 'go');
});

test('w1838: the slot\'s badge follows the readiness; "go" only when it can be used', () => {
  const s = { id: 'c1b21df6', title: 'w1466: Urso Ballista Live view for Ben', status: 'stopped', requestedBy: { userId: 'ben', displayName: 'Ben' }, lastActivityAt: at } as unknown as SessionInfo;
  const place = { shown: [s], older: [], waits: [{ session: s, request: 'w1466', on: ['Ben'] }] };
  const ben = { userId: 'ben', displayName: 'Ben' };
  const held = view({ state: 'holding', detail: 'the sandbox editor is not running' });
  const call = slotCall(place, [held], ben, (v, x) => liveReady(v, { sandbox: sb('stopped'), session: x }));
  assert.equal(call?.kind, 'live');
  assert.equal(call?.label, 'Live view: editor stopped');
  assert.equal(call?.ready?.ready, false);
  assert.equal(slotCall(place, [view()], ben, (v, x) => liveReady(v, { sandbox: sb('running'), session: x }))?.label, 'Live view: go');
});

/** A fake daemon frame socket or page. */
function fakeSocket() {
  const e = new EventEmitter() as EventEmitter & { OPEN: number; readyState: number; bufferedAmount: number; sent: unknown[]; send(b: unknown): void; close(): void };
  e.OPEN = 1;
  e.readyState = 1;
  e.bufferedAmount = 0;
  e.sent = [];
  e.send = (b: unknown) => void e.sent.push(b);
  e.close = () => {
    e.readyState = 3;
    e.emit('close');
  };
  return e;
}

function hub(o: { hold?: () => string | undefined; delayMs?: number } = {}) {
  let now = Date.parse('2026-10-23T07:00:00Z');
  const logs: string[] = [];
  let changes = 0;
  const session = { id: 's1', kind: 'worker', title: 'Ballista', machineId: 'beast', machineSandbox: 'slot5', requestedBy: { userId: 'ben', displayName: 'Ben' } } as unknown as SessionInfo;
  let inFlight = 0;
  let most = 0;
  const h = new LiveHub({
    enabled: () => true,
    machines: {
      canLive: () => true,
      live: async (_m, op) => {
        const c = String((op as { command?: string }).command ?? '');
        if (!c.startsWith('look.material.list')) return 'ok';
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((r) => setTimeout(r, o.delayMs ?? 0));
        inFlight--;
        return JSON.stringify({ shader: 'FF/Glow', knobs: [{ name: '_Glow', label: 'Glow', type: 'float', value: 1 }] });
      },
    },
    session: () => session,
    roleOf: (u) => (u === 'ben' ? 'owner' : undefined),
    changed: () => changes++,
    hold: () => o.hold?.(),
    log: (l) => logs.push(l),
    now: () => now,
  });
  return { h, session, logs, changes: () => changes, most: () => most, advance: (ms: number) => (now += ms) };
}

test('w1838: frames that stop with the socket open put the view to holding within LIVE_STALL_MS, and the next frame brings it back', async () => {
  const k = hub();
  await k.h.tool(k.session, { action: 'start', materials: ['VfxUrsoBallistaPadArcs'] });
  const id = k.h.viewsFor('ben')[0].liveId;
  k.h.onState('beast', { type: 'live_state', liveId: id, state: 'live', detail: '15 fps at 960 px' } as never);
  const ws = fakeSocket();
  assert.ok(k.h.attachFrames('beast', id, ws as unknown as WebSocket));
  ws.emit('message', Buffer.from([0xff, 0xd8, 1]), true);
  k.advance(LIVE_STALL_MS - 1);
  k.h.tick();
  assert.equal(k.h.viewsFor('ben')[0].state, 'live');
  k.advance(2);
  k.h.tick();
  const held = k.h.viewsFor('ben')[0];
  assert.equal(held.state, 'holding');
  assert.match(held.detail, /^no frame from the game for 10 s/);
  assert.equal(liveReady(held, { sandbox: sb('running') }).kind, 'stalled');
  ws.emit('message', Buffer.from([0xff, 0xd8, 2]), true);
  assert.equal(k.h.viewsFor('ben')[0].state, 'live');
  // The journal times each change.
  assert.ok(k.logs.some((l) => /^live view beast\/slot5 \(s1\): starting -> live after 0\.0 s/.test(l)), k.logs.join('\n'));
  assert.ok(k.logs.some((l) => /: live -> holding after 10\.0 s: no frame from the game/.test(l)), k.logs.join('\n'));
  assert.ok(k.logs.some((l) => /: holding -> live after 0\.0 s/.test(l)), k.logs.join('\n'));
});

test('w1838: the computer\'s hold reaches the pages on the view, and they hear when it changes', async () => {
  let hold: string | undefined;
  const k = hub({ hold: () => hold });
  await k.h.tool(k.session, { action: 'start', materials: ['M'] });
  k.h.tick();
  const before = k.changes();
  k.h.tick();
  assert.equal(k.changes(), before, 'no change, no push');
  hold = 'building since 07:40Z (Urgent hotfix release; w1606): no new work until it is done';
  k.h.tick();
  assert.equal(k.changes(), before + 1);
  assert.equal(k.h.viewsFor('ben')[0].hold, hold);
  // A wake shows on the view until it streams again.
  k.h.woken(k.h.viewsFor('ben')[0].liveId, 'Ben');
  assert.equal(k.h.viewsFor('ben')[0].wake?.who, 'Ben');
  k.h.onState('beast', { type: 'live_state', liveId: k.h.viewsFor('ben')[0].liveId, state: 'live', detail: '' } as never);
  assert.equal(k.h.viewsFor('ben')[0].wake, undefined);
});

test('w1838: the knobs of every material are read at once, not one after another', async () => {
  const k = hub({ delayMs: 30 });
  await k.h.tool(k.session, { action: 'start', materials: ['A', 'B', 'C'] });
  const knobs = await k.h.knobs('s1');
  assert.deepEqual(knobs.map((m) => m.material), ['A', 'B', 'C']);
  assert.equal(k.most(), 3);
});

function closer(o: { unity: MachineSandbox['unity']; status?: SessionInfo['status']; hold?: string; v?: Partial<LiveIdleView> }) {
  let now = Date.parse('2026-10-23T07:50:00Z');
  const sent: string[] = [];
  const woke: string[] = [];
  const logs: string[] = [];
  const v: LiveIdleView = { liveId: 'l1', sessionId: 'c1b21df6', machineId: 'beast', sandbox: 'slot5', state: 'holding', startedAtMs: 0, viewers: 0, ...o.v };
  const c = new LiveIdleCloser({
    minutes: () => 15,
    views: () => [v],
    sandbox: () => ({ id: 'slot5', unity: o.unity, sessionIds: ['c1b21df6'] }) as unknown as MachineSandbox,
    session: () => ({ id: 'c1b21df6', status: o.status ?? 'stopped', machineId: 'beast', machineSandbox: 'slot5', lastActivityAt: new Date(now).toISOString() }) as SessionInfo,
    wakePending: () => false,
    canClose: () => true,
    close: async () => 'skipped: test',
    send: (_id, text) => sent.push(text),
    hold: () => o.hold,
    woke: (id, who) => woke.push(`${id} ${who}`),
    log: (l) => logs.push(l),
    now: () => now,
  });
  return { c, v, sent, woke, logs, advance: (ms: number) => (now += ms) };
}

test('w1838: opening a view whose editor stopped (not idle-closed) wakes its worker to stage it again, once per stop', async () => {
  const k = closer({ unity: { state: 'stopped' } });
  const open = { ...k.v, detail: 'the sandbox editor is not running' };
  k.c.viewerOpened(open, 'Ben');
  k.c.viewerOpened(open, 'Ben');
  assert.equal(k.sent.length, 1);
  assert.match(k.sent[0], /^\[live view\] Ben opened your Live view, and it is not streaming: its editor is stopped\. Now start your editor \(mcp__machine__unity start\), put the game in play mode/);
  assert.deepEqual(k.woke, ['l1 Ben']);
  // Still down long after: an opening may wake it again.
  k.advance(LIVE_WAKE_AGAIN_MS);
  k.c.viewerOpened(open, 'Ben');
  assert.equal(k.sent.length, 2);
  // Streaming again ends the wake: the next stop wakes at once.
  k.v.state = 'live';
  await k.c.sweep();
  k.v.state = 'holding';
  k.c.viewerOpened(open, 'Ben');
  assert.equal(k.sent.length, 3);
});

test('w1838: the game out of play mode wakes it too; a reload, a starting editor, a worker mid-turn or a held computer do not', () => {
  const noPlay = closer({ unity: { state: 'running' } });
  noPlay.c.viewerOpened({ ...noPlay.v, detail: 'the game is not in play mode (no agent channel)' }, 'Ben');
  assert.match(noPlay.sent[0] ?? '', /it is not streaming: the game is not in play mode\. Now put the game in play mode/);

  const reload = closer({ unity: { state: 'running' } });
  reload.c.viewerOpened({ ...reload.v, detail: 'the game stopped streaming (left play mode, or a script reload); showing the last frame' }, 'Ben');
  const starting = closer({ unity: { state: 'starting' } });
  starting.c.viewerOpened({ ...starting.v, detail: 'the sandbox editor is not running' }, 'Ben');
  const busy = closer({ unity: { state: 'stopped' }, status: 'running' });
  busy.c.viewerOpened({ ...busy.v, detail: '' }, 'Ben');
  const held = closer({ unity: { state: 'stopped' }, hold: 'building since 07:40Z (Urgent hotfix release; w1606): no new work until it is done' });
  held.c.viewerOpened({ ...held.v, detail: '' }, 'Ben');
  for (const k of [reload, starting, busy, held]) assert.equal(k.sent.length, 0);
  assert.match(held.logs[0], /its worker is not woken: beast is held \(building since 07:40Z/);
});

test('w1838: the daemon looks for the game every second, and backs off after a try that cost the editor work', async () => {
  const states: [LiveState, string][] = [];
  let devTiers = 0;
  let channel: { port: number; token: string; tier: string; pid: number } | undefined;
  const s = new LiveSession(15, 960, {
    editorPid: () => 7,
    channel: () => channel,
    devTier: async () => (devTiers++, 'no channel host'),
    command: async () => ({ ok: false, status: 0, result: '' }),
    frame: () => undefined,
    state: (st, d) => states.push([st, d]),
    now: () => Date.now(),
  }, 10, 200);
  await s.start();
  await new Promise((r) => setTimeout(r, 30));
  channel = { port: 1, token: 't', tier: 'player-safe', pid: 7 };
  await new Promise((r) => setTimeout(r, 120));
  await s.stop();
  assert.equal(devTiers, 1, 'one dev-tier try, then it waits backoffMs, not retryMs');
  assert.ok(states.some(([st, d]) => st === 'holding' && /not in the dev tier/.test(d)));
});
