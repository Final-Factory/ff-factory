// Held machine-tool calls across a portal outage (w2422, machine/portalCalls.ts): w2335's blocked_on, made while the
// portal restarted (2026-10-27 10:05-10:20 UTC), was lost and its worker never resumed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HELD_TOOLS, PortalCalls, type RpcMessage } from '../machine/portalCalls.ts';
import { AnsweredCalls } from './answeredCalls.ts';

const link = (up: boolean) => {
  const sent: RpcMessage[] = [];
  const l = { up, sent, open: () => l.up, send: (m: RpcMessage) => void sent.push(m) };
  return l;
};
const rpc = (id: string, method: string, args: Record<string, unknown> = {}): RpcMessage => ({ type: 'rpc', id, sessionId: 's1', method, args });

test('the calls that set a wait are the held ones', () => {
  for (const m of ['blocked_on', 'waiting_on_person', 'wake_me', 'cancel_wake']) assert.ok(HELD_TOOLS.has(m), m);
  assert.ok(!HELD_TOOLS.has('timed_run'), 'timed_run files a new request: not idempotent, so not held');
});

test('a blocked_on made while the portal is unreachable is held and delivered, in order, when the link is back', async () => {
  const l = link(false);
  const calls = new PortalCalls(l, 60_000);
  const a = calls.call(rpc('a', 'wake_me', { minutes: 30 }), 60_000);
  const b = calls.call(rpc('b', 'blocked_on', { requests: ['w2338'], what: 'w2338 reporting' }), 60_000);
  assert.equal(l.sent.length, 0, 'nothing goes out on a down link');
  assert.deepEqual(calls.held().map((m) => m.id), ['a', 'b']);
  l.up = true;
  calls.linkUp();
  assert.deepEqual(l.sent.map((m) => m.id), ['a', 'b'], 'sent in the order they were made');
  calls.answer('a', true, 'check-in set');
  calls.answer('b', true, 'Blocked on w2338');
  assert.equal(await a, 'check-in set');
  assert.equal(await b, 'Blocked on w2338');
  assert.equal(calls.held().length, 0);
});

test('a held call sent on a link that drops before the answer goes again, once, on the next link', async () => {
  const l = link(true);
  const calls = new PortalCalls(l, 60_000);
  const p = calls.call(rpc('x', 'blocked_on', { requests: ['w2338'] }), 60_000);
  assert.equal(l.sent.length, 1);
  l.up = false;
  calls.linkDown();
  calls.linkUp(); // still down: nothing goes
  assert.equal(l.sent.length, 1);
  l.up = true;
  calls.linkUp();
  calls.linkUp(); // a second hello does not send it a third time
  assert.deepEqual(l.sent.map((m) => m.id), ['x', 'x'], 'the same id again, so the portal can answer it once');
  calls.answer('x', true, 'ok');
  assert.equal(await p, 'ok');
});

test('a held call the portal never answers fails loudly: NOT recorded, do not end the turn', async () => {
  const l = link(false);
  const calls = new PortalCalls(l, 20);
  await assert.rejects(calls.call(rpc('y', 'blocked_on'), 10), (e: Error) => {
    assert.match(e.message, /blocked_on was NOT recorded/);
    assert.match(e.message, /Do not end your turn/);
    return true;
  });
  assert.equal(calls.held().length, 0);
});

test('any other call on a down link fails at once and says it was not done', async () => {
  const l = link(false);
  const calls = new PortalCalls(l, 60_000);
  await assert.rejects(calls.call(rpc('z', 'timed_run'), 60_000), /timed_run was NOT done: the portal is unreachable/);
  assert.equal(l.sent.length, 0);
});

test('a non-held call in flight when the link drops fails at once, without waiting for its timeout', async () => {
  const l = link(true);
  const calls = new PortalCalls(l, 60_000);
  const p = calls.call(rpc('t', 'request_pair'), 60_000);
  l.up = false;
  calls.linkDown();
  await assert.rejects(p, /dropped before it answered request_pair/);
});

test('the portal answers a call id it already answered from memory: a held call sent twice is applied once', async () => {
  const answered = new AnsweredCalls<string>(1000);
  let applied = 0;
  const run = async () => `applied ${++applied}`;
  assert.equal(await answered.once('m:x', run, 0), 'applied 1');
  assert.equal(await answered.once('m:x', run, 500), 'applied 1');
  assert.equal(applied, 1);
  assert.equal(await answered.once('m:y', run, 600), 'applied 2');
  // Past its keep the id is forgotten (and so is the memory of it).
  assert.equal(await answered.once('m:x', run, 5000), 'applied 3');
});
