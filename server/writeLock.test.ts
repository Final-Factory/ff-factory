import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FF_LANDLOCK, writeLockArgs } from '../machine/writeLock.ts';
import { maxProbeArgv, probeMaxEvents } from '../machine/maxEventsFence.ts';

// w5333: the Linux write lock's rules (machine/writeLock.ts) and, where the kernel has Landlock, that the launcher refuses.

test('a locked worker writes every folder of the root but the daemon and secrets, and the few measured paths', () => {
  const a = writeLockArgs({ root: '/home/u/ffw', appDir: '/home/u/ffw/daemon', unitySlots: '/home/u/.ff-factory/unity-slots', runtimeDir: '/run/user/1000', home: '/home/u' });
  // w5552: no rule for the Max events file: it is the daemon's (<daemon>/max/max-events.jsonl), read-only like its folder.
  assert.deepEqual(a, [
    '--rw', '/dev', '--rw', '/proc',
    '--rw-children', '/home/u/ffw', '--except', 'daemon', '--except', 'secrets',
    '--rw', '/home/u/.ff-factory/unity-slots',
    '--sock', '/run/user/1000/cc-socks',
    '--rw', '/home/u/.config/unity3d', '--rw', '/home/u/.local/share/unity3d',
    '--rw', '/tmp',
  ]);
});

test('a daemon folder of another name inside the root is locked too; one outside it is simply not granted', () => {
  assert.ok(writeLockArgs({ root: '/r', appDir: '/r/app' }).join(' ').includes('--except app'));
  assert.ok(!writeLockArgs({ root: '/r', appDir: '/home/u/.ff-factory' }).includes('/home/u/.ff-factory'));
  assert.deepEqual(writeLockArgs({ root: '/r', extraRoots: ['/v/sandboxes'], extra: ['/x'] }).slice(-4), ['--rw', '/v/sandboxes', '--rw', '/x']);
});

const landlock = process.platform === 'linux' && spawnSync('python3', [FF_LANDLOCK, '--', 'true']).status === 0;

test('ff-landlock.py refuses writes outside the granted folders, in the locked child folders and in renames of them', { skip: !landlock && 'needs Linux with Landlock' }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'w5333-'));
  try {
    for (const d of ['root/daemon', 'root/secrets', 'root/tmp', 'outside']) fs.mkdirSync(path.join(base, d), { recursive: true });
    fs.mkdirSync(path.join(base, 'root/daemon/max'), { recursive: true });
    fs.writeFileSync(path.join(base, 'root/daemon/max/max-events.jsonl'), '');
    const script = [
      'try() { if eval "$2" 2>/dev/null; then echo "$1 ok"; else echo "$1 refused"; fi; }',
      `try tmp "touch ${base}/root/tmp/x"`,
      `try outside "touch ${base}/outside/x"`,
      `try daemon "touch ${base}/root/daemon/x"`,
      `try secrets "touch ${base}/root/secrets/x"`,
      `try newtop "mkdir ${base}/root/new"`,
      `try rename "mv ${base}/root/daemon ${base}/root/tmp/d"`,
      `try events "echo '{}' >> ${base}/root/daemon/max/max-events.jsonl"`,
      `try newfile-beside-events "touch ${base}/root/daemon/max/other.jsonl"`,
    ].join('\n');
    const args = writeLockArgs({ root: path.join(base, 'root') });
    const r = spawnSync('python3', [FF_LANDLOCK, ...args, '--', 'bash', '-c', script], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    // w5552: the Max events file is refused like the rest of the daemon's folder.
    assert.deepEqual(r.stdout.trim().split('\n'), [
      'tmp ok', 'outside refused', 'daemon refused', 'secrets refused', 'newtop refused', 'rename refused', 'events refused', 'newfile-beside-events refused',
    ]);
    // The daemon's own check (machine/maxEventsFence.ts) says the same, and an unfenced shell writes it.
    const file = path.join(base, 'root/daemon/max/max-events.jsonl');
    assert.equal(probeMaxEvents('landlock', ['python3', FF_LANDLOCK, ...args, '--', ...maxProbeArgv('/bin/sh', file)], file).refused, true);
    assert.equal(probeMaxEvents('none', maxProbeArgv('/bin/sh', file), file).refused, false);
    assert.equal(fs.readFileSync(file, 'utf8'), '', 'the check writes nothing');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
