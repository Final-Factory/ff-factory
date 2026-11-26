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
import { withBaseRepoLock } from './sandboxes.ts';
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
 * The machine sandbox tests (docs/machines.md): freeing a sandbox, the cleanup trim and release sweep, Library clones, lfs dedup, the disk guard, slot repos.
 * One of the server/machineSandboxes*.test.ts files split out of machineSandboxes.test.ts (w5826); helpers in machineSandboxesTestKit.ts.
 */


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

test("w898: the last agent leaving a sandbox sends it to 'cleanup', trims the caches, then frees it; a start in between is refused", async (t) => {
  const r = repos();
  t.after(r.cleanup);
  let live = 1;
  const { p, statuses } = pool(r, { liveAgents: () => live });
  await p.create({ id: 'sb1', branch: 'sandbox/sb1', base: 'origin/master', seedLibrary: false, startUnity: false });
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
  assert.ok(files.gone.every((f) => !exists(f)) && files.kept.every(exists), 'the superseded Burst player build gone, live entries and the rest of Library kept');
  await p.tick();
  assert.equal(p.list()[0].status, 'ready', 'it does not trim again until the next release');
  assert.equal((await p.trim('sb1')).files, 0);
});

test("w913: the release sweep of build and capture output runs in the same 'cleanup' state, once, and a failing one does not fail the trim", async (t) => {
  const r = repos();
  t.after(r.cleanup);
  let live = 1;
  const seen: string[] = [];
  const logs: string[] = [];
  let boom = false;
  const { p } = pool(r, {
    liveAgents: () => live,
    log: (l) => logs.push(l),
    releaseSweep: async (sb) => {
      seen.push(`${path.basename(sb)}:${p.list()[0].status}`);
      if (boom) throw new Error('disk gone');
      return { files: 2, bytes: 3 * 1024 ** 3 };
    },
  });
  await p.create({ id: 'sb1', branch: 'sandbox/sb1', base: 'origin/master', seedLibrary: false, startUnity: false });
  await ready(p, 'sb1');
  await p.tick();
  assert.deepEqual(seen, [], 'an agent lives there: no sweep');
  live = 0;
  await p.tick();
  await until('the trim to end', () => p.list()[0].status === 'ready');
  assert.deepEqual(seen, ['sb1:cleanup'], 'swept while the sandbox was in cleanup, not free');
  assert.ok(logs.some((l) => /build and capture output: 2 entries, 3\.0 GB/.test(l)), logs.join(' | '));
  boom = true;
  live = 1;
  await p.tick();
  live = 0;
  await p.tick();
  await until('the second trim to end', () => p.list()[0].status === 'ready' && seen.length === 2);
  assert.ok(logs.some((l) => /release sweep failed: disk gone/.test(l)));
});

test('w898: no trim while an agent is live, an editor is up, or a build has the project open; a release with the editor up trims when it stops', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  let live = 1;
  const { p, running } = pool(r, { liveAgents: () => live });
  await p.create({ id: 'sb1', branch: 'sandbox/sb1', base: 'origin/master', seedLibrary: false, startUnity: false });
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
  await p.create({ id: 'sb1', branch: 'sandbox/sb1', base: 'origin/master', seedLibrary: false, startUnity: false });
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
  await p.create({ id: 'sb1', branch: 'sandbox/sb1', base: 'origin/master', seedLibrary: false, startUnity: false });
  await ready(p, 'sb1');
  const cut = p.trim('sb1');
  assert.equal(p.list()[0].status, 'cleanup');
  const { p: restarted } = pool(r, { liveAgents: () => 0 });
  assert.equal(restarted.list().find((s) => s.id === 'sb1')?.status, 'ready');
  await cut; // let the first pool's trim time out, so no timer outlives the test
});

test('w1576: a sandbox unused for days gets its Library cloned from the seed again; a recently used one keeps its own', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  const seed = path.join(r.root, 'seed', 'Library');
  fs.mkdirSync(path.join(seed, 'Artifacts'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'Artifacts', 'seed.bin'), 'seed');
  let lastActivityMs = Date.now();
  const logs: string[] = [];
  const { p, statuses } = pool(r, {
    settings: { librarySeed: seed, librarySeedCopy: 'clone' },
    activity: () => ({ busy: false, lastActivityMs }),
    liveAgents: () => 0,
    log: (l) => logs.push(l),
  });
  await p.create({ id: 'sb1', branch: 'sandbox/sb1', base: 'origin/master', seedLibrary: false, startUnity: false });
  await ready(p, 'sb1');
  const lib = path.join(r.sbRoot, 'sb1', 'Library');
  fs.mkdirSync(path.join(lib, 'Artifacts'), { recursive: true });
  fs.writeFileSync(path.join(lib, 'Artifacts', 'own.bin'), 'grown over days');
  fs.mkdirSync(path.join(r.sbRoot, 'sb1', 'ProjectSettings'));
  fs.writeFileSync(path.join(r.sbRoot, 'sb1', 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.3.0f1');
  const old = new Date(Date.now() - 5 * 86_400_000);
  for (const d of [path.join(lib, 'Artifacts'), lib]) fs.utimesSync(d, old, old);
  await p.tick();
  assert.ok(fs.existsSync(path.join(lib, 'Artifacts', 'own.bin')), 'an agent was there a moment ago: kept');
  lastActivityMs = Date.now() - 5 * 86_400_000;
  (p as unknown as { lastReseedLookAt: number }).lastReseedLookAt = 0;
  await p.tick();
  await until('the reseed', () => logs.some((l) => /cloned from the seed again/.test(l)) && p.list()[0].status === 'ready');
  assert.ok(fs.existsSync(path.join(lib, 'Artifacts', 'seed.bin')) && !fs.existsSync(path.join(lib, 'Artifacts', 'own.bin')), "the seed's Library, not its own");
  assert.ok(statuses.includes('sb1:cleanup'), 'cleanup meanwhile: nobody is handed it half done');
  assert.ok(logs.some((l) => /^sandbox sb1: unused for 5 days: its Library \(0\.0 GB\) cloned from the seed again$/.test(l)), logs.join(' | '));
});

test('w1668: slot1 on a build computer (warm), where urgent releases build, keeps its own Library however long it lies unused', async (t) => {
  // lothsahn: "Let's make sure that urgent builds always get scheduled in slot1 on whatever machine they run in so that it uses caches as warm as possible."
  const r = repos();
  t.after(r.cleanup);
  const seed = path.join(r.root, 'seed', 'Library');
  fs.mkdirSync(path.join(seed, 'Artifacts'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'Artifacts', 'seed.bin'), 'seed');
  const logs: string[] = [];
  const { p } = pool(r, {
    settings: { librarySeed: seed, librarySeedCopy: 'clone' },
    activity: () => ({ busy: false, lastActivityMs: Date.now() - 5 * 86_400_000 }),
    liveAgents: () => 0,
    log: (l) => logs.push(l),
    warm: ['slot1'],
  });
  await p.create({ id: 'slot1', branch: 'sandbox/slot1', base: 'origin/master', seedLibrary: false, startUnity: false });
  await ready(p, 'slot1');
  const lib = path.join(r.sbRoot, 'slot1', 'Library');
  fs.mkdirSync(path.join(lib, 'ShaderCache'), { recursive: true });
  fs.writeFileSync(path.join(lib, 'ShaderCache', 'metal.bin'), 'compiled for the Mac player');
  fs.mkdirSync(path.join(r.sbRoot, 'slot1', 'ProjectSettings'));
  fs.writeFileSync(path.join(r.sbRoot, 'slot1', 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.3.0f1');
  // A second sandbox as stale: the one reseed of the pass goes to it, not to slot1 (one at a time, in creation order).
  await p.create({ id: 'sb2', branch: 'sandbox/sb2', base: 'origin/master', seedLibrary: false, startUnity: false });
  await ready(p, 'sb2');
  const lib2 = path.join(r.sbRoot, 'sb2', 'Library');
  fs.mkdirSync(path.join(lib2, 'Artifacts'), { recursive: true });
  fs.writeFileSync(path.join(lib2, 'Artifacts', 'own.bin'), 'grown over days');
  fs.mkdirSync(path.join(r.sbRoot, 'sb2', 'ProjectSettings'));
  fs.writeFileSync(path.join(r.sbRoot, 'sb2', 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.3.0f1');
  const old = new Date(Date.now() - 5 * 86_400_000);
  for (const d of [path.join(lib, 'ShaderCache'), lib, path.join(lib2, 'Artifacts'), lib2]) fs.utimesSync(d, old, old);
  await p.tick();
  await until('a reseed', () => logs.some((l) => /cloned from the seed again/.test(l)) && p.list().every((x) => x.status === 'ready'));
  assert.ok(logs.some((l) => /^sandbox sb2: unused for 5 days/.test(l)), logs.join(' | '));
  assert.ok(fs.existsSync(path.join(lib, 'ShaderCache', 'metal.bin')), 'slot1 keeps its own Library');
});

test('w1576: lfsDedup reads the bytes git lfs dedup shared, and never throws', async () => {
  const said = (code: number, stdout: string, stderr = '') => async () => ({ code, stdout, stderr });
  const ok = await lfsDedup(said(0, 'Success:\n  De-duplicated  size: 9103132700 bytes\n                count: 5026\n'), 'X');
  assert.deepEqual(ok, { bytes: 9103132700 });
  assert.equal(lfsDedupWords(ok), 'LFS files shared with the store: 8.5 GB');
  assert.deepEqual(await lfsDedup(said(2, '', 'Working tree is dirty. Please commit or reset your change.'), 'X'), { skipped: 'Working tree is dirty. Please commit or reset your change.' });
  assert.deepEqual(await lfsDedup(async () => Promise.reject(new Error('spawn git ENOENT')), 'X'), { skipped: 'spawn git ENOENT' });
  let args: string[] = [];
  await lfsDedup(async (a) => ((args = a), { code: 0, stdout: '', stderr: '' }), path.join('sb', 'x'));
  assert.deepEqual(args, ['-C', path.join('sb', 'x'), 'lfs', 'dedup']);
});

test('w1576: the release trim runs git lfs dedup in the sandbox and logs what it did', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  const logs: string[] = [];
  let live = 1;
  const { p } = pool(r, { liveAgents: () => live, log: (l) => logs.push(l) });
  await p.create({ id: 'sb1', branch: 'sandbox/sb1', base: 'origin/master', seedLibrary: false, startUnity: false });
  await ready(p, 'sb1');
  assert.ok(logs.some((l) => /^sandbox sb1: LFS (files shared with the store|dedup skipped)/.test(l)), `provisioning ran it: ${logs.join(' | ')}`);
  await p.tick();
  live = 0;
  await p.tick();
  await until('the trim to end', () => p.list()[0].status === 'ready' && logs.some((l) => /Library cache trim/.test(l)));
  assert.ok(logs.some((l) => /Library cache trim \(released\).*; LFS (files shared with the store|dedup skipped)/.test(l)), logs.join(' | '));
});

test('w1668: a warm sandbox (slot1 on a build computer) is not trimmed when released; its build output is still swept', async (t) => {
  // Measured on biscuit, a Linux release build (main): 81 s warm, 244 s once the caches the trim drops were gone.
  const r = repos();
  t.after(r.cleanup);
  let live = 1;
  const trimmed: string[] = [];
  const swept: string[] = [];
  const { p } = pool(r, {
    liveAgents: () => live,
    warm: ['slot1'],
    trimmer: async (project) => (trimmed.push(path.basename(project)), { files: 1, removedBytes: 1, keptBytes: 0 }),
    releaseSweep: async (sb) => (swept.push(path.basename(sb)), { files: 0, bytes: 0 }),
  });
  for (const id of ['slot1', 'sb2']) {
    await p.create({ id, branch: `sandbox/${id}`, base: 'origin/master', seedLibrary: false, startUnity: false });
    await ready(p, id);
  }
  await p.tick();
  live = 0;
  await p.tick();
  await until('both releases to end', () => p.list().every((x) => x.status === 'ready') && swept.length === 2);
  assert.deepEqual(trimmed, ['sb2'], 'slot1 keeps its Library caches');
  assert.deepEqual(swept.sort(), ['sb2', 'slot1'], 'both sweep their build output');
});

test('w1856: a release build hands its sandbox back: switch_branch onto urgent/<v> remembers the branch, build_plan done puts it back, and new work never starts on a release branch', async (t) => {
  const { r, mm, sessions, agents, sbOf, path1, gitNow } = await twoSandboxes(t);
  // The builder (here the worker that was in sb1 on feature/w1, as c28c5061's branch was in BEAST's slot1) puts the sandbox
  // on the bump commit, as the urgent-release skill says (step 3.1).
  const w = mm.createSession('pc', { kind: 'worker', title: 'w1836: the 1.0.0.12 urgent release', permissionMode: 'default', sandbox: 'sb1' });
  sessions.send(w.info.id, 'go');
  await until('w live and idle', () => w.live && w.info.status === 'idle');
  const said = await agents.switchBranch({ sandbox: 'pc/sb1', branch: 'urgent/1.0.0.12', createFrom: 'origin/master', callerSessionId: w.info.id });
  assert.match(said, /pc\/sb1 is on a release branch now: build_plan done puts it back on feature\/w1 \(w1856\); commit nothing on it\./);
  assert.equal(r.git(path1, 'branch', '--show-current'), 'urgent/1.0.0.12');
  assert.deepEqual({ from: w.info.releaseSwitch?.from, to: w.info.releaseSwitch?.to, sandbox: w.info.releaseSwitch?.sandbox }, { from: 'feature/w1', to: 'urgent/1.0.0.12', sandbox: 'sb1' });

  // build_plan done: back on the branch it left, the record gone.
  const plan = { machine: 'pc', what: 'the 1.0.0.12 urgent release', builder: w.info.id, requests: [], by: `worker ${w.info.id}`, declaredAt: Date.now(), dueAt: Date.now(), told: {}, paused: [], moved: [], kept: [] };
  const notes = await agents.handBackRelease(plan, w.info.id);
  assert.deepEqual(notes.map((n) => n.replace(/ \(.*\)$/, '')), ['pc/sb1 is back on feature/w1, off the release branch urgent/1.0.0.12']);
  assert.equal(r.git(path1, 'branch', '--show-current'), 'feature/w1');
  assert.equal(w.info.releaseSwitch, undefined);
  assert.deepEqual(await agents.handBackRelease(plan, w.info.id), [], 'nothing left to put back');

  // Left on a release branch with nobody there (the builder's request closed and it stopped): new work starts on a fresh
  // branch, never on urgent/<v>.
  await agents.switchBranch({ sandbox: 'pc/sb1', branch: 'urgent/1.0.0.12', callerSessionId: w.info.id });
  w.stop();
  await until('w stopped', () => !w.live);
  // Its request closed, so the release pass released the sandbox (placeReleased), as after w1836.
  delete w.info.releaseSwitch;
  w.info.placeReleased = { at: new Date().toISOString(), sandbox: 'sb1', branch: 'urgent/1.0.0.12', why: 'its work is over: its request is closed (w1836 done)' };
  await gitNow('sb1');
  const prep = await agents.prepareForNewWork('pc/sb1', undefined, 'W1767');
  assert.equal(prep.branch, 'sandbox/sb1-w1767', prep.note);
  assert.match(prep.note, /^ Handed over first: pc\/sb1 was on the release branch urgent\/1\.0\.0\.12, which a release build left it on \(w1856\)/);
  assert.equal(r.git(path1, 'branch', '--show-current'), 'sandbox/sb1-w1767');
  assert.equal(sbOf('sb1')!.branch, 'sandbox/sb1-w1767');
});

test("w5550: file_ffbox_symbols takes a version only from the request whose switch_branch onto urgent/<v> built it", async (t) => {
  const { store, mm, sessions, agents } = await twoSandboxes(t);
  const by = { userId: 'lothsahn', displayName: 'Lothsahn' };
  const work = (id: string, sid: string): WorkItem => ({ id, title: `${id} work`, brief: 'Do it.', priority: 'normal', keys: [], requestedBy: by, requesters: [], humanAsked: true, status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), sessionIds: [sid], overlaps: [], asks: 0, log: [] });
  // The builder of the urgent release (w5600) and another worker (w5601) in the other sandbox.
  const b = mm.createSession('pc', { kind: 'worker', title: 'w5600: the 1.0.0.20 urgent release', permissionMode: 'default', sandbox: 'sb1' });
  const o = mm.createSession('pc', { kind: 'worker', title: 'w5601: other work', permissionMode: 'default', sandbox: 'sb2' });
  store.putWork(work('w5600', b.info.id));
  store.putWork(work('w5601', o.info.id));
  store.workSeq = Math.max(store.workSeq, 5601);
  sessions.send(b.info.id, 'go');
  sessions.send(o.info.id, 'go');
  await until('both live and idle', () => b.live && b.info.status === 'idle' && o.live && o.info.status === 'idle');
  const file = (s: SessionInfo, version: string) => (agents as unknown as { fileFfboxSymbols: (i: SessionInfo, a: Record<string, unknown>) => Promise<string> }).fileFfboxSymbols(s, { version, entries: [{ app: 'main', platform: 'WindowsPlayer', attachment: 'att_aaaaaaaaaaaa' }] });

  // Nobody built 1.0.0.20 yet: refused for both.
  assert.match(await file(b.info, '1.0.0.20'), /^Refused \(w5550\): no urgent build of 1\.0\.0\.20 is recorded/);
  // The builder's switch onto urgent/1.0.0.20 (urgent-release.md 3.1) records w5600's build.
  await agents.switchBranch({ sandbox: 'pc/sb1', branch: 'urgent/1.0.0.20', createFrom: 'origin/master', callerSessionId: b.info.id });
  assert.deepEqual(agents.symbolOwners.get('1.0.0.20')?.builds.map((x) => [x.workIds, x.session, x.machine, x.sandbox]), [[['w5600'], b.info.id, 'pc', 'sb1']]);
  // Another request's build: refused. An unknown version: refused.
  assert.match(await file(o.info, '1.0.0.20'), /^Refused \(w5550\): 1\.0\.0\.20 was built for w5600, not for your request \(w5601\)/);
  assert.match(await file(b.info, '1.0.0.21'), /^Refused \(w5550\): no urgent build of 1\.0\.0\.21/);
  // Its own build passes the gate (this harness has no FFBox link, so the next step says so).
  await assert.rejects(file(b.info, '1.0.0.20'), /FFBox is not wired into this server/);
  // w5601 building 1.0.0.20 too (its own switch onto urgent/1.0.0.20; git keeps one branch in one worktree, so recorded
  // here as the switch records it) makes it a builder, but symbols w5600 filed are never overwritten by it.
  agents.symbolOwners.recordFiling('1.0.0.20', b.info.id, ['w5600']);
  agents.symbolOwners.recordSwitch('urgent/1.0.0.20', o.info.id, ['w5601'], 'pc', 'sb2');
  assert.match(await file(o.info, '1.0.0.20'), /^Refused \(w5550\): 1\.0\.0\.20's symbols were filed by w5600/);
});

test('w1944: a sandbox being handed to new work (its editor stopped, its branch switched, before the worker exists) is not free: no room for it, and a second start into it is refused', async (t) => {
  const { mm, sessions, agents, gitNow } = await twoSandboxes(t);
  const w = mm.createSession('pc', { kind: 'worker', title: 'w1935 work', permissionMode: 'default', sandbox: 'sb1' });
  sessions.send(w.info.id, 'go');
  await until('w live and idle', () => w.live && w.info.status === 'idle');
  w.stop();
  await until('w stopped', () => !w.live);
  // It released sb1 on its own branch while it waits on CI, as 604a6cdc released biscuit/slot1 at 01:12:48Z.
  w.info.placeReleased = { at: new Date().toISOString(), sandbox: 'sb1', branch: 'feature/w1', why: 'it waits on CI (w1935)' };
  await gitNow('sb1');
  const free = () => agents.places().find((p) => p.id === 'pc')!.freeSandboxes;
  assert.equal(free(), 2);
  let open!: () => void;
  const gate = new Promise<void>((res) => (open = res));
  const hands = mm as unknown as { switchBranch: (...a: unknown[]) => Promise<unknown> };
  const real = hands.switchBranch.bind(mm);
  hands.switchBranch = async (...a: unknown[]) => {
    await gate;
    return real(...a);
  };
  const prep = agents.prepareForNewWork('pc/sb1', undefined, 'W1911');
  await until('sb1 handed', () => free() === 1);
  await assert.rejects(agents.prepareForNewWork('pc/sb1', undefined, 'W1917'), /sandbox pc\/sb1 is being handed to new work W1911 now/);
  open();
  const done = await prep;
  assert.equal(done.branch, 'sandbox/sb1-w1911', done.note);
  // Handed over and no worker started in it (a failed start): free again.
  assert.equal(free(), 2);
});

test('w3502: an editor start on a cold Library near the disk line warns (a re-import writes about 18 GB), and starts', async (t) => {
  const r = repos();
  t.after(() => fs.rmSync(r.root, { recursive: true, force: true, maxRetries: 5 }));
  let free = 60 * GB; // above disk_warn_gb 50, below 50 + 18
  const logs: string[] = [];
  const { p, events, running } = pool(r, { free: () => free, log: (l) => logs.push(l) });
  await p.create({ id: 'a', branch: 'sandbox/a', base: 'origin/master', seedLibrary: false, startUnity: false });
  await ready(p, 'a');
  const said = await p.unity('a', 'start');
  assert.match(said, /Warning \(w3502\): its Unity Library is cold .* about 18 GB; with 60 GB free .* disk_warn_gb 50/);
  assert.match(said, /Started/, 'a warning, not a refusal');
  assert.equal(running.size, 1);
  assert.ok(events.some((e) => /sandbox a: Warning \(w3502\)/.test(e.text)), 'the portal is told');
  assert.ok(logs.some((l) => /Warning \(w3502\)/.test(l)));
  await p.unity('a', 'stop');
  // Plenty of room: no word.
  free = 200 * GB;
  assert.doesNotMatch(await p.unity('a', 'start'), /w3502/);
  await p.unity('a', 'stop');
  // A warm Library (its ArtifactDB) imports only what changed: no word near the line either.
  free = 60 * GB;
  const sb = p.list().find((x) => x.id === 'a')!;
  fs.mkdirSync(path.join(sb.path, 'Library'), { recursive: true });
  fs.writeFileSync(path.join(sb.path, 'Library', 'ArtifactDB'), 'db');
  assert.doesNotMatch(await p.unity('a', 'start'), /w3502/);
});

test("w3518: after a daemon restart the disk guard waits for the portal's pool settings: no disk-low notice from daemon.json's stale disk_warn_gb", async (t) => {
  const r = repos();
  t.after(r.cleanup);
  // lothdesktop, 2026-11-07 17:42 -07:00: 24 GB free, daemon.json's stale disk_warn_gb 50, the portal's pool 15.
  let free = 24 * GB;
  const { p, events } = pool(r, { free: () => free, settings: { diskWarnGB: 50, diskCriticalGB: 10 }, awaitConfigure: true });
  const low = () => events.filter((e) => /disk space (low|critical|is fine again)/.test(e.text)).map((e) => e.text);
  await p.tick();
  await p.tick();
  assert.deepEqual(low(), [], 'no notice before the welcome');
  assert.equal(p.diskState().level, 'ok');
  p.configure(SETTINGS(r.sbRoot, { diskWarnGB: 15, diskCriticalGB: 10 }));
  await p.tick();
  assert.deepEqual(low(), [], "none at the portal's line either: 24 GB is above 15");
  assert.equal(p.diskState().level, 'ok');
  // The guard runs from the welcome on: a real low disk is still reported.
  free = 12 * GB;
  await p.tick();
  assert.match(low().at(-1) ?? '', /disk space low: 12 GB free .*below disk_warn_gb 15/);
  // A welcome with no pool settings (an older portal, a worker root with no pool yet) settles on daemon.json's line.
  const r2 = repos();
  t.after(r2.cleanup);
  const q = pool(r2, { free: () => 24 * GB, settings: { diskWarnGB: 50, diskCriticalGB: 10 }, awaitConfigure: true });
  await q.p.tick();
  assert.equal(q.events.some((e) => /disk space low/.test(e.text)), false);
  q.p.settle();
  await q.p.tick();
  assert.match(q.events.map((e) => e.text).join(' | '), /disk space low: 24 GB free .*below disk_warn_gb 50/);
  // Without awaitConfigure (a pool built straight from settings, as before) the guard runs at once.
  const r3 = repos();
  t.after(r3.cleanup);
  const n = pool(r3, { free: () => 24 * GB, settings: { diskWarnGB: 50, diskCriticalGB: 10 } });
  await n.p.tick();
  assert.match(n.events.map((e) => e.text).join(' | '), /disk space low: 24 GB free/);
});

test("w3518: a welcome that lands while the pool looks at its sandboxes: the disk guard uses the portal's line, not the look's copy of daemon.json's", async (t) => {
  const r = repos();
  t.after(r.cleanup);
  // beast, 2026-11-08 01:43:25Z: the new daemon connected; its welcome came while a look was awaiting its sandboxes' processes
  // and git, so that look's guard checked 75 GB against daemon.json's 80 ("disk space low") and the next said "fine again".
  let free = 500 * GB; // room for the sandbox, then beast's 75 GB
  const { p, events } = pool(r, { free: () => free, settings: { diskWarnGB: 80, diskCriticalGB: 10 }, awaitConfigure: true });
  await p.create({ id: 'a', branch: 'sandbox/a', base: 'origin/master', seedLibrary: false, startUnity: false });
  await ready(p, 'a');
  free = 75 * GB;
  const d = (p as unknown as { d: PoolDeps }).d;
  const procs = d.procs;
  let welcomed = false;
  d.procs = async () => {
    if (!welcomed) {
      welcomed = true;
      p.configure(SETTINGS(r.sbRoot, { diskWarnGB: 15, diskCriticalGB: 10 }));
    }
    return procs();
  };
  await p.tick();
  assert.equal(welcomed, true, 'the welcome landed inside the look');
  assert.deepEqual(events.filter((e) => /disk space (low|critical|is fine again)/.test(e.text)).map((e) => e.text), []);
  assert.equal(p.diskState().level, 'ok');
});

test('w4925: a repeat pair run for the same request carries the sandboxes its last run used, says so to the dispatcher, and prefers their computers', async (t) => {
  const { store, sessions, mm, agents } = await twoSandboxes(t);
  const w = mm.createSession('pc', { kind: 'worker', title: 'w4880 work', permissionMode: 'default', sandbox: 'sb1' });
  sessions.send(w.info.id, 'go');
  await until('w live and idle', () => w.live && w.info.status === 'idle');
  const by = { userId: 'lothsahn', displayName: 'Lothsahn' };
  const now = new Date().toISOString();
  const item: WorkItem = { id: 'w4880', title: 'Black hole station fix', brief: 'Do it.', priority: 'urgent', keys: [], requestedBy: by, requesters: [], humanAsked: true, status: 'active', createdAt: now, updatedAt: now, sessionIds: [w.info.id], overlaps: [], asks: 0, log: [] };
  store.putWork(item);
  store.workSeq = Math.max(store.workSeq, 4880);
  const o = agents.orchestrators;
  const first = /^Filed (w\d+)/.exec(o.filePair(w.info.id, { what: 'MP pair on PR #3990', brief: 'Run the MP pair on the branch.', commit: '9cc67303f5c7' }))![1];
  assert.equal(store.work.get(first)!.pair?.warm, undefined, 'a first run has no earlier one');
  o.pairStarted(first, [{ session: 's-leg1', sandbox: 'biscuit/slot2' }]);
  // It ran and reported (here: closed by hand); the fix is pushed and its worker asks again.
  store.putWork({ ...store.work.get(first)!, status: 'done', outcome: 'FAIL: did not compile' });
  store.putWork({ ...store.work.get('w4880')!, status: 'active', blocked: undefined });
  const again = /^Filed (w\d+)/.exec(o.filePair(w.info.id, { what: 'MP pair on PR #3990', brief: 'Run the MP pair on the fixed branch.', commit: 'd56c9f7ec6' }))![1];
  const p = store.work.get(again)!;
  assert.deepEqual(p.pair?.warm, { from: first, legs: ['biscuit/slot2'] });
  assert.ok(p.brief.includes(warmText(p.pair!.warm!)), p.brief);
  assert.match(warmText(p.pair!.warm!), new RegExp(`^Its request's last pair run, ${first}, ran in biscuit/slot2: start its leg there when it is FREE .*never wait for it\.$`));
  // pairRoom: the warm computer first among those with room; a cached player of the commit still wins.
  const fit = { m5: { platform: 'darwin' }, pc: { platform: 'win32' }, biscuit: { platform: 'win32' } };
  assert.deepEqual(pairRoom(p, ['pc', 'biscuit'], fit).pick, ['biscuit']);
  assert.deepEqual(pairRoom({ pair: { ...p.pair!, warm: undefined } }, ['pc', 'biscuit'], fit).pick, ['pc'], 'without it, placement\'s own order');
  w.stop();
  await until('w stopped', () => !w.live);
});

// ---------------------------------------------------------------- w5614: slot repos (machine/slotRepo.ts)

test('w5614: while the store lock holds, a new sandbox is a slot repo even with slot_repos unset; an explicit setting still wins', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  let locked = true;
  const { p } = pool(r, { storeLocked: () => locked });
  await p.create({ id: 'sb1', branch: 'sandbox/sb1', base: 'origin/master', seedLibrary: false, startUnity: false });
  await ready(p, 'sb1');
  assert.ok(isSlotRepo(path.join(r.sbRoot, 'sb1')), 'locked: a worktree would need the store writable');
  locked = false;
  await p.create({ id: 'sb2', branch: 'sandbox/sb2', base: 'origin/master', seedLibrary: false, startUnity: false });
  await ready(p, 'sb2');
  assert.ok(!isSlotRepo(path.join(r.sbRoot, 'sb2')), 'unlocked and unset: a worktree, as before');
});

test('w5614: slot repos: a new sandbox is its own repo that borrows the clone\'s objects; its commits write nothing into the clone; a switch to a branch another sandbox holds is refused; a delete keeps its branches in the clone', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  const { p } = pool(r, { settings: { slotRepos: 'new' } });
  await p.create({ id: 'sb1', branch: 'sandbox/sb1', base: 'origin/master', seedLibrary: false, startUnity: false });
  await ready(p, 'sb1');
  const dir = path.join(r.sbRoot, 'sb1');
  assert.ok(isSlotRepo(dir), 'its .git is a folder with objects/info/alternates');
  assert.ok(borrowsFrom(dir, path.join(r.main, '.git')), 'it borrows the main clone\'s objects');
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8').replace(/\r\n/g, '\n'), 'game\n', 'checked out');
  assert.equal(r.git(dir, 'status', '--porcelain'), '');
  assert.equal(r.git(dir, 'branch', '--show-current'), 'sandbox/sb1');
  assert.equal(r.git(dir, 'rev-parse', 'HEAD'), r.git(r.main, 'rev-parse', 'origin/master'), 'at its base');
  assert.ok(r.git(dir, 'rev-parse', '--verify', 'origin/master'), "origin's refs came along");
  assert.doesNotMatch(r.git(r.main, 'worktree', 'list'), /sb1/, 'no worktree of the clone');
  assert.equal(r.git(r.main, 'config', '--get', 'gc.pruneExpire'), 'never', 'the clone keeps what slots borrow');
  assert.equal(r.git(dir, 'count-objects'), '0 objects, 0 kilobytes', 'nothing copied');

  // A commit: the clone gets no branch, no ref and no object.
  const before = r.git(r.main, 'count-objects', '-v');
  fs.writeFileSync(path.join(dir, 'work.txt'), 'w');
  r.git(dir, 'add', 'work.txt');
  r.git(dir, 'commit', '-q', '-m', 'slot work');
  const mine = r.git(dir, 'rev-parse', 'HEAD');
  assert.equal(r.git(r.main, 'count-objects', '-v'), before, 'no object written into the clone');
  assert.equal(r.git(r.main, 'branch', '--list', 'sandbox/sb1'), '', 'no branch in the clone');

  // Git no longer refuses a branch another sandbox holds: the pool does.
  await p.create({ id: 'sb2', branch: 'feature/x', base: 'origin/master', seedLibrary: false, startUnity: false });
  await ready(p, 'sb2');
  await assert.rejects(p.switch('sb2', 'sandbox/sb1'), /branch sandbox\/sb1 is checked out in sandbox sb1/);
  await assert.rejects(p.create({ id: 'sb3', branch: 'sandbox/sb1', base: 'origin/master', seedLibrary: false, startUnity: false }), /checked out in sandbox sb1|max_sandboxes/);

  // Its stash (w5692's review): two entries, the older with an untracked file, the newer a tracked edit.
  fs.writeFileSync(path.join(dir, 'loose.txt'), 'untracked');
  r.git(dir, 'stash', 'push', '-u', '-q', '-m', 'older');
  fs.writeFileSync(path.join(dir, 'work.txt'), 'edited');
  r.git(dir, 'stash', 'push', '-q', '-m', 'newer');
  const stashes = r.git(dir, 'stash', 'list', '--format=%H').split('\n').map((l) => l.trim());
  assert.equal(stashes.length, 2);

  // A delete keeps its unpushed commit: in the clone, under refs/sandbox-kept/sb1/ and as the branch (new there).
  await p.remove('sb1');
  // and its stash, newest first, with what each entry held (a worktree's refs/stash lived in the clone and outlived it).
  assert.equal(r.git(r.main, 'rev-parse', `${keptStashPrefix('sb1')}0`), stashes[0]);
  assert.equal(r.git(r.main, 'rev-parse', `${keptStashPrefix('sb1')}1`), stashes[1]);
  assert.equal(r.git(r.main, 'show', `${keptStashPrefix('sb1')}0:work.txt`), 'edited');
  assert.equal(r.git(r.main, 'show', `${keptStashPrefix('sb1')}1^3:loose.txt`), 'untracked', 'the untracked file came with it');
  assert.equal(fs.existsSync(dir), false, 'the folder is gone');
  assert.equal(r.git(r.main, 'rev-parse', 'refs/sandbox-kept/sb1/sandbox/sb1'), mine);
  assert.equal(r.git(r.main, 'rev-parse', 'refs/heads/sandbox/sb1'), mine);
  // A worker placed again in another sandbox finds its branch there, from the clone, as with worktrees.
  const sw = await p.switch('sb2', 'sandbox/sb1');
  assert.match(sw.notes.join('; '), /took sandbox\/sb1 from the main clone/);
  assert.equal(r.git(path.join(r.sbRoot, 'sb2'), 'rev-parse', 'HEAD'), mine);
  await p.remove('sb2');
});

test('w5614: slot repos "all": a free, idle worktree sandbox becomes a slot repo in place, its files, index and branch kept; one with an agent in it waits', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  let live = 1;
  const { p, events } = pool(r, { liveAgents: () => live });
  await p.create({ id: 'sb1', branch: 'sandbox/sb1', base: 'origin/master', seedLibrary: false, startUnity: false });
  await ready(p, 'sb1');
  const dir = path.join(r.sbRoot, 'sb1');
  fs.writeFileSync(path.join(dir, 'README.md'), 'changed\n');
  fs.writeFileSync(path.join(dir, 'staged.txt'), 's');
  r.git(dir, 'add', 'staged.txt');
  fs.writeFileSync(path.join(dir, 'loose.txt'), 'u');
  const status = r.git(dir, 'status', '--porcelain');
  const head = r.git(dir, 'rev-parse', 'HEAD');
  assert.ok(isWorktree(dir));

  p.configure(SETTINGS(r.sbRoot, { slotRepos: 'all' }));
  await p.tick();
  assert.ok(isWorktree(dir), 'an agent is live there: left as it is');
  live = 0;
  // The tick that sees it free trims its Library caches first (trimReleased, 'cleanup'); the conversion waits for that.
  await p.tick();
  await ready(p, 'sb1');
  (p as unknown as { lastConvertLookAt: number }).lastConvertLookAt = 0;
  if (!isSlotRepo(dir)) await p.tick();
  assert.ok(isSlotRepo(dir), `converted: ${JSON.stringify(events)} ${JSON.stringify(p.list())}`);
  assert.equal(p.list()[0].status, 'ready');
  assert.equal(r.git(dir, 'status', '--porcelain'), status, 'the same changes, staged and not');
  assert.equal(r.git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(r.git(dir, 'branch', '--show-current'), 'sandbox/sb1');
  assert.doesNotMatch(r.git(r.main, 'worktree', 'list'), /sb1/, 'the clone forgot the worktree');
  assert.equal(fs.readFileSync(path.join(dir, '.git', 'worktree-pointer'), 'utf8').startsWith('gitdir:'), true, 'the old pointer kept');
  // The branch is free in the clone again: the main clone may check it out (git refused while it was a worktree).
  r.git(r.main, 'switch', '-q', 'sandbox/sb1');
  r.git(r.main, 'switch', '-q', 'master');
});

test('w5614: slot repos "all" on a busy machine: a worktree that is never free converts when a worker is placed in it, and the look says why it waited', async (t) => {
  // BEAST, 2026-11-26: slot3 was free only between a release and the next placement, so convertIdle never saw it free,
  // and the log never said why. The worker placed there was the one waiting for the conversion.
  const r = repos();
  t.after(r.cleanup);
  const logs: string[] = [];
  const { p } = pool(r, { liveAgents: () => 1, log: (l) => logs.push(l) });
  await p.create({ id: 'sb1', branch: 'sandbox/sb1', base: 'origin/master', seedLibrary: false, startUnity: false });
  await ready(p, 'sb1');
  const dir = path.join(r.sbRoot, 'sb1');
  fs.writeFileSync(path.join(dir, 'loose.txt'), 'u');
  p.configure(SETTINGS(r.sbRoot, { slotRepos: 'all' }));
  await p.tick();
  (p as unknown as { lastConvertLookAt: number }).lastConvertLookAt = 0;
  await p.tick();
  assert.ok(isWorktree(dir), 'an agent is live there: the look leaves it');
  const said = logs.filter((l) => /sb1: not becoming a slot repo yet: an agent is live there/.test(l));
  assert.equal(said.length, 1, `the reason, once: ${JSON.stringify(logs)}`);
  await until('sb1 not busy', () => !(p as unknown as { busy: Set<string> }).busy.has('sb1'));
  const res = await p.switch('sb1', 'sandbox/placed', 'origin/master');
  assert.ok(isSlotRepo(dir), `converted at the placement: ${JSON.stringify(logs)}`);
  assert.equal(res.to, 'sandbox/placed');
  assert.equal(r.git(dir, 'branch', '--show-current'), 'sandbox/placed');
  assert.equal(p.list()[0].status, 'ready');
  assert.ok(fs.existsSync(path.join(dir, 'loose.txt')), 'files untouched');
});

for (const how of ['hangs', 'throws'] as const) {
  test(`w5614: a conversion at a placement that ${how} never stops the placement: the switch goes on with a whole worktree`, async (t) => {
    const r = repos();
    t.after(r.cleanup);
    const { p, events } = pool(r, { liveAgents: () => 1 });
    await p.create({ id: 'sb1', branch: 'sandbox/sb1', base: 'origin/master', seedLibrary: false, startUnity: false });
    await ready(p, 'sb1');
    const dir = path.join(r.sbRoot, 'sb1');
    // create's provision ends ready before its busy mark is cleared: a switch in that gap rightly skips the conversion.
    await until('sb1 not busy', () => !(p as unknown as { busy: Set<string> }).busy.has('sb1'));
    p.configure(SETTINGS(r.sbRoot, { slotRepos: 'all' }));
    const inner = p as unknown as { convertAtPlacementMs: number; d: { git: (a: string[], o?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }> } };
    // A throw needs no timeout; a hang needs one long enough to reach the planted fetch (Windows CI's git took over 300 ms
    // before it, run 45833036898: "timed out after 0 s" with the step never reached).
    inner.convertAtPlacementMs = how === 'hangs' ? 15_000 : 3 * 60_000;
    const real = inner.d.git;
    let reached = false;
    // The refs fetch into .git.new, after .git.new is written and before the swap: the worst place to be cut.
    inner.d.git = async (a, o) => {
      if (!a.includes('fetch') || !a.some((x) => x.endsWith('.git.new'))) return real(a, o);
      reached = true;
      if (how === 'throws') throw new Error('planted failure');
      // A hang: it ends only when the pool aborts it, as a killed git process would.
      return new Promise((res) => o?.signal?.addEventListener('abort', () => res({ code: 1, stdout: '', stderr: 'killed' })));
    };
    await p.tick();
    const before = { worktree: isWorktree(dir), blocker: (p as unknown as { convertBlocker: (r: unknown) => string | undefined; recs: Map<string, unknown> }).convertBlocker((p as unknown as { recs: Map<string, unknown> }).recs.get('sb1')) };
    const res = await p.switch('sb1', 'sandbox/placed', 'origin/master');
    assert.ok(reached, `the planted step ran: ${JSON.stringify({ before, now: { worktree: isWorktree(dir), slot: isSlotRepo(dir) }, events })}`);
    assert.equal(res.to, 'sandbox/placed', 'the placement went on');
    assert.ok(isWorktree(dir), 'still a whole worktree');
    assert.equal(fs.existsSync(path.join(dir, '.git.new')), false, 'no half-made git folder left');
    assert.equal(r.git(dir, 'branch', '--show-current'), 'sandbox/placed');
    assert.equal(p.list()[0].status, 'ready');
    assert.ok(events.some((e) => /sb1: could not become a slot repo/.test(e.text)), JSON.stringify(events));
    assert.ok(events.some((e) => /placements skip the conversion for 6 h/.test(e.text)), JSON.stringify(events));
    // w6086 finding 1: the next placement does not try again (it would hold that worker up too) ...
    inner.d.git = real;
    await p.switch('sb1', 'sandbox/placed2', 'origin/master');
    assert.ok(isWorktree(dir), 'backed off: the next placement leaves it');
    assert.equal(r.git(dir, 'branch', '--show-current'), 'sandbox/placed2');
    // ... and once the back-off is past, a placement converts it.
    (p as unknown as { convertFailedAt: Map<string, number> }).convertFailedAt.clear();
    await p.switch('sb1', 'sandbox/placed3', 'origin/master');
    assert.ok(isSlotRepo(dir), 'converted at a placement after the back-off');
    assert.equal(r.git(dir, 'branch', '--show-current'), 'sandbox/placed3');
  });
}

test('w5614: a conversion at a placement whose main clone lock stays busy gives up before doing anything, with no back-off (w6086 finding 2)', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  const { p, events } = pool(r, { liveAgents: () => 1 });
  await p.create({ id: 'sb1', branch: 'sandbox/sb1', base: 'origin/master', seedLibrary: false, startUnity: false });
  await ready(p, 'sb1');
  await until('sb1 not busy', () => !(p as unknown as { busy: Set<string> }).busy.has('sb1'));
  const dir = path.join(r.sbRoot, 'sb1');
  p.configure(SETTINGS(r.sbRoot, { slotRepos: 'all' }));
  (p as unknown as { convertAtPlacementMs: number }).convertAtPlacementMs = 300;
  // Another sandbox's locked work holds the main clone's lock for 2 s.
  let free: () => void = () => undefined;
  const holding = withBaseRepoLock(() => new Promise<void>((res) => (free = res)));
  const freeLater = setTimeout(() => free(), 2_000);
  t.after(() => clearTimeout(freeLater));
  const res = await p.switch('sb1', 'sandbox/placed', 'origin/master');
  await holding;
  assert.equal(res.to, 'sandbox/placed', 'the placement went on');
  assert.ok(isWorktree(dir), 'still a whole worktree');
  assert.equal(fs.existsSync(path.join(dir, '.git.new')), false, 'nothing was started');
  assert.ok(events.some((e) => /sb1: could not become a slot repo: the main clone stayed busy/.test(e.text)), JSON.stringify(events));
  assert.ok(!events.some((e) => /placements skip/.test(e.text)), 'a busy lock is no failure: no back-off');
  (p as unknown as { convertAtPlacementMs: number }).convertAtPlacementMs = 120_000;
  await p.switch('sb1', 'sandbox/placed2', 'origin/master');
  assert.ok(isSlotRepo(dir), 'the next placement converts it');
});

test('w5614: a conversion cut after its swap says it became a slot repo, not that it stays a worktree (w6086 finding 3)', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  const logs: string[] = [];
  const { p, events } = pool(r, { liveAgents: () => 1, log: (l) => logs.push(l) });
  await p.create({ id: 'sb1', branch: 'sandbox/sb1', base: 'origin/master', seedLibrary: false, startUnity: false });
  await ready(p, 'sb1');
  await until('sb1 not busy', () => !(p as unknown as { busy: Set<string> }).busy.has('sb1'));
  const dir = path.join(r.sbRoot, 'sb1');
  p.configure(SETTINGS(r.sbRoot, { slotRepos: 'all' }));
  const inner = p as unknown as { convertAtPlacementMs: number; d: { git: (a: string[], o?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }> } };
  inner.convertAtPlacementMs = 15_000;
  const real = inner.d.git;
  let reached = false;
  // The status count after the swap hangs until the pool cuts it.
  inner.d.git = async (a, o) => {
    if (!(a.includes('status') && a.includes('--untracked-files=no') && a.includes(dir) && isSlotRepo(dir))) return real(a, o);
    reached = true;
    return new Promise((res) => o?.signal?.addEventListener('abort', () => res({ code: 1, stdout: '', stderr: 'killed' })));
  };
  const res = await p.switch('sb1', 'sandbox/placed', 'origin/master');
  inner.d.git = real;
  assert.ok(reached, `the planted step ran: ${JSON.stringify({ logs, events })}`);
  assert.equal(res.to, 'sandbox/placed');
  assert.ok(isSlotRepo(dir), 'a whole slot repo');
  assert.equal(r.git(dir, 'branch', '--show-current'), 'sandbox/placed');
  assert.ok(logs.some((l) => /sb1: became a slot repo \(a step after the swap was cut/.test(l)), JSON.stringify(logs));
  assert.ok(!events.some((e) => /could not become a slot repo/.test(e.text)), JSON.stringify(events));
});

test('w5614: a conversion cut between its two renames is finished; a slot .git.new beside a whole .git is dropped', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-slotfin-'));
  try {
    const a = path.join(root, 'a');
    fs.mkdirSync(path.join(a, '.git.new'), { recursive: true });
    fs.writeFileSync(path.join(a, '.git.new', 'HEAD'), 'ref: refs/heads/x\n');
    fs.writeFileSync(path.join(a, '.git.worktree'), 'gitdir: ../repo/worktrees/a\n');
    assert.equal(finishConversion(a), true);
    assert.ok(fs.statSync(path.join(a, '.git')).isDirectory());
    assert.equal(fs.existsSync(path.join(a, '.git.worktree')), false);
    const b = path.join(root, 'b');
    fs.mkdirSync(path.join(b, '.git.new'), { recursive: true });
    fs.writeFileSync(path.join(b, '.git'), 'gitdir: ../repo/worktrees/b\n');
    assert.equal(finishConversion(b), false);
    assert.equal(fs.existsSync(path.join(b, '.git.new')), false);
    assert.ok(fs.statSync(path.join(b, '.git')).isFile(), 'the worktree stays a worktree');
    assert.equal(finishConversion(path.join(root, 'none')), false);
    assert.equal(worktreeRecordOf('gitdir: ../../repo/worktrees/slot4\n', path.join(root, 'sb', 'slot4'), path.join(root, 'repo')), path.join(root, 'repo', 'worktrees', 'slot4'));
    assert.equal(worktreeRecordOf('gitdir: /elsewhere/x\n', path.join(root, 'sb', 'slot4'), path.join(root, 'repo')), undefined, 'never outside the clone');
    assert.equal(gitPathForm('C:\\a\\b').endsWith('a/b'), true);
    // configText round-trips through git: quotes, backslashes, a dotted subsection, a tab.
    const entries: [string, string][] = [['core.autocrlf', 'false'], ['filter.lfs.smudge', 'git-lfs smudge -- "%f"'], ['branch.sandbox/a.b.merge', 'refs/heads/sandbox/a.b'], ['user.name', 'A \\ B\tC']];
    const cfg = path.join(root, 'cfg');
    fs.writeFileSync(cfg, configText(entries));
    const back = execFileSync('git', ['config', '--file', cfg, '--list', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean).map((e) => e.split('\n'));
    assert.deepEqual(back, entries);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// w5692's review: lothsahn's lockout rule asks for a recovery route tested with nobody at the machine. The route
// (docs/machines.md, Slot repos, "Going back"): slot_repos off, delete the slot repo, create it again.
test('w5614: the way back: with slot_repos off a new sandbox is a worktree and nothing converts; a slot repo deleted keeps its branch and stash, and created again is a worktree on that commit', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  const { p } = pool(r, { settings: { slotRepos: 'new' } });
  await p.create({ id: 'sb1', branch: 'sandbox/sb1', base: 'origin/master', seedLibrary: false, startUnity: false });
  await ready(p, 'sb1');
  const dir = path.join(r.sbRoot, 'sb1');
  assert.ok(isSlotRepo(dir));
  fs.writeFileSync(path.join(dir, 'work.txt'), 'w');
  r.git(dir, 'add', 'work.txt');
  r.git(dir, 'commit', '-q', '-m', 'slot work');
  const mine = r.git(dir, 'rev-parse', 'HEAD');

  // A switch away keeps the stash; a stash dropped since is cleared from the clone on the next keep.
  fs.writeFileSync(path.join(dir, 'work.txt'), 'stashed');
  r.git(dir, 'stash', 'push', '-q', '-m', 'one');
  await p.switch('sb1', 'side/y');
  assert.equal(r.git(r.main, 'show', `${keptStashPrefix('sb1')}0:work.txt`), 'stashed');
  r.git(dir, 'stash', 'drop', '-q');
  await p.switch('sb1', 'sandbox/sb1');
  assert.equal(r.git(r.main, 'for-each-ref', keptStashPrefix('sb1')), '', 'the dropped entry is gone from the clone too');

  p.configure(SETTINGS(r.sbRoot, {}));
  await p.create({ id: 'sb2', branch: 'sandbox/sb2', base: 'origin/master', seedLibrary: false, startUnity: false });
  await ready(p, 'sb2');
  assert.ok(isWorktree(path.join(r.sbRoot, 'sb2')), 'off: a new sandbox is a worktree');
  (p as unknown as { lastConvertLookAt: number }).lastConvertLookAt = 0;
  await p.tick();
  assert.ok(isWorktree(path.join(r.sbRoot, 'sb2')), 'off: nothing converted');

  await p.remove('sb1');
  assert.equal(r.git(r.main, 'rev-parse', 'refs/heads/sandbox/sb1'), mine, 'the delete kept the commit in the clone');
  await p.create({ id: 'sb1', branch: 'sandbox/sb1', base: 'origin/master', seedLibrary: false, startUnity: false });
  await ready(p, 'sb1');
  assert.ok(isWorktree(dir), 'created again: a worktree');
  assert.equal(r.git(dir, 'rev-parse', 'HEAD'), mine, 'on the kept commit');
  await p.remove('sb1');
  await p.remove('sb2');
});
