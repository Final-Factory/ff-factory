import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planCargoSweep } from './cargoGraphSweep.ts';
import { writeCargoUnit, type FakeUnit } from './cargoGraphFixture.ts';

/**
 * w4258: the stale-unit sweep of a cargo target (server/cargoGraphSweep.ts). A fixture laid out the way cargo writes one (checked
 * against m5's ffu slot3 target, 2026-11-14): `.fingerprint/<pkg>-<hash>/` with `lib-<pkg>` (the fingerprint, 16 hex digits,
 * little-endian) and `lib-<pkg>.json` (`deps: [[id, name, public, fingerprint as a decimal u64]]`, `local`).
 */

const NOW = Date.now();
const HOUR = 3_600_000;
const at = (p: string, ageH: number) => fs.utimesSync(p, (NOW - ageH * HOUR) / 1000, (NOW - ageH * HOUR) / 1000);
const writeUnit = (target: string, u: FakeUnit) => writeCargoUnit(target, u, NOW);

test('w4258: what no recent workspace build uses goes; old dependencies a current unit uses stay; a running binary pins its unit', async (t) => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w4258s-'));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  // Fingerprints above 2^53, as real ones are: a lossy JSON number would break the links.
  const serde: FakeUnit = { name: 'serde', hash: '1111111111111111', fp: 18_000_000_000_000_000_001n, ageH: 24 * 6 };
  const oldDep: FakeUnit = { name: 'glam', hash: '2222222222222222', fp: 17_000_000_000_000_000_003n, ageH: 24 * 4 };
  const simNow: FakeUnit = { name: 'ffu_sim', hash: '3333333333333333', fp: 16_000_000_000_000_000_005n, deps: [serde], workspace: true, ageH: 1 };
  const simOld: FakeUnit = { name: 'ffu_sim', hash: '4444444444444444', fp: 15_000_000_000_000_000_007n, deps: [oldDep, serde], workspace: true, ageH: 24 * 4 };
  const testOld: FakeUnit = { name: 'golden', hash: '5555555555555555', fp: 14_000_000_000_000_000_009n, deps: [simOld], workspace: true, ageH: 24 * 4 };
  const fresh: FakeUnit = { name: 'tool', hash: '6666666666666666', fp: 13_000_000_000_000_000_011n, workspace: false, ageH: 0 };
  for (const u of [serde, oldDep, simNow, simOld, testOld, fresh]) writeUnit(target, u);
  const o = { keepHours: 48, settleMs: 15 * 60_000, now: NOW };
  const hashes = (r: { paths: string[] }) => [...new Set(r.paths.map((p) => /-([0-9a-f]{16})/.exec(path.basename(p))![1]))].sort();

  const r = await planCargoSweep(target, o);
  assert.deepEqual(hashes(r), ['2222222222222222', '4444444444444444', '5555555555555555'], 'the old sim, its old test and the dependency only they used');
  assert.equal(r.units, 6);
  assert.equal(r.live, 2, 'the current sim and the six-day-old serde it uses');
  assert.ok(!r.paths.some((p) => p.includes('6666666666666666')), 'a unit written within the settle time stays, reached or not');

  const pinned = await planCargoSweep(target, { ...o, pinned: [`${target}/debug/deps/golden-5555555555555555 --test-threads 1`] });
  assert.deepEqual(hashes(pinned), [], 'a test binary still running keeps its unit and everything it was built from');

  const none = path.join(target, 'debug', '.fingerprint');
  fs.rmSync(path.join(none, 'ffu_sim-3333333333333333', 'lib-ffu_sim.json'));
  fs.rmSync(path.join(none, 'ffu_sim-4444444444444444', 'lib-ffu_sim.json'));
  fs.rmSync(path.join(none, 'golden-5555555555555555', 'lib-golden.json'));
  assert.deepEqual((await planCargoSweep(target, o)).paths, [], 'no workspace unit to start from: nothing is swept');
});

test('w4258: a live unit loses only its superseded object files: one link, older than its newest build', async (t) => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w4258o-'));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  const sim: FakeUnit = { name: 'ffu_sim', hash: '3333333333333333', fp: 16_000_000_000_000_000_005n, workspace: true, ageH: 1 };
  writeUnit(target, sim);
  const deps = path.join(target, 'debug', 'deps');
  const obj = (n: string, ageH: number) => {
    const p = path.join(deps, `ffu_sim-3333333333333333.${n}.rcgu.o`);
    fs.writeFileSync(p, Buffer.alloc(500));
    at(p, ageH);
    return p;
  };
  const stale = obj('old1', 30);
  const current = obj('new1', 1);
  // An incremental build hard-links the objects it reuses into deps/: those keep their old time and stay.
  const reused = obj('reused', 30);
  fs.mkdirSync(path.join(target, 'debug', 'incremental', 'ffu_sim-x'), { recursive: true });
  fs.linkSync(reused, path.join(target, 'debug', 'incremental', 'ffu_sim-x', 'reused.o'));
  const r = await planCargoSweep(target, { keepHours: 48, settleMs: 15 * 60_000, now: NOW });
  assert.deepEqual(r.paths, [stale]);
  assert.equal(r.objects, 1);
  assert.equal(r.bytes, 500);
  assert.ok(fs.existsSync(current));
});
