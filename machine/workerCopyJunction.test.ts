/**
 * w5615, review w6247: a junction made the way a worker makes one, `cmd /c mklink /J` (no privilege needed, so it runs on
 * the Windows runner as it does in a Low worker session on BEAST). fs.symlinkSync's junctions store a `\??\X:\` target
 * that Node's lstat sees as a link; the reviewer measured that a worker's `mklink /J` on BEAST stored `\??\Global\F:\...`,
 * which lstat and the JS realpathSync miss. These check the daemon's link tests on a real `mklink /J` junction: they take
 * link-ness from the parent's Dirent and the real path from realpathSync.native, which see both forms.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { LOW_COPY_SCRIPT, isLinkAt, linkIn, plainDirAt } from './workerCopy.ts';

const skip = process.platform !== 'win32';

function tmp(t: TestContext): string {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'workercopy-j-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
const put = (f: string, text = 'x') => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
/** `cmd /c mklink /J <link> <target>`, as a worker would make it. */
function mklinkJ(link: string, target: string): void {
  const r = spawnSync('cmd', ['/c', 'mklink', '/J', link, target], { encoding: 'utf8' });
  assert.equal(r.status, 0, `mklink /J: ${r.stdout}${r.stderr}`);
}

test('a mklink /J junction is a link to isLinkAt, plainDirAt and linkIn, at the top and inside a tree', { skip: skip && 'Windows only' }, (t) => {
  const d = tmp(t);
  put(path.join(d, 'secret', 'key.txt'), 'shh');
  fs.mkdirSync(path.join(d, 'build'));
  put(path.join(d, 'build', 'Game.exe'));
  mklinkJ(path.join(d, 'build', 'evil'), path.join(d, 'secret'));
  assert.equal(isLinkAt(path.join(d, 'build', 'evil')), true);
  assert.equal(isLinkAt(path.join(d, 'build')), false);
  assert.equal(plainDirAt(path.join(d, 'build', 'evil'), path.join(d, 'build'), 'evil'), false);
  assert.equal(plainDirAt(path.join(d, 'build'), d, 'build'), true);
  assert.equal(linkIn(path.join(d, 'build')), 'evil');
  assert.equal(linkIn(path.join(d, 'build', 'evil')), '.');
  // a slot folder swapped for a junction (the review's players/<sandbox>-<peer> case)
  fs.mkdirSync(path.join(d, 'players'));
  mklinkJ(path.join(d, 'players', 's1-0'), path.join(d, 'secret'));
  assert.equal(plainDirAt(path.join(d, 'players', 's1-0'), path.join(d, 'players'), 's1-0'), false);
});

test('LOW_COPY_SCRIPT never enters a mklink /J junction: refuse ends with exit 3, keep makes it again as a junction', { skip: skip && 'Windows only' }, (t) => {
  const d = tmp(t);
  put(path.join(d, 'secret', 'key.txt'), 'shh');
  put(path.join(d, 'build', 'Game.exe'), 'game');
  mklinkJ(path.join(d, 'build', 'evil'), path.join(d, 'secret'));
  const node = (src: string, dst: string, mode: string) =>
    spawnSync(process.execPath, ['-e', LOW_COPY_SCRIPT, src, dst, mode], { encoding: 'utf8' });
  const r = node(path.join(d, 'build'), path.join(d, 'r'), 'refuse');
  assert.equal(r.status, 3, r.stderr);
  assert.equal(fs.existsSync(path.join(d, 'r', 'evil', 'key.txt')), false);
  const k = node(path.join(d, 'build'), path.join(d, 'k'), 'keep');
  assert.equal(k.status, 0, k.stderr);
  assert.equal(fs.readFileSync(path.join(d, 'k', 'Game.exe'), 'utf8'), 'game');
  assert.equal(isLinkAt(path.join(d, 'k', 'evil')), true, 'kept as a junction, not flattened into a folder');
  assert.equal(fs.realpathSync.native(path.join(d, 'k', 'evil')).toLowerCase(), path.join(d, 'secret').toLowerCase());
  // the top itself a junction
  mklinkJ(path.join(d, 'top'), path.join(d, 'build'));
  assert.equal(node(path.join(d, 'top'), path.join(d, 't'), 'refuse').status, 3);
});
