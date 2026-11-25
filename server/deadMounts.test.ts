import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearDeadMounts, mountOps, mountsUnder, parseMountinfo } from './deadMounts.ts';
import { removeRenamed, type CleanupRun } from './cleanup.ts';

// w5276: biscuit, 2026-11-23. The stacked temp folder held two dead FUSE mounts (a desktop session's runtime folder in a
// worker's temp folder); every pass failed with `partly removed (EBUSY); the rest next pass`. These are its two lines of
// /proc/self/mountinfo, with the folder replaced by `<DIR>`.
const BISCUIT = [
  '5182 44 0:80 / <DIR>/w994/gs/gvfs rw,nosuid,nodev,relatime shared:1132 - fuse.gvfsd-fuse gvfsd-fuse rw,user_id=1000,group_id=1000',
  '5225 44 0:81 / <DIR>/w994/gs/doc rw,nosuid,nodev,relatime shared:1229 - fuse.portal portal rw,user_id=1000,group_id=1000',
];
const ROOT = '29 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw';
const STACKED = 'ffa-bd1baf7b.ffclean-1791750838504.ffclean-1791777592746';

const run = (): CleanupRun => ({ removed: [], failed: [], bytes: 0 });

/** The folder as it stood on biscuit: `<dir>/w994/gs/{gvfs,doc}`, the mount points as plain folders here. */
function fixture(t: { after: (fn: () => void) => void }): { dir: string; points: string[] } {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmount-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const dir = path.join(d, STACKED);
  // A mount point as /proc/self/mountinfo spells it: the lines join it to the folder with /, on Windows too (w5810).
  const points = ['gvfs', 'doc'].map((n) => `${dir}/w994/gs/${n}`);
  for (const p of points) fs.mkdirSync(p, { recursive: true });
  return { dir, points };
}

/**
 * Stand in for the system: a mount table built from `lines`, `dead` per point, and an unmount that takes the line off.
 * A mounted point makes rm fail with EBUSY, as on biscuit.
 */
function system(t: { after: (fn: () => void) => void }, dir: string, lines: string[], dead: (p: string) => boolean) {
  let table = [ROOT, ...lines.map((l) => l.replace('<DIR>', dir))];
  const unmounted: string[] = [];
  const mounted = () => parseMountinfo(table.join('\n')).map((m) => m.point);
  const mi = mock.method(mountOps, 'mountinfo', async () => table.join('\n'));
  const de = mock.method(mountOps, 'dead', async (p: string) => dead(p));
  const um = mock.method(mountOps, 'unmount', async (p: string) => {
    unmounted.push(p);
    table = table.filter((l) => parseMountinfo(l)[0]?.point !== p);
  });
  const realRm = fs.promises.rm;
  const rm = mock.method(fs.promises, 'rm', async (p: fs.PathLike, o?: fs.RmOptions) => {
    if (mounted().some((m) => m.startsWith(`${String(p)}/`))) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return realRm(p, o);
  });
  t.after(() => [mi, de, um, rm].forEach((m) => m.mock.restore()));
  return { unmounted };
}

test('parseMountinfo and mountsUnder: biscuit lines, deepest first, an escaped space, nothing outside the folder', () => {
  const ms = parseMountinfo([ROOT, ...BISCUIT.map((l) => l.replace('<DIR>', '/t/x')), '9 1 0:9 / /t/x\\040y rw - tmpfs t rw'].join('\n'));
  assert.deepEqual(ms.map((m) => m.fstype), ['ext4', 'fuse.gvfsd-fuse', 'fuse.portal', 'tmpfs']);
  assert.equal(ms[3].point, '/t/x y');
  assert.deepEqual(mountsUnder('/t/x', ms).map((m) => m.point).sort(), ['/t/x/w994/gs/doc', '/t/x/w994/gs/gvfs']);
  assert.deepEqual(mountsUnder('/t', ms).map((m) => m.point).at(-1), '/t/x y');
  assert.deepEqual(mountsUnder('/t/x/w994/gs/gv', ms), [], 'a name prefix is not inside');
});

test('removeRenamed: the stacked folder with two dead FUSE mounts inside is unmounted and removed', async (t) => {
  const { dir, points } = fixture(t);
  const sys = system(t, dir, BISCUIT, () => true);
  const out = run();
  assert.equal(await removeRenamed({ path: dir, rule: 'leftover', why: 'left over from an interrupted removal' }, out), true);
  assert.deepEqual(sys.unmounted.sort(), [...points].sort());
  assert.ok(!fs.existsSync(dir));
  assert.deepEqual(out.failed, []);
  assert.deepEqual(out.removed.map((r) => r.path), [dir]);
});

test('removeRenamed: an unmount that fails refuses the folder whole instead of half deleting it', async (t) => {
  const { dir } = fixture(t);
  system(t, dir, BISCUIT, () => true);
  mock.method(mountOps, 'unmount', async () => {
    throw new Error('fusermount: not permitted');
  });
  const out = run();
  assert.equal(await removeRenamed({ path: dir, rule: 'leftover', why: 'test' }, out), false);
  assert.ok(fs.existsSync(dir), 'left whole');
  assert.match(out.failed[0].why, /^refused: a live mount inside/);
});

test('removeRenamed: a LIVE mount inside refuses the folder whole; nothing is unmounted or deleted', async (t) => {
  const { dir } = fixture(t);
  fs.writeFileSync(path.join(dir, 'w994', 'gs', 'doc', 'a-persons-file.txt'), 'keep');
  const sys = system(t, dir, BISCUIT, (p) => p.endsWith('gvfs'));
  const out = run();
  assert.equal(await removeRenamed({ path: dir, rule: 'stopped-session-temp', why: 'test' }, out), false);
  assert.ok(fs.existsSync(path.join(dir, 'w994', 'gs', 'doc', 'a-persons-file.txt')), 'what the mount shows is kept');
  assert.equal(out.failed.length, 1);
  assert.match(out.failed[0].why, /^refused: a live mount inside \(.*\/w994\/gs\/doc\)/);
  assert.ok(sys.unmounted.every((p) => p.endsWith('gvfs')), 'only the dead one may come off');
});

test('clearDeadMounts: a dead mount that is not FUSE is never unmounted', async (t) => {
  const { dir } = fixture(t);
  const sys = system(t, dir, [`77 1 0:7 / <DIR>/w994/gs/gvfs rw - nfs srv:/x rw`], () => true);
  assert.match((await clearDeadMounts(dir)).live ?? '', /gvfs$/);
  assert.deepEqual(sys.unmounted, []);
});

test('clearDeadMounts: no mounts inside is a no-op', async (t) => {
  const { dir } = fixture(t);
  const sys = system(t, dir, [], () => true);
  assert.deepEqual(await clearDeadMounts(dir), { cleared: [] });
  assert.deepEqual(sys.unmounted, []);
});
