// w5333: OS-enforced write lock for workers on Linux (docs/worker-root.md, "Write lock (Linux, trial)"). Off unless a
// machine's daemon.json says `"writeLock": true`. Each agent's claude, and so every tool, build, player and git it starts,
// runs under machine/ff-landlock.py: Landlock refuses every create, write, truncate, rename or delete outside the folders
// below, needs no root and no namespace, and cannot be lifted by the process. The agent host itself stays outside it.
//
// systemd-run --user with ProtectSystem=strict (w5297's first pick) was tried first on biscuit and does nothing there:
// Ubuntu's kernel.apparmor_restrict_unprivileged_userns=1 sends systemd-executor to the unprivileged_userns profile, the
// mount namespace fails on CAP_SYS_ADMIN, and the user manager starts the unit anyway with every path still writable.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DAEMON_ONLY_CHILDREN, MEDIUM_ONLY_CHILDREN } from '../server/claudeHome.ts';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { FENCE_READ_ALLOW, fenceRootReadBack } from '../server/daemonReads.ts';
import { openChildren } from './lowIntegrity.ts';
import { STORE_CHILD } from './storeLock.ts';
import { sessionIdOf } from '../server/workerFence.ts';
import { TRANSCRIPTS, finishNewTranscripts, linkTranscripts, ownTranscriptArgs } from './transcriptLock.ts';

/** The launcher beside this file. */
export const FF_LANDLOCK = path.join(import.meta.dirname, 'ff-landlock.py');

/** The .NET runtime's IPC folder in /tmp (`.dotnet/shm`): made before a worker starts, since /tmp is create-only. */
export const DOTNET_DIR = '.dotnet';

/**
 * Folders of the install root a worker never writes: the daemon's own (its code, config, hosts), the secrets, and the Medium
 * agents' Claude Code folder (w5543: its settings, plugins and hooks run in agents outside the lock), and steamcmd's (w5551).
 */
export const LOCKED_CHILDREN = ['daemon', 'secrets', ...MEDIUM_ONLY_CHILDREN, ...DAEMON_ONLY_CHILDREN] as const;

export interface WriteLockPaths {
  /** The worker root (`~/ffw`). Only the folders workers write are writable (lowIntegrity.ts openChildren, w5569). */
  root: string;
  /** The daemon's folder, when it is not `<root>/daemon`. */
  appDir?: string;
  /** Folders of the install outside its root (DaemonConfig.extraRoots). */
  extraRoots?: string[];
  /** The Unity slots mailbox (FF_UNITY_SLOTS, `~/.ff-factory/unity-slots`): unity-slot requests and job logs. */
  unitySlots?: string;
  /** $XDG_RUNTIME_DIR: Claude Code binds its socket in `cc-socks` there (measured, w5333). */
  runtimeDir?: string;
  /**
   * The person's home: Unity writes its own config there and nowhere else will do (measured on biscuit, w5333):
   * `~/.config/unity3d` (Editor and player prefs, upm.log, CoreBusinessMetrics.db) and `~/.local/share/unity3d` (prefs).
   * XDG_CONFIG_HOME would move them, and with them the Unity licence Unity looks for there.
   */
  home?: string;
  /** The system temp folder Unity writes whatever TMPDIR says (default /tmp): create-only, its .dotnet writable. */
  tmp?: string;
  /** More writable folders, each with its reason in daemon.json (`writeLockExtra`). */
  extra?: string[];
  /** The configured temp and sandboxes folders: one in the root opens its root child too (w5569). */
  workFolders?: (string | undefined)[];
  /**
   * w5702: daemon.json `transcriptLock` is on: `<root>/transcripts` stays shut and each claude gets its own conversation's
   * rules (machine/transcriptLock.ts). Off, the transcripts folder is opened whole, as `claude` is.
   */
  transcriptLock?: boolean;
  /** w5614: the store lock holds (machine/storeLock.ts): the main clone (`repo`) stays read-only. */
  lockStore?: boolean;
}

/**
 * w5546: the read half. The daemon's folder, `secrets`, `root.json` and the daemon-only children (`steam`, w5639) are
 * closed to reads; what workers read in the daemon's folder (FENCE_READ_ALLOW: logs, code, the gh shim, Unity MCP status) is given back. Per run, `noRead` closes
 * more (w5548's gh login) and `read` gives back one path inside a closed folder (the run's own GitHub App tokens, w5547).
 */
export function readLockArgs(p: { root: string; appDir?: string; noRead?: string[]; read?: string[] }): string[] {
  const root = path.resolve(p.root);
  const app = p.appDir ? path.resolve(p.appDir) : path.join(root, 'daemon');
  const closed = [...new Set([app, path.join(root, 'daemon'), path.join(root, 'secrets'), path.join(root, 'root.json'), ...DAEMON_ONLY_CHILDREN.map((c) => path.join(root, c)), ...(p.noRead ?? [])])];
  const back = [...FENCE_READ_ALLOW.map((a) => path.join(app, a)), ...fenceRootReadBack(root), ...(p.read ?? [])];
  return [...closed.flatMap((c) => ['--no-read', c]), ...back.flatMap((b) => ['--read', b])];
}

/** ff-landlock.py's arguments for a worker (everything before `--`). */
export function writeLockArgs(p: WriteLockPaths): string[] {
  const root = path.resolve(p.root);
  const app = p.appDir ? path.resolve(p.appDir) : path.join(root, 'daemon');
  const except = new Set<string>(LOCKED_CHILDREN);
  if (path.dirname(app) === root) except.add(path.basename(app));
  if (p.lockStore) except.add(STORE_CHILD);
  // /dev: null, tty, shm, the GPU. /proc: a process's own oom_score_adj (Unity sets it); file modes still decide the rest.
  const args = ['--rw', '/dev', '--rw', '/proc'];
  // Only the root's folders workers write (w5569, as Windows since w5539): a portal, an instances folder or any new root
  // folder stays read-only until listed. A listed folder missing at start is skipped by ff-landlock.py (read-only), so
  // the daemon makes the missing ones before each locked worker starts (makeOpenRootChildren, w5676).
  for (const c of openChildren(root, p.workFolders ?? [], except)) args.push('--rw', path.join(root, c));
  // w5702: off, the transcripts folder is open whole, and made ahead (makeOpenRootChildren) even before any `on`, so a
  // claude locked before the switch keeps its own transcript once the switch moves them there (w5718's review).
  if (!p.transcriptLock) args.push('--rw', path.join(root, TRANSCRIPTS));
  for (const r of p.extraRoots ?? []) args.push('--rw', r);
  if (p.unitySlots) args.push('--rw', p.unitySlots);
  if (p.runtimeDir) args.push('--sock', path.join(p.runtimeDir, 'cc-socks'));
  // w5562: the user bus and the systemd user manager's own sockets, through which `systemd-run --user` starts a job
  // outside the lock (measured escaping on biscuit, w5463). Needs Landlock ABI 9 (Linux 7.1); a no-op before it.
  if (p.runtimeDir) args.push('--deny-unix', path.join(p.runtimeDir, 'bus'), '--deny-unix', path.join(p.runtimeDir, 'systemd'));
  if (p.home) args.push('--rw', path.join(p.home, '.config', 'unity3d'), '--rw', path.join(p.home, '.local', 'share', 'unity3d'));
  // Unity ignores TMPDIR for its sockets (/tmp/Unity-Upm-<pid>.sock, Unity-ShaderCompilerIPC-*.sock, ilpp.sock-<hash>)
  // and its shader compiler's lock (/tmp/Unity-ShaderCompilerIPC-*.lock, opened O_RDONLY|O_CREAT and flock'd), and its
  // .NET runtime keeps IPC files in /tmp/.dotnet/shm (measured on biscuit, w5333 and w5561). A private /tmp needs a mount
  // namespace, which this machine refuses an unprivileged user. So /tmp is create-only (w5561): new files and sockets and
  // removing them, never a write, truncate, folder or link, so the person's own files there cannot be changed. Only
  // .dotnet, the runtime's own folder, stays writable. /dev/shm stays writable through /dev (w5561): POSIX semaphores
  // and shared memory live only there (glibc's sem_open and shm_open), and Python's multiprocessing and Chromium fail
  // without it.
  if (p.home) {
    const tmp = p.tmp ?? '/tmp';
    args.push('--create', tmp, '--rw', path.join(tmp, DOTNET_DIR));
  }
  for (const e of p.extra ?? []) args.push('--rw', e);
  return args;
}

/**
 * Options.spawnClaudeCodeProcess that starts claude under ff-landlock.py with these arguments. The folders a rule names
 * must exist when it starts (a missing one is skipped, so it stays unwritable): cc-socks and the .NET runtime's
 * /tmp/.dotnet/shm (mode 1777, as the runtime makes it) are made here first. The Max
 * events file is no longer granted (w5552): it is the daemon's, read-only for workers like the rest of its folder.
 */
export function writeLockSpawner(args: string[], o: { python?: string; script?: string; transcripts?: string; log?: (line: string) => void } = {}) {
  const log = o.log ?? ((l: string) => console.warn(l));
  return (s: SpawnOptions): SpawnedProcess => {
    const own = o.transcripts ? transcriptRules(o.transcripts, s, log) : undefined;
    for (let i = 0; i < args.length - 1; i++) {
      try {
        if (args[i] === '--sock') fs.mkdirSync(args[i + 1], { recursive: true, mode: 0o700 });
        else if (args[i] === '--rw' && path.basename(args[i + 1]) === DOTNET_DIR) makeDotnetShm(args[i + 1]);
      } catch {
        /* the rule is skipped and the write refused: the agent says so */
      }
    }
    const child = spawn(o.python ?? 'python3', [o.script ?? FF_LANDLOCK, ...args, ...(own?.args ?? []), '--', s.command, ...s.args], {
      cwd: s.cwd,
      env: s.env,
      signal: s.signal,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    if (own?.sid) {
      const { sid } = own;
      child.on('exit', () => {
        try {
          finishNewTranscripts(o.transcripts!, sid);
        } catch (e) {
          log(`transcript lock: could not move ${sid}'s new transcript into place (${(e as Error).message}); its next start does`);
        }
      });
    }
    return child as unknown as SpawnedProcess;
  };
}

/**
 * w5702 (machine/transcriptLock.ts): the rules for the one conversation this claude may write, after making sure the
 * Claude home's `projects` is still the link to `transcripts` (a worker may have replaced it; that is logged). A claude
 * whose argv names no session id, or whose Claude home is not given, gets no transcript rule: it can write none.
 */
function transcriptRules(t: string, s: SpawnOptions, log: (line: string) => void): { args: string[]; sid?: string } {
  const sid = sessionIdOf(s.args);
  const home = s.env.CLAUDE_CONFIG_DIR;
  // Only the root's own Claude home (w5718's review): another home's `projects` would be hidden from its resumes.
  if (!sid || !home || path.resolve(home) !== path.join(path.dirname(t), 'claude')) return { args: [] };
  try {
    const did = linkTranscripts(path.dirname(t), home);
    if (did) log(`transcript lock: ${did}`);
    return { args: ownTranscriptArgs(t, sid, s.cwd), sid };
  } catch (e) {
    log(`transcript lock: could not set up ${sid}'s transcript rules (${(e as Error).message}); it starts with none and its transcript writes are refused`);
    return { args: [], sid };
  }
}

/**
 * Makes each root folder the lock opens (a `--rw` rule directly in the root) that does not exist yet, and answers the
 * ones it made (w5676). ff-landlock.py skips a rule whose folder is missing, and a locked worker cannot make it, since
 * the root itself is read-only: on a fresh root a worker folder never made (voice, agents, gamedata-home, ...) stayed
 * unwritable. Never LOCKED_CHILDREN or the daemon's folder, nothing outside the root, and never a folder in `absent`: the
 * sandboxes folder, whose absence is how the host guard sees a sandbox drive gone (hostHealth.ts blockReason), and an
 * empty folder made there would hide a drive that failed to mount. Run by the daemon, unlocked, before each locked worker
 * starts. A folder it cannot make stays read-only, as before.
 */
export function makeOpenRootChildren(root: string, args: string[], appDir?: string, absent: (string | undefined)[] = []): string[] {
  const r = path.resolve(root);
  const shut = new Set<string>(LOCKED_CHILDREN);
  if (appDir && path.dirname(path.resolve(appDir)) === r) shut.add(path.basename(path.resolve(appDir)));
  for (const a of absent) if (a && path.dirname(path.resolve(a)) === r) shut.add(path.basename(path.resolve(a)));
  const made: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== '--rw') continue;
    const p = path.resolve(args[i + 1]);
    if (path.dirname(p) !== r || shut.has(path.basename(p)) || fs.existsSync(p)) continue;
    try {
      fs.mkdirSync(p);
      made.push(p);
    } catch {
      /* a dangling link or no room: the rule is skipped and the worker's write refused, as before */
    }
  }
  return made;
}

/** /tmp/.dotnet and its shm, world-writable and sticky like the .NET runtime makes them (pal/src/sharedmemory). */
export function makeDotnetShm(dir: string): void {
  for (const d of [dir, path.join(dir, 'shm')]) {
    if (fs.existsSync(d)) continue;
    fs.mkdirSync(d);
    fs.chmodSync(d, 0o1777);
  }
}
