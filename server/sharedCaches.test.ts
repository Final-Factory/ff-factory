import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { judgePath } from './cleanupFolders.ts';
import { UvCachePruner, applyMediumUvToolDir, findUv, mediumUvCacheDir, mediumUvCacheFor, mediumUvToolDir, mediumUvToolFor, workerUvToolDir, prunedBytes, sandboxUvEnv, uvCandidates, workerDeterminismAuditDir, workerUvCacheDir } from '../machine/sharedCaches.ts';
import { rootEnv } from '../machine/daemon.ts';
import { MEDIUM_CHILDREN } from '../machine/lowIntegrity.ts';
import { LOCKED_CHILDREN } from '../machine/writeLock.ts';
import { READ_ONLY_IN_ROOT } from './workerFence.ts';

// w5281: m5 had 36.9 GB in ~/.cache/uv and 5.2 GB of DeterminismAudit in the game's data folder, both outside the worker
// install folder. The daemon now points both inside it and prunes them there.

test('shared caches: the uv cache and the audit folder are inside the root', () => {
  assert.equal(workerUvCacheDir('/r'), path.join('/r', 'cache', 'uv'));
  assert.equal(workerDeterminismAuditDir('/r'), path.join('/r', 'cache', 'determinism-audit'));
});

test('shared caches: uv prune output gives the bytes freed', () => {
  // uv 0.11.27 on m5, measured: a scratch cache with two `uv run --with` environments.
  assert.equal(prunedBytes('Pruning cache at: uvtest/cache\nRemoved 67 files (527.2KiB)\n'), Math.round(527.2 * 1024));
  assert.equal(prunedBytes('Removed 1,204 files (17.2GiB)'), Math.round(17.2 * 1024 ** 3));
  assert.equal(prunedBytes('Removed 1 file (12B)'), 12);
  assert.equal(prunedBytes('No unused entries found'), 0);
});

test('shared caches: uv is found on PATH first, then where the installers put it', () => {
  const mac = uvCandidates({ PATH: '/usr/bin:/bin' }, '/Users/b', 'darwin');
  assert.deepEqual(mac.slice(0, 2), ['/usr/bin/uv', '/bin/uv']);
  assert.ok(mac.includes('/Users/b/.local/bin/uv') && mac.includes('/opt/homebrew/bin/uv'), 'a launchd PATH lacks Homebrew');
  const win = uvCandidates({ Path: 'C:\\tools', LOCALAPPDATA: 'C:\\Users\\b\\AppData\\Local' }, 'C:\\Users\\b', 'win32');
  assert.equal(win[0], 'C:\\tools\\uv.exe');
  assert.ok(win.includes('C:\\Users\\b\\.local\\bin\\uv.exe'));
  assert.equal(findUv({ PATH: '/nope' }, '/Users/b', 'darwin', (p) => p === '/opt/homebrew/bin/uv'), '/opt/homebrew/bin/uv');
  assert.equal(findUv({ PATH: '' }, '/Users/b', 'darwin', () => false), undefined);
});

test('shared caches: one prune a day, hourly while space is low, one at a time, never forced', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uvprune-'));
  try {
    let now = 1_000_000_000_000;
    const calls: string[][] = [];
    const lines: string[] = [];
    let release: (v: { out: string }) => void = () => {};
    const p = new UvCachePruner({
      dir,
      uv: () => '/bin/uv',
      run: (_uv, args) => {
        calls.push(args);
        return new Promise((r) => (release = r));
      },
      log: (l) => lines.push(l),
      now: () => now,
    });
    const first = p.maybe(false);
    assert.ok(first);
    assert.deepEqual(calls[0], ['cache', 'prune', '--cache-dir', dir], 'no --force: uv waits for running uv processes');
    assert.equal(p.maybe(true), undefined, 'not while one runs');
    release({ out: 'Removed 3 files (2.0GiB)' });
    assert.equal(await first, 2 * 1024 ** 3);
    assert.match(lines.at(-1)!, /freed 2\.00 GB/);
    now += 30 * 60_000;
    assert.equal(p.maybe(false), undefined, 'a day apart normally');
    assert.equal(p.maybe(true), undefined, 'an hour apart while low');
    now += 31 * 60_000;
    assert.ok(p.maybe(true), 'low: after an hour');
    release({ out: '' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shared caches: no uv or no cache folder yet is no prune', () => {
  const lines: string[] = [];
  const none = new UvCachePruner({ dir: '/no/such/cache', uv: () => '/bin/uv', run: async () => ({ out: '' }), log: (l) => lines.push(l) });
  assert.equal(none.maybe(false), undefined);
  assert.ok(none.due(false), 'a missing folder does not use up the day: the next pass looks again');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uvprune-'));
  try {
    const noUv = new UvCachePruner({ dir, uv: () => undefined, run: async () => ({ out: '' }), log: (l) => lines.push(l) });
    assert.equal(noUv.maybe(false), undefined);
    assert.match(lines.at(-1)!, /no uv found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shared caches: ff-leftovers keeps the cache folder and says why', () => {
  const now = Date.now();
  const facts = { at: new Date(now).toISOString(), connected: true, owners: {}, root: '/r', sandboxes: [] } as unknown as Parameters<typeof judgePath>[1];
  const row = judgePath('/r/cache/uv', facts, now);
  assert.equal(row.verdict, 'keep');
  assert.match(row.why, /shared caches/);
});

test("w5565: the daemon and Medium agents use their own uv cache, in a root child every fence keeps from workers; sandbox agents keep the workers' one", () => {
  const r = path.resolve('/r');
  assert.equal(mediumUvCacheDir(r), path.join(r, 'cache-medium', 'uv'));
  for (const list of [MEDIUM_CHILDREN, [...LOCKED_CHILDREN], READ_ONLY_IN_ROOT.subpaths]) assert.ok(list.includes('cache-medium'), String(list));
  for (const platform of ['win32', 'darwin', 'linux'] as const) assert.equal(rootEnv(r, platform).UV_CACHE_DIR, mediumUvCacheDir(r), platform);
  // the daemon's start: unset or the workers' cache (an older daemon's) moves; one daemon.json names stays
  assert.equal(mediumUvCacheFor({}, r), mediumUvCacheDir(r));
  assert.equal(mediumUvCacheFor({ UV_CACHE_DIR: workerUvCacheDir(r) }, r), mediumUvCacheDir(r));
  assert.equal(mediumUvCacheFor({ UV_CACHE_DIR: mediumUvCacheDir(r) }, r), undefined);
  assert.equal(mediumUvCacheFor({ UV_CACHE_DIR: path.resolve('/elsewhere') }, r), undefined);
  // a sandbox agent: the workers' cache in place of the Medium one, nothing else touched
  const t = { UV_TOOL_DIR: mediumUvToolDir(r) };
  assert.deepEqual(sandboxUvEnv({ ...t, UV_CACHE_DIR: mediumUvCacheDir(r) }, r), { UV_CACHE_DIR: workerUvCacheDir(r), UV_TOOL_DIR: workerUvToolDir(r) });
  assert.deepEqual(sandboxUvEnv({ ...t, UV_CACHE_DIR: path.resolve('/elsewhere') }, r), { UV_TOOL_DIR: workerUvToolDir(r) });
  assert.deepEqual(sandboxUvEnv({ UV_CACHE_DIR: mediumUvCacheDir(r) }, undefined), {});
});

test("w5693: uvx's tool folder: sandbox agents get one inside the workers' cache, the daemon and Medium agents their own, which every fence keeps from workers", () => {
  const r = path.resolve('/r');
  assert.equal(workerUvToolDir(r), path.join(r, 'cache', 'uv-tools'));
  assert.equal(mediumUvToolDir(r), path.join(r, 'cache-medium', 'uv-tools'));
  // the workers' one is inside the cache child every fence opens; the Medium one inside cache-medium, which none does
  assert.ok(workerUvToolDir(r).startsWith(workerUvCacheDir(r).replace(/uv$/, '')));
  for (const list of [[...LOCKED_CHILDREN], READ_ONLY_IN_ROOT.subpaths]) assert.ok(list.includes(path.relative(r, mediumUvToolDir(r)).split(path.sep)[0]), String(list));
  // a fenced (sandbox) agent: unset (uv's default in the person's home, which the fence refuses) or the Medium one -> the workers'
  for (const env of [{}, { UV_TOOL_DIR: mediumUvToolDir(r) }, { UV_TOOL_DIR: '' }]) assert.equal(sandboxUvEnv(env, r).UV_TOOL_DIR, workerUvToolDir(r), JSON.stringify(env));
  assert.equal(sandboxUvEnv({ UV_TOOL_DIR: path.resolve('/elsewhere') }, r).UV_TOOL_DIR, undefined, 'one daemon.json names stays');
  // the daemon's start: unset or the workers' one moves to the Medium one; one daemon.json names stays
  assert.equal(mediumUvToolFor({}, r), mediumUvToolDir(r));
  assert.equal(mediumUvToolFor({ UV_TOOL_DIR: workerUvToolDir(r) }, r), mediumUvToolDir(r));
  assert.equal(mediumUvToolFor({ UV_TOOL_DIR: path.resolve('/elsewhere') }, r), undefined);
});

test('w5693: the Medium tool folder is set only once made; a folder that cannot be made keeps the old one and warns (no lockout)', () => {
  const r = path.resolve('/r');
  const made: string[] = [];
  const env: Record<string, string | undefined> = {};
  assert.match(applyMediumUvToolDir(env, r, (d) => made.push(d)) ?? '', /for the daemon and Medium agents/);
  assert.deepEqual(made, [mediumUvToolDir(r)]);
  assert.equal(env.UV_TOOL_DIR, mediumUvToolDir(r));
  assert.equal(applyMediumUvToolDir(env, r, () => assert.fail('already set')), undefined);
  const failing: Record<string, string | undefined> = {};
  const line = applyMediumUvToolDir(failing, r, () => {
    throw new Error('EACCES: permission denied');
  });
  assert.match(line ?? '', /could not make .*EACCES.*keep uv's own default/);
  assert.equal(failing.UV_TOOL_DIR, undefined, "uv's default stays");
  // the sandbox agents still get the workers' folder on such a machine
  assert.equal(sandboxUvEnv(failing, r).UV_TOOL_DIR, workerUvToolDir(r));
});
