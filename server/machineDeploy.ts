import { spawn } from 'node:child_process';
import { run } from './proc.ts';

/**
 * Install or update the daemon on a Mac over ssh (docs/machines.md), with this host's own ssh setup:
 * probe (uid, home, node, claude, the FF clone), copy this checkout's committed code, npm ci, write
 * the config and the LaunchAgent, (re)load it. The user does nothing on the Mac.
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
  home: string;
  repoPath: string;
  node: string;
  nodeVersion: string;
  claude?: string;
  version: string;
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

export function plist(home: string, node: string, flag: boolean, userPath = ''): string {
  const app = `${home}/.ff-factory/app`;
  const args = [node, ...(flag ? ['--experimental-strip-types'] : []), '--disable-warning=ExperimentalWarning', `${app}/machine/daemon.ts`];
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
  <key>StandardOutPath</key><string>${xml(home)}/.ff-factory/logs/daemon.log</string>
  <key>StandardErrorPath</key><string>${xml(home)}/.ff-factory/logs/daemon.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${xml(home)}</string>
    <key>PATH</key><string>${xml(agentPath(home, node, userPath))}</string>
  </dict>
</dict>
</plist>
`;
}

/** Stream `git archive` of this checkout's HEAD into ~/.ff-factory/app.new on the host. */
function upload(root: string, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const git = spawn('git', ['-C', root, 'archive', '--format=tar', 'HEAD', 'server', 'shared', 'machine', 'package.json', 'package-lock.json'], { windowsHide: true });
    const ssh = spawn('ssh', [...SSH, host, 'rm -rf ~/.ff-factory/app.new && mkdir -p ~/.ff-factory/app.new ~/.ff-factory/logs && tar -xf - -C ~/.ff-factory/app.new'], { windowsHide: true });
    let err = '';
    git.stderr.on('data', (d) => (err += d));
    ssh.stderr.on('data', (d) => (err += d));
    git.stdout.pipe(ssh.stdin);
    git.on('error', reject);
    ssh.on('error', reject);
    ssh.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`copying the code to ${host} failed (${code}): ${err.trim().slice(-400)}`))));
  });
}

export async function deploy(opts: {
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
  step?: (what: string) => void;
}): Promise<DeployResult> {
  const step = opts.step ?? (() => undefined);
  step('probing');
  const p = await probe(opts.host, opts.repoSlug);
  if (!p.home || !p.uid) throw new Error(`could not read the user and home directory on ${opts.host}`);
  const support = nodeSupport(p.nodeVersion);
  if (!p.node || !support.ok) throw new Error(`${opts.host} needs Node ${MIN_NODE.join('.')}+ (found ${p.nodeVersion ?? 'none'} at ${p.node ?? '-'})`);
  const repoPath = opts.repoPath ?? p.repos.sort((a, b) => a.length - b.length)[0];
  if (!repoPath) throw new Error(`no clone of ${opts.repoSlug || 'the game repo'} found under ${p.home} on ${opts.host}; pass its path`);

  step('copying code');
  await upload(opts.root, opts.host);
  const version = (await run('git', ['-C', opts.root, 'rev-parse', '--short', 'HEAD'])).stdout.trim() || 'unknown';

  step('npm ci');
  const nodeDir = p.node.replace(/\/node$/, '');
  await must(
    opts.host,
    'npm ci',
    `set -e
cd "$HOME/.ff-factory/app.new"
echo ${sq(version)} > machine/VERSION
export PATH=${sq(nodeDir)}:"$PATH"
npm ci --omit=dev --no-audit --no-fund --loglevel=error
`,
    10 * 60_000,
  );

  step('installing');
  const config = JSON.stringify({ portalUrl: opts.portalUrl, id: opts.id, token: opts.token, repoPath, claude: p.claude, maxSessions: opts.maxSessions }, null, 2);
  await must(
    opts.host,
    'install',
    `set -e
umask 077
F="$HOME/.ff-factory"
rm -rf "$F/app.old"
[ -d "$F/app" ] && mv "$F/app" "$F/app.old"
mv "$F/app.new" "$F/app"
mkdir -p "$F/agents" "$F/logs" "$HOME/Library/LaunchAgents"
cat > "$F/daemon.json" <<'FFCONFIG'
${config}
FFCONFIG
umask 022
cat > "$HOME/Library/LaunchAgents/${LABEL}.plist" <<'FFPLIST'
${plist(p.home, p.node, support.flag, p.path)}FFPLIST
launchctl bootout gui/${p.uid}/${LABEL} 2>/dev/null || true
sleep 1
launchctl bootstrap gui/${p.uid} "$HOME/Library/LaunchAgents/${LABEL}.plist"
`,
    60_000,
  );
  return { home: p.home, repoPath, node: p.node, nodeVersion: p.nodeVersion ?? '', claude: p.claude, version };
}

/** Stop and unload the daemon (its files stay in ~/.ff-factory). */
export async function undeploy(host: string) {
  await must(host, 'uninstall', `launchctl bootout gui/$(id -u)/${LABEL} 2>/dev/null || true\nrm -f "$HOME/Library/LaunchAgents/${LABEL}.plist"\n`, 60_000);
}
