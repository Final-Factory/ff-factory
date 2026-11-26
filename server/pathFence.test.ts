import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enforcedShimDir, guardOldShimBin, guardShimModes, pathFenceLine, pathFenceMode, readyShimDir, shimDirFor, shimQuarantineDir, watchShimBin } from '../machine/pathFence.ts';
import { writeShims } from '../machine/unitySlots.ts';
import { hostsWithPathDir } from '../machine/agentHost.ts';
import { FF_LANDLOCK, LOCKED_CHILDREN, readLockArgs, writeLockArgs } from '../machine/writeLock.ts';
import { openChildren } from '../machine/lowIntegrity.ts';
import { READ_ONLY_IN_ROOT, seatbeltProfile, type WorkerFence } from './workerFence.ts';

// w5863, w5899: the path fence (machine/pathFence.ts): the shims' enforced folder, shut by both fences, on by default.

test('w5899: the path fence is on when unset on macOS and Linux, warn or off only when asked, and always off on Windows', () => {
  for (const p of ['linux', 'darwin'] as const) {
    assert.equal(pathFenceMode(undefined, p), 'on', p);
    assert.equal(pathFenceMode('on', p), 'on', p);
    assert.equal(pathFenceMode('enforce', p), 'on', `${p}: a value off the wire fences`);
    assert.equal(pathFenceMode('warn', p), 'warn', p);
    assert.equal(pathFenceMode('off', p), 'off', `${p}: the recovery switch`);
  }
  assert.equal(pathFenceMode(undefined, 'win32'), 'off', 'Windows: its shims are in <root>/tools/shims (w5838)');
  const root = path.resolve('/r');
  const mailbox = path.join(root, 'unity-slots');
  assert.equal(shimDirFor('on', mailbox, root), path.join(root, 'tools-medium', 'shims'));
  assert.equal(shimDirFor('on', mailbox, undefined), path.join(mailbox, 'bin'), 'no worker root: the mailbox');
  for (const m of ['warn', 'off'] as const) assert.equal(shimDirFor(m, mailbox, root), path.join(mailbox, 'bin'), m);
  assert.match(pathFenceLine('on', enforcedShimDir(root), root), /on; .*tools-medium[\\/]shims.*cannot write.*path_fence off/);
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

test('w5899, w5872 review: an extra writable folder that holds a locked one (the shims folder among them) is left out of the lock', () => {
  const root = path.resolve('/home/u/ffw');
  const said: string[] = [];
  const keep = path.join(root, 'tmp', 'more');
  const args = writeLockArgs({ root, extra: [root, path.join(root, 'tools-medium'), enforcedShimDir(root), path.dirname(root), keep], extraRoots: [path.dirname(root)], dropped: (f) => said.push(f) });
  const rw = args.flatMap((a, i) => (args[i - 1] === '--rw' ? [a] : []));
  const dir = enforcedShimDir(root);
  assert.ok(!rw.some((g) => g === dir || dir.startsWith(g + path.sep)), `no grant covers ${dir}: ${rw.join(' ')}`);
  assert.ok(rw.includes(keep), 'a folder inside a writable child stays');
  assert.deepEqual(said, [path.dirname(root), root, path.join(root, 'tools-medium'), dir, path.dirname(root)], 'each one left out is told');
});

test('w5899: an agent host counts for the old shims folder while it runs with it on its PATH, or with no PATH record (older than w5899)', () => {
  const hosts = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-pathfence-hosts-'));
  const bin = path.resolve('/r/unity-slots/bin');
  const host = (id: string, place: object | undefined, pid = process.pid) => {
    fs.mkdirSync(path.join(hosts, id));
    fs.writeFileSync(path.join(hosts, id, 'host.json'), JSON.stringify({ hostProtocol: 1, sessionId: id, pid, startedAt: 1 }));
    if (place) fs.writeFileSync(path.join(hosts, id, 'place.json'), JSON.stringify(place));
  };
  try {
    host('old-path', { cwd: '/w', path: `/x:${bin}:/usr/bin` });
    host('no-mark', { cwd: '/w' });
    host('moved', { cwd: '/w', path: `/r/tools-medium/shims:/usr/bin` });
    host('unfenced', { cwd: '/w', path: `${bin}/` });
    host('ended', { cwd: '/w', path: bin }, 2 ** 22 + 12345);
    assert.deepEqual(hostsWithPathDir(hosts, bin).sort(), ['no-mark', 'old-path', 'unfenced']);
  } finally {
    fs.rmSync(hosts, { recursive: true, force: true });
  }
});

// The old shims folder's guard (machine/pathFence.ts guardOldShimBin). The options go in a variable, not a literal, so the
// same tests also type-check against the guard before w6063 (restore, a snapshot of the folder), which they fail.
const SHIM = '#!/bin/sh\necho real-ff-pr\n';
function guardRoot() {
  const root = fakeRoot();
  const bin = path.join(root, 'unity-slots', 'bin');
  const target = enforcedShimDir(root);
  fs.mkdirSync(target, { recursive: true });
  for (const n of ['ff-pr', 'unity-slot']) fs.writeFileSync(path.join(target, n), SHIM, { mode: 0o755 });
  const lines: string[] = [];
  const opts = (waits: () => string[], everyMs = 100) => ({
    target,
    quarantine: shimQuarantineDir(root),
    // Only the guard before w6063 calls it: it wrote the daemon's shims into the old folder itself.
    restore: () => {
      fs.mkdirSync(bin, { recursive: true });
      for (const n of ['ff-pr', 'unity-slot']) fs.writeFileSync(path.join(bin, n), SHIM, { mode: 0o755 });
    },
    waits,
    log: (l: string) => lines.push(l),
    everyMs,
  });
  // What an agent started before the move finds first on its PATH.
  const runs = (n: string) => fs.existsSync(path.join(bin, n)) && fs.statSync(path.join(bin, n)).isFile() && fs.readFileSync(path.join(bin, n), 'utf8') === SHIM;
  const only = () => runs('ff-pr') && runs('unity-slot') && fs.readdirSync(bin).sort().join() === 'ff-pr,unity-slot';
  return { root, bin, target, lines, opts, runs, only };
}

test('w5899: with no agent started before the move, the old shims folder goes at once', () => {
  const g = guardRoot();
  try {
    fs.writeFileSync(path.join(g.bin, 'ff-pr'), 'old');
    guardOldShimBin(g.bin, g.opts(() => []))();
    assert.equal(fs.existsSync(g.bin), false);
    assert.ok(fs.existsSync(path.join(g.root, 'unity-slots')), 'the mailbox stays');
    assert.match(g.lines.join('\n'), /removed the old shims folder/);
  } finally {
    fs.rmSync(g.root, { recursive: true, force: true });
  }
});

// fs.watch on Windows differs, and the path fence never runs there (pathFenceMode is off on Windows).
const notWin = { skip: process.platform === 'win32' && 'the path fence is off on Windows' };

test('w5899, w5872 review: while agents started before the move run, the old shims folder runs only the daemon\'s shims, then goes', notWin, async () => {
  const g = guardRoot();
  let waits = ['s1'];
  const stop = guardOldShimBin(g.bin, g.opts(() => waits));
  try {
    assert.ok(g.only(), 'those agents find the daemon\'s shims');
    assert.match(g.lines[0], /keeping the old shims folder .* 1 agent started before the move \(s1\)/);
    assert.ok(fs.lstatSync(g.bin).isSymbolicLink() && fs.readlinkSync(g.bin) === g.target, 'a link to <root>/tools-medium/shims, which the fence keeps read-only');
    fs.rmSync(g.bin);
    fs.mkdirSync(g.bin);
    fs.writeFileSync(path.join(g.bin, 'ff-pr'), '#!/bin/sh\necho planted\n', { mode: 0o755 });
    assert.ok(await waitFor(g.only), 'a folder put in its place is taken out');
    const elsewhere = path.join(g.root, 'tmp');
    fs.writeFileSync(path.join(elsewhere, 'keep'), 'keep');
    fs.rmSync(g.bin);
    fs.symlinkSync(elsewhere, g.bin);
    assert.ok(await waitFor(g.only), 'a link elsewhere is replaced');
    assert.equal(fs.readFileSync(path.join(elsewhere, 'keep'), 'utf8'), 'keep', 'the link\'s target is left alone');
    fs.rmSync(g.bin);
    fs.writeFileSync(g.bin, 'x');
    assert.ok(await waitFor(g.only), 'a file in its place is replaced');
    assert.match(g.lines.join('\n'), /undid a change the daemon did not make in the old shims folder/);
    assert.ok(fs.readdirSync(shimQuarantineDir(g.root)).length === 0, 'what was taken out is removed from the quarantine');
    waits = [];
    assert.ok(await waitFor(() => !fs.existsSync(g.bin) && !lstatOrUndefined(g.bin)), 'it goes once they have ended');
    assert.ok(fs.existsSync(path.join(g.target, 'ff-pr')), 'the real shims stay');
    assert.match(g.lines.at(-1)!, /removed the old shims folder .*every agent started before the move has ended/);
    fs.mkdirSync(g.bin);
    fs.writeFileSync(path.join(g.bin, 'git'), 'x');
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(fs.existsSync(path.join(g.bin, 'git')), 'the guard has stopped: no agent has that folder on its PATH any more');
  } finally {
    stop();
    fs.rmSync(g.root, { recursive: true, force: true });
  }
});

test('w6063 probe A: a name a worker planted in the old shims folder before the daemon starts is gone, and stays gone', notWin, async () => {
  const g = guardRoot();
  fs.writeFileSync(path.join(g.bin, 'gh'), '#!/bin/sh\necho planted\n', { mode: 0o755 });
  const stop = guardOldShimBin(g.bin, g.opts(() => ['s1']));
  try {
    assert.ok(!fs.existsSync(path.join(g.bin, 'gh')), 'the planted gh is not kept');
    assert.ok(g.only(), 'only the daemon\'s shims');
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!fs.existsSync(path.join(g.bin, 'gh')), 'nor written back');
  } finally {
    stop();
    fs.rmSync(g.root, { recursive: true, force: true });
  }
});

test('w6063 probe B: a folder a worker made in the old shims folder before the daemon starts does not strip unity-slot or ff-pr', notWin, async () => {
  const g = guardRoot();
  fs.mkdirSync(path.join(g.bin, 'x'));
  const stop = guardOldShimBin(g.bin, g.opts(() => ['s1']));
  try {
    assert.ok(g.runs('unity-slot') && g.runs('ff-pr'), 'those agents still find unity-slot and ff-pr');
    fs.writeFileSync(path.join(g.root, 'unity-slots', 'req-1'), '');
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(g.only(), 'and still do after the guard has run again');
    assert.doesNotMatch(g.lines.join('\n'), /could not write the old shims folder/);
  } finally {
    stop();
    fs.rmSync(g.root, { recursive: true, force: true });
  }
});

test('w6063 probe C: the old shims folder swapped for a link while the guard mends it deletes nothing behind the link', notWin, () => {
  const g = guardRoot();
  const victim = path.join(g.root, 'sandboxes', 'victim');
  fs.mkdirSync(path.join(victim, 'precious'), { recursive: true });
  fs.writeFileSync(path.join(victim, 'precious', 'work.txt'), 'keep');
  fs.writeFileSync(path.join(g.bin, 'gh'), 'planted');
  // A worker's swap timed exactly between the guard's look at the folder and what it does next.
  const real = fs.lstatSync;
  let swapped = false;
  (fs as { lstatSync: unknown }).lstatSync = (p: fs.PathLike, ...rest: unknown[]) => {
    const st = (real as (...a: unknown[]) => fs.Stats)(p, ...rest);
    if (!swapped && String(p) === g.bin && st?.isDirectory()) {
      swapped = true;
      fs.renameSync(g.bin, `${g.bin}.away`);
      fs.symlinkSync(victim, g.bin);
    }
    return st;
  };
  let stop = () => undefined as void;
  try {
    stop = guardOldShimBin(g.bin, g.opts(() => ['s1'], 60_000));
  } catch {
    // The guard may refuse; it must not delete.
  } finally {
    (fs as { lstatSync: unknown }).lstatSync = real;
  }
  try {
    assert.ok(swapped, 'the swap happened');
    assert.equal(fs.readFileSync(path.join(victim, 'precious', 'work.txt'), 'utf8'), 'keep', 'nothing behind the link is deleted');
  } finally {
    stop();
    fs.rmSync(g.root, { recursive: true, force: true });
  }
});

// w6074 (the re-review): chmod, which Landlock does not refuse. Root ignores modes, so these say nothing run as root.
const asRoot = process.getuid?.() === 0;
const notWinNorRoot = { skip: (process.platform === 'win32' && 'the path fence is off on Windows') || (asRoot && 'root ignores file modes') };

test('w6074 probe P9 (D): a folder a worker put at the old bin and chmod 555 is still taken out, and the link made again', notWinNorRoot, async () => {
  const g = guardRoot();
  fs.writeFileSync(path.join(g.bin, 'ff-pr'), '#!/bin/sh\necho planted\n', { mode: 0o755 });
  fs.mkdirSync(path.join(g.bin, 'deep'));
  fs.writeFileSync(path.join(g.bin, 'deep', 'f'), 'x');
  fs.chmodSync(path.join(g.bin, 'deep'), 0o555);
  fs.chmodSync(g.bin, 0o555);
  const stop = guardOldShimBin(g.bin, g.opts(() => ['s1']));
  try {
    assert.ok(g.only(), 'those agents run the daemon\'s ff-pr, not the planted one');
    assert.deepEqual(fs.readdirSync(shimQuarantineDir(g.root)), [], 'and the 555 folders inside are removed too');
    fs.rmSync(g.bin);
    fs.mkdirSync(g.bin);
    fs.writeFileSync(path.join(g.bin, 'ff-pr'), '#!/bin/sh\necho planted\n', { mode: 0o755 });
    fs.chmodSync(g.bin, 0o555);
    assert.ok(await waitFor(g.only), 'while the guard runs as well');
  } finally {
    stop();
    for (const p of [g.bin, path.join(g.bin, 'deep')]) if (lstatOrUndefined(p)?.isDirectory()) fs.chmodSync(p, 0o755);
    fs.rmSync(g.root, { recursive: true, force: true });
  }
});

test('w6074 probe P11 (D): a mend that keeps failing logs once an hour, not once per try', notWin, async () => {
  const g = guardRoot();
  const real = fs.renameSync;
  // Every rename of bin refused with a message that names a new path each time, as the kernel's does.
  let tries = 0;
  (fs as { renameSync: unknown }).renameSync = (a: fs.PathLike, b: fs.PathLike) => {
    if (String(a) !== g.bin) return real(a, b);
    tries++;
    throw Object.assign(new Error(`EACCES: permission denied, rename '${String(a)}' -> '${String(b)}'`), { code: 'EACCES' });
  };
  const stop = guardOldShimBin(g.bin, g.opts(() => ['s1'], 20));
  try {
    for (let i = 0; i < 30; i++) {
      fs.writeFileSync(path.join(g.root, 'unity-slots', `req-${i}`), '');
      fs.rmSync(path.join(g.root, 'unity-slots', `req-${i}`));
      await new Promise((r) => setTimeout(r, 10));
    }
    await waitFor(() => tries > 20);
    const notMended = g.lines.filter((l) => /not mended/.test(l));
    assert.ok(tries > 20, `the guard kept trying (${tries})`);
    assert.equal(notMended.length, 1, `one line, not one per try: ${notMended.length}`);
    assert.match(notMended[0], /not mended: EACCES/);
  } finally {
    stop();
    (fs as { renameSync: unknown }).renameSync = real;
    fs.rmSync(g.root, { recursive: true, force: true });
  }
});

test('w6074 probe P10 (E): a worker\'s chmod in <root>/tools-medium/shims does not stop the daemon writing its shims at start', notWinNorRoot, () => {
  const g = guardRoot();
  try {
    fs.writeFileSync(path.join(g.target, 'unity-slot.cmd'), 'x');
    fs.chmodSync(path.join(g.target, 'ff-pr'), 0o000);
    fs.chmodSync(path.join(g.target, 'unity-slot.cmd'), 0o000);
    fs.chmodSync(g.target, 0o500);
    readyShimDir(g.target);
    assert.equal(fs.statSync(g.target).mode & 0o777, 0o755, 'the folder');
    writeShims(g.target);
    fs.writeFileSync(path.join(g.target, 'ff-pr'), SHIM);
    assert.equal(fs.statSync(path.join(g.target, 'unity-slot')).mode & 0o777, 0o755, 'writeShims wrote unity-slot');
  } finally {
    if (lstatOrUndefined(g.target)) fs.chmodSync(g.target, 0o755);
    fs.rmSync(g.root, { recursive: true, force: true });
  }
});

test('w6074 probe P10 (E): while the daemon runs, a worker\'s chmod of a shim or of the shims folder is put back', notWinNorRoot, async () => {
  const g = guardRoot();
  const ffPr = path.join(g.target, 'ff-pr');
  const stop = guardShimModes(g.target, { log: (l) => g.lines.push(l), everyMs: 100 });
  try {
    fs.chmodSync(ffPr, 0o000);
    assert.ok(await waitFor(() => (fs.statSync(ffPr).mode & 0o777) === 0o755), 'ff-pr runs again');
    fs.chmodSync(g.target, 0o500);
    assert.ok(await waitFor(() => (fs.statSync(g.target).mode & 0o777) === 0o755), 'the folder is the daemon\'s to write again');
    assert.match(g.lines.join('\n'), /put back the mode the daemon gave in the shims folder/);
    for (let i = 0; i < 20; i++) {
      fs.chmodSync(ffPr, 0o000);
      await waitFor(() => (fs.statSync(ffPr).mode & 0o777) === 0o755);
    }
    assert.ok(g.lines.filter((l) => l.includes(ffPr)).length === 1, 'once an hour per name');
  } finally {
    stop();
    fs.chmodSync(g.target, 0o755);
    fs.rmSync(g.root, { recursive: true, force: true });
  }
});

const lstatOrUndefined = (p: string) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return undefined;
  }
};

test('live w5899 enforce: an extra writable folder over the root does not open <root>/tools-medium/shims', { skip: !landlock && 'needs Linux with Landlock' }, () => {
  const root = fakeRoot();
  const dir = enforcedShimDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const shim = path.join(dir, 'unity-slot');
  fs.writeFileSync(shim, '#!/bin/sh\necho real\n', { mode: 0o755 });
  try {
    const args = [...writeLockArgs({ root, appDir: path.join(root, 'daemon'), unitySlots: path.join(root, 'unity-slots'), extra: [root, path.join(root, 'tools-medium')] }), ...readLockArgs({ root })];
    const run = (script: string) => spawnSync('python3', [FF_LANDLOCK, ...args, '--', 'sh', '-c', script], { encoding: 'utf8' });
    const r = run(`echo planted > ${JSON.stringify(shim)}`);
    assert.notEqual(r.status, 0, 'the write is refused');
    assert.equal(fs.readFileSync(shim, 'utf8'), '#!/bin/sh\necho real\n');
    assert.equal(run(`PATH=${JSON.stringify(dir)}:$PATH; unity-slot`).stdout.trim(), 'real', 'and it runs from PATH');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
