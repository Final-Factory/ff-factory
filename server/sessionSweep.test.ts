import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionSweeper, planSessionSweep, sweepSettings, SWEEP_DEFAULTS } from './sessionSweep.ts';
import { sessionTempDir, type CleanupGuard } from './cleanup.ts';

/**
 * w913: a worker's temp folder (TMPDIR, `<install>/tmp/ffa-<session>`) is swept by the daemon after its process is gone: all
 * but the clones after a short grace, the clones too (unless they hold work nowhere else) after six hours.
 */
const MIN = 60_000;
const OLD = Date.now() - 24 * 60 * MIN; // everything in the fixtures is a day old unless a test touches it

function world(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffw-sweep-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const temp = path.join(root, 'tmp');
  fs.mkdirSync(temp);
  const guard: CleanupGuard = { keep: [path.join(root, 'sandboxes'), path.join(root, 'repo')], inUse: [], home: path.join(root, 'home') };
  const aged = (p: string) => {
    for (const e of fs.existsSync(p) && fs.statSync(p).isDirectory() ? fs.readdirSync(p) : []) aged(path.join(p, e));
    fs.utimesSync(p, OLD / 1000, OLD / 1000);
  };
  /** A session's folder as the w901/w907/w883 workers left theirs. */
  const session = (id: string) => {
    const dir = sessionTempDir(temp, id);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ['ffb.log', 'body.md', 'out.txt']) fs.writeFileSync(path.join(dir, f), 'x'.repeat(1000));
    fs.mkdirSync(path.join(dir, 'tour', 'shots'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tour', 'shots', 'a.png'), 'x'.repeat(5000));
    fs.mkdirSync(path.join(dir, 'build-abc', 'Data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'build-abc', 'Data', 'big.bin'), 'x'.repeat(20_000));
    fs.mkdirSync(path.join(dir, 'claude', 'proj', 'sess', 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'claude', 'proj', 'sess', 'tasks', 't.output'), 'x'.repeat(2000));
    fs.mkdirSync(path.join(dir, 'ff-factory', '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ff-factory', 'package.json'), '{}');
    aged(dir);
    return dir;
  };
  return { root, temp, guard, session };
}
const names = (d: string) => fs.readdirSync(d).sort();

test('w913: step 1 takes everything but the clones; a process that names the folder holds the whole sweep', async (t) => {
  const { root, guard, session } = world(t);
  const dir = session('aaaa1111');
  const plan = await planSessionSweep({ dir, step: 1, root, guard });
  assert.deepEqual(plan.items.map((i) => path.basename(i.path)).sort(), ['body.md', 'build-abc', 'claude', 'ffb.log', 'out.txt', 'tour']);
  assert.deepEqual(plan.kept.map((k) => path.basename(k.path)), ['ff-factory'], 'the clone stays for the worker\'s return');
  const busy = await planSessionSweep({ dir, step: 1, root, guard, procs: [{ pid: 4242, ppid: 1, cmd: `node ${dir.replace(/\\/g, '/')}/build-abc/run.js` }] });
  assert.equal(busy.items.length, 0);
  assert.match(busy.kept[0].why, /a process still names it \(pid 4242\)/);
  // the daemon's own process never counts
  const self = await planSessionSweep({ dir, step: 1, root, guard, procs: [{ pid: 7, ppid: 1, cmd: `daemon ${dir}` }], self: [7] });
  assert.equal(self.items.length, 6);
});

test('w913: step 2 takes the clones, except one with work that exists nowhere else, which is listed', async (t) => {
  const { root, guard, session } = world(t);
  const dir = session('bbbb2222');
  const clean = await planSessionSweep({ dir, step: 2, root, guard, localWork: async () => false });
  assert.ok(clean.items.some((i) => path.basename(i.path) === 'ff-factory'));
  assert.deepEqual(clean.listed, []);
  const dirty = await planSessionSweep({ dir, step: 2, root, guard, localWork: async () => true });
  assert.ok(!dirty.items.some((i) => path.basename(i.path) === 'ff-factory'));
  assert.match(dirty.listed[0].why, /uncommitted or unpushed work/);
});

test('w913: nothing outside <install>/tmp/ffa-*, nothing recent, nothing a guard keeps', async (t) => {
  const { root, temp, guard, session } = world(t);
  const dir = session('cccc3333');
  // not an ffa- folder, or outside the install folder
  fs.mkdirSync(path.join(temp, 'w605-e2e'));
  assert.equal((await planSessionSweep({ dir: path.join(temp, 'w605-e2e'), step: 1, root, guard })).items.length, 0);
  assert.equal((await planSessionSweep({ dir, step: 1, root: path.join(root, 'elsewhere'), guard })).items.length, 0);
  // a write a minute ago: the entry stays
  fs.writeFileSync(path.join(dir, 'build-abc', 'Data', 'big.bin'), 'y');
  const recent = await planSessionSweep({ dir, step: 1, root, guard });
  assert.ok(!recent.items.some((i) => path.basename(i.path) === 'build-abc'));
  assert.match(recent.kept.find((k) => path.basename(k.path) === 'build-abc')!.why, /changed in the last 2 min/);
  // a live session's folder is the guard's inUse
  const live = await planSessionSweep({ dir, step: 1, root, guard: { ...guard, inUse: [dir] } });
  assert.equal(live.items.length, 0);
});

test('w913: the sweeper waits out the grace, resets when the session returns, and removes the clones at six hours', async (t) => {
  const { root, temp, guard, session } = world(t);
  const dir = session('dddd4444');
  const other = session('eeee5555'); // a live one
  let now = Date.now() + 1000 * MIN; // after the fixtures' mtimes and the quiet window
  let live = true;
  const logs: string[] = [];
  const sw = new SessionSweeper({
    root,
    tempRoot: () => temp,
    sessions: () => [
      { id: 'dddd4444', live },
      { id: 'eeee5555', live: true },
    ],
    dirOf: (id) => sessionTempDir(temp, id),
    guard: () => ({ ...guard, inUse: [other] }),
    localWork: async () => false,
    now: () => now,
    log: (l) => logs.push(l),
  });
  await sw.tick();
  assert.equal(names(dir).length, 7, 'live: untouched');
  live = false;
  await sw.tick(); // first seen gone
  now += 9 * MIN;
  await sw.tick();
  assert.equal(names(dir).length, 7, 'inside the grace: untouched');
  now += 2 * MIN;
  await sw.tick();
  assert.deepEqual(names(dir), ['ff-factory'], 'step 1: only the clone is left');
  assert.match(logs.at(-1)!, /session sweep ffa-dddd4444 \(step 1, process gone 11 min\): removed 6 entries/);
  // it returns, works, ends again: the clock starts over
  live = true;
  await sw.tick();
  live = false;
  now += 5 * 60 * MIN;
  await sw.tick();
  now += 3 * 60 * MIN; // 3 h after the second end (8 h after the first)
  await sw.tick();
  assert.deepEqual(names(dir), ['ff-factory'], 'the clone waits for six hours after the LAST end');
  now += 4 * 60 * MIN;
  await sw.tick();
  assert.ok(!fs.existsSync(dir), 'step 2: the clone and the emptied folder are gone');
  assert.equal(names(other).length, 7, 'a live session\'s folder is never touched');
  assert.equal(sw.pending().find((p) => p.id === 'eeee5555'), undefined);
});

test('w913: without a worker root nothing is swept, and the settings are clamped', async (t) => {
  const { temp, guard, session } = world(t);
  const dir = session('ffff6666');
  const sw = new SessionSweeper({ root: undefined, tempRoot: () => temp, sessions: () => [{ id: 'ffff6666', live: false }], dirOf: (id) => sessionTempDir(temp, id), guard: () => guard, now: () => Date.now() + 10_000 * MIN });
  await sw.tick();
  await sw.tick();
  assert.equal(names(dir).length, 7);
  assert.deepEqual(sweepSettings({ graceMin: 0, cloneKeepHours: 'x', quietMin: 5 }), { ...SWEEP_DEFAULTS, quietMin: 5 });
});
