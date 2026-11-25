import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
    '--deny-unix', path.join('/run/user/1000', 'bus'), '--deny-unix', path.join('/run/user/1000', 'systemd'),
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
    for (const d of ['root/daemon', 'root/secrets', 'root/tmp', 'root/sandboxes', 'root/instances', 'root/ben-factory', 'root/claude', 'root/claude-medium', 'root/cache-medium/uv', 'root/cache/uv', 'outside']) fs.mkdirSync(path.join(base, d), { recursive: true });
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
      'tmp ok', 'outside refused', 'sandboxes ok', 'instances refused', 'portal refused', 'daemon refused', 'secrets refused', 'claude ok', 'claude-medium refused', 'claude-medium-rename refused', 'uv-medium refused', 'uv-workers ok', 'newtop refused', 'rename refused', 'events ok', 'newfile-beside-events refused',
    ]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

const abi = landlock ? Number(spawnSync('python3', [FF_LANDLOCK, '--', 'printenv', 'FF_LANDLOCK_ABI'], { encoding: 'utf8' }).stdout.trim()) : 0;

// w5562. `outside` is a process the test starts itself, outside the lock: it stands for the daemon, Unity, the desktop
// and other workers, which a probe never signals.
test('live w5562: a locked shell signals and kills its own children (job control too) and is refused any other process', { skip: (abi < 6 && `needs Landlock ABI 6 (signal scope); this kernel has ${abi}`) || false }, () => {
  const outside = spawn('sleep', ['120'], { stdio: 'ignore' });
  const twin = spawn('python3', [FF_LANDLOCK, '--', 'sleep', '120'], { stdio: 'ignore' });
  try {
    const script = [
      'set -e', 'kill -0 $$', 'sleep 60 & c=$!', 'kill -0 $c; kill -TERM $c; r=0; wait $c || r=$?; [ "$r" = 143 ]',
      'set -m; sleep 60 & kill %1; wait %1 || true',
      `"${process.execPath}" -e "const c=require('child_process').spawn('sleep',['60']);setTimeout(()=>c.kill('SIGKILL'),200);c.on('exit',(x,s)=>process.exit(s==='SIGKILL'?0:1))"`,
      'set +e', `kill -0 ${outside.pid} 2>/dev/null; echo outside0=$?`, `kill -TERM ${outside.pid} 2>/dev/null; echo outside=$?`, `kill -0 ${twin.pid} 2>/dev/null; echo twin=$?`,
    ].join('\n');
    const r = spawnSync('python3', [FF_LANDLOCK, '--', 'bash', '-c', script], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split('\n'), ['outside0=1', 'outside=1', 'twin=1'], 'every process outside this lock is refused, another lock of the same rules too');
    assert.equal(outside.exitCode, null, 'the outside process still runs');
  } finally {
    outside.kill('SIGKILL');
    twin.kill('SIGKILL');
  }
});

test('live w5562: --deny-unix refuses connecting to a socket made outside the lock, and only there', { skip: (abi < 9 && `needs Landlock ABI 9 (RESOLVE_UNIX); this kernel has ${abi}`) || false }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'w5562-'));
  const serve = (p: string) => spawn('python3', ['-c', `import socket,time;s=socket.socket(socket.AF_UNIX);s.bind(${JSON.stringify(p)});s.listen();time.sleep(60)`], { stdio: 'ignore' });
  fs.mkdirSync(path.join(base, 'run/systemd'), { recursive: true });
  const servers = [serve(path.join(base, 'run/bus')), serve(path.join(base, 'run/systemd/private')), serve(path.join(base, 'run/other'))];
  try {
    const until = Date.now() + 5000;
    while (!['run/bus', 'run/systemd/private', 'run/other'].every((s) => fs.existsSync(path.join(base, s))) && Date.now() < until) spawnSync('sleep', ['0.1']);
    const probe = (p: string) => `python3 -c "import socket;s=socket.socket(socket.AF_UNIX);s.connect(${JSON.stringify(p).replace(/"/g, "'")})" 2>/dev/null && echo ok || echo refused`;
    const own = path.join(base, 'run/own');
    const script = [probe(path.join(base, 'run/bus')), probe(path.join(base, 'run/systemd/private')), probe(path.join(base, 'run/other')), `python3 -c "import socket,time;s=socket.socket(socket.AF_UNIX);s.bind('${own}');s.listen();time.sleep(5)" & sleep 0.5`, probe(own), 'kill %1'].join('\n');
    const r = spawnSync('python3', [FF_LANDLOCK, '--rw', base, '--deny-unix', path.join(base, 'run/bus'), '--deny-unix', path.join(base, 'run/systemd'), '--', 'bash', '-c', script], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split('\n'), ['refused', 'refused', 'ok', 'ok'], 'bus and systemd refused; a sibling and its own socket stay reachable');
  } finally {
    for (const s of servers) s.kill('SIGKILL');
    fs.rmSync(base, { recursive: true, force: true });
  }
});
