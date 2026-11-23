import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { judgeWithGit, planFolders, type CleanupFacts, type SlotContext } from './cleanupFolders.ts';
import { idleJitEntries } from './cacheTrim.ts';
import { removeFenceProblem } from '../machine/leftovers.ts';

const DAY = 86_400_000;

function world(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffw-w5280-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const facts: CleanupFacts = {
    at: new Date(Date.now() + 1000).toISOString(),
    connected: true,
    root,
    tempRoot: path.join(root, 'tmp'),
    sandboxes: [],
    live: [],
    resumable: [],
    owners: {},
    open: [],
    closed: [],
    contextAt: new Date().toISOString(),
  };
  const ctx = (procs: string[] = []): SlotContext => ({ host: 'test', alive: () => false, procs });
  return { root, facts, ctx };
}

/** A file with its access and write times `readDaysAgo` and `writtenDaysAgo` days back. */
function file(p: string, writtenDaysAgo: number, readDaysAgo = writtenDaysAgo, body = 'x'.repeat(64)) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  fs.utimesSync(p, (Date.now() - readDaysAgo * DAY) / 1000, (Date.now() - writtenDaysAgo * DAY) / 1000);
}

/** A JIT bundle with its dSYM (a folder holding the DWARF file), as Burst writes them on macOS. */
function bundle(jit: string, hash: string, writtenDaysAgo: number, readDaysAgo: number) {
  file(path.join(jit, `${hash}.bundle`), writtenDaysAgo, readDaysAgo);
  const dwarf = path.join(jit, `${hash}.bundle.dSYM`, 'Contents', 'Resources', 'DWARF', `${hash}.bundle`);
  file(dwarf, writtenDaysAgo);
  for (const d of [path.dirname(dwarf), path.join(jit, `${hash}.bundle.dSYM`, 'Contents', 'Resources'), path.join(jit, `${hash}.bundle.dSYM`, 'Contents'), path.join(jit, `${hash}.bundle.dSYM`)]) fs.utimesSync(d, (Date.now() - writtenDaysAgo * DAY) / 1000, (Date.now() - writtenDaysAgo * DAY) / 1000);
}

/** Four Burst player builds of one target, oldest first, as the daemon trim's fixture writes them. */
function playerBuilds(dir: string): string[] {
  const hashes = ['a', 'b', 'c', 'd'].map((c) => c.repeat(32));
  hashes.forEach((h, i) => {
    for (const ext of ['dll', 'pdb']) file(path.join(dir, `${h}.${ext}`), 10 - i);
  });
  return hashes;
}

test('w5280: an idle sandbox\'s JIT bundle nobody loaded for 14 days is DELETE with its dSYM; one loaded lately stays however old', async (t) => {
  const { root, facts, ctx } = world(t);
  const sb = path.join(root, 'sandboxes', 'slot1');
  const jit = path.join(sb, 'Library', 'BurstCache', 'JIT');
  const idle = '1'.repeat(32);
  const used = '2'.repeat(32);
  bundle(jit, idle, 40, 20);
  bundle(jit, used, 40, 1); // written 40 days ago, loaded yesterday: in use (m5's slot3 bundles look like this)
  file(path.join(jit, 'BurstCacheManifest.cm'), 40);
  const f = { ...facts, sandboxes: [{ id: 'slot1', path: sb }] };
  const at = (rel: string) => judgeWithGit(path.join(jit, rel), f, Date.now(), ctx());
  const gone = await at(`${idle}.bundle`);
  assert.equal(gone.kind, 'sandbox-library');
  assert.equal(gone.verdict, 'delete', gone.why);
  assert.match(gone.why, /a Burst JIT bundle nobody loaded for 20 days/);
  assert.equal((await at(`${idle}.bundle.dSYM`)).verdict, 'delete');
  assert.equal((await at(`${used}.bundle`)).verdict, 'keep');
  assert.equal((await at(`${used}.bundle.dSYM`)).verdict, 'keep');
  assert.equal((await at('BurstCacheManifest.cm')).verdict, 'keep');
  assert.equal((await judgeWithGit(jit, f, Date.now(), ctx())).verdict, 'keep');
  const rows = (await planFolders(f, { slots: ctx(), sizes: 'none' })).filter((r) => r.kind === 'sandbox-library');
  assert.deepEqual(rows.map((r) => path.basename(r.path)).sort(), [`${idle}.bundle`, `${idle}.bundle.dSYM`]);
  // A worker in the sandbox keeps it all.
  const busy = { ...f, live: ['wk1'], owners: { wk1: { sandbox: 'slot1', requests: ['w1'] } } as never };
  assert.equal((await judgeWithGit(path.join(jit, `${idle}.bundle`), busy, Date.now(), ctx())).verdict, 'keep');
});

test('w5280: where the volume keeps no access times (no entry read after it was written), no JIT bundle is judged idle', async (t) => {
  const { root } = world(t);
  const jit = path.join(root, 'proj', 'Library', 'BurstCache', 'JIT');
  bundle(jit, '3'.repeat(32), 40, 40);
  bundle(jit, '4'.repeat(32), 30, 30);
  assert.deepEqual(await idleJitEntries(path.join(root, 'proj')), []);
  bundle(jit, '5'.repeat(32), 30, 2); // one read shows reads are recorded: the two never read go
  assert.equal((await idleJitEntries(path.join(root, 'proj'))).length, 4);
});

test('w5280: the Library seed\'s superseded player builds and old BuildCache folders are DELETE; its JIT, its caches whole and a seed being cloned stay', async (t) => {
  const { root, facts, ctx } = world(t);
  const seed = path.join(root, 'seed', 'Library');
  const hashes = playerBuilds(path.join(seed, 'BurstCache', 'macOS-Arm'));
  bundle(path.join(seed, 'BurstCache', 'JIT'), '6'.repeat(32), 60, 60);
  // BuildCache: the newest build's folder and an old one past the 2 GB cap stand in by age only (a small cap is not needed:
  // the newest build's own folders always stay, an older one stays while under the cap, so mark one 3 GB by a sparse file).
  const newest = path.join(seed, 'BuildCache', 'aa', 'h1', 'v1');
  file(path.join(newest, 'x.info'), 1);
  const big = path.join(seed, 'BuildCache', 'bb', 'h2', 'v1');
  fs.mkdirSync(big, { recursive: true });
  const fd = fs.openSync(path.join(big, 'blob'), 'w');
  fs.ftruncateSync(fd, 3 * 1024 ** 3);
  fs.closeSync(fd);
  fs.utimesSync(path.join(big, 'blob'), (Date.now() - 20 * DAY) / 1000, (Date.now() - 20 * DAY) / 1000);
  const f = { ...facts, librarySeed: seed };
  const at = (rel: string, procs?: string[], ff: CleanupFacts = f) => judgeWithGit(path.join(seed, rel), ff, Date.now(), ctx(procs));

  const old = await at(`BurstCache/macOS-Arm/${hashes[0]}.dll`);
  assert.equal(old.kind, 'seed-library');
  assert.equal(old.verdict, 'delete', old.why);
  assert.match(old.why, /a stale entry of the Library seed's BurstCache: a superseded Burst player build/);
  assert.equal((await at(`BurstCache/macOS-Arm/${hashes[3]}.dll`)).verdict, 'keep');
  assert.equal((await at('BuildCache/bb/h2/v1')).verdict, 'delete');
  assert.equal((await at('BuildCache/aa/h1/v1')).verdict, 'keep');
  assert.equal((await at(`BurstCache/JIT/${'6'.repeat(32)}.bundle`)).verdict, 'keep');
  assert.equal((await at('BurstCache')).verdict, 'keep');
  assert.equal((await at('BurstCache/macOS-Arm')).verdict, 'keep');
  // A sandbox being cloned from the seed (copyTree's cp names it) keeps every entry, and planFolders lists none.
  const cloning = [`cp -c -R ${seed} ${path.join(root, 'sandboxes', 'slot4', 'Library')}`];
  assert.equal((await at(`BurstCache/macOS-Arm/${hashes[0]}.dll`, cloning)).verdict, 'keep');
  assert.equal((await planFolders(f, { slots: ctx(cloning), sizes: 'none' })).filter((r) => r.kind === 'seed-library').length, 0);
  const rows = (await planFolders(f, { slots: ctx(), sizes: 'none' })).filter((r) => r.kind === 'seed-library');
  assert.ok(rows.length === 5 && rows.every((r) => r.verdict === 'delete'), JSON.stringify(rows.map((r) => r.path)));
  assert.ok(!rows.some((r) => r.path.includes(hashes[3]!) || r.path.includes('JIT')));
  // No seed in the facts (a pool that names none, as m5's on 2026-11-23): the install's own seed/Library is judged the same way.
  assert.equal((await at(`BurstCache/macOS-Arm/${hashes[0]}.dll`, [], facts)).verdict, 'delete');
  assert.equal((await at(`BurstCache/macOS-Arm/${hashes[3]}.dll`, [], facts)).verdict, 'keep');
  // A seed configured elsewhere leaves <root>/seed alone.
  const other = path.join(root, 'seed2', 'Library');
  fs.mkdirSync(other, { recursive: true });
  assert.equal((await at(`BurstCache/macOS-Arm/${hashes[0]}.dll`, [], { ...facts, librarySeed: other })).verdict, 'keep');
});

test('w5280: with no seed configured and no <root>/seed/Library, nothing is judged as the seed', async (t) => {
  const { root, facts, ctx } = world(t);
  const lib = path.join(root, 'seedless', 'Library');
  const hashes = playerBuilds(path.join(lib, 'BurstCache', 'macOS-Arm'));
  const r = await judgeWithGit(path.join(lib, 'BurstCache', 'macOS-Arm', `${hashes[0]}.dll`), facts, Date.now(), ctx());
  assert.equal(r.verdict, 'keep');
  assert.equal((await planFolders(facts, { slots: ctx(), sizes: 'none' })).filter((x) => x.kind === 'seed-library').length, 0);
});

test('w5280: a seed that is a project\'s own Library (the main clone\'s, a sandbox\'s) or outside the install folder is never judged as the seed', async (t) => {
  const { root, facts, ctx } = world(t);
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const hashes = playerBuilds(path.join(repo, 'Library', 'BurstCache', 'macOS-Arm'));
  const r = await judgeWithGit(path.join(repo, 'Library', 'BurstCache', 'macOS-Arm', `${hashes[0]}.dll`), { ...facts, librarySeed: path.join(repo, 'Library') }, Date.now(), ctx());
  assert.equal(r.verdict, 'keep');
  assert.notEqual(r.kind, 'seed-library');
  const sb = path.join(root, 'sandboxes', 'slot1');
  playerBuilds(path.join(sb, 'Library', 'BurstCache', 'macOS-Arm'));
  const inSandbox = (await planFolders({ ...facts, librarySeed: path.join(sb, 'Library'), sandboxes: [{ id: 'slot1', path: sb }], live: ['wk1'], owners: { wk1: { sandbox: 'slot1', requests: ['w1'] } } as never }, { slots: ctx(), sizes: 'none' })).filter((x) => x.verdict === 'delete');
  assert.deepEqual(inSandbox, []);
});

test('w5280: remove\'s fence lets through only entries inside the seed\'s Library caches, never the seed, its Library or a cache whole', () => {
  const root = path.join(os.tmpdir(), 'ffw-w5280-fence');
  const o = { home: os.homedir() };
  const p = (rel: string) => path.join(root, ...rel.split('/'));
  for (const rel of ['seed', 'seed/Library', 'seed/Library/BurstCache', 'seed/Library/BuildCache', 'seed/Library/Artifacts/ab/cd', 'seed/Other/BurstCache/x']) assert.match(removeFenceProblem(p(rel), root, o) ?? '', /seed|top folder/, rel);
  // An entry gets past the name fence (and on to its verdict); here it does not exist, which is the next check.
  assert.equal(removeFenceProblem(p('seed/Library/BurstCache/macOS-Arm/a.dll'), root, o), 'no such file or folder');
  assert.equal(removeFenceProblem(p('seed/Library/BuildCache/aa/h1/v1'), root, o), 'no such file or folder');
});
