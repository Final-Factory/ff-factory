import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { labelLow, lowTargets, type Exec } from '../machine/lowIntegrity.ts';
import { agentNodeExe, agentNodePathDir } from './agentNode.ts';

/**
 * w5717, for real on Windows (listed in .github/windows-tests.txt): the agents' node at `<root>\tools\node` keeps its
 * path (the firewall rule "Final Factory agent node" names it), and a Low worker can no longer take it away. Before,
 * `tools` was Low and its FILE_DELETE_CHILD let a Low process rename `tools\node` aside and plant its own node.exe,
 * which Medium agents, BEAST's instance portals and the elevated `worker.ts tools` then ran (measured on LothDesktop
 * from a Low worker: DELETE granted on V:\ffw\tools\node). Here real icacls labels an old-layout tree the way the
 * daemon's labelLow did, this node started with a worker's token (Low, no privileges, Administrators deny-only: LOWRUN)
 * shows the hole, labelLow with the tools children closes it, the same Low process still writes cargo and git, the
 * planted binary never runs, and a revert (labelLow without the children) gives back the old layout.
 *
 * It needs a process that may set a Medium label (a GitHub runner, a daemon); a Low worker cannot, and skips.
 */

const run = (cmd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 120_000 }, (err, stdout, stderr) => {
      const c = (err as { code?: unknown } | null)?.code;
      const code = err ? (typeof c === 'number' ? c : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
const exec: Exec = (cmd, args) => run(cmd, args);
const label = async (p: string) => /Mandatory Label\\(\w+) Mandatory Level:([^\s]*)/i.exec((await run('icacls', [p])).stdout)?.slice(1, 3).join(' ') ?? 'none';
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** What the Low process tries, each on its own: prints one JSON object of action -> 'ok' or the error code. */
export const PROBE = `
const fs = require('node:fs');
const path = require('node:path');
const [root, ...acts] = process.argv.slice(2);
const t = path.join(root, 'tools');
const did = {};
const tr = (k, f) => { try { f(); did[k] = 'ok'; } catch (e) { did[k] = e.code || String(e.message); } };
for (const a of acts) {
  if (a === 'control') tr(a, () => fs.writeFileSync(path.join(root, 'medium', 'x.txt'), 'x'));
  if (a === 'rename-node') tr(a, () => { fs.renameSync(path.join(t, 'node'), path.join(t, 'node-taken')); fs.renameSync(path.join(t, 'node-taken'), path.join(t, 'node')); });
  if (a === 'plant-node') tr(a, () => fs.copyFileSync(process.execPath, path.join(t, 'node', 'node.exe')));
  if (a === 'add-to-node') tr(a, () => fs.writeFileSync(path.join(t, 'node', 'planted.dll'), 'x'));
  if (a === 'new-tools-child') tr(a, () => fs.mkdirSync(path.join(t, 'planted')));
  if (a === 'cargo') tr(a, () => fs.writeFileSync(path.join(t, 'cargo', 'registry', 'g.txt'), 'x'));
  if (a === 'cargo-new') tr(a, () => fs.mkdirSync(path.join(t, 'cargo', 'git', 'db'), { recursive: true }));
  if (a === 'git') tr(a, () => fs.writeFileSync(path.join(t, 'git', 'bin', 'y.txt'), 'x'));
  const cp = require('node:child_process');
  const out = (f, args) => { try { return cp.execFileSync(f, args, { encoding: 'utf8', windowsHide: true }); } catch (e) { return String(e.stdout || '') + String(e.message); } };
  if (a === 'whoami') did.diag = (did.diag || '') + out(path.join(process.env.SystemRoot || process.env.windir, 'System32', 'whoami.exe'), ['/groups', '/priv']).split(/\\r?\\n/).filter((l) => /Mandatory Label|S-1-5-32-544|Se\\w+Privilege/.test(l)).map((l) => l.replace(/\\s+/g, ' ').trim()).join('\\n') + '\\n';
}
process.stdout.write(JSON.stringify(did));
`;

/**
 * Starts a command with a worker's token: this process's own with every privilege but SeChangeNotify removed,
 * Administrators deny-only (as in a signed-in person's filtered token) and the Low label. A GitHub runner's elevated
 * token keeps SeBackupPrivilege and SeRestorePrivilege at Low, and those pass any integrity label and access list
 * (run 45641049172: the runner's Low copy of node renamed tools\node under a Medium tools); no worker holds them
 * (LothDesktop, measured: Administrators deny-only, SeChangeNotify the only privilege). Stdout and stderr go to one file.
 */
export const LOWRUN = `param([string]$CmdFile, [string]$OutFile)
Add-Type -TypeDefinition @"
using System; using System.IO; using System.Text; using System.Runtime.InteropServices;
public static class LowRun {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct SI { public int cb; public string r, d, t; public int x, y, xs, ys, xc, yc, fill, flags; public short show, r2; public IntPtr r3, hin, hout, herr; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr hp, ht; public int pid, tid; }
  [StructLayout(LayoutKind.Sequential)] public struct SA { public IntPtr sid; public int attr; }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr p, int a, out IntPtr t);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr t, int flags, int nd, SA[] dis, int np, IntPtr pr, int nr, IntPtr rs, out IntPtr nt);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool ConvertStringSidToSidW(string s, out IntPtr sid);
  [DllImport("advapi32.dll")] static extern int GetLengthSid(IntPtr sid);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool SetTokenInformation(IntPtr t, int cls, ref SA i, int len);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr h, int m, int f);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcessAsUserW(IntPtr t, string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inh, int flags, IntPtr env, string dir, ref SI si, out PI pi);
  [DllImport("kernel32.dll")] static extern int WaitForSingleObject(IntPtr h, int ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out int c);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static void Ok(bool b, string what) { if (!b) throw new Exception(what + " failed: " + Marshal.GetLastWin32Error()); }
  // A worker's token: this one's with every privilege but SeChangeNotify removed, Administrators deny-only (as in a
  // signed-in person's filtered token) and the Low label. Its stdout and stderr go to one file opened here.
  public static int Run(string cmdline, string outFile) {
    IntPtr tok, rtok, admins, low;
    Ok(OpenProcessToken(GetCurrentProcess(), 0x2 | 0x8 | 0x1 | 0x80, out tok), "OpenProcessToken");
    Ok(ConvertStringSidToSidW("S-1-5-32-544", out admins), "ConvertStringSidToSid");
    SA[] dis = new SA[] { new SA { sid = admins, attr = 0 } };
    Ok(CreateRestrictedToken(tok, 0x1 | 0x4, 1, dis, 0, IntPtr.Zero, 0, IntPtr.Zero, out rtok), "CreateRestrictedToken");
    Ok(ConvertStringSidToSidW("S-1-16-4096", out low), "ConvertStringSidToSid");
    SA tml = new SA { sid = low, attr = 0x20 };
    Ok(SetTokenInformation(rtok, 25, ref tml, Marshal.SizeOf(typeof(SA)) + GetLengthSid(low)), "SetTokenInformation");
    using (FileStream f = new FileStream(outFile, FileMode.Create, FileAccess.Write, FileShare.ReadWrite)) {
      IntPtr h = f.SafeFileHandle.DangerousGetHandle();
      Ok(SetHandleInformation(h, 1, 1), "SetHandleInformation");
      SI si = new SI(); si.cb = Marshal.SizeOf(typeof(SI)); si.flags = 0x100; si.hout = h; si.herr = h;
      PI pi;
      Ok(CreateProcessAsUserW(rtok, null, new StringBuilder(cmdline), IntPtr.Zero, IntPtr.Zero, true, 0x08000000, IntPtr.Zero, null, ref si, out pi), "CreateProcessAsUser");
      WaitForSingleObject(pi.hp, 120000);
      int code; GetExitCodeProcess(pi.hp, out code);
      CloseHandle(pi.hp); CloseHandle(pi.ht);
      return code;
    }
  }
}
"@
exit [LowRun]::Run([IO.File]::ReadAllText($CmdFile), $OutFile)
`;

test('w5717: a Low worker can no longer rename or replace tools\\node, still writes the rest of tools, and a revert restores the old layout', { skip: process.platform !== 'win32' && 'Windows only' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w5717-'));
  try {
    const tools = path.join(root, 'tools');
    // Can this process set a Medium label at all? A Low worker cannot (icacls: "may not be assigned as the label").
    fs.mkdirSync(path.join(root, 'medium'));
    const can = await run('icacls', [path.join(root, 'medium'), '/setintegritylevel', '(OI)(CI)medium']);
    if (can.code !== 0) {
      t.skip(`this process cannot set a Medium label: ${(can.stderr || can.stdout).trim().slice(-120)}`);
      return;
    }
    for (const d of ['cargo/registry', 'git/bin', 'node', 'low']) fs.mkdirSync(path.join(tools, d), { recursive: true });
    fs.writeFileSync(path.join(tools, 'cargo', 'registry', 'f.txt'), 'x');
    fs.copyFileSync(process.execPath, agentNodeExe(root));
    const realNode = sha(agentNodeExe(root));
    fs.mkdirSync(path.join(root, 'bin'));
    const probe = path.join(root, 'bin', 'probe.cjs');
    fs.writeFileSync(probe, PROBE);
    const launcher = path.join(root, 'bin', 'lowrun.ps1');
    fs.writeFileSync(launcher, LOWRUN);
    let n = 0;
    const lowTry = (...acts: string[]): Record<string, string> => {
      const cmd = path.join(root, 'bin', `cmd${++n}.txt`);
      const out = path.join(root, 'bin', `out${n}.txt`);
      fs.writeFileSync(cmd, [process.execPath, probe, root, ...acts].map((a) => `"${a}"`).join(' '));
      const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher, cmd, out], { encoding: 'utf8', windowsHide: true, timeout: 180_000 });
      const text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
      assert.equal(r.status, 0, `the probe ran with a worker's token: ${r.stderr}${r.stdout}${text}`);
      return JSON.parse(text);
    };

    // The old layout, as the daemon's labelLow left it before w5717: tools Low on its own, node Medium on its own.
    const children = [{ name: 'tools', dir: true }];
    const listTools = () => fs.readdirSync(tools, { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() }));
    const said: string[] = [];
    const say = (l: string) => void said.push(l);
    assert.equal(await labelLow(lowTargets({ root, appDir: path.join(root, 'daemon'), children }), exec, say), true, said.join('\n'));
    assert.match(await label(tools), /^Low \(OI\)\(CI\)/);
    assert.match(await label(path.join(tools, 'node')), /^Medium/);
    // The probe is Low: it cannot write a Medium folder.
    assert.notEqual(lowTry('control').control, 'ok', 'the probe runs at Low');
    // The hole: inside a Low tools, the Low process renames the Medium node folder away (and back).
    assert.equal(lowTry('rename-node')['rename-node'], 'ok', 'before w5717 a Low worker could take tools\\node away');

    // w5717: labelLow with the tools children.
    said.length = 0;
    assert.equal(await labelLow(lowTargets({ root, appDir: path.join(root, 'daemon'), children, toolsChildren: listTools() }), exec, say), true, said.join('\n'));
    assert.match(await label(tools), /^Medium/, said.join('\n'));
    assert.match(await label(path.join(tools, 'cargo')), /^Low \(OI\)\(CI\)/, 'cargo Low on its own');
    assert.match(await label(path.join(tools, 'cargo', 'registry', 'f.txt')), /^Low \(I\)/, 'what is in cargo inherits Low from it');
    assert.match(await label(path.join(tools, 'git')), /^Low \(OI\)\(CI\)/);
    assert.match(await label(path.join(tools, 'node')), /^Medium/);
    const after = lowTry('rename-node', 'plant-node', 'add-to-node', 'new-tools-child', 'cargo', 'cargo-new', 'git');
    // w5717 review: on the runner the rename went through (run 45635881985) though on LothDesktop a Low process is
    // refused DELETE on a Medium folder under a Medium parent (measured). Say what the Low token and each right were.
    const diag = lowTry('whoami').diag ?? '';
    t.diagnostic(diag);
    t.diagnostic(`labels: ${(await run('icacls', [tools])).stdout}\n${(await run('icacls', [path.join(tools, 'node')])).stdout}`);
    assert.notEqual(after['rename-node'], 'ok', `tools\\node cannot be renamed away\n${diag}`);
    assert.notEqual(after['plant-node'], 'ok', 'node.exe cannot be replaced');
    assert.notEqual(after['add-to-node'], 'ok', 'nothing can be added beside node.exe');
    assert.notEqual(after['new-tools-child'], 'ok', 'no new folder in tools');
    assert.deepEqual([after.cargo, after['cargo-new'], after.git], ['ok', 'ok', 'ok'], `workers still write cargo and git: ${JSON.stringify(after)}`);
    // The planted binary never runs: the node on the agents' PATH is the one put there.
    assert.equal(sha(agentNodeExe(root)), realNode);
    assert.ok(!fs.existsSync(path.join(tools, 'node', 'planted.dll')) && !fs.existsSync(path.join(tools, 'node-taken')));
    assert.equal(agentNodePathDir(root, 'win32'), path.join(tools, 'node'));
    const v = spawnSync(path.join(agentNodePathDir(root, 'win32')!, 'node.exe'), ['-p', 'process.version'], { encoding: 'utf8' });
    assert.equal(v.stdout.trim(), process.version);
    // A second start changes nothing.
    said.length = 0;
    assert.equal(await labelLow(lowTargets({ root, appDir: path.join(root, 'daemon'), children, toolsChildren: listTools() }), exec, say), true);
    assert.deepEqual(said, [], 'nothing labelled again');

    // A revert (a daemon from before w5717 passes no children): tools goes back to Low and nothing is lost.
    said.length = 0;
    assert.equal(await labelLow(lowTargets({ root, appDir: path.join(root, 'daemon'), children }), exec, say), true, said.join('\n'));
    assert.match(await label(tools), /^Low/);
    assert.match(await label(path.join(tools, 'node')), /^Medium/);
    const back = lowTry('cargo', 'git');
    assert.deepEqual([back.cargo, back.git], ['ok', 'ok']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
