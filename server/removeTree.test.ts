import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTree } from './proc.ts';
import { exact, fakeRd } from './fakeRdTest.ts';

// w6462 (from w6437): rd /s /q answers 0 and leaves `x.`, `y ` and NUL with all that is in them; removeTree must make sure
// the folder is gone, going again by its \\?\ path, and say a failure when it is still there.

function tmp(t: TestContext): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rmtree-'));
  t.after(() => fs.rmSync(exact(d), { recursive: true, force: true }));
  return d;
}
const put = (p: string) => {
  fs.mkdirSync(exact(path.dirname(p)), { recursive: true });
  fs.writeFileSync(exact(p), 'x');
};
const there = (p: string) => fs.lstatSync(exact(p), { throwIfNoEntry: false }) !== undefined;
const PREFIX = '\\\\?\\';

test('removeTree on Windows: a plain folder goes by one rd, as before (w6462)', async (t) => {
  const dir = path.join(tmp(t), 'lib');
  put(path.join(dir, 'a', 'b', 'f'));
  const calls: string[][] = [];
  const r = await removeTree(dir, { run: fakeRd(calls), platform: 'win32' });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!there(dir));
  assert.deepEqual(calls, [['cmd.exe', '/c', 'rd', '/s', '/q', dir]]);
});

test('removeTree on Windows: what rd leaves (`x.`, `y `, NUL, deep or not) goes again by the \\\\?\\ path (w6462)', async (t) => {
  for (const n of ['x.', 'y ', 'NUL', 'nul.txt', path.join('deep', 'z.')]) {
    const dir = path.join(tmp(t), 'sb');
    put(path.join(dir, 'ok', 'f'));
    put(path.join(dir, n, 'payload.dll'));
    const calls: string[][] = [];
    const r = await removeTree(dir, { run: fakeRd(calls), platform: 'win32' });
    assert.equal(r.code, 0, `${n}: ${r.stderr}`);
    assert.ok(!there(dir), `${n}: gone`);
    assert.deepEqual(calls.map((c) => c[5]), [dir, `${PREFIX}${path.resolve(dir)}`], n);
  }
});

test('removeTree on Windows: a folder whose own name ends in a dot or a space goes by its \\\\?\\ path at once, never by the folder its plain path names (w6462)', async (t) => {
  for (const n of ['pkg.', 'pkg ']) {
    const d = tmp(t);
    const dir = path.join(d, n);
    put(path.join(dir, 'f'));
    put(path.join(d, 'pkg', 'keep.txt'));
    const calls: string[][] = [];
    const r = await removeTree(dir, { run: fakeRd(calls), platform: 'win32' });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!there(dir), `${JSON.stringify(n)}: gone`);
    assert.ok(there(path.join(d, 'pkg', 'keep.txt')), `${JSON.stringify(n)}: pkg beside it kept`);
    assert.deepEqual(calls.map((c) => c[5]), [`${PREFIX}${path.resolve(dir)}`]);
  }
});

test('removeTree: a folder still there after every try is a failure, with a line saying so (w6462)', async (t) => {
  const dir = path.join(tmp(t), 'sb');
  put(path.join(dir, 'x.', 'f'));
  const calls: string[][] = [];
  const r = await removeTree(dir, { run: fakeRd(calls, { leaveExact: true }), platform: 'win32' });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /still there after removing it by its plain path and by its \\\\\?\\ path \(w6462\)/);
  assert.equal(calls.length, 2);
  // A relative path has no \\?\ form: no second try, the same failure.
  const rel = path.relative(process.cwd(), dir);
  const calls2: string[][] = [];
  const r2 = await removeTree(rel, { run: fakeRd(calls2, { leaveExact: true }), platform: 'win32' });
  assert.notEqual(r2.code, 0);
  assert.match(r2.stderr, /still there after removing it \(w6462\)/);
  assert.equal(calls2.length, 1);
  // The other OSes: rm -rf, and the same check after it.
  const calls3: string[][] = [];
  const r3 = await removeTree(dir, { run: fakeRd(calls3, { leaveRm: true }), platform: 'linux' });
  assert.notEqual(r3.code, 0);
  assert.deepEqual(calls3, [['rm', '-rf', dir]]);
  const r4 = await removeTree(dir, { run: fakeRd([]), platform: 'linux' });
  assert.equal(r4.code, 0, r4.stderr);
  assert.ok(!there(dir));
});

test('Windows, live: the real removeTree removes `x.`, `y `, NUL and a junction in them, and keeps the junction\'s target (w6462)', { skip: process.platform !== 'win32' && 'rd and junctions are Windows only' }, async (t) => {
  const d = tmp(t);
  const dir = path.join(d, 'sb');
  put(path.join(dir, 'ok', 'f'));
  put(path.join(dir, 'con.txt'));
  for (const n of ['x.', 'y ', 'NUL']) put(path.join(dir, n, 'payload.dll'));
  put(path.join(d, 'outside', 'keep.txt'));
  fs.symlinkSync(path.join(d, 'outside'), exact(path.join(dir, 'x.', 'j')), 'junction');
  const r = await removeTree(dir);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!there(dir), 'gone');
  assert.ok(there(path.join(d, 'outside', 'keep.txt')), 'the junction\'s target kept');
});
