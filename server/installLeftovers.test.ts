import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cleanupPass, type StaleContext } from './staleOutput.ts';
import type { CleanupGuard } from './cleanup.ts';
import { descendants, installLeftoverSettings, mergePlans, newestWrite, planInstallLeftovers, tarOfPlayer, type ProcLite } from './installLeftovers.ts';
import { runCleanup, touchedWhy } from './cleanup.ts';

/**
 * w899: what the daemon's clean-up now takes of the leftovers w876 removed by hand on LothDesktop on 2026-10-10, laid out
 * from the recorded listing (fixtures/lothdesktop-2026-10-10.json), and what it must keep.
 */

interface Listing {
  live: string[];
  entries: { path: string; ageH: number; gb: number; sparse?: boolean }[];
  procs: ProcLite[];
}
const listing: Listing = JSON.parse(fs.readFileSync(new URL('./fixtures/lothdesktop-2026-10-10.json', import.meta.url), 'utf8'));
const HOUR = 3_600_000;
const NOW = Date.now();
/** The fixture's output files are made this long, and the cap lowered to match: a 99.6 GB file stands as 3 MB. */
const BIG = 3_000_000;
const settings = { ...installLeftoverSettings({}), outputCapGB: 1_000_000 / 1024 ** 3 };

function materialize(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  for (const e of listing.entries) {
    const file = path.join(root, ...e.path.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, e.sparse ? Buffer.alloc(BIG) : 'x');
  }
  // Ages last, from the file up to the root of the listing, so a parent never looks newer than its entry.
  for (const e of listing.entries) {
    const at = (NOW - e.ageH * HOUR) / 1000;
    for (let p = path.join(root, ...e.path.split('/')); p.length > root.length; p = path.dirname(p)) fs.utimesSync(p, Math.min(at, fs.statSync(p).mtimeMs / 1000), at);
  }
  // A folder holding only listed entries is as old as the newest of them.
  for (const dir of ['sandboxes/slot5/.nightly-builds/cache', 'nightly/builds', 'nightly/runs', 'scratch', 'tmp']) {
    const d = path.join(root, dir);
    const newest = Math.max(...fs.readdirSync(d).map((n) => fs.statSync(path.join(d, n)).mtimeMs));
    fs.utimesSync(d, newest / 1000, newest / 1000);
  }
  return root;
}

const procsFor = (root: string): ProcLite[] => listing.procs.map((p) => ({ ...p, cmd: p.cmd.replace('D:\\work\\ffw', root) }));

async function plan(root: string, extra: { ctx?: StaleContext; localWork?: (d: string) => Promise<boolean> } = {}) {
  const guard: CleanupGuard = { keep: [path.join(root, 'sandboxes'), path.join(root, 'repo'), path.join(root, 'daemon')], inUse: listing.live.map((id) => path.join(root, 'tmp', `ffa-${id}`)), home: path.join(root, 'home') };
  return planInstallLeftovers({
    root,
    sandboxes: fs.readdirSync(path.join(root, 'sandboxes')).map((n) => path.join(root, 'sandboxes', n)),
    tempRoots: [path.join(root, 'tmp')],
    guard,
    procs: procsFor(root),
    ctx: extra.ctx,
    settings,
    now: NOW,
    self: [500],
    localWork: extra.localWork ?? (async () => false),
  });
}

const rel = (root: string, p: string) => path.relative(root, p).split(path.sep).join('/');

test('takes the old builds, bench builds, captures, nightly runs, rehearsals, scratch and stopped sessions of the LothDesktop listing', async (t) => {
  const root = materialize(t);
  const ctx: StaleContext = { at: new Date(NOW).toISOString(), open: ['w798', 'w881'], closed: ['w597'] };
  const p = await plan(root, { ctx });
  const taken = new Set(p.items.map((i) => rel(root, i.path)));

  // Per-commit builds: the newest two stay; an older one goes once idle (a 4 h old one is still young).
  const c = 'sandboxes/slot5/.nightly-builds/cache/';
  assert.ok(taken.has(c + '58a768404c8b40506e487ea33225fc1b2fca6463-win'));
  assert.ok(taken.has(c + 'cd972fff34f1c3253f9ad83aa86ff57811f8e692-win'));
  assert.ok(taken.has(c + '7c8a19f7364f30a1525a192ea67a574239e31b1b-win'));
  assert.ok(!taken.has(c + 'f0437d8ccad6cfa977c6175f856767cb644ffe04-win'), 'the newest stays');
  assert.ok(!taken.has(c + 'fc7434cb711e32f231ff123a7d34a0ec3f66863c-win'), 'the second newest stays');
  assert.ok(!taken.has(c + '78d9acc71f0a2fbbaac916a624dbce785115f2dd-win'), 'touched 4 h ago: a worker may still use it');
  assert.ok(!taken.has('sandboxes/slot2/Builds/cache/a'), 'a lone cache entry is the newest: a live worker reuses it');
  // Bench builds, captures.
  for (const x of ['sandboxes/slot2/Builds/bench-release', 'sandboxes/slot6/Builds/bench', 'sandboxes/slot6/Builds/bench-release', 'sandboxes/slot1/.nightly-builds/clips', 'sandboxes/slot1/.nightly-builds/shots']) assert.ok(taken.has(x), x);
  // Nightly: builds beyond the newest two, runs but the newest, rehearsals past their age.
  assert.ok(!taken.has('nightly/builds/7c43c32aa803b3aa5019e5415652e7cb871ef8de-win') && !taken.has('nightly/builds/c58d40548cdc8adf567f6ab953a575c7461db633-win'), 'two builds: both are the newest two');
  assert.ok(taken.has('nightly/runs/2026-10-07') && taken.has('nightly/runs/2026-10-08'));
  assert.ok(!taken.has('nightly/runs/2026-10-10'), 'the newest run stays');
  assert.ok(taken.has('nightly/rehearsals/r1') && !taken.has('nightly/rehearsals/r2'));
  assert.ok(![...taken].some((x) => x.startsWith('nightly/state')), 'the nightly lab state is not on the list');
  // Scratch: an open request keeps its folder; a closed or unnamed old one goes.
  assert.ok(taken.has('scratch/slot4-builds') && taken.has('scratch/w597'));
  assert.ok(!taken.has('scratch/w798'));
  // Session temp: stopped sessions' folders go (a fixture repo does not hold one back), live ones stay.
  assert.ok(taken.has('tmp/ffa-63208f3b') && taken.has('tmp/ffa-cb4b501c'));
  assert.ok(!taken.has('tmp/ffa-c25f24bf') && !taken.has('tmp/ffa-60b156aa'));
  // Never Library, Assets, a sandbox itself, scripts.
  for (const x of taken) {
    assert.ok(!/(^|\/)(Library|Assets)(\/|$)/.test(x), x);
    assert.ok(!/^sandboxes\/slot\d$/.test(x), x);
    assert.ok(!x.endsWith('ffc.py'), x);
  }
});

test("an oversize task output of a stopped session goes with the process writing it; a live session's is only listed", async (t) => {
  const root = materialize(t);
  const p = await plan(root);
  const taken = p.items.map((i) => rel(root, i.path));
  assert.ok(taken.includes('tmp/ffa-ae965823/claude/D--work-ffw-sandboxes-slot4/5d1782d2/tasks/bhn7fdfj1.output'));
  // The python and the bash that started it are named; this daemon (pid 500) is not.
  assert.deepEqual(p.strays.map((s) => s.pid).sort((a, b) => a - b), [23756, 29272]);
  assert.ok(!taken.some((x) => x.includes('60b156aa/claude')), "the live session's output is not removed");
  assert.ok(p.listed.some((l) => l.path.includes('60b156aa') && /LIVE/.test(l.why)));
});

test('nothing outside the install folder, and nothing at all without one', async (t) => {
  const root = materialize(t);
  const none = await planInstallLeftovers({ root: undefined, sandboxes: [path.join(root, 'sandboxes', 'slot5')], tempRoots: [path.join(root, 'tmp')], guard: { keep: [], inUse: [], home: root }, now: NOW });
  assert.deepEqual(none.items, []);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(outside, 'ffa-old'));
  fs.utimesSync(path.join(outside, 'ffa-old'), 1, 1);
  const p = await planInstallLeftovers({ root, sandboxes: [], tempRoots: [outside], guard: { keep: [], inUse: [], home: path.join(root, 'home') }, now: NOW, settings });
  assert.ok(!p.items.some((i) => i.path.startsWith(outside)));
});

test("w1575: a stopped session's clone with unpushed work stays, listed; the rest of its folder goes", async (t) => {
  const root = materialize(t);
  const clone = path.join(root, 'tmp', 'ffa-cb4b501c', 'clone');
  fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
  for (const p of [path.join(clone, '.git'), clone, path.dirname(clone)]) fs.utimesSync(p, 1, 1);
  fs.utimesSync(path.join(clone, '..', 'x'), 1, 1);
  const p = await plan(root, { localWork: async (d) => d === clone });
  assert.ok(!p.items.some((i) => i.path.endsWith('ffa-cb4b501c') || i.path.startsWith(clone)), 'neither the folder nor the clone goes');
  assert.ok(p.listed.some((l) => l.path === clone && /unpushed/.test(l.why)), 'the clone is listed for a person');
  assert.ok(p.items.some((i) => i.path === path.join(root, 'tmp', 'ffa-cb4b501c', 'x')), 'what else the folder holds goes');
});

test('w1575: an entry taken alone never takes a repo with work nested deeper inside it', async (t) => {
  const root = materialize(t);
  const tmp = path.join(root, 'tmp');
  lay(tmp, ['ffa-c2829305/clone/.git/HEAD', 'ffa-c2829305/demo-222946/portal/base/.git/HEAD', 'ffa-c2829305/demo-222946/run.log', 'ffa-c2829305/scratch/a.txt'], 30);
  const work = new Set([path.join(tmp, 'ffa-c2829305', 'clone'), path.join(tmp, 'ffa-c2829305', 'demo-222946', 'portal', 'base')]);
  const p = await plan(root, { localWork: async (d) => work.has(d) });
  const taken = new Set(p.items.map((i) => rel(root, i.path)));
  assert.ok(taken.has('tmp/ffa-c2829305/scratch'), 'an entry with no repo goes');
  assert.ok(taken.has('tmp/ffa-c2829305/demo-222946/run.log'), 'beside the deep repo, its log goes');
  for (const x of taken) assert.ok(!/demo-222946\/portal|ffa-c2829305\/clone|^tmp\/ffa-c2829305$|demo-222946$/.test(x), `${x} holds a repo with work`);
  const listedRel = p.listed.map((l) => rel(root, l.path));
  assert.ok(listedRel.includes('tmp/ffa-c2829305/clone') && listedRel.includes('tmp/ffa-c2829305/demo-222946/portal/base'), JSON.stringify(listedRel));
});

/** A folder tree under `base`: each path (a trailing / makes a folder) made, then aged `ageH` hours, leaves first. */
function lay(base: string, paths: string[], ageH: number) {
  const at = (NOW - ageH * HOUR) / 1000;
  for (const rel of paths) {
    const p = path.join(base, ...rel.split('/').filter(Boolean));
    if (rel.endsWith('/')) fs.mkdirSync(p, { recursive: true });
    else (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, 'x'));
  }
  for (const rel of paths) for (let p = path.join(base, ...rel.split('/').filter(Boolean)); p.length > base.length; p = path.dirname(p)) fs.utimesSync(p, at, at);
}

test("w1575: a stopped session's folder changed lately is taken apart: what changed stays, its older entries go", async (t) => {
  const root = materialize(t);
  const dir = path.join(root, 'tmp', 'ffa-60244336');
  lay(dir, ['ff/a.txt', 'ff2/a.txt', 'ff3/a.txt'], 30);
  lay(dir, ['live-run/log.txt'], 0.5);
  fs.utimesSync(dir, (NOW - 0.5 * HOUR) / 1000, (NOW - 0.5 * HOUR) / 1000);
  const p = await plan(root);
  const taken = new Set(p.items.map((i) => rel(root, i.path)));
  assert.ok(!taken.has('tmp/ffa-60244336'), 'the folder changed lately: not whole');
  for (const x of ['ff', 'ff2', 'ff3']) assert.ok(taken.has(`tmp/ffa-60244336/${x}`), x);
  assert.ok(!taken.has('tmp/ffa-60244336/live-run'), 'what changed lately stays');
});

test('w1575: touchedWhy tells too many entries to judge from a change, so a person sees the folder', async (t) => {
  const root = materialize(t);
  const dir = path.join(root, 'tmp', 'ffa-big');
  lay(path.join(root, 'tmp'), ['ffa-big/a/1', 'ffa-big/a/2', 'ffa-big/b/3'], 30);
  assert.equal(await touchedWhy(dir, NOW - HOUR, 3), 'too-big');
  assert.equal(await touchedWhy(dir, NOW - HOUR), undefined);
  assert.equal(await touchedWhy(dir, NOW - 40 * HOUR), 'changed');
});

test('w1575: a fixture repo of a test (ffsb-e2e-<port>/base, a half-deleted build-player-restore-*) holds nothing back', async (t) => {
  const root = materialize(t);
  lay(path.join(root, 'tmp'), ['ffa-d0008818/ffsb-e2e-8791/base/.git/HEAD', 'ffa-d0008818/build-player-restore-0iti1_sb/.git/HEAD', 'ffa-d0008818/w1372-lostlines-abc/.git/HEAD'], 30);
  const p = await plan(root, { localWork: async () => true });
  assert.ok(p.items.some((i) => rel(root, i.path) === 'tmp/ffa-d0008818'), 'the folder goes whole');
});

test('w1575: a session keeps its newest player builds, live or not; an older idle one goes, one a player runs from stays', async (t) => {
  const root = materialize(t);
  const live = path.join(root, 'tmp', `ffa-${listing.live[0]}`);
  const build = (name: string, ageH: number) => lay(live, [`${name}/UnityPlayer.dll`, `${name}/FinalFactory.exe`, `${name}/FinalFactory_Data/data.unity3d`], ageH);
  build('builds/aaa111', 72);
  build('builds/bbb222', 48);
  build('builds/ccc333', 30);
  build('builds/ddd444', 4);
  build('w1468-verify/eee555', 1);
  lay(live, ['builds/not-a-build/readme.txt'], 72);
  const mac = path.join(root, 'tmp', 'ffa-macsess');
  for (const [n, h] of [['a', 50], ['b', 40], ['c', 30]] as const) lay(mac, [`out/${n}/FinalFactory.app/Contents/Frameworks/UnityPlayer.dylib`], h);
  const runs = path.join(live, 'builds', 'bbb222', 'FinalFactory.exe');
  const p = await planInstallLeftovers({
    root,
    sandboxes: [],
    tempRoots: [path.join(root, 'tmp')],
    guard: { keep: [], inUse: [live], resumable: [mac], home: path.join(root, 'home') },
    procs: [{ pid: 7, ppid: 1, cmd: `"${runs}" -batchmode` }],
    settings,
    now: NOW,
  });
  const old = p.items.filter((i) => i.rule === 'session-old-build').map((i) => rel(root, i.path)).sort();
  const id = listing.live[0];
  assert.deepEqual(old, [`tmp/ffa-${id}/builds/aaa111`, `tmp/ffa-${id}/builds/ccc333`, 'tmp/ffa-macsess/out/a/FinalFactory.app'], 'the newest two of each session stay, and the one a player runs from');
  assert.ok(!p.items.some((i) => i.path === live || i.path === mac), "a live or resumed session's folder never goes");
  assert.ok(!p.items.some((i) => i.path.includes('not-a-build')));
  // The clean-up's last check lets an old build through, inside the live folder, and still refuses the folder itself.
  const guard = { keep: [], inUse: [live], resumable: [mac], home: path.join(root, 'home') };
  const r = await runCleanup([...p.items.filter((i) => i.rule === 'session-old-build'), { path: live, why: 'test', rule: 'x' }], guard);
  assert.ok(!fs.existsSync(path.join(live, 'builds', 'aaa111')), 'the old build is removed');
  assert.ok(fs.existsSync(path.join(live, 'w1468-verify', 'eee555', 'UnityPlayer.dll')) && fs.existsSync(path.join(live, 'builds', 'ddd444')), 'the newest two are kept');
  assert.ok(fs.existsSync(runs), 'the build a player runs from is kept');
  assert.ok(r.failed.some((f) => f.path === live && /in use/.test(f.why)), 'the live folder itself is refused');
});

test('descendants walks a process tree', () => {
  const procs: ProcLite[] = [
    { pid: 2, ppid: 1, cmd: 'a' },
    { pid: 3, ppid: 2, cmd: 'b' },
    { pid: 4, ppid: 9, cmd: 'c' },
  ];
  assert.deepEqual(descendants(procs, 1).map((p) => p.pid), [2, 3]);
});

test('a dry run measures what would go and ends nothing; a real pass ends the strays first and keeps Library', async (t) => {
  const root = materialize(t);
  const p = await plan(root);
  const guard: CleanupGuard = { keep: [path.join(root, 'sandboxes')], inUse: [], home: path.join(root, 'home') };
  const ended: number[] = [];
  const pass = (dryRun: boolean) => cleanupPass({ opts: { stale: true, dryRun }, guard, mode: 'on', regular: async () => [], stale: async () => mergePlans({ items: [], listed: [] }, p), endStrays: async (s) => void ended.push(...s.map((x) => x.pid)) });
  const dry = await pass(true);
  assert.ok(dry.planned && dry.planned.length >= 8, 'the dry run lists what it would take');
  assert.equal(ended.length, 0);
  assert.ok(fs.existsSync(path.join(root, 'scratch', 'slot4-builds')));
  const real = await pass(false);
  assert.deepEqual(ended.sort((a, b) => a - b), [23756, 29272]);
  assert.ok(real.removed.length >= 8);
  assert.ok(!fs.existsSync(path.join(root, 'scratch', 'slot4-builds')));
  assert.ok(fs.existsSync(path.join(root, 'sandboxes', 'slot2', 'Library', 'big.bin')));
  assert.ok(fs.existsSync(path.join(root, 'nightly', 'state', 'x.json')));
});

test("w1099: a sandbox night's nightly-history loses old runs and logs as the lab did, never its state, reports or fixtures", async (t) => {
  const root = materialize(t);
  const h = path.join(root, 'nightly-history');
  const put = (rel: string, ageH: number) => {
    const f = path.join(h, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'x');
    const at = (NOW - ageH * HOUR) / 1000;
    for (let p = f; p.length > h.length; p = path.dirname(p)) fs.utimesSync(p, at, at);
  };
  put('runs/2026-10-01/run.json', 10 * 24);
  put('runs/2026-10-02/run.json', 9 * 24);
  put('logs/nightly-2026-10-01.log', 10 * 24);
  put('state/2026-10-01.json', 10 * 24);
  put('reports/2026-10-01.md', 10 * 24);
  put('fixtures/w797-reteoteigam.zip', 10 * 24);
  const p = await plan(root);
  const taken = new Set(p.items.map((i) => rel(root, i.path)));
  assert.ok(taken.has('nightly-history/runs/2026-10-01'), 'an old run goes');
  assert.ok(!taken.has('nightly-history/runs/2026-10-02'), 'the newest run stays, however old');
  assert.ok(taken.has('nightly-history/logs/nightly-2026-10-01.log'));
  for (const x of taken) assert.ok(!/^nightly-history\/(state|reports|fixtures)/.test(x), x);
});

/** Every entry under `dir` (and `dir`) aged `ageH` hours, deepest first, so nothing looks newer than what it holds. */
function ageAll(dir: string, ageH: number) {
  const at = (NOW - ageH * HOUR) / 1000;
  const walk = (p: string) => {
    if (fs.lstatSync(p).isDirectory()) for (const n of fs.readdirSync(p)) walk(path.join(p, n));
    fs.utimesSync(p, at, at);
  };
  walk(dir);
}

/** An idle worker's folder as biscuit's were on 2026-10-22 (w1719): caches beside the work that must stay. */
function idleSession(base: string) {
  const w = (rel: string, data: string | Buffer = 'x') => {
    const p = path.join(base, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
  };
  const capture = Buffer.concat([Buffer.from('PD3U'), Buffer.alloc(1024 ** 2)]);
  w('build-lzg-013039/player/UnityPlayer.so');
  w('build-lzg-013039/player/finalfactory_Data/data.unity3d');
  w('build-lzg-013039/build.log');
  w('ff-rawreader/ProjectSettings/ProjectVersion.txt');
  w('ff-rawreader/Assets/CpuBudget.cs');
  w('ff-rawreader/Library/ArtifactDB');
  w('ff-rawreader/Temp/x.tmp');
  w('ff/package.json');
  w('ff/node_modules/a/index.js');
  w('prof2-075440/branch/round1/save-idle.raw', capture);
  w('prof2-075440/branch/round1/save-idle.csv');
  w('prof2-075440/branch/round1/budget.txt');
  w('undigested/cap.raw', capture);
  w('notprofiler/img.raw', Buffer.alloc(1024 ** 2 + 4));
  w('notprofiler/img.csv');
  w('look-wide-190347/takeover.mp4');
  w('look-wide-190347/frames/f000001.jpg');
  w('look-wide-190347/frames/f000002.jpg');
  w('look-wide-190347/held-3s.png');
  w('shots-only/frames/f000001.png');
  w('report.md');
  // A game clone: its ignored Library goes, an untracked build in its work tree is uncommitted work and stays.
  w('game/.gitignore', '/[Ll]ibrary/\n');
  w('game/ProjectSettings/ProjectVersion.txt');
  w('game/Library/ArtifactDB');
  w('game/out/UnityPlayer.dll');
  execFileSync('git', ['init', '-q', path.join(base, 'game')]);
  // The prof2 digest is written after the capture; the undigested capture has none.
  ageAll(base, 30);
  const digest = (NOW - 29 * HOUR) / 1000;
  for (const f of ['save-idle.csv', 'budget.txt']) fs.utimesSync(path.join(base, 'prof2-075440', 'branch', 'round1', f), digest, digest);
  fs.utimesSync(path.join(base, 'notprofiler', 'img.csv'), digest, digest);
}

test("w1719: a resumable worker's folder with no activity for 24 h loses its rebuildable caches, never its work", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-idle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const tmp = path.join(root, 'tmp');
  const idle = path.join(tmp, 'ffa-7a60f775');
  idleSession(idle);
  ageAll(tmp, 30);
  const guard: CleanupGuard = { keep: [], inUse: [], resumable: [idle], home: path.join(root, 'home') };
  const p = await planInstallLeftovers({ root, sandboxes: [], tempRoots: [tmp], guard, procs: [], settings, now: NOW });
  const taken = p.items.filter((i) => i.rule === 'session-idle-cache').map((i) => rel(idle, i.path)).sort();
  assert.deepEqual(taken, [
    'build-lzg-013039/player',
    'ff-rawreader/Library',
    'ff-rawreader/Temp',
    'ff/node_modules',
    'game/Library',
    'look-wide-190347/frames',
    'prof2-075440/branch/round1/save-idle.raw',
  ]);
  assert.ok(p.items.every((i) => i.inSession === idle && /no activity for 24 h/.test(i.why)), 'each item names its rule and session');
  assert.ok(!p.items.some((i) => i.path === idle), 'the folder itself stays: its request may resume it');

  // The removal's last check lets the caches through the resumable guard and still refuses the folder; each is logged with its size.
  const r = await runCleanup([...p.items, { path: idle, why: 'test', rule: 'x' }], guard);
  assert.equal(r.removed.length, 7);
  assert.ok(r.removed.every((x) => x.bytes > 0 && x.rule === 'session-idle-cache'));
  assert.ok(r.failed.some((f) => f.path === idle && /resume/.test(f.why)), 'the folder itself is refused');
  for (const keep of ['report.md', 'build-lzg-013039/build.log', 'ff-rawreader/Assets/CpuBudget.cs', 'ff/package.json', 'prof2-075440/branch/round1/budget.txt', 'undigested/cap.raw', 'notprofiler/img.raw', 'look-wide-190347/takeover.mp4', 'look-wide-190347/held-3s.png', 'shots-only/frames/f000001.png', 'game/out/UnityPlayer.dll', 'game/.git/HEAD']) {
    assert.ok(fs.existsSync(path.join(idle, ...keep.split('/'))), `${keep} stays`);
  }
});

test('w1719: no cache goes from a folder that is live, written within 24 h, named by a process, open in Unity or not yet judged by the ledger', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-idle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const tmp = path.join(root, 'tmp');
  const [live, fresh, named, open] = ['ffa-11111111', 'ffa-22222222', 'ffa-33333333', 'ffa-44444444'].map((n) => path.join(tmp, n));
  for (const d of [live, fresh, named, open]) idleSession(d);
  fs.writeFileSync(path.join(open, 'ff-rawreader', 'Temp', 'UnityLockfile'), '');
  ageAll(tmp, 30);
  fs.writeFileSync(path.join(fresh, 'prof2-075440', 'notes.txt'), 'written an hour ago');
  fs.utimesSync(path.join(fresh, 'prof2-075440', 'notes.txt'), (NOW - HOUR) / 1000, (NOW - HOUR) / 1000);
  const home = path.join(root, 'home');
  const run = async (guard: CleanupGuard) =>
    (await planInstallLeftovers({ root, sandboxes: [], tempRoots: [tmp], guard, procs: [{ pid: 9, ppid: 1, cmd: `${path.join(named, 'build-lzg-013039', 'player', 'finalfactory.x86_64')} -batchmode` }], settings, now: NOW })).items.filter((i) => i.rule === 'session-idle-cache');
  const items = await run({ keep: [], inUse: [live], resumable: [fresh, named, open], home });
  const sessions = new Set(items.map((i) => path.basename(i.inSession!)));
  assert.deepEqual([...sessions], ['ffa-44444444'], 'only the folder with no activity has caches taken');
  // w1813: a lockfile no process names was left by a crashed editor and holds nothing; without the process list it holds.
  assert.ok(items.some((i) => /ff-rawreader[\\/]Library$/.test(i.path)) && items.some((i) => /ff-rawreader[\\/]Temp$/.test(i.path)), "a crashed editor's lockfile keeps nothing");
  const blind = (await planInstallLeftovers({ root, sandboxes: [], tempRoots: [tmp], guard: { keep: [], inUse: [live], resumable: [fresh, named, open], home }, settings, now: NOW })).items.filter((i) => i.inSession === open);
  assert.ok(blind.length && !blind.some((i) => /ff-rawreader[\\/](Library|Temp)$/.test(i.path)), 'a Unity project that may be open in an editor or a build keeps its Library and Temp');
  // Before the portal's welcome the whole temp root is resumable: nothing goes.
  assert.deepEqual(await run({ keep: [], inUse: [], resumable: [tmp], home }), []);
  // idleCacheHours 0 turns the rule off.
  assert.deepEqual((await planInstallLeftovers({ root, sandboxes: [], tempRoots: [tmp], guard: { keep: [], inUse: [], resumable: [open], home }, settings: { ...settings, idleCacheHours: 0 }, now: NOW })).items.filter((i) => i.rule === 'session-idle-cache'), []);
});

/** A tar as Python's tarfile writes one (ustar headers; `pax` puts each name in a pax header, as tarfile does for a long one). */
function tarOf(entries: { name: string; data: Buffer }[], pax = false): Buffer {
  const header = (name: string, size: number, type = '0') => {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0);
    h.write(size.toString(8).padStart(11, '0'), 124);
    h.write(type, 156);
    h.write('ustar\0', 257);
    return h;
  };
  const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
  const out: Buffer[] = [];
  for (const e of entries) {
    if (pax) {
      const rec = ` path=${e.name}\n`;
      let n = rec.length + 2;
      while (`${n}${rec}`.length !== n) n = `${n}${rec}`.length;
      const data = Buffer.from(`${n}${rec}`);
      out.push(header('././@PaxHeader', data.length, 'x'), pad(data));
    }
    out.push(header(e.name, e.data.length), pad(e.data));
  }
  out.push(Buffer.alloc(1024));
  return Buffer.concat(out);
}

test('w1813: tarOfPlayer finds a player packed into a release tar by its headers, plain or pax-named', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-tar-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  const big = Buffer.alloc(1024 ** 2);
  const put = (name: string, b: Buffer) => (fs.writeFileSync(path.join(dir, name), b), path.join(dir, name));
  assert.equal(await tarOfPlayer(put('linux.tar', tarOf([{ name: 'finalfactory_Data/data.unity3d', data: big }, { name: 'UnityPlayer.so', data: Buffer.from('x') }]))), true);
  const deep = `${'release/'.repeat(14)}player/UnityPlayer.dll`;
  assert.ok(deep.length > 100);
  assert.equal(await tarOfPlayer(put('win.tar', tarOf([{ name: 'a.bin', data: big }, { name: deep, data: Buffer.from('x') }], true))), true);
  assert.equal(await tarOfPlayer(put('saves.tar', tarOf([{ name: 'saves/w797.zip', data: big }, { name: 'notes/UnityPlayer.dll.txt', data: Buffer.from('x') }]))), false);
  assert.equal(await tarOfPlayer(put('junk.tar', Buffer.from('not a tar at all'))), false);
});

test('w1813: the last write of a folder of game clones is judged past 200,000 entries, and a cache or a Library only by its top, git objects not at all', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-newest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const w = (rel: string) => {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x');
    return p;
  };
  for (const f of ['game/Assets/a.cs', 'game/.git/HEAD', 'game/.git/objects/ab/cdef', 'game/Library/Artifacts/00/aa', 'build/player/finalfactory_Data/sub/x', 'build/player/UnityPlayer.dll']) w(f);
  ageAll(root, 30);
  const fresh = (rel: string) => fs.utimesSync(w(rel), (NOW - HOUR) / 1000, (NOW - HOUR) / 1000);
  // Deep inside a Library, a repo's objects or a cache: an editor reopened or a git gc, not the worker's own work.
  fresh('game/Library/Artifacts/00/bb');
  fresh('game/.git/objects/ab/0123');
  fresh('build/player/finalfactory_Data/sub/y');
  const cut = NOW - 24 * HOUR;
  const caches = new Set([path.join(root, 'build', 'player').replace(/\\/g, '/').toLowerCase()]);
  const last = await newestWrite(root, cut, caches);
  assert.ok(typeof last === 'number' && last <= cut, `nothing but cache insides changed (${last})`);
  // A source file the worker wrote counts.
  fresh('game/Assets/b.cs');
  const after = await newestWrite(root, cut, caches);
  assert.ok(typeof after === 'number' && after > cut);
  assert.equal(await newestWrite(root, NOW, caches, 3), 'too-big');
});

/** A stopped urgent-release worker's folder, as beast's ffa-6cf9fea3 and LothDesktop's ffa-409f9363 were on 2026-10-22. */
function releaseSession(base: string) {
  const w = (rel: string, data: string | Buffer = 'x') => {
    const p = path.join(base, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
  };
  const big = Buffer.alloc(1024 ** 2);
  w('urgent-1.0.0.8/stage/linux/release.main.tar', tarOf([{ name: 'finalfactory_Data/data.unity3d', data: big }, { name: 'UnityPlayer.so', data: Buffer.from('x') }]));
  w('urgent-1.0.0.8/stage/linux/other.tar', tarOf([{ name: 'saves/a.zip', data: big }]));
  w('urgent-1.0.0.8/workers/linux-main/release/player/UnityPlayer.so');
  // A Mac player: build-release.sh's release/player holds the .app beside its Localization, six levels down (w1813).
  w('urgent-1.0.0.8/workers/osx-main/release/player/finalfactory.app/Contents/Frameworks/UnityPlayer.dylib');
  w('urgent-1.0.0.8/workers/osx-main/release/player/Localization/en.json');
  w('urgent-1.0.0.8/symbols/linux-main.zip');
  w('urgent-1.0.0.8/run.json');
  w('proj/ProjectSettings/ProjectVersion.txt');
  w('proj/Assets/a.cs');
  for (const d of ['Bee', 'BurstCache', 'BuildCache', 'Artifacts']) w(`proj/Library/${d}/x`);
  w('proj/Library/ArtifactDB');
  for (const d of ['Temp', 'obj', 'Logs']) w(`proj/${d}/x`);
  w('review/takeover.mp4');
  w('report.md');
}

test("w1813: below the soft threshold a stopped worker's caches go after 15 min, a whole Library only after the idle age", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-low-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const tmp = path.join(root, 'tmp');
  const s = path.join(tmp, 'ffa-6cf9fea3');
  releaseSession(s);
  ageAll(tmp, 2);
  const home = path.join(root, 'home');
  const run = async (o: { low?: boolean; inUse?: string[]; now?: number; procs?: ProcLite[] } = {}) =>
    (await planInstallLeftovers({ root, sandboxes: [], tempRoots: [tmp], guard: { keep: [], inUse: o.inUse ?? [], resumable: [s], home }, procs: o.procs ?? [], settings, now: o.now ?? NOW, low: o.low })).items
      .filter((i) => i.rule === 'session-idle-cache')
      .map((i) => rel(s, i.path))
      .sort();
  // Written two hours ago: without low disk nothing goes until the folder was idle a day.
  assert.deepEqual(await run(), []);
  const quick = [
    'proj/Library/Bee',
    'proj/Library/BuildCache',
    'proj/Library/BurstCache',
    'proj/Logs',
    'proj/Temp',
    'proj/obj',
    'urgent-1.0.0.8/stage/linux/release.main.tar',
    'urgent-1.0.0.8/workers/linux-main/release/player',
    'urgent-1.0.0.8/workers/osx-main/release/player/finalfactory.app',
  ];
  assert.deepEqual(await run({ low: true }), quick, 'low disk: everything rebuildable but the Library import');
  // Not while it runs, while a process names it, or when it was written within the settle time.
  assert.deepEqual(await run({ low: true, inUse: [s] }), []);
  assert.deepEqual(await run({ low: true, procs: [{ pid: 7, ppid: 1, cmd: `tar -cf x ${path.join(s, 'urgent-1.0.0.8', 'stage')}` }] }), []);
  const edited = path.join(s, 'report.md');
  fs.writeFileSync(edited, 'edited');
  fs.utimesSync(edited, (NOW - 5 * 60_000) / 1000, (NOW - 5 * 60_000) / 1000);
  assert.deepEqual(await run({ low: true }), []);
  // A day later the whole Library goes too, low or not.
  const later = NOW + 30 * HOUR;
  const full = ['proj/Library', 'proj/Logs', 'proj/Temp', 'proj/obj', 'urgent-1.0.0.8/stage/linux/release.main.tar', 'urgent-1.0.0.8/workers/linux-main/release/player', 'urgent-1.0.0.8/workers/osx-main/release/player/finalfactory.app'];
  assert.deepEqual(await run({ now: later }), full);
  assert.deepEqual(await run({ now: later, low: true }), full);
  // The pass removes them and keeps the sources, the symbols, the other tar, the clip and the report.
  const guard: CleanupGuard = { keep: [], inUse: [], resumable: [s], home };
  const p = await planInstallLeftovers({ root, sandboxes: [], tempRoots: [tmp], guard, procs: [], settings, now: later });
  const r = await runCleanup(p.items, guard);
  assert.equal(r.removed.length, full.length);
  for (const keep of ['proj/Assets/a.cs', 'proj/ProjectSettings/ProjectVersion.txt', 'urgent-1.0.0.8/symbols/linux-main.zip', 'urgent-1.0.0.8/run.json', 'urgent-1.0.0.8/stage/linux/other.tar', 'urgent-1.0.0.8/workers/osx-main/release/player/Localization/en.json', 'review/takeover.mp4', 'report.md']) {
    assert.ok(fs.existsSync(path.join(s, ...keep.split('/'))), `${keep} stays`);
  }
});

test('w1813: a low pass says which check kept a worker folder\'s rebuildable caches, measured', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-held-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const tmp = path.join(root, 'tmp');
  const s = path.join(tmp, 'ffa-409f9363');
  releaseSession(s);
  ageAll(tmp, 2);
  const home = path.join(root, 'home');
  const held = async (o: { low?: boolean; inUse?: string[]; procs?: ProcLite[]; heldMinBytes?: number } = {}) =>
    (await planInstallLeftovers({ root, sandboxes: [], tempRoots: [tmp], guard: { keep: [], inUse: o.inUse ?? [], resumable: [s], home }, procs: o.procs ?? [], settings, now: NOW, low: o.low ?? true, heldMinBytes: o.heldMinBytes ?? 0 })).held ?? [];
  const one = async (o: Parameters<typeof held>[0]) => {
    const h = await held(o);
    assert.equal(h.length, 1, JSON.stringify(h));
    assert.equal(h[0]!.path, s);
    assert.ok(h[0]!.bytes >= 1024 ** 2, `measured: the tar alone is 1 MiB (${h[0]!.bytes})`);
    return h[0]!.why;
  };
  assert.match(await one({ inUse: [s] }), /9 rebuildable cache\(s\) kept: its worker runs/);
  assert.match(await one({ procs: [{ pid: 7, ppid: 1, cmd: `steamcmd +run ${path.join(s, 'urgent-1.0.0.8', 'vdf')}` }] }), /a running process names it \(pid 7: steamcmd/);
  const edited = path.join(s, 'report.md');
  fs.writeFileSync(edited, 'edited');
  fs.utimesSync(edited, (NOW - 5 * 60_000) / 1000, (NOW - 5 * 60_000) / 1000);
  assert.match(await one({}), /written 5 min ago \(.*report\.md\), within the 15 min/);
  // Hourly passes stay as they were (nothing said), and so does a small folder below the floor.
  assert.deepEqual(await held({ low: false, inUse: [s] }), []);
  assert.deepEqual(await held({ inUse: [s], heldMinBytes: 1024 ** 3 }), []);
  // The pass hands them on to its log, a dry run too: each is a "kept" line with its size and reason.
  const guard: CleanupGuard = { keep: [], inUse: [s], resumable: [s], home };
  const p = await planInstallLeftovers({ root, sandboxes: [], tempRoots: [tmp], guard, procs: [], settings, now: NOW, low: true, heldMinBytes: 0 });
  for (const dryRun of [true, false]) {
    const r = await cleanupPass({ opts: { stale: true, dryRun }, guard, mode: 'on', regular: async () => [], stale: async () => mergePlans({ items: [], listed: [] }, p) });
    assert.equal(r.held?.length, 1);
    assert.match(r.held![0]!.why, /its worker runs/);
  }
  // Taken: nothing is said to be kept.
  ageAll(tmp, 2);
  assert.deepEqual(await held({}), []);
});
