import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FF_LANDLOCK, writeLockArgs } from '../machine/writeLock.ts';
import { WORKER_CHILDREN } from '../machine/lowIntegrity.ts';

// w5333: the Linux write lock's rules (machine/writeLock.ts) and, where the kernel has Landlock, that the launcher refuses.

test('a locked worker writes only the root folders workers write, and the few measured paths (w5569)', () => {
  const root = path.resolve('/home/u/ffw');
  const a = writeLockArgs({ root, appDir: path.join(root, 'daemon'), maxEventsFile: path.join(root, 'daemon', 'max-events.jsonl'), unitySlots: '/home/u/.ff-factory/unity-slots', runtimeDir: '/run/user/1000', home: '/home/u' });
  assert.deepEqual(a, [
    '--rw', '/dev', '--rw', '/proc',
    ...[...WORKER_CHILDREN].sort().flatMap((c) => ['--rw', path.join(root, c)]),
    '--rw', path.join(root, 'daemon', 'max-events.jsonl'),
    '--rw', '/home/u/.ff-factory/unity-slots',
    '--sock', path.join('/run/user/1000', 'cc-socks'),
    '--rw', path.join('/home/u', '.config', 'unity3d'), '--rw', path.join('/home/u', '.local', 'share', 'unity3d'),
    '--rw', '/tmp',
  ]);
  assert.ok(!a.includes('--rw-children'), 'no blanket grant of the root');
  for (const c of ['daemon', 'secrets', 'instances', 'demos', 'ben-factory', 'ffu-runners']) assert.ok(!a.includes(path.join(root, c)), c);
});

test('a temp or sandboxes folder the config puts in another root folder opens that folder; never daemon or secrets (w5569)', () => {
  const root = path.resolve('/r');
  const a = writeLockArgs({ root, workFolders: [path.join(root, 'work', 'temp'), path.join(root, 'secrets', 'x'), '/elsewhere/sb', undefined] });
  assert.ok(a.includes(path.join(root, 'work')));
  assert.ok(!a.includes(path.join(root, 'secrets')));
  assert.ok(!a.includes('/elsewhere/sb') && !a.includes(path.resolve('/elsewhere')));
  assert.ok(!writeLockArgs({ root, appDir: path.join(root, 'app'), workFolders: [path.join(root, 'app', 't')] }).includes(path.join(root, 'app')), 'the daemon folder stays shut');
});

test('a daemon folder of another name inside the root is locked too; one outside it is simply not granted', () => {
  assert.ok(!writeLockArgs({ root: '/r', appDir: '/home/u/.ff-factory' }).includes('/home/u/.ff-factory'));
  assert.deepEqual(writeLockArgs({ root: '/r', extraRoots: ['/v/sandboxes'], extra: ['/x'] }).slice(-4), ['--rw', '/v/sandboxes', '--rw', '/x']);
});

const landlock = process.platform === 'linux' && spawnSync('python3', [FF_LANDLOCK, '--', 'true']).status === 0;

test('ff-landlock.py refuses writes outside the granted folders, in the locked child folders and in renames of them', { skip: !landlock && 'needs Linux with Landlock' }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'w5333-'));
  try {
    for (const d of ['root/daemon', 'root/secrets', 'root/tmp', 'root/sandboxes', 'root/instances', 'root/ben-factory', 'outside']) fs.mkdirSync(path.join(base, d), { recursive: true });
    fs.writeFileSync(path.join(base, 'root/daemon/max-events.jsonl'), '');
    const script = [
      'try() { if eval "$2" 2>/dev/null; then echo "$1 ok"; else echo "$1 refused"; fi; }',
      `try tmp "touch ${base}/root/tmp/x"`,
      `try outside "touch ${base}/outside/x"`,
      `try sandboxes "touch ${base}/root/sandboxes/x"`,
      `try instances "touch ${base}/root/instances/update-all.ts"`,
      `try portal "touch ${base}/root/ben-factory/x"`,
      `try daemon "touch ${base}/root/daemon/x"`,
      `try secrets "touch ${base}/root/secrets/x"`,
      `try newtop "mkdir ${base}/root/new"`,
      `try rename "mv ${base}/root/daemon ${base}/root/tmp/d"`,
      `try events "echo '{}' >> ${base}/root/daemon/max-events.jsonl"`,
      `try newfile-beside-events "touch ${base}/root/daemon/other.jsonl"`,
    ].join('\n');
    const args = writeLockArgs({ root: path.join(base, 'root'), maxEventsFile: path.join(base, 'root/daemon/max-events.jsonl') });
    const r = spawnSync('python3', [FF_LANDLOCK, ...args, '--', 'bash', '-c', script], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split('\n'), [
      'tmp ok', 'outside refused', 'sandboxes ok', 'instances refused', 'portal refused', 'daemon refused', 'secrets refused', 'newtop refused', 'rename refused', 'events ok', 'newfile-beside-events refused',
    ]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
