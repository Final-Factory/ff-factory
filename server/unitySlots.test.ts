import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  SlotRefused,
  UnitySlots,
  acquire,
  arbiterFile,
  assess,
  countsLine,
  denyFile,
  gamePlayers,
  grantFile,
  isUnityBinary,
  parseCli,
  reqFile,
  shimScripts,
  slotsDir,
  slotsPointer,
  splitArgs,
  unityProcesses,
  type ArbiterDeps,
  type Place,
  type SlotRequest,
} from '../machine/unitySlots.ts';
import type { Proc } from '../machine/unity.ts';
import { fleetOf, unitySlotsLine } from '../shared/fleet.ts';
import { machineLoadLine } from './system.ts';
import { capacityLines, type Computer } from './placement.ts';
import type { Machine, MachineStats, UnitySlotsReport } from '../shared/types.ts';

/**
 * Unity slots (w469, docs/unity-lifecycle.md "Unity slots"): every top-level Unity process counts toward a machine's
 * max_unity, and launches outside `unity start` wait in a queue for theirs: all-or-nothing, holders first, deadlock-free,
 * freed when their process is gone.
 */

const HUB = 'C:\\Program Files\\Unity\\Hub\\Editor\\6000.3.19f1\\Editor';

// BEAST's own listing, 2026-10-05 (Get-CimInstance Win32_Process): two sandbox editors, two AssetImportWorkers of
// one of them (quoted arguments, -parentPid), its ILPP runners; plus what LothDesktop had: batch builds with Burst's
// bcl.exe, game players, Unity Hub, and a script whose arguments name Unity.exe.
const WIN: Proc[] = [
  { pid: 45848, ppid: 33488, name: 'Unity.exe', cmd: `"${HUB}\\Unity.exe" -projectPath F:\\ffsb\\agent-mcp -logFile F:\\ffsb\\agent-mcp\\Logs\\sandbox-editor.log ` },
  { pid: 39248, ppid: 45848, name: 'Unity.ILPP.Runner.exe', cmd: `"${HUB}\\Data\\Tools\\BuildPipeline\\Compilation\\Unity.ILPP.Runner\\Unity.ILPP.Runner.exe" "unity-ilpp-6b68" "-name" "ILPP"` },
  { pid: 44044, ppid: 45848, name: 'Unity.exe', cmd: `"${HUB}\\Unity.exe" "-adb2" "-batchMode" "-noUpm" "-name" "AssetImportWorker4" "-projectPath" "F:/ffsb/agent-mcp" "-logFile" "Logs/AssetImportWorker4.log" "-srvPort" "57077" "-parentPid" "45848"` },
  { pid: 39704, ppid: 45848, name: 'Unity.exe', cmd: `"${HUB}\\Unity.exe" "-adb2" "-batchMode" "-noUpm" "-name" "AssetImportWorker6" "-projectPath" "F:/ffsb/agent-mcp" "-parentPid" "45848"` },
  { pid: 44300, ppid: 42068, name: 'Unity.exe', cmd: `"${HUB}\\Unity.exe" -projectPath F:\\ffsb\\mp-r2 -logFile F:\\ffsb\\mp-r2\\Logs\\sandbox-editor.log ` },
  { pid: 7000, ppid: 6000, name: 'python.exe', cmd: `python scripts\\unity_slot.py run -- "${HUB}\\Unity.exe" -batchmode -projectPath D:\\work\\ffsb\\pr-fix` },
  { pid: 7001, ppid: 7000, name: 'Unity.exe', cmd: `"${HUB}\\Unity.exe" -batchmode -quit -nographics -projectPath D:\\work\\ffsb\\pr-fix -executeMethod BuildScript.Build -logFile -` },
  { pid: 7002, ppid: 7001, name: 'bcl.exe', cmd: `"D:\\work\\ffsb\\pr-fix\\Library\\PackageCache\\com.unity.burst\\.Runtime\\bcl.exe" --platform=Windows` },
  { pid: 7003, ppid: 7001, name: 'Unity.exe', cmd: `"${HUB}\\Unity.exe" -batchMode -name AssetImportWorker0 -projectPath D:/work/ffsb/pr-fix -parentPid 7001` },
  { pid: 8000, ppid: 1, name: 'FinalFactory.exe', cmd: 'C:\\ffslots\\slot1\\player\\FinalFactory.exe -screen-fullscreen 0' },
  { pid: 8001, ppid: 1, name: 'Unity Hub.exe', cmd: '"C:\\Program Files\\Unity Hub\\Unity Hub.exe"' },
  { pid: 8002, ppid: 1, name: 'bash.exe', cmd: `bash -c '"/c/Program Files/Unity/Hub/Editor/6000.3.19f1/Editor/Unity.exe" -batchmode'` },
  // An elevated editor whose command line Windows does not show: its image name still says what it is.
  { pid: 8003, ppid: 1, name: 'Unity.exe', cmd: 'Unity.exe' },
];

const MAC_APP = '/Applications/Unity/Hub/Editor/6000.3.19f1/Unity.app/Contents/MacOS/Unity';
const MAC: Proc[] = [
  { pid: 100, ppid: 1, cmd: `${MAC_APP} -projectPath /Users/ben/ffsb/sb1 -logFile /Users/ben/ffsb/sb1/Logs/sandbox-editor.log` },
  { pid: 101, ppid: 100, cmd: `${MAC_APP} -adb2 -batchMode -noUpm -name AssetImportWorker0 -projectPath /Users/ben/ffsb/sb1 -logFile Logs/AssetImportWorker0.log -srvPort 6000` },
  { pid: 102, ppid: 1, cmd: `/Volumes/Data Drive/Unity/6000.3.19f1/Unity.app/Contents/MacOS/Unity -batchmode -quit -projectPath /Users/ben/My Projects/FinalFactory -executeMethod BuildScript.Build` },
  { pid: 103, ppid: 1, cmd: `/usr/bin/python3 /Users/ben/FinalFactory/scripts/unity_slot.py run -- ${MAC_APP} -batchmode -projectPath /x` },
  { pid: 104, ppid: 1, cmd: `/bin/bash -c ${MAC_APP} -batchmode` },
  { pid: 105, ppid: 1, cmd: '/Users/ben/builds/FinalFactory.app/Contents/MacOS/FinalFactory -batchmode' },
  { pid: 106, ppid: 1, cmd: '/Applications/Unity Hub.app/Contents/MacOS/Unity Hub' },
  { pid: 107, ppid: 100, cmd: '/Applications/Unity/Hub/Editor/6000.3.19f1/Unity.app/Contents/Tools/UnityShaderCompiler /x' },
  { pid: 108, ppid: 1, cmd: `${MAC_APP}Helper -x` },
];

test('unity slots: counting on Windows: editors and batch runs count; AssetImportWorkers, bcl, ILPP, players and scripts naming Unity do not', () => {
  const u = unityProcesses(WIN, 'win32');
  assert.deepEqual(
    u.map((x) => [x.pid, x.kind, x.project]),
    [
      [45848, 'interactive', 'F:\\ffsb\\agent-mcp'],
      [44300, 'interactive', 'F:\\ffsb\\mp-r2'],
      [7001, 'batch', 'D:\\work\\ffsb\\pr-fix'],
      [8003, 'interactive', undefined],
    ],
  );
  assert.deepEqual(gamePlayers(WIN, 'win32').map((p) => p.pid), [8000]);
  assert.equal(isUnityBinary({ cmd: `"${HUB}\\Unity.exe" -batchmode` }, 'win32'), true, 'no image name: the program of the command line');
  assert.equal(isUnityBinary({ cmd: `python run.py "${HUB}\\Unity.exe"` }, 'win32'), false);
  assert.deepEqual(splitArgs('"C:\\a b\\Unity.exe" "-projectPath" "D:/x y" -quit "say \\"hi\\""'), ['C:\\a b\\Unity.exe', '-projectPath', 'D:/x y', '-quit', 'say "hi"']);
});

test('unity slots: counting on macOS: the Unity binary at the start of the command line, a path with spaces too', () => {
  const u = unityProcesses(MAC, 'darwin');
  assert.deepEqual(
    u.map((x) => [x.pid, x.kind, x.project]),
    [
      [100, 'interactive', '/Users/ben/ffsb/sb1'],
      [102, 'batch', '/Users/ben/My Projects/FinalFactory'],
    ],
  );
  assert.deepEqual(gamePlayers(MAC, 'darwin').map((p) => p.pid), [105]);
});

const T0 = Date.parse('2026-10-05T12:00:00Z');
let nextPid = 9000;
/** A request; its waiting process gets a pid of its own unless given (no Unity process below runs under it). */
const req = (id: string, over: Partial<SlotRequest> = {}): SlotRequest => ({ id, holder: `pid:${id}`, count: 1, pid: nextPid++, label: id, createdAt: T0, ...over });
const editorProc = (pid: number, project: string, batch = false): Proc => ({ pid, ppid: 77777, name: 'Unity.exe', cmd: `"${HUB}\\Unity.exe"${batch ? ' -batchmode' : ''} -projectPath ${project}` });

test('unity slots: each place, holder and outside process counts once, as its reservation or its processes, the larger', () => {
  const places: Place[] = [
    { holder: 'sandbox:a', path: 'D:\\work\\ffsb\\a', editorUp: true },
    { holder: 'sandbox:b', path: 'D:\\work\\ffsb\\b', editorUp: true }, // starting: no process yet, still a slot
    { holder: 'main', path: 'D:\\FinalFactory' },
  ];
  const procs: Proc[] = [
    editorProc(10, 'D:\\work\\ffsb\\a'),
    editorProc(11, 'd:/work/ffsb/a/', true), // a batch run on a's project, outside the gate: a's slot plus one
    editorProc(12, 'D:\\FinalFactory'), // the owner's own editor
    { pid: 20, ppid: 1, name: 'python.exe', cmd: 'python build.py' },
    editorProc(21, 'D:\\elsewhere', true),
    { ...editorProc(21, 'D:\\elsewhere', true), pid: 22, ppid: 20 }, // under a holder's process
    editorProc(30, 'C:\\live\\FinalFactory'), // started outside the gate, nobody's
  ];
  procs[4] = { ...procs[4], ppid: 20 };
  const a = assess({ platform: 'win32', procs, requests: [req('r20', { pid: 20, count: 1, grantedAt: T0 })], places, limit: 8, now: T0 });
  // a: 2 processes; b: 1 reserved; main: 1; the holder: 2 processes for 1 granted; outside: 1.
  assert.equal(a.used, 7);
  assert.deepEqual([...a.holders.entries()].sort(), [['main', 1], ['pid:r20', 2], ['sandbox:a', 2], ['sandbox:b', 1]]);
  assert.deepEqual(a.outside.map((x) => x.pid), [30]);
  assert.equal(countsLine(a), 'editors 7 of 8: 3 interactive, 3 batch, 1 granted not started yet');
});

test('unity slots: two batch builds on a machine with one free slot run one after the other (LothDesktop, 2026-10-05)', () => {
  // Limit 3, one interactive editor and one build running: 1 free.
  const places: Place[] = [{ holder: 'sandbox:lag-lead', path: 'D:\\work\\ffsb\\lag-lead', editorUp: true }];
  const procs = [editorProc(10, 'D:\\work\\ffsb\\lag-lead'), editorProc(11, 'D:\\work\\ffsb\\ui-fix', true)];
  const first = req('b1', { pid: 501, label: 'build pr-fix', createdAt: T0 });
  const second = req('b2', { pid: 502, label: 'build bug-1553894544', createdAt: T0 + 1000 });
  let a = assess({ platform: 'win32', procs, requests: [first, second], places, limit: 3, now: T0 + 2000 });
  assert.deepEqual(a.grant, ['b1']);
  assert.deepEqual(a.waiting, [{ id: 'b2', position: 1, why: 'needs 1, 0 free (3 of 3 in use)' }]);
  // b1's build runs under its wrapper.
  const running = [...procs, { pid: 501, ppid: 1, name: 'python.exe', cmd: 'python' }, { ...editorProc(601, 'D:\\work\\ffsb\\pr-fix', true), ppid: 501 }];
  a = assess({ platform: 'win32', procs: running, requests: [{ ...first, grantedAt: T0 + 2000 }, second], places, limit: 3, now: T0 + 60_000 });
  assert.deepEqual(a.grant, [], 'still full');
  assert.equal(a.used, 3);
  // b1 done and released: b2's turn.
  a = assess({ platform: 'win32', procs, requests: [second], places, limit: 3, now: T0 + 30 * 60_000 });
  assert.deepEqual(a.grant, ['b2']);
});

test('unity slots: a free slot goes first to a waiter that already holds one, then to new requesters, oldest first', () => {
  const places: Place[] = [{ holder: 'sandbox:a', path: 'D:\\ffsb\\a', editorUp: true }];
  const procs = [editorProc(10, 'D:\\ffsb\\a'), editorProc(11, 'D:\\other', true)];
  const newcomer = req('n1', { createdAt: T0 });
  const holder = req('h1', { holder: 'sandbox:a', createdAt: T0 + 5000 }); // a's worker wants a batch build too
  const a = assess({ platform: 'win32', procs, requests: [newcomer, holder], places, limit: 3, now: T0 + 6000 });
  assert.deepEqual(a.grant, ['h1']);
  assert.deepEqual(a.waiting.map((w) => w.id), ['n1']);
  // A worker that stopped its editor a moment ago to build its own project in batch mode keeps its turn.
  const stopped = assess({ platform: 'win32', procs: [editorProc(11, 'D:\\other', true)], requests: [newcomer, holder], places: [{ holder: 'sandbox:a', path: 'D:\\ffsb\\a', priority: true }], limit: 2, now: T0 + 6000 });
  assert.deepEqual([stopped.grant, stopped.waiting.map((w) => w.id)], [['h1'], ['n1']]);
  // Among new requesters, the oldest; the queue stops at the first that does not fit (a peer run is not passed by singles).
  const peer = req('p1', { count: 2, createdAt: T0 });
  const single = req('s1', { createdAt: T0 + 1 });
  const b = assess({ platform: 'win32', procs: [editorProc(11, 'D:\\other', true)], requests: [peer, single], places: [], limit: 2, now: T0 + 2 });
  assert.deepEqual(b.grant, []);
  assert.deepEqual(b.waiting.map((w) => [w.id, w.why]), [['p1', 'needs 2, 1 free (1 of 2 in use)'], ['s1', 'behind 1 earlier request']]);
});

test('unity slots: two 2-editor peer runs on a machine with a limit of 3 never deadlock', () => {
  // All at once: the first gets both, the second waits holding nothing.
  const p1 = req('p1', { pid: 1, count: 2, createdAt: T0 });
  const p2 = req('p2', { pid: 2, count: 2, createdAt: T0 + 1 });
  let a = assess({ platform: 'win32', procs: [], requests: [p1, p2], places: [], limit: 3, now: T0 + 2 });
  assert.deepEqual([a.grant, a.waiting.map((w) => w.id), a.deny], [['p1'], ['p2'], []]);
  a = assess({ platform: 'win32', procs: [], requests: [p2], places: [], limit: 3, now: T0 + 60_000 });
  assert.deepEqual(a.grant, ['p2'], 'once p1 ends');

  // One editor at a time (a peer run that holds its host editor asks for the client's): both hold 1 and want 1 more.
  const host1 = req('h1', { pid: 1, holder: 'run1', grantedAt: T0 });
  const host2 = req('h2', { pid: 2, holder: 'run2', grantedAt: T0 });
  const more1 = req('m1', { pid: 1, holder: 'run1', createdAt: T0 + 10 });
  const more2 = req('m2', { pid: 2, holder: 'run2', createdAt: T0 + 20 });
  a = assess({ platform: 'win32', procs: [], requests: [host1, host2, more1, more2], places: [], limit: 3, now: T0 + 30 });
  assert.deepEqual([a.grant, a.waiting.map((w) => w.id), a.deny], [['m1'], ['m2'], []], 'run1 completes, run2 waits for it');

  // Each holds 1 and wants 2 more: neither can ever fit while the other holds. The newest is refused, so one finishes.
  const big1 = req('b1', { pid: 1, holder: 'run1', count: 2, createdAt: T0 + 10 });
  const big2 = req('b2', { pid: 2, holder: 'run2', count: 2, createdAt: T0 + 20 });
  a = assess({ platform: 'win32', procs: [], requests: [host1, host2, big1, big2], places: [], limit: 3, now: T0 + 30 });
  assert.deepEqual(a.grant, []);
  assert.deepEqual(a.deny.map((x) => x.id), ['b2']);
  assert.match(a.deny[0].why, /^would wait forever: every Unity slot here is held by runs that are themselves waiting for more \("b1" \(holds 1, wants 2\); this one holds 1 and wants 2\)/);
  // run2 gives up its host editor: run1 gets its two.
  a = assess({ platform: 'win32', procs: [], requests: [host1, big1], places: [], limit: 3, now: T0 + 40 });
  assert.deepEqual(a.grant, ['b1']);

  // A later waiting holder that fits goes first when everything else is held by waiters: it can finish.
  const want2 = req('w2', { pid: 1, holder: 'run1', count: 2, createdAt: T0 + 10 });
  const want1 = req('w1', { pid: 2, holder: 'run2', count: 1, createdAt: T0 + 20 });
  a = assess({ platform: 'win32', procs: [], requests: [host1, host2, want2, want1], places: [], limit: 3, now: T0 + 30 });
  assert.deepEqual([a.grant, a.deny], [['w1'], []]);
});

test('unity slots: refused at once: more than the limit, a holder asking past it, a holder waiting too long while holding', () => {
  const places: Place[] = [{ holder: 'sandbox:a', path: 'D:\\ffsb\\a', editorUp: true }];
  const a = assess({
    platform: 'win32',
    procs: [editorProc(10, 'D:\\ffsb\\a')],
    requests: [req('x4', { count: 4 }), req('xa', { holder: 'sandbox:a', count: 3 }), req('old', { holder: 'sandbox:a', count: 1, createdAt: T0 - 31 * 60_000 }), req('zero', { count: 0 })],
    places,
    limit: 3,
    now: T0,
  });
  const why = Object.fromEntries(a.deny.map((x) => [x.id, x.why]));
  assert.match(why.x4, /needs 4 Unity editors at once; this machine allows 3/);
  assert.match(why.xa, /it holds 1 \(its own process or the editor of sandbox:a\) and asks for 3 more, more than the 3 this machine allows at once/);
  assert.match(why.old, /waited 31 min while holding 1 slot\(s\)/);
  assert.match(why.zero, /asks for 0 slots/);
});

test('unity slots: over the limit by processes started outside the gate, or RAM high: nothing more starts, nothing is stopped', () => {
  const procs = [editorProc(1, 'D:\\a'), editorProc(2, 'D:\\b', true), editorProc(3, 'D:\\c', true), editorProc(4, 'D:\\d', true)];
  const a = assess({ platform: 'win32', procs, requests: [req('r1')], places: [], limit: 3, now: T0 });
  assert.equal(a.overLimit, true);
  assert.equal(countsLine(a), 'editors 4 of 3: 1 interactive, 3 batch');
  assert.deepEqual(a.grant, []);
  assert.equal(a.waiting[0].why, 'needs 1, 0 free (4 of 3 in use)');
  const r = assess({ platform: 'win32', procs: [], requests: [req('r1')], places: [], limit: 3, now: T0, ramPct: 90 });
  assert.deepEqual(r.grant, []);
  assert.equal(r.waiting[0].why, 'RAM 90% used; new Unity launches wait below 85%');
  // No limit configured (a main-clone Mac): counted, never held up, not even by RAM.
  assert.deepEqual(assess({ platform: 'darwin', procs: [], requests: [req('r1', { count: 5 })], places: [], now: T0, ramPct: 95 }).grant, ['r1']);
});

// ---------------------------------------------------------------- the mailbox, the arbiter and the client, on disk

function arbiter(t: { after: (fn: () => void) => void }, over: Partial<ArbiterDeps> & { procs?: () => Promise<Proc[]> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-slots-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const events: string[] = [];
  const dead = new Set<number>();
  const slots = new UnitySlots({
    dir,
    platform: 'win32',
    procs: async () => [],
    alive: (pid) => !dead.has(pid),
    now: () => Date.now(),
    limit: () => 1,
    places: () => [],
    ramPct: () => undefined,
    onEvent: (e) => events.push(e),
    ...over,
  });
  // The daemon looks every few seconds; here every 10 ms, so a waiting client is answered.
  const timer = setInterval(() => void slots.tick().catch(() => undefined), 10);
  t.after(() => clearInterval(timer));
  return { dir, slots, events, dead };
}

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

const client = (dir: string, pid: number, said: string[] = []) => ({ dir, pid, now: () => Date.now(), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), say: (l: string) => said.push(l) });

test('unity slots: a client waits in the queue for its slot and gets it when the holder releases; the arbiter file says who waits', async (t) => {
  const { dir, slots } = arbiter(t);
  await slots.tick();
  const said: string[] = [];
  const one = await acquire(client(dir, 111), { count: 1, label: 'build pr-fix', holder: 'sandbox:a', pollMs: 10 });
  assert.ok(one.id && !one.ungated);
  const box: { second?: Awaited<ReturnType<typeof acquire>> } = {};
  // Another run of the same sandbox: it waits for the first, it is not refused as one run holding while it waits.
  const waiting = acquire(client(dir, 222, said), { count: 1, label: 'build ui-fix', holder: 'sandbox:a', pollMs: 10 }).then((h) => (box.second = h));
  // The first had no grant until the arbiter looked; the second is now in the queue behind it.
  for (let i = 0; i < 20 && !said.length; i++) {
    await slots.tick();
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.equal(box.second === undefined, true, "still waiting");
  assert.match(said.join('\n'), /waiting for 1 Unity slot\(s\): position 1 of 1, needs 1, 0 free \(1 of 1 in use\); editors 1 of 1/);
  const file = JSON.parse(fs.readFileSync(arbiterFile(dir), 'utf8'));
  assert.deepEqual(file.granted.map((g: { label: string }) => g.label), ['build pr-fix']);
  one.stop();
  for (let i = 0; i < 50 && !box.second; i++) {
    await slots.tick();
    await new Promise((r) => setTimeout(r, 15));
  }
  await waiting;
  assert.ok(box.second?.id);
  assert.deepEqual(slots.report()!.granted.map((g) => g.label), ['build ui-fix']);
  box.second!.stop();
});

test('unity slots: a crashed holder (process gone) or a silent one (no heartbeat) has its slots freed and the orchestrator told', async (t) => {
  const { dir, slots, events, dead } = arbiter(t, { staleMs: 200 });
  await slots.tick();
  const crash = await (async () => {
    const p = acquire(client(dir, 4242), { count: 1, label: 'peer run', pollMs: 5, heartbeatMs: 60_000 });
    await new Promise((r) => setTimeout(r, 20));
    await slots.tick();
    return p;
  })();
  assert.ok(fs.existsSync(grantFile(dir, crash.id!)));
  dead.add(4242);
  await slots.tick();
  assert.equal(fs.existsSync(reqFile(dir, crash.id!)), false);
  assert.equal(fs.existsSync(grantFile(dir, crash.id!)), false);
  assert.match(events.join('\n'), /freed 1 Unity slot\(s\) of "peer run" \(pid:4242\): its process 4242 is gone/);
  // Alive but silent (suspended, or a pid reused): its file goes stale.
  const silent = await (async () => {
    const p = acquire(client(dir, process.pid), { count: 1, label: 'stuck build', pollMs: 5, heartbeatMs: 60_000 });
    await new Promise((r) => setTimeout(r, 20));
    await slots.tick();
    return p;
  })();
  const old = new Date(Date.now() - 1000);
  fs.utimesSync(reqFile(dir, silent.id!), old, old);
  await slots.tick();
  assert.equal(fs.existsSync(reqFile(dir, silent.id!)), false);
  assert.match(events.at(-1)!, /freed 1 Unity slot\(s\) of "stuck build" .*no heartbeat for \d+ s/);
  assert.equal(slots.report()!.used, 0);
});

test('unity slots: a refused request ends the client with the reason; no arbiter on the machine means no gate', async (t) => {
  const { dir, slots } = arbiter(t, { limit: () => 2 });
  await slots.tick();
  const p = acquire(client(dir, process.pid), { count: 3, label: 'three editors', pollMs: 5 });
  p.catch(() => undefined); // refused before assert.rejects looks
  await assert.rejects(p, (e: Error) => e instanceof SlotRefused && /refused: needs 3 Unity editors at once; this machine allows 2/.test(e.message));
  assert.equal(fs.readdirSync(dir).filter((f) => /^(req|grant|deny)-/.test(f)).length, 0, 'the client removed its files');
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-noarb-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const said: string[] = [];
  const h = await acquire(client(empty, process.pid, said), { count: 1, label: 'x' });
  assert.match(h.ungated!, /no slot arbiter on this machine/);
  assert.match(said[0], /running without a slot/);
});

test('unity slots: `unity start` takes a slot by the same rule: refused behind waiting launches or over the limit, with the counts', async (t) => {
  let procs: Proc[] = [];
  const { dir, slots } = arbiter(t, { limit: () => 2, procs: async () => procs });
  procs = [editorProc(1, 'D:\\ffsb\\a')];
  assert.equal(await slots.startRefusal('sandbox:b'), undefined, 'one free, nobody waiting');
  // A peer run waits for 2: an editor start may not take the slot it waits for.
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(reqFile(dir, 'peer1'), JSON.stringify({ v: 1, id: 'peer1', pid: process.pid, holder: 'pid:1', count: 2, label: 'paired audit', createdAt: new Date().toISOString() }));
  assert.match((await slots.startRefusal('sandbox:b'))!, /^not started: behind 1 earlier request; editors 1 of 2: 1 interactive, 0 batch; 1 launch\(es\) wait ahead of it\. Try again once one ends/);
  fs.rmSync(reqFile(dir, 'peer1'));
  procs = [editorProc(1, 'D:\\a'), editorProc(2, 'D:\\b', true), editorProc(3, 'D:\\c', true)];
  assert.match((await slots.startRefusal('sandbox:b'))!, /^not started: needs 1, 0 free \(3 of 2 in use\); editors 3 of 2: 1 interactive, 2 batch/);
  assert.equal(slots.line(), 'editors 3 of 2: 1 interactive, 2 batch; OVER LIMIT: nothing more starts until it drops');
  assert.equal(denyFile(dir, 'x').endsWith('deny-x.json'), true);
});

test('unity slots: tells the orchestrator once when the machine goes over its limit, and when it is back', async (t) => {
  let procs: Proc[] = [editorProc(1, 'D:\\ffsb\\a'), editorProc(2, 'D:\\nightly\\FinalFactory', true)];
  const { slots, events } = arbiter(t, { limit: () => 1, procs: async () => procs });
  await slots.tick();
  await slots.tick();
  assert.equal(events.length, 1);
  assert.match(events[0], /^Unity editors 2 of 1: 1 interactive, 1 batch on this machine: over its limit\. Nothing more is granted .*nothing is stopped\. Started outside the slot gate: interactive a, batch FinalFactory\.$/);
  procs = [editorProc(1, 'D:\\ffsb\\a')];
  await slots.tick();
  assert.equal(events[1], 'Unity back within its limit on this machine: editors 1 of 1: 1 interactive, 0 batch.');
});

test('unity slots: the CLI: run waits, runs and releases; a second run waits for the first (real processes)', { timeout: 60_000 }, async (t) => {
  const { dir, slots } = arbiter(t, { limit: () => 1 });
  await slots.tick();
  const timer = setInterval(() => void slots.tick(), 40);
  t.after(() => clearInterval(timer));
  const script = path.join(import.meta.dirname, '..', 'machine', 'unitySlots.ts');
  const log = path.join(dir, 'order.log');
  const job = (name: string) =>
    new Promise<number>((resolve) => {
      const body = `const fs=require('fs');fs.appendFileSync(${JSON.stringify(log)},'${name} start '+Date.now()+'\\n');setTimeout(()=>{fs.appendFileSync(${JSON.stringify(log)},'${name} end '+Date.now()+'\\n')},400)`;
      const c = spawn(process.execPath, [script, 'run', '--label', name, '--', process.execPath, '-e', body], { env: { ...process.env, FF_UNITY_SLOTS: dir }, stdio: 'ignore' });
      c.on('exit', (code) => resolve(code ?? -1));
    });
  const [a, b] = await Promise.all([job('first'), new Promise<number>((r) => setTimeout(() => void job('second').then(r), 150))]);
  assert.deepEqual([a, b], [0, 0]);
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' '));
  assert.deepEqual(lines.map((l) => `${l[0]} ${l[1]}`), ['first start', 'first end', 'second start', 'second end'], 'one after the other');
  assert.ok(Number(lines[2][2]) >= Number(lines[1][2]));
});

test('unity slots: CLI arguments, the shims and the mailbox folder', () => {
  assert.deepEqual(parseCli(['run', '--count', '2', '--label', 'paired audit', '--', 'bash', 'audit.sh', '--fast']).o.rest, ['bash', 'audit.sh', '--fast']);
  assert.equal(parseCli(['acquire', '-n', '2']).o.count, 2);
  assert.throws(() => parseCli(['run', '--count', 'two']), /--count takes a number, not "two"/);
  const s = shimScripts('C:\\Program Files\\nodejs\\node.exe', [], 'C:\\Users\\x\\.ff-factory\\app\\machine\\unitySlots.ts');
  assert.equal(s.sh.split('\n')[2], 'exec "C:/Program Files/nodejs/node.exe" "C:/Users/x/.ff-factory/app/machine/unitySlots.ts" "$@"');
  assert.match(s.cmd, /^@echo off\r\n.*\r\n"C:\\Program Files\\nodejs\\node\.exe" "C:\\Users\\x\\\.ff-factory\\app\\machine\\unitySlots\.ts" %\*\r\n$/s);
  assert.equal(slotsDir({}, '/home/u'), path.join('/home/u', '.ff-factory', 'unity-slots'));
  assert.equal(slotsDir({ FF_UNITY_SLOTS: '/tmp/s' }, '/home/u'), '/tmp/s');
});

test('unity slots: a worker-root install\'s mailbox is found through its pointer by scripts outside the daemon', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-slothome-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const rootSlots = path.join(home, 'ff-worker', 'daemon', 'unity-slots');
  fs.mkdirSync(path.dirname(slotsPointer(home)), { recursive: true });
  fs.writeFileSync(slotsPointer(home), JSON.stringify({ dir: rootSlots }));
  assert.equal(slotsDir({}, home), path.join(home, '.ff-factory', 'unity-slots'), 'a pointer to a folder that is gone (an uninstalled root) is ignored');
  fs.mkdirSync(rootSlots, { recursive: true });
  assert.equal(slotsDir({}, home), rootSlots, 'the nightly harness and a build by hand find the root\'s mailbox');
  assert.equal(slotsDir({ FF_UNITY_SLOTS: '/tmp/s' }, home), '/tmp/s', "an agent's own FF_UNITY_SLOTS wins");
});

test('unity slots: system_status, the Capacity block and the dashboard say "editors 4 of 3: 1 interactive, 3 batch"', () => {
  const report: UnitySlotsReport = {
    limit: 3,
    used: 4,
    interactive: 1,
    batch: 3,
    outside: 3,
    players: 2,
    overLimit: true,
    ramPct: 98,
    ramLimitPct: 85,
    waiting: [{ label: 'build bug-1553894544', count: 1, holder: 'sandbox:bug-1553894544', since: '2026-10-05T12:00:00.000Z', why: 'needs 1, 0 free (4 of 3 in use)' }],
    granted: [],
    at: '2026-10-05T12:00:00.000Z',
  };
  const line = 'editors 4 of 3: 1 interactive, 3 batch; OVER LIMIT: nothing more starts until it drops; 1 waiting ("build bug-1553894544" for 1); RAM 98%: new launches wait below 85%; 2 game players (not counted)';
  assert.equal(unitySlotsLine(report), line);
  const GB = 1024 ** 3;
  const stats: MachineStats = { hostname: 'LothDesktop', platform: 'win32', cpuModel: 'Ryzen', cpuCount: 32, loadPct: 100, memTotalBytes: 64 * GB, memFreeBytes: 1 * GB, at: report.at, unity: report };
  assert.match(machineLoadLine({ id: 'lothdesktop' }, stats, true), new RegExp(`; Unity ${line.replace(/[()]/g, '\\$&')}$`));
  const loth: Computer = { id: 'lothdesktop', online: true, live: 3, midTurn: 3, maxAgents: 6, sandboxes: 3, maxSandboxes: 3, freeSandboxes: 0, memUsedBytes: 63 * GB, memTotalBytes: 64 * GB, editors: 4, maxEditors: 3, editorsDetail: line.replace(/^editors \d+ of \S+: /, '') };
  assert.match(capacityLines([loth]).join('\n'), /editors 4 of 3: 1 interactive, 3 batch; OVER LIMIT/);
  const m = { id: 'lothdesktop', online: true, sandboxRoot: 'D:\\work\\ffsb', maxUnity: 3, sandboxes: [], sessionIds: [] } as unknown as Machine;
  const [, pc] = fleetOf({ sessions: [], machines: [m], machineStats: { lothdesktop: stats } });
  assert.deepEqual([pc.editors, pc.editorLimit], [4, 3], 'the dashboard counts every Unity process, not only sandbox editors');
});

test('unity slots: a second arbiter answering the same mailbox is reported once (a hung test daemon granted BEAST\'s slots, w469)', async (t) => {
  const { dir, slots, events } = arbiter(t);
  await slots.tick();
  const rogue = new UnitySlots({ dir, platform: 'win32', procs: async () => [], alive: () => true, now: () => Date.now(), limit: () => undefined, places: () => [], ramPct: () => undefined, machine: 'mx' });
  await rogue.tick();
  await slots.tick();
  await rogue.tick();
  await slots.tick();
  const told = events.filter((e) => e.startsWith('another process'));
  assert.equal(told.length, 1, 'once per arbiter');
  assert.match(told[0], /another process \(pid \d+, machine "mx"\) is answering this machine's Unity slots mailbox .* too, so launches may be granted past the limit/);
});
