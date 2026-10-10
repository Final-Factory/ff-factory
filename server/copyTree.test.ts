import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyTree } from './proc.ts';

test('copyTree: excluded top-level folders stay behind, the rest comes along (a Library copy without its caches, w898)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-test-copytree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const src = path.join(root, 'src');
  for (const f of ['ArtifactDB/a', 'BuildCache/ab/x', 'BurstCache/Windows-Intel/y', 'Bee/b', 'BuildCacheNot/z']) {
    fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true });
    fs.writeFileSync(path.join(src, f), 'x');
  }
  const all = path.join(root, 'all');
  await copyTree(src, all);
  assert.ok(fs.existsSync(path.join(all, 'BuildCache', 'ab', 'x')) && fs.existsSync(path.join(all, 'BurstCache', 'Windows-Intel', 'y')), 'no exclude: everything');
  for (const mode of [undefined, 'clone'] as const) {
    const dst = path.join(root, `dst-${mode}`);
    await copyTree(src, dst, { mode, exclude: ['BuildCache', 'BurstCache'] });
    assert.deepEqual(fs.readdirSync(dst).sort(), ['ArtifactDB', 'Bee', 'BuildCacheNot']);
    assert.ok(fs.existsSync(path.join(dst, 'ArtifactDB', 'a')));
  }
});
