import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { STALE_INDEX_LOCK_MS, clearStaleIndexLock, clearStaleLockIn, gitFailure } from './staleGitLock.ts';

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
  assert.ok(fs.existsSync(lock), 'a lock 59 minutes old is kept');
  assert.match(clearStaleLockIn(d, Date.now() + 2 * STALE_INDEX_LOCK_MS) ?? '', /removed a stale index\.lock, 1[12]\d min old/);
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
