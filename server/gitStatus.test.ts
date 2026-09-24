import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describeGit, parseStatus, readGitStatus } from './gitStatus.ts';

test('git status: porcelain v2 read into branch, upstream, ahead/behind, changes', () => {
  const out = [
    '# branch.oid 11a8ad9c',
    '# branch.head 098-belts',
    '# branch.upstream origin/098-belts',
    '# branch.ab +2 -5',
    '1 .M N... 100644 100644 100644 a b Assets/x.cs',
    '1 M. N... 100644 100644 100644 a b Assets/y.cs',
    '? notes.txt',
  ].join('\n');
  assert.deepEqual(parseStatus(out), { branch: '098-belts', upstream: 'origin/098-belts', ahead: 2, behind: 5, dirty: 2, untracked: 1 });
  assert.equal(parseStatus('# branch.oid x\n# branch.head (detached)\n').branch, 'detached HEAD');
  assert.equal(parseStatus('# branch.head main\n').upstream, undefined);
});

test('git status: read from a real repository, and described for the orchestrator', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-git-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'feature/x');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'First commit');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'x');
  const g = (await readGitStatus(dir))!;
  assert.equal(g.branch, 'feature/x');
  assert.equal(g.untracked, 1);
  assert.equal(g.head?.subject, 'First commit');
  assert.match(describeGit(g, 'sandbox/x'), /^git: on feature\/x \(created on sandbox\/x\); 0 changed, 1 untracked; no upstream; last \w+ "First commit"$/);
  assert.equal(await readGitStatus(path.join(dir, 'nope')), undefined);
});
