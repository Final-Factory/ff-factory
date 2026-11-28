/**
 * w6639: what still held BEAST's daemon loop after w6554 (an hour of F:/ffw/daemon/logs read by w6614, 2026-11-27 23:50Z to
 * 2026-11-28 00:57Z): an agent host's launch spawn (24.7 s, 14.7 s), the transcript tail's keep-open close (56.6 s), the close
 * in writeInPlace under writeCleanupFacts (15.8 s) and the Unity MCP status read under refreshMcpScopes (10.8 s). Each now
 * runs off the loop; the answers are the same.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { launchDetached, useSpawnThread } from './spawnThread.ts';
import { HostedSession, LineTail, type HostDeps } from '../machine/agentHost.ts';
import { writeInPlace } from '../machine/readFence.ts';
import { readStatusFiles, readStatusFilesAsync } from './unityMcp.ts';
import { McpScopes } from '../machine/unityMcp.ts';
import type { FromDaemon } from './machineProtocol.ts';
import type { SessionInfo } from '../shared/types.ts';

const tmp = (t: { after: (f: () => void) => void }, name: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `w6639-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  return dir;
};

const until = async (what: string, cond: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** Every child_process start on this thread while `fn` runs (the spawn thread has its own child_process: unseen). */
async function loopSpawns<T>(fn: () => Promise<T> | T): Promise<{ value: T; spawns: string[] }> {
  const names = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'] as const;
  const mod = cp as unknown as Record<string, (...a: unknown[]) => unknown>;
  const real = new Map(names.map((n) => [n, mod[n]]));
  const spawns: string[] = [];
  for (const n of names) mod[n] = (...a: unknown[]) => (spawns.push(`${n} ${String(a[0])}`), real.get(n)!(...a));
  syncBuiltinESMExports();
  try {
    return { value: await fn(), spawns };
  } finally {
    for (const n of names) mod[n] = real.get(n)!;
    syncBuiltinESMExports();
  }
}

/** Records the synchronous closes of fs while `fn` runs (the async fs.close is not one). */
async function syncCloses<T>(fn: () => Promise<T> | T): Promise<{ value: T; closes: number[] }> {
  const real = fs.closeSync;
  const closes: number[] = [];
  (fs as { closeSync: typeof fs.closeSync }).closeSync = (fd: number) => (closes.push(fd), real(fd));
  try {
    return { value: await fn(), closes };
  } finally {
    (fs as { closeSync: typeof fs.closeSync }).closeSync = real;
  }
}

const pidGone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

test('w6639: launchDetached starts a detached program from the spawn thread: its stdin and log as before, nothing started on the loop', { timeout: 60_000 }, async (t) => {
  const dir = tmp(t, 'launch');
  // A stand-in host: reads its start from stdin, writes it to stdout (the log), and ends.
  const script = "let d='';process.stdin.on('data',(c)=>d+=c).on('end',()=>{console.log('got '+d)})";
  const go = (log: string) => launchDetached({ cmd: process.execPath, args: ['-e', script], cwd: dir, env: process.env, log, input: '{"w":6639}', noPid: 'no pid' });

  useSpawnThread(false);
  const off = await loopSpawns(() => go(path.join(dir, 'off.log')));
  assert.equal(typeof off.value, 'number', 'with the thread off the pid comes back at once, as launchHost answered before');
  assert.equal(off.spawns.length, 1, off.spawns.join('\n'));

  useSpawnThread(true, () => {});
  t.after(() => useSpawnThread(false));
  const on = await loopSpawns(async () => {
    const r = go(path.join(dir, 'on.log'));
    assert.ok(r instanceof Promise, 'with the thread on the pid comes from the thread');
    return r;
  });
  assert.ok(on.value > 0);
  assert.deepEqual(on.spawns, [], 'nothing started on the loop with the thread on');

  for (const [name, pid] of [['off', off.value as number], ['on', on.value]] as const) {
    await until(`the ${name} stand-in wrote its start`, () => fs.existsSync(path.join(dir, `${name}.log`)) && fs.readFileSync(path.join(dir, `${name}.log`), 'utf8').includes('got {"w":6639}'));
    await until(`the ${name} stand-in ended`, () => pidGone(pid));
  }
});

test('w6639: a program that cannot start answers its error from the thread, as launchHost threw', { timeout: 30_000 }, async (t) => {
  const dir = tmp(t, 'nostart');
  const s = { cmd: path.join(dir, 'no-such-program-w6639'), args: [], cwd: dir, env: process.env, log: path.join(dir, 'x.log'), input: '', noPid: 'the agent host did not start' };
  useSpawnThread(false);
  assert.throws(() => launchDetached(s), /the agent host did not start/);
  useSpawnThread(true, () => {});
  t.after(() => useSpawnThread(false));
  await assert.rejects(Promise.resolve(launchDetached(s)), /the agent host did not start/);
});

const info = (id: string): SessionInfo => ({ id, kind: 'worker', title: `w6639 ${id}`, status: 'idle', permissionMode: 'default', createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), turns: 0, costUsd: 0, pendingPermissions: [] });

function hosted(root: string, launch: HostDeps['launch']) {
  const out: FromDaemon[] = [];
  const logs: string[] = [];
  let changed = 0;
  const deps: HostDeps = {
    root,
    out: (m) => out.push(m),
    events: new EventEmitter(),
    handlers: () => ({}),
    spec: () => ({ cwd: root }) as never,
    editorUp: () => undefined,
    changed: () => void changed++,
    log: (l) => logs.push(l),
    launch,
  };
  const s = new HostedSession(info('h1'), 0, deps);
  return { s, out, logs, changed: () => changed };
}

test("w6639: a host whose start the thread answers later: its pid is kept, and a failed start is told the portal as before", { timeout: 30_000 }, async (t) => {
  const root = tmp(t, 'hosted');
  const ok = hosted(root, () => Promise.resolve(4242));
  t.after(() => ok.s.detach());
  ok.s.send('hello', 'orchestrator');
  assert.equal(ok.s.info.status, 'running');
  await until('the pid came back', () => ok.logs.some((l) => l.includes('started, pid 4242')));
  assert.equal(ok.s.hostPid, 4242);
  assert.equal(ok.out.filter((m) => m.type === 'failed').length, 0);

  const bad = hosted(path.join(root, 'b'), () => Promise.reject(new Error('the agent host did not start')));
  t.after(() => bad.s.detach());
  bad.s.send('hello', 'orchestrator');
  await until('the failure was told', () => bad.out.some((m) => m.type === 'failed'));
  const failed = bad.out.find((m) => m.type === 'failed') as Extract<FromDaemon, { type: 'failed' }>;
  assert.equal(failed.error, 'could not start its agent host: the agent host did not start');
  assert.equal((failed as { reason?: string }).reason, 'host_start');
  assert.equal(bad.s.info.status, 'error');
  assert.ok(bad.changed() > 0, 'the daemon is told its record changed');
});

test("w6639: the agent host's launch is not a spawn on the daemon's loop", () => {
  const text = fs.readFileSync(path.join(import.meta.dirname, '..', 'machine', 'agentHost.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.doesNotMatch(text, /(^|[^.\w])spawn\(/m, 'machine/agentHost.ts starts a program on the loop: use launchDetached (server/spawnThread.ts)');
});

test("w6639: the transcript tail's keep-open timer closes its handle off the loop; an explicit close still closes at once", { timeout: 20_000 }, async (t) => {
  const dir = tmp(t, 'tail');
  const file = path.join(dir, 'out.jsonl');
  fs.writeFileSync(file, 'one\ntwo\n');
  const lines: string[] = [];
  const tail = new LineTail(file, (l) => lines.push(l), 0, 50);
  const { closes } = await syncCloses(async () => {
    tail.poll();
    await new Promise((r) => setTimeout(r, 200)); // past keepOpenMs: the timer let go of the handle
  });
  assert.deepEqual(lines, ['one', 'two']);
  assert.deepEqual(closes, [], 'the keep-open timer closed its handle with a synchronous close on the loop');
  // It was let go of: the next poll opens the file again and reads on.
  fs.appendFileSync(file, 'three\n');
  const again = await syncCloses(() => {
    tail.poll();
    tail.close(); // before its folder is removed: at once, as before
  });
  assert.deepEqual(lines, ['one', 'two', 'three']);
  assert.equal(again.closes.length, 1, 'an explicit close is still synchronous (its folder is removed next)');
});

test('w6639: writeInPlace writes the same bytes in place and closes its handle off the loop', async (t) => {
  const dir = tmp(t, 'inplace');
  const file = path.join(dir, 'facts.json');
  fs.writeFileSync(file, '{"long":"old contents, longer than the new"}');
  const ino = fs.statSync(file).ino;
  const { closes } = await syncCloses(() => writeInPlace(file, '{"a":1}'));
  assert.deepEqual(closes, [], 'writeInPlace closed with a synchronous close on the loop');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}');
  assert.equal(fs.statSync(file).ino, ino, 'the same file, written in place');
  const fresh = path.join(dir, 'new.json');
  writeInPlace(fresh, 'x');
  assert.equal(fs.readFileSync(fresh, 'utf8'), 'x');
});

test('w6639: the Unity MCP status files read off the loop are the ones read on it, and a sync given them reads nothing on the loop', async (t) => {
  const home = tmp(t, 'mcp');
  const app = tmp(t, 'app');
  fs.writeFileSync(path.join(home, 'unity-mcp-status-aaa.json'), '\uFEFF' + JSON.stringify({ project_path: 'D:\\work\\ffsb\\sb1', unity_port: 6401 }));
  fs.writeFileSync(path.join(home, 'unity-mcp-status-bbb.json'), JSON.stringify({ project_path: 'D:\\work\\ffsb\\sb2' }));
  fs.writeFileSync(path.join(home, 'unity-mcp-status-ccc.json'), '{ half written');
  fs.writeFileSync(path.join(home, 'other.json'), JSON.stringify({ project_path: 'x' }));
  const sorted = <T extends { name: string }>(a: T[]) => [...a].sort((x, y) => x.name.localeCompare(y.name));
  const sync = readStatusFiles(home);
  const off = await readStatusFilesAsync(home);
  assert.equal(sync.length, 2);
  assert.deepEqual(sorted(off), sorted(sync));
  assert.deepEqual(await readStatusFilesAsync([home, path.join(home, 'missing')]), off);

  const scopes = new McpScopes(home);
  assert.equal(scopes.statusDirs(), home);
  const real = { readdirSync: fs.readdirSync, readFileSync: fs.readFileSync };
  const reads: string[] = [];
  const f = fs as unknown as Record<string, (...a: unknown[]) => unknown>;
  f.readdirSync = (...a: unknown[]) => (String(a[0]).startsWith(home) && reads.push(String(a[0])), (real.readdirSync as (...x: unknown[]) => unknown)(...a));
  f.readFileSync = (...a: unknown[]) => (String(a[0]).startsWith(home) && reads.push(String(a[0])), (real.readFileSync as (...x: unknown[]) => unknown)(...a));
  try {
    scopes.sync(app, [{ place: 'sb1', project: 'D:\\work\\ffsb\\sb1', pid: process.pid }], Date.now(), () => undefined, off);
  } finally {
    Object.assign(fs, real);
  }
  assert.deepEqual(reads, [], 'given the files read off the loop, sync reads none of them again');
});
