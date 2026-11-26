import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enforcedShimDir, pathFenceLine, pathFenceMode, watchShimBin } from '../machine/pathFence.ts';
import { FF_LANDLOCK, LOCKED_CHILDREN, readLockArgs, writeLockArgs } from '../machine/writeLock.ts';
import { openChildren } from '../machine/lowIntegrity.ts';
import { READ_ONLY_IN_ROOT, seatbeltProfile, type WorkerFence } from './workerFence.ts';

// w5863: the path fence (machine/pathFence.ts): warn-only first, the shims' enforced folder already shut by both fences.

test('w5863: the path fence is warn when unset on macOS and Linux, off only when asked, and always off on Windows', () => {
  for (const p of ['linux', 'darwin'] as const) {
    assert.equal(pathFenceMode(undefined, p), 'warn', p);
    assert.equal(pathFenceMode('warn', p), 'warn', p);
    assert.equal(pathFenceMode('off', p), 'off', `${p}: the recovery switch`);
    assert.equal(pathFenceMode('on', p), 'warn', `${p}: no enforce in this stage`);
  }
  assert.equal(pathFenceMode(undefined, 'win32'), 'off', 'Windows: its shims are in <root>/tools/shims (w5838)');
  assert.match(pathFenceLine('warn', '/r/unity-slots/bin', '/r'), /warn only; nothing is refused.*[\\/]r[\\/]tools-medium[\\/]shims/);
  assert.match(pathFenceLine('off', '/r/unity-slots/bin', '/r'), /off/);
});

test('w5863: the enforced shims folder is one both fences already keep read-only, and no worker folder', () => {
  const root = path.resolve('/home/u/ffw');
  const dir = enforcedShimDir(root);
  const child = path.relative(root, dir).split(path.sep)[0];
  assert.equal(child, 'tools-medium');
  assert.ok((LOCKED_CHILDREN as readonly string[]).includes(child), 'Landlock: never granted');
  assert.ok(READ_ONLY_IN_ROOT.subpaths.includes(child), 'Seatbelt: denied');
  assert.ok(!openChildren(root, [], LOCKED_CHILDREN).includes(child));
  assert.ok(!writeLockArgs({ root }).some((a) => a === dir || a === path.join(root, child)), 'no --rw for it');
  // Seatbelt is macOS's, so its profile takes a POSIX root on every runner (path.resolve adds a drive letter on Windows).
  const f: WorkerFence = { kind: 'seatbelt', root: '/home/u/ffw', home: '/Users/u', darwinTemp: '/private/var/folders/x/T', darwinCache: '/private/var/folders/x/C' };
  const sb = seatbeltProfile(f);
  const deny = sb.lastIndexOf('(deny file-write*');
  assert.ok(deny > sb.indexOf('(allow file-write*'), 'the deny comes after the allows (later rules win)');
  assert.ok(sb.slice(deny).includes(`(subpath "${path.posix.join('/home/u/ffw', 'tools-medium')}")`), 'tools-medium is in the deny block');
});

const waitFor = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return cond();
};

// The watch runs only where the path fence does (pathFenceMode is always off on Windows, w5838), and Windows' fs.watch
// reports one write as more than one event, so the once-per-hour count is not this runner's to check.
test('w5863: the warn watch logs a write to the shims folder, once per name per hour, and the folder being replaced', { skip: process.platform === 'win32' && 'the path fence is off on Windows' }, async () => {
  const mailbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-pathfence-'));
  const bin = path.join(mailbox, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'ff-pr'), '#!/bin/sh\n');
  const lines: string[] = [];
  let t = 0;
  const stop = watchShimBin(bin, (l) => lines.push(l), { now: () => t });
  try {
    fs.writeFileSync(path.join(mailbox, 'req-1.json'), '{}');
    fs.writeFileSync(path.join(bin, 'ff-pr'), '#!/bin/sh\necho planted\n');
    assert.ok(await waitFor(() => lines.some((l) => l.includes(path.join(bin, 'ff-pr')))), lines.join('\n'));
    assert.match(lines[0], /path fence \(warn\): .*ff-pr changed and the daemon did not write it.*refused once the path fence is on/);
    assert.ok(!lines.some((l) => l.includes('req-1')), 'the mailbox\'s own traffic is not logged');
    const n = lines.length;
    fs.appendFileSync(path.join(bin, 'ff-pr'), 'again\n');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(lines.filter((l) => l.includes('ff-pr')).length, n, 'once per hour per name');
    t = 3600_001;
    fs.appendFileSync(path.join(bin, 'ff-pr'), 'later\n');
    assert.ok(await waitFor(() => lines.length > n), 'after an hour, again');
    fs.renameSync(bin, path.join(mailbox, 'old-bin'));
    assert.ok(await waitFor(() => lines.some((l) => l.includes(`${bin} changed`))), 'the folder moved away');
  } finally {
    stop();
    fs.rmSync(mailbox, { recursive: true, force: true });
  }
});

test('w5872 review: a shims folder removed and made again is watched again, and its removal is logged as the folder', async () => {
  const mailbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-pathfence-'));
  const bin = path.join(mailbox, 'bin');
  fs.mkdirSync(bin);
  const lines: string[] = [];
  const stop = watchShimBin(bin, (l) => lines.push(l));
  try {
    fs.rmSync(bin, { recursive: true });
    assert.ok(await waitFor(() => lines.some((l) => l.includes(`${bin} changed`))), lines.join('\n'));
    assert.ok(!lines.some((l) => l.includes(path.join(bin, 'bin'))), `no <bin>/bin: ${lines.join('\n')}`);
    fs.mkdirSync(bin);
    await new Promise((r) => setTimeout(r, 100));
    fs.writeFileSync(path.join(bin, 'ff-leftovers'), 'planted\n');
    assert.ok(await waitFor(() => lines.some((l) => l.includes(path.join(bin, 'ff-leftovers')))), `a write in the new bin is logged: ${lines.join('\n')}`);
  } finally {
    stop();
    fs.rmSync(mailbox, { recursive: true, force: true });
  }
});

const landlock = process.platform === 'linux' && spawnSync('python3', [FF_LANDLOCK, '--', 'true']).status === 0;

/** A worker root as the daemon has it, with its Unity slots mailbox inside (biscuit: ~/ffw/unity-slots). */
function fakeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-pathfence-root-'));
  for (const c of ['daemon', 'secrets', 'tools-medium', 'tools', 'unity-slots/bin', 'tmp', 'sandboxes']) fs.mkdirSync(path.join(root, c), { recursive: true });
  return root;
}

test('live w5863 warn: a fenced write to the mailbox shims works today (the hole) and the daemon logs it as would-be-refused', { skip: !landlock && 'needs Linux with Landlock' }, async () => {
  const root = fakeRoot();
  const bin = path.join(root, 'unity-slots', 'bin');
  const shim = path.join(bin, 'ff-pr');
  fs.writeFileSync(shim, '#!/bin/sh\necho real\n', { mode: 0o755 });
  const lines: string[] = [];
  const stop = watchShimBin(bin, (l) => lines.push(l));
  try {
    // The lock a sandbox worker runs under today (daemon.ts lockArgs: the mailbox granted whole).
    const args = [...writeLockArgs({ root, appDir: path.join(root, 'daemon'), unitySlots: path.join(root, 'unity-slots') }), ...readLockArgs({ root })];
    const r = spawnSync('python3', [FF_LANDLOCK, ...args, '--', 'sh', '-c', `printf '#!/bin/sh\\necho planted\\n' > ${JSON.stringify(shim)}`], { encoding: 'utf8' });
    assert.equal(r.status, 0, `warn refuses nothing: ${r.stderr}`);
    assert.match(fs.readFileSync(shim, 'utf8'), /planted/);
    assert.ok(await waitFor(() => lines.some((l) => l.includes(shim) && /would|refused once/.test(l))), lines.join('\n'));
  } finally {
    stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('live w5863 enforce: in <root>/tools-medium/shims a fenced worker runs the shims and cannot change, add, move or remove one', { skip: !landlock && 'needs Linux with Landlock' }, () => {
  const root = fakeRoot();
  const dir = enforcedShimDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const shim = path.join(dir, 'ff-pr');
  fs.writeFileSync(shim, '#!/bin/sh\necho real-ff-pr\n', { mode: 0o755 });
  try {
    const args = [...writeLockArgs({ root, appDir: path.join(root, 'daemon'), unitySlots: path.join(root, 'unity-slots') }), ...readLockArgs({ root })];
    const run = (script: string) => spawnSync('python3', [FF_LANDLOCK, ...args, '--', 'sh', '-c', script], { encoding: 'utf8' });
    const q = JSON.stringify;
    const ran = run(`PATH=${q(dir)}:$PATH; ff-pr`);
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stdout.trim(), 'real-ff-pr', 'the shim runs from PATH under the fence');
    for (const [what, script] of [
      ['overwrite', `echo planted > ${q(shim)}`],
      ['append', `echo planted >> ${q(shim)}`],
      ['truncate', `truncate -s 0 ${q(shim)}`],
      ['new file', `echo planted > ${q(path.join(dir, 'python3'))}`],
      ['remove', `rm -f ${q(shim)}`],
      ['rename out', `mv ${q(shim)} ${q(path.join(root, 'tmp', 'x'))}`],
      ['rename in', `echo planted > ${q(path.join(root, 'tmp', 'y'))} && mv ${q(path.join(root, 'tmp', 'y'))} ${q(shim)}`],
      ['replace the folder', `mv ${q(dir)} ${q(path.join(root, 'tmp', 'shims'))}`],
    ] as const) {
      const r = run(script);
      assert.notEqual(r.status, 0, `${what} is refused`);
      assert.match(r.stderr, /Permission denied|Operation not permitted|cannot/i, `${what}: ${r.stderr}`);
    }
    assert.equal(fs.readFileSync(shim, 'utf8'), '#!/bin/sh\necho real-ff-pr\n', 'the shim is untouched');
    assert.deepEqual(fs.readdirSync(dir), ['ff-pr']);
    assert.equal(run(`echo ok > ${q(path.join(root, 'unity-slots', 'req-1.json'))}`).status, 0, 'the mailbox stays writable for slot requests');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
