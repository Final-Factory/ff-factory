/**
 * w5615, review w6212 B1/B2: the copy with a worker's rights (machine/workerCopy.ts). The plain (unfenced) route runs the
 * real cp on this machine; the fenced routes are checked by the command they build.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { LOW_COPY_SCRIPT, linkIn, plainDirAt, workerCopier, writeFileSafe, type Ran } from './workerCopy.ts';

function tmp(t: TestContext): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workercopy-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
const put = (f: string, text = 'x') => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const realRun = async (cmd: string, argv: string[]): Promise<Ran> => {
  const r = spawnSync(cmd, argv, { encoding: 'utf8' });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
const rm = async (d: string) => fs.rmSync(d, { recursive: true, force: true });

test('linkIn finds a link anywhere in a tree, and the top itself', (t) => {
  const d = tmp(t);
  put(path.join(d, 'a', 'b', 'f'));
  assert.equal(linkIn(path.join(d, 'a')), undefined);
  fs.symlinkSync(d, path.join(d, 'a', 'b', 'l'));
  assert.equal(linkIn(path.join(d, 'a')), path.join('b', 'l'));
  fs.symlinkSync(path.join(d, 'a'), path.join(d, 'top'));
  assert.equal(linkIn(path.join(d, 'top')), '.');
});

test('plainDirAt: a folder where it should be; a link, a folder below a link, a file or nothing is not', (t) => {
  const d = tmp(t);
  fs.mkdirSync(path.join(d, 'players', 's1'), { recursive: true });
  assert.equal(plainDirAt(path.join(d, 'players', 's1'), d, path.join('players', 's1')), true);
  fs.mkdirSync(path.join(d, 'else', 's2'), { recursive: true });
  fs.symlinkSync(path.join(d, 'else'), path.join(d, 'linked'));
  assert.equal(plainDirAt(path.join(d, 'linked'), d, 'linked'), false);
  assert.equal(plainDirAt(path.join(d, 'linked', 's2'), d, path.join('linked', 's2')), false);
  put(path.join(d, 'file'));
  assert.equal(plainDirAt(path.join(d, 'file'), d, 'file'), false);
  assert.equal(plainDirAt(path.join(d, 'none'), d, 'none'), false);
});

test('writeFileSafe replaces a link at the name and never writes through it', (t) => {
  const d = tmp(t);
  put(path.join(d, 'victim'), 'keep');
  fs.symlinkSync(path.join(d, 'victim'), path.join(d, 'slot.json'));
  writeFileSafe(path.join(d, 'slot.json'), '{}');
  assert.equal(fs.readFileSync(path.join(d, 'victim'), 'utf8'), 'keep');
  assert.equal(fs.lstatSync(path.join(d, 'slot.json')).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(d, 'slot.json'), 'utf8'), '{}');
  assert.deepEqual(fs.readdirSync(d).sort(), ['slot.json', 'victim']);
});

test('the plain copy keeps a link as a link (never follows it) for a cache, and refuses a build holding one', async (t) => {
  const d = tmp(t);
  put(path.join(d, 'secret', 'token'), 'shh');
  put(path.join(d, 'src', 'a', 'f'), 'one');
  fs.symlinkSync(path.join(d, 'secret'), path.join(d, 'src', 'a', 'out'));
  const copy = workerCopier({ run: realRun, removeTree: rm });
  await copy(path.join(d, 'src'), path.join(d, 'dst'), { links: 'keep' });
  assert.equal(fs.readFileSync(path.join(d, 'dst', 'a', 'f'), 'utf8'), 'one');
  assert.equal(fs.lstatSync(path.join(d, 'dst', 'a', 'out')).isSymbolicLink(), true);
  await assert.rejects(copy(path.join(d, 'src'), path.join(d, 'build'), { links: 'refuse' }), /holds a link or junction/);
  assert.equal(fs.existsSync(path.join(d, 'build')), false);
});

test('a failed copy removes what it made and says why', async (t) => {
  const d = tmp(t);
  put(path.join(d, 'src', 'f'));
  const removed: string[] = [];
  const copy = workerCopier({
    run: async () => ({ code: 1, stdout: '', stderr: 'deny file-read-data /x\n' }),
    removeTree: async (p) => void removed.push(p),
  });
  await assert.rejects(copy(path.join(d, 'src'), path.join(d, 'dst'), { links: 'keep' }), /failed \(1\): deny file-read-data/);
  assert.deepEqual(removed, [path.join(d, 'dst')]);
});

test('macOS runs cp inside the Seatbelt fence with its read rules on; Linux under the landlock; Windows only in the Low node', async (t) => {
  const d = tmp(t);
  put(path.join(d, 'src', 'f'));
  const ran: [string, string[]][] = [];
  const run = async (c: string, a: string[]) => (ran.push([c, a]), { code: 0, stdout: '', stderr: '' });
  const fence = { kind: 'seatbelt' as const, root: d, home: d, darwinTemp: d, darwinCache: d };
  await workerCopier({ platform: 'darwin', macFence: () => fence, run, removeTree: rm })(path.join(d, 'src'), path.join(d, 'dst'), { links: 'refuse' });
  assert.equal(ran[0][0], '/usr/bin/sandbox-exec');
  assert.ok(ran[0][1].includes('/bin/cp'), ran[0][1].join(' '));
  await workerCopier({ platform: 'linux', linuxLock: () => ['--rw', '/w'], run, removeTree: rm })(path.join(d, 'src'), path.join(d, 'dst2'), { links: 'keep' });
  assert.equal(ran[1][0], 'python3');
  assert.deepEqual(ran[1][1].slice(1), ['--rw', '/w', '--rw', d, '--', 'cp', '-a', '--reflink=auto', path.join(d, 'src'), path.join(d, 'dst2')]);
  await assert.rejects(workerCopier({ platform: 'win32', run, removeTree: rm })(path.join(d, 'src'), path.join(d, 'dst3'), { links: 'keep' }), /no Low node/);
  await workerCopier({ platform: 'win32', lowNode: () => 'C:/low/node.exe', run, removeTree: rm })(path.join(d, 'src'), path.join(d, 'dst4'), { links: 'refuse' });
  assert.deepEqual(ran[2], ['C:/low/node.exe', ['-e', LOW_COPY_SCRIPT, path.join(d, 'src'), path.join(d, 'dst4'), 'refuse']]);
});

test('LOW_COPY_SCRIPT walks the tree without entering a link: keep makes it again, refuse ends with exit 3', async (t) => {
  const d = tmp(t);
  put(path.join(d, 'secret', 'token'), 'shh');
  put(path.join(d, 'src', 'a', 'f'), 'one');
  fs.symlinkSync(path.join(d, 'secret'), path.join(d, 'src', 'a', 'out'));
  const node = (dst: string, mode: string) => spawnSync(process.execPath, ['-e', LOW_COPY_SCRIPT, path.join(d, 'src'), dst, mode], { encoding: 'utf8' });
  const k = node(path.join(d, 'k'), 'keep');
  assert.equal(k.status, 0, k.stderr);
  assert.equal(fs.readFileSync(path.join(d, 'k', 'a', 'f'), 'utf8'), 'one');
  assert.equal(fs.lstatSync(path.join(d, 'k', 'a', 'out')).isSymbolicLink(), true);
  assert.equal(node(path.join(d, 'r'), 'refuse').status, 3);
});
