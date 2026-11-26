// w5999: the macOS and Windows CI runners keep their temp files inside the worker root, as machine/runnerUnits.ts (d) does
// for Linux's systemd units (w5834, lothsahn: "under no circumstances should workers write outside of ffw", "And not just
// Windows, Mac and Linux too."). Measured before it: a .NET Runner.Listener or Runner.Worker start leaves
// clr-debug-pipe-<pid>-*-in/out and dotnet-diagnostic-<pid>-*-socket in TMPDIR, on a Mac the per-user /var/folders/.../T/,
// and a Windows job's tools write in %TEMP% (%LOCALAPPDATA%\Temp on C:). ffu #1162 fixed new installs only.
//
// How the runners run (listed read-only, 2026-11-26):
// - macOS (m3: ~/actions-runner, ~/ffu-runner, ~/ffw/ffu-runners/ffu-m3-2): a LaunchAgent each,
//   ~/Library/LaunchAgents/actions.runner.<owner-repo>.<name>.plist (the runner's svc.sh), running <dir>/runsvc.sh, whose
//   node RunnerService.js keeps Runner.Listener alive. The listener's environment is the plist's EnvironmentVariables, read
//   when launchd loads the job: .NET opens its pipes at start, before the listener reads its .env, so only the plist reaches
//   them. Each runner's plist gets TMPDIR (runnerEnvTempDir) and DOTNET_EnableDiagnostics=0 (plutil -replace; the original is
//   kept once under <root>/tmp/runner-env/), and a job launchd loaded without them is reloaded once while its listener is
//   idle: launchctl bootout, then bootstrap. The plist is outside ffw (it is the runner service's own configuration).
// - Windows (LothDesktop: V:\ffw\ffu-runners\ffu-lothdesktop-1, -2; BEAST: its ffu runners): a scheduled task each,
//   `conhost --headless cmd /c cd /d <dir> && run.cmd` (ffu tools/ci-runners/install-ffu-runner.ps1). Runner.Listener reads
//   <dir>\.env into its own environment at start (src/Runner.Listener/Program.cs LoadAndSetEnv, runner 2.338.2: every line in
//   order, so the last one of a key wins), and its workers and their jobs inherit it. So .env gets TEMP, TMP, TMPDIR and
//   DOTNET_EnableDiagnostics=0, and a listener started before .env last changed is relaunched once while idle: it is ended
//   with exit code 2, which run-helper.cmd answers with "retryable error, re-launch runner in 5 seconds" and run.cmd with a
//   new listener in the same task, which reads the new .env. A listener ended that way leaves its GitHub session behind: the
//   new one is refused "A session for this runner already exists" and retries every 30 s for up to 4 minutes, then exits 5
//   and run.cmd stops (MessageListener.cs _sessionConflictRetryLimit). On LothDesktop on 2026-11-02 two such conflicts
//   cleared in 1.5 and 2.5 minutes (ffu-lothdesktop-1/_diag/Runner_20261102-214855-utc.log, -2's Runner_20261102-214156).
//
// Recovery needs nobody (lothsahn's lockout rule): every runner restarted is kept in <root>/tmp/runner-env.json before its
// restart, and until it is seen back for RESTART_SETTLE_MS (past those 4 minutes) the daemon looks each pass: one gone for
// two looks (an unloaded launchd job; no listener for that folder) is started again (launchctl bootstrap; its scheduled task
// or run.cmd, machine/hostGuard.ts runnerRestartScript), every START_EVERY_MS, never while a hold has the machine's runners,
// for up to GIVE_UP_MS. A runner is restarted at most once for a temp folder, also across daemon restarts (the state file);
// never while a worker runs under it, its log says busy, a bench turn or the load gate holds it suspended, or it cooled
// less than COOLDOWN_MS. An operations runner (ff-ops-runner, the deploy route) gets its configuration but is never
// restarted: it takes it at its next start. Every failure is said once and changes nothing else: no agent waits on this.
import fs from 'node:fs';
import path from 'node:path';
import type { RunnerCensus } from './benchRunners.ts';
import { runnerRestartScript } from './hostGuard.ts';
import { COOLDOWN_MS, busySince } from './runnerUnits.ts';

export type EnvPlatform = 'darwin' | 'win32';

export interface EnvRunner {
  /** macOS: the launchd job's label; Windows: the runner folder's name. */
  name: string;
  /** The runner folder (Windows: with backslashes). */
  root: string;
  /** macOS: the LaunchAgent plist that runs it. */
  plist?: string;
}

/** A runner restarted for its temp folder, kept until it is seen back (recovery). */
export interface RestartEntry {
  name: string;
  root: string;
  plist?: string;
  at: number;
  pid: number;
  /** The last time recovery started it again: the settle and first-look clocks count from it (a second exit 5). */
  startedAt?: number;
}

export interface RunnerEnvState {
  /** Runners restarted and not yet seen back for RESTART_SETTLE_MS. */
  restarting: RestartEntry[];
  /** The temp folder each runner was restarted once for: never again for it. */
  done: Record<string, string>;
}

/** Wait this long after a restart before a runner that is not there counts as gone (run-helper.cmd waits 5 s). */
export const FIRST_LOOK_MS = 60_000;
/** A restarted runner seen back this long after its restart is back for good (a session conflict ends it at 4 min). */
export const RESTART_SETTLE_MS = 6 * 60_000;
/** A gone runner is started again at most this often. */
export const START_EVERY_MS = 10 * 60_000;
/** After this the daemon stops starting a runner it restarted, and says so. */
export const GIVE_UP_MS = 24 * 3_600_000;

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
export const sameRoot = (a: string, b: string, platform: EnvPlatform) =>
  platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);

/**
 * A runner's temp folder: <runner folder>/_tmp inside the worker root, else <root>/runner-tmp/<folder name> (m3's
 * ~/actions-runner and ~/ffu-runner sit outside ffw). The folder name, not the launchd label, keeps a Unix socket path in
 * it under macOS's 104 bytes. Undefined with no worker root.
 */
export function runnerEnvTempDir(root: string, workerRoot: string | undefined, platform: EnvPlatform): string | undefined {
  if (!workerRoot) return undefined;
  const r = norm(workerRoot);
  const x = norm(root);
  const inside = platform === 'win32' ? x.toLowerCase().startsWith(`${r.toLowerCase()}/`) : x.startsWith(`${r}/`);
  const out = inside ? `${x}/_tmp` : `${r}/runner-tmp/${path.posix.basename(x)}`;
  return platform === 'win32' ? out.replace(/\//g, '\\') : out;
}

/** The environment a runner gets: Windows' .NET and tools read TMP and TEMP, macOS's TMPDIR. */
export function wantedEnv(tmp: string, platform: EnvPlatform): [string, string][] {
  const tail: [string, string][] = [['DOTNET_EnableDiagnostics', '0']];
  return platform === 'win32' ? [['TEMP', tmp], ['TMP', tmp], ['TMPDIR', tmp], ...tail] : [['TMPDIR', tmp], ...tail];
}

const keyOf = (k: string, platform: EnvPlatform) => (platform === 'win32' ? k.toUpperCase() : k);

/** Whether `have` holds every wanted value (Windows' variable names are not case sensitive). */
export function hasEnv(have: Map<string, string>, want: [string, string][], platform: EnvPlatform): boolean {
  const h = new Map([...have].map(([k, v]) => [keyOf(k, platform), v]));
  return want.every(([k, v]) => h.get(keyOf(k, platform)) === v);
}

/** The values a .env sets, as LoadAndSetEnv reads it: KEY=VALUE lines in order, the last one of a key winning. */
export function envFileValues(text: string | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of (text ?? '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) m.set(line.slice(0, i), line.slice(i + 1));
  }
  return m;
}

/** A .env with the wanted values: the first line of each wanted key rewritten, its later ones dropped, a missing one added. */
export function withEnv(text: string | undefined, want: [string, string][], platform: EnvPlatform): string {
  const eol = text === undefined ? (platform === 'win32' ? '\r\n' : '\n') : text.includes('\r\n') ? '\r\n' : '\n';
  const lines = (text ?? '').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const wanted = new Map(want.map(([k, v]) => [keyOf(k, platform), `${k}=${v}`]));
  const placed = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const i = line.indexOf('=');
    const k = i > 0 ? keyOf(line.slice(0, i), platform) : undefined;
    if (k === undefined || !wanted.has(k)) out.push(line);
    else if (!placed.has(k)) {
      out.push(wanted.get(k)!);
      placed.add(k);
    }
  }
  for (const [k, line] of wanted) if (!placed.has(k)) out.push(line);
  return out.join(eol) + eol;
}

/** The runner a LaunchAgent runs (its plist as `plutil -convert json`): ProgramArguments[0] is <dir>/runsvc.sh, <dir> holds .runner. */
export function plistRunner(json: unknown, file: string, exists: (p: string) => boolean = fs.existsSync): EnvRunner | undefined {
  const j = json as { Label?: unknown; ProgramArguments?: unknown };
  const exe = Array.isArray(j?.ProgramArguments) ? j.ProgramArguments[0] : undefined;
  if (typeof j?.Label !== 'string' || typeof exe !== 'string' || path.posix.basename(exe) !== 'runsvc.sh') return undefined;
  const root = path.posix.dirname(exe);
  return exists(path.posix.join(root, '.runner')) ? { name: j.Label, root, plist: file } : undefined;
}

/** The plist's EnvironmentVariables (string values only). */
export function plistEnv(json: unknown): Map<string, string> {
  const e = (json as { EnvironmentVariables?: unknown })?.EnvironmentVariables;
  const m = new Map<string, string>();
  if (e && typeof e === 'object') for (const [k, v] of Object.entries(e)) if (typeof v === 'string') m.set(k, v);
  return m;
}

/**
 * The environment launchd loaded for a job: the `environment = {` block of `launchctl print gui/<uid>/<label>` (not its
 * "default" or "inherited" ones). Undefined when there is no such block: a runner's plist always sets ACTIONS_RUNNER_SVC,
 * so that is output this cannot read, and nothing is restarted on it.
 */
export function launchctlEnv(print: string | undefined): Map<string, string> | undefined {
  const lines = (print ?? '').split('\n');
  const start = lines.findIndex((l) => /^\tenvironment = \{\s*$/.test(l));
  if (start < 0) return undefined;
  const m = new Map<string, string>();
  for (const l of lines.slice(start + 1)) {
    if (/^\t\}/.test(l)) return m;
    const x = /^\t\t(\S+) => (.*)$/.exec(l);
    if (x) m.set(x[1], x[2]);
  }
  return undefined;
}

export interface RunnerEnvDeps {
  platform: EnvPlatform;
  /** The runners: macOS from ~/Library/LaunchAgents; Windows from the census and <root>/ffu-runners. */
  runners(census: RunnerCensus): Promise<EnvRunner[]>;
  /** The runner's temp folder (runnerEnvTempDir), made; undefined with no worker root. */
  tempDir(r: EnvRunner): string | undefined;
  /** Its configured environment: macOS the plist's EnvironmentVariables, Windows its .env (empty with none); undefined: unreadable. */
  configured(r: EnvRunner): Promise<Map<string, string> | undefined>;
  /** Writes the wanted values into that configuration (the original kept once). */
  configure(r: EnvRunner, want: [string, string][]): Promise<void>;
  /** Whether the running listener has the configured environment; undefined when that cannot be read. */
  current(r: EnvRunner, pid: number, want: [string, string][]): Promise<boolean | undefined>;
  /** Why the runner must not be restarted here (a Windows service), or undefined. */
  unrestartable?(r: EnvRunner, pid: number): Promise<string | undefined>;
  /** Restarts it with its configuration: macOS bootout and bootstrap; Windows its listener ended with exit code 2. */
  restart(r: EnvRunner, pid: number): Promise<void>;
  /** Whether it is there: macOS its job loaded; Windows a listener for its folder in the census. */
  alive(r: EnvRunner, census: RunnerCensus): Promise<boolean>;
  /** Starts a runner that is gone: macOS launchctl bootstrap; Windows its scheduled task or run.cmd. Answers what it did. */
  start(r: EnvRunner): Promise<string>;
  /** A hold has this machine's runners now (machine/loadRunners.ts), or it stopped this one: it is not started. */
  held(r: EnvRunner): boolean;
  /** An operations runner (ff-ops-runner): configured, never restarted. */
  opsRunner(root: string): boolean;
  census(): Promise<RunnerCensus>;
  diag(root: string): string | undefined;
  paused(): Set<number>;
  readState(): RunnerEnvState | undefined;
  writeState(s: RunnerEnvState): void;
  log(text: string): void;
  now(): number;
}

export class RunnerEnv {
  private readonly d: RunnerEnvDeps;
  private ticking = false;
  private said = new Set<string>();
  private last = new Map<string, number>();
  /** Looks in a row a restarted runner was not there. */
  private misses = new Map<string, number>();
  /** Listener pids already seen with the wanted environment: not asked again. */
  private ok = new Set<number>();

  constructor(d: RunnerEnvDeps) {
    this.d = d;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.step();
    } catch (e) {
      this.d.log(`runner env: ${(e as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private sayOnce(key: string, text: string) {
    if (this.said.has(key)) return;
    this.said.add(key);
    this.d.log(`runner env: ${text} (w5999)`);
  }

  private state(): RunnerEnvState {
    const s = this.d.readState();
    return { restarting: Array.isArray(s?.restarting) ? s.restarting : [], done: s?.done && typeof s.done === 'object' ? s.done : {} };
  }

  private save(s: RunnerEnvState) {
    try {
      this.d.writeState(s);
    } catch (e) {
      this.sayOnce('state', `could not write its state (${(e as Error).message})`);
    }
  }

  /** The runners it restarted that are gone are started again (recovery); one back past RESTART_SETTLE_MS is done. */
  private async recover(s: RunnerEnvState, census: RunnerCensus): Promise<boolean> {
    let changed = false;
    const now = this.d.now();
    for (const e of [...s.restarting]) {
      const r: EnvRunner = { name: e.name, root: e.root, ...(e.plist ? { plist: e.plist } : {}) };
      let alive = false;
      try {
        alive = await this.d.alive(r, census);
      } catch (err) {
        this.sayOnce(`${e.name}/alive`, `${e.name}: could not tell whether it runs (${(err as Error).message})`);
        continue;
      }
      const last = Math.max(e.at, e.startedAt ?? 0);
      if (alive) {
        this.misses.delete(e.name);
        if (now - last >= RESTART_SETTLE_MS) {
          s.restarting = s.restarting.filter((x) => x !== e);
          changed = true;
          this.d.log(`runner env: ${e.name} (${e.root}) is back after its restart for its temp folder (w5999)`);
        }
        continue;
      }
      if (now - last < FIRST_LOOK_MS) continue;
      const n = (this.misses.get(e.name) ?? 0) + 1;
      this.misses.set(e.name, n);
      if (n < 2 || this.d.held(r)) continue;
      if (now - e.at > GIVE_UP_MS) {
        s.restarting = s.restarting.filter((x) => x !== e);
        changed = true;
        this.d.log(`runner env: ${e.name} (${e.root}) is still not running ${Math.round((now - e.at) / 3_600_000)} h after its restart for its temp folder: no longer started by this (w5999)`);
        continue;
      }
      if (e.startedAt !== undefined && now - e.startedAt < START_EVERY_MS) continue;
      e.startedAt = now;
      this.misses.delete(e.name);
      changed = true;
      try {
        const how = await this.d.start(r);
        this.d.log(`runner env: ${e.name} (${e.root}) was not running after its restart for its temp folder: started (${how}) (w5999)`);
      } catch (err) {
        this.d.log(`runner env: ${e.name} (${e.root}) was not running after its restart for its temp folder; starting it failed: ${(err as Error).message} (w5999)`);
      }
    }
    return changed;
  }

  private idle(r: EnvRunner, c: RunnerCensus): { pid: number } | undefined {
    const p = this.d.platform;
    const l = c.listeners.find((x) => sameRoot(x.root, r.root, p));
    if (!l || l.busy || c.workers.some((w) => sameRoot(w.root, r.root, p)) || this.d.paused().has(l.pid)) return undefined;
    return busySince(this.d.diag(r.root)) === undefined ? { pid: l.pid } : undefined;
  }

  private async step() {
    const census = await this.d.census();
    const s = this.state();
    let changed = await this.recover(s, census);
    const runners = await this.d.runners(census);
    for (const r of runners) {
      const tmp = (() => {
        try {
          return this.d.tempDir(r);
        } catch (e) {
          this.sayOnce(`${r.name}/tmp`, `${r.name}: could not make its temp folder (${(e as Error).message})`);
          return undefined;
        }
      })();
      if (!tmp) continue;
      const want = wantedEnv(tmp, this.d.platform);
      let have: Map<string, string> | undefined;
      try {
        have = await this.d.configured(r);
      } catch (e) {
        this.sayOnce(`${r.name}/read`, `${r.name} (${r.root}): could not read its configuration (${(e as Error).message})`);
        continue;
      }
      if (!have) continue;
      if (!hasEnv(have, want, this.d.platform)) {
        try {
          await this.d.configure(r, want);
          this.said.delete(`${r.name}/write`);
          this.d.log(`runner env: ${r.name} (${r.root}): wrote ${want.map(([k, v]) => `${k}=${v}`).join(', ')} into ${r.plist ?? '.env'} (w5999)`);
        } catch (e) {
          this.sayOnce(`${r.name}/write`, `${r.name} (${r.root}): could not write its configuration (${(e as Error).message})`);
        }
        continue; // the restart, if one is needed, is the next pass's
      }
      // an idle listener started without it: restarted once
      if (s.done[r.name] === tmp || s.restarting.some((e) => e.name === r.name)) continue;
      const t = this.last.get(r.name);
      if (t !== undefined && this.d.now() - t < COOLDOWN_MS) continue;
      const l = this.idle(r, census);
      if (!l || this.ok.has(l.pid)) continue;
      let cur: boolean | undefined;
      try {
        cur = await this.d.current(r, l.pid, want);
      } catch (e) {
        cur = undefined;
        this.sayOnce(`${r.name}/current`, `${r.name}: could not read its listener's environment (${(e as Error).message}): not restarted for it`);
      }
      if (cur === true) this.ok.add(l.pid);
      if (cur !== false) {
        if (cur === undefined) this.sayOnce(`${r.name}/current`, `${r.name}: could not tell whether listener pid ${l.pid} has its temp folder: not restarted for it`);
        continue;
      }
      if (this.d.opsRunner(r.root)) {
        this.sayOnce(`${r.name}/ops`, `${r.name} (${r.root}) is an operations runner: not restarted, it takes TMPDIR=${tmp} at its next start`);
        continue;
      }
      const why = await this.d.unrestartable?.(r, l.pid);
      if (why) {
        this.sayOnce(`${r.name}/unrestartable`, `${r.name} (${r.root}): ${why}: not restarted for its temp folder`);
        continue;
      }
      // a fresh look just before it: the pass's census can be seconds old (w5884 N1), a bench turn may have paused it
      const fresh = await this.d.census();
      const again = this.idle(r, fresh);
      if (!again || again.pid !== l.pid) continue;
      s.done[r.name] = tmp;
      s.restarting.push({ name: r.name, root: r.root, ...(r.plist ? { plist: r.plist } : {}), at: this.d.now(), pid: l.pid });
      this.save(s); // before the restart: a daemon that dies in it still starts the runner again
      changed = false;
      this.last.set(r.name, this.d.now());
      try {
        await this.d.restart(r, l.pid);
        this.d.log(`runner env: ${r.name} (${r.root}): idle listener pid ${l.pid} started without TMPDIR=${tmp}: restarted once for it (w5999)`);
      } catch (e) {
        this.d.log(`runner env: ${r.name} (${r.root}): restarting idle listener pid ${l.pid} for its temp folder failed: ${(e as Error).message}; started again if it is gone (w5999)`);
      }
    }
    if (changed) this.save(s);
  }
}

/** TerminateProcess(pid, 2) of one process of this user's, as a PowerShell script (exit code 2: run-helper.cmd relaunches). */
export function winRelaunchScript(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 4) throw new Error(`pid ${pid} is not a listener to relaunch`);
  return [
    `Add-Type -TypeDefinition @'`,
    `using System; using System.Runtime.InteropServices;`,
    `public static class FFRelaunch {`,
    `  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint a, bool i, int p);`,
    `  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);`,
    `  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr h, uint code);`,
    `  public static string Run(int pid) {`,
    `    IntPtr h = OpenProcess(0x0001, false, pid);`,
    `    if (h == IntPtr.Zero) return "OpenProcess failed: error " + Marshal.GetLastWin32Error();`,
    `    try { return TerminateProcess(h, 2) ? "" : "TerminateProcess failed: error " + Marshal.GetLastWin32Error(); }`,
    `    finally { CloseHandle(h); }`,
    `  }`,
    `}`,
    `'@`,
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    `if (-not $p -or $p.ProcessName -ne 'Runner.Listener') { [Console]::Error.Write('pid ${pid} is not a Runner.Listener now'); exit 3 }`,
    `$r = [FFRelaunch]::Run(${pid}); if ($r) { [Console]::Error.Write($r); exit 4 }`,
  ].join('\n');
}

/** The UTC start time of one process, as a PowerShell script (Windows' census carries none). */
export function winStartTimeScript(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 4) throw new Error(`pid ${pid} is not a process`);
  return `$p = Get-Process -Id ${pid} -ErrorAction Stop; [Console]::Out.Write($p.StartTime.ToUniversalTime().ToString('o'))`;
}

export interface RunnerEnvOpsInput {
  platform: EnvPlatform;
  /** The worker root (ffw); without one nothing is done. */
  workerRoot: string | undefined;
  home: string;
  uid: number;
  /** Runs a program; rejects with its stderr on a non-zero exit. */
  exec(cmd: string, args: string[]): Promise<string>;
}

export type RunnerEnvOps = Pick<RunnerEnvDeps, 'runners' | 'tempDir' | 'configured' | 'configure' | 'current' | 'unrestartable' | 'restart' | 'alive' | 'start' | 'readState' | 'writeState'>;

export const runnerEnvStateFile = (workerRoot: string) => path.join(workerRoot, 'tmp', 'runner-env.json');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The original, kept once: <worker root>/tmp/runner-env/<name><ext>.orig. */
export function keepOriginal(workerRoot: string, name: string, file: string, ext: string) {
  const dir = path.join(workerRoot, 'tmp', 'runner-env');
  const keep = path.join(dir, `${name.replace(/[^\w.-]/g, '_')}${ext}.orig`);
  if (fs.existsSync(keep) || !fs.existsSync(file)) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(file, keep);
}

/** The real operations on this machine: launchd plists on macOS, .env files and scheduled tasks on Windows. */
export function runnerEnvOps(o: RunnerEnvOpsInput): RunnerEnvOps {
  const { platform, workerRoot } = o;
  const common = {
    tempDir: (r: EnvRunner) => {
      const t = runnerEnvTempDir(r.root, workerRoot, platform);
      if (t) fs.mkdirSync(t, { recursive: true });
      return t;
    },
    readState: () => {
      if (!workerRoot) return undefined;
      try {
        return JSON.parse(fs.readFileSync(runnerEnvStateFile(workerRoot), 'utf8')) as RunnerEnvState;
      } catch {
        return undefined;
      }
    },
    writeState: (s: RunnerEnvState) => {
      if (!workerRoot) return;
      const file = runnerEnvStateFile(workerRoot);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(s));
      fs.renameSync(`${file}.tmp`, file);
    },
  };
  const listens = (r: EnvRunner, c: RunnerCensus) => c.listeners.some((l) => sameRoot(l.root, r.root, platform));
  if (platform === 'darwin') {
    const agents = path.join(o.home, 'Library', 'LaunchAgents');
    const job = (r: EnvRunner) => `gui/${o.uid}/${r.name}`;
    const readPlist = async (file: string) => JSON.parse(await o.exec('plutil', ['-convert', 'json', '-o', '-', file])) as unknown;
    return {
      ...common,
      runners: async () => {
        if (!workerRoot) return [];
        let files: string[] = [];
        try {
          files = fs.readdirSync(agents).filter((f) => f.startsWith('actions.runner.') && f.endsWith('.plist'));
        } catch {
          return [];
        }
        const out: EnvRunner[] = [];
        for (const f of files) {
          const file = path.join(agents, f);
          try {
            const r = plistRunner(await readPlist(file), file);
            if (r) out.push(r);
          } catch {
            // a plist plutil cannot read is not a runner this changes
          }
        }
        return out;
      },
      configured: async (r) => plistEnv(await readPlist(r.plist!)),
      configure: async (r, want) => {
        const plist = r.plist!;
        keepOriginal(workerRoot!, r.name, plist, '.plist');
        const j = (await readPlist(plist)) as { EnvironmentVariables?: unknown };
        if (!j.EnvironmentVariables || typeof j.EnvironmentVariables !== 'object') await o.exec('plutil', ['-insert', 'EnvironmentVariables', '-xml', '<dict/>', plist]);
        for (const [k, v] of want) await o.exec('plutil', ['-replace', `EnvironmentVariables.${k}`, '-string', v, plist]);
      },
      current: async (r, _pid, want) => {
        const env = launchctlEnv(await o.exec('launchctl', ['print', job(r)]).catch(() => undefined));
        return env === undefined ? undefined : hasEnv(env, want, platform);
      },
      // runsvc.sh answers SIGTERM by stopping its listener for good: launchd unloads the job, then loads it from its plist
      restart: async (r) => {
        await o.exec('launchctl', ['bootout', job(r)]);
        let last: unknown;
        for (let i = 0; i < 5; i++) {
          try {
            await o.exec('launchctl', ['bootstrap', `gui/${o.uid}`, r.plist!]);
            return;
          } catch (e) {
            last = e;
            await sleep(3_000);
          }
        }
        throw last as Error;
      },
      alive: async (r, c) => listens(r, c),
      start: async (r) => {
        const loaded = await o.exec('launchctl', ['print', job(r)]).then(
          () => true,
          () => false,
        );
        if (loaded) {
          await o.exec('launchctl', ['kickstart', job(r)]);
          return `launchctl kickstart ${job(r)}`;
        }
        await o.exec('launchctl', ['bootstrap', `gui/${o.uid}`, r.plist!]);
        return `launchctl bootstrap ${r.plist}`;
      },
    };
  }
  // the native path module: these run only in a Windows daemon (and its tests run on every OS)
  const envFile = (r: EnvRunner) => path.join(r.root, '.env');
  const ps = (script: string) => o.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  return {
    ...common,
    runners: async (c) => {
      if (!workerRoot) return [];
      const roots = c.listeners.map((l) => path.normalize(l.root));
      const base = path.join(workerRoot, 'ffu-runners');
      try {
        for (const d of fs.readdirSync(base)) if (fs.existsSync(path.join(base, d, '.runner'))) roots.push(path.join(base, d));
      } catch {
        // no ffu-runners folder here
      }
      const out: EnvRunner[] = [];
      for (const root of roots) if (!out.some((x) => sameRoot(x.root, root, platform))) out.push({ name: path.basename(root), root });
      return out;
    },
    configured: async (r) => {
      try {
        return envFileValues(fs.readFileSync(envFile(r), 'utf8'));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
        throw e;
      }
    },
    configure: async (r, want) => {
      const file = envFile(r);
      keepOriginal(workerRoot!, r.name, file, '.env');
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
      fs.writeFileSync(`${file}.ff-tmp`, withEnv(text, want, platform));
      fs.renameSync(`${file}.ff-tmp`, file);
    },
    // the listener read .env at its start: one started before .env last changed has the old values
    current: async (r, pid) => {
      const started = Date.parse((await ps(winStartTimeScript(pid))).trim());
      if (!Number.isFinite(started)) return undefined;
      return started > fs.statSync(envFile(r)).mtimeMs;
    },
    // config.cmd --runasservice leaves .service: RunnerService.exe runs that listener, not run.cmd's loop
    unrestartable: async (r) => (fs.existsSync(path.join(r.root, '.service')) ? 'it runs as a Windows service, which takes .env at its next start' : undefined),
    restart: async (_r, pid) => {
      await ps(winRelaunchScript(pid));
    },
    alive: async (r, c) => listens(r, c),
    start: async (r) => (await ps(runnerRestartScript(r.root))).trim() || 'started',
  };
}
