import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BENCH_LOCK_STALE_MS, benchLockDir, readBenchLock } from '../machine/benchLock.ts';
import { needsLive } from '../shared/capacity.ts';
import type { WorkItem } from '../shared/types.ts';

/**
 * w1600: the daemon reads the bench lock the game repo's scripts/bench/quiet_gate.sh holds for a whole timed run
 * (`$FF_WORKER_ROOT/tmp/bench.lock`, its holder in `owner`), so the portal keeps a Live view editor from starting beside it.
 */
test('w1600: readBenchLock reports a held lock with its owner line, nothing when free, stale or without a worker root', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w1600-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(readBenchLock(undefined), undefined, 'no worker root: nothing to read');
  assert.equal(readBenchLock(root), undefined, 'free');
  const dir = benchLockDir(root);
  assert.equal(dir, path.join(root, 'tmp', 'bench.lock'));
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  assert.deepEqual(readBenchLock(root, now)?.owner, 'its owner line is not written yet', 'mkdir comes a moment before the owner line');
  fs.writeFileSync(path.join(dir, 'owner'), 'BEAST pid 4121 worker 21:04:10 probe A round 2 (/f/ffw/sandboxes/slot4)\n');
  const held = readBenchLock(root, now)!;
  assert.equal(held.owner, 'BEAST pid 4121 worker 21:04:10 probe A round 2 (/f/ffw/sandboxes/slot4)');
  assert.ok(Math.abs(Date.parse(held.since) - fs.statSync(dir).mtimeMs) < 1000);
  // Older than quiet_gate.sh's BENCH_LOCK_STALE_MIN (40): a killed run's, which the next run takes over.
  assert.equal(readBenchLock(root, fs.statSync(dir).mtimeMs + BENCH_LOCK_STALE_MS + 1), undefined);
});

const item = (o: Partial<WorkItem>): Pick<WorkItem, 'needs' | 'liveView' | 'title' | 'brief' | 'notes'> => ({ title: 'Add a Shield Battery', brief: 'Do it.', ...o });

test('w1600: needsLive: a request whose worker started a view, or whose words ask for one; never work that needs only an agent slot', () => {
  assert.equal(needsLive(item({})), false);
  assert.equal(needsLive(item({ liveView: { at: '2026-10-19T03:08:00Z', session: 'abc', machine: 'lothdesktop' } })), true);
  // w1468: Ben's "i want live view" arrived as a note on the request.
  assert.equal(needsLive(item({ notes: [{ at: '2026-10-19T02:53:00Z', by: 'ben', text: 'Change more before it merges, then "i want live view".' }] })), true);
  assert.equal(needsLive(item({ brief: 'Open a Live-View of the Ballista for Ben.' })), true);
  assert.equal(needsLive(undefined, 'Stage it in a liveview for Ben.'), true, 'the dispatcher\'s own brief');
  // FF Factory work about Live views (w1599, this request) runs in a clone with no editor.
  assert.equal(needsLive(item({ needs: 'agent', title: 'Sidebar: a "Live view: go" button' })), false);
  assert.equal(needsLive(item({ brief: 'Make the view live-update on change.' })), false);
});
