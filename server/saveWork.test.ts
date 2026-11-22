import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { saveWork, savedBranch } from './saveWork.ts';
import { tmpFont } from './tmpFontFixture.ts';

function repos() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-save-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString().trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'develop', origin]);
  execFileSync('git', ['clone', '-q', origin, work], { stdio: 'pipe' });
  git(work, 'config', 'user.email', 't@t');
  git(work, 'config', 'user.name', 't');
  git(work, 'switch', '-q', '-c', 'develop');
  fs.writeFileSync(path.join(work, 'a.cs'), 'a');
  fs.writeFileSync(path.join(work, '.gitignore'), 'Library/\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'base');
  git(work, 'push', '-q', '-u', 'origin', 'develop');
  git(work, 'switch', '-q', '-c', 'w1-feature');
  return { root, origin, work, git, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const MSG = 'FF Factory: w1 saved before its sandbox was released (w656)';

test('w656 save: changed, deleted and new files are committed on the worker branch and pushed; ignored files stay', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  fs.writeFileSync(path.join(r.work, 'a.cs'), 'changed');
  fs.writeFileSync(path.join(r.work, 'New.cs'), 'new');
  fs.writeFileSync(path.join(r.work, 'New.cs.meta'), 'guid');
  fs.mkdirSync(path.join(r.work, 'Library'));
  fs.writeFileSync(path.join(r.work, 'Library', 'big.bin'), Buffer.alloc(20 * 1024 * 1024));
  const res = await saveWork({ dir: r.work, branch: 'w1-feature', message: MSG });
  assert.equal(res.files, 3);
  assert.equal(res.pushed, true);
  assert.equal(r.git(r.work, 'status', '--porcelain'), '', 'clean: the sandbox may be released');
  assert.equal(r.git(r.origin, 'log', '-1', '--format=%s', 'w1-feature'), MSG, 'safe on origin');
  assert.equal(r.git(r.work, 'rev-parse', '--short', 'HEAD'), res.sha);
  assert.ok(fs.existsSync(path.join(r.work, 'Library', 'big.bin')), 'ignored files are left alone');
  // git reset HEAD~1 gives the worker its changes back, uncommitted.
  r.git(r.work, 'reset', '-q', 'HEAD~1');
  assert.match(r.git(r.work, 'status', '--porcelain'), /M a\.cs/);
  assert.match(r.git(r.work, 'status', '--porcelain'), /\?\? New\.cs/);
});

test('w656 save: nothing to save; refused on another branch, a shared branch, or untracked files too many or too big', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  assert.deepEqual(await saveWork({ dir: r.work, branch: 'w1-feature', message: MSG }), { files: 0, pushed: false, notes: ['nothing to save'] });
  fs.writeFileSync(path.join(r.work, 'a.cs'), 'changed');
  await assert.rejects(saveWork({ dir: r.work, branch: 'w2-other', message: MSG }), /on w1-feature, not the worker's branch w2-other/);
  r.git(r.work, 'stash', '-q');
  r.git(r.work, 'switch', '-q', 'develop');
  r.git(r.work, 'stash', 'pop', '-q');
  await assert.rejects(saveWork({ dir: r.work, branch: 'develop', message: MSG }), /develop, a shared branch/);
  r.git(r.work, 'switch', '-q', 'w1-feature');
  const limits = { files: 3, fileBytes: 1000, totalBytes: 1500 };
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(r.work, `run${i}.log`), 'x');
  await assert.rejects(saveWork({ dir: r.work, branch: 'w1-feature', message: MSG, limits }), /4 untracked files there, more than the 3 a save commits/);
  for (let i = 0; i < 4; i++) fs.rmSync(path.join(r.work, `run${i}.log`));
  fs.writeFileSync(path.join(r.work, 'clip.mp4'), Buffer.alloc(2000));
  await assert.rejects(saveWork({ dir: r.work, branch: 'w1-feature', message: MSG, limits }), /the untracked file clip\.mp4 is 0\.0 MB, more than/);
  fs.rmSync(path.join(r.work, 'clip.mp4'));
  fs.writeFileSync(path.join(r.work, 'b1.bin'), Buffer.alloc(900));
  fs.writeFileSync(path.join(r.work, 'b2.bin'), Buffer.alloc(900));
  await assert.rejects(saveWork({ dir: r.work, branch: 'w1-feature', message: MSG, limits }), /the untracked files there are more than/);
  assert.match(r.git(r.work, 'status', '--porcelain'), /M a\.cs/, 'nothing was committed');
});

test('w1983 save: build output in .nightly-builds/ or Builds/ is neither saved nor counted, so a player build never pins a sandbox', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  const limits = { files: 3, fileBytes: 1000, totalBytes: 1500 };
  // lothdesktop/slot6 at 03:27Z on 2026-10-24: ".nightly-builds/5f7b5ad5…-win/player/UnityPlayer.dll is 80 MB".
  const player = path.join(r.work, '.nightly-builds', 'abc-win', 'player');
  fs.mkdirSync(player, { recursive: true });
  fs.writeFileSync(path.join(player, 'UnityPlayer.dll'), Buffer.alloc(5000));
  fs.mkdirSync(path.join(r.work, 'Builds'));
  for (const n of [1, 2, 3, 4]) fs.writeFileSync(path.join(r.work, 'Builds', `f${n}.bin`), 'x');
  const none = await saveWork({ dir: r.work, branch: 'w1-feature', message: MSG, limits });
  // The game repo ignores Builds/: an exclude pathspec naming an ignored folder made git add exit 1 ("The following paths
  // are ignored ... Builds ... Use -f"), and lothdesktop/slot6 stayed held from 06:56Z on 2026-10-24.
  fs.appendFileSync(path.join(r.work, '.git', 'info', 'exclude'), '\nBuilds/\n');
  const ignored = await saveWork({ dir: r.work, branch: 'w1-feature', message: MSG, limits });
  assert.equal(ignored.files, 0, 'an ignored Builds/ is no error');
  assert.equal(none.files, 0);
  assert.equal(none.sha, undefined);
  assert.match(none.notes.join(' '), /nothing to save \(build output in \.nightly-builds\/ or builds\/ stays, uncommitted\)/);
  fs.writeFileSync(path.join(r.work, 'New.cs'), 'new');
  const res = await saveWork({ dir: r.work, branch: 'w1-feature', message: MSG, limits });
  assert.equal(res.files, 1);
  assert.equal(r.git(r.work, 'show', '--name-only', '--format=', 'HEAD'), 'New.cs');
  assert.ok(fs.existsSync(path.join(player, 'UnityPlayer.dll')), 'the build stays where it is');
});

test('w656 save: a push that fails still leaves the commit in the repository, and says so', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  r.git(r.work, 'remote', 'set-url', 'origin', path.join(r.root, 'gone.git'));
  fs.writeFileSync(path.join(r.work, 'a.cs'), 'changed');
  const res = await saveWork({ dir: r.work, branch: 'w1-feature', message: MSG });
  assert.equal(res.pushed, false);
  assert.match(res.notes.join('; '), /not pushed .*the commit is in this machine's repository/);
  assert.equal(r.git(r.work, 'log', '-1', '--format=%s'), MSG);
});

test('w2782 save: a material the editor only re-serialized in play mode is restored to HEAD, one a worker changed is saved', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  const mat = (flags: number, color: string, extra = '') =>
    `%YAML 1.1\n--- !u!21 &2100000\nMaterial:\n  serializedVersion: 8\n  m_ObjectHideFlags: ${flags}\n  m_Name: M\n  m_LightmapFlags: ${extra ? 7 : 3}\n  m_SavedProperties:\n    m_Colors:\n    - _Color: {${color}}\n${extra}`;
  const base = mat(0, 'r: 0.72156864, g: 0.3529412, b: 0.15686275, a: 1');
  for (const n of ['Noise', 'Real', 'Both', 'Staged']) fs.writeFileSync(path.join(r.work, `${n}.mat`), base);
  r.git(r.work, 'add', '-A');
  r.git(r.work, 'commit', '-q', '-m', 'materials');
  // As e0eefbfd47 (w2777) committed LaserMapMaterial.mat: HideFlags 0 to 32, EmissiveIsBlack, a URP default, a re-rounded colour.
  const noise = mat(32, 'r: 0.72156864, g: 0.35294116, b: 0.1568627, a: 1', '    - _XRMotionVectorsPass: 1\n');
  fs.writeFileSync(path.join(r.work, 'Noise.mat'), noise);
  fs.writeFileSync(path.join(r.work, 'Staged.mat'), noise);
  r.git(r.work, 'add', 'Staged.mat');
  fs.writeFileSync(path.join(r.work, 'Real.mat'), mat(0, 'r: 1, g: 0, b: 0, a: 1'));
  fs.writeFileSync(path.join(r.work, 'Both.mat'), mat(32, 'r: 1, g: 0, b: 0, a: 1'));
  fs.writeFileSync(path.join(r.work, 'a.cs'), 'changed');
  const res = await saveWork({ dir: r.work, branch: 'w1-feature', message: MSG });
  assert.equal(res.files, 3);
  assert.deepEqual(r.git(r.work, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['Both.mat', 'Real.mat', 'a.cs']);
  assert.equal(r.git(r.work, 'status', '--porcelain'), '', 'clean: the sandbox may be released');
  // Restored from HEAD, so a Windows runner's core.autocrlf checks it out with CRLF.
  assert.equal(fs.readFileSync(path.join(r.work, 'Noise.mat'), 'utf8').replaceAll('\r\n', '\n'), base, 'the noise is gone, not left uncommitted');
  assert.match(fs.readFileSync(path.join(r.work, 'Both.mat'), 'utf8'), /m_ObjectHideFlags: 32[\s\S]*r: 1, g: 0/, 'noise beside a real change is saved with it');
  assert.match(res.notes[0], /^restored 2 file\(s\) the Unity editor only rewrote by itself .* to HEAD instead of saving them: (Noise|Staged)\.mat, (Noise|Staged)\.mat$/);
  // Only the editor's noise left: nothing is committed, and the worktree is clean.
  fs.writeFileSync(path.join(r.work, 'Noise.mat'), noise);
  const none = await saveWork({ dir: r.work, branch: 'w1-feature', message: MSG });
  assert.equal(none.sha, undefined);
  assert.equal(none.notes.length, 2);
  assert.match(none.notes[0], /^restored 1 file\(s\) the Unity editor only rewrote by itself .* instead of saving them: Noise\.mat$/);
  assert.equal(none.notes[1], 'nothing else to save');
  assert.equal(r.git(r.work, 'status', '--porcelain'), '');
});

const FONT = 'Assets/TextMesh Pro/Resources/Fonts & Materials/LiberationSans SDF - Fallback.asset';

test('w5067 save: a dynamic TMP font atlas the editor grew is restored to HEAD, not committed beside the real work', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  const font = path.join(r.work, ...FONT.split('/'));
  const other = path.join(r.work, 'Assets', 'Fonts', 'NotoSansJP SDF.asset');
  const stat = path.join(r.work, 'Assets', 'Fonts', 'Static SDF.asset');
  fs.mkdirSync(path.dirname(font), { recursive: true });
  fs.mkdirSync(path.dirname(other), { recursive: true });
  fs.writeFileSync(font, tmpFont({ pairs: 2 }));
  fs.writeFileSync(other, tmpFont());
  fs.writeFileSync(stat, tmpFont({ mode: 0 }));
  r.git(r.work, 'add', '-A');
  r.git(r.work, 'commit', '-q', '-m', 'fonts');
  // As 6d6488f046 on PR #4137's branch: 4,245 lines of kerning records the editor added to the Fallback atlas.
  fs.writeFileSync(font, tmpFont({ pairs: 60 }));
  fs.writeFileSync(other, tmpFont({ glyphs: 4, pixels: 'ffffffff' }));
  fs.writeFileSync(stat, tmpFont({ mode: 0, glyphs: 2 })); // a static font's glyphs are someone's edit: saved
  fs.writeFileSync(path.join(r.work, 'a.cs'), 'changed');
  const res = await saveWork({ dir: r.work, branch: 'w1-feature', message: MSG });
  assert.deepEqual(r.git(r.work, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['Assets/Fonts/Static SDF.asset', 'a.cs']);
  assert.equal(res.files, 2);
  assert.equal(r.git(r.work, 'status', '--porcelain'), '', 'clean: the sandbox may be released');
  assert.equal(fs.readFileSync(font, 'utf8').replaceAll('\r\n', '\n'), tmpFont({ pairs: 2 }), 'the atlas is back at HEAD');
  assert.match(res.notes[0], /^restored 2 file\(s\) .*dynamic font atlas.*: .*(LiberationSans SDF - Fallback|NotoSansJP SDF)\.asset/);
  assert.equal(r.git(r.origin, 'log', '-1', '--format=%s', 'w1-feature'), MSG);
  // Only the atlas left: nothing is committed or pushed.
  fs.writeFileSync(font, tmpFont({ pairs: 61 }));
  const none = await saveWork({ dir: r.work, branch: 'w1-feature', message: MSG });
  assert.equal(none.sha, undefined);
  assert.equal(none.pushed, false);
  assert.equal(r.git(r.work, 'status', '--porcelain'), '');
});

test('w5067 save: while the pull request\'s CI runs, the save goes to a side branch and the PR branch on origin is untouched', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  fs.writeFileSync(path.join(r.work, 'b.cs'), 'worker commit');
  r.git(r.work, 'add', '-A');
  r.git(r.work, 'commit', '-q', '-m', 'the head CI runs on');
  r.git(r.work, 'push', '-q', '-u', 'origin', 'w1-feature');
  const head = r.git(r.work, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(r.work, 'a.cs'), 'changed');
  const hold = 'CI runs on Final-Factory/FinalFactory#4137';
  const res = await saveWork({ dir: r.work, branch: 'w1-feature', message: MSG, holdPush: hold });
  assert.equal(r.git(r.origin, 'rev-parse', 'w1-feature'), head, 'no push to the PR branch: its CI run is not cancelled');
  assert.equal(res.sideRef, savedBranch('w1-feature', res.sha!));
  assert.equal(r.git(r.origin, 'log', '-1', '--format=%s', res.sideRef!), MSG, 'the save is safe on origin');
  assert.equal(r.git(r.work, 'status', '--porcelain'), '');
  assert.equal(r.git(r.work, 'log', '-1', '--format=%s'), MSG, 'the branch here holds the save');
  // Nothing unpushed by `--not --remotes`, so switchBranch's pre-switch push leaves the PR branch alone too.
  assert.equal(r.git(r.work, 'rev-list', '--count', 'HEAD', '--not', '--remotes'), '0');
  assert.match(res.notes.join(' '), /not pushed to w1-feature \(CI runs on Final-Factory\/FinalFactory#4137/);
});

test('w5067 save: a side-branch push that fails hands the work back uncommitted, and the PR branch is untouched', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  r.git(r.work, 'push', '-q', '-u', 'origin', 'w1-feature');
  const head = r.git(r.work, 'rev-parse', 'HEAD');
  // A hook on origin refuses any ff-saved/ ref.
  const hook = path.join(r.origin, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\nwhile read o n ref; do case "$ref" in refs/heads/ff-saved/*) exit 1;; esac; done\n');
  fs.chmodSync(hook, 0o755);
  fs.writeFileSync(path.join(r.work, 'a.cs'), 'changed');
  await assert.rejects(saveWork({ dir: r.work, branch: 'w1-feature', message: MSG, holdPush: 'CI runs on x#1' }), /side branch .* failed/);
  assert.equal(r.git(r.work, 'rev-parse', 'HEAD'), head, 'the save commit is undone');
  assert.match(r.git(r.work, 'status', '--porcelain'), /M a\.cs/, 'the work is back, uncommitted');
  assert.equal(r.git(r.origin, 'rev-parse', 'w1-feature'), head);
});
