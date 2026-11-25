import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MacUnity, fencedEditorBin, type EditorFence, type Proc, type UnityDeps } from '../machine/unity.ts';
import { bridgeInfo, bridgeUpSince } from './unityHang.ts';
import { readStatusFiles } from './unityMcp.ts';

const REPO = String.raw`V:\ffw\sandboxes\slot1`;
const BIN = String.raw`C:\Program Files\Unity\Hub\Editor\6000.3.19f1\Editor\Unity.exe`;
const FENCE: EditorFence = { launcher: String.raw`V:\ffw\tools\low\node.exe`, unityDir: String.raw`V:\ffw\tools\unity-low`, licensingIpc: 'LicenseClient-u-low', env: { APPDATA: String.raw`V:\ffw\home\AppData\Roaming`, UNITY_MCP_STATUS_DIR: String.raw`V:\ffw\home\.unity-mcp` } };
const JUNCTION_BIN = String.raw`V:\ffw\tools\unity-low\6000.3.19f1\Unity.exe`;

test('w5540: the fenced editor binary is the junction\'s for the install\'s version, else none', () => {
  const has = (p: string) => p === JUNCTION_BIN;
  assert.equal(fencedEditorBin(BIN, FENCE.unityDir, has), JUNCTION_BIN);
  assert.equal(fencedEditorBin(BIN.replace('6000.3.19f1', '6000.4.0f1'), FENCE.unityDir, has), undefined, 'no junction for that version');
  assert.equal(fencedEditorBin(String.raw`D:\odd\Unity.exe`, FENCE.unityDir, () => true), undefined, 'not <version>/Editor/Unity.exe');
});

function fakeWin(junction: boolean, fenced: boolean) {
  const world = { procs: [] as Proc[], plain: [] as string[][], low: [] as { bin: string; args: string[] }[], now: 0 };
  const launchAt = (bin: string, args: string[]) => {
    const pid = 7000 + world.procs.length;
    world.procs.push({ pid, ppid: 1, cmd: `"${bin}" ${args.join(' ')}` });
    return pid;
  };
  const deps: UnityDeps = {
    procs: async () => [...world.procs],
    kill: () => undefined,
    launch: (bin, args) => (world.plain.push([bin, ...args]), launchAt(bin, args)),
    ...(fenced ? { launchFenced: async (f: EditorFence, bin: string, args: string[]) => (world.low.push({ bin, args }), launchAt(bin, args)) } : {}),
    exists: (p) => junction && p === JUNCTION_BIN,
    remove: () => undefined,
    sleep: async (ms) => void (world.now += ms),
    now: () => world.now,
  };
  return { world, u: new MacUnity(REPO, deps, () => BIN, 'win32', {}, { fence: () => FENCE }) };
}

test('w5540: a Windows sandbox editor starts at Low through the junction with the Low licensing channel; without a junction it starts unfenced and says why', async () => {
  const a = fakeWin(true, true);
  const said = await a.u.start();
  assert.equal(a.world.plain.length, 0, 'never the unfenced launch');
  assert.equal(a.world.low[0].bin, JUNCTION_BIN);
  assert.deepEqual(a.world.low[0].args.slice(-2), ['-licensingIpc', 'LicenseClient-u-low']);
  assert.match(said, /at Low integrity/);
  assert.deepEqual(a.u.fenced, { on: true });

  const b = fakeWin(false, true);
  const saidB = await b.u.start();
  assert.equal(b.world.low.length, 0);
  assert.equal(b.world.plain[0][0], BIN, 'the install\'s own path, Medium as before');
  assert.ok(!b.world.plain[0].includes('-licensingIpc'));
  assert.match(saidB, /unfenced \(no junction/);
});

test('w5540: the daemon reads bridge status from every status folder; the newest file for a project answers', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w5540-'));
  try {
    const home = path.join(tmp, 'home');
    const low = path.join(tmp, 'low');
    for (const d of [home, low]) fs.mkdirSync(d);
    const put = (dir: string, port: number, ageMs: number) => {
      const f = path.join(dir, 'unity-mcp-status-abc.json');
      fs.writeFileSync(f, JSON.stringify({ unity_port: port, reloading: false, project_path: 'V:/ffw/sandboxes/slot1/Assets' }));
      const t = (Date.now() - ageMs) / 1000;
      fs.utimesSync(f, t, t);
    };
    put(home, 6401, 60_000); // left by the editor before, at Medium
    put(low, 6402, 1000); // the fenced editor's
    assert.deepEqual(bridgeInfo(REPO, [home, low]), { port: 6402, reloading: false });
    assert.deepEqual(bridgeInfo(REPO, [low, home]), { port: 6402, reloading: false }, 'order does not matter');
    assert.equal(bridgeUpSince(REPO, Date.now() - 10_000, [home, low]), true, 'the fresh file in the fence\'s folder counts');
    assert.equal(bridgeUpSince(REPO, Date.now() - 10_000, [home]), false);
    assert.equal(readStatusFiles([home, low]).length, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
