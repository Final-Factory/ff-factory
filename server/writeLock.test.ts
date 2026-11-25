import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FF_LANDLOCK, readLockArgs, writeLockArgs } from '../machine/writeLock.ts';

// w5333: the Linux write lock's rules (machine/writeLock.ts) and, where the kernel has Landlock, that the launcher refuses.

test("a locked worker writes every folder of the root but the daemon, secrets and the Medium agents' Claude folder, and the few measured paths", () => {
  const a = writeLockArgs({ root: '/home/u/ffw', appDir: '/home/u/ffw/daemon', maxEventsFile: '/home/u/ffw/daemon/max-events.jsonl', unitySlots: '/home/u/.ff-factory/unity-slots', runtimeDir: '/run/user/1000', home: '/home/u' });
  assert.deepEqual(a, [
    '--rw', '/dev', '--rw', '/proc',
    '--rw-children', '/home/u/ffw', '--except', 'cache-medium', '--except', 'claude-medium', '--except', 'daemon', '--except', 'secrets',
    '--rw', '/home/u/ffw/daemon/max-events.jsonl',
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
    for (const d of ['root/daemon', 'root/secrets', 'root/tmp', 'root/claude', 'root/claude-medium', 'root/cache-medium/uv', 'root/cache/uv', 'outside']) fs.mkdirSync(path.join(base, d), { recursive: true });
    fs.writeFileSync(path.join(base, 'root/daemon/max-events.jsonl'), '');
    const script = [
      'try() { if eval "$2" 2>/dev/null; then echo "$1 ok"; else echo "$1 refused"; fi; }',
      `try tmp "touch ${base}/root/tmp/x"`,
      `try outside "touch ${base}/outside/x"`,
      `try daemon "touch ${base}/root/daemon/x"`,
      `try secrets "touch ${base}/root/secrets/x"`,
      // w5543: the workers' Claude folder is theirs; the Medium agents' one (settings, plugins, hooks) is not
      `try claude "touch ${base}/root/claude/settings.json"`,
      `try claude-medium "touch ${base}/root/claude-medium/settings.json"`,
      `try claude-medium-rename "mv ${base}/root/claude-medium ${base}/root/tmp/cm"`,
      // w5565: the daemon's and Medium agents' uv cache is theirs; the workers' one stays the workers'
      `try uv-medium "touch ${base}/root/cache-medium/uv/x"`,
      `try uv-workers "touch ${base}/root/cache/uv/x"`,
      `try newtop "mkdir ${base}/root/new"`,
      `try rename "mv ${base}/root/daemon ${base}/root/tmp/d"`,
      `try events "echo '{}' >> ${base}/root/daemon/max-events.jsonl"`,
      `try newfile-beside-events "touch ${base}/root/daemon/other.jsonl"`,
    ].join('\n');
    const args = writeLockArgs({ root: path.join(base, 'root'), maxEventsFile: path.join(base, 'root/daemon/max-events.jsonl') });
    const r = spawnSync('python3', [FF_LANDLOCK, ...args, '--', 'bash', '-c', script], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split('\n'), [
      'tmp ok', 'outside refused', 'daemon refused', 'secrets refused', 'claude ok', 'claude-medium refused', 'claude-medium-rename refused', 'uv-medium refused', 'uv-workers ok', 'newtop refused', 'rename refused', 'events ok', 'newfile-beside-events refused',
    ]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('w5546: readLockArgs closes the daemon folder, secrets and root.json, and gives back what workers read there', () => {
  const root = path.resolve('/r');
  const a = readLockArgs({ root, read: [path.join(root, 'daemon/gh-app/sessions/s1.json')] });
  const of = (flag: string) => a.flatMap((x, i) => (a[i - 1] === flag ? [x] : []));
  assert.deepEqual(of('--no-read'), [path.join(root, 'daemon'), path.join(root, 'secrets'), path.join(root, 'root.json')]);
  const back = of('--read');
  for (const x of ['logs', 'src', 'app', 'gh-app/bin', 'unity-mcp', 'sandboxes.json', 'gh-app/sessions/s1.json']) assert.ok(back.includes(path.join(root, 'daemon', x)), x);
  for (const x of back) assert.ok(!/tokens\.json|daemon\.json|hosts|root(-backup)?\.json|secrets/.test(x), `never given back: ${x}`);
  const other = readLockArgs({ root, appDir: '/opt/ffd' });
  assert.ok(other.includes(path.resolve('/opt/ffd')) && other.includes(path.join(path.resolve('/opt/ffd'), 'logs')));
});

test('ff-landlock.py w5546: a locked worker cannot read secrets, root.json or a closed daemon file, and reads the rest', { skip: !landlock && 'needs Linux with Landlock' }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'w5546-'));
  try {
    const root = path.join(base, 'root');
    for (const d of ['daemon/logs', 'daemon/gh-app/sessions', 'secrets', 'tmp']) fs.mkdirSync(path.join(root, d), { recursive: true });
    for (const f of ['secrets/machine-token', 'root.json', 'daemon/daemon.json', 'daemon/gh-app/tokens.json', 'daemon/logs/daemon.log', 'daemon/gh-app/sessions/s1.json', 'daemon/gh-app/sessions/s2.json', 'tmp/mine']) fs.writeFileSync(path.join(root, f), 'x');
    const tries = ['secrets/machine-token', 'root.json', 'daemon/daemon.json', 'daemon/gh-app/tokens.json', 'daemon/gh-app/sessions/s2.json', 'daemon/logs/daemon.log', 'daemon/gh-app/sessions/s1.json', 'tmp/mine'];
    const script = ['try() { if cat "$2" >/dev/null 2>&1; then echo "$1 ok"; else echo "$1 refused"; fi; }', ...tries.map((t) => `try ${t} "${path.join(root, t)}"`), 'try etc /etc/passwd'].join('\n');
    const args = [...writeLockArgs({ root }), ...readLockArgs({ root, read: [path.join(root, 'daemon/gh-app/sessions/s1.json')] })];
    const r = spawnSync('python3', [FF_LANDLOCK, ...args, '--', 'bash', '-c', script], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split('\n'), [...tries.slice(0, 5).map((t) => `${t} refused`), ...tries.slice(5).map((t) => `${t} ok`), 'etc ok']);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
