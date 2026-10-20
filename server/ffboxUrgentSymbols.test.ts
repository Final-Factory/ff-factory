// An urgent-lane release's symbols into FFBox's store (w1639; docs/ffbox.md, "Symbols of an urgent-lane build"). lothsahn:
// "Please make sure that if beast does a build that the symbols get uploaded to ffbox in the normal place so it can
// diagnose crashes and desyncs", and "We don't want a new public endpoint on ffbox." The portal sends each published
// archive over FFBox's own connector link (symbols_put parts, answered by the connector) and asks FFBox to file each build
// (symbols_ingest). The mock here answers as ffbox scripts/fffconnector.py symbols_put and ffwatch fff_query_symbols_ingest
// do (ffbox test/test_urgent_symbols.py tests those).
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
import { FfboxSymbolUploads, checkSymbolUpload, describeSymbolUpload } from './ffboxUrgentSymbols.ts';
import { SYMBOLS_UPLOAD, mintProviderToken, tokenSha256 } from './providerProtocol.ts';
import { CATALOG } from './launch.ts';
import { MockConnector } from '../e2e/mockConnector.ts';
import type { Config } from './config.ts';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function setup(t: { after: (fn: () => Promise<void> | void) => void }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffbox-urgent-symbols-'));
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
  }, 5);
  return () => clearInterval(timer);
}

/**
 * FFBox as its connector and ffwatch answer: parts only at the offset an archive stands at (a 3-part window ahead of
 * ffwatch, which takes them on every 4th part), complete once the bytes' SHA-256 is the archive's name; symbols_ingest
 * filing, then filed (or refused for `refuse`).
 */
function fakeFfbox(c: MockConnector, opts: { refuse?: string; busyEvery?: number; refusePut?: boolean } = {}) {
  const got = new Map<string, Buffer[]>();
  const log: { what: string; args: Record<string, unknown> }[] = [];
  let puts = 0;
  const filings = new Map<string, number>();
  const stop = onQuery(c, (q) => {
    const a = q.args ?? {};
    log.push({ what: q.what, args: a });
    if (q.what === 'symbols_put') {
      puts++;
      if (opts.refusePut) return c.send({ type: 'query_result', id: q.id, what: q.what, ok: false, error: 'refused', reason: 'over the 512 MB an archive may be' });
      if (opts.busyEvery && puts % opts.busyEvery === 0) return c.send({ type: 'query_result', id: q.id, what: q.what, ok: false, error: 'busy', reason: 'FFBox has not taken the parts before this one yet' });
      const name = String(a.archive);
      const parts = got.get(name) ?? [];
      got.set(name, parts);
      const have = parts.reduce((n, p) => n + p.length, 0);
      const total = Number(a.bytes);
      if (have === total && sha(Buffer.concat(parts)) === name) return c.send({ type: 'query_result', id: q.id, what: q.what, ok: true, data: { have, complete: true } });
      if (Number(a.offset) !== have || have >= total) return c.send({ type: 'query_result', id: q.id, what: q.what, ok: true, data: { have, complete: false } });
      const data = Buffer.from(String(a.data), 'base64');
      parts.push(data);
      return c.send({ type: 'query_result', id: q.id, what: q.what, ok: true, data: { have: have + data.length, complete: false } });
    }
    if (q.what === 'symbols_ingest') {
      const key = `${a.version} ${a.app} ${a.platform}`;
      if (opts.refuse) return c.send({ type: 'query_result', id: q.id, what: q.what, ok: true, data: { state: 'refused', reason: opts.refuse } });
      const n = (filings.get(key) ?? 0) + 1;
      filings.set(key, n);
      return c.send({ type: 'query_result', id: q.id, what: q.what, ok: true, data: n < 2 ? { state: 'filing', archive: a.archive } : { state: 'filed', modules: 12, sources: ['master@abc'] } });
    }
    c.send({ type: 'query_result', id: q.id, what: q.what, ok: false, error: 'unsupported' });
  });
  return { got, log, stop };
}

const ARCHIVE = Buffer.from(Array.from({ length: 200_000 }, (_, i) => (i * 7919 + 13) % 253));
const MAC = Buffer.from(Array.from({ length: 50_000 }, (_, i) => (i * 31) % 249));

async function publish(store: AttachmentStore, dir: string, name: string, body: Buffer) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, body);
  return store.addFile(f, { source: 'test' });
}

const quick = { sleep: () => new Promise<void>((r) => setTimeout(r, 1)), limits: { pollMs: 1, stallMs: 5_000 } };

test('w1639: each archive crosses once, in parts, and every build is filed; the tool text says so', async (t) => {
  const { pm, store, c, dataDir } = await setup(t);
  const ffbox = fakeFfbox(c);
  t.after(ffbox.stop);
  const win = await publish(store, dataDir, 'win.tgz', ARCHIVE);
  const mac = await publish(store, dataDir, 'mac.tgz', MAC);
  const ups = new FfboxSymbolUploads(pm, store, quick);
  const job = ups.start(
    '1.0.0.3',
    [
      { app: 'main', platform: 'WindowsPlayer', attachment: win.id },
      { app: 'demo', platform: 'WindowsPlayer', attachment: win.id },
      { app: 'main', platform: 'OSXPlayer', attachment: mac.id },
      { app: 'demo', platform: 'OSXPlayer', attachment: mac.id },
    ],
    'worker "w1639" on beast/slot4',
  );
  await job.done;
  assert.equal(job.error, undefined, job.error ?? "");
  assert.deepEqual(Buffer.concat(ffbox.got.get(sha(ARCHIVE))!), ARCHIVE, 'the Windows archive arrived whole, in order');
  assert.deepEqual(Buffer.concat(ffbox.got.get(sha(MAC))!), MAC, 'and the Mac one');
  const puts = ffbox.log.filter((l) => l.what === 'symbols_put');
  assert.ok(puts.every((p) => Buffer.from(String(p.args.data), 'base64').length <= SYMBOLS_UPLOAD.partBytes), 'no part over the connector\'s 45,000 bytes');
  assert.ok(puts.every((p) => typeof p.args.archive === 'string' && /^[0-9a-f]{64}$/.test(p.args.archive as string)), 'an archive is named by its SHA-256, never a path');
  assert.equal(puts.filter((p) => p.args.archive === sha(ARCHIVE) && p.args.offset === 0).length, 1, 'main and the demo share one archive: it crosses once');
  const ingests = ffbox.log.filter((l) => l.what === 'symbols_ingest');
  assert.deepEqual([...new Set(ingests.map((i) => `${i.args.app} ${i.args.platform}`))], ['main WindowsPlayer', 'demo WindowsPlayer', 'main OSXPlayer', 'demo OSXPlayer']);
  assert.ok(ingests.every((i) => i.args.version === '1.0.0.3' && i.args.by === 'worker "w1639" on beast/slot4'));
  assert.ok(job.entries.every((e) => e.state === 'filed' && e.modules === 12));
  const text = describeSymbolUpload(job);
  assert.match(text, /^\[ffbox data: /);
  assert.match(text, /1\.0\.0\.3 main WindowsPlayer: filed, 12 modules in the store/);
  assert.match(text, /on FFBox whole, SHA-256 checked there/);
  assert.match(text, /Done: list_ffbox_files what "symbols" version "1\.0\.0\.3" lists them/);
  assert.equal(ups.get('1.0.0.3'), job, 'asked again with the version, the tool reports this upload');
});

test('w1639: a busy FFBox (its window full) is waited out; the parts never count against the 30 queries a minute', async (t) => {
  const { pm, store, c, dataDir } = await setup(t);
  const ffbox = fakeFfbox(c, { busyEvery: 3 });
  t.after(ffbox.stop);
  const win = await publish(store, dataDir, 'win.tgz', ARCHIVE);
  const job = new FfboxSymbolUploads(pm, store, quick).start('1.0.0.3', [{ app: 'main', platform: 'WindowsPlayer', attachment: win.id }], 'w');
  await job.done;
  assert.equal(job.error, undefined, job.error ?? "");
  assert.deepEqual(Buffer.concat(ffbox.got.get(sha(ARCHIVE))!), ARCHIVE);
  assert.ok(ffbox.log.filter((l) => l.what === 'symbols_put').length > Math.ceil(ARCHIVE.length / SYMBOLS_UPLOAD.partBytes), 'busy parts were sent again');
  assert.equal(pm.queryProblem('symbols'), undefined, 'the views still have their whole budget');
});

test('w1639: FFBox\'s refusal ends the upload with its words; a filing FFBox refuses says why', async (t) => {
  const a = await setup(t);
  const f1 = fakeFfbox(a.c, { refusePut: true });
  t.after(f1.stop);
  const win = await publish(a.store, a.dataDir, 'win.tgz', ARCHIVE);
  const job = new FfboxSymbolUploads(a.pm, a.store, quick).start('1.0.0.3', [{ app: 'main', platform: 'WindowsPlayer', attachment: win.id }], 'w');
  await job.done;
  assert.match(job.error ?? '', /FFBox refused archive .* over the 512 MB an archive may be/);
  assert.match(describeSymbolUpload(job), /Call file_ffbox_symbols again with the same entries/);
  f1.stop();
  const f2 = fakeFfbox(a.c, { refuse: 'the store already holds 1.0.0.4 main WindowsPlayer from master@0123456789ab: this box never files over it' });
  t.after(f2.stop);
  const job2 = new FfboxSymbolUploads(a.pm, a.store, quick).start('1.0.0.4', [{ app: 'main', platform: 'WindowsPlayer', attachment: win.id }], 'w');
  await job2.done;
  assert.equal(job2.entries[0].state, 'refused');
  assert.match(describeSymbolUpload(job2), /never files over it/);
  assert.match(describeSymbolUpload(job2), /Not every build was filed/);
});

test('w1639: the call is checked here first: a version, 1 to 6 builds, each once, an archive this portal holds', async (t) => {
  const { store, dataDir } = await setup(t);
  const win = await publish(store, dataDir, 'win.tgz', ARCHIVE);
  const bad: [unknown, unknown, RegExp][] = [
    ['1.0.3', [{ app: 'main', platform: 'WindowsPlayer', attachment: win.id }], /four numbers/],
    ['1.0.0.3', [], /1 to 6 builds/],
    ['1.0.0.3', [{ app: 'beta', platform: 'WindowsPlayer', attachment: win.id }], /main or demo/],
    ['1.0.0.3', [{ app: 'main', platform: 'Android', attachment: win.id }], /WindowsPlayer, OSXPlayer, LinuxPlayer/],
    ['1.0.0.3', [{ app: 'main', platform: 'WindowsPlayer', attachment: '../../etc/passwd' }], /attachment id from publish_attachment/],
    ['1.0.0.3', [{ app: 'main', platform: 'WindowsPlayer', attachment: 'att_aaaaaaaaaaaa' }], /has no att_aaaaaaaaaaaa/],
    ['1.0.0.3', [{ app: 'main', platform: 'WindowsPlayer', attachment: win.id }, { app: 'main', platform: 'WindowsPlayer', attachment: win.id }], /twice/],
  ];
  for (const [v, e, re] of bad) assert.throws(() => checkSymbolUpload(store, v, e), re);
  assert.equal(checkSymbolUpload(store, '1.0.0.3', [{ app: 'demo', platform: 'LinuxPlayer', attachment: win.id }]).entries[0].record.sha256, sha(ARCHIVE));
});

test('w1639: file_ffbox_symbols is a worker tool on every computer, in the ffbox group', () => {
  assert.ok('file_ffbox_symbols' in CATALOG);
  const shape = (CATALOG as Record<string, Record<string, unknown>>).file_ffbox_symbols;
  assert.deepEqual(Object.keys(shape).sort(), ['entries', 'version']);
});
