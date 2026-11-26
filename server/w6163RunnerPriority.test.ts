import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import type { RunnerCensus } from '../machine/benchRunners.ts';
import type { Proc } from '../machine/unity.ts';
import {
  CLASS,
  RUNNER_PRIORITY_ENFORCE,
  RunnerPriority,
  TASK_EVERY_MS,
  listenerChain,
  parseProcRows,
  parseTaskRows,
  processPriorityScript,
  prioLow,
  runnerPriorityMode,
  runnerTaskScript,
  type Prio,
  type ProcRow,
  type RunnerPriorityMode,
  type TaskRow,
} from '../machine/runnerPriority.ts';

/**
 * w6163: LothDesktop's ffu runners ran their jobs at BelowNormal after the daemon started them with Start-ScheduledTask (task
 * priority 7; logged 2026-11-26 17:46Z), and at Normal after a logon start. The daemon reads (warn) or sets (enforce) the
 * tasks to 4 and the listener and its cmd/conhost parents to Normal class, I/O and memory priority; never on BEAST.
 */
const P = os.constants.priority;
const R1 = 'V:/ffw/ffu-runners/ffu-lothdesktop-1';
const R2 = 'V:/ffw/ffu-runners/ffu-lothdesktop-2';
const LOW: Prio = { cls: CLASS.BELOW_NORMAL, io: 1, mem: 2 };
const NORMAL: Prio = { cls: CLASS.NORMAL, io: 2, mem: 5 };

// conhost 101 -> cmd 102 -> cmd 103 (run-helper) -> listener 11; svchost 100 above (the task's host): the chain stops there
const PROCS: Proc[] = [
  { pid: 100, ppid: 4, cmd: 'svchost.exe -k netsvcs', name: 'svchost.exe' },
  { pid: 101, ppid: 100, cmd: `conhost.exe --headless cmd.exe /c cd /d "${R1}" && run.cmd`, name: 'conhost.exe' },
  { pid: 102, ppid: 101, cmd: 'cmd.exe /c run.cmd', name: 'cmd.exe' },
  { pid: 103, ppid: 102, cmd: 'cmd /c run-helper.cmd', name: 'cmd.exe' },
  { pid: 11, ppid: 103, cmd: `"${R1}\\bin\\Runner.Listener.exe" run`, name: 'Runner.Listener.exe' },
  { pid: 12, ppid: 1, cmd: `"${R2}\\bin\\Runner.Listener.exe" run`, name: 'Runner.Listener.exe' },
];

function rig(mode: RunnerPriorityMode, o: { cls?: Record<number, number>; tasks?: (roots: string[], fix: boolean) => TaskRow[]; raise?: (pids: number[], fix: boolean) => ProcRow[]; census?: RunnerCensus } = {}) {
  const cls: Record<number, number> = { ...(o.cls ?? { 11: P.PRIORITY_BELOW_NORMAL, 101: P.PRIORITY_BELOW_NORMAL, 102: P.PRIORITY_BELOW_NORMAL, 103: P.PRIORITY_BELOW_NORMAL, 12: P.PRIORITY_NORMAL }) };
  const lines: string[] = [];
  const raises: { pids: number[]; fix: boolean }[] = [];
  const taskCalls: { roots: string[]; fix: boolean }[] = [];
  const state = {
    now: 1_000_000,
    census: o.census ?? { listeners: [{ pid: 11, root: R1, busy: false }, { pid: 12, root: R2, busy: true }], workers: [{ pid: 21, root: R2 }], leftovers: [] },
  };
  const rp = new RunnerPriority({
    mode,
    procs: async () => PROCS,
    census: () => state.census,
    priorityOf: (pid) => cls[pid],
    raise: async (pids, fix) => {
      raises.push({ pids, fix });
      if (o.raise) return o.raise(pids, fix);
      return pids.map((pid) => {
        const before = cls[pid] === P.PRIORITY_NORMAL ? NORMAL : LOW;
        if (fix) cls[pid] = P.PRIORITY_NORMAL;
        return { pid, before, after: fix ? NORMAL : before };
      });
    },
    tasks: async (roots, fix) => {
      taskCalls.push({ roots, fix });
      return o.tasks ? o.tasks(roots, fix) : roots.map((root) => ({ root, task: `\\${root.split('/').pop()}`, before: 7, after: fix ? 4 : 7 }));
    },
    now: () => state.now,
    log: (l) => lines.push(l),
  });
  return { rp, lines, raises, taskCalls, state, cls };
}

test('w6163: the first step enforces nowhere; BEAST never; off off Windows and in test rigs; daemon.json wins', () => {
  assert.equal(RUNNER_PRIORITY_ENFORCE.size, 0);
  assert.equal(runnerPriorityMode('lothdesktop', 'win32', true), 'warn');
  assert.equal(runnerPriorityMode('beast', 'win32', true), 'warn');
  assert.equal(runnerPriorityMode('lothdesktop', 'win32', true, 'enforce'), 'enforce');
  assert.equal(runnerPriorityMode('lothdesktop', 'win32', true, 'off'), 'off');
  assert.equal(runnerPriorityMode('biscuit', 'linux', true), 'off');
  assert.equal(runnerPriorityMode('lothdesktop', 'win32', false, 'enforce'), 'off');
});

test('w6163: the chain is the listener and the cmd/conhost it runs under, stopping at the task host and at a younger parent', () => {
  assert.deepEqual(listenerChain(11, PROCS), [11, 103, 102, 101]);
  assert.deepEqual(listenerChain(12, PROCS), [12]);
  const started: Record<number, number> = { 11: 50, 103: 40, 102: 60, 101: 10 };
  assert.deepEqual(listenerChain(11, PROCS, (p) => started[p]), [11, 103], 'a parent pid that started after its child is another process');
});

test('w6163: enforce sets the tasks to 4 and raises the listener and its parents in class, I/O and memory, once', async () => {
  const { rp, lines, raises, taskCalls } = rig('enforce');
  await rp.tick();
  assert.deepEqual(taskCalls, [{ roots: [R1, R2], fix: true }]);
  assert.deepEqual(raises, [{ pids: [11, 103, 102, 101], fix: true }, { pids: [12], fix: true }]);
  assert.ok(lines.some((l) => l.includes("set ffu-lothdesktop-1's scheduled task \\ffu-lothdesktop-1 from priority 7 (BelowNormal) to 4 (Normal)")), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes("raised ffu-lothdesktop-1's listener (pid 11) from BelowNormal, I/O 1, memory 2 to Normal, I/O 2, memory 5, and its 3 parent(s)")), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes("ffu-lothdesktop-2's listener (pid 12) and its 0 parent(s) run at Normal")), lines.join('\n'));
  const n = lines.length;
  await rp.tick();
  assert.equal(taskCalls.length, 1, 'the tasks are read again only after TASK_EVERY_MS');
  assert.equal(raises.length, 2, 'a listener read once and at Normal class is not read again');
  assert.equal(lines.length, n, 'nothing new is said');
});

test('w6163: a listener whose class reads low again after a raise (run.cmd relaunched it) is raised again', async () => {
  const { rp, raises, cls } = rig('enforce');
  await rp.tick();
  cls[11] = P.PRIORITY_BELOW_NORMAL;
  await rp.tick();
  assert.equal(raises.length, 3);
  assert.deepEqual(raises[2], { pids: [11, 103, 102, 101], fix: true });
});

test('w6163: warn (BEAST, and lothdesktop in the first step) sets nothing, reads each listener once and says what it read', async () => {
  const { rp, lines, raises, taskCalls } = rig('warn');
  await rp.tick();
  await rp.tick();
  assert.ok(raises.every((r) => !r.fix) && taskCalls.every((t) => !t.fix));
  assert.equal(raises.length, 2);
  assert.ok(lines.some((l) => l.includes('runs at priority 7 (BelowNormal)') && l.includes('only reports it')), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes("ffu-lothdesktop-1's listener (pid 11) runs at BelowNormal, I/O 1, memory 2, 4 of it and its 3 parent(s) below Normal") && l.includes('only reports it')), lines.join('\n'));
});

test('w6163: off does nothing at all', async () => {
  const { rp, lines, raises, taskCalls } = rig('off');
  await rp.tick();
  assert.deepEqual([lines, raises, taskCalls], [[], [], []]);
});

test('w6163: only ffu- runners are looked at', async () => {
  const { rp, raises, taskCalls } = rig('enforce', { census: { listeners: [{ pid: 11, root: 'V:/ffw/actions-runner', busy: false }], workers: [], leftovers: [] } });
  await rp.tick();
  assert.deepEqual([raises, taskCalls], [[], []]);
});

test('w6163: a raise that fails or leaves a process low is said once; a failing read is said once', async () => {
  const a = rig('enforce', { raise: (pids) => pids.map((pid) => ({ pid, before: LOW, after: LOW, error: 'class: error 5' })) });
  await a.rp.tick();
  await a.rp.tick();
  assert.equal(a.lines.filter((l) => l.includes("could not raise ffu-lothdesktop-1's listener (pid 11)")).length, 1, a.lines.join('\n'));
  const b = rig('enforce', { raise: (pids) => pids.map((pid) => ({ pid, before: LOW, after: { ...NORMAL, mem: 4 } })) });
  await b.rp.tick();
  assert.ok(b.lines.some((l) => l.includes('but 4 still read below Normal')), b.lines.join('\n'));
  const c = rig('warn', {
    raise: () => {
      throw new Error('powershell exited 1');
    },
  });
  await c.rp.tick();
  await c.rp.tick();
  assert.equal(c.lines.filter((l) => l.includes("could not read the runners' process priorities")).length, 1);
});

test('w6163: the tasks are read again after an hour and for a runner folder not seen before', async () => {
  const { rp, taskCalls, state } = rig('enforce');
  await rp.tick();
  state.now += TASK_EVERY_MS;
  await rp.tick();
  assert.equal(taskCalls.length, 2);
  state.census = { ...state.census, listeners: [...state.census.listeners, { pid: 13, root: 'V:/ffw/ffu-runners/ffu-lothdesktop-3', busy: false }] };
  await rp.tick();
  assert.equal(taskCalls.length, 3);
});

test('w6163: a task that could not be set, no task, a bad folder and a read that fails are each said once', async () => {
  let fail = false;
  const { rp, lines, state } = rig('enforce', {
    tasks: (roots) => {
      if (fail) throw new Error('Access is denied.');
      return [{ root: roots[0]!, task: '\\ffu-lothdesktop-1', before: 7, after: 7, error: 'Access is denied.' }, { root: roots[1]! }];
    },
  });
  await rp.tick();
  assert.ok(lines.some((l) => l.includes("could not set ffu-lothdesktop-1's scheduled task") && l.includes('Access is denied.')), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes('ffu-lothdesktop-2 has no scheduled task')), lines.join('\n'));
  fail = true;
  state.now += TASK_EVERY_MS;
  await rp.tick();
  state.now += TASK_EVERY_MS;
  await rp.tick();
  assert.equal(lines.filter((l) => l.includes("could not read the runners' scheduled tasks")).length, 1);
  state.census = { ...state.census, listeners: [...state.census.listeners, { pid: 14, root: "V:/ffw/ffu-runners/ffu-it's", busy: false }] };
  await rp.tick();
  await rp.tick();
  assert.equal(lines.filter((l) => l.includes("ffu-it's is not a folder")).length, 1);
});

test('w6163: the task script matches the folder as runnerRestartScript does, sets 4 only with fix, and refuses a quote', () => {
  const read = runnerTaskScript([R1], false);
  assert.match(read, /\$fix = \$false/);
  assert.ok(read.includes("'V:\\ffw\\ffu-runners\\ffu-lothdesktop-1'"));
  assert.ok(read.includes("(?![\\w.-])"));
  assert.ok(read.includes('$before -gt 4') && read.includes('Settings.Priority = 4'));
  assert.match(runnerTaskScript([`${R2}/`], true), /\$fix = \$true[\s\S]*'V:\\ffw\\ffu-runners\\ffu-lothdesktop-2'/);
  assert.throws(() => runnerTaskScript(["V:\\it's"], true));
  assert.throws(() => runnerTaskScript(['relative\\path'], true));
  // a whitelist: PowerShell also ends a single-quoted string at U+2018..U+201B (review of #1398)
  for (const q of ['\u2018', '\u2019', '\u201A', '\u201B', '`', '$', ';', '(']) assert.throws(() => runnerTaskScript([`V:\\ffu-x${q}y`], false), q);
});

test('w6163: a listener the process script printed nothing (or half a row) for is a failure, never "Normal"', async () => {
  const { rp, lines } = rig('warn', { raise: (pids) => pids.slice(1).map((pid) => ({ pid, before: pid === 101 ? { cls: CLASS.NORMAL } : NORMAL, after: NORMAL })) });
  await rp.tick();
  assert.ok(lines.some((l) => l.includes("could not read ffu-lothdesktop-1's listener") && l.includes('pid 11: not read') && l.includes('pid 101: not read')), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes("could not read ffu-lothdesktop-2's listener (pid 12)")), lines.join('\n'));
  assert.ok(!lines.some((l) => l.includes('run at Normal')), lines.join('\n'));
});

test('w6163: a tick still running makes the next one a no-op, not a second PowerShell beside it', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let calls = 0;
  const { rp } = rig('warn', {
    tasks: (roots) => roots.map((root) => ({ root })),
    raise: (pids) => pids.map((pid) => ({ pid, before: NORMAL, after: NORMAL })),
  });
  const inner = (rp as unknown as { d: { raise: (p: number[], f: boolean) => Promise<ProcRow[]> } }).d;
  const orig = inner.raise;
  inner.raise = async (p, f) => {
    calls++;
    await gate;
    return orig(p, f);
  };
  const first = rp.tick();
  await new Promise((r) => setImmediate(r));
  await rp.tick();
  assert.equal(calls, 1);
  release();
  await first;
});

test('w6163: the process script refuses a system pid, and its lines parse', () => {
  assert.throws(() => processPriorityScript([4], true));
  assert.match(processPriorityScript([11, 103], false), /@\(11, 103\)[\s\S]*\$false/);
  assert.deepEqual(parseProcRows('11;16384;1;2;32;2;5;\r\n103;;;;;;;OpenProcess failed: error 5\nnoise'), [
    { pid: 11, before: { cls: 16384, io: 1, mem: 2 }, after: { cls: 32, io: 2, mem: 5 } },
    { pid: 103, before: {}, after: {}, error: 'OpenProcess failed: error 5' },
  ]);
  assert.ok(prioLow(LOW) && !prioLow(NORMAL) && prioLow({ ...NORMAL, mem: 4 }) && !prioLow({ cls: CLASS.HIGH, io: 2, mem: 5 }));
});

test('w6163: parseTaskRows reads one row or many', () => {
  assert.deepEqual(parseTaskRows('{"root":"V:\\\\a","task":"\\\\a","before":7,"after":4,"error":null}'), [{ root: 'V:\\a', task: '\\a', before: 7, after: 4 }]);
  assert.deepEqual(parseTaskRows('[{"root":"V:\\\\a"},{"root":"V:\\\\b","task":"\\\\b","before":4,"after":4}]'), [{ root: 'V:\\a' }, { root: 'V:\\b', task: '\\b', before: 4, after: 4 }]);
  assert.deepEqual(parseTaskRows(''), []);
});
