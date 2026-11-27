import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeRenamed, runCleanup, type CleanupRun } from './cleanup.ts';
import { firstAlonePass } from './staleOutput.ts';

// w6166: on Windows, two fs.promises.rename calls of one directory at the same moment both return ok (BEAST, w6161: 10 of 10), so
// two removals of one released ffu target at once (the w6044 alone step and a pass's later step) both counted it removed.
function slotTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffw-w6166-'));
  const slot = path.join(root, 'ffu-sandboxes', 'slot2');
  const t = path.join(slot, 'target');
  for (let d = 0; d < 20; d++) {
    fs.mkdirSync(path.join(t, 'debug', `d${d}`), { recursive: true });
    for (let f = 0; f < 20; f++) fs.writeFileSync(path.join(t, 'debug', `d${d}`, `f${f}.rlib`), Buffer.alloc(64));
  }
  fs.mkdirSync(path.join(slot, 'ffu'), { recursive: true });
  fs.writeFileSync(path.join(slot, 'ffu', 'keep.rs'), 'x');
  return { root, slot, t };
}

test('w6166: two removals of one released target at once: it goes once, counted once, nothing fails', async () => {
  for (let trial = 0; trial < 5; trial++) {
    const { root, slot, t } = slotTree();
    try {
      const guard = { keep: [], inUse: [], home: path.join(root, 'nobody') };
      const item = { path: t, rule: 'ffu-slot-target', why: 'test' };
      const [a, b] = await Promise.all([
        firstAlonePass({ mode: 'on', root: [root], guard, first: { plan: async () => ({ items: [item], listed: [] }) }, busyNow: async () => undefined }),
        runCleanup([{ ...item }], guard as never, async () => undefined),
      ]);
      assert.equal((a?.removed.length ?? 0) + b.removed.length, 1, 'removed once, counted once');
      assert.equal((a?.bytes ?? 0) + b.bytes, 20 * 20 * 64, 'its bytes once');
      assert.deepEqual([...(a?.failed ?? []), ...b.failed], [], 'the second finds it taken, not a failure');
      assert.ok(!fs.existsSync(t));
      assert.ok(fs.existsSync(path.join(slot, 'ffu', 'keep.rs')), "the slot's checkout stays");
      assert.deepEqual(fs.readdirSync(slot).sort(), ['ffu'], 'no .ffclean leftover beside it');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('w6166: a removal inside one in flight waits and counts nothing; a removal of its parent waits for it', async () => {
  const { root, slot, t } = slotTree();
  try {
    const outs: CleanupRun[] = [0, 1, 2].map(() => ({ removed: [], failed: [], bytes: 0 }));
    await Promise.all([
      removeRenamed({ path: t, rule: 'ffu-slot-target', why: 'test' }, outs[0]),
      removeRenamed({ path: path.join(t, 'debug', 'd3'), rule: 'test', why: 'inside' }, outs[1]),
    ]);
    assert.deepEqual(outs[0].removed.map((r) => r.path), [t]);
    assert.deepEqual([outs[1].removed, outs[1].failed], [[], []], 'inside one in flight: neither removed nor failed');
    fs.mkdirSync(path.join(t, 'x'), { recursive: true });
    fs.writeFileSync(path.join(t, 'x', 'a'), Buffer.alloc(10));
    await Promise.all([
      removeRenamed({ path: t, rule: 'ffu-slot-target', why: 'test' }, outs[0]),
      removeRenamed({ path: slot, rule: 'test', why: 'parent' }, outs[2]),
    ]);
    assert.equal(outs[0].removed.length, 2, 'the target went first');
    assert.deepEqual(outs[2].removed.map((r) => r.path), [slot], 'then its parent');
    assert.deepEqual([...outs[0].failed, ...outs[2].failed], []);
    assert.ok(!fs.existsSync(slot));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
