import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { refreshBaseClone, startBaseRefresh } from './baseRefresh.ts';

/** w467, change 11: the orchestrators' base clone follows origin/develop, with real git. */

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' }).toString().trim();

test('w467: the base clone is fetched and moved to origin/develop; with modified files its HEAD stays', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-baserefresh-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const base = path.join(root, 'base');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'develop', origin]);
  execFileSync('git', ['clone', '-q', origin, work], { stdio: 'pipe' });
  git(work, 'switch', '-q', '-c', 'develop');
  fs.writeFileSync(path.join(work, 'README.md'), 'one\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'one');
  git(work, 'push', '-q', '-u', 'origin', 'develop');
  execFileSync('git', ['clone', '-q', origin, base], { stdio: 'pipe' });
  assert.match(await refreshBaseClone(base, 'origin/develop'), /^already at origin\/develop/, 'the same commit, now detached');
  assert.equal(git(base, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'detached');
  assert.match(await refreshBaseClone(base, 'origin/develop'), /^already at origin\/develop/);
  // New code on origin: the next refresh brings the working tree there.
  fs.writeFileSync(path.join(work, 'README.md'), 'two\n');
  git(work, 'commit', '-q', '-am', 'two');
  git(work, 'push', '-q');
  assert.match(await refreshBaseClone(base, 'origin/develop'), /^moved to origin\/develop \(\w{9} → \w{9}\)$/);
  assert.equal(fs.readFileSync(path.join(base, 'README.md'), 'utf8').replace(/\r\n/g, '\n'), 'two\n');
  assert.equal(git(base, 'rev-parse', 'HEAD'), git(work, 'rev-parse', 'HEAD'));
  // Someone's modified file: left alone.
  fs.writeFileSync(path.join(work, 'README.md'), 'three\n');
  git(work, 'commit', '-q', '-am', 'three');
  git(work, 'push', '-q');
  fs.writeFileSync(path.join(base, 'README.md'), 'mine\n');
  assert.equal(await refreshBaseClone(base, 'origin/develop'), 'the base clone has modified files: HEAD left where it is');
  assert.equal(fs.readFileSync(path.join(base, 'README.md'), 'utf8'), 'mine\n');
  // No clone there: nothing to do.
  assert.match(await refreshBaseClone(path.join(root, 'none'), 'origin/develop'), /^no base clone at /);
});

test('w467: repo.refreshMinutes 0 starts no timer', () => {
  const stop = startBaseRefresh({ repo: { basePath: '/nowhere', refreshMinutes: 0 }, defaultBase: 'origin/develop' }, () => assert.fail('no log'));
  stop();
});
