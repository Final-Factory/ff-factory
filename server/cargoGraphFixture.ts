/**
 * w4258: a cargo target as cargo lays one out, for the tests of the stale-unit sweep (server/cargoGraphSweep.ts) and the ffu slot
 * rule (checked against m5's ffu slot3 target, 2026-11-14): `.fingerprint/<pkg>-<hash>/` with `lib-<pkg>` (the
 * fingerprint, 16 hex digits, little-endian) and `lib-<pkg>.json` (`deps: [[id, name, public, fingerprint as a bare u64]]`,
 * `local`), and the unit's rlib in deps/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fingerprintHex } from './cargoGraphSweep.ts';

const HOUR = 3_600_000;
const TAG = 'Signature: 8a477f597d28d172789f06886806bc55\n# This file is a cache directory tag created by cargo.\n';

export interface FakeUnit {
  name: string;
  hash: string;
  fp: bigint;
  deps?: FakeUnit[];
  workspace?: boolean;
  ageH: number;
  /** Bytes of its rlib in deps/. */
  bytes?: number;
}

/** Write a unit into `<target>/debug` as cargo would. */
export function writeCargoUnit(target: string, u: FakeUnit, NOW: number) {
  const at = (p: string, ageH: number) => fs.utimesSync(p, (NOW - ageH * HOUR) / 1000, (NOW - ageH * HOUR) / 1000);
  const prof = path.join(target, 'debug');
  const fpDir = path.join(prof, '.fingerprint', `${u.name}-${u.hash}`);
  fs.mkdirSync(fpDir, { recursive: true });
  fs.mkdirSync(path.join(prof, 'deps'), { recursive: true });
  fs.writeFileSync(path.join(target, 'CACHEDIR.TAG'), TAG);
  fs.writeFileSync(path.join(fpDir, `lib-${u.name}`), fingerprintHex(u.fp)!);
  const json = {
    rustc: 1,
    deps: (u.deps ?? []).map((d, i) => [i, d.name, false, d.fp.toString()]),
    local: u.workspace ? [{ CheckDepInfo: { dep_info: `lib/${u.name}`, checksum: false } }] : [{ Precalculated: '1.0.0' }],
  };
  // cargo writes the decimal u64 unquoted; JSON.parse reads it as a lossy number, the reason the sweep must not depend on it.
  const text = JSON.stringify(json).replace(/"(\d{16,})"/g, '$1');
  fs.writeFileSync(path.join(fpDir, `lib-${u.name}.json`), text);
  fs.writeFileSync(path.join(fpDir, 'invoked.timestamp'), '');
  const rlib = path.join(prof, 'deps', `lib${u.name}-${u.hash}.rlib`);
  fs.writeFileSync(rlib, Buffer.alloc(u.bytes ?? 1000));
  const d = path.join(prof, 'deps', `${u.name}-${u.hash}.d`);
  fs.writeFileSync(d, '');
  for (const p of [rlib, d, path.join(fpDir, `lib-${u.name}`), path.join(fpDir, `lib-${u.name}.json`), path.join(fpDir, 'invoked.timestamp'), fpDir]) at(p, u.ageH);
}

