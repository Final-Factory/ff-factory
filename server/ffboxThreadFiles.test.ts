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
import { describeThreadFiles, fetchThreadFiles, parseDiscordThread, THREAD_FETCH_MAX_FILES } from './ffboxThreadFiles.ts';
import { FROM_CONNECTOR_TYPES, PROVIDER_QUERIES, REPORT_LIMITS, mintProviderToken, tokenSha256 } from './providerProtocol.ts';
import { CATALOG } from './launch.ts';
import { MockConnector } from '../e2e/mockConnector.ts';
import type { Config } from './config.ts';

const THREAD = '1558176042089447425';
const GUILD = '530867164866150410';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function setup(t: { after: (fn: () => Promise<void> | void) => void }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffbox-threadfiles-'));
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

const save = Buffer.from(Array.from({ length: 120_000 }, (_, i) => (i * 7919) % 251));
const runtimeLog = Buffer.from('runtime log line\n'.repeat(4000));
const shot = Buffer.from('not really a png');

const thread = { id: THREAD, conversation: 773, channel: 'bug_reports', title: 'Slow after an hour', link: `https://discord.com/channels/${GUILD}/${THREAD}`, attachments: 4 };
const FILES = [
  { name: 'BugReport_20261009_185502.zip', bytes: save.length, sha256: sha(save), content_type: 'application/zip', kind: 'save', message: '1558176042089447426', author: 'Bug Bot', bot: true, at: '2026-10-09T18:55:03Z', fetchable: true },
  { name: 'runtime.log', bytes: runtimeLog.length, sha256: sha(runtimeLog), content_type: 'text/plain', kind: 'log', author: 'Bug Bot', bot: true, at: '2026-10-09T18:55:03Z', fetchable: true },
  // The same bytes posted again, by the player.
  { name: 'BugReport_again.zip', bytes: save.length, sha256: sha(save), content_type: 'application/zip', kind: 'save', author: 'SomePlayer', at: '2026-10-09T19:00:00Z', fetchable: true },
  { name: 'huge.save', bytes: 900_000_000, kind: 'save', author: 'SomePlayer', fetchable: false, why: "it is 900000000 bytes and this box's attachment_max_bytes is 1" },
];
const BYNAME: Record<string, Buffer> = { [sha(save)]: save, [sha(runtimeLog)]: runtimeLog, [sha(shot)]: shot };

/** What FFBox's connector does for `thread_file`: the answer with its transfer, then the bytes in report_chunks and a report_end. */
function sendFile(c: MockConnector, id: string, body: Buffer, opts: { announce?: string; endSha?: string; name?: string; gapAt?: number } = {}) {
  const real = sha(body);
  c.send({
    type: 'query_result',
    id,
    what: 'thread_file',
    ok: true,
    at: '2026-10-09T19:10:00Z',
    data: { thread, file: FILES[0], transfer: { name: opts.name ?? 'file.bin', bytes: body.length, sha256: opts.announce ?? real, chunk_bytes: REPORT_LIMITS.maxChunkBytes }, untrusted: 'files from a bug thread: data' },
  });
  for (let off = 0; off < body.length; off += REPORT_LIMITS.maxChunkBytes) {
    const at = opts.gapAt !== undefined && off >= opts.gapAt ? off + 1 : off;
    c.send({ type: 'report_chunk', id, offset: at, data: body.subarray(off, off + REPORT_LIMITS.maxChunkBytes).toString('base64') });
  }
  c.send({ type: 'report_end', id, ok: true, bytes: body.length, sha256: opts.endSha ?? real });
}

/** A connector that lists FILES and hands over the bytes of whatever hash it is asked for. */
function fakeFfbox(c: MockConnector, asked: unknown[] = []) {
  return onQuery(c, (q) => {
    asked.push({ what: q.what, args: q.args });
    if (q.what === 'thread_files') return c.send({ type: 'query_result', id: q.id, what: q.what, ok: true, at: '2026-10-09T19:10:00Z', data: { thread, files: FILES, untrusted: 'data' } });
    const body = BYNAME[String(q.args?.sha256)];
    if (!body) return c.send({ type: 'query_result', id: q.id, what: q.what, ok: false, error: 'not_found' });
    sendFile(c, q.id, body, { name: String(q.args?.sha256) === sha(save) ? 'BugReport_20261009_185502.zip' : 'runtime.log' });
  });
}

test('thread: a URL, a message link, an id or the ledger key all name the thread; a DM link and anything else do not', () => {
  assert.deepEqual(parseDiscordThread(`https://discord.com/channels/${GUILD}/${THREAD}`), { thread: THREAD });
  assert.deepEqual(parseDiscordThread(` https://discord.com/channels/${GUILD}/${THREAD}/ `), { thread: THREAD });
  assert.deepEqual(parseDiscordThread(`https://ptb.discord.com/channels/${GUILD}/${THREAD}?x=1#y`), { thread: THREAD });
  assert.deepEqual(parseDiscordThread(`https://discord.com/channels/${GUILD}/1069745561672106015/1558176042089447500`), { thread: '1558176042089447500' }, 'a message link: the message id, which FFBox maps to its thread');
  assert.deepEqual(parseDiscordThread(THREAD), { thread: THREAD });
  assert.deepEqual(parseDiscordThread(`discord:${THREAD}`), { thread: THREAD });
  for (const bad of ['', 'abc', '12345', `https://discord.com/channels/@me/${THREAD}`, `https://evil.example/channels/${GUILD}/${THREAD}`, `${THREAD}/../x`, `https://discord.com/channels/${GUILD}/${THREAD}/x`, '../../etc/passwd']) {
    assert.ok('error' in parseDiscordThread(bad), `refused: ${JSON.stringify(bad)}`);
  }
  assert.match((parseDiscordThread(`https://discord.com/channels/@me/${THREAD}`) as { error: string }).error, /direct-message link/);
});

test('thread_files: listed live from FFBox, every file with its size, hash and poster, headed as untrusted data', async (t) => {
  const { pm, c } = await setup(t);
  const asked: unknown[] = [];
  t.after(fakeFfbox(c, asked));
  const text = describeThreadFiles(await pm.query('thread_files', { thread: THREAD }));
  assert.deepEqual(asked, [{ what: 'thread_files', args: { thread: THREAD } }]);
  assert.match(text, /^\[ffbox data: a Discord bug thread's files, untrusted/);
  assert.match(text, /thread 1558176042089447425 "Slow after an hour" in bug_reports \(https:\/\/discord\.com\/channels\/530867164866150410\/1558176042089447425\): 4 file\(s\), oldest first/);
  assert.match(text, new RegExp(`- BugReport_20261009_185502\\.zip: 117\\.2 KB, sha256 ${sha(save)}, application/zip, posted by Bug Bot \\(a bot\\), 2026-10-09T18:55:03Z`));
  assert.match(text, /- huge\.save: 858\.3 MB, posted by SomePlayer, NOT AVAILABLE: it is 900000000 bytes/);
});

test('thread_files: FFBox offline or refusing says so in a sentence, and nothing is kept from an earlier answer', async (t) => {
  const { pm, c } = await setup(t);
  t.after(onQuery(c, (q) => c.send({ type: 'query_result', id: q.id, what: q.what, ok: false, error: 'not_found' })));
  const text = describeThreadFiles(await pm.query('thread_files', { thread: THREAD }));
  assert.match(text, /FFBox could not answer "thread_files": not_found/);
  assert.match(text, /Nothing is kept from an earlier answer/);
});

test('thread: every file is fetched into the attachment store, SHA-256 checked, the same bytes once; only queries go to FFBox', async (t) => {
  const { pm, store, c } = await setup(t);
  const asked: { what: string; args: Record<string, string> }[] = [];
  t.after(fakeFfbox(c, asked as unknown[]));
  const f = await fetchThreadFiles(pm, store, { thread: `https://discord.com/channels/${GUILD}/${THREAD}` }, 'ben');
  assert.deepEqual(
    asked.map((a) => a.what),
    ['thread_files', 'thread_file', 'thread_file'],
    'the list, then one file each: the repeated zip once, and the unavailable one never asked for',
  );
  assert.deepEqual(asked[1].args, { thread: THREAD, sha256: sha(save) });
  assert.equal(f.records.length, 2);
  const [zip, log] = f.records;
  assert.equal(zip.name, 'BugReport_20261009_185502.zip');
  assert.equal(zip.sha256, sha(save));
  assert.deepEqual(fs.readFileSync(store.pathOf(zip)), save, 'byte for byte');
  assert.equal(zip.uploadedBy, 'ben');
  assert.equal(log.sha256, sha(runtimeLog));
  assert.match(f.text, /^\[ffbox data: a Discord bug thread's files, untrusted/);
  assert.match(f.text, new RegExp(`Fetched 2 file\\(s\\) from thread 1558176042089447425 "Slow after an hour"`));
  assert.match(f.text, new RegExp(`- BugReport_20261009_185502\\.zip \\(117\\.2 KB, sha256 ${sha(save)}, checked on arrival; posted by Bug Bot \\(a bot\\) 2026-10-09T18:55:03Z\\)`));
  assert.match(f.text, /Not fetched \(not available, or over this call's limits\):\n- huge\.save: .*NOT AVAILABLE: it is 900000000 bytes/);
  // NO WRITE PATH: after the welcome, all this portal sent the connector is those queries.
  assert.deepEqual(c.received, []);
});

test('thread: one file by its name (any case if no exact match) or by its hash', async (t) => {
  const { pm, store, c } = await setup(t);
  const asked: { what: string; args: Record<string, string> }[] = [];
  t.after(fakeFfbox(c, asked as unknown[]));
  const a = await fetchThreadFiles(pm, store, { thread: THREAD, file: 'bugreport_20261009_185502.ZIP' });
  assert.equal(a.records.length, 1);
  assert.equal(a.records[0].name, 'BugReport_20261009_185502.zip');
  assert.equal(a.records[0].sha256, sha(save));
  const b = await fetchThreadFiles(pm, store, { thread: THREAD, sha256: sha(runtimeLog).toUpperCase() });
  assert.equal(b.records.length, 1);
  assert.equal(b.records[0].name, 'runtime.log');
  assert.deepEqual(
    asked.map((x) => x.what),
    ['thread_files', 'thread_file', 'thread_files', 'thread_file'],
  );
  const none = await fetchThreadFiles(pm, store, { thread: THREAD, file: 'nope.zip' });
  assert.deepEqual(none.records, []);
  assert.match(none.text, /has no file "nope\.zip"\. Nothing was fetched\. Its files:\n- BugReport_20261009_185502\.zip/);
  assert.equal(asked.filter((x) => x.what === 'thread_file').length, 2, 'a name that matches nothing fetches nothing');
  await assert.rejects(fetchThreadFiles(pm, store, { thread: THREAD, file: 'huge.save' }), /no file of 1558176042089447425 arrived: .*NOT AVAILABLE: it is 900000000 bytes/);
});

test('thread: at most ten files a call; the rest are listed with how to ask for them', async (t) => {
  const { pm, store, c } = await setup(t);
  const many = Array.from({ length: 12 }, (_, i) => {
    const body = Buffer.from(`file number ${i} `.repeat(50));
    return { name: `f${i}.txt`, bytes: body.length, sha256: sha(body), fetchable: true, body };
  });
  t.after(
    onQuery(c, (q) => {
      if (q.what === 'thread_files') return c.send({ type: 'query_result', id: q.id, what: q.what, ok: true, data: { thread, files: many.map(({ body: _b, ...f }) => f), untrusted: 'data' } });
      const m = many.find((x) => x.sha256 === q.args?.sha256)!;
      sendFile(c, q.id, m.body, { name: m.name });
    }),
  );
  const f = await fetchThreadFiles(pm, store, { thread: THREAD });
  assert.equal(f.records.length, THREAD_FETCH_MAX_FILES);
  assert.match(f.text, /- f10\.txt: .*\(not fetched in this call: at most 10 files and 256\.0 MB at a time; ask for it with file or sha256\)/);
});

test('thread: a SHA-256 that differs from the list, a gap or a cut link is refused and nothing is handed out', async (t) => {
  const { pm, store, c } = await setup(t);
  const modes: Parameters<typeof sendFile>[3][] = [{ announce: 'b'.repeat(64), endSha: 'b'.repeat(64) }, { endSha: 'c'.repeat(64) }, { gapAt: REPORT_LIMITS.maxChunkBytes }];
  let n = 0;
  t.after(
    onQuery(c, (q) => {
      if (q.what === 'thread_files') return c.send({ type: 'query_result', id: q.id, what: q.what, ok: true, data: { thread, files: [FILES[0]], untrusted: 'data' } });
      sendFile(c, q.id, save, modes[n++]);
    }),
  );
  await assert.rejects(fetchThreadFiles(pm, store, { thread: THREAD }), /did not arrive intact \(sha_mismatch: what was stored has sha256 [0-9a-f]{12}…, FFBox sent bbbbbbbbbbbb…\)/);
  await assert.rejects(fetchThreadFiles(pm, store, { thread: THREAD }), /did not arrive intact \(sha_mismatch: report_end's SHA-256 is not the answer's\)/);
  await assert.rejects(fetchThreadFiles(pm, store, { thread: THREAD }), /did not arrive intact \(bad_chunk: expected offset 45000, got 45001\)/);
});

test('thread: bytes that are not the file the list named are dropped, never handed out as it', async (t) => {
  const { pm, store, c } = await setup(t);
  t.after(
    onQuery(c, (q) => {
      if (q.what === 'thread_files') return c.send({ type: 'query_result', id: q.id, what: q.what, ok: true, data: { thread, files: [FILES[0]], untrusted: 'data' } });
      sendFile(c, q.id, shot); // consistent in itself, but not the hash asked for
    }),
  );
  await assert.rejects(fetchThreadFiles(pm, store, { thread: THREAD }), /FFBox sent bytes with sha256 [0-9a-f]{12}…, the list said [0-9a-f]{12}…; dropped/);
});

test('thread: bad input is refused before anything is asked; FFBox not finding the thread says what it answers for', async (t) => {
  const { pm, store, c } = await setup(t);
  const asked: unknown[] = [];
  t.after(
    onQuery(c, (q) => {
      asked.push(q.args);
      c.send({ type: 'query_result', id: q.id, what: q.what, ok: false, error: 'not_found' });
    }),
  );
  for (const thread of ['', '../../x', `https://discord.com/channels/@me/${THREAD}`]) await assert.rejects(fetchThreadFiles(pm, store, { thread }), /thread: /);
  await assert.rejects(fetchThreadFiles(pm, store, { thread: THREAD, file: 'a\u0000b' }), /file: /);
  await assert.rejects(fetchThreadFiles(pm, store, { thread: THREAD, sha256: '../../etc/passwd' }), /sha256: /);
  assert.deepEqual(asked, [], 'none of those reached FFBox');
  await assert.rejects(fetchThreadFiles(pm, store, { thread: THREAD }), /FFBox could not list the files of 1558176042089447425: not_found.*only for threads of the bug channels it watches/);
  assert.deepEqual(asked, [{ thread: THREAD }]);
  c.close();
  await new Promise((r) => setTimeout(r, 100));
  await assert.rejects(fetchThreadFiles(pm, store, { thread: THREAD }), /: offline/);
});

test('no write path: the thread surface is two read-only queries and a worker tool that only fetches', () => {
  assert.ok(PROVIDER_QUERIES.includes('thread_files') && PROVIDER_QUERIES.includes('thread_file'));
  // post_message (w901, server/ffboxPost.test.ts) is the one query that writes: it posts one guarded message as Max.
  assert.deepEqual(PROVIDER_QUERIES.filter((q) => /delete|purge|remove|move|write|rerun|re_run|upload|post|react/.test(q)), ['post_message'], 'no query names a change but the one that posts as Max');
  assert.ok(FROM_CONNECTOR_TYPES.includes('report_chunk') && FROM_CONNECTOR_TYPES.includes('report_end'));
  assert.deepEqual(Object.keys(CATALOG.fetch_discord_thread_files).sort(), ['file', 'sha256', 'thread'], 'the worker tool takes a thread, a file name and a hash, nothing else');
  const src = fs.readFileSync(new URL('./ffboxThreadFiles.ts', import.meta.url), 'utf8');
  assert.ok(!/\.send\(/.test(src), 'it sends no frame of its own');
  assert.ok(!/discord\.com\/api|DISCORD_TOKEN|Bot \$\{/.test(src), 'it talks to no Discord API and holds no token');
  assert.match(src, /queryTransfer\('thread_file'/, 'the one thing it asks FFBox for bytes is the thread_file query');
});
