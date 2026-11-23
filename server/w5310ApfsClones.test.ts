import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { clonedInSandboxes, planFolders, renderFolders, type CleanupFacts, type SlotContext } from './cleanupFolders.ts';
import { onVolume, removeFolders, volumeFree } from '../machine/leftovers.ts';

const DAY = 86_400_000;
const MB = 1_048_576;

function file(p: string, writtenDaysAgo: number, bytes = 64) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes, 7));
  const t = (Date.now() - writtenDaysAgo * DAY) / 1000;
  fs.utimesSync(p, t, t);
}

/** An install with a seed whose oldest two Burst player builds are stale, and slot3's Library holding one of them. */
function world(t: { after: (fn: () => void) => void }, clone: (from: string, to: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffw-w5310-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const seed = path.join(root, 'seed', 'Library');
  const target = path.join(seed, 'BurstCache', 'macOS-Arm');
  const hashes = ['a', 'b', 'c', 'd'].map((c) => c.repeat(32));
  hashes.forEach((h, i) => file(path.join(target, `${h}.dll`), 10 - i, 1 * MB));
  const sb = path.join(root, 'sandboxes', 'slot3');
  const shared = path.join(sb, 'Library', 'BurstCache', 'macOS-Arm', `${hashes[0]}.dll`);
  fs.mkdirSync(path.dirname(shared), { recursive: true });
  clone(path.join(target, `${hashes[0]}.dll`), shared);
  const facts: CleanupFacts = {
    at: new Date(Date.now() + 1000).toISOString(),
    connected: true,
    root,
    tempRoot: path.join(root, 'tmp'),
    // slot3 is in use: its own Library is no candidate, only the seed's entries are.
    sandboxes: [{ id: 'slot3', path: sb }],
    live: ['wk3'],
    resumable: [],
    owners: { wk3: { sandbox: 'slot3', requests: ['w3'] } } as never,
    open: [],
    closed: [],
    contextAt: new Date().toISOString(),
  };
  const ctx: SlotContext = { host: 'test', alive: () => false, procs: [] };
  return { root, seed, target, hashes, facts, ctx };
}

test('w5310: onVolume reports what the volume freed, clamped to the files\' bytes', () => {
  const size = { bytes: 100 * MB, freed: 100 * MB };
  assert.equal(onVolume(size, 1000 * MB, 1000 * MB).freed, 0); // a clone: free space did not move
  assert.match(onVolume(size, 1000 * MB, 1000 * MB).text, /0 MB freed by the volume's free space, of 100 MB in its files: the rest is still held by an APFS clone/);
  assert.equal(onVolume(size, 1000 * MB, 1100 * MB).freed, 100 * MB);
  assert.equal(onVolume(size, 1000 * MB, 1100 * MB).text, '100 MB freed');
  assert.equal(onVolume(size, 1000 * MB, 990 * MB).freed, 0); // another writer took more than the delete freed
  assert.equal(onVolume(size, 1000 * MB, 1500 * MB).freed, 100 * MB); // another delete meanwhile: never more than the files
  assert.equal(onVolume(size, undefined, undefined).freed, 100 * MB); // statfs unread, or not macOS: the files' count
});

test('w5310: folders counts a seed entry a sandbox Library also holds as APFS clones that free ~0 (macOS)', async (t) => {
  const { seed, target, hashes, facts, ctx } = world(t, (a, b) => fs.copyFileSync(a, b));
  const rows = (await planFolders(facts, { slots: ctx, sizes: 'delete', platform: 'darwin', privateBytes: async () => undefined })).filter((r) => r.kind === 'seed-library');
  const byName = Object.fromEntries(rows.map((r) => [path.basename(r.path), r]));
  assert.deepEqual(Object.keys(byName).sort(), [`${hashes[0]}.dll`, `${hashes[1]}.dll`]);
  assert.equal(byName[`${hashes[0]}.dll`]!.bytes, 0);
  assert.equal(byName[`${hashes[0]}.dll`]!.cloned, MB);
  assert.equal(byName[`${hashes[1]}.dll`]!.bytes, MB);
  assert.equal(byName[`${hashes[1]}.dll`]!.cloned, undefined);
  const plan = await planFolders(facts, { slots: ctx, sizes: 'delete', platform: 'darwin', privateBytes: async () => undefined });
  assert.match(renderFolders(plan, facts), /shared with APFS clones, not freed/);
  // Elsewhere (robocopy on Windows copies, it does not clone) the files' count stands.
  const win = (await planFolders(facts, { slots: ctx, sizes: 'delete', platform: 'win32' })).find((r) => r.path.endsWith(`${hashes[0]}.dll`));
  assert.equal(win!.bytes, MB);
  // A sandbox copy of another size is no clone.
  assert.equal(clonedInSandboxes(path.join(target, `${hashes[1]}.dll`), seed, facts.sandboxes), 0);
});

test('w5310: on APFS, removing a seed entry a sandbox holds as a real clone (cp -c) logs ~0 freed', { skip: process.platform !== 'darwin' && 'APFS clones are macOS only' }, async (t) => {
  const { root, target, hashes, facts, ctx } = world(t, (a, b) => execFileSync('cp', ['-c', a, b]));
  // Bigger than the noise of other writers on a shared Mac: 64 MB, cloned.
  const victim = path.join(target, `${hashes[0]}.dll`);
  file(victim, 10, 64 * MB);
  const shared = path.join(facts.sandboxes[0]!.path, 'Library', 'BurstCache', 'macOS-Arm', `${hashes[0]}.dll`);
  fs.rmSync(shared);
  execFileSync('cp', ['-c', victim, shared]);
  const out: string[] = [];
  const log = path.join(root, 'removed.jsonl');
  const code = await removeFolders([victim], facts, Date.now(), (s) => void out.push(s), async () => ctx, new Map(), { log, cwd: root });
  assert.equal(code, 0, out.join(''));
  assert.ok(!fs.existsSync(victim));
  const line = JSON.parse(fs.readFileSync(log, 'utf8').trim());
  assert.equal(line.fileBytes, 64 * MB, out.join(''));
  assert.ok(line.bytes < 32 * MB, `freed ${line.bytes} of a clone: ${out.join('')}`);
  assert.match(out.join(''), /APFS clone/);
  assert.ok((await volumeFree(root))! > 0);
});
