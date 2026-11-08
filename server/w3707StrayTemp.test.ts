import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitBashStrayRoot, gitBashStrayTop, sweepGitBashStray } from './gitBashPath.ts';

// LothDesktop, 2026-11-08: V:\v\ffw\tmp held ffa-48e6e232 (a 60 MB zip, closed worker), ffa-4e9bffcb (empty, closed) and
// ffa-01c194fe (w2895, open). The clean-up now takes the closed ones and the chain once it is empty (w3707).
test('w3707: the stray temp root is Git Bash\'s spelling of the temp root, from the drive root', () => {
  assert.equal(gitBashStrayRoot('V:\\ffw\\tmp'), 'V:\\v\\ffw\\tmp');
  assert.equal(gitBashStrayRoot('F:/ffw/tmp/'), 'F:\\f\\ffw\\tmp');
  assert.equal(gitBashStrayRoot('/Users/m5/ffw/tmp'), undefined);
  assert.equal(gitBashStrayTop('V:\\v\\ffw\\tmp'), 'V:\\v');
});

test('w3707: a sweep removes closed workers\' folders only, then the empty chain up to its top', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'w3707-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const top = path.join(base, 'v');
  const stray = path.join(top, 'ffw', 'tmp');
  fs.mkdirSync(path.join(stray, 'ffa-48e6e232'), { recursive: true });
  fs.writeFileSync(path.join(stray, 'ffa-48e6e232', 'w2402-launch-clips.zip'), 'zip');
  fs.mkdirSync(path.join(stray, 'ffa-4e9bffcb'));
  fs.mkdirSync(path.join(stray, 'ffa-01c194fe', 'ffu-280'), { recursive: true });
  fs.writeFileSync(path.join(stray, 'ffa-01c194fe', 'ffu-280', '.git'), 'gitdir: gone');
  fs.writeFileSync(path.join(base, 'beside.txt'), 'not ours');
  const open = new Set(['01c194fe']);
  const closed = (sid: string) => !open.has(sid);

  const dry = await sweepGitBashStray(stray, top, closed, true);
  assert.deepEqual(dry.removed.map((r) => path.basename(r.path)).sort(), ['ffa-48e6e232', 'ffa-4e9bffcb']);
  assert.ok(fs.existsSync(path.join(stray, 'ffa-48e6e232')), 'a dry run removes nothing');

  const r = await sweepGitBashStray(stray, top, closed);
  assert.deepEqual(r.removed.map((x) => path.basename(x.path)).sort(), ['ffa-48e6e232', 'ffa-4e9bffcb']);
  assert.deepEqual(r.kept.map((x) => path.basename(x.path)), ['ffa-01c194fe']);
  assert.match(r.kept[0]!.why, /has not closed/);
  assert.deepEqual(r.emptied, [], 'an open worker\'s folder keeps the chain');
  assert.ok(fs.existsSync(path.join(stray, 'ffa-01c194fe', 'ffu-280')));

  open.clear(); // w2895 closes
  const after = await sweepGitBashStray(stray, top, closed);
  assert.deepEqual(after.removed.map((x) => path.basename(x.path)), ['ffa-01c194fe']);
  assert.deepEqual(after.emptied, [stray, path.dirname(stray), top]);
  assert.ok(!fs.existsSync(top));
  assert.ok(fs.existsSync(path.join(base, 'beside.txt')), 'nothing above the top is touched');
});

test('w3707: anything in the stray root that is not a worker folder stays, and so does the chain', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'w3707-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const top = path.join(base, 'v');
  const stray = path.join(top, 'ffw', 'tmp');
  fs.mkdirSync(path.join(stray, 'someone'), { recursive: true });
  const r = await sweepGitBashStray(stray, top, () => true);
  assert.deepEqual(r.removed, []);
  assert.equal(r.kept[0]!.why, 'not a worker temp folder');
  assert.deepEqual(r.emptied, []);
  assert.ok(fs.existsSync(path.join(stray, 'someone')));
});
