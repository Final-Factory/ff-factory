import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from './store.ts';
import { SessionManager, setQueryForTesting } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { Agents } from './agents.ts';
import { Identity } from './identity.ts';
import type { Config } from './config.ts';
import type { Requester, SessionInfo, TranscriptEvent, UserInfo, WorkItem } from '../shared/types.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';
import { startTestMachine } from './testMachine.ts';
import { useFakeVault } from './testVault.ts';

/**
 * w5278: the dispatcher's slow tools no longer hold it. In w5222's measured hour (2026-11-23 06:30-07:30 UTC) its
 * machine_cleanup took 153 s, its switch_branch calls 15 s (median) to 36 s, and start_agent 43 s while it handed a
 * released sandbox over. start_agent now answers once its checks pass and runs the switch in the background (its `branch`
 * replaces the switch_branch before it); machine_cleanup's result comes as a message.
 */

useFakeVault();
setQueryForTesting(fakeQuery({ stepMs: 1 }) as never);

const LOTH: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };
const PEOPLE: UserInfo[] = [
  { userId: 'ben', displayName: 'Ben', role: 'owner' },
  { ...LOTH, role: 'member' },
];

async function until(what: string, cond: () => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

type UserEv = Extract<TranscriptEvent, { kind: 'user' }>;

async function setup(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-dispbg-'));
  const cfg = {
    dataDir: dir,
    sandboxRoot: dir,
    standingRoot: path.join(dir, '_agents'),
    repo: { url: path.join(dir, 'base'), basePath: path.join(dir, 'base') },
    defaultBase: 'origin/master',
    models: ['opus'],
    defaultModel: 'opus',
    protectedPaths: [],
    limits: {
      maxSessions: 30,
      maxUnity: 2,
      maxSandboxes: 4,
      minFreeGB: 0,
      minFreeRamGB: 0,
    },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: true },
    worker: { permissionMode: 'bypassPermissions', effort: 'low' },
    unity: {},
  } as unknown as Config;
  const store = new Store(dir);
  const sessions = new SessionManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const agents = new Agents(cfg, store, sessions, machines, new Identity(cfg, () => PEOPLE));
  agents.boot();
  (agents.orchestrators as unknown as { d: { gatherMs: number } }).d.gatherMs = 50;
  agents.orchestrators.statusAskDelayMs = 3_600_000;
  const pc = await startTestMachine(machines, { sandboxes: ['alpha', 'beta'] });
  t.after(async () => {
    await pc.stop();
    agents.orchestrators.close();
    agents.close(); // w6152: Agents' timers stop before the folder goes (w5915: a release pass wrote into a removed transcript, ENOENT).
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const call = async (info: SessionInfo, name: string, args: Record<string, unknown>) => {
    const tool = agents.orchestratorBelt(info).find((x) => x.name === name);
    if (!tool) throw new Error(`${info.title} has no ${name}`);
    const r = await tool.handler(args);
    return {
      text: r.content.map((c) => c.text).join('\n'),
      isError: !!r.isError,
    };
  };
  const users = (id: string) => store.readTranscript(id).filter((e): e is UserEv => e.kind === 'user');
  const request = (id: string, title: string) => {
    const now = new Date().toISOString();
    const w: WorkItem = {
      id,
      title,
      brief: `${title}.`,
      priority: 'normal',
      keys: [],
      requestedBy: LOTH,
      requesters: [],
      humanAsked: true,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      sessionIds: [],
      overlaps: [],
      asks: 0,
      log: [],
    };
    store.putWork(w);
    store.workSeq = Math.max(store.workSeq, Number(id.slice(1)));
    return w;
  };
  const branchIn = (sb: string) =>
    execFileSync('git', ['-C', pc.path(sb), 'branch', '--show-current'], {
      encoding: 'utf8',
    }).trim();
  return {
    store,
    agents,
    pc,
    call,
    users,
    request,
    branchIn,
    dispatcher: () => sessions.get(agents.dispatcherId).info,
  };
}

test('w5278: start_agent with branch answers before the switch, holds the request and the sandbox while it runs, then starts the worker on that branch with its brief', async (t) => {
  const { store, call, users, request, branchIn, dispatcher } = await setup(t);
  request('w1', 'Continue the moved work');
  request('w2', 'Other work');
  const started = await call(dispatcher(), 'start_agent', {
    sandbox: 'pc/alpha',
    prompt: 'Carry on from the pushed branch.',
    title: 'Moved work',
    work_id: 'w1',
    branch: 'feature/w1-moved',
  });
  assert.equal(started.isError, false, started.text);
  assert.match(started.text, /^Starting w1 in pc\/alpha: the sandbox is being switched to feature\/w1-moved first .*you need not wait for it \(w5278\)/);

  // Meanwhile neither the request nor the sandbox can be started again.
  const again = await call(dispatcher(), 'start_agent', {
    sandbox: 'pc/beta',
    prompt: 'x',
    title: 'Moved work',
    work_id: 'w1',
  });
  assert.match(again.text, /^ERROR: w1 is being started already: a start_agent for it is starting it in pc(\/alpha)? now/);
  const other = await call(dispatcher(), 'start_agent', {
    sandbox: 'pc/alpha',
    prompt: 'x',
    title: 'Other',
    work_id: 'w2',
  });
  assert.equal(other.isError, true, other.text);
  assert.match(other.text, /pc\/alpha/);

  await until('w1 has its worker', () => store.work.get('w1')!.sessionIds.length === 1);
  const worker = store.work.get('w1')!.sessionIds[0];
  assert.equal(store.sessions.get(worker)!.machineSandbox, 'alpha');
  assert.equal(branchIn('alpha'), 'feature/w1-moved');
  await until('its brief went', () => users(worker).length > 0);
  assert.ok(users(worker)[0].text.startsWith('Carry on from the pushed branch.'), users(worker)[0].text);
});

test("w5278: start_agent with branch keeps switch_branch's refusals, said at once, and nothing starts", async (t) => {
  const { store, call, request, dispatcher } = await setup(t);
  request('w1', 'Some work');
  const onMaster = await call(dispatcher(), 'start_agent', {
    sandbox: 'pc/alpha',
    prompt: 'x',
    title: 'Some work',
    work_id: 'w1',
    branch: 'master',
  });
  assert.equal(onMaster.isError, true, onMaster.text);
  assert.match(onMaster.text, /master/);
  const seat = await call(dispatcher(), 'start_agent', {
    sandbox: 'pc/alpha',
    prompt: 'x',
    title: 'Some work',
    work_id: 'w1',
    branch: 'feature/x',
    extra_agent: true,
  });
  assert.match(seat.text, /^ERROR: branch is for game work in a FREE sandbox/);
  assert.deepEqual(store.work.get('w1')!.sessionIds, []);
  // The request is free to start: no hold was left behind.
  const ok = await call(dispatcher(), 'start_agent', {
    sandbox: 'pc/alpha',
    prompt: 'Go.',
    title: 'Some work',
    work_id: 'w1',
  });
  assert.equal(ok.isError, false, ok.text);
  assert.match(ok.text, /^Started agent /);
});

test('w5278: a switch that fails after start_agent answered tells the dispatcher, starts nothing, and leaves the request startable', async (t) => {
  const { store, pc, call, users, request, branchIn, dispatcher } = await setup(t);
  request('w1', 'Some work');
  // An uncommitted change in the tree: the daemon refuses the switch (switch_branch's rule), after the answer went.
  const tracked = execFileSync('git', ['-C', pc.path('alpha'), 'ls-files'], {
    encoding: 'utf8',
  })
    .split('\n')
    .find((f) => f && !f.startsWith('.'))!;
  fs.appendFileSync(path.join(pc.path('alpha'), tracked), '\nlocal edit\n');
  const before = branchIn('alpha');
  const started = await call(dispatcher(), 'start_agent', {
    sandbox: 'pc/alpha',
    prompt: 'x',
    title: 'Some work',
    work_id: 'w1',
    branch: 'feature/w1',
  });
  assert.equal(started.isError, false, started.text);
  await until('the dispatcher hears it failed', () => users(dispatcher().id).some((e) => e.text.includes('[start failed] w1 did not start in pc/alpha')));
  const told = users(dispatcher().id).find((e) => e.text.includes('[start failed] w1'))!.text;
  assert.match(told, /uncommitted/);
  assert.deepEqual(store.work.get('w1')!.sessionIds, []);
  assert.equal(branchIn('alpha'), before);
  assert.ok(store.work.get('w1')!.log.some((l) => /did not start after the sandbox was prepared \(w5278\)/.test(JSON.stringify(l))));
  // Nothing holds it: a start in the other sandbox goes.
  const ok = await call(dispatcher(), 'start_agent', {
    sandbox: 'pc/beta',
    prompt: 'Go.',
    title: 'Some work',
    work_id: 'w1',
  });
  assert.match(ok.text, /^Started agent /, ok.text);
});

test("w5278: the dispatcher's machine_cleanup answers at once and the pass's result comes as a [clean-up] message", async (t) => {
  const { call, users, dispatcher } = await setup(t);
  const r = await call(dispatcher(), 'machine_cleanup', {
    machine: 'pc',
    dry_run: true,
  });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^The dry-run clean-up pass on pc is running .*\[clean-up\] message/);
  await until('its result arrives', () =>
    users(dispatcher().id).some((e) => e.text.includes('[clean-up] The dry-run clean-up pass you started on pc finished:')),
  );
  const bad = await call(dispatcher(), 'machine_cleanup', {
    machine: 'nosuch',
  });
  assert.equal(bad.isError, true, bad.text);
});
