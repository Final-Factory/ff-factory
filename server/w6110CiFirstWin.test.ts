import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { runnerCensus } from '../machine/benchRunners.ts';
import { LOTHDESKTOP_CI_FIRST, WIN_CI_FIRST, WinCiFirst, coresBetween, priorityName, type WinCiFirstDeps, type WinCiFirstSettings, type WinProc } from '../machine/ciFirstWin.ts';

/**
 * w6110: on 2026-11-26 12:54-14:53 UTC a worker's planted CPU hogs (64 to 96 busy loops, w6066) ran at Normal priority beside
 * LothDesktop's ffu runners, and their steps ran 10-25 times slower (a 1-4 min crosscheck took 56 min and timed out). The
 * daemon puts the agents' processes below the runners' jobs by priority class; warn only first: nothing is set.
 */
const P = os.constants.priority;
const R2 = 'V:\\ffw\\ffu-runners\\ffu-lothdesktop-2';
const BASE: WinProc[] = [
  { pid: 10, ppid: 1, cmd: `"${R2}\\bin\\Runner.Listener.exe" run` },
  { pid: 11, ppid: 10, cmd: `"${R2}\\bin\\Runner.Worker.exe" spawnclient 1 2` },
  { pid: 12, ppid: 11, cmd: 'cargo.exe test' },
  { pid: 20, ppid: 1, cmd: 'node.exe agentHost.ts' }, // the agent host: never touched
  { pid: 21, ppid: 20, cmd: 'claude.exe' },
  { pid: 22, ppid: 21, cmd: 'python.exe hog.py' },
  { pid: 23, ppid: 21, cmd: 'Unity.exe -batchmode' }, // already BelowNormal
  { pid: 30, ppid: 1, cmd: 'node.exe agentHost.ts' },
  { pid: 31, ppid: 30, cmd: 'claude.exe' },
];

function rig(o: { settings?: WinCiFirstSettings | null; procs?: WinProc[] } = {}) {
  let procs = o.procs ?? BASE;
  const prio = new Map<number, number>([
    [10, P.PRIORITY_NORMAL],
    [11, P.PRIORITY_NORMAL],
    [12, P.PRIORITY_NORMAL],
    [20, P.PRIORITY_NORMAL],
    [21, P.PRIORITY_NORMAL],
    [22, P.PRIORITY_NORMAL],
    [23, P.PRIORITY_BELOW_NORMAL],
    [30, P.PRIORITY_NORMAL],
    [31, P.PRIORITY_ABOVE_NORMAL],
  ]);
  const cpuMs = new Map<number, number>([...prio.keys()].map((p) => [p, 0]));
  const set: string[] = [];
  const lines: string[] = [];
  let now = 1_000_000;
  let fail = false;
  const d: WinCiFirstDeps = {
    settings: o.settings === null ? undefined : (o.settings ?? LOTHDESKTOP_CI_FIRST),
    procs: async () => {
      if (fail) throw new Error('Get-CimInstance timed out');
      return procs;
    },
    census: (ps) => runnerCensus(ps),
    hosts: () => [
      { session: 'aaaa1111', pid: 20 },
      { session: 'bbbb2222', pid: 30 },
    ],
    priorityOf: (pid) => prio.get(pid),
    setPriority: (pid, p) => (set.push(`${pid} ${p}`), prio.set(pid, p), true),
    cpu: async (pids) => new Map(pids.filter((p) => cpuMs.has(p)).map((p) => [`${p}@7`, cpuMs.get(p)!])),
    now: () => now,
    log: (l) => void lines.push(l),
  };
  return {
    cf: new WinCiFirst(d),
    prio,
    set,
    lines,
    burn: (pid: number, ms: number) => void cpuMs.set(pid, (cpuMs.get(pid) ?? 0) + ms),
    advance: (ms: number) => void (now += ms),
    setProcs: (p: WinProc[]) => void (procs = p),
    setFail: (f: boolean) => void (fail = f),
  };
}

test('lothdesktop is a Windows CI-first machine, warn only, BelowNormal', () => {
  assert.equal(WIN_CI_FIRST.lothdesktop, LOTHDESKTOP_CI_FIRST);
  assert.equal(LOTHDESKTOP_CI_FIRST.enforce, false);
  assert.equal(LOTHDESKTOP_CI_FIRST.priority, P.PRIORITY_BELOW_NORMAL);
  assert.equal(Object.keys(WIN_CI_FIRST).length, 1);
  assert.equal(priorityName(P.PRIORITY_NORMAL), 'Normal');
  assert.equal(priorityName(P.PRIORITY_BELOW_NORMAL), 'BelowNormal');
  assert.equal(priorityName(P.PRIORITY_LOW), 'Idle');
  assert.equal(priorityName(P.PRIORITY_ABOVE_NORMAL), 'AboveNormal');
});

test('no settings: disabled, does nothing', async () => {
  const r = rig({ settings: null });
  assert.equal(r.cf.enabled, false);
  assert.equal(await r.cf.tick(), undefined);
  assert.deepEqual(r.set, []);
  assert.deepEqual(r.lines, []);
});

test('warn only: nothing is set; the job and the agents beside it are logged with their cores', async () => {
  const r = rig();
  const first = await r.cf.tick();
  assert.equal(first?.jobs, 1);
  // 21, 22 (Normal) and 31 (AboveNormal) would be lowered; 23 is BelowNormal already; the hosts 20 and 30 are not counted
  assert.equal(first?.above, 3);
  assert.equal(first?.lowered, 0);
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /CI job\(s\) running: ffu-lothdesktop-2 \(worker 11 at Normal\); 2 agent\(s\) beside them; 3 of their process\(es\) run above BelowNormal, which enforcing would lower \(warn only, w6110\)/);
  r.advance(60_000);
  r.burn(22, 60_000 * 12); // a 12-core hog
  r.burn(12, 60_000 * 2);
  const second = await r.cf.tick();
  assert.equal(second?.agentCores?.aaaa1111, 12);
  assert.equal(second?.agentCores?.bbbb2222, 0);
  assert.equal(second?.jobCores, 2);
  assert.match(r.lines[1], /agents used 12\.0 of \d+ cores over the last 60 s \(aaaa1111 12\.0\) and the jobs 2\.0/);
  // rate-limited: the next minute's hog says nothing new
  r.advance(60_000);
  r.burn(22, 60_000 * 12);
  await r.cf.tick();
  assert.equal(r.lines.length, 2);
  assert.deepEqual(r.set, []);
  assert.equal(r.prio.get(22), P.PRIORITY_NORMAL);
});

test('enforce: only agents\' processes above the setting go down; the runner, its job and the hosts are never touched', async () => {
  const r = rig({ settings: { ...LOTHDESKTOP_CI_FIRST, enforce: true } });
  const res = await r.cf.tick();
  assert.equal(res?.lowered, 3);
  assert.deepEqual(r.set.sort(), [`21 ${P.PRIORITY_BELOW_NORMAL}`, `22 ${P.PRIORITY_BELOW_NORMAL}`, `31 ${P.PRIORITY_BELOW_NORMAL}`]);
  for (const pid of [10, 11, 12, 20, 30]) assert.equal(r.prio.get(pid), P.PRIORITY_NORMAL, `pid ${pid}`);
  assert.match(r.lines.join('\n'), /lowered 3 of the agents' process\(es\) to BelowNormal/);
  // nothing above any more: nothing set again
  const again = await r.cf.tick();
  assert.equal(again?.lowered, 0);
  assert.equal(r.set.length, 3);
});

test('a job that runs under an agent host (a worker running a runner by hand) is not lowered', async () => {
  const procs = [...BASE, { pid: 40, ppid: 21, cmd: `"${R2}\\bin\\Runner.Worker.exe" spawnclient` }, { pid: 41, ppid: 40, cmd: 'cargo.exe' }];
  const r = rig({ settings: { ...LOTHDESKTOP_CI_FIRST, enforce: true }, procs });
  r.prio.set(40, P.PRIORITY_NORMAL);
  r.prio.set(41, P.PRIORITY_NORMAL);
  await r.cf.tick();
  assert.equal(r.prio.get(40), P.PRIORITY_NORMAL);
  assert.equal(r.prio.get(41), P.PRIORITY_NORMAL);
});

test('no job: nothing logged; a job ending is logged once', async () => {
  const idle = BASE.filter((p) => p.pid !== 11 && p.pid !== 12);
  const r = rig({ procs: idle });
  assert.equal((await r.cf.tick())?.jobs, 0);
  assert.deepEqual(r.lines, []);
  r.setProcs(BASE);
  await r.cf.tick();
  r.setProcs(idle);
  await r.cf.tick();
  await r.cf.tick();
  assert.equal(r.lines.length, 2);
  assert.match(r.lines[1], /no CI job running now/);
});

test('a failing process listing is survived and said once per streak', async () => {
  const r = rig();
  r.setFail(true);
  assert.equal(await r.cf.tick(), undefined);
  assert.equal(await r.cf.tick(), undefined);
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /could not list processes: Get-CimInstance timed out/);
  r.setFail(false);
  assert.equal((await r.cf.tick())?.jobs, 1);
  assert.match(r.lines[1], /answers again/);
});

test('coresBetween counts only processes read on both ticks', () => {
  const a = new Map([
    ['1@5', 1000],
    ['2@5', 0],
  ]);
  const b = new Map([
    ['1@5', 4000],
    ['2@6', 9000], // pid reused: a new process, no baseline
  ]);
  assert.equal(coresBetween(a, b, () => true, 1000), 3);
  assert.equal(coresBetween(a, b, () => true, 0), 0);
});
