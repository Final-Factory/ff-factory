import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { has, prepush } from './prepush.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const NOREPLY = '1+ci@users.noreply.github.com';

/** A throwaway repository whose origin/main is one clean commit, as a worker's clone looks before it pushes. */
function repo(t: { after: (fn: () => void) => void }): { dir: string; git: (...args: string[]) => string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'prepush-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.name', 'CI');
  git('config', 'user.email', NOREPLY);
  writeFileSync(path.join(dir, 'README.md'), 'clean\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  return { dir, git };
}

// In ci.yml's checks job (Linux) the tools are installed, so a missing one fails the test there instead of skipping it.
// Windows CI does not install them (windows.yml's daily whole-suite run, w910): skipped there.
function need(t: { skip: (msg: string) => void }, tool: string, versionArg?: string): boolean {
  if (has(tool, versionArg)) return true;
  assert.ok(!(process.env.CI && process.platform === 'linux'), `${tool} is missing on the CI runner`);
  t.skip(`${tool} is not installed here`);
  return false;
}

test('prepush identity: a commit with a non-noreply email fails; noreply passes', (t) => {
  const { dir, git } = repo(t);
  writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'fine');
  assert.equal(prepush(dir, 'origin/main', ['identity']), 0);
  writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  git('add', '.');
  git('-c', 'user.email=someone@example.com', 'commit', '--quiet', '-m', 'personal address');
  assert.equal(prepush(dir, 'origin/main', ['identity']), 1);
});

test('prepush gitleaks: a planted fake key in a new commit fails; a clean commit passes', (t) => {
  if (!need(t, 'gitleaks', 'version')) return;
  const { dir, git } = repo(t);
  writeFileSync(path.join(dir, 'clean.ts'), 'export const x = 1;\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'clean');
  assert.equal(prepush(dir, 'origin/main', ['gitleaks']), 0);
  // Assembled here so this file itself carries no key-shaped string for the repository's own scan.
  const key = ['AK', 'IA'].join('') + 'QYLPMN2HJ4K7WXZ3';
  writeFileSync(path.join(dir, 'leak.ts'), `export const awsKey = '${key}';\n`);
  git('add', '.');
  git('commit', '--quiet', '-m', 'planted key');
  assert.equal(prepush(dir, 'origin/main', ['gitleaks']), 1);
});

test('prepush shellcheck: a planted finding in a VM script fails lint.sh --shellcheck-only', (t) => {
  if (!need(t, 'shellcheck') || !need(t, 'bash')) return;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'prepush-sc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(path.join(ROOT, 'deploy'), path.join(dir, 'deploy'), { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  execFileSync('git', ['-c', `user.email=${NOREPLY}`, '-c', 'user.name=CI', 'commit', '--quiet', '--allow-empty', '-m', 'base'], { cwd: dir });
  // The scripts as they are pass shellcheck: CI's VM lint job proves that on every change to them.
  appendFileSync(path.join(dir, 'deploy/vm/host/lib.sh'), '\nplanted() { ls $1 | grep x; }\n');
  assert.equal(prepush(dir, 'HEAD', ['shellcheck']), 1);
});
