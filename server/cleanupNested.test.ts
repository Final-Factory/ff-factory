// w6486: planInstallLeftovers drops the items inside other items with dropNested, and norm keeps its answers for
// absolute paths. Both must give exactly what the pairwise loop and the plain norm gave (BEAST's daemon held its event
// loop 13 s in them on 2026-11-27).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { dropNested, norm, normKept, within } from './cleanup.ts';

/** The loop dropNested replaces, as it was. */
const pairwise = <T>(m: Map<string, T>) => {
  for (const p of [...m.keys()]) if ([...m.keys()].some((q) => q !== p && within(p, q))) m.delete(p);
};
/** norm as it was, with nothing kept. */
const plainNorm = (p: string) =>
  (/^[a-zA-Z]:[\\/]|^\\\\/.test(p) ? path.win32 : p.startsWith('/') ? path.posix : path).resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

const PARTS = ['a', 'A', 'b', 'ab', 'a.b', 'ffa-1', '..', '.'];
const ROOTS = ['F:\\ffw', 'f:/ffw/', 'F:\\', 'C:/x', '/', '/home/u', '/home/u/', '\\\\server\\share', '//server/share', 'rel'];
/** A seeded random path: a root and a few parts, joined with either slash, sometimes a trailing one. */
function paths(seed: number, n: number): string[] {
  let x = seed;
  const r = (k: number) => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x % k;
  };
  return Array.from({ length: n }, () => {
    let p = ROOTS[r(ROOTS.length)];
    for (let i = r(4); i > 0; i--) p += (r(2) ? '/' : '\\') + PARTS[r(PARTS.length)];
    return r(5) === 0 ? p + '/' : p;
  });
}

test('w6486: norm gives the same answer as before, kept or not, and within too', () => {
  for (const p of [...paths(7, 400), ...ROOTS]) {
    assert.equal(norm(p), plainNorm(p), p);
    assert.equal(norm(p), plainNorm(p), `${p}, asked again (kept)`);
  }
  const ps = paths(11, 120);
  for (const p of ps) for (const q of ps) assert.equal(within(p, q), plainNorm(p) === plainNorm(q) || plainNorm(p).startsWith(plainNorm(q) + '/'), `${p} in ${q}`);
});

test('w6486: dropNested drops exactly the keys the pairwise loop dropped, in the same order', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const keys = [...new Set(paths(seed, 1 + (seed % 40)))];
    const a = new Map(keys.map((k, i) => [k, i]));
    const b = new Map(a);
    pairwise(a);
    dropNested(b);
    assert.deepEqual([...b.entries()], [...a.entries()], `seed ${seed}: ${keys.join(' | ')}`);
  }
  // Two keys for one folder: the first goes, the second stays; a POSIX root holds every POSIX path; a drive root its drive.
  const m = new Map([['F:\\ffw\\a', 1], ['f:/ffw/A/', 2], ['/', 3], ['/home/u', 4], ['F:\\', 5], ['F:\\ffw\\b', 6], ['C:\\x', 7]]);
  dropNested(m);
  assert.deepEqual([...m.keys()], ['/', 'F:\\', 'C:\\x']);
});

test('w6486: dropNested on a large plan takes milliseconds', () => {
  const m = new Map<string, number>();
  for (let i = 0; i < 20_000; i++) m.set(`F:\\ffw\\tmp\\ffa-${i % 4000}\\cargo\\target-${i}`, i);
  for (let i = 0; i < 4000; i += 2) m.set(`F:\\ffw\\tmp\\ffa-${i}`, i);
  const at = Date.now();
  dropNested(m);
  assert.ok(Date.now() - at < 2000, `${Date.now() - at} ms`);
  assert.equal(m.size, 2000 + 10_000);
});

test('w6508: norm keeps its answer only for paths no working folder changes; a UNC path with no share is worked out each time', () => {
  const kept = String.raw`F:\ffw|c:/x|F:\|/|/home/u|//server/share|\\server\share|\\server\share\a|\\?\C:\x|\\.\pipe\x`.split('|');
  const not = String.raw`\\|\\server|\\server\|\\\x|rel|a\b|C:|C:x`.split('|');
  for (const p of kept) assert.equal(normKept(p), true, p);
  for (const p of not) assert.equal(normKept(p), false, p);
  // What it rests on: a kept path's answer is the same from any working folder; a UNC path with no share's is not.
  for (const p of kept) assert.equal(path.win32.resolve('D:\\one', p) === path.win32.resolve('Q:\\two', p) || !/^[a-zA-Z]:|^\\\\/.test(p), true, p);
  for (const p of not.slice(0, 4)) assert.notEqual(path.win32.resolve('D:\\one', p), path.win32.resolve('Q:\\two', p), p);
});
