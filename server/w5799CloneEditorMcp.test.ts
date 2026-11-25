import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpScopes, cloneEditors, mcpPlaces, mcpStatusDir } from '../machine/unityMcp.ts';

/**
 * w5799: a peer run's second editor is opened on a ParrelSync clone of the sandbox (`<sandbox>_clone_<n>`), no place of the
 * daemon's, so no status folder followed it and the worker's Unity MCP server could not pin it. Now a Unity process whose
 * -projectPath is exactly such a clone has its status copied into the sandbox's own folder, beside the sandbox editor's,
 * once written after the look that first saw it.
 */

const tmpdir = (t: { after: (fn: () => void) => void }, name: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ff-w5799-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
};

test('w5799: only a Unity process on exactly <sandbox>_clone_<n> is a clone editor of the sandbox', () => {
  const sb = '/r/sandboxes/slot2';
  const eds = [
    { pid: 1, project: '/r/sandboxes/slot2' },
    { pid: 2, project: '/r/sandboxes/slot2_clone_0' },
    { pid: 3, project: '/r/sandboxes/slot2_clone_1/' },
    { pid: 4, project: '/r/sandboxes/slot20_clone_0' },
    { pid: 5, project: '/r/sandboxes/slot2_clone_x' },
    { pid: 6, project: '/r/other/slot2_clone_0' },
    { pid: 7 },
  ];
  assert.deepEqual(cloneEditors(sb, eds).map((e) => e.pid), [2, 3]);
  assert.deepEqual(cloneEditors('F:\\ffw\\sandboxes\\Slot2', [{ pid: 8, project: 'f:/ffw/sandboxes/slot2_clone_0' }]).map((e) => e.pid), [8], 'Windows spellings');
  assert.deepEqual(cloneEditors(sb, undefined), [], 'no process list yet: none');
  assert.deepEqual(mcpPlaces([{ id: 'slot2', path: sb, unity: {} }], () => undefined, () => undefined, eds)[0].clones?.map((c) => c.pid), [2, 3]);
});

test("w5799: the clone editor's status sits beside the sandbox editor's, only written after it was first seen, and goes with it", (t) => {
  const dir = tmpdir(t, 'scopes');
  const editors = path.join(dir, 'home', '.unity-mcp');
  const app = path.join(dir, 'app');
  fs.mkdirSync(editors, { recursive: true });
  const project = path.join(dir, 'sandboxes', 'slot2');
  const clone = `${project}_clone_0`;
  const T = Date.now();
  const write = (name: string, proj: string, port: number, mtime: number) => {
    const f = path.join(editors, name);
    fs.writeFileSync(f, JSON.stringify({ unity_port: port, project_path: `${proj}/Assets` }));
    fs.utimesSync(f, mtime / 1000, mtime / 1000);
  };
  const folder = () => fs.readdirSync(mcpStatusDir(app, 'slot2')).filter((n) => n.startsWith('unity-mcp-status-')).sort();
  const portFile = () => JSON.parse(fs.readFileSync(path.join(mcpStatusDir(app, 'slot2'), 'unity-mcp-port.json'), 'utf8')).unity_port;
  let list: { pid: number; project?: string }[] = [];
  const places = () => mcpPlaces([{ id: 'slot2', path: project, unity: { pid: 10 } }], (pid) => pid, () => undefined, list);
  const scopes = new McpScopes(editors);

  write('unity-mcp-status-host.json', project, 6400, T - 60_000);
  // A clone editor's old file (a crashed one's, 1 s before its first look) and a live pid now on that clone: not copied.
  write('unity-mcp-status-clone.json', clone, 6401, T - 1_000);
  list = [{ pid: 10, project }, { pid: 20, project: clone }];
  scopes.sync(app, places(), T);
  assert.deepEqual(folder(), ['unity-mcp-status-host.json']);
  // Its heartbeat: copied beside the host's; the legacy port file stays the sandbox editor's.
  write('unity-mcp-status-clone.json', clone, 6401, T + 500);
  scopes.sync(app, places(), T + 5_000);
  assert.deepEqual(folder(), ['unity-mcp-status-clone.json', 'unity-mcp-status-host.json']);
  assert.equal(portFile(), 6400);
  // It exits: its file goes.
  list = [{ pid: 10, project }];
  scopes.sync(app, places(), T + 10_000);
  assert.deepEqual(folder(), ['unity-mcp-status-host.json']);
  // Its pid reused by a process that is no Unity editor: nothing comes back an hour later.
  scopes.sync(app, places(), T + 3_600_000);
  assert.deepEqual(folder(), ['unity-mcp-status-host.json']);
  // A new clone editor (pid 30): only from its own heartbeat on.
  list = [{ pid: 10, project }, { pid: 30, project: clone }];
  scopes.sync(app, places(), T + 3_700_000);
  assert.deepEqual(folder(), ['unity-mcp-status-host.json'], "the dead one's file predates pid 30");
  write('unity-mcp-status-clone.json', clone, 6403, T + 3_700_500);
  scopes.sync(app, places(), T + 3_705_000);
  assert.deepEqual(folder(), ['unity-mcp-status-clone.json', 'unity-mcp-status-host.json']);
});

test('w5799: a clone editor of another sandbox never reaches this one', (t) => {
  const dir = tmpdir(t, 'other');
  const editors = path.join(dir, 'home', '.unity-mcp');
  const app = path.join(dir, 'app');
  fs.mkdirSync(editors, { recursive: true });
  const a = path.join(dir, 'sandboxes', 'slot2');
  const b = path.join(dir, 'sandboxes', 'slot3');
  const T = Date.now();
  const list = [{ pid: 40, project: `${b}_clone_0` }];
  const places = () => mcpPlaces([{ id: 'slot2', path: a, unity: {} }, { id: 'slot3', path: b, unity: {} }], () => undefined, () => undefined, list);
  const scopes = new McpScopes(editors);
  scopes.sync(app, places(), T);
  const f = path.join(editors, 'unity-mcp-status-b.json');
  fs.writeFileSync(f, JSON.stringify({ unity_port: 6410, project_path: `${b}_clone_0` }));
  fs.utimesSync(f, (T + 500) / 1000, (T + 500) / 1000);
  scopes.sync(app, places(), T + 5_000);
  assert.deepEqual(fs.readdirSync(mcpStatusDir(app, 'slot2')).filter((n) => n.startsWith('unity-mcp-status-')), []);
  assert.deepEqual(fs.readdirSync(mcpStatusDir(app, 'slot3')).filter((n) => n.startsWith('unity-mcp-status-')), ['unity-mcp-status-b.json']);
});
