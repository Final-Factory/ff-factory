import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// w6434: on Linux the daemon's code runs through the `<daemon>/app` link to `code/app`; its entry points must still run.

test('w6434: a script started through a folder link is its own main module, and an import is not', { skip: process.platform === 'win32' && 'needs symlinks' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w6434-main-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = path.join(dir, 'code', 'app', 'machine');
  fs.mkdirSync(real, { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, 'isMain.ts'), path.join(real, 'isMain.ts'));
  fs.writeFileSync(path.join(real, 'entry.ts'), "import { isMainModule } from './isMain.ts';\nconsole.log(isMainModule(import.meta.filename) ? 'main' : 'not main');\n");
  fs.writeFileSync(path.join(real, 'other.ts'), "import './entry.ts';\n");
  fs.symlinkSync(path.join('code', 'app'), path.join(dir, 'app'));
  const run = (f: string) => spawnSync(process.execPath, [path.join(dir, 'app', 'machine', f)], { encoding: 'utf8' });
  const r = run('entry.ts');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'main', 'through the link');
  assert.equal(run('other.ts').stdout.trim(), 'not main', 'imported by another script');
});
