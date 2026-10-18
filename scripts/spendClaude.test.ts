import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze, render } from './spend-claude.ts';

/** w1469: the base context measured from a session's first call, and what reading it on every call cost. */
test('spend-claude: the base is the first call less its first message, read again by every call', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-claude-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'proj');
  fs.mkdirSync(dir);
  const at = (s: number) => new Date(Date.now() - 3_600_000 + s * 1000).toISOString();
  const call = (id: string, s: number, cr: number, cw: number) => ({
    type: 'assistant',
    uuid: `a-${id}`,
    timestamp: at(s),
    message: { id, model: 'claude-opus-5-5', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 0, output_tokens: 100, cache_read_input_tokens: cr, cache_creation_input_tokens: cw } },
  });
  const lines = [
    { type: 'user', uuid: 'u1', timestamp: at(0), message: { role: 'user', content: 'w1469: go'.padEnd(2_700, '.') } }, // 1,000 tokens at 2.7
    call('m1', 1, 17_000, 44_000), // 61,000 = a base of 60,000 and the message
    call('m2', 2, 61_000, 40_000), // 101,000: the base is 60,000 of it
  ];
  fs.writeFileSync(path.join(dir, 's1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
  const r = analyze(root, Date.now() - 86_400_000);
  assert.deepEqual(r.extra.base.firsts, [60_000]);
  assert.equal(r.extra.base.calls, 2);
  assert.equal(r.extra.base.tok, 120_000);
  // call 1 read 17,000 of it and wrote 43,000 (1-hour writes, $8 a million on Opus 5.5); call 2 read it all ($0.20 a million)
  const usd = (17_000 * 0.2 + 43_000 * 8 + 60_000 * 0.2) / 1e6;
  assert.ok(Math.abs(r.extra.base.usd - usd) < 1e-9, `${r.extra.base.usd} vs ${usd}`);
  assert.match(render(r, 1, 1), /base context, measured \(w1469\).*median 60k tokens/);
});
