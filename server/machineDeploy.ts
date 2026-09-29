import { spawn } from 'node:child_process';
import { run } from './proc.ts';
import * as win from './machineDeployWin.ts';
import { platformNoun, type MachinePlatform } from '../shared/types.ts';

/**
 * Install or update the daemon on a machine over ssh (docs/machines.md), with this host's own ssh setup:
 * find out what the machine runs (detectPlatform), probe it (user, home, node, claude, the FF clone), copy
 * this checkout's committed code, npm ci, write the config and what keeps the daemon running (a LaunchAgent
 * on a Mac, a Task Scheduler task on Windows: server/machineDeployWin.ts), (re)start it. The user does
 * nothing on the machine.
 */

export const LABEL = 'com.fffactory.daemon';
const SSH = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];
/** Node that can run the TypeScript directly: 22.6+ with --experimental-strip-types, 23.6+ without. */
const MIN_NODE = [22, 6];

export interface Probe {
  uid: string;
  home: string;
  node?: string;
  nodeVersion?: string;
  claude?: string;
  repos: string[];
  /** The user's own shell PATH (login + interactive zsh). */
  path: string;
  gh?: string;
}

export interface DeployResult {
  platform: MachinePlatform;
  home: string;
  repoPath: string;
  node: string;
  nodeVersion: string;
  claude?: string;
  version: string;
  /** Windows: the daemon starts only in a logged-on session; false means it starts at the user's next logon. */
  started?: boolean;
}

/** Run a bash script on `host` (fed on stdin, so no quoting through ssh). */
export function sshScript(host: string, script: string, opts: { timeoutMs?: number; stdin?: NodeJS.ReadableStream } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('ssh', [...SSH, host, 'bash', '-s'], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 120_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr || e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end(script);
  });
}

async function must(host: string, what: string, script: string, timeoutMs?: number) {
  const r = await sshScript(host, script, { timeoutMs });
  if (r.code !== 0) throw new Error(`${what} on ${host} failed (${r.code}): ${(r.stderr || r.stdout).trim().split('\n').slice(-6).join(' | ')}`);
  return r.stdout;
}

/** "owner/name" of a GitHub-style repo URL (https or ssh, with or without .git). Exported for tests. */
export function repoSlug(url: string): string | undefined {
  return /[:/]([^/:\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1];
}

/** `slug` ("owner/name", from config repo.url) is how the game clone is recognised among the host's repos. */
export async function probe(host: string, slug = ''): Promise<Probe> {
  if (slug && !/^[\w.-]+\/[\w.-]+$/.test(slug)) throw new Error(`"${slug}" is not an owner/name repo slug`);
  const out = await must(
    host,
    'probe',
    `
set -u
echo "uid=$(id -u)"
echo "home=$HOME"
# The PATH the user's own terminal has (login + interactive zsh: ~/.zprofile and ~/.zshrc), so agents find
# what they installed wherever it lives (~/bin/gh, Homebrew, a hand-installed node).
upath=$(zsh -ilc 'print -r -- "__FFPATH__=$PATH"' </dev/null 2>/dev/null | sed -n 's/^__FFPATH__=//p' | tail -1)
echo "path=$upath"
best=""; bestn=0; bestv=""
cands=""
IFS=:; for d in $upath; do cands="$cands $d/node"; done; unset IFS
for n in /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node $cands; do
  [ -x "$n" ] || continue
  v=$("$n" -p 'process.versions.node' 2>/dev/null) || continue
  num=$(echo "$v" | awk -F. '{printf "%d%03d%03d", $1, $2, $3}')
  if [ "$num" -gt "$bestn" ]; then best="$n"; bestn="$num"; bestv="$v"; fi
done
echo "node=$best"
echo "nodev=$bestv"
c=$(PATH="$HOME/.local/bin:$upath:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" command -v claude || true)
[ -n "$c" ] && echo "claude=$c"
for t in gh git-lfs; do echo "$t=$(PATH="$upath:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" command -v $t || true)"; done
find "$HOME" -maxdepth 4 -type d -name .git -not -path "*/Library/*" 2>/dev/null | while read -r d; do
  r=$(dirname "$d")
  u=$(git -C "$r" remote get-url origin 2>/dev/null || true)
  case "$u" in *[:/]${slug}|*[:/]${slug}.git) echo "repo=$r" ;; esac
done
`,
    60_000,
  );
  const kv = out.split('\n').map((l) => l.trim().split(/=(.*)/s));
  const get = (k: string) => kv.find(([key]) => key === k)?.[1] || undefined;
  return {
    uid: get('uid') ?? '',
    home: get('home') ?? '',
    node: get('node'),
    nodeVersion: get('nodev'),
    claude: get('claude'),
    path: get('path') ?? '',
    gh: get('gh'),
    repos: kv.filter(([k]) => k === 'repo').map(([, v]) => v),
  };
}

/** Whether `v` ("22.15.0") runs our TypeScript, and whether it needs the strip-types flag. */
export function nodeSupport(v: string | undefined): { ok: boolean; flag: boolean } {
  const [a, b] = (v ?? '0').split('.').map(Number);
  const ok = a > MIN_NODE[0] || (a === MIN_NODE[0] && b >= MIN_NODE[1]);
  const native = a > 23 || (a === 23 && b >= 6);
  return { ok, flag: ok && !native };
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The LaunchAgent's PATH: node's own dir first, then the user's shell PATH (so agents find what the user
 * installed, e.g. ~/bin/gh), then Homebrew and the system dirs a LaunchAgent does not get by default.
 */
export function agentPath(home: string, node: string, userPath: string): string {
  const dirs = [
    node.replace(/\/node$/, ''),
    ...userPath.split(':'),
    `${home}/.local/bin`,
    `${home}/bin`,
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ]
    .map((d) => d.trim().replace(/^~(?=\/|$)/, home))
    .filter((d) => d.startsWith('/'));
  return [...new Set(dirs)].join(':');
}

/** The daemon's folder on a Mac: the machine's app_dir, else ~/.ff-factory. */
export const macAppDir = (home: string, appDir?: string) => appDir || `${home}/.ff-factory`;

export function plist(home: string, node: string, flag: boolean, userPath = '', appDir?: string): string {
  const dir = macAppDir(home, appDir);
  const app = `${dir}/app`;
  const args = [node, ...(flag ? ['--experimental-strip-types'] : []), '--disable-warning=ExperimentalWarning', `${app}/machine/daemon.ts`, `${dir}/daemon.json`];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>${args.map((a) => `<string>${xml(a)}</string>`).join('')}</array>
  <key>WorkingDirectory</key><string>${xml(app)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(dir)}/logs/daemon.log</string>
  <key>StandardErrorPath</key><string>${xml(dir)}/logs/daemon.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${xml(home)}</string>
    <key>PATH</key><string>${xml(agentPath(home, node, userPath))}</string>
  </dict>
</dict>
</plist>
`;
}

/** The daemon's folder in a remote shell command: quoted, or ~/.ff-factory. Exported for tests. */
export const macDirArg = (appDir?: string) => (appDir ? sq(appDir) : '~/.ff-factory');

/** Stream `git archive` of this checkout's HEAD into app.new in the daemon's folder on the host. */
function upload(root: string, host: string, appDir?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const git = spawn('git', ['-C', root, 'archive', '--format=tar', 'HEAD', 'server', 'shared', 'machine', 'package.json', 'package-lock.json'], { windowsHide: true });
    const d = macDirArg(appDir);
    const ssh = spawn('ssh', [...SSH, host, `rm -rf ${d}/app.new && mkdir -p ${d}/app.new ${d}/logs && tar -xf - -C ${d}/app.new`], { windowsHide: true });
    let err = '';
    git.stderr.on('data', (d) => (err += d));
    ssh.stderr.on('data', (d) => (err += d));
    git.stdout.pipe(ssh.stdin);
    git.on('error', reject);
    ssh.on('error', reject);
    ssh.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`copying the code to ${host} failed (${code}): ${err.trim().slice(-400)}`))));
  });
}

export interface DeployOptions {
  host: string;
  id: string;
  portalUrl: string;
  token: string;
  /** The checkout whose committed code is deployed (this server's own). */
  root: string;
  repoPath?: string;
  maxSessions: number;
  /** "owner/name" of the game repo (config repo.url), to find its clone when repoPath is not given. */
  repoSlug?: string;
  /** The machine's own folders (add_machine; docs/machines.md): unset means the defaults. */
  dirs?: MachineDirs;
  /** The daemon's folder of the previous deploy, when it moves (Windows stops the daemon running from there). */
  previousAppDir?: string;
  step?: (what: string) => void;
}

/** A machine's folder options, as add_machine takes them and daemon.json keeps them. */
export interface MachineDirs {
  appDir?: string;
  unityEditorRoot?: string;
  unityPath?: string;
  tempDir?: string;
}

/** Throws when a folder option is for the other OS (a D:\ path on a Mac, a /Users path on Windows). Exported for tests. */
export function checkDirs(dirs: MachineDirs | undefined, platform: MachinePlatform, host: string) {
  for (const [k, v] of Object.entries(dirs ?? {})) {
    if (!v) continue;
    if (/^[a-zA-Z]:\\/.test(v) !== (platform === 'win32')) throw new Error(`${k} "${v}" is not a ${platform === 'win32' ? 'Windows' : 'Mac'} path, and ${host} is a ${platformNoun(platform)}`);
  }
}

/**
 * What `uname -s` said over ssh, as a platform. A Windows PC answers only when Git's or MSYS's Unix tools are
 * on its PATH (MINGW64_NT-10.0-26100, MSYS_NT-...); otherwise its shell fails the command (undefined).
 */
export function platformOfUname(out: string, code: number): MachinePlatform | 'other' | undefined {
  const s = out.trim().split('\n').pop()?.trim() ?? '';
  if (/^(MINGW|MSYS|CYGWIN)/i.test(s)) return 'win32';
  if (code !== 0) return undefined;
  if (/^Darwin$/i.test(s)) return 'darwin';
  return s ? 'other' : undefined;
}

/**
 * Which OS `host` runs, over ssh: `uname -s` answers on a Mac (whatever its login shell); a Windows PC is
 * recognised by PowerShell answering (OpenSSH Server's default shell there is cmd.exe or PowerShell, and
 * both run the same encoded command, server/machineDeployWin.ts).
 */
export async function detectPlatform(host: string): Promise<MachinePlatform> {
  const r = await run('ssh', [...SSH, host, 'uname', '-s'], { timeoutMs: 30_000 });
  if (r.code === 255) throw new Error(`ssh ${host} failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' | ')}`);
  const u = platformOfUname(r.stdout, r.code);
  if (u === 'darwin' || u === 'win32') return u;
  if (u === 'other') throw new Error(`${host} runs ${r.stdout.trim()}; machines are Macs or Windows PCs`);
  const w = await win.psScript(host, "'platform=' + [Environment]::OSVersion.Platform", { timeoutMs: 60_000 });
  if (w.code === 0 && /platform=Win32NT/.test(w.stdout)) return 'win32';
  throw new Error(`could not tell what ${host} runs: uname -s failed (${(r.stderr || r.stdout).trim().slice(0, 200)}) and PowerShell did not answer (${(w.stderr || w.stdout).trim().slice(0, 200)})`);
}

export async function deploy(opts: DeployOptions): Promise<DeployResult> {
  (opts.step ?? (() => undefined))('checking the OS');
  return (await detectPlatform(opts.host)) === 'win32' ? deployWindows(opts) : deployMac(opts);
}

async function deployMac(opts: DeployOptions): Promise<DeployResult> {
  const step = opts.step ?? (() => undefined);
  step('probing');
  const p = await probe(opts.host, opts.repoSlug);
  if (!p.home || !p.uid) throw new Error(`could not read the user and home directory on ${opts.host}`);
  const support = nodeSupport(p.nodeVersion);
  if (!p.node || !support.ok) throw new Error(`${opts.host} needs Node ${MIN_NODE.join('.')}+ (found ${p.nodeVersion ?? 'none'} at ${p.node ?? '-'})`);
  const repoPath = opts.repoPath ?? p.repos.sort((a, b) => a.length - b.length)[0];
  if (!repoPath) throw new Error(`no clone of ${opts.repoSlug || 'the game repo'} found under ${p.home} on ${opts.host}; pass its path`);
  checkDirs(opts.dirs, 'darwin', opts.host);
  const appDir = opts.dirs?.appDir;

  step('copying code');
  await upload(opts.root, opts.host, appDir);
  const version = (await run('git', ['-C', opts.root, 'rev-parse', '--short', 'HEAD'])).stdout.trim() || 'unknown';

  step('npm ci');
  const nodeDir = p.node.replace(/\/node$/, '');
  await must(
    opts.host,
    'npm ci',
    `set -e
cd ${appDir ? sq(appDir) : '"$HOME/.ff-factory"'}/app.new
echo ${sq(version)} > machine/VERSION
export PATH=${sq(nodeDir)}:"$PATH"
npm ci --omit=dev --no-audit --no-fund --loglevel=error
`,
    10 * 60_000,
  );

  step('installing');
  const config = daemonConfig({ portalUrl: opts.portalUrl, id: opts.id, token: opts.token, repoPath, claude: p.claude, maxSessions: opts.maxSessions, ...opts.dirs });
  await must(
    opts.host,
    'install',
    `set -e
umask 077
F=${appDir ? sq(appDir) : '"$HOME/.ff-factory"'}
rm -rf "$F/app.old"
[ -d "$F/app" ] && mv "$F/app" "$F/app.old"
mv "$F/app.new" "$F/app"
mkdir -p "$F/agents" "$F/logs" "$HOME/Library/LaunchAgents"
cat > "$F/daemon.json" <<'FFCONFIG'
${config}
FFCONFIG
umask 022
cat > "$HOME/Library/LaunchAgents/${LABEL}.plist" <<'FFPLIST'
${plist(p.home, p.node, support.flag, p.path, appDir)}FFPLIST
launchctl bootout gui/${p.uid}/${LABEL} 2>/dev/null || true
sleep 1
launchctl bootstrap gui/${p.uid} "$HOME/Library/LaunchAgents/${LABEL}.plist"
`,
    60_000,
  );
  return { platform: 'darwin', home: p.home, repoPath, node: p.node, nodeVersion: p.nodeVersion ?? '', claude: p.claude, version };
}

// ---------------------------------------------------------------- Windows (server/machineDeployWin.ts)

export interface WinProbe {
  home: string;
  sid: string;
  user: string;
  os?: string;
  loggedOn: boolean;
  tar: boolean;
  node?: string;
  nodeVersion?: string;
  claude?: string;
  /** Claude Code found only as an npm shim (claude.cmd), which the Agent SDK cannot start: it uses its own. */
  claudeShim?: string;
  git?: string;
  gh?: string;
  repos: string[];
}

/** The Windows probe's `key=value` lines (`key~b64=<base64>` for a value beyond ASCII). Exported for tests. */
export function parseWinProbe(out: string): WinProbe {
  const kv = out.split('\n').map((l) => {
    const [k, v = ''] = l.trim().split(/=(.*)/s);
    return k.endsWith('~b64') ? [k.slice(0, -4), Buffer.from(v, 'base64').toString('utf8')] : [k, v];
  });
  const get = (k: string) => kv.find(([key]) => key === k)?.[1]?.trim() || undefined;
  return {
    home: get('home') ?? '',
    sid: get('sid') ?? '',
    user: get('user') ?? '',
    os: get('os'),
    loggedOn: get('loggedOn') === 'True',
    tar: get('tar') === 'True',
    node: get('node'),
    nodeVersion: get('nodev'),
    claude: get('claude'),
    claudeShim: get('claudeShim'),
    git: get('git'),
    gh: get('gh'),
    repos: kv.filter(([k]) => k === 'repo').map(([, v]) => v.trim()),
  };
}

async function mustPs(host: string, what: string, script: string, opts: { timeoutMs?: number; data?: string } = {}) {
  const r = await win.psScript(host, script, opts);
  if (r.code !== 0) throw new Error(`${what} on ${host} failed (${r.code}): ${(r.stderr || r.stdout).trim().split('\n').slice(-6).join(' | ')}`);
  return r.stdout;
}

/** The daemon's config file (both platforms); a folder option left unset is left out. Exported for tests. */
export function daemonConfig(o: { portalUrl: string; id: string; token: string; repoPath: string; claude?: string; maxSessions: number } & MachineDirs): string {
  return JSON.stringify(
    { portalUrl: o.portalUrl, id: o.id, token: o.token, repoPath: o.repoPath, claude: o.claude, maxSessions: o.maxSessions, appDir: o.appDir, unityEditorRoot: o.unityEditorRoot, unityPath: o.unityPath, tempDir: o.tempDir },
    null,
    2,
  );
}

/** A git archive of this checkout's committed code as a base64 .tar.gz (the Windows upload's payload). */
export function bundle(root: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const git = spawn('git', ['-C', root, 'archive', '--format=tar.gz', 'HEAD', 'server', 'shared', 'machine', 'package.json', 'package-lock.json'], { windowsHide: true });
    const chunks: Buffer[] = [];
    let err = '';
    git.stdout.on('data', (d: Buffer) => chunks.push(d));
    git.stderr.on('data', (d) => (err += d));
    git.on('error', reject);
    git.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks).toString('base64')) : reject(new Error(`git archive failed (${code}): ${err.trim().slice(-400)}`))));
  });
}

/** The game clone: the given path, else the shortest one found (the clone, not a copy nested in it). */
export function pickRepo(given: string | undefined, found: string[]): string | undefined {
  return given || [...found].sort((a, b) => a.length - b.length)[0];
}

async function deployWindows(opts: DeployOptions): Promise<DeployResult> {
  const step = opts.step ?? (() => undefined);
  step('probing');
  const p = parseWinProbe(await mustPs(opts.host, 'probe', win.probeScript(opts.repoSlug ?? ''), { timeoutMs: 3 * 60_000 }));
  if (!p.home || !p.sid) throw new Error(`could not read the user and home folder on ${opts.host}`);
  const support = nodeSupport(p.nodeVersion);
  if (!p.node || !support.ok) throw new Error(`${opts.host} needs Node ${MIN_NODE.join('.')}+ (found ${p.nodeVersion ?? 'none'} at ${p.node ?? '-'})`);
  if (!p.git) throw new Error(`${opts.host} has no git (install Git for Windows: Claude Code also needs its bash)`);
  if (!p.tar) throw new Error(`${opts.host} has no tar.exe in System32 (Windows 10 1803 or newer has it)`);
  const repoPath = pickRepo(opts.repoPath, p.repos);
  if (!repoPath) throw new Error(`no clone of ${opts.repoSlug || 'the game repo'} found under ${p.home} or near the top of a drive on ${opts.host}; pass its path`);
  checkDirs(opts.dirs, 'win32', opts.host);
  const appDir = opts.dirs?.appDir;

  step('copying code');
  await mustPs(opts.host, 'copying the code', win.uploadScript(appDir), { data: await bundle(opts.root), timeoutMs: 10 * 60_000 });
  const version = (await run('git', ['-C', opts.root, 'rev-parse', '--short', 'HEAD'])).stdout.trim() || 'unknown';

  step('npm ci');
  await mustPs(opts.host, 'npm ci', win.npmScript(p.node, version, appDir), { timeoutMs: 10 * 60_000 });

  step('installing');
  const config = daemonConfig({ portalUrl: opts.portalUrl, id: opts.id, token: opts.token, repoPath, claude: p.claude, maxSessions: opts.maxSessions, ...opts.dirs });
  const out = await mustPs(opts.host, 'install', win.installScript({ sid: p.sid, home: p.home, config, node: p.node, flag: support.flag, appDir, previousAppDir: opts.previousAppDir }), { timeoutMs: 3 * 60_000 });
  return { platform: 'win32', home: p.home, repoPath, node: p.node, nodeVersion: p.nodeVersion ?? '', claude: p.claude, version, started: /started=True/.test(out) };
}

// ---------------------------------------------------------------- start, stop, restart, remove

export type DaemonAction = 'start' | 'stop' | 'restart';

/** The Mac's launchctl lines for each action on the LaunchAgent. Exported for tests. */
export function macControlScript(action: DaemonAction | 'uninstall'): string {
  const plistPath = `"$HOME/Library/LaunchAgents/${LABEL}.plist"`;
  const target = `gui/$(id -u)/${LABEL}`;
  switch (action) {
    case 'start':
      return `set -e\nlaunchctl print ${target} >/dev/null 2>&1 || launchctl bootstrap gui/$(id -u) ${plistPath}\n`;
    case 'stop':
      return `launchctl bootout ${target} 2>/dev/null || true\n`;
    case 'restart':
      return `set -e\nif launchctl print ${target} >/dev/null 2>&1; then launchctl kickstart -k ${target}; else launchctl bootstrap gui/$(id -u) ${plistPath}; fi\n`;
    case 'uninstall':
      return `launchctl bootout ${target} 2>/dev/null || true\nrm -f ${plistPath}\n`;
  }
}

/**
 * Start, stop or restart the daemon on a machine. A stopped Mac daemon loads again at the next login, a
 * Windows one starts again at the next logon. Returns what happened, in a few words.
 */
export async function controlDaemon(host: string, platform: MachinePlatform | undefined, action: DaemonAction, appDir?: string): Promise<string> {
  const pf = platform ?? (await detectPlatform(host));
  if (pf === 'win32') {
    const out = await mustPs(host, `daemon ${action}`, win.controlScript(action, appDir), { timeoutMs: 2 * 60_000 });
    const stopped = /stopped=(\d+)/.exec(out)?.[1];
    const started = /started=(True|False)/.exec(out)?.[1];
    return [
      stopped !== undefined ? `stopped the ${win.TASK_NAME} task (${stopped} process(es) ended; Unity editors left running)` : '',
      started === 'True' ? `started the ${win.TASK_NAME} task` : started === 'False' ? 'nobody is logged on there, so the daemon starts at the next logon' : '',
    ]
      .filter(Boolean)
      .join('; ');
  }
  await must(host, `daemon ${action}`, macControlScript(action), 60_000);
  return action === 'stop' ? 'unloaded the LaunchAgent (it loads again at the next login)' : action === 'start' ? 'loaded the LaunchAgent' : 'restarted the LaunchAgent';
}

/** Stop and unload the daemon (its files stay in its folder). */
export async function undeploy(host: string, platform?: MachinePlatform, appDir?: string) {
  const pf = platform ?? (await detectPlatform(host));
  if (pf === 'win32') await mustPs(host, 'uninstall', win.uninstallScript(appDir), { timeoutMs: 2 * 60_000 });
  else await must(host, 'uninstall', macControlScript('uninstall'), 60_000);
}
