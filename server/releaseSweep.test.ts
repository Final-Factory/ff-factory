import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RELEASE_SETTINGS, planInstallLeftovers } from './installLeftovers.ts';
import type { CleanupGuard } from './cleanup.ts';

/**
 * w913: when a sandbox is released its last worker's build and capture output goes with the Library trim: the newest build per
 * cache stays, the rest, benchmark builds and capture output go, never Library, never the nightly lab or a session's temp.
 */
test('w913: a released sandbox keeps its newest cached build and loses the rest of what its worker built', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffw-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sb = path.join(root, 'sandboxes', 'slot1');
  const age = (p: string, hours: number) => {
    const at = new Date(Date.now() - hours * 3_600_000);
    fs.utimesSync(p, at, at);
  };
  const make = (rel: string, hours: number) => {
    const f = path.join(sb, rel, 'f.bin');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'x'.repeat(100));
    age(f, hours);
    age(path.dirname(f), hours);
  };
  make('.nightly-builds/cache/aaa', 30);
  make('.nightly-builds/cache/bbb', 20);
  make('.nightly-builds/cache/ccc', 10); // newest: stays
  make('Builds/cache/ddd', 5);
  make('Builds/cache/eee', 40);
  make('Builds/bench-before3', 3);
  make('Builds/bench-live', 0); // a build still writing: stays
  make('.nightly-builds/clips', 2);
  make('.nightly-builds/shots', 2);
  make('Library/BurstCache', 100); // the Library trim's, not this sweep's
  make('Assets/Screenshots', 100);
  make('Builds/w913-mine', 5); // not a named child: left to the stale-output rules
  const nightly = path.join(root, 'nightly', 'builds', 'old');
  fs.mkdirSync(nightly, { recursive: true });
  age(nightly, 100);
  const guard: CleanupGuard = { keep: [path.join(root, 'repo')], inUse: [], home: path.join(root, 'home') };
  const plan = await planInstallLeftovers({ root, sandboxes: [sb], tempRoots: [path.join(root, 'tmp')], guard, settings: RELEASE_SETTINGS, scope: 'sandboxes' });
  const gone = plan.items.map((i) => path.relative(sb, i.path).split(path.sep).join('/')).sort();
  assert.deepEqual(gone, ['.nightly-builds/cache/aaa', '.nightly-builds/cache/bbb', '.nightly-builds/clips', '.nightly-builds/shots', 'Builds/bench-before3', 'Builds/cache/eee']);
  // outside the install folder: nothing, whatever the sandbox path says
  const outside = await planInstallLeftovers({ root: path.join(root, 'elsewhere'), sandboxes: [sb], tempRoots: [], guard, settings: RELEASE_SETTINGS, scope: 'sandboxes' });
  assert.equal(outside.items.length, 0);
});
