import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';
import type { TranscriptEvent } from '../shared/types.ts';

// w1377: a limited transcript read takes the end of the file only. On 2026-10-15 every daemon connect asked lastSeq of each
// of its machine's sessions, each ask read the whole transcript, and the reconnects of a blocked portal kept it blocked.

function fixture(lines: number) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-tail-'));
  const store = new Store(tmp);
  const file = path.join(tmp, 'transcripts', 's1.jsonl');
  // Lines of every length, with multi-byte text, so chunk edges fall inside lines and inside characters.
  const out: string[] = [];
  for (let seq = 1; seq <= lines; seq++) out.push(JSON.stringify({ seq, t: '2026-10-15T09:56:09Z', kind: 'assistant', text: `${'é🙂x'.repeat(seq % 97)} line ${seq}` }));
  fs.writeFileSync(file, out.join('\n') + '\n');
  return { tmp, store, file, done: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

const seqs = (es: TranscriptEvent[]) => es.map((e) => e.seq);

test('w1377: readTranscript with a limit gives what the whole read gave, for any limit, across chunk edges', (t) => {
  const f = fixture(6000);
  t.after(f.done);
  assert.ok(fs.statSync(f.file).size > 1024 * 1024, 'bigger than several first chunks');
  const all = f.store.readTranscript('s1');
  assert.equal(all.length, 6000);
  for (const n of [1, 2, 3, 17, 400, 2000, 5999, 6000, 9000]) assert.deepEqual(seqs(f.store.readTranscript('s1', n)), seqs(all.slice(-n)), `limit ${n}`);
  assert.equal((f.store.readTranscript('s1', 5).at(-1) as { text: string }).text, (all.at(-1) as { text: string }).text, 'multi-byte text intact');
});

test('w1377: the last line of a big transcript costs a small read, not the file', (t) => {
  const f = fixture(6000);
  t.after(f.done);
  let bytes = 0;
  const real = fs.readSync;
  const spy = mock.method(fs, 'readSync', (...a: Parameters<typeof fs.readSync>) => {
    const n = (real as (...x: unknown[]) => number)(...a);
    bytes += n;
    return n;
  });
  const whole = mock.method(fs, 'readFileSync');
  try {
    assert.equal(f.store.lastSeq('s1'), 6000);
    assert.equal(f.store.readTranscript('s1', 40).length, 40);
  } finally {
    spy.mock.restore();
    whole.mock.restore();
  }
  assert.equal(whole.mock.calls.filter((c) => String(c.arguments[0]).endsWith('s1.jsonl')).length, 0, 'never the whole file');
  assert.ok(bytes < 300 * 1024, `read ${bytes} bytes of ${fs.statSync(f.file).size}`);
});

test('w1377: lastSeq is remembered, and skips a torn last line instead of reading as an empty transcript', (t) => {
  const f = fixture(50);
  t.after(f.done);
  fs.appendFileSync(f.file, '{"seq":51,"t":"2026-10-15T09:5');
  assert.equal(f.store.lastSeq('s1'), 50, 'the torn line is skipped');
  fs.rmSync(f.file);
  assert.equal(f.store.lastSeq('s1'), 50, 'remembered: no second read');
  const e = f.store.append('s1', { kind: 'system', text: 'next' });
  assert.equal(e.seq, 51, 'the next event follows the last whole one');
});

test('w1377: readTranscriptFrom and eventAt read back only as far as the seq asked for', (t) => {
  const f = fixture(3000);
  t.after(f.done);
  const all = f.store.readTranscript('s1');
  for (const from of [1, 2, 1500, 2990, 3000, 3001]) assert.deepEqual(seqs(f.store.readTranscriptFrom('s1', from)), seqs(all.filter((e) => e.seq >= from)), `from ${from}`);
  assert.equal(f.store.eventAt('s1', 2999)?.seq, 2999);
  assert.deepEqual(f.store.eventAt('s1', 7), all[6]);
  assert.equal(f.store.eventAt('s1', 9999), undefined);
  assert.deepEqual(f.store.readTranscriptFrom('nobody', 1), []);
  assert.deepEqual(f.store.readTranscript('nobody', 3), []);
  assert.equal(f.store.lastSeq('nobody'), 0);
});
