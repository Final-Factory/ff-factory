import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { postTextFromFile } from './ffboxPostFile.ts';

function dirs(t: { after: (fn: () => void) => void }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ffbox-postfile-'));
  const cwd = path.join(base, 'work');
  const outside = path.join(base, 'elsewhere');
  fs.mkdirSync(cwd);
  fs.mkdirSync(outside);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { cwd, outside };
}

test('a file in the working folder becomes the text, minus the lines to skip', async (t) => {
  const { cwd } = dirs(t);
  fs.writeFileSync(path.join(cwd, 'notes.md'), 'steam_description: Dev build 94: x\r\n\r\n**Build 94** Title\r\n\r\n* one\r\n');
  assert.equal(await postTextFromFile(cwd, 'notes.md', 2, [cwd]), '**Build 94** Title\n\n* one\n');
  assert.equal(await postTextFromFile(cwd, 'notes.md', undefined, [cwd]), 'steam_description: Dev build 94: x\n\n**Build 94** Title\n\n* one\n');
});

test('a file outside the working and temp folders is refused, and so is one over 16 KB or a missing one', async (t) => {
  const { cwd, outside } = dirs(t);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
  await assert.rejects(postTextFromFile(cwd, path.join(outside, 'secret.txt'), 0, [cwd]), /only a file in your working folder or your own temp folder/);
  fs.writeFileSync(path.join(cwd, 'big.md'), 'x'.repeat(16 * 1024 + 1));
  await assert.rejects(postTextFromFile(cwd, 'big.md', 0, [cwd]), /at most 2000 characters/);
  await assert.rejects(postTextFromFile(cwd, 'nope.md', 0, [cwd]), /no such file/);
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(cwd, 'link.md'));
  await assert.rejects(postTextFromFile(cwd, 'link.md', 0, [cwd]), /only a file in your working folder/, 'a symlink out of the folder is followed to where it points, and refused');
});
