import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './config.ts';

/**
 * scripts/update-steps.ps1 when the upstream was rewritten (a force-push that cleaned commit identities):
 * it moves the checkout only when nothing here would be lost, and keeps the old HEAD on a branch.
 */

const onWindows = process.platform === 'win32';

function setup(t: { after: (fn: () => void) => void }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'update-steps-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }));
  const origin = path.join(tmp, 'origin.git');
  const app = path.join(tmp, 'app');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (cwd: string, msg: string, who = 'Someone <someone@example.com>') => {
    const [, name, email] = /^(.*) <(.*)>$/.exec(who)!;
    git(cwd, '-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '-m', msg);
  };
  fs.mkdirSync(path.join(app, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(app, 'web'));
  for (const f of ['common.ps1', 'update-steps.ps1']) fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(app, 'scripts', f));
  const pkg = (name: string) => JSON.stringify({ name, version: '1.0.0', private: true, scripts: { build: 'node -e 0' } });
  const lock = (name: string) => JSON.stringify({ name, version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name, version: '1.0.0' } } });
  fs.writeFileSync(path.join(app, 'package.json'), pkg('app'));
  fs.writeFileSync(path.join(app, 'package-lock.json'), lock('app'));
  fs.writeFileSync(path.join(app, 'web', 'package.json'), pkg('web'));
  fs.writeFileSync(path.join(app, 'web', 'package-lock.json'), lock('web'));
  fs.writeFileSync(path.join(app, '.gitignore'), 'data/\nnode_modules/\nconfig.json\n');
  fs.writeFileSync(path.join(app, 'a.txt'), '1\n');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  git(app, 'init', '-q', '-b', 'main');
  git(app, 'add', '-A');
  commit(app, 'root', 'Public <1+x@users.noreply.github.com>');
  fs.writeFileSync(path.join(app, 'a.txt'), '2\n');
  git(app, 'add', '-A');
  commit(app, 'change', 'Private Person <private@example.com>');
  git(app, 'remote', 'add', 'origin', origin);
  git(app, 'push', '-q', '-u', 'origin', 'main');
  fs.mkdirSync(path.join(app, 'data'));
  fs.writeFileSync(path.join(app, 'data', 'state.json'), 'keep');

  // Rewrite the upstream the way the identity clean-up does: same trees, messages and dates, new identity.
  const rewriteUpstream = (extra?: string) => {
    const work = path.join(tmp, 'rewrite');
    git(tmp, 'clone', '-q', origin, work);
    const root = git(work, 'rev-list', '--max-parents=0', 'HEAD');
    const tip = git(work, 'rev-parse', 'HEAD');
    const env = { ...process.env, GIT_AUTHOR_NAME: 'Public', GIT_AUTHOR_EMAIL: '1+x@users.noreply.github.com', GIT_COMMITTER_NAME: 'Public', GIT_COMMITTER_EMAIL: '1+x@users.noreply.github.com' };
    const rewritten = execFileSync('git', ['commit-tree', `${tip}^{tree}`, '-p', root, '-m', 'change'], { cwd: work, env, encoding: 'utf8' }).trim();
    git(work, 'reset', '-q', '--hard', rewritten);
    if (extra) {
      fs.writeFileSync(path.join(work, 'b.txt'), extra);
      git(work, 'add', '-A');
      commit(work, 'after the rewrite', 'Public <1+x@users.noreply.github.com>');
    }
    git(work, 'push', '-q', '--force-with-lease=main:' + tip, 'origin', 'HEAD:main');
    return git(work, 'rev-parse', 'HEAD');
  };
  const update = () => {
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(app, 'scripts', 'update-steps.ps1')], { cwd: app, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { ok: true, out };
    } catch (e) {
      const x = e as { stdout?: string; stderr?: string };
      return { ok: false, out: `${x.stdout ?? ''}${x.stderr ?? ''}` };
    }
  };
  return { app, git, commit, rewriteUpstream, update };
}

test('update-steps: a rewritten upstream with the same content moves the checkout and keeps the old HEAD', { skip: !onWindows && 'Windows only', timeout: 120_000 }, (t) => {
  const { app, git, rewriteUpstream, update } = setup(t);
  const oldHead = git(app, 'rev-parse', 'HEAD');
  const newTip = rewriteUpstream('new work\n');
  const r = update();
  assert.ok(r.ok, r.out);
  assert.equal(git(app, 'rev-parse', 'HEAD'), newTip);
  const backup = git(app, 'branch', '--list', 'pre-rewrite-*', '--format=%(refname:short)');
  assert.match(backup, /^pre-rewrite-\d{8}-\d{6}$/);
  assert.equal(git(app, 'rev-parse', backup), oldHead);
  assert.equal(fs.readFileSync(path.join(app, 'data', 'state.json'), 'utf8'), 'keep');
});

test('update-steps: a rewritten upstream is refused when a local commit or a local edit would be lost', { skip: !onWindows && 'Windows only', timeout: 120_000 }, (t) => {
  const { app, git, commit, rewriteUpstream, update } = setup(t);
  fs.writeFileSync(path.join(app, 'local.txt'), 'only here\n');
  git(app, 'add', '-A');
  commit(app, 'local only');
  const head = git(app, 'rev-parse', 'HEAD');
  rewriteUpstream();
  const r = update();
  assert.equal(r.ok, false);
  assert.match(r.out, /1 commit\(s\) the upstream has no equivalent of/);
  assert.equal(git(app, 'rev-parse', 'HEAD'), head);

  git(app, 'reset', '-q', '--hard', 'HEAD~1');
  fs.writeFileSync(path.join(app, 'a.txt'), 'edited here\n');
  const r2 = update();
  assert.equal(r2.ok, false);
  assert.match(r2.out, /tracked files are modified here/);
  assert.equal(fs.readFileSync(path.join(app, 'a.txt'), 'utf8'), 'edited here\n');
});
