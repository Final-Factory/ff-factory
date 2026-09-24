import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CLEANUP, planCleanup, runCleanup } from './cleanup.ts';

test('clean-up: old scratch and clean old clones go; fresh, unpushed, dirty and protected stay', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tmp = path.join(root, 'Temp');
  const now = Date.now();
  const make = (rel: string, ageHours: number) => {
    const p = path.join(tmp, rel);
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'x'), 'x');
    const t = new Date(now - ageHours * 3_600_000);
    fs.utimesSync(p, t, t);
    return p;
  };
  const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  const clone = (name: string, ageHours: number, state: 'clean' | 'dirty' | 'unpushed') => {
    const bare = path.join(root, `${name}.git`);
    execFileSync('git', ['init', '-q', '--bare', bare]);
    const app = path.join(tmp, name, 'app');
    fs.mkdirSync(app, { recursive: true });
    git(app, 'init', '-q');
    git(app, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'one');
    git(app, 'remote', 'add', 'origin', bare);
    git(app, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    git(app, 'fetch', '-q', 'origin');
    if (state === 'dirty') fs.writeFileSync(path.join(app, 'new.txt'), 'work');
    if (state === 'unpushed') git(app, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'local');
    const t = new Date(now - ageHours * 3_600_000);
    fs.utimesSync(path.join(tmp, name), t, t);
    return path.join(tmp, name);
  };
  const oldShot = make('edge-shot-abc123', 5);
  const newShot = make('edge-shot-def456', 0.2);
  const oldTest = make('scenes-Ab12Cd', 30);
  const notOurs = make('scenes-of-a-play', 300); // not the mkdtemp shape: someone else's folder
  const oldClean = clone('fff-old', 24 * 5, 'clean');
  const oldDirty = clone('fff-dirty', 24 * 5, 'dirty');
  const oldUnpushed = clone('ffsb-unpushed', 24 * 5, 'unpushed');
  const newClean = clone('fff-new', 5, 'clean');
  const mine = clone('ffsb-standing', 24 * 5, 'clean'); // contains the running app: kept
  const audit = path.join(root, 'DeterminismAudit');
  fs.mkdirSync(audit);
  for (const [n, days] of [['a', 20], ['b', 3]] as const) {
    const p = path.join(audit, n);
    fs.writeFileSync(p, 'r');
    const t = new Date(now - days * 86_400_000);
    fs.utimesSync(p, t, t);
  }

  const items = planCleanup({
    policy: { ...DEFAULT_CLEANUP, ageRules: [{ path: audit, olderThanDays: 14 }, { path: path.join(root, 'protected'), olderThanDays: 1 }] },
    tempDir: tmp,
    keep: [path.join(mine, 'app'), path.join(root, 'protected')],
    now,
  });
  const chosen = items.map((i) => i.path).sort();
  assert.deepEqual(chosen, [oldShot, oldTest, oldClean, path.join(audit, 'a')].sort());
  for (const p of [newShot, notOurs, oldDirty, oldUnpushed, newClean, mine]) assert.ok(!chosen.includes(p), p);

  const r = runCleanup(items);
  assert.equal(r.removed.length, 4);
  assert.ok(!fs.existsSync(oldShot) && !fs.existsSync(oldClean) && fs.existsSync(oldDirty) && fs.existsSync(path.join(audit, 'b')));
});
