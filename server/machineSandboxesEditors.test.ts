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
 * The machine sandbox tests (docs/machines.md): the whole wait loop, pair asks, sandboxes in use, editor starts, bench tickets and Unity slots, worktree creation.
 * One of the server/machineSandboxes*.test.ts files split out of machineSandboxes.test.ts (w5826); helpers in machineSandboxesTestKit.ts.
 */


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

test('w1945: a worker that asks for a pair run with request_pair frees its sandbox as its turn ends: stopped, released FREE on its branch, and placed again when the pair reports', async (t) => {
  const { r, store, sessions, mm, agents, path1, gitNow } = await twoSandboxes(t);
  // w665's case (2026-10-23): its worker held m3's only sandbox while the two-machine run of its PR waited for a pair.
  const w = mm.createSession('pc', { kind: 'worker', title: 'w665 work', permissionMode: 'default', sandbox: 'sb1' });
  sessions.send(w.info.id, 'go');
  await until('w live and idle', () => w.live && w.info.status === 'idle');
  fs.writeFileSync(path.join(path1, 'pin.txt'), 'no collider');
  r.git(path1, 'add', 'pin.txt');
  r.git(path1, 'commit', '-q', '-m', 'w665 pin');
  r.git(path1, 'push', '-q', '-u', 'origin', 'HEAD');
  const by = { userId: 'lothsahn', displayName: 'Lothsahn' };
  const item: WorkItem = { id: 'w665', title: 'Low-ore pin collider', brief: 'Do it.', priority: 'urgent', keys: [], requestedBy: by, requesters: [], humanAsked: true, status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), sessionIds: [w.info.id], overlaps: [], asks: 0, log: [] };
  store.putWork(item);
  store.workSeq = Math.max(store.workSeq, 665);
  const o = agents.orchestrators;
  const out = o.filePair(w.info.id, { what: 'MP-lowore-pin-pair on PR #2340', brief: 'Run MP-lowore-pin-pair on the branch; 400 heartbeats compared, none diverged.' });
  const id = /^Filed (w\d+)/.exec(out)![1];
  assert.equal(item.status, 'blocked');
  assert.equal(store.work.get(id)!.pair?.for, 'w665');
  await gitNow('sb1');
  (agents.placeAgain as unknown as { d: { soon?: () => void } }).d.soon = () => undefined;
  assert.match(agents.placeAgain.tick().join('\n'), new RegExp(`stopped .*\\(it waits on w665: ${id}`));
  await until('w stopped', () => !w.live && w.info.status === 'stopped');
  await gitNow('sb1');
  assert.match(agents.placeAgain.tick().join('\n'), new RegExp(`released pc/sb1 of .* \\(it waits on w665: ${id}`));
  assert.equal(w.info.placeReleased?.branch, 'feature/w1');
  assert.match(agents.describeAllSandboxes(), /pc\/sb1 FREE/);
});

test('w2067: a machine reads sandboxes in use of its limit, from the FREE that marks each sandbox, and the page gets that same FREE', async (t) => {
  const { sessions, mm, agents } = await twoSandboxes(t);
  const pc = () => mm.list().find((m) => m.id === 'pc')!;
  // Both made, neither used: "0/2", not "2/2" (biscuit read full with two of its three empty, 2026-10-24).
  assert.match(agents.describeAllSandboxes(), /0\/2 sandboxes in use, up to 2 agents each/);
  assert.deepEqual(pc().sandboxes!.map((sb) => agents.sandboxFree('pc', sb)), [true, true]);
  const w = mm.createSession('pc', { kind: 'worker', title: 'w2067 work', permissionMode: 'default', sandbox: 'sb1' });
  sessions.send(w.info.id, 'go');
  await until('w live and idle', () => w.live && w.info.status === 'idle');
  const text = agents.describeAllSandboxes();
  assert.match(text, /1\/2 sandboxes in use, up to 2 agents each/);
  // The header, the per-sandbox FREE marks and what the page is sent agree.
  const free = pc().sandboxes!.filter((sb) => agents.sandboxFree('pc', sb)).map((sb) => sb.id);
  assert.deepEqual(free, ['sb2']);
  assert.deepEqual([...text.matchAll(/- pc\/(\w+) FREE/g)].map((m) => m[1]), free);
  w.stop();
  await until('w stopped', () => !w.live);
});

test('w1615, w1860: an editor start takes a shared bench ticket after its slot: queued while a timed run holds the lock, started at its turn, the ticket held while the editor runs and taken again when it is lost; a stop cancels a queued start', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  const tickets: ReturnType<typeof fakeTicket>[] = [];
  const { p, events, running } = pool(r, { settings: { maxUnity: 2 }, bootTicket: () => {
    const k = fakeTicket();
    tickets.push(k);
    return { ticket: k as unknown as BenchTicket };
  } });
  t.after(() => tickets.forEach((k) => k.release())); // a failed assertion must not leave a queued start waiting forever
  for (const id of ['a', 'b']) await p.create({ id, branch: `sandbox/${id}`, base: 'origin/master', seedLibrary: false, startUnity: false });
  await ready(p, 'a');
  await ready(p, 'b');
  // A timed run holds the lock: the start answers at once that it is queued, and no editor runs.
  const said = await p.unity('a', 'start');
  assert.match(said, /^Queued \(w1615\): .*place 2, waiting for t00000001 exclusive probe A round 2.*starts by itself at its turn/);
  assert.equal(running.size, 0, 'nothing starts beside the timed run');
  await p.tick();
  assert.equal(p.list().find((s) => s.id === 'a')!.unity.state, 'starting', 'a look keeps it queued, not stopped');
  assert.match(p.list().find((s) => s.id === 'a')!.unity.detail ?? '', /^queued in the bench queue: /);
  assert.match(await p.unity('a', 'start'), /Already queued in the bench queue/, 'a second start does not queue twice');
  assert.equal(tickets.length, 1);
  // Its turn: the pool starts the editor itself and tells the worker.
  tickets[0].kind = 'granted';
  await until('a started at its turn', () => running.size === 1);
  await until('the event', () => events.some((e) => /sandbox a: its queued editor start ran at its turn in the bench queue/.test(e.text)));
  assert.equal(tickets[0].released, 0, 'held while the editor loads');
  await p.tick();
  assert.equal(p.list().find((s) => s.id === 'a')!.unity.state, 'running');
  assert.equal(tickets[0].released, 0, 'w1860: held while the editor runs, not only while it boots');
  // w1860: its ticket revoked at the shared group's limit: the running editor takes a new one (after EDITOR_TICKET_RETRY_MS).
  tickets[0].kind = 'failed';
  await p.tick();
  assert.equal(tickets[0].released, 1);
  assert.equal(tickets.length, 1, 'not at once');
  clockSkew.ms += EDITOR_TICKET_RETRY_MS;
  t.after(() => (clockSkew.ms = 0));
  await p.tick();
  assert.equal(tickets.length, 2, 'a new ticket for the running editor');
  assert.equal(running.size, 1, 'the editor ran on meanwhile');
  // A start that is granted at once runs at once; a stop of a queued start cancels it and lets its ticket go.
  const b = p.unity('b', 'start');
  tickets.length = 1;
  assert.match(await b, /^Queued/);
  assert.match(await p.unity('b', 'stop'), /Its queued start is cancelled \(w1615\)/);
  assert.equal(tickets[1].released, 1);
  tickets[1].kind = 'granted';
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(running.has(path.join(r.sbRoot, 'b')), false, 'a cancelled start never runs');
});

test('w1829: a booting editor shows starting until its own bridge writes its status; one left by the editor before it does not count, and an editor running before the daemon is up at its first look', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  const tickets: ReturnType<typeof fakeTicket>[] = [];
  /** When each project's bridge last wrote its status file (bridgeUpSince's mtime). */
  const status = new Map<string, number>();
  const { p, running } = pool(r, {
    settings: { maxUnity: 2 },
    bootTicket: () => {
      const k = fakeTicket();
      k.kind = 'granted';
      tickets.push(k);
      return { ticket: k as unknown as BenchTicket };
    },
    bridge: (project, since, run) => run.has(project) && (since === undefined || (status.get(project) ?? -Infinity) >= since),
  });
  t.after(() => tickets.forEach((k) => k.release()));
  for (const id of ['a', 'b']) await p.create({ id, branch: `sandbox/${id}`, base: 'origin/master', seedLibrary: false, startUnity: false });
  await ready(p, 'a');
  await ready(p, 'b');
  const pa = path.join(r.sbRoot, 'a');
  const pb = path.join(r.sbRoot, 'b');
  const state = (id: string) => p.list().find((s) => s.id === id)!.unity.state;
  // b's editor already ran when this daemon started, its status written a minute ago: up at the first look.
  running.add(pb);
  status.set(pb, Date.now() - 60_000);
  // a's last editor left its status a minute ago; a new one is launched now (BEAST slot5, 2026-10-23).
  status.set(pa, Date.now() - 60_000);
  assert.match(await p.unity('a', 'start'), /Started/);
  assert.equal(running.has(pa), true);
  await p.tick();
  assert.equal(state('b'), 'running', 'an editor that ran before the daemon');
  assert.equal(state('a'), 'starting', 'its first import still runs');
  assert.equal(tickets[0].released, 0, 'the boot keeps its ticket: no timed run starts beside the import');
  // Its own bridge comes up and writes its status.
  status.set(pa, Date.now());
  await p.tick();
  assert.equal(state('a'), 'running');
  assert.equal(tickets[0].released, 0, 'a running editor keeps its ticket (w1860)');
});

test('w1829: an editor closed for a timed run is marked before its quit, says why, keeps its mark across a daemon restart, starts again through the bench queue when the turn ends and stays marked until it runs, and its worker hears it once', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  const tickets: ReturnType<typeof fakeTicket>[] = [];
  const bootTicket = () => {
    const k = fakeTicket();
    k.kind = 'granted';
    tickets.push(k);
    return { ticket: k as unknown as BenchTicket };
  };
  const { p, running } = pool(r, { bootTicket });
  t.after(() => tickets.forEach((k) => k.release()));
  await p.create({ id: 'a', branch: 'sandbox/a', base: 'origin/master', seedLibrary: false, startUnity: false });
  await ready(p, 'a');
  await p.unity('a', 'start');
  await p.tick();
  assert.equal(p.list()[0].unity.state, 'running');
  const by = 'a timed run on lothdesktop/slot3 (w1785)';
  // The close itself is the editor's own save and quit (machine/liveIdle.ts); here it quits the stand-in. The mark is in
  // sandboxes.json before the quit is sent: a daemon restart in the middle of it still reopens the editor.
  const res = await p.benchClose('a', by, 't00000042', `closed for ${by}; reopens when it ends (by 10:00Z at the latest)`, async () => {
    assert.deepEqual(pool(r, { bootTicket }).p.benchClosedList().map((c) => [c.id, c.ticket]), [['a', 't00000042']], 'marked before the quit');
    running.clear();
    return { closed: true, saved: ['Assets/Scenes/Look.unity'], text: 'closed (saved Assets/Scenes/Look.unity and the assets first)' };
  });
  assert.equal(res.closed, true);
  assert.deepEqual(p.benchClosedList().map((c) => c.id), ['a']);
  await p.tick();
  const sb = p.list()[0];
  assert.equal(sb.unity.state, 'stopped');
  assert.match(sb.unity.detail ?? '', /^closed for a timed run on lothdesktop\/slot3 \(w1785\); reopens when it ends/, 'the panel and list_sandboxes say why, after a look too');
  // A daemon restart: the mark is in sandboxes.json, so the restarted daemon reopens it when no turn keeps it closed.
  const again = pool(r, { bootTicket });
  assert.deepEqual(again.p.benchClosedList().map((c) => c.id), ['a']);
  const said = await again.p.benchReopen('a');
  assert.match(said, /Started \(fake\)/);
  assert.equal(again.running.size, 1, 'started again');
  assert.equal(tickets.length, 2, 'through a shared bench ticket, like any start');
  assert.ok(again.p.benchClosedList()[0]?.reopenAt, 'still marked until a look sees it run (a start not made is asked for again)');
  await again.p.tick();
  assert.deepEqual(again.p.benchClosedList(), [], 'running again: the mark goes');
  const note = again.p.takeBenchNote('a');
  assert.match(note ?? '', /^\[bench turn\] Your sandbox's Unity editor was closed at \d\d:\d\dZ for a timed run on lothdesktop\/slot3 \(w1785\).* It saved Assets\/Scenes\/Look\.unity first\. Its assets were saved too: check git status/);
  assert.equal(again.p.takeBenchNote('a'), undefined, 'once');
  assert.match(await again.p.benchReopen('a'), /^not closed$/);
  // A close skipped (compiling) leaves no mark; one that took the quit and still runs keeps it, its pid with it.
  await again.p.benchClose('a', by, 't00000043', 'x', async () => ({ closed: false, saved: [], text: 'skipped: it is compiling or importing' }));
  assert.deepEqual(again.p.benchClosedList(), []);
  await again.p.benchClose('a', by, 't00000043', 'x', async () => ({ closed: false, quitting: true, saved: [], text: 'skipped: asked to quit (...), it still runs after 180 s; left running, never killed' }));
  await again.p.tick();
  assert.deepEqual(again.p.benchClosedList().map((c) => c.id), ['a'], 'it may yet go: the turn reopens it then');
  // A stop asked for is the last word: the turn does not start it again after it.
  await again.p.unity('a', 'stop');
  assert.deepEqual(again.p.benchClosedList(), []);
  // w2116: a dialog held the quit up, so the close backed the scenes up and force-stopped the editor: unlike a stop asked
  // for, its mark stays and the turn's end starts it again.
  await again.p.unity('a', 'start');
  await again.p.tick();
  const forced = await again.p.benchClose('a', by, 't00000044', 'x', async () => {
    await again.p.benchForceStop('a');
    return { closed: true, forced: true, saved: [], text: 'closed by force: the dialog "Save Scene [&Save / Cancel]" held it 32 s; backed up ...' };
  });
  assert.equal(forced.closed, true);
  assert.equal(again.running.size, 0, 'force-stopped');
  await again.p.tick();
  assert.deepEqual(again.p.benchClosedList().map((c) => [c.id, c.ticket]), [['a', 't00000044']], 'the turn reopens it');
});

test('w1962: a queued editor start holds its slot while it waits, so another start is refused meanwhile, and it starts at its turn', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  const tickets: ReturnType<typeof fakeTicket>[] = [];
  let queue = true;
  const { p, events, running } = pool(r, { settings: { maxUnity: 1 }, bootTicket: () => {
    const k = fakeTicket();
    if (!queue) k.kind = 'granted';
    tickets.push(k);
    return { ticket: k as unknown as BenchTicket };
  } });
  t.after(() => tickets.forEach((k) => k.release())); // a failed assertion must not leave a queued start waiting forever
  for (const id of ['a', 'b']) await p.create({ id, branch: `sandbox/${id}`, base: 'origin/master', seedLibrary: false, startUnity: false });
  await ready(p, 'a');
  await ready(p, 'b');
  assert.match(await p.unity('a', 'start'), /^Queued/);
  queue = false;
  await assert.rejects(p.unity('b', 'start'), /already 1 sandbox editors running or starting on this machine \(a; max_unity 1\)/, "a's queued start holds the slot");
  tickets[0].kind = 'granted';
  await until('a started at its turn', () => events.some((e) => /sandbox a: its queued editor start ran at its turn in the bench queue/.test(e.text)));
  assert.equal(running.size, 1);
  assert.equal(tickets[0].released, 0, 'the granted ticket is kept while the editor runs');
  assert.ok(!events.some((e) => /was not made at its turn/.test(e.text)));
});

test('machine sandboxes: a worktree of the main clone on its own branch, a warm Library, removed cleanly', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  const { p } = pool(r);
  const created = await p.create({ id: 'sb1', branch: 'sandbox/sb1', base: 'origin/master', seedLibrary: true, startUnity: false });
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
  assert.equal(r.git(r.main, 'branch', '--show-current'), 'master', "the main clone's own checkout is untouched");
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
  await p.create({ id: 'sb1', branch: 'sandbox/sb1', base: 'origin/master', seedLibrary: true, startUnity: false });
  await ready(p, 'sb1');
  fs.rmSync(path.join(r.main, 'Library'), { recursive: true, force: true });
  await p.create({ id: 'sb2', branch: 'feature/x', base: 'origin/master', seedLibrary: true, startUnity: false });
  await ready(p, 'sb2');
  assert.equal(fs.readFileSync(path.join(r.sbRoot, 'sb2', 'Library', 'Artifacts', 'warm.bin'), 'utf8'), 'imported', "sb1's Library");
  assert.ok(fs.existsSync(path.join(r.sbRoot, 'sb2', 'Assets', '__FFFactoryReimport')), 'armed after any Library copy');
  const exclude = fs.readFileSync(path.join(r.main, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(exclude.split('\n').filter((l) => l === '/Assets/__FFFactoryReimport*').length, 1, 'the exclude line once');

  await assert.rejects(p.create({ id: 'sb3', branch: 'sandbox/sb3', base: 'origin/master', seedLibrary: false, startUnity: false }), /already 2 sandboxes on this machine \(max_sandboxes 2\)/);
  await p.remove('sb2', true);
  assert.equal(r.git(r.main, 'branch', '--list', 'feature/x'), '', 'deleteBranch removes the branch');
  await assert.rejects(p.create({ id: 'sb1', branch: 'sandbox/other', base: 'origin/master', seedLibrary: false, startUnity: false }), /already exists/);
  await assert.rejects(p.create({ id: 'sb3', branch: 'master', base: 'origin/master', seedLibrary: false, startUnity: false }), /never master, main or develop/);
  await assert.rejects(p.create({ id: 'sb3', branch: 'bad..name', base: 'origin/master', seedLibrary: false, startUnity: false }), /not a valid branch name/);
  await assert.rejects(p.create({ id: 'finalfactory', branch: 'sandbox/ff', base: 'origin/master', seedLibrary: false, startUnity: false }), /main clone's folder name/);
  await assert.rejects(p.create({ id: 'Bad Name', branch: 'sandbox/x', base: 'origin/master', seedLibrary: false, startUnity: false }), /not a usable sandbox name/);
});

test('machine sandboxes: editors are limited by max_unity; a switch waits for the editor to stop; the disk guard', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  let free: number | undefined = 500 * GB;
  let busy = true;
  const { p, events, running } = pool(r, { free: () => free, settings: { maxUnity: 1 }, activity: () => ({ busy, lastActivityMs: Date.now() }) });
  for (const id of ['a', 'b']) await p.create({ id, branch: `sandbox/${id}`, base: 'origin/master', seedLibrary: false, startUnity: false });
  await ready(p, 'a');
  await ready(p, 'b');
  await p.unity('a', 'start');
  assert.equal(p.list().find((s) => s.id === 'a')!.unity.state, 'starting');
  assert.match(p.list().find((s) => s.id === 'a')!.unity.logPath ?? '', /sandbox-editor\.log$/, 'its own log, not the shared Editor.log');
  await assert.rejects(p.unity('b', 'start'), /already 1 sandbox editors running or starting on this machine \(a; max_unity 1\)/);
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
  await assert.rejects(p.create({ id: 'c', branch: 'sandbox/c', base: 'origin/master', seedLibrary: false, startUnity: false }), /disk space is warn|already 2 sandboxes/);
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

test("w2988: a sandbox handed to a worker's branch still holding another worker's untracked folder: both CI-wait saves commit only the worker's own files, the folder stays untracked and never reaches the branch, and the worker is told", async (t) => {
  const r = repos();
  t.after(r.cleanup);
  const { p } = pool(r);
  await p.create({ id: 'slot1', branch: 'regress/fog-lock', base: 'origin/master', seedLibrary: false, startUnity: false });
  await ready(p, 'slot1');
  const sb = p.list().find((s) => s.id === 'slot1')!.path;
  // m5/slot1 on 2026-11-03: worker 3be01245's `ffu-bake asteroid --preview` output, and its editor's .meta files.
  const theirs = ['Assets/_RM1Preview.meta', 'Assets/_RM1Preview/asteroid.obj', 'Assets/_RM1Preview/asteroid.obj.meta', 'Assets/_RM1Preview/asteroid_albedo.tga'];
  fs.mkdirSync(path.join(sb, 'Assets', '_RM1Preview'), { recursive: true });
  for (const f of theirs) fs.writeFileSync(path.join(sb, f), 'not w2979s');
  const hand = await p.switch('slot1', 'sandbox/slot1-w2979', 'origin/master');
  assert.match(hand.notes.join('; '), /4 untracked file\(s\) were already here from before, not yours.*Assets\/_RM1Preview/, 'the worker placed there is told');

  fs.writeFileSync(path.join(sb, 'Mine.cs'), 'w2979');
  fs.writeFileSync(path.join(sb, 'README.md'), 'changed by w2979');
  const first = await p.saveWork('slot1', 'sandbox/slot1-w2979', 'FF Factory: saved 5589ceba (w656)');
  assert.equal(first.files, 2, 'its new file and its change, nothing of the folder');
  assert.match(first.notes.join('; '), /left 4 untracked file\(s\) uncommitted.*not this worker's \(w2988\)/);
  const onBranch = r.git(r.origin, 'ls-tree', '-r', '--name-only', 'sandbox/slot1-w2979');
  assert.match(onBranch, /Mine\.cs/);
  assert.doesNotMatch(onBranch, /_RM1Preview/, 'never pushed to the PR branch');
  for (const f of theirs) assert.ok(fs.existsSync(path.join(sb, f)), `${f} is left where it was`);
  assert.deepEqual(r.git(sb, 'status', '--porcelain', '-uall', '--', 'Assets').split('\n').sort(), theirs.map((f) => `?? ${f}`).sort(), 'still untracked');

  // Rewritten in the sandbox meanwhile (the editor re-imported it at 10:41), released again: the PR head does not move.
  const head = r.git(r.origin, 'rev-parse', 'sandbox/slot1-w2979');
  fs.writeFileSync(path.join(sb, theirs[1]), 'rewritten');
  const second = await p.saveWork('slot1', 'sandbox/slot1-w2979', 'FF Factory: saved 5589ceba (w656)');
  assert.equal(second.sha, undefined);
  assert.match(second.notes.join('; '), /nothing else to save/);
  assert.equal(r.git(r.origin, 'rev-parse', 'sandbox/slot1-w2979'), head, "the PR's head stays, so its merge on green holds");
});

test('machine sandboxes: the default disk guard (w628) starts an editor at 25 GB free; a full Library copy needs the Library', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  let free: number | undefined = 25 * GB;
  const defaults = { diskWarnGB: DISK_WARN_GB_DEFAULT, diskCriticalGB: DISK_CRITICAL_GB_DEFAULT };
  const { p } = pool(r, { free: () => free, settings: defaults });
  await p.create({ id: 'a', branch: 'sandbox/a', base: 'origin/master', seedLibrary: false, startUnity: false });
  await ready(p, 'a');
  // The m3 of 2026-10-07: about 25 GB free, which the old 50 GB guard refused.
  await p.tick();
  assert.equal(p.diskState().level, 'ok');
  assert.match(await p.unity('a', 'start'), /Started/);
  free = 14 * GB;
  await p.tick();
  assert.equal(p.diskState().level, 'warn', 'below 15 GB no new editors (w1951)');
  free = 9 * GB;
  await p.tick();
  assert.equal(p.diskState().level, 'critical', 'below 10 GB idle editors stop');
  free = 19 * GB;
  await p.tick();
  assert.equal(p.diskState().level, 'warn', 'hysteresis: not ok again until 20 GB');
  free = 20 * GB;
  await p.tick();
  assert.equal(p.diskState().level, 'ok');

  // A full copy (robocopy onto NTFS) of a 100 GB Library at 110 GB free: refused, where the flat 30 GB allowance passed.
  const full = pool(r, { free: () => 110 * GB, copyBytes: 100 * GB, settings: defaults }).p;
  await full.create({ id: 'b', branch: 'sandbox/b', base: 'origin/master', seedLibrary: true, startUnity: false });
  await until('b refused', () => full.list().find((x) => x.id === 'b')?.status === 'error');
  assert.match(full.list().find((x) => x.id === 'b')!.statusDetail ?? '', /not enough disk for the Library copy \(~100 GB\): 110 GB free .* need 115 GB/);
  await full.remove('b').catch(() => undefined);
  // A block clone reports no size: the allowance stands.
  const cloned = pool(r, { free: () => 110 * GB, settings: defaults }).p;
  await cloned.create({ id: 'c', branch: 'sandbox/c', base: 'origin/master', seedLibrary: true, startUnity: false });
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
