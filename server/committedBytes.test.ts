import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { run } from './proc.ts';
import { blobId, restoreCommittedBytes, staleEolEntries } from './committedBytes.ts';
import { switchBranch } from './switchBranch.ts';

const PLIST = 'lib/fmod.bundle/Contents/Info.plist';
const OTHER = 'lib/fmod.bundle/Contents/Other.plist';
const RULE = 'lib/*.bundle/Contents/*.plist -text\n';

/**
 * The game repo's w1275 case: a clone under core.autocrlf=true checks out LF plists as CRLF, then pulls the
 * .gitattributes rule that makes them -text. The pull leaves the CRLF copies and `git status` clean.
 */
function staleClone() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-eol-'));
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const work = path.join(root, 'work');
  const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' }).toString().trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', origin]);
  execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', origin, seed], { stdio: 'pipe' });
  git(seed, 'switch', '-q', '-c', 'master');
  fs.mkdirSync(path.join(seed, 'lib/fmod.bundle/Contents'), { recursive: true });
  fs.writeFileSync(path.join(seed, PLIST), '<plist>\n<dict/>\n</plist>\n');
  fs.writeFileSync(path.join(seed, OTHER), '<plist>\n<other/>\n</plist>\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'plists');
  git(seed, 'push', '-q', '-u', 'origin', 'master');
  execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=true', origin, work], { stdio: 'pipe' });
  git(work, 'switch', '-q', '-c', 'sandbox/a');
  fs.writeFileSync(path.join(seed, '.gitattributes'), RULE);
  git(seed, 'add', '.gitattributes');
  git(seed, 'commit', '-q', '-m', 'rule');
  git(seed, 'push', '-q', 'origin', 'master');
  const runGit = (a: string[]) => run('git', ['-C', work, ...a], { timeoutMs: 60_000 });
  return { root, work, git, runGit, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const crs = (file: string) => fs.readFileSync(file).filter((b) => b === 13).length;

test('blobId: matches git hash-object', () => {
  const bytes = Buffer.from('<plist>\n</plist>\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-blob-'));
  try {
    fs.writeFileSync(path.join(dir, 'x'), bytes);
    assert.equal(blobId(bytes, 40), execFileSync('git', ['hash-object', '--no-filters', path.join(dir, 'x')]).toString().trim());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('staleEolEntries: only -text files whose index is LF and working copy CRLF', () => {
  const id = 'a'.repeat(40);
  const ls = [
    `100644 ${id} 0\ti/lf    w/crlf  attr/-text            \ta/Info.plist`,
    `100644 ${id} 0\ti/lf    w/lf    attr/-text            \ta/Fine.plist`,
    `100644 ${id} 0\ti/lf    w/crlf  attr/text eol=lf      \ta/x.cs`,
    `100644 ${id} 0\ti/-text w/-text attr/-text            \ta/binary`,
    `100644 ${id} 0\ti/lf    w/mixed attr/-text            \ta/with space.plist`,
    '',
  ].join('\0');
  assert.deepEqual(staleEolEntries(ls).map((e) => e.path), ['a/Info.plist', 'a/with space.plist']);
});

test('restoreCommittedBytes: a pull leaves the CRLF copies; this puts the committed bytes back and keeps a real edit', async (t) => {
  const r = staleClone();
  t.after(r.cleanup);
  assert.equal(crs(path.join(r.work, PLIST)), 3, 'autocrlf wrote CRLF');
  r.git(r.work, 'pull', '-q', '--no-rebase', 'origin', 'master');
  assert.equal(crs(path.join(r.work, PLIST)), 3, 'the pull brought the rule but rewrote nothing');
  // A person's edit in the other plist: more than line endings differ, so it stays.
  fs.writeFileSync(path.join(r.work, OTHER), '<plist>\r\n<edited/>\r\n</plist>\r\n');

  const fixed = await restoreCommittedBytes(r.work, r.runGit);
  assert.deepEqual(fixed, [PLIST]);
  assert.equal(crs(path.join(r.work, PLIST)), 0);
  assert.equal(fs.readFileSync(path.join(r.work, PLIST), 'utf8'), '<plist>\n<dict/>\n</plist>\n');
  assert.equal(crs(path.join(r.work, OTHER)), 3, 'the edit is untouched');
  assert.equal(r.git(r.work, 'status', '--porcelain'), `M ${OTHER}`);
  assert.deepEqual(await restoreCommittedBytes(r.work, r.runGit), [], 'a second look finds nothing');
});

test('switchBranch: switching to a branch that brings the -text rule puts the committed bytes back', async (t) => {
  const r = staleClone();
  t.after(r.cleanup);
  const res = await switchBranch({ dir: r.work, branch: 'sandbox/b' });
  assert.match(res.notes.join('; '), /put back the committed bytes of 2 file\(s\) checked out with CRLF/);
  assert.equal(crs(path.join(r.work, PLIST)), 0);
  assert.equal(crs(path.join(r.work, OTHER)), 0);
  assert.equal(r.git(r.work, 'status', '--porcelain'), '');
});
