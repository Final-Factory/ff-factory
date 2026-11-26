import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Shared by the Windows legs that need a worker's token on an elevated runner (w5703, w5957).
/**
 * Removes privileges from a running process's token (PowerShell P/Invoke of AdjustTokenPrivileges, SE_PRIVILEGE_REMOVED);
 * answers one line per name: `removed`, or `not held`. A privilege not in the token is not an error.
 */
export const PRIV_PS = `param([int]$procId, [string]$names)
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class FfPriv {
  [StructLayout(LayoutKind.Sequential, Pack = 4)] struct TP { public int Count; public long Luid; public int Attr; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool LookupPrivilegeValue(string sys, string name, out long luid);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool all, ref TP state, int len, IntPtr prev, IntPtr ret);
  public static string Remove(int pid, string name) {
    IntPtr h = OpenProcess(0x1000, false, pid); if (h == IntPtr.Zero) return "OpenProcess " + Marshal.GetLastWin32Error();
    IntPtr t; if (!OpenProcessToken(h, 0x28, out t)) return "OpenProcessToken " + Marshal.GetLastWin32Error();
    long luid; if (!LookupPrivilegeValue(null, name, out luid)) return "LookupPrivilegeValue " + Marshal.GetLastWin32Error();
    TP tp = new TP(); tp.Count = 1; tp.Luid = luid; tp.Attr = 4;
    if (!AdjustTokenPrivileges(t, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero)) return "AdjustTokenPrivileges " + Marshal.GetLastWin32Error();
    return Marshal.GetLastWin32Error() == 1300 ? "not held" : "removed";
  }
}
"@
foreach ($n in $names.Split(',')) { "$n " + [FfPriv]::Remove($procId, $n) }
`;
export function removePrivileges(pid: number, names: string[], dir: string): string {
  const ps1 = path.join(dir, 'remove-privileges.ps1');
  fs.writeFileSync(ps1, PRIV_PS);
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, String(pid), names.join(',')], { encoding: 'utf8' }).trim();
}
