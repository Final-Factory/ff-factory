import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearVisibilityCache, gitIdentityEnv, githubSlug, repoIsPublic } from './publicGit.ts';
import { buildOptions, type LaunchSpec } from './launch.ts';

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

// w3093: four workers in two days had a push refused by GitHub's email-privacy rule after committing in a fresh clone of a
// private repo (ffu) with the machine's global, private email; the identity used to reach public repos only.
test('git identity: a worker commits as the noreply identity in every clone, over the global and the clone\'s own identity', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pubgit-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const global = path.join(tmp, 'owner.gitconfig');
  fs.writeFileSync(global, '[user]\n\tname = Owner\n\temail = owner-private@example.com\n');
  const spec: LaunchSpec = { cwd: tmp, settingSources: [], append: '', strictMcp: true, guard: { id: 'x', ownPath: tmp, protectedPaths: [], gameRepos: [] }, publicGit: { name: 'Final Factory', email: '1+pub@users.noreply.github.com', repos: [] } };
  // The daemon's own environment: the owner's global config, and a command-scope entry already there (kept, appended after).
  const daemonEnv = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' };
  const env = buildOptions(spec, {}, daemonEnv).env as NodeJS.ProcessEnv;
  assert.equal(env.GIT_CONFIG_COUNT, '3');
  assert.equal(env.GIT_CONFIG_KEY_0, 'core.autocrlf', 'an entry already given is kept');
  const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env }).trim();
  const commit = (name: string, setup: (dir: string) => void) => {
    const dir = path.join(tmp, name);
    execFileSync('git', ['init', '-q', dir], { env });
    setup(dir);
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'x');
    return git(dir, 'log', '-1', '--format=%an <%ae> %ce');
  };
  const want = 'Final Factory <1+pub@users.noreply.github.com> 1+pub@users.noreply.github.com';
  assert.equal(commit('private-clone', (d) => git(d, 'remote', 'add', 'origin', 'https://github.com/Org/private-engine.git')), want, 'a fresh clone of a private repo');
  assert.equal(commit('own-identity', (d) => git(d, 'config', 'user.email', 'owner-private@example.com')), want, "over a clone's own user.email (a main clone's)");
  assert.equal(commit('no-remote', () => {}), want, 'a repo with no remote');
  // A worker that means another identity still says so on the command line.
  const dir = path.join(tmp, 'no-remote');
  git(dir, '-c', 'user.email=chosen@example.com', 'commit', '-q', '--allow-empty', '-m', 'y');
  assert.equal(git(dir, 'log', '-1', '--format=%ae'), 'chosen@example.com');
  // Without an identity in the spec, nothing is added.
  assert.equal(gitIdentityEnv({ name: '', email: '' }, daemonEnv).GIT_CONFIG_COUNT, undefined);
});
