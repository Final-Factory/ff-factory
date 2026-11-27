// w6397: a worker that waits on a follow-up it handed up (hand_up_requests, w2969) is Blocked on it once it is filed and
// resumed when it closes. w6096's worker cc0f9074 handed up the flaky gateway_standby test at 01:29 UTC on 2026-11-27, asked
// for its id to wait on it, was never told it, and w6096 sat Stalled 8 h after w6254 (the follow-up) closed as done.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlockerWatch } from './blockerWatch.ts';
import { BEN, firstTurn, setupOnMachine } from './orchestratorsTestKit.ts';
import { blockerName } from '../shared/blockers.ts';
import { handUpWaitIn, handUpWaitRef, workLive } from '../shared/workState.ts';

// cc0f9074's still-open line on w6096, 01:29 UTC 2026-11-27 (the request id is the test's).
const W6096_LINE = 'w1: still open: blocked on a fix for the flaky ffu-server gateway_standby test (handed up), then CI on Final-Factory/ffu#1213';

test('w6397: a line waits on a handed-up follow-up only when the wait itself says so', () => {
  assert.equal(handUpWaitIn(W6096_LINE), true);
  for (const line of ['w1: still open: blocked on the follow-up I handed up', 'w9: still open: waiting for the hand-up to be fixed', 'needs the follow-up request to land']) assert.equal(handUpWaitIn(line), true, line);
  for (const line of [
    'w1: still open: blocked on CI on Final-Factory/ffu#1213; the follow-up is handed up',
    'w1: still open: blocked on CI on PR #12, then the follow-up',
    'Handed up two follow-ups. w1: still open: blocked on CI on PR #12',
    'w1: still open: waiting on "the follow-up" review',
  ])
    assert.equal(handUpWaitIn(line), false, line);
  const work = new Map([['w2', { status: 'done' as const }], ['w3', { status: 'active' as const }], ['w4', { status: 'queued' as const }]]);
  const w = { id: 'w1', handedUp: { worker: 'a', at: '', count: 3, items: [], to: [], filed: ['w2', 'w3', 'w4'] } };
  assert.equal(handUpWaitRef(w, W6096_LINE, (id) => work.get(id)), 'w4', 'the newest still open');
  work.set('w4', { status: 'cancelled' as never });
  assert.equal(handUpWaitRef(w, W6096_LINE, (id) => work.get(id)), 'w3');
  assert.equal(handUpWaitRef(w, 'w1: still open: blocked on CI on PR #12', (id) => work.get(id)), undefined);
  assert.equal(handUpWaitRef({ id: 'w1' }, W6096_LINE, (id) => work.get(id)), undefined, 'nothing handed up');
});

async function handedUp(t: Parameters<typeof setupOnMachine>[0]) {
  const env = await setupOnMachine(t);
  const { store, machines, agents, dispatcher, chat, call } = env;
  const ben = chat(BEN).info;
  await call(ben, 'request_work', { title: 'FFU client: terrain under the tilted camera', brief: 'Draw the terrain under the tilted 3D camera.' });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Do it', title: 'w1: terrain', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const info = store.sessions.get(id)!;
  await firstTurn(info);
  const said = await machines.hooks!.handlersFor(info, store.machines.get('pc')!).hand_up_requests!({ items: [{ title: 'ffu: gateway_standby 20-kills test fails under a runner stall', brief: 'Fix the flaky test.' }] });
  const clock = Date.now();
  const watch = new BlockerWatch({ store, orchestrators: env.o, now: () => clock, checkInPending: (sid) => agents.waker.pending(sid) !== undefined });
  return { ...env, ben, id, info, said: String(said), clock, watch, w: () => store.work.get('w1')! };
}

test('w6397: hand up, file, close as done: the original shows Blocked on the follow-up in between, not Stalled, and its worker is resumed with its id', async (t) => {
  const { store, agents, ben, call, id, info, clock, watch, w } = await handedUp(t);
  // The turn ends on w6096's line: no id to wait on yet, so no gate, and nothing is recorded before the follow-up is filed.
  Object.assign(info, { status: 'stopped', lastResult: `Handed it up.\n\n${W6096_LINE}`, lastResultAt: new Date(clock - 60_000).toISOString() });
  assert.equal((await watch.tick()).has('w1'), false);
  assert.equal(w().blocked, undefined);
  const filed = await call(ben, 'file_follow_ups', { request: 'w1' });
  assert.equal(filed.isError, false, filed.text);
  const fid = /Filed (w\d+)/.exec(filed.text)![1];
  assert.equal(agents.waker.pending(id), undefined, 'a stopped worker is not woken to be told the id');
  assert.match((await watch.tick()).get('w1') ?? '', new RegExp(`^recorded: the wait on ${fid} its worker ${id}'s report names`));
  assert.deepEqual([w().status, w().blocked?.kind, w().blocked?.ref, w().blocked?.by], ['blocked', 'request', fid, `worker ${id}`]);
  assert.match(blockerName(w().blocked!, clock), new RegExp(`^${fid} `), 'shown Blocked on the follow-up');
  const live = () => workLive(w(), { items: [...store.work.values()], session: (sid) => store.sessions.get(sid), now: clock });
  assert.equal(live()?.state, 'blocked', JSON.stringify(live()));
  // The follow-up still open: Blocked, nobody resumed.
  assert.equal((await watch.tick()).has('w1'), false);
  assert.equal(agents.waker.pending(id), undefined);
  // The follow-up closes as done: the worker is resumed within a minute, and its resume names the follow-up.
  store.work.get(fid)!.status = 'done';
  assert.match((await watch.tick()).get('w1') ?? '', new RegExp(`^clear: ${fid} closed as done`));
  assert.equal(w().status, 'active');
  assert.match(agents.waker.pending(id)?.note ?? '', new RegExp(`${fid} closed as done`));
});

test('w6397: a follow-up cancelled or declined resumes its worker with that news, not a question for its person', async (t) => {
  for (const status of ['cancelled', 'rejected'] as const) {
    await t.test(status, async (tt) => {
      const { store, agents, ben, call, id, info, clock, watch, w } = await handedUp(tt);
      Object.assign(info, { status: 'stopped', lastResult: 'w1: still open: blocked on the follow-up I handed up', lastResultAt: new Date(clock - 60_000).toISOString() });
      const fid = /Filed (w\d+)/.exec((await call(ben, 'file_follow_ups', { request: 'w1' })).text)![1];
      await watch.tick();
      assert.equal(w().blocked?.ref, fid);
      store.work.get(fid)!.status = status;
      await watch.tick();
      assert.equal(w().status, 'active');
      assert.equal(w().question, undefined, 'its person is not asked');
      const note = agents.waker.pending(id)?.note ?? '';
      assert.match(note, new RegExp(`${fid} was ${status === 'rejected' ? 'declined' : 'cancelled'} without delivering`));
      assert.match(note, /decide how w1 goes on without it \(w6397\)/);
    });
  }
});

test('w6397: a worker mid-turn when its follow-up is filed is told the id, to wait on it with blocked_on', async (t) => {
  const { agents, ben, call, id, info, said, w } = await handedUp(t);
  // hand_up_requests' reply says how to wait on it.
  assert.match(said, /blocked on the follow-up I handed up.*resumes you, with its id, when it closes \(done, cancelled or declined; w6397\)/);
  info.status = 'running';
  const fid = /Filed (w\d+)/.exec((await call(ben, 'file_follow_ups', { request: 'w1' })).text)![1];
  assert.match(agents.waker.pending(id)?.note ?? '', new RegExp(`^\\[follow-up filed\\] The follow-up you handed up for w1, ".*", is filed as ${fid} \\(w6397\\)\\. If w1 waits on it, call blocked_on with requests \\["${fid}"\\]`));
  assert.ok(w().log.some((l) => l.includes(`is told its follow-up's id ${fid} (w6397)`)));
});
