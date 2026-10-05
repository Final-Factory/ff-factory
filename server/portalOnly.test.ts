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
import type { HostHealthMonitor } from './hostHealth.ts';
import type { Config } from './config.ts';
import type { Requester, UserInfo } from '../shared/types.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';

/**
 * The portal-only mode (w464, docs/portal-on-ffbox-host.md section 6, change 1 and part of change 2): with config
 * hostSandboxes false this host is no place for work. Its pool leaves the capacity block, placement and list_sandboxes,
 * create_sandbox here is refused with the reason, and host_recovery takes only cleanup. The config, the host guard and
 * the standing agents' sides are in config.test.ts, hostHealth.test.ts and standing.test.ts.
 */

setQueryForTesting(fakeQuery({ stepMs: 1 }) as never);

const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const PEOPLE: UserInfo[] = [{ ...BEN, role: 'owner' }];

function setup(t: { after: (fn: () => void | Promise<void>) => void }, hostSandboxes?: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-portal-only-'));
  const cfg = {
    dataDir: dir,
    sandboxRoot: path.join(dir, 'sandboxes'),
    standingRoot: path.join(dir, '_agents'),
    repo: { url: path.join(dir, 'base'), basePath: path.join(dir, 'base') },
    defaultBase: 'origin/develop',
    models: ['opus', 'sonnet'],
    defaultModel: 'opus',
    protectedPaths: [],
    limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: false },
    worker: { permissionMode: 'bypassPermissions', effort: 'low' },
    unity: {},
    ...(hostSandboxes === undefined ? {} : { hostSandboxes }),
  } as unknown as Config;
  const store = new Store(dir);
  const sessions = new SessionManager(cfg, store);
  const sandboxes = new SandboxManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const agents = new Agents(cfg, store, sandboxes, sessions, machines, new Identity(cfg, () => PEOPLE));
  agents.boot();
  // A host guard that only says what it was asked to do.
  const asked: string[] = [];
  agents.hostHealth = {
    remountNow: async () => (asked.push('remount'), 'remounted'),
    selftest: async () => (asked.push('selftest'), 'tested'),
    cleanupNow: async () => (asked.push('cleanup'), 'cleaned'),
    compact: async () => (asked.push('compact'), { action: 'compact', ok: true, at: '', detail: 'compacted' }),
  } as unknown as HostHealthMonitor;
  t.after(async () => {
    agents.orchestrators.close();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = agents.orchestratorBelt(sessions.get(agents.dispatcherId).info).find((x) => x.name === name);
    if (!tool) throw new Error(`the dispatcher has no ${name}`);
    const r = await tool.handler(args);
    return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
  };
  return { agents, sandboxes, asked, call };
}

test('portal-only: this host leaves the capacity block and list_sandboxes, and says why', (t) => {
  const { agents } = setup(t, false);
  assert.deepEqual(
    agents.places().map((p) => p.id),
    [],
    'no "this host" (and no machine yet)',
  );
  assert.match(agents.describeAllSandboxes(), /^## this host: no sandboxes \(this portal holds no sandboxes of its own \(config hostSandboxes: false, the portal-only mode\)\); work goes to the machines below/);
});

test('without the switch, this host keeps its pool as before', (t) => {
  const { agents } = setup(t);
  assert.deepEqual(
    agents.places().map((p) => p.id),
    ['this host'],
  );
});

test('portal-only: create_sandbox here is refused with the reason and where to go instead', (t) => {
  const { sandboxes } = setup(t, false);
  assert.throws(() => sandboxes.create({ name: 'sb1' }), /^Error: this portal holds no sandboxes of its own \(config hostSandboxes: false, the portal-only mode\): create the sandbox on a machine \(create_sandbox with machine/);
});

test('portal-only: host_recovery runs cleanup and refuses the sandbox-drive and Windows helper actions', async (t) => {
  const { call, asked } = setup(t, false);
  assert.equal((await call('host_recovery', { action: 'cleanup' })).text, 'cleaned');
  for (const action of ['remount', 'trim', 'compact', 'selftest']) {
    const r = await call('host_recovery', { action });
    assert.equal(r.isError, true, action);
    assert.match(r.text, new RegExp(`^ERROR: ${action} is for a host with a sandbox drive and the Windows helper tasks; .*Only cleanup applies here\\.$`));
  }
  const reboot = await call('host_recovery', { action: 'reboot', confirm_reboot: true });
  assert.match(reboot.text, /^ERROR: reboot is for a host with a sandbox drive/);
  assert.deepEqual(asked, ['cleanup'], 'nothing but the clean-up ran');
});
