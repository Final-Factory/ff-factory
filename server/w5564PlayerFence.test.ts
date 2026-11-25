// w5564 (rogue-worker audit w5451, item 33): the players the daemon starts run fenced on Linux and macOS. A timed run's
// player is a file in a folder fenced workers write, so started as the daemon's plain child a swapped one would write
// anywhere; it now starts under ff-landlock.py (Linux) or sandbox-exec (macOS), writing only its run and build folders and
// the game's data root and player home inside the worker root, and a leg is refused when the fence cannot run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fencedPlayer, playerFenceFor, playerLandlockArgs, playerSeatbeltProfile, playerWritable, type PlayerFence } from '../machine/playerFence.ts';
import { TimedRunner, type RunTicket } from '../machine/timedRunner.ts';
import { hashVariant, scanBuild } from '../machine/timedRunPack.ts';
import { FF_LANDLOCK } from '../machine/writeLock.ts';
import { SANDBOX_EXEC } from './workerFence.ts';
import type { TicketState } from '../machine/benchQueue.ts';
import { TIMED_DEFAULTS, type TimedRunOrder, type TimedRunReport } from '../shared/timedRun.ts';

const tmp = (t: { after(fn: () => void): void }, tag: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), tag));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

test('w5564: a player writes its run and build folders and the data root and player home, only inside the root', () => {
  const env = { FF_GAME_DATA_DIR: '/r/gamedata', FF_PLAYER_HOME: '/r/gamedata-home' };
  assert.deepEqual(playerWritable({ root: '/r', runDir: '/r/timing/runs/tr_1', buildDir: '/r/players/slot1-0/player', env }), [
    '/r/timing/runs/tr_1', '/r/players/slot1-0/player', '/r/gamedata', '/r/gamedata-home',
  ]);
  // a data root outside the root (a person's own, an older build's legacy root), the root itself, the daemon and secrets: never
  assert.deepEqual(playerWritable({ root: '/r', runDir: '/r/timing/runs/tr_1', buildDir: '/r', env: { FF_GAME_DATA_DIR: '/home/u/.config/unity3d/Never Games/finalfactory', FF_PLAYER_HOME: '/r/secrets/x' } }), ['/r/timing/runs/tr_1']);
  assert.deepEqual(playerWritable({ root: '/r', runDir: '/r/daemon/runs', buildDir: '/r2/player', env: { FF_GAME_DATA_DIR: 'relative' } }), []);
});

test('w5564: each fence wraps the player its own way; an unavailable one refuses it, Windows starts it as it is', () => {
  const launch = { cmd: '/r/players/slot1-0/player/finalfactory.exe', args: ['-logFile', '/r/timing/runs/tr_1/base/round1/player.log'] };
  const w = ['/r/timing/runs/tr_1', '/r/players/slot1-0/player'];
  assert.deepEqual(fencedPlayer({ kind: 'none' }, launch, w), launch);
  assert.match((fencedPlayer({ kind: 'unavailable', why: 'Landlock unavailable (errno 38)' }, launch, w) as { refused: string }).refused, /cannot run here \(Landlock unavailable \(errno 38\)\); a daemon-started player never runs unfenced/);
  assert.deepEqual(fencedPlayer({ kind: 'landlock', python: '/usr/bin/python3', script: '/d/machine/ff-landlock.py' }, launch, w), {
    cmd: '/usr/bin/python3',
    args: ['/d/machine/ff-landlock.py', '--rw', '/dev', '--rw', '/proc', '--rw', w[0], '--rw', w[1], '--', launch.cmd, ...launch.args],
  });
  // no /tmp, no home, no blanket root: tighter than the worker lock (machine/writeLock.ts)
  assert.ok(!playerLandlockArgs(w).some((a) => a === '/tmp' || a.startsWith('/home') || a === '/r'));
  const mac = fencedPlayer({ kind: 'seatbelt', darwinTemp: '/private/var/folders/x/T', darwinCache: '/private/var/folders/x/C' }, launch, w) as { cmd: string; args: string[] };
  assert.equal(mac.cmd, SANDBOX_EXEC);
  assert.equal(mac.args[0], '-p');
  assert.deepEqual(mac.args.slice(2), [launch.cmd, ...launch.args]);
});

test('w5564: the macOS player profile refuses every write but its folders, the device nodes and the Darwin temp and cache', () => {
  const p = playerSeatbeltProfile({ darwinTemp: '/private/var/folders/x/T', darwinCache: '/private/var/folders/x/C' }, ['/Users/u/ffw/timing/runs/tr_1', '/Users/u/ffw/players/slot1-0/player', '/Users/u/ffw/a "q"']);
  const lines = p.split('\n');
  assert.equal(lines[0], '(version 1)');
  assert.ok(lines.indexOf('(deny file-write*)') > lines.indexOf('(allow default)'), 'deny after the default');
  assert.ok(p.includes('(subpath "/Users/u/ffw/timing/runs/tr_1")'));
  assert.ok(p.includes('(subpath "/Users/u/ffw/players/slot1-0/player")'));
  assert.ok(p.includes('(subpath "/Users/u/ffw/a \\"q\\"")'), 'quotes escaped');
  assert.ok(p.includes('(subpath "/private/var/folders/x/T") (subpath "/private/var/folders/x/C")'));
  assert.ok(!p.includes('/private/tmp') && !p.includes('(subpath "/Users/u/ffw")'), 'neither /tmp nor the whole root');
  // nothing to open: the deny stands alone (the probe's no-op)
  assert.ok(!playerSeatbeltProfile({ darwinTemp: '/t', darwinCache: '/c' }, []).includes('(allow file-write*\n'));
});

test('w5564: the fence is probed once per kind and missing wrappers or a failed no-op leave it unavailable', () => {
  assert.deepEqual(playerFenceFor({ platform: 'win32' }), { kind: 'none' });
  assert.match(JSON.stringify(playerFenceFor({ platform: 'linux', exists: () => false })), /ff-landlock\.py is missing/);
  assert.match(JSON.stringify(playerFenceFor({ platform: 'darwin', exists: () => false })), /sandbox-exec is missing/);
  assert.match(JSON.stringify(playerFenceFor({ platform: 'freebsd' })), /no player fence for freebsd/);
  const seen: string[][] = [];
  const mac = playerFenceFor({ platform: 'darwin', exists: () => true, getconf: (n) => (n === 'DARWIN_USER_TEMP_DIR' ? '/nonexistent/T/' : '/nonexistent/C'), probe: (l) => (seen.push([l.cmd, ...l.args]), { ok: true }) });
  assert.deepEqual(mac, { kind: 'seatbelt', darwinTemp: '/nonexistent/T', darwinCache: '/nonexistent/C' });
  assert.equal(seen[0][0], SANDBOX_EXEC);
  assert.equal(seen[0].at(-1), '/usr/bin/true');
  assert.deepEqual(playerFenceFor({ platform: 'darwin', exists: () => true, getconf: () => '/t', probe: () => ({ ok: false, why: 'exited 65; stderr: sandbox-exec: syntax error' }) }), { kind: 'unavailable', why: 'a no-op inside it failed: exited 65; stderr: sandbox-exec: syntax error' });
  const lin = playerFenceFor({ platform: 'linux', exists: (p) => p === FF_LANDLOCK, probe: () => ({ ok: true }) });
  assert.deepEqual(lin, { kind: 'landlock', python: 'python3', script: FF_LANDLOCK });
});

const landlock = process.platform === 'linux' && spawnSync('python3', [FF_LANDLOCK, '--', 'true']).status === 0;

test('w5564: a fenced player writes its folders and is refused outside the root, in other slots and in the sandboxes', { skip: !landlock && 'needs Linux with Landlock' }, (t) => {
  const base = tmp(t, 'w5564-');
  const root = path.join(base, 'ffw');
  for (const d of ['timing/runs/tr_1', 'players/slot1-0/player', 'players/slot2-0/player', 'sandboxes/slot1', 'gamedata/UserData/saves', 'gamedata-home', 'tmp', 'daemon']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.mkdirSync(path.join(base, 'outside'));
  const f = playerFenceFor();
  assert.equal(f.kind, 'landlock');
  const w = playerWritable({ root, runDir: path.join(root, 'timing/runs/tr_1'), buildDir: path.join(root, 'players/slot1-0/player'), env: { FF_GAME_DATA_DIR: path.join(root, 'gamedata'), FF_PLAYER_HOME: path.join(root, 'gamedata-home') } });
  const script = [
    'try() { if ( echo x > "$2" ) 2>/dev/null; then echo "$1 ok"; else echo "$1 refused"; fi; }',
    `try run "${root}/timing/runs/tr_1/player.log"`,
    `try build "${root}/players/slot1-0/player/x"`,
    `try save "${root}/gamedata/UserData/saves/s.zip"`,
    `try prefs "${root}/gamedata-home/prefs"`,
    `try outside "${base}/outside/x"`,
    `try other-slot "${root}/players/slot2-0/player/finalfactory.exe"`,
    `try sandbox "${root}/sandboxes/slot1/x"`,
    `try root-tmp "${root}/tmp/x"`,
    `try daemon "${root}/daemon/x"`,
    `try devnull /dev/null`,
  ].join('\n');
  const l = fencedPlayer(f, { cmd: 'bash', args: ['-c', script] }, w) as { cmd: string; args: string[] };
  const r = spawnSync(l.cmd, l.args, { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), ['run ok', 'build ok', 'save ok', 'prefs ok', 'outside refused', 'other-slot refused', 'sandbox refused', 'root-tmp refused', 'daemon refused', 'devnull ok']);
});

/** A queue ticket granted at once. */
class Ticket implements RunTicket {
  wait(): Promise<TicketState> {
    return Promise.resolve({ kind: 'granted', ticket: 't00000001', line: 'granted' } as TicketState);
  }
  state() {
    return { kind: 'granted', ticket: 't00000001', line: 'granted' } as TicketState;
  }
  release() {}
}

/** A worker computer's runner with one leg of one build, under `fence`; what each spawn got is in `spawned`. */
async function oneLeg(t: { after(fn: () => void): void }, fence: PlayerFence) {
  const d = tmp(t, 'w5564r-');
  const p = path.join(d, 'build');
  fs.mkdirSync(path.join(p, 'finalfactory_Data'), { recursive: true });
  fs.writeFileSync(path.join(p, 'finalfactory.exe'), 'player');
  const files = scanBuild(p);
  const ps = await hashVariant(p, files);
  const pieces = new Map<string, string>();
  const pieceIds: Record<string, string> = {};
  for (const pc of ps) {
    const f = path.join(d, `piece-${pc.sha256}`);
    fs.writeFileSync(f, Buffer.concat(pc.parts.map((x) => fs.readFileSync(path.join(p, x.path)).subarray(x.offset, x.offset + x.length))));
    pieceIds[pc.sha256] = `att_${pc.sha256.slice(0, 12)}`;
    pieces.set(pieceIds[pc.sha256], f);
  }
  const save = Buffer.from('PK save');
  fs.writeFileSync(path.join(d, 'save'), save);
  pieces.set('att_save', path.join(d, 'save'));
  const order: TimedRunOrder = { id: 'tr_00000055a1', what: 'w5564 leg', requests: ['w5564'], session: 'sess-5f298b22', variants: [{ name: 'base', args: [], files, pieces: ps }], save: { id: 'att_save', name: 'bench.zip', size: save.length, sha256: createHash('sha256').update(save).digest('hex') }, pieceIds, settings: { ...TIMED_DEFAULTS, rounds: 1, sampleS: 5, settleS: 5 } };
  const reports: TimedRunReport[] = [];
  const logs: string[] = [];
  const spawned: { cmd: string; args: string[] }[] = [];
  const player = (args: string[]): ChildProcess => {
    const log = args[args.indexOf('-logFile') + 1];
    return spawn(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(log)}, '[Audit] PerfSummary hb=320 fps=60 ups=20 frameAvgMs=16.5\\n')`], { stdio: 'ignore' });
  };
  const runner = new TimedRunner({
    root: path.join(d, 'root'),
    portalUrl: 'http://127.0.0.1:1',
    token: 'x',
    send: (m) => void reports.push(m),
    log: (l) => void logs.push(l),
    personBusy: () => undefined,
    savesDir: path.join(d, 'saves'),
    pollMs: 5,
    fetchPiece: async (ref, dest) => void fs.copyFileSync(pieces.get(ref.id)!, dest),
    spawnPlayer: (cmd, args) => (spawned.push({ cmd, args }), player(args)),
    playerFence: () => fence,
    worker: { sandboxIds: () => ['slot1'], ticket: () => ({ ticket: new Ticket() }), owner: () => ({ pid: 4242, end: () => {} }) },
  });
  runner.enqueue(order);
  const end = await new Promise<Extract<TimedRunReport, { type: 'timed_run_done' }>>((resolve, reject) => {
    const until = Date.now() + 30_000;
    const look = () => {
      const r = reports.find((x) => x.type === 'timed_run_done');
      if (r) resolve(r as Extract<TimedRunReport, { type: 'timed_run_done' }>);
      else if (Date.now() > until) reject(new Error(`never ended: ${JSON.stringify(reports.slice(-3))}`));
      else setTimeout(look, 10);
    };
    look();
  });
  return { d, end, spawned, logs };
}

test('w5564: a timed leg starts its player inside the fence, writing only its run folder, build and data roots', async (t) => {
  const r = await oneLeg(t, { kind: 'landlock', python: '/usr/bin/python3', script: '/d/machine/ff-landlock.py' });
  assert.equal(r.spawned.length, 1);
  const { cmd, args } = r.spawned[0];
  assert.equal(cmd, '/usr/bin/python3');
  assert.equal(args[0], '/d/machine/ff-landlock.py');
  const cut = args.indexOf('--');
  assert.match(args[cut + 1], /players[/\\]slot1-0[/\\]player[/\\]finalfactory\.exe$/, 'the borrowed slot\'s player, after the fence\'s own arguments');
  const rw = args.slice(1, cut).filter((_, i) => i % 2 === 1);
  assert.deepEqual(rw.slice(0, 2), ['/dev', '/proc']);
  assert.ok(rw.some((p) => /timing[/\\]runs[/\\]tr_00000055a1$/.test(p)), `run folder in ${rw}`);
  assert.ok(rw.some((p) => /players[/\\]slot1-0[/\\]player$/.test(p)), `build folder in ${rw}`);
  assert.ok(rw.every((p) => p === '/dev' || p === '/proc' || p.startsWith(fs.realpathSync(path.join(r.d, 'root')))), `all inside the root: ${rw}`);
  const launch = fs.readFileSync(path.join(r.d, 'root', 'timing', 'runs', 'tr_00000055a1', 'base', 'round1', 'launch.txt'), 'utf8');
  assert.match(launch, /\nfence landlock\n/);
});

test('w5564: a fence that cannot run refuses the leg and starts no player', async (t) => {
  const r = await oneLeg(t, { kind: 'unavailable', why: 'Landlock unavailable (errno 38)' });
  assert.equal(r.spawned.length, 0);
  assert.equal(r.end.ok, false);
  assert.match(r.end.legs[0].note ?? '', /player fence cannot run here \(Landlock unavailable \(errno 38\)\)/);
  assert.ok(r.logs.some((l) => /never runs unfenced/.test(l)));
});
