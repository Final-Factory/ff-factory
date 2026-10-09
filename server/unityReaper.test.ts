import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REAP, UnityReaper, inspectProcs, logFileOf, ownerOf, parsePsClock, verdict, type Judged, type ProcFacts, type ReaperDeps } from '../machine/unityReaper.ts';
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
