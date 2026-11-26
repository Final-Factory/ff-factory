import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isLink, linkTarget, removeLink } from './fsLink.ts';

// w5915: a junction a Low-integrity process makes (each BEAST worker, this test run included there) is a plain folder to
// Node's lstat and EINVAL to its readlink; these see it as a link wherever the test runs, and remove only the link.

test('w5915: a junction or folder link is a link, its target is where it leads, and removing it leaves the target whole', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-fslink-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'precious.txt'), 'x');
  const plain = path.join(base, 'plain');
  fs.mkdirSync(plain);
  const link = path.join(base, 'link');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(isLink(link), true);
  assert.equal(isLink(plain), false);
  assert.equal(isLink(path.join(base, 'missing')), false);
  assert.equal(fs.realpathSync.native(linkTarget(link)), fs.realpathSync.native(outside));
  removeLink(link);
  assert.equal(fs.existsSync(link), false);
  assert.ok(fs.existsSync(path.join(outside, 'precious.txt')), 'the target survives');
  fs.writeFileSync(path.join(plain, 'f'), 'x');
  assert.throws(() => removeLink(plain), 'a real folder with something in it is never removed');
  assert.ok(fs.existsSync(path.join(plain, 'f')));
});
