import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProviderManager } from './providers.ts';
import { AttachmentStore } from './attachments.ts';
import { describeDiagnosisFiles, describeSymbols, fetchFfboxDiagnosis, fetchFfboxSymbols, ffboxSymbolsArgs } from './ffboxSymbols.ts';
import { PROVIDER_QUERIES, REPORT_LIMITS, mintProviderToken, tokenSha256 } from './providerProtocol.ts';
import { CATALOG } from './launch.ts';
import { MockConnector } from '../e2e/mockConnector.ts';
import type { Config } from './config.ts';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const RID = '20261018T101500Z-crash-3a9f01c2d4';

async function setup(t: { after: (fn: () => Promise<void> | void) => void }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffbox-symbols-'));
  const token = mintProviderToken();
  const cfg = { dataDir, providers: { ffbox: { enabled: true, tokenSha256: tokenSha256(token) } } } as unknown as Config;
  const pm = new ProviderManager(cfg);
  pm.statusPollMs = 0;
  const store = new AttachmentStore(dataDir);
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => pm.upgrade(req, socket, head, '127.0.0.1'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const c = new MockConnector(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, token);
  await c.hello({ protocol: 2 });
  t.after(() => {
    c.close();
    pm.close();
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { pm, store, c, dataDir };
}

type Q = { id: string; what: string; args?: Record<string, unknown> };
function onQuery(c: MockConnector, answer: (q: Q) => void) {
  const timer = setInterval(() => {
    for (let i = c.received.findIndex((m) => m.type === 'query'); i >= 0; i = c.received.findIndex((m) => m.type === 'query')) answer(c.received.splice(i, 1)[0] as Q);
  }, 10);
  return () => clearInterval(timer);
}

/** A Burst pdb of 250 KB, handed over by the mock in parts of 100 KB, as FFBox does in parts of 64 MiB. */
const PDB = Buffer.from(Array.from({ length: 250_000 }, (_, i) => (i * 7919) % 251));
const PART = 100_000;
const ID = 'A1B2C3D4E5F60718293A4B5C6D7E8F901';
const pdbView = (over: Record<string, unknown> = {}) => ({ version: '1.0.0.0', app: 'main', platform: 'WindowsPlayer', module: 'lib_burst_generated.pdb', id: ID, name: 'lib_burst_generated.pdb', bytes: PDB.length, kind: 'pdb', ...over });

function sendPart(c: MockConnector, q: Q, body: Buffer, opts: { partSha?: string; wholeSha?: string } = {}) {
  const offset = Number(q.args?.offset ?? 0);
  const part = body.subarray(offset, offset + PART);
  c.send({
    type: 'query_result',
    id: q.id,
    what: 'symbol_file',
    ok: true,
    at: '2026-10-19T07:00:00Z',
    data: {
      file: { ...pdbView(), sha256: opts.wholeSha ?? sha(body) },
      part: { offset, bytes: part.length, last: offset + part.length >= body.length },
      transfer: { name: 'lib_burst_generated.pdb', bytes: part.length, sha256: opts.partSha ?? sha(part), chunk_bytes: REPORT_LIMITS.maxChunkBytes },
    },
  });
  for (let off = 0; off < part.length; off += REPORT_LIMITS.maxChunkBytes) c.send({ type: 'report_chunk', id: q.id, offset: off, data: part.subarray(off, off + REPORT_LIMITS.maxChunkBytes).toString('base64') });
  c.send({ type: 'report_end', id: q.id, ok: true, bytes: part.length, sha256: opts.partSha ?? sha(part) });
}

const listing = (files: unknown[]) => (c: MockConnector, q: Q) => c.send({ type: 'query_result', id: q.id, what: 'symbols', ok: true, at: '2026-10-19T07:00:00Z', data: { files, offset: 0, total: files.length, part_bytes: PART } });

test('fetch_ffbox_symbols: a release pdb comes in parts into ONE attachment, each part and the whole SHA-256 checked', async (t) => {
  const { pm, store, c } = await setup(t);
  const asked: Q[] = [];
  let busyOnce = true;
  const stop = onQuery(c, (q) => {
    asked.push(q);
    if (q.what === 'symbols') return listing([pdbView(), pdbView({ name: 'lib_burst_generated.sym', bytes: 900, kind: 'sym' })])(c, q);
    // Another file is streaming on FFBox the first time: the fetch asks again.
    if (busyOnce) {
      busyOnce = false;
      return c.send({ type: 'query_result', id: q.id, what: 'symbol_file', ok: false, error: 'busy' });
    }
    sendPart(c, q, PDB);
  });
  t.after(stop);
  const f = await fetchFfboxSymbols(pm, store, { version: '1.0.0.0', file: 'lib_burst_generated.pdb' }, 'u1', { retryMs: 5 });
  assert.equal(f.records.length, 1);
  assert.equal(f.records[0].sha256, sha(PDB));
  assert.equal(f.records[0].size, PDB.length);
  assert.deepEqual(fs.readFileSync(store.pathOf(f.records[0])), PDB, 'the parts appended back into the same bytes');
  const parts = asked.filter((q) => q.what === 'symbol_file');
  assert.deepEqual(parts.map((q) => q.args?.offset), [0, 0, 100_000, 200_000], 'busy once, then the three parts from where the upload stood');
  assert.deepEqual(Object.keys(parts[1].args ?? {}).sort(), ['app', 'id', 'module', 'name', 'offset', 'platform', 'version'], 'six words and an offset: never a path');
  assert.deepEqual(asked[0].args, { version: '1.0.0.0', name: 'lib_burst_generated.pdb', limit: 500, offset: 0 });
  assert.match(f.text, /Fetched lib_burst_generated\.pdb of 1\.0\.0\.0 main WindowsPlayer .*244\.1 KB in 3 part\(s\).*checked on arrival/);
});

test('fetch_ffbox_symbols: a part whose bytes are not its SHA-256, or a file that changed between parts, keeps nothing', async (t) => {
  const { pm, store, c, dataDir } = await setup(t);
  let mode: 'part' | 'whole' = 'part';
  const stop = onQuery(c, (q) => {
    if (q.what === 'symbols') return listing([pdbView()])(c, q);
    const offset = Number(q.args?.offset ?? 0);
    if (mode === 'part' && offset === PART) return sendPart(c, q, PDB, { partSha: 'f'.repeat(64) });
    if (mode === 'whole' && offset === PART) return sendPart(c, q, PDB, { wholeSha: 'e'.repeat(64) });
    sendPart(c, q, PDB);
  });
  t.after(stop);
  await assert.rejects(fetchFfboxSymbols(pm, store, { version: '1.0.0.0', file: 'lib_burst_generated.pdb' }, undefined, { retryMs: 1 }), /did not arrive intact from byte 100000 .sha_mismatch/);
  mode = 'whole';
  await assert.rejects(fetchFfboxSymbols(pm, store, { version: '1.0.0.0', file: 'lib_burst_generated.pdb' }, undefined, { retryMs: 1 }), /changed on FFBox/);
  assert.equal(store.usage().files, 0, "no attachment was made");
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'attachments', 'partial')).length, 0, 'and no partial upload is left');
});

test('fetch_ffbox_symbols: no match, two builds, over the attachment limit and a refusal each say so before any byte moves', async (t) => {
  const { pm, store, c } = await setup(t);
  let files: unknown[] = [pdbView(), pdbView({ app: 'demo' })];
  let refused = false;
  const stop = onQuery(c, (q) => {
    if (q.what === 'symbols') return listing(files)(c, q);
    if (refused) return c.send({ type: 'query_result', id: q.id, what: 'symbol_file', ok: true, data: { refused: 'name: only a .pdb, .sym, .dll or .exe the store lists is handed over' } });
    assert.fail('no part may be asked for');
  });
  t.after(stop);
  await assert.rejects(fetchFfboxSymbols(pm, store, { version: '1.0.0.0', file: 'lib_burst_generated.pdb' }), /in 2 builds .* give platform, app or id[\s\S]*demo/);
  await assert.rejects(fetchFfboxSymbols(pm, store, { version: '1.0.0.0', file: 'UnityPlayer.pdb' }), /has no UnityPlayer\.pdb for version 1\.0\.0\.0/);
  files = [pdbView({ bytes: 900 * 1024 * 1024 })];
  await assert.rejects(fetchFfboxSymbols(pm, store, { version: '1.0.0.0', file: 'lib_burst_generated.pdb' }), /900\.0 MB; this portal's attachment store takes at most 200\.0 MB/);
  files = [pdbView()];
  refused = true;
  await assert.rejects(fetchFfboxSymbols(pm, store, { version: '1.0.0.0', file: 'lib_burst_generated.pdb' }), /FFBox refused lib_burst_generated\.pdb of 1\.0\.0\.0: name:/);
  await assert.rejects(fetchFfboxSymbols(pm, store, { file: 'lib_burst_generated.pdb' }), /version or commit/);
  await assert.rejects(fetchFfboxSymbols(pm, store, { version: '1.0.0.0', file: '../../secrets.env' }), /file: a symbol file's name/);
  assert.equal(store.usage().files, 0);
});

test('list_ffbox_files: the symbols args are checked here first, and the answers read as FFBox data', () => {
  assert.deepEqual(ffboxSymbolsArgs({ version: '1.0.0.0', name: 'burst' }), { args: { limit: 200, offset: 0, version: '1.0.0.0', name: 'burst' } });
  for (const bad of [{ version: '../1.0' }, { commit: 'xyz' }, { platform: 'etc' }, { app: '../main' }]) assert.ok('error' in ffboxSymbolsArgs(bad), JSON.stringify(bad));
  const versions = describeSymbols({ what: 'symbols', live: true, ok: true, at: '2026-10-19T07:00:00Z', data: { versions: [{ version: '1.0.0.0', builds: [{ app: 'main', platform: 'WindowsPlayer', modules: 41, sources: ['master@abcdef123456'] }] }], about: 'release symbols' } });
  assert.match(versions, /^\[ffbox data: release symbols/);
  assert.match(versions, /- 1\.0\.0\.0: main WindowsPlayer \(41 modules, built from master@abcdef123456\)/);
  const files = describeSymbols({ what: 'symbols', live: true, ok: true, data: { files: [pdbView()], total: 1, offset: 0 } }, 200 * 1024 * 1024);
  assert.match(files, /lib_burst_generated\.pdb \(244\.1 KB, pdb\): 1\.0\.0\.0 main WindowsPlayer, module lib_burst_generated\.pdb, id A1B2/);
  assert.match(files, /up to 200\.0 MB a file/);
  for (const q of ['symbols', 'symbol_file', 'diagnosis_files', 'diagnosis_file']) assert.ok((PROVIDER_QUERIES as readonly string[]).includes(q), q);
  assert.deepEqual(Object.keys(CATALOG.fetch_ffbox_symbols).sort(), ['app', 'commit', 'file', 'id', 'platform', 'version'], 'names and words, never a path');
  assert.deepEqual(Object.keys(CATALOG.list_ffbox_files).sort(), ['app', 'channel', 'commit', 'id', 'kind', 'limit', 'name', 'offset', 'platform', 'since', 'until', 'version', 'what']);
});

test("fetch_ffbox_report diagnosis: the newest run that kept the file, SHA-256 checked; a refusal keeps nothing", async (t) => {
  const { pm, store, c } = await setup(t);
  const summary = Buffer.from('crash signature: lib_burst_generated!Foo\n');
  const runs = [{ conversation: 7, run: 12, files: [{ name: 'stack.txt', bytes: 30 }] }, { conversation: 7, run: 9, files: [{ name: 'summary.md', bytes: summary.length }] }];
  const asked: Q[] = [];
  const stop = onQuery(c, (q) => {
    asked.push(q);
    if (q.what === 'diagnosis_files') return c.send({ type: 'query_result', id: q.id, what: q.what, ok: true, data: { report: RID, runs, untrusted: 'data' } });
    if (q.args?.name === 'leaky.log') return c.send({ type: 'query_result', id: q.id, what: q.what, ok: true, data: { report: RID, run: 12, refused: 'withheld: the file carries a credential this box holds' } });
    c.send({ type: 'query_result', id: q.id, what: q.what, ok: true, data: { report: RID, conversation: 7, run: q.args?.run, file: { name: 'summary.md', bytes: summary.length }, transfer: { name: 'summary.md', bytes: summary.length, sha256: sha(summary), chunk_bytes: REPORT_LIMITS.maxChunkBytes } } });
    c.send({ type: 'report_chunk', id: q.id, offset: 0, data: summary.toString('base64') });
    c.send({ type: 'report_end', id: q.id, ok: true, bytes: summary.length, sha256: sha(summary) });
  });
  t.after(stop);
  const f = await fetchFfboxDiagnosis(pm, store, { id: RID, file: 'summary.md' });
  assert.equal(f.records[0].sha256, sha(summary));
  assert.deepEqual(asked.find((q) => q.what === 'diagnosis_file')?.args, { id: RID, run: 9, name: 'summary.md' }, 'run 9 kept summary.md, run 12 did not');
  assert.match(f.text, /Fetched summary\.md of 20261018T101500Z-crash-3a9f01c2d4's diagnosis \(FFBox conversation 7, run 9\)/);
  await assert.rejects(fetchFfboxDiagnosis(pm, store, { id: RID, file: 'leaky.log', run: 12 }), /withheld/);
  await assert.rejects(fetchFfboxDiagnosis(pm, store, { id: RID, file: '../summary.md' }), /diagnosis: one file/);
  await assert.rejects(fetchFfboxDiagnosis(pm, store, { id: RID, file: 'none.md' }), /no diagnosis run of .* kept a file named none\.md/);
  const text = describeDiagnosisFiles({ what: 'diagnosis_files', live: true, ok: true, data: { report: RID, runs } });
  assert.match(text, /- conversation 7, run 9: summary\.md/);
  assert.deepEqual(Object.keys(CATALOG.fetch_ffbox_report).sort(), ['diagnosis', 'file', 'id', 'run']);
});
