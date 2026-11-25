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
import { MEDIUM_ONLY_CHILDREN } from '../server/claudeHome.ts';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';

/** The launcher beside this file. */
export const FF_LANDLOCK = path.join(import.meta.dirname, 'ff-landlock.py');

/**
 * Folders of the install root a worker never writes: the daemon's own (its code, config, hosts), the secrets, and the Medium
 * agents' Claude Code folder (w5543: its settings, plugins and hooks run in agents outside the lock).
 */
export const LOCKED_CHILDREN = ['daemon', 'secrets', ...MEDIUM_ONLY_CHILDREN] as const;

export interface WriteLockPaths {
  /** The worker root (`~/ffw`). Every folder in it is writable except the daemon's and `secrets`. */
  root: string;
  /** The daemon's folder, when it is not `<root>/daemon`. */
  appDir?: string;
  /** Folders of the install outside its root (DaemonConfig.extraRoots). */
  extraRoots?: string[];
  /** The ffdiscord CLI appends here (FF_MAX_EVENTS, inside the daemon's folder): this one file only. */
  maxEventsFile?: string;
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
  /** More writable folders, each with its reason in daemon.json (`writeLockExtra`). */
  extra?: string[];
}

/** ff-landlock.py's arguments for a worker (everything before `--`). */
export function writeLockArgs(p: WriteLockPaths): string[] {
  const root = path.resolve(p.root);
  const app = p.appDir ? path.resolve(p.appDir) : path.join(root, 'daemon');
  const except = new Set<string>(LOCKED_CHILDREN);
  if (path.dirname(app) === root) except.add(path.basename(app));
  // /dev: null, tty, shm, the GPU. /proc: a process's own oom_score_adj (Unity sets it); file modes still decide the rest.
  const args = ['--rw', '/dev', '--rw', '/proc', '--rw-children', root, ...[...except].sort().flatMap((n) => ['--except', n])];
  for (const r of p.extraRoots ?? []) args.push('--rw', r);
  if (p.maxEventsFile) args.push('--rw', p.maxEventsFile);
  if (p.unitySlots) args.push('--rw', p.unitySlots);
  if (p.runtimeDir) args.push('--sock', path.join(p.runtimeDir, 'cc-socks'));
  // w5562: the user bus and the systemd user manager's own sockets, through which `systemd-run --user` starts a job
  // outside the lock (measured escaping on biscuit, w5463). Needs Landlock ABI 9 (Linux 7.1); a no-op before it.
  if (p.runtimeDir) args.push('--deny-unix', path.join(p.runtimeDir, 'bus'), '--deny-unix', path.join(p.runtimeDir, 'systemd'));
  if (p.home) args.push('--rw', path.join(p.home, '.config', 'unity3d'), '--rw', path.join(p.home, '.local', 'share', 'unity3d'));
  // Unity ignores TMPDIR for its Package Manager socket (/tmp/Unity-Upm-<pid>.sock), its shader compiler's lock
  // (/tmp/Unity-ShaderCompilerIPC-*.lock) and its runtime's /tmp/.dotnet/shm: without them the editor exits 1 or aborts
  // (measured on biscuit, w5333). A private /tmp needs a mount namespace, which this machine refuses an unprivileged user.
  if (p.home) args.push('--rw', '/tmp');
  for (const e of p.extra ?? []) args.push('--rw', e);
  return args;
}

/**
 * Options.spawnClaudeCodeProcess that starts claude under ff-landlock.py with these arguments. The folders a rule names
 * must exist when it starts (a missing one is skipped, so it stays unwritable): the max events file and cc-socks are
 * made here first.
 */
export function writeLockSpawner(args: string[], o: { python?: string; script?: string } = {}) {
  return (s: SpawnOptions): SpawnedProcess => {
    for (let i = 0; i < args.length - 1; i++) {
      try {
        if (args[i] === '--sock') fs.mkdirSync(args[i + 1], { recursive: true, mode: 0o700 });
        else if (args[i] === '--rw' && args[i + 1].endsWith('.jsonl') && !fs.existsSync(args[i + 1])) fs.writeFileSync(args[i + 1], '');
      } catch {
        /* the rule is skipped and the write refused: the agent says so */
      }
    }
    return spawn(o.python ?? 'python3', [o.script ?? FF_LANDLOCK, ...args, '--', s.command, ...s.args], {
      cwd: s.cwd,
      env: s.env,
      signal: s.signal,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  };
}
