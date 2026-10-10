import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupPass, type StaleContext } from './staleOutput.ts';
import type { CleanupGuard } from './cleanup.ts';
import { descendants, installLeftoverSettings, mergePlans, planInstallLeftovers, type ProcLite } from './installLeftovers.ts';

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

test("a stopped session's folder holding a clone with unpushed work stays, listed", async (t) => {
  const root = materialize(t);
  const clone = path.join(root, 'tmp', 'ffa-cb4b501c', 'clone');
  fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
  for (const p of [path.join(clone, '.git'), clone, path.dirname(clone)]) fs.utimesSync(p, 1, 1);
  fs.utimesSync(path.join(clone, '..', 'x'), 1, 1);
  const p = await plan(root, { localWork: async () => true });
  assert.ok(!p.items.some((i) => i.path.endsWith('ffa-cb4b501c')));
  assert.ok(p.listed.some((l) => l.path.endsWith('ffa-cb4b501c') && /unpushed/.test(l.why)));
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
