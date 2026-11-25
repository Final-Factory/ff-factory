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
  const places = (daemonPid?: number) => mcpPlaces([{ id: 'slot2', path: project, unity: { pid: daemonPid } }], alive, () => instance, [...live].map((pid) => ({ pid, project })));
  const port = () => JSON.parse(fs.readFileSync(path.join(mcpStatusDir(app, 'slot2'), 'unity-mcp-port.json'), 'utf8')).unity_port;
  const scopes = new McpScopes(editors);

  // Nothing runs: no editor, port 0.
  scopes.sync(app, places(), T);
  assert.equal(port(), 0);
  // The daemon's own editor wins while it runs.
  live.add(10);
  instance = 10;
  assert.deepEqual(places(10), [{ place: 'slot2', project, pid: 10 }]);
  assert.deepEqual(places(), [{ place: 'slot2', project, pid: 10, fromInstance: true }]);
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

test("w5746: at the daemon's first look, a crashed editor's old status file is not copied for a reused EditorInstance.json pid", (t) => {
  // Independent review w5753 (PR #1246, check 3): a fresh McpScopes (the daemon just started or updated) took a status
  // file of any age, so a 24 h old file of a crashed editor whose EditorInstance.json pid now belongs to another live
  // process copied the dead editor's port 6402, which another sandbox's editor may hold now.
  const dir = tmpdir(t, 'first');
  const editors = path.join(dir, 'home', '.unity-mcp');
  const app = path.join(dir, 'app');
  fs.mkdirSync(editors, { recursive: true });
  const project = path.join(dir, 'sandboxes', 'slot2');
  const T = Date.now();
  const f = path.join(editors, 'unity-mcp-status-dead.json');
  const status = (port: number, mtime: number) => {
    fs.writeFileSync(f, JSON.stringify({ unity_port: port, project_path: `${project}/Assets` }));
    fs.utimesSync(f, mtime / 1000, mtime / 1000);
  };
  status(6402, T - 24 * 3600_000);
  const places = mcpPlaces([{ id: 'slot2', path: project, unity: {} }], (pid) => pid, () => 4242, [{ pid: 4242, project }]);
  const port = () => JSON.parse(fs.readFileSync(path.join(mcpStatusDir(app, 'slot2'), 'unity-mcp-port.json'), 'utf8')).unity_port;
  const scopes = new McpScopes(editors);
  scopes.sync(app, places, T);
  assert.equal(port(), 0, "the dead editor's port is not copied");
  assert.equal(fs.existsSync(path.join(mcpStatusDir(app, 'slot2'), 'unity-mcp-status-dead.json')), false);
  scopes.sync(app, places, T + 5_000);
  assert.equal(port(), 0, 'nor at the next look, while nothing writes it');
  // A live batch editor of that pid writes its heartbeat (every 0.5 s): taken at the next look.
  status(6405, T + 6_000);
  scopes.sync(app, places, T + 10_000);
  assert.equal(port(), 6405);
});

test("w5746: at the daemon's first look, the daemon's own running editor keeps its status of any age", (t) => {
  const dir = tmpdir(t, 'own');
  const editors = path.join(dir, 'home', '.unity-mcp');
  const app = path.join(dir, 'app');
  fs.mkdirSync(editors, { recursive: true });
  const project = path.join(dir, 'sandboxes', 'slot2');
  const T = Date.now();
  const f = path.join(editors, 'unity-mcp-status-own.json');
  fs.writeFileSync(f, JSON.stringify({ unity_port: 6401, project_path: `${project}/Assets` }));
  fs.utimesSync(f, (T - 3600_000) / 1000, (T - 3600_000) / 1000);
  const scopes = new McpScopes(editors);
  scopes.sync(app, mcpPlaces([{ id: 'slot2', path: project, unity: { pid: 77 } }], (pid) => pid, () => undefined, []), T);
  assert.equal(JSON.parse(fs.readFileSync(path.join(mcpStatusDir(app, 'slot2'), 'unity-mcp-port.json'), 'utf8')).unity_port, 6401);
});

test('w5746: an EditorInstance.json pid counts only while it is a Unity editor of that project', (t) => {
  // Re-review w5779 (PR #1246, check 3): a worker's batch editor crashed and another process took its pid within one look;
  // "alive" alone kept the dead editor's status (port 6402) copied for as long as that process lived.
  const dir = tmpdir(t, 'reused');
  const editors = path.join(dir, 'home', '.unity-mcp');
  const app = path.join(dir, 'app');
  fs.mkdirSync(editors, { recursive: true });
  const project = path.join(dir, 'sandboxes', 'slot2');
  const other = path.join(dir, 'sandboxes', 'slot3');
  const T = Date.now();
  const f = path.join(editors, 'unity-mcp-status-dead.json');
  const status = (port: number, mtime: number) => {
    fs.writeFileSync(f, JSON.stringify({ unity_port: port, project_path: `${project}/Assets` }));
    fs.utimesSync(f, mtime / 1000, mtime / 1000);
  };
  const sbs = [{ id: 'slot2', path: project, unity: {} }];
  const port = () => JSON.parse(fs.readFileSync(path.join(mcpStatusDir(app, 'slot2'), 'unity-mcp-port.json'), 'utf8')).unity_port;
  assert.deepEqual(mcpPlaces(sbs, (pid) => pid, () => 500, undefined), [{ place: 'slot2', project, pid: undefined }], 'no process list yet: none');
  assert.deepEqual(mcpPlaces(sbs, (pid) => pid, () => 500, [{ pid: 500, project: other }]), [{ place: 'slot2', project, pid: undefined }], "another project's editor: none");
  assert.deepEqual(mcpPlaces(sbs, (pid) => pid, () => 500, [{ pid: 500, project: `${project}/` }]), [{ place: 'slot2', project, pid: 500, fromInstance: true }]);
  const scopes = new McpScopes(editors);
  // The batch editor (pid 500) runs and heartbeats: copied.
  scopes.sync(app, mcpPlaces(sbs, (pid) => pid, () => 500, [{ pid: 500, project }]), T);
  status(6402, T + 1_000);
  scopes.sync(app, mcpPlaces(sbs, (pid) => pid, () => 500, [{ pid: 500, project }]), T + 5_000);
  assert.equal(port(), 6402);
  // It crashes, and a process that is no Unity editor takes pid 500 before the next look: its port goes, and stays gone.
  scopes.sync(app, mcpPlaces(sbs, (pid) => pid, () => 500, []), T + 10_000);
  assert.equal(port(), 0);
  scopes.sync(app, mcpPlaces(sbs, (pid) => pid, () => 500, []), T + 3_600_000);
  assert.equal(port(), 0, 'an hour later too');
  assert.equal(fs.existsSync(path.join(mcpStatusDir(app, 'slot2'), 'unity-mcp-status-dead.json')), false);
});

test("w5746: at the first look, an EditorInstance.json pid's file must be newer than the look, with no 2 s allowance", (t) => {
  // Re-review w5779: the 2 s allowance let a file written 1.5 s before the daemon's first look through.
  const dir = tmpdir(t, 'slack');
  const editors = path.join(dir, 'home', '.unity-mcp');
  const app = path.join(dir, 'app');
  fs.mkdirSync(editors, { recursive: true });
  const project = path.join(dir, 'sandboxes', 'slot2');
  const T = Date.now();
  const f = path.join(editors, 'unity-mcp-status-x.json');
  fs.writeFileSync(f, JSON.stringify({ unity_port: 6402, project_path: project }));
  fs.utimesSync(f, (T - 1_500) / 1000, (T - 1_500) / 1000);
  const places = mcpPlaces([{ id: 'slot2', path: project, unity: {} }], (pid) => pid, () => 600, [{ pid: 600, project }]);
  new McpScopes(editors).sync(app, places, T);
  assert.equal(JSON.parse(fs.readFileSync(path.join(mcpStatusDir(app, 'slot2'), 'unity-mcp-port.json'), 'utf8')).unity_port, 0);
});
