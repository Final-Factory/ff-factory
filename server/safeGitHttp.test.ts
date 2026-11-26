import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { REPO_TRUST_KEYS, parseScan, refusal, scannedOverrides } from './safeGit.ts';
import { run } from './proc.ts';

// w6100 (w6091's review of #1367, follow-up B): a repository's own config can send the daemon's https calls through a proxy
// it names (`http.proxy`, `http.<url>.proxy`, `remote.<name>.proxy`, `http.curloptResolve`) and turn off or replace the
// certificate check (`http.sslVerify`, `http.sslCAInfo`, `http.sslBackend`), so a token goes to the worker's server.
// Measured on BEAST (git 2.56.1): with a planted http.proxy and sslVerify false, a fenced ls-remote of github.com through a
// MITM on 127.0.0.1 sent its Authorization header to it.

const hasGit = spawnSync('git', ['--version']).status === 0;
const slash = (p: string) => p.replace(/\\/g, '/');
const rows = (r: [string, string][]) => parseScan(r.map(([s, kv]) => `${s}\0${kv}\0`).join(''));

test('w6100: a repository-set proxy, resolve and TLS check fall back to neutral values; a CA file, TLS backend or LFS URL is left to the refusal', () => {
  const scan = rows([
    ['local', 'http.proxy\nhttp://127.0.0.1:1'],
    ['local', 'http.https://github.com.proxy\nhttp://127.0.0.1:1'],
    ['local', 'remote.origin.proxy\nhttp://127.0.0.1:1'],
    ['local', 'http.curloptresolve\ngithub.com:443:127.0.0.1'],
    ['local', 'http.sslverify\nfalse'],
    ['local', 'http.https://github.com.sslverify\nfalse'],
    ['local', 'http.schannelusesslcainfo\ntrue'],
    ['local', 'http.sslcainfo\n/evil.pem'],
    ['local', 'http.sslbackend\nopenssl'],
    ['local', 'lfs.url\nhttp://127.0.0.1:1/lfs'],
    ['global', 'http.sslcapath\n/etc/ssl/certs'],
    ['local', 'http.sslcapath\n/evil'],
  ]);
  assert.deepEqual(scannedOverrides(scan), [
    ['http.proxy', ''],
    ['http.https://github.com.proxy', ''],
    ['remote.origin.proxy', ''],
    ['http.curloptresolve', ''],
    ['http.sslverify', 'true'],
    ['http.https://github.com.sslverify', 'true'],
    ['http.schannelusesslcainfo', ''],
    ['http.sslcapath', '/etc/ssl/certs'],
  ]);
});

test('w6100: warn-only for now: a network call with a repository-set CA file, TLS backend or LFS URL is logged and made', (t) => {
  assert.equal(REPO_TRUST_KEYS, 'warn', 'enforcing is its own PR (lockout rule)');
  const warned: string[] = [];
  t.mock.method(console, 'warn', (m: string) => warned.push(m));
  for (const key of ['http.sslcainfo', 'http.https://github.com.sslbackend', 'lfs.url', 'remote.origin.lfsurl']) {
    warned.length = 0;
    assert.equal(refusal(['-C', 'x', 'fetch', 'origin'], rows([['local', `${key}\nSECRETVALUE`]])), undefined, key);
    assert.equal(warned.length, 1, key);
    assert.match(warned[0], new RegExp(`^safeGit \\(w6100, warn-only\\): would refuse git fetch: the repository's own config sets ${key.replace(/[.]/g, '\\.')}`));
    assert.doesNotMatch(warned[0], /SECRETVALUE/, 'the value is never logged');
  }
  warned.length = 0;
  assert.equal(refusal(['status'], rows([['local', 'http.sslcainfo\n/x']])), undefined);
  assert.equal(refusal(['fetch'], rows([['global', 'http.sslcainfo\n/ca'], ['local', 'http.sslcainfo\n/x']])), undefined);
  assert.equal(warned.length, 0, 'no remote, or the user sets the key too: nothing to refuse');
});

/** A smart-HTTP git server for `root` on 127.0.0.1 (git http-backend as CGI), and a proxy that only logs what reaches it. */
async function servers(root: string) {
  const backend = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const cgi = spawn('git', ['http-backend'], {
      env: { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: u.pathname, QUERY_STRING: u.search.slice(1), REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers['content-type'] ?? '', REMOTE_ADDR: '127.0.0.1' },
    });
    req.pipe(cgi.stdin);
    const out: Buffer[] = [];
    cgi.stdout.on('data', (d: Buffer) => out.push(d));
    cgi.on('close', () => {
      const all = Buffer.concat(out);
      const end = all.indexOf('\r\n\r\n');
      const head = all.subarray(0, end).toString('latin1').split('\r\n');
      let status = 200;
      for (const h of head) {
        const [k, ...v] = h.split(':');
        if (/^status$/i.test(k)) status = parseInt(v.join(':'), 10);
        else res.setHeader(k, v.join(':').trim());
      }
      res.statusCode = status;
      res.end(all.subarray(end + 4));
    });
  });
  const hits: string[] = [];
  const proxy = net.createServer((sock) => {
    sock.once('data', (b) => {
      hits.push(b.toString('latin1').split('\r\n')[0]);
      sock.end('HTTP/1.1 502 no\r\nContent-Length: 0\r\n\r\n');
    });
    sock.on('error', () => {});
  });
  const listen = (s: net.Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as net.AddressInfo).port)));
  return { backend: await listen(backend), proxy: await listen(proxy), hits, close: () => (backend.close(), proxy.close()) };
}

test('w6100: a repository-set proxy is followed by plain git and never by the fenced fetch, which still works', { skip: !hasGit }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'safegithttp-'));
  const s = await servers(root);
  try {
    const git = (cwd: string, ...a: string[]) => {
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@users.noreply.github.com', ...a], { cwd, encoding: 'utf8' });
      assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
      return r.stdout;
    };
    const served = path.join(root, 'served.git');
    git(root, 'init', '-q', '--bare', served);
    const src = path.join(root, 'src');
    git(root, 'init', '-q', '-b', 'main', src);
    fs.writeFileSync(path.join(src, 'a.txt'), 'one\n');
    git(src, 'add', '.');
    git(src, 'commit', '-qm', 'init');
    git(src, 'push', '-q', slash(served), 'main');

    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) delete env[k];
    const url = `http://127.0.0.1:${s.backend}/served.git`;
    const planted = `http://127.0.0.1:${s.proxy}`;
    for (const key of ['http.proxy', `http.${url}.proxy`, 'remote.origin.proxy']) {
      const work = path.join(root, `work-${key.length}`);
      git(root, 'init', '-q', work);
      git(work, 'remote', 'add', 'origin', url);
      git(work, 'config', key, planted);

      // Control: plain git sends the fetch to the planted proxy (async, so the proxy in this process can answer).
      s.hits.length = 0;
      const plain = await new Promise<number>((r) => execFile('git', ['-C', work, 'fetch', '-q', 'origin'], { env }, (e) => r(e ? 1 : 0)));
      assert.equal(plain, 1, `${key}: the proxy refuses, so plain git's fetch fails`);
      assert.match(s.hits.join('\n'), /served\.git/, `${key}: plain git went through the planted proxy`);

      s.hits.length = 0;
      const fenced = await run('git', ['-C', work, 'fetch', '-q', 'origin'], { env, timeoutMs: 60_000 });
      assert.equal(fenced.code, 0, `${key}: ${fenced.stderr}`);
      assert.deepEqual(s.hits, [], `${key}: the fenced fetch never touched the planted proxy`);
      assert.equal(git(work, 'rev-parse', 'refs/remotes/origin/main').trim(), git(src, 'rev-parse', 'HEAD').trim(), `${key}: and fetched`);
    }
  } finally {
    s.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
