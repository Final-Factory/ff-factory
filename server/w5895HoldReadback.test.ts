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
  // The dispatcher's guard lets the recorded ask through, though humanAsked is false (C1: every try was refused).
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

test('w5895: a drain lets only its running workers finish by default; another worker\'s check-in resume is logged against it and still goes (warn-only)', async (t) => {
  const env = await heldScene(t);
  (env.agents as unknown as { waker: { pending(id: string): unknown } }).waker.pending = (id: string) => (id === 'stop1' ? { at: '2026-11-26T04:39:00.000Z', note: 'check CI' } : undefined);
  env.store.putWork({ ...env.store.work.get('w5814')!, humanAsked: true });
  const set = await env.call(env.dispatcher().info, 'hold_machine', { machine: 'pc', action: 'hold', words: WORDS, who: 'Lothsahn', except: ['w5586'], work_id: 'w5814' });
  assert.ok(!set.isError, set.text);
  assert.match(set.text, /the 1 worker\(s\) running there finish, and the others there should not resume/);
  assert.match(set.text, /worker stop1 \(w5475\) stopped; will resume here at its check-in 04:39Z: the drain lets only its running workers finish, so this resume is AGAINST it/);
  assert.match(set.text, /w5586: worker stop2 stopped; resumes here at its next message \(the hold lets it through\)/);
  const d = env.store.machines.get('pc')!.drain!;
  assert.deepEqual([d.resumes, d.running], ['running', ['run1']]);
  assert.match(drainWouldHold(d, { id: 'stop1', works: ['w5475'] }) ?? '', /lets only the workers running at/);
  assert.equal(drainWouldHold(d, { id: 'run1', works: ['w5814'] }), undefined, 'a running one finishes');
  assert.equal(drainWouldHold(d, { id: 'stop2', works: ['w5586'] }), undefined, 'an excepted request\'s worker resumes');
  // Warn-only: the resume of stop1 at its check-in is not held (machineHold), and it is logged once.
  const logs: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.join(' '));
  try {
    const hold = (env.agents as unknown as { machineHold(s: { info: SessionInfo }): string | undefined }).machineHold.bind(env.agents);
    const s = { info: env.store.sessions.get('stop1')! };
    assert.equal(hold(s), undefined, 'warn-only: the resume goes');
    assert.equal(hold(s), undefined);
  } finally {
    console.log = log;
  }
  assert.equal(logs.filter((l) => /pc drain: worker stop1 \(w5475\) resumes there.*warn-only: it would be held once enforced/.test(l)).length, 1, logs.join('\n'));
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
