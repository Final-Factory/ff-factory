import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { runnerCensus } from '../machine/benchRunners.ts';
import fs from 'node:fs';
import path from 'node:path';
import {
  LOTHDESKTOP_CI_FIRST,
  WIN_CI_FIRST,
  WinCiFirst,
  agentTrees,
  cpuBetween,
  loweredFile,
  priorityName,
  readLowered,
  writeLowered,
  type Lowered,
  type ProcFact,
  type WinCiFirstDeps,
  type WinCiFirstMode,
  type WinCiFirstSettings,
  type WinProc,
} from '../machine/ciFirstWin.ts';

/**
 * w6110: on 2026-11-26 12:54-14:53 UTC a worker's planted CPU hogs (64 to 96 busy loops, w6066) ran at Normal priority beside
 * LothDesktop's ffu runners, and their steps ran 10-25 times slower (a 1-4 min crosscheck took 56 min and timed out). The
 * daemon finds the agents' processes beside a running job and logs what they use; warn only: it sets nothing.
 */
const P = os.constants.priority;
const R2 = 'V:\\ffw\\ffu-runners\\ffu-lothdesktop-2';
const DAEMON = 5;
const BASE: WinProc[] = [
  { pid: 10, ppid: 1, cmd: `"${R2}\\bin\\Runner.Listener.exe" run` },
  { pid: 11, ppid: 10, cmd: `"${R2}\\bin\\Runner.Worker.exe" spawnclient 1 2` },
  { pid: 12, ppid: 11, cmd: 'cargo.exe test' },
  { pid: 20, ppid: DAEMON, cmd: 'node.exe agentHost.ts' }, // an agent host: never counted
  { pid: 21, ppid: 20, cmd: 'claude.exe' },
  { pid: 22, ppid: 21, cmd: 'python.exe hog.py' },
  { pid: 23, ppid: 21, cmd: 'Unity.exe -batchmode' }, // already BelowNormal
  { pid: 30, ppid: DAEMON, cmd: 'node.exe agentHost.ts' },
  { pid: 31, ppid: 30, cmd: 'claude.exe' },
];

function rig(o: { settings?: WinCiFirstSettings | null; procs?: WinProc[]; mode?: WinCiFirstMode; record?: Lowered; prio?: [number, number][] } = {}) {
  let procs = o.procs ?? BASE;
  const prio = new Map<number, number>([...[10, 11, 12, 20, 21, 22, 30].map((p) => [p, P.PRIORITY_NORMAL] as [number, number]), [23, P.PRIORITY_BELOW_NORMAL], [31, P.PRIORITY_ABOVE_NORMAL]]);
  const started = new Map<number, number>(procs.map((p) => [p.pid, 100 + p.pid])); // parents start before children
  const cpuMs = new Map<number, number>();
  const lines: string[] = [];
  const asked: number[][] = [];
  let now = 1_000_000;
  let busy = 0;
  let fail = false;
  let factsFail = false;
  let held = false;
  let record: Lowered = o.record ?? {};
  const set: [number, number][] = [];
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
    facts: async (pids) => {
      if (factsFail) throw new Error('inspecting processes failed (1)');
      asked.push(pids);
      return pids.filter((p) => procs.some((x) => x.pid === p)).map((p): ProcFact => ({ pid: p, startedAt: started.get(p), cpuMs: cpuMs.get(p) ?? 0 }));
    },
    machineBusyMs: () => busy,
    self: DAEMON,
    mode: o.mode,
    held: () => held,
    setPriority: (pid, p) => {
      if (!prio.has(pid)) return false;
      prio.set(pid, p);
      set.push([pid, p]);
      return true;
    },
    record: { read: () => ({ ...record }), write: (l) => void (record = { ...l }) },
    now: () => now,
    log: (l) => void lines.push(l),
  };
  for (const [pid, p] of o.prio ?? []) prio.set(pid, p);
  return {
    cf: new WinCiFirst(d),
    set,
    record: () => record,
    setHeld: (h: boolean) => void (held = h),
    prio,
    started,
    lines,
    asked,
    burn: (pid: number, ms: number) => {
      cpuMs.set(pid, (cpuMs.get(pid) ?? 0) + ms);
      busy += ms;
    },
    advance: (ms: number) => void (now += ms),
    setProcs: (p: WinProc[]) => void (procs = p),
    setFail: (f: boolean) => void (fail = f),
    setFactsFail: (f: boolean) => void (factsFail = f),
  };
}

test('lothdesktop is the one Windows CI-first machine, BelowNormal', () => {
  assert.equal(WIN_CI_FIRST.lothdesktop, LOTHDESKTOP_CI_FIRST);
  assert.deepEqual(Object.keys(WIN_CI_FIRST), ['lothdesktop']);
  assert.equal(LOTHDESKTOP_CI_FIRST.priority, P.PRIORITY_BELOW_NORMAL);
  assert.equal(priorityName(P.PRIORITY_NORMAL), 'Normal');
  assert.equal(priorityName(P.PRIORITY_BELOW_NORMAL), 'BelowNormal');
  assert.equal(priorityName(P.PRIORITY_LOW), 'Idle');
  assert.equal(priorityName(P.PRIORITY_ABOVE_NORMAL), 'AboveNormal');
});

test('no settings: disabled, does nothing', async () => {
  const r = rig({ settings: null });
  assert.equal(r.cf.enabled, false);
  assert.equal(await r.cf.tick(), undefined);
  assert.deepEqual(r.lines, []);
  assert.deepEqual(r.asked, []);
});

test('beside a job: the job and the agents are logged, with the machine, the jobs, each agent and the rest in cores', async () => {
  const r = rig();
  const first = await r.cf.tick();
  assert.equal(first?.jobs, 1);
  // 22 (Normal) runs above BelowNormal; 21 and 31 are the hosts' own children (claude) and 23 a Unity, none of them a tool;
  // the hosts 20 and 30 are not counted
  assert.equal(first?.above, 1);
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /CI job\(s\) running: ffu-lothdesktop-2 \(worker 11 at Normal\); 2 agent\(s\) beside them; 1 of their tools' process\(es\) run above BelowNormal, which enforcing would lower \(warn only, w6110\)/);
  r.advance(120_000); // an uneven tick: the window says what it was
  r.burn(22, 120_000 * 12); // a 12-core hog
  r.burn(12, 120_000 * 2);
  r.burn(999, 120_000 * 1); // something outside both (an editor, an orphan): the rest
  const second = await r.cf.tick();
  assert.equal(second?.windowMs, 120_000);
  assert.equal(second?.agentCores?.aaaa1111, 12);
  assert.equal(second?.agentCores?.bbbb2222, 0);
  assert.equal(second?.jobCores, 2);
  assert.equal(second?.machineCores, 15);
  assert.match(r.lines[1], /over the last 120 s the machine used 15\.0 of \d+ cores: the CI job\(s\) on ffu-lothdesktop-2 \(worker 11 at Normal\) 2\.0, FF Factory's agents 12\.0 \(aaaa1111 12\.0\), the rest 1\.0/);
  // rate-limited: the next minute's hog says nothing new
  r.advance(60_000);
  r.burn(22, 60_000 * 12);
  await r.cf.tick();
  assert.equal(r.lines.length, 2);
  assert.equal(r.prio.get(22), P.PRIORITY_NORMAL);
});

test('a process new since the last tick counts in full', async () => {
  const r = rig();
  await r.cf.tick();
  r.advance(60_000);
  r.setProcs([...BASE, { pid: 24, ppid: 21, cmd: 'rustc.exe' }]);
  r.started.set(24, 1_030_000); // started inside the window
  r.burn(24, 60_000 * 5);
  const res = await r.cf.tick();
  assert.equal(res?.agentCores?.aaaa1111, 5);
});

test('a reused pid is not walked into: a parent that started after its child is not its parent', () => {
  // 40's real parent died; the daemon's old pid... any pid can come back as an unrelated process. 41 names 21 as parent but
  // started before 21 did; 50 is another host, 51 its claude, and 60 the daemon's child: none are agent 20's.
  const procs = [
    { pid: 20, ppid: 5 },
    { pid: 21, ppid: 20 },
    { pid: 41, ppid: 21 },
    { pid: 50, ppid: 21 },
    { pid: 51, ppid: 50 },
    { pid: 5, ppid: 21 },
    { pid: 60, ppid: 5 },
  ];
  const started = new Map([
    [20, 1_000],
    [21, 2_000],
    [41, 500],
    [50, 3_000],
    [51, 3_100],
    [5, 2_500],
    [60, 2_600],
  ]);
  const trees = agentTrees([20, 50], procs, new Set([20, 50, 5]), started);
  assert.deepEqual(trees.get(20), [21]);
  assert.deepEqual(trees.get(50), [51]);
  // a pid with no start time read is not walked into either
  assert.deepEqual(agentTrees([20], procs, new Set([20]), new Map([[20, 1_000]])).get(20), []);
});

test("a runner started under an agent host is the job's, not the agent's", async () => {
  const procs = [...BASE, { pid: 40, ppid: 21, cmd: `"${R2}\\bin\\Runner.Worker.exe" spawnclient` }, { pid: 41, ppid: 40, cmd: 'cargo.exe' }];
  const r = rig({ procs });
  r.prio.set(40, P.PRIORITY_NORMAL);
  r.prio.set(41, P.PRIORITY_NORMAL);
  assert.equal((await r.cf.tick())?.above, 1);
  r.advance(60_000);
  r.burn(41, 60_000 * 3);
  const res = await r.cf.tick();
  assert.equal(res?.agentCores?.aaaa1111, 0);
  assert.equal(res?.jobCores, 3);
});

test('no job: nothing read beyond the listing and nothing logged; a job ending is logged once', async () => {
  const idle = BASE.filter((p) => p.pid !== 11 && p.pid !== 12);
  const r = rig({ procs: idle });
  assert.equal((await r.cf.tick())?.jobs, 0);
  assert.deepEqual(r.lines, []);
  assert.deepEqual(r.asked, []);
  r.setProcs(BASE);
  await r.cf.tick();
  r.setProcs(idle);
  await r.cf.tick();
  await r.cf.tick();
  assert.equal(r.lines.length, 2);
  assert.match(r.lines[1], /no CI job running now/);
});

test('a failing process listing or CPU read is survived and said once per streak', async () => {
  const r = rig();
  r.setFail(true);
  assert.equal(await r.cf.tick(), undefined);
  assert.equal(await r.cf.tick(), undefined);
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /could not list processes: Get-CimInstance timed out/);
  r.setFail(false);
  assert.equal((await r.cf.tick())?.jobs, 1);
  assert.match(r.lines[1], /answers again/);
  r.setFactsFail(true);
  await r.cf.tick();
  await r.cf.tick();
  assert.equal(r.lines.filter((l) => /could not read the processes' start times and CPU/.test(l)).length, 1);
  r.setFactsFail(false);
  r.advance(60_000);
  const back = await r.cf.tick();
  assert.equal(back?.windowMs, undefined); // no baseline across the gap
  assert.match(r.lines.at(-1)!, /read again/);
});

test('ticks never overlap: one still waiting on its listing makes the next return at once', async () => {
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  let calls = 0;
  const cf = new WinCiFirst({
    settings: LOTHDESKTOP_CI_FIRST,
    procs: async () => {
      calls++;
      await gate;
      return [];
    },
    census: (ps) => runnerCensus(ps),
    hosts: () => [],
    priorityOf: () => undefined,
    facts: async () => [],
    machineBusyMs: () => 0,
    self: 1,
    now: () => 0,
    log: () => {},
  });
  const a = cf.tick();
  assert.equal(await cf.tick(), undefined);
  release();
  assert.equal((await a)?.jobs, 0);
  assert.equal(calls, 1);
});

test('cpuBetween: a difference for one read twice, in full for one new in the window, nothing for a reused pid from before', () => {
  const before = new Map([
    ['1@5', 1000],
    ['2@5', 0],
  ]);
  const after: ProcFact[] = [
    { pid: 1, startedAt: 5, cpuMs: 4000 },
    { pid: 2, startedAt: 50, cpuMs: 9000 }, // pid 2 again, a new process started in the window
    { pid: 3, startedAt: 1, cpuMs: 7000 }, // not read last time and older than the window: no baseline
  ];
  assert.equal(cpuBetween(before, after, 10), 3000 + 9000);
});

test("an adopted host whose old parent pid a job's process got again stays the agents', not the job's", async () => {
  // after a daemon restart host 20's parent pid is the old daemon's; a job's rustc now has that pid
  const procs = BASE.map((p) => (p.pid === 20 ? { ...p, ppid: 77 } : p)).concat([{ pid: 77, ppid: 12, cmd: 'rustc.exe' }]);
  const r = rig({ procs });
  r.prio.set(77, P.PRIORITY_NORMAL);
  assert.equal((await r.cf.tick())?.above, 1);
  r.advance(60_000);
  r.burn(22, 60_000 * 8);
  const res = await r.cf.tick();
  assert.equal(res?.agentCores?.aaaa1111, 8);
  assert.equal(res?.jobCores, 0);
});

test("a job whose first CPU read fails still gets its start line once the read answers", async () => {
  const r = rig();
  r.setFactsFail(true);
  await r.cf.tick();
  r.setFactsFail(false);
  await r.cf.tick();
  assert.equal(r.lines.filter((l) => /CI job\(s\) running/.test(l)).length, 1);
});

// ---- enforce (w6110's second step): daemon.json winCiFirst "enforce" ----

test("enforce: beside a job only an agent's tools go to BelowNormal, recorded with what they had; hosts, claude, Unity and the job keep theirs", async () => {
  const procs = [...BASE, { pid: 24, ppid: 23, cmd: 'bee_backend.exe' }];
  const r = rig({ procs, mode: 'enforce', prio: [[24, P.PRIORITY_NORMAL]] });
  const res = await r.cf.tick();
  assert.equal(res?.lowered, 1);
  assert.deepEqual(r.set, [[22, P.PRIORITY_BELOW_NORMAL]]);
  for (const pid of [10, 11, 12, 20, 21, 24, 30]) assert.equal(r.prio.get(pid), P.PRIORITY_NORMAL, `pid ${pid}`);
  assert.equal(r.prio.get(31), P.PRIORITY_ABOVE_NORMAL);
  assert.deepEqual(r.record(), { '22@122': { prev: P.PRIORITY_NORMAL, at: 1_000_000 } });
  assert.match(r.lines.join('\n'), /lowered 1 of the agents' tools' process\(es\) to BelowNormal beside the CI job\(s\), so the jobs go first \(w6110\): 22 python\.exe/);
  assert.match(r.lines.join('\n'), /1 of their tools' process\(es\) lowered to BelowNormal so far/);
  // the next tick finds it BelowNormal already: nothing set again
  r.advance(60_000);
  assert.equal((await r.cf.tick())?.lowered, 0);
  assert.equal(r.set.length, 1);
});

test('warn (the default) sets nothing even with a way to set', async () => {
  const r = rig();
  await r.cf.tick();
  r.advance(60_000);
  await r.cf.tick();
  assert.deepEqual(r.set, []);
  assert.deepEqual(r.record(), {});
});

test("enforce: a bench or a person's turn raises what was lowered (and what it started since) back, and lowers nothing until it ends", async () => {
  const procs = [...BASE, { pid: 25, ppid: 22, cmd: 'python.exe child.py' }, { pid: 26, ppid: 22, cmd: 'python.exe old.py' }];
  const r = rig({ procs, mode: 'enforce', prio: [[26, P.PRIORITY_BELOW_NORMAL]] });
  r.started.set(25, 2_000_000); // started after 22 was lowered, so it inherited BelowNormal
  r.prio.set(25, P.PRIORITY_BELOW_NORMAL);
  await r.cf.tick();
  assert.equal(r.prio.get(22), P.PRIORITY_BELOW_NORMAL);
  r.setHeld(true);
  r.advance(60_000);
  const res = await r.cf.tick();
  assert.equal(res?.raised, 2);
  assert.equal(r.prio.get(22), P.PRIORITY_NORMAL);
  assert.equal(r.prio.get(25), P.PRIORITY_NORMAL);
  assert.equal(r.prio.get(26), P.PRIORITY_BELOW_NORMAL, 'BelowNormal of its own before 22 was lowered: left alone');
  assert.deepEqual(r.record(), {});
  assert.equal(res?.lowered, 0);
  r.advance(60_000);
  await r.cf.tick();
  assert.equal(r.prio.get(22), P.PRIORITY_NORMAL, 'nothing lowered while the turn holds');
  assert.match(r.lines.join('\n'), /a bench or a person's turn holds this machine: what was lowered is raised back/);
  r.setHeld(false);
  r.advance(60_000);
  await r.cf.tick();
  assert.equal(r.prio.get(22), P.PRIORITY_BELOW_NORMAL, 'lowered again once the turn ends');
  assert.match(r.lines.join('\n'), /the turn holding this machine ended/);
});

test('enforce: once no CI job runs, what was lowered goes back', async () => {
  const r = rig({ mode: 'enforce' });
  await r.cf.tick();
  assert.equal(r.prio.get(22), P.PRIORITY_BELOW_NORMAL);
  r.setProcs(BASE.filter((p) => p.pid !== 11 && p.pid !== 12));
  r.advance(60_000);
  const res = await r.cf.tick();
  assert.equal(res?.jobs, 0);
  assert.equal(res?.raised, 1);
  assert.equal(r.prio.get(22), P.PRIORITY_NORMAL);
  assert.deepEqual(r.record(), {});
});

test('a daemon started with warn or off raises what the record holds; a reused pid (another start time) is left alone', async () => {
  for (const mode of ['warn', 'off'] as const) {
    const r = rig({
      mode,
      record: { '22@122': { prev: P.PRIORITY_NORMAL, at: 500 }, '31@999': { prev: P.PRIORITY_NORMAL, at: 500 } },
      prio: [[22, P.PRIORITY_BELOW_NORMAL]],
    });
    r.prio.set(31, P.PRIORITY_BELOW_NORMAL); // 31 started at 131, not 999: another process with that pid
    const res = await r.cf.tick();
    assert.equal(res?.raised, 1, mode);
    assert.equal(r.prio.get(22), P.PRIORITY_NORMAL);
    assert.equal(r.prio.get(31), P.PRIORITY_BELOW_NORMAL);
    assert.deepEqual(r.record(), {});
    assert.match(r.lines[0], new RegExp(`raised 1 process\\(es\\) back to the priority they had \\(winCiFirst is ${mode}; 2 were recorded as lowered, 1 of them still run\\)`));
    if (mode === 'off') assert.equal(r.lines.length, 1, 'off: nothing else is read or said');
  }
});

test('the record file: written atomically under <root>/tmp, bad entries dropped, removed when empty', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w6110-'));
  try {
    assert.deepEqual(readLowered(root), {});
    writeLowered(root, { '22@122': { prev: 0, at: 5 } });
    assert.deepEqual(readLowered(root), { '22@122': { prev: 0, at: 5 } });
    fs.writeFileSync(loweredFile(root), JSON.stringify({ '22@122': { prev: 0, at: 5 }, bad: { prev: 0, at: 1 }, '7@1': { prev: 'x' } }));
    assert.deepEqual(readLowered(root), { '22@122': { prev: 0, at: 5 } });
    fs.writeFileSync(loweredFile(root), 'not json');
    assert.deepEqual(readLowered(root), {});
    writeLowered(root, {});
    assert.equal(fs.existsSync(loweredFile(root)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
