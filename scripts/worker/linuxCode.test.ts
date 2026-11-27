import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { linuxCodeFolder, newLinuxCode, swapBackLinuxCode, swapInLinuxCode } from './linuxCode.ts';
import { FF_LANDLOCK, readLockArgs, writeLockArgs } from '../../machine/writeLock.ts';

// w6434: the Linux daemon's code behind the code link (scripts/worker/linuxCode.ts), and that Landlock runs keep it.

const links = process.platform !== 'win32';
const version = (appDir: string, which: 'app' | 'app.old' | 'app.failed') => fs.readFileSync(path.join(linuxCodeFolder(appDir, which), 'machine', 'VERSION'), 'utf8').trim();

function build(appDir: string, v: string) {
  const dir = newLinuxCode(appDir);
  fs.mkdirSync(path.join(dir, 'machine'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'machine', 'VERSION'), v + '\n');
  fs.writeFileSync(path.join(dir, 'machine', 'ghApp.ts'), `// ${v}\n`);
}

test('w6434: an update moves the old layout behind the code link, swaps inside code/, and a rollback puts the old code back', { skip: !links && 'needs symlinks (the layout is Linux only)' }, (t) => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w6434-'));
  t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));
  // The old layout: a real app folder and an older app.old beside it.
  for (const [d, v] of [['app', 'A'], ['app.old', 'Z']]) {
    fs.mkdirSync(path.join(appDir, d, 'machine'), { recursive: true });
    fs.writeFileSync(path.join(appDir, d, 'machine', 'VERSION'), v + '\n');
  }
  assert.equal(version(appDir, 'app.old'), 'Z', 'the old layout reads its own app.old');
  build(appDir, 'B');
  swapInLinuxCode(appDir);
  assert.equal(fs.readlinkSync(path.join(appDir, 'app')), path.join('code', 'app'), 'app is the relative code link');
  assert.equal(version(appDir, 'app'), 'B');
  assert.equal(version(appDir, 'app.old'), 'A', 'the real app folder became code/app.old');
  assert.equal(fs.existsSync(path.join(appDir, 'app.old')), false, "the old layout's app.old is gone");
  assert.equal(fs.readFileSync(path.join(appDir, 'app', 'machine', 'VERSION'), 'utf8').trim(), 'B', 'read through the link');
  build(appDir, 'C');
  swapInLinuxCode(appDir);
  assert.deepEqual([version(appDir, 'app'), version(appDir, 'app.old')], ['C', 'B']);
  assert.deepEqual(fs.readdirSync(path.join(appDir, 'code')).sort(), ['app', 'app.old']);
  swapBackLinuxCode(appDir);
  assert.deepEqual([version(appDir, 'app'), version(appDir, 'app.failed')], ['B', 'C'], 'the rollback: app.old back, the new code aside');
  assert.throws(() => swapBackLinuxCode(appDir), /no .*app\.old to put back/);
  assert.equal(version(appDir, 'app'), 'B', 'a refused rollback moves nothing');
});

test('w6434: after a downgrade put a real app folder back, the next update moves it over and drops the stale code/app', { skip: !links && 'needs symlinks' }, (t) => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w6434-'));
  t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));
  build(appDir, 'B');
  swapInLinuxCode(appDir);
  // An installer from before w6434: app (the link) -> app.old, a new real app.
  fs.renameSync(path.join(appDir, 'app'), path.join(appDir, 'app.old'));
  fs.mkdirSync(path.join(appDir, 'app', 'machine'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'app', 'machine', 'VERSION'), 'OLD\n');
  assert.equal(fs.readFileSync(path.join(appDir, 'app.old', 'machine', 'VERSION'), 'utf8').trim(), 'B', "the old installer's app.old is the link, and still leads to code");
  build(appDir, 'D');
  swapInLinuxCode(appDir);
  assert.deepEqual([version(appDir, 'app'), version(appDir, 'app.old')], ['D', 'OLD']);
  assert.equal(fs.lstatSync(path.join(appDir, 'app')).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(appDir, 'app.old')), false);
});

const landlock = process.platform === 'linux' && spawnSync('python3', [FF_LANDLOCK, '--', 'true']).status === 0;

/** A run under the lock and the read rules reads ghApp.ts, waits for `go`, then reads it again; `swap` runs in between. */
async function readAcrossSwap(root: string, swap: () => void): Promise<string[]> {
  const appDir = path.join(root, 'daemon');
  const flag = path.join(path.dirname(root), 'go');
  const file = path.join(appDir, 'app', 'machine', 'ghApp.ts');
  const script = `r() { if cat "${file}" >/dev/null 2>&1; then echo "$1 ok"; else echo "$1 refused"; fi; }; r before; echo up; while [ ! -e "${flag}" ]; do sleep 0.05; done; r after`;
  const child = spawn('python3', [FF_LANDLOCK, ...writeLockArgs({ root }), ...readLockArgs({ root }), '--', 'bash', '-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('up\n')) resolve();
    });
    child.on('exit', () => reject(new Error(`the run ended early: ${out} ${err}`)));
  });
  swap();
  fs.writeFileSync(flag, '');
  const code = await new Promise<number | null>((resolve) => (child.exitCode !== null ? resolve(child.exitCode) : child.on('exit', resolve)));
  assert.equal(code, 0, err);
  return out.split('\n').filter((l) => l && l !== 'up');
}

test('live w6434: a run already going reads the new code after an update swaps it inside code/; the old layout lost it (B4 of #1193)', { skip: !landlock && 'needs Linux with Landlock' }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'w6434-live-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  const appDir = path.join(root, 'daemon');
  for (const d of ['secrets', 'tmp']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.mkdirSync(appDir, { recursive: true });
  build(appDir, 'A');
  swapInLinuxCode(appDir);
  assert.deepEqual(await readAcrossSwap(root, () => (build(appDir, 'B'), swapInLinuxCode(appDir))), ['before ok', 'after ok'], 'the code link keeps the new code readable');
  assert.equal(version(appDir, 'app'), 'B');
  // The old layout's swap, as installers before w6434 did it: the renamed-in app is a new entry of the closed folder.
  fs.rmSync(path.join(appDir, 'app'));
  fs.rmSync(path.join(appDir, 'code'), { recursive: true });
  fs.mkdirSync(path.join(appDir, 'app', 'machine'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'app', 'machine', 'ghApp.ts'), '// old\n');
  const oldSwap = () => {
    fs.mkdirSync(path.join(appDir, 'app.new', 'machine'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'app.new', 'machine', 'ghApp.ts'), '// new\n');
    fs.renameSync(path.join(appDir, 'app'), path.join(appDir, 'app.old'));
    fs.renameSync(path.join(appDir, 'app.new'), path.join(appDir, 'app'));
  };
  assert.deepEqual(await readAcrossSwap(root, oldSwap), ['before ok', 'after refused'], 'the old layout: the swap took the code from the run');
});
