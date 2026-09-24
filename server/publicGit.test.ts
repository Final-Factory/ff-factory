import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearVisibilityCache, githubSlug, publicIdentityEnv, repoIsPublic } from './publicGit.ts';

test('public repos: gh first, then the anonymous API, cached', () => {
  clearVisibilityCache();
  const calls: string[] = [];
  const answers: Record<string, string | undefined> = {
    'gh repos/o/pub': 'false\n',
    'gh repos/o/priv': 'true\n',
    'gh repos/o/nogh': undefined,
    'curl o/nogh': '200',
    'gh repos/o/gone': undefined,
    'curl o/gone': '404',
  };
  const run = (cmd: string, args: string[]) => {
    const key = cmd === 'gh' ? `gh ${args[1]}` : `curl ${args.at(-1)!.replace('https://api.github.com/repos/', '')}`;
    calls.push(key);
    return answers[key];
  };
  const NOW = Date.parse('2026-09-24T18:00:00Z');
  assert.equal(repoIsPublic('github.com/o/pub', NOW, run), true);
  assert.equal(repoIsPublic('github.com/o/priv', NOW, run), false);
  assert.equal(repoIsPublic('github.com/o/nogh', NOW, run), true);
  assert.equal(repoIsPublic('github.com/o/gone', NOW, run), false);
  assert.equal(repoIsPublic('gitlab.com/o/x', NOW, run), undefined);
  const n = calls.length;
  assert.equal(repoIsPublic('github.com/o/pub', NOW + 3_600_000, run), true);
  assert.equal(calls.length, n, 'cached');
  assert.equal(repoIsPublic('github.com/o/priv', NOW + 2 * 3_600_000, run), false);
  assert.equal(calls.length, n + 1, 'a private answer is re-checked after an hour');
  assert.equal(githubSlug('git@github.com:Final-Factory/ff-factory.git'), 'Final-Factory/ff-factory');
  assert.equal(githubSlug('https://github.com/Final-Factory/ff-factory'), 'Final-Factory/ff-factory');
});

test('public repos: agents commit as the public identity in public clones, their own identity elsewhere', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pubgit-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const env = publicIdentityEnv({ name: 'Public Name', email: '1+pub@users.noreply.github.com' }, ['Org/public-kit'], path.join(tmp, 'id.gitconfig'), { GIT_CONFIG_COUNT: '1' });
  assert.equal(env.GIT_CONFIG_COUNT, '4', 'appended after the entries already in the environment');
  const base = { ...process.env, GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false', ...env };
  const email = (remote: string) => {
    const dir = path.join(tmp, remote.replace(/\W+/g, '_'));
    execFileSync('git', ['init', '-q', dir]);
    execFileSync('git', ['-C', dir, 'config', 'user.email', 'person@example.com']);
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remote]);
    return execFileSync('git', ['-C', dir, 'config', 'user.email'], { encoding: 'utf8', env: base }).trim();
  };
  assert.equal(email('https://github.com/Org/public-kit.git'), '1+pub@users.noreply.github.com');
  assert.equal(email('git@github.com:Org/public-kit.git'), '1+pub@users.noreply.github.com');
  assert.equal(email('https://github.com/Org/private-game.git'), 'person@example.com');
});
