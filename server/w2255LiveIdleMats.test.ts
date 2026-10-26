// w2255: an idle close of a Live view's editor saves every dirty asset (AssetDatabase.SaveAssets); the daemon then puts back
// every .mat file the close wrote (machine/liveIdle.ts putBackMats), so no knob value lands in the worktree without the
// person's Keep. On m5/slot2 (w2196, 2026-10-26 03:37Z) the close rewrote 11 materials, one with the view's ColorBR.
// The worktree here is a real git repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { putBackMats, snapshotMats } from '../machine/liveIdle.ts';

const MAT = (color: string) => `%YAML 1.1\nMaterial:\n  m_Name: Tier1Body\n  m_SavedProperties:\n    m_Colors:\n    - _ColorBR: {r: ${color}, g: 0.2, b: 0.2, a: 1}\n`;

function worktree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2255-'));
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'core.autocrlf', 'false');
  const write = (p: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), text);
  };
  write('Assets/Materials/Tier1Body.mat', MAT('0.9'));
  write('Assets/Materials/Tier2Body.mat', MAT('0.1'));
  write('Assets/Materials/Kept.mat', MAT('0.5'));
  write('Assets/Scripts/Thing.cs', 'class Thing {}\n');
  write('.gitignore', '/[Ll]ogs/\n'); // as the game repo's
  git('add', '-A');
  git('commit', '-qm', 'base');
  const read = (p: string) => fs.readFileSync(path.join(dir, p), 'utf8');
  return { dir, git, write, read };
}

test('w2255: the .mat files an idle close wrote go back; what it wrote is kept in Logs, other files stay', async () => {
  const w = worktree();
  // Before the close: a Keep the person pressed (uncommitted), and the worker's own uncommitted script.
  w.write('Assets/Materials/Kept.mat', MAT('0.42'));
  w.write('Assets/Scripts/Thing.cs', 'class Thing { int x; }\n');
  const before = await snapshotMats(w.dir);
  assert.deepEqual([...before.keys()], ['Assets/Materials/Kept.mat']);

  // The close's SaveAssets: the knob's unkept ColorBR into a clean material, a format rewrite of another, and the kept
  // material overwritten with a value moved after the Keep.
  w.write('Assets/Materials/Tier1Body.mat', MAT('0.61'));
  w.write('Assets/Materials/Tier2Body.mat', MAT('0.1') + '  m_BuildTextureStacks: []\n');
  w.write('Assets/Materials/Kept.mat', MAT('0.77'));
  w.write('Assets/Scripts/Thing.cs', 'class Thing { int y; }\n');

  const text = await putBackMats(w.dir, before, new Date('2026-10-26T03:37:16.123Z'));
  assert.equal(
    text,
    'put back 3 .mat files the close wrote (Assets/Materials/Kept.mat, Assets/Materials/Tier1Body.mat, Assets/Materials/Tier2Body.mat); what it wrote is in Logs/live-close-backup-20261026T033716Z',
  );
  assert.equal(w.read('Assets/Materials/Tier1Body.mat'), MAT('0.9'), 'a clean material goes back to git');
  assert.equal(w.read('Assets/Materials/Tier2Body.mat'), MAT('0.1'));
  assert.equal(w.read('Assets/Materials/Kept.mat'), MAT('0.42'), 'the Keep stays');
  assert.equal(w.read('Assets/Scripts/Thing.cs'), 'class Thing { int y; }\n', 'only .mat files are put back');
  assert.equal(w.read('Logs/live-close-backup-20261026T033716Z/Assets/Materials/Tier1Body.mat'), MAT('0.61'), 'nothing is lost');
  assert.equal(w.read('Logs/live-close-backup-20261026T033716Z/Assets/Materials/Kept.mat'), MAT('0.77'));
  assert.deepEqual(w.git('status', '--porcelain').split('\n').filter(Boolean), [' M Assets/Materials/Kept.mat', ' M Assets/Scripts/Thing.cs']);
});

test('w2255: a close that wrote no .mat changes nothing and says nothing', async () => {
  const w = worktree();
  w.write('Assets/Materials/Kept.mat', MAT('0.42'));
  const before = await snapshotMats(w.dir);
  assert.equal(await putBackMats(w.dir, before, new Date()), undefined);
  assert.equal(w.read('Assets/Materials/Kept.mat'), MAT('0.42'));
  assert.equal(fs.existsSync(path.join(w.dir, 'Logs')), false);
});

test('w2255: no git there: says so, never throws', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2255-nogit-'));
  const text = await putBackMats(path.join(dir, 'missing'), new Map(), new Date());
  assert.match(text ?? '', /^could not read git status to put back the \.mat files the close wrote/);
});
