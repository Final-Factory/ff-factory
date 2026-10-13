import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LEFTOVER, LeftoverReaper, callerPids, envFrom, installLeftoversShim, kindOf, macEnvLine, orphanVerdict, ownLeftovers, readEnvs, readLeases, realInspect, sessionVerdict, slotOf, tempSessionOf, type LeftoverDeps, type PlayerLease, type ProcEnv } from '../machine/leftovers.ts';
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
}

/** A fake machine: processes with their environments, start times and CPU, sessions, leases and a clock. */
function machine(procs: (Proc & { env?: ProcEnv; born?: number; cpu?: number })[], o: { platform?: UnityPlatform; sessions?: Record<string, Session>; leases?: PlayerLease[]; ready?: boolean; known?: string[] } = {}) {
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
    procs: async () => st.procs.map(({ pid, ppid, cmd, name }) => ({ pid, ppid, cmd, ...(name ? { name } : {}) })),
    envOf: async (pids) => new Map(st.procs.filter((p) => pids.includes(p.pid) && p.env).map((p) => [p.pid, p.env!])),
    inspect: async (pids) => st.procs.filter((p) => pids.includes(p.pid)).map((p) => ({ pid: p.pid, startedAt: p.born, cpuMs: p.cpu ?? 0 })),
    sessionLive: (id) => !!st.sessions[id]?.live,
    sessionKnown: (id) => id in st.sessions || (o.known ?? []).includes(id),
    resumable: (id) => !!st.sessions[id]?.resumable,
    wakeAt: (id) => st.sessions[id]?.wakeAt,
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
      // A player and an Xvfb end on SIGTERM; a process named "stubborn" only on SIGKILL.
      const p = st.procs.find((x) => x.pid === pid);
      if (p && (sig === 'SIGKILL' || !/stubborn/.test(p.cmd))) st.procs = st.procs.filter((x) => x.pid !== pid);
    },
    exists: (p) => st.files.has(p),
    remove: (p) => void st.files.delete(p),
    sleep: async () => undefined,
    now: () => st.now,
    log: (l) => void st.logs.push(l),
    onEvent: (t) => void st.events.push(t),
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
  const sleeper = (extra: Record<string, string>) => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { env: { ...process.env, FF_SESSION_ID: '', FF_MACHINE_ID: '', ...extra }, stdio: 'ignore' });
  const a = sleeper({ FF_SESSION_ID: 'w1196abc', FF_SANDBOX_ID: 'slot9', FF_MACHINE_ID: 'testbox' });
  const b = sleeper({});
  try {
    await new Promise((r) => setTimeout(r, 500));
    const got = await readEnvs(platform, [a.pid!, b.pid!]);
    assert.deepEqual(got.get(a.pid!), { session: 'w1196abc', sandbox: 'slot9', machine: 'testbox' });
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
    setTimeout(() => execFile(${JSON.stringify(BASH)}, ['-c', ${JSON.stringify(`'${shim}' end 2>&1 | tail -20; echo "status=\${PIPESTATUS[0]}"`)}], { timeout: 120000 }, (e, out, err) => {
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

test('on a real Linux machine: a detached "player" and "Xvfb" of a stopped session end, a live session\'s player stays', { skip: process.platform !== 'linux' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffw-'));
  // node under the player's and Xvfb's names (a symlink: argv[0] and so the command line keep the name; Ubuntu's sleep is a
  // multicall binary that refuses to run under another one).
  const bin = (p: string) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.symlinkSync(process.execPath, p);
    return p;
  };
  const stoppedPlayer = bin(path.join(root, 'players', 'slot9-0', 'player', 'finalfactory.x86_64'));
  const livePlayer = bin(path.join(root, 'players', 'slot9-1', 'player', 'finalfactory.x86_64'));
  const display = bin(path.join(root, 'tmp', 'ffa-deadbeef', 'xv', 'Xvfb'));
  const start = (file: string, session: string) => {
    const c = spawn(file, ['-e', 'setTimeout(() => {}, 600000)'], { env: { ...process.env, FF_SESSION_ID: session, FF_MACHINE_ID: 'testbox', FF_SANDBOX_ID: 'slot9' }, detached: true, stdio: 'ignore' });
    c.unref();
    return c.pid!;
  };
  const pids = { player: start(stoppedPlayer, 'deadbeef'), xvfb: start(display, 'deadbeef'), live: start(livePlayer, 'cafecafe') };
  const unity = realUnityDeps('linux');
  let now = Date.now();
  const reaper = new LeftoverReaper({
    platform: 'linux',
    machineId: 'testbox',
    // Only this test's processes: nothing else on the machine is ever looked at.
    procs: async () => (await unity.procs()).filter((p) => Object.values(pids).includes(p.pid)),
    envOf: (p) => readEnvs('linux', p),
    inspect: realInspect('linux'),
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
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return !fs.readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') Z ');
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
