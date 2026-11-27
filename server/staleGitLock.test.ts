import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { STALE_INDEX_LOCK_MS, STATUS_TIMEOUT_MS, clearStaleIndexLock, clearStaleLockIn, gitFailure } from './staleGitLock.ts';

const tmp = (t: { after: (fn: () => void) => void }) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-lock-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

test('w6432: an index.lock older than the limit is removed, a fresh one is a live git\'s and stays', (t) => {
  const d = tmp(t);
  const lock = path.join(d, 'index.lock');
  assert.equal(clearStaleLockIn(d, Date.now()), undefined, 'no lock, nothing done');
  fs.writeFileSync(lock, '');
  assert.equal(clearStaleLockIn(d, Date.now() + STALE_INDEX_LOCK_MS - 60_000), undefined);
  assert.ok(fs.existsSync(lock), 'a lock a minute short of the limit is kept');
  assert.match(clearStaleLockIn(d, Date.now() + 2 * STALE_INDEX_LOCK_MS) ?? '', /removed a stale index\.lock, \d+ min old/);
  assert.ok(!fs.existsSync(lock));
});

test('w6432: clearStaleIndexLock finds a worktree\'s git dir and frees it for git add', async (t) => {
  const d = tmp(t);
  execFileSync('git', ['init', '-q', d]);
  fs.writeFileSync(path.join(d, 'a.txt'), 'a');
  const lock = path.join(d, '.git', 'index.lock');
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 2 * STALE_INDEX_LOCK_MS);
  fs.utimesSync(lock, old, old);
  assert.throws(() => execFileSync('git', ['-C', d, 'add', 'a.txt'], { stdio: 'pipe' }), /index\.lock/);
  assert.match((await clearStaleIndexLock(d)) ?? '', /removed a stale index\.lock/);
  execFileSync('git', ['-C', d, 'add', 'a.txt'], { stdio: 'pipe' });
  assert.equal(await clearStaleIndexLock(path.join(d, 'not-a-repo-dir-that-is-missing')), undefined, 'no repository: nothing, no throw');
});

test('w6432: gitFailure names a timeout, where Node says only "Command failed"', () => {
  const said = 'Command failed: git -C V:\\ffw\\sandboxes\\slot1 status --porcelain=v2 --branch\n';
  assert.match(gitFailure({ code: -1, stdout: '', stderr: said, signal: 'SIGTERM', timedOut: true }, 120_000), /^timed out after 120 s/);
  assert.equal(gitFailure({ code: -1, stdout: '', stderr: said, signal: 'SIGKILL' }, 120_000), 'git was ended by SIGKILL before it said anything');
  assert.equal(gitFailure({ code: 128, stdout: '', stderr: "warn\nfatal: Unable to create 'x/index.lock': File exists.\n" }, 120_000), "warn fatal: Unable to create 'x/index.lock': File exists.");
});

test('w6453: the timers leave margins: a status well inside the server 10-minute switch and save waits, a lock limit past the longest git', () => {
  const serverWait = 10 * 60_000; // server/machines.ts switchBranch and saveWork
  assert.ok(STATUS_TIMEOUT_MS <= serverWait / 2, 'the fetch, checkout or commit after the status still ends before the server gives up');
  const resetHard = 60 * 60_000; // machine/sandboxes.ts provisioning reset --hard
  const backgroundCommand = 2 * 60 * 60_000; // a worker's own long git in the background
  assert.ok(STALE_INDEX_LOCK_MS > resetHard && STALE_INDEX_LOCK_MS > backgroundCommand);
  const src = (f: string) => fs.readFileSync(path.join(import.meta.dirname, f), 'utf8');
  for (const f of ['saveWork.ts', 'switchBranch.ts']) {
    assert.match(src(f), /clearStaleIndexLock\(dir\)/, `${f} clears a stale lock first`);
    assert.match(src(f), /'status'.*STATUS_TIMEOUT_MS/, `${f}'s status uses STATUS_TIMEOUT_MS`);
  }
  assert.match(src('machines.ts'), /did not finish the switch in 10 minutes/, 'the server wait this margin is measured against');
});
