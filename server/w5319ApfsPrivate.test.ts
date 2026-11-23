import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { planFolders, renderFolders, type CleanupFacts, type SlotContext } from './cleanupFolders.ts';
import { apfsPrivateBytes } from './apfsPrivate.ts';

const DAY = 86_400_000;
const MB = 1_048_576;
const onMac = process.platform === 'darwin';

function file(p: string, writtenDaysAgo: number, bytes: number) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes, 7));
  const t = (Date.now() - writtenDaysAgo * DAY) / 1000;
  fs.utimesSync(p, t, t);
}

/**
 * m5 on 2026-11-23: a seed whose two oldest Burst builds are stale, one of them cloned to a place outside every sandbox
 * Library (on m5 the seed's blocks are shared with copies no worker reads), and no sandbox holding it.
 */
function world(t: { after: (fn: () => void) => void }, clone?: (from: string, to: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffw-w5319-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'seed', 'Library', 'BurstCache', 'macOS-Arm');
  const hashes = ['a', 'b', 'c', 'd'].map((c) => c.repeat(32));
  hashes.forEach((h, i) => file(path.join(target, `${h}.dll`), 10 - i, 2 * MB));
  if (clone) clone(path.join(target, `${hashes[0]}.dll`), path.join(root, 'elsewhere.dll'));
  const sb = path.join(root, 'sandboxes', 'slot3');
  fs.mkdirSync(path.join(sb, 'Library'), { recursive: true });
  const facts: CleanupFacts = {
    at: new Date(Date.now() + 1000).toISOString(),
    connected: true,
    root,
    tempRoot: path.join(root, 'tmp'),
    sandboxes: [{ id: 'slot3', path: sb }],
    live: ['wk3'],
    resumable: [],
    owners: { wk3: { sandbox: 'slot3', requests: ['w3'] } } as never,
    open: [],
    closed: [],
    contextAt: new Date().toISOString(),
  };
  const ctx: SlotContext = { host: 'test', alive: () => false, procs: [] };
  return { root, target, hashes, facts, ctx };
}

test('w5319: on macOS folders counts a row by its APFS private bytes, so a clone no sandbox holds is not promised', async (t) => {
  const { hashes, facts, ctx } = world(t);
  const asked: string[][] = [];
  const privateBytes = async (paths: string[]) => (asked.push(paths), paths.map((p) => (p.includes(hashes[0]!) ? 0 : p.includes(hashes[1]!) ? MB : null)));
  const plan = await planFolders(facts, { slots: ctx, sizes: 'delete', platform: 'darwin', privateBytes });
  const by = Object.fromEntries(plan.filter((r) => r.kind === 'seed-library').map((r) => [path.basename(r.path), r]));
  assert.equal(by[`${hashes[0]}.dll`]!.bytes, 0); // all of it shared: nothing freed
  assert.equal(by[`${hashes[0]}.dll`]!.cloned, 2 * MB);
  assert.equal(by[`${hashes[1]}.dll`]!.bytes, MB); // half shared
  assert.equal(by[`${hashes[1]}.dll`]!.cloned, MB);
  assert.equal(plan.freed, MB, 'the total promises only what the volume would free');
  assert.equal(plan.cloned, 3 * MB);
  assert.match(renderFolders(plan, facts), /\+3 MB shared with APFS clones, not freed/);
  assert.equal(asked.length, 1, 'one read for every row');
  // Not macOS: no read, the files' count stands.
  const win = await planFolders(facts, { slots: ctx, sizes: 'delete', platform: 'win32', privateBytes: async () => assert.fail('read on win32') });
  assert.equal(win.freed, 4 * MB);
});

test('w5319: a path whose private size is unknown (null) keeps its files\' count, and a tiny share is not shown', async (t) => {
  const { facts, ctx } = world(t);
  const plan = await planFolders(facts, { slots: ctx, sizes: 'delete', platform: 'darwin', privateBytes: async (ps) => ps.map((): null => null) });
  assert.equal(plan.freed, 4 * MB);
  assert.equal(plan.cloned, undefined);
  const near = await planFolders(facts, { slots: ctx, sizes: 'delete', platform: 'darwin', privateBytes: async (ps) => ps.map(() => 2 * MB - 1000) });
  assert.doesNotMatch(renderFolders(near, facts), /0 MB shared/);
});

test('w5319: apfsPrivateBytes reads a real cp -c clone as 0 and a lone file whole (APFS)', { skip: !onMac && 'APFS is macOS only' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffw-w5319p-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = path.join(dir, 'd', 'a.bin');
  file(a, 0, 4 * MB);
  execFileSync('cp', ['-c', a, path.join(dir, 'b.bin')]);
  file(path.join(dir, 'd', 'solo.bin'), 0, 3 * MB);
  const got = await apfsPrivateBytes([a, path.join(dir, 'b.bin'), path.join(dir, 'd', 'solo.bin'), path.join(dir, 'd'), path.join(dir, 'gone')]);
  assert.deepEqual(got, [0, 0, 3 * MB, 3 * MB, 0]);
  assert.equal(await apfsPrivateBytes([a], { python: path.join(dir, 'no-python') }), undefined);
});

test('w5319: folders on a real APFS clone outside every sandbox Library promises ~0 for it (m5\'s case)', { skip: !onMac && 'APFS is macOS only' }, async (t) => {
  const { hashes, facts, ctx } = world(t, (a, b) => execFileSync('cp', ['-c', a, b]));
  const plan = await planFolders(facts, { slots: ctx, sizes: 'delete', platform: 'darwin' });
  const by = Object.fromEntries(plan.filter((r) => r.kind === 'seed-library').map((r) => [path.basename(r.path), r]));
  assert.equal(by[`${hashes[0]}.dll`]!.bytes, 0, 'the clone outside the sandboxes keeps its blocks');
  assert.equal(by[`${hashes[1]}.dll`]!.bytes, 2 * MB);
  assert.equal(plan.freed, 2 * MB);
});
