import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TRIM_DEFAULTS, trimLibraryCaches } from './cacheTrim.ts';

const H = 3_600_000;

/** A project with Library/BuildCache and Library/BurstCache files of the given ages (hours) and sizes (bytes). */
function project(t: { after: (fn: () => void) => void }, files: Record<string, [hours: number, bytes: number]>) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-test-trim-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = Date.now();
  for (const [rel, [hours, bytes]] of Object.entries(files)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'x'.repeat(bytes));
    const at = new Date(now - hours * H);
    fs.utimesSync(f, at, at);
  }
  return { dir, now, has: (rel: string) => fs.existsSync(path.join(dir, rel)) };
}

const HEX = (c: string) => c.repeat(32);

test('trim: superseded Burst player builds go, the newest two stay with the manifest and Hashes, JIT and the rest of Library are never touched (w2752)', async (t) => {
  const p = project(t, {
    [`Library/BurstCache/Windows-Intel/${HEX('a')}.dll`]: [1, 900],
    [`Library/BurstCache/Windows-Intel/${HEX('a')}.pdb`]: [1, 1900],
    [`Library/BurstCache/Windows-Intel/${HEX('b')}.dll`]: [5, 900],
    [`Library/BurstCache/Windows-Intel/${HEX('b')}.pdb`]: [5, 1900],
    [`Library/BurstCache/Windows-Intel/${HEX('c')}.dll`]: [9, 900],
    [`Library/BurstCache/Windows-Intel/${HEX('c')}.pdb`]: [9, 1900],
    [`Library/BurstCache/Windows-Intel/${HEX('d')}.dll`]: [30, 900],
    'Library/BurstCache/Windows-Intel/BurstCacheManifest.cm': [300, 50],
    'Library/BurstCache/Windows-Intel/Hashes/x.bhc': [300, 5],
    'Library/BurstCache/AotSettings_StandaloneWindows.hash': [200, 16],
    [`Library/BurstCache/JIT/${HEX('e')}.dll`]: [500, 700],
    'Library/PlayerDataCache/Win642/Data/level0': [500, 10],
    'Library/EntitySceneBundles/a.archive': [500, 10],
    'Library/Artifacts/ab/x': [500, 10],
    'Library/Bee/keep': [500, 10],
  });
  const r = await trimLibraryCaches(p.dir, TRIM_DEFAULTS, { now: p.now });
  assert.equal(r.skipped, undefined);
  assert.equal(r.stopped, undefined);
  assert.equal(r.files, 3, 'the c pair and d');
  assert.equal(r.removedBytes, 900 + 1900 + 900);
  for (const gone of [`${HEX('c')}.dll`, `${HEX('c')}.pdb`, `${HEX('d')}.dll`]) assert.ok(!p.has(`Library/BurstCache/Windows-Intel/${gone}`), gone);
  for (const kept of [
    `Library/BurstCache/Windows-Intel/${HEX('a')}.dll`,
    `Library/BurstCache/Windows-Intel/${HEX('b')}.pdb`,
    'Library/BurstCache/Windows-Intel/BurstCacheManifest.cm',
    'Library/BurstCache/Windows-Intel/Hashes/x.bhc',
    'Library/BurstCache/AotSettings_StandaloneWindows.hash',
    `Library/BurstCache/JIT/${HEX('e')}.dll`,
    'Library/PlayerDataCache/Win642/Data/level0',
    'Library/EntitySceneBundles/a.archive',
    'Library/Artifacts/ab/x',
    'Library/Bee/keep',
  ])
    assert.ok(p.has(kept), kept);
});

test('trim: BuildCache entry folders go whole, never a file of one: the newest build\'s own stay, then the newest up to the cap (w2752, w1211)', async (t) => {
  const p = project(t, {
    'Library/BuildCache/ab/h1/v1/a.info': [1, 10],
    'Library/BuildCache/ab/h1/v1/a.bundle': [200, 600], // an old file in a folder the newest build rewrote: kept with it
    'Library/BuildCache/ab/h2/v1/b.bundle': [1.5, 600], // the same build (within an hour of the newest write)
    'Library/BuildCache/cd/h3/v1/c.bundle': [5, 300], // fits under the cap after those
    'Library/BuildCache/cd/h3/v2/c.bundle': [8, 400], // past it
    'Library/BuildCache/ef/h4/v9/d.bundle': [50, 10],
  });
  const r = await trimLibraryCaches(p.dir, { ...TRIM_DEFAULTS, buildCacheGB: 1600 / 1024 ** 3 }, { now: p.now });
  assert.deepEqual(
    ['ab/h1/v1/a.bundle', 'ab/h2/v1/b.bundle', 'cd/h3/v1/c.bundle', 'cd/h3/v2', 'ef/h4/v9', 'ef'].map((f) => p.has(`Library/BuildCache/${f}`)),
    [true, true, true, false, false, false],
    'the newest build (610 + 600) and 300 more under 1.6 kB stay; the 400 does not fit, and everything older than it goes too (newest first, as the pipeline\'s own prune)',
  );
});

test('trim: never while an editor or build has the project open, and it stops when one opens meanwhile', async (t) => {
  const open = project(t, { 'Library/BuildCache/ab/h/v/old': [500, 100], 'Temp/UnityLockfile': [0, 0] });
  const r = await trimLibraryCaches(open.dir, TRIM_DEFAULTS, { now: open.now });
  assert.match(r.skipped ?? '', /editor or build/);
  assert.ok(open.has('Library/BuildCache/ab/h/v/old'));
  // Opened meanwhile: a cache of many files, the lock appears after the listing.
  const files: Record<string, [number, number]> = {};
  for (let i = 0; i < 600; i++) files[`Library/BuildCache/ab/h${i}/v/f`] = [500 + i, 10];
  const busy = project(t, files);
  const ac = new AbortController();
  let n = 0;
  const rename = fs.promises.rename;
  t.mock.method(fs.promises, 'rename', async (from: fs.PathLike, to: fs.PathLike) => {
    if (++n === 50) fs.mkdirSync(path.join(busy.dir, 'Temp'), { recursive: true }), fs.writeFileSync(path.join(busy.dir, 'Temp', 'UnityLockfile'), '');
    return rename(from, to);
  });
  const r2 = await trimLibraryCaches(busy.dir, { ...TRIM_DEFAULTS, buildCacheGB: 0 }, { now: busy.now, signal: ac.signal });
  assert.match(r2.stopped ?? '', /opened the project/);
  assert.ok(r2.files > 0 && r2.files < 600, `stopped partway (${r2.files})`);
});

test('trim: an aborted signal stops it between files', async (t) => {
  const p = project(t, { 'Library/BuildCache/ab/h1/v/1': [500, 10], 'Library/BuildCache/ab/h2/v/2': [500, 10] });
  const ac = new AbortController();
  ac.abort();
  const r = await trimLibraryCaches(p.dir, TRIM_DEFAULTS, { now: p.now, signal: ac.signal });
  assert.equal(r.stopped, 'timed out');
  assert.ok(p.has('Library/BuildCache/ab/h1/v/1') && p.has('Library/BuildCache/ab/h2/v/2'));
});
