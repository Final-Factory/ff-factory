// w1861: a machine that takes no timed runs. lothsahn, 2026-10-23, after Ben's speech-to-text ran on m5 inside w1780's
// timed A/B: "The m5 should not be used for timing runs because Ben runs stuff on it personally", and later "I thought we
// said we weren't doing timing runs on M5 because it is blocked. That needs to go to a different machine." Placement never
// sends timed work there (the capacity line's "Next timed work" included), and its daemon writes the refusal where the
// game repo's bench_queue.py reads it, which then refuses every exclusive ticket there (scripts/tests/test_bench_queue.py).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capacityLines, pickComputer, pickTimed, timedLine, type Computer } from './placement.ts';
import { writeBenchPriorities } from '../machine/benchLock.ts';
import { MachineManager, NO_TIMED_RUNS, noTimedRunsOf } from './machines.ts';
import { Store } from './store.ts';
import { SessionManager } from './sessions.ts';
import type { Config } from './config.ts';
import type { Machine } from '../shared/types.ts';

const GB = 1024 ** 3;
const box = (id: string, maxSandboxes: number, platform: string, o: Partial<Computer> = {}): Computer => ({ id, online: true, live: 1, midTurn: 0, maxAgents: 2 * maxSandboxes, sandboxes: 1, maxSandboxes, freeSandboxes: 1, memUsedBytes: 16 * GB, memTotalBytes: 64 * GB, editors: 1, maxEditors: 2, platform, ...o });
const NO = 'lothsahn: "The m5 should not be used for timing runs"';

test('w1861: m5 takes no timed runs by default; its record can give another reason or clear it, and no other machine has one', () => {
  assert.match(noTimedRunsOf({ id: 'm5' })!, /^lothsahn, 2026-10-23: "The m5 should not be used for timing runs because Ben runs stuff on it personally"$/);
  assert.equal(noTimedRunsOf({ id: 'm5', noTimedRuns: '' }), undefined, 'add_machine no_timed_runs "" clears it');
  assert.equal(noTimedRunsOf({ id: 'm5', noTimedRuns: '  ' }), undefined);
  assert.equal(noTimedRunsOf({ id: 'm3', noTimedRuns: 'Ben games here' }), 'Ben games here');
  for (const id of ['beast', 'lothdesktop', 'm3', 'biscuit']) assert.equal(noTimedRunsOf({ id }), undefined, id);
  assert.deepEqual(Object.keys(NO_TIMED_RUNS), ['m5']);
});

test('w1861: timed work never goes to a computer that takes none, even the smallest or the only one with room; other work still does', () => {
  const m5 = box('m5', 2, 'darwin', { live: 0, editors: 0, noTimedRuns: NO });
  const m3 = box('m3', 2, 'darwin', { live: 2 });
  const loth = box('lothdesktop', 4, 'win32');
  const beast = box('beast', 8, 'win32');
  // Before w1861 m5 won: smallest and idlest.
  assert.equal(pickTimed([beast, loth, m5, m3], {}, 'timed')!.pick.id, 'm3');
  assert.equal(pickTimed([beast, loth, m5, m3], {}, 'timed:darwin')!.pick.id, 'm3');
  assert.equal(pickTimed([beast, loth, m5], {}, 'timed:darwin'), undefined, 'no Mac takes timed runs');
  const p = pickTimed([beast, loth, m5], {}, 'timed')!;
  assert.equal(p.pick.id, 'lothdesktop');
  assert.match(p.why, /; never m5 \(it takes no timed runs: lothsahn: "The m5 should not be used for timing runs"\)$/);
  // Every other computer full: the general placement answers, and it never names m5 either; with only m5 open, none.
  const full = (c: Computer) => ({ ...c, freeSandboxes: 0, sandboxes: c.maxSandboxes, agentSeats: 0 });
  const rest = pickComputer([full(beast), loth, m5], undefined, {}, 'game', false, 'timed')!;
  assert.equal(rest.pick.id, 'lothdesktop');
  assert.equal(pickComputer([full(beast), full(loth), m5], undefined, {}, 'game', false, 'timed'), undefined);
  // Builds, editors, coding and tests still go there: lothsahn, "m5 stays open for all other work".
  assert.equal(pickComputer([full(beast), full(loth), m5], undefined, {}, 'game')!.pick.id, 'm5');
  assert.equal(pickComputer([full(beast), full(loth), m5], undefined, {}, 'agent')!.pick.id, 'm5');
});

test('w1861: the capacity lines\' "Next timed work" names another computer and says m5 takes none', () => {
  const m5 = box('m5', 2, 'darwin', { live: 0, editors: 0, noTimedRuns: NO });
  const places = [box('beast', 8, 'win32'), box('lothdesktop', 4, 'win32'), m5];
  const line = timedLine(places)!;
  assert.match(line, /^Next timed work \(benchmarks, perf A\/Bs and probes; on the platform it names, w1628\): lothdesktop \(/);
  assert.match(line, /never m5 \(it takes no timed runs/);
  const lines = capacityLines(places, undefined, {});
  assert.ok(lines.some((l) => l.startsWith('Next timed work') && !/\): m5 /.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /^- m5\b.*no timed runs \(w1861\)/.test(l)), lines.join('\n'));
  assert.equal(timedLine([box('beast', 8, 'win32', { freeSandboxes: 0, sandboxes: 8 }), m5]), 'No computer has room for timed work now.');
});

test('w1861: the daemon writes the refusal into priorities.json beside the sessions; none when the machine takes timed runs', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w1861-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const no = { why: NO, elsewhere: ['lothdesktop', 'm3'] };
  const file = writeBenchPriorities(root, { s1: { priority: 'normal', requests: ['w1861'] } }, new Date('2026-10-23T16:00:00Z'), false, no)!;
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { at: '2026-10-23T16:00:00.000Z', v: 2, single_worker: false, no_timed_runs: no, sessions: { s1: { priority: 'normal', requests: ['w1861'] } } });
  writeBenchPriorities(root, {}, new Date('2026-10-23T16:01:00Z'), false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).no_timed_runs, undefined, 'a cleared setting is gone at the next push');
});

test('w1861: the portal sends m5 its refusal with the machines that take timed runs, online first, and sends the others none', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w1861-mm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = { dataDir: dir, port: 0, limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 }, orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: false }, worker: { permissionMode: 'bypassPermissions', effort: 'low' }, unity: {} } as unknown as Config;
  const store = new Store(dir);
  const rec = (id: string, o: Partial<Machine> = {}) => ({ id, host: id, purpose: 'unused', status: 'deployed', online: false, repoPath: '/r', home: '/h', portalUrl: 'http://p', sessionIds: [], createdAt: '2026-10-01T00:00:00Z', sandboxRoot: '/s', ...o }) as unknown as Machine;
  for (const m of [rec('m5'), rec('beast'), rec('lothdesktop'), rec('m3'), rec('ffbox', { sandboxRoot: undefined })]) store.putMachine(m);
  const machines = new MachineManager(cfg, store, new SessionManager(cfg, store));
  const msg = machines.benchPrioritiesMsg('m5', {});
  assert.deepEqual(msg.noTimedRuns, { why: NO_TIMED_RUNS.m5, elsewhere: ['beast', 'lothdesktop', 'm3'] }, 'machines with sandboxes only');
  assert.equal(machines.benchPrioritiesMsg('beast', {}).noTimedRuns, undefined);
  assert.equal('noTimedRuns' in machines.benchPrioritiesMsg('beast', {}), false, 'an older daemon sees the message it knew');
  store.putMachine(rec('m3', { noTimedRuns: 'Ben games here' }));
  assert.deepEqual(machines.noTimedRuns('m5')!.elsewhere, ['beast', 'lothdesktop']);
  store.putMachine(rec('m5', { noTimedRuns: '' }));
  assert.equal(machines.noTimedRuns('m5'), undefined);
});
