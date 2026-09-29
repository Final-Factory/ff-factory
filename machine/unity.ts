import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../server/proc.ts';
import { DEFAULT_HANG, bridgeInfo, bridgePing, editorVerdict, restartAllowed, type HangThresholds } from '../server/unityHang.ts';
import { closeWindow, decide, decideClose, describeDialog, findClosable, findDialogs, listWindows, parsePsJson, pressButton, sceneFilesUnchanged, type Dialog } from '../server/watchdog.ts';
import { accessibilityStep, axPrompt, axTrusted, closeMacWindow, listMacDialogs, macPermissionProblem, nodeBinary, pressMacButton, sessionAway, sessionState, tccAccessibility, type SessionState } from './macDialogs.ts';

/**
 * The Unity editor of a machine's clone (docs/unity-lifecycle.md), managed by the daemon on the machine: status,
 * start, stop (graceful, then forced) and restart, for the orchestrator and machine workers (the "unity" tool),
 * and an automatic restart of a hung or crashed editor (MacUnityWatch). It only ever touches the editor that
 * has this clone open (and the processes that editor started), never git and never another project's editor.
 * Written for the Macs first (hence the names); a Windows PC (`platform` win32) gets the same, minus App Nap (its
 * dialog watch reads windows through scripts/unity-windows.ps1, as the host's does).
 */

export type UnityPlatform = 'darwin' | 'win32';

export interface Proc {
  pid: number;
  ppid: number;
  cmd: string;
}

export interface UnityDeps {
  /** Every process: pid, parent, full command line. */
  procs(): Promise<Proc[]>;
  kill(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  /** Start the editor detached; its pid (the Windows launch goes through PowerShell, so it may be a promise). */
  launch(bin: string, args: string[], cwd: string): number | Promise<number>;
  exists(p: string): boolean;
  remove(p: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Turn App Nap off for the editor app at `bin` (optional: the real Mac writes NSAppSleepDisabled). */
  noAppNap?(bin: string): Promise<void>;
}

const norm = (p: string) => p.replace(/[\\/]+$/, '');

/** A path as compared on `platform`: Windows paths are case-insensitive and take either slash. */
export const pathKey = (p: string, platform: UnityPlatform = 'darwin') => (platform === 'win32' ? p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : norm(p));

/** The -projectPath of a Unity command line (Hub writes -projectpath), or undefined. */
export function projectPathOf(cmd: string): string | undefined {
  const m = /-projectpath\s+("([^"]+)"|(\S+))/i.exec(cmd);
  return m ? norm(m[2] ?? m[3]) : undefined;
}

/** The Unity editor binary in a command line: Unity.app's on a Mac, Unity.exe on Windows (not "Unity Hub.exe"). */
const isEditorCmd = (cmd: string, platform: UnityPlatform) => (platform === 'win32' ? /[\\/]Unity\.exe"?(\s|$)/i.test(cmd) : /\/Unity\.app\/Contents\/MacOS\/Unity(\s|$)/.test(cmd));

/**
 * The Unity editor with `repo` open: the Unity binary with that project path, not a -batchMode one (its
 * AssetImportWorkers, a command-line build), which has no windows and no bridge and is not the editor.
 */
export function editorsFor(procs: Proc[], repo: string, platform: UnityPlatform = 'darwin'): Proc[] {
  const want = pathKey(repo, platform);
  return procs.filter((p) => {
    if (!isEditorCmd(p.cmd, platform) || /\s-batchmode(\s|$)/i.test(p.cmd)) return false;
    const proj = projectPathOf(p.cmd);
    return proj !== undefined && pathKey(proj, platform) === want;
  });
}

/** A process and everything it started (shader compilers, bee, Unity Helper, a crash reporter it spawned). */
export function treeOf(procs: Proc[], root: number): number[] {
  const out = [root];
  for (let i = 0; i < out.length; i++) for (const p of procs) if (p.ppid === out[i] && !out.includes(p.pid)) out.push(p.pid);
  return out;
}

/**
 * What an editor started that must survive its restart, with everything below it: a game player (any .app
 * other than Unity.app, e.g. the 074 host player launched from the editor), another project's editor (a
 * ParrelSync clone), Unity Hub, and node or claude (the daemon, an agent).
 */
export function spareOnRestart(p: Proc, repo: string, platform: UnityPlatform = 'darwin'): string | undefined {
  if (platform === 'win32') return spareOnRestartWin(p, repo);
  const app = /\/([^/]+)\.app\/Contents\//.exec(p.cmd)?.[1];
  if (app && app !== 'Unity') return app === 'Unity Hub' ? 'Unity Hub' : `the ${app} app`;
  if (/\/Unity\.app\/Contents\/MacOS\/Unity(\s|$)/.test(p.cmd)) {
    const proj = projectPathOf(p.cmd);
    if (proj && proj !== norm(repo)) return `another project's editor (${proj})`;
  }
  if (!/\/Unity\.app\//.test(p.cmd) && /(^|\/)(node|claude)(\s|$)/.test(p.cmd)) return 'node/claude';
  return undefined;
}

/** The program a Windows command line starts: its full path (quoted or not). */
const exeOf = (cmd: string) => (/^\s*"([^"]+)"/.exec(cmd)?.[1] ?? /^\s*(\S+)/.exec(cmd)?.[1] ?? '');

/**
 * spareOnRestart on Windows. Part of the editor: Unity's own helpers (anything in the editor's install, the
 * shader compiler, bee, the ILPP runner, the package manager, the crash handler), what the build writes under
 * the project's Library, and console hosts and shells. Spared: Unity Hub, another project's editor, node or
 * claude, and any other program (a game player such as a build of the game launched from the editor).
 */
function spareOnRestartWin(p: Proc, repo: string): string | undefined {
  const exe = exeOf(p.cmd);
  const name = path.win32.basename(exe);
  if (/^Unity Hub\.exe$/i.test(name)) return 'Unity Hub';
  if (isEditorCmd(p.cmd, 'win32')) {
    const proj = projectPathOf(p.cmd);
    if (proj && pathKey(proj, 'win32') !== pathKey(repo, 'win32')) return `another project's editor (${proj})`;
    return undefined;
  }
  if (/^(node|claude)(\.exe)?$/i.test(name)) return 'node/claude';
  const key = pathKey(exe, 'win32');
  if (/\/unity\/hub\/editor\/|\/editor\/data\//.test(key)) return undefined;
  if (key.startsWith(`${pathKey(repo, 'win32')}/library/`)) return undefined;
  if (/^(conhost|cmd|dotnet|mono|UnityShaderCompiler|UnityCrashHandler(32|64)?|bee_backend|Unity\.ILPP\.Runner|Unity\.Licensing\.Client|UnityPackageManager|UnityAutoQuitter)(\.exe)?$/i.test(name)) return undefined;
  return name ? `${name.replace(/\.exe$/i, '')} (a program it started)` : undefined;
}

/** The editor and the processes it started that go with it (treeOf minus spareOnRestart and what those started), and what is spared. */
export function editorTree(procs: Proc[], root: number, repo: string, platform: UnityPlatform = 'darwin'): { kill: number[]; spared: string[] } {
  const kill = [root];
  const spared: string[] = [];
  for (let i = 0; i < kill.length; i++) {
    for (const p of procs) {
      if (p.ppid !== kill[i] || kill.includes(p.pid)) continue;
      const why = spareOnRestart(p, repo, platform);
      if (why) spared.push(`${why} (pid ${p.pid})`);
      else kill.push(p.pid);
    }
  }
  return { kill, spared };
}

/**
 * Crash reporters left for this project (their parent editor may be gone already). On Windows only Unity's bug
 * reporter counts: UnityCrashHandler64 runs beside every editor there (docs/unity-lifecycle.md).
 */
export function reportersFor(procs: Proc[], repo: string, platform: UnityPlatform = 'darwin'): Proc[] {
  if (platform === 'win32') return procs.filter((p) => /Unity ?Bug ?Reporter/i.test(p.cmd) && pathKey(p.cmd, 'win32').includes(pathKey(repo, 'win32')));
  return procs.filter((p) => /Unity ?Bug ?Reporter|UnityCrashHandler/i.test(p.cmd) && p.cmd.includes(norm(repo)));
}

/** Unity Hub's settings folder: %APPDATA%\UnityHub on Windows, ~/Library/Application Support/UnityHub on a Mac. */
export function hubConfigDir(platform: UnityPlatform, env: NodeJS.ProcessEnv, home: string): string | undefined {
  if (platform === 'win32') return env.APPDATA ? path.win32.join(env.APPDATA, 'UnityHub') : undefined;
  return path.posix.join(home, 'Library', 'Application Support', 'UnityHub');
}

/**
 * Unity Hub's editor folders, each holding <version>/...: the install location chosen in the Hub
 * (secondaryInstallPath.json, a JSON string; e.g. C:\Program Files\Unity\Editor), then the defaults (Program Files
 * on Windows, /Applications and ~/Applications on a Mac).
 */
export function hubEditorDirs(platform: UnityPlatform, env: NodeJS.ProcessEnv, home: string, read: (p: string) => string): string[] {
  const dirs =
    platform === 'win32'
      ? [env.ProgramFiles, env.ProgramW6432, 'C:\\Program Files'].filter((d): d is string => !!d).map((d) => path.win32.join(d, 'Unity', 'Hub', 'Editor'))
      : ['/Applications/Unity/Hub/Editor', path.posix.join(home, 'Applications/Unity/Hub/Editor')];
  const hub = hubConfigDir(platform, env, home);
  if (hub) {
    try {
      const custom = JSON.parse(read((platform === 'win32' ? path.win32 : path.posix).join(hub, 'secondaryInstallPath.json')));
      if (typeof custom === 'string' && custom.trim()) dirs.unshift(custom.trim());
    } catch {
      // no custom location
    }
  }
  return [...new Set(dirs)];
}

/**
 * The editors Unity Hub lists in its settings folder (editors-v2.json, the older editors.json: installs it was
 * pointed at, wherever they are), as version and executable. Read leniently: any entry with a `version` and a
 * `location` (a path or a list of paths; on a Mac the .app or the binary in it).
 */
export function hubListedEditors(platform: UnityPlatform, env: NodeJS.ProcessEnv, home: string, read: (p: string) => string): { version: string; bin: string }[] {
  const hub = hubConfigDir(platform, env, home);
  if (!hub) return [];
  const P = platform === 'win32' ? path.win32 : path.posix;
  const out: { version: string; bin: string }[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    const locs = typeof o.location === 'string' ? [o.location] : Array.isArray(o.location) ? o.location.filter((l): l is string => typeof l === 'string') : [];
    if (typeof o.version === 'string' && locs.length) {
      for (const l of locs) out.push({ version: o.version, bin: platform === 'darwin' && /\.app\/?$/.test(l) ? P.join(l, 'Contents/MacOS/Unity') : l });
    } else Object.values(o).forEach(visit);
  };
  for (const f of ['editors-v2.json', 'editors.json']) {
    try {
      visit(JSON.parse(read(P.join(hub, f))));
    } catch {
      // not there, or not JSON
    }
  }
  return out;
}

/** Where a machine keeps Unity when not (only) where Unity Hub says (add_machine unity_editor_root / unity_path). */
export interface UnityLocation {
  /** A folder of editor versions, <root>/<version>/..., searched first. */
  editorRoot?: string;
  /** The editor executable itself: used as is, whatever the project's version. */
  unityPath?: string;
}

/**
 * The editor binary: the machine's unity_path, else the project's Unity version (ProjectSettings/ProjectVersion.txt)
 * in its unity_editor_root, then the editors Unity Hub lists, then the Hub's install folders (its chosen one first).
 * A folder of versions holds <version>\Editor\Unity.exe on Windows, <version>/Unity.app on a Mac.
 */
export function editorBinary(repo: string, exists: (p: string) => boolean, read: (p: string) => string, home = os.homedir(), platform: UnityPlatform = 'darwin', env: NodeJS.ProcessEnv = process.env, where: UnityLocation = {}): string {
  if (where.unityPath) {
    if (exists(where.unityPath)) return where.unityPath;
    throw new Error(`the machine's unity_path ${where.unityPath} does not exist`);
  }
  let version = '';
  try {
    version = /m_EditorVersion:\s*(\S+)/.exec(read(path.posix.join(repo, 'ProjectSettings', 'ProjectVersion.txt')))?.[1] ?? '';
  } catch {
    // no version file
  }
  if (!version) throw new Error(`no Unity version in ${repo}/ProjectSettings/ProjectVersion.txt`);
  const inBase = (base: string) => (platform === 'win32' ? path.win32.join(base, version, 'Editor', 'Unity.exe') : path.posix.join(base, version, 'Unity.app/Contents/MacOS/Unity'));
  const bases = [...(where.editorRoot ? [where.editorRoot] : []), ...hubEditorDirs(platform, env, home, read)];
  const listed = hubListedEditors(platform, env, home, read).filter((e) => e.version === version).map((e) => e.bin);
  for (const bin of [...(where.editorRoot ? [inBase(where.editorRoot)] : []), ...listed, ...bases.map(inBase)]) if (exists(bin)) return bin;
  throw new Error(`Unity ${version} is not installed in ${bases.join(' or ')}${listed.length ? ` (Unity Hub lists it at ${listed.join(', ')})` : ''} (install it with Unity Hub, or give the machine's unity_editor_root or unity_path)`);
}

export class MacUnity {
  readonly repo: string;
  readonly platform: UnityPlatform;
  /** The editor's own log (-logFile), for a sandbox editor (machine/sandboxes.ts); unset: Unity's default Editor.log. */
  readonly logFile?: string;
  private readonly d: UnityDeps;
  private readonly bin: () => string;

  constructor(repo: string, deps?: UnityDeps, bin?: () => string, platform: UnityPlatform = 'darwin', where: UnityLocation = {}, opts: { logFile?: string } = {}) {
    this.repo = norm(repo);
    this.platform = platform;
    this.logFile = opts.logFile;
    this.d = deps ?? realDeps(platform);
    this.bin = bin ?? (() => editorBinary(this.repo, fs.existsSync, (p) => fs.readFileSync(p, 'utf8'), os.homedir(), platform, process.env, where));
  }

  /** This platform's view of the processes (editorsFor, reportersFor, editorTree with it). */
  editors(procs: Proc[]) {
    return editorsFor(procs, this.repo, this.platform);
  }

  reporters(procs: Proc[]) {
    return reportersFor(procs, this.repo, this.platform);
  }

  private get lock() {
    return (this.platform === 'win32' ? path.win32 : path.posix).join(this.repo, 'Temp', 'UnityLockfile');
  }

  /** Every process now (for the watch). */
  procsNow(): Promise<Proc[]> {
    return this.d.procs();
  }

  async status(): Promise<string> {
    const procs = await this.d.procs();
    const eds = this.editors(procs);
    const reporters = this.reporters(procs);
    const lock = this.lock;
    const parts = [eds.length ? `running: pid ${eds.map((e) => e.pid).join(', ')}` : 'not running', `project ${this.repo}`];
    if (reporters.length) parts.push(`crash reporter open (pid ${reporters.map((r) => r.pid).join(', ')}): the editor crashed`);
    if (!eds.length && this.d.exists(lock)) parts.push('a stale Temp/UnityLockfile is left (start removes it)');
    return parts.join('; ');
  }

  /**
   * Stop the editor of this clone. Graceful first (SIGTERM, up to `graceMs`), then SIGKILL of the editor and
   * everything it started; `force` skips the graceful step (a frozen editor ignores it anyway). Crash reporters
   * for this project go too, and the lock file an editor killed this way leaves behind is removed.
   */
  async stop(opts: { force?: boolean; graceMs?: number } = {}): Promise<string> {
    let procs = await this.d.procs();
    const eds = this.editors(procs);
    const notes: string[] = [];
    if (!eds.length) notes.push('no editor was running');
    if (eds.length && !opts.force) {
      for (const e of eds) this.d.kill(e.pid, 'SIGTERM');
      const until = this.d.now() + (opts.graceMs ?? 30_000);
      while (this.d.now() < until) {
        await this.d.sleep(1000);
        procs = await this.d.procs();
        if (!this.editors(procs).length) break;
      }
      if (!this.editors(procs).length) notes.push(`quit gracefully (pid ${eds.map((e) => e.pid).join(', ')})`);
    }
    const left = this.editors(procs);
    if (left.length) {
      const trees = left.map((e) => editorTree(procs, e.pid, this.repo, this.platform));
      const pids = [...new Set(trees.flatMap((t) => t.kill))];
      const spared = trees.flatMap((t) => t.spared);
      for (const pid of pids) this.d.kill(pid, 'SIGKILL');
      notes.push(`${opts.force ? 'force-killed' : 'did not quit in time; force-killed'} pid ${left.map((e) => e.pid).join(', ')} and ${pids.length - left.length} process(es) it started`);
      if (spared.length) notes.push(`left running what it started that is not part of it: ${spared.join(', ')}`);
      for (let i = 0; i < 15; i++) {
        await this.d.sleep(1000);
        procs = await this.d.procs();
        if (!this.editors(procs).length) break;
      }
    }
    const reporters = this.reporters(procs);
    for (const r of reporters) this.d.kill(r.pid, 'SIGKILL');
    if (reporters.length) notes.push(`closed ${reporters.length} crash reporter(s)`);
    procs = await this.d.procs();
    if (this.editors(procs).length) throw new Error(`the editor is still running after SIGKILL (${notes.join('; ')})`);
    const lock = this.lock;
    if (this.d.exists(lock)) {
      this.d.remove(lock);
      notes.push('removed the stale Temp/UnityLockfile');
    }
    return `Stopped: ${notes.join('; ')}.`;
  }

  /** Start the editor for this clone (nothing if one already has it open). */
  async start(): Promise<string> {
    const procs = await this.d.procs();
    const eds = this.editors(procs);
    if (eds.length) return `Already running (pid ${eds.map((e) => e.pid).join(', ')}).`;
    const lock = this.lock;
    if (this.d.exists(lock)) this.d.remove(lock); // no editor has the project open, so the lock is stale
    const bin = this.bin();
    await this.noAppNap(bin);
    const pid = await this.d.launch(bin, ['-projectPath', this.repo, ...(this.logFile ? ['-logFile', this.logFile] : [])], this.repo);
    for (let i = 0; i < 10; i++) {
      await this.d.sleep(1000);
      if (this.editors(await this.d.procs()).length) break;
    }
    return `Started ${bin} (pid ${pid}). The Unity MCP bridge comes up once the project has loaded (a minute or more); wait for it before Unity MCP calls.`;
  }

  /**
   * macOS App Nap throttles an editor in the background (or with the display asleep): its main thread, and so
   * the bridge ping, may then answer only after long delays, which read as a hang. Turned off for Unity's
   * app (by its own bundle id) before every launch, and by the daemon at start for the next one. Best effort.
   */
  async noAppNap(bin?: string): Promise<void> {
    try {
      await this.d.noAppNap?.(bin ?? this.bin());
    } catch {
      // not fatal: the watch also tolerates a throttled editor
    }
  }

  async restart(opts: { force?: boolean } = {}): Promise<string> {
    const stopped = await this.stop(opts);
    return `${stopped} ${await this.start()}`;
  }
}

/**
 * A Windows process listing (Win32_Process as JSON: pid, parent, full command line). The CIM query costs a
 * second or two, which the watch's 30 s look can afford. Exported for tests (the parser).
 */
export function parseWinProcs(json: string, log?: (line: string) => void): Proc[] {
  // Tolerant of raw control characters and of an unreadable entry (server/watchdog.ts parsePsJson).
  const rows = parsePsJson<{ pid: number; ppid: number; cmd?: string | null; name?: string | null }>(json, 'the Windows process list', log);
  return rows.map((r) => ({ pid: Number(r.pid), ppid: Number(r.ppid), cmd: r.cmd || r.name || '' }));
}

// Control characters other than tab and line breaks are dropped from names and command lines before ConvertTo-Json,
// which in Windows PowerShell 5.1 lets them through raw (parsePsJson copes if one still does).
const WIN_PROCS =
  "$bad = '[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f]'; Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = ([string]$_.Name) -replace $bad, ''; cmd = ([string]$_.CommandLine) -replace $bad, '' } } | ConvertTo-Json -Compress";

/** The PowerShell that starts the editor so that it is nobody's child (it outlives a daemon restart) and prints its pid. */
export function winLaunchScript(bin: string, args: string[], cwd: string): string {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  // Start-Process joins -ArgumentList with spaces and quotes nothing: each argument is quoted here.
  const argLine = args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
  return `(Start-Process -FilePath ${q(bin)} -ArgumentList ${q(argLine)} -WorkingDirectory ${q(cwd)} -PassThru).Id`;
}

/** The real machine: ps, signals and a detached launch on a Mac; CIM, taskkill and Start-Process on Windows. */
export function realDeps(platform: UnityPlatform = 'darwin'): UnityDeps {
  const base = realDepsMac();
  if (platform !== 'win32') return base;
  const ps = (script: string, timeoutMs: number) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs });
  return {
    ...base,
    procs: async () => {
      const r = await ps(WIN_PROCS, 60_000);
      if (r.code !== 0) throw new Error(`listing processes failed (${r.code}): ${r.stderr.trim().slice(0, 200)}`);
      return parseWinProcs(r.stdout);
    },
    // taskkill without /F asks the program to close (the editor may save and quit); /F ends it at once.
    kill: (pid, signal) => {
      try {
        execFileSync('taskkill.exe', ['/PID', String(pid), ...(signal === 'SIGKILL' ? ['/F'] : [])], { stdio: 'ignore', windowsHide: true, timeout: 15_000 });
      } catch {
        // already gone
      }
    },
    launch: async (bin, args, cwd) => {
      const r = await ps(winLaunchScript(bin, args, cwd), 60_000);
      const pid = Number(r.stdout.trim().split(/\s+/).pop());
      if (r.code !== 0 || !Number.isFinite(pid) || pid <= 0) throw new Error(`could not start ${bin}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
      return pid;
    },
    noAppNap: undefined,
  };
}

function realDepsMac(): UnityDeps {
  return {
    procs: async () => {
      const r = await run('ps', ['-axo', 'pid=,ppid=,command='], { timeoutMs: 15_000 });
      return r.stdout
        .split('\n')
        .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }));
    },
    kill: (pid, signal) => {
      try {
        process.kill(pid, signal);
      } catch {
        // already gone
      }
    },
    launch: (bin, args, cwd) => {
      const child = spawn(bin, args, { cwd, detached: true, stdio: 'ignore' });
      child.unref();
      if (!child.pid) throw new Error(`could not start ${bin}`);
      return child.pid;
    },
    exists: (p) => fs.existsSync(p),
    remove: (p) => fs.rmSync(p, { force: true }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    noAppNap: async (bin) => {
      // .../Unity.app/Contents/MacOS/Unity -> the app's bundle id (Unity has used com.unity3d.UnityEditor5.x for years).
      const app = bin.replace(/\/Contents\/MacOS\/[^/]+$/, '');
      const id = (await run('defaults', ['read', `${app}/Contents/Info`, 'CFBundleIdentifier'], { timeoutMs: 10_000 })).stdout.trim() || 'com.unity3d.UnityEditor5.x';
      await run('defaults', ['write', id, 'NSAppSleepDisabled', '-bool', 'YES'], { timeoutMs: 10_000 });
    },
  };
}

// ---------------------------------------------------------------- the watch: hangs and crashes, restarted

export interface WatchDeps {
  /** Size and last-write time of the editor log, or undefined when there is none. */
  logStat(): { size: number; mtimeMs: number } | undefined;
  /** The last few KB of the editor log (crash evidence after the editor is gone). */
  logTail(): string;
  bridge(): { port?: number; reloading?: boolean };
  ping(port: number, timeoutMs?: number): Promise<boolean>;
  now(): number;
  /** The main display is asleep (pmset displaysleepnow, the lid, the screensaver's sleep): App Nap then throttles everything. */
  displayAsleep(): Promise<boolean>;
  /**
   * The editor's dialogs, the windows to close (server/watchdog.ts CLOSABLE_WINDOWS) and its main window title
   * (machine/macDialogs.ts on a Mac, scripts/unity-windows.ps1 on Windows); throws the probe's error.
   */
  listDialogs(pid: number): Promise<{ dialogs: Dialog[]; closable?: Dialog[]; mainTitle?: string; windows?: number }>;
  pressButton(pid: number, d: Dialog, button: string): Promise<boolean>;
  /** Close a window listDialogs found closable, as its close button does. Returns whether it closed. */
  closeWindow?(pid: number, d: Dialog): Promise<boolean>;
  /** No *.unity file in the clone has uncommitted changes (git status, read-only). */
  sceneFilesClean(): Promise<boolean>;
  /** The node binary the privacy settings must name. */
  nodePath(): string;
  /** The console session: locked, someone else's, display asleep (macDialogs.sessionState). */
  sessionState(): Promise<SessionState>;
  /** Accessibility really granted (AXIsProcessTrusted); undefined when it cannot be told. */
  axTrusted(): Promise<boolean | undefined>;
  /** The daemon log (each failed look, with the session state and AXIsProcessTrusted, for diagnosis). */
  log?(line: string): void;
  /** The TCC Accessibility entry of the node binary ('on'/'off'/'missing'; undefined: unreadable). */
  tccEntry?(): Promise<'on' | 'off' | 'missing' | undefined>;
  /** Show macOS's own Accessibility prompt on the Mac's screen. */
  axPrompt?(): Promise<void>;
}

/** What Unity writes to its log when it crashes (macOS: signals and the native crash reporter; Windows: its stack trace dump). */
export const CRASH_MARKERS = /Crash!!!|Received signal SIG(SEGV|BUS|ABRT|ILL|FPE)|Native Crash Reporting|Obtained \d+ stack frames|=+ OUTPUTTING STACK TRACE =+/;

export const MAC_EDITOR_LOG = path.join(os.homedir(), 'Library', 'Logs', 'Unity', 'Editor.log');

/**
 * An editor's dialogs and windows to close on Windows (scripts/unity-windows.ps1, as the host's watchdog reads them),
 * and its main window title: Unity's own window (UnityContainerWndClass) whose title names Unity.
 */
export async function listWinDialogs(pid: number): Promise<{ dialogs: Dialog[]; closable: Dialog[]; mainTitle?: string; windows: number }> {
  const wins = await listWindows([pid]);
  const own = wins.filter((w) => w.pid === pid && w.class === 'UnityContainerWndClass');
  const main = own.find((w) => /\bUnity\b/.test(w.title)) ?? own[0];
  return { dialogs: findDialogs(wins), closable: findClosable(wins), mainTitle: main?.title, windows: wins.length };
}

/** The editor log Unity writes by default: ~/Library/Logs/Unity on a Mac, %LOCALAPPDATA%\Unity\Editor on Windows. */
export function editorLogPath(platform: UnityPlatform, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  if (platform === 'win32') return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'Unity', 'Editor', 'Editor.log');
  return MAC_EDITOR_LOG;
}

/**
 * Watches the editor of a machine's clone every `everyMs` (the daemon starts it): an editor judged hung by
 * editorVerdict (server/unityHang.ts: the bridge silent and the log silent for long, a crash reporter) is
 * restarted; one that vanished is started again only when there is crash evidence (a crash reporter, crash
 * lines at the end of its log), never when someone simply quit it. At most `max` automatic restarts per
 * `windowMinutes`; then it reports once and leaves the editor alone until the window has passed.
 */
export class MacUnityWatch {
  private readonly u: MacUnity;
  private readonly d: WatchDeps;
  private readonly report: (text: string, restarted: boolean) => void;
  private readonly opts: { max: number; windowMinutes: number; hang: HangThresholds };
  private pid = 0;
  private bridgeUp = false;
  private bridgeFailingSince?: number;
  private logSize = -1;
  private logGrewAt = 0;
  private expectedUntil = 0;
  private restarts: { at: string }[] = [];
  private gaveUpAt = 0;
  private busy = false;
  /** The watch launched the current editor itself (a restart): only then does a startup stall count. */
  private launchedByUs = false;
  /** Dialogs open at the last look, and what the watch did about each. */
  private open: { d: Dialog; state: 'pressed' | 'blocked' | 'new'; since: number; why?: string }[] = [];
  /** Buttons pressed recently (the rate limits of decide), newest last. */
  private dismissed: { at: string; title: string; button: string }[] = [];
  /** Dialogs already reported, by title and text: once per appearance. */
  private reported = new Set<string>();
  /** The macOS permission the dialog watch lacks (the one-time step), if any. */
  private permission?: string;
  /** Why the dialog watch is paused (the screen is locked, the display asleep), if it is. */
  private paused?: string;
  /** When each kind of notice was last sent: none more than once a day. */
  private readonly noticed = new Map<string, number>();
  /** Failed looks in a row with the screen awake and unlocked: a permission notice needs 3 across 15 minutes. */
  private failStreak?: { first: number; count: number };
  /** A dialog rule asked for a fresh editor (decide's `restart`, e.g. the licensing "Connection Lost" coming back). */
  private dialogRestart?: string;

  constructor(u: MacUnity, report: (text: string, restarted: boolean) => void, deps: Partial<WatchDeps> = {}, opts: Partial<{ max: number; windowMinutes: number; hang: HangThresholds }> = {}) {
    this.u = u;
    this.report = report;
    this.opts = { max: 3, windowMinutes: 30, hang: DEFAULT_HANG, ...opts };
    const log = u.logFile ?? editorLogPath(u.platform);
    const mac = u.platform !== 'win32';
    this.d = {
      logStat: () => {
        try {
          const s = fs.statSync(log);
          return { size: s.size, mtimeMs: s.mtimeMs };
        } catch {
          return undefined;
        }
      },
      logTail: () => {
        try {
          const fd = fs.openSync(log, 'r');
          try {
            const size = fs.fstatSync(fd).size;
            const n = Math.min(size, 16 * 1024);
            const buf = Buffer.alloc(n);
            fs.readSync(fd, buf, 0, n, size - n);
            return buf.toString('utf8');
          } finally {
            fs.closeSync(fd);
          }
        } catch {
          return '';
        }
      },
      bridge: () => bridgeInfo(u.repo),
      ping: (port, timeoutMs) => bridgePing(port, timeoutMs),
      now: () => Date.now(),
      displayAsleep: async () => {
        if (process.platform !== 'darwin') return false;
        const r = await run('osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("CoreGraphics"); $.CGDisplayIsAsleep($.CGMainDisplayID())'], { timeoutMs: 15_000 });
        return r.code === 0 && /^(true|1)$/.test(r.stdout.trim());
      },
      // The dialog watch reads windows through macOS's System Events on a Mac, scripts/unity-windows.ps1 on Windows.
      listDialogs: (pid) => (mac ? listMacDialogs(pid) : listWinDialogs(pid)),
      pressButton: (pid, d, button) => (mac ? pressMacButton(pid, d, button) : pressButton(pid, d.hwnd, button)),
      closeWindow: (pid, d) => (mac ? closeMacWindow(pid, d) : closeWindow(pid, d.hwnd, d.title)),
      sceneFilesClean: () => sceneFilesUnchanged(u.repo),
      nodePath: () => nodeBinary(),
      sessionState: () => sessionState(),
      axTrusted: () => axTrusted(),
      log: (line) => console.log(new Date().toISOString(), line),
      tccEntry: mac ? () => tccAccessibility(nodeBinary()) : undefined,
      axPrompt: mac ? () => axPrompt() : undefined,
      ...deps,
    };
  }

  /** The editor's pid at the last look (undefined: none running). */
  get editorPid(): number | undefined {
    return this.pid || undefined;
  }

  /** A stop or restart asked for through the tool: the editor going away is not a crash. */
  expectExit(ms = 5 * 60_000) {
    this.expectedUntil = this.d.now() + ms;
  }

  /** One look. Returns what it did (for tests); never throws. */
  async tick(): Promise<'ok' | 'restarted' | 'gave-up' | 'skipped'> {
    if (this.busy) return 'skipped';
    this.busy = true;
    try {
      return await this.look();
    } catch (e) {
      this.report(`Unity watch on this machine failed: ${(e as Error).message}`, false);
      return 'ok';
    } finally {
      this.busy = false;
    }
  }

  private async look(): Promise<'ok' | 'restarted' | 'gave-up'> {
    const now = this.d.now();
    const procs = await this.u.procsNow();
    const eds = this.u.editors(procs);
    const st = this.d.logStat();
    if (st && st.size !== this.logSize) {
      if (this.logSize >= 0 || !this.logGrewAt) this.logGrewAt = st.mtimeMs;
      this.logSize = st.size;
    }
    if (!eds.length) {
      const had = this.pid;
      this.pid = 0;
      this.bridgeUp = false;
      this.bridgeFailingSince = undefined;
      if (!had || now < this.expectedUntil) return 'ok';
      const evidence = this.u.reporters(procs).length ? 'its crash reporter is open' : CRASH_MARKERS.test(this.d.logTail()) ? 'its log ends in a crash' : '';
      if (!evidence) return 'ok'; // quit by someone: leave it closed
      return this.restart(`the editor crashed (${evidence})`, now);
    }
    const pid = eds[0].pid;
    if (pid !== this.pid) {
      this.pid = pid;
      this.bridgeUp = false;
      this.bridgeFailingSince = undefined;
      this.logGrewAt = Math.max(this.logGrewAt, now);
    }
    const dialogOpen = await this.dialogs(pid, now);
    if (this.dialogRestart) {
      const why = this.dialogRestart;
      this.dialogRestart = undefined;
      return this.restart(`the editor keeps showing a dialog: ${why}`, now);
    }
    const b = this.d.bridge();
    // A quick ping first; when it fails, one long one (60 s): a throttled or idle editor gets to it, a frozen
    // one does not. With the display asleep a silent bridge proves nothing (App Nap), so its clock restarts.
    let ok = b.port ? await this.d.ping(b.port) : false;
    if (!ok && b.port && this.bridgeUp) ok = await this.d.ping(b.port, 60_000);
    const asleep = !ok && this.bridgeUp ? await this.d.displayAsleep().catch(() => false) : false;
    if (ok) {
      this.bridgeUp = true;
      this.launchedByUs = false;
      this.bridgeFailingSince = undefined;
    } else if (asleep) this.bridgeFailingSince = undefined;
    else if (this.bridgeUp && this.bridgeFailingSince === undefined) this.bridgeFailingSince = now;
    // A silent bridge counts only once it has answered for this editor (an editor running without the bridge,
    // or before it is up, is never judged by it); a startup stall only for an editor the watch launched.
    const v = editorVerdict(
      {
        alive: true,
        crashReporter: this.u.reporters(procs).length > 0,
        phase: this.launchedByUs && !this.bridgeUp ? 'starting' : 'running',
        dialog: dialogOpen,
        bridgeFailingSince: this.bridgeFailingSince,
        reloading: b.reloading,
        logGrewAt: this.logGrewAt,
      },
      now,
      this.opts.hang,
    );
    if (v.kind === 'ok') return 'ok';
    return this.restart(`the editor ${v.kind === 'crashed' ? 'crashed' : 'hung'}: ${v.why}`, now);
  }

  /**
   * The dialog watchdog on this Mac (docs/unity-dialogs.md): the same rule table as on the host. A known
   * dialog with a safe answer is pressed; one that needs a person, or an unknown one still there on the next
   * look, is reported once. Returns whether a dialog is open (a dialog is never a hang).
   */
  private async dialogs(pid: number, now: number): Promise<boolean> {
    let seen: { dialogs: Dialog[]; closable?: Dialog[]; mainTitle?: string; windows?: number };
    try {
      seen = await this.d.listDialogs(pid);
      // Only a look that saw the editor's windows proves anything (none: System Events did not know the process).
      if (seen.windows !== 0) {
        if (this.permission) this.notice('restored', now, "Unity dialog watch on this machine can see the editor's windows again.");
        this.permission = this.paused = this.failStreak = undefined;
      }
    } catch (e) {
      await this.cannotSee((e as Error).message, now, "read Unity's dialogs");
      return this.open.length > 0;
    }
    const key = (d: Dialog) => `${d.title}\n${d.text}`;
    const before = new Map(this.open.map((o) => [key(o.d), o]));
    const open: typeof this.open = [];
    // Windows to close (the FMOD Setup Wizard): closed like their title bar's X, unless they keep coming back.
    const closable = seen.closable ?? [];
    for (const d of closable) {
      const k = key(d);
      const prev = before.get(k);
      const v = decideClose(d, this.dismissed, now);
      if ('close' in v && this.d.closeWindow) {
        let closed = false;
        try {
          closed = await this.d.closeWindow(pid, d);
        } catch (e) {
          await this.cannotSee((e as Error).message, now, "close Unity's windows");
        }
        if (closed) {
          this.answered(d, 'Close', now);
          this.reported.delete(k);
          continue;
        }
      }
      const why = 'why' in v ? v.why : 'closing it did not work';
      open.push({ d, state: 'blocked', since: prev?.since ?? now, why });
      if (!this.reported.has(k)) {
        this.reported.add(k);
        const advice = (d as Dialog & { closable?: { advice: string } }).closable?.advice;
        this.report(`Unity on this machine shows "${d.title}" and it was left open: ${why}.${advice ? ` ${advice}` : ''}`, false);
      }
    }
    let sceneFilesClean: boolean | undefined;
    for (const d of seen.dialogs) {
      if (closable.some((c) => c.hwnd === d.hwnd)) continue;
      const k = key(d);
      const prev = before.get(k);
      const a = d.known?.action;
      if (a?.kind === 'dismiss' && a.onlyIf && sceneFilesClean === undefined) sceneFilesClean = await this.d.sceneFilesClean().catch(() => false);
      const v = decide(d, {
        autoDismiss: true,
        recent: this.dismissed,
        nowMs: now,
        // No bridge check of open scenes here: the scene files on disk are the measure (as on the host without one).
        scenesClean: sceneFilesClean,
        sceneFilesClean,
        editorTitle: seen.mainTitle,
      });
      if ('restart' in v) {
        this.dialogRestart = v.why;
        open.push({ d, state: 'blocked', since: prev?.since ?? now, why: v.why });
        continue;
      }
      if ('click' in v) {
        let pressed = false;
        try {
          pressed = await this.d.pressButton(pid, d, v.click);
        } catch (e) {
          await this.cannotSee((e as Error).message, now, "press Unity's buttons");
        }
        if (pressed) {
          this.answered(d, v.click, now);
          this.reported.delete(k);
          open.push({ d, state: 'pressed', since: prev?.since ?? now });
          continue;
        }
      }
      // Unknown dialogs are reported only if still there on the next look (many close by themselves).
      const block = d.known || prev;
      const why = d.known?.advice ?? ('why' in v ? v.why : undefined);
      open.push({ d, state: block ? 'blocked' : 'new', since: prev?.since ?? now, why });
      if (block && !this.reported.has(k)) {
        this.reported.add(k);
        this.report(`Unity on this machine is waiting on a dialog: ${describeDialog(d)} [${d.buttons.join(' / ')}]${why ? `. ${why}` : ''}`, false);
      }
    }
    // A dialog that closed may come back later and deserves a new report then.
    for (const k of [...this.reported]) if (!open.some((o) => key(o.d) === k)) this.reported.delete(k);
    this.open = open.filter((o) => o.state !== 'pressed');
    return this.open.length > 0;
  }

  /** A dialog answered, or a window closed, automatically: kept for the rate limits and the status, and logged. */
  private answered(d: Dialog, button: string, now: number) {
    this.dismissed = [...this.dismissed, { at: new Date(now).toISOString(), title: d.title, button }].slice(-40);
    const what = d.buttons.length ? `dismissed "${d.title}" with "${button}"` : `closed "${d.title}"`;
    this.d.log?.(`unity ${(this.u.platform === 'win32' ? path.win32 : path.posix).basename(this.u.repo)}: ${what}`);
  }

  /**
   * System Events failed. A locked screen, another user at the console or a sleeping display make it fail in
   * ways that look like a missing permission, so those pause the watch (one notice); a missing Accessibility
   * permission is reported only when AXIsProcessTrusted agrees. Each notice at most once an hour.
   */
  private async cannotSee(msg: string, now: number, what: string) {
    const session = await this.d.sessionState().catch(() => ({}));
    const away = sessionAway(session);
    const step = away ? undefined : macPermissionProblem(msg, this.d.nodePath());
    const trusted = step ? await this.d.axTrusted().catch(() => undefined) : undefined;
    this.d.log?.(`dialog watch: could not ${what} (${msg.replace(/\s+/g, ' ').slice(0, 160)}); session ${JSON.stringify(session)}; AXIsProcessTrusted ${trusted ?? 'not asked'}`);
    if (away) {
      this.paused = away;
      this.notice('paused', now, `Unity dialog watch on this machine is paused: ${away}. It resumes by itself when someone is back at the screen.`);
      return;
    }
    if (!step || trusted === true) return; // not a permission error, or granted: a passing failure
    // A real, lasting loss only: 3 failed looks in a row across at least 15 minutes, screen awake and unlocked.
    const f = (this.failStreak ??= { first: now, count: 0 });
    f.count++;
    if (f.count < 3 || now - f.first < 15 * 60_000) return;
    // As exact as the TCC entry lets us be, and macOS's own prompt on the screen (both at most once a day).
    const accessibility = /Accessibility access/.test(step);
    const entry = accessibility ? await this.d.tccEntry?.().catch(() => undefined) : undefined;
    const exact = accessibility ? accessibilityStep(this.d.nodePath(), entry) : step;
    this.permission = exact;
    if (this.notice('permission', now, `Unity dialog watch on this machine cannot ${what}: ${exact}${accessibility && this.d.axPrompt ? ' macOS also shows its own Accessibility prompt on the Mac\'s screen now.' : ''}`)) {
      if (accessibility) await this.d.axPrompt?.().catch(() => undefined);
    }
  }

  /** Send a notice, unless the same kind went out within the day. Returns whether it was sent. */
  private notice(kind: string, now: number, text: string): boolean {
    if (now - (this.noticed.get(kind) ?? -Infinity) < 24 * 3_600_000) return false;
    this.noticed.set(kind, now);
    this.report(text, false);
    return true;
  }

  /** Lines for the unity status: dialogs waiting, the permission step, recent automatic answers. */
  describe(): string {
    const now = this.d.now();
    const lines: string[] = [];
    for (const o of this.open) lines.push(`${o.state === 'blocked' ? 'blocked on a dialog' : 'dialog (checking)'}: ${describeDialog(o.d)} [${o.d.buttons.join(' / ')}], for ${Math.round((now - o.since) / 60_000)} min${o.why ? `; ${o.why}` : ''}`);
    if (this.paused) lines.push(`dialog watch paused: ${this.paused}`);
    else if (this.permission) lines.push(`dialog watch off: ${this.permission}`);
    const recent = this.dismissed.filter((x) => now - Date.parse(x.at) < 3_600_000).slice(-5);
    if (recent.length) lines.push(`auto-answered in the last hour: ${recent.map((x) => `"${x.title.slice(0, 60)}" -> ${x.button} (${Math.round((now - Date.parse(x.at)) / 60_000)} min ago)`).join('; ')}`);
    return lines.join('\n');
  }

  private async restart(why: string, now: number): Promise<'restarted' | 'gave-up'> {
    this.restarts = this.restarts.filter((r) => now - Date.parse(r.at) < this.opts.windowMinutes * 60_000);
    if (!restartAllowed(this.restarts, now, this.opts.max, this.opts.windowMinutes)) {
      if (now - this.gaveUpAt > this.opts.windowMinutes * 60_000) {
        this.gaveUpAt = now;
        this.report(`Unity on this machine ${why}, but it was already restarted ${this.opts.max} times in ${this.opts.windowMinutes} min; leaving it for a person (the unity tool still restarts it).`, false);
      }
      return 'gave-up';
    }
    this.restarts.push({ at: new Date(now).toISOString() });
    this.expectExit();
    let text: string;
    try {
      text = await this.u.restart({ force: true });
    } catch (e) {
      this.report(`Unity on this machine ${why}; restarting it failed: ${(e as Error).message}`, false);
      return 'restarted';
    }
    this.pid = 0;
    this.bridgeUp = false;
    this.launchedByUs = true;
    this.bridgeFailingSince = undefined;
    this.logGrewAt = now;
    this.report(`Unity on this machine ${why}; restarted it automatically (${this.restarts.length} in the last ${this.opts.windowMinutes} min). ${text}`, true);
    return 'restarted';
  }
}
