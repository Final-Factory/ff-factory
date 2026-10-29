import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { branchNow, handBackBranch, headBranch, isReleaseBranch, isUrgentBranch, nextReleaseSwitch, releaseBranchWarning } from './releaseHandBack.ts';
import { checkReleaseBranchCommit, repoBranch } from './guard.ts';
import { handoverNote } from './work.ts';

/**
 * w1856: the urgent release build w1836 (1.0.0.12, on BEAST) left beast/slot1 on urgent/1.0.0.12, and the next worker in
 * that sandbox committed its work onto the release branch.
 */

const AT = '2026-10-23T09:00:00.000Z';

test('w1856: urgent/<v> and release/<v> are release branches; a branch that only mentions one is not', () => {
  for (const b of ['urgent/1.0.0.12', 'release/1.0.0.12', 'release/0.50.0.90']) assert.ok(isReleaseBranch(b), b);
  for (const b of ['w1767-circuit-visibility', 'urgent-fix', 'release-notes/1.0', 'releases/x', 'ffbox/urgent/1', undefined]) assert.ok(!isReleaseBranch(b), String(b));
  assert.ok(isUrgentBranch('urgent/1.0.0.12'));
  assert.ok(!isUrgentBranch('release/1.0.0.12'), 'a bump branch takes its release worker\'s commits');
});

test('w1856: switching onto a release branch records the branch the sandbox left; the next release keeps the first; leaving clears it', () => {
  const first = nextReleaseSwitch(undefined, 'beast', 'slot1', 'w1767-circuit-visibility', 'urgent/1.0.0.10', AT);
  assert.deepEqual(first, { machine: 'beast', sandbox: 'slot1', from: 'w1767-circuit-visibility', to: 'urgent/1.0.0.10', at: AT });
  // w1836 built 1.0.0.10, 1.0.0.11 and 1.0.0.12 in one session: the sandbox still goes back to where it was before the first.
  const third = nextReleaseSwitch(first, 'beast', 'slot1', 'urgent/1.0.0.10', 'urgent/1.0.0.12', AT);
  assert.equal(third?.from, 'w1767-circuit-visibility');
  assert.equal(third?.to, 'urgent/1.0.0.12');
  assert.equal(nextReleaseSwitch(third, 'beast', 'slot1', 'urgent/1.0.0.12', 'w1836-notes', AT), undefined, 'left by hand: nothing to put back');
  assert.deepEqual(nextReleaseSwitch(first, 'beast', 'slot2', 'x', 'y', AT), first, 'another sandbox\'s switch keeps it');
  assert.equal(nextReleaseSwitch(undefined, 'beast', 'slot1', 'a', 'b', AT), undefined, 'an ordinary switch records nothing');
});

test('w1856: the sandbox goes back to the branch it left, else a fresh hand-over branch', () => {
  const none = () => false;
  assert.equal(handBackBranch('slot1', 'urgent/1.0.0.12', 'w1767-circuit-visibility', none), 'w1767-circuit-visibility');
  assert.equal(handBackBranch('slot1', 'urgent/1.0.0.12', undefined, none), 'sandbox/slot1-after-urgent-1.0.0.12', 'unknown: fresh');
  assert.equal(handBackBranch('slot1', 'urgent/1.0.0.12', 'release/1.0.0.12', none), 'sandbox/slot1-after-urgent-1.0.0.12', 'never another release branch');
  assert.equal(handBackBranch('slot1', 'urgent/1.0.0.12', 'w1', (b) => b === 'w1'), 'sandbox/slot1-after-urgent-1.0.0.12', 'git keeps one branch in one worktree');
  assert.equal(handBackBranch('slot1', 'urgent/1.0.0.12', 'detached HEAD', none), 'sandbox/slot1-after-urgent-1.0.0.12');
});

test('w1856: the branch now is the daemon\'s sandbox list first, its git status read second', () => {
  assert.equal(branchNow({ branch: 'urgent/1.0.0.12', git: { branch: 'w1' } }), 'urgent/1.0.0.12');
  assert.equal(branchNow({ branch: '?', git: { branch: 'w1' } }), 'w1');
});

test('w1856: headBranch reads a worktree\'s branch from its files', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'w1856-head-'));
  try {
    const gitDir = path.join(d, 'main', '.git', 'worktrees', 'slot1');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.mkdirSync(path.join(d, 'slot1'));
    fs.writeFileSync(path.join(d, 'slot1', '.git'), `gitdir: ${gitDir}\n`);
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/urgent/1.0.0.12\n');
    assert.equal(headBranch(path.join(d, 'slot1')), 'urgent/1.0.0.12');
    fs.writeFileSync(path.join(gitDir, 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
    assert.equal(headBranch(path.join(d, 'slot1')), undefined, 'detached');
    fs.mkdirSync(path.join(d, 'clone', '.git'), { recursive: true });
    fs.writeFileSync(path.join(d, 'clone', '.git', 'HEAD'), 'ref: refs/heads/master\n');
    assert.equal(headBranch(path.join(d, 'clone')), 'master', 'a plain clone too');
    assert.equal(headBranch(path.join(d, 'nothing')), undefined);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('w1856: the shell guard refuses a commit on urgent/<v> in the sandbox, and nothing else', () => {
  const sb = 'F:/ffw/sandboxes/slot1';
  const on = (branch: string) => () => branch;
  const refused = checkReleaseBranchCommit('git add -A && git commit -m "w1767: circuit traces"', sb, sb, on('urgent/1.0.0.12'));
  assert.match(refused ?? '', /^git commit is blocked here: this sandbox is on urgent\/1\.0\.0\.12/);
  assert.match(refused ?? '', /mcp__machine__switch_branch/);
  for (const cmd of ['git merge origin/master', 'git cherry-pick abc123', 'git -C F:/ffw/sandboxes/slot1 commit -am x', 'cd F:/ffw/sandboxes/slot1/Assets && git pull', 'git revert HEAD', 'git am x.patch', 'git rebase origin/master']) {
    assert.ok(checkReleaseBranchCommit(cmd, sb, sb, on('urgent/1.0.0.12')), cmd);
  }
  for (const cmd of ['git status', 'git log -3', 'git switch -c w1767-circuit-visibility', 'git commit --help', 'git merge --abort', 'git -C F:/ffw/tmp/ffa-1/ff-factory commit -m x', 'cd F:/ffw/tmp/ffa-1/clone && git commit -m x']) {
    assert.equal(checkReleaseBranchCommit(cmd, sb, sb, on('urgent/1.0.0.12')), undefined, cmd);
  }
  assert.equal(checkReleaseBranchCommit('git commit -m x', sb, sb, on('w1767-circuit-visibility')), undefined, 'its own branch');
  assert.equal(checkReleaseBranchCommit('git commit -m x', sb, sb, on('release/1.0.0.12')), undefined, 'a bump branch is its release worker\'s');
});

test('w1856: a new worker whose sandbox is still on a release branch is warned in its handover', () => {
  const warned = handoverNote({ id: 'w1767' }, { sandbox: { id: 'beast/slot1', branch: 'urgent/1.0.0.12', git: 'git: on urgent/1.0.0.12; clean' }, related: [] });
  assert.ok(warned.includes(releaseBranchWarning('urgent/1.0.0.12')), warned);
  assert.match(warned, /Never commit on it \(the shell guard refuses commits on urgent\/\*\): switch_branch to your own branch first/);
  const plain = handoverNote({ id: 'w1767' }, { sandbox: { id: 'beast/slot1', branch: 'w1767-circuit-visibility' }, related: [] });
  assert.doesNotMatch(plain, /WARNING \(w1856\)/);
});

test('w2503: a commit in a clone of its own is judged by that clone\'s branch, not the sandbox\'s', () => {
  // w2474's worker, in beast/slot1 left on urgent/1.0.0.23 by a release build, had `cd "$TMPDIR/ff-factory" && git commit`
  // refused: the guard could not follow $TMPDIR, so it judged the sandbox's branch, and the worker committed through a script.
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'w2503-'));
  try {
    const sb = path.join(d, 'sandboxes', 'slot1').replace(/\\/g, '/');
    const tmp = path.join(d, 'tmp', 'ffa-1').replace(/\\/g, '/');
    const head = (dir: string, branch: string) => {
      fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
    };
    head(sb, 'urgent/1.0.0.23');
    head(`${tmp}/ff-factory`, 'w2474-oom-policy');
    head(`${sb}/Temp/ff-factory`, 'w2474-oom-policy');
    fs.mkdirSync(`${sb}/Assets/Scripts`, { recursive: true });
    const env = { TMPDIR: tmp, HOME: path.join(d, 'home') };
    const run = (cmd: string) => checkReleaseBranchCommit(cmd, sb, sb, repoBranch, env);
    // The misfire: each of these commits in the worker's own clone, on its own branch.
    for (const cmd of [
      'cd "$TMPDIR/ff-factory" && git add -A && git commit -m "w2474: OOMPolicy=continue"',
      'cd $TMPDIR/ff-factory && git commit -m x',
      'git -C "$TMPDIR/ff-factory" commit -m x',
      'git -C ${TMPDIR}/ff-factory merge origin/main',
      `git -C ${sb}/Temp/ff-factory commit -m x`,
      `cd ${sb}/Temp/ff-factory && git commit -m x`,
    ]) assert.equal(run(cmd), undefined, cmd);
    // The guard still holds in the sandbox itself, from its root or a folder inside it.
    for (const cmd of ['git commit -m x', 'cd Assets/Scripts && git commit -m x', `git -C ${sb} merge origin/master`]) {
      assert.match(run(cmd) ?? '', /this sandbox is on urgent\/1\.0\.0\.23/, cmd);
    }
    // A folder the text does not reveal counts as the sandbox, and the refusal says why and how to name it.
    const lost = run('cd "$NOT_SET/ff-factory" && git commit -m x');
    assert.match(lost ?? '', /could not be followed/);
    assert.match(lost ?? '', /git -C <path>/);
    // Once the sandbox is back on a worker's branch nothing is refused.
    head(sb, 'sandbox/slot1-w2474');
    assert.equal(run('git commit -m x'), undefined);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
