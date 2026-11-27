// w6264 (lothsahn: "Windows workers: rm -rf follows a mklink /J junction; clean temp folders with rd /s /q"): on Windows,
// Git Bash's `rm -rf` on a folder that holds a junction made by `cmd /c mklink /J` deleted the junction's target whole,
// then failed on the junction (measured on BEAST in w6252, and on LothDesktop in w6264, where a worker's junction stores its
// target as `\??\Global\V:\...` and lstat calls it a plain folder). Every route FF Factory deletes a worker's folder by on
// Windows must remove the junction and keep what it points at: removeTree (`rd /s /q`), the clean-up's removeRenamed
// (fs.promises.rm, whole or by members), fs.rmSync and fs.promises.rm (the session temp folder's sweep, server/index.ts),
// and the route the worker prompt gives (`cmd //c "rd /s /q ..."`, or Remove-Item in PowerShell).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTree } from './proc.ts';
import { removeRenamed, type CleanupRun } from './cleanup.ts';
import { diskHygiene } from './agents.ts';

const win = process.platform === 'win32';

/** A folder in the test's own temp: `target/keep.txt`, and `tree/` with a file and a junction `tree/j` -> `target`. */
function junctionTree(): { root: string; tree: string; junction: string; keep: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w6264-'));
  const target = path.join(root, 'target');
  const tree = path.join(root, 'tree');
  fs.mkdirSync(target);
  fs.mkdirSync(path.join(tree, 'sub'), { recursive: true });
  const keep = path.join(target, 'keep.txt');
  fs.writeFileSync(keep, 'keep');
  fs.writeFileSync(path.join(tree, 'sub', 'x.txt'), 'x');
  const junction = path.join(tree, 'j');
  execFileSync('cmd.exe', ['/c', 'mklink', '/J', junction, target], { stdio: 'ignore' });
  assert.ok(fs.existsSync(path.join(junction, 'keep.txt')), 'the junction leads to the target');
  return { root, tree, junction, keep };
}

const emptyRun = (): CleanupRun => ({ removed: [], failed: [], bytes: 0 });

const routes: [string, (t: { tree: string; junction: string }) => Promise<unknown>][] = [
  ['removeTree (rd /s /q)', async ({ tree }) => removeTree(tree)],
  ['the clean-up removeRenamed, whole', async ({ tree }) => removeRenamed({ path: tree, why: 'test', rule: 'leftover' }, emptyRun())],
  ['the clean-up removeRenamed, renamed first', async ({ tree }) => removeRenamed({ path: tree, why: 'test', rule: 'stale' }, emptyRun())],
  [
    'the clean-up removeRenamed, by members (the junction one of them)',
    async ({ tree, junction }) => removeRenamed({ path: tree, why: 'test', rule: 'stale', members: [junction, path.join(tree, 'sub')] }, emptyRun()),
  ],
  ['fs.rmSync recursive', async ({ tree }) => fs.rmSync(tree, { recursive: true, force: true })],
  ['fs.promises.rm recursive (the session temp sweep)', async ({ tree }) => fs.promises.rm(tree, { recursive: true, force: true, maxRetries: 2 })],
  ['the prompt\'s cmd /c rd /s /q', async ({ tree }) => execFileSync('cmd.exe', ['/c', 'rd', '/s', '/q', tree], { stdio: 'ignore' })],
  [
    'the prompt\'s Remove-Item -Recurse -Force',
    async ({ tree }) =>
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Remove-Item -LiteralPath $env:W6264_T -Recurse -Force'], {
        env: { ...process.env, W6264_T: tree },
        stdio: 'ignore',
      }),
  ],
];

for (const [name, remove] of routes) {
  test(`w6264: ${name} removes a junction inside a folder and keeps the folder it points at`, { skip: !win && 'mklink /J is Windows only' }, async () => {
    const t = junctionTree();
    try {
      await remove(t);
      assert.equal(fs.readFileSync(t.keep, 'utf8'), 'keep', 'the junction\'s target and its file are kept');
      assert.ok(!fs.existsSync(t.junction), 'the junction is gone');
      if (!name.includes('by members')) assert.ok(!fs.existsSync(t.tree), 'the folder is gone');
    } finally {
      fs.rmSync(t.root, { recursive: true, force: true });
    }
  });
}

test('w6264: removeTree on the junction itself removes the link and keeps the target', { skip: !win && 'mklink /J is Windows only' }, async () => {
  const t = junctionTree();
  try {
    await removeTree(t.junction);
    assert.ok(!fs.existsSync(t.junction));
    assert.equal(fs.readFileSync(t.keep, 'utf8'), 'keep');
  } finally {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});

test('w6264: a Windows worker is told to delete a folder with rd, never rm -r; other workers are not', () => {
  const w = diskHygiene('win32');
  assert.match(w, /On Windows a folder goes with `cmd \/\/c "rd \/s \/q \$\(cygpath -w "\$TMPDIR\/<name>"\)"`/);
  assert.match(w, /Remove-Item -LiteralPath "\$env:TEMP\\<name>" -Recurse -Force/);
  assert.match(w, /never `rm -r`: Git Bash's `rm -rf` goes through a junction/);
  for (const p of ['darwin', 'linux']) assert.doesNotMatch(diskHygiene(p), /On Windows a folder goes with/);
});
