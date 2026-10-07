import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { saveWork } from './saveWork.ts';

function repos() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-save-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString().trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'develop', origin]);
  execFileSync('git', ['clone', '-q', origin, work], { stdio: 'pipe' });
  git(work, 'config', 'user.email', 't@t');
  git(work, 'config', 'user.name', 't');
  git(work, 'switch', '-q', '-c', 'develop');
  fs.writeFileSync(path.join(work, 'a.cs'), 'a');
  fs.writeFileSync(path.join(work, '.gitignore'), 'Library/\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'base');
  git(work, 'push', '-q', '-u', 'origin', 'develop');
  git(work, 'switch', '-q', '-c', 'w1-feature');
  return { root, origin, work, git, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const MSG = 'FF Factory: w1 saved before its sandbox was released (w656)';

test('w656 save: changed, deleted and new files are committed on the worker branch and pushed; ignored files stay', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  fs.writeFileSync(path.join(r.work, 'a.cs'), 'changed');
  fs.writeFileSync(path.join(r.work, 'New.cs'), 'new');
  fs.writeFileSync(path.join(r.work, 'New.cs.meta'), 'guid');
  fs.mkdirSync(path.join(r.work, 'Library'));
  fs.writeFileSync(path.join(r.work, 'Library', 'big.bin'), Buffer.alloc(20 * 1024 * 1024));
  const res = await saveWork({ dir: r.work, branch: 'w1-feature', message: MSG });
  assert.equal(res.files, 3);
  assert.equal(res.pushed, true);
  assert.equal(r.git(r.work, 'status', '--porcelain'), '', 'clean: the sandbox may be released');
  assert.equal(r.git(r.origin, 'log', '-1', '--format=%s', 'w1-feature'), MSG, 'safe on origin');
  assert.equal(r.git(r.work, 'rev-parse', '--short', 'HEAD'), res.sha);
  assert.ok(fs.existsSync(path.join(r.work, 'Library', 'big.bin')), 'ignored files are left alone');
  // git reset HEAD~1 gives the worker its changes back, uncommitted.
  r.git(r.work, 'reset', '-q', 'HEAD~1');
  assert.match(r.git(r.work, 'status', '--porcelain'), /M a\.cs/);
  assert.match(r.git(r.work, 'status', '--porcelain'), /\?\? New\.cs/);
});

test('w656 save: nothing to save; refused on another branch, a shared branch, or untracked files too many or too big', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  assert.deepEqual(await saveWork({ dir: r.work, branch: 'w1-feature', message: MSG }), { files: 0, pushed: false, notes: ['nothing to save'] });
  fs.writeFileSync(path.join(r.work, 'a.cs'), 'changed');
  await assert.rejects(saveWork({ dir: r.work, branch: 'w2-other', message: MSG }), /on w1-feature, not the worker's branch w2-other/);
  r.git(r.work, 'stash', '-q');
  r.git(r.work, 'switch', '-q', 'develop');
  r.git(r.work, 'stash', 'pop', '-q');
  await assert.rejects(saveWork({ dir: r.work, branch: 'develop', message: MSG }), /develop, a shared branch/);
  r.git(r.work, 'switch', '-q', 'w1-feature');
  const limits = { files: 3, fileBytes: 1000, totalBytes: 1500 };
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(r.work, `run${i}.log`), 'x');
  await assert.rejects(saveWork({ dir: r.work, branch: 'w1-feature', message: MSG, limits }), /4 untracked files there, more than the 3 a save commits/);
  for (let i = 0; i < 4; i++) fs.rmSync(path.join(r.work, `run${i}.log`));
  fs.writeFileSync(path.join(r.work, 'clip.mp4'), Buffer.alloc(2000));
  await assert.rejects(saveWork({ dir: r.work, branch: 'w1-feature', message: MSG, limits }), /the untracked file clip\.mp4 is 0\.0 MB, more than/);
  fs.rmSync(path.join(r.work, 'clip.mp4'));
  fs.writeFileSync(path.join(r.work, 'b1.bin'), Buffer.alloc(900));
  fs.writeFileSync(path.join(r.work, 'b2.bin'), Buffer.alloc(900));
  await assert.rejects(saveWork({ dir: r.work, branch: 'w1-feature', message: MSG, limits }), /the untracked files there are more than/);
  assert.match(r.git(r.work, 'status', '--porcelain'), /M a\.cs/, 'nothing was committed');
});

test('w656 save: a push that fails still leaves the commit in the repository, and says so', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  r.git(r.work, 'remote', 'set-url', 'origin', path.join(r.root, 'gone.git'));
  fs.writeFileSync(path.join(r.work, 'a.cs'), 'changed');
  const res = await saveWork({ dir: r.work, branch: 'w1-feature', message: MSG });
  assert.equal(res.pushed, false);
  assert.match(res.notes.join('; '), /not pushed .*the commit is in this machine's repository/);
  assert.equal(r.git(r.work, 'log', '-1', '--format=%s'), MSG);
});
