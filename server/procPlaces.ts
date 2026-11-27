/**
 * w6240: where each process on this machine runs from, its executable and its working folder, for the ffu slot rule of the
 * clean-up (server/installLeftovers.ts, slotRunsFrom). A command line alone missed a test run: on biscuit, 2026-11-27, the
 * stale-unit sweep took 62 of 257 test executables from ffu slot4's target while `python3 tools/run_tests_parallel.py`, started
 * in the slot's checkout with a relative path, was running them. Its argv named neither the target nor the checkout; its
 * working folder was the checkout, and its children's executables were in the target.
 *
 * - Linux: `/proc/<pid>/exe` and `/proc/<pid>/cwd`. A process of another user (EACCES) or one that ended (ENOENT) has no place;
 *   workers run as the daemon's user, so theirs are all read.
 * - macOS: `lsof -a -d cwd,txt -u <uid> -Fpfn`, this user's processes; a process's first `txt` file is its executable (later
 *   ones are the libraries it maps).
 * - Windows: Win32_Process ExecutablePath. Windows has no API to read another process's working folder short of reading its
 *   memory, so `cwd` stays empty there: the rule's other checks (the executable, the command line) stand for it.
 *
 * Undefined when the listing itself fails (no /proc, lsof missing or answering nothing, PowerShell failing): the caller keeps
 * what it would have swept, since a run from it cannot be ruled out.
 */
import fs from 'node:fs';
import { execFile } from 'node:child_process';

export interface ProcPlace {
  pid: number;
  exe?: string;
  cwd?: string;
}

const run = (cmd: string, args: string[], timeoutMs = 60_000) =>
  new Promise<{ code: number; stdout: string }>((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 256 * 1024 ** 2, windowsHide: true }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : -1) : 0;
      resolve({ code, stdout: String(stdout ?? '') });
    });
  });

/** lsof's -F output (`p<pid>`, `f<fd>`, `n<name>` lines) as places: the first txt is the executable. */
export function parseLsof(out: string): ProcPlace[] {
  const by = new Map<number, ProcPlace>();
  let cur: ProcPlace | undefined;
  let fd = '';
  for (const line of out.split('\n')) {
    const k = line[0];
    const v = line.slice(1);
    if (k === 'p') {
      const pid = Number(v);
      cur = by.get(pid) ?? { pid };
      by.set(pid, cur);
      fd = '';
    } else if (k === 'f') fd = v;
    else if (k === 'n' && cur) {
      if (fd === 'cwd' && !cur.cwd) cur.cwd = v;
      else if (fd === 'txt' && !cur.exe) cur.exe = v;
    }
  }
  return [...by.values()];
}

async function linuxPlaces(): Promise<ProcPlace[] | undefined> {
  let names: string[];
  try {
    names = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n));
  } catch {
    return undefined;
  }
  if (!names.length) return undefined;
  const link = (p: string) => fs.promises.readlink(p).then((s) => s.replace(/ \(deleted\)$/, '')).catch(() => undefined);
  return Promise.all(names.map(async (n) => ({ pid: Number(n), exe: await link(`/proc/${n}/exe`), cwd: await link(`/proc/${n}/cwd`) })));
}

async function macPlaces(): Promise<ProcPlace[] | undefined> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  // lsof exits 1 when any one file could not be read; its output still holds every process it could.
  const r = await run('lsof', ['-n', '-P', '-w', '-a', '-d', 'cwd,txt', ...(uid === undefined ? [] : ['-u', String(uid)]), '-Fpfn']);
  const places = parseLsof(r.stdout);
  return places.length ? places : undefined;
}

async function windowsPlaces(): Promise<ProcPlace[] | undefined> {
  const ps = 'Get-CimInstance Win32_Process -Property ProcessId, ExecutablePath | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; exe = [string]$_.ExecutablePath } } | ConvertTo-Json -Compress';
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  if (r.code !== 0 || !r.stdout.trim()) return undefined;
  try {
    const j = JSON.parse(r.stdout) as { pid: number; exe?: string } | { pid: number; exe?: string }[];
    return (Array.isArray(j) ? j : [j]).map((x) => ({ pid: x.pid, exe: x.exe || undefined }));
  } catch {
    return undefined;
  }
}

/** Every process's executable and working folder on this machine, or undefined when they cannot be read. */
export async function procPlaces(platform: NodeJS.Platform = process.platform): Promise<ProcPlace[] | undefined> {
  if (platform === 'linux') return linuxPlaces();
  if (platform === 'darwin') return macPlaces();
  if (platform === 'win32') return windowsPlaces();
  return undefined;
}
