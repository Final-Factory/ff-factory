import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCleanup, type CleanupGuard, type CleanupItem } from './cleanup.ts';
import { INSTALL_LEFTOVER_DEFAULTS, anyBusyNow, installLeftoverSettings, linkOnPath, planInstallLeftovers, runnerBusyNow, runnerTargetLinksNow, type InstallLeftoverSettings, type ProcLite } from './installLeftovers.ts';
import { writeCargoUnit, type FakeUnit } from './cargoGraphFixture.ts';
import { sweptUnits, unitKeyOf } from './cargoGraphSweep.ts';

/**
 * w6291: an idle FFU runner's cargo target (`ffu-runners/<runner>/_work/<entry>/<child>/target`) gets the ffu slots' cap: its stale
 * units, then the whole target over the cap. An active runner is never runnerWorkDays untouched, so ffu-lothdesktop-1's target
 * (19.8 GB, measured 2026-11-27) had no bound until a low pass took the whole job folder. The rule starts in warn mode (lothsahn's
 * lockout rule, docs/worker-fence.md): it lists what it would take, plans nothing, and counts the units a later pass found live
 * again.
 */

const HOUR = 3_600_000;
const NOW = Date.now();
const GB = 1024 ** 3;

function install(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w6291-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  return root;
}

const listener = (root: string, name: string, pid: number): ProcLite => ({ pid, ppid: 1, cmd: `"${path.join(root, 'ffu-runners', name, 'bin', 'Runner.Listener.exe')}" run` });
const worker = (root: string, name: string, pid: number, ppid: number): ProcLite => ({ pid, ppid, cmd: `"${path.join(root, 'ffu-runners', name, 'bin', 'Runner.Worker.exe')}" spawnclient 1 2` });
const idleLog = (at: number) => `[${new Date(at).toISOString().slice(0, 19).replace('T', ' ')}Z INFO JobDispatcher] WRITE LINE: x: Listening for Jobs\n`;
const jobLog = (at: number) => `[${new Date(at).toISOString().slice(0, 19).replace('T', ' ')}Z INFO JobDispatcher] Acknowledging runner request 'bd216421'\n`;

const rel = (root: string, p: string) => path.relative(root, p).split(path.sep).join('/');
const TARGET = 'ffu-runners/r1/_work/ffu/ffu/target';
const targetOf = (root: string) => path.join(root, ...TARGET.split('/'));
const runnerOf = (root: string) => path.join(root, 'ffu-runners', 'r1');

const unit = (name: string, n: number, ageH: number, o: Partial<FakeUnit> = {}): FakeUnit => ({ name, hash: n.toString(16).padStart(16, '0'), fp: 0x1234567890abcdefn + BigInt(n), ageH, ...o });

/**
 * A runner r1 with a cargo target in its job folder: the live units (the workspace's ffu_sim built an hour ago and the serde it uses),
 * and stale ones (an old workspace build of ffu_sim, the glam only it used) that no build of the last two days uses.
 */
function world(root: string, o: { serdeBytes?: number } = {}) {
  const target = targetOf(root);
  const serde = unit('serde', 1, 24 * 6, { bytes: o.serdeBytes ?? 2000 });
  const glam = unit('glam', 2, 24 * 4, { bytes: 3000 });
  const simNow = unit('ffu_sim', 3, 1, { deps: [serde], workspace: true, bytes: o.serdeBytes ?? 2000 });
  const simOld = unit('ffu_sim', 4, 24 * 4, { deps: [glam, serde], workspace: true, bytes: 4000 });
  for (const u of [serde, glam, simNow, simOld]) writeCargoUnit(target, u, NOW);
  // the runner itself: a listener's folder, the runner's own _work children
  fs.mkdirSync(path.join(runnerOf(root), 'bin'), { recursive: true });
  fs.mkdirSync(path.join(runnerOf(root), '_work', '_temp'), { recursive: true });
  fs.writeFileSync(path.join(runnerOf(root), '_work', '_temp', 'x.sh'), 'x');
  return { target, serde, glam, simNow, simOld };
}

/** Every file and folder under `dir` (and `dir`) last written `ageH` hours ago. */
function ageAll(dir: string, ageH: number) {
  const at = (NOW - ageH * HOUR) / 1000;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) ageAll(path.join(dir, e.name), ageH);
    else fs.utimesSync(path.join(dir, e.name), at, at);
  }
  fs.utimesSync(dir, at, at);
}

/** The target's top folders and CACHEDIR.TAG written `ageH` hours ago: no build wrote into it lately (newestTopWrite). */
function quiet(target: string, ageH: number) {
  const at = (NOW - ageH * HOUR) / 1000;
  for (const d of [target, path.join(target, 'debug'), path.join(target, 'debug', 'deps'), path.join(target, 'debug', '.fingerprint'), path.join(target, 'CACHEDIR.TAG')]) fs.utimesSync(d, at, at);
}

interface Opts {
  low?: boolean;
  procs?: ProcLite[];
  settings?: Partial<InstallLeftoverSettings>;
  warnFile?: string;
  runnerLog?: (r: string) => string | undefined;
}

async function plan(root: string, o: Opts = {}) {
  const guard: CleanupGuard = { keep: [path.join(root, 'sandboxes'), path.join(root, 'repo')], inUse: [], home: path.join(root, 'home') };
  return planInstallLeftovers({
    root,
    sandboxes: [],
    tempRoots: [path.join(root, 'tmp')],
    guard,
    procs: o.procs ?? [listener(root, 'r1', 100)],
    settings: { ...installLeftoverSettings({}), ...o.settings },
    now: NOW,
    localWork: async () => false,
    low: o.low,
    heldMinBytes: 0,
    alive: () => true,
    runnerLog: o.runnerLog ?? (() => idleLog(NOW - HOUR)),
    ...(o.warnFile ? { runnerWarnFile: o.warnFile } : {}),
  });
}

const targetItems = (p: { items: CleanupItem[] }) => p.items.filter((i) => i.rule === 'ffu-runner-target');
const warnLines = (root: string, p: { listed: { path: string; why: string }[] }) => p.listed.filter((l) => /^warn-only \(runnerTargetMode warn, w6291\): would take /.test(l.why)).map((l) => ({ path: rel(root, l.path), why: l.why }));
const hashesOf = (paths: string[]) => [...new Set(paths.map((p) => /-([0-9a-f]{16})/.exec(path.basename(p))![1]))].sort();
const H = { serde: '0000000000000001', glam: '0000000000000002', simNow: '0000000000000003', simOld: '0000000000000004' };

test('w6291: the default is warn: the stale units are listed with what would go, nothing is planned or removed', async (t) => {
  const root = install(t);
  const w = world(root);
  assert.equal(INSTALL_LEFTOVER_DEFAULTS.runnerTargetMode, 'warn');
  const p = await plan(root);
  assert.deepEqual(p.items.map((i) => i.rule), [], 'warn plans nothing');
  const lines = warnLines(root, p);
  assert.deepEqual(lines.map((l) => l.path), [TARGET]);
  assert.match(lines[0].why, /would take stale build output in FFU runner r1's cargo target \(.* GB of .* GB\): \d+ entries of units no workspace build of the last 48 h uses; 2 of 4 units stay; the next job rebuilds only those \(w6291\)/);
  assert.ok(fs.existsSync(path.join(w.target, 'debug', 'deps', `libglam-${H.glam}.rlib`)), 'nothing was removed');
  assert.ok(!p.listed.some((l) => /_temp|_work$/.test(rel(root, l.path))), 'the runner own folders are not looked into for targets');
});

test('w6291: mode on plans an item with members (the stale units) for the runner, and the removal takes only those', async (t) => {
  const root = install(t);
  const w = world(root);
  const p = await plan(root, { settings: { runnerTargetMode: 'on' } });
  const items = targetItems(p);
  assert.equal(items.length, 1);
  const it = items[0];
  assert.equal(it.path, w.target);
  assert.equal(it.runner, runnerOf(root), 'the runner rides the item for runnerBusyNow');
  assert.equal(it.base, runnerOf(root));
  assert.ok(it.members?.length, 'a sweep: members, not the whole target');
  assert.deepEqual(hashesOf(it.members!), [H.glam, H.simOld].sort(), 'the old sim build and the glam only it used');
  for (const m of it.members!) assert.ok(m.startsWith(w.target + path.sep), m);
  assert.match(it.why, /^stale build output in FFU runner r1's cargo target .*; 2 of 4 units stay; the next job rebuilds only those \(w6291\)$/);
  assert.ok(!p.listed.some((l) => /warn-only/.test(l.why)), 'nothing is listed as warn-only in mode on');

  // runCleanup removes each member of the item on its own (removeMembers) and the re-check passes while the runner is idle.
  const guard: CleanupGuard = { keep: [path.join(root, 'repo')], inUse: [], home: path.join(root, 'home') };
  const run = await runCleanup(items, guard, runnerBusyNow(async () => [listener(root, 'r1', 100)], () => NOW, () => idleLog(NOW - HOUR)));
  assert.equal(run.failed.length, 0, JSON.stringify(run.failed));
  assert.equal(run.removed.length, 1, 'one entry for the lot');
  const deps = path.join(w.target, 'debug', 'deps');
  assert.ok(fs.existsSync(path.join(deps, `libserde-${H.serde}.rlib`)) && fs.existsSync(path.join(deps, `libffu_sim-${H.simNow}.rlib`)), 'the live units stay');
  assert.ok(!fs.existsSync(path.join(deps, `libglam-${H.glam}.rlib`)) && !fs.existsSync(path.join(deps, `libffu_sim-${H.simOld}.rlib`)), 'the stale ones are gone');
  assert.ok(fs.existsSync(path.join(w.target, 'CACHEDIR.TAG')), 'the target itself stays');
});

test('w6291: a runner that runs a job, or was just handed one, gets nothing listed or planned (busy runners keep everything)', async (t) => {
  const root = install(t);
  world(root);
  quiet(targetOf(root), 2);
  for (const mode of ['warn', 'on'] as const) {
    const settings = { runnerTargetMode: mode, runnerTargetCapGB: 0.00001 };
    const worked = await plan(root, { settings, procs: [listener(root, 'r1', 100), worker(root, 'r1', 101, 100)] });
    assert.equal(targetItems(worked).length, 0, `${mode}: a Runner.Worker runs`);
    assert.equal(warnLines(root, worked).length, 0);
    const handed = await plan(root, { settings, procs: [listener(root, 'r1', 100)], runnerLog: () => jobLog(NOW - 60_000) });
    assert.equal(targetItems(handed).length, 0, `${mode}: a job was just handed over`);
    assert.equal(warnLines(root, handed).length, 0);
    const cargo: ProcLite = { pid: 300, ppid: 1, cmd: `cargo build --manifest-path ${path.join(runnerOf(root), '_work', 'ffu', 'ffu', 'Cargo.toml')}` };
    const building = await plan(root, { settings, procs: [cargo] });
    assert.equal(targetItems(building).length, 0, `${mode}: a build runs from its _work`);
    assert.equal(warnLines(root, building).length, 0);
  }
});

test('w6291: over the cap with nothing stale the whole target goes in mode on once settled, and is listed in warn', async (t) => {
  const root = install(t);
  const target = targetOf(root);
  // one live unit, 30 KB: nothing stale, over a 21 KB cap
  writeCargoUnit(target, unit('ffu_sim', 3, 1, { workspace: true, bytes: 30_000 }), NOW);
  const cap = { runnerTargetCapGB: 0.00002 };
  assert.ok(0.00002 * GB < 30_000);

  const recent = await plan(root, { settings: { ...cap, runnerTargetMode: 'on' } });
  assert.equal(targetItems(recent).length, 0, 'cargo wrote into it a moment ago (the fixture folders are new): not whole yet');

  quiet(target, 2);
  const on = await plan(root, { settings: { ...cap, runnerTargetMode: 'on' } });
  const whole = targetItems(on);
  assert.equal(whole.length, 1);
  assert.equal(whole[0].path, target);
  assert.equal(whole[0].members, undefined, 'the whole target, not a sweep');
  assert.equal(whole[0].runner, runnerOf(root));
  assert.match(whole[0].why, /FFU runner r1's cargo target \(.* GB\) is over the 0\.00002 GB runner cap, no job runs and nothing in it was written for 15 min; the next job rebuilds it cold \(w6291\)/);

  const warn = await plan(root, { settings: { ...cap, runnerTargetMode: 'warn' } });
  assert.equal(warn.items.length, 0);
  const lines = warnLines(root, warn);
  assert.equal(lines.length, 1);
  assert.match(lines[0].why, /^warn-only \(runnerTargetMode warn, w6291\): would take FFU runner r1's cargo target .* rebuilds it cold \(w6291\)$/);

  const noCap = await plan(root, { settings: { runnerTargetCapGB: 0, runnerTargetMode: 'on' } });
  assert.equal(targetItems(noCap).length, 0, 'cap 0: no cap');
});

test('w6291: over the cap the window narrows until the stale units bring it under, and the whole target goes only when they cannot', async (t) => {
  const root = install(t);
  const target = targetOf(root);
  // Two workspace builds 3 h apart: at 48 h and 24 h both are roots; the 1 h window drops the older one's own units.
  const serde = unit('serde', 1, 24 * 6, { bytes: 6000 });
  const older = unit('ffu_old', 2, 4, { deps: [serde], workspace: true, bytes: 20_000 });
  const newest = unit('ffu_sim', 3, 1, { deps: [serde], workspace: true, bytes: 10_000 });
  for (const u of [serde, older, newest]) writeCargoUnit(target, u, NOW);
  quiet(target, 2);
  const p = await plan(root, { settings: { runnerTargetMode: 'on', runnerTargetCapGB: 0.00003 } }); // ~32 KB: over it at 48/24/6 h, under at 1 h
  const it = targetItems(p)[0];
  assert.ok(it?.members, 'a sweep, not the whole target');
  assert.deepEqual(hashesOf(it.members!), ['0000000000000002'], 'the older workspace unit goes at the 1 h window');
  assert.match(it.why, /no workspace build of the last 1 h uses/);
  const wide = await plan(root, { settings: { runnerTargetMode: 'on', runnerTargetCapGB: 24 } });
  assert.equal(targetItems(wide).length, 0, 'under the cap the 48 h window keeps both');
  const noSweep = await plan(root, { settings: { runnerTargetMode: 'on', runnerTargetKeepHours: 0, runnerTargetCapGB: 0.00003 } });
  assert.equal(targetItems(noSweep)[0]?.members, undefined, 'keepHours 0: no sweep, over the cap the whole target');
});

test('w6291: mode off does nothing, and writes nothing', async (t) => {
  const root = install(t);
  world(root);
  quiet(targetOf(root), 2);
  const warnFile = path.join(root, 'daemon', 'ffu-runner-sweep-warn.json');
  const p = await plan(root, { settings: { runnerTargetMode: 'off', runnerTargetCapGB: 0.00001 }, warnFile });
  assert.equal(p.items.length, 0);
  assert.equal(p.listed.length, 0);
  assert.ok(!fs.existsSync(warnFile));
});

test('w6291: a low pass keeps today\'s rule: the whole job folder after the settle time, no ffu-runner-target item', async (t) => {
  const root = install(t);
  world(root);
  const warnFile = path.join(root, 'daemon', 'ffu-runner-sweep-warn.json');
  ageAll(path.join(runnerOf(root), '_work', 'ffu'), 2);
  for (const mode of ['warn', 'on'] as const) {
    const p = await plan(root, { low: true, settings: { runnerTargetMode: mode, runnerTargetCapGB: 0.00001 }, warnFile });
    assert.deepEqual(p.items.filter((i) => /^ffu-runner/.test(i.rule)).map((i) => `${i.rule} ${rel(root, i.path)}`), ['ffu-runner-work ffu-runners/r1/_work/ffu'], mode);
    assert.equal(targetItems(p).length, 0);
    assert.equal(warnLines(root, p).length, 0);
  }
  assert.ok(!fs.existsSync(warnFile), 'a low pass does not count');
});

test('w6291: an entry the old rule takes whole (untouched runnerWorkDays) is not also swept', async (t) => {
  const root = install(t);
  world(root);
  ageAll(path.join(runnerOf(root), '_work', 'ffu'), 20 * 24);
  for (const mode of ['warn', 'on'] as const) {
    const p = await plan(root, { settings: { runnerTargetMode: mode } });
    assert.ok(p.items.some((i) => i.rule === 'ffu-runner-work' && rel(root, i.path) === 'ffu-runners/r1/_work/ffu'), mode);
    assert.equal(targetItems(p).length, 0, mode);
    assert.equal(warnLines(root, p).length, 0, mode);
  }
});

test('w6291: runnerBusyNow keeps an ffu-runner-target item when a job started since the plan, and passes it while the runner is idle', async (t) => {
  const root = install(t);
  const w = world(root);
  const p = await plan(root, { settings: { runnerTargetMode: 'on' } });
  const it = targetItems(p)[0];
  assert.ok(it);
  const idle = runnerBusyNow(async () => [listener(root, 'r1', 100)], () => NOW, () => idleLog(NOW - HOUR));
  assert.equal(await idle(it), undefined);
  const started = runnerBusyNow(async () => [listener(root, 'r1', 100)], () => NOW, () => jobLog(NOW));
  assert.match((await started(it)) ?? '', /a job may have started on the FFU runner since the plan/);
  const worked = runnerBusyNow(async () => [listener(root, 'r1', 100), worker(root, 'r1', 101, 100)], () => NOW, () => idleLog(NOW - HOUR));
  assert.match((await worked(it)) ?? '', /Runner\.Worker \(pid 101\) runs a job/);
  assert.match((await runnerBusyNow(async () => undefined)(it)) ?? '', /could not be read/, 'an unreadable list keeps it');
  // and runCleanup honours it: the item is kept, nothing inside goes
  const guard: CleanupGuard = { keep: [path.join(root, 'repo')], inUse: [], home: path.join(root, 'home') };
  const run = await runCleanup([it], guard, started);
  assert.equal(run.removed.length, 0);
  assert.match(run.failed[0]?.why ?? '', /^kept: a job may have started/);
  assert.ok(fs.existsSync(path.join(w.target, 'debug', 'deps', `libglam-${H.glam}.rlib`)));
});

test('w6291 warn: a recorded stale unit a build used again is a miss, counted and said; the others are not', async (t) => {
  const root = install(t);
  const w = world(root);
  const warnFile = path.join(root, 'daemon', 'ffu-runner-sweep-warn.json');
  const key = (u: FakeUnit) => `${u.name}-${u.hash}`;

  const first = await plan(root, { warnFile });
  assert.match(warnLines(root, first)[0].why, /; misses so far: 0 in 0 checks$/);
  const rec1 = JSON.parse(fs.readFileSync(warnFile, 'utf8')).targets[w.target];
  assert.equal(rec1.keepHours, 48);
  assert.deepEqual([...rec1.units].sort(), [key(w.glam), key(w.simOld)].sort());
  assert.equal(rec1.checks, 0);

  // nothing changed: the same units are stale again, no miss
  const second = await plan(root, { warnFile });
  assert.match(warnLines(root, second)[0].why, /; misses so far: 0 in 1 checks$/);

  // a build since: a new workspace unit that uses glam makes it live again
  writeCargoUnit(w.target, unit('ffu_net', 5, 0.5, { deps: [w.glam], workspace: true }), NOW);
  const third = await plan(root, { warnFile });
  const rec3 = JSON.parse(fs.readFileSync(warnFile, 'utf8')).targets[w.target];
  assert.equal(rec3.checks, 2);
  assert.equal(rec3.misses, 1, 'glam is on disk and no longer stale');
  assert.deepEqual(rec3.missedUnits, [key(w.glam)]);
  assert.deepEqual([...rec3.units], [key(w.simOld)], 'the new record is what is stale now');
  assert.match(warnLines(root, third)[0].why, /; misses so far: 1 in 2 checks$/);
  assert.deepEqual(third.items, [], 'still plans nothing');

  // a recorded unit that was removed meanwhile is not a miss
  fs.rmSync(path.join(w.target, 'debug', '.fingerprint', key(w.simOld)), { recursive: true });
  await plan(root, { warnFile });
  const rec4 = JSON.parse(fs.readFileSync(warnFile, 'utf8')).targets[w.target];
  assert.equal(rec4.misses, 1);
  assert.equal(rec4.checks, 3);
});

test('w6291 warn: a missing, torn or ill-typed file starts the counts fresh; the file is written only in warn mode', async (t) => {
  const root = install(t);
  world(root);
  const warnFile = path.join(root, 'daemon', 'ffu-runner-sweep-warn.json');
  await plan(root, { warnFile });
  assert.ok(fs.existsSync(warnFile), 'the missing folder and file are made');
  fs.writeFileSync(warnFile, '{"targets":{"x":{"keepH');
  const p = await plan(root, { warnFile });
  assert.match(warnLines(root, p)[0].why, /misses so far: 0 in 0 checks$/);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(warnFile, 'utf8')).targets).length, 1, 'rewritten whole');
  fs.writeFileSync(warnFile, JSON.stringify({ targets: { [targetOf(root)]: { keepHours: 'x', units: 3 }, other: null } }));
  assert.match(warnLines(root, await plan(root, { warnFile }))[0].why, /misses so far: 0 in 0 checks$/);
  // mode on neither reads nor writes it
  const before = fs.readFileSync(warnFile, 'utf8');
  await plan(root, { warnFile, settings: { runnerTargetMode: 'on' } });
  assert.equal(fs.readFileSync(warnFile, 'utf8'), before);
  // no file named: warn lists, counts nothing
  const bare = await plan(root, {});
  assert.doesNotMatch(warnLines(root, bare)[0].why, /misses so far/);
});

test('w6291 warn: the misses kept for a person are the last 20', async (t) => {
  const root = install(t);
  const w = world(root);
  const warnFile = path.join(root, 'daemon', 'ffu-runner-sweep-warn.json');
  await plan(root, { warnFile });
  const rec = JSON.parse(fs.readFileSync(warnFile, 'utf8'));
  rec.targets[w.target].missedUnits = Array.from({ length: 25 }, (_, i) => `old-${String(i).padStart(16, '0')}`);
  rec.targets[w.target].misses = 25;
  fs.writeFileSync(warnFile, JSON.stringify(rec));
  writeCargoUnit(w.target, unit('ffu_net', 5, 0.5, { deps: [w.glam], workspace: true }), NOW);
  await plan(root, { warnFile });
  const after = JSON.parse(fs.readFileSync(warnFile, 'utf8')).targets[w.target];
  assert.equal(after.missedUnits.length, 20);
  assert.equal(after.missedUnits.at(-1), `glam-${w.glam.hash}`);
  assert.equal(after.misses, 26);
});

test('w6291: a unit key drops the lib prefix and the extension; a superseded object file is no unit swept', () => {
  assert.equal(unitKeyOf('libglam-0000000000000002.rlib'), 'glam-0000000000000002');
  assert.equal(unitKeyOf('glam-0000000000000002'), 'glam-0000000000000002');
  assert.equal(unitKeyOf('ffu_sim-0000000000000003.d'), 'ffu_sim-0000000000000003');
  assert.equal(unitKeyOf('CACHEDIR.TAG'), undefined);
  const sweep = { paths: ['/t/debug/deps/libglam-0000000000000002.rlib', '/t/debug/deps/glam-0000000000000002.d', '/t/debug/.fingerprint/glam-0000000000000002', '/t/debug/deps/ffu_sim-0000000000000003.abc.rcgu.o'], bytes: 0, units: 0, live: 0, executables: 0, objects: 1, incrementalBytes: 0 };
  assert.deepEqual(sweptUnits(sweep), ['glam-0000000000000002']);
});

test('w6291: the settings parse: only off, warn and on are modes; hours and cap are held to their ranges', () => {
  const d = INSTALL_LEFTOVER_DEFAULTS;
  assert.deepEqual([d.runnerTargetMode, d.runnerTargetKeepHours, d.runnerTargetCapGB], ['warn', 48, 24]);
  assert.equal(installLeftoverSettings({}).runnerTargetMode, 'warn');
  assert.equal(installLeftoverSettings(undefined).runnerTargetMode, 'warn');
  for (const bad of ['enforce', 'ON', '', 1, true, null, {}]) assert.equal(installLeftoverSettings({ runnerTargetMode: bad }).runnerTargetMode, 'warn', String(bad));
  for (const ok of ['off', 'warn', 'on'] as const) assert.equal(installLeftoverSettings({ runnerTargetMode: ok }).runnerTargetMode, ok);
  assert.equal(installLeftoverSettings({ runnerTargetKeepHours: 0 }).runnerTargetKeepHours, 0);
  assert.equal(installLeftoverSettings({ runnerTargetKeepHours: 24 * 365 }).runnerTargetKeepHours, 24 * 365);
  assert.equal(installLeftoverSettings({ runnerTargetKeepHours: -1 }).runnerTargetKeepHours, 48);
  assert.equal(installLeftoverSettings({ runnerTargetKeepHours: 24 * 365 + 1 }).runnerTargetKeepHours, 48);
  assert.equal(installLeftoverSettings({ runnerTargetKeepHours: '6' }).runnerTargetKeepHours, 48);
  assert.equal(installLeftoverSettings({ runnerTargetCapGB: 0 }).runnerTargetCapGB, 0);
  assert.equal(installLeftoverSettings({ runnerTargetCapGB: 10_000 }).runnerTargetCapGB, 10_000);
  assert.equal(installLeftoverSettings({ runnerTargetCapGB: 10_001 }).runnerTargetCapGB, 24);
  assert.equal(installLeftoverSettings({ runnerTargetCapGB: -5 }).runnerTargetCapGB, 24);
  assert.equal(installLeftoverSettings({ runnerTargetCapGB: Number.NaN }).runnerTargetCapGB, 24);
});

/** A folder outside the install folder: what a junction inside it must never lead the removal into (review w6301 of #1427). */
function outside(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w6291-out-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}
/** Moves `from` to `to` and leaves a junction (a directory symlink off Windows) at `from` pointing at it. */
function junctionAway(from: string, to: string) {
  fs.renameSync(from, to);
  fs.symlinkSync(to, from, 'junction');
}

test('w6291 (review w6301): a junction on the way to a runner target is refused: no item, nothing outside the install folder goes', async (t) => {
  const root = install(t);
  const out = outside(t);
  const w = world(root);
  const glam = path.join(out, 'ffu', 'ffu', 'target', 'debug', 'deps', `libglam-${H.glam}.rlib`);
  junctionAway(path.join(runnerOf(root), '_work', 'ffu'), path.join(out, 'ffu'));
  assert.ok(fs.existsSync(glam), 'the fixture: the stale unit now lives outside, reached through the junction');
  assert.match((await linkOnPath(root, w.target, true)) ?? '', /link or junction/, 'linkOnPath sees the junction on the path');
  const p = await plan(root, { settings: { runnerTargetMode: 'on' } });
  assert.deepEqual(targetItems(p), []);
  for (const l of p.listed.filter((x) => x.path === w.target)) assert.match(l.why, /^refused \(w6291\): .*link or junction/);
  const guard: CleanupGuard = { keep: [path.join(root, 'repo')], inUse: [], home: path.join(root, 'home') };
  await runCleanup(p.items.filter((i) => i.rule.startsWith('ffu-runner')), guard, anyBusyNow(runnerBusyNow(async () => [listener(root, 'r1', 100)], () => NOW, () => idleLog(NOW - HOUR)), runnerTargetLinksNow(root)));
  assert.ok(fs.existsSync(glam), 'the file outside the install folder stays');
});

test('w6291 (review w6301): a junction inside a runner target refuses the whole target in the plan', async (t) => {
  const root = install(t);
  const out = outside(t);
  const w = world(root);
  fs.mkdirSync(path.join(out, 'x'));
  fs.writeFileSync(path.join(out, 'x', 'keep.txt'), 'a person\'s file');
  fs.mkdirSync(path.join(w.target, 'debug', 'build'), { recursive: true });
  fs.symlinkSync(path.join(out, 'x'), path.join(w.target, 'debug', 'build', 'x'), 'junction');
  const p = await plan(root, { settings: { runnerTargetMode: 'on' } });
  assert.deepEqual(targetItems(p), []);
  const l = p.listed.find((x) => x.path === w.target);
  assert.match(l?.why ?? '', /^refused \(w6291\): FFU runner r1's cargo target is never swept through a link or junction: .*build.x/);
  assert.ok(fs.existsSync(path.join(out, 'x', 'keep.txt')));
});

test('w6291 (review w6301): a junction made between the plan and the removal keeps the item (runnerTargetLinksNow); the files it leads to stay', async (t) => {
  const root = install(t);
  const out = outside(t);
  const w = world(root);
  const p = await plan(root, { settings: { runnerTargetMode: 'on' } });
  const items = targetItems(p);
  assert.equal(items.length, 1);
  assert.ok(items[0].members?.length);
  junctionAway(path.join(w.target, 'debug', 'deps'), path.join(out, 'deps'));
  const guard: CleanupGuard = { keep: [path.join(root, 'repo')], inUse: [], home: path.join(root, 'home') };
  const run = await runCleanup(items, guard, anyBusyNow(runnerBusyNow(async () => [listener(root, 'r1', 100)], () => NOW, () => idleLog(NOW - HOUR)), runnerTargetLinksNow(root)));
  assert.equal(run.removed.length, 0);
  assert.match(run.failed[0]?.why ?? '', /^kept: a link or junction is in the target \(w6291\)/);
  assert.ok(fs.existsSync(path.join(out, 'deps', `libglam-${H.glam}.rlib`)), 'the stale unit outside, behind the junction, stays');
  // The whole-target form is walked too.
  assert.match((await runnerTargetLinksNow(root)({ rule: 'ffu-runner-target', path: w.target })) ?? '', /link or junction/);
  // Other rules pass this check untouched.
  assert.equal(await runnerTargetLinksNow(root)({ rule: 'ffu-runner-work', path: w.target }), undefined);
});

test('w6291 (review w6301): the warn file is written whole through a rename, and no temp file is left beside it', async (t) => {
  const root = install(t);
  world(root);
  const warnFile = path.join(root, 'daemon', 'ffu-runner-sweep-warn.json');
  await plan(root, { warnFile });
  assert.ok(JSON.parse(fs.readFileSync(warnFile, 'utf8')).targets);
  assert.deepEqual(fs.readdirSync(path.dirname(warnFile)), ['ffu-runner-sweep-warn.json']);
});
