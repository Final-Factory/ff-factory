// w1688: secrets masked by value, whatever their variable is called, in their common encodings, and in Claude Code's own
// transcripts in place. Fake secrets only, made at run time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { MIN_SECRET_LENGTH, addSecretEnv, addSecretValues, redactSecrets, redactValue, registerSecretValues, secretBytesMatcher, secretValueStats, secretValuesSince, secretValuesVersion, skippedSecrets } from './secrets.ts';
import { CliScrubber, inPlaceMask, scrubInPlace } from './cliScrub.ts';

const fake = (n = 20) => randomBytes(n).toString('base64url').slice(0, n);
const b64 = (v: string) => Buffer.from(v).toString('base64').replace(/=+$/, '');
const reset = () => registerSecretValues([]);

test('w1688: a secret under any name is masked by value: the vault names it in secretEnv, SECRET_ENV and token shapes find the rest', (t) => {
  t.after(reset);
  const pass = fake();
  const login = fake();
  const unnamed = fake();
  // FAKE_STEAM_LOGIN matches no name rule: masked because the spec says it is the vault's
  addSecretEnv({ FAKE_PASSWORD: pass, FAKE_STEAM_LOGIN: login, FAKE_NOTE: unnamed, PATH: '/usr/bin' }, ['FAKE_STEAM_LOGIN']);
  const out = redactSecrets(`FAKE_PASSWORD=${pass}\nFAKE_STEAM_LOGIN=${login}\nFAKE_NOTE=${unnamed}\nPATH=/usr/bin`);
  assert.ok(!out.includes(pass) && !out.includes(login), 'both masked');
  assert.match(out, new RegExp(`FAKE_PASSWORD=\\[redacted vault secret …${pass.slice(-4).replace(/[-]/g, '\\-')}\\]`));
  assert.ok(out.includes(`FAKE_NOTE=${unnamed}`), 'a variable no rule names and the spec does not list is not a secret');
  assert.ok(out.includes('PATH=/usr/bin'));
});

test('w1688: each value is masked in its encodings too: URL-encoded, base64, base64url and JSON-escaped', (t) => {
  t.after(reset);
  const v = `Fk3/+ "q"&é${fake(12)}`;
  addSecretValues([v]);
  const forms = [v, encodeURIComponent(v), encodeURIComponent(v).replace(/%[0-9A-F]{2}/g, (s) => s.toLowerCase()), b64(v), b64(v).replace(/\+/g, '-').replace(/\//g, '_'), Buffer.from(v).toString('base64')];
  for (const f of forms) {
    const out = redactSecrets(`x ${f} y`);
    assert.ok(!out.includes(f.replace(/=+$/, '')), `masked: form ${forms.indexOf(f)}`);
    assert.match(out, /\[redacted vault secret(?:, (?:URL-encoded|base64))? ….{4}\]/);
  }
  // in an event (JSON): the quote is escaped there, and redactValue's quick check still finds it
  const ev = redactValue({ kind: 'tool_result', text: `got ${v}` });
  assert.ok(!JSON.stringify(ev).includes(JSON.stringify(v).slice(1, -1)) && !ev.text.includes(v));
});

test('w1688: a value under 8 characters is skipped and named; a value under 16 shows none of its characters', (t) => {
  t.after(reset);
  const short = fake(MIN_SECRET_LENGTH - 2);
  const mid = fake(12);
  addSecretEnv({ FAKE_PIN_PASSWORD: short, FAKE_MID_SECRET: mid });
  assert.ok(skippedSecrets().includes('FAKE_PIN_PASSWORD'), 'the short one named');
  assert.ok(!skippedSecrets().includes('FAKE_MID_SECRET'));
  assert.equal(redactSecrets(`pin ${short}`), `pin ${short}`, 'not masked: it would rewrite ordinary words');
  assert.equal(redactSecrets(`mid ${mid}`), 'mid [redacted vault secret]', 'no last four of a 12-character value');
  const stats = secretValueStats();
  assert.equal(stats.values, 1);
  assert.ok(!JSON.stringify(stats).includes(mid) && !JSON.stringify(stats).includes(short), 'the stats hold names and counts only');
});

test('w1688: values learnt are versioned, so a scrubber looks back for the new ones only; minted ones need no look back', (t) => {
  t.after(reset);
  reset();
  const v0 = secretValuesVersion();
  const a = fake();
  assert.equal(addSecretValues([a]), 1);
  assert.equal(addSecretValues([a]), 0, 'known: nothing new');
  assert.deepEqual(secretValuesSince(v0), { values: [a], recent: false });
  const v1 = secretValuesVersion();
  addSecretValues([fake()], { recent: true });
  assert.equal(secretValuesSince(v1)?.recent, true);
});

test('w1688: scrubInPlace overwrites each match with a mask of its length, across chunk edges, and loses nothing appended', async (t) => {
  t.after(reset);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-cliscrub-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const v = fake(24);
  addSecretValues([v]);
  const file = path.join(dir, 's.jsonl');
  const line = (o: object) => JSON.stringify(o) + '\n';
  fs.writeFileSync(file, line({ type: 'user', toolUseResult: { stdout: `FAKE_PASSWORD=${v}\nb64=${b64(v)}` } }) + line({ type: 'assistant', text: 'ok' }));
  const before = fs.statSync(file).size;
  const r = await scrubInPlace(file, secretBytesMatcher()!);
  assert.equal(r.count, 2);
  const after = fs.readFileSync(file, 'utf8');
  assert.equal(after.length, before, 'same length: nothing moved');
  assert.ok(!after.includes(v) && !after.includes(b64(v)));
  for (const l of after.split('\n').filter(Boolean)) JSON.parse(l);
  assert.equal(inPlaceMask(12).toString(), '[redacted**]');
  // appended after the scan: found from where the scan ended, the earlier bytes left as they are
  fs.appendFileSync(file, line({ more: v }));
  const r2 = await scrubInPlace(file, secretBytesMatcher()!, r.size);
  assert.equal(r2.count, 1);
  assert.ok(!fs.readFileSync(file, 'utf8').includes(v));
  // a big file, the value across the edge of the 8 MB chunks
  const big = path.join(dir, 'big.jsonl');
  const edge = 8 * 1024 * 1024 - 10;
  fs.writeFileSync(big, Buffer.concat([Buffer.alloc(edge, 'a'), Buffer.from(v), Buffer.alloc(100, 'b')]));
  assert.equal((await scrubInPlace(big, secretBytesMatcher()!)).count, 1);
  assert.ok(!fs.readFileSync(big, 'latin1').includes(v));
});

test('w1688: the CliScrubber masks what is already on disk once a value is learnt, and new writes as they come', async (t) => {
  t.after(reset);
  reset();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-cliroot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const v = fake(30);
  const old = path.join(root, 'F--sb', 'a.jsonl');
  fs.mkdirSync(path.dirname(old), { recursive: true });
  fs.writeFileSync(old, JSON.stringify({ stdout: `FFSTEAM_PASSWORD=${v}` }) + '\n');
  const lines: string[] = [];
  const reports: { total: number; trigger: string }[] = [];
  const s = new CliScrubber({ root, log: (l) => lines.push(l), report: (r) => reports.push(r), sweepMs: 3_600_000 }).start();
  t.after(() => s.stop());
  await s.sweep();
  assert.ok(fs.readFileSync(old, 'utf8').includes(v), 'nothing known yet: nothing masked');
  addSecretValues([v]);
  await s.sweep();
  assert.ok(!fs.readFileSync(old, 'utf8').includes(v), 'the old copy masked once the value is known');
  assert.equal(reports.at(-1)?.trigger, 'back-scan');
  // a new write, in a new subagent folder: the watch (or the next sweep) masks it
  const sub = path.join(root, 'F--sb', 'sess', 'subagents', 'b.jsonl');
  fs.mkdirSync(path.dirname(sub), { recursive: true });
  fs.writeFileSync(sub, JSON.stringify({ text: `again ${v}` }) + '\n');
  const end = Date.now() + 10_000;
  while (fs.readFileSync(sub, 'utf8').includes(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 100));
    if (Date.now() > end - 5_000) await s.sweep();
  }
  assert.ok(!fs.readFileSync(sub, 'utf8').includes(v));
  assert.ok(lines.length >= 2 && lines.every((l) => !l.includes(v)), 'the log names files and counts, never the value');
});
