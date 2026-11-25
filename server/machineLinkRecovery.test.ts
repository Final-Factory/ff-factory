import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { Store } from './store.ts';
import { SessionManager, setQueryForTesting } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { Agents } from './agents.ts';
import { Identity } from './identity.ts';
import { checkMachineLink, isMachineLinkPath, machineLinkMode, resetMachineLinkWarnings } from './machineLinkGate.ts';
import { clientAddress } from './clientAddress.ts';
import { setAppConfig } from './appConfig.ts';
import type { Config } from './config.ts';
import type { Requester, SessionInfo, UserInfo } from '../shared/types.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';
import { useFakeVault } from './testVault.ts';

/**
 * w5575 review (w5707): a daemon that machineLinkTailnet "enforce" refuses is named and alerted, and the dispatcher lets it
 * back in with no person at any machine: set_app_config machineLinkTailnet "warn" for an open request an owner asked for.
 * The upgrade handler mirrors server/index.ts's: the same check on the live config, linkRefused, then machines.upgrade.
 */

useFakeVault();
setQueryForTesting(fakeQuery({ stepMs: 1 }) as never);

const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const LOTH: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };
const PEOPLE: UserInfo[] = [
  { ...BEN, role: 'owner' },
  { ...LOTH, role: 'member' },
];

async function until(what: string, cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Dial /machine as a daemon behind Tailscale Serve would, from `from` (X-Forwarded-For): the status it got, or 101. */
function dial(url: string, token: string, from: string): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${url.replace('http', 'ws')}/machine`, { headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': from } });
    ws.on('open', () => {
      ws.close();
      resolve(101);
    });
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on('error', () => resolve(0));
  });
}

type ToolResult = { content: { text: string }[]; isError?: boolean };

test('machineLinkTailnet enforce: a refused daemon is named and alerted, and the dispatcher lets it back in for an owner', async (t) => {
  resetMachineLinkWarnings();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-linkrecovery-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ port: 8790 }, null, 2));
  const before = process.env.FFSB_CONFIG;
  process.env.FFSB_CONFIG = file;
  const cfg = {
    dataDir: dir,
    sandboxRoot: dir,
    standingRoot: path.join(dir, '_agents'),
    repo: { url: 'https://github.com/Final-Factory/FinalFactory.git', basePath: path.join(dir, 'base') },
    defaultBase: 'origin/master',
    models: ['opus', 'sonnet'],
    defaultModel: 'opus',
    protectedPaths: [],
    limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: false },
    worker: { permissionMode: 'bypassPermissions', effort: 'low' },
    unity: {},
  } as unknown as Config;
  const store = new Store(dir);
  const sessions = new SessionManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const agents = new Agents(cfg, store, sessions, machines, new Identity(cfg, () => PEOPLE));
  agents.boot();
  const o = agents.orchestrators;
  const alerts: { id: string; title: string; text: string }[] = [];
  machines.linkRefusedAlert = (id, title, text) => alerts.push({ id, title, text });
  const logs: string[] = [];
  const { token } = machines.register({ id: 'laptop', name: 'LothLaptop', host: 'laptop', purpose: 'unused', status: 'ready', platform: 'win32' } as never);

  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    const p = new URL(req.url ?? '/', 'http://x').pathname;
    const v = isMachineLinkPath(p) ? checkMachineLink(req, machineLinkMode(cfg.machineLinkTailnet), 'link /machine', (l) => logs.push(l)) : undefined;
    if (v?.refuse) {
      machines.linkRefused(req, v.address, v.why ?? '');
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    machines.upgrade(req, socket, head, clientAddress(req));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    if (before === undefined) delete process.env.FFSB_CONFIG;
    else process.env.FFSB_CONFIG = before;
    server.close();
    o.close();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  // Unset is enforce: the machine, seen from a LAN address through the proxy, is refused, named and alerted once an hour.
  assert.equal(await dial(url, token, '10.1.0.154'), 403);
  assert.equal(await dial(url, token, '10.1.0.154'), 403);
  assert.ok(logs.some((l) => /refused link \/machine from 10\.1\.0\.154/.test(l)), logs.join('\n'));
  assert.equal(alerts.length, 1, 'one alert an hour per machine');
  assert.equal(alerts[0].id, 'laptop');
  assert.match(alerts[0].title, /LothLaptop: daemon link refused \(machineLinkTailnet\)/);
  assert.match(alerts[0].text, /locked out, not offline/);
  assert.match(alerts[0].text, /set_app_config machineLinkTailnet "warn"/);
  // A tailnet source still gets in under enforce.
  assert.equal(await dial(url, token, '100.74.97.12'), 101);
  // A wrong token from outside is refused and names no machine.
  assert.equal(await dial(url, 'not-a-token', '10.1.0.154'), 403);
  assert.equal(alerts.length, 1);

  // The dispatcher, in a turn the harness started: refused with no request, and for a member's request.
  const d = sessions.get(agents.dispatcherId)!.info;
  sessions.send(d.id, '[work request] (test) nothing', 'system');
  await until('the dispatcher answers', () => d.status === 'idle');
  const call = async (info: SessionInfo, name: string, args: Record<string, unknown>) => {
    const tool = agents.orchestratorBelt(info).find((x) => x.name === name) as unknown as { handler: (a: Record<string, unknown>) => Promise<ToolResult> } | undefined;
    if (!tool) throw new Error(`no ${name}`);
    const r = await tool.handler(args);
    return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
  };
  const file_ = async (who: Requester, title: string) => {
    const p = o.personalFor(who);
    p.lastFrom = 'human';
    const r = await call(p.info, 'request_work', { title, brief: `${who.displayName} says: ${title}` });
    assert.equal(r.isError, false, r.text);
    return [...store.work.values()].find((w) => w.title === title)!.id;
  };
  const none = await call(d, 'set_app_config', { key: 'machineLinkTailnet', value: 'warn', user_asked: true });
  assert.equal(none.isError, true, none.text);
  const lw = await file_(LOTH, 'Let LothLaptop back in');
  const member = await call(d, 'set_app_config', { key: 'machineLinkTailnet', value: 'warn', user_asked: true, work_id: lw });
  assert.equal(member.isError, true, member.text);
  assert.match(member.text, /machineLinkTailnet is an owner's setting/);
  assert.equal(await dial(url, token, '10.1.0.154'), 403, 'still refused');

  // An owner's request: set, written, live, and the next dial from outside gets in.
  const bw = await file_(BEN, 'The daemon link accepts only tailnet connections');
  const ok = await call(d, 'set_app_config', { key: 'machineLinkTailnet', value: 'warn', user_asked: true, work_id: bw });
  assert.equal(ok.isError, false, ok.text);
  assert.equal(cfg.machineLinkTailnet, 'warn');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).machineLinkTailnet, 'warn');
  assert.equal(await dial(url, token, '10.1.0.154'), 101);
  assert.ok(logs.some((l) => /WOULD REFUSE link \/machine from 10\.1\.0\.154/.test(l)), 'warn still logs it');
});

test('trustProxy false is refused while machineLinkTailnet is enforce, and enforce while trustProxy is false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-trustproxy-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{}');
  try {
    const cfg = {} as Config;
    assert.throws(() => setAppConfig(file, cfg, 'trustProxy', false), /would refuse every daemon/);
    setAppConfig(file, cfg, 'machineLinkTailnet', 'enforce');
    assert.throws(() => setAppConfig(file, cfg, 'trustProxy', false), /would refuse every daemon/);
    setAppConfig(file, cfg, 'machineLinkTailnet', 'warn');
    setAppConfig(file, cfg, 'trustProxy', false);
    assert.equal(cfg.trustProxy, false);
    assert.throws(() => setAppConfig(file, cfg, 'machineLinkTailnet', 'enforce'), /would refuse every daemon/);
    assert.equal(cfg.machineLinkTailnet, 'warn');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
