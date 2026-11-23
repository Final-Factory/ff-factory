import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { doomedName, hasCleanSuffix, renameAway, withoutCleanSuffix } from './renameAway.ts';
import { removeRenamed, type CleanupRun } from './cleanup.ts';

// w5268: biscuit's ffa-bd1baf7b gained one `.ffclean-<ms>` per failed pass until its name passed the limit (ENAMETOOLONG).
const STACKED = 'ffa-bd1baf7b.ffclean-1791750838504.ffclean-1791777592746';

function scratch(t: { after: (fn: () => void) => void }): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ffclean-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

function folder(dir: string, name: string): string {
  const p = path.join(dir, name);
  fs.mkdirSync(path.join(p, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(p, 'sub', 'f.txt'), 'x');
  return p;
}

const run = (): CleanupRun => ({ removed: [], failed: [], bytes: 0 });
const suffixes = (n: string) => n.match(/\.ffclean-\d+/g)?.length ?? 0;

test('doomedName: a name that already carries two suffixes gets one, never three', () => {
  const p = path.join('/x', 'tmp', STACKED);
  assert.equal(withoutCleanSuffix(p), path.join('/x', 'tmp', 'ffa-bd1baf7b'));
  assert.equal(path.basename(doomedName(p, 42)), 'ffa-bd1baf7b.ffclean-42');
  assert.equal(suffixes(path.basename(doomedName(p))), 1);
  assert.equal(path.basename(doomedName(path.join('/x', 'ffa-1'), 7)), 'ffa-1.ffclean-7');
  assert.ok(hasCleanSuffix(p));
  assert.ok(!hasCleanSuffix(path.join('/x', 'ffa-1')));
  assert.ok(!hasCleanSuffix(path.join('/x', 'a.ffclean-1', 'child')), 'only the last segment counts');
});

test('renameAway: a stacked name is not renamed again; a plain one gets exactly one suffix', async (t) => {
  const d = scratch(t);
  const stacked = folder(d, STACKED);
  assert.equal(await renameAway(stacked), stacked);
  assert.deepEqual(fs.readdirSync(d), [STACKED], 'the rename added no suffix');

  const plain = folder(d, 'ffa-cafe1234');
  const away = await renameAway(plain, 1791999999999);
  assert.equal(path.basename(away), 'ffa-cafe1234.ffclean-1791999999999');
  assert.ok(fs.existsSync(away) && !fs.existsSync(plain));
});

test('removeRenamed: a stacked temp folder is removed in place, with no rename', async (t) => {
  const d = scratch(t);
  const stacked = folder(d, STACKED);
  const rename = mock.method(fs.promises, 'rename');
  t.after(() => rename.mock.restore());
  const out = run();
  assert.equal(await removeRenamed({ path: stacked, rule: 'stopped-session-temp', why: 'test' }, out), true);
  assert.equal(rename.mock.callCount(), 0, 'no rename');
  assert.deepEqual(fs.readdirSync(d), [], 'gone, nothing left renamed beside it');
  assert.deepEqual(out.removed.map((r) => r.path), [stacked]);
  assert.deepEqual(out.failed, []);
});

test('removeRenamed: a rename refused as ENAMETOOLONG removes the folder in place', async (t) => {
  const d = scratch(t);
  const p = folder(d, 'ffa-0123abcd');
  const rename = mock.method(fs.promises, 'rename', async () => {
    throw Object.assign(new Error('name too long'), { code: 'ENAMETOOLONG' });
  });
  t.after(() => rename.mock.restore());
  const out = run();
  assert.equal(await removeRenamed({ path: p, rule: 'stopped-session-temp', why: 'test' }, out), true);
  assert.equal(rename.mock.callCount(), 1);
  assert.ok(!fs.existsSync(p));
  assert.deepEqual(out.failed, []);
});

test('removeRenamed: any other rename error still leaves the entry whole (in use)', async (t) => {
  const d = scratch(t);
  const p = folder(d, 'ffa-busy0001');
  const rename = mock.method(fs.promises, 'rename', async () => {
    throw Object.assign(new Error('busy'), { code: 'EBUSY' });
  });
  t.after(() => rename.mock.restore());
  const out = run();
  assert.equal(await removeRenamed({ path: p, rule: 'stopped-session-temp', why: 'test' }, out), false);
  assert.ok(fs.existsSync(path.join(p, 'sub', 'f.txt')), 'kept whole');
  assert.match(out.failed[0].why, /in use \(EBUSY\)/);
});
