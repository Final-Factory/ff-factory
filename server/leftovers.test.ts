import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LEFTOVER, LeftoverReaper, forPerson, launchForPerson, personEnv, waitLoop, callerPids, envFrom, installLeftoversShim, kindOf, macEnvLine, orphanVerdict, ownLeftovers, personGames, readEnvs, readLeases, realInspect, sameRoot, sessionVerdict, sessionTempRoot, msysParents, slotOf, tempSessionInArgs, tempSessionOf, type LeftoverDeps, type PlayerLease, type ProcEnv } from '../machine/leftovers.ts';
import { realDeps as realUnityDeps, type Proc, type UnityPlatform } from '../machine/unity.ts';
import { playerText, unitySlotsLine } from '../shared/fleet.ts';

/**
 * What a stopped worker left running (w1196, w1197; machine/leftovers.ts). The kill cases are biscuit's of 2026-10-13: pid
 * 2459040, a headless player in slot1-1 under Xvfb :101, left by worker a33e1437 (w1072) 27 h earlier, and the same of
 * worker 1290a5e0 (w1025) in slot2-0, plus an orphan player nobody names. The keep cases are what must never be ended: a
 * live worker's player, one whose worker set a check-in, an interactive editor, the main clone, another machine's.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const ROOT = '/home/u/ffw';
const PLAYERS = `${ROOT}/players`;
const TMP = `${ROOT}/tmp`;
const player = (slot: string) => `${PLAYERS}/${slot}/player/finalfactory.x86_64 -batchmode -ffAutomation -logFile ${TMP}/ffa-x/p.log`;
const xvfb = (session: string, display: number) => `${TMP}/ffa-${session}/xv/root/usr/bin/Xvfb :${display} -screen 0 1280x720x24 -nolisten tcp`;

interface Session {
  live?: boolean;
  resumable?: boolean;
  wakeAt?: number;
  sandbox?: string;
  /** When its current agent host started (w3673). */
  hostSince?: number;
}

/** A fake machine: processes with their environments, start times and CPU, sessions, leases and a clock. */
function machine(procs: (Proc & { env?: ProcEnv; born?: number; cpu?: number })[], o: { platform?: UnityPlatform; sessions?: Record<string, Session>; leases?: PlayerLease[]; ready?: boolean; known?: string[]; personPlay?: boolean; root?: string } = {}) {
  const t0 = 1_000 * HOUR;
  for (const p of procs) p.born ??= t0 - 30 * HOUR;
  const st = {
    procs,
    now: t0,
    sessions: o.sessions ?? {},
    leases: o.leases ?? [],
    ready: o.ready ?? true,
    files: new Set<string>(),
    signals: [] as string[],
    events: [] as string[],
    logs: [] as string[],
  };
  const deps: LeftoverDeps = {
    platform: o.platform ?? 'linux',
    machineId: 'biscuit',
    ...(o.root ? { root: o.root } : {}),
    procs: async () => st.procs.map(({ pid, ppid, cmd, name }) => ({ pid, ppid, cmd, ...(name ? { name } : {}) })),
    envOf: async (pids) => new Map(st.procs.filter((p) => pids.includes(p.pid) && p.env).map((p) => [p.pid, p.env!])),
    inspect: async (pids) => st.procs.filter((p) => pids.includes(p.pid)).map((p) => ({ pid: p.pid, startedAt: p.born, cpuMs: p.cpu ?? 0 })),
    sessionLive: (id) => !!st.sessions[id]?.live,
    sessionKnown: (id) => id in st.sessions || (o.known ?? []).includes(id),
    resumable: (id) => !!st.sessions[id]?.resumable,
    wakeAt: (id) => st.sessions[id]?.wakeAt,
    hostSince: (id) => st.sessions[id]?.hostSince,
    liveSandboxes: () => new Set(Object.values(st.sessions).filter((s) => s.live && s.sandbox).map((s) => s.sandbox!)),
    ready: () => st.ready,
    slotRoots: () => [PLAYERS],
    tempRoot: () => TMP,
    leases: () => st.leases,
    protectedPaths: () => [`${ROOT}/repo`, `${ROOT}/daemon`],
    places: () => [1, 2, 3].map((k) => ({ id: `slot${k}`, path: `${ROOT}/sandboxes/slot${k}` })),
    // As on biscuit: the daemon (100) runs under `systemd --user` (9212), which every orphan here is reparented to too.
    self: () => [100, 9212],
    host: 'biscuit',
    kill: (pid, sig) => {
      st.signals.push(`${sig} ${pid}`);
      // A player and an Xvfb end on SIGTERM; a process named "stubborn" only on SIGKILL; one named "unkillable" on neither.
      const p = st.procs.find((x) => x.pid === pid);
      if (p && /unkillable/.test(p.cmd)) return sig === 'SIGKILL' ? 'taskkill: ERROR: The process with PID ' + pid + ' could not be terminated. Reason: Access is denied.' : undefined;
      if (p && (sig === 'SIGKILL' || !/stubborn/.test(p.cmd))) st.procs = st.procs.filter((x) => x.pid !== pid);
    },
    exists: (p) => st.files.has(p),
    remove: (p) => void st.files.delete(p),
    sleep: async () => undefined,
    now: () => st.now,
    log: (l) => void st.logs.push(l),
    onEvent: (t) => void st.events.push(t),
    personPlay: () => !!o.personPlay,
  };
  const reaper = new LeftoverReaper(deps);
  /** One look `min` minutes after the last. */
  const look = async (min = 1) => {
    st.now += min * MIN;
    return reaper.look();
  };
  return { st, reaper, look, alive: (pid: number) => st.procs.some((p) => p.pid === pid) };
}

const SYSTEMD = { pid: 9212, ppid: 1, cmd: '/usr/lib/systemd/systemd --user' };
const DAEMON = { pid: 100, ppid: 9212, cmd: `/usr/bin/node ${ROOT}/daemon/app/machine/daemon.ts ${ROOT}/daemon/daemon.json` };
const env = (session: string, sandbox = 'slot1'): ProcEnv => ({ session, sandbox, machine: 'biscuit' });

// ---------------------------------------------------------------- 1. a stopped worker's player and its display end

test('biscuit, 2026-10-13: the player and Xvfb a stopped worker left end within the grace; the event names what, why and whose', async () => {
  const m = machine(
    [
      SYSTEMD,
      DAEMON,
      { pid: 2459040, ppid: 9212, cmd: player('slot1-1'), env: env('a33e1437') },
      { pid: 2459001, ppid: 9212, cmd: xvfb('a33e1437', 101), env: env('a33e1437') },
      { pid: 2459002, ppid: 9212, cmd: `${TMP}/ffa-a33e1437/xv/root/usr/bin/openbox`, env: env('a33e1437') },
      { pid: 2311211, ppid: 9212, cmd: player('slot2-0'), env: env('1290a5e0', 'slot2') },
      { pid: 2311200, ppid: 9212, cmd: xvfb('1290a5e0', 62), env: env('1290a5e0', 'slot2') },
    ],
    { sessions: { a33e1437: {}, '1290a5e0': {} } },
  );
  // First sight: the clock starts; nothing ends inside the grace (two minutes: neither worker has a request waiting).
  assert.deepEqual(await m.look(0), []);
  const p = m.reaper.report().players.find((x) => x.pid === 2459040)!;
  assert.equal(p.owner, 'stopped');
  assert.equal(p.slot, 'slot1-1');
  assert.equal(p.session, 'a33e1437');
  assert.equal(p.ageMin, 30 * 60);
  assert.equal(p.endsInMin, 2);
  assert.deepEqual(await m.look(1), []);
  const ended = await m.look(1);
  assert.equal(ended.length, 2, 'one end per worker');
  for (const pid of [2459040, 2459001, 2459002, 2311211, 2311200]) assert.ok(!m.alive(pid), `pid ${pid} ended`);
  assert.ok(m.alive(9212) && m.alive(100), 'systemd and the daemon untouched');
  const a = m.st.events.find((e) => e.includes('a33e1437'))!;
  assert.match(a, /ended 3 process\(es\) left by worker a33e1437 \(sandbox slot1\)/);
  assert.match(a, /game player slot1-1 pid 2459040/);
  assert.match(a, /Xvfb pid 2459001/);
  assert.match(a, /openbox pid 2459002/);
  assert.match(a, /its worker stopped 2 min ago and no request waits for it/);
  // Children first, then SIGTERM only: both end on it.
  assert.ok(m.st.signals.every((s) => s.startsWith('SIGTERM')));
  assert.match(m.st.logs.join('\n'), /Command lines: .*finalfactory\.x86_64/);
});

test('a worker that a request still waits for (CI, a person) keeps what it left 10 min, then it ends; SIGKILL for what ignores SIGTERM', async () => {
  const m = machine([SYSTEMD, { pid: 50, ppid: 9212, cmd: player('slot3-0'), env: env('w3', 'slot3') }, { pid: 51, ppid: 9212, cmd: '/usr/bin/stubborn-ffmpeg -i x', env: env('w3', 'slot3') }], {
    sessions: { w3: { resumable: true } },
  });
  await m.look(0);
  for (let i = 0; i < 9; i++) assert.deepEqual(await m.look(1), [], `minute ${i + 1}: kept`);
  assert.equal(m.reaper.report().players[0].endsInMin, 1);
  const [e] = await m.look(1);
  assert.deepEqual(e.pids.sort(), [50, 51]);
  assert.ok(!m.alive(50) && !m.alive(51));
  assert.deepEqual(m.st.signals, ['SIGTERM 50', 'SIGTERM 51', 'SIGKILL 51']);
  assert.match(e.line, /a request still waits for it, with no check-in pending.*1 needed SIGKILL/);
});

test('w1983: a process SIGKILL does not end is said so once, with why, and tried again an hour later, not at every look', async () => {
  // LothDesktop, 2026-10-24: "ended 1 process(es) left by worker 5322f111 (sandbox slot6): gh pid 24280 ... 1 needed SIGKILL"
  // every minute from 04:44Z, the same pid each time: taskkill /F failed and the watch never looked again.
  const m = machine([SYSTEMD, { pid: 24280, ppid: 9212, cmd: '/usr/bin/gh unkillable pr view', env: env('5322f111', 'slot6') }], { sessions: { '5322f111': {} } });
  await m.look(0);
  await m.look(1);
  const [e] = await m.look(1);
  assert.deepEqual(m.st.signals, ['SIGTERM 24280', 'SIGKILL 24280']);
  assert.deepEqual(e.pids, []);
  assert.deepEqual(e.stuck, [24280]);
  assert.match(e.line, /^could not end 1 process\(es\) left by worker 5322f111 \(sandbox slot6\), still running after SIGKILL: gh pid 24280 \(taskkill: ERROR: .*Access is denied\.\); tried again in 60 min\. Why: its worker stopped/);
  assert.doesNotMatch(e.line, /^ended|needed SIGKILL/);
  for (let i = 0; i < 59; i++) assert.deepEqual(await m.look(1), [], `minute ${i + 1} after: not tried again`);
  assert.equal(m.st.signals.length, 2);
  const [again] = await m.look(1);
  assert.deepEqual(again.stuck, [24280], 'an hour later it is tried again');
  assert.equal(m.st.signals.length, 4);
  // Gone at last: forgotten, and a new process under its pid is a new one.
  m.st.procs = m.st.procs.filter((p) => p.pid !== 24280);
  assert.deepEqual(await m.look(1), []);
});

test('every other process a stopped worker left goes with it (w1197): a gnome session, ffmpeg, a batch build and its lock', async () => {
  const m = machine(
    [
      SYSTEMD,
      { pid: 60, ppid: 9212, cmd: 'dbus-daemon --nofork --print-address 4 --session', env: env('bd1baf7b', 'slot3') },
      { pid: 61, ppid: 9212, cmd: `/usr/libexec/gvfsd-fuse ${TMP}/ffa-bd1baf7b/w994/gs/gvfs -f`, env: env('bd1baf7b', 'slot3') },
      { pid: 62, ppid: 9212, cmd: '/usr/bin/ffmpeg -f x11grab -i :99 clip.mp4', env: env('bd1baf7b', 'slot3') },
      { pid: 63, ppid: 9212, cmd: `/opt/Unity/Hub/Editor/6000.3.19f1/Editor/Unity -batchmode -quit -projectPath ${ROOT}/sandboxes/slot3 -executeMethod Build.Linux`, env: env('bd1baf7b', 'slot3') },
    ],
    { sessions: { bd1baf7b: {} } },
  );
  m.st.files.add(`${ROOT}/sandboxes/slot3/Temp/UnityLockfile`);
  await m.look(0);
  await m.look(1);
  const [e] = await m.look(1);
  assert.deepEqual(e.pids.sort(), [60, 61, 62, 63]);
  assert.match(e.line, /batch Unity pid 63/);
  assert.ok(!m.st.files.has(`${ROOT}/sandboxes/slot3/Temp/UnityLockfile`), 'the killed build\'s stale lock goes');
  await m.look(1);
  assert.equal(m.reaper.report().others, 0);
});

// ---------------------------------------------------------------- 2. an orphan with no owner ends by the safety net

test('the safety net: a player in a slot that names no session, whose starter is gone and whose slot nobody holds, ends 10 min after first seen', async () => {
  const m = machine([SYSTEMD, { pid: 70, ppid: 9212, cmd: player('slot2-1') }], { sessions: {} });
  await m.look(0);
  assert.equal(m.reaper.report().players[0].owner, 'orphan');
  assert.equal(m.reaper.report().players[0].endsInMin, 10);
  assert.match(unitySlotsLine({ used: 0, interactive: 0, batch: 0, outside: 0, players: 1, playerList: m.reaper.report().players, overLimit: false, ramLimitPct: 85, waiting: [], granted: [], at: '' }), /1 game player \(not counted\): pid 70 slot2-1, ORPHAN \(no owner: ends in 10 min\), up 30\.0 h/);
  for (let i = 0; i < 9; i++) assert.deepEqual(await m.look(1), []);
  const [e] = await m.look(1);
  assert.deepEqual(e.pids, [70]);
  assert.match(e.line, /left by no worker: game player slot2-1 pid 70.*an orphan: it names no session, its starter is gone and nobody holds its slot/);
});

test('an orphan beside a live player of the same build (one slot, two leases) is still an orphan; a remote run\'s lease holds it', async () => {
  const m = machine([SYSTEMD, { pid: 71, ppid: 9212, cmd: player('slot0') }, { pid: 72, ppid: 9212, cmd: player('slot0'), env: env('me') }], {
    sessions: { me: { live: true } },
    leases: [{ slot: 'slot0', pid: 72, host: 'biscuit', time: 1_000 * 3600 }],
  });
  await m.look(0);
  assert.equal(m.reaper.report().players.find((p) => p.pid === 71)!.owner, 'orphan');
  m.st.leases.push({ slot: 'slot0', pid: 5, host: 'm5', time: m.st.now / 1000 });
  await m.look(1);
  assert.equal(m.reaper.report().players.find((p) => p.pid === 71)!.owner, 'held');
});

test('an orphan player is kept while anything may own it: a live starter, a live lease of another run, a live worker in its sandbox', () => {
  const now = 10 * HOUR;
  assert.equal(orphanVerdict({ parent: 'python3 (pid 12)', firstSeen: 0, now }).end, false);
  assert.equal(orphanVerdict({ heldBy: 'beast pid 4', firstSeen: 0, now }).end, false);
  assert.equal(orphanVerdict({ sandboxLive: 'slot2', firstSeen: 0, now }).end, false);
  assert.equal(orphanVerdict({ firstSeen: now - LEFTOVER.ORPHAN_GRACE_MS + 1, now }).end, false);
  assert.equal(orphanVerdict({ firstSeen: now - LEFTOVER.ORPHAN_GRACE_MS, now }).end, true);
});

test('a player whose lease names its session (Windows, a Mac without ps -E) follows that session; a run from a worker\'s temp folder follows its path', async () => {
  const m = machine(
    [SYSTEMD, { pid: 80, ppid: 9212, cmd: player('slot1-0') }, { pid: 81, ppid: 9212, cmd: xvfb('cafe1234', 77) }],
    { sessions: { cafe1234: {}, beef5678: {} }, leases: [{ slot: 'slot1-0', pid: 80, host: 'biscuit', session: 'beef5678', sandbox: `${ROOT}/sandboxes/slot1`, time: 0 }] },
  );
  await m.look(0);
  assert.equal(m.reaper.report().players[0].session, 'beef5678');
  await m.look(1);
  const ended = await m.look(1);
  assert.deepEqual(ended.map((e) => e.session).sort(), ['beef5678', 'cafe1234']);
});

test('w1575, Windows: a Git Bash tail naming a stopped worker\'s temp folder ends once its starter is gone; one a live shell runs stays; an import worker whose editor is gone ends', async () => {
  // As on beast and LothDesktop, 2026-10-19: tails of 10-15 whose shells were gone held stopped workers' folders, and import
  // workers of slot2 ran a day after its editor stopped. Git Bash programs show no environment on Windows (measured).
  const tail = (s: string) => `"C:\\Program Files\\Git\\usr\\bin\\tail.exe" -n +1 -f ${TMP}/ffa-${s}/run.log`;
  const unity = '"C:\\Program Files\\Unity\\Hub\\Editor\\6000.3.0f1\\Editor\\Unity.exe"';
  const m = machine(
    [
      { pid: 90, ppid: 49932, cmd: tail('824be148'), name: 'tail.exe' },
      { pid: 91, ppid: 92, cmd: tail('824be148'), name: 'tail.exe' },
      { pid: 92, ppid: 7, cmd: '"C:\\Program Files\\Git\\usr\\bin\\bash.exe"', name: 'bash.exe' },
      { pid: 93, ppid: 33000, cmd: `${unity} -adb2 -batchMode -noUpm -name AssetImportWorker0 -projectPath F:/ffw/sandboxes/slot2 -logFile ${TMP}/ffa-29bac897/import.log`, name: 'Unity.exe' },
      { pid: 94, ppid: 95, cmd: `${unity} -adb2 -batchMode -noUpm -name AssetImportWorker1 -projectPath F:/ffw/sandboxes/slot1`, name: 'Unity.exe' },
      { pid: 95, ppid: 7, cmd: `${unity} -projectPath F:/ffw/sandboxes/slot1`, name: 'Unity.exe' },
    ],
    { platform: 'win32', sessions: { '824be148': {} } },
  );
  await m.look(0);
  const ended = [];
  for (let i = 0; i < 12; i++) ended.push(...(await m.look(1)));
  assert.deepEqual(ended.flatMap((e) => e.pids).sort((a, b) => a - b), [90, 93], 'the orphan tail and the orphan import worker');
  assert.ok(ended.some((e) => e.session === '824be148' && e.pids.includes(90)), "the tail is the stopped worker's");
  assert.ok(m.alive(91) && m.alive(92), 'a tail a live shell runs stays, whatever folder it reads');
  assert.ok(m.alive(94) && m.alive(95), "a running editor and its import worker are never touched");
});

// ---------------------------------------------------------------- 3. what is never ended

test('a live worker\'s player and Xvfb are never ended, however long they run', async () => {
  const m = machine([SYSTEMD, { pid: 90, ppid: 9212, cmd: player('slot2-0'), env: env('eb0f39d4', 'slot2') }, { pid: 91, ppid: 9212, cmd: xvfb('eb0f39d4', 99), env: env('eb0f39d4', 'slot2') }], {
    sessions: { eb0f39d4: { live: true, sandbox: 'slot2' } },
  });
  for (let i = 0; i < 48; i++) assert.deepEqual(await m.look(30), []);
  assert.ok(m.alive(90) && m.alive(91));
  assert.deepEqual(m.st.signals, []);
  assert.equal(m.reaper.report().players[0].owner, 'live');
  assert.equal(playerText(m.reaper.report().players[0]), 'pid 90 slot2-0, worker eb0f39d4 in slot2 (running), up 54.0 h');
  // It stops: the clock starts then, not at the player's start.
  m.st.sessions.eb0f39d4.live = false;
  assert.deepEqual(await m.look(1), []);
  assert.deepEqual(await m.look(1), []);
  assert.equal((await m.look(1)).length, 1);
});

test('a worker that set a check-in keeps its run until the check-in is due plus 10 min; back live, its clock starts over', async () => {
  const m = machine([SYSTEMD, { pid: 95, ppid: 9212, cmd: player('slot1-0'), env: env('soak') }], { sessions: { soak: { resumable: true } } });
  m.st.sessions.soak.wakeAt = m.st.now + 3 * HOUR;
  await m.look(0);
  for (let i = 0; i < 18; i++) assert.deepEqual(await m.look(10), [], `kept at ${(i + 1) * 10} min`);
  assert.match(m.reaper.report().players[0].endsInMin + '', /^1[0-9]$/);
  // The check-in fired and resumed it: live again, then stopped once more with no check-in.
  m.st.sessions.soak = { live: true };
  await m.look(1);
  m.st.sessions.soak = { resumable: true };
  for (let i = 0; i < 10; i++) assert.deepEqual(await m.look(1), []);
  assert.equal((await m.look(1)).length, 1);
});

test('never ended: an interactive editor and what it started, the main clone, the daemon\'s own folder, another machine\'s or an unknown session\'s process, anything before the welcome', async () => {
  const editor = `/opt/Unity/Hub/Editor/6000.3.19f1/Editor/Unity -projectPath ${ROOT}/repo -logFile x.log`;
  const procs = [
    SYSTEMD,
    DAEMON,
    { pid: 200, ppid: 9212, cmd: editor, env: env('gone') },
    { pid: 201, ppid: 200, cmd: '/opt/Unity/Hub/Editor/6000.3.19f1/Editor/Data/Resources/PackageManager/Server/UnityPackageManager server -s 200', env: env('gone') },
    { pid: 202, ppid: 9212, cmd: `/opt/Unity/Hub/Editor/6000.3.19f1/Editor/Unity -projectPath ${ROOT}/sandboxes/slot1`, env: env('gone') },
    { pid: 203, ppid: 9212, cmd: `git -C ${ROOT}/repo fetch`, env: env('gone') },
    { pid: 204, ppid: 9212, cmd: `/usr/bin/node ${ROOT}/daemon/app/machine/agentHost.ts ${ROOT}/daemon/hosts/gone`, env: env('gone') },
    { pid: 205, ppid: 9212, cmd: player('slot1-0'), env: { session: 'gone', machine: 'lothdesktop' } },
    { pid: 206, ppid: 9212, cmd: '/usr/bin/claude --model opus', env: { session: 'orch1234' } },
    { pid: 207, ppid: 9212, cmd: '/snap/firefox/x/firefox' },
  ];
  const m = machine(procs, { sessions: { gone: {} } });
  for (let i = 0; i < 30; i++) await m.look(10);
  assert.deepEqual(m.st.signals, []);
  // A known session without a machine id is this machine's; its process ends.
  const known = machine([SYSTEMD, { pid: 300, ppid: 9212, cmd: '/usr/bin/sleep 999', env: { session: 'std1' } }], { sessions: {}, known: ['std1'] });
  for (let i = 0; i < 4; i++) await known.look(1);
  assert.ok(!known.alive(300));
  // Before the portal's welcome nothing ends: who is live is not known yet.
  const early = machine([SYSTEMD, { pid: 400, ppid: 9212, cmd: player('slot1-0'), env: env('gone') }], { sessions: { gone: {} }, ready: false });
  for (let i = 0; i < 30; i++) await early.look(10);
  assert.ok(early.alive(400));
  early.st.ready = true;
  assert.equal((await early.look(1)).length, 1);
});

test("w3714, BEAST 2026-11-08: a second FF Factory's worker on the same computer (same machine id, another FF_WORKER_ROOT) is never this daemon's; its own root's is, and one with no root is judged as before", async () => {
  const procs = [
    SYSTEMD,
    // Ben's Light Tree daemon's worker: the live daemon ended its claude four times in 8 min before this.
    { pid: 500, ppid: 9212, cmd: '/usr/bin/claude --model opus', env: { session: 'a2148455', sandbox: 'slot1', machine: 'biscuit', root: '/home/u/ben-factory/worker' } },
    { pid: 501, ppid: 9212, cmd: '/usr/bin/sleep 999', env: { session: 'gone', sandbox: 'slot1', machine: 'biscuit', root: `${ROOT}/` } },
    { pid: 502, ppid: 9212, cmd: '/usr/bin/sleep 998', env: env('gone') },
  ];
  const m = machine(procs, { sessions: { gone: {} }, root: ROOT });
  for (let i = 0; i < 30; i++) await m.look(10);
  assert.ok(m.alive(500), "another daemon's worker is spared");
  assert.ok(!m.alive(501), "this daemon's own root's leftover ends");
  assert.ok(!m.alive(502), 'a leftover with no root (a worker from before w3714) ends as before');
  assert.ok(!m.st.signals.some((s) => s.endsWith(' 500')));
  assert.equal(sameRoot('F:\\ffw', 'f:/ffw/', 'win32'), true);
  assert.equal(sameRoot('F:\\ffw', 'F:/ffw/ben-factory/worker', 'win32'), false);
  assert.equal(sameRoot('/home/u/FFW', '/home/u/ffw', 'linux'), false);
  assert.equal(sameRoot(undefined, '/home/u/ffw', 'linux'), true);
  assert.equal(sameRoot('/home/u/ffw', undefined, 'darwin'), true);
  assert.deepEqual(envFrom(['FF_SESSION_ID=a2148455', 'FF_MACHINE_ID=beast', 'FF_WORKER_ROOT=F:\\ffw\\ben-factory\\worker']), { session: 'a2148455', machine: 'beast', root: 'F:\\ffw\\ben-factory\\worker' });
  assert.deepEqual(envFrom(['FF_SESSION_ID=a', 'FF_WORKER_ROOT=']), { session: 'a' });
  assert.deepEqual(macEnvLine('  812 /usr/bin/claude TERM=xterm FF_SESSION_ID=d51d7def FF_MACHINE_ID=m3 FF_WORKER_ROOT=/Users/b/ben-factory/worker')?.env, { session: 'd51d7def', machine: 'm3', root: '/Users/b/ben-factory/worker' });
});

test('w2410, BEAST 2026-10-27: a stopped worker\'s own `unity-slot run` names the daemon\'s folder, yet it and its bench ticket\'s helper end like its other leftovers; the agent host is still spared', async () => {
  // Worker d2d9c644's run waited for ticket t00002471 from 12:23 UTC; at 14:03 UTC the reaper ended only the bash and sh
  // around it, and the run (with its Unity slot and its waiting ticket) outlived its worker by hours.
  const slotRun = { pid: 600, ppid: 9212, cmd: `/usr/bin/node --experimental-strip-types ${ROOT}/daemon/app/machine/unitySlots.ts run --label "w2367 release base for launch clip" -- unity`, env: env('d2d9c644', 'slot4') };
  const helper = { pid: 601, ppid: 600, cmd: `python3 ${ROOT}/sandboxes/slot4/scripts/bench/bench_queue.py --lock ${ROOT}/tmp/bench.lock hold --mode shared --what "unity: w2367" --owner-pid 600`, env: env('d2d9c644', 'slot4') };
  const host = { pid: 602, ppid: 9212, cmd: `/usr/bin/node ${ROOT}/daemon/app/machine/agentHost.ts ${ROOT}/daemon/hosts/d2d9c644`, env: env('d2d9c644', 'slot4') };
  const m = machine([SYSTEMD, DAEMON, slotRun, helper, host], { sessions: { d2d9c644: { resumable: true } } });
  await m.look(0);
  for (let i = 0; i < 9; i++) assert.deepEqual(await m.look(1), [], `minute ${i + 1}: kept (a request still waits for it)`);
  await m.look(1);
  assert.ok(!m.alive(600) && !m.alive(601), 'the run and its ticket helper ended');
  assert.ok(m.alive(602) && m.alive(100), 'the agent host and the daemon untouched');
  assert.match(m.st.events.join('\n'), /left by worker d2d9c644/);
  // A check-in ahead keeps them, as for any process of a worker coming back to look at its job.
  const back = machine([SYSTEMD, DAEMON, { ...slotRun }, { ...helper }], { sessions: { d2d9c644: { resumable: true, wakeAt: 1_000 * HOUR + 60 * MIN } } });
  for (let i = 0; i < 30; i++) await back.look(1);
  assert.ok(back.alive(600) && back.alive(601), 'kept until its check-in is due');
  // And never while its worker runs (between turns too).
  const live = machine([SYSTEMD, DAEMON, { ...slotRun }, { ...helper }], { sessions: { d2d9c644: { live: true } } });
  for (let i = 0; i < 30; i++) await live.look(10);
  assert.deepEqual(live.st.signals, []);
});

test('a shared build server a stopped worker started ends only once it is idle: another worker\'s build may be compiling through it', async () => {
  const vbcs = { pid: 500, ppid: 9212, cmd: 'dotnet exec /opt/Unity/Editor/Data/DotNetSdkRoslyn/VBCSCompiler.dll -pipename:abc', env: env('gone'), cpu: 0 };
  const m = machine([SYSTEMD, vbcs], { sessions: { gone: {} } });
  await m.look(0);
  for (let i = 0; i < 5; i++) {
    m.st.procs.find((p) => p.pid === 500)!.cpu! += 30_000;
    assert.deepEqual(await m.look(1), [], 'busy: kept');
  }
  assert.equal((await m.look(1)).length, 1, 'idle for a minute: ended');
});

// ---------------------------------------------------------------- the pure pieces

test('sessionVerdict: live keeps; a done worker 2 min, a waited-for one 10 min, a check-in until it is due plus 10 min', () => {
  const now = 100 * HOUR;
  assert.equal(sessionVerdict({ live: true, resumable: false, stoppedSince: 0, now }).end, false);
  assert.equal(sessionVerdict({ live: false, resumable: false, stoppedSince: now - LEFTOVER.DONE_GRACE_MS + 1, now }).end, false);
  assert.equal(sessionVerdict({ live: false, resumable: false, stoppedSince: now - LEFTOVER.DONE_GRACE_MS, now }).end, true);
  assert.equal(sessionVerdict({ live: false, resumable: true, stoppedSince: now - 9 * MIN, now }).end, false);
  assert.equal(sessionVerdict({ live: false, resumable: true, stoppedSince: now - 10 * MIN, now }).end, true);
  const w = sessionVerdict({ live: false, resumable: true, stoppedSince: now - 5 * HOUR, wakeAt: now - 9 * MIN, now });
  assert.equal(w.end, false);
  assert.match(w.why, /its check-in comes due at/);
  assert.equal(sessionVerdict({ live: false, resumable: true, stoppedSince: now - 5 * HOUR, wakeAt: now - 10 * MIN, now }).end, true);
});

test('sessionVerdict (w3715): a stopped worker that holds a bench ticket loses its check-in grace; a live one keeps it', () => {
  const now = 100 * HOUR;
  const far = { wakeAt: now + 5 * HOUR, resumable: true };
  // a stopped holder with a far check-in ends DONE_GRACE after it stopped
  const kept = sessionVerdict({ live: false, ...far, holdsTicket: true, stoppedSince: now - LEFTOVER.DONE_GRACE_MS + 1, now });
  assert.equal(kept.end, false);
  assert.equal(kept.until, now + 1);
  assert.match(kept.why, /holds bench ticket\(s\)/);
  const ended = sessionVerdict({ live: false, ...far, holdsTicket: true, stoppedSince: now - LEFTOVER.DONE_GRACE_MS, now });
  assert.equal(ended.end, true);
  assert.match(ended.why, /holds bench ticket\(s\)/);
  // without a ticket the check-in still keeps it, and so does a waiting request
  const woken = sessionVerdict({ live: false, ...far, holdsTicket: false, stoppedSince: now - HOUR, now });
  assert.equal(woken.end, false);
  assert.match(woken.why, /its check-in comes due at/);
  assert.equal(sessionVerdict({ live: false, ...far, stoppedSince: now - HOUR, now }).end, false);
  // a live holder is kept
  assert.equal(sessionVerdict({ live: true, ...far, holdsTicket: true, stoppedSince: now - 5 * HOUR, now }).end, false);
});

test('kinds, slots, temp paths and environments as each platform writes them', () => {
  const none = new Set<number>();
  assert.equal(kindOf({ pid: 1, ppid: 0, cmd: player('slot1-1') }, 'linux', none), 'player');
  assert.equal(kindOf({ pid: 1, ppid: 0, cmd: 'D:\\ffw\\players\\slot2-0\\player\\finalfactory.exe -batchmode', name: 'finalfactory.exe' }, 'win32', none), 'player');
  assert.equal(kindOf({ pid: 1, ppid: 0, cmd: '/Users/b/ffw/players/slot0/player/finalfactory.app/Contents/MacOS/finalfactory -x' }, 'darwin', none), 'player');
  assert.equal(kindOf({ pid: 1, ppid: 0, cmd: xvfb('a', 1) }, 'linux', none), 'display');
  assert.equal(kindOf({ pid: 1, ppid: 0, cmd: 'Xvfb :99 -screen 0 1x1x24' }, 'linux', none), 'display');
  assert.equal(kindOf({ pid: 1, ppid: 0, cmd: '"C:\\Program Files\\dotnet\\dotnet.exe" "C:\\x\\MSBuild.dll" /nologo /nodemode:1 /nodeReuse:true', name: 'dotnet.exe' }, 'win32', none), 'server');
  assert.equal(kindOf({ pid: 1, ppid: 0, cmd: '/usr/bin/ffmpeg -i x' }, 'linux', none), 'process');
  assert.equal(slotOf(player('slot1-1'), [PLAYERS], 'linux'), 'slot1-1');
  assert.equal(slotOf('"D:\\work\\ffw\\players\\slot3-0\\player\\finalfactory.exe" -x', ['D:/work/ffw/players'], 'win32'), 'slot3-0');
  assert.equal(slotOf('/other/players/slot1-1/player/finalfactory.x86_64', [PLAYERS], 'linux'), undefined);
  assert.equal(tempSessionOf(xvfb('a33e1437', 101), TMP, 'linux'), 'a33e1437');
  assert.equal(tempSessionOf(`/usr/bin/Xvfb ${TMP}/ffa-a33e1437/x`, TMP, 'linux'), undefined, 'only the program\'s own path counts');
  assert.equal(tempSessionOf('"F:\\ffw\\tmp\\ffa-9abc\\tools\\ffmpeg.exe" -i x', 'F:\\ffw\\tmp', 'win32'), '9abc');
  // w1575: Git Bash programs on Windows show no environment; the temp folder they name is the owner (beast, 2026-10-19).
  const tail = '"C:\\Program Files\\Git\\usr\\bin\\tail.exe" -n +1 -f /f/ffw/tmp/ffa-824be148/before1-155347/runner.log';
  assert.equal(tempSessionInArgs(tail, 'F:\\ffw\\tmp', 'win32'), '824be148');
  assert.equal(tempSessionInArgs('tail.exe -f F:\\ffw\\tmp\\ffa-0a5ecf34\\mpaudit\\audit.log', 'F:\\ffw\\tmp', 'win32'), '0a5ecf34');
  assert.equal(tempSessionInArgs('x.exe --log=/f/ffw/tmp/ffa-aa11/x.log', 'F:/ffw/tmp', 'win32'), 'aa11');
  assert.equal(tempSessionInArgs('diff /f/ffw/tmp/ffa-aa11/a /f/ffw/tmp/ffa-bb22/b', 'F:/ffw/tmp', 'win32'), undefined, 'two sessions named: nobody');
  assert.equal(tempSessionInArgs('tail -f /g/ffw/tmp/ffa-aa11/a /x/f/ffw/tmp/ffa-cc33/b', 'F:/ffw/tmp', 'win32'), undefined, 'another drive, or the path inside another');
  assert.equal(tempSessionInArgs(tail, 'F:\\ffw\\tmp', 'linux'), undefined, 'Windows only: elsewhere the environment says');
  assert.deepEqual(envFrom(['PATH=/bin', 'FF_SESSION_ID=eb0f39d4', 'FF_SANDBOX_ID=slot2', 'FF_MACHINE_ID=biscuit']), { session: 'eb0f39d4', sandbox: 'slot2', machine: 'biscuit' });
  assert.deepEqual(macEnvLine('  812 /Users/b/ffw/players/slot0/player/finalfactory.app/Contents/MacOS/finalfactory -batchmode TERM=xterm FF_SESSION_ID=abcd1234 FF_SANDBOX_ID=slot1 FF_MACHINE_ID=m5 HOME=/Users/b'), { pid: 812, env: { session: 'abcd1234', sandbox: 'slot1', machine: 'm5' } });
  assert.deepEqual(macEnvLine('  9 /bin/echo FF_SESSION_ID=fake PATH=/bin FF_SESSION_ID=real'), { pid: 9, env: { session: 'real' } });
});

test('ff-leftovers: a worker\'s own processes, not its own chain, not claude\'s MCP servers, not an interactive editor; its background jobs are in', () => {
  const procs: Proc[] = [
    SYSTEMD,
    { pid: 10, ppid: 9212, cmd: `/usr/bin/node ${ROOT}/daemon/app/machine/agentHost.ts ${ROOT}/daemon/hosts/me` },
    { pid: 11, ppid: 10, cmd: '/home/u/.local/bin/claude --output-format stream-json' },
    { pid: 12, ppid: 11, cmd: 'uvx --from mcpforunityserver mcp-for-unity' },
    { pid: 13, ppid: 12, cmd: 'python -m mcp_for_unity' },
    { pid: 14, ppid: 11, cmd: '/bin/bash -c ff-leftovers end' },
    { pid: 15, ppid: 14, cmd: `/usr/bin/node ${ROOT}/daemon/app/machine/leftovers.ts end` },
    { pid: 16, ppid: 11, cmd: '/bin/bash -c python3 soak.py' },
    { pid: 17, ppid: 16, cmd: 'python3 soak.py' },
    { pid: 18, ppid: 9212, cmd: player('slot2-0') },
    { pid: 19, ppid: 9212, cmd: xvfb('me', 99) },
    { pid: 20, ppid: 9212, cmd: `/opt/Unity/Hub/Editor/6000.3.19f1/Editor/Unity -projectPath ${ROOT}/repo` },
    { pid: 21, ppid: 20, cmd: 'bee_backend --profile x' },
    { pid: 22, ppid: 9212, cmd: player('slot2-1') },
  ];
  const env = new Map<number, ProcEnv>(procs.filter((p) => p.pid !== 9212 && p.pid !== 22).map((p) => [p.pid, { session: 'me' }]));
  env.set(22, { session: 'someone-else' });
  assert.deepEqual(ownLeftovers('me', procs, env, 15, 'linux').map((p) => p.pid), [16, 17, 18, 19]);
  // w1758: what the command's own shell runs beside it is the command's, not a background job: `ff-leftovers end | tail`
  // with tail forked and not yet exec'd (it reads as the same bash, with the session), and a `while read` subshell. CI's
  // loaded runner ended its own tail ("status=0 Terminated", the list lost).
  const piped: Proc[] = [
    ...procs,
    { pid: 23, ppid: 14, cmd: "/bin/bash -c ff-leftovers end 2>&1 | tail -20; echo status=$?" },
    { pid: 24, ppid: 14, cmd: '/bin/bash -c ff-leftovers end' },
    { pid: 25, ppid: 24, cmd: 'cat' },
  ];
  for (const p of piped.slice(-3)) env.set(p.pid, { session: 'me' });
  assert.deepEqual(ownLeftovers('me', piped, env, 15, 'linux').map((p) => p.pid), [16, 17, 18, 19]);
});

test('ff-leftovers on Windows (w1219): Git Bash breaks the parent chain at the shim, and claude, its shell and its MCP servers are still never its leftovers', () => {
  // BEAST, 2026-10-13, as Win32_Process listed it from a worker's own Bash tool: the shim's sh.exe names as its parent a
  // forked copy of bash that had already exited (MSYS fork+exec), so the walk up from node stopped there, and the old
  // ff-leftovers listed claude.exe, its conhost, its Unity MCP server and its shells; `end` killed them (exit code 1).
  const W = (pid: number, ppid: number, name: string, cmd: string) => ({ pid, ppid, name, cmd });
  const procs: Proc[] = [
    W(31748, 14732, 'node.exe', '"C:\\nvm4w\\nodejs\\node.exe" F:/ffw/daemon/app/machine/daemon.ts'),
    W(21376, 31748, 'node.exe', '"C:\\nvm4w\\nodejs\\node.exe" F:\\ffw\\daemon\\app\\machine\\agentHost.ts F:\\ffw\\daemon\\hosts\\me'),
    W(4584, 21376, 'claude.exe', 'C:\\Users\\u\\.local\\bin\\claude.exe --output-format stream-json --verbose'),
    W(41784, 4584, 'conhost.exe', '\\??\\C:\\WINDOWS\\system32\\conhost.exe 0x4'),
    W(54960, 4584, 'uvx.exe', 'C:/Users/u/uvx.exe --offline --from mcpforunityserver==10.0.0 mcp-for-unity'),
    W(50816, 54960, 'uv.exe', '"C:\\Users\\u\\uv.exe" tool uvx --offline --from mcpforunityserver==10.0.0'),
    // This Bash tool call: Git's bash.exe launcher, the MSYS bash, then the shim (its Windows parent 44516 is gone) and node.
    W(35268, 4584, 'bash.exe', '"C:\\Program Files\\Git\\bin\\bash.exe" -c "ff-leftovers end 2>&1 | tail -5"'),
    W(32460, 35268, 'bash.exe', '"C:\\Program Files\\Git\\usr\\bin\\bash.exe" -c "ff-leftovers end 2>&1 | tail -5"'),
    W(59212, 32460, 'tail.exe', 'C:\\Program Files\\Git\\usr\\bin\\tail.exe -5'),
    W(55384, 44516, 'sh.exe', 'C:\\Program Files\\Git\\usr\\bin\\sh.exe /c/Users/u/.ff-factory/unity-slots/bin/ff-leftovers end'),
    W(43776, 55384, 'node.exe', '"C:\\nvm4w\\nodejs\\node.exe" F:/ffw/daemon/app/machine/leftovers.ts end'),
    // A background task claude keeps (its shells and what they run), and a detached player whose starter is gone.
    W(24740, 4584, 'bash.exe', '"C:\\Program Files\\Git\\bin\\bash.exe" -c "python soak.py"'),
    W(40680, 24740, 'bash.exe', '"C:\\Program Files\\Git\\usr\\bin\\bash.exe" -c "python soak.py"'),
    W(58408, 46000, 'python.exe', 'python.exe soak.py'),
    W(6000, 7000, 'finalfactory.exe', '"F:\\ffw\\players\\slot5-0\\player\\finalfactory.exe" -batchmode'),
    // Another worker beside it, with a background job of its own.
    W(8100, 31748, 'node.exe', '"C:\\nvm4w\\nodejs\\node.exe" F:\\ffw\\daemon\\app\\machine\\agentHost.ts F:\\ffw\\daemon\\hosts\\other'),
    W(8000, 8100, 'claude.exe', 'C:\\Users\\u\\.local\\bin\\claude.exe --output-format stream-json'),
    W(8001, 8000, 'bash.exe', '"C:\\Program Files\\Git\\bin\\bash.exe" -c "sleep 600"'),
  ];
  const env = new Map<number, ProcEnv>(procs.filter((p) => ![31748, 21376, 8100, 8000, 8001].includes(p.pid)).map((p) => [p.pid, { session: 'me', machine: 'beast' }]));
  for (const pid of [8000, 8001]) env.set(pid, { session: 'other', machine: 'beast' });
  const never = [4584, 41784, 54960, 50816, 21376, 31748, 8000, 8001];
  // With the shim's MSYS parents (FF_LEFTOVERS_CALLERS: the sh and the bash of this call), only the background task and
  // the player.
  const withCallers = ownLeftovers('me', procs, env, 43776, 'win32', { callers: callerPids(' 55384 32460') }).map((p) => p.pid);
  assert.deepEqual(withCallers, [24740, 40680, 58408, 6000]);
  // An older shim that sends none: this call's own shells are taken, but claude and what it runs for itself never are.
  const without = ownLeftovers('me', procs, env, 43776, 'win32').map((p) => p.pid);
  assert.deepEqual(without, [35268, 32460, 59212, 24740, 40680, 58408, 6000]);
  for (const pid of never) assert.ok(!without.includes(pid) && !withCallers.includes(pid), `pid ${pid} is never a leftover of 'me'`);
  // A parent pid Windows gave a newer process is no agent host: a player whose starter is gone stays a leftover.
  const reused = [...procs, W(7000, 1, 'chrome.exe', 'chrome.exe')];
  const born = (pid: number) => (pid === 7000 ? 2_000_000 : 1_000_000);
  assert.ok(ownLeftovers('me', reused, env, 43776, 'win32', { callers: [32460], born }).some((p) => p.pid === 6000));
  assert.ok(!ownLeftovers('me', reused, env, 43776, 'win32', { callers: [32460] }).some((p) => p.pid === 6000), 'without start times a live parent is trusted: kept, never the wrong way');
});

test('readLeases: every slot\'s lease files, the session player_slots.py writes included; an unreadable one skipped', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leases-'));
  fs.mkdirSync(path.join(root, 'slot1-1', 'leases'), { recursive: true });
  fs.writeFileSync(path.join(root, 'slot1-1', 'leases', 'biscuit-1-a.json'), JSON.stringify({ pid: 2459040, host: 'biscuit', sandbox: '/x/sandboxes/slot1', time: 5, session: 'a33e1437' }));
  fs.writeFileSync(path.join(root, 'slot1-1', 'leases', 'biscuit-2-b.json'), '{half');
  assert.deepEqual(readLeases([root, path.join(root, 'missing')]), [{ slot: 'slot1-1', pid: 2459040, host: 'biscuit', time: 5, session: 'a33e1437', sandbox: '/x/sandboxes/slot1' }]);
});

// ---------------------------------------------------------------- the real machine

const platform: UnityPlatform = process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin';

test('readEnvs on this machine finds the session of a process started with it, and none in one started without', async () => {
  const sleeper = (extra: Record<string, string>) => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { env: { ...process.env, FF_SESSION_ID: '', FF_MACHINE_ID: '', FF_WORKER_ROOT: '', ...extra }, stdio: 'ignore' });
  const a = sleeper({ FF_SESSION_ID: 'w1196abc', FF_SANDBOX_ID: 'slot9', FF_MACHINE_ID: 'testbox', FF_WORKER_ROOT: '/srv/ffw-test' });
  const b = sleeper({});
  try {
    await new Promise((r) => setTimeout(r, 500));
    const got = await readEnvs(platform, [a.pid!, b.pid!]);
    assert.deepEqual(got.get(a.pid!), { session: 'w1196abc', sandbox: 'slot9', machine: 'testbox', root: '/srv/ffw-test' });
    assert.equal(got.get(b.pid!), undefined);
  } finally {
    a.kill('SIGKILL');
    b.kill('SIGKILL');
  }
});

// Git Bash on Windows (not WSL's System32\bash.exe), bash elsewhere.
const BASH = process.platform === 'win32' ? ['C:\\Program Files\\Git\\bin\\bash.exe'].find((b) => fs.existsSync(b)) : '/bin/bash';

test('on this machine: `ff-leftovers end` run through its shim from a bash pipeline ends the agent\'s background job, never the agent or its shell (w1219)', { skip: !BASH && 'no Git Bash' }, async () => {
  // A throwaway session of its own: only this test's processes carry it, so nothing else can be listed or ended.
  const session = `w1219t${process.pid}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffleft-'));
  const bin = path.join(root, 'bin');
  installLeftoversShim(bin);
  const shim = path.join(bin, 'ff-leftovers').replace(/\\/g, '/');
  // A stand-in for claude: it keeps a background job, then runs the command as the workers of 2026-10-13 did.
  const agent = `
    const { spawn, execFile } = require('node:child_process');
    // A compound command, as claude's background tasks are: bash stays (a lone \`bash -c 'sleep 600'\` execs into sleep on
    // Linux, and a non-shell child of the agent is one of its own tools, like an MCP server, so it is spared by design).
    const bg = spawn(${JSON.stringify(BASH)}, ['-c', 'sleep 600; true'], { stdio: 'ignore' });
    // The pipeline's reader is a subshell (w1758): a shell beside the command, as a forked tail is until it execs, which
    // a loaded CI runner caught and ended ("status=0 Terminated"); it is the command's own and must be spared every time.
    setTimeout(() => execFile(${JSON.stringify(BASH)}, ['-c', ${JSON.stringify(`'${shim}' end 2>&1 | while IFS= read -r l; do echo "$l"; done | tail -20; echo "status=\${PIPESTATUS[0]}"`)}], { timeout: 120000 }, (e, out, err) => {
      setTimeout(() => {
        let bgAlive = true;
        try { process.kill(bg.pid, 0); } catch { bgAlive = false; }
        process.stdout.write(JSON.stringify({ pid: process.pid, bg: bg.pid, bgAlive, out: String(out) + String(err) }));
        setTimeout(() => process.exit(0), 200);
      }, 500);
    }), 1500);`;
  const child = spawn(process.execPath, ['-e', agent], { env: { ...process.env, FF_SESSION_ID: session, FF_MACHINE_ID: 'testbox', FF_SANDBOX_ID: 'slot9' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (b) => (out += b));
  child.stderr.on('data', (b) => (err += b));
  const code = await new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
  assert.equal(code, 0, `the agent survived its own ff-leftovers end (it exited ${code}; ${err.slice(0, 300)})`);
  const got = JSON.parse(out) as { pid: number; bg: number; bgAlive: boolean; out: string };
  assert.match(got.out, /status=0/, got.out);
  assert.match(got.out, /Ended \d+ of \d+ process/, got.out);
  assert.ok(!got.out.includes(`pid ${got.pid} `), `the agent itself is not in what was ended:\n${got.out}`);
  assert.ok(got.out.includes('sleep 600'), `its background job was:\n${got.out}`);
});

// Linux and a Mac (w1197: the m5's path is this one, with `ps -E` for the environments; the macOS CI job runs this file).
const posixPlatform = process.platform === 'linux' ? 'linux' : process.platform === 'darwin' ? 'darwin' : undefined;

test('on a real Linux machine or Mac: a detached "player" and "Xvfb" of a stopped session end, a live session\'s player stays', { skip: !posixPlatform && 'Linux and macOS only' }, async () => {
  const plat = posixPlatform!;
  // A Mac's player is the binary inside finalfactory.app, a Linux one finalfactory.x86_64 (unitySlots.ts gamePlayers).
  const playerIn = (slot: string) => (plat === 'darwin' ? path.join(root, 'players', slot, 'player', 'finalfactory.app', 'Contents', 'MacOS', 'finalfactory') : path.join(root, 'players', slot, 'player', 'finalfactory.x86_64'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffw-'));
  // node under the player's and Xvfb's names (a symlink: argv[0] and so the command line keep the name; Ubuntu's sleep is a
  // multicall binary that refuses to run under another one).
  const bin = (p: string) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.symlinkSync(process.execPath, p);
    return p;
  };
  const stoppedPlayer = bin(playerIn('slot9-0'));
  const livePlayer = bin(playerIn('slot9-1'));
  const display = bin(path.join(root, 'tmp', 'ffa-deadbeef', 'xv', 'Xvfb'));
  const start = (file: string, session: string) => {
    const c = spawn(file, ['-e', 'setTimeout(() => {}, 600000)'], { env: { ...process.env, FF_SESSION_ID: session, FF_MACHINE_ID: 'testbox', FF_SANDBOX_ID: 'slot9' }, detached: true, stdio: 'ignore' });
    c.unref();
    return c.pid!;
  };
  const pids = { player: start(stoppedPlayer, 'deadbeef'), xvfb: start(display, 'deadbeef'), live: start(livePlayer, 'cafecafe') };
  const unity = realUnityDeps(plat);
  let now = Date.now();
  const reaper = new LeftoverReaper({
    platform: plat,
    machineId: 'testbox',
    // Only this test's processes: nothing else on the machine is ever looked at.
    procs: async () => (await unity.procs()).filter((p) => Object.values(pids).includes(p.pid)),
    envOf: (p) => readEnvs(plat, p),
    inspect: realInspect(plat),
    sessionLive: (id) => id === 'cafecafe',
    sessionKnown: () => false,
    resumable: () => false,
    wakeAt: () => undefined,
    liveSandboxes: () => new Set(),
    ready: () => true,
    slotRoots: () => [path.join(root, 'players')],
    tempRoot: () => path.join(root, 'tmp'),
    leases: () => [],
    protectedPaths: () => [],
    places: () => [],
    self: () => [process.pid],
    host: os.hostname(),
    kill: (pid, sig) => unity.kill(pid, sig),
    exists: (p) => fs.existsSync(p),
    remove: () => undefined,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 500))),
    now: () => now,
    log: () => undefined,
    onEvent: () => undefined,
  });
  // Gone, or a zombie (an ended child of this test that nobody reaped yet): ps says so on Linux and a Mac alike.
  const alive = (pid: number) => {
    try {
      const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
      return stat !== '' && !stat.startsWith('Z');
    } catch {
      return false;
    }
  };
  try {
    await new Promise((r) => setTimeout(r, 300));
    await reaper.look();
    assert.equal(reaper.report().players.find((p) => p.pid === pids.player)?.owner, 'stopped');
    now += LEFTOVER.DONE_GRACE_MS - MIN;
    assert.deepEqual(await reaper.look(), []);
    now += MIN;
    const ended = await reaper.look();
    assert.deepEqual(ended.map((e) => e.pids.sort((x, y) => x - y)), [[pids.player, pids.xvfb].sort((x, y) => x - y)]);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!alive(pids.player) && !alive(pids.xvfb), 'the stopped session\'s player and Xvfb are gone');
    assert.ok(alive(pids.live), 'the live session\'s player still runs');
  } finally {
    for (const pid of Object.values(pids)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone
      }
    }
  }
});

// ---------------------------------------------------------------- w1894: a person's own game

test("w1894: a game no worker started is a person's (Steam's); a worker's never is, nor a slot player (w2994), and the person's is never ended", async () => {
  const STEAM = { pid: 4242, ppid: 9000, cmd: '/home/u/.steam/steam/steamapps/common/Final Factory/FinalFactory.x86_64 -screen-fullscreen 1' };
  const byHand = { pid: 4343, ppid: 9212, cmd: `${PLAYERS}/slot1-0/player/finalfactory.x86_64 -screen-fullscreen 0` };
  const leased = { pid: 501, ppid: 9212, cmd: `${PLAYERS}/slot2-0/player/finalfactory.x86_64 -batchmode` };
  const worker = { pid: 502, ppid: 9212, cmd: '/opt/x/finalfactory.x86_64 -ffAutomationRole solo', env: env('aaaa1111') };
  const sandboxBuild = { pid: 503, ppid: 9212, cmd: `${ROOT}/sandboxes/slot3/Builds/finalfactory.x86_64` };
  const tempBuild = { pid: 504, ppid: 9212, cmd: `${TMP}/ffa-bbbb2222/build/finalfactory.x86_64` };
  const procs = () => [SYSTEMD, DAEMON, { ...STEAM }, { ...byHand }, { ...leased }, { ...worker }, { ...sandboxBuild }, { ...tempBuild }];
  const leases: PlayerLease[] = [{ slot: 'slot2-0', pid: 501, host: 'biscuit', session: 'cccc3333', sandbox: `${ROOT}/sandboxes/slot2` }];
  const on = machine(procs(), { personPlay: true, leases, sessions: { aaaa1111: { live: true }, cccc3333: { live: true } } });
  await on.look(0);
  assert.deepEqual(on.reaper.report().persons, [4242]);
  // w2994: a slot player with no lease of its own is the pool's, judged as an orphan exactly as with the look off.
  assert.equal(on.reaper.report().players.find((p) => p.pid === 4343)?.owner, 'orphan');
  for (let i = 0; i < 15; i++) await on.look(1);
  assert.ok(on.alive(4242), "a person's game is never ended");
  // Off on the machine: no person is looked for, and a slot player nobody holds is an orphan as before (w1196).
  const off = machine(procs(), { leases, sessions: { aaaa1111: { live: true }, cccc3333: { live: true } } });
  await off.look(0);
  assert.deepEqual(off.reaper.report().persons, []);
  assert.equal(off.reaper.report().players.find((p) => p.pid === 4343)?.owner, 'orphan');
});

// ---------------------------------------------------------------- w2994: an ffnightly lab client is no person

// LothDesktop, 2026-11-03 19:37:32Z: the client peer 'a' of MP-W1444-knn-combat-pair (pid 37072), started by lab.py's
// local-win launch under ffnightly.py run from lothdesktop/slot1, counted as lothsahn playing, and the yield made every lab
// player quit. Its slot lease held ffnightly's pid (player_slots.py _lease: holder_pid or os.getpid()), not the game's.
const LOTH = {
  python: { pid: 30100, ppid: 22000, cmd: String.raw`C:\Python312\python.exe scripts\nightly\ffnightly.py run --scenario MP-W1444-knn-combat-pair` },
  shell: { pid: 22000, ppid: 21000, cmd: String.raw`"C:\Program Files\Git\usr\bin\bash.exe" -c ffnightly` },
  game: { pid: 37072, ppid: 30100, cmd: String.raw`"V:\ffw\players\slot1-1\player\finalfactory.exe" -ffAutomationRole client -logFile V:\ffw\tmp\ffa-x\pr18-143254\a.log`, name: 'finalfactory.exe' },
  steam: { pid: 5000, ppid: 4000, cmd: String.raw`"C:\Program Files (x86)\Steam\steam.exe"` },
  steamGame: { pid: 5100, ppid: 5000, cmd: String.raw`"C:\Program Files (x86)\Steam\steamapps\common\Final Factory\FinalFactory.exe"`, name: 'FinalFactory.exe' },
  mainClone: { pid: 5200, ppid: 4100, cmd: String.raw`"V:\ffw\repo\Builds\Windows\finalfactory.exe"`, name: 'finalfactory.exe' },
  explorer: { pid: 4100, ppid: 900, cmd: String.raw`C:\Windows\explorer.exe` },
};
const lothO = (extra: Partial<Parameters<typeof personGames>[3]> = {}) => ({ platform: 'win32' as const, self: new Set<number>([700]), places: ['V:/ffw/sandboxes/slot1', 'V:/ffw/sandboxes/slot2'], tempRoot: 'V:/ffw/tmp', slotRoots: ['V:/ffw/players'], ...extra });

test('w2994: an ffnightly-launched slot-pool client is no person, by its exe path alone, its worker ancestry alone, or its lease holder alone', () => {
  const procs = Object.values(LOTH);
  const env = new Map<number, ProcEnv>([[30100, { session: '7d11981c', sandbox: 'slot1', machine: 'lothdesktop' }], [22000, { session: '7d11981c', sandbox: 'slot1', machine: 'lothdesktop' }]]);
  // The incident's look: no environment read for the game itself, no candidate for it, no lease naming its pid.
  assert.deepEqual(personGames(procs, [], env, lothO()).sort(), [5100, 5200], 'only Steam\'s game and one a person built and started count');
  // The exe path alone (no environment read anywhere, no leases): a slot player is never a person's.
  assert.deepEqual(personGames(procs, [], new Map(), lothO()).sort(), [5100, 5200]);
  // Its worker ancestry alone (the same client run from outside the pool, as with FF_PLAYER_SLOTS=off): ffnightly's FF_SESSION_ID.
  const outside = { ...LOTH.game, cmd: String.raw`"V:\ffw\builds\w2990\finalfactory.exe" -ffAutomationRole client` };
  assert.deepEqual(personGames([LOTH.python, LOTH.shell, outside], [], env, lothO()), []);
  // Or a lease on this host whose holder pid is its parent (lab.py's lease is ffnightly's pid), with no environment read.
  assert.deepEqual(personGames([LOTH.python, LOTH.shell, outside], [], new Map(), lothO({ leasePids: new Set([30100]) })), []);
  assert.deepEqual(personGames([LOTH.python, LOTH.shell, outside], [], new Map(), lothO()), [37072], 'nothing ties it to a worker: a person\'s');
  // A reused pid is no ancestor: a "parent" that started after the game is not its starter.
  const born = new Map([[37072, 1_000_000], [30100, 2_000_000], [22000, 500_000]]);
  assert.deepEqual(personGames([LOTH.python, LOTH.shell, outside], [], env, lothO({ born })), [37072]);
});

test("w2994: a person's own game (Steam's, or the main clone's build) with no worker in its ancestry still holds the machine, on Windows, macOS and Linux", () => {
  assert.deepEqual(personGames(Object.values(LOTH), [], new Map(), lothO({ leasePids: new Set([30100]) })).sort(), [5100, 5200]);
  const mac = [
    { pid: 1, ppid: 0, cmd: '/sbin/launchd' },
    { pid: 610, ppid: 1, cmd: '/Applications/Steam.app/Contents/MacOS/steam_osx' },
    { pid: 620, ppid: 610, cmd: '/Users/l/Library/Application Support/Steam/steamapps/common/Final Factory/FinalFactory.app/Contents/MacOS/FinalFactory' },
    { pid: 630, ppid: 1, cmd: '/Users/l/ffw/players/slot2-0/player/FinalFactory.app/Contents/MacOS/FinalFactory -batchmode' },
    { pid: 640, ppid: 1, cmd: '/usr/bin/python3 scripts/nightly/ffnightly.py run' },
    { pid: 650, ppid: 640, cmd: '/Users/l/ffw/builds/x/FinalFactory.app/Contents/MacOS/FinalFactory -ffAutomationRole host' },
  ];
  const macEnv = new Map<number, ProcEnv>([[640, { session: 'aaaa1111', machine: 'm5' }]]);
  const macO = { platform: 'darwin' as const, self: new Set<number>(), places: ['/Users/l/ffw/sandboxes/slot1'], tempRoot: '/Users/l/ffw/tmp', slotRoots: ['/Users/l/ffw/players'] };
  // launchd (pid 1) is what every detached process is reparented to: it carries no worker, and the walk stops there.
  assert.deepEqual(personGames(mac, [], macEnv, macO), [620]);
  const linux = [
    { pid: 1, ppid: 0, cmd: '/sbin/init' },
    { pid: 9212, ppid: 1, cmd: '/usr/lib/systemd/systemd --user' },
    { pid: 4242, ppid: 9212, cmd: '/home/u/.steam/steam/steamapps/common/Final Factory/FinalFactory.x86_64' },
    { pid: 4343, ppid: 9212, cmd: `${PLAYERS}/slot1-0/player/finalfactory.x86_64 -screen-fullscreen 0` },
  ];
  assert.deepEqual(personGames(linux, [], new Map(), { platform: 'linux', self: new Set([100]), places: [], tempRoot: TMP, slotRoots: [PLAYERS] }), [4242]);
});

test('ff-leftovers on Windows (w3637): a native program a Git Bash script left running in the background is listed, though its starter shows no session', () => {
  // BEAST, 2026-11-08, as Win32_Process listed it: a worker's script started `python ... &` and exited; MSYS keeps the
  // script's bash.exe as the Windows parent of the native python while it runs, and that bash shows the reader no
  // environment. So python looked like the agent itself (a session process whose live parent carries none) and `ff-leftovers
  // end` said "None is left" while `bench_queue.py timed` (pid 52636) kept waiting.
  const W = (pid: number, ppid: number, name: string, cmd: string) => ({ pid, ppid, name, cmd });
  const procs: Proc[] = [
    W(21376, 31748, 'node.exe', '"C:\\nvm4w\\nodejs\\node.exe" F:\\ff\\app\\machine\\agentHost.ts F:\\ff\\hosts\\me'),
    W(4584, 21376, 'claude.exe', 'C:\\Users\\u\\.local\\bin\\claude.exe --output-format stream-json --verbose'),
    W(35268, 4584, 'bash.exe', '"C:\\Program Files\\Git\\bin\\bash.exe" -c "ff-leftovers end"'),
    W(32460, 35268, 'bash.exe', '"C:\\Program Files\\Git\\usr\\bin\\bash.exe" -c "ff-leftovers end"'),
    W(55384, 44516, 'sh.exe', 'C:\\Program Files\\Git\\usr\\bin\\sh.exe /c/Users/u/.ff-factory/unity-slots/bin/ff-leftovers end'),
    W(43776, 55384, 'node.exe', '"C:\\nvm4w\\nodejs\\node.exe" F:/ff/app/machine/leftovers.ts end'),
    W(48876, 57712, 'bash.exe', '"C:\\Program Files\\Git\\usr\\bin\\bash.exe" /f/ff/tmp/ffa-me/leg.sh'),
    W(52636, 48876, 'python.exe', 'C:\\Python310\\python.exe scripts/bench/bench_queue.py timed --what "w3454 proof" --minutes 20'),
    W(52700, 52636, 'conhost.exe', '\\??\\C:\\WINDOWS\\system32\\conhost.exe 0x4'),
  ];
  // Win32's reader sees the environment of native programs only (w1575): not the MSYS shells'.
  const env = new Map<number, ProcEnv>([4584, 35268, 55384, 43776, 52636, 52700].map((pid) => [pid, { session: 'me', machine: 'beast' }]));
  const born = (pid: number) => (pid === 52636 ? 1_000_015 : 1_000_000);
  const mine = ownLeftovers('me', procs, env, 43776, 'win32', { callers: callerPids('55384 32460'), born }).map((p) => p.pid);
  // The script's bash names the session's temp folder, so it is listed too (w4000); without the temp root it is not.
  assert.deepEqual(mine, [52636, 52700]);
  const named = ownLeftovers('me', procs, env, 43776, 'win32', { callers: callerPids('55384 32460'), born, tempRoot: 'F:\\ff\\tmp' }).map((p) => p.pid);
  assert.deepEqual(named, [48876, 52636, 52700]);
  assert.ok(!mine.includes(4584) && !named.includes(4584), 'claude, whose parent is its agent host, is still never a leftover');
});

test('ff-leftovers on Windows (w4000): a background `bash $TMPDIR/x.sh` sleep loop stopped with TaskStop is listed with its sleep, another worker\'s loop never', () => {
  // lothdesktop, 2026-11-12, as Win32_Process and Git Bash's /proc showed it: after TaskStop the task's shells are gone; the
  // script's bash (3916) has a Windows parent that exited (30688) and its `sleep` another (28824), and neither shows the
  // reader an environment, so `ff-leftovers list` said "Nothing your session started is still running" (w3998, w3980: a
  // `checks.sh` loop and its `cargo run` ran on after "None is left"). Beside it another worker's identical loop.
  const W = (pid: number, ppid: number, name: string, cmd: string) => ({ pid, ppid, name, cmd });
  const launcher = (pid: number, ppid: number, git: string) => W(pid, ppid, 'bash.exe', `"C:\\Program Files\\Git\\${git}\\bash.exe" -c "source /c/Users/u/.claude/shell-snapshots/s.sh 2>/dev/null || true && export TEMP='V:\\ffw\\tmp\\ffa-me' TMP='V:\\ffw\\tmp\\ffa-me' && eval 'ff-leftovers end' < /dev/null"`);
  const procs: Proc[] = [
    W(21376, 31748, 'node.exe', '"C:\\nvm4w\\nodejs\\node.exe" D:\\work\\ffw\\daemon\\app\\machine\\agentHost.ts D:\\work\\ffw\\daemon\\hosts\\me'),
    W(25844, 21376, 'claude.exe', 'C:\\Users\\u\\.local\\bin\\claude.exe --output-format stream-json --verbose'),
    W(54960, 25844, 'uvx.exe', 'C:/Users/u/uvx.exe --offline --from mcpforunityserver==10.0.0 mcp-for-unity'),
    // This Bash tool call (its launcher names the temp folder too) and the shim.
    launcher(11080, 25844, 'bin'),
    launcher(32168, 11080, 'usr'),
    W(55384, 44516, 'sh.exe', 'C:\\Program Files\\Git\\usr\\bin\\sh.exe /c/Users/u/.ff-factory/unity-slots/bin/ff-leftovers end'),
    W(43776, 55384, 'node.exe', '"V:\\ffw\\tools\\node\\node.exe" D:/work/ffw/daemon/app/machine/leftovers.ts end'),
    // The stopped task's loop, a `cargo run` it started and that cargo's child, and the loop's sleep.
    W(3916, 30688, 'bash.exe', '"C:\\Program Files\\Git\\usr\\bin\\bash.exe" /v/ffw/tmp/ffa-me/x.sh'),
    W(31896, 3916, 'cargo.exe', 'cargo run -p ffu-headless -- crosscheck'),
    W(31900, 31896, 'ffu-headless.exe', 'target\\debug\\ffu-headless.exe crosscheck'),
    W(29288, 28824, 'sleep.exe', '"C:\\Program Files\\Git\\usr\\bin\\sleep.exe" 5'),
    // Another worker's loop and its sleep, and a CI runner's MSYS bash.
    W(26916, 26000, 'bash.exe', '"C:\\Program Files\\Git\\usr\\bin\\bash.exe" /v/ffw/tmp/ffa-other/cost.sh'),
    W(15944, 15000, 'sleep.exe', '"C:\\Program Files\\Git\\usr\\bin\\sleep.exe" 5'),
    W(13376, 13000, 'bash.exe', '/usr/bin/bash --noprofile --norc -e -o pipefail V:\\ffw\\ffu-runners\\ffu\\_temp\\a.sh'),
  ];
  // Native programs show the session; MSYS ones show nothing (w1575). The shim's FF_LEFTOVERS_MSYS: each MSYS program's
  // parent by Windows pid, as /proc gave it (the loop's own parent had exited: no entry).
  const env = new Map<number, ProcEnv>([25844, 54960, 11080, 55384, 43776, 31896, 31900].map((pid) => [pid, { session: 'me' }]));
  const msys = msysParents(' 32168:11080 55384:32168 29288:3916 15944:26916 bad 7:7');
  assert.equal(msys.size, 4);
  const o = { callers: callerPids('55384 32168 11080'), tempRoot: sessionTempRoot('me', { TEMP: 'V:\\ffw\\tmp\\ffa-me' }), msys };
  assert.equal(o.tempRoot, 'V:\\ffw\\tmp');
  assert.deepEqual(ownLeftovers('me', procs, env, 43776, 'win32', o).map((p) => p.pid), [3916, 31896, 31900, 29288]);
  // The other worker's loop is its own, by either rule, and an older shim's call (no MSYS map) still finds the loop.
  assert.deepEqual(ownLeftovers('other', procs, new Map(), 1, 'win32', { tempRoot: 'V:\\ffw\\tmp', msys }).map((p) => p.pid), [26916, 15944]);
  assert.deepEqual(ownLeftovers('me', procs, env, 43776, 'win32', { ...o, msys: undefined }).map((p) => p.pid), [3916, 31896, 31900]);
  // Before this, neither rule existed: the loop was missed, while cargo's environment kept it (and its child) listed.
  assert.deepEqual(ownLeftovers('me', procs, env, 43776, 'win32', { callers: o.callers }).map((p) => p.pid), [31896, 31900]);
  // Elsewhere every process shows its environment, so neither rule is used.
  assert.deepEqual(ownLeftovers('me', procs, env, 43776, 'linux', o).map((p) => p.pid).includes(3916), false);
  assert.equal(sessionTempRoot('me', { TEMP: 'C:\\Users\\u\\AppData\\Local\\Temp' }), undefined);
});

// ---------------------------------------------------------------- w3673: a wait loop an earlier agent host left

// lothdesktop, 2026-11-07: worker 316ded29's claude died with its host; resumed under the same id, its session was live
// again, so the two Git Bash `until grep -q "^exit" $TMPDIR/build.log; do sleep 30; done` loops its old claude ran were
// kept as a live worker's, and ran on until the ops worker killed them.
test('w3673: a live worker\'s wait loop from before its current agent host ends; its build, and its current host\'s loops, are kept', async () => {
  const t0 = 1_000 * HOUR;
  const loop = (born: number, pid: number) => ({ pid, ppid: 9212, cmd: `/usr/bin/bash -c until grep -q "^exit" $TMPDIR/build.log; do sleep 30; done`, env: env('316ded29', 'slot4'), born });
  const m = machine(
    [
      SYSTEMD,
      DAEMON,
      loop(t0 - 12 * HOUR, 5001),
      { pid: 5002, ppid: 5001, cmd: 'sleep 30', env: env('316ded29', 'slot4'), born: t0 - MIN },
      // A build its old agent started (unity-slot run), waited on by a loop: not a wait loop, kept.
      { pid: 5010, ppid: 9212, cmd: `/usr/bin/bash -c while unity-slot run -- Unity -batchmode -quit; do sleep 5; done`, env: env('316ded29', 'slot4'), born: t0 - 12 * HOUR },
      { pid: 5011, ppid: 5010, cmd: '/opt/unity/Editor/Unity -batchmode -quit -projectPath x', env: env('316ded29', 'slot4'), born: t0 - 12 * HOUR },
      // Its current agent's own loop.
      loop(t0 - 10 * MIN, 5020),
    ],
    { sessions: { '316ded29': { live: true, resumable: true, sandbox: 'slot4', hostSince: t0 - 30 * MIN } } },
  );
  assert.deepEqual(await m.look(0), []);
  const ended = await m.look(1);
  assert.equal(ended.length, 1, JSON.stringify(ended));
  assert.ok(!m.alive(5001), 'the old wait loop ended');
  for (const pid of [5010, 5011, 5020]) assert.ok(m.alive(pid), `pid ${pid} kept`);
  assert.match(m.st.events.join('\n'), /a wait loop started \d\d:\d\d UTC, before its worker's current agent host \(\d\d:\d\d UTC\): the agent it waited for is gone \(w3673\)/);
});

test('w3673: waitLoop is a sleeping until/while shell whose children are what a wait runs', () => {
  const p = { pid: 1, ppid: 0, cmd: 'bash -c until grep -q done log; do sleep 30; done' };
  assert.equal(waitLoop(p, [p, { pid: 2, ppid: 1, cmd: 'sleep 30' }], 'linux'), true);
  assert.equal(waitLoop(p, [p, { pid: 2, ppid: 1, cmd: 'python build.py' }], 'linux'), false, 'a shell running a build is no wait loop');
  assert.equal(waitLoop({ pid: 1, ppid: 0, cmd: 'bash -c ./build.sh' }, [], 'linux'), false);
  assert.equal(waitLoop({ pid: 1, ppid: 0, cmd: 'C:/Program Files/Git/usr/bin/bash.exe -c "until grep -q x f; do sleep 30; done"', name: 'bash.exe' }, [], 'win32'), true);
});

// ---------------------------------------------------------------- w4047: a program started for a person

test('w4047, the m5: a launcher a worker started for a person (FF_FOR_PERSON, no session) is never swept, nor what it runs, nor an installer in the temp folder; the worker\'s other leftovers still are', async () => {
  // Ben's m5, w4046: the Epic Games Launcher opened with `open -a` carried the worker's FF_SESSION_ID and was ended 2 min after
  // the worker's turn. Started through `ff-leftovers launch` it carries FF_FOR_PERSON instead.
  const person: ProcEnv = { person: 'a33e1437' };
  const m = machine([
    SYSTEMD,
    DAEMON,
    { pid: 201, ppid: 9212, cmd: '/usr/bin/ffmpeg -i x', env: env('a33e1437') },
    { pid: 202, ppid: 9212, cmd: '/opt/Epic Games Launcher/EpicGamesLauncher', env: person },
    { pid: 203, ppid: 202, cmd: '/opt/Epic Games Launcher/EpicWebHelper --type=renderer', env: person },
    // Its tree is the person's even where a child shows no environment (Windows' Git Bash programs, a setuid helper).
    { pid: 204, ppid: 202, cmd: `${TMP}/ffa-a33e1437/epic/updater` },
    // An installer's window run from the worker's own temp folder: the path rule alone would make it the worker's.
    { pid: 205, ppid: 9212, cmd: `${TMP}/ffa-a33e1437/Setup/installer --ui`, env: person },
    // The marker is honoured only without a session: an FF_FOR_PERSON exported in a worker's shell spares nothing.
    { pid: 206, ppid: 9212, cmd: '/usr/bin/python3 soak.py', env: { ...env('a33e1437'), person: 'a33e1437' } },
  ], { sessions: { a33e1437: {} } });
  for (let i = 0; i < 40; i++) await m.look();
  assert.deepEqual([201, 206].filter(m.alive), [], "the worker's own leftovers end as before");
  assert.ok([202, 203, 204, 205].every(m.alive), 'what was started for the person runs on after 40 min');
  assert.ok(!m.st.signals.some((s) => /\s20[2-5]$/.test(s)), 'and was never signalled');
  assert.equal(m.st.logs.filter((l) => /spared pid 202, started for a person by worker a33e1437/.test(l)).length, 1, 'said once in the log');
});

test('w4047: ff-leftovers never lists what the worker started for a person, nor its tree; its background job still is (Linux, Windows)', () => {
  const procs: Proc[] = [
    SYSTEMD,
    { pid: 10, ppid: 9212, cmd: `/usr/bin/node ${ROOT}/daemon/app/machine/agentHost.ts ${ROOT}/daemon/hosts/me` },
    { pid: 11, ppid: 10, cmd: '/home/u/.local/bin/claude --output-format stream-json' },
    { pid: 14, ppid: 11, cmd: '/bin/bash -c ff-leftovers end' },
    { pid: 15, ppid: 14, cmd: `/usr/bin/node ${ROOT}/daemon/app/machine/leftovers.ts end` },
    { pid: 16, ppid: 11, cmd: '/bin/bash -c python3 soak.py' },
    { pid: 17, ppid: 16, cmd: 'python3 soak.py' },
    { pid: 30, ppid: 9212, cmd: '/opt/Epic Games Launcher/EpicGamesLauncher' },
    { pid: 31, ppid: 30, cmd: `${TMP}/ffa-me/epic/updater --log ${TMP}/ffa-me/epic/u.log` },
  ];
  const env = new Map<number, ProcEnv>([10, 11, 14, 15, 16, 17].map((pid) => [pid, { session: 'me' }]));
  env.set(30, { person: 'me' });
  assert.deepEqual(ownLeftovers('me', procs, env, 15, 'linux').map((p) => p.pid), [16, 17]);
  // On Windows a process that names the session's temp folder is the session's (w4000), unless it is in the person's tree.
  assert.deepEqual(ownLeftovers('me', procs, env, 15, 'win32', { tempRoot: TMP }).map((p) => p.pid), [16, 17]);
  assert.equal(forPerson({ person: 'me' }), true);
  assert.equal(forPerson({ person: 'me', session: 'me' }), false);
  assert.equal(forPerson(undefined), false);
  assert.deepEqual(envFrom(['FF_FOR_PERSON=me', 'PATH=/bin']), { person: 'me' });
  assert.deepEqual(macEnvLine('  77 /Applications/Epic Games Launcher.app/Contents/MacOS/EpicGamesLauncher HOME=/Users/b FF_FOR_PERSON=cf018e8d'), { pid: 77, env: { person: 'cf018e8d' } });
});

test('w4047: personEnv drops the worker\'s ownership variables and credentials, marks the session, and leaves the worker\'s temp folder', () => {
  const e = { PATH: '/bin', HOME: '/Users/b', FF_SESSION_ID: 'cf018e8d', FF_SANDBOX_ID: 'slot1', FF_MACHINE_ID: 'm5', FF_WORKER_ROOT: '/Users/b/ffw', FF_LEFTOVERS_CALLERS: '1 2', FF_CLEANUP_FACTS: '/x', GH_TOKEN: 'ghs_x', CLAUDE_CODE_OAUTH_TOKEN: 'sk', ANTHROPIC_API_KEY: 'k', CLAUDECODE: '1', TMPDIR: '/Users/b/ffw/tmp/ffa-cf018e8d/', FF_SKILLS: '/s' };
  assert.deepEqual(personEnv(e, 'cf018e8d', 'darwin'), { PATH: '/bin', HOME: '/Users/b', FF_SKILLS: '/s', FF_FOR_PERSON: 'cf018e8d' });
  const w = personEnv({ Path: 'C:\\Windows', TEMP: 'V:\\ffw\\tmp\\ffa-cf018e8d', TMP: 'C:\\Users\\b\\AppData\\Local\\Temp', LOCALAPPDATA: 'C:\\Users\\b\\AppData\\Local', Ff_Session_Id: 'cf018e8d' }, 'cf018e8d', 'win32');
  assert.deepEqual(w, { Path: 'C:\\Windows', TEMP: 'C:\\Users\\b\\AppData\\Local\\Temp', TMP: 'C:\\Users\\b\\AppData\\Local\\Temp', LOCALAPPDATA: 'C:\\Users\\b\\AppData\\Local', FF_FOR_PERSON: 'cf018e8d' });
});

test('on this machine (w4047): a program started with `ff-leftovers launch` survives a sweep of its stopped worker, whose ordinary leftover is ended', async () => {
  const session = `w4047t${process.pid}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffperson-'));
  const out = path.join(dir, 'env.json');
  const ownEnv = { FF_SESSION_ID: session, FF_SANDBOX_ID: 'slot9', FF_MACHINE_ID: 'testbox', FF_WORKER_ROOT: dir };
  const e = { ...process.env, ...ownEnv, GH_TOKEN: 'ghs_test', TMPDIR: path.join(dir, `ffa-${session}`), TEMP: path.join(dir, `ffa-${session}`) };
  const said: string[] = [];
  const script = `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ env: process.env, cwd: process.cwd() })); setTimeout(() => {}, 120000)`;
  const launched = await launchForPerson([process.execPath, '-e', script], session, e, platform, (s) => void said.push(s));
  assert.equal(launched.code, 0, said.join(''));
  const app = launched.pid!;
  const leftover = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { env: { ...process.env, ...ownEnv }, stdio: 'ignore' });
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    for (let i = 0; i < 100 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 100));
    const seen = JSON.parse(fs.readFileSync(out, 'utf8')) as { env: Record<string, string>; cwd: string };
    assert.equal(seen.env.FF_FOR_PERSON, session);
    for (const k of [...Object.keys(ownEnv), 'GH_TOKEN']) assert.equal(seen.env[k], undefined, k);
    assert.ok(!Object.entries(seen.env).some(([k, v]) => /^(TEMP|TMP|TMPDIR)$/i.test(k) && v.includes(`ffa-${session}`)), "not the worker's temp folder");
    assert.equal(fs.realpathSync(seen.cwd).toLowerCase(), fs.realpathSync(os.homedir()).toLowerCase());
    const envs = await readEnvs(platform, [app, leftover.pid!]);
    assert.deepEqual(envs.get(app), { person: session });
    assert.equal(envs.get(leftover.pid!)?.session, session);
    // The daemon's sweep, reading this machine's environments and sending real signals; the session stopped, nothing waits for it.
    const fake = machine([], { sessions: { [session]: {} } });
    const procs = () => [app, leftover.pid!].filter(alive).map((pid) => ({ pid, ppid: 9212, cmd: `node sleeper ${pid}` }));
    const reaper = new LeftoverReaper({
      ...fake.reaper['d'],
      machineId: 'testbox',
      root: dir,
      procs: async () => procs(),
      envOf: (pids) => readEnvs(platform, pids),
      kill: (pid, sig) => {
        try {
          process.kill(pid, sig);
        } catch {
          // gone
        }
        return undefined;
      },
      inspect: async (pids) => pids.map((pid) => ({ pid, startedAt: fake.st.now - HOUR, cpuMs: 0 })),
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 500))),
    });
    for (let i = 0; i < 6; i++) {
      fake.st.now += 2 * MIN;
      await reaper.look();
    }
    for (let i = 0; i < 50 && alive(leftover.pid!); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(alive(leftover.pid!), false, 'the ordinary leftover was ended');
    assert.equal(alive(app), true, 'the program started for a person runs on');
  } finally {
    leftover.kill('SIGKILL');
    try {
      process.kill(app, 'SIGKILL');
    } catch {
      // gone
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
