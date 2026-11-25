/**
 * The worker write fence (w5333, macOS trial): a whole-worker Seatbelt profile that lets an agent's claude process, and
 * everything it starts (Bash, subagents, git, batch Unity), write only inside the worker root and a short list of named
 * exceptions. Reads, exec and the network are unchanged; the user is the same. The daemon and the agent host stay
 * outside the fence: hooks, the guard and the FF Factory tools run there, as before.
 *
 * Off by default: daemon.json `workerFence: "seatbelt"` turns it on, on macOS only (docs/worker-fence.md). The profile is
 * passed inline (`sandbox-exec -p`), so no file a worker could edit decides it.
 *
 * Every exception below was measured on m5 on 2026-11-23 (w5333): without it a fenced run failed, and the failure is
 * quoted beside it. Anything else outside the root is refused with EPERM ("Operation not permitted").
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { MEDIUM_ONLY_CHILDREN } from './claudeHome.ts';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

export interface WorkerFence {
  kind: 'seatbelt';
  /** The worker root, resolved (Seatbelt matches resolved paths: /var is /private/var). */
  root: string;
  home: string;
  /** confstr DARWIN_USER_TEMP_DIR and DARWIN_USER_CACHE_DIR, resolved, no trailing slash. */
  darwinTemp: string;
  darwinCache: string;
  /** More folders a worker may write (the Unity slots mailbox when it is not in the root). */
  extraWritable?: string[];
}

/** An SBPL string literal. */
const lit = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Inside the root, still read-only for workers: the daemon's folder, the secrets, the root's record, and the Medium agents'
 * Claude Code folder (w5543: settings, plugins and hooks that agents outside the fence load). Not `repo`, the
 * main clone: a sandbox is a git worktree whose git data (index, objects, refs) lives in it, so a fenced commit there
 * failed on `repo/worktrees/<name>/index.lock` (w5333; the Linux lock leaves it writable for the same reason).
 */
export const READ_ONLY_IN_ROOT = { subpaths: ['daemon', 'secrets', ...MEDIUM_ONLY_CHILDREN], files: ['root.json'] };

export function seatbeltProfile(f: WorkerFence): string {
  const home = (p: string) => path.join(f.home, p);
  const extra = (f.extraWritable ?? []).filter((p) => path.isAbsolute(p));
  return [
    '(version 1)',
    '(allow default)',
    ';; Every file write is refused, except below. Later rules win.',
    '(deny file-write*)',
    `(allow file-write* (subpath ${lit(f.root)}))`,
    ';; device nodes every shell writes to',
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/ptmx")',
    '  (literal "/dev/dtracehelper") (literal "/dev/random") (literal "/dev/urandom")',
    '  (regex #"^/dev/ttys[0-9]+$") (regex #"^/dev/fd/[0-9]+$"))',
    ';; per-user Darwin temp and cache folders: system frameworks (Metal, CoreServices) write there with no setting',
    `(allow file-write* (subpath ${lit(f.darwinTemp)}) (subpath ${lit(f.darwinCache)}))`,
    ';; named exceptions with no setting (docs/worker-root.md 2.7)',
    '(allow file-write*',
    `  (subpath ${lit(home('.ff-factory/unity-slots'))})`,
    `  (subpath ${lit(home('.unity-mcp'))})`,
    ...extra.map((p) => `  (subpath ${lit(p)})`),
    ';; Unity: hard-coded /tmp sockets and the licensing client (each measured, w5333)',
    '  (regex #"^/private/tmp/Unity-Upm-[0-9]+\\.sock$")',
    '  (regex #"^/private/tmp/ilpp\\.sock-[0-9a-f]+$")',
    '  (regex #"^/private/tmp/Unity-ShaderCompilerIPC-[0-9]+-[0-9]+\\.(sock|lock)$")',
    '  (literal "/private/tmp/unitypreflock")',
    '  (regex #"^/private/tmp/Unity-LicenseClient-[^/]+\\.sock$")',
    '  (subpath "/private/tmp/.dotnet")',
    `  (subpath ${lit(home('Library/Logs/Unity'))})`,
    `  (subpath ${lit(home('Library/Unity/licenses'))})`,
    ';; Unity per-user caches with no project setting: GI cache, Bee, CurlRequestCache.db (a player build logged "Failed to create GICache directory" 81,224 times without it)',
    `  (subpath ${lit(home('Library/Caches/com.unity3d.UnityEditor'))}))`,
    ';; inside the root, read-only for workers',
    '(deny file-write*',
    ...READ_ONLY_IN_ROOT.subpaths.map((p) => `  (subpath ${lit(path.join(f.root, p))})`),
    ...READ_ONLY_IN_ROOT.files.map((p) => `  (literal ${lit(path.join(f.root, p))})`),
    ')',
  ].join('\n');
}

const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

const confstr = (name: string) => execFileSync('/usr/bin/getconf', [name], { encoding: 'utf8' }).trim().replace(/\/+$/, '');

/**
 * The fence for this daemon's agents, or undefined when it is off: daemon.json `workerFence` is not "seatbelt", the
 * machine is not a Mac, it has no worker root, or sandbox-exec is missing.
 */
export function fenceFor(o: { setting?: string; root?: string; platform?: NodeJS.Platform; home: string; extraWritable?: string[]; exists?: (p: string) => boolean; getconf?: (name: string) => string }): WorkerFence | undefined {
  if (o.setting !== 'seatbelt' || (o.platform ?? process.platform) !== 'darwin' || !o.root) return undefined;
  if (!(o.exists ?? fs.existsSync)(SANDBOX_EXEC)) return undefined;
  const get = o.getconf ?? confstr;
  return {
    kind: 'seatbelt',
    root: real(o.root),
    home: real(o.home),
    darwinTemp: real(get('DARWIN_USER_TEMP_DIR')),
    darwinCache: real(get('DARWIN_USER_CACHE_DIR')),
    ...(o.extraWritable?.length ? { extraWritable: o.extraWritable.map(real) } : {}),
  };
}

/**
 * What a fenced agent's environment adds: Claude Code's own temp (task output, its /tmp/cc-socks messaging socket) moves
 * into the root, and the auto-updater, which writes ~/.local/share/claude, is off. TMPPREFIX: zsh writes each here-document
 * to /tmp/zshXXXXXX, which the fence refuses (w5397, m5: "can't create temp file for here document: operation not
 * permitted"); its files go to <root>/tmp/zshXXXXXX instead, and zsh removes each once read.
 */
export const fenceEnv = (f: WorkerFence): Record<string, string> => ({ CLAUDE_CODE_TMPDIR: path.join(f.root, 'tmp', 'claude-code'), DISABLE_AUTOUPDATER: '1', TMPPREFIX: path.join(f.root, 'tmp', 'zsh') });

/** The argv that runs `command args` inside the fence. */
export const fencedArgv = (f: WorkerFence, command: string, args: string[]) => [SANDBOX_EXEC, '-p', seatbeltProfile(f), command, ...args];

/**
 * Options.spawnClaudeCodeProcess: the SDK's claude, inside the fence. sandbox-exec execs the command, so the child's pid
 * is claude's own and the SDK's kill and abort reach it. Its stderr's tail is logged when it exits non-zero (a profile
 * the kernel refuses exits 65 before claude starts).
 */
export function fenceSpawner(f: WorkerFence, run: typeof spawn = spawn, log: (line: string) => void = (l) => console.warn(l)) {
  return (o: SpawnOptions): SpawnedProcess => {
    fs.mkdirSync(fenceEnv(f).CLAUDE_CODE_TMPDIR, { recursive: true });
    const [cmd, ...args] = fencedArgv(f, o.command, o.args);
    const child: ChildProcess = run(cmd, args, { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, signal: o.signal, stdio: ['pipe', 'pipe', 'pipe'] });
    let tail = '';
    child.stderr?.on('data', (c: Buffer) => (tail = (tail + c.toString()).slice(-2000)));
    child.on('exit', (code) => {
      if (code) log(`worker fence: claude exited ${code}${tail ? `; stderr: ${tail.trim().split('\n').slice(-5).join(' | ')}` : ''}`);
    });
    return child as unknown as SpawnedProcess;
  };
}
