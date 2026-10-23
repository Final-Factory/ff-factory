import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REAP, UnityReaper, inspectProcs, isSlotWrapper, logFileOf, ownerOf, parsePsClock, verdict, type Judged, type ProcFacts, type ReaperDeps } from '../machine/unityReaper.ts';
import type { Proc, UnityPlatform } from '../machine/unity.ts';

/**
 * Orphaned and hung batch builds (w791, machine/unityReaper.ts). The kill cases are the two of 2026-10-09: LothDesktop
 * pid 3856, a nightly prepare build of slot4 hung with its parent script alive, and m5 pid 81390, a worker's Mac build
 * 15 h old whose parent was pid 1. The keep cases are what must never be touched: an interactive editor, a Unity of a
 * project that is not a sandbox, a build whose owner is alive and progressing, and a young or progressing orphan.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const EDITOR = 'C:\\Program Files\\Unity\\Editor\\6000.3.19f1\\Editor';
const SLOT4 = 'D:\\work\\ffw\\sandboxes\\slot4';
const MAC_APP = '/Applications/Unity/Hub/Editor/6000.3.19f1/Unity.app/Contents/MacOS/Unity';

const winBatch = (pid: number, ppid: number, project = SLOT4, log = `${project}\\.nightly-builds\\x-win\\prepare.log`): Proc => ({
  pid,
  ppid,
  name: 'Unity.exe',
  cmd: `"${EDITOR}\\Unity.exe" -batchmode -quit -nographics -projectPath ${project} -executeMethod Editor.LocalMultiplayerVerificationBuild.PrepareWindowsMultiplayerBuild -logFile ${log}`,
});

/** A fake machine: a process list, start times, CPU, file times, a clock. Killing a pid removes it from the list. */
function machine(platform: UnityPlatform, procs: Proc[], places: { id: string; path: string }[]) {
  const st = {
    procs,
    now: 1_000 * HOUR,
    born: new Map<number, number>(),
    cpu: new Map<number, number>(),
    mtimes: new Map<string, number>(),
    files: new Set<string>(),
    killed: [] as number[],
    events: [] as string[],
    logs: [] as string[],
    afterKill: 0,
  };
  const deps: ReaperDeps = {
    platform,
    procs: async () => st.procs.map((p) => ({ ...p })),
    inspect: async (pids): Promise<ProcFacts[]> => pids.filter((p) => st.procs.some((x) => x.pid === p)).map((pid) => ({ pid, startedAt: st.born.get(pid), cpuMs: st.cpu.get(pid) })),
    places: () => places,
    mtime: (f) => st.mtimes.get(f),
    kill: (pid) => {
      st.killed.push(pid);
      st.procs = st.procs.filter((p) => p.pid !== pid);
    },
    exists: (p) => st.files.has(p),
    remove: (p) => void st.files.delete(p),
    sleep: async () => undefined,
    now: () => st.now,
    log: (l) => void st.logs.push(l),
    onEvent: (t) => void st.events.push(t),
    afterKill: async () => void st.afterKill++,
  };
  return { st, deps, reaper: new UnityReaper(deps) };
}

/** A look, then another a minute later (the daemon's cadence), with no change but the clock. */
async function twoLooks(m: ReturnType<typeof machine>) {
  await m.reaper.look();
  m.st.now += MIN;
  return m.reaper.look();
}

test('w791: LothDesktop pid 3856: a hung nightly prepare build whose parent script is alive is ended with what it started, and its lock removed', async () => {
  const m = machine(
    'win32',
    [
      { pid: 500, ppid: 400, name: 'bash.exe', cmd: 'C:\\Program Files\\Git\\usr\\bin\\bash.exe scripts/nightly/build_player.sh' },
      winBatch(3856, 500),
      { pid: 3860, ppid: 3856, name: 'bee_backend.exe', cmd: `"${EDITOR}\\Data\\Tools\\BuildPipeline\\bee_backend.exe" --ipc` },
      { pid: 3861, ppid: 3856, name: 'Unity.exe', cmd: `"${EDITOR}\\Unity.exe" "-adb2" "-batchMode" "-name" "AssetImportWorker0" "-projectPath" "D:/work/ffw/sandboxes/slot4" "-parentPid" "3856"` },
      { pid: 3862, ppid: 3856, name: 'FinalFactory.exe', cmd: 'C:\\ffslots\\slot1\\player\\FinalFactory.exe' },
    ],
    [{ id: 'slot4', path: SLOT4 }],
  );
  const { st } = m;
  const t0 = st.now - 3 * HOUR - 30 * MIN;
  for (const p of [500, 3856, 3860, 3861, 3862]) st.born.set(p, t0);
  st.born.set(500, t0 - HOUR);
  st.cpu.set(3856, 4_000);
  st.mtimes.set(`${SLOT4}\\.nightly-builds\\x-win\\prepare.log`, st.now - 3 * HOUR); // the log stopped three hours ago
  st.files.add(`${SLOT4}\\Temp\\UnityLockfile`);

  const first = await m.reaper.look();
  assert.equal(first[0].killed, false, 'the first look only starts the clock: the daemon saw it just now');
  st.now += 31 * MIN;
  const second = await m.reaper.look();
  assert.equal(second[0].killed, true, second[0].line);
  assert.match(second[0].line, /hung: running \d+ min, no log or CPU progress for 31 min/);
  assert.deepEqual([...st.killed].sort((a, b) => a - b), [3856, 3860, 3861], 'the build, its bee_backend and its import worker; not its parent script, not the game player it launched');
  assert.equal(st.files.has(`${SLOT4}\\Temp\\UnityLockfile`), false, 'the stale lock is removed');
  assert.equal(st.events.length, 1);
  assert.match(st.events[0], /ended batch Unity pid 3856 of sandbox slot4 \(Editor\.LocalMultiplayerVerificationBuild\.PrepareWindowsMultiplayerBuild\)/);
  assert.match(st.events[0], /removed the stale Temp\/UnityLockfile/);
  assert.match(st.events[0], /spared the FinalFactory player|spared FinalFactory/);
  assert.equal(st.afterKill, 1, 'the slots are looked at again at once');
});

test('w791: m5 pid 81390: a build whose parent is launchd and whose log is stale is ended on the second look', async () => {
  const log = '/Users/benryding/ffw/sandboxes/slot1/Logs/build.log';
  const m = machine(
    'darwin',
    [{ pid: 81390, ppid: 1, cmd: `${MAC_APP} -batchmode -quit -nographics -projectPath /Users/benryding/ffw/sandboxes/slot1 -executeMethod Editor.LocalMultiplayerVerificationBuild.BuildMacMultiplayerDev -logFile ${log}` }],
    [{ id: 'slot1', path: '/Users/benryding/ffw/sandboxes/slot1' }],
  );
  const { st } = m;
  st.born.set(81390, st.now - 15 * HOUR);
  st.cpu.set(81390, 90_000);
  st.mtimes.set(log, st.now - 14 * HOUR);
  st.files.add('/Users/benryding/ffw/sandboxes/slot1/Temp/UnityLockfile');
  const first = await m.reaper.look();
  assert.equal(first[0].killed, false);
  assert.match(first[0].line, /waiting for a second look/);
  st.now += MIN;
  st.mtimes.set(log, st.now - 15 * HOUR);
  const second = await m.reaper.look();
  assert.equal(second[0].killed, true, second[0].line);
  assert.match(second[0].line, /orphaned: its parent is launchd \(pid 1\)/);
  assert.deepEqual(st.killed, [81390]);
  assert.equal(st.files.size, 0);
});

test('w791: never an interactive editor, however old, silent or orphaned', async () => {
  const m = machine(
    'win32',
    [{ pid: 700, ppid: 9999, name: 'Unity.exe', cmd: `"${EDITOR}\\Unity.exe" -projectPath ${SLOT4} -logFile ${SLOT4}\\Logs\\sandbox-editor.log` }],
    [{ id: 'slot4', path: SLOT4 }],
  );
  m.st.born.set(700, m.st.now - 30 * HOUR);
  const found = await twoLooks(m);
  m.st.now += 5 * HOUR;
  await m.reaper.look();
  assert.deepEqual(found, []);
  assert.deepEqual(m.st.killed, []);
});

test('w791: never a batch Unity of a project that is not a sandbox (the main clone, a person\'s own checkout)', async () => {
  const main = 'D:\\work\\ffw\\repo';
  const m = machine('win32', [winBatch(800, 9999, main, `${main}\\Logs\\b.log`)], [{ id: 'slot4', path: SLOT4 }]);
  m.st.born.set(800, m.st.now - 30 * HOUR);
  m.st.mtimes.set(`${main}\\Logs\\b.log`, m.st.now - 30 * HOUR);
  const found = await twoLooks(m);
  m.st.now += 5 * HOUR;
  await m.reaper.look();
  assert.deepEqual(found, []);
  assert.deepEqual(m.st.killed, []);
});

test('w791: a build whose owner is alive and whose log keeps growing is left alone, however long it runs', async () => {
  const log = `${SLOT4}\\.nightly-builds\\x-win\\build.log`;
  const m = machine('win32', [{ pid: 500, ppid: 400, name: 'bash.exe', cmd: 'bash.exe build_player.sh' }, winBatch(900, 500, SLOT4, log)], [{ id: 'slot4', path: SLOT4 }]);
  const { st } = m;
  st.born.set(900, st.now - 5 * HOUR);
  st.born.set(500, st.now - 5 * HOUR);
  for (let i = 0; i < 40; i++) {
    st.mtimes.set(log, st.now - 20_000); // written 20 s ago, every look
    const r = await m.reaper.look();
    assert.equal(r[0].killed, false, r[0].line);
    st.now += MIN;
  }
  assert.deepEqual(st.killed, []);
});

test('w791: a build whose owner is alive and whose log is silent but whose process tree works is left alone (a long Burst compile)', async () => {
  const log = `${SLOT4}\\Logs\\b.log`;
  const m = machine('win32', [{ pid: 500, ppid: 400, name: 'bash.exe', cmd: 'bash.exe x.sh' }, winBatch(901, 500, SLOT4, log), { pid: 902, ppid: 901, name: 'bcl.exe', cmd: `${SLOT4}\\Library\\PackageCache\\com.unity.burst\\bcl.exe` }], [{ id: 'slot4', path: SLOT4 }]);
  const { st } = m;
  st.born.set(901, st.now - 3 * HOUR);
  st.born.set(500, st.now - 3 * HOUR);
  st.mtimes.set(log, st.now - 2 * HOUR);
  let cpu = 100_000;
  for (let i = 0; i < 45; i++) {
    cpu += 20_000; // 20 s of CPU a minute in bcl.exe
    st.cpu.set(902, cpu);
    const r = await m.reaper.look();
    assert.equal(r[0].killed, false, `look ${i}: ${r[0].line}`);
    st.now += MIN;
  }
  assert.deepEqual(st.killed, []);
});

test('w791: a young build is never judged hung, whatever its log says', async () => {
  const log = `${SLOT4}\\Logs\\b.log`;
  const m = machine('win32', [{ pid: 500, ppid: 400, name: 'bash.exe', cmd: 'bash.exe x.sh' }, winBatch(903, 500, SLOT4, log)], [{ id: 'slot4', path: SLOT4 }]);
  m.st.born.set(903, m.st.now - 20 * MIN);
  m.st.born.set(500, m.st.now - 21 * MIN);
  m.st.mtimes.set(log, m.st.now - 19 * MIN);
  const r = await twoLooks(m);
  m.st.now += 25 * MIN; // 46 min old, 44 min silent: over the stall, under the minimum age
  const later = await m.reaper.look();
  assert.equal(r[0].killed, false);
  assert.equal(later[0].killed, false, later[0].line);
  assert.deepEqual(m.st.killed, []);
});

test('w791: an orphan that still makes progress is left until it is 90 min old, then ended', async () => {
  const log = `${SLOT4}\\Logs\\b.log`;
  const m = machine('win32', [winBatch(950, 424242, SLOT4, log)], [{ id: 'slot4', path: SLOT4 }]); // parent 424242 is not in the list
  const { st } = m;
  st.born.set(950, st.now - 30 * MIN);
  await m.reaper.look();
  for (let i = 0; i < 59; i++) {
    st.now += MIN;
    st.mtimes.set(log, st.now - 5_000);
    const r = await m.reaper.look();
    assert.equal(r[0].killed, false, r[0].line);
  }
  st.now += MIN;
  st.mtimes.set(log, st.now - 5_000);
  const r = await m.reaper.look();
  assert.equal(r[0].killed, true, r[0].line);
  assert.match(r[0].line, /over the 90 min an orphan may run/);
});

test('w791: the lock stays when another Unity still has the project open', async () => {
  const m = machine(
    'win32',
    [winBatch(960, 424242), { pid: 961, ppid: 1, name: 'Unity.exe', cmd: `"${EDITOR}\\Unity.exe" -projectPath ${SLOT4}` }],
    [{ id: 'slot4', path: SLOT4 }],
  );
  const { st } = m;
  st.born.set(960, st.now - 5 * HOUR);
  st.files.add(`${SLOT4}\\Temp\\UnityLockfile`);
  const r2 = await twoLooks(m); // 5 h old and orphaned: over the 90 min an orphan may run
  assert.equal(r2[0].killed, true, r2[0].line);
  assert.deepEqual(st.killed, [960], 'the interactive editor of the same project is not touched');
  assert.equal(st.files.has(`${SLOT4}\\Temp\\UnityLockfile`), true);
  assert.match(st.events[0], /left Temp\/UnityLockfile, a Unity \(pid 961\) still has the project open/);
});

test('w1196: on a Mac or Linux the start time moves by up to a second between looks (ps elapsed seconds); the orphan is still ended on the second look', async () => {
  const log = '/home/u/ffw/sandboxes/slot1/Logs/build.log';
  const m = machine('linux', [{ pid: 4242, ppid: 1, cmd: `/opt/Unity/Hub/Editor/6000.3.19f1/Editor/Unity -batchmode -quit -projectPath /home/u/ffw/sandboxes/slot1 -logFile ${log}` }], [{ id: 'slot1', path: '/home/u/ffw/sandboxes/slot1' }]);
  const { st } = m;
  st.born.set(4242, st.now - 15 * HOUR);
  st.mtimes.set(log, st.now - 14 * HOUR);
  assert.equal((await m.reaper.look())[0].killed, false);
  st.now += MIN;
  st.born.set(4242, st.now - 15 * HOUR - MIN + 715); // measured on biscuit: 715 ms off between two looks
  const second = await m.reaper.look();
  assert.equal(second[0].killed, true, second[0].line);
});

test('w791: a reused pid is a new build, not the old one\'s history', async () => {
  const log = `${SLOT4}\\Logs\\b.log`;
  const m = machine('win32', [{ pid: 500, ppid: 400, name: 'bash.exe', cmd: 'bash.exe x.sh' }, winBatch(970, 500, SLOT4, log)], [{ id: 'slot4', path: SLOT4 }]);
  const { st } = m;
  st.born.set(970, st.now - 2 * HOUR);
  st.born.set(500, st.now - 2 * HOUR);
  st.mtimes.set(log, st.now - 2 * HOUR);
  await m.reaper.look();
  st.now += 29 * MIN;
  st.born.set(970, st.now - 2 * MIN); // the build ended; pid 970 is a new build now
  const r = await m.reaper.look();
  st.now += 2 * MIN;
  const r2 = await m.reaper.look();
  assert.equal(r[0].killed, false);
  assert.equal(r2[0].killed, false, r2[0].line);
});

test('w791: a worker asks (check): it hears what was ended, or why each build stays, or that there is none', async () => {
  const none = machine('win32', [], [{ id: 'slot4', path: SLOT4 }]);
  assert.match(await none.reaper.check(), /No batch-mode Unity builds are running/);

  const log = `${SLOT4}\\Logs\\b.log`;
  const healthy = machine('win32', [{ pid: 500, ppid: 400, name: 'bash.exe', cmd: 'bash.exe x.sh' }, winBatch(980, 500, SLOT4, log)], [{ id: 'slot4', path: SLOT4 }]);
  healthy.st.born.set(980, healthy.st.now - 10 * MIN);
  healthy.st.mtimes.set(log, healthy.st.now - 5_000);
  const text = await healthy.reaper.check();
  assert.match(text, /No batch build is stuck/);
  assert.match(text, /batch Unity pid 980 of sandbox slot4/);
  assert.match(text, /kept/);
  assert.deepEqual(healthy.st.killed, []);

  const stuck = machine('darwin', [{ pid: 81390, ppid: 1, cmd: `${MAC_APP} -batchmode -quit -projectPath /s/slot1 -logFile /s/slot1/b.log` }], [{ id: 'slot1', path: '/s/slot1' }]);
  stuck.st.born.set(81390, stuck.st.now - 15 * HOUR);
  stuck.st.mtimes.set('/s/slot1/b.log', stuck.st.now - 15 * HOUR);
  await stuck.reaper.check(); // the first look sees the orphan
  stuck.st.now += 30_000;
  const ended = await stuck.reaper.check();
  assert.match(ended, /Ended 1 stuck batch build/);
  assert.deepEqual(stuck.st.killed, [81390]);
});

test('w791: tick looks once a minute', async () => {
  const m = machine('win32', [], []);
  let looks = 0;
  const deps = { ...m.deps, procs: async () => (looks++, []) };
  const r = new UnityReaper(deps);
  await r.tick();
  await r.tick();
  m.st.now += REAP.LOOK_EVERY_MS;
  await r.tick();
  assert.equal(looks, 2);
});

test('w791: ownerOf: a dead, init, launchd or reused parent is a gone owner; a live one is not', () => {
  const win: Proc[] = [{ pid: 10, ppid: 1, name: 'bash.exe', cmd: 'bash.exe x.sh' }];
  const u = (ppid: number) => ({ pid: 20, ppid });
  const born = (pid: number, at: number) => new Map<number, ProcFacts>([[pid, { pid, startedAt: at }]]);
  assert.equal(ownerOf(u(10), win, new Map(), 'win32').gone, false);
  assert.match(ownerOf(u(11), win, new Map(), 'win32').why, /parent process 11 is gone/);
  assert.equal(ownerOf(u(10), win, new Map([...born(20, 1_000), ...born(10, 50_000)]), 'win32').gone, true, 'the parent started after the build: its pid was reused');
  assert.equal(ownerOf(u(10), win, new Map([...born(20, 50_000), ...born(10, 1_000)]), 'win32').gone, false);
  assert.equal(ownerOf(u(1), [], new Map(), 'darwin').gone, true);
  assert.equal(ownerOf(u(1), [], new Map(), 'linux').gone, true);
  const sys: Proc[] = [{ pid: 900, ppid: 1, cmd: '/usr/lib/systemd/systemd --user' }];
  assert.equal(ownerOf(u(900), sys, new Map(), 'linux').gone, true);
  const sh: Proc[] = [{ pid: 901, ppid: 1, cmd: '/bin/bash build.sh' }];
  assert.equal(ownerOf(u(901), sh, new Map(), 'darwin').gone, false);
  assert.equal(ownerOf({ pid: 20, ppid: 0 }, [], new Map(), 'win32').gone, true);
});

test('w791: verdict: the limits', () => {
  const base: Judged = { ageMs: 0, owner: { gone: false, why: 'its parent bash (pid 5) is alive' }, orphanLooks: 0, stalledMs: 0, logStalledMs: 0 };
  const v = (o: Partial<Judged>) => verdict({ ...base, ...o });
  const gone = { gone: true, why: 'its parent process 7 is gone' };
  // alive owner
  assert.equal(v({ ageMs: 59 * MIN, stalledMs: 5 * HOUR }).kill, false, 'under an hour old');
  assert.equal(v({ ageMs: 2 * HOUR, stalledMs: 29 * MIN }).kill, false, 'silent for under 30 min');
  assert.equal(v({ ageMs: 60 * MIN, stalledMs: 30 * MIN }).kill, true);
  assert.equal(v({ ageMs: 7 * HOUR, stalledMs: 1 * MIN, logStalledMs: 29 * MIN }).kill, false, 'the log still grew a moment ago');
  assert.equal(v({ ageMs: 7 * HOUR, stalledMs: 1 * MIN, logStalledMs: 31 * MIN }).kill, true, 'a hang that burns CPU');
  assert.equal(v({ ageMs: 5 * HOUR, stalledMs: 1 * MIN, logStalledMs: 31 * MIN }).kill, false, 'busy and under 6 h');
  // orphan
  assert.equal(v({ owner: gone, orphanLooks: 1, ageMs: 10 * HOUR, stalledMs: 10 * HOUR }).kill, false, 'one look is not enough');
  assert.equal(v({ owner: gone, orphanLooks: 2, ageMs: 20 * MIN, stalledMs: 9 * MIN }).kill, false);
  assert.equal(v({ owner: gone, orphanLooks: 2, ageMs: 20 * MIN, stalledMs: 10 * MIN }).kill, true);
  assert.equal(v({ owner: gone, orphanLooks: 2, ageMs: 89 * MIN, stalledMs: 0 }).kill, false);
  assert.equal(v({ owner: gone, orphanLooks: 2, ageMs: 90 * MIN, stalledMs: 0 }).kill, true);
});

test('w791: logFileOf and parsePsClock', () => {
  assert.equal(logFileOf('Unity.exe -batchmode -projectPath D:\\p -logFile Logs\\b.log', 'D:\\p', 'win32'), 'D:\\p\\Logs\\b.log');
  assert.equal(logFileOf('Unity.exe -logFile "D:\\a b\\c.log" -quit', 'D:\\p', 'win32'), 'D:\\a b\\c.log');
  assert.equal(logFileOf('Unity -batchmode -logFile -', '/p', 'darwin'), undefined);
  assert.equal(logFileOf('Unity -batchmode -quit', '/p', 'darwin'), undefined);
  assert.equal(logFileOf('Unity -logFile /x/b.log', '/p', 'darwin'), '/x/b.log');
  assert.equal(parsePsClock('15:02'), 15 * 60_000 + 2_000);
  assert.equal(parsePsClock('1:02:03'), (3600 + 120 + 3) * 1000);
  assert.equal(parsePsClock('2-03:04:05'), (2 * 86400 + 3 * 3600 + 4 * 60 + 5) * 1000);
  assert.equal(parsePsClock('0:12.50'), 12_500);
  assert.equal(parsePsClock('garbage'), undefined);
});

test('w791: inspectProcs reads the real machine (this process: a start time in the past, some CPU)', async () => {
  const platform: UnityPlatform = process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin';
  const [f] = await inspectProcs(platform, [process.pid]);
  assert.equal(f.pid, process.pid);
  assert.ok(f.startedAt && f.startedAt < Date.now() && f.startedAt > Date.now() - 24 * HOUR, `startedAt ${f.startedAt}`);
  assert.ok(f.cpuMs !== undefined && f.cpuMs >= 0);
});

// ---------------------------------------------------------------- w1874: the biscuit case

const BISCUIT = '/home/u/ffw/sandboxes/slot1';
const BLOG = '/home/u/ffw/tmp/ffa-cc1272a4/builds/A-dev.log';
const NODE = '/home/u/.local/node/bin/node';
const LUNITY = '/home/u/Unity/Hub/Editor/6000.3.19f1/Editor/Unity';

/**
 * biscuit, 2026-10-23: worker cc1272a4's build script ran `unity-slot run` from a background shell; the worker ended the
 * shell, and the wrapper (node, pid 2460427) lived on under the user's systemd (pid 9212) with its batch Unity (pid
 * 2460462), hung in a futex wait, its log silent since "Unloading 192 Unused Serialized files". Its tree used 50-80 ms of
 * CPU a minute, with a burst of 2 s or more once. clear_batch kept it: "its parent node (pid 2460427) is alive".
 */
function biscuit(runs: { pid: number; session?: string }[] = []) {
  const m = machine(
    'linux',
    [
      { pid: 9212, ppid: 1, cmd: '/usr/lib/systemd/systemd --user --deserialize=22' },
      { pid: 2460427, ppid: 9212, cmd: `${NODE} /home/u/ffw/app/machine/unitySlots.ts run --label w1789 bench build A-dev -- ${LUNITY} -batchmode -quit -projectPath ${BISCUIT}` },
      { pid: 2460456, ppid: 2460427, cmd: `python3 ${BISCUIT}/scripts/bench/bench_queue.py --lock /home/u/ffw/tmp/bench.lock hold --mode shared --what unity: w1789 bench build A-dev --own` },
      { pid: 2460462, ppid: 2460427, cmd: `${LUNITY} -batchmode -quit -projectPath ${BISCUIT} -buildTarget Linux64 -executeMethod Editor.ShaderBenchBuild.BuildLinux -logFile ${BLOG}` },
      { pid: 2460769, ppid: 2460462, cmd: 'Unity.ILPP.Runner /tmp/ilpp.sock-222c6d51addfd74cf130e74be93e941e' },
    ],
    [
      { id: 'slot1', path: BISCUIT },
      { id: 'slot2', path: '/home/u/ffw/sandboxes/slot2' },
    ],
  );
  const { st } = m;
  st.born.set(9212, st.now - 100 * HOUR);
  for (const p of [2460427, 2460456, 2460462, 2460769]) st.born.set(p, st.now - 22 * MIN);
  st.cpu.set(2460462, 37_700);
  st.mtimes.set(BLOG, st.now - 21 * MIN);
  st.files.add(`${BISCUIT}/Temp/UnityLockfile`);
  return { ...m, reaper: new UnityReaper({ ...m.deps, runs: () => runs }) };
}

/** The same build, its wrapper's caller (the build script) alive. */
function biscuitAlive(runs: { pid: number; session?: string }[]) {
  const m = biscuit(runs);
  m.st.procs = m.st.procs.map((p) => (p.pid === 2460427 ? { ...p, ppid: 500 } : p)).concat({ pid: 500, ppid: 1, cmd: '/bin/bash build4.sh' });
  m.st.born.set(500, m.st.now - HOUR);
  return m;
}

test('w1874: a build under a unity-slot wrapper whose caller is gone is an orphan; idle CPU and a 2.5 s burst are not progress; it is ended with the wrapper', async () => {
  const m = biscuit();
  const { st } = m;
  const first = await m.reaper.look();
  assert.equal(first[0].killed, false);
  assert.match(first[0].line, /its unity-slot wrapper \(pid 2460427\) is left with nobody: the wrapper's parent is systemd \(pid 9212\)/);
  for (let i = 1; i <= 9; i++) {
    st.now += MIN;
    st.cpu.set(2460462, st.cpu.get(2460462)! + (i === 4 ? 2_500 : 70)); // 70 ms a minute, one 2.5 s burst
    const r = await m.reaper.look();
    assert.equal(r[0].killed, false, `minute ${i}: ${r[0].line}`);
  }
  st.now += MIN;
  const r = await m.reaper.look();
  assert.equal(r[0].killed, true, r[0].line);
  assert.match(r[0].line, /orphaned: its unity-slot wrapper/);
  assert.deepEqual(st.killed, [2460769, 2460462, 2460427], 'the build and its ILPP runner, then the wrapper left with nobody');
  assert.match(r[0].line, /ended its unity-slot wrapper \(pid 2460427\), left with nobody/);
  assert.equal(st.files.has(`${BISCUIT}/Temp/UnityLockfile`), false, 'the Library is unlocked');
});

test("w1874: the worker that owns a stalled build ends it at once, without the hour; another worker's ask keeps today's rules", async () => {
  // The run recorded its session: only that session owns it, even from the same sandbox.
  const other = biscuit([{ pid: 2460427, session: 'cc1272a4' }]);
  assert.match(await other.reaper.check({ session: '4d46f2a4', sandbox: 'slot1' }), /No batch build is stuck/);
  assert.deepEqual(other.st.killed, []);

  const owner = biscuit([{ pid: 2460427, session: 'cc1272a4' }]);
  const text = await owner.reaper.check({ session: 'cc1272a4', sandbox: 'slot1' });
  assert.match(text, /Ended 1 stuck batch build/);
  assert.match(text, /stalled, and yours: its log has not grown for 21 min/);
  assert.deepEqual(owner.st.killed, [2460769, 2460462, 2460427]);

  // A wrapper from before w1874 recorded no session: a worker of the build's sandbox owns it, one of another does not.
  const old = biscuit([{ pid: 2460427 }]);
  assert.match(await old.reaper.check({ session: 'zz', sandbox: 'slot2' }), /No batch build is stuck/);
  assert.match(await old.reaper.check({ session: 'cc1272a4', sandbox: 'slot1' }), /Ended 1 stuck batch build/);
});

test('w1874: an owned build with a silent log but a busy tree (a Burst step) is kept until 20 min of silence; an idle one goes at 10 min', async () => {
  const busy = biscuitAlive([{ pid: 2460427, session: 'w' }]);
  busy.st.mtimes.set(BLOG, busy.st.now);
  const ask = () => busy.reaper.check({ session: 'w', sandbox: 'slot1' });
  for (let i = 0; i < 20; i++) {
    busy.st.cpu.set(2460769, (busy.st.cpu.get(2460769) ?? 0) + 60_000); // a core busy
    const t = await ask();
    assert.match(t, /No batch build is stuck/, `minute ${i}: ${t}`);
    busy.st.now += MIN;
  }
  busy.st.cpu.set(2460769, (busy.st.cpu.get(2460769) ?? 0) + 60_000);
  assert.match(await ask(), /stalled, and yours: its log has not grown for 20 min/);

  const idle = biscuitAlive([{ pid: 2460427, session: 'w' }]);
  idle.st.mtimes.set(BLOG, idle.st.now - 2 * MIN);
  const ask2 = () => idle.reaper.check({ session: 'w', sandbox: 'slot1' });
  for (let i = 0; i < 10; i++) {
    assert.match(await ask2(), /No batch build is stuck/, `minute ${i}`);
    idle.st.now += MIN;
  }
  const t = await ask2();
  assert.match(t, /stalled, and yours: running \d+ min, no log or CPU progress for 10 min/);
  assert.deepEqual(idle.st.killed, [2460769, 2460462], 'the wrapper, whose caller is alive, ends by itself and tells it');
  assert.match(t, /its unity-slot wrapper \(pid 2460427\) tells its caller/);
});

test('w1874: verdict: the owner limits; ownerOf looks through a unity-slot wrapper; isSlotWrapper', () => {
  const base: Judged = { ageMs: 15 * MIN, owner: { gone: false, why: 'x' }, orphanLooks: 0, stalledMs: 0, logStalledMs: 0, owned: true };
  const v = (o: Partial<Judged>) => verdict({ ...base, ...o });
  assert.equal(v({ logStalledMs: 19 * MIN, stalledMs: 9 * MIN }).kill, false);
  assert.equal(v({ logStalledMs: 20 * MIN }).kill, true);
  assert.equal(v({ logStalledMs: 12 * MIN, stalledMs: 10 * MIN }).kill, true);
  assert.equal(v({ logStalledMs: 25 * MIN, stalledMs: 25 * MIN, owned: false }).kill, false, "not the asker's: the hour rule");
  assert.match(v({ logStalledMs: 5 * MIN }).why, /as it is yours it is ended once its log is silent for 20 min/);

  const procs: Proc[] = [
    { pid: 9212, ppid: 1, cmd: '/usr/lib/systemd/systemd --user' },
    { pid: 600, ppid: 1, cmd: '/bin/bash build.sh' },
    { pid: 700, ppid: 600, cmd: `${NODE} /x/machine/unitySlots.ts run --label a -- Unity -batchmode` },
    { pid: 701, ppid: 9212, cmd: `${NODE} /x/machine/unitySlots.ts run --label a -- Unity -batchmode` },
    { pid: 702, ppid: 9212, cmd: 'python3 scripts/unity_slot.py run --label b -- Unity -batchmode' },
  ];
  assert.equal(ownerOf({ pid: 20, ppid: 700 }, procs, new Map(), 'linux').gone, false);
  assert.match(ownerOf({ pid: 20, ppid: 700 }, procs, new Map(), 'linux').why, /wrapper \(pid 700\) is there, and the wrapper's parent bash/);
  assert.equal(ownerOf({ pid: 20, ppid: 701 }, procs, new Map(), 'linux').gone, true);
  assert.equal(ownerOf({ pid: 20, ppid: 702 }, procs, new Map(), 'linux').gone, true);
  assert.equal(isSlotWrapper('"C:\\node\\node.exe" "D:\\ffw\\app\\machine\\unitySlots.ts" run -- Unity.exe'), true);
  assert.equal(isSlotWrapper('/bin/sh /home/u/.local/bin/unity-slot run --label x -- Unity'), true);
  assert.equal(isSlotWrapper('/bin/bash scripts/build_player.sh'), false);
  assert.equal(isSlotWrapper(`${NODE} /x/machine/unitySlots.ts status`), false);
});

test('w1874: an owned build that writes no log file (stdout) is never ended for a silent log alone, only with an idle tree', () => {
  const base: Judged = { ageMs: 40 * MIN, owner: { gone: false, why: 'x' }, orphanLooks: 0, stalledMs: 1 * MIN, logStalledMs: 40 * MIN, owned: true, logKnown: false };
  assert.equal(verdict(base).kill, false, 'busy, its log unknown: kept');
  assert.equal(verdict({ ...base, stalledMs: 10 * MIN }).kill, true, 'idle for 10 min: ended');
});
