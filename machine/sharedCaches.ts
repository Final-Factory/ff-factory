import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The machine's shared caches inside the worker install folder (w5281). Before it, every `uv run --with pillow ...` the
 * worker prompt prescribes filled the user's own uv cache (`~/.cache/uv`, 36.9 GB on m5 on 2026-11-23: 64 cached
 * environments, 62 of them older than 14 days, and 19.5 GB of archives), and the game's determinism audits wrote
 * `DeterminismAudit` (5.2 GB) into the game's data folder: both outside the folder, where no agent and no clean-up may delete.
 * The daemon puts these in its own environment (rootEnv), so every agent, editor, player and batch run it starts inherits them.
 */
export const sharedCacheDir = (root: string) => path.join(root, 'cache');
export const workerUvCacheDir = (root: string) => path.join(sharedCacheDir(root), 'uv');
/**
 * Read by the game (FF_DETERMINISM_AUDIT_DIR, NetworkDeterminismAuditRetention.AuditRoot) and the audit scripts in place of
 * `<game data>/DeterminismAudit`. No clean-up pass deletes in it (server/cleanup.ts PROTECTED_SEGMENTS: an `audit` segment is
 * never removed); the game's own retention keeps it to 40 entries and 10 GB.
 */
export const workerDeterminismAuditDir = (root: string) => path.join(sharedCacheDir(root), 'determinism-audit');

/**
 * The other tools' caches, each by the variable its own docs give (w5297, lothsahn: "under no circumstances should workers
 * write outside of ffw"). Without them a worker's `pip`, `npx`, Playwright, Unity's Package Manager and Asset Store
 * downloads, `dotnet` and every XDG-following tool wrote into the person's home folder. Caches only: nothing here holds a
 * login, a licence or a setting a person made, so a fresh folder costs one download. Basis, all sourced:
 * - UPM_CACHE_ROOT, ASSETSTORE_CACHE_PATH: Unity manual, "upm config cache" and "Customize the asset package cache
 *   location" (the variable beats the Preferences window and the user config file).
 * - PIP_CACHE_DIR, npm_config_cache, NUGET_PACKAGES, DOTNET_CLI_HOME, PLAYWRIGHT_BROWSERS_PATH: each tool's own docs.
 * - XDG_CACHE_HOME (macOS and Linux): the XDG base directory spec; uv, pip, gh, Mesa's shader cache and Unity's Linux
 *   editor cache follow it. Not XDG_CONFIG_HOME or XDG_DATA_HOME: Unity's Linux licence and gh's login live there.
 * - GH_NO_UPDATE_NOTIFIER: gh writes its update check's state.yml under the home folder; with a token in GH_TOKEN it writes
 *   nothing else (gh help environment).
 * Exported for tests (server/outsideWrites.test.ts lists every path variable and fails on one outside the root).
 */
export function workerToolCacheEnv(root: string, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const c = (...p: string[]) => path.join(sharedCacheDir(root), ...p);
  return {
    PIP_CACHE_DIR: c('pip'),
    npm_config_cache: c('npm'),
    UPM_CACHE_ROOT: c('upm'),
    ASSETSTORE_CACHE_PATH: c('asset-store'),
    NUGET_PACKAGES: c('nuget', 'packages'),
    DOTNET_CLI_HOME: c('dotnet'),
    PLAYWRIGHT_BROWSERS_PATH: c('ms-playwright'),
    ...(platform === 'win32' ? {} : { XDG_CACHE_HOME: c('xdg') }),
    GH_NO_UPDATE_NOTIFIER: '1',
  };
}

/**
 * Where a Unity editor the daemon starts keeps its temp files on Windows (w5297): `<root>/tmp/unity` in place of the
 * person's `%LOCALAPPDATA%\Temp` (the editor's crash folders, Bee's and the shader compiler's scratch). Windows only:
 * there Unity's licensing client talks over a named pipe, not a file in the temp folder; on macOS and Linux its socket's
 * place was not checked, so their editors keep the system temp (an exception in docs/worker-root.md 2.6). Empty without a root.
 */
export function editorTempEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Record<string, string> {
  if (platform !== 'win32' || !env.FF_WORKER_ROOT) return {};
  const t = path.join(env.FF_WORKER_ROOT, 'tmp', 'unity');
  return { TMP: t, TEMP: t };
}

/**
 * A batch Unity run under `unity-slot run` that names no `-logFile` wrote the person's own Editor.log
 * (`%LOCALAPPDATA%\Unity\Editor`, `~/Library/Logs/Unity`, `~/.config/unity3d`), over the one their own editor keeps (w5297).
 * Such a run gets `-logFile <TMPDIR>/unity-<label>-<time>.log`, the worker's own temp folder; anything else is left as given.
 * Undefined when nothing is added.
 */
export function batchUnityLogFile(rest: string[], env: NodeJS.ProcessEnv, label: string, now = new Date()): string | undefined {
  const [cmd = '', ...args] = rest;
  const base = cmd.replace(/\\/g, '/').split('/').pop() ?? '';
  if (!/^unity(\.exe)?$/i.test(base)) return undefined;
  if (!args.some((a) => /^-batchmode$/i.test(a)) || args.some((a) => /^-logfile$/i.test(a))) return undefined;
  const dir = env.TMPDIR || env.TEMP || env.TMP || (env.FF_WORKER_ROOT ? path.join(env.FF_WORKER_ROOT, 'tmp') : undefined);
  if (!dir) return undefined;
  const slug = label.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'run';
  return path.join(dir, `unity-${slug}-${now.toISOString().replace(/[-:.]/g, '').slice(0, 15)}.log`);
}

/** A normal prune this often; below the soft threshold, this often instead. */
export const UV_PRUNE_EVERY_HOURS = 24;
export const UV_PRUNE_LOW_EVERY_HOURS = 1;
/**
 * `uv cache prune` waits while another uv process reads the cache (its in-use check; never `--force`, which would pull files
 * from under a running `uv run`). A prune still waiting after this is ended and tried again at the next turn.
 */
export const UV_PRUNE_TIMEOUT_MS = 15 * 60_000;

/** Where uv may be when the daemon's PATH (a launchd or service PATH) lacks it: PATH first, then the installers' places. */
export function uvCandidates(env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform): string[] {
  const exe = platform === 'win32' ? 'uv.exe' : 'uv';
  const P = platform === 'win32' ? path.win32 : path.posix;
  const sep = platform === 'win32' ? ';' : ':';
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const onPath = (env[pathKey] ?? '').split(sep).filter(Boolean).map((d) => P.join(d, exe));
  const extra =
    platform === 'win32'
      ? [P.join(home, '.local', 'bin', exe), P.join(home, '.cargo', 'bin', exe), ...(env.LOCALAPPDATA ? [P.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', exe)] : [])]
      : [P.join(home, '.local', 'bin', exe), P.join(home, '.cargo', 'bin', exe), '/opt/homebrew/bin/uv', '/usr/local/bin/uv', '/usr/bin/uv'];
  return [...new Set([...onPath, ...extra])];
}

export function findUv(env: NodeJS.ProcessEnv = process.env, home = os.homedir(), platform: NodeJS.Platform = process.platform, exists = (p: string) => fs.existsSync(p)): string | undefined {
  return uvCandidates(env, home, platform).find((p) => exists(p));
}

/** The bytes `uv cache prune` says it removed ("Removed 67 files (527.2KiB)"), 0 when it removed nothing. */
export function prunedBytes(out: string): number {
  const m = /Removed\s+[\d,]+\s+files?\s+\(([\d.]+)\s*([KMGT]?i?B)\)/i.exec(out);
  if (!m) return 0;
  const unit = m[2]!.toUpperCase();
  const pow = ({ B: 0, KIB: 1, KB: 1, MIB: 2, MB: 2, GIB: 3, GB: 3, TIB: 4, TB: 4 } as Record<string, number>)[unit] ?? 0;
  return Math.round(Number(m[1]) * 1024 ** pow);
}

export interface UvPruneDeps {
  dir: string;
  uv(): string | undefined;
  run(uv: string, args: string[], timeoutMs: number): Promise<{ out: string; error?: string }>;
  log(line: string): void;
  now?: () => number;
}

/** One `uv cache prune` of the machine's shared uv cache at a time, daily (hourly while space is low), never blocking a pass. */
export class UvCachePruner {
  private lastAt = 0;
  private running?: Promise<number | undefined>;
  private readonly d: UvPruneDeps;
  constructor(d: UvPruneDeps) {
    this.d = d;
  }

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  due(low: boolean): boolean {
    if (this.running) return false;
    const every = (low ? UV_PRUNE_LOW_EVERY_HOURS : UV_PRUNE_EVERY_HOURS) * 3_600_000;
    return this.now() - this.lastAt >= every;
  }

  /** Starts a prune when one is due and returns it (the bytes freed, undefined when it did not run); the caller need not wait. */
  maybe(low: boolean): Promise<number | undefined> | undefined {
    if (!this.due(low)) return undefined;
    // No cache folder yet is not a prune: the next pass looks again (w5281: m5's first pass after the deploy ran seconds
    // before the first uv run made the folder, and the day's slot went with it).
    if (!fs.existsSync(this.d.dir)) return undefined;
    this.lastAt = this.now();
    const uv = this.d.uv();
    if (!uv) {
      this.d.log(`uv cache prune: no uv found (PATH, ~/.local/bin, ~/.cargo/bin, Homebrew); ${this.d.dir} not pruned`);
      return undefined;
    }
    const p = this.d
      .run(uv, ['cache', 'prune', '--cache-dir', this.d.dir], UV_PRUNE_TIMEOUT_MS)
      .then(({ out, error }) => {
        if (error) {
          this.d.log(`uv cache prune of ${this.d.dir}: ${error.slice(0, 200)}`);
          return undefined;
        }
        const bytes = prunedBytes(out);
        this.d.log(`uv cache prune of ${this.d.dir}: freed ${(bytes / 2 ** 30).toFixed(2)} GB`);
        return bytes;
      })
      .finally(() => {
        this.running = undefined;
      });
    this.running = p;
    return p;
  }
}

/** Runs a command with a timeout, low and hidden; the error text when it failed or timed out. */
export function runQuiet(bin: string, args: string[], timeoutMs: number): Promise<{ out: string; error?: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (e, stdout, stderr) => {
      const out = `${stdout ?? ''}\n${stderr ?? ''}`;
      if (e) resolve({ out, error: (e as NodeJS.ErrnoException & { killed?: boolean }).killed ? `still waiting after ${Math.round(timeoutMs / 60_000)} min (another uv process holds the cache); tried again next turn` : String(stderr || e.message).trim() });
      else resolve({ out });
    });
  });
}

/**
 * Fills `cacheDir` with the Unity MCP server's package when it is not there yet (machine/unityMcp.ts uvWarmRuns); what
 * it did, in a line for the log, or undefined when the server is not an offline uvx one.
 */
export async function warmUvCache(command: string, runs: { offline: string[]; online: string[] } | undefined, cacheDir: string, run: (bin: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ error?: string }>): Promise<string | undefined> {
  if (!runs) return undefined;
  const env = { ...process.env, UV_CACHE_DIR: cacheDir };
  if (!(await run(command, runs.offline, env)).error) return `unity mcp: its package is in ${cacheDir}`;
  const online = await run(command, runs.online, env);
  return online.error ? `unity mcp: could not fill ${cacheDir} with its package, so agents here get no Unity MCP bridge: ${online.error.slice(0, 300)}` : `unity mcp: filled ${cacheDir} with its package`;
}

/** runQuiet with an environment. */
export function runQuietEnv(bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = UV_PRUNE_TIMEOUT_MS): Promise<{ out: string; error?: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, env, maxBuffer: 16 * 1024 * 1024 }, (e, stdout, stderr) => {
      resolve({ out: `${stdout ?? ''}\n${stderr ?? ''}`, ...(e ? { error: String(stderr || e.message).trim() } : {}) });
    });
  });
}
