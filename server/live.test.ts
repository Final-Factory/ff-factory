// The live view's portal half (server/live.ts, w1398): who may watch, the switch, the agent's tool, the knob checks
// and the newest-frame fan-out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { LiveError, LiveHub, knobValue } from './live.ts';
import type { SessionInfo, UserRole } from '../shared/types.ts';

const BEN = { userId: 'ben', displayName: 'Ben' };
const KAI = { userId: 'kai', displayName: 'Kai' };
const session = { id: 's1', kind: 'worker', title: 'Comet', machineId: 'beast', machineSandbox: 'slot1', requestedBy: KAI } as unknown as SessionInfo;

function hub(opts: { enabled?: boolean; canLive?: boolean; answers?: Record<string, string> } = {}) {
  const calls: Record<string, unknown>[] = [];
  let changes = 0;
  const roles: Record<string, UserRole> = { ben: 'owner', kai: 'member', lee: 'member' };
  const h = new LiveHub({
    enabled: () => opts.enabled ?? true,
    machines: {
      canLive: () => opts.canLive ?? true,
      live: async (_m, op) => {
        calls.push(op as Record<string, unknown>);
        const c = String((op as { command?: string }).command ?? op.op);
        for (const [k, v] of Object.entries(opts.answers ?? {})) if (c.startsWith(k)) return v;
        return 'ok';
      },
    },
    session: (id) => (id === 's1' ? session : undefined),
    roleOf: (u) => roles[u],
    changed: () => changes++,
  });
  return { h, calls, changes: () => changes };
}

/** A fake page or daemon socket: records what was sent, with a settable backlog. */
function fakeSocket() {
  const e = new EventEmitter() as EventEmitter & { OPEN: number; readyState: number; bufferedAmount: number; sent: Buffer[]; send(b: Buffer): void; close(): void };
  e.OPEN = 1;
  e.readyState = 1;
  e.bufferedAmount = 0;
  e.sent = [];
  e.send = (b: Buffer) => void e.sent.push(b);
  e.close = () => {
    e.readyState = 3;
    e.emit('close');
  };
  return e;
}

test('live: the requester and the owners watch; nobody else, and nobody while the switch is off', async () => {
  const { h } = hub();
  assert.equal(h.canWatch('s1', 'kai'), true);
  assert.equal(h.canWatch('s1', 'ben'), true, 'an owner');
  assert.equal(h.canWatch('s1', 'lee'), false);
  assert.equal(h.canWatch('s1', undefined), false);
  await h.tool(session, { action: 'start', materials: ['VfxComet'] });
  assert.equal(h.viewsFor('kai').length, 1);
  assert.equal(h.viewsFor('lee').length, 0);
  const off = hub({ enabled: false }).h;
  assert.match(await off.tool(session, { action: 'start' }), /off on this portal/);
  assert.deepEqual(off.viewsFor('ben'), []);
});

test('live: start asks the machine, clamps fps and width, and keeps only valid material names', async () => {
  const { h, calls } = hub();
  const text = await h.tool(session, { action: 'start', fps: 500, width: 10, materials: ['VfxComet', 'bad|name', 'CometCatcherMaterial'] });
  assert.match(text, /Live view started \(30 fps, 320 px, knobs on VfxComet, CometCatcherMaterial\)/);
  assert.equal(calls[0].op, 'start');
  assert.equal(calls[0].sandbox, 'slot1');
  const [v] = h.viewsFor('ben');
  assert.deepEqual([v.fps, v.width, v.state], [30, 320, 'starting']);
  assert.match(await h.tool(session, { action: 'status' }), /^Live view starting/);
  assert.equal(await h.tool(session, { action: 'stop' }), 'Live view stopped.');
  assert.equal(calls.at(-1)?.op, 'stop');
  assert.deepEqual(h.viewsFor('ben'), []);
  assert.match(await hub({ canLive: false }).h.tool(session, { action: 'start' }), /needs a daemon update/);
});

test('live: a knob reaches the game only for the view\'s materials, a property name and a numeric value', async () => {
  const { h, calls } = hub({ answers: { 'look.material.set': '{"name":"_Intensity","value":2.5}', 'look.material.list': '{"material":"VfxComet","shader":"FinalFactory/VfxComet","knobs":[{"name":"_Intensity","type":"range","value":1,"min":0,"max":4}]}' } });
  await h.tool(session, { action: 'start', materials: ['VfxComet'] });
  const knob = await h.setKnob('s1', { material: 'VfxComet', name: '_Intensity', value: 2.5 }, BEN);
  assert.deepEqual(knob, { name: '_Intensity', value: 2.5 });
  const set = calls.find((c) => String(c.command).startsWith('look.material.set'))!;
  assert.equal(set.command, 'look.material.set|VfxComet|_Intensity|2.5');
  assert.equal(set.note, 'Ben set VfxComet._Intensity to 2.5 in the live view');
  await assert.rejects(h.setKnob('s1', { material: 'Other', name: '_Intensity', value: 1 }, BEN), (e: LiveError) => e.status === 400);
  await assert.rejects(h.setKnob('s1', { material: 'VfxComet', name: '_X|live.frames', value: 1 }, BEN), /not a shader property name/);
  await assert.rejects(h.setKnob('s1', { material: 'VfxComet', name: '_X', value: [1, 2] }, BEN), /a knob value/);
  const knobs = await h.knobs('s1');
  assert.equal(knobs[0].shader, 'FinalFactory/VfxComet');
  assert.equal(knobs[0].knobs[0].name, '_Intensity');
  await assert.rejects(hub().h.knobs('s1'), (e: LiveError) => e.status === 404);
});

test('live: knob values become the game\'s text', () => {
  assert.equal(knobValue(2.5), '2.5');
  assert.equal(knobValue([64, 22.123456, 0, 1]), '64,22.12346,0,1');
  assert.equal(knobValue([1, 2, 3]), '1,2,3');
  assert.equal(knobValue(Number.NaN), undefined);
  assert.equal(knobValue([1, 2]), undefined);
  assert.equal(knobValue('3'), undefined);
});

test('live: switching it off stops every view and tells the pages (w1417)', async () => {
  let on = true;
  let switched = 0;
  const calls: Record<string, unknown>[] = [];
  const h = new LiveHub({
    enabled: () => on,
    machines: { canLive: () => true, live: async (_m, op) => (calls.push(op as Record<string, unknown>), 'ok') },
    session: (id) => (id === 's1' ? session : undefined),
    roleOf: () => 'owner',
    changed: () => undefined,
    switched: () => switched++,
  });
  await h.tool(session, { action: 'start', materials: ['VfxComet'] });
  assert.equal(h.viewsFor('ben').length, 1);
  on = false;
  await h.switched(false);
  assert.equal(calls.at(-1)?.op, 'stop', 'the machine stops streaming');
  assert.equal(switched, 1);
  on = true;
  assert.deepEqual(h.viewsFor('ben'), [], 'nothing comes back when it is on again: the agent starts a new view');
  await h.switched(true);
  assert.equal(switched, 2);
});

test('live: frames go to every page, newest first, and a page that is behind skips one', async () => {
  const { h } = hub();
  await h.tool(session, { action: 'start', materials: [] });
  const [v] = h.viewsFor('ben');
  const daemon = fakeSocket();
  assert.equal(h.attachFrames('other-machine', v.liveId, daemon as unknown as WebSocket), false, 'only the view\'s own machine');
  assert.equal(h.attachFrames('beast', v.liveId, daemon as unknown as WebSocket), true);
  daemon.emit('message', Buffer.from([1]), true);
  const page = fakeSocket();
  assert.equal(h.addViewer('s1', page as unknown as WebSocket), true);
  assert.deepEqual(page.sent.map((b) => b[0]), [1], 'a new page gets the newest frame at once');
  page.bufferedAmount = 5 * 1024 * 1024;
  daemon.emit('message', Buffer.from([2]), true);
  page.bufferedAmount = 0;
  daemon.emit('message', Buffer.from([3]), true);
  daemon.emit('message', Buffer.from('not a frame'), false);
  assert.deepEqual(page.sent.map((b) => b[0]), [1, 3]);
  assert.equal(h.viewsFor('ben')[0].frames, 3);
  h.onState('beast', { type: 'live_state', liveId: v.liveId, state: 'holding', detail: 'left play mode', frames: 3 });
  assert.equal(h.viewsFor('ben')[0].state, 'holding');
  await h.sessionGone('s1');
  assert.equal(page.readyState, 3, 'the page is told the view stopped');
});
