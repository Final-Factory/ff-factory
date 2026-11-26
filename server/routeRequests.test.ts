import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';
import { SessionManager, setQueryForTesting, type SessionHandle } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { Agents } from './agents.ts';
import { Identity } from './identity.ts';
import { RouteRequests } from './routeRequests.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';
import type { Config } from './config.ts';
import type { Requester, UserInfo, WorkItem } from '../shared/types.ts';

/**
 * w5914's route requests on the real ledger (server/routeRequests.ts, docs/bash-nudge.md): a worker's "no other route" files
 * one request per need, triaged low risk (goes ahead) or needing approval (waits, with options); more workers asking for the
 * same need join it; once it is done and a later portal commit runs, the waiting cards are denied with the route.
 */

setQueryForTesting(fakeQuery({ stepMs: 1 }) as never);

const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const LOTH: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };

async function until(pred: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function setup(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-route-'));
  const people: UserInfo[] = [{ ...BEN, role: 'owner' }, { ...LOTH, role: 'owner' }];
  const cfg = {
    dataDir: dir,
    sandboxRoot: dir,
    standingRoot: path.join(dir, '_agents'),
    repo: { url: path.join(dir, 'base'), basePath: path.join(dir, 'base') },
    defaultBase: 'master',
    models: ['opus', 'sonnet'],
    defaultModel: 'opus',
    protectedPaths: [],
    limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: true },
    worker: { permissionMode: 'default', effort: 'low' },
    unity: {},
    intake: {},
  } as unknown as Config;
  const store = new Store(dir);
  const sessions = new SessionManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const agents = new Agents(cfg, store, sessions, machines, new Identity(cfg, () => people));
  agents.boot();
  const o = agents.orchestrators;
  let sha = 'aaaaaaaaaaaa';
  const rr = new RouteRequests({ store, sessions, orchestrators: o, systemPayer: () => BEN, lookbackDays: () => 7, portalSha: () => sha }).start();
  t.after(async () => {
    rr.stop();
    o.close();
    agents.close(); // w6152: Agents' timers stop before the folder goes (w5915: a release pass wrote into a removed transcript, ENOENT).
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  let seq = 10;
  store.workSeq = 100;
  /** A worker on its own open request (w11, w12, ...), its shell commands asked in default mode. */
  const worker = () => {
    const s = sessions.create({ kind: 'worker', title: 'a worker', permissionMode: 'default', options: () => ({ model: 'opus' }) });
    const now = new Date().toISOString();
    const id = `w${++seq}`;
    store.putWork({ id, title: `Request ${id}`, brief: 'x', priority: 'normal', keys: [], requestedBy: LOTH, requesters: [LOTH], humanAsked: true, status: 'active', createdAt: now, updatedAt: now, sessionIds: [s.info.id], overlaps: [], asks: 0, log: [] } as WorkItem);
    return { s, work: () => store.work.get(id)! };
  };
  const routes = () => [...store.work.values()].filter((w) => w.source?.kind === 'harness-route');
  /** The worker asks the command: nudged first, then insists "no other route"; its card goes up. */
  const ask = async (s: SessionHandle, command: string) => {
    sessions.send(s.info.id, `#permcmd ${command}`);
    await until(() => s.info.pendingPermissions.some((p) => p.noRoute), `the card for ${command}`);
  };
  return { store, sessions, rr, worker, routes, ask, setSha: (x: string) => (sha = x) };
}

test('w5914 auto-filing, low risk: a route request is filed approved, its card linked in both logs', async (t) => {
  const { worker, routes, ask } = setup(t);
  const a = worker();
  await ask(a.s, 'unity-slot run --label build -- make');
  await until(() => routes().length === 1, 'the route request');
  const r = routes()[0];
  assert.equal(r.route?.key, 'bash:unity-slot run');
  assert.equal(r.route?.triage, 'go');
  assert.equal(r.approval?.state, 'approved');
  assert.equal(r.triage?.class, 'follow-up');
  assert.match(r.brief, /Command: unity-slot run --label build -- make/);
  assert.match(r.brief, /The worker's reason: the fake agent needs this exact command/);
  assert.match(r.brief, /Triage: low risk, goes ahead with no approval/);
  assert.deepEqual(r.route?.waiters.map((x) => [x.session, x.works]), [[a.s.info.id, [a.work().id]]]);
  assert.ok(a.work().log.some((l) => l.includes(`filed route request ${r.id}`) && l.includes('its approval card is linked to it')));
  assert.equal(a.s.info.pendingPermissions.length, 1, 'the card still goes to a person meanwhile');
});

test('w5914 triage, needs approval: network access waits for a reviewer with options, the recommended one first', async (t) => {
  const { worker, routes, ask } = setup(t);
  const a = worker();
  await ask(a.s, 'curl -s https://example.com/x');
  await until(() => routes().length === 1, 'the route request');
  const r = routes()[0];
  assert.equal(r.route?.triage, 'approval');
  assert.equal(r.approval?.state, 'pending');
  assert.equal(r.triage?.class, 'needs-human');
  assert.match(r.approval?.why ?? '', /network or firewall/);
  assert.match(r.brief, /waits for lothsahn's approval/);
  assert.match(r.brief, /Options:\n1\. A narrow MCP tool .*\(recommended\)\n2\. An allow rule .*\n3\. No new route/);
});

test('w5914 dedup: workers asking for the same route join one request', async (t) => {
  const { worker, routes, ask } = setup(t);
  const a = worker();
  const b = worker();
  await ask(a.s, 'curl -s https://example.com/x');
  await until(() => routes().length === 1, 'the route request');
  await ask(b.s, 'curl https://example.com/other');
  await until(() => (routes()[0].route?.waiters.length ?? 0) === 2, 'the second waiter');
  assert.equal(routes().length, 1, 'one request for the need');
  assert.ok(b.work().log.some((l) => l.includes(`linked to route request ${routes()[0].id}`)));
  // Another program is another need.
  const c = worker();
  await ask(c.s, 'taskkill /im foo.exe');
  await until(() => routes().length === 2, 'a request for another need');
});

test('w5914 deny after the route lands: done, then a later portal commit runs; the waiting cards are denied with the route', async (t) => {
  const { store, worker, routes, ask, rr, setSha } = setup(t);
  const a = worker();
  const b = worker();
  await ask(a.s, 'unity-slot run -- make');
  await until(() => routes().length === 1, 'the route request');
  await ask(b.s, 'unity-slot run -- other');
  await until(() => (routes()[0].route?.waiters.length ?? 0) === 2, 'the second waiter');
  const r = routes()[0];
  // Its worker's DONE report ends with the Route line (routeBrief asks for it); the close note keeps only the first line.
  Object.assign(r, { status: 'done', outcome: 'DONE: it', findings: [{ at: new Date().toISOString(), by: 'abc', text: 'DONE: it\nRoute: mcp__machine__unity_run with label and command\nLearned: nothing new' }] });
  store.putWork(r);
  rr.check();
  assert.equal(r.route?.doneSha, 'aaaaaaaaaaaa');
  assert.equal(a.s.info.pendingPermissions.length, 1, 'not deployed yet: the card stays');
  setSha('bbbbbbbbbbbb');
  rr.check();
  await until(() => a.s.info.pendingPermissions.length === 0 && b.s.info.pendingPermissions.length === 0, 'both cards cleared');
  assert.equal(r.route?.line, 'mcp__machine__unity_run with label and command');
  assert.equal(r.route?.waiters.length, 0);
  await until(() => a.s.info.status === 'idle', 'a idle');
  // A worker asking for it after it landed is told at once, once; asked again, a person answers.
  const c = worker();
  c.s.send('#permcmd unity-slot run -- third');
  await until(() => (r.route?.told ?? []).includes(c.s.info.id), 'told the route');
  assert.equal(routes().length, 1, 'no new request');
  await until(() => c.s.info.status === 'idle', `c idle: ${c.s.info.status} ${JSON.stringify(c.s.info.pendingPermissions.map((p) => p.reason))}`);
  await ask(c.s, 'unity-slot run -- third');
  assert.equal(c.s.info.pendingPermissions.length, 1, 'a person is asked the second time');
});

test('w5914: a route request closed without the route (declined) settles the need: no new request, a person answers', async (t) => {
  const { store, worker, routes, ask } = setup(t);
  const a = worker();
  await ask(a.s, 'curl -s https://example.com/x');
  await until(() => routes().length === 1, 'the route request');
  const r = routes()[0];
  r.status = 'rejected';
  store.putWork(r);
  const b = worker();
  await ask(b.s, 'curl https://example.com/y');
  await until(() => b.work().log.some((l) => l.includes(`route request ${r.id} for it closed rejected`)), 'the note');
  assert.equal(routes().length, 1);
});
