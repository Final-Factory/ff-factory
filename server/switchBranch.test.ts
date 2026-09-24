import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { explainCheckoutError, switchBranch } from './switchBranch.ts';

function repos() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-switch-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' }).toString().trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'develop', origin]);
  execFileSync('git', ['clone', '-q', origin, work], { stdio: 'pipe' });
  git(work, 'switch', '-q', '-c', 'develop');
  git(work, 'commit', '-q', '--allow-empty', '-m', 'base');
  git(work, 'push', '-q', '-u', 'origin', 'develop');
  git(work, 'switch', '-q', '-c', 'sandbox/a');
  return { root, origin, work, git, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('switch: refuses uncommitted changes and names them', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  fs.writeFileSync(path.join(r.work, 'x.txt'), 'x');
  r.git(r.work, 'add', 'x.txt');
  await assert.rejects(switchBranch({ dir: r.work, branch: 'other' }), /1 uncommitted change\(s\) \(x\.txt\)/);
  assert.equal(r.git(r.work, 'branch', '--show-current'), 'sandbox/a', 'nothing switched');
});

test('switch: pushes stranded commits, then creates the new branch from origin/develop', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  r.git(r.work, 'commit', '-q', '--allow-empty', '-m', 'work in progress');
  fs.writeFileSync(path.join(r.work, 'scratch.txt'), 'untracked');
  const res = await switchBranch({ dir: r.work, branch: '098-belts' });
  assert.equal(res.from, 'sandbox/a');
  assert.equal(res.to, '098-belts');
  assert.match(res.notes.join('; '), /pushed 1 unpushed commit\(s\) of sandbox\/a first; created 098-belts from origin\/develop; 1 untracked file\(s\) came along/);
  assert.equal(r.git(r.origin, 'log', '-1', '--format=%s', 'sandbox/a'), 'work in progress', 'the commit is safe on origin');
  assert.equal(r.git(r.work, 'log', '-1', '--format=%s'), 'base');
});

test('switch: tracks a branch that only exists on origin; fast-forwards a local one that lags', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  const other = path.join(r.root, 'other');
  execFileSync('git', ['clone', '-q', r.origin, other], { stdio: 'pipe' });
  r.git(other, 'switch', '-q', '-c', 'feature/x', 'origin/develop');
  r.git(other, 'commit', '-q', '--allow-empty', '-m', 'remote work');
  r.git(other, 'push', '-q', '-u', 'origin', 'feature/x');
  let res = await switchBranch({ dir: r.work, branch: 'feature/x' });
  assert.match(res.notes[0], /checked out feature\/x from origin/);
  assert.equal(r.git(r.work, 'log', '-1', '--format=%s'), 'remote work');

  r.git(r.work, 'switch', '-q', 'sandbox/a');
  r.git(other, 'commit', '-q', '--allow-empty', '-m', 'more remote work');
  r.git(other, 'push', '-q');
  res = await switchBranch({ dir: r.work, branch: 'feature/x' });
  assert.match(res.notes.join('; '), /fast-forwarded feature\/x/);
  assert.equal(r.git(r.work, 'log', '-1', '--format=%s'), 'more remote work');
});

test('switch: develop with unpushed commits is left for a person; a branch in another worktree is explained', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  r.git(r.work, 'switch', '-q', 'develop');
  r.git(r.work, 'commit', '-q', '--allow-empty', '-m', 'local only');
  await assert.rejects(switchBranch({ dir: r.work, branch: 'sandbox/a' }), /develop has 1 commit\(s\) that are on no remote/);
  r.git(r.work, 'reset', '-q', '--hard', 'origin/develop');
  const wt = path.join(r.root, 'wt');
  r.git(r.work, 'worktree', 'add', '-q', wt, 'sandbox/a');
  await assert.rejects(switchBranch({ dir: r.work, branch: 'sandbox/a', nameOf: () => 'sandbox sb2' }), /Branch sandbox\/a is checked out in another worktree \(sandbox sb2\)/);
  assert.equal(explainCheckoutError("fatal: 'x' is already used by worktree at 'C:/ffsb/sb2'", 'x'), "Branch x is checked out in another worktree at C:/ffsb/sb2. Switch that one to another branch first; git does not allow one branch in two worktrees.");
  await assert.rejects(switchBranch({ dir: r.work, branch: '-f' }), /not a valid branch name/);
});
