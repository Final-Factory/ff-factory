import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INSTALL_LEFTOVER_DEFAULTS, installLeftoverSettings, planInstallLeftovers, type InstallLeftoverSettings, type ProcLite } from './installLeftovers.ts';

/**
 * w6524: on LothDesktop (2026-11-27) an hourly pass ran 45+ min while V: fell to 6 GB, and the low and asked steps that run alone
 * during it (the ffu slots' first step, w6044) planned 0 items four times: runner 2's 13.8 GB job folder waited for the next
 * full low pass. The first step of a low pass now plans the idle runners' job folders too (rule ffu-runner-work), warn-only
 * first (runnerFirstMode, lothsahn's lockout rule).
 */

const HOUR = 3_600_000;
const NOW = Date.now();

function install(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w6524-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  return root;
}

const listener = (root: string, name: string, pid: number): ProcLite => ({ pid, ppid: 1, cmd: `"${path.join(root, 'ffu-runners', name, 'bin', 'Runner.Listener.exe')}" run` });
const worker = (root: string, name: string, pid: number, ppid: number): ProcLite => ({ pid, ppid, cmd: `"${path.join(root, 'ffu-runners', name, 'bin', 'Runner.Worker.exe')}" spawnclient 1 2` });
const idleLog = (at: number) => `[${new Date(at).toISOString().slice(0, 19).replace('T', ' ')}Z INFO JobDispatcher] WRITE LINE: x: Listening for Jobs\n`;
const rel = (root: string, p: string) => path.relative(root, p).split(path.sep).join('/');

function ageAll(dir: string, ageH: number) {
  const at = (NOW - ageH * HOUR) / 1000;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) ageAll(path.join(dir, e.name), ageH);
    else fs.utimesSync(path.join(dir, e.name), at, at);
  }
  fs.utimesSync(dir, at, at);
}

/** Runner r1 with a job folder `_work/ffu` written `ageH` hours ago, and its own `_work/_temp`. */
function world(root: string, ageH: number) {
  const job = path.join(root, 'ffu-runners', 'r1', '_work', 'ffu', 'ffu', 'target', 'debug');
  fs.mkdirSync(job, { recursive: true });
  fs.writeFileSync(path.join(job, 'big.rlib'), 'x'.repeat(4096));
  fs.mkdirSync(path.join(root, 'ffu-runners', 'r1', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ffu-runners', 'r1', '_work', '_temp'), { recursive: true });
  ageAll(path.join(root, 'ffu-runners', 'r1', '_work', 'ffu'), ageH);
}

async function first(root: string, o: { low?: boolean; settings?: Partial<InstallLeftoverSettings>; procs?: readonly ProcLite[] } = {}) {
  return planInstallLeftovers({
    root,
    sandboxes: [],
    tempRoots: [],
    guard: { keep: [path.join(root, 'sandboxes'), path.join(root, 'repo')], inUse: [], home: path.join(root, 'home') },
    procs: o.procs ? [...o.procs] : [listener(root, 'r1', 100)],
    settings: { ...installLeftoverSettings({}), ...o.settings },
    now: NOW,
    localWork: async () => false,
    low: o.low ?? true,
    heldMinBytes: 0,
    alive: () => true,
    runnerLog: () => idleLog(NOW - HOUR),
    scope: 'ffu-slots',
  });
}

const runnerItems = (root: string, p: { items: { rule: string; path: string }[] }) => p.items.filter((i) => i.rule === 'ffu-runner-work').map((i) => rel(root, i.path));
const warned = (root: string, p: { listed: { path: string; why: string }[] }) => p.listed.filter((l) => l.why.startsWith('warn-only (runnerFirstMode warn, w6524): the low first step would take ')).map((l) => rel(root, l.path));

test('w6524: the default is warn: the low first step lists an idle runner\'s settled job folder and plans nothing', async (t) => {
  const root = install(t);
  world(root, 2);
  assert.equal(INSTALL_LEFTOVER_DEFAULTS.runnerFirstMode, 'warn');
  const p = await first(root);
  assert.deepEqual(runnerItems(root, p), []);
  assert.deepEqual(warned(root, p), ['ffu-runners/r1/_work/ffu']);
  assert.match(p.listed.find((l) => l.why.includes('w6524'))!.why, /no job running, untouched for 15 min \(the disk is low\)/);
});

test('w6524: on, the low first step plans the job folder under rule ffu-runner-work, with its runner for the re-check', async (t) => {
  const root = install(t);
  world(root, 2);
  const p = await first(root, { settings: { runnerFirstMode: 'on' } });
  assert.deepEqual(runnerItems(root, p), ['ffu-runners/r1/_work/ffu']);
  assert.equal(p.items.find((i) => i.rule === 'ffu-runner-work')!.runner, path.join(root, 'ffu-runners', 'r1'));
  assert.deepEqual(warned(root, p), []);
});

test('w6524: a first step that is not low, mode off, a runner running a job, or a folder written within the settle time: nothing', async (t) => {
  const root = install(t);
  world(root, 2);
  for (const [why, o] of [
    ['not low', { low: false, settings: { runnerFirstMode: 'on' as const } }],
    ['off', { settings: { runnerFirstMode: 'off' as const } }],
    ['a job runs', { settings: { runnerFirstMode: 'on' as const }, procs: [listener(root, 'r1', 100), worker(root, 'r1', 101, 100)] }],
  ] as const) {
    const p = await first(root, o);
    assert.deepEqual(runnerItems(root, p), [], why);
    assert.deepEqual(warned(root, p), [], why);
  }
  const fresh = install(t);
  world(fresh, 0);
  for (const mode of ['warn', 'on'] as const) {
    const p = await first(fresh, { settings: { runnerFirstMode: mode } });
    assert.deepEqual(runnerItems(fresh, p), [], mode);
    assert.deepEqual(warned(fresh, p), [], mode);
  }
});

test('w6524: a value that is not off, warn or on falls back to warn', () => {
  assert.equal(installLeftoverSettings({ runnerFirstMode: 'yes' }).runnerFirstMode, 'warn');
  assert.equal(installLeftoverSettings({ runnerFirstMode: 'on' }).runnerFirstMode, 'on');
});
