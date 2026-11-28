/**
 * w6675: the three notes from 7c34d8f7's lockout review of PR #1537 (w6639) on the Unity MCP status folders the daemon
 * writes off the loop: a failed rename leaves no temporary file, a sandbox deleted while a pass waits on the disk does
 * not get its folder back from that pass, and a refresh that never finishes no longer stops every later one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readStatusFiles, syncStatusDirAsync } from './unityMcp.ts';
import { McpScopes, mcpStatusDir } from '../machine/unityMcp.ts';
import { Daemon, MCP_REFRESH_HUNG_MS } from '../machine/daemon.ts';

const tmp = (t: { after: (f: () => void) => void }, name: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `w6675-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  return dir;
};

/** A status home with one editor's file for D:\work\ffsb\sb1. */
function statusHome(t: { after: (f: () => void) => void }) {
  const home = tmp(t, 'home');
  fs.writeFileSync(path.join(home, 'unity-mcp-status-aaa.json'), JSON.stringify({ project_path: 'D:\\work\\ffsb\\sb1', unity_port: 6401 }));
  return { home, files: readStatusFiles(home) };
}

test('w6675: a write whose rename fails removes its temporary file, and the failure still reaches the caller', async (t) => {
  const { files } = statusHome(t);
  const dir = tmp(t, 'renamefail');
  const rename = fs.promises.rename;
  fs.promises.rename = (async () => {
    throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
  }) as typeof fs.promises.rename;
  t.after(() => void (fs.promises.rename = rename));
  await assert.rejects(syncStatusDirAsync(dir, 'D:\\work\\ffsb\\sb1', { since: 0 }, files), /EPERM/);
  fs.promises.rename = rename;
  assert.deepEqual(
    fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')),
    [],
    'a uniquely named temporary file is left behind that nothing would ever remove',
  );
});

test("w6675: a sandbox deleted while a pass waits on the disk does not get its status folder back from that pass", async (t) => {
  const { home, files } = statusHome(t);
  const app = tmp(t, 'app');
  const scopes = new McpScopes(home);
  const sb1 = { place: 'sb1', project: 'D:\\work\\ffsb\\sb1', pid: process.pid };
  // A first look makes its folders.
  await scopes.syncAsync(app, [sb1], Date.now(), () => undefined, files);
  const dir = mcpStatusDir(app, 'sb1');
  assert.ok(fs.existsSync(dir));

  // The next pass is held on the disk making sb1's folder, its plan made while sb1 still existed.
  const mkdir = fs.promises.mkdir;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held = 0;
  fs.promises.mkdir = (async (...a: Parameters<typeof mkdir>) => {
    if (path.resolve(String(a[0])) === path.resolve(dir) && held++ === 0) await gate;
    return mkdir(...a);
  }) as typeof mkdir;
  t.after(() => void (fs.promises.mkdir = mkdir));
  const sb1Changed = { ...sb1, pid: process.pid + 1 };
  const slow = scopes.syncAsync(app, [sb1Changed], Date.now(), () => undefined, files);
  // Meanwhile sb1 is deleted: a later look removes its folder.
  await scopes.syncAsync(app, [], Date.now(), () => undefined, files);
  assert.equal(fs.existsSync(dir), false, 'the later look removed the deleted sandbox folder');
  release();
  await slow;
  fs.promises.mkdir = mkdir;
  assert.equal(held, 1, 'the pass was held making the folder');
  assert.equal(fs.existsSync(dir), false, "the pass planned before the delete made the deleted sandbox's status folder again");
});

test('w6675: a pass that is no longer current writes nothing', async (t) => {
  const { home, files } = statusHome(t);
  const app = tmp(t, 'stale');
  await new McpScopes(home).syncAsync(app, [{ place: 'sb1', project: 'D:\\work\\ffsb\\sb1', pid: process.pid }], Date.now(), () => undefined, files, () => false);
  assert.equal(fs.existsSync(mcpStatusDir(app, 'sb1')), false);
});

type Pass = { current: () => boolean; finish: () => void };

/** refreshMcpScopes on a stand-in daemon whose one pass (refreshMcpScopesOnce) waits until the test finishes it. */
function refresher() {
  const passes: Pass[] = [];
  const self = {
    mcpPass: undefined as unknown,
    refreshMcpScopesOnce(current: () => boolean) {
      return new Promise<void>((finish) => passes.push({ current, finish }));
    },
  };
  const refresh = (now: number) => (Daemon.prototype as unknown as { refreshMcpScopes: (this: unknown, now: number) => Promise<void> }).refreshMcpScopes.call(self, now);
  return { self, passes, refresh };
}

test('w6675: a status refresh that never finishes stops later ones only until MCP_REFRESH_HUNG_MS; a late finish does not undo the newer pass', async () => {
  const { self, passes, refresh } = refresher();
  void refresh(0);
  assert.equal(passes.length, 1);
  // One at a time, as w6639 made it: a 5 s tick while the first runs starts nothing.
  void refresh(5_000);
  assert.equal(passes.length, 1);
  void refresh(MCP_REFRESH_HUNG_MS - 1);
  assert.equal(passes.length, 1);
  // Hung: a new pass starts, and the old one is no longer current (it writes nothing more).
  const second = refresh(MCP_REFRESH_HUNG_MS);
  assert.equal(passes.length, 2, 'a refresh that never finishes stops every later one');
  assert.equal(passes[0].current(), false);
  assert.equal(passes[1].current(), true);
  // The old pass finishes late: the new one is still the current pass, and a tick now starts nothing.
  passes[0].finish();
  await new Promise((r) => setImmediate(r));
  assert.ok(self.mcpPass, 'the late finish cleared the newer pass');
  assert.equal(passes[1].current(), true);
  void refresh(MCP_REFRESH_HUNG_MS + 5_000);
  assert.equal(passes.length, 2);
  // The new pass finishes: the next tick starts at once.
  passes[1].finish();
  await second;
  assert.equal(self.mcpPass, undefined);
  void refresh(MCP_REFRESH_HUNG_MS + 10_000);
  assert.equal(passes.length, 3);
  passes[2].finish();
});
