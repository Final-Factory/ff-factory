import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REMOTE_GUARD, allowedRemote, guardRemote, guardRemoteSync, redact, remoteProblem } from './remoteGuard.ts';
import { saveWork } from './saveWork.ts';
import { run } from './proc.ts';

// w6099 (w6091's review of #1367, follow-up A): a worker can point a sandbox's origin at a bare repository it planted on
// the disk; the daemon's push then runs that repository's receive-pack, its hooks and config, outside safeGit's fence.

const hasGit = spawnSync('git', ['--version']).status === 0;
const slash = (p: string) => p.replace(/\\/g, '/');

test('w6099: only GitHub over https or ssh is a remote the daemon uses', () => {
  for (const u of ['https://github.com/Final-Factory/ff-factory.git', 'https://github.com/Final-Factory/ffu', 'git@github.com:Final-Factory/FinalFactory.git', 'ssh://git@github.com/Final-Factory/ffu.git', 'https://x-access-token:FAKE@github.com/o/r.git'])
    assert.equal(allowedRemote(u), true, u);
  for (const u of ['F:/ffw/planted.git', '/home/w/planted.git', 'file:///F:/ffw/planted.git', '../planted', 'http://github.com/o/r.git', 'https://github.com.evil.example/o/r.git', 'https://gitlab.com/o/r.git', 'ext::sh -c x', ''])
    assert.equal(allowedRemote(u), false, u);
});

test('w6099: a fetch or push URL that is not GitHub is named, with no user name or password in the message', () => {
  const gh = 'https://github.com/o/r.git\n';
  assert.equal(remoteProblem('origin', gh, gh), undefined);
  assert.equal(remoteProblem('origin', `${gh}git@github.com:o/r.git\n`, gh), undefined, 'several GitHub URLs are fine');
  assert.match(remoteProblem('origin', gh, 'F:/ffw/planted.git\n')!, /origin points at F:\/ffw\/planted\.git, not a GitHub repository/, 'a planted pushurl alone');
  assert.match(remoteProblem('origin', 'file:///x.git\n', gh)!, /file:\/\/\/x\.git/, 'a planted fetch URL');
  const tok = remoteProblem('origin', 'https://user:FAKESECRET@evil.example/r.git\n', gh)!;
  assert.match(tok, /https:\/\/evil\.example\/r\.git/);
  assert.doesNotMatch(tok, /FAKESECRET|user:/, 'no credential in the message');
  assert.equal(redact('https://a:b@github.com/o/r'), 'https://github.com/o/r');
  assert.match(remoteProblem('origin', undefined, gh)!, /could not read origin's URL/);
  assert.match(remoteProblem('origin', '', '')!, /no URL/);
});

test('w6099: warn-only for now: a problem is logged and the call goes on; the sync check agrees', async (t) => {
  assert.equal(REMOTE_GUARD, 'warn', 'enforcing is its own PR (lockout rule)');
  const warned: string[] = [];
  t.mock.method(console, 'warn', (m: string) => warned.push(m));
  const planted = (a: string[]) => (a.includes('--push') ? 'F:/ffw/planted.git\n' : 'https://github.com/o/r.git\n');
  assert.equal(await guardRemote(async (a) => planted(a), 'a push in X'), undefined);
  assert.equal(guardRemoteSync(planted, 'a push in Y'), undefined);
  assert.equal(warned.length, 2);
  assert.match(warned[0], /^remote guard \(w6099, warn-only\): would refuse a push in X: origin points at F:\/ffw\/planted\.git/);
  assert.equal(await guardRemote(async () => 'https://github.com/o/r.git\n', 'a push in Z'), undefined);
  assert.equal(warned.length, 2, 'a GitHub origin logs nothing');
});

test('w6099: a sandbox whose origin is a planted bare repository with a hook: the save is logged as one the guard would refuse', { skip: !hasGit }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remoteguard-'));
  try {
    const marker = slash(path.join(root, 'ran.txt'));
    const git = (cwd: string, ...a: string[]) => {
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@users.noreply.github.com', ...a], { cwd, encoding: 'utf8' });
      assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
      return r.stdout;
    };
    const planted = path.join(root, 'planted.git');
    git(root, 'init', '-q', '--bare', planted);
    fs.writeFileSync(path.join(planted, 'hooks', 'pre-receive'), `#!/bin/sh\necho "pre-receive $*" >> '${marker}'\ncat >/dev/null\nexit 0\n`, { mode: 0o755 });
    const work = path.join(root, 'work');
    git(root, 'init', '-q', '-b', 'w1-feature', work);
    fs.writeFileSync(path.join(work, 'a.txt'), 'one\n');
    git(work, 'add', '.');
    git(work, 'commit', '-qm', 'init');
    git(work, 'remote', 'add', 'origin', 'https://github.com/Final-Factory/example.git');
    git(work, 'config', 'remote.origin.pushurl', slash(planted));

    // Control: the daemon's fenced push runs the planted repository's hook (the hole w6099 closes; safeGit cannot reach it).
    const ctl = await run('git', ['-C', work, 'push', '-q', 'origin', 'w1-feature:refs/heads/control']);
    assert.equal(ctl.code, 0, ctl.stderr);
    assert.match(fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '', /pre-receive/, 'the planted hook ran from a fenced push');
    fs.rmSync(marker, { force: true });

    const warned: string[] = [];
    t.mock.method(console, 'warn', (m: string) => warned.push(m));
    fs.writeFileSync(path.join(work, 'a.txt'), 'two\n');
    await saveWork({ dir: work, branch: 'w1-feature', message: 'save' });
    assert.equal(warned.length, 1, warned.join('\n'));
    assert.match(warned[0], new RegExp(`would refuse the save's push in .*work: origin points at ${slash(planted).replace(/[.]/g, '\\.')}`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
