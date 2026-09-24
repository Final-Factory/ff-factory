import { execFile, spawn } from 'node:child_process';
import os from 'node:os';

export const isWindows = process.platform === 'win32';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a program (no shell) and collect its output. Never throws on a non-zero exit. */
export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Aborting kills the child; the result then has a non-zero code. */
  signal?: AbortSignal;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 0, maxBuffer: 64 * 1024 * 1024, env: opts.env ?? process.env, windowsHide: true, signal: opts.signal },
      (err, stdout, stderr) => {
        // err.code is the exit status for a program that ran, or a string like ENOENT when it could not start.
        const raw = (err as { code?: unknown } | null)?.code;
        const code = !err ? 0 : typeof raw === 'number' ? raw : -1;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) || (err ? err.message : '') });
      },
    );
  });
}

/** Like run(), but throws with the tail of stderr when the exit code is not in okCodes. */
export async function must(cmd: string, args: string[], opts: RunOptions & { okCodes?: number[] } = {}) {
  const r = await run(cmd, args, opts);
  if (!(opts.okCodes ?? [0]).includes(r.code)) {
    const tail = (r.stderr || r.stdout).trim().split('\n').slice(-6).join('\n');
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.code}): ${tail}`);
  }
  return r;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The full command line of a process, or undefined if it is gone. Used to prove a pid is ours before killing it. */
/**
 * When a process started, as an opaque string that is stable for the life of the process, or
 * undefined if it is gone or the OS will not say. A pid whose start time differs from the one
 * recorded at launch has been reused by another program.
 */
export async function processStartTime(pid: number): Promise<string | undefined> {
  if (isWindows) {
    const r = await run('powershell.exe', [
      '-NoProfile',
      '-Command',
      `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().ToString('o')`,
    ]);
    const s = r.stdout.trim();
    return r.code === 0 && s ? s : undefined;
  }
  const r = await run('ps', ['-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' } });
  const s = r.stdout.trim();
  return r.code === 0 && s ? s : undefined;
}

/** Drop a process to below-normal CPU priority so it cannot starve the live game on this machine. Best effort. */
export function lowerPriority(pid: number) {
  try {
    os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // not fatal: the process runs at normal priority
  }
}

export async function commandLine(pid: number): Promise<string | undefined> {
  if (isWindows) {
    const r = await run('powershell.exe', [
      '-NoProfile',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
    ]);
    const s = r.stdout.trim();
    return s || undefined;
  }
  const r = await run('ps', ['-o', 'command=', '-p', String(pid)]);
  const s = r.stdout.trim();
  return s || undefined;
}

/** Terminate a process tree: politely first, then by force after graceMs. */
export async function killTree(pid: number, graceMs = 15000) {
  if (isWindows) {
    await run('taskkill.exe', ['/PID', String(pid), '/T']);
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return;
    }
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await sleep(500);
  }
  if (isWindows) await run('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
  else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/** Start a long-lived program that outlives nothing of ours: detached, no stdio. */
export function launchDetached(cmd: string, args: string[], cwd: string): number {
  const child = spawn(cmd, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  if (!child.pid) throw new Error(`failed to launch ${cmd}`);
  return child.pid;
}

/**
 * Start a console program that must outlive this server (Windows). spawn({ detached: true }) does not
 * work for powershell.exe: without a console it exits at once without running anything (measured on
 * this host). So a short-lived PowerShell starts it with Start-Process; a grandchild is outside node's job
 * object and survives our exit. Arguments travel as JSON in an environment variable. Returns its pid.
 */
export async function launchIndependent(cmd: string, args: string[]): Promise<number> {
  const relay = [
    '$a = $env:FFSB_LAUNCH_ARGS | ConvertFrom-Json',
    // CreateProcess quoting: quote what needs it, backslash-escape embedded double quotes.
    String.raw`$q = ($a | ForEach-Object { if ($_ -match '[\s"]' -or $_ -eq '') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '`,
    '(Start-Process $env:FFSB_LAUNCH_CMD -WindowStyle Hidden -ArgumentList $q -PassThru).Id',
  ].join('; ');
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(relay, 'utf16le').toString('base64')], {
    timeoutMs: 60_000,
    env: { ...process.env, FFSB_LAUNCH_CMD: cmd, FFSB_LAUNCH_ARGS: JSON.stringify(args) },
  });
  const pid = Number(/^\d+/m.exec(r.stdout)?.[0]);
  if (r.code !== 0 || !pid) throw new Error(`could not start ${cmd} (${r.code}): ${r.stderr.trim().slice(-300)}`);
  return pid;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a program at below-normal priority and wait for it. Unlike run(), the pid is known as soon as
 * it starts, so the priority applies to the whole run. Output is kept only as a short tail.
 */
function runLowPriority(cmd: string, args: string[], opts: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    const keep = (acc: string, chunk: Buffer) => (acc + chunk.toString()).slice(-16 * 1024);
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal: opts.signal, env: opts.env ?? process.env });
    if (child.pid) lowerPriority(child.pid);
    child.stdout.on('data', (c: Buffer) => (out = keep(out, c)));
    child.stderr.on('data', (c: Buffer) => (err = keep(err, c)));
    let done = false;
    const finish = (code: number, why?: string) => {
      if (done) return;
      done = true;
      resolve({ code, stdout: out, stderr: err || why || '' });
    };
    child.on('error', (e) => finish(-1, e.message));
    child.on('close', (code) => finish(code ?? -1));
  });
}

/** Copy a large directory tree, using copy-on-write clones where the OS offers them. Runs at below-normal priority. */
export async function copyTree(src: string, dst: string, opts: { signal?: AbortSignal; mode?: 'robocopy' | 'clone' } = {}) {
  let cmd: string;
  let args: string[];
  let okCodes = [0];
  let env: NodeJS.ProcessEnv | undefined;
  if (isWindows && opts.mode === 'clone') {
    // The Windows copy engine block-clones on ReFS (Dev Drive) when source and target share a volume;
    // robocopy does not. Paths go in as arguments, never spliced into the script text.
    // (powershell -Command joins trailing arguments into the script text, so paths travel in env vars.)
    cmd = 'powershell.exe';
    args = ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; Copy-Item -LiteralPath $env:FFSB_COPY_SRC -Destination $env:FFSB_COPY_DST -Recurse -Force'];
    env = { ...process.env, FFSB_COPY_SRC: src, FFSB_COPY_DST: dst };
  } else if (isWindows) {
    // robocopy exit codes below 8 are success. On a ReFS Dev Drive, Windows 11 block-clones.
    // /MT:8, not more: this machine is also a live game peer, and 32 copy threads saturate the disk.
    cmd = 'robocopy.exe';
    args = [src, dst, '/E', '/MT:8', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'];
    okCodes = [0, 1, 2, 3, 4, 5, 6, 7];
  } else if (process.platform === 'darwin') {
    cmd = 'cp';
    args = ['-cR', src, dst]; // APFS clonefile
  } else {
    cmd = 'cp';
    args = ['-a', '--reflink=auto', src, dst];
  }
  const r = await runLowPriority(cmd, args, { ...opts, env });
  if (!okCodes.includes(r.code)) {
    const tail = (r.stderr || r.stdout).trim().split('\n').slice(-6).join('\n');
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.code}): ${tail}`);
  }
}

/** Recursively delete a directory. Returns the command's result; callers check whether the directory is gone. */
export async function removeTree(dir: string): Promise<RunResult> {
  if (isWindows) {
    // rd copes with long paths and read-only files far better than a recursive unlink of Library/.
    return run('cmd.exe', ['/c', 'rd', '/s', '/q', dir]);
  }
  return run('rm', ['-rf', dir]);
}
