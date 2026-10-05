import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAIN_CLONE, McpScopes, mcpStatusDir, resolveUnityMcpServer, scopedUnityMcp } from '../machine/unityMcp.ts';
import { Daemon, type Probes } from '../machine/daemon.ts';
import { realPoolDeps } from '../machine/sandboxes.ts';
import { buildOptions, type LaunchSpec } from './launch.ts';
import { Store } from './store.ts';
import { SessionManager } from './sessions.ts';
import { SandboxManager } from './sandboxes.ts';
import { MachineManager } from './machines.ts';
import { Agents } from './agents.ts';
import { Identity } from './identity.ts';
import type { Config } from './config.ts';
import type { MachineSandbox, SessionInfo } from '../shared/types.ts';

// Daemons started here keep their Unity slots mailbox in a folder of their own, not the real one in the home folder.
process.env.FF_UNITY_SLOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-slots-'));

/**
 * The Unity MCP bridge for machine agents (docs/machines.md, "Unity MCP"): which server the daemon runs, each place's
 * own status folder, and the portal asking for it for main-clone and sandbox agents alike.
 */

const tmpdir = (t: { after: (fn: () => void) => void }, name: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ffsb-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
};

const UVX = { command: 'C:\\Users\\u\\.local\\bin\\uvx.exe', args: ['--offline', '--from', 'mcpforunityserver==10.0.0', 'mcp-for-unity'] };
const PRE = { command: 'C:/Users/u/.local/bin/uvx.exe', args: ['--prerelease', 'explicit', '--from', 'mcpforunityserver>=0.0.0a0', 'mcp-for-unity'] };

test("machine unity mcp: the server is daemon.json's, else the machine's own Claude Code entry (the clone's, user-wide, most used)", (t) => {
  const dir = tmpdir(t, 'mcpresolve');
  const file = path.join(dir, '.claude.json');
  const write = (j: unknown) => fs.writeFileSync(file, '\uFEFF' + JSON.stringify(j));
  const stdio = (s: typeof UVX) => ({ UnityMCP: { type: 'stdio', ...s, env: {} } });

  // LothDesktop as found (2026-09-29): three other clones registered, the main clone (D:\work\FFFRepo) not.
  write({ mcpServers: {}, projects: { 'D:/work/FinalFactory': { mcpServers: stdio(UVX) }, 'D:/work/FinalFactoryMaster': { mcpServers: stdio(UVX) }, 'D:/work/FinalFactory2': { mcpServers: stdio(PRE) }, 'D:/work/other': {} } });
  const most = resolveUnityMcpServer(undefined, 'D:\\work\\FFFRepo', file);
  assert.deepEqual(most.server, UVX, 'the one most projects use');
  assert.match(most.source, /used by 2 project/);

  // The main clone's own entry wins, whatever the slashes and case.
  write({ mcpServers: { UnityMCP: { ...UVX } }, projects: { 'd:/work/fffrepo': { mcpServers: stdio(PRE) } } });
  assert.deepEqual(resolveUnityMcpServer(undefined, 'D:\\work\\FFFRepo\\', file).server, PRE);
  // Then a user-wide one.
  write({ mcpServers: { UnityMCP: { ...PRE, env: { A: '1' } } }, projects: { 'D:/work/FinalFactory': { mcpServers: stdio(UVX) } } });
  assert.deepEqual(resolveUnityMcpServer(undefined, 'D:\\work\\FFFRepo', file).server, { ...PRE, env: { A: '1' } });
  // daemon.json's before any of them.
  assert.deepEqual(resolveUnityMcpServer({ command: 'uvx', args: ['x'] }, 'D:\\work\\FFFRepo', file).server, { command: 'uvx', args: ['x'] });

  // An http entry, none, or no file: no server (and it says why).
  write({ projects: { 'D:/work/FinalFactory': { mcpServers: { UnityMCP: { type: 'http', url: 'http://localhost:8080/mcp' } } } } });
  assert.equal(resolveUnityMcpServer(undefined, 'D:\\work\\FFFRepo', file).server, undefined);
  assert.match(resolveUnityMcpServer(undefined, 'D:\\work\\FFFRepo', path.join(dir, 'missing.json')).source, /no .*missing\.json/);

  // Scoped: the place's own status folder, the entry's env kept.
  assert.deepEqual(scopedUnityMcp({ ...UVX, env: { A: '1' } }, 'D:\\ff', 'sb1').env, { A: '1', UNITY_MCP_STATUS_DIR: path.join('D:\\ff', 'unity-mcp', 'sb1') });
});

test("machine unity mcp: each place's folder holds only its own editor's status file, and only one written since that editor started", (t) => {
  const dir = tmpdir(t, 'mcpscopes');
  const home = path.join(dir, 'home', '.unity-mcp');
  const app = path.join(dir, 'app');
  fs.mkdirSync(home, { recursive: true });
  const T = Date.now();
  const status = (hash: string, project: string, port: number, mtime: number) => {
    const f = path.join(home, `unity-mcp-status-${hash}.json`);
    fs.writeFileSync(f, JSON.stringify({ unity_port: port, project_path: `${project}/Assets` }));
    fs.utimesSync(f, mtime / 1000, mtime / 1000);
  };
  const files = (place: string) => fs.readdirSync(mcpStatusDir(app, place)).sort();
  const port = (place: string) => JSON.parse(fs.readFileSync(path.join(mcpStatusDir(app, place), 'unity-mcp-port.json'), 'utf8')).unity_port;
  const scopes = new McpScopes(home);

  // Both editors were already running when the daemon started: their status files count whatever their age.
  status('aaaa', 'D:/work/FFFRepo', 6400, T - 3_600_000);
  status('bbbb', 'D:/work/ffsb/sb1', 6401, T - 3_600_000);
  status('cccc', 'D:/work/ffsb/sb2', 6402, T - 3_600_000);
  scopes.sync(app, [
    { place: MAIN_CLONE, project: 'D:\\work\\FFFRepo', pid: 10 },
    { place: 'sb1', project: 'D:\\work\\ffsb\\sb1', pid: 11 },
    { place: 'sb2', project: 'D:\\work\\ffsb\\sb2' },
  ], T);
  assert.deepEqual(files(MAIN_CLONE), ['unity-mcp-port.json', 'unity-mcp-status-aaaa.json']);
  assert.deepEqual(files('sb1'), ['unity-mcp-port.json', 'unity-mcp-status-bbbb.json']);
  assert.equal(port('sb1'), 6401);
  assert.deepEqual(files('sb2'), ['unity-mcp-port.json'], 'a stopped editor: nothing to find');
  assert.equal(port('sb2'), 0, "and the fallback never reaches another editor's port");

  // sb1's editor crashed and a new one started (pid 12) after the last look: its crashed predecessor's file is not
  // mirrored until the new editor writes its own.
  scopes.sync(app, [{ place: MAIN_CLONE, project: 'D:\\work\\FFFRepo', pid: 10 }, { place: 'sb1', project: 'D:\\work\\ffsb\\sb1', pid: 12 }, { place: 'sb2', project: 'D:\\work\\ffsb\\sb2' }], T + 30_000);
  assert.deepEqual(files('sb1'), ['unity-mcp-port.json']);
  assert.equal(port('sb1'), 0);
  status('bbbb', 'D:/work/ffsb/sb1', 6403, T + 40_000);
  scopes.sync(app, [{ place: MAIN_CLONE, project: 'D:\\work\\FFFRepo', pid: 10 }, { place: 'sb1', project: 'D:\\work\\ffsb\\sb1', pid: 12 }, { place: 'sb2', project: 'D:\\work\\ffsb\\sb2' }], T + 45_000);
  assert.deepEqual(files('sb1'), ['unity-mcp-port.json', 'unity-mcp-status-bbbb.json']);
  assert.equal(port('sb1'), 6403);
  assert.deepEqual(files(MAIN_CLONE), ['unity-mcp-port.json', 'unity-mcp-status-aaaa.json'], 'the main clone kept its own');

  // A deleted sandbox: its folder goes too.
  scopes.sync(app, [{ place: MAIN_CLONE, project: 'D:\\work\\FFFRepo', pid: 10 }, { place: 'sb1', project: 'D:\\work\\ffsb\\sb1', pid: 12 }], T + 60_000);
  assert.equal(fs.existsSync(mcpStatusDir(app, 'sb2')), false);
});

const PROBES: Probes = {
  stats: async () => ({ hostname: 'pc', platform: 'win32', cpuModel: 'x', cpuCount: 1, loadPct: 0, memTotalBytes: 1, memFreeBytes: 1 }),
  usage: async () => ({ account: {}, reply: { rate_limits_available: false } }),
};

test('machine unity mcp: the daemon gives an agent that asks for it the bridge of its own place, and buildOptions starts it', (t) => {
  const dir = tmpdir(t, 'mcpdaemon');
  const app = path.join(dir, 'app');
  const daemon = new Daemon(
    { portalUrl: 'http://127.0.0.1:9', id: 'pc', token: 't', repoPath: path.join(dir, 'main'), appDir: app, maxEventsFile: null, unityMcpServer: UVX },
    () => {
      throw new Error('no sessions here');
    },
    PROBES,
    realPoolDeps(process.platform === 'win32' ? 'win32' : 'darwin', path.join(dir, 'main')),
  );
  t.after(() => daemon.shutdown());
  assert.equal(daemon.stdioMcpFor({ unityMcp: false, sandbox: 'sb1' }), undefined, 'not asked (an older portal): none');
  const sb = daemon.stdioMcpFor({ unityMcp: true, sandbox: 'sb1' })!;
  assert.deepEqual(sb.UnityMCP, { ...UVX, env: { UNITY_MCP_STATUS_DIR: mcpStatusDir(app, 'sb1') } });
  assert.equal(fs.existsSync(mcpStatusDir(app, 'sb1')), true, 'its folder exists before the server starts');
  const main = daemon.stdioMcpFor({ unityMcp: true })!;
  assert.equal(main.UnityMCP.env?.UNITY_MCP_STATUS_DIR, mcpStatusDir(app, MAIN_CLONE));

  const spec: LaunchSpec = { cwd: dir, settingSources: [], append: '', strictMcp: false, guard: { id: 'sb1', ownPath: dir, protectedPaths: [], gameRepos: [] }, stdioMcp: sb, mcp: { server: 'machine', tools: [{ name: 'set_label', description: 'd' }] } };
  const o = buildOptions(spec, {});
  assert.deepEqual(o.mcpServers?.UnityMCP, { type: 'stdio', ...UVX, env: { UNITY_MCP_STATUS_DIR: mcpStatusDir(app, 'sb1') } });
  assert.ok(o.mcpServers?.machine, 'beside the in-process tools');
});

test('machine unity mcp: the portal asks for it for main-clone and sandbox agents on a machine', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-mcpportal-'));
  const cfg = {
    dataDir: dir,
    sandboxRoot: dir,
    standingRoot: path.join(dir, '_agents'),
    repo: { url: path.join(dir, 'base'), basePath: path.join(dir, 'base') },
    defaultBase: 'origin/develop',
    models: ['opus'],
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
  const agents = new Agents(cfg, store, new SandboxManager(cfg, store), sessions, machines, new Identity(cfg, () => []));
  t.after(async () => {
    agents.orchestrators.close();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const sb: MachineSandbox = { id: 'sb1', branch: 'sandbox/sb1', base: 'origin/develop', path: 'D:\\work\\ffsb\\sb1', createdAt: '2026-09-29T00:00:00Z', status: 'ready', purpose: 'unused', sessionIds: [], unity: { state: 'stopped' } };
  const { machine } = machines.register({ id: 'pc', host: 'pc', purpose: 'unused', status: 'ready', repoPath: 'D:\\work\\FFFRepo', home: 'C:\\Users\\u', portalUrl: 'http://x', maxSessions: 2, platform: 'win32', sandboxes: [sb] } as never);
  const info = (over: Partial<SessionInfo>) => ({ id: 's1', kind: 'worker', title: 't', status: 'idle', permissionMode: 'default', createdAt: '', lastActivityAt: '', turns: 0, costUsd: 0, pendingPermissions: [], machineId: 'pc', ...over }) as SessionInfo;
  const main = machines.hooks!.specFor(info({}), machine);
  assert.equal(main.unityMcp, true);
  assert.equal(main.stdioMcp, undefined, "the portal never sends commands: they are the machine's");
  assert.equal(main.guard.id, 'FFFRepo', 'pinned to the main clone\'s instance');
  const inSb = machines.hooks!.specFor(info({ machineSandbox: 'sb1' }), machine);
  assert.equal(inSb.unityMcp, true);
  assert.equal(inSb.sandbox, 'sb1');
  assert.equal(inSb.guard.id, 'sb1');
});
