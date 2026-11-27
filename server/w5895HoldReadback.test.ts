import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import type { SessionInfo } from '../shared/types.ts';
import { orchestratorAskIn } from '../shared/workState.ts';
import { drainWouldHold, holdReadback, newDrain } from './machineDrain.ts';
import { readBackSetting } from './appConfig.ts';
import { orchestratorStepText } from './orchestrators.ts';
import { LOTH, putRequests, twoComputers } from './orchestratorsTestKit.ts';
import type { Config } from './config.ts';

// w5895, 2026-11-25/26: lothsahn answered w5814's card at 22:08 UTC, "Hold new work on LothDesktop and let the running
// workers finish". His orchestrator recorded it as a note outside his own turn, every set_app_config of the dispatcher's was
// refused (w5814 not humanAsked), w5814's worker had no hold tool ("It needs the hold set by the orchestrator", 03:42, which
// reached nobody), and the hold was set only at 03:47 by config placement.hold, excepting w5475, w5586, w5656, w5796: stopped
// workers, which resumed during it (w5475's at 04:39). lothsahn: "Why is w5475 running?  We had a hold and it wasn't running".

/** The turn a person's chat is in: their own message's, or the harness's. */
const asTurn = (h: object, from: 'human' | 'system') => Object.defineProperty(h, 'turnFrom', { get: () => from, configurable: true });

const WORDS = 'Hold new work on LothDesktop and let the running workers finish';

/** pc (LothDesktop's stand-in) with three workers: one mid-turn, one stopped with a check-in, one stopped without. */
async function heldScene(t: Parameters<typeof twoComputers>[0]) {
  const env = await twoComputers(t);
  const { store } = env;
  // set_app_config writes a config file: the test's own (server/config.ts configPath).
  const file = path.join(env.dir, 'config.json');
  fs.writeFileSync(file, '{}\n');
  const was = process.env.FFSB_CONFIG;
  process.env.FFSB_CONFIG = file;
  t.after(() => {
    if (was === undefined) delete process.env.FFSB_CONFIG;
    else process.env.FFSB_CONFIG = was;
  });
  const worker = (id: string, status: SessionInfo['status']) => store.putSession({ id, kind: 'worker', machineId: 'pc', status, title: id, createdAt: new Date().toISOString() } as SessionInfo);
  worker('run1', 'running');
  worker('stop1', 'stopped');
  worker('stop2', 'stopped');
  putRequests(store, [
    { id: 'w5814', status: 'active', by: LOTH, sessionIds: ['run1'] },
    { id: 'w5475', status: 'active', by: LOTH, sessionIds: ['stop1'] },
    { id: 'w5586', status: 'active', by: LOTH, sessionIds: ['stop2'] },
  ]);
  return env;
}

test('w5895: hold words through update_work in the person\'s own turn hold the machine at once, and the result reads it back live', async (t) => {
  const env = await heldScene(t);
  const loth = env.chat(LOTH);
  asTurn(loth, 'human');
  const r = await env.call(loth.info, 'update_work', { id: 'w5814', hold: { machine: 'pc', action: 'hold' }, words: WORDS });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /HOLD SET on pc: pc is drained/);
  assert.match(r.text, /Read back live: .*HELD \(drained: Lothsahn: "Hold new work/);
  assert.ok(env.store.machines.get('pc')!.drain, 'the drain is on the machine record');
  assert.equal(env.store.work.get('w5814')!.holdAsk?.set?.by, "Lothsahn's orchestrator");
  // The status line shows it held, and no unset ask is left.
  const st = await env.call(env.dispatcher().info, 'system_status', {});
  assert.match(st.text, /HELD \(drained: Lothsahn/);
  assert.doesNotMatch(st.text, /ASKED, NOT SET/);
});

test('w5895: hold words outside the person\'s turn are recorded NOT SET, named in system_status, and the dispatcher\'s hold_machine for the request goes through within its turn', async (t) => {
  const env = await heldScene(t);
  const loth = env.chat(LOTH);
  asTurn(loth, 'system');
  const r = await env.call(loth.info, 'update_work', { id: 'w5814', hold: { machine: 'pc', action: 'hold' }, words: WORDS });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /HOLD ASKED, NOT SET: .*hold_machine machine=pc action=hold work_id=w5814/);
  assert.equal(env.store.machines.get('pc')!.drain, undefined, 'not set outside their turn');
  assert.equal(env.store.work.get('w5814')!.humanAsked, false);
  const before = await env.call(env.dispatcher().info, 'system_status', {});
  assert.match(before.text, /HOLD ASKED, NOT SET: w5814: Lothsahn asked .* to hold pc .*the dispatcher sets it with hold_machine/);
  const lm = await env.call(env.dispatcher().info, 'list_machines', {});
  assert.match(lm.text, /HOLD ASKED, NOT SET: w5814/);
  // The dispatcher's guard lets the recorded ask through, though humanAsked is false (C1: every try was refused). Its own
  // turn is pinned to the harness's: its turn source starts 'human' and flips only when a notice reaches it, so unpinned
  // the guard could pass by dispatcherHeardPerson and the test prove nothing (CI on #1307, Linux, 2026-11-26).
  asTurn(env.dispatcher(), 'system');
  const set = await env.call(env.dispatcher().info, 'hold_machine', { machine: 'pc', action: 'hold', words: WORDS, who: 'Lothsahn', work_id: 'w5814' });
  assert.ok(!set.isError, set.text);
  assert.match(set.text, /Read back live: .*HELD/);
  assert.equal(env.store.work.get('w5814')!.holdAsk?.set?.by, 'the dispatcher');
  const after = await env.call(env.dispatcher().info, 'system_status', {});
  assert.match(after.text, /HELD \(drained: Lothsahn/);
  assert.doesNotMatch(after.text, /ASKED, NOT SET/);
});

test('w5895: the read-back flags every excepted request with no live worker there, and when it will resume (the check-in case)', async (t) => {
  const env = await heldScene(t);
  // w5475's worker is stopped with a check-in at 04:39: a hold that excepts it lets it resume then.
  (env.agents as unknown as { waker: { pending(id: string): unknown } }).waker.pending = (id: string) => (id === 'stop1' ? { at: '2026-11-26T04:39:00.000Z', note: 'check CI' } : undefined);
  const r = await env.call(env.dispatcher().info, 'set_app_config', { key: 'placement.hold', value: { pc: { why: 'lothsahn: hold it', except: ['w5814', 'w5475', 'w5586', 'w5656'] } }, user_asked: true });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /read back live:\n.*HELD \(lothsahn: hold it/);
  assert.match(r.text, /w5814: worker run1 running\./);
  assert.match(r.text, /w5475: worker stop1 stopped; will resume here at its check-in 04:39Z \(the hold lets it through\)/);
  assert.match(r.text, /w5586: worker stop2 stopped; resumes here at its next message/);
  assert.match(r.text, /w5656: no worker of it here/);
});

const machineHoldOf = (env: { agents: unknown }) => (env.agents as unknown as { machineHold(s: { info: SessionInfo }): string | undefined }).machineHold.bind(env.agents);

/** w5937: lothsahn's drain of pc set by the dispatcher on w5814, with stop1 (w5475) due to resume at its check-in 04:39. */
async function drained(t: Parameters<typeof twoComputers>[0], extra: Record<string, unknown> = {}) {
  const env = await heldScene(t);
  (env.agents as unknown as { waker: { pending(id: string): unknown } }).waker.pending = (id: string) => (id === 'stop1' ? { at: '2026-11-26T04:39:00.000Z', note: 'check CI' } : undefined);
  env.store.putWork({ ...env.store.work.get('w5814')!, humanAsked: true });
  const set = await env.call(env.dispatcher().info, 'hold_machine', { machine: 'pc', action: 'hold', words: WORDS, who: 'Lothsahn', except: ['w5586'], work_id: 'w5814', ...extra });
  assert.ok(!set.isError, set.text);
  return { env, set, hold: machineHoldOf(env), s: (id: string) => ({ info: env.store.sessions.get(id)! }) };
}

test('w5937: a drain lets only its running workers finish by default; another worker\'s check-in resume is held, once logged', async (t) => {
  const { env, set, hold, s } = await drained(t);
  assert.match(set.text, /the 1 worker\(s\) running there finish, and the others there do not resume until it is lifted/);
  assert.match(set.text, /worker stop1 \(w5475\) stopped; will resume here at its check-in 04:39Z: the drain lets only its running workers finish, so this resume is HELD/);
  assert.match(set.text, /w5586: worker stop2 stopped; resumes here at its next message \(the hold lets it through\)/);
  const d = env.store.machines.get('pc')!.drain!;
  assert.deepEqual([d.resumes, d.running], ['running', ['run1']]);
  assert.match(drainWouldHold(d, { id: 'stop1', works: ['w5475'] }) ?? '', /lets only the workers running at/);
  const logs: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.join(' '));
  try {
    for (let n = 0; n < 2; n++) assert.match(hold(s('stop1')) ?? '', /^pc is drained: Lothsahn's drain lets only the workers running at .*hold_machine lift, update_work hold \{action: lift\}, or a hold with resumes 'all'/);
    assert.equal(hold(s('stop2')), undefined, 'an excepted request\'s worker resumes');
    assert.equal(hold(s('run1')), undefined, 'a worker mid-turn is never held');
    // run1 ends its turn: it was running when the drain was set, so its next resume goes on.
    env.store.putSession({ ...env.store.sessions.get('run1')!, status: 'idle' });
    assert.equal(hold(s('run1')), undefined, 'a worker running at the drain finishes, over several turns');
  } finally {
    console.log = log;
  }
  assert.equal(logs.filter((l) => /pc drain: worker stop1 \(w5475\) resume held, as .* \(w5937\)/.test(l)).length, 1, logs.join('\n'));
});

test('w5937: a drain set again keeps the workers the first one lets finish (w6055 F1)', async (t) => {
  const { env, hold, s } = await drained(t);
  env.store.putSession({ ...env.store.sessions.get('run1')!, status: 'idle' });
  const again = await env.call(env.dispatcher().info, 'hold_machine', { machine: 'pc', action: 'hold', words: WORDS, who: 'Lothsahn', except: ['w5586'], hours: 4, work_id: 'w5814' });
  assert.ok(!again.isError, again.text);
  assert.deepEqual(env.store.machines.get('pc')!.drain!.running, ['run1']);
  assert.equal(hold(s('run1')), undefined, 'run1 was running at the first drain: it still finishes');
  assert.ok(hold(s('stop1')), 'stop1 is still held');
});

test('w5937: a drain-held message for a worker whose request closed is dropped and said, not held forever (w6058)', async (t) => {
  const { env, hold } = await drained(t);
  // A real session on pc, stopped, on w5475 (the store-only stop1 has no handle the send queue can hold).
  const h = env.sessions.create({ kind: 'worker', title: 'held', permissionMode: 'bypassPermissions', options: () => ({ model: 'opus' }) });
  Object.assign(h.info, { machineId: 'pc', status: 'stopped' });
  env.store.putSession(h.info);
  const id = h.info.id;
  env.store.putWork({ ...env.store.work.get('w5475')!, sessionIds: ['stop1', id] });
  const mine = () => env.sessions.queued().filter((q) => q.id === id).length;
  env.sessions.send(id, 'A reply to the held worker');
  env.sessions.drain();
  assert.equal(mine(), 1, 'held while w5475 is open');
  assert.ok(hold(h));
  env.store.putWork({ ...env.store.work.get('w5475')!, status: 'done' });
  env.sessions.drain();
  assert.equal(mine(), 0, 'dropped once its request closed');
  assert.ok(env.store.readTranscript(id).some((e) => e.kind === 'system' && /A resume was not delivered: pc is drained .* no open request left/.test(e.text)));
  // With an open request again, its held message waits for the lift as before.
  env.store.putWork({ ...env.store.work.get('w5475')!, status: 'active' });
  env.sessions.send(id, 'Another reply');
  env.sessions.drain();
  assert.equal(mine(), 1);
});

test('w6092: a dispatcher message_agent naming a request, to a stopped worker on a drained machine whose own request closed, is held, not dropped', async (t) => {
  const { env, hold } = await drained(t);
  const h = env.sessions.create({ kind: 'worker', title: 'held', permissionMode: 'bypassPermissions', options: () => ({ model: 'opus' }) });
  Object.assign(h.info, { machineId: 'pc', status: 'stopped' });
  env.store.putSession(h.info);
  const id = h.info.id;
  // Its own request closed: the worker has no open request until the new one is linked to it.
  env.store.putWork({ ...env.store.work.get('w5475')!, status: 'done', sessionIds: ['stop1', id] });
  putRequests(env.store, [{ id: 'w6092', status: 'queued', by: LOTH, sessionIds: [] }]);
  const mine = () => env.sessions.queued().filter((q) => q.id === id).length;
  const r = await env.call(env.dispatcher().info, 'message_agent', { session_id: id, text: 'A follow-up for you.', work_id: 'w6092', title: 'follow-up', session: 'same', session_reason: 'a fix for what it shipped' });
  assert.ok(!r.isError, r.text);
  env.sessions.drain();
  await new Promise((res) => setImmediate(res));
  assert.equal(mine(), 1, `held on the drain, not dropped: ${env.store.readTranscript(id).filter((e) => e.kind === 'system').map((e) => e.text).join(' | ')}`);
  assert.ok(env.store.work.get('w6092')!.sessionIds.includes(id), 'linked to the worker');
  assert.ok(hold(h), 'the drain holds it');
  assert.ok(!env.store.readTranscript(id).some((e) => e.kind === 'system' && /A resume was not delivered/.test(e.text)));
});

test('w5937: a drain with resumes all holds no worker already there (w5878\'s behavior)', async (t) => {
  const { hold, s } = await drained(t, { resumes: 'all' });
  assert.equal(hold(s('stop1')), undefined);
});

test('w5937: recovery needs nobody at the machine: hold_machine lift releases the held resume', async (t) => {
  const { env, hold, s } = await drained(t);
  assert.ok(hold(s('stop1')));
  const r = await env.call(env.dispatcher().info, 'hold_machine', { machine: 'pc', action: 'lift', work_id: 'w5814' });
  assert.ok(!r.isError, r.text);
  assert.equal(hold(s('stop1')), undefined);
});

test('w5937: recovery needs nobody at the machine: update_work hold {action: lift} in the person\'s turn releases it', async (t) => {
  const { env, hold, s } = await drained(t);
  assert.ok(hold(s('stop1')));
  const loth = env.chat(LOTH);
  asTurn(loth, 'human');
  const r = await env.call(loth.info, 'update_work', { id: 'w5814', hold: { machine: 'pc', action: 'lift' }, words: 'Lift the hold on LothDesktop' });
  assert.ok(!r.isError, r.text);
  assert.equal(env.store.machines.get('pc')!.drain, undefined);
  assert.equal(hold(s('stop1')), undefined);
});

test('w5937: recovery needs nobody at the machine: the hold set again with resumes all releases it, and the drain stays', async (t) => {
  const { env, hold, s } = await drained(t);
  assert.ok(hold(s('stop1')));
  const loth = env.chat(LOTH);
  asTurn(loth, 'human');
  const r = await env.call(loth.info, 'update_work', { id: 'w5814', hold: { machine: 'pc', action: 'hold', resumes: 'all' }, words: 'Keep LothDesktop held but let its workers resume' });
  assert.ok(!r.isError, r.text);
  assert.equal(env.store.machines.get('pc')!.drain?.resumes, 'all');
  assert.equal(hold(s('stop1')), undefined);
});

test('w5895: holdReadback says NOT held plainly, and an old drain (no resumes) lets every worker resume as before', () => {
  assert.match(holdReadback('LothDesktop', undefined, [], undefined, []), /^LothDesktop: NOT held/);
  const old = { ...(newDrain({ words: WORDS, who: 'lothsahn' }, 'the dispatcher', new Date('2026-11-26T03:47:00Z')) as object), resumes: undefined, running: undefined } as Parameters<typeof drainWouldHold>[0];
  assert.equal(drainWouldHold(old, { id: 'x', works: [] }), undefined);
  const all = newDrain({ words: WORDS, who: 'lothsahn', resumes: 'all' }, 'the dispatcher', new Date());
  assert.ok(typeof all !== 'string' && all.resumes === 'all' && !all.running);
});

test('w5895: set_app_config reads the live value back; a server that did not take it is a loud refusal', () => {
  const cfg = { placement: { hold: { pc: 'x' }, holdExcept: { pc: ['w1'] } } } as unknown as Config;
  assert.deepEqual(readBackSetting(cfg, 'placement.hold', { pc: { why: 'x', except: ['w1'] } }).ok, true);
  assert.deepEqual(readBackSetting(cfg, 'placement.hold', { pc: 'y' }).ok, false);
  assert.equal(readBackSetting({ ownerName: 'Ben' } as unknown as Config, 'ownerName', 'Ben').ok, true);
  assert.equal(readBackSetting({ ownerName: 'Ben' } as unknown as Config, 'ownerName', 'Lothsahn').ok, false);
});

test('w5895: a worker line that needs a hold set by the orchestrator routes as an [orchestrator step], with how to set it', () => {
  for (const line of ['It needs the hold set by the orchestrator', 'w5814: still open: the LothDesktop drain must be set by my orchestrator', 'the orchestrator sets the hold on lothdesktop']) assert.ok(orchestratorAskIn(line), line);
  assert.ok(!orchestratorAskIn('w1: still open: blocked on CI on #12'));
  assert.match(orchestratorStepText({ id: 'w5814', title: 'x' }, 'abc', 'It needs the hold set by the orchestrator', 'Lothsahn'), /update_work hold \{machine, action\} on w5814/);
});

// w5940's review of #1307 at ae282369: an ask once set stayed counted as unset after a lift or its hours running out, so
// "HOLD ASKED, NOT SET" came back and its work_id let the dispatcher hold the machine again.
async function setByDispatcher(t: Parameters<typeof twoComputers>[0], hours?: number) {
  const env = await heldScene(t);
  asTurn(env.chat(LOTH), 'system');
  const r = await env.call(env.chat(LOTH).info, 'update_work', { id: 'w5814', hold: { machine: 'pc', action: 'hold' }, words: WORDS });
  assert.ok(!r.isError, r.text);
  asTurn(env.dispatcher(), 'system');
  const set = await env.call(env.dispatcher().info, 'hold_machine', { machine: 'pc', action: 'hold', words: WORDS, who: 'Lothsahn', work_id: 'w5814', ...(hours ? { hours } : {}) });
  assert.ok(!set.isError, set.text);
  assert.ok(env.store.work.get('w5814')!.holdAsk?.set);
  return env;
}

test('w5895: a hold that was set and then lifted does not come back as HOLD ASKED, NOT SET, and its work_id no longer gets a re-hold through the guard', async (t) => {
  const env = await setByDispatcher(t);
  // A person tells the dispatcher to lift it, in their own turn there.
  asTurn(env.dispatcher(), 'human');
  const lift = await env.call(env.dispatcher().info, 'hold_machine', { machine: 'pc', action: 'lift' });
  assert.ok(!lift.isError, lift.text);
  assert.equal(env.store.machines.get('pc')!.drain, undefined);
  asTurn(env.dispatcher(), 'system');
  const st = await env.call(env.dispatcher().info, 'system_status', {});
  assert.doesNotMatch(st.text, /ASKED, NOT SET/);
  const lm = await env.call(env.dispatcher().info, 'list_machines', {});
  assert.doesNotMatch(lm.text, /ASKED, NOT SET/);
  const again = await env.call(env.dispatcher().info, 'hold_machine', { machine: 'pc', action: 'hold', words: WORDS, who: 'Lothsahn', work_id: 'w5814' });
  assert.ok(again.isError, `the spent ask lets no re-hold through: ${again.text}`);
  assert.equal(env.store.machines.get('pc')!.drain, undefined);
});

test('w5895: a hold whose hours ran out does not come back as HOLD ASKED, NOT SET', async (t) => {
  const env = await setByDispatcher(t, 2);
  const m = env.store.machines.get('pc')!;
  assert.ok(m.drain?.until, 'the drain has an end');
  m.drain = { ...m.drain!, until: new Date(Date.now() - 60_000).toISOString() };
  const st = await env.call(env.dispatcher().info, 'system_status', {});
  assert.doesNotMatch(st.text, /HELD \(drained/);
  assert.doesNotMatch(st.text, /ASKED, NOT SET/);
});

test('w5895: a lift asked outside the person\'s turn shows LIFT ASKED, NOT SET until the dispatcher lifts it, then not again', async (t) => {
  const env = await setByDispatcher(t);
  const r = await env.call(env.chat(LOTH).info, 'update_work', { id: 'w5814', hold: { machine: 'pc', action: 'lift' }, words: 'Lift the hold on LothDesktop now' });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /LIFT ASKED, NOT SET/);
  const before = await env.call(env.dispatcher().info, 'system_status', {});
  assert.match(before.text, /LIFT ASKED, NOT SET: w5814/);
  asTurn(env.dispatcher(), 'system');
  const lift = await env.call(env.dispatcher().info, 'hold_machine', { machine: 'pc', action: 'lift', work_id: 'w5814' });
  assert.ok(!lift.isError, lift.text);
  const after = await env.call(env.dispatcher().info, 'system_status', {});
  assert.doesNotMatch(after.text, /ASKED, NOT SET/);
});

test('w5895: a hold of an unknown machine is refused and leaves no ask behind', async (t) => {
  const env = await heldScene(t);
  asTurn(env.chat(LOTH), 'system');
  const r = await env.call(env.chat(LOTH).info, 'update_work', { id: 'w5814', hold: { machine: 'nosuchpc', action: 'hold' }, words: WORDS });
  assert.ok(r.isError, r.text);
  assert.match(r.text, /no computer FF Factory knows/);
  assert.equal(env.store.work.get('w5814')!.holdAsk, undefined);
  const st = await env.call(env.dispatcher().info, 'system_status', {});
  assert.doesNotMatch(st.text, /ASKED, NOT SET/);
});

// w5943's review of #1307 at c72eeb05: a hold that landed some other way than hold_machine work_id=<the asking request>
// left that request's ask unset; once the hold was lifted the line came back and the guard let the dispatcher hold the
// machine again. The incident itself went this way: w5814's ask stayed NOT SET while config placement.hold held LothDesktop.
async function askedOutside(t: Parameters<typeof twoComputers>[0]) {
  const env = await heldScene(t);
  asTurn(env.chat(LOTH), 'system');
  const r = await env.call(env.chat(LOTH).info, 'update_work', { id: 'w5814', hold: { machine: 'pc', action: 'hold' }, words: WORDS });
  assert.ok(!r.isError, r.text);
  assert.ok(!env.store.work.get('w5814')!.holdAsk?.set);
  return env;
}
async function noReHold(env: Awaited<ReturnType<typeof heldScene>>) {
  assert.ok(env.store.work.get('w5814')!.holdAsk?.set, 'the ask on w5814 is set by the hold that landed another way');
  asTurn(env.dispatcher(), 'system');
  const st = await env.call(env.dispatcher().info, 'system_status', {});
  assert.doesNotMatch(st.text, /ASKED, NOT SET/);
  const again = await env.call(env.dispatcher().info, 'hold_machine', { machine: 'pc', action: 'hold', words: WORDS, who: 'Lothsahn', work_id: 'w5814' });
  assert.ok(again.isError, `no re-hold for the spent ask: ${again.text}`);
  assert.equal(env.store.machines.get('pc')!.drain, undefined);
}

test('w5895: a hold set in the person\'s own turn on another request, then lifted, spends the first request\'s ask too', async (t) => {
  const env = await askedOutside(t);
  const loth = env.chat(LOTH);
  asTurn(loth, 'human');
  const h = await env.call(loth.info, 'update_work', { id: 'w5475', hold: { machine: 'pc', action: 'hold' }, words: WORDS });
  assert.ok(!h.isError, h.text);
  const l = await env.call(loth.info, 'update_work', { id: 'w5475', hold: { machine: 'pc', action: 'lift' }, words: 'Lift the hold on LothDesktop' });
  assert.ok(!l.isError, l.text);
  await noReHold(env);
});

test('w5895: a hold_machine without work_id, then lifted, spends the asking request\'s ask', async (t) => {
  const env = await askedOutside(t);
  asTurn(env.dispatcher(), 'human');
  for (const action of ['hold', 'lift'] as const) {
    const r = await env.call(env.dispatcher().info, 'hold_machine', { machine: 'pc', action, words: WORDS, who: 'Lothsahn' });
    assert.ok(!r.isError, r.text);
  }
  await noReHold(env);
});

test('w5895: a hold set through config placement.hold, then removed, spends the asking request\'s ask', async (t) => {
  const env = await askedOutside(t);
  asTurn(env.dispatcher(), 'human');
  const on = await env.call(env.dispatcher().info, 'set_app_config', { key: 'placement.hold', value: { pc: { why: 'lothsahn: hold it' } }, user_asked: true });
  assert.ok(!on.isError, on.text);
  assert.equal(env.store.work.get('w5814')!.holdAsk?.set?.by, 'config placement.hold');
  const off = await env.call(env.dispatcher().info, 'set_app_config', { key: 'placement.hold', value: null, user_asked: true });
  assert.ok(!off.isError, off.text);
  await noReHold(env);
});

// w5969's review of #1307 at d4df9ff1: removing a machine from config placement.hold spent a lift ask while a drain still
// held it (probe B3), and a lift of a config-only hold never showed NOT SET (B4). An ask is now spent only once in force.
test('w5895: a lift ask is not spent by a config placement.hold removal while the drain still holds; the dispatcher\'s lift then goes through (B3)', async (t) => {
  const env = await heldScene(t);
  const disp = env.dispatcher();
  asTurn(disp, 'human');
  assert.ok(!(await env.call(disp.info, 'hold_machine', { machine: 'pc', action: 'hold', words: WORDS, who: 'Lothsahn' })).isError);
  assert.ok(!(await env.call(disp.info, 'set_app_config', { key: 'placement.hold', value: { pc: { why: 'lothsahn: hold it' } }, user_asked: true })).isError);
  asTurn(env.chat(LOTH), 'system');
  const ask = await env.call(env.chat(LOTH).info, 'update_work', { id: 'w5814', hold: { machine: 'pc', action: 'lift' }, words: 'Lift the hold on LothDesktop' });
  assert.ok(!ask.isError, ask.text);
  assert.ok(!(await env.call(disp.info, 'set_app_config', { key: 'placement.hold', value: null, user_asked: true })).isError);
  assert.ok(env.store.machines.get('pc')!.drain, 'still drained');
  assert.equal(env.store.work.get('w5814')!.holdAsk?.set, undefined, 'the lift is not in force, so its ask is not spent');
  asTurn(disp, 'system');
  const st = await env.call(disp.info, 'system_status', {});
  assert.match(st.text, /LIFT ASKED, NOT SET: w5814: .*hold_machine machine=pc action=lift work_id=w5814/);
  const lift = await env.call(disp.info, 'hold_machine', { machine: 'pc', action: 'lift', work_id: 'w5814' });
  assert.ok(!lift.isError, lift.text);
  assert.equal(env.store.machines.get('pc')!.drain, undefined);
  assert.ok(env.store.work.get('w5814')!.holdAsk?.set);
  assert.doesNotMatch((await env.call(disp.info, 'system_status', {})).text, /ASKED, NOT SET/);
});

test('w5895: a lift ask of a config-only hold shows NOT SET with who lifts it, and the config removal spends it (B4)', async (t) => {
  const env = await heldScene(t);
  const disp = env.dispatcher();
  asTurn(disp, 'human');
  assert.ok(!(await env.call(disp.info, 'set_app_config', { key: 'placement.hold', value: { pc: { why: 'lothsahn: hold it' } }, user_asked: true })).isError);
  asTurn(env.chat(LOTH), 'system');
  const ask = await env.call(env.chat(LOTH).info, 'update_work', { id: 'w5814', hold: { machine: 'pc', action: 'lift' }, words: 'Lift the hold on LothDesktop' });
  assert.ok(!ask.isError, ask.text);
  asTurn(disp, 'system');
  // A hold_machine lift has no drain to lift: it spends nothing while the config hold stays.
  await env.call(disp.info, 'hold_machine', { machine: 'pc', action: 'lift', work_id: 'w5814' });
  assert.equal(env.store.work.get('w5814')!.holdAsk?.set, undefined);
  const st = await env.call(disp.info, 'system_status', {});
  assert.match(st.text, /LIFT ASKED, NOT SET: w5814: .*set_app_config placement\.hold without pc/);
  asTurn(disp, 'human');
  assert.ok(!(await env.call(disp.info, 'set_app_config', { key: 'placement.hold', value: null, user_asked: true })).isError);
  assert.equal(env.store.work.get('w5814')!.holdAsk?.set?.by, 'config placement.hold');
  asTurn(disp, 'system');
  assert.doesNotMatch((await env.call(disp.info, 'system_status', {})).text, /ASKED, NOT SET/);
});

// w5978's review of #1307 at ff84e75d: a lift in the person's own turn headlined "LIFT SET" while config placement.hold still
// held the machine (P1), and a lift asked while nothing held it was never spent, so the guard later let the dispatcher lift
// someone else's new drain for it (P3).
test('w5895: a lift in the person\'s own turn while config placement.hold still holds says NOT SET, never "takes new work again" (P1)', async (t) => {
  const env = await heldScene(t);
  const disp = env.dispatcher();
  asTurn(disp, 'human');
  assert.ok(!(await env.call(disp.info, 'hold_machine', { machine: 'pc', action: 'hold', words: WORDS, who: 'Lothsahn' })).isError);
  assert.ok(!(await env.call(disp.info, 'set_app_config', { key: 'placement.hold', value: { pc: { why: 'lothsahn: hold it' } }, user_asked: true })).isError);
  const loth = env.chat(LOTH);
  asTurn(loth, 'human');
  const r = await env.call(loth.info, 'update_work', { id: 'w5814', hold: { machine: 'pc', action: 'lift' }, words: 'Lift the hold on LothDesktop' });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /LIFT ASKED, NOT SET: still held by config placement\.hold; set_app_config placement\.hold without pc in this turn/);
  assert.doesNotMatch(r.text, /LIFT SET|takes new work again/);
  assert.equal(env.store.machines.get('pc')!.drain, undefined, 'the drain itself is lifted');
  assert.equal(env.store.work.get('w5814')!.holdAsk?.set, undefined);
  // P1b: hold_machine's own lift says the same.
  asTurn(disp, 'human');
  assert.ok(!(await env.call(disp.info, 'hold_machine', { machine: 'pc', action: 'hold', words: WORDS, who: 'Lothsahn' })).isError);
  const l = await env.call(disp.info, 'hold_machine', { machine: 'pc', action: 'lift' });
  assert.ok(!l.isError, l.text);
  assert.doesNotMatch(l.text, /takes new work again/);
  assert.match(l.text, /config placement\.hold still holds pc/);
});

test('w5895: a lift asked while nothing holds the machine is spent at once, so it cannot lift a later drain of someone else\'s (P3)', async (t) => {
  const env = await heldScene(t);
  const disp = env.dispatcher();
  asTurn(env.chat(LOTH), 'system');
  const ask = await env.call(env.chat(LOTH).info, 'update_work', { id: 'w5814', hold: { machine: 'pc', action: 'lift' }, words: 'Lift the hold on LothDesktop' });
  assert.ok(!ask.isError, ask.text);
  assert.match(ask.text, /LIFT ALREADY IN FORCE on pc/);
  assert.equal(env.store.work.get('w5814')!.holdAsk?.set?.by, 'already in force when asked');
  asTurn(disp, 'human');
  assert.ok(!(await env.call(disp.info, 'hold_machine', { machine: 'pc', action: 'hold', words: 'Ben: hold new work on pc for the build', who: 'Ben' })).isError);
  asTurn(disp, 'system');
  assert.doesNotMatch((await env.call(disp.info, 'system_status', {})).text, /ASKED, NOT SET/);
  const lift = await env.call(disp.info, 'hold_machine', { machine: 'pc', action: 'lift', work_id: 'w5814' });
  assert.ok(lift.isError, `the spent lift ask opens nothing: ${lift.text}`);
  assert.ok(env.store.machines.get('pc')!.drain, 'the newer drain stays');
});

test('w5895: an unset lift ask never opens the guard against a drain set after it (P3, the guard)', async (t) => {
  const env = await heldScene(t);
  const disp = env.dispatcher();
  const w = env.store.work.get('w5814')!;
  w.holdAsk = { machine: 'pc', action: 'lift', words: 'Lift the hold on LothDesktop', who: 'Lothsahn', at: '2000-01-01T00:00:00.000Z' };
  w.humanAsked = false; // as after a note outside their turn: only the ask could open the guard
  env.store.putWork(w);
  asTurn(disp, 'human');
  assert.ok(!(await env.call(disp.info, 'hold_machine', { machine: 'pc', action: 'hold', words: 'Ben: hold new work on pc for the build', who: 'Ben' })).isError);
  asTurn(disp, 'system');
  const lift = await env.call(disp.info, 'hold_machine', { machine: 'pc', action: 'lift', work_id: 'w5814' });
  assert.ok(lift.isError, lift.text);
  assert.ok(env.store.machines.get('pc')!.drain);
});
