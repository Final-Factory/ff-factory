import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { planCleanup, removeRenamed, runCleanup, type CleanupRun } from './cleanup.ts';
import { withoutOverlap } from './staleOutput.ts';

// w5284: biscuit, 2026-11-23 15:12:33Z. agent-temp removed tmp/ffa-23762b98, ffa-29812d82 and ffa-ac9b16c2 whole, then the
// own-leftover plan's items for the same folders (and for ffa-ac9b16c2's entries one by one) each failed `in use (ENOENT)`:
// 130 of them. The own plan had split ffa-ac9b16c2 because `pmc-iauuxz34/work`, two levels down, held a clone with commits
// on no remote, which agent-temp's one-level repo search never saw.

const run = (): CleanupRun => ({ removed: [], failed: [], bytes: 0 });
const guard = (home: string) => ({ keep: [], inUse: [], home: path.join(home, 'nobody') });

function scratch(t: { after: (fn: () => void) => void }): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ffoverlap-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

function old(p: string) {
  const then = new Date(Date.now() - 48 * 3_600_000);
  const walk = (q: string) => {
    if (fs.lstatSync(q).isDirectory()) for (const n of fs.readdirSync(q)) walk(path.join(q, n));
    fs.utimesSync(q, then, then);
  };
  walk(p);
}

test('runCleanup: a folder and a child of it both planned: the folder goes, failedAll stays empty', async (t) => {
  const tmp = scratch(t);
  const dir = path.join(tmp, 'ffa-ac9b16c2');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'b-a.log'), 'x');
  const items = [
    { path: dir, rule: 'agent-temp', why: 'test' },
    { path: path.join(dir, 'b-a.log'), rule: 'stopped-session-temp', why: 'test' },
    { path: path.join(dir, 'sub'), rule: 'stopped-session-temp', why: 'test' },
    { path: dir, rule: 'stopped-session-temp', why: 'planned twice' },
  ];
  const out = await runCleanup(items, guard(tmp));
  assert.deepEqual(out.failed, []);
  assert.deepEqual(out.removed.map((r) => r.path), [dir], 'counted once, the children not counted');
  assert.ok(!fs.existsSync(dir));
});

test('removeRenamed: a path already gone is neither failed nor removed', async (t) => {
  const tmp = scratch(t);
  const out = run();
  assert.equal(await removeRenamed({ path: path.join(tmp, 'ffa-gone0001'), rule: 'agent-temp', why: 'test' }, out), true);
  assert.deepEqual(out, run());
});

test('withoutOverlap: biscuit 15:12Z: a folder the own plan split stays with it; one both took whole runs once', () => {
  const T = '/home/u/ffw/tmp';
  const regular = ['ffa-23762b98', 'ffa-29812d82', 'ffa-ac9b16c2'].map((n) => ({ path: `${T}/${n}`, rule: 'agent-temp' }));
  const own = {
    items: [`${T}/ffa-23762b98`, `${T}/ffa-ac9b16c2/b-a.log`, `${T}/ffa-ac9b16c2/crop.py`, `${T}/ffa-ac9b16c2/claude-1000`].map((p) => ({ path: p })),
    listed: [{ path: `${T}/ffa-ac9b16c2/pmc-iauuxz34/work` }],
  };
  const r = withoutOverlap(regular, own);
  assert.deepEqual(r.first.map((i) => path.basename(i.path)), ['ffa-23762b98', 'ffa-29812d82'], 'ffa-ac9b16c2 left to the own plan');
  assert.deepEqual(r.own.map((i) => path.relative(T, i.path)), ['ffa-ac9b16c2/b-a.log', 'ffa-ac9b16c2/crop.py', 'ffa-ac9b16c2/claude-1000']);
});

test('planCleanup: agent-temp keeps a session folder with a git repo two levels down (pmc-*/work)', async (t) => {
  const tmp = scratch(t);
  const keepDir = path.join(tmp, 'ffa-ac9b16c2');
  const work = path.join(keepDir, 'pmc-iauuxz34', 'work');
  fs.mkdirSync(work, { recursive: true });
  execFileSync('git', ['init', '-q', work]);
  fs.writeFileSync(path.join(keepDir, 'b-a.log'), 'x');
  const goes = path.join(tmp, 'ffa-29812d82');
  fs.mkdirSync(path.join(goes, 'a', 'b'), { recursive: true });
  for (const p of [keepDir, goes]) old(p);
  const items = await planCleanup({ rules: [{ id: 'agent-temp', dir: tmp, names: ['ffa-*'], olderThanHours: 2, what: 'test' }], guard: guard(tmp) });
  assert.deepEqual(items.map((i) => path.basename(i.path)).sort(), ['ffa-29812d82']);
});
