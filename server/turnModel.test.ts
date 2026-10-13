import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { messageTag, ROUTINE_AFTER_MINUTES_DEFAULT, ROUTINE_MODEL_DEFAULT, TurnModels, turnKind, turnModelSettings } from './turnModel.ts';
import { Store } from './store.ts';
import { SessionManager, setQueryForTesting } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { Agents } from './agents.ts';
import { Identity } from './identity.ts';
import { normalizeSetting, SETTABLE_KEYS } from './appConfig.ts';
import type { Config } from './config.ts';
import type { Requester, SessionInfo, UserInfo } from '../shared/types.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';
import { useFakeVault } from './testVault.ts';

/**
 * Which model answers a coordinator's turn (w1158, lothsahn: "2) Do it, use sonnet"; docs/orchestrators.md "Which model
 * answers a turn"): the turns no person started on the routine model, a person's own message on the coordinator's own.
 * Workers are never switched (lothsahn: "5) Do not do this").
 */

useFakeVault();

const OPUS = 'opus';
const cfg = (o: Partial<Config['orchestrator']> = {}) => ({ orchestrator: { model: OPUS, effort: 'medium' as const, notifyOnWorkerEvents: true, ...o } });
const personal = (id = 'p1'): Pick<SessionInfo, 'id' | 'kind' | 'orchestratorRole' | 'model'> => ({ id, kind: 'orchestrator', orchestratorRole: 'personal', model: OPUS });
const dispatcher = (id = 'd1'): Pick<SessionInfo, 'id' | 'kind' | 'orchestratorRole' | 'model'> => ({ id, kind: 'orchestrator', orchestratorRole: 'dispatcher', model: OPUS });

test('w1158: every kind of turn the request names, classified', () => {
  // Routine: nobody's own message started them (lothsahn's list in w1158, and the like).
  const routine = [
    '[worker update] w12 (fix the splitter): the worker finished a turn …',
    '[dispatch] w12: started in beast/slot2',
    '[timer t-08f90bfd "Morning check"] check stalled requests',
    '[ledger cleanup] closed w11 (merged)',
    '[heartbeat] 3 workers busy',
    '[machines] biscuit is back online',
    '[machine biscuit] Clean-up cannot free enough disk space',
    '[machine updates] biscuit updated to 1a2b3c',
    '[ops worker] deploy done',
    '[intake auto-closed] w40 merged',
    '[app restarted] your turn was cut off',
    '[unity] slot3 editor restarted',
    '[unity blocked] beast at its editor limit',
    '[host] disk low',
    '[wake_me] your check-in',
    '[person message] from Ben: can you look at w9?',
    '[conditional decision] closed w811',
    '[intake question] w50 asks …',
    '[intake escalation] w51 measured +3% tick time',
    '[auto-delegation] started w52',
    '[from another owner] Ben messaged your worker',
    '[from FFBox, Lothsahn] filed w53',
    '[standing agent] triage finished',
  ];
  for (const t of routine) {
    assert.equal(turnKind('personal', 'system', t), 'routine', t);
    assert.equal(turnKind('dispatcher', 'system', t), 'routine', t);
  }
  // The dispatcher's placement and dispatch decisions keep its own model.
  for (const t of ['[work request] w12 from Ben (high): …', '[work update] w12: Ben added a note', '[ledger] w633 (the timing table) is unblocked', '[ledger] Capacity may have freed: 2 requests queued']) {
    assert.equal(turnKind('dispatcher', 'system', t), 'own', t);
    assert.equal(turnKind('personal', 'system', t), 'routine', `${t}: not a person's orchestrator's decision`);
  }
  // A person's click can be their own words for an action (w1039).
  assert.equal(turnKind('personal', 'system', '[reaction] Ben 👍 on #42'), 'own');
  // A person's own words, however they came (their chat, FFBox's matched relay, a remote session, voice).
  for (const t of ['close w9 please', "[via FFBox: Ben's own message in #ask-assistant] approve w9", '[via remote]\nstatus?', '[ledger cleanup] (quoted by Ben)']) {
    assert.equal(turnKind('personal', 'human', t), 'person', t);
    assert.equal(turnKind('dispatcher', 'human', t), 'person', t);
  }
  assert.equal(messageTag('[timer t-1 "x"] go'), 'timer t-1');
  assert.equal(messageTag('[from FFBox, Lothsahn] filed'), 'from ffbox');
  assert.equal(messageTag('no tag'), undefined);
  assert.notEqual(turnKind('dispatcher', 'system', '[ledger cleanup] closed w11'), 'own', '"ledger cleanup" is not "ledger"');
});

test('w1158: routine turns on the routine model, a person\'s on the own model, and routine ones shortly after a person\'s stay there', () => {
  let now = 1_000_000;
  const tm = new TurnModels(() => cfg(), () => now);
  const p = personal();
  // Quiet: a routine turn goes to Sonnet.
  assert.deepEqual(tm.pick(p, 'system', '[worker update] w1 …', true), { model: ROUTINE_MODEL_DEFAULT, kind: 'routine' });
  assert.equal(ROUTINE_MODEL_DEFAULT, 'claude-sonnet-5-5', 'lothsahn: "use sonnet"');
  // A person writes: their model at once, joining a running turn too.
  assert.deepEqual(tm.pick(p, 'human', 'what is w1 doing?', false), { model: OPUS, kind: 'person' });
  // Within the window after it, routine turns stay on the own model (its cache holds the conversation).
  now += (ROUTINE_AFTER_MINUTES_DEFAULT - 1) * 60_000;
  assert.deepEqual(tm.pick(p, 'system', '[worker update] w1 done', true), { model: OPUS, kind: 'routine' });
  // After it, the routine model again.
  now += 2 * 60_000;
  assert.deepEqual(tm.pick(p, 'system', '[timer t-1 "x"] check', true), { model: ROUTINE_MODEL_DEFAULT, kind: 'routine' });
  // The session's model follows its live process (init message): a drifted one does not change the own model.
  assert.deepEqual(tm.pick({ ...p, model: ROUTINE_MODEL_DEFAULT } as never, 'human', 'and now?', true), { model: OPUS, kind: 'person' });
  now += 2 * 60 * 60_000;
  // A routine message joining a running turn changes nothing.
  assert.equal(tm.pick(p, 'system', '[worker update] w2', false), undefined);
  // Each coordinator has its own window.
  assert.deepEqual(tm.pick(personal('p2'), 'system', '[worker update] w3', true), { model: ROUTINE_MODEL_DEFAULT, kind: 'routine' });
  // The dispatcher's decisions on its own model; its routine notices on the routine one once the window has passed.
  const d = dispatcher();
  assert.deepEqual(tm.pick(d, 'system', '[work request] w5 …', true), { model: OPUS, kind: 'own' });
  assert.deepEqual(tm.pick(d, 'system', '[machines] beast online', true), { model: OPUS, kind: 'routine' });
  now += 61 * 60_000;
  assert.deepEqual(tm.pick(d, 'system', '[machines] beast online', true), { model: ROUTINE_MODEL_DEFAULT, kind: 'routine' });
});

test('w1158: workers, standing agents and the ops worker are never switched; "off" keeps every coordinator turn on its own model', () => {
  const tm = new TurnModels(() => cfg());
  for (const kind of ['worker', 'standing', 'ops'] as const) assert.equal(tm.pick({ id: 'x', kind }, 'system', '[wake_me] check', true), undefined, kind);
  const off = new TurnModels(() => cfg({ routineModel: 'off' }));
  assert.deepEqual(off.pick(personal(), 'system', '[worker update] w1', true), { model: OPUS, kind: 'routine' });
  assert.equal(turnModelSettings(cfg({ routineModel: null })).routine, undefined);
  assert.equal(turnModelSettings(cfg()).routine, ROUTINE_MODEL_DEFAULT);
  // 0 minutes: every routine turn switches.
  const now = 5_000_000;
  const zero = new TurnModels(() => cfg({ routineAfterMinutes: 0 }), () => now);
  zero.pick(personal(), 'human', 'hi', true);
  assert.equal(zero.pick(personal(), 'system', '[worker update] w1', true)?.model, ROUTINE_MODEL_DEFAULT);
  // Settable live, checked (the way back to all-Opus without a deploy).
  assert.ok(SETTABLE_KEYS.includes('orchestrator.routineModel') && SETTABLE_KEYS.includes('orchestrator.routineAfterMinutes'));
  assert.equal(normalizeSetting('orchestrator.routineModel', 'off'), 'off');
  assert.equal(normalizeSetting('orchestrator.routineModel', 'claude-sonnet-5-5'), 'claude-sonnet-5-5');
  assert.throws(() => normalizeSetting('orchestrator.routineModel', 'gpt-5; rm -rf'), /a model/);
  assert.throws(() => normalizeSetting('orchestrator.routineAfterMinutes', -1), /0 to 1440/);
});

test('w1158: a live coordinator session starts on the routine model for a routine turn and switches for its person\'s message', async (t) => {
  const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
  const PEOPLE: UserInfo[] = [{ ...BEN, role: 'owner' }];
  const calls: string[] = [];
  const base = fakeQuery({ stepMs: 1 });
  setQueryForTesting(((args: Parameters<typeof base>[0]) => {
    calls.push(`start ${args.options?.model}`);
    const q = base(args) as unknown as { setModel: (m?: string) => Promise<void> };
    q.setModel = async (m?: string) => void calls.push(`set ${m}`);
    return q;
  }) as never);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-turnmodel-'));
  const config = {
    dataDir: dir,
    sandboxRoot: dir,
    standingRoot: path.join(dir, '_agents'),
    repo: { url: path.join(dir, 'base'), basePath: path.join(dir, 'base') },
    defaultBase: 'origin/master',
    models: ['opus', 'sonnet'],
    defaultModel: 'opus',
    protectedPaths: [],
    limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: false },
    worker: { permissionMode: 'bypassPermissions', effort: 'low' },
    unity: {},
    machines: {},
  } as unknown as Config;
  const store = new Store(dir);
  const sessions = new SessionManager(config, store);
  const machines = new MachineManager(config, store, sessions);
  const agents = new Agents(config, store, sessions, machines, new Identity(config, () => PEOPLE));
  agents.boot();
  t.after(async () => {
    agents.orchestrators.close();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const id = agents.orchestrators.personalFor(BEN).info.id;
  const idle = async () => {
    for (let i = 0; i < 400 && sessions.get(id).info.turnOpenSince; i++) await new Promise((r) => setTimeout(r, 10));
  };
  sessions.send(id, '[worker update] w1 (a fix): finished a turn', 'system');
  await idle();
  sessions.send(id, 'what did it find?', 'human', undefined, { requestedBy: BEN });
  await idle();
  sessions.send(id, '[worker update] w1: merged', 'system');
  await idle();
  assert.deepEqual(calls, ['start claude-sonnet-5-5', 'set opus'], 'routine first, then the person; the routine turn right after stays on opus');
  const lines = store.readTranscript(id, 50).filter((e) => e.kind === 'system').map((e) => e.text);
  assert.ok(lines.includes("Model: opus from this turn on (a person's own message; w1158)."), lines.join('\n'));
});
