import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { IMMUTABLE, REVALIDATE, appCsp, brandedManifest, serveStatic, webBuild, withBrand, withBuildMeta } from './webStatic.ts';
import { BUILD_META } from '../shared/freshness.ts';

const INDEX_V1 = '<!doctype html><html><head><script type="module" src="/assets/index-aaaa.js"></script></head><body></body></html>';
const INDEX_V2 = '<!doctype html><html><head><script type="module" src="/assets/index-bbbb.js"></script></head><body></body></html>';

/** A built web UI in a temp folder, served the way server/index.ts serves web/dist. */
async function withSite(fn: (get: (p: string, headers?: Record<string, string>) => Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>, dir: string) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webstatic-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'index.html'), INDEX_V1);
  fs.writeFileSync(path.join(dir, 'assets', 'index-aaaa.js'), 'console.log(1)');
  fs.writeFileSync(path.join(dir, 'sw.js'), '// sw');
  fs.writeFileSync(path.join(dir, 'manifest.webmanifest'), '{}');
  // A throw answers 500 with its message, so a test fails on it rather than waiting forever for a reply.
  const server = http.createServer((req, res) =>
    serveStatic(dir, req, new URL(req.url ?? '/', 'http://x'), res).catch((e: Error) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(e?.stack ?? e));
    }),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  const get = (p: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
          let body = '';
          res.on('data', (c: Buffer) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        })
        .on('error', reject);
    });
  try {
    await fn(get, dir);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

test('the app page and /login carry the CSP (scripts from this origin only, no framing, no plug-ins) and nosniff (w5518)', async () => {
  await withSite(async (get) => {
    for (const p of ['/', '/login', '/index.html']) {
      const r = await get(p);
      const csp = String(r.headers['content-security-policy'] ?? '');
      assert.match(csp, /(^|; )script-src 'self'(;|$)/, p);
      assert.match(csp, /(^|; )frame-ancestors 'none'(;|$)/, p);
      assert.match(csp, /(^|; )object-src 'none'(;|$)/, p);
      assert.doesNotMatch(csp, /script-src[^;]*(unsafe|blob:|data:)/, p);
      // Remote images in agent text stop loading: no remote origin, no wildcard.
      assert.match(csp, /(^|; )img-src 'self' data: blob:(;|$)/, p);
      assert.equal(r.headers['x-content-type-options'], 'nosniff', p);
    }
  });
});

test('the CSP names the socket origin of a plain Host, and leaves out an odd one', () => {
  assert.match(appCsp('fff.example.ts.net'), /connect-src 'self' wss:\/\/fff\.example\.ts\.net ws:\/\/fff\.example\.ts\.net;/);
  assert.match(appCsp('127.0.0.1:8790'), /connect-src 'self' wss:\/\/127\.0\.0\.1:8790 ws:\/\/127\.0\.0\.1:8790;/);
  assert.match(appCsp('[::1]:8790'), /wss:\/\/\[::1\]:8790/);
  for (const odd of [undefined, '', "evil; script-src *", 'a b', 'x:99999999']) assert.match(appCsp(odd), /connect-src 'self';/, String(odd));
});

test('the page (/, index.html and any app route) revalidates every time and names its build; hashed bundles are kept for good', async () => {
  await withSite(async (get, dir) => {
    const build = webBuild(dir)!;
    assert.match(build, /^[0-9a-f]{12}$/);
    for (const p of ['/', '/index.html', '/some/app/route']) {
      const r = await get(p);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers['cache-control'], REVALIDATE, p);
      assert.equal(r.headers.etag, `"${build}"`, p);
      assert.match(r.headers['content-type'] ?? '', /^text\/html/, p);
      assert.ok(r.body.includes(`<meta name="${BUILD_META}" content="${build}" />`), p);
    }
    const js = await get('/assets/index-aaaa.js');
    assert.equal(js.status, 200);
    assert.equal(js.headers['cache-control'], IMMUTABLE);
    // Not hashed: the service worker and the manifest are asked about again too.
    assert.equal((await get('/sw.js')).headers['cache-control'], REVALIDATE);
    assert.equal((await get('/manifest.webmanifest')).headers['cache-control'], REVALIDATE);
  });
});

test('an unchanged page costs a 304; a rebuild changes the build and the page, without a restart', async () => {
  await withSite(async (get, dir) => {
    const v1 = webBuild(dir)!;
    const same = await get('/', { 'if-none-match': `"${v1}"` });
    assert.equal(same.status, 304);
    assert.equal(same.body, '');

    fs.writeFileSync(path.join(dir, 'index.html'), INDEX_V2);
    // A different size, so the stat check sees the rebuild even within one mtime tick.
    const v2 = webBuild(dir)!;
    assert.notEqual(v2, v1);
    const fresh = await get('/', { 'if-none-match': `"${v1}"` });
    assert.equal(fresh.status, 200);
    assert.equal(fresh.headers.etag, `"${v2}"`);
    assert.ok(fresh.body.includes('index-bbbb.js') && fresh.body.includes(`content="${v2}"`));
  });
});

test('a bundle a rebuild removed is a 404, not the page in its place (an old tab would fail on a MIME error)', async () => {
  await withSite(async (get) => {
    const r = await get('/assets/index-gone.js');
    assert.equal(r.status, 404);
    assert.equal(r.headers['cache-control'], 'no-store');
  });
});

test('no web UI built: no build id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webstatic-empty-'));
  try {
    assert.equal(webBuild(dir), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the build meta goes first in <head>', () => {
  assert.equal(withBuildMeta('<html><head><title>x</title></head></html>', 'abc'), `<html><head>\n    <meta name="${BUILD_META}" content="abc" /><title>x</title></head></html>`);
});

// w15: an install that is not Final Factory's names the page and the installed app after itself.
test("the page's and the PWA's name: Final Factory's build as it is, another install's own", () => {
  const html = '<head><meta name="apple-mobile-web-app-title" content="FF Factory" />\n<title>FF Factory</title></head>';
  assert.equal(withBrand(html, undefined), html);
  const brand = { title: 'Ryding Factory for Lens Scout', short: 'Lens Scout' };
  assert.equal(withBrand(html, brand), '<head><meta name="apple-mobile-web-app-title" content="Lens Scout" />\n<title>Ryding Factory for Lens Scout</title></head>');
  assert.equal(withBrand('<title>x</title>', { title: 'A & <B>', short: 'A' }), '<title>A &amp; &lt;B&gt;</title>');
  const m = JSON.parse(brandedManifest(JSON.stringify({ name: 'FF Factory', short_name: 'FF Factory', description: 'x', start_url: '/' }), brand)) as Record<string, string>;
  assert.equal(m.name, 'Ryding Factory for Lens Scout');
  assert.equal(m.short_name, 'Lens Scout');
  assert.equal(m.start_url, '/');
  assert.match(m.description, /Lens Scout's agents/);
});
