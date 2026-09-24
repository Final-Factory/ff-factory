import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { bridgeInfo, bridgePing, crashLeftoversFor, crashReportersFor, editorVerdict, restartAllowed, type EditorObservation } from './unityHang.ts';

const NOW = Date.parse('2026-09-24T16:00:00Z');
const min = 60_000;
const base: EditorObservation = { alive: true, phase: 'running', logGrewAt: NOW - 5_000 };

test('unity verdict: crashes', () => {
  assert.deepEqual(editorVerdict({ ...base, alive: false }, NOW), { kind: 'crashed', why: 'the editor process is gone' });
  assert.deepEqual(editorVerdict({ ...base, alive: false, expectedExit: true }, NOW), { kind: 'ok' });
  assert.equal(editorVerdict({ ...base, crashReporter: true }, NOW).kind, 'crashed');
});

test('unity verdict: a long import or compile is never a hang; a silent, unresponsive editor is', () => {
  // Busy: the window is "not responding" and the bridge silent, but the log keeps growing.
  assert.equal(editorVerdict({ ...base, notRespondingSince: NOW - 20 * min, bridgeFailingSince: NOW - 20 * min, logGrewAt: NOW - 30_000 }, NOW).kind, 'ok');
  // Frozen: not responding for 3 min and nothing logged.
  const v = editorVerdict({ ...base, notRespondingSince: NOW - 4 * min, logGrewAt: NOW - 4 * min }, NOW);
  assert.equal(v.kind, 'hung');
  assert.match(v.kind === 'hung' ? v.why : '', /not responding for 4 min/);
  assert.equal(editorVerdict({ ...base, notRespondingSince: NOW - 2 * min, logGrewAt: NOW - 4 * min }, NOW).kind, 'ok', 'not long enough');
  // The bridge silent 10 min with a silent log: hung; while reloading it gets 45 min.
  assert.equal(editorVerdict({ ...base, bridgeFailingSince: NOW - 11 * min, logGrewAt: NOW - 11 * min }, NOW).kind, 'hung');
  assert.equal(editorVerdict({ ...base, bridgeFailingSince: NOW - 11 * min, logGrewAt: NOW - 11 * min, reloading: true }, NOW).kind, 'ok');
  assert.equal(editorVerdict({ ...base, bridgeFailingSince: NOW - 50 * min, logGrewAt: NOW - 11 * min, reloading: true }, NOW).kind, 'hung');
  // A dialog is the dialog watchdog's business.
  assert.equal(editorVerdict({ ...base, dialog: true, notRespondingSince: NOW - 30 * min, logGrewAt: NOW - 30 * min }, NOW).kind, 'ok');
  // Starting: only a stalled log counts.
  assert.equal(editorVerdict({ ...base, phase: 'starting', logGrewAt: NOW - 16 * min }, NOW).kind, 'hung');
  assert.equal(editorVerdict({ ...base, phase: 'starting', bridgeFailingSince: NOW - 30 * min, logGrewAt: NOW - min }, NOW).kind, 'ok');
});

test('unity auto-restart budget: 3 in 30 minutes', () => {
  const at = (m: number) => new Date(NOW - m * min).toISOString();
  assert.ok(restartAllowed([{ at: at(5) }, { at: at(10) }], NOW, 3, 30));
  assert.ok(!restartAllowed([{ at: at(5) }, { at: at(10) }, { at: at(20) }], NOW, 3, 30));
  assert.ok(restartAllowed([{ at: at(5) }, { at: at(10) }, { at: at(40) }], NOW, 3, 30));
  assert.ok(restartAllowed([{ at: at(5) }, { at: at(6), auto: false }, { at: at(7), auto: false }], NOW, 3, 30), 'restarts asked for by hand do not count');
});

test('unity bridge: status files by project, and a ping answered on the main thread', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unity-mcp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A fake bridge speaking the MCP-for-Unity framing.
  const got: string[] = [];
  const server = net.createServer((s) => {
    s.write('WELCOME UNITY-MCP 1 FRAMING=1\n');
    let buf = Buffer.alloc(0);
    s.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 8) return;
      const len = Number(buf.readBigUInt64BE(0));
      if (buf.length < 8 + len) return;
      got.push(buf.subarray(8, 8 + len).toString());
      const reply = Buffer.from('{"status":"success","result":{"message":"pong"}}');
      const h = Buffer.alloc(8);
      h.writeBigUInt64BE(BigInt(reply.length));
      s.write(Buffer.concat([h, reply]));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = (server.address() as net.AddressInfo).port;
  fs.writeFileSync(path.join(dir, 'unity-mcp-status-abc.json'), JSON.stringify({ unity_port: port, reloading: true, project_path: 'F:/ffsb/sb1/Assets' }));
  fs.writeFileSync(path.join(dir, 'unity-mcp-port-abc.json'), JSON.stringify({ unity_port: port, project_path: 'F:/ffsb/sb1/Assets' }));
  fs.writeFileSync(path.join(dir, 'unity-mcp-status-zzz.json'), JSON.stringify({ unity_port: 1, reloading: false, project_path: 'F:/ffsb/other/Assets' }));
  assert.deepEqual(bridgeInfo('F:\\ffsb\\sb1', dir), { port, reloading: true });
  assert.deepEqual(bridgeInfo('F:/ffsb/none', dir), {});
  assert.equal(await bridgePing(port, 3000), true);
  assert.deepEqual(JSON.parse(got[0]), { type: 'ping', params: {} }, 'a queued JSON ping, answered on the main thread');
  // Nothing listening: false, quickly.
  const dead = net.createServer();
  await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
  const deadPort = (dead.address() as net.AddressInfo).port;
  dead.close();
  assert.equal(await bridgePing(deadPort, 3000), false);
});

test('unity crash evidence: the bug reporter counts; the crash handler beside every editor does not', () => {
  const procs = [
    { pid: 1, name: 'UnityCrashHandler64.exe', cmd: '"C:/Program Files/Unity/Editor/UnityCrashHandler64.exe" --attach 500 "F:/ffsb/sb1"' },
    { pid: 2, name: 'UnityCrashHandler64.exe', cmd: '"C:/Program Files/Unity/Editor/UnityCrashHandler64.exe" --attach 700' },
    { pid: 3, name: 'UnityBugReporter.exe', cmd: 'UnityBugReporter.exe --unity_project "F:/ffsb/sb1" --editor_mode' },
    { pid: 4, name: 'UnityBugReporter.exe', cmd: 'UnityBugReporter.exe --unity_project "F:/ffsb/other"' },
  ];
  assert.deepEqual(crashReportersFor(procs, 'F:/ffsb/sb1').map((p) => p.pid), [3]);
  assert.deepEqual(crashReportersFor(procs.slice(0, 2), 'F:/ffsb/sb1'), []);
  assert.deepEqual(crashLeftoversFor(procs, 'F:/ffsb/sb1', 700).map((p) => p.pid), [1, 2, 3]);
  assert.deepEqual(crashLeftoversFor(procs, 'F:/ffsb/sb1').map((p) => p.pid), [1, 3]);
});
