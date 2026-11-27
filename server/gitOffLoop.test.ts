/**
 * w6554: the daemon's git calls through gitExecFile (the clean-up's unpushedWorkWhy, liveIdle, selfUpdate, the leftover
 * scans) and RunnerEnv's PowerShell start, and past their timeout end, from the spawn thread (server/spawnThread.ts), not
 * on the daemon's loop. On 2026-11-27 BEAST's loop was held 48.8 s, 44.1 s and 19.3 s in those git starts and 24.5 s in a
 * kill under RunnerEnv's step. Behaviour is the same with the thread on or off.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import cp, { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitExecFile } from './safeGit.ts';
import { unpushedWorkWhy } from './cleanup.ts';
import { useSpawnThread } from './spawnThread.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Every child_process call made on this thread while `fn` runs (the spawn thread loads its own child_process: unseen). */
async function loopSpawns<T>(fn: () => Promise<T>): Promise<{ value: T; spawns: string[] }> {
  const names = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'] as const;
  const mod = cp as unknown as Record<string, (...a: unknown[]) => unknown>;
  const real = new Map(names.map((n) => [n, mod[n]]));
  const spawns: string[] = [];
  for (const n of names) mod[n] = (...a: unknown[]) => (spawns.push(`${n} ${String(a[0])} ${JSON.stringify(a[1] ?? '').slice(0, 80)}`), real.get(n)!(...a));
  syncBuiltinESMExports();
  try {
    return { value: await fn(), spawns };
  } finally {
    for (const n of names) mod[n] = real.get(n)!;
    syncBuiltinESMExports();
  }
}

/** `fn` with the spawn thread off (as outside the daemon) and on (as in it). */
async function offAndOn<T>(fn: () => Promise<T>): Promise<{ off: { value: T; spawns: string[] }; on: { value: T; spawns: string[] } }> {
  useSpawnThread(false);
  const off = await loopSpawns(fn);
  useSpawnThread(true, () => {});
  try {
    return { off, on: await loopSpawns(fn) };
  } finally {
    useSpawnThread(false);
  }
}

function repo(t: { after: (f: () => void) => void }, name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `w6554-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@users.noreply.github.com', 'commit', '-q', '--allow-empty', '-m', 'one');
  return dir;
}

const gitOut = (args: string[], opts: Parameters<typeof gitExecFile>[1]) =>
  new Promise<{ err: string | undefined; out: string; stderr: string }>((resolve) => gitExecFile(args, opts, (e, out, stderr) => resolve({ err: e ? 'error' : undefined, out, stderr })));

test('w6554: gitExecFile starts both its spawns (the fence scan and git) from the spawn thread, with the same answer', async (t) => {
  const dir = repo(t, 'exec');
  // rev-list reads objects: the fence scans the checkout's config first (needsScan), a second program.
  const { off, on } = await offAndOn(() => gitOut(['--no-optional-locks', '-C', dir, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8', timeout: 15_000, windowsHide: true }));
  assert.deepEqual(on.value, off.value);
  assert.equal(on.value.out.trim(), '1');
  assert.equal(off.spawns.length, 2, `the recorder sees the loop's spawns with the thread off:\n${off.spawns.join('\n')}`);
  assert.deepEqual(on.spawns, [], 'nothing started on the loop with the thread on');
});

test('w6554: a git that fails answers its error and stderr from the thread as execFile did', async (t) => {
  const dir = repo(t, 'fail');
  const { off, on } = await offAndOn(() => gitOut(['--no-optional-locks', '-C', dir, 'rev-parse', '--verify', 'no-such-ref-w6554'], { encoding: 'utf8', timeout: 15_000, windowsHide: true }));
  assert.equal(on.value.err, 'error');
  assert.deepEqual(on.value, off.value);
  assert.deepEqual(on.spawns, []);
});

test("w6554: the clean-up's unpushedWorkWhy reads a clone's work from the thread, the same answer, nothing on the loop", async (t) => {
  const dir = repo(t, 'unpushed');
  const { off, on } = await offAndOn(() => unpushedWorkWhy(dir));
  assert.equal(off.value, '1 commit on no remote');
  assert.equal(on.value, off.value);
  assert.ok(off.spawns.length > 0, off.spawns.join('\n'));
  assert.deepEqual(on.spawns, []);
});

test("w6554: safeGit.ts and the daemon's runner calls start no program with a bare execFile", () => {
  const strip = (f: string) => fs.readFileSync(path.join(here, '..', f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  for (const f of ['server/safeGit.ts', 'machine/daemon.ts']) {
    const text = strip(f);
    assert.doesNotMatch(text, /(^|[^.\w])execFile\(/m, `${f} calls execFile on the loop: use execFileOffThread (server/spawnThread.ts)`);
  }
});
