import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FF_LANDLOCK, LOCKED_CHILDREN, makeDotnetShm, makeOpenRootChildren, readLockArgs, writeLockArgs } from '../machine/writeLock.ts';
import { WORKER_CHILDREN, openChildren } from '../machine/lowIntegrity.ts';
import { maxProbeArgv, probeMaxEvents } from '../machine/maxEventsFence.ts';

// w5333: the Linux write lock's rules (machine/writeLock.ts) and, where the kernel has Landlock, that the launcher refuses.

test('a locked worker writes only the root folders workers write, and the few measured paths (w5569)', () => {
  const root = path.resolve('/home/u/ffw');
  const a = writeLockArgs({ root, appDir: path.join(root, 'daemon'), unitySlots: '/home/u/.ff-factory/unity-slots', runtimeDir: '/run/user/1000', home: '/home/u' });
  // w5552: no rule for the Max events file: it is the daemon's (<daemon>/max/max-events.jsonl), read-only like its folder.
  assert.deepEqual(a, [
    '--rw', '/dev', '--rw', '/proc',
    ...[...WORKER_CHILDREN].sort().flatMap((c) => ['--rw', path.join(root, c)]),
    '--rw', '/home/u/.ff-factory/unity-slots',
    '--sock', path.join('/run/user/1000', 'cc-socks'),
    '--deny-unix', path.join('/run/user/1000', 'bus'), '--deny-unix', path.join('/run/user/1000', 'systemd'),
    '--rw', path.join('/home/u', '.config', 'unity3d'), '--rw', path.join('/home/u', '.local', 'share', 'unity3d'),
    '--create', '/tmp', '--rw', path.join('/tmp', '.dotnet'),
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
    fs.mkdirSync(path.join(base, 'root/daemon/max'), { recursive: true });
    fs.writeFileSync(path.join(base, 'root/daemon/max/max-events.jsonl'), '');
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
      `try events "echo '{}' >> ${base}/root/daemon/max/max-events.jsonl"`,
      `try newfile-beside-events "touch ${base}/root/daemon/max/other.jsonl"`,
    ].join('\n');
    const args = writeLockArgs({ root: path.join(base, 'root') });
    const r = spawnSync('python3', [FF_LANDLOCK, ...args, '--', 'bash', '-c', script], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    // w5552: the Max events file is refused like the rest of the daemon's folder.
    assert.deepEqual(r.stdout.trim().split('\n'), [
      'tmp ok', 'outside refused', 'sandboxes ok', 'instances refused', 'portal refused', 'daemon refused', 'secrets refused', 'claude ok', 'claude-medium refused', 'claude-medium-rename refused', 'uv-medium refused', 'uv-workers ok', 'newtop refused', 'rename refused', 'events refused', 'newfile-beside-events refused',
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

test('w5546: readLockArgs closes the daemon folder, secrets and root.json, and gives back what workers read there', () => {
  const root = path.resolve('/r');
  const a = readLockArgs({ root, read: [path.join(root, 'daemon/gh-app/sessions/s1')] });
  const of = (flag: string) => a.flatMap((x, i) => (a[i - 1] === flag ? [x] : []));
  assert.deepEqual(of('--no-read'), [path.join(root, 'daemon'), path.join(root, 'secrets'), path.join(root, 'root.json'), path.join(root, 'steam')], 'steam: w5639');
  const back = of('--read');
  for (const x of ['logs', 'src', 'app', 'gh-app/bin', 'unity-mcp', 'sandboxes.json', 'gh-app/sessions/s1']) assert.ok(back.includes(path.join(root, 'daemon', x)), x);
  for (const x of back) assert.ok(!/tokens\.json|daemon\.json|hosts|root(-backup)?\.json|secrets/.test(x), `never given back: ${x}`);
  const other = readLockArgs({ root, appDir: '/opt/ffd' });
  assert.ok(other.includes(path.resolve('/opt/ffd')) && other.includes(path.join(path.resolve('/opt/ffd'), 'logs')));
});

test('ff-landlock.py w5546: a locked worker cannot read secrets, root.json, steam or a closed daemon file, and reads the rest', { skip: !landlock && 'needs Linux with Landlock' }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'w5546-'));
  try {
    const root = path.join(base, 'root');
    for (const d of ['daemon/logs', 'daemon/gh-app/sessions/s1', 'daemon/gh-app/sessions/s2', 'secrets', 'steam', 'steam-lobby-gate', 'tmp']) fs.mkdirSync(path.join(root, d), { recursive: true });
    for (const f of ['secrets/machine-token', 'root.json', 'daemon/daemon.json', 'daemon/gh-app/tokens.json', 'daemon/logs/daemon.log', 'daemon/gh-app/sessions/s1/tokens.json', 'daemon/gh-app/sessions/s2/tokens.json', 'steam/config.json', 'steam-lobby-gate/gate.json', 'tmp/mine']) fs.writeFileSync(path.join(root, f), 'x');
    // w5639: steam's config.json (steamcmd's cached login sits beside it) is refused; the lobby gate's folder is not.
    const tries = ['secrets/machine-token', 'root.json', 'daemon/daemon.json', 'daemon/gh-app/tokens.json', 'daemon/gh-app/sessions/s2/tokens.json', 'steam/config.json', 'daemon/logs/daemon.log', 'daemon/gh-app/sessions/s1/tokens.json', 'steam-lobby-gate/gate.json', 'tmp/mine'];
    const script = ['try() { if cat "$2" >/dev/null 2>&1; then echo "$1 ok"; else echo "$1 refused"; fi; }', ...tries.map((t) => `try ${t} "${path.join(root, t)}"`), `if ls "${path.join(root, 'steam')}" >/dev/null 2>&1; then echo 'ls-steam ok'; else echo 'ls-steam refused'; fi`, 'try etc /etc/passwd'].join('\n');
    const args = [...writeLockArgs({ root }), ...readLockArgs({ root, read: [path.join(root, 'daemon/gh-app/sessions/s1')] })];
    const r = spawnSync('python3', [FF_LANDLOCK, ...args, '--', 'bash', '-c', script], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split('\n'), [...tries.slice(0, 6).map((t) => `${t} refused`), ...tries.slice(6).map((t) => `${t} ok`), 'ls-steam refused', 'etc ok']);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// w5561: Unity binds its sockets and makes its shader compiler's lock in /tmp whatever TMPDIR says, so /tmp is
// create-only: a worker makes files and sockets there and removes them, and never changes a file it did not make.
test("ff-landlock.py's create-only /tmp: new files, locks and sockets, never a write, a folder or a link; .dotnet writable", { skip: !landlock && 'needs Linux with Landlock' }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'w5561-'));
  try {
    const tmp = path.join(base, 'systmp');
    fs.mkdirSync(path.join(base, 'root'), { recursive: true });
    fs.mkdirSync(tmp);
    fs.writeFileSync(path.join(tmp, 'owners'), 'mine\n');
    makeDotnetShm(path.join(tmp, '.dotnet'));
    assert.equal(fs.statSync(path.join(tmp, '.dotnet/shm')).mode & 0o7777, 0o1777);
    // Unity's two kinds of /tmp file: its shader compiler's lock (O_RDONLY|O_CREAT, flock) and its IPC sockets
    fs.writeFileSync(path.join(base, 'lock.py'), "import os,sys,fcntl\nf=os.open(sys.argv[1],os.O_RDONLY|os.O_CREAT,0o600)\nfcntl.flock(f,fcntl.LOCK_EX)\nos.unlink(sys.argv[1])\n");
    fs.writeFileSync(path.join(base, 'sock.py'), "import os,sys,socket\ns=socket.socket(socket.AF_UNIX)\ns.bind(sys.argv[1])\ns.listen()\nos.unlink(sys.argv[1])\n");
    const script = [
      'try() { if eval "$2" 2>/dev/null; then echo "$1 ok"; else echo "$1 refused"; fi; }',
      `try write "echo x > ${tmp}/owners"`,
      `try append "echo x >> ${tmp}/owners"`,
      `try truncate "truncate -s 0 ${tmp}/owners"`,
      `try mkdir "mkdir ${tmp}/d"`,
      `try symlink "ln -s ${tmp}/owners ${tmp}/l"`,
      `try lock "python3 ${base}/lock.py ${tmp}/x.lock"`,
      `try socket "python3 ${base}/sock.py ${tmp}/x.sock"`,
      `try dotnet "mkdir ${tmp}/.dotnet/shm/session1 && echo x > ${tmp}/.dotnet/shm/session1/f && rm -r ${tmp}/.dotnet/shm/session1"`,
    ].join('\n');
    const args = writeLockArgs({ root: path.join(base, 'root'), home: path.join(base, 'home'), tmp });
    const r = spawnSync('python3', [FF_LANDLOCK, ...args, '--', 'bash', '-c', script], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split('\n'), ['write refused', 'append refused', 'truncate refused', 'mkdir refused', 'symlink refused', 'lock ok', 'socket ok', 'dotnet ok']);
    assert.equal(fs.readFileSync(path.join(tmp, 'owners'), 'utf8'), 'mine\n', "the person's file is unchanged");
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

test('w5676: on a fresh root the daemon makes every open root folder before a locked worker starts; never a locked one, nothing outside', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'w5676-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'ffw');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'daemon'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tmp'));
  // A daemon.json extra naming a locked folder must not make it either.
  const args = writeLockArgs({ root, extra: [outside, path.join(root, 'secrets')] });
  const made = makeOpenRootChildren(root, args, path.join(root, 'daemon'), [path.join(root, 'sandboxes')]);
  const open = openChildren(root, [], LOCKED_CHILDREN);
  assert.deepEqual(made.map((m) => path.basename(m)).sort(), open.filter((c) => c !== 'tmp' && c !== 'sandboxes'), 'every missing open folder, and only those');
  for (const c of open.filter((c) => c !== 'sandboxes')) assert.ok(fs.statSync(path.join(root, c)).isDirectory(), c);
  assert.ok(!fs.existsSync(path.join(root, 'sandboxes')), 'the sandboxes folder is never made: its absence means a drive gone');
  for (const c of LOCKED_CHILDREN) if (c !== 'daemon') assert.ok(!fs.existsSync(path.join(root, c)), `${c} is not made`);
  assert.ok(!fs.existsSync(outside), 'a rule outside the root makes nothing');
  assert.deepEqual(makeOpenRootChildren(root, args, path.join(root, 'daemon'), [path.join(root, 'sandboxes')]), [], 'a second start makes nothing');
});

test('live w5676: a locked worker writes in an open root folder the daemon made, and could not before', { skip: !landlock && 'needs Linux with Landlock' }, (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'w5676-live-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'ffw');
  fs.mkdirSync(path.join(root, 'daemon'), { recursive: true });
  const args = writeLockArgs({ root });
  const write = () => spawnSync('python3', [FF_LANDLOCK, ...args, '--', 'bash', '-c', `mkdir -p ${JSON.stringify(path.join(root, 'voice'))} && touch ${JSON.stringify(path.join(root, 'voice', 'x'))}`], { encoding: 'utf8' });
  assert.notEqual(write().status, 0, 'missing at start: the rule is skipped and the root is read-only');
  makeOpenRootChildren(root, args, path.join(root, 'daemon'));
  const r = write();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(root, 'voice', 'x')));
  assert.notEqual(spawnSync('python3', [FF_LANDLOCK, ...args, '--', 'touch', path.join(root, 'daemon', 'x')]).status, 0, 'daemon stays locked');
});
