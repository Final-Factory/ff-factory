/**
 * w5347: a Roslyn compiler server (VBCSCompiler) started at Low integrity breaks every Unity compile on the machine.
 *
 * Unity's Bee compiles with `dotnet exec <Editor>/Data/DotNetSdkRoslyn/csc.dll /shared`, and Roslyn names the server's pipe
 * from the user, elevation and the compiler's folder only, not the integrity level. So a server that a Low-integrity Unity
 * started (the w5333 trial) takes the pipe of every normal editor of that install, and writes their output with its Low
 * token: `error CS2012: Cannot open '...\Library\Bee\artifacts\...dll' for writing -- 'Access to the path ... is denied.'`
 * (measured on LothDesktop, 2026-11-23: three slot1 player builds and slot6, until the server ended; reproduced in
 * isolation, docs/worker-root.md 4.1). Roslyn ends an idle server after its keep-alive (10 minutes by default).
 *
 * A failed `unity-slot run` names that cause instead of a bare compile failure.
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { execFileOffThread } from '../server/spawnThread.ts';

/** A Unity log's CS2012 under Library/Bee: the path it could not write, or undefined. */
export function beeAccessDenied(log: string): string | undefined {
  const m = /error CS2012: Cannot open '([^']*[\\/]Library[\\/]Bee[\\/][^']*)' for writing -- '?Access to the path/i.exec(log);
  return m?.[1];
}

/** The value after `-logFile` in a command, or undefined. */
export function logFileArg(args: string[]): string | undefined {
  const i = args.findIndex((a) => /^-logfile$/i.test(a));
  return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('-') ? args[i + 1] : undefined;
}

export interface CompilerServer {
  pid: number;
  /** The integrity level's RID: 0x1000 Low, 0x2000 Medium, 0x3000 High; 0 when it could not be read. */
  rid: number;
  started: string;
  /** The VBCSCompiler.dll it runs, which names the install whose editors share its pipe. */
  dll: string;
}

/** Each running VBCSCompiler server with its integrity level (Windows; PowerShell reads each process's token). */
const LIST_SERVERS = String.raw`
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class FfIl {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int a, bool i, int pid);
  [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr p, int a, out IntPtr t);
  [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr t, int c, IntPtr b, int l, out int r);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr s, int n);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr s);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static int Rid(int pid) {
    IntPtr p = OpenProcess(0x1000, false, pid); if (p == IntPtr.Zero) return 0;
    IntPtr t; if (!OpenProcessToken(p, 8, out t)) { CloseHandle(p); return 0; }
    int n; GetTokenInformation(t, 25, IntPtr.Zero, 0, out n); IntPtr b = Marshal.AllocHGlobal(n); int r = 0;
    if (GetTokenInformation(t, 25, b, n, out n)) { IntPtr s = Marshal.ReadIntPtr(b); r = Marshal.ReadInt32(GetSidSubAuthority(s, Marshal.ReadByte(GetSidSubAuthorityCount(s)) - 1)); }
    Marshal.FreeHGlobal(b); CloseHandle(t); CloseHandle(p); return r;
  }
}
'@
@(Get-CimInstance Win32_Process -Filter "Name='dotnet.exe' or Name='VBCSCompiler.exe'" | Where-Object { $_.CommandLine -match 'VBCSCompiler' } | ForEach-Object {
  $dll = if ($_.CommandLine -match '([^"]*VBCSCompiler\.(dll|exe))') { $matches[1].Trim() } else { '' }
  [pscustomobject]@{ pid = [int]$_.ProcessId; rid = [FfIl]::Rid([int]$_.ProcessId); started = $_.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); dll = $dll }
}) | ConvertTo-Json -Compress
`;

/** Parses LIST_SERVERS's JSON (one object or an array); anything else is no servers. */
export function parseCompilerServers(json: string): CompilerServer[] {
  try {
    const v: unknown = JSON.parse(json.trim() || '[]');
    const list = Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : [];
    return list
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && Number.isInteger((s as { pid?: unknown }).pid))
      .map((s) => ({ pid: s.pid as number, rid: Number(s.rid) || 0, started: String(s.started ?? ''), dll: String(s.dll ?? '') }));
  } catch {
    return [];
  }
}

/** The running compiler servers (Windows only; empty elsewhere or when PowerShell fails). */
export function compilerServers(platform: NodeJS.Platform = process.platform): CompilerServer[] {
  if (platform !== 'win32') return [];
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(LIST_SERVERS, 'utf16le').toString('base64')], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  return r.status === 0 ? parseCompilerServers(r.stdout) : [];
}

/**
 * The same, without blocking the caller's event loop: the daemon's 15 s look (w5347) ran compilerServers() on its main
 * thread, and from beast's Low switch-on (2026-11-24 11:30 UTC) its LoopWatch logged a blocked loop 90-230 times an hour
 * (about 5 before), up to 72 s, until its link heartbeat and the update download's stall check fired late (w5938).
 */
export function compilerServersAsync(platform: NodeJS.Platform = process.platform): Promise<CompilerServer[]> {
  if (platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve) =>
    // w6077: started from the daemon's spawn thread: the PowerShell start itself held BEAST's loop up to 35.5 s.
    execFileOffThread('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(LIST_SERVERS, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 30_000, windowsHide: true }, (err, stdout) =>
      resolve(err ? [] : parseCompilerServers(stdout)),
    ),
  );
}

const LOW = (s: CompilerServer) => s.rid > 0 && s.rid < 0x2000;

/**
 * What to tell the worker after a failed run: a Low-integrity compiler server is running (the cause, whether or not the log
 * shows it yet), or the log's CS2012 under Library/Bee with no such server left. Undefined when neither.
 */
export function compilerServerAdvice(denied: string | undefined, servers: CompilerServer[]): string | undefined {
  const low = servers.filter(LOW);
  if (low.length) {
    const list = low.map((s) => `pid ${s.pid} (started ${s.started}, ${s.dll || 'VBCSCompiler'})`).join(', ');
    return (
      `w5347: a Low-integrity Roslyn compiler server runs on this machine: ${list}. Every Unity of that install shares its pipe and ` +
      `fails to compile with CS2012 "Access to the path ... is denied" under Library/Bee${denied ? ` (this run: ${denied})` : ''}. ` +
      `It came from a Low-integrity run (the w5333 trial). If your session started it, \`ff-leftovers end\` ends it; otherwise ` +
      `do not kill it: tell your orchestrator, and run again once it is gone (Roslyn ends an idle server after 10 minutes).`
    );
  }
  if (denied)
    return (
      `w5347: CS2012 "Access to the path ... is denied" under Library/Bee (${denied}). The known cause is a Roslyn compiler server ` +
      `left by a Low-integrity Unity run, which every editor of the install shares; none runs now, so run again.`
    );
  return undefined;
}

/** The last `max` bytes of a log, or '' when it cannot be read. */
export function logTail(file: string | undefined, max = 4 << 20): string {
  if (!file) return '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, max);
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, size - len);
      return b.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}
