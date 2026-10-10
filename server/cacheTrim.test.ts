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

test('trim: files older than the keep age go, the recent ones stay, the rest of Library is never touched, empty folders go', async (t) => {
  const p = project(t, {
    'Library/BuildCache/ab/old.bin': [100, 1000],
    'Library/BuildCache/ab/new.bin': [3, 1000],
    'Library/BuildCache/cd/old.bin': [60, 1000],
    'Library/BurstCache/Windows-Intel/old.dll': [72, 5000],
    'Library/BurstCache/Windows-Intel/new.dll': [1, 5000],
    'Library/BurstCache/AotSettings_StandaloneWindows.hash': [200, 16],
    'Library/ArtifactDB/keep': [500, 10],
    'Library/Bee/keep': [500, 10],
    'Assets/keep.cs': [500, 10],
  });
  const r = await trimLibraryCaches(p.dir, { ...TRIM_DEFAULTS, keepHours: 48, capGB: 0 }, { now: p.now });
  assert.equal(r.skipped, undefined);
  assert.equal(r.stopped, undefined);
  assert.equal(r.files, 4, 'the four old cache files');
  assert.equal(r.removedBytes, 1000 + 1000 + 5000 + 16);
  assert.equal(r.keptBytes, 1000 + 5000);
  for (const kept of ['Library/BuildCache/ab/new.bin', 'Library/BurstCache/Windows-Intel/new.dll', 'Library/ArtifactDB/keep', 'Library/Bee/keep', 'Assets/keep.cs']) assert.ok(p.has(kept), kept);
  for (const gone of ['Library/BuildCache/ab/old.bin', 'Library/BuildCache/cd/old.bin', 'Library/BuildCache/cd', 'Library/BurstCache/Windows-Intel/old.dll', 'Library/BurstCache/AotSettings_StandaloneWindows.hash']) assert.ok(!p.has(gone), gone);
  assert.ok(p.has('Library/BuildCache') && p.has('Library/BurstCache'), 'the cache folders themselves stay');
});

test('trim: a cap keeps the newest files of each cache up to the cap, even young ones past it go oldest first', async (t) => {
  const p = project(t, {
    'Library/BuildCache/a/1': [1, 400],
    'Library/BuildCache/a/2': [2, 400],
    'Library/BuildCache/a/3': [3, 400],
    'Library/BurstCache/x/1': [5, 300],
  });
  const r = await trimLibraryCaches(p.dir, { keepHours: 48, capGB: 900 / 1024 ** 3, timeoutMs: 1000 }, { now: p.now });
  assert.deepEqual(['Library/BuildCache/a/1', 'Library/BuildCache/a/2', 'Library/BuildCache/a/3', 'Library/BurstCache/x/1'].map(p.has), [true, true, false, true], 'the oldest of BuildCache over 900 bytes; BurstCache is its own cap');
  assert.equal(r.removedBytes, 400);
  assert.equal(r.keptBytes, 800 + 300);
});

test('trim: never while an editor or build has the project open, and it stops when one opens meanwhile', async (t) => {
  const open = project(t, { 'Library/BuildCache/a/old': [500, 100], 'Temp/UnityLockfile': [0, 0] });
  const r = await trimLibraryCaches(open.dir, TRIM_DEFAULTS, { now: open.now });
  assert.match(r.skipped ?? '', /editor or build/);
  assert.ok(open.has('Library/BuildCache/a/old'));
  // Opened meanwhile: a cache of many files, the lock appears after the listing.
  const files: Record<string, [number, number]> = {};
  for (let i = 0; i < 600; i++) files[`Library/BuildCache/a/f${i}`] = [500, 10];
  const busy = project(t, files);
  const ac = new AbortController();
  let n = 0;
  const unlink = fs.promises.unlink;
  t.mock.method(fs.promises, 'unlink', async (f: fs.PathLike) => {
    if (++n === 50) fs.mkdirSync(path.join(busy.dir, 'Temp'), { recursive: true }), fs.writeFileSync(path.join(busy.dir, 'Temp', 'UnityLockfile'), '');
    return unlink(f);
  });
  const r2 = await trimLibraryCaches(busy.dir, TRIM_DEFAULTS, { now: busy.now, signal: ac.signal });
  assert.match(r2.stopped ?? '', /opened the project/);
  assert.ok(r2.files > 0 && r2.files < 600, `stopped partway (${r2.files})`);
});

test('trim: an aborted signal stops it between files', async (t) => {
  const p = project(t, { 'Library/BuildCache/a/1': [500, 10], 'Library/BuildCache/a/2': [500, 10] });
  const ac = new AbortController();
  ac.abort();
  const r = await trimLibraryCaches(p.dir, TRIM_DEFAULTS, { now: p.now, signal: ac.signal });
  assert.equal(r.stopped, 'timed out');
  assert.ok(p.has('Library/BuildCache/a/1') && p.has('Library/BuildCache/a/2'));
});
