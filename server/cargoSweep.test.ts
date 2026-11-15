import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cargoUnits, newestUnitDirWrite, readsMoveAtime, sweepCargoTarget } from '../machine/cargoSweep.ts';

/** w4255: trimming a cargo target by its units' last read (machine/cargoSweep.ts), used on an ffu slot's take. */

const DAY = 86_400_000;
const MB = 1024 * 1024;

function tmp(t: { after: (fn: () => void) => void }): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w4255-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** One cargo unit of `mb` MB across deps, .fingerprint and build, last read `ageDays` ago. */
function unit(target: string, profile: string, name: string, hash: string, ageDays: number, mb = 1): void {
  const p = path.join(target, profile);
  const files = [
    path.join(p, 'deps', `lib${name}-${hash}.rlib`),
    path.join(p, 'deps', `${name}-${hash}.d`),
    path.join(p, '.fingerprint', `${name}-${hash}`, `lib-${name}`),
    path.join(p, 'build', `${name}-${hash}`, 'out', 'gen.rs'),
  ];
  const at = new Date(Date.now() - ageDays * DAY);
  for (const [i, f] of files.entries()) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, Buffer.alloc(i === 0 ? mb * MB : 16));
    fs.utimesSync(f, at, at);
  }
}

const exists = (target: string, rel: string) => fs.existsSync(path.join(target, rel));

test('w4255: a unit is the files of one hash in a profile, across deps, .fingerprint and build', (t) => {
  const target = path.join(tmp(t), 'target');
  unit(target, 'debug', 'serde', '00000000000000aa', 5);
  unit(target, 'release', 'serde', '00000000000000aa', 1);
  unit(target, 'native/release', 'glam', '00000000000000bb', 1);
  fs.writeFileSync(path.join(target, 'debug', 'ffu-headless'), 'bin');
  const units = cargoUnits(target);
  assert.equal(units.length, 3, 'the same hash in two profiles is two units; a custom profile counts; a binary without a hash is none');
  const dbg = units.find((u) => u.key.startsWith(path.join(target, 'debug')))!;
  assert.equal(dbg.paths.length, 4);
  assert.ok(Math.abs(dbg.lastRead - (Date.now() - 5 * DAY)) < 60_000);
});

test('w4255: stale units go whatever the size; read ones stay under the cap; files without a hash stay', (t) => {
  const target = path.join(tmp(t), 'target');
  if (!(fs.mkdirSync(target, { recursive: true }), readsMoveAtime(target))) return t.skip('this drive does not move access times on a read');
  unit(target, 'debug', 'old', '00000000000000aa', 5);
  unit(target, 'debug', 'used', '00000000000000bb', 0);
  unit(target, 'debug', 'young', '00000000000000cc', 2);
  fs.writeFileSync(path.join(target, 'debug', 'ffu-headless'), 'bin');
  fs.utimesSync(path.join(target, 'debug', 'ffu-headless'), new Date(Date.now() - 9 * DAY), new Date(Date.now() - 9 * DAY));
  const r = sweepCargoTarget(target, { capBytes: 100 * MB, staleDays: 3 });
  assert.equal(r.removed, 1);
  for (const rel of ['debug/deps/libold-00000000000000aa.rlib', 'debug/.fingerprint/old-00000000000000aa', 'debug/build/old-00000000000000aa']) assert.ok(!exists(target, rel), rel);
  assert.ok(exists(target, 'debug/deps/libused-00000000000000bb.rlib'));
  assert.ok(exists(target, 'debug/deps/libyoung-00000000000000cc.rlib'));
  assert.ok(exists(target, 'debug/ffu-headless'));
  assert.ok(r.freedBytes >= MB && r.afterBytes < r.beforeBytes);
  assert.ok(!exists(target, '.ff-atime-probe'));
});

test('w4255: over the cap, the least recently read units go until it is under; a unit read in one file stays whole', (t) => {
  const target = path.join(tmp(t), 'target');
  if (!(fs.mkdirSync(target, { recursive: true }), readsMoveAtime(target))) return t.skip('this drive does not move access times on a read');
  unit(target, 'debug', 'a', '000000000000000a', 2, 3);
  unit(target, 'debug', 'b', '000000000000000b', 1.5, 3);
  unit(target, 'debug', 'c', '000000000000000c', 1, 3);
  unit(target, 'debug', 'd', '000000000000000d', 2.5, 3);
  // d's fingerprint was read just now: d is the newest unit, though its rlib was last read days ago
  fs.readFileSync(path.join(target, 'debug', '.fingerprint', 'd-000000000000000d', 'lib-d'));
  const r = sweepCargoTarget(target, { capBytes: 7 * MB, staleDays: 3 });
  assert.equal(r.removed, 2);
  assert.ok(!exists(target, 'debug/deps/liba-000000000000000a.rlib'), 'the oldest read goes first');
  assert.ok(!exists(target, 'debug/deps/libb-000000000000000b.rlib'));
  assert.ok(exists(target, 'debug/deps/libc-000000000000000c.rlib'));
  assert.ok(exists(target, 'debug/deps/libd-000000000000000d.rlib'), 'a unit read in any file is in use');
  assert.ok(r.afterBytes <= 7 * MB);
});

test('w4255: no target is nothing to do, and the write check sees a build', (t) => {
  const base = tmp(t);
  const r = sweepCargoTarget(path.join(base, 'target'), { capBytes: 0, staleDays: 3 });
  assert.equal(r.removed, 0);
  assert.equal(r.skipped, 'no target');
  assert.equal(newestUnitDirWrite(path.join(base, 'target')), 0);
  unit(path.join(base, 'target'), 'debug', 'x', '00000000000000ab', 0);
  assert.ok(Date.now() - newestUnitDirWrite(path.join(base, 'target')) < 60_000);
});

test('w4255: on Linux (relatime, the default) a re-read days later moves an access time, so the trim runs there', (t) => {
  if (process.platform !== 'linux') return t.skip('the probe says no on APFS and NTFS by design');
  assert.ok(readsMoveAtime(tmp(t)), 'a skip here would hide a probe that never lets the trim run on biscuit');
});
