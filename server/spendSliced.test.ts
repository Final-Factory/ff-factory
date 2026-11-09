// w3855: spend.json is built a request or session at a time on the background write (durable.ts stringifyObjectSliced), the
// same bytes as the one-go JSON.stringify it replaces there; flushSync (shutdown) still writes in one go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SnapshotFile, stringifyObjectSliced } from './durable.ts';
import { SpendStore } from './spend.ts';

test('w3855: stringifyObjectSliced is JSON.stringify of the same object, key order included, and lets the event loop run', async () => {
  const entries: [string, number | undefined][] = [['b', 1.5], ['10', 2], ['a', undefined], ['2', 3], ['01', 4], ['-1', 5], ['4294967295', 6], ['4294967294', 7], ['x"y', 8]];
  const value = (v: number | undefined) => (v === undefined ? undefined : { v, half: v / 2 });
  const want = JSON.stringify(Object.fromEntries(entries.map(([k, v]) => [k, value(v)])));
  assert.equal(await stringifyObjectSliced(entries, value), want);
  assert.equal(await stringifyObjectSliced([], value), '{}');
  let ran = false;
  setImmediate(() => (ran = true));
  assert.equal(await stringifyObjectSliced(entries, value, 0), want);
  assert.equal(ran, true, 'the event loop ran between slices');
});

const tok = (n: number) => ({ in: n + 0.4, out: n, cr: n * 3 + 0.6, cw: n, usd: n / 7 });

test('w3855: the spend file built in slices is the one-go file, byte for byte', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-spend-sliced-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const session = (id: string, n: number) => ({ id, role: 'worker', title: id, firstAt: 'x', lastAt: 'y', turns: n, total: tok(n), estimated: tok(1), models: { 'claude-opus-5-5': tok(n) }, cats: { base: { usd: n / 3, tok: n + 0.5 } }, requests: { w1: n / 9 }, calls: n, ctxMax: 0, compactions: 0 });
  const request = (id: string, n: number) => ({ id, title: id, firstAt: 'x', lastAt: 'y', total: tok(n), estimated: tok(2), models: { 'claude-sonnet-5-5': tok(n) }, accounts: { 'vault-ben-1': tok(n) }, coordDays: { '42': { '2026-11-09': tok(n) } }, cats: { 'file-read': { usd: n / 11, tok: n } }, days: { '2026-11-09': tok(n) }, sessions: { s1: { role: 'worker', total: tok(n), models: { m: tok(1) } } } });
  const sessions = Object.fromEntries(['s1', '42', 'conv-x', '7'].map((id, i) => [id, session(id, i + 1)]));
  const requests = Object.fromEntries(['w1', 'w3855', '12'].map((id, i) => [id, request(id, i + 3)]));
  fs.writeFileSync(path.join(dir, 'spend.json'), JSON.stringify({ version: 1, requests, sessions, backfillNone: ['a', 'b'] }));
  const spend = new SpendStore(dir, { work: () => [], session: () => undefined, priorResults: () => 1 });
  const s = spend as unknown as { persisted: () => unknown; persistedSliced: () => Promise<string> };
  const once = JSON.stringify(s.persisted());
  assert.match(once, /"backfillNone":\["a","b"\]/);
  assert.equal(await s.persistedSliced(), once);
  spend.backfillNone.clear();
  assert.equal(await s.persistedSliced(), JSON.stringify(s.persisted()), 'and without the tail');
});

test('w3855: a snapshot file with a sliced serializer writes its text in the background; flushSync writes the one-go text', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-snap-sliced-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'f.json');
  const snap = new SnapshotFile(file, () => '"sync"', { delayMs: 0, intervalMs: 0, generations: 0, label: 't' }, async () => '"sliced"');
  snap.changed();
  for (let i = 0; i < 200 && !(fs.existsSync(file) && !snap.pending); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(fs.readFileSync(file, 'utf8'), '"sliced"');
  snap.flushSync();
  assert.equal(fs.readFileSync(file, 'utf8'), '"sync"');
});
