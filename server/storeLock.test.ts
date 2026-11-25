import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GRACE_MS, STORE_CHILD, daemonGit, daemonGitBusy, decideStoreLock, ignoredStorePath, storeGitFolder, storeLockLine, storeLockSetting, watchStore } from '../machine/storeLock.ts';
import { isSlotRepo } from '../machine/slotRepo.ts';
import { isLabelledLow, isLabelledMedium, lowTargets, labelLow, lowCopy, type Exec } from '../machine/lowIntegrity.ts';
import { FF_LANDLOCK, writeLockArgs } from '../machine/writeLock.ts';
import { fenceFor, seatbeltProfile } from './workerFence.ts';

// w5614 (stage 1 of w5544): the store lock. Once every sandbox is a slot repo the fences leave the main clone read-only.

const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A root with a store at root/repo (one commit) and, per name, a slot repo (alternates) or a worktree in root/sandboxes. */
function makeRoot(o: { slots?: string[]; worktrees?: string[] } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'w5614-')));
  const root = path.join(base, 'root');
  const repo = path.join(root, STORE_CHILD);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-qm', 'one');
  fs.mkdirSync(path.join(root, 'sandboxes'));
  const sandboxes: { id: string; path: string }[] = [];
  for (const id of o.slots ?? []) {
    const p = path.join(root, 'sandboxes', id);
    git(root, 'clone', '-q', '--shared', repo, p);
    sandboxes.push({ id, path: p });
  }
  for (const id of o.worktrees ?? []) {
    const p = path.join(root, 'sandboxes', id);
    git(repo, 'worktree', 'add', '-q', '-b', `b-${id}`, p);
    sandboxes.push({ id, path: p });
  }
  return { base, root, repo, sandboxes, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('the setting: anything but "warn" or "on" is off, and off decides nothing', () => {
  assert.equal(storeLockSetting(undefined), 'off');
  assert.equal(storeLockSetting('yes'), 'off');
  assert.equal(storeLockSetting('warn'), 'warn');
  assert.equal(storeLockSetting('on'), 'on');
  assert.deepEqual(decideStoreLock({ repoPath: '/nowhere', sandboxes: [], isSlotRepo: () => false }), { setting: 'off', locked: false, watch: false, blockers: [] });
  assert.equal(storeLockLine({ setting: 'off', locked: false, watch: false, blockers: [] }), undefined);
});

test('the store git folder: .git of a clone, the folder of a bare repo, nothing for an empty folder', () => {
  const has = (...ps: string[]) => (p: string) => ps.includes(p);
  const R = path.resolve('/r/repo');
  assert.equal(storeGitFolder(R, has(path.join(R, '.git', 'HEAD'))), path.join(R, '.git'));
  assert.equal(storeGitFolder(R, has(path.join(R, 'HEAD'), path.join(R, 'objects'))), R);
  assert.equal(storeGitFolder(R, has()), undefined);
});

test('"on" locks when every sandbox is a slot repo; a worktree or a non-slot sandbox holds it off, and says which', () => {
  const ok = makeRoot({ slots: ['slot1', 'slot2'] });
  try {
    const d = decideStoreLock({ setting: 'on', root: ok.root, repoPath: ok.repo, sandboxes: ok.sandboxes, isSlotRepo });
    assert.deepEqual(d.blockers, []);
    assert.equal(d.locked, true);
    assert.equal(d.watch, false);
    assert.equal(fs.realpathSync(d.gitDir!), path.join(ok.repo, '.git'));
    assert.match(storeLockLine(d)!, /store lock: on;.*read-only to sandbox workers/);
    // "warn" refuses nothing but watches, and says it would apply.
    const w = decideStoreLock({ setting: 'warn', root: ok.root, repoPath: ok.repo, sandboxes: ok.sandboxes, isSlotRepo });
    assert.equal(w.locked, false);
    assert.equal(w.watch, true);
    assert.match(storeLockLine(w)!, /warn only;.*would apply now/);
  } finally {
    ok.done();
  }
  const mixed = makeRoot({ slots: ['slot1'], worktrees: ['slot2'] });
  try {
    const plain = path.join(mixed.root, 'sandboxes', 'slot3');
    fs.mkdirSync(plain);
    const d = decideStoreLock({ setting: 'on', root: mixed.root, repoPath: mixed.repo, sandboxes: [...mixed.sandboxes, { id: 'slot3', path: plain }], isSlotRepo });
    assert.equal(d.locked, false);
    assert.equal(d.watch, true, 'held off: the writes are logged instead');
    assert.equal(d.blockers.length, 2, d.blockers.join(' | '));
    assert.match(d.blockers[0], /1 worktree of the main clone still there \(slot2\)/);
    assert.match(d.blockers[1], /sandbox slot3 not a slot repo/, 'the worktree is named once, not again as a non-slot sandbox');
    assert.match(storeLockLine(d)!, /on asked, but held off/);
    // A worktree whose folder is gone does not hold it.
    fs.rmSync(mixed.sandboxes[1].path, { recursive: true, force: true });
    fs.rmSync(plain, { recursive: true, force: true });
    assert.equal(decideStoreLock({ setting: 'on', root: mixed.root, repoPath: mixed.repo, sandboxes: mixed.sandboxes, isSlotRepo }).locked, true);
  } finally {
    mixed.done();
  }
});

test('"on" stays off for a main clone outside <root>/repo, no root, no git folder, or an OS with no fence', () => {
  const base = { setting: 'on', sandboxes: [], isSlotRepo: () => true, exists: (p: string) => p.endsWith(path.join('.git', 'HEAD')), readDir: () => [] };
  const root = path.resolve('/ffw');
  const elsewhere = decideStoreLock({ ...base, root, repoPath: path.resolve('/src/FinalFactory') });
  assert.equal(elsewhere.locked, false);
  assert.match(elsewhere.blockers.join(), /is not .*the folder the fences close/);
  assert.match(decideStoreLock({ ...base, repoPath: path.join(root, 'repo') }).blockers.join(), /no worker root/);
  assert.match(decideStoreLock({ ...base, root, repoPath: path.join(root, 'repo'), exists: () => false }).blockers.join(), /no git folder/);
  assert.match(decideStoreLock({ ...base, root, repoPath: path.join(root, 'repo'), platform: 'freebsd' }).blockers.join(), /no fence on freebsd/);
  assert.equal(decideStoreLock({ ...base, root, repoPath: path.join(root, 'repo'), platform: 'linux' }).locked, true);
});

test('the fences: with lockStore, repo leaves the Seatbelt and Landlock write sets, and its git folder is Medium on Windows', () => {
  const root = path.resolve('/Users/p/ffw');
  const mac = (lockStore: boolean) => fenceFor({ setting: 'seatbelt', root, platform: 'darwin', home: '/Users/p', lockStore, exists: () => true, getconf: (n) => `/t/${n}` })!;
  const repoRule = `(subpath "${path.join(root, 'repo')}")`;
  assert.ok(seatbeltProfile(mac(false)).includes(repoRule));
  assert.ok(!seatbeltProfile(mac(true)).includes(repoRule), 'locked: repo is not writable');
  assert.ok(seatbeltProfile(mac(true)).includes(`(subpath "${path.join(root, 'sandboxes')}")`), 'the slots still are');
  // path.join throughout (w5764's review): the file runs on Windows too.
  const L = path.resolve('/home/u/ffw');
  const lin = (lockStore: boolean) => writeLockArgs({ root: L, lockStore });
  assert.ok(lin(false).includes(path.join(L, 'repo')));
  assert.ok(!lin(true).includes(path.join(L, 'repo')));
  assert.ok(lin(true).includes(path.join(L, 'sandboxes')));
  const W = path.resolve('/ffw');
  const kids = ['repo', 'sandboxes', 'tmp'].map((name) => ({ name, dir: true }));
  const open = lowTargets({ root: W, appDir: path.join(W, 'daemon'), children: kids, exists: () => true });
  assert.ok(open.dirs.includes(path.join(W, 'repo', '.git')));
  const locked = lowTargets({ root: W, appDir: path.join(W, 'daemon'), children: kids, exists: () => true, lockStore: true });
  assert.ok(!locked.dirs.includes(path.join(W, 'repo', '.git')));
  assert.ok(locked.medium.includes(path.join(W, 'repo', '.git')), 'relabelled Medium: the way back from an earlier Low label');
  assert.ok(locked.dirs.includes(path.join(W, 'sandboxes')));
});

test('the watch logs a write the daemon did not make, once per path an hour, and none while daemon git runs', async () => {
  assert.ok(ignoredStorePath('index.lock') && ignoredStorePath('worktrees/s1/HEAD') && ignoredStorePath('FETCH_HEAD') && ignoredStorePath('logs\\HEAD'));
  assert.ok(!ignoredStorePath('refs/heads/main') && !ignoredStorePath('config') && !ignoredStorePath('objects/ab/cd'));
  // daemonGit counts its call and a grace after it.
  let release!: () => void;
  const p = daemonGit(new Promise<void>((r) => (release = r)));
  assert.equal(daemonGitBusy(), true);
  release();
  await p;
  assert.equal(daemonGitBusy(), true, 'within the grace');
  assert.equal(daemonGitBusy(Date.now() + GRACE_MS + 1), false);
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'w5614w-')));
  fs.mkdirSync(path.join(dir, 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config'), '');
  const said: string[] = [];
  let busy = true;
  const stop = watchStore(dir, (l) => void said.push(l), { busy: () => busy });
  try {
    const waitFor = async (n: number) => {
      for (let i = 0; i < 100 && said.length < n; i++) await new Promise((r) => setTimeout(r, 30));
    };
    fs.writeFileSync(path.join(dir, 'refs', 'heads', 'daemon'), 'x');
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(said, [], 'the daemon\'s own write is not logged');
    busy = false;
    fs.writeFileSync(path.join(dir, 'refs', 'heads', 'worker'), 'x');
    await waitFor(1);
    assert.equal(said.length, 1, said.join('\n'));
    assert.match(said[0], /store lock \(warn\): .*refs.*changed while the daemon ran no git/);
    fs.writeFileSync(path.join(dir, 'refs', 'heads', 'worker2'), 'y');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(said.length, 1, 'once per path an hour');
    fs.writeFileSync(path.join(dir, 'config'), '[ff]');
    await waitFor(2);
    assert.equal(said.length, 2, said.join('\n'));
    assert.match(said[1], /config changed/);
  } finally {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const landlock = process.platform === 'linux' && spawnSync('python3', [FF_LANDLOCK, '--', 'true']).status === 0;

test('live (Linux): under the locked write set a slot repo commits, and the store\'s config, refs and objects are refused', { skip: !landlock && 'needs Linux with Landlock' }, () => {
  const r0 = makeRoot({ slots: ['slotA', 'slotB'] });
  try {
    const a = r0.sandboxes[0].path;
    const g = path.join(r0.repo, '.git');
    const script = [
      'try() { if eval "$2" >/dev/null 2>&1; then echo "$1 ok"; else echo "$1 refused"; fi; }',
      `try commit "cd ${a} && echo b > b.txt && git -c user.name=t -c user.email=t@t -c commit.gpgsign=false add b.txt && git -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -qm two"`,
      `try store-config "git -C ${r0.repo} config ff.x 1"`,
      `try store-ref "touch ${g}/refs/heads/evil"`,
      `try store-object "touch ${g}/objects/evil"`,
      `try store-git-ref "git -C ${r0.repo} branch evil"`,
    ].join('\n');
    const args = writeLockArgs({ root: r0.root, lockStore: true, extra: ['/dev/null'] });
    const r = spawnSync('python3', [FF_LANDLOCK, ...args, '--', 'bash', '-c', script], { encoding: 'utf8', env: { ...process.env, HOME: r0.base } });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split('\n'), ['commit ok', 'store-config refused', 'store-ref refused', 'store-object refused', 'store-git-ref refused']);
    assert.equal(git(a, 'log', '-1', '--format=%s'), 'two');
    assert.ok(!fs.existsSync(path.join(g, 'refs', 'heads', 'evil')));
    // Unlocked (the way back), the same store write goes through.
    const open = spawnSync('python3', [FF_LANDLOCK, ...writeLockArgs({ root: r0.root }), '--', 'bash', '-c', `touch ${g}/refs/heads/back`], { encoding: 'utf8' });
    assert.equal(open.status, 0, open.stderr);
  } finally {
    r0.done();
  }
});

const realExec: Exec = async (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' } as never;
};

/**
 * A Low process: a Low-labelled copy of cmd.exe running one line. windowsVerbatimArguments (w5764's review, measured on
 * lothdesktop): without it node quotes the line and cmd.exe rejects every one, exit 1 with nothing written, so a
 * "refused" check passed with no lock at all. Every leg below therefore also proves the same shell writes where it may.
 */
const lowShell = (cmd: string) => (line: string) => spawnSync(cmd, ['/d', '/s', '/c', `"${line}"`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true });

test('live (Windows): a Low process writes its slot repo and is refused in the Medium store; store_lock off labels it Low again and a Low git commit in a worktree of it goes through', { skip: process.platform !== 'win32' && 'needs Windows' }, async () => {
  const r0 = makeRoot({ slots: ['slotA'] });
  try {
    const g = path.join(r0.repo, '.git');
    const a = r0.sandboxes[0].path;
    const children = [STORE_CHILD, 'sandboxes'].map((name) => ({ name, dir: true }));
    const targets = (lockStore: boolean) => lowTargets({ root: r0.root, appDir: path.join(r0.root, 'daemon'), children, lockStore });
    const label = async (p: string) => (await realExec('icacls', [p])).stdout;
    const said: string[] = [];
    // Before the lock: labelled as the daemon did (the store's git folder Low), then the lock's labelling, so the relabel is proven.
    assert.equal(await labelLow(targets(false), realExec, (l) => void said.push(l)), true, said.join('\n'));
    assert.ok(isLabelledLow(await label(g)), 'unlocked: the store is Low');
    const locked = targets(true);
    assert.ok(locked.medium.includes(g));
    assert.equal(await labelLow(locked, realExec, (l) => void said.push(l)), true, said.join('\n'));
    assert.ok(isLabelledMedium(await label(g)), `locked: the store reads Medium\n${await label(g)}`);
    const cmd = await lowCopy(r0.base, path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), realExec, (l) => void said.push(l));
    assert.ok(cmd, said.join('\n'));
    const low = lowShell(cmd!);
    const ok = low(`echo x> "${path.join(a, 'low.txt')}"`);
    assert.equal(ok.status, 0, `the Low shell writes its slot repo: ${ok.stderr}`);
    assert.ok(fs.existsSync(path.join(a, 'low.txt')), 'and the file is there: the shell really ran the line');
    const cfgBefore = fs.readFileSync(path.join(g, 'config'), 'utf8');
    for (const line of [`echo x> "${path.join(g, 'refs', 'heads', 'evil')}"`, `echo x>> "${path.join(g, 'config')}"`, `echo x> "${path.join(g, 'objects', 'evil')}"`]) {
      assert.notEqual(low(line).status, 0, line);
    }
    assert.ok(!fs.existsSync(path.join(g, 'refs', 'heads', 'evil')));
    assert.ok(!fs.existsSync(path.join(g, 'objects', 'evil')));
    assert.equal(fs.readFileSync(path.join(g, 'config'), 'utf8'), cfgBefore);

    // The way back: store_lock off, and the daemon's next labelling turns the store's git folder Low again.
    assert.equal(await labelLow(targets(false), realExec, (l) => void said.push(l)), true, said.join('\n'));
    assert.ok(isLabelledLow(await label(g)), `unlocked again: the store is Low\n${await label(g)}`);
    const back = low(`echo x> "${path.join(g, 'refs', 'heads', 'back')}"`);
    assert.equal(back.status, 0, `the Low write into the store goes through again: ${back.stderr}`);
    // A worktree of the store (a sandbox before slot repos) commits at Low: its index, HEAD and refs live in the store.
    const wt = path.join(r0.root, 'sandboxes', 'wt');
    git(r0.repo, 'worktree', 'add', '-q', '-b', 'b-wt', wt);
    fs.writeFileSync(path.join(wt, 'c.txt'), 'c\n');
    const gitc = `git -c user.name=t -c user.email=t@t -c commit.gpgsign=false -c safe.directory=* -C "${wt}"`;
    const commit = low(`${gitc} add c.txt && ${gitc} commit -qm low-commit`);
    assert.equal(commit.status, 0, `a Low git commit in a worktree: ${commit.stdout}${commit.stderr}`);
    assert.equal(git(wt, 'log', '-1', '--format=%s'), 'low-commit');
  } finally {
    r0.done();
  }
});
