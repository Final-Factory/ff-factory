import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';
import { SessionManager, setQueryForTesting } from './sessions.ts';
import { SandboxManager } from './sandboxes.ts';
import { MachineManager } from './machines.ts';
import { Agents } from './agents.ts';
import { Identity } from './identity.ts';
import { PERSONAL_TOOLS, beltFor } from './belts.ts';
import { FILINGS_PER_MESSAGE, FOLLOW_UPS_PER_MESSAGE } from './orchestrators.ts';
import type { Config } from './config.ts';
import type { Requester, SessionInfo, TranscriptEvent, UserInfo } from '../shared/types.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';

/**
 * People's own orchestrators and the dispatcher (docs/orchestrators.md), end to end on a real Agents with the scripted
 * fake SDK: the migration from one shared chat, each role's tools, filing and the overlap check, the dispatcher's
 * decisions and replies, where worker updates go, follow-ups, and the guards on attribution and destructive tools.
 */

setQueryForTesting(fakeQuery({ stepMs: 1 }) as never);

const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const LOTH: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };
const PEOPLE: UserInfo[] = [
  { ...BEN, role: 'owner' },
  { ...LOTH, role: 'member' },
];
const T0 = '2026-09-28T09:00:00.000Z';

async function until(what: string, cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function setup(t: { after: (fn: () => void | Promise<void>) => void }, opts: { legacy?: boolean; notify?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-orch-'));
  const cfg = {
    dataDir: dir,
    sandboxRoot: dir,
    standingRoot: path.join(dir, '_agents'),
    repo: { url: path.join(dir, 'base'), basePath: path.join(dir, 'base') },
    defaultBase: 'origin/develop',
    models: ['opus', 'sonnet'],
    defaultModel: 'opus',
    protectedPaths: [],
    limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: opts.notify ?? true },
    worker: { permissionMode: 'bypassPermissions', effort: 'low' },
    unity: {},
  } as unknown as Config;
  if (opts.legacy) {
    // The one shared orchestrator from before, with a conversation and the global heartbeat.
    const main: SessionInfo = { id: 'main1', kind: 'orchestrator', title: 'Main', status: 'idle', permissionMode: 'default', createdAt: T0, lastActivityAt: T0, turns: 3, costUsd: 1, pendingPermissions: [], sdkSessionId: 'fake-main' };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ sandboxes: [], sessions: [main], orchestratorId: 'main1', settings: { heartbeatMinutes: 15 } }));
    fs.mkdirSync(path.join(dir, 'transcripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'transcripts', 'main1.jsonl'), JSON.stringify({ seq: 1, t: T0, kind: 'user', text: 'start work on spec 098', from: 'human', requestedBy: BEN }) + '\n');
  }
  const store = new Store(dir);
  const sessions = new SessionManager(cfg, store);
  const sandboxes = new SandboxManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const agents = new Agents(cfg, store, sandboxes, sessions, machines, new Identity(cfg, () => PEOPLE));
  // Workers start without the sandbox machinery (git identity, guard, Unity MCP): the fake agent needs none of it.
  Object.defineProperty(agents, 'workerOptions', { value: () => ({ model: 'opus' }) });
  store.putSandbox({ id: 'alpha', name: 'alpha', branch: 'sandbox/alpha', base: 'origin/develop', path: path.join(dir, 'alpha'), purpose: 'unused', status: 'ready', createdAt: T0, unity: { state: 'stopped' }, sessionIds: [] });
  agents.boot();
  t.after(async () => {
    agents.orchestrators.close();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const o = agents.orchestrators;
  const dispatcher = () => sessions.get(agents.dispatcherId);
  const chat = (r: Requester) => o.personalFor(r);
  /** Call one of an orchestrator's tools as its model would. */
  const call = async (info: SessionInfo, name: string, args: Record<string, unknown>) => {
    const tool = agents.orchestratorBelt(info).find((x) => x.name === name);
    if (!tool) throw new Error(`${info.title} has no ${name}`);
    const r = await tool.handler(args);
    return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
  };
  /** Harness messages a session got carrying `tag` (notices gathered into one message each keep their tag at a line start). */
  const heard = (id: string, tag: string) =>
    store.readTranscript(id).filter((e): e is Extract<TranscriptEvent, { kind: 'user' }> => e.kind === 'user' && e.from === 'system' && e.text.split('\n').some((l) => l.startsWith(tag)));
  return { dir, cfg, store, sessions, agents, o, dispatcher, chat, call, heard };
}

test('migration: the shared chat becomes the dispatcher, people get their own, the heartbeat becomes the owner’s', (t) => {
  const { store, agents, o } = setup(t, { legacy: true });
  const d = store.sessions.get('main1')!;
  assert.equal(agents.dispatcherId, 'main1', 'the dispatcher keeps the old conversation (it knows what is in flight)');
  assert.equal(d.orchestratorRole, 'dispatcher');
  assert.equal(d.title, 'Dispatcher');
  for (const r of [BEN, LOTH]) {
    const p = o.personalOf(r.userId)!;
    assert.ok(p, `${r.displayName} has an orchestrator`);
    assert.equal(p.info.kind, 'orchestrator');
    assert.equal(p.info.orchestratorRole, 'personal');
    assert.deepEqual(p.info.requestedBy, r);
    const notes = store.readTranscript(p.info.id);
    assert.equal(notes.length, 1);
    assert.match((notes[0] as { text: string }).text, /continues as the Dispatcher/);
  }
  assert.deepEqual(store.settings.heartbeat, { ben: 15 });
  assert.equal(store.settings.heartbeatMinutes, null);
  // A second start changes nothing.
  o.boot();
  assert.equal([...store.sessions.values()].filter((s) => s.kind === 'orchestrator').length, 3);
  assert.equal(store.readTranscript(o.personalOf('ben')!.info.id).length, 1);
});

test("tool belts: a person's orchestrator sees and files; the dispatcher acts; an /mcp key drives directly", (t) => {
  const { agents, dispatcher, chat } = setup(t);
  const names = (list: { name: string }[]) => new Set(list.map((x) => x.name));
  const personal = names(agents.orchestratorBelt(chat(BEN).info));
  assert.deepEqual([...personal].sort(), [...PERSONAL_TOOLS].sort());
  const d = names(agents.orchestratorBelt(dispatcher().info));
  for (const x of ['start_agent', 'create_sandbox', 'delete_sandbox', 'decide_work', 'list_work', 'message_agent', 'approve_delegation', 'max_activity']) assert.ok(d.has(x), `dispatcher has ${x}`);
  for (const x of ['request_work', 'update_work', 'set_heartbeat']) assert.ok(!d.has(x), `dispatcher has no ${x}`);
  const remote = names(beltFor('remote', agents.toolSpecs('human', agents.fixedActor(BEN), { role: 'remote', owner: BEN })));
  for (const x of ['start_agent', 'list_work', 'set_heartbeat']) assert.ok(remote.has(x), `remote has ${x}`);
  for (const x of ['request_work', 'update_work', 'decide_work']) assert.ok(!remote.has(x), `remote has no ${x}`);
});

test('filing and dedupe: the overlap is found at once, a repeat is the same request, the dispatcher must merge or say why not', async (t) => {
  const { store, o, dispatcher, chat, call, heard } = setup(t);
  const ben = chat(BEN).info;
  const loth = chat(LOTH).info;
  const a = await call(ben, 'request_work', { title: 'Fix the belt splitter desync (spec 098)', brief: 'Players desync when a splitter feeds three belts.', priority: 'high' });
  assert.equal(a.isError, false, a.text);
  assert.match(a.text, /^Filed w1 with the dispatcher\. You get a \[dispatch\]/);
  const b = await call(loth, 'request_work', { title: 'Belt splitter desync on load', brief: 'Seen after loading a save with splitters.', related_ids: ['098'] });
  assert.match(b.text, /^Filed w2 .*Possible overlap: w1 "Fix the belt splitter desync \(spec 098\)" \(same spec 098, similar title, strong\)/);
  assert.deepEqual(store.work.get('w2')!.overlaps[0], { ref: 'w1', kind: 'work', title: 'Fix the belt splitter desync (spec 098)', score: 0.8, why: 'same spec 098, similar title' });
  const again = await call(loth, 'request_work', { title: 'belt splitter desync ON LOAD', brief: 'Again.' });
  assert.match(again.text, /^Already filed as w2 \(new\)/);
  assert.equal(store.work.size, 2);

  // The dispatcher heard both, each attributed to its person.
  await until('both requests reach the dispatcher', () => heard(dispatcher().info.id, '[work request]').length === 2);
  assert.deepEqual(heard(dispatcher().info.id, '[work request]').map((e) => e.requestedBy?.userId).sort(), ['ben', 'lothsahn']);

  // Starting the repeat is refused until merged, or overridden with a reason.
  const start = await call(dispatcher().info, 'start_agent', { sandbox: 'alpha', prompt: 'fix it', title: 'Belt fix', work_id: 'w2' });
  assert.equal(start.isError, true);
  assert.match(start.text, /w2 may repeat work in flight: w1 .*override_duplicate/);

  const merge = await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'merge', into: 'w1', note: 'Same fix; Ben filed it first.' });
  assert.equal(merge.isError, false, merge.text);
  const [w1, w2] = [store.work.get('w1')!, store.work.get('w2')!];
  assert.equal(w2.status, 'merged');
  assert.equal(w2.mergedInto, 'w1');
  assert.deepEqual(w1.requesters, [BEN, LOTH]);
  await until('Lothsahn hears the merge', () => heard(loth.id, '[dispatch]').length === 1);
  assert.match(heard(loth.id, '[dispatch]')[0].text, /^\[dispatch\] w2 "Belt splitter desync on load": merged into w1 /);
  assert.equal(heard(ben.id, '[dispatch]').length, 0, 'Ben filed w1 and was not asked anything');
  assert.match(o.requireWork('w2').log.at(-1)!, /dispatcher: merged into w1/);
});

test('budgets and limits: a few filings per message of the person; a person’s next message restores them', async (t) => {
  const { o, chat, call } = setup(t);
  const ben = chat(BEN).info;
  for (let i = 0; i < FILINGS_PER_MESSAGE; i++) assert.equal((await call(ben, 'request_work', { title: `Task ${i} of many`, brief: 'x' })).isError, false);
  const over = await call(ben, 'request_work', { title: 'One more thing', brief: 'x' });
  assert.equal(over.isError, true);
  assert.match(over.text, /3 filings since Ben last wrote/);
  o.personWrote(ben.id);
  assert.equal((await call(ben, 'request_work', { title: 'One more thing', brief: 'x' })).isError, false);
});

test("routing: a worker's update goes to its requesters' own chats, never the dispatcher's or anyone else's", async (t) => {
  const { store, sessions, dispatcher, chat, call, heard } = setup(t);
  const ben = chat(BEN).info;
  const loth = chat(LOTH).info;
  await call(ben, 'request_work', { title: 'Make the tutorial skippable', brief: 'Add a skip button.' });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'alpha', prompt: 'Add a skip button to the tutorial', title: 'Tutorial skip', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  assert.deepEqual(sessions.get(id).info.requestedBy, BEN, 'the worker runs for the requester');
  await until('Ben hears the worker', () => heard(ben.id, '[worker update]').length === 1);
  assert.match(heard(ben.id, '[worker update]')[0].text, /\(requested by Ben\) in sandbox alpha finished a turn\. Its final message:\n\nEcho: Add a skip button/);
  assert.match(heard(ben.id, '[dispatch]')[0].text, new RegExp(`^\\[dispatch\\] w1 "Make the tutorial skippable": started worker ${id} "Tutorial skip" in alpha\\.`));
  const w = store.work.get('w1')!;
  assert.equal(w.status, 'active');
  assert.deepEqual(w.sessionIds, [id]);
  assert.equal(w.outcome, 'Echo: Add a skip button to the tutorial');
  assert.equal(heard(loth.id, '[worker update]').length, 0);
  assert.equal(heard(dispatcher().info.id, '[worker update]').length, 0);
});

test("follow-ups: a person's orchestrator messages only its person's own workers, a few times per message of theirs", async (t) => {
  const { o, agents, chat, call, heard } = setup(t);
  const loth = chat(LOTH).info;
  const ben = chat(BEN).info;
  const v = agents.startWorker({ sandbox: 'alpha', prompt: 'Look at the inventory UI', title: 'Inventory look', from: 'human', requestedBy: LOTH });
  assert.equal((await call(ben, 'message_agent', { session_id: v.info.id, text: 'hi' })).text, `ERROR: ${v.info.id} "Inventory look" is Lothsahn's work: follow up only on Ben's own workers; for anything else, request_work`);
  const sent = await call(loth, 'message_agent', { session_id: v.info.id, text: 'Also check the tooltips' });
  assert.equal(sent.text, 'Sent, for Lothsahn.');
  // The turn the follow-up started is reported back to Lothsahn only (the first turn too, when it was still running).
  await until('Lothsahn hears the follow-up', () => heard(loth.id, '[worker update]').some((e) => e.text.includes('Echo: Also check the tooltips')));
  assert.equal(heard(ben.id, '[worker update]').length, 0);
  for (let i = 1; i < FOLLOW_UPS_PER_MESSAGE; i++) assert.equal((await call(loth, 'message_agent', { session_id: v.info.id, text: `more ${i}` })).isError, false);
  assert.match((await call(loth, 'message_agent', { session_id: v.info.id, text: 'too many' })).text, /3 follow-ups to .* since Lothsahn last wrote/);
  o.personWrote(loth.id);
  assert.equal((await call(loth, 'message_agent', { session_id: v.info.id, text: 'after they wrote' })).isError, false);
});

test('the dispatcher acts for the request it serves, and runs destructive tools only for a person who asked', async (t) => {
  const { store, sessions, o, dispatcher, chat, call } = setup(t);
  const d = dispatcher();
  // A turn the harness started (a request arrived), not the owner writing here.
  sessions.send(d.info.id, '[work request] (test) nothing', 'system');
  await until('the dispatcher answers', () => d.info.status === 'idle');
  assert.match((await call(d.info, 'start_agent', { sandbox: 'alpha', prompt: 'x', title: 'x' })).text, /say whom this is for: pass work_id/);
  assert.match((await call(d.info, 'approve_delegation', { id: 'd1', user_asked: true })).text, /^ERROR: approve_delegation runs only for a request its person asked for/);
  // Filed by Ben's orchestrator in a turn of his own: the guard lets it through (the delegation itself does not exist).
  await call(chat(BEN).info, 'request_work', { title: 'Approve the doc fixes', brief: 'Ben says approve delegation d1.', related_ids: ['d1'] });
  assert.equal(store.work.get('w1')!.humanAsked, true);
  assert.match((await call(d.info, 'approve_delegation', { id: 'd1', user_asked: true, work_id: 'w1' })).text, /^ERROR: no delegation request "d1"/);
  // Work nobody asked for is the system payer's; a stranger is refused.
  assert.deepEqual(o.dispatcherActor('ben'), BEN);
  assert.throws(() => o.dispatcherActor('mallory'), /has not asked for anything/);
  assert.deepEqual(o.dispatcherActor(undefined, 'w1'), BEN);
  o.decide({ id: 'w1', action: 'done', note: 'nothing to approve' });
  assert.throws(() => o.dispatcherActor(undefined, 'w1'), /w1 is done/);
});

test('requests: a question goes to its filer, whose answer brings it back; closing as done does not wake the dispatcher', async (t) => {
  const { store, dispatcher, chat, call, heard } = setup(t);
  const loth = chat(LOTH).info;
  await call(loth, 'request_work', { title: 'Playtest the new tutorial', brief: 'Look for soft locks.' });
  await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'ask', note: 'Single-player or co-op?' });
  assert.equal(store.work.get('w1')!.status, 'question');
  await until('Lothsahn hears the question', () => heard(loth.id, '[dispatch]').length === 1);
  assert.match(heard(loth.id, '[dispatch]')[0].text, /: a question\.\nSingle-player or co-op\?$/);
  assert.match((await call(loth, 'update_work', { id: 'w1', note: 'Single-player' })).text, /^w1 is new: note: Single-player\./);
  // Filed and answered within a moment: the dispatcher gets both in one message.
  await until('the dispatcher hears the answer', () => heard(dispatcher().info.id, '[work update]').length === 1);
  assert.match(heard(dispatcher().info.id, '[work update]')[0].text, /^\[work request\] w1 [\s\S]*\n---\n\n\[work update\] w1 "Playtest the new tutorial" \(new\) from Lothsahn: note: Single-player\.$/);
  const before = heard(dispatcher().info.id, '[work').length;
  assert.match((await call(loth, 'update_work', { id: 'w1', close: 'done', note: 'Found none' })).text, /closed as done/);
  await new Promise((r) => setTimeout(r, 1800));
  assert.equal(heard(dispatcher().info.id, '[work').length, before);
  assert.equal(store.work.get('w1')!.outcome, 'Found none');
  assert.match((await call(chat(BEN).info, 'update_work', { id: 'w1', note: 'mine now' })).text, /is Lothsahn's request, not Ben's/);
});

test('list_work: open requests by default, one in full with its log', async (t) => {
  const { dispatcher, chat, call } = setup(t);
  await call(chat(BEN).info, 'request_work', { title: 'Tidy the docs', brief: 'Fix the dead links in docs/.', priority: 'low' });
  const all = await call(dispatcher().info, 'list_work', {});
  assert.match(all.text, /^- w1 \[new, low\] "Tidy the docs" for Ben, /);
  const one = await call(chat(LOTH).info, 'list_work', { id: 'w1' });
  assert.match(one.text, /Fix the dead links in docs\/\./);
  assert.match(one.text, /Log:\n {2}\d\d:\d\d filed by Ben/);
  assert.equal((await call(chat(LOTH).info, 'list_work', { mine: true })).text, 'No open requests.');
});
