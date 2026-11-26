import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionInfo, WorkItem } from '../shared/types.ts';
import { moveDecision, type MoveFacts } from './resumeMove.ts';
import type { Computer } from './placement.ts';
import { USER_ASKED_TOOLS } from './belts.ts';
import { drainHolds, drainOf, newDrain } from './machineDrain.ts';
import { BEN, putRequests, T0, twoComputers } from './orchestratorsTestKit.ts';

// w5878, 2026-11-26: lothsahn on w5814, "Hold new work on LothDesktop and let the running workers finish". The hold lived in
// the dispatcher's notes only, and the w2046 moves put w5838 (17:54-07:00), w5857 (18:06), w5863 (18:54) and w5834 (19:12)
// on LothDesktop: every move logged "first with room in placement.prefer (beast > lothdesktop > ...)" with no hold named.
// hold_machine keeps a person's drain on the machine's record, and placement() carries it to every path. pc is LothDesktop.

const WORDS = 'Hold new work on LothDesktop and let the running workers finish';
const asked = (env: Awaited<ReturnType<typeof twoComputers>>) => putRequests(env.store, [{ id: 'w5878', status: 'active', humanAsked: true }]);

async function drained(t: Parameters<typeof twoComputers>[0], extra: Record<string, unknown> = {}) {
  const env = await twoComputers(t);
  asked(env);
  const r = await env.call(env.dispatcher().info, 'hold_machine', { machine: 'pc', action: 'hold', words: WORDS, who: 'lothsahn', work_id: 'w5878', ...extra });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /^pc is drained: no new work, move or pair leg goes there.*worker\(s\) running there finish/);
  return env;
}

test('w5878: hold_machine needs the person\'s quoted words and who; it holds new work (placement()) and not the resumes of pc\'s own workers (placement(false)); lift ends it', async (t) => {
  const env = await twoComputers(t);
  const { agents, call, dispatcher, store } = env;
  asked(env);
  // The dispatcher runs it only for a request its person asked in their own words (belts.ts USER_ASKED_TOOLS).
  assert.ok(USER_ASKED_TOOLS.has('hold_machine'), "the dispatcher's runs only when a person asked");
  const bare = await call(dispatcher().info, 'hold_machine', { machine: 'pc', action: 'hold', who: 'lothsahn', work_id: 'w5878' });
  assert.equal(bare.isError, true);
  assert.match(bare.text, /the person's own words/);
  assert.equal(agents.placement().hold?.pc, undefined);
  assert.ok(!(await call(dispatcher().info, 'hold_machine', { machine: 'pc', action: 'hold', words: WORDS, who: 'lothsahn', work_id: 'w5878' })).isError);
  assert.match(agents.placement().hold?.pc ?? '', /^drained: lothsahn: "Hold new work on LothDesktop and let the running workers finish" \(set by the dispatcher at/);
  assert.equal(agents.placement(false).hold?.pc, undefined, "pc's own workers still resume there (machineHold)");
  assert.equal(agents.placement().hold?.beast, undefined);
  assert.ok(store.machines.get('pc')!.drain, 'kept on the machine record');
  const lift = await call(dispatcher().info, 'hold_machine', { machine: 'pc', action: 'lift', work_id: 'w5878' });
  assert.match(lift.text, /^pc takes new work again/);
  assert.equal(agents.placement().hold?.pc, undefined);
});

test('w5878: a drain with hours lifts by itself; except lets the named request through', () => {
  const now = new Date(T0);
  const d = newDrain({ words: WORDS, who: 'lothsahn', hours: 2, except: ['W12', 'nope'] }, 'the dispatcher', now);
  assert.ok(typeof d !== 'string');
  assert.deepEqual(d.except, ['w12']);
  assert.ok(drainOf({ drain: d }, now.getTime() + 3_600_000));
  assert.equal(drainOf({ drain: d }, now.getTime() + 2 * 3_600_000), undefined, 'past until');
  assert.deepEqual(drainHolds([{ id: 'pc', drain: d }], now.getTime()).except, { pc: ['w12'] });
});

test('w5878: a dispatcher start on a drained computer is refused; one its drain excepts, and one elsewhere, start', async (t) => {
  const { store, call, dispatcher } = await drained(t, { except: ['w9'] });
  putRequests(store, [{ id: 'w8', by: BEN, status: 'queued', queuedFor: { at: T0 } }, { id: 'w9', by: BEN, status: 'queued', queuedFor: { at: T0 } }]);
  const no = await call(dispatcher().info, 'start_agent', { work_id: 'w8', prompt: 'Fix it.', title: 'fix', sandbox: 'pc/alpha' });
  assert.equal(no.isError, true);
  assert.match(no.text, /pc is drained: lothsahn: "Hold new work on LothDesktop.*no new work goes there/);
  assert.deepEqual(store.work.get('w8')!.sessionIds, []);
  const ok = await call(dispatcher().info, 'start_agent', { work_id: 'w8', prompt: 'Fix it.', title: 'fix', sandbox: 'beast/slot1' });
  assert.ok(!ok.isError, ok.text);
  const except = await call(dispatcher().info, 'start_agent', { work_id: 'w9', prompt: 'Fix it.', title: 'fix', sandbox: 'pc/alpha' });
  assert.ok(!except.isError, except.text);
});

// The fleet at 19:12:25-07:00 on 2026-11-25 (w5834's move): BEAST at its cap, LothDesktop idle and drained.
const pc = (id: string, over: Partial<Computer> = {}): Computer => ({ id, online: true, live: 0, midTurn: 0, maxAgents: 6, sandboxes: 3, maxSandboxes: 3, freeSandboxes: 3, platform: 'win32', ...over });
const FLEET: Computer[] = [pc('beast', { live: 7, midTurn: 6, sandboxes: 6, maxSandboxes: 6, freeSandboxes: 0 }), pc('pc')];

test('w5878: the w2046 room move and the agent-cap move (moveDecision on the worker\'s own facts) never pick a drained computer', async (t) => {
  const env = await twoComputers(t);
  const { store, agents, call, dispatcher } = env;
  asked(env);
  putRequests(store, [{ id: 'w5834', priority: 'high', status: 'active' }]);
  const info = { id: 'd2a4daef', machineId: 'beast', machineSandbox: 'slot1' } as SessionInfo;
  const facts = (): MoveFacts => ({
    ...(agents as unknown as { moveFacts(i: SessionInfo, r: WorkItem[]): MoveFacts }).moveFacts(info, [store.work.get('w5834')!]),
    places: FLEET, branch: 'w5834-fix', released: true, git: undefined, prefs: { ...agents.placement(), prefer: ['beast', 'pc'] },
  });
  for (const kind of ['game', 'agent'] as const) {
    const before = moveDecision({ ...facts(), requests: facts().requests.map((r) => ({ ...r, kind })) });
    assert.ok('move' in before && before.move.to === 'pc', `${kind}, not drained: ${JSON.stringify(before)}`);
  }
  await call(dispatcher().info, 'hold_machine', { machine: 'pc', action: 'hold', words: WORDS, who: 'lothsahn', work_id: 'w5878' });
  for (const kind of ['game', 'agent'] as const) {
    const d = moveDecision({ ...facts(), requests: facts().requests.map((r) => ({ ...r, kind })) });
    assert.ok(!('move' in d), `${kind}, drained: ${JSON.stringify(d)}`);
  }
});

test('w5878: a pair run\'s leg on a drained computer is refused, and nothing starts', async (t) => {
  const { store, call, dispatcher } = await drained(t);
  putRequests(store, [{ id: 'w2', by: BEN, status: 'queued', queuedFor: { at: T0 }, pair: { legs: 2 } }]);
  for (const [host, client] of [['beast/slot1', 'pc/alpha'], ['pc/alpha', 'beast/slot1']]) {
    const r = await call(dispatcher().info, 'start_agent', { work_id: 'w2', prompt: 'Run MP-lowore-pin-pair.', title: 'pair', sandbox: host, pair_sandboxes: [client] });
    assert.equal(r.isError, true);
    assert.match(r.text, /on pc\/alpha: pc is drained: lothsahn.*Nothing was started\./);
    assert.deepEqual(store.work.get('w2')!.sessionIds, []);
  }
});

test("w5878: a drain's except lets its requests past the drain only, never past a coming build's or a config hold on the same computer", async (t) => {
  const { agents, cfg } = await drained(t, { except: ['w9'] });
  assert.deepEqual(agents.placement().holdExcept?.pc, ['w9'], 'drain alone: w9 may go');
  const b = agents as unknown as { builds?: { holds(): Record<string, string> } };
  const builds = b.builds;
  b.builds = { ...(builds ?? {}), holds: () => ({ pc: 'a build is coming (w1606)' }) } as typeof builds;
  assert.equal(agents.placement().holdExcept?.pc, undefined, 'a build lets nothing through (w1863)');
  assert.match(agents.placement().hold?.pc ?? '', /a build is coming/);
  b.builds = builds;
  cfg.placement = { ...cfg.placement, hold: { pc: 'Ben testing' } };
  assert.equal(agents.placement().holdExcept?.pc, undefined, "a config hold's exceptions are its own");
});
