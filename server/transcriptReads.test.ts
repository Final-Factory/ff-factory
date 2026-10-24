import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Store } from './store.ts';
import { gzipFile } from './dataGuard.ts';

/**
 * w2026: the transcript reads background passes make never hold the event loop: the ledger sweep's `gh pr create` scan reads only
 * what was appended since its last pass, in pieces, and a tail read of a compressed transcript comes from its tail file instead of
 * unzipping the whole transcript synchronously.
 */

const T = '2026-10-24T09:00:00.000Z';
let seq = 0;
const line = (o: object) => JSON.stringify({ seq: ++seq, t: T, ...o });

test('w2026: prCreateResults reads a transcript once, then only what was appended, never a line still being written', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-scan-'));
  const store = new Store(dir);
  const f = path.join(dir, 'transcripts', 's1.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const filler = line({ kind: 'tool_result', toolUseId: 'x', text: 'z'.repeat(50_000) });
  fs.writeFileSync(f, [filler, line({ kind: 'tool_use', toolUseId: 'a', name: 'Bash', input: { command: 'gh pr create --fill' } }), line({ kind: 'tool_result', toolUseId: 'a', text: 'https://github.com/o/r/pull/1' })].join('\n') + '\n');
  assert.deepEqual((await store.prCreateResults('s1')).map((r) => r.text), ['https://github.com/o/r/pull/1']);
  // a URL a worker merely mentions is not one; a call and its result split across two passes, the result torn mid-line
  const res = line({ kind: 'tool_result', toolUseId: 'b', text: 'https://github.com/o/r/pull/2' });
  fs.appendFileSync(f, [line({ kind: 'tool_result', toolUseId: 'x', text: 'see https://github.com/o/r/pull/9' }), line({ kind: 'tool_use', toolUseId: 'b', name: 'Bash', input: { command: 'cd x && gh pr create --base main' } }), res.slice(0, 20)].join('\n'));
  assert.equal((await store.prCreateResults('s1')).length, 1);
  fs.appendFileSync(f, res.slice(20) + '\n');
  assert.deepEqual((await store.prCreateResults('s1')).map((r) => r.text), ['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2']);
  // compressed by the data guard: read whole once, the same answer
  assert.ok(await gzipFile(f));
  assert.equal((await store.prCreateResults('s1')).length, 2);
});

test('w2026: a tail read of a compressed transcript comes from its tail file, not a synchronous unzip of the whole', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gz-tail-'));
  const store = new Store(dir);
  for (let i = 0; i < 50; i++) store.append('s1', { kind: 'system', text: `line ${i}` });
  const f = path.join(dir, 'transcripts', 's1.jsonl');
  assert.ok(await gzipFile(f));
  assert.ok(fs.existsSync(`${f}.gz.tail`));
  const orig = zlib.gunzipSync;
  let unzips = 0;
  (zlib as { gunzipSync: unknown }).gunzipSync = (...a: unknown[]) => {
    unzips++;
    return (orig as (...x: unknown[]) => unknown)(...a);
  };
  try {
    assert.deepEqual(store.readTranscript('s1', 3).map((e) => e.seq), [48, 49, 50]);
    assert.equal(store.lastSeq('s1'), 50);
    assert.equal(unzips, 0);
    // a tail file of another .gz (rewritten since) is ignored, and written again from the whole read
    fs.writeFileSync(`${f}.gz.tail`, `${JSON.stringify({ of: 1, whole: true })}\n`);
    assert.equal(store.readTranscript('s1', 2).at(-1)?.seq, 50);
    assert.equal(unzips, 1);
    assert.equal(store.readTranscript('s1', 2).at(-1)?.seq, 50);
    assert.equal(unzips, 1);
  } finally {
    (zlib as { gunzipSync: unknown }).gunzipSync = orig;
  }
  // written to again: the plain file comes back and the tail file goes
  store.noteCompressed('s1');
  store.append('s1', { kind: 'system', text: 'again' });
  assert.ok(!fs.existsSync(`${f}.gz.tail`));
});
