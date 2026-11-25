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
    const rel = path.relative(norm(r), norm(p));
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
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
  if (busy) return say({ state: 'failed', error: 'this computer runs another Steam job now (one steamcmd session per account): ask again when it ends' });
  const sdir = steamDir(d.root);
  const lock = path.join(sdir, 'job.lock');
  let staging: string | undefined;
  busy = true;
  try {
    if (!fs.existsSync(path.join(sdir, 'config.json'))) throw new Error(`${sdir} has no config.json: this computer was never set up for the urgent lane (urgent_release.py steam-install)`);
    try {
      fs.writeFileSync(lock, `${msg.id} ${new Date().toISOString()}\n`, { flag: 'wx' });
    } catch {
      const age = Date.now() - fs.statSync(lock).mtimeMs;
      if (age < STALE_LOCK_MS) throw new Error(`another Steam job holds ${lock} (${Math.round(age / 60_000)} min): ask again when it ends`);
      fs.writeFileSync(lock, `${msg.id} ${new Date().toISOString()}\n`);
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
