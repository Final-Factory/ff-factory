import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { redactSecrets, redactValue, registerSecretValues } from './secrets.ts';
import { SCRUB_MARKER, SCRUB_VERSION, redactFileText, scrubAtStart, scrubTree } from './scrubSecrets.ts';
import { Store, bus } from './store.ts';
import { AttachmentStore } from './attachments.ts';
import type { ServerEvent, SessionInfo, WorkItem } from '../shared/types.ts';

// w1584: a worker's failing test printed its vault GitHub token (w1519) into its transcript. Every store masks secrets as it
// writes, and the scrub masks what is already on disk. Fake, real-looking tokens, built at run time so no secret scanner
// takes them for real ones; the leaked one ended …yVC9, so the fakes do too.
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PAT = `github_pat_11FAKEFAKE0${'Fake'.repeat(15)}yVC9`;
const GHP = `ghp_${'FAKE'.repeat(8)}yVC9`;
const GHO = `gho_${'Fake'.repeat(8)}yVC9`;
const GHS = `ghs_${'fAkE'.repeat(8)}yVC9`;
const GHU = `ghu_${'FaKe'.repeat(8)}yVC9`;
const OAUTH = `sk-ant-oat01-${'fAkE_'.repeat(10)}yVC9`;
const API = `sk-ant-api03-${'fake-'.repeat(10)}yVC9`;
const ADMIN = `sk-ant-admin01-${'fake_'.repeat(10)}yVC9`;
const KEY_KIND = ['RSA', 'PRIVATE', 'KEY'].join(' ');
const PEM = `-----BEGIN ${KEY_KIND}-----\nMIIEfakefakefakefake\nfakefakefake+/=\n-----END ${KEY_KIND}-----`;
const PEM_CUT = `-----BEGIN ${KEY_KIND}-----\nMIIEfakefakefakefake\nfakefake`;
/** A vault value with no token shape (an env-kind entry): masked because the vault handed it out. */
const VAULT_VALUE = 'plain-vault-value-yVC9';
const ALL = [PAT, GHP, GHO, GHS, GHU, OAUTH, API, ADMIN, VAULT_VALUE];
const leaks = (text: string) => [...ALL, 'MIIEfakefake'].filter((s) => text.includes(s));

const withVault = (t: { after: (fn: () => void) => void }) => {
  registerSecretValues([VAULT_VALUE]);
  t.after(() => registerSecretValues([]));
};

test('scrub: every token shape and every vault value is masked to its last four characters', (t) => {
  withVault(t);
  for (const s of ALL) {
    const out = redactSecrets(`before ${s} after`);
    assert.deepEqual(leaks(out), [], s.slice(0, 8));
    assert.match(out, /\[redacted [^\]]*…yVC9\]/, s.slice(0, 8));
  }
  assert.equal(redactSecrets(`x ${PAT} y`), 'x github_pat_[redacted …yVC9] y');
  assert.equal(redactSecrets(PEM), `[redacted RSA private key]`);
  assert.equal(redactSecrets(`${PEM_CUT}\n(clipped)`), '[redacted RSA private key]\n(clipped)');
  assert.equal(redactSecrets(redactSecrets(`a ${PAT}`)), `a github_pat_[redacted …yVC9]`, 'masking twice changes nothing');
});

test('scrub: a token after an escape or a colour code is masked (the shapes had a look-behind that let them through)', () => {
  // How the leaked token sat in a test's output: an assertion's actual value, on a line of its own, in a JSON event.
  const event = { kind: 'tool_result', text: `AssertionError: Expected values to be strictly equal:\n${PAT}\n  actual: '${GHP}'` };
  assert.deepEqual(leaks(JSON.stringify(redactValue(event))), []);
  assert.deepEqual(leaks(redactSecrets(`\x1b[32m${PAT}\x1b[0m`)), []);
  assert.deepEqual(leaks(redactFileText('t.jsonl', JSON.stringify(event) + '\n').text), []);
  assert.equal(redactValue({ text: 'nothing here' }).text, 'nothing here');
});

test('scrub: a session record, a work item and every event the dashboard hears are masked before state.json, work.json or a page', (t) => {
  withVault(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrub-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sent: string[] = [];
  const on = (e: ServerEvent) => sent.push(JSON.stringify(e));
  bus.on('event', on);
  t.after(() => bus.off('event', on));
  const store = new Store(dir);
  const now = new Date().toISOString();
  const s = { id: 's1', kind: 'worker', title: 'w1', status: 'idle', permissionMode: 'default', createdAt: now, lastActivityAt: now, turns: 1, costUsd: 0, pendingPermissions: [], lastResult: `the env held ${PAT}`, statusDetail: VAULT_VALUE } as unknown as SessionInfo;
  store.putSession(s);
  assert.equal(store.sessions.get('s1'), s, 'the record held is the one redacted (in place)');
  assert.equal(s.lastResult, 'the env held github_pat_[redacted …yVC9]');
  const w = { id: 'w1', title: 't', brief: 'b', priority: 'normal', keys: [], status: 'active', sessionIds: ['s1'], log: [`09:00 worker: printed ${GHP}`], notes: [{ at: now, by: 'x', text: OAUTH }] } as unknown as WorkItem;
  store.putWork(w);
  store.flush();
  const onDisk = ['state.json', 'work.json'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.deepEqual(leaks(onDisk), []);
  assert.match(onDisk, /github_pat_\[redacted …yVC9\]/);
  assert.match(onDisk, /\[redacted vault secret …yVC9\]/);
  assert.equal(sent.length, 2);
  assert.deepEqual(leaks(sent.join('\n')), [], 'the session and work events the page hears');

  // Records written before this (an older release): masked by scrubSecrets at start.
  const old = { ...s, id: 's2', lastResult: `old ${GHU}` };
  (store.sessions as Map<string, SessionInfo>).set('s2', old);
  assert.ok(store.scrubSecrets() >= 1);
  assert.equal(old.lastResult, 'old ghu_[redacted …yVC9]');
  store.flush();
});

test('scrub: emit masks a streamed delta and a notice', (t) => {
  const sent: string[] = [];
  const on = (e: ServerEvent) => sent.push(JSON.stringify(e));
  bus.on('event', on);
  t.after(() => bus.off('event', on));
  // emit is the store module's: the one every server event goes through.
  return import('./store.ts').then(({ emit }) => {
    emit({ type: 'delta', sessionId: 's1', text: `streamed ${GHS}` } as ServerEvent);
    emit({ type: 'notify', notice: { kind: 'turnEnd', title: 'w1 finished', body: PAT, url: '#/', tag: 't' } } as unknown as ServerEvent);
    assert.equal(sent.length, 2);
    assert.deepEqual(leaks(sent.join('\n')), []);
  });
});

/** A data folder as the portal keeps one, with planted secrets in each kind of file, and files that must not be touched. */
function plantDataDir(dir: string) {
  const w = (rel: string, data: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), data);
  };
  w('transcripts/a.jsonl', [JSON.stringify({ seq: 1, kind: 'tool_result', text: `ok\n${PAT}\n` }), JSON.stringify({ seq: 2, kind: 'assistant', text: 'clean' }), ''].join('\n'));
  w('transcripts/b.jsonl.gz', zlib.gzipSync(JSON.stringify({ seq: 1, kind: 'user', text: `${OAUTH} and ${VAULT_VALUE}` }) + '\n'));
  w('transcripts/clean.jsonl', JSON.stringify({ seq: 1, text: 'nothing' }) + '\n');
  w('state.json.1', JSON.stringify({ sandboxes: [], sessions: [{ id: 's', lastResult: GHP }] }, null, 2) + '\n');
  w('cleanup-log.jsonl', `not json ${GHO}\n`);
  w('notes.txt', `${PEM}\n`);
  // Files that hold secrets on purpose, or a person's bytes: never rewritten.
  w('vault.json', JSON.stringify({ entries: [{ note: GHP }] }));
  w('vapid.json', JSON.stringify({ privateKey: PAT }));
  w('attachments/blobs/ab/abcd', `a person's log ${PAT}`);
  return { untouched: ['vault.json', 'vapid.json', 'attachments/blobs/ab/abcd'].map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')] as const) };
}

const readAll = (dir: string, files: string[]) => files.map((f) => (f.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(path.join(dir, f))).toString('utf8') : fs.readFileSync(path.join(dir, f), 'utf8'))).join('\n');
const SCRUBBED = ['transcripts/a.jsonl', 'transcripts/b.jsonl.gz', 'state.json.1', 'cleanup-log.jsonl', 'notes.txt'];

test('scrub: the data folder is masked in place, a dry run writes nothing, and a second pass finds nothing left', (t) => {
  withVault(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrub-data-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { untouched } = plantDataDir(dir);
  const before = readAll(dir, SCRUBBED);

  const dry = scrubTree([dir], { dryRun: true });
  assert.equal(readAll(dir, SCRUBBED), before, 'a dry run writes nothing');
  assert.deepEqual(dry.files.map((f) => path.relative(dir, f.file).replace(/\\/g, '/')).sort(), [...SCRUBBED].sort());
  assert.equal(dry.total, 6);

  const done = scrubTree([dir]);
  assert.equal(done.total, 6);
  const after = readAll(dir, SCRUBBED);
  assert.deepEqual(leaks(after), [], 'nothing planted is left');
  assert.match(after, /github_pat_\[redacted …yVC9\]/);
  assert.match(after, /\[redacted vault secret …yVC9\]/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'transcripts/a.jsonl'), 'utf8').split('\n')[1]).text, 'clean', 'the other lines are kept');
  assert.match(fs.readFileSync(path.join(dir, 'state.json.1'), 'utf8'), /^\{\n {2}"sandboxes"/, 'JSON keeps its indent');
  for (const [f, text] of untouched) assert.equal(fs.readFileSync(path.join(dir, f), 'utf8'), text, `${f} is not touched`);
  assert.equal(scrubTree([dir]).total, 0, 'remaining: 0');
});

test('scrub: the portal scrubs its data folder at start once per scrub version, logging paths and counts only', async (t) => {
  withVault(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrub-start-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  plantDataDir(dir);
  const lines: string[] = [];
  const r = await scrubAtStart(dir, (l) => lines.push(l));
  assert.equal(r?.total, 6);
  assert.deepEqual(leaks(lines.join('\n')), [], 'the log names no value');
  assert.ok(lines.some((l) => /a\.jsonl: redacted 1$/.test(l)));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, SCRUB_MARKER), 'utf8')).version, SCRUB_VERSION);
  assert.equal(await scrubAtStart(dir, (l) => lines.push(l)), undefined, 'scrubbed already: not again');
});

test('scrub: fffctl scrub-secrets\'s tool prints paths and counts, never a value, and "remaining: 0" when it is done', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrub-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A Claude Code projects folder: the CLI's own transcript and a tool-result file.
  fs.mkdirSync(path.join(dir, 'proj', 'sess', 'tool-results'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'proj', 'sess.jsonl'), JSON.stringify({ type: 'user', message: { content: `  actual: '${PAT}',\n` } }) + '\n');
  fs.writeFileSync(path.join(dir, 'proj', 'sess', 'tool-results', 'r1.txt'), `GH_TOKEN=${GHP}\n`);
  const old = new Date(Date.now() - 3600_000);
  const busy = path.join(dir, 'proj', 'busy.jsonl');
  fs.writeFileSync(busy, JSON.stringify({ text: GHS }) + '\n');
  for (const f of ['sess.jsonl', 'sess/tool-results/r1.txt']) fs.utimesSync(path.join(dir, 'proj', f), old, old);
  const run = (...args: string[]) => spawnSync(process.execPath, ['server/scrubSecretsCli.ts', '--no-data', ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });

  const dry = run('--dry-run', '--claude-projects', path.join(dir, 'proj'));
  assert.equal(dry.status, 1, dry.stderr);
  assert.deepEqual(leaks(dry.stdout + dry.stderr), []);
  assert.match(dry.stdout, /sess\.jsonl: would redact 1/);
  assert.match(dry.stdout, /r1\.txt: would redact 1/);
  assert.match(dry.stdout, /remaining: 3$/m);

  // A file written in the last two minutes is being written: left, and named.
  const first = run('--claude-projects', path.join(dir, 'proj'));
  assert.equal(first.status, 1);
  assert.match(first.stdout, /busy\.jsonl: 1 left: changed in the last two minutes/);
  assert.match(first.stdout, /remaining: 1$/m);
  fs.utimesSync(busy, old, old);
  const second = run('--claude-projects', path.join(dir, 'proj'));
  assert.equal(second.status, 0, second.stdout);
  assert.match(second.stdout, /remaining: 0$/m);
  assert.deepEqual(leaks(first.stdout + second.stdout), []);
  const files = ['sess.jsonl', 'sess/tool-results/r1.txt', 'busy.jsonl'].map((f) => fs.readFileSync(path.join(dir, 'proj', f), 'utf8')).join('\n');
  assert.deepEqual(leaks(files), []);
  assert.match(files, /github_pat_\[redacted …yVC9\]/);
});

test('scrub: a text attachment is stored with its secrets masked, under the SHA-256 of what is kept', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrub-att-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new AttachmentStore(path.join(dir, 'data'));
  const log = path.join(dir, 'Player.log');
  fs.writeFileSync(log, `line 1\nGH_TOKEN=${PAT}\nline 3\n`);
  const rec = await store.addFile(log);
  const kept = fs.readFileSync(store.pathOf(rec), 'utf8');
  assert.equal(kept, 'line 1\nGH_TOKEN=github_pat_[redacted …yVC9]\nline 3\n');
  assert.equal(rec.size, Buffer.byteLength(kept));
  assert.match(store.pathOf(rec), new RegExp(rec.sha256));
  // Not text: kept as it came.
  const bin = path.join(dir, 'save.zip');
  fs.writeFileSync(bin, Buffer.from(`PK\x03\x04${GHP}`));
  const z = await store.addFile(bin);
  assert.ok(fs.readFileSync(store.pathOf(z)).includes(GHP));
});
