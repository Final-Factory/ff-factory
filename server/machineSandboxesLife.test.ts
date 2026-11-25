import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import type { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Store } from './store.ts';
import { SessionManager, midTurnRefusal, othersMidTurn, type SessionHandle, type SessionSink } from './sessions.ts';
import { Agents } from './agents.ts';
import { BlockerWatch } from './blockerWatch.ts';
import { Identity } from './identity.ts';
import { MachineManager, limitOptions, machineForPath, mergeSandboxes, parseSandboxRef, poolSettingsOf } from './machines.ts';
import { daemonConfig } from './machineDeploy.ts';
import { describeCleanupItems } from './cleanup.ts';
import { Daemon, type Probes } from '../machine/daemon.ts';
import { UnitySlots } from '../machine/unitySlots.ts';
import type { BenchTicket } from '../machine/benchQueue.ts';
import { EDITOR_TICKET_RETRY_MS, SandboxPool, type PoolOptions, deletable, idleSandboxEditors, lfsDedup, lfsDedupWords, librarySource, treeBytes, type PoolDeps, type SandboxEditor } from '../machine/sandboxes.ts';
import { DISK_CRITICAL_GB_DEFAULT, DISK_WARN_GB_DEFAULT } from '../shared/types.ts';
import { copyTree, removeTree, run } from './proc.ts';
import { readGitStatus } from './gitStatus.ts';
import { borrowsFrom, configText, finishConversion, gitPathForm, isSlotRepo, isWorktree, keptStashPrefix, worktreeRecordOf } from '../machine/slotRepo.ts';
import { testRepos } from './testMachine.ts';
import type { Config } from './config.ts';
import type { GitStatus, ImageInput, PermissionMode, SandboxPoolSettings, SessionInfo, WorkItem } from '../shared/types.ts';
import { pairRoom, warmText } from '../shared/capacity.ts';
import {
  GB,
  until,
  repos,
  deps,
  SETTINGS,
  pool,
  ready,
  clockSkew,
  fakeTicket,
  FakeAgent,
  PROBES,
  twoSandboxes,
  fillCaches,
} from './machineSandboxesTestKit.ts';

/**
 * The machine sandbox tests (docs/machines.md): folders gone or remade, settings and limits, create and run agents, switch_branch, stale output, queued editor starts.
 * One of the server/machineSandboxes*.test.ts files split out of machineSandboxes.test.ts (w5826); helpers in machineSandboxesTestKit.ts.
 */


test('machine sandboxes: the idle-editor stop and a restarted daemon', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  let last = Date.now();
  const { p, running } = pool(r, { idle: 1, activity: () => ({ busy: false, lastActivityMs: last }) });
  await p.create({ id: 'a', branch: 'sandbox/a', base: 'origin/master', seedLibrary: false, startUnity: true });
  await ready(p, 'a');
  await until('editor started', () => running.size === 1);
  await p.tick();
  assert.equal(running.size, 1, 'recent activity');
  last = Date.now() - 5 * 60_000;
  // Started just now counts as activity too; age the start.
  (p as unknown as { unityState: Map<string, { startedAt?: number }> }).unityState.get('a')!.startedAt = last;
  await p.tick();
  assert.equal(running.size, 0, 'idle for longer than idleStopMinutes');

  // A create cut off by a daemon restart reads as an error, not as forever "creating".
  const file = path.join(r.root, 'app', 'sandboxes.json');
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  rows[0].status = 'creating';
  fs.writeFileSync(file, JSON.stringify(rows));
  const after = pool(r).p;
  assert.equal(after.list()[0].status, 'error');
  assert.match(after.list()[0].statusDetail ?? '', /interrupted while creating/);
});

test("w1918: a free sandbox whose folder is gone (its drive reset) is made again on its branch; one whose sandbox root is gone (the drive not attached) is left", async (t) => {
  const r = repos();
  t.after(r.cleanup);
  const lines: string[] = [];
  const { p, events } = pool(r, { log: (l) => lines.push(l) });
  await p.create({ id: 'sb1', branch: 'sandbox/sb1', base: 'origin/master', seedLibrary: false, startUnity: false });
  await ready(p, 'sb1');
  const dir = path.join(r.sbRoot, 'sb1');
  fs.writeFileSync(path.join(dir, 'work.txt'), 'pushed');
  r.git(dir, 'add', 'work.txt');
  r.git(dir, 'commit', '-q', '-m', 'sb1 work');
  r.git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

  // The drive is not attached: no sandbox root, so nothing is made (the host guard reattaches it).
  fs.renameSync(r.sbRoot, `${r.sbRoot}-away`);
  await p.tick();
  assert.equal(p.list()[0].status, 'ready');
  assert.equal(fs.existsSync(r.sbRoot), false, 'no sandbox root made on the bare volume');
  fs.renameSync(`${r.sbRoot}-away`, r.sbRoot);

  // The drive was reset: the root is there, the sandbox folder is not (and the clone still lists it as a worktree).
  fs.rmSync(dir, { recursive: true, force: true });
  await p.tick();
  assert.equal(p.list()[0].status, 'creating');
  await ready(p, 'sb1');
  assert.equal(r.git(dir, 'branch', '--show-current'), 'sandbox/sb1');
  assert.equal(fs.readFileSync(path.join(dir, 'work.txt'), 'utf8'), 'pushed', 'its committed work, on its branch');
  assert.equal(p.list()[0].git?.branch, 'sandbox/sb1', 'git status is read again');
  assert.ok(lines.some((l) => /sandbox sb1: its folder .* is gone .*making its worktree again on sandbox\/sb1/.test(l)), lines.join('\n'));
  assert.ok(events.some((e) => /is gone/.test(e.text)));

  // Once per daemon run: gone again, it is left to a delete and a create.
  fs.rmSync(dir, { recursive: true, force: true });
  await p.tick();
  assert.equal(p.list()[0].status, 'ready');
  assert.equal(fs.existsSync(dir), false);
});

test("w1918: a sandbox folder an agent start made again (no .git, only the agent's files) is remade in place, the agent's files kept; one holding a checkout's files is left", async (t) => {
  const r = repos();
  t.after(r.cleanup);
  const lines: string[] = [];
  const { p } = pool(r, { log: (l) => lines.push(l) });
  await p.create({ id: 'sb1', branch: 'sandbox/sb1', base: 'origin/master', seedLibrary: false, startUnity: false });
  await p.create({ id: 'sb2', branch: 'sandbox/sb2', base: 'origin/master', seedLibrary: false, startUnity: false });
  await ready(p, 'sb1');
  await ready(p, 'sb2');
  const dir = path.join(r.sbRoot, 'sb1');
  const dir2 = path.join(r.sbRoot, 'sb2');
  const tracked = r.git(dir, 'ls-tree', '--name-only', 'HEAD').split('\n')[0].trim();

  // The drive was reset, then an agent started in sb1 (its folder made, with its Inbox); sb2 lost only its .git.
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'Inbox'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Inbox', 'a-save.zip'), 'save');
  fs.rmSync(path.join(dir2, '.git'), { force: true });
  await p.tick();
  await ready(p, 'sb1');
  assert.equal(r.git(dir, 'branch', '--show-current'), 'sandbox/sb1');
  assert.equal(fs.readFileSync(path.join(dir, 'Inbox', 'a-save.zip'), 'utf8'), 'save', "the agent's files stay");
  assert.ok(fs.existsSync(path.join(dir, tracked)), 'checked out');
  assert.equal(fs.existsSync(`${dir}.remake`), false, 'the folder beside it is gone');
  assert.ok(r.git(r.main, 'worktree', 'list').includes('sb1'), r.git(r.main, 'worktree', 'list'));
  assert.ok(lines.some((l) => /sandbox sb1: its folder .* has no checkout .*making its worktree again/.test(l)), lines.join('\n'));
  for (let i = 0; i < 100 && p.list().find((x) => x.id === 'sb2')!.status === 'creating'; i++) await new Promise((res) => setTimeout(res, 50));
  const sb2 = p.list().find((x) => x.id === 'sb2')!;
  assert.equal(sb2.status, 'error');
  assert.match(sb2.statusDetail ?? '', /holds a checkout's files/);
  assert.ok(fs.existsSync(path.join(dir2, tracked)), 'its files are left');
});

test('w1915: a free sandbox whose folder came back empty (a worker started in it after the drive reset) is made again in that folder', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  const { p } = pool(r);
  await p.create({ id: 'sb1', branch: 'sandbox/sb1', base: 'origin/master', seedLibrary: false, startUnity: false });
  await ready(p, 'sb1');
  const dir = path.join(r.sbRoot, 'sb1');
  r.git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

  // A folder with files in it is a sandbox: left alone.
  await p.tick();
  assert.equal(p.list()[0].status, 'ready');

  // The drive was reset and the folder made again empty (LothLaptop's slot1: the worker's own directory).
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  await p.tick();
  assert.equal(p.list()[0].status, 'creating');
  await ready(p, 'sb1');
  assert.equal(r.git(dir, 'branch', '--show-current'), 'sandbox/sb1');
});

test('w1918: a remake a daemon restart cut off (after its worktree was added, before the checkout) is made again by the next daemon, not left as an error', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  const lines: string[] = [];
  const first = pool(r, { log: (l) => lines.push(l) }).p;
  await first.create({ id: 'sb1', branch: 'sandbox/sb1', base: 'origin/master', seedLibrary: false, startUnity: false });
  await ready(first, 'sb1');
  const dir = path.join(r.sbRoot, 'sb1');
  const tracked = r.git(dir, 'ls-tree', '--name-only', 'HEAD').split('\n')[0].trim();
  r.git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

  // The drive was reset; the remake got as far as the worktree (a .git, nothing checked out) when an update restarted the
  // daemon: sandboxes.json still says creating, with the remake's mark.
  fs.rmSync(dir, { recursive: true, force: true });
  r.git(r.main, 'worktree', 'prune');
  r.git(r.main, 'worktree', 'add', '--no-checkout', dir, 'sandbox/sb1');
  assert.equal(fs.existsSync(path.join(dir, tracked)), false);
  const file = path.join(r.root, 'app', 'sandboxes.json');
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.assign(rows[0], { status: 'creating', remaking: true });
  fs.writeFileSync(file, JSON.stringify(rows));

  const { p } = pool(r, { log: (l) => lines.push(l) });
  assert.equal(p.list()[0].status, 'ready');
  await p.tick();
  assert.equal(p.list()[0].status, 'creating');
  await ready(p, 'sb1');
  assert.equal(r.git(dir, 'branch', '--show-current'), 'sandbox/sb1');
  assert.ok(fs.existsSync(path.join(dir, tracked)), 'checked out');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].remaking, undefined, 'the mark is cleared once it is ready');
  // A plain create cut off still reads as an error (the restart test above).
});

// ---------------------------------------------------------------- pure parts

test('machine sandboxes: only a direct child of the root named after it can be deleted, never the main clone', () => {
  assert.equal(deletable('D:\\work\\ffsb\\sb1', 'sb1', 'D:\\work\\ffsb', 'D:\\work\\mainrepo', 'win32'), true);
  assert.equal(deletable('d:/work/FFSB/sb1/', 'sb1', 'D:\\work\\ffsb', 'D:\\work\\mainrepo', 'win32'), true, 'case and slashes on Windows');
  assert.equal(deletable('D:\\work\\ffsb\\sb1\\Library', 'sb1', 'D:\\work\\ffsb', 'D:\\work\\mainrepo', 'win32'), false);
  assert.equal(deletable('D:\\work\\ffsb\\sb2', 'sb1', 'D:\\work\\ffsb', 'D:\\work\\mainrepo', 'win32'), false);
  assert.equal(deletable('D:\\work\\mainrepo', 'mainrepo', 'D:\\work', 'D:\\work\\mainrepo', 'win32'), false, 'the main clone itself');
  assert.equal(deletable('D:\\work\\mainrepo\\sb', 'sb', 'D:\\work\\mainrepo', 'D:\\work\\mainrepo', 'win32'), false, 'inside the main clone');
  assert.equal(deletable('/Users/b/ffsb/sb1', 'sb1', '/Users/b/ffsb', '/Users/b/FinalFactory', 'darwin'), true);
  assert.equal(deletable('/Users/b/FFSB/sb1', 'sb1', '/Users/b/ffsb', '/Users/b/FinalFactory', 'darwin'), false, 'a Mac compares exactly');
});

test('machine sandboxes: where a Library comes from, and which editors are idle', () => {
  const has = (d: string) => d !== '/main' && d !== '/sb/empty';
  assert.equal(librarySource('/x', [], () => true), path.join('/x', 'Library'), "the main clone's first");
  const sbs = [
    { path: '/sb/busy', status: 'ready' as const, editorUp: true },
    { path: '/sb/idle', status: 'ready' as const, editorUp: false },
    { path: '/sb/new', status: 'creating' as const, editorUp: false },
  ];
  assert.equal(librarySource('/main', sbs, has), path.join('/sb/idle', 'Library'), 'a sandbox whose editor is stopped');
  assert.equal(librarySource('/main', [sbs[0]], has), path.join('/sb/busy', 'Library'), 'else any ready one');
  assert.equal(librarySource('/main', [{ path: '/sb/empty', status: 'ready', editorUp: false }], has), undefined);

  const now = 10 * 3_600_000;
  const act = (id: string) => ({ busy: id === 'busy', lastActivityMs: id === 'recent' ? now - 60_000 : 0 });
  const eds = [
    { id: 'old', up: true, startedAt: 0 },
    { id: 'recent', up: true, startedAt: 0 },
    { id: 'busy', up: true, startedAt: 0 },
    { id: 'justStarted', up: true, startedAt: now - 60_000 },
    { id: 'down', up: false },
  ];
  assert.deepEqual(idleSandboxEditors(eds, act, now, 120), ['old']);
  assert.deepEqual(idleSandboxEditors(eds, act, now, 0), [], '0 turns it off');
});

test('machine sandboxes: settings, limits, references and snapshots on the portal', () => {
  assert.equal(poolSettingsOf({}), null, 'no sandbox_root, no sandboxes');
  assert.deepEqual(poolSettingsOf({ sandboxRoot: 'D:\\work\\ffsb' }), { root: 'D:\\work\\ffsb', maxSandboxes: 3, maxAgentsPerSandbox: 2, maxUnity: 2, diskWarnGB: 15, diskCriticalGB: 10 }, 'a new machine with nothing passed: the disk guard defaults to 15/10 GB (w1951)');
  assert.equal(poolSettingsOf({ sandboxRoot: '/x', diskWarnGB: 10 })!.diskCriticalGB, 10, 'critical never above warn');

  assert.deepEqual(limitOptions({ maxSandboxes: 3 }, { maxUnity: 2, maxSandboxes: 1 }), { maxSandboxes: 3, maxAgentsPerSandbox: undefined, maxUnity: 2, diskWarnGB: undefined, diskCriticalGB: undefined, maxSandboxAgents: undefined }, 'unset ones are kept');
  assert.throws(() => limitOptions({ maxSandboxes: 0 }, undefined), /maxSandboxes must be a whole number from 1 to 8/);
  assert.throws(() => limitOptions({ diskWarnGB: 10, diskCriticalGB: 20 }, undefined), /disk_critical_gb must not be above disk_warn_gb/);

  assert.deepEqual(parseSandboxRef('lothdesktop/sb1'), { machine: 'lothdesktop', sandbox: 'sb1' });
  assert.deepEqual(parseSandboxRef('LothDesktop/SB 1'), { machine: 'lothdesktop', sandbox: 'sb-1' });
  assert.equal(parseSandboxRef('spec-098'), undefined);

  const unity = { state: 'stopped' as const };
  const prev = [{ id: 'a', branch: 'x', base: 'b', path: '/a', purpose: 'belts', status: 'ready' as const, createdAt: '', unity, sessionIds: ['s1'] }];
  const next = mergeSandboxes(prev, [
    { id: 'a', branch: 'y', base: 'b', path: '/a', status: 'ready', createdAt: '', unity },
    { id: 'b', branch: 'z', base: 'b', path: '/b', status: 'creating', createdAt: '', unity },
  ]);
  // The label is the sandbox's name (w575): an old label gives way to it.
  assert.deepEqual(next.map((s) => [s.id, s.branch, s.purpose, s.sessionIds]), [
    ['a', 'y', 'a', ['s1']],
    ['b', 'z', 'b', []],
  ]);
  assert.deepEqual(mergeSandboxes(prev, []), [], 'gone on the machine, gone here');

  const m = { repoPath: 'D:\\work\\mainrepo', home: 'C:\\Users\\l', platform: 'win32' as const, sandboxRoot: 'D:\\work\\ffsb' };
  assert.equal(machineForPath('D:/work/ffsb/sb1/Assets/Screenshots/a.png', [m]), m, "a sandbox's screenshot belongs to its machine");

  const cfg = JSON.parse(daemonConfig({ portalUrl: 'https://p', id: 'x', token: 't', repoPath: '/r', sandboxes: poolSettingsOf({ sandboxRoot: '/s', maxSandboxes: 3 }) }));
  assert.deepEqual(cfg.sandboxes, { root: '/s', maxSandboxes: 3, maxAgentsPerSandbox: 2, maxUnity: 2, diskWarnGB: 15, diskCriticalGB: 10 }, 'daemon.json keeps them');
  assert.equal(JSON.parse(daemonConfig({ portalUrl: 'https://p', id: 'x', token: 't', repoPath: '/r' })).sandboxes, undefined);
});

test('machine sandboxes: create, run agents (per-sandbox limit), drive the editor and delete, from the portal through a daemon', async (t) => {
  const r = repos();
  const cfg = { dataDir: path.join(r.root, 'data'), limits: { maxSessions: 6 }, repo: { url: 'x' }, worker: { effort: 'high' }, defaultBase: 'origin/master' } as unknown as Config;
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const store = new Store(cfg.dataDir);
  const sessions = new SessionManager(cfg, store);
  const mm = new MachineManager(cfg, store, sessions);
  mm.hooks = {
    specFor: (info, m) => {
      const sb = info.machineSandbox ? mm.requireSandbox(m.id, info.machineSandbox) : undefined;
      return { cwd: sb?.path ?? r.main, sandbox: sb?.id, settingSources: [], append: '', strictMcp: true, guard: { id: sb?.id ?? 'x', ownPath: sb?.path ?? r.main, protectedPaths: [], gameRepos: [] } };
    },
    handlersFor: () => ({}),
  };
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => mm.upgrade(req, socket, head, '127.0.0.1'));
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { token } = mm.register({ id: 'pc', host: 'pc', purpose: 'unused', status: 'ready', repoPath: r.main, home: r.root, portalUrl: url, sandboxRoot: r.sbRoot, maxSandboxes: 2, maxAgentsPerSandbox: 1, maxUnity: 1 });
  const { d: poolDeps, running } = deps(r.main);
  const daemon = new Daemon({ portalUrl: url, id: 'pc', token, repoPath: r.main, appDir: path.join(r.root, 'app'), claude: 'no-such-claude', maxSessions: 1, maxEventsFile: null, sandboxCacheTrim: false }, (i, s, o, e) => new FakeAgent(i, s, o, e), PROBES, poolDeps);
  t.after(async () => {
    daemon.shutdown();
    server.close();
    // The link's close comes after the last update the daemon sent; then the saves land before the folders go.
    await until('the daemon gone', () => !mm.isOnline('pc'), 5000).catch(() => undefined);
    store.flush();
    await store.saved();
    r.cleanup();
  });
  daemon.start();
  await until('online with hello', () => mm.isOnline('pc') && !!store.machines.get('pc')?.info);

  const text = await mm.createSandbox('pc', { name: 'sb1', seedLibrary: true });
  assert.match(text, /Creating sandbox sb1 on branch sandbox\/sb1 from origin\/master/);
  await until('ready on the portal', () => store.machines.get('pc')?.sandboxes?.find((s) => s.id === 'sb1')?.status === 'ready');
  const sb = mm.requireSandbox('pc', 'sb1');
  assert.equal(sb.purpose, 'sb1', 'its label is its name (w575)');
  assert.equal(fs.existsSync(path.join(sb.path, 'Library', 'Artifacts', 'warm.bin')), true);
  await assert.rejects(mm.createSandbox('pc', { name: 'sb1' }), /already exists on pc/);

  // Agents: the sandbox has its own limit (1), apart from the main clone's.
  const a1 = mm.createSession('pc', { kind: 'worker', title: 'a1', permissionMode: 'default', sandbox: 'sb1' });
  assert.equal(a1.info.machineSandbox, 'sb1');
  assert.deepEqual(mm.requireSandbox('pc', 'sb1').sessionIds, [a1.info.id]);
  sessions.send(a1.info.id, 'hello');
  await until('a1 live', () => a1.live);
  const a2 = mm.createSession('pc', { kind: 'worker', title: 'a2', permissionMode: 'default', sandbox: 'sb1' });
  // The limit counts mid-turn agents only (w384): an idle a1 takes no slot; a1 mid-turn makes a2's message wait.
  await until('a1 idle', () => a1.info.status === 'idle');
  assert.equal(mm.placeFull(a2), undefined);
  a1.info.status = 'running';
  assert.match(mm.placeFull(a2) ?? '', /1 agents mid-turn in sandbox pc\/sb1 \(max_agents_per_sandbox 1\)/);
  assert.equal(sessions.isQueued(sessions.send(a2.info.id, 'x')), true, 'queued, not refused');
  assert.equal(sessions.queued()[0].on, 'capacity', 'a slot: Queued, capacity (w643)');
  a1.info.status = 'idle';
  sessions.drain();
  await until('a2 delivered once a1 is idle', () => a2.live && !sessions.queued().length);
  // No worker runs in a main clone (w536).
  const main = mm.createSession('pc', { kind: 'worker', title: 'main', permissionMode: 'default' });
  assert.throws(() => sessions.send(main.info.id, 'main clone work'), /pc runs workers in sandboxes only: start this one in one of its sandboxes \(pc\/sb1\)/);

  // The sandbox's editor, not the main clone's.
  assert.match(await mm.unity('pc', 'start', false, 'sb1'), /Started \(fake\)/);
  assert.deepEqual([...running], [sb.path]);
  await until('the snapshot shows it', () => mm.requireSandbox('pc', 'sb1').unity.state !== 'stopped');
  await assert.rejects(mm.switchBranch('pc', 'feature/z', undefined, 'sb1'), /is running: stop it first/);
  await mm.unity('pc', 'stop', false, 'sb1');
  // w791: a worker's clear_batch reaches the daemon's reaper (this daemon's process list is empty: it kills nothing real);
  // a daemon of protocol 8 would start the editor on an action it does not know, so the portal never sends it one.
  assert.match(await mm.unity('pc', 'clear_batch', false, 'sb1'), /No batch-mode Unity builds are running in any sandbox/);
  const hello = (mm as unknown as { hellos: Map<string, { protocol: number }> }).hellos.get('pc')!;
  const proto = hello.protocol;
  hello.protocol = 8;
  await assert.rejects(mm.unity('pc', 'clear_batch', false, 'sb1'), /speaks protocol 8 and cannot clear stuck batch builds \(needs 9\)/);
  hello.protocol = proto;
  const sw = await mm.switchBranch('pc', 'feature/z', undefined, 'sb1');
  assert.equal(sw.to, 'feature/z');
  assert.equal(r.git(r.main, 'branch', '--show-current'), 'master', 'the main clone stays where it was');

  // Delete: refused while an agent there runs; then gone on both sides.
  await assert.rejects(mm.deleteSandbox('pc', 'sb1'), /2 agent\(s\) still run in sandbox sb1/);
  a1.stop();
  a2.stop();
  await until('a1 and a2 stopped', () => !a1.live && !a2.live);
  assert.match(await mm.deleteSandbox('pc', 'sb1'), /Deleted sandbox sb1/);
  assert.deepEqual(store.machines.get('pc')!.sandboxes, []);
  assert.equal(fs.existsSync(sb.path), false);
});

// ---------------------------------------------------------------- switch_branch's mid-turn check (w422)

test('switch_branch busy check: never the caller; others mid-turn by title; a mid-turn status with no process is stale', () => {
  const h = (id: string, status: SessionInfo['status'], live: boolean) => ({ info: { id, title: `t-${id}`, status } as SessionInfo, live });
  const me = h('me', 'running', true);
  assert.deepEqual(othersMidTurn([me], 'me'), { busy: [], stale: [] }, 'the caller alone');
  const other = h('o', 'waiting_permission', true);
  const starting = h('st', 'starting', false);
  const gone = h('g', 'running', false);
  const r = othersMidTurn([me, other, starting, gone, h('i', 'idle', true), h('s', 'stopped', false), undefined], 'me');
  assert.deepEqual(r.busy, [other, starting], "another agent's turn, and one starting before its process is reported");
  assert.deepEqual(r.stale, [gone]);
  assert.deepEqual(othersMidTurn([me]).busy, [me], 'no caller (the orchestrator): every agent mid-turn counts');
  assert.equal(midTurnRefusal([other], 'sb1'), 'agent(s) "t-o" is mid-turn in sb1; wait for them (or stop them) first');
  assert.match(midTurnRefusal([other, starting], 'pc/sb1'), /^agent\(s\) "t-o", "t-st" are mid-turn in pc\/sb1;/);
});

test('switch_branch on a machine sandbox: the calling worker alone switches, through the portal and the daemon; others block by name; stale ones are cleared (w422)', async (t) => {
  const r = repos();
  const cfg = {
    dataDir: path.join(r.root, 'data'),
    sandboxRoot: path.join(r.root, 'host-sb'),
    standingRoot: path.join(r.root, '_agents'),
    repo: { url: 'x', basePath: path.join(r.root, 'base') },
    defaultBase: 'origin/master',
    models: ['opus'],
    defaultModel: 'opus',
    protectedPaths: [],
    limits: { maxSessions: 6, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: false },
    worker: { permissionMode: 'default', effort: 'low' },
    unity: {},
  } as unknown as Config;
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const store = new Store(cfg.dataDir);
  const sessions = new SessionManager(cfg, store);
  const mm = new MachineManager(cfg, store, sessions);
  const agents = new Agents(cfg, store, sessions, mm, new Identity(cfg, () => []));
  // Stand-in launch specs (no Claude here); the switch is the real Agents.switchBranch.
  mm.hooks = {
    specFor: (info, m) => {
      const sb = info.machineSandbox ? mm.requireSandbox(m.id, info.machineSandbox) : undefined;
      return { cwd: sb?.path ?? r.main, sandbox: sb?.id, settingSources: [], append: '', strictMcp: true, guard: { id: sb?.id ?? 'x', ownPath: sb?.path ?? r.main, protectedPaths: [], gameRepos: [] } };
    },
    handlersFor: () => ({}),
  };
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => mm.upgrade(req, socket, head, '127.0.0.1'));
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { token } = mm.register({ id: 'pc', host: 'pc', purpose: 'unused', status: 'ready', repoPath: r.main, home: r.root, portalUrl: url, sandboxRoot: r.sbRoot, maxSandboxes: 2, maxAgentsPerSandbox: 3, maxUnity: 1 });
  const { d: poolDeps } = deps(r.main);
  const daemon = new Daemon({ portalUrl: url, id: 'pc', token, repoPath: r.main, appDir: path.join(r.root, 'app'), claude: 'no-such-claude', maxSessions: 3, maxEventsFile: null, sandboxCacheTrim: false }, (i, s, o, e) => new FakeAgent(i, s, o, e), PROBES, poolDeps);
  t.after(async () => {
    agents.orchestrators.close();
    clearInterval(agents.placeAgainTick);
    daemon.shutdown();
    server.close();
    // The link's close comes after the last update the daemon sent; then the saves land before the folders go.
    await until('the daemon gone', () => !mm.isOnline('pc'), 5000).catch(() => undefined);
    store.flush();
    await store.saved();
    r.cleanup();
  });
  daemon.start();
  await until('online with hello', () => mm.isOnline('pc') && !!store.machines.get('pc')?.info);
  await mm.createSandbox('pc', { name: 'sb1' });
  await until('sb1 ready', () => store.machines.get('pc')?.sandboxes?.find((s) => s.id === 'sb1')?.status === 'ready');

  const worker = (title: string) => {
    const s = mm.createSession('pc', { kind: 'worker', title, permissionMode: 'default', sandbox: 'sb1' });
    sessions.send(s.info.id, 'go');
    return s;
  };
  const a1 = worker('pr-fix-a2');
  const a2 = worker('other worker');
  await until('both live and idle', () => a1.live && a2.live && a1.info.status === 'idle' && a2.info.status === 'idle');
  // What the daemon itself runs: its own check reads these, not the portal's copies.
  const onDaemon = (id: string) => (daemon as unknown as { entries: Map<string, { s: SessionHandle }> }).entries.get(id)!.s.info;
  const midTurn = (s: { info: SessionInfo }, status: SessionInfo['status']) => {
    s.info.status = status;
    onDaemon(s.info.id).status = status;
  };

  // The worker calls switch_branch in its own turn, alone in its sandbox (w421: refused with "1 agent(s) are mid-turn").
  midTurn(a1, 'running');
  assert.match(await agents.switchBranch({ sandbox: 'pc/sb1', branch: 'feature/z', callerSessionId: a1.info.id }), /^pc\/sb1: sandbox\/sb1 → feature\/z/);
  // Creating a branch is the same call, with create_from.
  assert.match(await agents.switchBranch({ sandbox: 'pc/sb1', branch: 'feature/new', createFrom: 'origin/master', callerSessionId: a1.info.id }), /→ feature\/new/);

  // Another agent there that only waits (w426): its turn over, a wake_me pending and a background task still running.
  // Idle is not mid-turn, on the portal or on the daemon, so it does not hold the switch up, the orchestrator's included.
  agents.waker.schedule(a2.info.id, 30, 'check the build');
  assert.ok(agents.waker.pending(a2.info.id));
  for (const info of [a2.info, onDaemon(a2.info.id)]) Object.assign(info, { status: 'idle', backgroundTasks: 1, statusDetail: '1 background task(s)' });
  assert.match(await agents.switchBranch({ sandbox: 'pc/sb1', branch: 'feature/waits', callerSessionId: a1.info.id }), /→ feature\/waits/);
  midTurn(a1, 'idle');
  assert.match(await agents.switchBranch({ sandbox: 'pc/sb1', branch: 'feature/new' }), /→ feature\/new/);
  midTurn(a1, 'running');
  agents.waker.cancel(a2.info.id);

  // Another agent mid-turn there blocks it, by its title: on the portal...
  midTurn(a2, 'running');
  await assert.rejects(agents.switchBranch({ sandbox: 'pc/sb1', branch: 'feature/w', callerSessionId: a1.info.id }), /agent\(s\) "other worker" is mid-turn in pc\/sb1/);
  // ...and on the daemon, when the portal has not heard of that turn yet.
  a2.info.status = 'idle';
  await assert.rejects(agents.switchBranch({ sandbox: 'pc/sb1', branch: 'feature/w', callerSessionId: a1.info.id }), /agent\(s\) "other worker" is mid-turn in sandbox sb1/);
  // The orchestrator (no caller) is held up by both.
  a2.info.status = 'running';
  await assert.rejects(agents.switchBranch({ sandbox: 'pc/sb1', branch: 'feature/w' }), /"pr-fix-a2", "other worker" are mid-turn/);

  // w4608: an agent there on an agent seat (its open work is all not the game's, w1098: it works in its own clone) holds no
  // switch up, on the portal or on the daemon: w4591's timed leg waited 30 min in lothdesktop/slot2 behind w4397's FFU agent.
  const seated = store.sessions.get(a2.info.id)!;
  const oldTitle = seated.title;
  seated.title = 'w9001: FFU route window design';
  const ffu = { id: 'w9001', title: 'FFU route window design', status: 'active', needs: 'agent', requesters: [], log: [], sessionIds: [], prs: [], related: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as unknown as WorkItem;
  store.putWork(ffu);
  assert.match(await agents.switchBranch({ sandbox: 'pc/sb1', branch: 'feature/seat', callerSessionId: a1.info.id }), /→ feature\/seat/);
  // Game work there still holds it up, by its title.
  store.putWork({ ...ffu, needs: 'game' });
  await assert.rejects(agents.switchBranch({ sandbox: 'pc/sb1', branch: 'feature/w', callerSessionId: a1.info.id }), /is mid-turn in pc\/sb1/);
  // Put back for what follows.
  store.putWork({ ...ffu, status: 'done' });
  seated.title = oldTitle;

  // A stopped agent left "running" on the portal (no process behind it) does not block, and is cleared.
  a2.stop();
  await until('a2 stopped', () => !a2.live && a2.info.status === 'stopped');
  a2.info.status = 'running';
  assert.match(await agents.switchBranch({ sandbox: 'pc/sb1', branch: 'feature/w', callerSessionId: a1.info.id }), /→ feature\/w/);
  assert.equal(a2.info.status, 'stopped');
  assert.equal(r.git(mm.requireSandbox('pc', 'sb1').path, 'branch', '--show-current'), 'feature/w');
  midTurn(a1, 'idle');
  a1.stop();
  await until('a1 stopped', () => !a1.live);
});

// ---------------------------------------------------------------- stale build output through the daemon (w459)

test('stale output on a machine: the portal sends the ledger facts, a dry run comes back in full and removes nothing, and the pass is logged on the portal', async (t) => {
  const r = repos();
  const cfg = { dataDir: path.join(r.root, 'data'), limits: { maxSessions: 6 }, repo: { url: 'x' }, worker: { effort: 'high' }, defaultBase: 'origin/master' } as unknown as Config;
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const store = new Store(cfg.dataDir);
  const sessions = new SessionManager(cfg, store);
  const mm = new MachineManager(cfg, store, sessions);
  mm.hooks = { specFor: () => ({ cwd: r.main, settingSources: [], append: '', strictMcp: true, guard: { id: 'x', ownPath: r.main, protectedPaths: [], gameRepos: [] } }), handlersFor: () => ({}) };
  // No pass of its own during the test (everyMinutes 0, softFreeGB 0), and no nightly lab of this computer's.
  mm.cleanupFor = () => ({ everyMinutes: 0, softFreeGB: 0, staleOutput: { nightlyRoots: [] } });
  mm.cleanupContext = () => ({ at: new Date().toISOString(), open: ['w393'], closed: ['w95'] });
  const logged: { machine: string; entry: Record<string, unknown> }[] = [];
  mm.cleanupLog = (machine, entry) => logged.push({ machine, entry });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => mm.upgrade(req, socket, head, '127.0.0.1'));
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { token } = mm.register({ id: 'pc', host: 'pc', purpose: 'unused', status: 'ready', repoPath: r.main, home: r.root, portalUrl: url, sandboxRoot: r.sbRoot, maxSandboxes: 2, maxAgentsPerSandbox: 1, maxUnity: 1 });
  const { d: poolDeps } = deps(r.main);
  const daemon = new Daemon({ portalUrl: url, id: 'pc', token, repoPath: r.main, appDir: path.join(r.root, 'app'), claude: 'no-such-claude', maxSessions: 1, maxEventsFile: null, sandboxCacheTrim: false }, (i, s, o, e) => new FakeAgent(i, s, o, e), PROBES, poolDeps);
  t.after(async () => {
    daemon.shutdown();
    server.close();
    // The link's close comes after the last update the daemon sent; then the saves land before the folders go.
    await until('the daemon gone', () => !mm.isOnline('pc'), 5000).catch(() => undefined);
    store.flush();
    await store.saved();
    r.cleanup();
  });
  daemon.start();
  await until('online with hello', () => mm.isOnline('pc') && !!store.machines.get('pc')?.info);
  await mm.createSandbox('pc', { name: 'sb1' });
  await until('sb1 ready', () => store.machines.get('pc')?.sandboxes?.find((s) => s.id === 'sb1')?.status === 'ready');
  const sb = mm.requireSandbox('pc', 'sb1').path;
  const old = (Date.now() - 5 * 86_400_000) / 1000;
  const make = (rel: string) => {
    const p = path.join(sb, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x'.repeat(1000));
    for (let q = p; q !== sb; q = path.dirname(q)) fs.utimesSync(q, old, old);
    return path.join(sb, rel.split('/').slice(0, 2).join('/'));
  };
  const closed = make('Builds/w95/player/finalfactory.exe');
  const open = make('Builds/w393-facing/player.exe');
  const perf = make('Builds/perf/log.txt');

  const dry = await mm.cleanupNow('pc', { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.removed, 0);
  const planned = dry.planned!.find((p) => path.resolve(p.path) === path.resolve(closed));
  assert.ok(planned, `w95's build is planned: ${JSON.stringify(dry.planned?.map((p) => p.path))}`);
  assert.match(planned.why, /closed in the ledger/);
  assert.ok(planned.bytes >= 1000);
  assert.ok(!dry.planned!.some((p) => path.resolve(p.path) === path.resolve(open)), "an open request's build is kept");
  assert.match(dry.listed!.find((l) => path.resolve(l.path) === path.resolve(perf))!.why, /not attributable/);
  assert.ok(fs.existsSync(closed), 'a dry run removes nothing');
  assert.match(describeCleanupItems(dry), /dry run.*\nWould remove \(biggest first\):\n- .*w95/s);
  assert.equal(store.machines.get('pc')!.lastCleanup, undefined, "a dry run is not the machine's last clean-up");
  await until('the pass logged on the portal', () => logged.some((l) => l.entry.dryRun === true));
  assert.equal(logged[0].machine, 'pc');
  assert.ok((logged.find((l) => l.entry.dryRun)!.entry.plannedAll as unknown[]).length >= 1);
  await assert.rejects(mm.cleanupNow('nosuch'), /no machine|unknown|not found/i);
});

test('machine sandboxes: an editor start takes a Unity slot: batch builds started outside the gate count, a restart keeps its slot (w469)', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-msb-slots-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const HUB = 'C:\\Program Files\\Unity\\Hub\\Editor\\6000.3.19f1\\Editor\\Unity.exe';
  const build = (pid: number, project: string) => ({ pid, ppid: 77, name: 'Unity.exe', cmd: `"${HUB}" -batchmode -quit -projectPath ${project} -executeMethod BuildScript.Build` });
  let procs = [build(501, 'D:\\work\\ffsb\\pr-fix'), build(502, 'D:\\work\\ffsb\\ui-fix')];
  let slots: UnitySlots | undefined;
  const { p } = pool(r, { settings: { maxUnity: 2 }, slots: () => slots! });
  slots = new UnitySlots({ dir, platform: 'win32', procs: async () => procs, alive: () => true, now: () => Date.now(), limit: () => 2, places: () => p.list().map((s) => ({ holder: `sandbox:${s.id}`, path: s.path, editorUp: p.editorUp(s.id) })), ramPct: () => undefined });
  for (const id of ['a', 'b']) await p.create({ id, branch: `sandbox/${id}`, base: 'origin/master', seedLibrary: false, startUnity: false });
  await ready(p, 'a');
  await ready(p, 'b');
  // Two command-line builds hold both slots (LothDesktop on 2026-10-05: its limit counted only the interactive editor).
  await assert.rejects(p.unity('a', 'start'), /^Error: not started: needs 1, 0 free \(2 of 2 in use\); held by batch pid 501 outside the gate, batch pid 502 outside the gate; editors 2 of 2: 0 interactive, 2 batch\. Try again once one ends/);
  procs = [build(501, 'D:\\work\\ffsb\\pr-fix')];
  assert.match(await p.unity('a', 'start'), /Started \(fake\)/);
  await assert.rejects(p.unity('b', 'start'), /not started: needs 1, 0 free \(2 of 2 in use\)/, "a's editor holds its slot while it starts");
  // The second build comes back meanwhile: a restart of a's editor is not queued behind it.
  procs = [build(501, 'D:\\work\\ffsb\\pr-fix'), build(502, 'D:\\work\\ffsb\\ui-fix')];
  assert.match(await p.unity('a', 'restart'), /Stopped \(fake\)\. Started \(fake\)/);
  assert.match(await p.unity('a', 'status'), /\nUnity on this machine: editors 3 of 2: 0 interactive, 2 batch, 1 editor start queued or booting; OVER LIMIT: nothing more starts until it drops/);
});

test('w4775: editor starts at the same moment take the free Unity slots one at a time: with one free, one starts and the rest are refused (lothdesktop, 2026-11-19 11:50Z: three starts with two free, "Unity editors 4 of 3")', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-msb-slots-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const HUB = 'C:\\Program Files\\Unity\\Hub\\Editor\\6000.3.19f1\\Editor\\Unity.exe';
  const procs = [{ pid: 501, ppid: 77, name: 'Unity.exe', cmd: `"${HUB}" -batchmode -quit -projectPath D:\\work\\ffsb\\pr-fix -executeMethod BuildScript.Build` }];
  let slots: UnitySlots | undefined;
  const { p } = pool(r, { settings: { maxUnity: 2, maxSandboxes: 3 }, slots: () => slots! });
  slots = new UnitySlots({ dir, platform: 'win32', procs: async () => procs, alive: () => true, now: () => Date.now(), limit: () => 2, places: () => p.list().map((s) => ({ holder: `sandbox:${s.id}`, path: s.path, editorUp: p.editorUp(s.id) })), ramPct: () => undefined });
  for (const id of ['a', 'b', 'c']) await p.create({ id, branch: `sandbox/${id}`, base: 'origin/master', seedLibrary: false, startUnity: false });
  for (const id of ['a', 'b', 'c']) await ready(p, id);
  const out = await Promise.allSettled(['a', 'b', 'c'].map((id) => p.unity(id, 'start')));
  assert.equal(out.filter((x) => x.status === 'fulfilled').length, 1, JSON.stringify(out.map((x) => (x.status === 'fulfilled' ? x.value : String(x.reason)))));
  for (const x of out.filter((y) => y.status === 'rejected')) assert.match(String((x as PromiseRejectedResult).reason), /not started: needs 1, 0 free \(2 of 2 in use\)/);
  assert.equal(['a', 'b', 'c'].filter((id) => p.editorUp(id)).length, 1, 'only the one that started holds a slot');
  // A refused start leaves no slot behind: the next one, after the build ends, starts.
  procs.length = 0;
  const next = ['a', 'b', 'c'].find((id) => !p.editorUp(id))!;
  assert.match(await p.unity(next, 'start'), /Started \(fake\)/);
});

test('w1962: queued editor starts that fill the Unity slots each start at their turn, never refused for the slot they hold (LothDesktop, 2026-10-23: "needs 1, 0 free (3 of 3 in use) ... 3 granted not started yet")', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-msb-slots-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tickets: ReturnType<typeof fakeTicket>[] = [];
  let slots: UnitySlots | undefined;
  const { p, events, running } = pool(r, { settings: { maxUnity: 2, maxSandboxes: 3 }, slots: () => slots!, bootTicket: () => {
    const k = fakeTicket();
    tickets.push(k);
    return { ticket: k as unknown as BenchTicket };
  } });
  t.after(() => tickets.forEach((k) => k.release()));
  slots = new UnitySlots({ dir, platform: 'win32', procs: async () => [], alive: () => true, now: () => Date.now(), limit: () => 2, places: () => p.list().map((s) => ({ holder: `sandbox:${s.id}`, path: s.path, editorUp: p.editorUp(s.id) })), ramPct: () => undefined });
  for (const id of ['a', 'b', 'c']) await p.create({ id, branch: `sandbox/${id}`, base: 'origin/master', seedLibrary: false, startUnity: false });
  for (const id of ['a', 'b', 'c']) await ready(p, id);
  // A timed run holds the bench lock: both starts queue, each holding the slot it took first (w1615's order).
  assert.match(await p.unity('a', 'start'), /^Queued/);
  assert.match(await p.unity('b', 'start'), /^Queued/);
  await assert.rejects(p.unity('c', 'start'), /not started: needs 1, 0 free \(2 of 2 in use\); held by sandbox:a \(no request, low\), sandbox:b \(no request, low\); editors 2 of 2: 0 interactive, 0 batch, 2 editor starts queued or booting\./, 'the slots read as queued starts, not grants');
  // The timed run ends: the shared turn grants both tickets, and both editors start.
  tickets[0].kind = 'granted';
  tickets[1].kind = 'granted';
  await until('both started at their turn', () => ['a', 'b'].every((id) => events.some((e) => new RegExp(`sandbox ${id}: its queued editor start ran at its turn`).test(e.text))));
  assert.equal(running.size, 2);
  assert.ok(!events.some((e) => /was not made at its turn/.test(e.text)), events.map((e) => e.text).join('\n'));
  assert.deepEqual(tickets.slice(0, 2).map((k) => k.released), [0, 0]);
});
