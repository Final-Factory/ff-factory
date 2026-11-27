/**
 * A worker's token for live Windows tests (toolsLabelsWin.test.ts w5717, sharedLock.test.ts w5615): LOWRUN, a PowerShell
 * launcher, and lowRunner, which runs one cmd.exe line through it. Not a test file: imported by them.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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

/**
 * Runs cmd.exe lines with a worker's token (LOWRUN), its scripts and output in `dir`. `status` is cmd's exit code; `launch`
 * says the launcher itself failed (a refused write must not be read off a launcher that never started cmd).
 */
export function lowRunner(dir: string): (line: string) => { status: number | null; out: string; launch?: string } {
  fs.mkdirSync(dir, { recursive: true });
  const launcher = path.join(dir, 'lowrun.ps1');
  fs.writeFileSync(launcher, LOWRUN);
  const cmdExe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
  let n = 0;
  return (line) => {
    const cmd = path.join(dir, `cmd${++n}.txt`);
    const out = path.join(dir, `out${n}.txt`);
    fs.writeFileSync(cmd, `"${cmdExe}" /d /s /c "${line}"`);
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher, cmd, out], { encoding: 'utf8', windowsHide: true, timeout: 180_000 });
    const text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
    const err = `${r.stderr ?? ''}${r.stdout ?? ''}`;
    return { status: r.status, out: text, launch: /failed: \d+|Exception/.test(err) ? err.trim().slice(-300) : undefined };
  };
}
