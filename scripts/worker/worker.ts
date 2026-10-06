// FF Factory worker install (w513; docs/worker-install.md, docs/worker-root.md): everything a worker machine's daemon
// and its agents use lives under one root folder, installed, checked and removed by this one tool. The OS wrappers
// (install.ps1 / install.sh, uninstall.ps1 / uninstall.sh) ask the questions, find node and pass the machine's
// credential on stdin; this file does the work, the same way on Windows and on a Mac.
//
//   install     check every prerequisite first and change nothing if one is missing; then create the root, clone the
//               game repo into it (bare), install the daemon from this checkout with its folders in the root, add the
//               firewall rules for the fixed player slots (Windows, one UAC prompt) and wait for the portal to see it.
//               Safe to run again: it updates what is there.
//   uninstall   refuse (naming them) while agents are mid-turn or sandboxes hold unpushed commits or uncommitted work;
//               then unenroll from the portal, remove the service, stop what still runs from the root, remove the
//               firewall rules and the slot config, delete the root, and check that nothing is left.
//   check       list what of an install exists on this computer (the leaves-nothing-behind checklist reads it).
//
// The machine credential (the `ffm_<id>_…` token the portal issued for this machine) is read from stdin, kept only in
// <root>/secrets/machine-token (owner-only) and never printed or put on a command line.

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LABEL, MIN_NODE, bundle, macControlScript, macProbeScript, macReloadLines, nodeSupport, parseMacProbe, parseWinProbe, plist } from '../../server/machineDeploy.ts';
import * as win from '../../server/machineDeployWin.ts';
import type { SandboxPoolSettings } from '../../shared/types.ts';

export const LAYOUT_VERSION = 1;
export const DEFAULT_REPO = 'https://github.com/Final-Factory/FinalFactory.git';
export const MIN_GIT: [number, number] = [2, 48];
/** The firewall rule groups the install owns (the slot group is the one scripts/nightly/setup_player_slot_firewall.ps1 uses too). */
export const SLOT_GROUP = 'Final Factory player slots';
export const UNITY_GROUP = 'Final Factory Unity editors';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..');

// ---------------------------------------------------------------- the layout (docs/worker-root.md 2.1)

export interface Layout {
  root: string;
  manifest: string;
  daemon: string;
  src: string;
  secrets: string;
  token: string;
  repo: string;
  sandboxes: string;
  seed: string;
  players: string;
  nightly: string;
  scratch: string;
  tmp: string;
  logs: string;
}

/** Every folder of a worker root. Exported for tests. */
export function layoutOf(root: string): Layout {
  const j = (...p: string[]) => path.join(root, ...p);
  return {
    root,
    manifest: j('root.json'),
    daemon: j('daemon'),
    src: j('daemon', 'src'),
    secrets: j('secrets'),
    token: j('secrets', 'machine-token'),
    repo: j('repo'),
    sandboxes: j('sandboxes'),
    seed: j('seed'),
    players: j('players'),
    nightly: j('nightly'),
    scratch: j('scratch'),
    tmp: j('tmp'),
    logs: j('daemon', 'logs'),
  };
}

/** What the uninstall removes besides the root, recorded as the install makes it. */
export interface OutsideItem {
  kind: 'task' | 'launchagent' | 'firewall-group' | 'file';
  name: string;
  note?: string;
}

/** <root>/root.json. */
export interface Manifest {
  installId: string;
  layout: number;
  machineId: string;
  portalUrl: string;
  platform: 'win32' | 'darwin';
  /** The scheduled task (Windows) or LaunchAgent label (Mac) that runs the daemon. */
  service: string;
  slots: number;
  repoUrl: string;
  createdAt: string;
  updatedAt: string;
  outside: OutsideItem[];
}

export function readManifest(root: string): Manifest | undefined {
  try {
    return JSON.parse(fs.readFileSync(layoutOf(root).manifest, 'utf8')) as Manifest;
  } catch {
    return undefined;
  }
}

function writeManifest(root: string, m: Manifest) {
  const file = layoutOf(root).manifest;
  fs.writeFileSync(file + '.tmp', JSON.stringify(m, null, 2) + '\n');
  fs.renameSync(file + '.tmp', file);
}

/** Add an outside item once (by kind and name). Exported for tests. */
export function noteOutside(m: Manifest, item: OutsideItem): Manifest {
  if (!m.outside.some((o) => o.kind === item.kind && o.name.toLowerCase() === item.name.toLowerCase())) m.outside.push(item);
  return m;
}

// ---------------------------------------------------------------- inputs

/** The machine id a credential carries (`ffm_<id>_<secret>`, server/machines.ts authenticate), or undefined. Exported for tests. */
export function credentialId(token: string): string | undefined {
  return /^ffm_([a-z0-9-]+)_[A-Za-z0-9_-]{40,}$/.exec(token.trim())?.[1];
}

/** "2.48.1.windows.1" → [2, 48]; undefined when it is not git's version line. Exported for tests. */
export function gitVersion(out: string): [number, number] | undefined {
  const m = /git version (\d+)\.(\d+)/.exec(out);
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

export const versionAtLeast = (v: [number, number], min: [number, number]) => v[0] > min[0] || (v[0] === min[0] && v[1] >= min[1]);

export interface InstallOptions {
  root: string;
  portalUrl: string;
  token: string;
  maxSandboxes: number;
  maxAgentsPerSandbox: number;
  maxUnity: number;
  slots: number;
  repoUrl: string;
  /** Windows task name or Mac LaunchAgent label; a second install on one computer (a test root) uses its own. */
  service: string;
  firewall: boolean;
  /** No clean-up passes of its own (a test install on a computer that holds other work). */
  noCleanup?: boolean;
  unityEditorRoot?: string;
  unityPath?: string;
}

/** A parsed command line: `--key value` options and `--flag`s. Exported for tests. */
export function parseArgs(argv: string[]): { cmd: string; opts: Record<string, string>; flags: Set<string> } {
  const [cmd = 'help', ...rest] = argv;
  const opts: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument "${a}"`);
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) flags.add(key);
    else {
      opts[key] = next;
      i++;
    }
  }
  return { cmd, opts, flags };
}

// ---------------------------------------------------------------- running things

const isWin = process.platform === 'win32';
const say = (line: string) => console.log(line);

/** One line rewritten in place on a terminal (\r + ESC[K, no indent: w508), a plain line every 10 s otherwise. */
export class Progress {
  private last = 0;
  private readonly tty: boolean;
  constructor(tty = !!process.stderr.isTTY) {
    this.tty = tty;
  }
  update(line: string) {
    if (this.tty) process.stderr.write(`\r${line}\x1b[K`);
    else if (Date.now() - this.last > 10_000) {
      this.last = Date.now();
      process.stderr.write(line + '\n');
    }
  }
  done(line?: string) {
    if (this.tty) process.stderr.write(`\r\x1b[K`);
    if (line) say(line);
  }
}

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a program, its output captured; `live` streams its stderr (git's own progress) instead. */
export function exec(cmd: string, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; live?: boolean; timeoutMs?: number } = {}): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env ?? process.env, windowsHide: true, stdio: ['pipe', 'pipe', o.live ? 'inherit' : 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = o.timeoutMs ? setTimeout(() => child.kill(), o.timeoutMs) : undefined;
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr || e.message });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin?.end(o.input ?? '');
  });
}

async function must(what: string, cmd: string, args: string[], o: Parameters<typeof exec>[2] = {}): Promise<string> {
  const r = await exec(cmd, args, o);
  if (r.code !== 0) throw new Error(`${what} failed (${r.code}): ${(r.stderr || r.stdout).trim().slice(-600)}`);
  return r.stdout;
}

async function ps(what: string, script: string, timeoutMs = 5 * 60_000): Promise<string> {
  const r = await win.psScript(win.LOCAL, script, { timeoutMs });
  if (r.code !== 0) throw new Error(`${what} failed: ${win.failureDetail(r)}`);
  return r.stdout;
}

const bash = (what: string, script: string, timeoutMs = 5 * 60_000) => must(what, 'bash', ['-s'], { input: script, timeoutMs });

// ---------------------------------------------------------------- the portal, asked with the machine's own credential

export interface WhoAmI {
  id: string;
  online: boolean;
  root?: string;
  agents: { id: string; title: string; sandbox?: string; midTurn: boolean }[];
  sandboxes: string[];
}

/** GET /machine/whoami (server/index.ts, w513). Exported for tests. */
export async function whoami(portalUrl: string, token: string, fetcher: typeof fetch = fetch): Promise<{ ok: true; me: WhoAmI } | { ok: false; error: string }> {
  try {
    const r = await fetcher(`${portalUrl}/machine/whoami`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    if (r.status === 401) return { ok: false, error: 'the portal does not accept this credential (no machine record has it: ask for a new one)' };
    if (r.status === 404) return { ok: false, error: 'the portal at that URL is too old to enroll a worker install (no /machine/whoami)' };
    if (!r.ok) return { ok: false, error: `the portal answered ${r.status}` };
    return { ok: true, me: (await r.json()) as WhoAmI };
  } catch (e) {
    return { ok: false, error: `the portal at ${portalUrl} did not answer (${(e as Error).message})` };
  }
}

// ---------------------------------------------------------------- prerequisites (abort before changing anything)

export interface Facts {
  platform: NodeJS.Platform;
  elevated: boolean;
  nodeVersion: string;
  git?: [number, number];
  gitLfs: boolean;
  claude?: string;
  rootState: 'missing' | 'empty' | 'ours' | 'other';
  rootParentExists: boolean;
  freeGB?: number;
  portal: { ok: true; me: WhoAmI } | { ok: false; error: string };
  credentialId?: string;
  /** The service name is taken by a daemon that runs from somewhere else (today's layout: migrate instead). */
  serviceElsewhere?: string;
  loggedOn?: boolean;
}

/** Every reason the install cannot go ahead, from facts gathered without changing anything. Exported for tests. */
export function preflightProblems(f: Facts, o: Pick<InstallOptions, 'root' | 'portalUrl' | 'slots' | 'maxSandboxes' | 'maxAgentsPerSandbox' | 'maxUnity'>): string[] {
  const p: string[] = [];
  if (f.platform !== 'win32' && f.platform !== 'darwin') p.push(`this tool installs on Windows and macOS, not ${f.platform}`);
  if (f.platform === 'win32' && f.elevated) p.push('run it from a normal (not administrator) PowerShell: files an elevated shell makes belong to Administrators, and git then refuses the clone; the one step that needs admin rights (the firewall rules) asks for them itself');
  if (!nodeSupport(f.nodeVersion.replace(/^v/, '')).ok) p.push(`node ${MIN_NODE.join('.')} or newer is needed (this is ${f.nodeVersion})`);
  if (!f.git) p.push(`git is missing: install git ${MIN_GIT.join('.')} or newer (${f.platform === 'win32' ? 'winget install --id Git.Git -e' : 'brew install git'})`);
  else if (!versionAtLeast(f.git, MIN_GIT)) p.push(`git ${f.git.join('.')} is too old: ${MIN_GIT.join('.')} or newer is needed for relative worktree paths (${f.platform === 'win32' ? 'winget upgrade --id Git.Git -e' : 'brew upgrade git'})`);
  if (!f.gitLfs) p.push(`git-lfs is missing (${f.platform === 'win32' ? 'it comes with Git for Windows: reinstall git' : 'brew install git-lfs && git lfs install'})`);
  if (!f.claude) p.push(`Claude Code is missing (${f.platform === 'win32' ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash'})`);
  if (!path.isAbsolute(o.root)) p.push(`the root must be an absolute path (got "${o.root}")`);
  if (!f.rootParentExists) p.push(`the folder the root goes in does not exist: ${path.dirname(o.root)}`);
  if (f.rootState === 'other') p.push(`${o.root} already holds other files; pick an empty or new folder (or the root of an earlier install of this machine)`);
  if (f.freeGB !== undefined && f.freeGB < 20) p.push(`only ${f.freeGB} GB free where the root goes; the clone alone needs about 11 GB and each sandbox 15-125 GB`);
  if (!/^https?:\/\/[^/\s]+$/.test(o.portalUrl)) p.push(`the portal URL must look like https://<host> with no path (got "${o.portalUrl}")`);
  else if (!f.portal.ok) p.push(f.portal.error);
  else if (f.credentialId && f.portal.me.id !== f.credentialId) p.push(`the portal says this credential is machine ${f.portal.me.id}, not ${f.credentialId}`);
  if (!f.credentialId) p.push('the credential is not a machine credential (it starts ffm_<machine id>_)');
  if (f.serviceElsewhere) p.push(`a daemon is already installed here (${f.serviceElsewhere}); move it into a root with migrate, or pick another --service for a second install`);
  if (f.platform === 'win32' && f.loggedOn === false) p.push('nobody is logged on to this PC\'s desktop: the daemon runs in the interactive session (the Claude login, the GPU Unity needs)');
  for (const [k, v, lo, hi] of [
    ['slots', o.slots, 1, 32],
    ['max-sandboxes', o.maxSandboxes, 1, 20],
    ['max-agents-per-sandbox', o.maxAgentsPerSandbox, 1, 6],
    ['max-unity', o.maxUnity, 1, 8],
  ] as const) {
    if (!Number.isInteger(v) || v < lo || v > hi) p.push(`--${k} must be a whole number from ${lo} to ${hi} (got ${v})`);
  }
  return p;
}

/** What is in the root folder now. */
function rootState(root: string, machineId?: string): Facts['rootState'] {
  if (!fs.existsSync(root)) return 'missing';
  const entries = fs.readdirSync(root);
  if (!entries.length) return 'empty';
  const m = readManifest(root);
  return m && (!machineId || m.machineId === machineId) ? 'ours' : 'other';
}

function freeGB(dir: string): number | undefined {
  try {
    let d = dir;
    while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
    const s = fs.statfsSync(d);
    return Math.floor((s.bavail * s.bsize) / 1e9);
  } catch {
    return undefined;
  }
}

function elevated(): boolean {
  if (!isWin) return process.getuid?.() === 0;
  return spawnSync('net', ['session'], { windowsHide: true, stdio: 'ignore' }).status === 0;
}

/** Where the service's daemon runs from today, if it is installed and not in `appDir`. */
async function serviceElsewhere(service: string, appDir: string): Promise<string | undefined> {
  if (isWin) {
    const out = await ps('looking for the daemon task', `$t = Get-ScheduledTask -TaskName ${win.psq(win.taskName({ task: service }))} -ErrorAction SilentlyContinue\nif ($t) { [string]$t.Actions[0].WorkingDirectory }\n`).catch(() => '');
    const dir = out.trim();
    return dir && path.resolve(dir).toLowerCase() !== path.resolve(appDir).toLowerCase() ? `the ${service} task runs ${dir}` : undefined;
  }
  const file = path.join(os.homedir(), 'Library', 'LaunchAgents', `${service}.plist`);
  if (!fs.existsSync(file)) return undefined;
  return fs.readFileSync(file, 'utf8').includes(`${appDir}/app/`) ? undefined : `the ${service} LaunchAgent runs from elsewhere`;
}

async function gatherFacts(o: InstallOptions): Promise<Facts & { probe: { node?: string; claude?: string; sid?: string; home: string; user?: string; uid?: string; path?: string } }> {
  const git = gitVersion((await exec('git', ['--version'])).stdout);
  const lfs = (await exec('git', ['lfs', 'version'])).code === 0;
  let probe: { node?: string; claude?: string; sid?: string; home: string; user?: string; uid?: string; path?: string; loggedOn?: boolean };
  if (isWin) {
    const p = parseWinProbe(await ps('probing this PC', win.probeScript('')));
    probe = { node: p.node, claude: p.claude, sid: p.sid, home: p.home, user: p.user, loggedOn: p.loggedOn };
  } else {
    const p = parseMacProbe(await bash('probing this Mac', macProbeScript('')));
    probe = { node: p.node, claude: p.claude, home: p.home, uid: p.uid, path: p.path };
  }
  const id = credentialId(o.token);
  const portal = await whoami(o.portalUrl, o.token);
  return {
    platform: process.platform,
    elevated: elevated(),
    nodeVersion: process.version,
    git,
    gitLfs: lfs,
    claude: probe.claude,
    rootState: rootState(o.root, id),
    rootParentExists: fs.existsSync(path.dirname(o.root)),
    freeGB: freeGB(o.root),
    portal,
    credentialId: id,
    serviceElsewhere: await serviceElsewhere(o.service, layoutOf(o.root).daemon),
    loggedOn: probe.loggedOn,
    probe,
  };
}

// ---------------------------------------------------------------- install

/** daemon.json of a worker root install: its folders in the root, the credential in a file, sandboxes only. Exported for tests. */
export function daemonJson(o: InstallOptions, l: Layout, id: string, claude: string | undefined): Record<string, unknown> {
  const sandboxes: SandboxPoolSettings = {
    root: l.sandboxes,
    maxSandboxes: o.maxSandboxes,
    maxAgentsPerSandbox: o.maxAgentsPerSandbox,
    maxUnity: o.maxUnity,
    diskWarnGB: 50,
    diskCriticalGB: 20,
    ...(fs.existsSync(path.join(l.seed, 'Library')) ? { librarySeed: path.join(l.seed, 'Library') } : {}),
  };
  return {
    portalUrl: o.portalUrl,
    id,
    root: l.root,
    tokenFile: l.token,
    repoPath: l.repo,
    claude,
    // No agents in a clone (w477): this machine takes work in its sandboxes only.
    maxSessions: 0,
    appDir: l.daemon,
    tempDir: l.tmp,
    unitySlotsDir: path.join(l.daemon, 'unity-slots'),
    maxEventsFile: path.join(l.daemon, 'max-events.jsonl'),
    ...(o.unityEditorRoot ? { unityEditorRoot: o.unityEditorRoot } : {}),
    ...(o.unityPath ? { unityPath: o.unityPath } : {}),
    ...(o.noCleanup ? { cleanup: { everyMinutes: 0, softFreeGB: 0 } } : {}),
    sandboxes,
  };
}

/** Owner-only: the secrets folder and the credential in it. */
async function lockDown(dir: string, sid?: string) {
  if (isWin) {
    if (!sid) throw new Error('no SID to give the secrets folder to');
    // The folder only (inheritable grants mean nothing on a file), then each file back to inheriting from it.
    await must('restricting the secrets folder', 'icacls', [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '/Q']);
    for (const f of fs.readdirSync(dir)) await must('restricting a secret file', 'icacls', [path.join(dir, f), '/reset', '/Q']);
  } else {
    fs.chmodSync(dir, 0o700);
    for (const f of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, f), 0o600);
  }
}

async function cloneRepo(l: Layout, url: string) {
  if (!fs.existsSync(path.join(l.repo, 'HEAD'))) {
    say(`Cloning ${url} into ${l.repo} (bare; about 1.3 GB of history, git's progress below)...`);
    await must('git clone', 'git', ['clone', '--bare', '--progress', url, l.repo], { live: true });
  }
  // A bare clone has no fetch refspec: sandboxes' branches stay local, origin's go to refs/remotes/origin (docs/worker-root.md 2.3).
  await must('git config', 'git', ['-C', l.repo, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
  // Worktrees record relative paths (git 2.48+), so the root can be moved or renamed.
  await must('git config', 'git', ['-C', l.repo, 'config', 'worktree.useRelativePaths', 'true']);
  await must('git lfs install', 'git', ['-C', l.repo, 'lfs', 'install', '--local']);
  say('Fetching origin...');
  await must('git fetch', 'git', ['-C', l.repo, 'fetch', '--prune', '--progress', 'origin'], { live: true });
}

/** The ff-factory checkout the daemon is installed from: a clone of `from` in <root>/daemon/src, updated on a re-run. */
async function syncSource(l: Layout, from: string) {
  if (path.resolve(from).toLowerCase() === path.resolve(l.src).toLowerCase()) return;
  if (!fs.existsSync(path.join(l.src, '.git'))) await must('copying the installer checkout', 'git', ['clone', '--quiet', from, l.src]);
  else await must('updating the installer checkout', 'git', ['-C', l.src, 'fetch', '--quiet', from, '+HEAD:refs/remotes/installer/HEAD']);
  const head = (await must('git rev-parse', 'git', ['-C', from, 'rev-parse', 'HEAD'])).trim();
  await must('checking out the installer revision', 'git', ['-C', l.src, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', head]);
}

async function installDaemonWin(o: InstallOptions, l: Layout, id: string, probe: { node?: string; claude?: string; sid?: string; home: string }) {
  const support = nodeSupport((await must('node --version', probe.node!, ['-p', 'process.versions.node'])).trim());
  const config = JSON.stringify(daemonJson(o, l, id, probe.claude), null, 2);
  const service = { task: o.service, only: true };
  const tgz = path.join(os.tmpdir(), `ff-worker-${process.pid}.tgz`);
  fs.writeFileSync(tgz, Buffer.from(await bundle(l.src), 'base64'));
  await ps('unpacking the daemon', win.uploadScript(l.daemon, tgz));
  const version = (await must('git rev-parse', 'git', ['-C', l.src, 'rev-parse', '--short', 'HEAD'])).trim();
  say('npm ci for the daemon...');
  await ps('npm ci', win.npmScript(probe.node!, version, l.daemon), 10 * 60_000);
  const out = await ps('registering the daemon task', win.installScript({ sid: probe.sid!, home: probe.home, config, node: probe.node!, flag: support.flag, appDir: l.daemon, service }));
  return { version, started: /started=True/.test(out) };
}

async function installDaemonMac(o: InstallOptions, l: Layout, id: string, probe: { node?: string; claude?: string; home: string; uid?: string; path?: string }) {
  const support = nodeSupport((await must('node --version', probe.node!, ['-p', 'process.versions.node'])).trim());
  const newDir = path.join(l.daemon, 'app.new');
  fs.rmSync(newDir, { recursive: true, force: true });
  fs.mkdirSync(newDir, { recursive: true });
  await must('copying the daemon code', 'bash', ['-c', `git -C "$1" archive --format=tar HEAD server shared machine scripts/unity-windows.ps1 package.json package-lock.json | tar -xf - -C "$2"`, 'x', l.src, newDir]);
  const version = (await must('git rev-parse', 'git', ['-C', l.src, 'rev-parse', '--short', 'HEAD'])).trim();
  fs.writeFileSync(path.join(newDir, 'machine', 'VERSION'), version + '\n');
  say('npm ci for the daemon...');
  await must('npm ci', 'npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: newDir, env: { ...process.env, PATH: `${path.dirname(probe.node!)}:${process.env.PATH}` }, timeoutMs: 10 * 60_000 });
  const app = path.join(l.daemon, 'app');
  const old = path.join(l.daemon, 'app.old');
  fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(app)) fs.renameSync(app, old);
  fs.renameSync(newDir, app);
  fs.mkdirSync(l.logs, { recursive: true });
  fs.mkdirSync(path.join(l.daemon, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(l.daemon, 'daemon.json'), JSON.stringify(daemonJson(o, l, id, probe.claude), null, 2), { mode: 0o600 });
  const agents = path.join(probe.home, 'Library', 'LaunchAgents');
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, `${o.service}.plist`), plist(probe.home, probe.node!, support.flag, probe.path ?? '', l.daemon, o.service));
  await bash('loading the LaunchAgent', `set -e\n${macReloadLines(`gui/${probe.uid}`, o.service)}`, 2 * 60_000);
  return { version, started: true };
}

/** The Unity editors this computer has (the Hub's lists and its default folders): the firewall rules name them. */
export function unityEditors(home = os.homedir()): string[] {
  const out = new Set<string>();
  const hub = isWin ? path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'UnityHub') : path.join(home, 'Library', 'Application Support', 'UnityHub');
  for (const f of ['editors-v2.json', 'editors.json']) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(hub, f), 'utf8')) as { data?: { location?: string[] | string }[] } | Record<string, { location?: string[] | string }>;
      const list = Array.isArray((j as { data?: unknown }).data) ? (j as { data: { location?: string[] | string }[] }).data : Object.values(j);
      for (const e of list) for (const loc of [e?.location ?? []].flat()) if (loc && fs.existsSync(loc)) out.add(loc);
    } catch {
      // no such list
    }
  }
  const roots = isWin ? [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Unity', 'Hub', 'Editor')] : ['/Applications/Unity/Hub/Editor'];
  for (const r of roots) {
    try {
      for (const v of fs.readdirSync(r)) {
        const exe = isWin ? path.join(r, v, 'Editor', 'Unity.exe') : path.join(r, v, 'Unity.app');
        if (fs.existsSync(exe)) out.add(exe);
      }
    } catch {
      // no Hub folder
    }
  }
  return [...out].filter((p) => (isWin ? /unity\.exe$/i.test(p) : true));
}

/** Run scripts/worker/firewall.ps1 elevated (one UAC prompt): the slot rules, the editors' rules, the slot config. */
async function firewall(action: 'add' | 'remove', l: Layout, slots: number, editors: string[]): Promise<string> {
  const script = path.join(SRC, 'scripts', 'worker', 'firewall.ps1');
  const log = path.join(os.tmpdir(), `ff-worker-firewall-${process.pid}.log`);
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Root', l.players, '-Count', String(slots), '-LogFile', log, ...(action === 'remove' ? ['-Remove'] : []), ...(editors.length ? ['-UnityExe', editors.join(';')] : [])];
  say(`Windows Firewall: ${action === 'add' ? 'adding' : 'removing'} the rules (one administrator prompt)...`);
  // Start-Process -Verb RunAs takes one argument string; it reaches PowerShell through the environment, unquoted by no shell.
  const line = args.map((a) => (/[\s;]/.test(a) ? `"${a}"` : a)).join(' ');
  const r = elevated()
    ? await exec('powershell.exe', args)
    : await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList $env:FFW_FIREWALL_ARGS; exit $p.ExitCode'], { env: { ...process.env, FFW_FIREWALL_ARGS: line } });
  const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  fs.rmSync(log, { force: true });
  if (r.code !== 0) throw new Error(`the firewall step failed or was declined (${r.code}): ${(text || r.stderr || r.stdout).trim().slice(-600)}`);
  return text.trim();
}

/** Ask a yes/no question on the terminal; `yes` answers it. */
async function confirm(question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) return false;
  process.stdout.write(`${question} [y/N] `);
  const answer = await new Promise<string>((resolve) => process.stdin.once('data', (d) => resolve(String(d).trim().toLowerCase())));
  return answer === 'y' || answer === 'yes';
}

export async function install(o: InstallOptions, from = SRC): Promise<void> {
  const l = layoutOf(path.resolve(o.root));
  o.root = l.root;
  say(`FF Factory worker install into ${l.root}`);
  say('Checking prerequisites (nothing changes until they all pass)...');
  const f = await gatherFacts(o);
  const problems = preflightProblems(f, o);
  if (problems.length) {
    say(`\nNot installing: ${problems.length} problem(s):`);
    for (const p of problems) say(`- ${p}`);
    process.exitCode = 2;
    return;
  }
  const id = f.credentialId!;
  say(`OK: machine ${id}, node ${f.nodeVersion}, git ${f.git!.join('.')}, Claude Code ${f.claude}, ${f.freeGB ?? '?'} GB free.`);

  // 1. The root and its manifest.
  for (const d of [l.root, l.daemon, l.secrets, l.sandboxes, l.seed, l.players, l.nightly, l.scratch, l.tmp, l.logs]) fs.mkdirSync(d, { recursive: true });
  const now = new Date().toISOString();
  const prev = readManifest(l.root);
  const m: Manifest = {
    installId: prev?.installId ?? crypto.randomUUID(),
    layout: LAYOUT_VERSION,
    machineId: id,
    portalUrl: o.portalUrl,
    platform: isWin ? 'win32' : 'darwin',
    service: o.service,
    slots: o.slots,
    repoUrl: o.repoUrl,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    outside: prev?.outside ?? [],
  };
  writeManifest(l.root, m);
  for (let k = 0; k < o.slots; k++) fs.mkdirSync(path.join(l.players, `slot${k}`), { recursive: true });

  // 2. The credential, owner-only.
  // The folder first: a file written after inherits its owner-only rights (and one from an earlier run gets them back).
  await lockDown(l.secrets, f.probe.sid);
  fs.writeFileSync(l.token, o.token.trim() + '\n', { mode: 0o600 });
  await lockDown(l.secrets, f.probe.sid);

  // 3. The game repo, bare, and the installer's own checkout.
  await cloneRepo(l, o.repoUrl);
  await syncSource(l, from);

  // 4. The daemon and its service. A test install cleans nothing: its settings are in place before it first starts.
  if (o.noCleanup) fs.writeFileSync(path.join(l.daemon, 'cleanup.json'), JSON.stringify({ everyMinutes: 0, softFreeGB: 0, staleOutput: { mode: 'off' } }));
  noteOutside(m, isWin ? { kind: 'task', name: o.service, note: 'runs the daemon at logon' } : { kind: 'launchagent', name: o.service, note: '~/Library/LaunchAgents' });
  writeManifest(l.root, m);
  const d = isWin ? await installDaemonWin(o, l, id, f.probe) : await installDaemonMac(o, l, id, f.probe);
  say(`Daemon ${d.version} installed as ${isWin ? `the ${o.service} task` : `the ${o.service} LaunchAgent`}${d.started ? ' and started' : ' (it starts at the next logon)'}.`);

  // 5. Windows Firewall: the fixed slot paths and the Unity editors, once.
  if (isWin && o.firewall) {
    const editors = unityEditors(f.probe.home);
    noteOutside(m, { kind: 'firewall-group', name: SLOT_GROUP, note: `${o.slots} slots under ${l.players}` });
    if (editors.length) noteOutside(m, { kind: 'firewall-group', name: UNITY_GROUP, note: editors.join('; ') });
    noteOutside(m, { kind: 'file', name: path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'FinalFactory', 'player-slots.json'), note: 'the slot root for scripts outside the daemon' });
    writeManifest(l.root, m);
    say(await firewall('add', l, o.slots, editors));
  } else if (isWin) say('Skipped the firewall rules (--no-firewall): players will prompt on first start.');

  // 6. The portal sees it.
  const p = new Progress();
  for (let i = 0; i < 45; i++) {
    const w = await whoami(o.portalUrl, o.token);
    if (w.ok && w.me.online) {
      p.done(`The portal sees ${id} online${w.me.root ? ` with root ${w.me.root}` : ''}.`);
      return summary(l, m);
    }
    p.update(`waiting for the daemon to connect to ${o.portalUrl} (${i * 2}s)`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  p.done(`The daemon has not connected yet. Its log: ${path.join(l.logs, 'daemon.log')}`);
  process.exitCode = 1;
  summary(l, m);
}

function summary(l: Layout, m: Manifest) {
  say(`\nInstalled. Root ${l.root} (root.json lists what lives outside it):`);
  for (const o of m.outside) say(`- ${o.kind} ${o.name}${o.note ? ` (${o.note})` : ''}`);
  say(`Check it any time: node scripts/worker/worker.ts check --root "${l.root}"`);
}

// ---------------------------------------------------------------- uninstall

export interface SandboxRisk {
  sandbox: string;
  unpushed: string[];
  dirty: string[];
}

/** Commits on a sandbox's branch that no remote has, and its uncommitted files. Exported for tests. */
export async function sandboxRisks(sandboxesDir: string): Promise<SandboxRisk[]> {
  const out: SandboxRisk[] = [];
  if (!fs.existsSync(sandboxesDir)) return out;
  for (const name of fs.readdirSync(sandboxesDir)) {
    const dir = path.join(sandboxesDir, name);
    if (!fs.existsSync(path.join(dir, '.git'))) continue;
    const log = await exec('git', ['-C', dir, 'log', '--oneline', '--no-decorate', 'HEAD', '--not', '--remotes', '--']);
    const status = await exec('git', ['-C', dir, 'status', '--porcelain=v1', '--untracked-files=normal']);
    const unpushed = log.code === 0 ? log.stdout.split('\n').filter(Boolean) : [`(git log failed: ${log.stderr.trim().slice(0, 200)})`];
    const dirty = status.code === 0 ? status.stdout.split('\n').filter(Boolean).filter((l) => !/\s(Library|Logs|Temp|obj|Builds|UserSettings)\/?$/.test(l)) : [];
    if (unpushed.length || dirty.length) out.push({ sandbox: name, unpushed, dirty });
  }
  return out;
}

/** This process and every one above it (Mac): the uninstall's own command lines name the root too. */
async function ancestors(): Promise<Set<number>> {
  const out = new Set<number>([process.pid]);
  let pid = process.ppid;
  while (pid > 1 && !out.has(pid)) {
    out.add(pid);
    pid = Number((await exec('ps', ['-o', 'ppid=', '-p', String(pid)])).stdout.trim()) || 0;
  }
  return out;
}

/** Stop every process started from the root (editors of its sandboxes, players in its slots, agents' shells), never Unity Hub. */
async function stopRootProcesses(root: string): Promise<number> {
  if (isWin) {
    const out = await ps(
      'stopping what runs from the root',
      `$root = ${win.psq(root)}
$n = 0
$all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CommandLine, ExecutablePath)
# This uninstall itself (its command line names the root too): this script and every process above it.
$mine = New-Object System.Collections.Generic.HashSet[int]
$id = $PID
while ($id -and $mine.Add([int]$id)) { $id = ($all | Where-Object { $_.ProcessId -eq $id } | Select-Object -First 1).ParentProcessId }
foreach ($p in $all) {
  if ($mine.Contains([int]$p.ProcessId) -or [string]$p.Name -match '^Unity Hub\\.exe$') { continue }
  $c = [string]$p.CommandLine + ' ' + [string]$p.ExecutablePath
  if ($c.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }
}
"stopped=$n"
`,
    );
    return Number(/stopped=(\d+)/.exec(out)?.[1] ?? 0);
  }
  const r = await exec('pgrep', ['-f', root]);
  const mine = await ancestors();
  const pids = r.stdout.split('\n').map(Number).filter((p) => p && !mine.has(p));
  for (const p of pids) {
    try {
      process.kill(p, 'SIGTERM');
    } catch {
      // gone already
    }
  }
  return pids.length;
}

export interface UninstallOptions {
  root: string;
  yes: boolean;
  force: boolean;
  /** Leave the portal's record (the portal is gone, or it is a test against no portal). */
  keepRegistration: boolean;
}

export async function uninstall(o: UninstallOptions): Promise<void> {
  const l = layoutOf(path.resolve(o.root));
  const m = readManifest(l.root);
  if (!m) throw new Error(`${l.root} is not a worker root (no root.json); nothing removed`);
  say(`FF Factory worker uninstall of ${l.root} (machine ${m.machineId})`);
  const token = fs.existsSync(l.token) ? fs.readFileSync(l.token, 'utf8').trim() : '';

  // 1. What would be lost: agents mid-turn (the portal knows), unpushed commits and uncommitted work (git knows).
  const w = token ? await whoami(m.portalUrl, token) : ({ ok: false, error: 'no credential in the root' } as const);
  const busy = w.ok ? w.me.agents.filter((a) => a.midTurn) : [];
  const risks = await sandboxRisks(l.sandboxes);
  if (busy.length) {
    say(`\n${busy.length} agent(s) are mid-turn on ${m.machineId}:`);
    for (const a of busy) say(`- ${a.title} (${a.id}${a.sandbox ? `, sandbox ${a.sandbox}` : ''})`);
  }
  for (const r of risks) {
    say(`\nSandbox ${r.sandbox}:`);
    for (const c of r.unpushed) say(`- unpushed commit ${c}`);
    if (r.dirty.length) say(`- ${r.dirty.length} uncommitted file(s): ${r.dirty.slice(0, 8).join(', ')}${r.dirty.length > 8 ? ', …' : ''}`);
  }
  if ((busy.length || risks.length) && !o.force) {
    say('\nNot uninstalling: the work above would be lost. Push it or let the agents finish, then run this again, or pass --force to discard it.');
    process.exitCode = 3;
    return;
  }
  if (!w.ok && !o.keepRegistration) {
    say(`\nNot uninstalling: ${w.error}. The portal must forget this machine too; pass --keep-registration to remove it here only (then remove_machine ${m.machineId} on the portal).`);
    process.exitCode = 4;
    return;
  }
  if (!(await confirm(`Remove the ${m.machineId} worker install and everything in ${l.root}?`, o.yes))) {
    say('Nothing removed.');
    process.exitCode = 1;
    return;
  }

  // 2. The portal forgets it (its agents are stopped there on purpose first).
  if (w.ok && !o.keepRegistration) {
    const r = await fetch(`${m.portalUrl}/machine/unenroll${o.force ? '?force=1' : ''}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`the portal refused to unenroll ${m.machineId} (${r.status}): ${(await r.text()).slice(0, 400)}; nothing removed here`);
    say(`The portal forgot ${m.machineId}.`);
  }

  // 3. The service, then whatever still runs from the root.
  if (isWin) await ps('removing the daemon task', win.uninstallScript(l.daemon, { task: m.service, only: true }));
  else await bash('unloading the LaunchAgent', macControlScript('uninstall', m.service));
  say(`Removed the ${m.service} ${isWin ? 'task' : 'LaunchAgent'}.`);
  say(`Stopped ${await stopRootProcesses(l.root)} process(es) still running from the root.`);

  // 4. Firewall rules and the slot config (Windows).
  if (isWin && m.outside.some((x) => x.kind === 'firewall-group')) say(await firewall('remove', l, m.slots, []));

  // 5. The root itself: rmdir /s and rm -rf unlink junctions and symlinks, they never follow them.
  process.chdir(os.tmpdir());
  const rm = isWin ? await exec('cmd.exe', ['/d', '/c', 'rmdir', '/s', '/q', l.root]) : await exec('rm', ['-rf', l.root]);
  if (fs.existsSync(l.root)) throw new Error(`could not delete ${l.root} (${rm.code}): ${(rm.stderr || rm.stdout).trim().slice(-400)}; a process may still hold a file there`);
  say(`Deleted ${l.root}.`);

  // 6. Prove it.
  const left = await check(l.root, m);
  report(left, m);
  if (left.some((c) => c.present)) process.exitCode = 5;
}

// ---------------------------------------------------------------- check: what of an install exists here

export interface CheckItem {
  what: string;
  present: boolean;
  detail?: string;
}

/** Every trace an install leaves, present or not (the leaves-nothing-behind checklist, docs/worker-install.md). */
export async function check(root: string, m?: Manifest): Promise<CheckItem[]> {
  const l = layoutOf(root);
  const service = m?.service ?? (isWin ? win.TASK_NAME : LABEL);
  const items: CheckItem[] = [{ what: `root folder ${l.root}`, present: fs.existsSync(l.root) }];
  if (isWin) {
    const out = await ps(
      'checking the install',
      `$ErrorActionPreference = 'Continue'
$t = Get-ScheduledTask -TaskName ${win.psq(service)} -ErrorAction SilentlyContinue
"task=$([bool]$t)"
"slotRules=$(@(Get-NetFirewallRule -Group ${win.psq(SLOT_GROUP)} -ErrorAction SilentlyContinue).Count)"
"unityRules=$(@(Get-NetFirewallRule -Group ${win.psq(UNITY_GROUP)} -ErrorAction SilentlyContinue).Count)"
$root = ${win.psq(l.root)}
"rootRules=$(@(Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { [string]$_.Program -like ($root + '*') }).Count)"
$cfg = Join-Path $env:ProgramData 'FinalFactory\\player-slots.json'
"slotConfig=$(if (Test-Path -LiteralPath $cfg) { (Get-Content -Raw -LiteralPath $cfg | ConvertFrom-Json).root } else { '' })"
$all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CommandLine)
$mine = New-Object System.Collections.Generic.HashSet[int]
$id = $PID
while ($id -and $mine.Add([int]$id)) { $id = ($all | Where-Object { $_.ProcessId -eq $id } | Select-Object -First 1).ParentProcessId }
"procs=$(@($all | Where-Object { ([string]$_.CommandLine).IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and -not $mine.Contains([int]$_.ProcessId) }).Count)"
"runKeys=$(@(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue | ForEach-Object { $_.PSObject.Properties } | Where-Object { ([string]$_.Value).IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count)"
`,
    );
    const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(out)?.[1]?.trim() ?? '';
    const cfgRoot = get('slotConfig');
    // A rule group counts only when this install made it: the slot group's name is shared with the game repo's own script.
    const ours = (g: string) => !!m?.outside.some((o) => o.kind === 'firewall-group' && o.name === g);
    const group = (g: string, n: string) => ({ what: `firewall group "${g}"${ours(g) ? '' : ' (not made by this install)'}`, present: ours(g) && Number(n) > 0, detail: `${n} rule(s)` });
    items.push(
      { what: `scheduled task ${service}`, present: get('task') === 'True' },
      group(SLOT_GROUP, get('slotRules')),
      group(UNITY_GROUP, get('unityRules')),
      { what: `firewall rules naming a path in the root`, present: Number(get('rootRules')) > 0, detail: `${get('rootRules')} rule(s)` },
      { what: 'slot config %ProgramData%\\FinalFactory\\player-slots.json pointing into the root', present: !!cfgRoot && cfgRoot.toLowerCase().startsWith(l.root.toLowerCase()), detail: cfgRoot || 'none' },
      { what: 'processes whose command line names the root', present: Number(get('procs')) > 0, detail: get('procs') },
      { what: 'HKCU Run entries naming the root', present: Number(get('runKeys')) > 0, detail: get('runKeys') },
    );
  } else {
    const plistFile = path.join(os.homedir(), 'Library', 'LaunchAgents', `${service}.plist`);
    const loaded = (await exec('launchctl', ['print', `gui/${process.getuid?.()}/${service}`])).code === 0;
    const mine = await ancestors();
    const procs = (await exec('pgrep', ['-f', l.root])).stdout.split('\n').filter((p) => p && !mine.has(Number(p))).length;
    items.push(
      { what: `LaunchAgent plist ${plistFile}`, present: fs.existsSync(plistFile) },
      { what: `LaunchAgent ${service} loaded`, present: loaded },
      { what: 'processes whose command line names the root', present: procs > 0, detail: String(procs) },
    );
  }
  return items;
}

/** What the uninstall leaves on purpose (docs/worker-install.md, "What stays"). */
export const LEFT_ON_PURPOSE = [
  'Unity Hub, its editors and Unity\'s licence: shared with the people who use this computer',
  'Git, node, Claude Code and gh, and their own files in the home folder (~/.claude, ~/.gitconfig, gh\'s login): tool dependencies, lothsahn 2026-10-06',
  'Claude Code\'s conversation files of this install\'s agents, under ~/.claude/projects/ (named after the sandbox folders): delete them by hand if wanted',
  'The game\'s save and data folder (%USERPROFILE%\\AppData\\LocalLow\\Never Games\\finalfactory, ~/Library/Application Support/Never Games/finalfactory)',
  'People\'s own game clones',
];

function report(items: CheckItem[], m?: Manifest) {
  say('\nLeaves-nothing-behind check:');
  for (const c of items) say(`${c.present ? 'LEFT' : 'gone'}  ${c.what}${c.detail ? ` (${c.detail})` : ''}`);
  say('\nLeft on purpose:');
  for (const x of LEFT_ON_PURPOSE) say(`- ${x}`);
  const left = items.filter((c) => c.present);
  say(left.length ? `\n${left.length} item(s) remain: see above.` : `\nNothing of the ${m?.machineId ?? ''} install remains.`);
}

// ---------------------------------------------------------------- the command line

async function readCredential(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0].trim();
}

const USAGE = `node scripts/worker/worker.ts <install|uninstall|check> --root <folder> [options]
  install   --portal-url <url> --credential-stdin [--max-sandboxes 3] [--max-agents-per-sandbox 2] [--max-unity 2]
            [--slots 8] [--repo-url ${DEFAULT_REPO}] [--service <task or label>] [--no-firewall] [--no-cleanup]
            [--unity-editor-root <dir>] [--unity-path <exe>]
  uninstall [--yes] [--force] [--keep-registration]
  check     [--service <task or label>] (lists what of the install exists on this computer)
The OS wrappers (scripts/worker/install.ps1, install.sh) ask for these and pipe the credential.`;

export async function main(argv = process.argv.slice(2)) {
  const { cmd, opts, flags } = parseArgs(argv);
  const num = (k: string, d: number) => (opts[k] === undefined ? d : Number(opts[k]));
  if (cmd === 'install') {
    if (!opts.root || !opts['portal-url'] || !flags.has('credential-stdin')) throw new Error(USAGE);
    await install({
      root: opts.root,
      portalUrl: opts['portal-url'].replace(/\/+$/, ''),
      token: await readCredential(),
      maxSandboxes: num('max-sandboxes', 3),
      maxAgentsPerSandbox: num('max-agents-per-sandbox', 2),
      maxUnity: num('max-unity', 2),
      slots: num('slots', 8),
      repoUrl: opts['repo-url'] ?? DEFAULT_REPO,
      service: opts.service ?? (isWin ? win.TASK_NAME : LABEL),
      firewall: !flags.has('no-firewall'),
      noCleanup: flags.has('no-cleanup'),
      unityEditorRoot: opts['unity-editor-root'],
      unityPath: opts['unity-path'],
    });
  } else if (cmd === 'uninstall') {
    if (!opts.root) throw new Error(USAGE);
    await uninstall({ root: opts.root, yes: flags.has('yes'), force: flags.has('force'), keepRegistration: flags.has('keep-registration') });
  } else if (cmd === 'check') {
    if (!opts.root) throw new Error(USAGE);
    const root = path.resolve(opts.root);
    // After an uninstall the manifest is gone: --service names what to look for.
    const m = readManifest(root) ?? (opts.service ? ({ service: opts.service, outside: [] } as unknown as Manifest) : undefined);
    report(await check(root, m), m);
  } else {
    say(USAGE);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`ERROR: ${(e as Error).message}`);
    process.exitCode = 1;
  });
}
