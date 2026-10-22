import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * w1742 (lothsahn: "now we're making random folders under the temp directory and nodejs is triggering the windows
 * firewall"): Windows asks once for every new program path that listens on an address other than loopback, and a
 * worker's node is often a fresh copy, so one such listen in a test covered an unattended machine's screen with an
 * "allow access" prompt (lothdesktop, 2026-10-20: server/testPorts.ts bound 0.0.0.0 41 times in one `npm test`). Every
 * server the tests, the e2e harness, the scripts and the daemon start listens on 127.0.0.1 (or a named pipe), and only
 * the portal itself listens where its config says (server/index.ts, `cfg.host`).
 */

const ROOT = path.join(import.meta.dirname, '..');

function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|mjs|cjs|js)$/.test(e.name) && p !== import.meta.filename) out.push(p);
    }
  };
  for (const d of ['server', 'scripts', 'e2e', 'machine', path.join('web', 'mock'), path.join('web', 'perf')]) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
  return out;
}

/** The listens in `text` that name no loopback host, no pipe path and no configured host, as "file:line". */
export function wideListens(file: string, text: string): string[] {
  const bad: string[] = [];
  const at = (i: number) => `${file}:${text.slice(0, i).split('\n').length}`;
  // .listen(<args>): the first 200 characters of the call.
  for (const m of text.matchAll(/\.listen\(([^\n]{0,200})/g)) {
    const args = m[1].split(/=>|\bfunction\b/)[0]; // not the callback: its text may say "localhost"
    if (/^\s*\)/.test(args)) continue; // listen(): a voice or event API, not a socket (a socket's would need a port)
    if (/127\.0\.0\.1|localhost|::1|\bpath\b|\bcfg\.host\b/i.test(args)) continue;
    bad.push(at(m.index));
  }
  // new WebSocketServer({ port }) listens by itself, on every address unless it names a host.
  for (const m of text.matchAll(/new WebSocketServer\(\{([^}]{0,300})\}/g)) {
    if (/\bnoServer\s*:\s*true|\bserver\s*:|\bhost\s*:\s*['"](127\.0\.0\.1|localhost|::1)/.test(m[1])) continue;
    bad.push(at(m.index));
  }
  // dgram sockets: bind(port) alone binds every address.
  for (const m of text.matchAll(/\.bind\((\d+|[a-zA-Z_]\w*)\s*(,\s*\(|\))/g)) {
    if (!/createSocket\(/.test(text)) continue;
    bad.push(at(m.index));
  }
  return bad;
}

test('the census finds a listen on every address and passes the loopback ones (w1742)', () => {
  assert.deepEqual(wideListens('a.ts', "s.listen(0, '0.0.0.0', r);\ns.listen(port, () => {});\ns.listen(0, r);\ns.listen(port, host, () => {});\ns.listen(PORT, () => log(`on http://localhost:${PORT}`));"), ['a.ts:1', 'a.ts:2', 'a.ts:3', 'a.ts:4', 'a.ts:5']);
  assert.deepEqual(wideListens('b.ts', "s.listen(0, '127.0.0.1', r);\ns.listen({ path: p }, r);\nserver.listen(cfg.port, cfg.host, () => {});\nthis.listen();"), []);
  assert.deepEqual(wideListens('c.ts', "new WebSocketServer({ port: 0 });\nnew WebSocketServer({ noServer: true });\nnew WebSocketServer({ host: '127.0.0.1', port: 0 });"), ['c.ts:1']);
  assert.deepEqual(wideListens('d.ts', "const u = dgram.createSocket('udp4');\nu.bind(port, () => {});\nu.bind({ port, address: '127.0.0.1' });"), ['d.ts:2']);
});

test('every server the tests, scripts and daemon start listens on loopback, so no node path ever raises a Windows Firewall prompt (w1742)', () => {
  const bad = sources().flatMap((f) => wideListens(path.relative(ROOT, f).replace(/\\/g, '/'), fs.readFileSync(f, 'utf8')));
  assert.deepEqual(bad, [], "listen on '127.0.0.1' (or a pipe path): a listen on every address prompts on Windows for each new node path (w1742)");
});
