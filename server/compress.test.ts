import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { acceptsGzip, endMaybeGzip, GZIP_MIN_BYTES, gzippedFile } from './compress.ts';

test('Accept-Encoding: gzip is taken unless refused with q=0', () => {
  assert.equal(acceptsGzip('gzip, deflate, br'), true);
  assert.equal(acceptsGzip('br;q=1.0, gzip;q=0.8'), true);
  assert.equal(acceptsGzip('*'), true);
  assert.equal(acceptsGzip('gzip;q=0'), false);
  assert.equal(acceptsGzip('identity'), false);
  assert.equal(acceptsGzip(undefined), false);
  assert.equal(acceptsGzip(['deflate', 'gzip']), true);
});

/** A GET to a server that replies with `body` through endMaybeGzip; the raw bytes and headers, not decoded. */
async function fetchRaw(body: string, acceptEncoding?: string) {
  const server = http.createServer((req, res) => void endMaybeGzip(req, res, 200, { 'content-type': 'application/json' }, body));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    return await new Promise<{ headers: http.IncomingHttpHeaders; data: Buffer }>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/', headers: acceptEncoding ? { 'accept-encoding': acceptEncoding } : {} }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ headers: res.headers, data: Buffer.concat(chunks) }));
        })
        .on('error', reject);
    });
  } finally {
    server.close();
  }
}

test('a big JSON reply is gzipped for a client that takes gzip, and comes back the same', async () => {
  const body = JSON.stringify({ sessions: Array.from({ length: 2000 }, (_, i) => ({ id: `s${i}`, title: `Agent number ${i}`, status: 'stopped' })) });
  assert.ok(body.length > GZIP_MIN_BYTES);
  const r = await fetchRaw(body, 'gzip, deflate');
  assert.equal(r.headers['content-encoding'], 'gzip');
  assert.equal(r.headers.vary, 'Accept-Encoding');
  assert.ok(r.data.length < body.length / 4, `gzipped ${r.data.length} of ${body.length}`);
  assert.equal(zlib.gunzipSync(r.data).toString(), body);
});

test('a small reply, or a client without gzip, gets the body as it is', async () => {
  const small = await fetchRaw('{"ok":true}', 'gzip');
  assert.equal(small.headers['content-encoding'], undefined);
  assert.equal(small.data.toString(), '{"ok":true}');
  const big = 'x'.repeat(GZIP_MIN_BYTES * 2);
  const plain = await fetchRaw(big);
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.data.toString(), big);
});

test('static text files are gzipped once per version; images are left alone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-gz-'));
  try {
    const js = path.join(dir, 'app.js');
    fs.writeFileSync(js, 'console.log("hello");\n'.repeat(500));
    const first = await gzippedFile(js, fs.statSync(js));
    assert.ok(first);
    assert.equal(zlib.gunzipSync(first).toString(), fs.readFileSync(js, 'utf8'));
    assert.equal(await gzippedFile(js, fs.statSync(js)), first, 'cached');
    fs.writeFileSync(js, 'console.log("changed");\n'.repeat(600));
    const second = await gzippedFile(js, fs.statSync(js));
    assert.equal(zlib.gunzipSync(second!).toString(), fs.readFileSync(js, 'utf8'), 'a new build is served, not the cached one');
    const png = path.join(dir, 'a.png');
    fs.writeFileSync(png, Buffer.alloc(4096));
    assert.equal(await gzippedFile(png, fs.statSync(png)), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
