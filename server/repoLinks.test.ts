import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// w4533: a worker's temp worktree linked node_modules to another clone's, and `git add -A` carried that link
// (/Users/.../ffa-2c08ba20/ffx/node_modules) into main with #997. No tracked symlink may point at an absolute path.
test('no tracked symlink points outside the repo (a node_modules link to a clone in someone\'s temp folder)', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const git = (...a: string[]) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  const links = git('ls-files', '-s').split('\n').filter((l) => l.startsWith('120000 '));
  const bad = links
    .map((l) => ({ file: l.split('\t')[1], target: git('cat-file', '-p', l.split(/\s+/)[1]).trim() }))
    .filter(({ file, target }) => path.isAbsolute(target) || /^[a-z]:[\\/]/i.test(target) || file.split('/').includes('node_modules'));
  assert.deepEqual(bad, [], 'tracked symlinks to absolute paths or node_modules');
});
