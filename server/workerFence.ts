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
import { DAEMON_ONLY_CHILDREN, MEDIUM_ONLY_CHILDREN } from './claudeHome.ts';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { openChildren } from '../machine/lowIntegrity.ts';
import { workerUvToolDir } from '../machine/sharedCaches.ts';
import { projectSlug } from './claudeHome.ts';

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
  /** The root children workers write (lowIntegrity.ts openChildren, w5569); absent: openChildren(root). */
  open?: string[];
  /** w5659: refuse preference writes through cfprefsd too (PREF_RULES); daemon.json `workerPrefFence: true`. */
  prefDeny?: boolean;
}

/** An SBPL string literal. */
const lit = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Inside the root, still read-only for workers: the daemon's folder, the secrets, the root's record, and the Medium agents'
 * Claude Code folder (w5543: settings, plugins and hooks that agents outside the fence load). Not `repo`, the
 * main clone: a sandbox is a git worktree whose git data (index, objects, refs) lives in it, so a fenced commit there
 * failed on `repo/worktrees/<name>/index.lock` (w5333; the Linux lock leaves it writable for the same reason).
 */
export const READ_ONLY_IN_ROOT = { subpaths: ['daemon', 'secrets', ...MEDIUM_ONLY_CHILDREN, ...DAEMON_ONLY_CHILDREN], files: ['root.json'] };

/**
 * w5563: the one conversation a fenced process may write in its Claude home's transcripts. `projects` is
 * `<CLAUDE_CONFIG_DIR>/projects`, resolved; `sid` its Claude Code session id (`--resume` or `--session-id`).
 */
export interface OwnTranscript {
  projects: string;
  sid: string;
}

/** An SBPL regex literal of a path (#"..."): its regex characters escaped. */
const rx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/"/g, '\\"');

/**
 * w5563: every transcript in the agent's Claude home is read-only to it, but its own conversation's: `<sid>.jsonl` in any
 * project folder (a long cwd's folder is named by a hash, a moved sandbox keeps its old one) and its `<sid>/` folder
 * (tool results, subagents' transcripts). Claude Code only appends there (docs/transcript-seal.md); it may not make
 * `memory/` or a new project folder (measured on m5: a resume and a new conversation both ran with the folder read-only and
 * `memory` unmakeable), and the host makes the cwd's project folder first (fenceSpawner).
 */
export function ownTranscriptRules(o: OwnTranscript): string[] {
  const p = rx(o.projects);
  return [
    ";; other conversations' transcripts are read-only (w5563, docs/transcript-seal.md)",
    `(deny file-write* (subpath ${lit(o.projects)}))`,
    `(allow file-write* (regex #"^${p}/[^/]+/${o.sid}\\.jsonl$") (regex #"^${p}/[^/]+/${o.sid}(/|$)"))`,
  ];
}

/**
 * Signals (w5562): a worker may signal only processes of its own fence, itself and everything it started (they inherit
 * its sandbox), so a careless `pkill -f` or `kill` cannot end the daemon, the agent host, a Unity editor the daemon
 * started, another worker or the owner's apps. Signal 0 (a liveness check) is a signal too: to a process outside the
 * fence it answers EPERM, which every liveness check of ours reads as alive (unitySlots.ts isAlive, bench_queue.py,
 * player_slots.py). Signals sent TO the worker (the daemon's stop, the SDK's abort) are not the sandbox's to refuse.
 * `children` as well as `same-sandbox`: a direct child is ours even if it could change its sandbox.
 * No launchd rule: launchd itself refuses job submission from a sandboxed caller (measured on m5, w5562, from inside
 * the fence: `launchctl submit` exit 1 "Operation not permitted", `launchctl bootstrap gui/<uid>` "5: Input/output
 * error", and the job never ran), and that goes through the bootstrap port, not a mach-lookup name a profile could deny.
 */
export const SIGNAL_RULES = [';; signals: only to this fence\'s own processes (w5562)', '(deny signal)', '(allow signal (target self) (target children) (target same-sandbox))'];

/**
 * Preferences (w5659): `defaults write`, NSUserDefaults, CFPreferences and Unity's EditorPrefs and PlayerPrefs reach the
 * plist in ~/Library/Preferences through cfprefsd, which writes it outside the sandbox, so the file rules above never see
 * them: from inside the fence a `defaults write` of a new domain made its plist there (measured on m5). cfprefsd lets a
 * client write when the client may either write preferences or write the plist's own file, so this rule closes it only
 * together with the file deny of ~/Library/Preferences above (measured on m5: a fenced `defaults write` of a new domain
 * exits 1 "Could not write domain" and makes no plist; with this rule alone it is written). Reads still work. A refused
 * EditorPrefs write is silent to Unity: a fenced batch Unity compiled, passed EditMode 31/31 and a PlayMode load test with
 * cfprefsd rejecting 66 of its writes (measured on m5). macOS logs nothing for the sandbox itself; cfprefsd logs each
 * refusal as "rejecting write of key(s) ... from process <pid> (<name>)" (`log show`, from outside the fence).
 */
export const PREF_RULES = [";; preferences through cfprefsd are refused too (w5659, with the file deny of ~/Library/Preferences)", '(deny user-preference-write)'];

export function seatbeltProfile(f: WorkerFence, own?: OwnTranscript): string {
  const home = (p: string) => path.join(f.home, p);
  const extra = (f.extraWritable ?? []).filter((p) => path.isAbsolute(p));
  return [
    '(version 1)',
    '(allow default)',
    ';; Every file write is refused, except below. Later rules win.',
    '(deny file-write*)',
    ';; only the root folders workers write (w5569): a portal, an instances folder or a new root folder stays read-only',
    '(allow file-write*',
    ...(f.open ?? openChildren(f.root)).map((c) => `  (subpath ${lit(path.join(f.root, c))})`),
    ')',
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
    ...(own ? ownTranscriptRules(own) : []),
    ';; inside the root, read-only for workers',
    '(deny file-write*',
    ...READ_ONLY_IN_ROOT.subpaths.map((p) => `  (subpath ${lit(path.join(f.root, p))})`),
    ...READ_ONLY_IN_ROOT.files.map((p) => `  (literal ${lit(path.join(f.root, p))})`),
    ')',
    ...SIGNAL_RULES,
    ...(f.prefDeny ? PREF_RULES : []),
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
export function fenceFor(o: { setting?: string; root?: string; platform?: NodeJS.Platform; home: string; extraWritable?: string[]; workFolders?: (string | undefined)[]; prefDeny?: boolean; exists?: (p: string) => boolean; getconf?: (name: string) => string }): WorkerFence | undefined {
  if (o.setting !== 'seatbelt' || (o.platform ?? process.platform) !== 'darwin' || !o.root) return undefined;
  if (!(o.exists ?? fs.existsSync)(SANDBOX_EXEC)) return undefined;
  const get = o.getconf ?? confstr;
  return {
    kind: 'seatbelt',
    root: real(o.root),
    open: openChildren(o.root, o.workFolders, READ_ONLY_IN_ROOT.subpaths),
    home: real(o.home),
    darwinTemp: real(get('DARWIN_USER_TEMP_DIR')),
    darwinCache: real(get('DARWIN_USER_CACHE_DIR')),
    ...(o.extraWritable?.length ? { extraWritable: o.extraWritable.map(real) } : {}),
    ...(o.prefDeny ? { prefDeny: true } : {}),
  };
}

/**
 * What a fenced agent's environment adds: Claude Code's own temp (task output, its /tmp/cc-socks messaging socket) moves
 * into the root, and the auto-updater, which writes ~/.local/share/claude, is off. TMPPREFIX: zsh writes each here-document
 * to /tmp/zshXXXXXX, which the fence refuses (w5397, m5: "can't create temp file for here document: operation not
 * permitted"); its files go to <root>/tmp/zshXXXXXX instead, and zsh removes each once read. UV_TOOL_DIR (w5693): uvx
 * takes a temp file in uv's tool folder on every run, ~/.local/share/uv/tools by default, which the fence refuses, so the
 * Unity MCP server (`uvx --from mcpforunityserver ...`) died at start; it runs from <root>/cache/uv-tools instead
 * (machine/sharedCaches.ts workerUvToolDir), never the Medium agents' one.
 */
export const fenceEnv = (f: WorkerFence): Record<string, string> => ({ CLAUDE_CODE_TMPDIR: path.join(f.root, 'tmp', 'claude-code'), DISABLE_AUTOUPDATER: '1', TMPPREFIX: path.join(f.root, 'tmp', 'zsh'), UV_TOOL_DIR: workerUvToolDir(f.root) });

/** The argv that runs `command args` inside the fence. */
export const fencedArgv = (f: WorkerFence, command: string, args: string[], own?: OwnTranscript) => [SANDBOX_EXEC, '-p', seatbeltProfile(f, own), command, ...args];

/** The Claude Code session id a claude argv runs (`--resume <id>` or `--session-id <id>`, either form), when it is a safe one. */
export function sessionIdOf(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v = a === '--resume' || a === '--session-id' ? args[i + 1] : /^--(?:resume|session-id)=(.*)$/.exec(a)?.[1];
    if (v !== undefined) return /^[A-Za-z0-9_-]{8,80}$/.test(v) ? v : undefined;
  }
  return undefined;
}

/**
 * w5563: the transcripts this process may write (its own conversation's), when its Claude home is in the root: a home outside
 * it is refused whole by the fence already. The cwd's project folder is made here, outside the fence, under both the cwd's
 * name and its resolved one. A process whose session id the argv does not say gets no rule: it writes no transcript of
 * another conversation's id either way it could find, but AgentSession always passes one (`sessionId` or `resume`).
 */
export function ownTranscriptOf(f: WorkerFence, o: { args: string[]; cwd?: string; env: Record<string, string | undefined> }): OwnTranscript | undefined {
  const sid = sessionIdOf(o.args);
  const home = o.env.CLAUDE_CONFIG_DIR;
  if (!sid || !home || !path.isAbsolute(home)) return undefined;
  const projects = path.join(real(home), 'projects');
  if (!projects.startsWith(f.root + path.sep)) return undefined;
  for (const cwd of new Set(o.cwd ? [o.cwd, real(o.cwd)] : [])) {
    try {
      fs.mkdirSync(path.join(projects, projectSlug(cwd)), { recursive: true });
    } catch {
      // the CLI's write is refused and says so; the conversation's other folders still take it
    }
  }
  return { projects, sid };
}

/**
 * Options.spawnClaudeCodeProcess: the SDK's claude, inside the fence. sandbox-exec execs the command, so the child's pid
 * is claude's own and the SDK's kill and abort reach it. Its stderr's tail is logged when it exits non-zero (a profile
 * the kernel refuses exits 65 before claude starts).
 */
export function fenceSpawner(f: WorkerFence, run: typeof spawn = spawn, log: (line: string) => void = (l) => console.warn(l)) {
  return (o: SpawnOptions): SpawnedProcess => {
    fs.mkdirSync(fenceEnv(f).CLAUDE_CODE_TMPDIR, { recursive: true });
    const [cmd, ...args] = fencedArgv(f, o.command, o.args, ownTranscriptOf(f, o));
    const child: ChildProcess = run(cmd, args, { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, signal: o.signal, stdio: ['pipe', 'pipe', 'pipe'] });
    let tail = '';
    child.stderr?.on('data', (c: Buffer) => (tail = (tail + c.toString()).slice(-2000)));
    child.on('exit', (code) => {
      if (code) log(`worker fence: claude exited ${code}${tail ? `; stderr: ${tail.trim().split('\n').slice(-5).join(' | ')}` : ''}`);
    });
    return child as unknown as SpawnedProcess;
  };
}
