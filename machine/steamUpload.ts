/**
 * The daemon's side of steam_upload (w5551, docs/steam-upload.md): the urgent release lane's Steam login check and upload,
 * run here with the Steam build account's credential, which the portal sends with the job and no worker holds.
 *
 * The portal decided the upload is the caller's own release and the live branch the one it names (server/steamUpload.ts).
 * Here: one job at a time; the run folders must be inside the caller's sandbox or temp folder; the players are copied into
 * `<root>/steam/staging` (a folder no worker writes or reads), refusing links, so nothing the worker does after the check
 * changes what is uploaded; ffbox's ffrelease-check.py checks each copy; ffbox's ffsteam.py uploads it, from a checkout of
 * ffbox in `<root>/steam/ffbox` that no worker can write. A version's app is uploaded once (`<root>/steam/uploads.json`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { FromDaemon, ToDaemon } from '../server/machineProtocol.ts';
import { addSecretValues, redactSecrets } from '../server/secrets.ts';
import { STEAM_CHILD } from '../server/claudeHome.ts';
import { gitFence, isGit } from '../server/safeGit.ts';

export type SteamUploadMsg = Extract<ToDaemon, { type: 'steam_upload' }>;
type StateMsg = Extract<FromDaemon, { type: 'steam_upload_state' }>;

export interface SteamRunDeps {
  /** The worker root (`<root>/steam` is steamcmd's folder: config.json, steamcmd, its cached login). */
  root: string;
  /** Where the caller may keep run folders: its sandbox and its temp folder. */
  allowedRoots: string[];
  python: string;
  /** GH_TOKEN and the credential helper for the ffbox clone, or undefined for the machine's own login. */
  gitEnv?: NodeJS.ProcessEnv;
  send: (msg: StateMsg) => void;
  log: (line: string) => void;
  /** Tests: the program runner (default spawn). */
  run?: Runner;
  /** Tests: steamcmd's download (default fetch). */
  download?: Download;
}

export type Runner = (cmd: string, args: string[], o: { env: NodeJS.ProcessEnv; cwd?: string; timeoutMs: number }) => Promise<{ code: number; out: string }>;

export const FFBOX_URL = 'https://github.com/Final-Factory/ffbox.git';
const PLATFORM_FLAG = { windows: 'windows', mac: 'mac', linux: 'linux' } as const;
/** The only Steam branch an agent's upload sets live (ffbox release_lane.SETLIVE, Release-Lanes.md "Development only"). */
export const LIVE_ALLOWED = ['development'];
const UPLOAD_TIMEOUT_MS = 2 * 60 * 60_000;
const CHECK_TIMEOUT_MS = 400_000;
/** A lock older than this was left by a daemon that died mid-job. */
const STALE_LOCK_MS = 3 * 60 * 60_000;
/** Names no Steam process gets from the daemon's own environment. */
const DROP_ENV = /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|ANTHROPIC_.*|CLAUDE_CODE_OAUTH_TOKEN|OPENAI_API_KEY|FFBOX_ROOT|FFBOX_TEST|FFSTEAM_.*)$/i;

export const steamDir = (root: string) => path.join(root, STEAM_CHILD);

/** Valve's steamcmd for each platform (w5640: the daemon installs it, since no worker may write `<root>/steam`). */
export const STEAMCMD: Partial<Record<NodeJS.Platform, { url: string; exe: string }>> = {
  win32: { url: 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip', exe: 'steamcmd.exe' },
  darwin: { url: 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_osx.tar.gz', exe: 'steamcmd.sh' },
  linux: { url: 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz', exe: 'steamcmd.sh' },
};
/** A Steam account name as Steam takes them. */
const ACCOUNT = /^[A-Za-z0-9_]{2,64}$/;
const configFile = (root: string) => path.join(steamDir(root), 'config.json');
type SteamConfig = { release?: { steam?: { account?: string; steamcmd?: string; home?: string } & Record<string, unknown> } & Record<string, unknown> } & Record<string, unknown>;
function readConfig(root: string): SteamConfig {
  try {
    const v = JSON.parse(fs.readFileSync(configFile(root), 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as SteamConfig) : {};
  } catch {
    return {};
  }
}
export const steamcmdExe = (root: string, platform: NodeJS.Platform = process.platform) => path.join(steamDir(root), 'steamcmd', STEAMCMD[platform]?.exe ?? 'steamcmd.sh');

/** What this computer lacks before ffsteam can run (config.json's account and steamcmd, steamcmd itself), or undefined. */
export function steamMissing(root: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const s = readConfig(root).release?.steam;
  if (!s?.account) return `${configFile(root)} names no build account`;
  if (!s.steamcmd || !fs.existsSync(s.steamcmd)) return `no steamcmd at ${s.steamcmd ?? steamcmdExe(root, platform)}`;
  return undefined;
}

/** Fetch a URL into a file (the default download; tests pass their own). */
export type Download = (url: string, file: string) => Promise<void>;
const defaultDownload: Download = async (url, file) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
};

/**
 * Install steamcmd for ffsteam (w5640; what urgent_release.py steam-install did in a worker before w5551): Valve's steamcmd
 * into `<root>/steam/steamcmd` when it is not there (unpacked with the system tar, which reads a zip on Windows, then run
 * once with +quit, which updates it and logs nobody in), and config.json's release.steam: the build account, steamcmd and
 * its home. The account is a setting, never a name in code (lothsahn, w1639): the portal's steamBuildAccount, sent with the
 * job, else the account config.json names already. Other keys of config.json are kept.
 */
export async function installSteamcmd(root: string, account: string | undefined, run: Runner, o: { platform?: NodeJS.Platform; download?: Download; log?: (line: string) => void } = {}): Promise<{ steamcmd: string; downloaded: boolean }> {
  const platform = o.platform ?? process.platform;
  const cfg = readConfig(root);
  const name = account || cfg.release?.steam?.account;
  if (!name) throw new Error('no build account to set up: the portal setting steamBuildAccount names it (config.json, docs/steam-upload.md); nothing was installed');
  if (!ACCOUNT.test(name)) throw new Error('steamBuildAccount is not a Steam account name (letters, digits and _); nothing was installed');
  const src = STEAMCMD[platform];
  if (!src) throw new Error(`Valve has no steamcmd for ${platform}`);
  const sdir = steamDir(root);
  const exe = steamcmdExe(root, platform);
  let downloaded = false;
  if (!fs.existsSync(exe)) {
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    const archive = path.join(sdir, `steamcmd-download${src.url.endsWith('.zip') ? '.zip' : '.tar.gz'}`);
    try {
      await (o.download ?? defaultDownload)(src.url, archive);
      // Windows' own bsdtar (System32), not a Git for Windows tar on PATH, which cannot read a zip.
      const tar = platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
      const x = await run(tar, ['-xf', archive, '-C', path.dirname(exe)], { env: process.env, timeoutMs: 120_000 });
      if (x.code !== 0 || !fs.existsSync(exe)) throw new Error(`could not unpack ${src.url}: ${lastLines(x.out, 4)}`);
    } finally {
      fs.rmSync(archive, { force: true });
    }
    // Its first run updates steamcmd (a few minutes) and exits with a code of its own (7 after an update): only the
    // program being there counts.
    const q = await run(exe, ['+quit'], { env: steamEnv(root, {}), cwd: path.dirname(exe), timeoutMs: 900_000 });
    o.log?.(`steamcmd installed in ${path.dirname(exe)}; its first run exited ${q.code}`);
    downloaded = true;
  }
  const release = (cfg.release ??= {});
  release.steam = { ...(release.steam ?? {}), account: name, steamcmd: exe, home: path.join(sdir, 'home') };
  fs.writeFileSync(`${configFile(root)}.part`, `${JSON.stringify(cfg, null, 2)}\n`);
  fs.renameSync(`${configFile(root)}.part`, configFile(root));
  return { steamcmd: exe, downloaded };
}

let busy = false;

// The ffbox clone's git goes through server/safeGit.ts (w5541): a worker could have written a config it would read.
const defaultRun: Runner = async (cmd, args, o) => {
  const g = isGit(cmd) ? await gitFence(args, { cwd: o.cwd, env: o.env }) : { args, env: o.env };
  return new Promise((resolve) => {
    const p = spawn(cmd, g.args, { env: g.env, cwd: o.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const take = (b: Buffer) => {
      out += b.toString('utf8');
      if (out.length > 200_000) out = out.slice(-100_000);
    };
    p.stdout.on('data', take);
    p.stderr.on('data', take);
    const t = setTimeout(() => p.kill(), o.timeoutMs);
    p.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: -1, out: `${out}\n${e.message}` });
    });
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, out });
    });
  });
};

/** The last lines of a program's output, redacted, for the portal. */
export const lastLines = (out: string, n = 12) => redactSecrets(out.trim().split(/\r?\n/).slice(-n).join('\n')).slice(-1500);

/** Whether `p` (already resolved) is inside one of `roots` (resolved too), case-blind on Windows. */
export function inside(p: string, roots: string[], win = process.platform === 'win32'): boolean {
  const norm = (s: string) => (win ? s.toLowerCase() : s);
  return roots.some((r) => {
    // win picks the path rules, not the host's: C:\a is a plain relative name to posix path (w5725: the test failed on Linux).
    const P = win ? path.win32 : path.posix;
    const rel = P.relative(norm(r), norm(p));
    return rel !== '' && !rel.startsWith('..') && !P.isAbsolute(rel);
  });
}

/** Copy `from` into `to`, refusing any link (a symlink or a Windows junction), so the copy is what was checked. */
export function copyNoLinks(from: string, to: string) {
  const st = fs.lstatSync(from);
  if (st.isSymbolicLink()) throw new Error(`${from} is a link: a release's files are copied as they are, never through a link`);
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) copyNoLinks(path.join(from, name), path.join(to, name));
  } else if (st.isFile()) {
    fs.copyFileSync(from, to);
  } else {
    throw new Error(`${from} is not a file or a folder`);
  }
}

/** The run folder of each platform, resolved and checked to be the caller's; a string is the refusal. */
export function checkRuns(runs: Partial<Record<string, string>>, allowedRoots: string[]): Record<string, string> | string {
  const roots = allowedRoots.flatMap((r) => {
    try {
      return [fs.realpathSync(r)];
    } catch {
      return [];
    }
  });
  if (!roots.length) return 'none of your folders (sandbox, temp folder) was found on this computer';
  const out: Record<string, string> = {};
  for (const [platform, dir] of Object.entries(runs)) {
    if (!dir) continue;
    if (!(platform in PLATFORM_FLAG)) return `unknown platform ${platform}`;
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return `runs.${platform}: ${dir} does not exist`;
    }
    if (!inside(real, roots)) return `runs.${platform}: ${dir} is not inside your sandbox or temp folder`;
    if (!fs.existsSync(path.join(real, 'release', 'player'))) return `runs.${platform}: ${dir} has no release/player (build-release.sh's run folder)`;
    out[platform] = real;
  }
  return out;
}

/** Copy one run folder's files ffrelease-check and ffsteam read into the staging folder. */
function stageRun(from: string, to: string) {
  fs.mkdirSync(path.join(to, 'release'), { recursive: true });
  for (const f of ['release.json', 'build.log', path.join('release', 'release-build.json')]) {
    if (fs.existsSync(path.join(from, f))) copyNoLinks(path.join(from, f), path.join(to, f));
  }
  copyNoLinks(path.join(from, 'release', 'player'), path.join(to, 'release', 'player'));
}

interface UploadRecord {
  version: string;
  app: string;
  at: string;
  session: string;
  result?: unknown;
}
const uploadsFile = (root: string) => path.join(steamDir(root), 'uploads.json');
export function readUploads(root: string): UploadRecord[] {
  try {
    const v = JSON.parse(fs.readFileSync(uploadsFile(root), 'utf8')) as unknown;
    return Array.isArray(v) ? (v as UploadRecord[]) : [];
  } catch {
    return [];
  }
}
function addUpload(root: string, r: UploadRecord) {
  const all = [...readUploads(root), r];
  fs.writeFileSync(`${uploadsFile(root)}.part`, `${JSON.stringify(all, null, 2)}\n`);
  fs.renameSync(`${uploadsFile(root)}.part`, uploadsFile(root));
}

/** The environment ffsteam runs in: the daemon's minus every credential it holds, plus steam's folder and the job's secrets. */
export function steamEnv(root: string, secrets: Record<string, string>, guardCode?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!DROP_ENV.test(k)) env[k] = v;
  env.FFBOX_CONFIG_DIR = steamDir(root);
  for (const [k, v] of Object.entries(secrets)) if (/^FFSTEAM_(PASSWORD|GUARD_SECRET|GUARD_CODE)$/.test(k)) env[k] = v;
  if (guardCode) env.FFSTEAM_GUARD_CODE = guardCode;
  return env;
}

/** Clone ffbox into steam's folder, or bring it to origin/master. */
async function ffboxCheckout(d: SteamRunDeps, run: Runner): Promise<string> {
  const dir = path.join(steamDir(d.root), 'ffbox');
  const env = { ...process.env, ...(d.gitEnv ?? {}), GIT_TERMINAL_PROMPT: '0' };
  const r = fs.existsSync(path.join(dir, '.git'))
    ? await run('git', ['-C', dir, 'fetch', '-q', '--depth', '1', FFBOX_URL, 'master'], { env, timeoutMs: 120_000 }).then(async (f) =>
        f.code === 0 ? run('git', ['-C', dir, 'reset', '-q', '--hard', 'FETCH_HEAD'], { env, timeoutMs: 60_000 }) : f,
      )
    : await run('git', ['clone', '-q', '--depth', '1', FFBOX_URL, dir], { env, timeoutMs: 180_000 });
  if (r.code !== 0) throw new Error(`could not get ffbox: ${lastLines(r.out, 4)}`);
  return path.join(dir, 'scripts');
}

/** Each app's depot platforms from ffsteam's own config reader (urgent_release.py's need_linux reads this). */
async function depotsOf(scripts: string, env: NodeJS.ProcessEnv, d: SteamRunDeps, run: Runner): Promise<Record<string, string[]> | undefined> {
  const code = `import json, sys; sys.path.insert(0, sys.argv[1]); import ffsteam; s = ffsteam.steam_config(); print(json.dumps({a: sorted((v or {}).get('depots', {}).keys()) for a, v in (s.get('apps') or {}).items()}))`;
  const r = await run(d.python, ['-I', '-c', code, scripts], { env, timeoutMs: 60_000 });
  try {
    return JSON.parse(r.out.trim().split(/\r?\n/).pop() ?? '') as Record<string, string[]>;
  } catch {
    return undefined;
  }
}

/** Run one job to its end, telling the portal each phase. Never throws. */
export async function runSteamJob(msg: SteamUploadMsg, d: SteamRunDeps): Promise<void> {
  const run = d.run ?? defaultRun;
  const say = (m: Omit<StateMsg, 'type' | 'id'>) => d.send({ type: 'steam_upload_state', id: msg.id, ...m });
  addSecretValues(Object.values(msg.secrets ?? {}).filter((v) => v));
  if (msg.guardCode) addSecretValues([msg.guardCode]);
  // The account name is no secret, but no output repeats it (w5640): the portal's setting, and the one config.json names
  // already, which a check prints when the setting is unset (ffsteam's "<account> logs in", seen on BEAST 2026-11-25).
  addSecretValues([msg.account, readConfig(d.root).release?.steam?.account].filter((v): v is string => !!v));
  if (busy) return say({ state: 'failed', error: 'this computer runs another Steam job now (one steamcmd session per account): ask again when it ends' });
  const sdir = steamDir(d.root);
  const lock = path.join(sdir, 'job.lock');
  let staging: string | undefined;
  busy = true;
  try {
    fs.mkdirSync(sdir, { recursive: true });
    try {
      fs.writeFileSync(lock, `${msg.id} ${new Date().toISOString()}\n`, { flag: 'wx' });
    } catch {
      const age = Date.now() - fs.statSync(lock).mtimeMs;
      if (age < STALE_LOCK_MS) throw new Error(`another Steam job holds ${lock} (${Math.round(age / 60_000)} min): ask again when it ends`);
      fs.writeFileSync(lock, `${msg.id} ${new Date().toISOString()}\n`);
    }
    // A new computer sets itself up (w5640): install asks for it, and a check or upload does it when anything is missing.
    const missing = steamMissing(d.root);
    if (msg.action === 'install' || missing) {
      say({ state: 'running', phase: 'installing steamcmd' });
      const got = await installSteamcmd(d.root, msg.account, run, { download: d.download, log: d.log });
      d.log(`steam install ${msg.id}: ${got.downloaded ? 'downloaded steamcmd' : 'steamcmd was there'}; config.json written`);
      if (msg.action === 'install') return say({ state: 'done', phase: 'install', result: { steamcmd: got.steamcmd, downloaded: got.downloaded, ...(missing ? { was: missing } : {}) } });
    }
    say({ state: 'running', phase: 'ffbox' });
    const scripts = await ffboxCheckout(d, run);
    const env = steamEnv(d.root, msg.secrets ?? {}, msg.guardCode);

    if (msg.action === 'check') {
      say({ state: 'running', phase: 'login check' });
      const r = await run(d.python, ['-I', path.join(scripts, 'ffsteam.py'), 'check'], { env, timeoutMs: CHECK_TIMEOUT_MS });
      const depots = await depotsOf(scripts, env, d, run);
      const result = { exit: r.code, ...(depots ? { depots } : {}) };
      d.log(`steam check ${msg.id}: exit ${r.code}`);
      return say({ state: r.code === 0 ? 'done' : 'failed', phase: 'login check', said: lastLines(r.out), result, ...(r.code === 0 ? {} : { error: r.code === 3 ? 'Steam login stopped (exit 3): its last lines say why (a Steam Guard code: call check with guard_code)' : `ffsteam.py check exited ${r.code}` }) });
    }

    // An upload.
    const { version, app, runs } = msg;
    if (!version || !/^\d+\.\d+\.\d+\.\d+$/.test(version) || (app !== 'main' && app !== 'demo') || !runs) throw new Error('an upload needs version, app and runs');
    if (msg.live && (app !== 'main' || !LIVE_ALLOWED.includes(msg.live))) throw new Error(`refusing to set ${msg.live} live for ${app}`);
    if (msg.live && msg.preview) throw new Error('a preview sets nothing live');
    if (!msg.preview && readUploads(d.root).some((u) => u.version === version && u.app === app)) throw new Error(`${app} ${version} was uploaded from this computer already (${uploadsFile(d.root)})`);
    const real = checkRuns(runs, d.allowedRoots);
    if (typeof real === 'string') throw new Error(real);
    if (!real.windows || !real.mac) throw new Error('runs needs windows and mac');

    say({ state: 'running', phase: 'copying the players' });
    staging = path.join(sdir, 'staging', `${version}-${app}-${msg.id}`);
    fs.rmSync(staging, { recursive: true, force: true });
    for (const [platform, dir] of Object.entries(real)) stageRun(dir, path.join(staging, platform));

    say({ state: 'running', phase: 'ffrelease-check' });
    for (const platform of Object.keys(real)) {
      const r = await run(d.python, ['-I', path.join(scripts, 'ffrelease-check.py'), path.join(staging, platform), '--version', version, '--json'], { env: { ...steamEnv(d.root, {}), PYTHONIOENCODING: 'utf-8' }, timeoutMs: 600_000 });
      let verdict: { good?: boolean; failures?: unknown } | undefined;
      try {
        verdict = JSON.parse(r.out.slice(r.out.indexOf('{'))) as { good?: boolean; failures?: unknown };
      } catch {
        verdict = undefined;
      }
      if (!verdict?.good) throw new Error(`ffrelease-check: the ${platform} player is NOT GOOD: ${verdict ? JSON.stringify(verdict.failures).slice(0, 600) : lastLines(r.out, 4)}`);
    }

    const out = path.join(staging, 'out');
    const args = [path.join(scripts, 'ffsteam.py'), 'upload', '--version', version, '--out', out];
    for (const platform of Object.keys(real)) args.push(`--${app}-${PLATFORM_FLAG[platform as keyof typeof PLATFORM_FLAG]}`, path.join(staging, platform, 'release', 'player'));
    if (msg.live) args.push('--setlive-main', msg.live);
    if (msg.preview) args.push('--preview');
    say({ state: 'running', phase: msg.preview ? 'steamcmd (preview)' : 'steamcmd upload' });
    const r = await run(d.python, ['-I', ...args], { env, timeoutMs: UPLOAD_TIMEOUT_MS });
    let result: Record<string, unknown> = { exit: r.code };
    try {
      result = { ...result, ...(JSON.parse(redactSecrets(fs.readFileSync(path.join(out, 'steam-upload.json'), 'utf8'))) as Record<string, unknown>) };
    } catch {
      // No record: the exit code and the last lines say why.
    }
    d.log(`steam upload ${msg.id}: ${app} ${version}${msg.preview ? ' (preview)' : ''} exit ${r.code}`);
    if (r.code === 0 && !msg.preview) addUpload(d.root, { version, app, at: new Date().toISOString(), session: msg.session, result });
    return say({ state: r.code === 0 ? 'done' : 'failed', phase: 'steamcmd', said: lastLines(r.out), result, ...(r.code === 0 ? {} : { error: r.code === 3 ? 'Steam login stopped (exit 3): its last lines say why (a Steam Guard code: steam_upload check with guard_code)' : `ffsteam.py upload exited ${r.code}` }) });
  } catch (e) {
    d.log(`steam ${msg.action} ${msg.id}: ${(e as Error).message}`);
    return say({ state: 'failed', error: redactSecrets((e as Error).message) });
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
    try {
      if (fs.readFileSync(lock, 'utf8').startsWith(`${msg.id} `)) fs.rmSync(lock, { force: true });
    } catch {
      // No lock of ours.
    }
    busy = false;
  }
}
