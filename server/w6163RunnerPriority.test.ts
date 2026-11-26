import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import type { RunnerCensus } from '../machine/benchRunners.ts';
import { RUNNER_PRIORITY_ENFORCE, RunnerPriority, TASK_EVERY_MS, parseTaskRows, runnerTaskScript, taskNormal, type RunnerPriorityMode, type TaskRow } from '../machine/runnerPriority.ts';

/**
 * w6163: LothDesktop's ffu runners ran their jobs at BelowNormal after the daemon started them with Start-ScheduledTask (task
 * priority 7; logged 2026-11-26 17:46Z), and at Normal after a logon start. The daemon sets the tasks to 5 and raises a
 * listener below Normal to Normal on lothdesktop only; elsewhere (BEAST) it only logs.
 */
const P = os.constants.priority;
const R1 = 'V:\\ffw\\ffu-runners\\ffu-lothdesktop-1';
const R2 = 'V:\\ffw\\ffu-runners\\ffu-lothdesktop-2';

function rig(mode: RunnerPriorityMode, o: { prio?: Record<number, number>; tasks?: (roots: string[], fix: boolean) => TaskRow[]; failSet?: boolean } = {}) {
  const prio: Record<number, number> = { ...(o.prio ?? { 11: P.PRIORITY_BELOW_NORMAL, 12: P.PRIORITY_NORMAL }) };
  const census: RunnerCensus = { listeners: [{ pid: 11, root: R1, busy: false }, { pid: 12, root: R2, busy: true }], workers: [{ pid: 21, root: R2 }], leftovers: [] };
  const lines: string[] = [];
  const set: [number, number][] = [];
  const taskCalls: { roots: string[]; fix: boolean }[] = [];
  const state = { now: 1_000_000, census };
  const rp = new RunnerPriority({
    mode,
    census: async () => state.census,
    priorityOf: (pid) => prio[pid],
    setPriority: (pid, p) => {
      if (o.failSet) return false;
      set.push([pid, p]);
      prio[pid] = p;
      return true;
    },
    tasks: async (roots, fix) => {
      taskCalls.push({ roots, fix });
      return o.tasks ? o.tasks(roots, fix) : roots.map((root) => ({ root, task: `\\${root.split('\\').pop()}`, before: 7, after: fix ? 5 : 7 }));
    },
    now: () => state.now,
    log: (l) => lines.push(l),
  });
  return { rp, lines, set, taskCalls, state, prio };
}

test('w6163: only lothdesktop enforces; BEAST is not in the list', () => {
  assert.deepEqual([...RUNNER_PRIORITY_ENFORCE], ['lothdesktop']);
  assert.ok(!RUNNER_PRIORITY_ENFORCE.has('beast'));
});

test('w6163: enforce sets the tasks to 5 and raises a BelowNormal listener to Normal, once', async () => {
  const { rp, lines, set, taskCalls } = rig('enforce');
  await rp.tick();
  assert.deepEqual(taskCalls, [{ roots: [R1, R2], fix: true }]);
  assert.deepEqual(set, [[11, P.PRIORITY_NORMAL]], 'only the BelowNormal listener, never one at Normal');
  assert.ok(lines.some((l) => l.includes('set ffu-lothdesktop-1\'s scheduled task \\ffu-lothdesktop-1 from priority 7 (BelowNormal) to 5 (Normal)')), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes('raised ffu-lothdesktop-1\'s listener (pid 11) from BelowNormal to Normal')), lines.join('\n'));
  const n = lines.length;
  await rp.tick();
  assert.equal(taskCalls.length, 1, 'the tasks are read again only after TASK_EVERY_MS');
  assert.equal(lines.length, n, 'nothing new is said');
});

test('w6163: warn (BEAST) sets nothing and says what it read', async () => {
  const { rp, lines, set, taskCalls } = rig('warn');
  await rp.tick();
  assert.deepEqual(set, []);
  assert.deepEqual(taskCalls, [{ roots: [R1, R2], fix: false }]);
  assert.ok(lines.some((l) => l.includes('runs at priority 7 (BelowNormal)') && l.includes('only reports it')), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes('listener (pid 11) runs at BelowNormal') && l.includes('only reports it')), lines.join('\n'));
});

test('w6163: off does nothing at all', async () => {
  const { rp, lines, set, taskCalls } = rig('off');
  await rp.tick();
  assert.deepEqual([lines, set, taskCalls], [[], [], []]);
});

test('w6163: a listener above Normal is left alone, and a failed raise is said once', async () => {
  const a = rig('enforce', { prio: { 11: P.PRIORITY_ABOVE_NORMAL, 12: P.PRIORITY_NORMAL } });
  await a.rp.tick();
  assert.deepEqual(a.set, []);
  const b = rig('enforce', { failSet: true });
  await b.rp.tick();
  await b.rp.tick();
  assert.equal(b.lines.filter((l) => l.includes('could not raise ffu-lothdesktop-1')).length, 1);
});

test('w6163: the tasks are read again after an hour and for a runner folder not seen before', async () => {
  const { rp, taskCalls, state } = rig('enforce');
  await rp.tick();
  state.now += TASK_EVERY_MS;
  await rp.tick();
  assert.equal(taskCalls.length, 2);
  state.census = { ...state.census, listeners: [...state.census.listeners, { pid: 13, root: 'V:\\ffw\\ffu-runners\\ffu-lothdesktop-3', busy: false }] };
  await rp.tick();
  assert.equal(taskCalls.length, 3);
});

test('w6163: a task that could not be set, no task, and a read that fails are each said once', async () => {
  let fail = false;
  const { rp, lines, state } = rig('enforce', {
    tasks: (roots) => {
      if (fail) throw new Error('Access is denied.');
      return [{ root: roots[0]!, task: '\\ffu-lothdesktop-1', before: 7, after: 7, error: 'Access is denied.' }, { root: roots[1]! }];
    },
  });
  await rp.tick();
  assert.ok(lines.some((l) => l.includes('could not set ffu-lothdesktop-1\'s scheduled task') && l.includes('Access is denied.')), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes('ffu-lothdesktop-2 has no scheduled task')), lines.join('\n'));
  fail = true;
  state.now += TASK_EVERY_MS;
  await rp.tick();
  state.now += TASK_EVERY_MS;
  await rp.tick();
  assert.equal(lines.filter((l) => l.includes('could not read the runners\' scheduled tasks')).length, 1);
});

test('w6163: the task script matches the folder as runnerRestartScript does, sets only with fix, and refuses a quote', () => {
  const read = runnerTaskScript([R1], false);
  assert.match(read, /\$fix = \$false/);
  assert.ok(read.includes(`'${R1}'`));
  assert.ok(read.includes("(?![\\w.-])"));
  assert.match(runnerTaskScript(['V:/ffw/ffu-runners/ffu-lothdesktop-2/'], true), /\$fix = \$true[\s\S]*'V:\\ffw\\ffu-runners\\ffu-lothdesktop-2'/);
  assert.throws(() => runnerTaskScript(["V:\\it's"], true));
  assert.throws(() => runnerTaskScript(['relative\\path'], true));
});

test('w6163: parseTaskRows reads one row or many, and the Normal range is 0 to 6', () => {
  assert.deepEqual(parseTaskRows('{"root":"V:\\\\a","task":"\\\\a","before":7,"after":5,"error":null}'), [{ root: 'V:\\a', task: '\\a', before: 7, after: 5 }]);
  assert.deepEqual(parseTaskRows('[{"root":"V:\\\\a"},{"root":"V:\\\\b","task":"\\\\b","before":5,"after":5}]'), [{ root: 'V:\\a' }, { root: 'V:\\b', task: '\\b', before: 5, after: 5 }]);
  assert.deepEqual(parseTaskRows(''), []);
  assert.deepEqual([4, 5, 6, 7, 10].map(taskNormal), [true, true, true, false, false]);
});
