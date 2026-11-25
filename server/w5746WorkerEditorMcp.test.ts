import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpScopes, mcpPlaces, mcpStatusDir, workerEditorStatusDir } from '../machine/unityMcp.ts';
import { editorStatusEnv } from '../machine/unitySlots.ts';
import { seatbeltProfile } from './workerFence.ts';
import { openChildren } from '../machine/lowIntegrity.ts';

/**
 * w5746: an editor a fenced sandbox worker starts itself (a -batchmode `unity-slot run`) inherited the worker's
 * UNITY_MCP_STATUS_DIR, its place's synced folder in the daemon's folder, which the fences keep read-only, so its bridge
 * heartbeat wrote nothing and the worker's Unity MCP server found no editor (measured on m5, w5693). Now unity-slot gives
 * it a folder the worker may write, and the daemon copies its status into the place's folder by the pid in the project's
 * Library/EditorInstance.json.
 */

const tmpdir = (t: { after: (fn: () => void) => void }, name: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ff-w5746-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
};

test('w5746: the status folder of a worker-started editor is one every worker fence lets it write', () => {
  assert.equal(workerEditorStatusDir('/Users/u/ffw', 'darwin', '/Users/u'), path.join('/Users/u', '.unity-mcp'), 'macOS: ~/.unity-mcp, the daemon\'s own editors\' folder');
  assert.equal(workerEditorStatusDir('/home/u/ffw', 'linux', '/home/u'), path.join('/home/u/ffw', 'home', '.unity-mcp'), 'Linux: inside the root (Landlock does not open ~/.unity-mcp)');
  assert.equal(workerEditorStatusDir('D:\\ffw', 'win32', 'C:\\Users\\u'), path.join('D:\\ffw', 'home', '.unity-mcp'), 'Windows: inside the root (a Low worker cannot write ~/.unity-mcp)');
  // The root child `home` is open to workers on every fence (Landlock and Seatbelt take openChildren; Windows Low labels it).
  assert.ok(openChildren('/r').includes('home'));
  // The Seatbelt profile allows ~/.unity-mcp and the root's `home`, and its read-only deny covers neither.
  const profile = seatbeltProfile({ kind: 'seatbelt', root: '/r', home: '/Users/u', darwinTemp: '/t', darwinCache: '/c', readOff: true });
  assert.match(profile, /\(subpath "\/Users\/u\/\.unity-mcp"\)/);
  assert.match(profile, /\(subpath "\/r\/home"\)/);
  const deny = profile.slice(profile.lastIndexOf('(deny file-write*'));
  assert.doesNotMatch(deny, /unity-mcp|"\/r\/home"/);
});

test('w5746: unity-slot run gives the editor it starts the writable folder as its UNITY_MCP_STATUS_DIR', (t) => {
  const dir = tmpdir(t, 'env');
  const editors = path.join(dir, 'home', '.unity-mcp');
  const synced = path.join(dir, 'daemon', 'unity-mcp', 'slot2');
  const env = editorStatusEnv({ UNITY_MCP_STATUS_DIR: synced, FF_UNITY_MCP_EDITOR_STATUS_DIR: editors, KEEP: '1' });
  assert.equal(env.UNITY_MCP_STATUS_DIR, editors);
  assert.equal(env.KEEP, '1');
  assert.ok(fs.existsSync(editors), 'made, so the first heartbeat has a folder');
  const old = { UNITY_MCP_STATUS_DIR: synced };
  assert.equal(editorStatusEnv(old), old, 'an older daemon (no FF_UNITY_MCP_EDITOR_STATUS_DIR): unchanged');
});

test("w5746: a sandbox with no daemon editor follows the editor a worker started there, by its EditorInstance.json pid", (t) => {
  const dir = tmpdir(t, 'scopes');
  const editors = path.join(dir, 'home', '.unity-mcp');
  const app = path.join(dir, 'app');
  fs.mkdirSync(editors, { recursive: true });
  const project = path.join(dir, 'sandboxes', 'slot2');
  const T = Date.now();
  const status = (port: number, mtime: number) => {
    const f = path.join(editors, 'unity-mcp-status-abcd.json');
    fs.writeFileSync(f, JSON.stringify({ unity_port: port, project_path: `${project}/Assets` }));
    fs.utimesSync(f, mtime / 1000, mtime / 1000);
  };
  const live = new Set<number>();
  const alive = (pid?: number) => (pid && live.has(pid) ? pid : undefined);
  let instance: number | undefined;
  const places = (daemonPid?: number) => mcpPlaces([{ id: 'slot2', path: project, unity: { pid: daemonPid } }], alive, () => instance);
  const port = () => JSON.parse(fs.readFileSync(path.join(mcpStatusDir(app, 'slot2'), 'unity-mcp-port.json'), 'utf8')).unity_port;
  const scopes = new McpScopes(editors);

  // Nothing runs: no editor, port 0.
  scopes.sync(app, places(), T);
  assert.equal(port(), 0);
  // The daemon's own editor wins while it runs.
  live.add(10);
  instance = 10;
  assert.deepEqual(places(10), [{ place: 'slot2', project, pid: 10 }]);
  // A dead daemon editor and a stale EditorInstance.json: none.
  live.delete(10);
  assert.deepEqual(places(10), [{ place: 'slot2', project, pid: undefined }]);
  // A batch editor the worker started (pid 20, seen first now) boots, then its bridge writes: copied.
  live.add(20);
  instance = 20;
  scopes.sync(app, places(10), T + 5_000);
  status(6402, T + 60_000);
  scopes.sync(app, places(10), T + 65_000);
  assert.equal(port(), 6402);
  assert.ok(fs.existsSync(path.join(mcpStatusDir(app, 'slot2'), 'unity-mcp-status-abcd.json')));
  // It exits: its file goes from the place's folder.
  live.delete(20);
  scopes.sync(app, places(), T + 70_000);
  assert.equal(port(), 0);
  assert.equal(fs.existsSync(path.join(mcpStatusDir(app, 'slot2'), 'unity-mcp-status-abcd.json')), false);
  // A later editor whose pid is first seen after that file was written does not take the dead one's port.
  live.add(30);
  instance = 30;
  scopes.sync(app, places(), T + 200_000);
  assert.equal(port(), 0, 'the stale file predates the new pid');
});
