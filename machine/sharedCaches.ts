import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MEDIUM_CACHE_CHILD } from '../server/claudeHome.ts';

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
 * The daemon's and Medium agents' own uv cache, <root>/cache-medium/uv (w5565, item 5 of the w5451 audit): they run uvx
 * (the Unity MCP server) and `uv run --with ...` from it, so it sits where no worker fence lets a worker write, and
 * sandbox agents keep workerUvCacheDir (daemon.ts runSpec).
 */
export const mediumUvCacheDir = (root: string) => path.join(root, MEDIUM_CACHE_CHILD, 'uv');

/**
 * The daemon's own UV_CACHE_DIR at start (w5565): the Medium cache, also in place of the workers' one a daemon started by
 * an older one may have carried over; one daemon.json names (any other folder) stays. Undefined when it is already right.
 */
export function mediumUvCacheFor(env: Record<string, string | undefined>, root: string): string | undefined {
  const cur = env.UV_CACHE_DIR;
  if (cur && path.resolve(cur) !== path.resolve(workerUvCacheDir(root))) return undefined;
  return mediumUvCacheDir(root);
}

/**
 * uv's tool folder (UV_TOOL_DIR, default ~/.local/share/uv/tools, %APPDATA%\uv\tools on Windows), split the way w5565
 * split the cache (w5693). `uvx` takes a temp file there on every run (uv 0.11.27: "Could not create temporary file ...
 * at path ~/.local/share/uv/tools/.tmpXXXX"), and no worker fence lets a worker write the person's home, so on m5 every
 * Seatbelt-fenced sandbox agent's Unity MCP server (`uvx --from mcpforunityserver ...`) exited at start: UnityMCP
 * CONNECTION_CLOSED. Opening the home folder to workers is no fix: the daemon and Medium agents run uvx from it too, so a
 * worker could plant a tool there that runs outside the fence. So workers get <root>/cache/uv-tools, which every fence
 * already opens (the `cache` child), and the daemon and Medium agents <root>/cache-medium/uv-tools, which none does.
 */
export const workerUvToolDir = (root: string) => path.join(sharedCacheDir(root), 'uv-tools');
export const mediumUvToolDir = (root: string) => path.join(root, MEDIUM_CACHE_CHILD, 'uv-tools');

/**
 * The daemon's own UV_TOOL_DIR at start (w5693), as mediumUvCacheFor: unset or the workers' one moves to the Medium
 * folder; one daemon.json names (any other folder) stays. Undefined when there is nothing to change.
 */
export function mediumUvToolFor(env: Record<string, string | undefined>, root: string): string | undefined {
  const cur = env.UV_TOOL_DIR;
  if (cur && path.resolve(cur) !== path.resolve(workerUvToolDir(root))) return undefined;
  return mediumUvToolDir(root);
}

/**
 * Sets the daemon's UV_TOOL_DIR to the Medium tool folder once it is made (w5693). The fallback, so a machine never loses
 * its daemon's or Medium agents' uvx over it: when the folder cannot be made, UV_TOOL_DIR stays as it was (uv's own
 * default, what every daemon used before w5693) and the answer is the warning to log. Undefined when nothing was to do.
 */
export function applyMediumUvToolDir(env: Record<string, string | undefined>, root: string, mkdir: (dir: string) => void = (d) => fs.mkdirSync(d, { recursive: true })): string | undefined {
  const dir = mediumUvToolFor(env, root);
  if (!dir) return undefined;
  try {
    mkdir(dir);
  } catch (e) {
    return `uv tool folder: could not make ${dir} (${(e as Error).message}); the daemon and Medium agents keep ${env.UV_TOOL_DIR ? env.UV_TOOL_DIR : "uv's own default"} (w5693)`;
  }
  env.UV_TOOL_DIR = dir;
  return `uv tool folder: ${dir} for the daemon and Medium agents; sandbox agents use ${workerUvToolDir(root)} (w5693)`;
}

/**
 * What a sandbox agent's environment adds (w5565): the workers' uv cache in place of the daemon's Medium one; w5693: and
 * the workers' uv tool folder in place of the Medium one, or of uv's default in the person's home (unset), which the
 * fence refuses. One daemon.json names (any other folder) stays.
 */
export function sandboxUvEnv(env: Record<string, string | undefined>, root: string | undefined): Record<string, string> {
  if (!root) return {};
  const same = (a: string, b: string) => path.resolve(a) === path.resolve(b);
  const out: Record<string, string> = {};
  if (env.UV_CACHE_DIR && same(env.UV_CACHE_DIR, mediumUvCacheDir(root))) out.UV_CACHE_DIR = workerUvCacheDir(root);
  if (!env.UV_TOOL_DIR || same(env.UV_TOOL_DIR, mediumUvToolDir(root))) out.UV_TOOL_DIR = workerUvToolDir(root);
  return out;
}
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
 * The machine's cargo home inside the install folder (w5501): the crates registry, its index and git checkouts every ffu
 * slot and every worker's cargo shares. Before it, BEAST's agents used the person's `~/.cargo` on C:, where a worker under
 * the Windows Low-integrity fence cannot write: a `cargo fetch` of a crate not yet downloaded failed with "Access is denied
 * (os error 5)" (measured 2026-11-24, w5499). `cache` is a root child, so every fence lets a worker write it: Windows labels
 * it Low with (OI)(CI) and what is made in it inherits Low (lowIntegrity.ts lowTargets), and Seatbelt and Landlock open
 * it with the other WORKER_CHILDREN (lowIntegrity.ts openChildren, w5569).
 */
export const workerCargoHomeDir = (root: string) => path.join(sharedCacheDir(root), 'cargo');
/** Root children a cargo home already set there may not stay in: the daemon's and the secrets (no worker writes them) and the CI runners' (Medium on Windows, lowIntegrity.ts CI_CHILDREN). */
const CARGO_HOME_NOT_UNDER = ['daemon', 'secrets', 'ffu-runners'];

/**
 * The CARGO_HOME the daemon gives its agents, and the old one to seed it from. A CARGO_HOME already inside the root and
 * writable for a worker stays (LothDesktop's `V:/ffw/tools/cargo`, set in its environment); anything else (unset, so
 * cargo's `~/.cargo`, or a folder outside the root) moves to `<root>/cache/cargo`, seeded from the old one. Exported for tests.
 */
export function workerCargoHome(root: string, env: NodeJS.ProcessEnv, home: string, p: typeof path = path, exists: (f: string) => boolean = fs.existsSync): { home: string; seedFrom?: string } {
  const now = env.CARGO_HOME?.trim();
  if (now) {
    const rel = p.relative(p.resolve(root), p.resolve(now));
    const first = rel.split(/[\\/]/)[0]?.toLowerCase() ?? '';
    // w5717: `tools` is Medium on Windows and a Low worker cannot make a new folder in it, so a cargo home there stays
    // only while it is there; once gone it moves to `<root>/cache/cargo` like any other.
    const gone = first === 'tools' && !exists(p.resolve(now));
    if (rel && !rel.startsWith('..') && !p.isAbsolute(rel) && !CARGO_HOME_NOT_UNDER.includes(first) && !gone) return { home: p.resolve(now) };
  }
  const to = p.join(root, 'cache', 'cargo');
  const from = now ? p.resolve(now) : p.join(home, '.cargo');
  return p.resolve(from).toLowerCase() === p.resolve(to).toLowerCase() ? { home: to } : { home: to, seedFrom: from };
}

/** What a seed copies from the old cargo home: the registry's index and downloaded crates, git dependencies' bare clones, and its config. Not `bin` (the person's installed tools, found on PATH where they are), `registry/src` (unpacked again from the cache), nor `credentials*` (a login). */
export const CARGO_SEED_PIECES = [['registry', 'index'], ['registry', 'cache'], ['git', 'db'], ['config.toml'], ['config']];

/**
 * Seeds a new cargo home from the old one (w5501), so the first build after the move downloads nothing: each piece of
 * CARGO_SEED_PIECES that the old home has and the new one lacks is copied into `<to>/.seed` and renamed into place, so
 * cargo never sees half a piece (a worker's cargo that made a piece first keeps its own; the copy is dropped). Reads the
 * old home only: nothing there is written, moved or deleted. Never throws; answers a line for the daemon's log.
 */
export async function seedCargoHome(from: string, to: string, o: { cp?: (a: string, b: string) => Promise<void> } = {}): Promise<string> {
  const cp = o.cp ?? ((a: string, b: string) => fs.promises.cp(a, b, { recursive: true, errorOnExist: false, force: false, preserveTimestamps: true }));
  const holds = (a: string, b: string) => {
    const x = path.relative(path.resolve(a), path.resolve(b));
    return x === '' || (!x.startsWith('..') && !path.isAbsolute(x));
  };
  if (holds(from, to) || holds(to, from)) return `cargo home: not seeding ${to} from ${from}: one holds the other`;
  const done: string[] = [];
  const failed: string[] = [];
  const stage = path.join(to, '.seed');
  for (const piece of CARGO_SEED_PIECES) {
    const src = path.join(from, ...piece);
    const dst = path.join(to, ...piece);
    const name = piece.join('/');
    try {
      if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
      const tmp = path.join(stage, piece.join('-'));
      await fs.promises.rm(tmp, { recursive: true, force: true });
      await fs.promises.mkdir(stage, { recursive: true });
      await cp(src, tmp);
      await fs.promises.mkdir(path.dirname(dst), { recursive: true });
      if (fs.existsSync(dst)) await fs.promises.rm(tmp, { recursive: true, force: true });
      else {
        await fs.promises.rename(tmp, dst);
        done.push(name);
      }
    } catch (e) {
      failed.push(`${name} (${(e as Error).message.slice(0, 160)})`);
    }
  }
  await fs.promises.rm(stage, { recursive: true, force: true }).catch(() => undefined);
  if (!done.length && !failed.length) return `cargo home: ${to} (nothing to seed from ${from})`;
  return `cargo home: ${to}${done.length ? `, seeded ${done.join(', ')} from ${from}` : ''}${failed.length ? `; could not copy ${failed.join('; ')} (cargo downloads them)` : ''}`;
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
 * it did, in a line for the log, or undefined when the server is not an offline uvx one. `agentEnv` is what the agents'
 * environment changes (`for` names them in the line): a Low agent's APPDATA and LOCALAPPDATA move into the root
 * (lowIntegrity.ts lowEnv), so uv finds no managed Python there, picks another one from PATH and needs other packages, and
 * a cache warmed under the daemon's own APPDATA still had no Unity MCP bridge for them (BEAST, w5402).
 */
export async function warmUvCache(command: string, runs: { offline: string[]; online: string[] } | undefined, cacheDir: string, run: (bin: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ error?: string }>, agentEnv: Record<string, string> = {}, forWhom = 'agents', trust?: { root: string; appDir: string }): Promise<string | undefined> {
  if (!runs) return undefined;
  // w5542: the entry may come from <root>/claude/.claude.json, which workers can write, and this runs at the daemon's level:
  // never a uvx or a --from package inside the worker root (outside the daemon's folder).
  const planted = trust && [command, ...runs.online].find((a) => workerWritable(a.replace(/^(git\+)?file:\/\//, ''), trust.root, trust.appDir));
  if (planted) return `unity mcp: did not warm the uv cache${forWhom === 'agents' ? '' : ` for ${forWhom}`}: ${planted} is in a folder workers can write (w5542)`;
  const env: NodeJS.ProcessEnv = { ...process.env, ...agentEnv, UV_CACHE_DIR: cacheDir };
  // A Low agent's APPDATA is inside the root: its uv.toml is a worker's file, so the daemon's run reads no uv config.
  if (trust && Object.values(agentEnv).some((v) => workerWritable(v, trust.root, trust.appDir))) env.UV_NO_CONFIG = '1';
  const tag = forWhom === 'agents' ? '' : ` for ${forWhom}`;
  if (!(await run(command, runs.offline, env)).error) return `unity mcp: its package is in ${cacheDir}${tag}`;
  const online = await run(command, runs.online, env);
  return online.error ? `unity mcp: could not fill ${cacheDir} with its package${tag}, so ${forWhom} here get no Unity MCP bridge: ${online.error.slice(0, 300)}` : `unity mcp: filled ${cacheDir} with its package${tag}`;
}

/** w5542: whether `p` is an absolute path inside the worker root and outside the daemon's folder (where workers can write). */
export function workerWritable(p: string, root: string, appDir: string): boolean {
  const P = /^[A-Za-z]:[\\/]|^\\\\/.test(root) ? path.win32 : path.posix;
  if (!P.isAbsolute(p)) return false;
  const inside = (dir: string) => {
    const fold = (x: string) => (P === path.win32 ? x.toLowerCase() : x);
    const rel = P.relative(fold(P.resolve(dir)), fold(P.resolve(p)));
    return rel === '' || (!!rel && !rel.startsWith('..') && !P.isAbsolute(rel));
  };
  return inside(root) && !inside(appDir);
}

/** runQuiet with an environment. */
export function runQuietEnv(bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = UV_PRUNE_TIMEOUT_MS): Promise<{ out: string; error?: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, env, maxBuffer: 16 * 1024 * 1024 }, (e, stdout, stderr) => {
      resolve({ out: `${stdout ?? ''}\n${stderr ?? ''}`, ...(e ? { error: String(stderr || e.message).trim() } : {}) });
    });
  });
}
