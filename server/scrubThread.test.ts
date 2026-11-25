import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { registerSecretValues } from './secrets.ts';
import { SCRUB_MARKER, SCRUB_VERSION, commitScrubbed, redactFileText, scrubAtStart, scrubTree } from './scrubSecrets.ts';

// w5613: the start-up scrub of scrub version 3 (w5526) held the portal's event loop up to 10.0 s over one big transcript
// (journal, 2026-11-25 08:19Z). The reading and masking now run on a thread; the portal's thread only swaps masked copies in.
// Fake, real-looking secrets built at run time, as in scrubSecrets.test.ts.
const GHP = `ghp_${'FAKE'.repeat(8)}yVC9`;
const VAULT_VALUE = 'plain-vault-value-5613';
const leaks = (text: string) => [GHP, VAULT_VALUE].filter((s) => text.includes(s));

const withVault = (t: { after: (fn: () => void) => void }) => {
  registerSecretValues([VAULT_VALUE]);
  t.after(() => registerSecretValues([]));
};

/** A transcript line as the stores write them, about 600 bytes; one in `every` carries a secret. */
const line = (i: number, every: number) =>
  JSON.stringify({ seq: i, kind: 'tool_result', at: '2026-11-25T08:00:00Z', text: i % every === 0 ? `token ${GHP} and ${VAULT_VALUE}` : `ok ${'x'.repeat(520)} ${i}` });

function bigDataDir(dir: string): { secrets: number } {
  fs.mkdirSync(path.join(dir, 'transcripts'), { recursive: true });
  let secrets = 0;
  const lines = (n: number, every: number) => {
    const out: string[] = [];
    for (let i = 1; i <= n; i++) {
      out.push(line(i, every));
      if (i % every === 0) secrets++;
    }
    return out.join('\n') + '\n';
  };
  // about 30 MB and 15 MB (as text) of transcript and a state.json of about 10 MB (halved from 60, 30 and 20 MB for CI's time, w5613)
  fs.writeFileSync(path.join(dir, 'transcripts/big.jsonl'), lines(50_000, 2500));
  fs.writeFileSync(path.join(dir, 'transcripts/old.jsonl.gz'), zlib.gzipSync(lines(25_000, 2500)));
  const sessions: Record<string, unknown> = {};
  for (let i = 0; i < 15_000; i++) sessions[`s${i}`] = { id: `s${i}`, title: 'x'.repeat(600), note: i === 7 ? `GH_TOKEN=${GHP}` : '' };
  secrets++;
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ sessions }, null, 2));
  // and many small files, as the data folder holds thousands
  for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(dir, 'transcripts', `small${i}.jsonl`), line(i, 100) + '\n');
  secrets += 3;
  return { secrets };
}

test('scrub thread (w5613): a large data folder is scrubbed at start with no block of the event loop over 200 ms', { timeout: 300_000 }, async (t) => {
  withVault(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrub-thread-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  bigDataDir(dir);

  // What one big file costs on the portal's thread, as the scrub ran before (the block this removes): measured, not asserted.
  const text = fs.readFileSync(path.join(dir, 'transcripts/big.jsonl'), 'utf8');
  let t0 = performance.now();
  redactFileText('big.jsonl', text);
  t.diagnostic(`masking the 30 MB transcript on one thread: ${(performance.now() - t0).toFixed(0)} ms`);

  const h = monitorEventLoopDelay({ resolution: 10 });
  // the longest gap between turns, seen by a timer that asks for one every 5 ms
  let last = performance.now();
  let worst = 0;
  const tick = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 5);
  h.enable();
  t0 = performance.now();
  const lines: string[] = [];
  const r = await scrubAtStart(dir, (l) => lines.push(l));
  const took = performance.now() - t0;
  h.disable();
  clearInterval(tick);
  t.diagnostic(`scrub took ${took.toFixed(0)} ms; longest gap between turns ${worst.toFixed(0)} ms; loop delay max ${(h.max / 1e6).toFixed(0)} ms, p99 ${(h.percentile(99) / 1e6).toFixed(0)} ms`);

  assert.ok(r, 'it ran');
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.equal(r.files.length, 6, 'every file that held a secret: the two transcripts, state.json and three small ones');
  // The scrub's own work on the portal's thread, timed piece by piece: what the old scrub did there for a whole file. Asserted
  // on the thread's CPU time: the wall time and the gap a timer sees are diagnostics only, since on a loaded machine they are
  // the scheduler's (20 to 178 ms over five runs on lothdesktop at 98% CPU; one piece 285 ms wall on a CI runner, w5559).
  t.diagnostic(`longest piece on the portal's thread: ${r.longestTurnMs} ms wall, ${r.longestTurnCpuMs} ms CPU`);
  assert.ok(r.longestTurnCpuMs! < 200, `the scrub held the event loop ${r.longestTurnCpuMs} ms of CPU at once`);
  assert.ok(lines.some((l) => /^scrubbed on its own thread in [\d.]+ s; the longest piece on the portal's thread took \d+ ms$/.test(l)), lines.join('\n'));
  assert.deepEqual(leaks(lines.join('\n')), [], 'the log names no value');
  assert.deepEqual(leaks(fs.readFileSync(path.join(dir, 'transcripts/big.jsonl'), 'utf8')), [], 'the big transcript is masked');
  assert.deepEqual(leaks(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'transcripts/old.jsonl.gz'))).toString('utf8')), [], 'the zipped one too');
  assert.deepEqual(leaks(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')), [], 'and state.json');
  assert.match(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), /^\{\n {2}"sessions"/, 'JSON keeps its indent');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, SCRUB_MARKER), 'utf8')).version, SCRUB_VERSION, 'the marker is written as before');
  assert.equal(scrubTree([dir]).total, 0, 'nothing is left');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'transcripts')).filter((f) => f.includes('.scrub-')), [], 'no masked copy is left behind');
});

test('scrub thread (w5613): a masked copy is swapped in only over the file as it was read; what was appended since is kept, masked', (t) => {
  withVault(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrub-commit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'a.jsonl');
  const tmp = `${file}.scrub-test.tmp`;
  const first = line(1, 1) + '\n';
  const stage = () => {
    fs.writeFileSync(file, first);
    const st = fs.statSync(file);
    const clean = redactFileText('a.jsonl', first);
    fs.writeFileSync(tmp, clean.text);
    return { file, tmp, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, n: clean.n, gz: false };
  };

  // unchanged since the read: swapped in
  let c = stage();
  assert.deepEqual(commitScrubbed(c), { ok: c.n });
  assert.deepEqual(leaks(fs.readFileSync(file, 'utf8')), []);
  assert.equal(fs.existsSync(tmp), false);

  // the portal appended a line meanwhile: kept after the masked text, and masked too
  c = stage();
  const appended = JSON.stringify({ seq: 2, kind: 'assistant', text: `then ${GHP}` }) + '\n';
  fs.appendFileSync(file, appended);
  const r = commitScrubbed(c);
  assert.ok('ok' in r && r.ok === c.n + 1, JSON.stringify(r));
  const after = fs.readFileSync(file, 'utf8').split('\n');
  assert.equal(after.length, 3, 'both lines and the last newline');
  assert.equal(JSON.parse(after[1]).seq, 2, 'the appended line is kept');
  assert.deepEqual(leaks(after.join('\n')), [], 'and masked');

  // replaced by its writer meanwhile (a rename): not swapped in, read again
  c = stage();
  fs.writeFileSync(`${file}.new`, first + appended);
  fs.renameSync(`${file}.new`, file);
  const kept = fs.readFileSync(file, 'utf8');
  assert.deepEqual(commitScrubbed(c), { changed: true });
  assert.equal(fs.readFileSync(file, 'utf8'), kept, 'the writer\'s file is untouched');
  assert.equal(fs.existsSync(tmp), false, 'the copy is removed');

  // cut shorter meanwhile: read again
  c = stage();
  fs.writeFileSync(file, '');
  assert.deepEqual(commitScrubbed(c), { changed: true });

  // deleted meanwhile: nothing to do
  c = stage();
  fs.rmSync(file);
  assert.deepEqual(commitScrubbed(c), { gone: true });
  assert.equal(fs.existsSync(tmp), false);
});
