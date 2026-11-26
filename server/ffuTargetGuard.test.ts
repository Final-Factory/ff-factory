import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkPrivateFfuTarget, targetDirsIn } from './ffuTargetGuard.ts';
import { runCleanup } from './cleanup.ts';

/** w4258: a worker that holds an ffu slot never points cargo at its temp folder (server/ffuTargetGuard.ts). */

const root = path.join(os.tmpdir(), 'ff-w4258g-root');
const tmp = path.join(root, 'tmp', 'ffa-aaaa1111');
const env = { TMPDIR: tmp, HOME: '/home/x' };
const holds = { env, root, session: 'aaaa1111', heldSlot: () => 'slot2' };

test('w4258: a slot holder is refused a private target in its temp folder, in every spelling', () => {
  for (const cmd of [
    'export CARGO_TARGET_DIR="$TMPDIR/ffu-target"',
    'CARGO_TARGET_DIR=$TMPDIR/ffu-target cargo test -p ffu-sim',
    `cd ${root}/ffu-sandboxes/slot2/ffu && CARGO_TARGET_DIR=${tmp}/ffu-target-main cargo build`,
    'cargo build --target-dir "${TMPDIR}/t2"',
    'cargo test --target-dir=$TMPDIR/ffu-target',
    'env CARGO_TARGET_DIR=$(echo $TMPDIR)/x cargo build',
  ]) assert.match(checkPrivateFfuTarget(cmd, holds) ?? '', /you hold ffu slot2.*ffu-slot where/s, cmd);
  assert.match(checkPrivateFfuTarget('$env:CARGO_TARGET_DIR = "$env:TEMP\\ffu-target"', { ...holds, env: { TEMP: tmp } }) ?? '', /slot2/);
});

test('w4258: the slot target, a worker without a slot, and text that only mentions the variable pass', () => {
  const slot = path.join(root, 'ffu-sandboxes', 'slot2', 'target');
  for (const cmd of [`export CARGO_TARGET_DIR=${slot}`, 'eval "$(ffu-slot where)"', 'cargo test -p ffu-sim', 'echo $CARGO_TARGET_DIR', 'CARGO_TARGET_DIR= cargo build'])
    assert.equal(checkPrivateFfuTarget(cmd, holds), undefined, cmd);
  assert.equal(checkPrivateFfuTarget('export CARGO_TARGET_DIR="$TMPDIR/ffu-target"', { ...holds, heldSlot: () => undefined }), undefined, 'all slots were held: the temp folder is the fallback');
  assert.equal(checkPrivateFfuTarget('export CARGO_TARGET_DIR="$TMPDIR/ffu-target"', { env, root, session: 'aaaa1111' }), undefined, 'no slots.json: no slot held');
  assert.deepEqual(targetDirsIn(`CARGO_TARGET_DIR='a b' cargo build --target-dir c`), ['a b', 'c']);
});

test('w4258: a clean-up item with members removes each member, never the folder, and logs one entry', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w4258m-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'target');
  const f = (p: string, n: number) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, Buffer.alloc(n)), p);
  const a = f(path.join(target, 'debug', 'deps', 'liba-1111111111111111.rlib'), 100);
  const b = f(path.join(target, 'debug', 'incremental', 'a-1111111111111111', 's', 'x.o'), 50);
  const keep = f(path.join(target, 'debug', 'deps', 'libb-2222222222222222.rlib'), 10);
  const outside = f(path.join(dir, 'other.txt'), 10);
  const r = await runCleanup(
    [{ path: target, rule: 'ffu-slot-target', why: 'stale', base: target, members: [a, path.dirname(path.dirname(b)), outside, path.join(target, 'gone')] }],
    { keep: [], inUse: [], home: path.join(dir, 'home') },
  );
  assert.deepEqual(r.removed, [{ path: target, bytes: 150, rule: 'ffu-slot-target', why: 'stale' }]);
  assert.ok(!fs.existsSync(a) && !fs.existsSync(b) && fs.existsSync(keep) && fs.existsSync(outside) && fs.existsSync(target));
});

test('w5885: a worker holding two slots builds in either target; the refusal names both and says a second branch takes a second slot', () => {
  const two = { ...holds, heldSlot: () => ['slot2', 'slot3'] };
  for (const id of ['slot2', 'slot3']) assert.equal(checkPrivateFfuTarget(`export CARGO_TARGET_DIR=${path.join(root, 'ffu-sandboxes', id, 'target')}`, two), undefined, id);
  assert.match(checkPrivateFfuTarget('export CARGO_TARGET_DIR="$TMPDIR/ffu-target-bug"', two) ?? '', /you hold ffu slot2 and slot3.*ffu-slot take --branch <that branch>.*never counts as another worker's/s);
});
