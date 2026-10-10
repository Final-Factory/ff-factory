import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { SandboxPool, type PoolOptions, deletable, idleSandboxEditors, librarySource, treeBytes, type PoolDeps, type SandboxEditor } from '../machine/sandboxes.ts';
import { DISK_CRITICAL_GB_DEFAULT, DISK_WARN_GB_DEFAULT } from '../shared/types.ts';
import { copyTree, removeTree, run } from './proc.ts';
import { readGitStatus } from './gitStatus.ts';
import { testRepos } from './testMachine.ts';
import type { Config } from './config.ts';
import type { ImageInput, PermissionMode, SandboxPoolSettings, SessionInfo, WorkItem } from '../shared/types.ts';

// Daemons started here keep their Unity slots mailbox in a folder of their own, not the real one in the home folder.
process.env.FF_UNITY_SLOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-slots-'));

const GB = 1024 ** 3;

test('w890: the whole loop: a worker that ends its turn waiting on a deploy frees its sandbox within a minute, new work takes it, the deploy lands, the block clears and the worker resumes and is placed again, on its branch, in the other sandbox', async (t) => {
  const { r, store, sessions, mm, agents, sbOf, path1, path2, gitNow, onDaemon } = await twoSandboxes(t);

  // A worker on feature/w1 has its PR merged and its work pushed; its request is Blocked on the portal deploy, which only a
  // person starts (it declared the wait itself, blocked_on deploys ["portal"]). It ends its turn: Idle, no check-in.
  const w = mm.createSession('pc', { kind: 'worker', title: 'w1 work', permissionMode: 'default', sandbox: 'sb1' });
  sessions.send(w.info.id, 'go');
  await until('w live and idle', () => w.live && w.info.status === 'idle');
  fs.writeFileSync(path.join(path1, 'work.txt'), 'w1');
  r.git(path1, 'add', 'work.txt');
  r.git(path1, 'commit', '-q', '-m', 'w1 work');
  r.git(path1, 'push', '-q', '-u', 'origin', 'HEAD');
  // No requesters: the notices to a person's orchestrator would start a real agent session in this harness.
  const by = { userId: 'lothsahn', displayName: 'Lothsahn' };
  const item: WorkItem = { id: 'w1', title: 'Fix the CI read', brief: 'Do it.', priority: 'normal', keys: [], requestedBy: by, requesters: [], humanAsked: true, status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), sessionIds: [w.info.id], overlaps: [], asks: 0, log: [] };
  store.putWork(item);
  store.workSeq = Math.max(store.workSeq, 1);
  let portal = 'aaa1111';
  const o = agents.orchestrators;
  (o as unknown as { d: { deploySha?: (id?: string) => string | undefined } }).d.deploySha = () => portal;
  assert.match(o.workerBlocked(w.info.id, { deploys: ['portal'], what: 'the portal deploy of 65b1d27' }), /^Recorded: w1 is Blocked on a portal deploy\./);
  assert.equal(item.blocked?.sha, 'aaa1111');
  await gitNow('sb1');

  // The first pass stops it (it holds nothing to do), the next, which the server runs 5 s later, frees the sandbox. (The
  // timer is the server's: here the test asks for the pass itself, and checks that the first one asked for it.)
  let soon = 0;
  (agents.placeAgain as unknown as { d: { soon?: () => void } }).d.soon = () => void soon++;
  assert.match(agents.placeAgain.tick().join('\n'), /stopped .*\(it waits on w1: a portal deploy\)/);
  assert.equal(soon, 1, 'the next pass is asked for at once, not left a minute away');
  await until('w stopped', () => !w.live && w.info.status === 'stopped');
  await gitNow('sb1');
  assert.match(agents.placeAgain.tick().join('\n'), /released pc\/sb1 of .* \(it waits on w1: a portal deploy\)/);
  assert.equal(w.info.placeReleased?.branch, 'feature/w1');
  assert.match(agents.describeAllSandboxes(), /pc\/sb1 FREE/);

  // New work takes the sandbox (feature/w1 is left first, nothing lost).
  const prep = await agents.prepareForNewWork('pc/sb1', undefined, 'W999');
  assert.equal(prep.branch, 'sandbox/sb1-w999');
  const n = agents.startWorker({ sandbox: 'pc/sb1', prompt: 'new work', from: 'orchestrator' });
  await until('n live', () => n.live);
  await gitNow('sb1');

  // The deploy lands: a different commit runs. The blocker watch clears the gate and resumes the worker.
  const watch = new BlockerWatch({ store, orchestrators: o, portalSha: () => portal });
  assert.equal((await watch.tick()).has('w1'), false, 'the same commit still runs: it waits');
  assert.equal(item.status, 'blocked');
  portal = 'bbb2222';
  assert.match((await watch.tick()).get('w1')!, /^clear: the portal runs bbb2222 now \(aaa1111 when it was blocked\)$/);
  assert.equal(item.status, 'active');
  const wake = agents.waker.pending(w.info.id)!;
  assert.ok(wake && Date.parse(wake.at) - Date.now() <= 61_000, 'its check-in is within a minute');
  assert.match(wake.note, /The deploy you waited for has happened: do the check that comes after it now/);

  // The check-in fires (what the waker does when its time comes): the worker is placed again in sb2, on its branch.
  agents.waker.cancel(w.info.id);
  sessions.send(w.info.id, `[wake_me] Time is up. Your note: ${wake.note}`, 'system');
  await until('w resumed in sb2', () => w.live && w.info.machineSandbox === 'sb2', 30_000);
  assert.equal(r.git(path2, 'branch', '--show-current'), 'feature/w1');
  assert.equal(r.git(path2, 'log', '-1', '--format=%s'), 'w1 work');
  assert.equal(onDaemon(w.info.id)?.spec?.cwd, path2, 'its process runs in sb2');
  assert.equal(w.info.placeReleased, undefined);
  const said = store.readTranscript(w.info.id).filter((e) => e.kind === 'user').map((e) => (e as { text: string }).text).at(-1) ?? '';
  assert.match(said, /^\[moved\] While you were stopped your sandbox pc\/sb1 went to other work/);
  assert.ok(said.includes('do the check that comes after it now'), said);
  assert.ok(!sbOf('sb1')!.sessionIds.includes(w.info.id));
  n.stop();
  w.stop();
  await until('both stopped', () => !n.live && !w.live);
});

const until = async (what: string, cond: () => boolean, ms = 60_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** A bare origin and the machine's main clone of it (on develop), with a warm Library the clone never commits. */
const repos = () => testRepos();

/** Real git, copy and delete; a stand-in editor (no Unity), and free space the test sets. */
function deps(repoPath: string, o: { free?: () => number | undefined; copyBytes?: number } = {}) {
  const running = new Set<string>();
  const d: PoolDeps = {
    git: (args, opts = {}) => run('git', ['-C', repoPath, ...args], { timeoutMs: opts.timeoutMs ?? 120_000, signal: opts.signal, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }),
    copyTree: (src, dst, signal) => copyTree(src, dst, { signal }),
    ...(o.copyBytes !== undefined ? { libraryCopyBytes: async () => o.copyBytes } : {}),
    removeTree,
    freeBytes: async () => (o.free ? o.free() : 500 * GB),
    procs: async () => [],
    editor: (sb, logFile): SandboxEditor => ({
      unity: {
        logFile,
        start: async () => {
          running.add(sb.path);
          return 'Started (fake).';
        },
        stop: async () => {
          running.delete(sb.path);
          return 'Stopped (fake).';
        },
        status: async () => (running.has(sb.path) ? 'running: pid 4242' : 'not running'),
        editors: () => (running.has(sb.path) ? [{ pid: 4242, ppid: 1, cmd: `Unity -projectPath ${sb.path}` }] : []),
      },
    }),
    bridgeUp: (p) => running.has(p),
    gitStatus: readGitStatus,
    now: () => Date.now(),
  };
  return { d, running };
}

const SETTINGS = (root: string, over: Partial<SandboxPoolSettings> = {}): SandboxPoolSettings => ({ root, maxSandboxes: 2, maxAgentsPerSandbox: 2, maxUnity: 1, diskWarnGB: 50, diskCriticalGB: 20, ...over });

function pool(r: ReturnType<typeof repos>, o: { free?: () => number | undefined; copyBytes?: number; settings?: Partial<SandboxPoolSettings>; activity?: (id: string) => { busy: boolean; lastActivityMs: number }; idle?: number; slots?: () => UnitySlots; liveAgents?: (id: string) => number; trim?: PoolOptions['trim']; trimmer?: PoolOptions['trimmer'] } = {}) {
  const events: { text: string; checkpoint?: boolean }[] = [];
  /** The status of each sandbox at every change the portal would be sent, consecutive repeats dropped (w898: the cleanup state's order). */
  const statuses: string[] = [];
  const { d, running } = deps(r.main, o);
  const created: { p?: SandboxPool } = {};
  const p = new SandboxPool(
    {
      repoPath: r.main,
      stateFile: path.join(r.root, 'app', 'sandboxes.json'),
      settings: SETTINGS(r.sbRoot, o.settings),
      activity: o.activity ?? (() => ({ busy: false, lastActivityMs: Date.now() })),
      onChange: () => {
        const s = created.p?.list().map((x) => `${x.id}:${x.status}`).join(',') ?? '';
        if (s && statuses.at(-1) !== s) statuses.push(s);
      },
      onEvent: (e) => events.push(e),
      idleStopMinutes: o.idle,
      ...(o.liveAgents ? { liveAgents: o.liveAgents } : {}),
      ...(o.trim !== undefined ? { trim: o.trim } : {}),
      ...(o.trimmer ? { trimmer: o.trimmer } : {}),
      librarySeedGB: 1,
      ...(o.slots ? { editorSlot: (id: string) => o.slots!().startRefusal(`sandbox:${id}`), slotsStatus: async () => (await o.slots!().tick(), o.slots!().describe()) } : {}),
    },
    d,
  );
  created.p = p;
  return { p, events, running, statuses };
}

const ready = (p: SandboxPool, id: string) => until(`${id} ready`, () => {
  const s = p.list().find((x) => x.id === id);
  if (s?.status === 'error') throw new Error(`${id} failed: ${s.statusDetail}`);
  return s?.status === 'ready';
});

// ---------------------------------------------------------------- the pool, against real git (CI runs this on Windows too)

test('machine sandboxes: a worktree of the main clone on its own branch, a warm Library, removed cleanly', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  const { p } = pool(r);
  const created = await p.create({ id: 'sb1', branch: 'sandbox/sb1', base: 'origin/develop', seedLibrary: true, startUnity: false });
  assert.equal(created.status, 'creating');
  assert.equal(created.path, path.join(r.sbRoot, 'sb1'));
  await ready(p, 'sb1');
  const dir = path.join(r.sbRoot, 'sb1');
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8').replace(/\r\n/g, '\n'), 'game\n', 'checked out');
  assert.equal(fs.readFileSync(path.join(dir, 'Library', 'Artifacts', 'warm.bin'), 'utf8'), 'imported', "the main clone's Library, copied");
  // The copied Library's stale script mappings: the first editor start reimports the scripts, via a script git ignores.
  const script = path.join(dir, 'Assets', '__FFFactoryReimport', 'Editor', 'ScriptReimportAfterLibraryCopy.cs');
  assert.match(fs.readFileSync(script, 'utf8'), /ImportAsset\(p, ImportAssetOptions\.ForceUpdate\)[\s\S]*DeleteAsset\(Folder\)/);
  fs.writeFileSync(path.join(dir, 'Assets', '__FFFactoryReimport.meta'), 'guid: x');
  assert.equal(r.git(dir, 'status', '--porcelain'), '', 'excluded from git, with the .meta Unity makes');
  assert.equal(r.git(r.main, 'status', '--porcelain'), '', 'the main clone is clean too');
  assert.equal(r.git(dir, 'branch', '--show-current'), 'sandbox/sb1');
  assert.match(r.git(r.main, 'worktree', 'list'), /ffsb[\\/]sb1/);
  assert.equal(r.git(r.main, 'branch', '--show-current'), 'develop', "the main clone's own checkout is untouched");
  assert.equal(p.list()[0].git?.branch, 'sandbox/sb1');

  // Persisted: a new daemon finds it.
  const again = pool(r).p;
  assert.deepEqual(again.list().map((s) => [s.id, s.status]), [['sb1', 'ready']]);

  const text = await p.remove('sb1');
  assert.match(text, /Deleted sandbox sb1/);
  assert.equal(fs.existsSync(dir), false, 'the folder is gone');
  assert.doesNotMatch(r.git(r.main, 'worktree', 'list'), /sb1/);
  assert.match(r.git(r.main, 'branch', '--list', 'sandbox/sb1'), /sandbox\/sb1/, 'the branch is kept by default');
  assert.deepEqual(p.list(), []);
});

test('machine sandboxes: a second one seeds its Library from a sandbox when the main clone has none; limits and bad names are refused', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  const { p } = pool(r);
  await p.create({ id: 'sb1', branch: 'sandbox/sb1', base: 'origin/develop', seedLibrary: true, startUnity: false });
  await ready(p, 'sb1');
  fs.rmSync(path.join(r.main, 'Library'), { recursive: true, force: true });
  await p.create({ id: 'sb2', branch: 'feature/x', base: 'origin/develop', seedLibrary: true, startUnity: false });
  await ready(p, 'sb2');
  assert.equal(fs.readFileSync(path.join(r.sbRoot, 'sb2', 'Library', 'Artifacts', 'warm.bin'), 'utf8'), 'imported', "sb1's Library");
  assert.ok(fs.existsSync(path.join(r.sbRoot, 'sb2', 'Assets', '__FFFactoryReimport')), 'armed after any Library copy');
  const exclude = fs.readFileSync(path.join(r.main, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(exclude.split('\n').filter((l) => l === '/Assets/__FFFactoryReimport*').length, 1, 'the exclude line once');

  await assert.rejects(p.create({ id: 'sb3', branch: 'sandbox/sb3', base: 'origin/develop', seedLibrary: false, startUnity: false }), /already 2 sandboxes on this machine \(max_sandboxes 2\)/);
  await p.remove('sb2', true);
  assert.equal(r.git(r.main, 'branch', '--list', 'feature/x'), '', 'deleteBranch removes the branch');
  await assert.rejects(p.create({ id: 'sb1', branch: 'sandbox/other', base: 'origin/develop', seedLibrary: false, startUnity: false }), /already exists/);
  await assert.rejects(p.create({ id: 'sb3', branch: 'develop', base: 'origin/develop', seedLibrary: false, startUnity: false }), /never master, main or develop/);
  await assert.rejects(p.create({ id: 'sb3', branch: 'bad..name', base: 'origin/develop', seedLibrary: false, startUnity: false }), /not a valid branch name/);
  await assert.rejects(p.create({ id: 'finalfactory', branch: 'sandbox/ff', base: 'origin/develop', seedLibrary: false, startUnity: false }), /main clone's folder name/);
  await assert.rejects(p.create({ id: 'Bad Name', branch: 'sandbox/x', base: 'origin/develop', seedLibrary: false, startUnity: false }), /not a usable sandbox name/);
});

test('machine sandboxes: editors are limited by max_unity; a switch waits for the editor to stop; the disk guard', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  let free: number | undefined = 500 * GB;
  let busy = true;
  const { p, events, running } = pool(r, { free: () => free, settings: { maxUnity: 1 }, activity: () => ({ busy, lastActivityMs: Date.now() }) });
  for (const id of ['a', 'b']) await p.create({ id, branch: `sandbox/${id}`, base: 'origin/develop', seedLibrary: false, startUnity: false });
  await ready(p, 'a');
  await ready(p, 'b');
  await p.unity('a', 'start');
  assert.equal(p.list().find((s) => s.id === 'a')!.unity.state, 'starting');
  assert.match(p.list().find((s) => s.id === 'a')!.unity.logPath ?? '', /sandbox-editor\.log$/, 'its own log, not the shared Editor.log');
  await assert.rejects(p.unity('b', 'start'), /already 1 sandbox editors running on this machine \(a; max_unity 1\)/);
  await p.tick();
  assert.equal(p.list().find((s) => s.id === 'a')!.unity.state, 'running', 'up once its bridge is');
  await assert.rejects(p.switch('a', 'feature/y'), /editor of sandbox a is running: stop it first/);
  await p.unity('a', 'stop');
  assert.equal(running.size, 0);
  const res = await p.switch('a', 'feature/y');
  assert.equal(res.to, 'feature/y');
  assert.equal(p.list().find((s) => s.id === 'a')!.branch, 'feature/y');

  // Low disk: no new sandboxes or editors; critical: idle editors stop, busy agents are asked to checkpoint.
  free = 30 * GB;
  await p.tick();
  assert.equal(p.diskState().level, 'warn');
  await assert.rejects(p.unity('b', 'start'), /disk space is warn/);
  await assert.rejects(p.create({ id: 'c', branch: 'sandbox/c', base: 'origin/develop', seedLibrary: false, startUnity: false }), /disk space is warn|already 2 sandboxes/);
  free = 52 * GB;
  await p.tick();
  assert.equal(p.diskState().level, 'warn', 'hysteresis: 5 GB above the threshold before it clears');
  free = 200 * GB;
  await p.tick();
  assert.equal(p.diskState().level, 'ok');
  await p.unity('b', 'start');
  free = 10 * GB;
  await p.tick();
  assert.equal(p.diskState().level, 'critical');
  assert.equal(running.size, 1, 'an editor with a busy agent keeps running');
  assert.ok(events.some((e) => e.checkpoint), 'the portal is asked to tell busy agents to checkpoint');
  busy = false;
  await p.tick();
  assert.equal(running.size, 0, 'an idle one is stopped');
});

test('machine sandboxes: the default disk guard (w628) starts an editor at 25 GB free; a full Library copy needs the Library', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  let free: number | undefined = 25 * GB;
  const defaults = { diskWarnGB: DISK_WARN_GB_DEFAULT, diskCriticalGB: DISK_CRITICAL_GB_DEFAULT };
  const { p } = pool(r, { free: () => free, settings: defaults });
  await p.create({ id: 'a', branch: 'sandbox/a', base: 'origin/develop', seedLibrary: false, startUnity: false });
  await ready(p, 'a');
  // The m3 of 2026-10-07: about 25 GB free, which the old 50 GB guard refused.
  await p.tick();
  assert.equal(p.diskState().level, 'ok');
  assert.match(await p.unity('a', 'start'), /Started/);
  free = 19 * GB;
  await p.tick();
  assert.equal(p.diskState().level, 'warn', 'below 20 GB no new editors');
  free = 9 * GB;
  await p.tick();
  assert.equal(p.diskState().level, 'critical', 'below 10 GB idle editors stop');
  free = 24 * GB;
  await p.tick();
  assert.equal(p.diskState().level, 'warn', 'hysteresis: not ok again until 25 GB');
  free = 25 * GB;
  await p.tick();
  assert.equal(p.diskState().level, 'ok');

  // A full copy (robocopy onto NTFS) of a 100 GB Library at 110 GB free: refused, where the flat 30 GB allowance passed.
  const full = pool(r, { free: () => 110 * GB, copyBytes: 100 * GB, settings: defaults }).p;
  await full.create({ id: 'b', branch: 'sandbox/b', base: 'origin/develop', seedLibrary: true, startUnity: false });
  await until('b refused', () => full.list().find((x) => x.id === 'b')?.status === 'error');
  assert.match(full.list().find((x) => x.id === 'b')!.statusDetail ?? '', /not enough disk for the Library copy \(~100 GB\): 110 GB free .* need 120 GB/);
  await full.remove('b').catch(() => undefined);
  // A block clone reports no size: the allowance stands.
  const cloned = pool(r, { free: () => 110 * GB, settings: defaults }).p;
  await cloned.create({ id: 'c', branch: 'sandbox/c', base: 'origin/develop', seedLibrary: true, startUnity: false });
  await ready(cloned, 'c');
});

test('machine sandboxes: treeBytes sums the files under a folder', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-tree-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'one.bin'), Buffer.alloc(1000));
  fs.writeFileSync(path.join(dir, 'a', 'b', 'two.bin'), Buffer.alloc(2345));
  assert.equal(await treeBytes(dir), 3345);
  assert.equal(await treeBytes(path.join(dir, 'missing')), undefined);
});

test('machine sandboxes: the idle-editor stop and a restarted daemon', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  let last = Date.now();
  const { p, running } = pool(r, { idle: 1, activity: () => ({ busy: false, lastActivityMs: last }) });
  await p.create({ id: 'a', branch: 'sandbox/a', base: 'origin/develop', seedLibrary: false, startUnity: true });
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
  assert.deepEqual(poolSettingsOf({ sandboxRoot: 'D:\\work\\ffsb' }), { root: 'D:\\work\\ffsb', maxSandboxes: 3, maxAgentsPerSandbox: 2, maxUnity: 2, diskWarnGB: 20, diskCriticalGB: 10 }, 'the disk guard defaults to 20/10 GB (w628)');
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
  assert.deepEqual(cfg.sandboxes, { root: '/s', maxSandboxes: 3, maxAgentsPerSandbox: 2, maxUnity: 2, diskWarnGB: 20, diskCriticalGB: 10 }, 'daemon.json keeps them');
  assert.equal(JSON.parse(daemonConfig({ portalUrl: 'https://p', id: 'x', token: 't', repoPath: '/r' })).sandboxes, undefined);
});

// ---------------------------------------------------------------- portal <-> daemon, end to end

class FakeAgent implements SessionHandle {
  info: SessionInfo;
  live = false;
  lastFrom: 'human' | 'orchestrator' | 'system' = 'human';
  private readonly sink: SessionSink;
  private readonly events: EventEmitter;
  constructor(info: SessionInfo, sink: SessionSink, _o: unknown, events: EventEmitter) {
    this.info = info;
    this.sink = sink;
    this.events = events;
  }
  send(text: string, from: 'human' | 'orchestrator' | 'system' = 'human', uuid = 'u', _images: ImageInput[] = []) {
    this.live = true;
    this.sink.append(this.info.id, { kind: 'user', text, from, uuid });
    this.info.status = 'idle';
    this.sink.putSession(this.info);
    this.events.emit('turnEnd', this, `echo ${text}`);
    return uuid;
  }
  async interrupt() {}
  async setMode(m: PermissionMode) {
    this.info.permissionMode = m;
  }
  stop() {
    if (!this.live) return;
    this.live = false;
    this.info.status = 'stopped';
    this.sink.putSession(this.info);
    this.events.emit('ended', this);
  }
  decide() {
    return false;
  }
}

const PROBES: Probes = {
  stats: async () => ({ hostname: 'pc', platform: 'win32', cpuModel: 'x', cpuCount: 1, loadPct: 0, memTotalBytes: GB, memFreeBytes: GB }),
  usage: async () => ({ account: {}, reply: { rate_limits_available: false } }),
};

test('machine sandboxes: create, run agents (per-sandbox limit), drive the editor and delete, from the portal through a daemon', async (t) => {
  const r = repos();
  const cfg = { dataDir: path.join(r.root, 'data'), limits: { maxSessions: 6 }, repo: { url: 'x' }, worker: { effort: 'high' }, defaultBase: 'origin/develop' } as unknown as Config;
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
  assert.match(text, /Creating sandbox sb1 on branch sandbox\/sb1 from origin\/develop/);
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
  assert.equal(r.git(r.main, 'branch', '--show-current'), 'develop', 'the main clone stays where it was');

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
    defaultBase: 'origin/develop',
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
  assert.match(await agents.switchBranch({ sandbox: 'pc/sb1', branch: 'feature/new', createFrom: 'origin/develop', callerSessionId: a1.info.id }), /→ feature\/new/);

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
  const cfg = { dataDir: path.join(r.root, 'data'), limits: { maxSessions: 6 }, repo: { url: 'x' }, worker: { effort: 'high' }, defaultBase: 'origin/develop' } as unknown as Config;
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
  for (const id of ['a', 'b']) await p.create({ id, branch: `sandbox/${id}`, base: 'origin/develop', seedLibrary: false, startUnity: false });
  await ready(p, 'a');
  await ready(p, 'b');
  // Two command-line builds hold both slots (LothDesktop on 2026-10-05: its limit counted only the interactive editor).
  await assert.rejects(p.unity('a', 'start'), /^Error: not started: needs 1, 0 free \(2 of 2 in use\); editors 2 of 2: 0 interactive, 2 batch\. Try again once one ends/);
  procs = [build(501, 'D:\\work\\ffsb\\pr-fix')];
  assert.match(await p.unity('a', 'start'), /Started \(fake\)/);
  await assert.rejects(p.unity('b', 'start'), /not started: needs 1, 0 free \(2 of 2 in use\)/, "a's editor holds its slot while it starts");
  // The second build comes back meanwhile: a restart of a's editor is not queued behind it.
  procs = [build(501, 'D:\\work\\ffsb\\pr-fix'), build(502, 'D:\\work\\ffsb\\ui-fix')];
  assert.match(await p.unity('a', 'restart'), /Stopped \(fake\)\. Started \(fake\)/);
  assert.match(await p.unity('a', 'status'), /\nUnity on this machine: editors 3 of 2: 0 interactive, 2 batch, 1 granted not started yet; OVER LIMIT: nothing more starts until it drops/);
});

/** A portal with a machine `pc` (a real daemon and git) holding two ready sandboxes, sb1 on feature/w1 and sb2 (w640, w890). */
async function twoSandboxes(t: { after: (fn: () => void | Promise<void>) => void }) {
  const r = repos();
  const cfg = {
    dataDir: path.join(r.root, 'data'),
    sandboxRoot: path.join(r.root, 'host-sb'),
    standingRoot: path.join(r.root, '_agents'),
    repo: { url: 'x', basePath: path.join(r.root, 'base') },
    defaultBase: 'origin/develop',
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
  mm.hooks = {
    specFor: (info, m) => {
      const sb = mm.requireSandbox(m.id, info.machineSandbox!);
      return { cwd: sb.path, sandbox: sb.id, settingSources: [], append: '', strictMcp: true, guard: { id: sb.id, ownPath: sb.path, protectedPaths: [], gameRepos: [] } };
    },
    handlersFor: () => ({}),
  };
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => mm.upgrade(req, socket, head, '127.0.0.1'));
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { token } = mm.register({ id: 'pc', host: 'pc', purpose: 'unused', status: 'ready', repoPath: r.main, home: r.root, portalUrl: url, sandboxRoot: r.sbRoot, maxSandboxes: 2, maxAgentsPerSandbox: 2, maxUnity: 1 });
  const { d: poolDeps } = deps(r.main);
  const daemon = new Daemon({ portalUrl: url, id: 'pc', token, repoPath: r.main, appDir: path.join(r.root, 'app'), claude: 'no-such-claude', maxSessions: 4, maxEventsFile: null, sandboxCacheTrim: false }, (i, s, o, e) => new FakeAgent(i, s, o, e), PROBES, poolDeps);
  t.after(async () => {
    agents.orchestrators.close();
    daemon.shutdown();
    server.close();
    await new Promise((res) => setTimeout(res, 300));
    store.flush();
    r.cleanup();
  });
  daemon.start();
  await until('online with hello', () => mm.isOnline('pc') && !!store.machines.get('pc')?.info);
  await mm.createSandbox('pc', { name: 'sb1', branch: 'feature/w1' });
  await mm.createSandbox('pc', { name: 'sb2' });
  const sbOf = (id: string) => store.machines.get('pc')?.sandboxes?.find((s) => s.id === id);
  await until('both ready', () => sbOf('sb1')?.status === 'ready' && sbOf('sb2')?.status === 'ready');
  const path1 = sbOf('sb1')!.path;
  const path2 = sbOf('sb2')!.path;
  // The portal's copy of a sandbox's git state, read now (the daemon reads it every 2 minutes).
  const gitNow = async (id: string) => {
    sbOf(id)!.git = await readGitStatus(sbOf(id)!.path);
  };
  const onDaemon = (id: string) => (daemon as unknown as { entries: Map<string, { spec?: { cwd: string } }> }).entries.get(id);
  return { r, store, sessions, mm, agents, sbOf, path1, path2, gitNow, onDaemon };
}

// ---------------------------------------------------------------- far check-ins release their sandbox (w640)

test('w640: a worker stopped with a far check-in frees its sandbox; new work there starts on a fresh branch; the worker resumes in another sandbox on its branch, nothing lost', async (t) => {
  const { r, store, sessions, mm, agents, sbOf, path1, path2, gitNow, onDaemon } = await twoSandboxes(t);

  // A worker on feature/w1 commits work no remote has, then sets a check-in two hours out and ends its turn.
  const w = mm.createSession('pc', { kind: 'worker', title: 'w1 work', permissionMode: 'default', sandbox: 'sb1' });
  sessions.send(w.info.id, 'go');
  await until('w live and idle', () => w.live && w.info.status === 'idle');
  fs.writeFileSync(path.join(path1, 'work.txt'), 'w1');
  r.git(path1, 'add', 'work.txt');
  r.git(path1, 'commit', '-q', '-m', 'w1 work');
  assert.match(agents.waker.schedule(w.info.id, 120, 'check CI'), /I will message you/);
  assert.ok(w.info.wakeAt, 'its check-in is on the session');
  await gitNow('sb1');

  // Waiting with only a far check-in: stopped first, then its clean sandbox is released.
  assert.match(agents.placeAgain.tick().join('\n'), /stopped .*its check-in is 2.0 h away/);
  await until('w stopped', () => !w.live && w.info.status === 'stopped');
  await gitNow('sb1');
  assert.match(agents.placeAgain.tick().join('\n'), /released pc\/sb1/);
  assert.deepEqual({ sandbox: w.info.placeReleased?.sandbox, branch: w.info.placeReleased?.branch }, { sandbox: 'sb1', branch: 'feature/w1' });
  assert.match(agents.describeAllSandboxes(), /pc\/sb1 FREE/);
  assert.match(agents.describeAllSandboxes(), /its sandbox is released/);

  // New work there: the sandbox leaves w's branch first (its commit pushed on the way), so nothing lands on it.
  const prep = await agents.prepareForNewWork('pc/sb1', undefined, 'W999');
  assert.equal(prep.branch, 'sandbox/sb1-w999');
  assert.match(prep.note, /pushed 1 unpushed commit\(s\) of feature\/w1 first/);
  assert.equal(r.git(r.origin, 'log', '-1', '--format=%s', 'feature/w1'), 'w1 work', 'its work is on origin');
  const n = agents.startWorker({ sandbox: 'pc/sb1', prompt: 'new work', from: 'orchestrator' });
  await until('n live', () => n.live);
  await gitNow('sb1');
  assert.equal(sbOf('sb1')!.git?.branch, 'sandbox/sb1-w999');
  // Nothing more to release, and new work is not given a sandbox a waiting resume has spoken for.
  assert.deepEqual(agents.placeAgain.tick(), []);

  // Its check-in comes: placed in sb2, switched to its branch, and its message says where it is now.
  sessions.send(w.info.id, '[wake_me] Time is up. Your note: check CI', 'system');
  await until('w resumed in sb2', () => w.live && w.info.machineSandbox === 'sb2', 30_000);
  assert.equal(r.git(path2, 'branch', '--show-current'), 'feature/w1');
  assert.equal(r.git(path2, 'log', '-1', '--format=%s'), 'w1 work');
  assert.equal(onDaemon(w.info.id)?.spec?.cwd, path2, 'its process runs in sb2');
  const said = store.readTranscript(w.info.id).filter((e) => e.kind === 'user').map((e) => (e as { text: string }).text).at(-1) ?? '';
  assert.match(said, /^\[moved\] While you were stopped your sandbox pc\/sb1 went to other work/);
  assert.ok(said.includes(path2) && said.endsWith('[wake_me] Time is up. Your note: check CI'), said);
  assert.equal(w.info.placeReleased, undefined);
  assert.equal(w.info.movedFrom, undefined, 'said once');
  assert.deepEqual(sbOf('sb2')!.sessionIds, [w.info.id]);
  assert.ok(!sbOf('sb1')!.sessionIds.includes(w.info.id));
  n.stop();
  w.stop();
  await until('both stopped', () => !n.live && !w.live);
});

// ---------------------------------------------------------------- release trims the Library caches (w898)

/** Library/BuildCache and Library/BurstCache files in a sandbox: some days old, some fresh. */
function fillCaches(dir: string) {
  const make = (rel: string, hours: number) => {
    const f = path.join(dir, 'Library', rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'x'.repeat(2000));
    const at = new Date(Date.now() - hours * 3_600_000);
    fs.utimesSync(f, at, at);
  };
  make('BuildCache/ab/old', 24 * 9);
  make('BuildCache/ab/new', 2);
  make('BurstCache/Windows-Intel/old.dll', 24 * 9);
  make('BurstCache/Windows-Intel/new.dll', 2);
  make('ArtifactDB/keep', 24 * 9);
  return { gone: ['BuildCache/ab/old', 'BurstCache/Windows-Intel/old.dll'], kept: ['BuildCache/ab/new', 'BurstCache/Windows-Intel/new.dll', 'ArtifactDB/keep'] };
}

test("w898: the last agent leaving a sandbox sends it to 'cleanup', trims the caches, then frees it; a start in between is refused", async (t) => {
  const r = repos();
  t.after(r.cleanup);
  let live = 1;
  const { p, statuses } = pool(r, { liveAgents: () => live });
  await p.create({ id: 'sb1', branch: 'sandbox/sb1', base: 'origin/develop', seedLibrary: false, startUnity: false });
  await ready(p, 'sb1');
  const dir = path.join(r.sbRoot, 'sb1');
  const files = fillCaches(dir);
  const exists = (rel: string) => fs.existsSync(path.join(dir, 'Library', rel));
  await p.tick();
  assert.equal(p.list()[0].status, 'ready', 'an agent lives there: nothing happens');
  assert.ok(files.gone.every(exists));
  live = 0; // the request closed, the worker stopped, or it waits for CI: its session is gone
  await p.tick();
  assert.equal(p.list()[0].status, 'cleanup', 'released: cleanup at once, before anyone can be handed the sandbox');
  assert.match(p.list()[0].statusDetail ?? '', /trimming/);
  await assert.rejects(p.unity('sb1', 'start'), /cleanup.*not ready/, 'an editor start in between is refused');
  await assert.rejects(p.switch('sb1', 'other'), /is cleanup/, 'so is a branch switch (the hand-over)');
  await until('the trim to end', () => p.list()[0].status === 'ready');
  assert.deepEqual(statuses.filter((s) => s.startsWith('sb1:')), ['sb1:creating', 'sb1:ready', 'sb1:cleanup', 'sb1:ready'], 'ready, cleanup, ready: in that order and once');
  assert.ok(files.gone.every((f) => !exists(f)) && files.kept.every(exists), 'old cache files gone, recent ones and the rest of Library kept');
  await p.tick();
  assert.equal(p.list()[0].status, 'ready', 'it does not trim again until the next release');
  assert.equal((await p.trim('sb1')).files, 0);
});

test('w898: no trim while an agent is live, an editor is up, or a build has the project open; a release with the editor up trims when it stops', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  let live = 1;
  const { p, running } = pool(r, { liveAgents: () => live });
  await p.create({ id: 'sb1', branch: 'sandbox/sb1', base: 'origin/develop', seedLibrary: false, startUnity: false });
  await ready(p, 'sb1');
  const dir = path.join(r.sbRoot, 'sb1');
  const files = fillCaches(dir);
  const gone = () => files.gone.every((f) => !fs.existsSync(path.join(dir, 'Library', f)));
  assert.match((await p.trim('sb1')).skipped ?? '', /agent is live/);
  live = 0;
  await p.unity('sb1', 'start');
  await p.tick();
  assert.match((await p.trim('sb1')).skipped ?? '', /editor is up/);
  assert.equal(p.list()[0].status, 'ready', 'the editor holds the caches: no cleanup state either');
  assert.ok(!gone());
  // The last agent left while the editor was up: the trim waits for the editor, then runs.
  live = 1;
  await p.tick();
  live = 0;
  await p.tick();
  assert.ok(!gone());
  running.delete(dir);
  await p.tick();
  await until('the trim after the editor stopped', () => gone());
  await until('free again', () => p.list()[0].status === 'ready');
  // A batchmode build (a lock file, no pool editor).
  const again = fillCaches(dir);
  fs.mkdirSync(path.join(dir, 'Temp'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Temp', 'UnityLockfile'), '');
  assert.match((await p.trim('sb1')).skipped ?? '', /editor or build has the project open/);
  assert.ok(again.gone.every((f) => fs.existsSync(path.join(dir, 'Library', f))));
});

test('w898: a trim that hangs, fails or ignores its abort times out and the sandbox goes back to free, with the reason told', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  let mode: 'hang' | 'fail' | 'slow-abort' = 'hang';
  let aborted = false;
  const trimmer: PoolOptions['trimmer'] = (_project, _policy, o) =>
    mode === 'hang'
      ? new Promise(() => undefined)
      : mode === 'fail'
        ? Promise.reject(new Error('EBUSY: file locked'))
        : new Promise((resolve) => o?.signal?.addEventListener('abort', () => ((aborted = true), resolve({ stopped: 'timed out', files: 1, removedBytes: 5, keptBytes: 0 }))));
  const { p, events, statuses } = pool(r, { liveAgents: () => 0, trim: { timeoutMs: 80 }, trimmer });
  await p.create({ id: 'sb1', branch: 'sandbox/sb1', base: 'origin/develop', seedLibrary: false, startUnity: false });
  await ready(p, 'sb1');
  const t0 = Date.now();
  const hung = p.trim('sb1', 'test');
  assert.equal(p.list()[0].status, 'cleanup');
  const res = await hung;
  assert.match(res.stopped ?? '', /timed out after/);
  assert.ok(Date.now() - t0 >= 70 && Date.now() - t0 < 5000, 'given up after the timeout, not stuck');
  assert.equal(p.list()[0].status, 'ready', 'a hung trim must not leave the sandbox in cleanup');
  assert.match(events.at(-1)?.text ?? '', /sandbox sb1: Library cache trim \(test\).*stopped early \(timed out after .*handed back as it is/);
  mode = 'fail';
  assert.match((await p.trim('sb1')).stopped ?? '', /failed: EBUSY/);
  assert.equal(p.list()[0].status, 'ready');
  mode = 'slow-abort';
  await p.trim('sb1');
  assert.ok(aborted, 'the timeout aborts the trim so it stops at its next file');
  assert.equal(p.list()[0].status, 'ready');
  assert.deepEqual(statuses.filter((s) => s.startsWith('sb1:')), ['sb1:creating', 'sb1:ready', 'sb1:cleanup', 'sb1:ready', 'sb1:cleanup', 'sb1:ready', 'sb1:cleanup', 'sb1:ready']);
});

test('w898: a daemon restart in the middle of a trim leaves nothing stuck: the pool reads cleanup back as ready', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  const { p } = pool(r, { liveAgents: () => 0, trim: { timeoutMs: 300 }, trimmer: () => new Promise(() => undefined) });
  await p.create({ id: 'sb1', branch: 'sandbox/sb1', base: 'origin/develop', seedLibrary: false, startUnity: false });
  await ready(p, 'sb1');
  const cut = p.trim('sb1');
  assert.equal(p.list()[0].status, 'cleanup');
  const { p: restarted } = pool(r, { liveAgents: () => 0 });
  assert.equal(restarted.list().find((s) => s.id === 'sb1')?.status, 'ready');
  await cut; // let the first pool's trim time out, so no timer outlives the test
});
