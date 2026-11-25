import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ownerSocketDenyArgs, ownerSocketPaths, ownerSocketProbeTargets } from '../machine/ownerSecrets.ts';
import { SOCKET_PROBE_SCRIPT, sayOwnerSocketProbe } from '../machine/readFence.ts';
import { FF_LANDLOCK } from '../machine/writeLock.ts';

const landlock = process.platform === 'linux' && spawnSync('python3', [FF_LANDLOCK, '--', 'true']).status === 0;

test('w5748: the owner sockets are the session bus, the keyring folder and the ssh and gpg agents', () => {
  assert.deepEqual(ownerSocketPaths({ runtimeDir: '/run/user/1000', env: { SSH_AUTH_SOCK: '/run/user/1000/gcr/ssh' } }), [
    '/run/user/1000/bus',
    '/run/user/1000/keyring',
    '/run/user/1000/gcr',
    '/run/user/1000/gnupg',
    '/run/user/1000/openssh_agent',
    '/run/user/1000/gcr/ssh',
  ]);
  // An agent outside the runtime folder (ssh -A, a keychain tool) is probed too; no runtime folder, only the agent.
  assert.deepEqual(ownerSocketPaths({ env: { SSH_AUTH_SOCK: '/tmp/ssh-x/agent.1' } }), ['/tmp/ssh-x/agent.1']);
  assert.deepEqual(ownerSocketPaths({ env: {} }), []);
});

test('w5748: sayOwnerSocketProbe names each reachable socket and why, and says so when none were found', () => {
  const socks = ['/r/bus', '/r/gcr/ssh'];
  const open = sayOwnerSocketProbe('warn', socks, 'abi 8\n1 ok\n0 ok\n');
  assert.deepEqual(open.open, socks);
  assert.match(open.line, /0\/2 refused \(Landlock ABI 8\); reachable from a fenced run: \/r\/bus, \/r\/gcr\/ssh \(Landlock ABI 8: refusing a socket's connect needs ABI 9/);
  const shut = sayOwnerSocketProbe('on', socks, 'abi 9\n0 refused\n1 refused\n');
  assert.deepEqual(shut.open, []);
  assert.equal(shut.line, 'read fence (on, linux) owner sockets: 2/2 refused (Landlock ABI 9)');
  // No answer for one is not a pass: it counts as reachable, as the file probe's "could not judge".
  assert.deepEqual(sayOwnerSocketProbe('warn', socks, 'abi 9\n0 refused\n').open, ['/r/gcr/ssh (no answer)']);
  assert.match(sayOwnerSocketProbe('warn', [], 'abi 8\n').line, /none found to probe \(Landlock ABI 8\)/);
});

test('live w5748: the probe connects to listening sockets only, sending nothing, and says the ABI under ff-landlock.py', { skip: !landlock && 'needs Linux with Landlock' }, (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'w5748-'));
  const servers: ReturnType<typeof spawn>[] = [];
  t.after(() => {
    for (const s of servers) s.kill('SIGKILL');
    fs.rmSync(base, { recursive: true, force: true });
  });
  // A server that prints any byte it is sent: the probe must send none.
  const serve = (p: string) => {
    const c = spawn('python3', ['-c', `import socket,sys\ns=socket.socket(socket.AF_UNIX);s.bind(${JSON.stringify(p)});s.listen()\nwhile True:\n  c,_=s.accept();d=c.recv(64);sys.stdout.write(repr(d)+'\\n');sys.stdout.flush();c.close()`], { stdio: ['ignore', 'pipe', 'ignore'] });
    servers.push(c);
    return c;
  };
  fs.mkdirSync(path.join(base, 'gnupg'));
  const got: string[] = [];
  serve(path.join(base, 'bus')).stdout!.on('data', (d) => got.push(String(d)));
  serve(path.join(base, 'gnupg', 'S.gpg-agent')).stdout!.on('data', (d) => got.push(String(d)));
  fs.writeFileSync(path.join(base, 'gnupg', 'not-a-socket'), '');
  const until = Date.now() + 5000;
  while (!(fs.existsSync(path.join(base, 'bus')) && fs.existsSync(path.join(base, 'gnupg', 'S.gpg-agent'))) && Date.now() < until) spawnSync('sleep', ['0.1']);
  const socks = ownerSocketProbeTargets([path.join(base, 'bus'), path.join(base, 'gnupg'), path.join(base, 'missing')]);
  assert.deepEqual(socks, [path.join(base, 'bus'), path.join(base, 'gnupg', 'S.gpg-agent')], 'sockets only, a folder by the sockets in it');
  const r = spawnSync('python3', [FF_LANDLOCK, '--rw', base, '--', process.execPath, '-e', SOCKET_PROBE_SCRIPT, ...socks, path.join(base, 'gone')], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.match(lines[0], /^abi \d+$/);
  assert.deepEqual(lines.slice(1).sort(), ['0 ok', '1 ok', '2 ENOENT']);
  spawnSync('sleep', ['0.3']);
  assert.ok(got.every((g) => g.trim() === "b''"), `the servers read nothing but the close: ${got.join(' ')}`);
});

test('w5748 enforce: a run in on mode denies the owner sockets in the runtime folder, never an agent elsewhere', () => {
  assert.deepEqual(ownerSocketDenyArgs('/run/user/1000'), ['--deny-unix', '/run/user/1000/bus', '--deny-unix', '/run/user/1000/keyring', '--deny-unix', '/run/user/1000/gcr', '--deny-unix', '/run/user/1000/gnupg', '--deny-unix', '/run/user/1000/openssh_agent']);
  assert.deepEqual(ownerSocketDenyArgs(undefined), []);
});

const abi = landlock ? Number(spawnSync('python3', [FF_LANDLOCK, '--', 'printenv', 'FF_LANDLOCK_ABI'], { encoding: 'utf8' }).stdout.trim()) : 0;

test('live w5748 enforce: the owner-socket denies refuse the bus, keyring and agents, and only those', { skip: (abi < 9 && `needs Landlock ABI 9 (RESOLVE_UNIX); this kernel has ${abi}`) || false }, (t) => {
  const run = fs.mkdtempSync(path.join(os.tmpdir(), 'w5748e-'));
  const servers: ReturnType<typeof spawn>[] = [];
  t.after(() => {
    for (const s of servers) s.kill('SIGKILL');
    fs.rmSync(run, { recursive: true, force: true });
  });
  for (const d of ['keyring', 'gcr', 'gnupg']) fs.mkdirSync(path.join(run, d));
  const socks = ['bus', 'keyring/control', 'gcr/ssh', 'gnupg/S.gpg-agent', 'openssh_agent', 'pipewire-0'].map((s) => path.join(run, s));
  for (const p of socks) servers.push(spawn('python3', ['-c', `import socket,time;s=socket.socket(socket.AF_UNIX);s.bind(${JSON.stringify(p)});s.listen();time.sleep(60)`], { stdio: 'ignore' }));
  const until = Date.now() + 5000;
  while (!socks.every((p) => fs.existsSync(p)) && Date.now() < until) spawnSync('sleep', ['0.1']);
  const r = spawnSync('python3', [FF_LANDLOCK, '--rw', run, ...ownerSocketDenyArgs(run), '--', process.execPath, '-e', SOCKET_PROBE_SCRIPT, ...socks], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n').slice(1).sort(), ['0 refused', '1 refused', '2 refused', '3 refused', '4 refused', '5 ok'], 'a socket workers use (audio) stays reachable');
});
