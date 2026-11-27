import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REMOTE_GUARD, allowedRemote, guardRemote, guardRemoteSync, redact, remoteProblem } from './remoteGuard.ts';
import { saveWork } from './saveWork.ts';
import { switchBranch } from './switchBranch.ts';
import { run } from './proc.ts';
import { realFfuSlotDeps, takeSlot } from '../machine/ffuSlots.ts';

// w6099 (w6091's review of #1367, follow-up A): a worker can point a sandbox's origin at a bare repository it planted on
// the disk; the daemon's push then runs that repository's receive-pack, its hooks and config, outside safeGit's fence.

const hasGit = spawnSync('git', ['--version']).status === 0;
const slash = (p: string) => p.replace(/\\/g, '/');
// Other test files import server/testLocalRemotes.ts to push to a bare repository in a temp folder; this one never does.
(globalThis as { ffTestLocalRemotes?: boolean }).ffTestLocalRemotes = false;

test('w6099: only GitHub over https or ssh is a remote the daemon uses', () => {
  for (const u of ['https://github.com/Final-Factory/ff-factory.git', 'https://github.com/Final-Factory/ffu', 'git@github.com:Final-Factory/FinalFactory.git', 'ssh://git@github.com/Final-Factory/ffu.git', 'https://x-access-token:FAKE@github.com/o/r.git'])
    assert.equal(allowedRemote(u), true, u);
  for (const u of ['F:/ffw/planted.git', '/home/w/planted.git', 'file:///F:/ffw/planted.git', '../planted', 'http://github.com/o/r.git', 'https://github.com.evil.example/o/r.git', 'https://gitlab.com/o/r.git', 'ext::sh -c x', ''])
    assert.equal(allowedRemote(u), false, u);
});

test('w6099: a fetch or push URL that is not GitHub is named, with no user name, password or query in the message', () => {
  const gh = 'https://github.com/o/r.git\n';
  assert.equal(remoteProblem('origin', gh, gh), undefined);
  assert.equal(remoteProblem('origin', `${gh}git@github.com:o/r.git\n`, gh), undefined, 'several GitHub URLs are fine');
  assert.match(remoteProblem('origin', gh, 'F:/ffw/planted.git\n')!, /origin points at F:\/ffw\/planted\.git, not a GitHub repository/, 'a planted pushurl alone');
  assert.match(remoteProblem('origin', 'file:///x.git\n', gh)!, /file:\/\/\/x\.git/, 'a planted fetch URL');
  const tok = remoteProblem('origin', 'https://user:FAKESECRET@evil.example/r.git\n', gh)!;
  assert.match(tok, /https:\/\/evil\.example\/r\.git/);
  assert.doesNotMatch(tok, /FAKESECRET|user:/, 'no credential in the message');
  assert.equal(redact('https://a:b@github.com/o/r'), 'https://github.com/o/r');
  // w6112's review, finding A: the scp form, a second @ and a query string carried a token past the first redact.
  assert.equal(redact('x-access-token:FAKESECRET@evil.example:o/r.git'), 'evil.example:o/r.git');
  assert.equal(redact('https://a@FAKESECRET@evil.example/r.git'), 'https://evil.example/r.git');
  assert.equal(redact('https://evil.example/r.git?access_token=FAKESECRET#FAKESECRET'), 'https://evil.example/r.git');
  // w6148's review of #1389: the user info ends at the first `/`, so a `?` or `#` in a password is still user info.
  assert.equal(redact('https://u:FAKE?PW@evil.example/r.git'), 'https://evil.example/r.git');
  assert.equal(redact('https://u:FAKE#PW@evil.example/r.git'), 'https://evil.example/r.git');
  assert.equal(redact('F:\\ffw\\planted.git'), 'F:\\ffw\\planted.git');
  assert.equal(redact('F:/ffw/planted.git'), 'F:/ffw/planted.git');
  assert.equal(redact('file:///F:/ffw/planted.git'), 'file:///F:/ffw/planted.git');
  // Finding C: each message names the fix, and a checkout with no origin is told to add one.
  assert.match(remoteProblem('origin', undefined, gh)!, /could not read origin's URL .*git remote -v.*git remote set-url origin/);
  assert.match(remoteProblem('origin', undefined, undefined, undefined, 'upstream\n')!, /no remote named origin, so git would take "origin" for a folder in it .*git remote add origin/);
  assert.equal(remoteProblem('origin', gh, gh, undefined, 'origin\nupstream\n'), undefined);
  assert.match(remoteProblem('origin', '', '')!, /no URL/);
});

test('w6099: enforced: a planted URL is refused, the sync check agrees, and a GitHub origin passes', async () => {
  assert.equal(REMOTE_GUARD, 'enforce', '#1371 shipped it warn-only first (lockout rule)');
  const planted = (a: string[]) => (a.length === 1 ? 'origin\n' : a.includes('--push') ? 'F:/ffw/planted.git\n' : 'https://github.com/o/r.git\n');
  assert.match((await guardRemote(async (a) => planted(a), 'a push in X'))!, /^refused by FF Factory: origin points at F:\/ffw\/planted\.git/);
  assert.match(guardRemoteSync(planted, 'a push in Y')!, /^refused by FF Factory: origin points at F:\/ffw\/planted\.git/);
  assert.equal(await guardRemote(async (a) => (a.length === 1 ? 'origin\n' : 'https://github.com/o/r.git\n'), 'a push in Z'), undefined);
  assert.match(guardRemoteSync(() => undefined, 'a push in W')!, /could not read origin's URL/);
});

test('w6099: a sandbox whose origin is a planted bare repository with a hook: the save commits and refuses the push, the switch refuses, and the hook never runs', { skip: !hasGit }, async () => {
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

    const head = git(work, 'rev-parse', 'HEAD').trim();
    fs.writeFileSync(path.join(work, 'a.txt'), 'two\n');
    const saved = await saveWork({ dir: work, branch: 'w1-feature', message: 'save' });
    assert.equal(saved.pushed, false);
    assert.match(saved.notes.join('\n'), new RegExp(`not pushed \\(refused by FF Factory: origin points at ${slash(planted).replace(/[.]/g, '\\.')}`));
    assert.notEqual(git(work, 'rev-parse', 'HEAD').trim(), head, 'the work is committed here');
    assert.equal(git(work, 'status', '--porcelain'), '', 'and nothing is left uncommitted');
    await assert.rejects(switchBranch({ dir: work, branch: 'w2-other', createFrom: 'HEAD' }), /refused by FF Factory: origin points at .*; nothing was switched/);
    assert.equal(git(work, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'w1-feature');
    assert.equal(fs.existsSync(marker), false, 'the planted hook never ran');
    assert.equal(spawnSync('git', ['--git-dir', planted, 'rev-parse', '--verify', '--quiet', 'refs/heads/w1-feature']).status, 1, 'nothing reached the planted repository');

    // Recovery needs nobody at the machine: the worker sets origin back, and the guard lets it through.
    const check = () =>
      guardRemote(async (a) => {
        const g = await run('git', ['-C', work, ...a]);
        return g.code === 0 ? g.stdout : undefined;
      }, 'x');
    git(work, 'remote', 'remove', 'origin');
    assert.match((await check())!, /no remote named origin/, 'with no origin it is refused too, and told to add one');
    git(work, 'remote', 'add', 'origin', 'https://github.com/Final-Factory/example.git');
    assert.equal(await check(), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('w6099: ffu-slot take refuses to fetch the shared clone from an origin that is not GitHub, and names the clone', { skip: !hasGit }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'remoteguard-ffu-'));
  try {
    const work = path.join(base, 'src');
    const git = (cwd: string, ...a: string[]) => assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@users.noreply.github.com', ...a], { cwd, encoding: 'utf8' }).status, 0, a.join(' '));
    fs.mkdirSync(work);
    git(work, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(work, 'Cargo.toml'), '[workspace]\n');
    git(work, 'add', '.');
    git(work, 'commit', '-qm', 'one');
    const planted = path.join(base, 'planted.git');
    git(base, 'clone', '-q', '--bare', work, planted);
    const root = path.join(base, 'install');
    fs.mkdirSync(root);
    const d = { ...realFfuSlotDeps({ FF_WORKER_ROOT: root, FF_SESSION_ID: 'take0001' }), max: 2, freeGB: () => 500, write: () => {}, say: () => {} };
    assert.throws(() => takeSlot(d, { remote: planted }), /the shared clone in .* was not fetched: refused by FF Factory: origin points at /);
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  }
});
