import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readStatusFiles, syncStatusDir } from './unityMcp.ts';

/**
 * Where MCP-for-Unity 10 (stdio) connects when its pinned editor is not in `dir`'s status files: the newest
 * status file, else the port files (the legacy one last), else 6400 (port_discovery.discover_unity_port).
 * Liveness probes are left out: the editor being looked for is down, so they do not change the pick.
 */
function upstreamFallbackPort(dir: string): number {
  const files = (re: RegExp) =>
    fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((n) => re.test(n))
          .map((n) => path.join(dir, n))
          .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
      : [];
  const port = (f: string) => (JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')) as { unity_port?: number }).unity_port;
  const status = files(/^unity-mcp-status-.*\.json$/)[0];
  if (status) return port(status)!;
  for (const f of [...files(/^unity-mcp-port-.*\.json$/), ...files(/^unity-mcp-port\.json$/)]) {
    const p = port(f);
    if (typeof p === 'number') return p;
  }
  return 6400;
}

test("unity MCP: a sandbox's workers only ever find, or fall back to, their own editor", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-unitymcp-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home', '.unity-mcp');
  fs.mkdirSync(home, { recursive: true });
  const status = (hash: string, project: string, port: number, mtime: number) => {
    const f = path.join(home, `unity-mcp-status-${hash}.json`);
    // b's editor writes a byte order mark, as some do.
    fs.writeFileSync(f, (hash.startsWith('b') ? '\uFEFF' : '') + JSON.stringify({ unity_port: port, project_path: `${project}/Assets`, reloading: false }));
    fs.utimesSync(f, mtime / 1000, mtime / 1000);
  };
  const now = Date.now();
  // The live game on 6400, sandbox b on 6402; sandbox a (6401) is restarting, its status file gone.
  status('aaaa0000', 'C:/Games/FinalFactory', 6400, now - 1000);
  status('bbbb1111', 'F:/ffsb/b', 6402, now);
  // Before: every worker's server looked in ~/.unity-mcp, so a's pinned calls fell back to b's editor.
  assert.equal(upstreamFallbackPort(home), 6402);

  // Each sandbox's workers get a status folder of their own (a machine daemon's, machine/unityMcp.ts).
  const dirA = path.join(tmp, 'data', 'unity-mcp', 'a');
  const dirB = path.join(tmp, 'data', 'unity-mcp', 'b');
  const sync = (sinceA?: number) => {
    const files = readStatusFiles(home);
    syncStatusDir(dirA, 'F:\\ffsb\\a', sinceA === undefined ? undefined : { since: sinceA }, files);
    syncStatusDir(dirB, 'F:/ffsb/b', { since: now - 60_000 }, files);
  };
  sync(now - 5000);
  assert.deepEqual(fs.readdirSync(dirB).sort(), ['unity-mcp-port.json', 'unity-mcp-status-bbbb1111.json']);
  assert.deepEqual(fs.readdirSync(dirA), ['unity-mcp-port.json']);
  assert.equal(upstreamFallbackPort(dirA), 0, 'a never reaches another editor while its own is down');
  assert.equal(upstreamFallbackPort(dirB), 6402);

  // a is up again: its own status file, and the fallback points at its own port.
  status('cccc2222', 'F:/ffsb/a', 6401, now);
  sync(now - 5000);
  assert.deepEqual(fs.readdirSync(dirA).sort(), ['unity-mcp-port.json', 'unity-mcp-status-cccc2222.json']);
  assert.equal(upstreamFallbackPort(dirA), 6401);

  // A status file older than the running editor's launch is a crashed editor's leftover: not mirrored.
  sync(now + 60_000);
  assert.deepEqual(fs.readdirSync(dirA), ['unity-mcp-port.json']);
  assert.equal(upstreamFallbackPort(dirA), 0);
  // Stopped: nothing to find.
  sync(undefined);
  assert.equal(upstreamFallbackPort(dirA), 0);
});
