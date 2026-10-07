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
import { slotsPointer } from '../../machine/unitySlots.ts';
import { ADMIN_PROBE_PS, aclArgs, adminFromProbe, authorizeIn, authorizedKeysFile, fetchPortalKey, hostnameFallback, keyBlob, parseKeyscan, registerSsh, revokeIn, tailnetNameOf, tailscaleCandidates } from './portalSsh.ts';

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
  kind: 'task' | 'launchagent' | 'firewall-group' | 'file' | 'authorized-key';
  name: string;
  /** authorized-key: the key's base64 (the lines the uninstall removes). */
  note?: string;
  /** authorized-key: the line was there before this install, so the uninstall leaves it (w568). */
  existed?: boolean;
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
  /** Player-folder pairs: one per sandbox (players/slotK-0 and slotK-1, K = 1..slots; w576). */
  slots: number;
  repoUrl: string;
  /** A test install's firewall group suffix (firewall.ps1 -GroupSuffix). */
  firewallSuffix?: string;
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

/**
 * Add an outside item once (by kind and name). One already there takes the new note, so a re-run with another
 * --max-sandboxes rewrites the firewall group's slot count (w600: LothDesktop's root.json still said "8 slots" at 5).
 * Exported for tests.
 */
export function noteOutside(m: Manifest, item: OutsideItem): Manifest {
  const had = m.outside.find((o) => o.kind === item.kind && o.name.toLowerCase() === item.name.toLowerCase());
  if (!had) m.outside.push(item);
  else if (item.note !== undefined) had.note = item.note;
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
  repoUrl: string;
  /** Windows task name or Mac LaunchAgent label; a second install on one computer (a test root) uses its own. */
  service: string;
  firewall: boolean;
  /** No clean-up passes of its own (a test install on a computer that holds other work). */
  noCleanup?: boolean;
  /** Its own Unity slots mailbox: only a test install beside another daemon (the default is the one every script finds). */
  unitySlotsDir?: string;
  /**
   * Windows: run elevated (an administrator's ssh session, as the portal's own deploy does) and give everything this run
   * makes to this user (`icacls /setowner`), so the daemon's non-elevated git does not refuse the clone as owned by
   * Administrators. Without it, an elevated run is refused.
   */
  owner?: string;
  /** A test install beside a live one: its own firewall rule groups and no slot config. */
  firewallSuffix?: string;
  /** A local clone of the game repo to seed the root's clone from (a migration's old clone, or install --seed-from): no download, no credential. */
  seedFrom?: string;
  /** daemon.json settings the old daemon had (a migration: its host guard, protected paths, MCP server, limits). */
  carry?: Record<string, unknown>;
  /** A migration replaces the old daemon's service on purpose (worker.ts migrate). */
  replacesService?: boolean;
  /**
   * Worktrees with absolute paths (git's default) instead of relative ones. Relative paths let the root move, but git
   * then marks the clone extensions.relativeWorktrees, which every git older than 2.48 refuses to open: a computer
   * whose daemon or tools still use an older git needs this (a test install beside a live daemon, say).
   */
  absoluteWorktrees?: boolean;
  unityEditorRoot?: string;
  unityPath?: string;
  /** The portal's ssh (w568, scripts/worker/portalSsh.ts): false skips it (--no-ssh). */
  ssh?: boolean;
  /** The name the portal reaches this machine by (default: its tailnet name, else its computer name). */
  sshHost?: string;
  /** The ssh user the portal's key is authorized for (default: the account running the install). */
  sshUser?: string;
  /**
   * An update of this machine's own install (worker.ts update, w613): no fetch of the game repo (the root's clone is
   * reused; over ssh a Mac's keychain and a Windows user's credential manager are out of reach), the old LaunchAgent's
   * PATH kept in its order, the old Library seed kept, and no administrator prompt that nobody can answer.
   */
  update?: boolean;
  /**
   * The GPU Whisper for the portal's mic (w615, docs/voice.md "Whisper on a worker's GPU"): a faster-whisper model name
   * turns it on (daemon.json `voice`), "off" turns it off; unset keeps what daemon.json has (off on a new install).
   */
  voiceWhisper?: string;
}

/**
 * daemon.json `voice` after an install (w615): `flag` a model name turns it on with that model, "off" turns it off (its
 * other settings kept), unset keeps `had`. Undefined: no `voice` key (off). Exported for tests.
 */
export function voiceSetting(flag: string | undefined, had: unknown): Record<string, unknown> | undefined {
  const before = had && typeof had === 'object' && !Array.isArray(had) ? (had as Record<string, unknown>) : undefined;
  if (flag === undefined || flag === '') return before;
  if (flag === 'off') return before ? { ...before, enabled: false } : undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(flag)) throw new Error(`--voice-whisper is a faster-whisper model name (large-v3-turbo, small.en, ...) or off, not "${flag}"`);
  return { ...before, enabled: true, model: flag };
}

/** The `voice` of the daemon.json already in the root, if any: a re-run keeps it (w615). */
function existingVoice(l: Layout): unknown {
  try {
    return (JSON.parse(fs.readFileSync(path.join(l.daemon, 'daemon.json'), 'utf8')) as Record<string, unknown>).voice;
  } catch {
    return undefined;
  }
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
    // A program that exits without reading its input closes the pipe first (EPIPE): its exit code says how it went.
    child.stdin?.on('error', () => undefined);
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
  /** The commit the connected daemon runs, and why it is outdated (w613); absent from an older portal. */
  daemon?: string;
  outdated?: string;
  root?: string;
  agents: { id: string; title: string; sandbox?: string; midTurn: boolean }[];
  sandboxes: string[];
}

/**
 * POST /machine/stopping (server/index.ts, w513): the daemon stops on purpose now (a migration), so the portal's offline
 * redeploy leaves the machine alone until a daemon says hello again. A portal without the route (404) is fine only if it
 * was told another way: the daemon was stopped with machine_daemon stop, and none runs (the caller checks). Exported for tests.
 */
export async function holdRedeploys(portalUrl: string, token: string, fetcher: typeof fetch = fetch): Promise<{ ok: true } | { ok: false; error: string; tooOld?: boolean }> {
  try {
    const r = await fetcher(`${portalUrl}/machine/stopping`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    if (r.ok) return { ok: true };
    if (r.status === 404) return { ok: false, tooOld: true, error: 'the portal is too old to hold its redeploys during a migration (no /machine/stopping)' };
    return { ok: false, error: `the portal refused to hold its redeploys (HTTP ${r.status})` };
  } catch (e) {
    return { ok: false, error: `the portal did not answer (${(e as Error).message})` };
  }
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
  /** Windows: Claude Code only as an npm shim (claude.cmd): the Agent SDK cannot start it and uses its own bundled one. */
  claudeShim?: string;
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
export function preflightProblems(f: Facts, o: Pick<InstallOptions, 'root' | 'portalUrl' | 'maxSandboxes' | 'maxAgentsPerSandbox' | 'maxUnity'> & { owner?: string }): string[] {
  const p: string[] = [];
  if (f.platform !== 'win32' && f.platform !== 'darwin') p.push(`this tool installs on Windows and macOS, not ${f.platform}`);
  if (f.platform === 'win32' && f.elevated && !o.owner) p.push('run it from a normal (not administrator) PowerShell: files an elevated shell makes belong to Administrators, and git then refuses the clone; the one step that needs admin rights (the firewall rules) asks for them itself');
  if (!nodeSupport(f.nodeVersion.replace(/^v/, '')).ok) p.push(`node ${MIN_NODE.join('.')} or newer is needed (this is ${f.nodeVersion})`);
  if (!f.git) p.push(`git is missing: install git ${MIN_GIT.join('.')} or newer (${f.platform === 'win32' ? 'winget install --id Git.Git -e' : 'brew install git'})`);
  else if (!versionAtLeast(f.git, MIN_GIT)) p.push(`git ${f.git.join('.')} is too old: ${MIN_GIT.join('.')} or newer is needed for relative worktree paths (${f.platform === 'win32' ? 'winget upgrade --id Git.Git -e' : 'brew upgrade git'})`);
  if (!f.gitLfs) p.push(`git-lfs is missing (${f.platform === 'win32' ? 'it comes with Git for Windows: reinstall git' : 'brew install git-lfs && git lfs install'})`);
  if (!f.claude && !f.claudeShim) p.push(`Claude Code is missing (${f.platform === 'win32' ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash'})`);
  // The path rules of the computer the root is for (a test judges a Windows path anywhere).
  const pp = f.platform === 'win32' ? path.win32 : path.posix;
  if (!pp.isAbsolute(o.root)) p.push(`the root must be an absolute path (got "${o.root}")`);
  if (!f.rootParentExists) p.push(`the folder the root goes in does not exist: ${pp.dirname(o.root)}`);
  if (f.rootState === 'other') p.push(`${o.root} already holds other files; pick an empty or new folder (or the root of an earlier install of this machine)`);
  if (f.freeGB !== undefined && f.freeGB < 20) p.push(`only ${f.freeGB} GB free where the root goes; the clone alone needs about 11 GB and each sandbox 15-125 GB`);
  if (!/^https?:\/\/[^/\s]+$/.test(o.portalUrl)) p.push(`the portal URL must look like https://<host> with no path (got "${o.portalUrl}")`);
  else if (!f.portal.ok) p.push(f.portal.error);
  else if (f.credentialId && f.portal.me.id !== f.credentialId) p.push(`the portal says this credential is machine ${f.portal.me.id}, not ${f.credentialId}`);
  if (!f.credentialId) p.push('the credential is not a machine credential (it starts ffm_<machine id>_)');
  // The count sets the player-folder pairs (w576): lowering it below the sandboxes there would leave one without its pair.
  const there = f.portal.ok ? f.portal.me.sandboxes : [];
  if (there.length > o.maxSandboxes) {
    p.push(`--max-sandboxes ${o.maxSandboxes} is below the ${there.length} sandboxes there (${there.join(', ')}): delete ${there.length - o.maxSandboxes} first (delete_sandbox)`);
  }
  if (f.serviceElsewhere) p.push(`a daemon is already installed here (${f.serviceElsewhere}); move it into a root with migrate, or pick another --service for a second install`);
  if (f.platform === 'win32' && f.loggedOn === false) p.push('nobody is logged on to this PC\'s desktop: the daemon runs in the interactive session (the Claude login, the GPU Unity needs)');
  for (const [k, v, lo, hi] of [
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
  if (m) return !machineId || m.machineId === machineId ? 'ours' : 'other';
  // A migration in progress made the root before the install (scripts/worker/migrate.ts).
  return entries.every((e) => ['migration.json', 'migration', 'daemon', 'sandboxes', 'seed', 'nightly', 'scratch'].includes(e)) && entries.includes('migration.json') ? 'ours' : 'other';
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
  let probe: { node?: string; claude?: string; claudeShim?: string; sid?: string; home: string; user?: string; uid?: string; path?: string; loggedOn?: boolean };
  if (isWin) {
    const p = parseWinProbe(await ps('probing this PC', win.probeScript('')));
    probe = { node: p.node, claude: p.claude, claudeShim: p.claudeShim, sid: p.sid, home: p.home, user: p.user, loggedOn: p.loggedOn };
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
    claudeShim: probe.claudeShim,
    rootState: rootState(o.root, id),
    rootParentExists: fs.existsSync(path.dirname(o.root)),
    freeGB: freeGB(o.root),
    portal,
    credentialId: id,
    serviceElsewhere: o.replacesService ? undefined : await serviceElsewhere(o.service, layoutOf(o.root).daemon),
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
  // A migration keeps the old daemon's settings (its host guard, protected paths, MCP server, idle stop); the root's
  // folders and the credential file replace its own, the token never goes into daemon.json, and max_agents is gone (w536).
  const { token: _t, appDir: _a, tempDir: _d, repoPath: _r, sandboxes: oldPool, unitySlotsDir: _u, maxEventsFile: _m, configFile: _c, maxSessions: _ms, ...carried } = (o.carry ?? {}) as Record<string, unknown>;
  if (oldPool && typeof oldPool === 'object') {
    const { root: _pr, librarySeed: oldSeed, ...poolRest } = oldPool as Record<string, unknown>;
    Object.assign(sandboxes, { ...poolRest, root: sandboxes.root, ...(sandboxes.librarySeed ? { librarySeed: sandboxes.librarySeed } : {}) });
    // An update keeps the seed the daemon had (w613: BEAST's block-cloned Library) when the root holds none of its own.
    if (o.update && !sandboxes.librarySeed && typeof oldSeed === 'string' && oldSeed) sandboxes.librarySeed = oldSeed;
  }
  const voice = voiceSetting(o.voiceWhisper, 'voice' in carried ? carried.voice : existingVoice(l));
  delete carried.voice;
  return {
    ...carried,
    ...(voice ? { voice } : {}),
    portalUrl: o.portalUrl,
    id,
    root: l.root,
    tokenFile: l.token,
    repoPath: l.repo,
    claude,
    appDir: l.daemon,
    tempDir: l.tmp,
    // The Unity slots mailbox stays at its standard place (~/.ff-factory/unity-slots, machine/unitySlots.ts slotsDir),
    // where the game's scripts and a scheduled nightly harness find it with no config (w469).
    ...(o.unitySlotsDir ? { unitySlotsDir: o.unitySlotsDir } : {}),
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

/**
 * The root's own bare clone. `seedFrom`, a local clone of the same repo (a migration's old clone): its origin branches
 * are copied locally instead of downloaded, so no credential is needed. An ssh session on Windows cannot reach the
 * user's GitHub credential (LothDesktop, measured 2026-10-06), while the daemon in the user's session can; the
 * clone's remote is still `url`, and the fetch from it below is then only tried. Exported for tests.
 */
export async function cloneRepo(l: Pick<Layout, 'repo'>, url: string, relative = true, seedFrom?: string, fetchOrigin = true) {
  if (!fs.existsSync(path.join(l.repo, 'HEAD'))) {
    if (seedFrom) {
      say(`Seeding ${l.repo} from ${seedFrom}'s origin branches (local, no download)...`);
      await must('git init', 'git', ['init', '--bare', '--quiet', l.repo]);
      await must('git remote add', 'git', ['-C', l.repo, 'remote', 'add', 'origin', url]);
      await must('git fetch (seed)', 'git', ['-C', l.repo, 'fetch', '--no-tags', '--progress', seedFrom, '+refs/remotes/origin/*:refs/remotes/origin/*'], { live: true });
    } else {
      say(`Cloning ${url} into ${l.repo} (bare; about 1.3 GB of history, git's progress below)...`);
      await must('git clone', 'git', ['clone', '--bare', '--progress', url, l.repo], { live: true });
    }
  }
  // A bare clone has no fetch refspec: sandboxes' branches stay local, origin's go to refs/remotes/origin (docs/worker-root.md 2.3).
  await must('git config', 'git', ['-C', l.repo, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
  // Worktrees record relative paths (git 2.48+), so the root can be moved or renamed (absoluteWorktrees: git's default).
  await must('git config', 'git', ['-C', l.repo, 'config', 'worktree.useRelativePaths', relative ? 'true' : 'false']);
  // The daemon runs non-elevated, where Windows refuses to make symlinks (no Developer Mode), so a checkout of the repo's
  // symlinks (AGENTS.md) fails and the sandbox ends in error. Git for Windows' installer may set core.symlinks true for
  // the whole system, and a clone made elevated (--owner, over ssh) does not get the local false a non-elevated one does
  // (BEAST, w596): set it here, so symlinks check out as plain files the way a person's clone has them.
  if (isWin) await must('git config', 'git', ['-C', l.repo, 'config', 'core.symlinks', 'false']);
  await must('git lfs install', 'git', ['-C', l.repo, 'lfs', 'install', '--local']);
  // An update (w613) fetches nothing: the clone is there, and the daemon fetches with the user's own credentials when it
  // next makes a sandbox. Over ssh a Mac's keychain is out of reach and git fetch fails there (m5, 2026-10-07).
  if (!fetchOrigin) return void say(`Kept the root's clone of the game repo as it is (no fetch: the daemon fetches with your own credentials when it next makes a sandbox).`);
  say('Fetching origin...');
  if (!seedFrom) return void (await must('git fetch', 'git', ['-C', l.repo, 'fetch', '--prune', '--progress', 'origin'], { live: true }));
  const r = await exec('git', ['-c', 'credential.interactive=never', '-C', l.repo, 'fetch', '--prune', 'origin'], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, timeoutMs: 10 * 60_000 });
  if (r.code !== 0) say(`(Could not fetch origin here: ${(r.stderr || r.stdout).trim().split('\n').pop()}. The seed is enough; the daemon fetches with the user's own credentials when it next makes a sandbox.)`);
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
  const plistFile = path.join(agents, `${o.service}.plist`);
  // An update keeps the PATH the daemon had, in its order (w613: m5's ~/.unity/bin moved to the end), and adds what is new.
  const oldPath = o.update && fs.existsSync(plistFile) ? plistPathOf(fs.readFileSync(plistFile, 'utf8')) : undefined;
  const text = plist(probe.home, probe.node!, support.flag, probe.path ?? '', l.daemon, o.service);
  fs.writeFileSync(plistFile, oldPath ? withPlistPath(text, mergePath(oldPath, plistPathOf(text) ?? '')) : text);
  await bash('loading the LaunchAgent', `set -e\n${macReloadLines(`gui/${probe.uid}`, o.service)}`, 2 * 60_000);
  return { version, started: true };
}

/**
 * The supervisor, as this computer has it (w576, lothsahn: "every worker should have a restart daemon--it should be the
 * standard part of the install"). Windows: the task runs this root's run-daemon.ps1 (machineDeployWin supervisorScript),
 * which starts the daemon again whenever it exits, and Task Scheduler restarts the supervisor itself if it fails.
 * A Mac: launchd is the supervisor, by the LaunchAgent's KeepAlive.
 */
export interface SupervisorFacts {
  /** The task, or the LaunchAgent plist. */
  installed: boolean;
  /** The task's action runs this root's run-daemon.ps1; the plist runs this root's daemon. */
  here: boolean;
  /** Task Scheduler's restart on failure; the plist's KeepAlive. */
  restarts: boolean;
  /** run-daemon.ps1 is in the daemon's folder (always true on a Mac). */
  script: boolean;
  /** Supervisors running from this root (Windows), or launchd running the daemon (a Mac). */
  running: number;
}

/** What is wrong with the supervisor; `started` is whether it should run now (someone is logged on). Exported for tests. */
export function supervisorProblems(f: SupervisorFacts, l: Pick<Layout, 'daemon'>, service: string, started: boolean, platform: 'win32' | 'darwin' = isWin ? 'win32' : 'darwin'): string[] {
  const out: string[] = [];
  if (platform === 'win32') {
    const script = path.win32.join(win.winDir(l.daemon), 'run-daemon.ps1');
    if (!f.installed) return [`no ${service} task`];
    if (!f.here) out.push(`the ${service} task does not run ${script} (a task registered for another folder was kept: registering it needs an administrator)`);
    if (!f.restarts) out.push(`the ${service} task is not restarted on failure`);
    if (!f.script) out.push(`${script} is missing`);
    if (started && f.here && f.script && !f.running) out.push(`no supervisor runs from ${script}`);
  } else {
    if (!f.installed) return [`no ${service} LaunchAgent plist`];
    if (!f.here) out.push(`the ${service} LaunchAgent does not run the daemon in ${l.daemon}`);
    if (!f.restarts) out.push(`the ${service} LaunchAgent has no KeepAlive, so launchd does not start the daemon again`);
    if (started && f.here && !f.running) out.push(`launchd does not run ${service}`);
  }
  return out;
}

async function supervisorFacts(l: Layout, service: string): Promise<SupervisorFacts> {
  if (isWin) {
    const out = await ps(
      'checking the supervisor',
      `$ErrorActionPreference = 'Continue'
$s = Join-Path ${win.psq(win.winDir(l.daemon))} 'run-daemon.ps1'
$t = Get-ScheduledTask -TaskName ${win.psq(service)} -ErrorAction SilentlyContinue
"installed=$([bool]$t)"
"here=$([bool]($t -and ([string]$t.Actions[0].Arguments).IndexOf($s, [StringComparison]::OrdinalIgnoreCase) -ge 0))"
"restarts=$([bool]($t -and $t.Settings.RestartCount -gt 0))"
"script=$(Test-Path -LiteralPath $s)"
"running=$(@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -Property CommandLine | Where-Object { ([string]$_.CommandLine).IndexOf($s, [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count)"
`,
    );
    const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(out)?.[1]?.trim() ?? '';
    return { installed: get('installed') === 'True', here: get('here') === 'True', restarts: get('restarts') === 'True', script: get('script') === 'True', running: Number(get('running')) || 0 };
  }
  const file = path.join(os.homedir(), 'Library', 'LaunchAgents', `${service}.plist`);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const state = (await exec('launchctl', ['print', `gui/${process.getuid?.()}/${service}`])).stdout;
  return {
    installed: !!text,
    here: text.includes(`${l.daemon}/app/machine/daemon.ts`),
    restarts: /<key>KeepAlive<\/key>\s*<true\/>/.test(text),
    script: true,
    running: /^\s*state = running$/m.test(state) ? 1 : 0,
  };
}

/** The supervisor is not optional: the install fails until it is in place, and re-running the installer repairs it. */
async function requireSupervisor(l: Layout, service: string, started: boolean): Promise<void> {
  let problems: string[] = [];
  // Start-ScheduledTask and launchctl bootstrap return before the supervisor runs.
  for (let i = 0; i < 30; i++) {
    problems = supervisorProblems(await supervisorFacts(l, service), l, service, started);
    if (!problems.length) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (problems.length) throw new Error(`the daemon's supervisor is not in place: ${problems.join('; ')}. Re-run the installer${isWin ? ' from an administrator PowerShell' : ''} to repair it`);
  say(`Supervisor: ${isWin ? `the ${service} task runs ${path.win32.join(win.winDir(l.daemon), 'run-daemon.ps1')}, which starts the daemon again whenever it exits` : `launchd starts the daemon again whenever it exits (KeepAlive)`}${started ? ', running' : ''}.`);
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
  // The install location chosen in the Hub (LothDesktop: C:\Program Files\Unity\Editor), as machine/unity.ts editorBinary reads it.
  try {
    const chosen = JSON.parse(fs.readFileSync(path.join(hub, 'secondaryInstallPath.json'), 'utf8')) as unknown;
    if (typeof chosen === 'string' && chosen.trim()) roots.push(chosen.trim());
  } catch {
    // no choice made
  }
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

/** Give paths made by an elevated run to `owner` (Windows; `recursive`: every file under them). Exported for migrate.ts. */
export async function giveTo(owner: string, paths: string[], recursive = true) {
  if (!isWin) return;
  for (const p of paths.filter((x) => fs.existsSync(x))) await must(`giving ${p} to ${owner}`, 'icacls', [p, '/setowner', owner, ...(recursive ? ['/T'] : []), '/C', '/Q']);
}

/** Everything in the root to `owner`, but the sandboxes' own trees: a sandbox moved in by a rename keeps its owner. */
async function giveRoot(l: Layout, owner: string) {
  await giveTo(owner, [l.root, l.sandboxes], false);
  await giveTo(owner, fs.readdirSync(l.root).filter((e) => e !== 'sandboxes').map((e) => path.join(l.root, e)));
}

/** Run scripts/worker/firewall.ps1 elevated (one UAC prompt): the slot rules, the editors' rules, the slot config. */
/** firewall.ps1's arguments (the elevated step adds -LogFile). */
/**
 * The player folders of a worker root install: each sandbox slotK (K = 1..sandboxes) owns players/slotK-0 (peer 0,
 * the host) and slotK-1 (peer 1, the client), and runs its built players only from those (lothsahn, w576; the firewall
 * rules name exactly these paths; scripts/nightly/player_slots.py picks them from the sandbox it runs in). Exported for tests.
 */
export function playerFolders(sandboxes: number): string[] {
  const out: string[] = [];
  for (let k = 1; k <= sandboxes; k++) out.push(`slot${k}-0`, `slot${k}-1`);
  // The nightly lab is no sandbox: its own pair (lothsahn, w576: "Let's use slotnightly-0 and slotnightly-1").
  out.push('slotnightly-0', 'slotnightly-1');
  return out;
}

/**
 * Make the player folders `keep` and remove the other slot folders (slotN, slotN-P) under `players`: a smaller sandbox
 * count, or the old slot0..7 pool. One a player still runs from cannot be moved aside and stays, said. Exported for tests.
 */
export function syncPlayerFolders(players: string, keep: string[], log: (line: string) => void = say): { made: string[]; removed: string[]; kept: string[] } {
  const out = { made: [] as string[], removed: [] as string[], kept: [] as string[] };
  fs.mkdirSync(players, { recursive: true });
  for (const name of keep) {
    if (!fs.existsSync(path.join(players, name))) out.made.push(name);
    fs.mkdirSync(path.join(players, name), { recursive: true });
  }
  const want = new Set(keep.map((k) => k.toLowerCase()));
  for (const e of fs.readdirSync(players, { withFileTypes: true })) {
    if (!e.isDirectory() || !/^slot(\d+|nightly)(-\d+)?$/i.test(e.name) || want.has(e.name.toLowerCase())) continue;
    const from = path.join(players, e.name);
    const trash = path.join(players, `${e.name}.removed-${Date.now()}`);
    try {
      fs.renameSync(from, trash); // fails on Windows while a player runs from it, before anything is deleted
    } catch (err) {
      out.kept.push(e.name);
      log(`Kept ${from}: ${(err as NodeJS.ErrnoException).code ?? 'in use'} (a player may still run from it); run the installer again once it ends.`);
      continue;
    }
    fs.rmSync(trash, { recursive: true, force: true });
    out.removed.push(e.name);
  }
  return out;
}

function firewallArgs(action: 'add' | 'remove', l: Layout, slots: number, editors: string[], suffix?: string): string[] {
  const script = path.join(SRC, 'scripts', 'worker', 'firewall.ps1');
  return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Root', l.players, '-Pairs', String(slots), ...(action === 'remove' ? ['-Remove'] : []), ...(editors.length ? ['-UnityExe', editors.join(';')] : []), ...(suffix ? ['-GroupSuffix', suffix] : [])];
}

/**
 * What needs administrator rights on Windows, done in ONE elevated step (one UAC prompt): the firewall rules, and the
 * portal's key in C:\ProgramData\ssh\administrators_authorized_keys for an admin account (w568), which a non-elevated
 * admin cannot even read.
 */
export type ElevatedStep = { kind: 'firewall'; args: string[] } | { kind: 'authorize-key'; file: string; line: string } | { kind: 'revoke-key'; file: string; blob: string };

/** Run the steps in this process when it is elevated, else in an elevated copy of this script (one prompt). Returns its log. */
async function elevatedSteps(steps: ElevatedStep[]): Promise<string> {
  if (!steps.length) return '';
  const tag = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  const log = path.join(os.tmpdir(), `ff-worker-elevated-${tag}.log`);
  const file = path.join(os.tmpdir(), `ff-worker-elevated-${tag}.json`);
  fs.writeFileSync(file, JSON.stringify(steps));
  try {
    let code = 0;
    let out = '';
    if (elevated()) code = await runElevatedSteps(steps, log);
    else {
      // Start-Process -Verb RunAs takes one argument string; it reaches PowerShell through the environment, unquoted by no shell.
      const args = [...process.execArgv, path.join(SRC, 'scripts', 'worker', 'worker.ts'), 'elevated', '--steps', file, '--log', log];
      const line = args.map((a) => (/[\s;]/.test(a) ? `"${a}"` : a)).join(' ');
      const r = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$p = Start-Process $env:FFW_NODE -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList $env:FFW_ARGS; exit $p.ExitCode'], { env: { ...process.env, FFW_NODE: process.execPath, FFW_ARGS: line } });
      code = r.code ?? 1;
      out = `${r.stderr}${r.stdout}`;
    }
    const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    if (code !== 0) throw new Error(`the administrator step failed or was declined (${code}): ${(text || out).trim().slice(-600)}`);
    return text.trim();
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(log, { force: true });
  }
}

/** The elevated half (`worker.ts elevated`): each step in order, its words appended to `log`. Returns an exit code. */
export async function runElevatedSteps(steps: ElevatedStep[], log: string): Promise<number> {
  const note = (line: string) => fs.appendFileSync(log, `${line}\n`);
  try {
    for (const s of steps) {
      if (s.kind === 'firewall') {
        const r = await exec('powershell.exe', [...s.args, '-LogFile', log]);
        if (r.code !== 0) throw new Error(`firewall.ps1 exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(-400)}`);
      } else if (s.kind === 'authorize-key') {
        const r = authorizeIn(s.file, s.line);
        const acl = await exec('icacls', aclArgs(s.file, true));
        if (acl.code !== 0) throw new Error(`icacls ${s.file} exited ${acl.code}: ${(acl.stderr || acl.stdout).trim().slice(-300)}`);
        note(`The portal's ssh key: ${r.changed ? (r.existed ? 'updated in' : 'added to') : 'already in'} ${s.file} (Administrators and SYSTEM only).`);
        note(`key-existed=${r.existed}`);
      } else {
        note(`The portal's ssh key: removed ${revokeIn(s.file, s.blob)} line(s) from ${s.file}.`);
      }
    }
    return 0;
  } catch (e) {
    note(`FAILED: ${(e as Error).message}`);
    return 1;
  }
}

/** The portal's key line for this machine and where it goes (w568), or why not (the step is skipped, never fatal). */
async function portalKeyPlan(o: InstallOptions, home: string): Promise<{ file: string; line: string; admin: boolean } | { skip: string }> {
  if (o.ssh === false) return { skip: 'skipped (--no-ssh)' };
  const k = await fetchPortalKey(o.portalUrl, o.token);
  if (!k.ok) return { skip: k.error };
  const admin = isWin && !o.sshUser && adminFromProbe(await ps('checking whether this account is an administrator', ADMIN_PROBE_PS));
  return { file: authorizedKeysFile(process.platform, home, admin), line: k.key.authorizedKey, admin };
}

/** This computer's tailnet name (Tailscale's CLI), or undefined. */
async function tailnetName(): Promise<string | undefined> {
  for (const bin of tailscaleCandidates()) {
    const r = await exec(bin, ['status', '--json'], { timeoutMs: 15_000 }).catch(() => undefined);
    const name = r?.code === 0 ? tailnetNameOf(r.stdout) : undefined;
    if (name) return name;
  }
  return undefined;
}

/**
 * The portal's ssh, its second half (w568): this machine's host keys from its own sshd (loopback, no network in
 * between), with its ssh user and the name the portal reaches it by, to POST /machine/ssh; the portal pins them and
 * answers whether its ssh gets in. Never fatal: ssh is the portal's way to start, stop or unload this daemon from afar.
 */
async function registerPortalSsh(o: InstallOptions) {
  const scan = await exec(isWin ? 'ssh-keyscan.exe' : 'ssh-keyscan', ['-T', '5', '-t', 'ed25519,ecdsa,rsa', '127.0.0.1'], { timeoutMs: 30_000 }).catch(() => undefined);
  const hostKeys = parseKeyscan(scan?.stdout ?? '');
  if (!hostKeys.length) {
    say(`The portal's ssh: no sshd answers on this computer (${isWin ? 'the OpenSSH Server service' : 'Remote Login, in System Settings > General > Sharing'}), so the portal cannot start, stop or unload this daemon from afar. Turn it on and run this installer again.`);
    return;
  }
  const host = (o.sshHost ?? (await tailnetName()) ?? hostnameFallback()).toLowerCase();
  const user = o.sshUser ?? os.userInfo().username;
  const r = await registerSsh(o.portalUrl, o.token, { user, host, hostKeys });
  if (!r.ok) say(`The portal's ssh: could not register this machine's host keys (${r.error}).`);
  else if (r.reachable) say(`The portal's ssh: it reaches this machine as ${r.host}, its host key pinned there.`);
  else say(`The portal's ssh: registered as ${r.host} (host key pinned), but its ssh does not get in yet: ${r.detail}`);
}

/** Ask a yes/no question on the terminal; `yes` answers it. */
async function confirm(question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) return false;
  process.stdout.write(`${question} [y/N] `);
  const answer = await new Promise<string>((resolve) => process.stdin.once('data', (d) => resolve(String(d).trim().toLowerCase())));
  return answer === 'y' || answer === 'yes';
}

export async function install(o: InstallOptions, from = SRC, phase: 'all' | 'prepare' | 'finish' = 'all'): Promise<boolean> {
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
    return false;
  }
  const id = f.credentialId!;
  say(`OK: machine ${id}, node ${f.nodeVersion}, git ${f.git!.join('.')}, Claude Code ${f.claude ?? `${f.claudeShim} (an npm shim: agents use the Agent SDK's own Claude Code)`}, ${f.freeGB ?? '?'} GB free.`);

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
    slots: o.maxSandboxes,
    repoUrl: o.repoUrl,
    ...(o.firewallSuffix ? { firewallSuffix: o.firewallSuffix } : {}),
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    outside: prev?.outside ?? [],
  };
  writeManifest(l.root, m);
  const pf = syncPlayerFolders(l.players, playerFolders(o.maxSandboxes));
  say(`Player folders: ${playerFolders(o.maxSandboxes).length} (slot1-0..slot${o.maxSandboxes}-1 and slotnightly-0, -1)${pf.made.length ? `, ${pf.made.length} made` : ''}${pf.removed.length ? `; removed ${pf.removed.join(', ')}` : ''}${pf.kept.length ? `; still in use: ${pf.kept.join(', ')}` : ''}.`);

  // 2. The credential, owner-only.
  // The folder first: a file written after inherits its owner-only rights (and one from an earlier run gets them back).
  await lockDown(l.secrets, f.probe.sid);
  fs.writeFileSync(l.token, o.token.trim() + '\n', { mode: 0o600 });
  await lockDown(l.secrets, f.probe.sid);

  // 3. The game repo, bare, and the installer's own checkout.
  await cloneRepo(l, o.repoUrl, !o.absoluteWorktrees, o.seedFrom, !o.update);
  await syncSource(l, from);
  if (o.owner) await giveRoot(l, o.owner);

  if (phase === 'prepare') return true;

  // The Unity slots mailbox the daemon will use, outside the root on purpose; the uninstall removes it.
  noteOutside(m, { kind: 'file', name: o.unitySlotsDir ?? path.join(os.homedir(), '.ff-factory', 'unity-slots'), note: 'the Unity slots mailbox every script finds (w469)' });
  writeManifest(l.root, m);

  // 4. The daemon and its service. A test install cleans nothing: its settings are in place before it first starts.
  if (o.noCleanup) fs.writeFileSync(path.join(l.daemon, 'cleanup.json'), JSON.stringify({ everyMinutes: 0, softFreeGB: 0, staleOutput: { mode: 'off' } }));
  noteOutside(m, isWin ? { kind: 'task', name: o.service, note: 'runs the daemon at logon' } : { kind: 'launchagent', name: o.service, note: '~/Library/LaunchAgents' });
  writeManifest(l.root, m);
  const d = isWin ? await installDaemonWin(o, l, id, f.probe) : await installDaemonMac(o, l, id, f.probe);
  say(`Daemon ${d.version} installed as ${isWin ? `the ${o.service} task` : `the ${o.service} LaunchAgent`}${d.started ? ' and started' : ' (it starts at the next logon)'}.`);
  await requireSupervisor(l, o.service, d.started);
  // No Unity slots pointer: the mailbox stays at its standard place in the home folder (daemonJson), where the daemon,
  // its agents and scripts outside it (the nightly harness, a build by hand) all find it with no config (w469,
  // machine/unitySlots.ts slotsDir). One mailbox, so they can never disagree. The uninstall still removes a pointer
  // into its root (an install from before this), and slotsDir still honours one a person writes.

  // 5. The portal's key (w568): fetched with this machine's credential; on Windows an admin account's goes in the shared
  //    administrators_authorized_keys, in the one administrator step below, any other account's in its own file now.
  const key = await portalKeyPlan(o, f.probe.home);
  const steps: ElevatedStep[] = [];
  let keyExisted: boolean | undefined;
  if ('skip' in key) say(`The portal's ssh key: not added (${key.skip}).`);
  else if (isWin && key.admin) steps.push({ kind: 'authorize-key', file: key.file, line: key.line });
  else {
    const r = authorizeIn(key.file, key.line);
    if (isWin) await must('setting the rights of authorized_keys', 'icacls', aclArgs(key.file, false, f.probe.sid ? `*${f.probe.sid}` : undefined));
    keyExisted = r.existed;
    say(`The portal's ssh key: ${r.changed ? (r.existed ? 'updated in' : 'added to') : 'already in'} ${key.file}.`);
  }

  // Windows Firewall: the fixed slot paths and the Unity editors, once; with the admin key, in the same prompt.
  if (isWin && o.firewall) {
    const editors = unityEditors(f.probe.home);
    const sfx = o.firewallSuffix ? ` ${o.firewallSuffix}` : '';
    noteOutside(m, { kind: 'firewall-group', name: SLOT_GROUP + sfx, note: `${o.maxSandboxes} sandboxes' player folders (slot1-0..slot${o.maxSandboxes}-1) and the nightly lab's (slotnightly-0, -1) under ${l.players}` });
    if (editors.length) noteOutside(m, { kind: 'firewall-group', name: UNITY_GROUP + sfx, note: editors.join('; ') });
    if (!o.firewallSuffix) noteOutside(m, { kind: 'file', name: path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'FinalFactory', 'player-slots.json'), note: 'the slot root for scripts outside the daemon' });
    writeManifest(l.root, m);
    steps.unshift({ kind: 'firewall', args: firewallArgs('add', l, o.maxSandboxes, editors, o.firewallSuffix) });
  } else if (isWin) say('Skipped the firewall rules (--no-firewall): players will prompt on first start.');
  if (steps.length && o.update && !elevated() && !process.stdin.isTTY) {
    // Nobody can answer an administrator prompt here (an ssh session that is not elevated): what the install put there stays.
    say(`Skipped ${steps.map((s) => (s.kind === 'firewall' ? 'the firewall rules' : "the portal's ssh key in administrators_authorized_keys")).join(' and ')}: this session is not elevated and nobody can answer a prompt; the ones the install made stay (an elevated or interactive update refreshes them).`);
  } else if (steps.length) {
    say(`${steps.map((s) => (s.kind === 'firewall' ? 'Windows Firewall: adding the rules' : "the portal's ssh key into administrators_authorized_keys")).join(', and ')} (one administrator prompt)...`);
    const text = await elevatedSteps(steps);
    const existed = /^key-existed=(true|false)$/m.exec(text)?.[1];
    if (existed) keyExisted = existed === 'true';
    say(text.replace(/^key-existed=.*\n?/m, '').trim());
  }
  if (!('skip' in key) && keyExisted !== undefined) {
    const blob = keyBlob(key.line)!;
    if (!m.outside.some((x) => x.kind === 'authorized-key' && x.name.toLowerCase() === key.file.toLowerCase())) m.outside.push({ kind: 'authorized-key', name: key.file, note: blob, ...(keyExisted ? { existed: true } : {}) });
    writeManifest(l.root, m);
  }
  if (!isWin) {
    // A Mac has no firewall rules to make; scripts outside the daemon (the nightly lab's LaunchAgent) find the slots here.
    // Its own block: as the else of the key step above it never ran on a Mac whose ssh key was set (m3, w596).
    const cfg = writeMacSlotConfig(l.players, o.maxSandboxes);
    noteOutside(m, { kind: 'file', name: cfg, note: 'the slot root for scripts outside the daemon' });
    writeManifest(l.root, m);
  }

  if (o.owner) await giveRoot(l, o.owner);

  // The portal's ssh, its second half (w568): this machine's host keys pinned there, and its ssh tried.
  if (o.ssh !== false) await registerPortalSsh(o);

  // 6. The portal sees it.
  const p = new Progress();
  for (let i = 0; i < 45; i++) {
    const w = await whoami(o.portalUrl, o.token);
    if (w.ok && w.me.online) {
      p.done(`The portal sees ${id} online${w.me.root ? ` with root ${w.me.root}` : ''}.`);
      await nightlyTaskCheck(l);
      summary(l, m);
      return true;
    }
    p.update(`waiting for the daemon to connect to ${o.portalUrl} (${i * 2}s)`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  p.done(`The daemon has not connected yet. Its log: ${path.join(l.logs, 'daemon.log')}`);
  process.exitCode = 1;
  await nightlyTaskCheck(l);
  summary(l, m);
  return false;
}

/** The nightly e2e lab's scheduled task on a Windows lab PC, made by the game repo's scripts/nightly/install_schedule.sh. */
// ---------------------------------------------------------------- update (w613)

/** What `worker.ts update` takes on its command line; every setting it does not name comes from the install there. */
export interface UpdateFlags {
  maxSandboxes?: number;
  maxAgentsPerSandbox?: number;
  maxUnity?: number;
  /** Windows, elevated: who gets what the update makes (default: the user the daemon's task runs as). */
  owner?: string;
  /** The daemon code: "portal" (the commit the portal runs, the default), a branch or a commit of ff-factory. */
  ref?: string;
  /** A local ff-factory checkout to install from instead, with no download at all. */
  source?: string;
  /** Override what the install did: firewall rules (Windows) and the portal's ssh (--no-firewall, --no-ssh). */
  firewall?: boolean;
  ssh?: boolean;
  /** The GPU Whisper for the portal's mic (w615): a model name turns it on, "off" turns it off; unset carries daemon.json's. */
  voiceWhisper?: string;
}

/**
 * The install options an update runs with (w613): the root's own root.json and daemon.json, every setting carried
 * (beast's agent total, protected paths, the Library seed, the editors' priority, the disk guard, cleanup, the Unity
 * paths), the limits from the flags only when given, and the machine's own credential. Exported for tests.
 */
export function planUpdate(root: string, m: Manifest, config: Record<string, unknown>, token: string, f: UpdateFlags & { absoluteWorktrees?: boolean }): InstallOptions {
  const pool = (config.sandboxes && typeof config.sandboxes === 'object' ? config.sandboxes : {}) as Record<string, unknown>;
  const pick = (flag: number | undefined, key: string, fallback: number) => (flag !== undefined ? flag : typeof pool[key] === 'number' ? (pool[key] as number) : fallback);
  const maxSandboxes = pick(f.maxSandboxes, 'maxSandboxes', m.slots || 3);
  const maxAgentsPerSandbox = pick(f.maxAgentsPerSandbox, 'maxAgentsPerSandbox', 2);
  const maxUnity = pick(f.maxUnity, 'maxUnity', 2);
  return {
    root,
    portalUrl: String(config.portalUrl || m.portalUrl).replace(/\/+$/, ''),
    token,
    maxSandboxes,
    maxAgentsPerSandbox,
    maxUnity,
    repoUrl: m.repoUrl || DEFAULT_REPO,
    service: m.service,
    // As the install had them: firewall rules only if it made them, the portal's ssh only if it set it up (root.json's
    // outside list records both), unless a flag says otherwise.
    firewall: f.firewall ?? m.outside.some((x) => x.kind === 'firewall-group'),
    ssh: f.ssh ?? m.outside.some((x) => x.kind === 'authorized-key'),
    ...(m.firewallSuffix ? { firewallSuffix: m.firewallSuffix } : {}),
    ...(typeof config.unitySlotsDir === 'string' ? { unitySlotsDir: config.unitySlotsDir } : {}),
    ...(f.absoluteWorktrees ? { absoluteWorktrees: true } : {}),
    ...(f.owner ? { owner: f.owner } : {}),
    ...(f.voiceWhisper !== undefined ? { voiceWhisper: f.voiceWhisper } : {}),
    carry: { ...config, sandboxes: { ...pool, maxSandboxes, maxAgentsPerSandbox, maxUnity } },
    update: true,
  };
}

/** Every setting as a dotted path and its value (JSON), for the diff an update prints. */
function flatten(v: unknown, at = '', out: Record<string, string> = {}): Record<string, string> {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) flatten(x, at ? `${at}.${k}` : k, out);
  } else if (at) out[at] = JSON.stringify(v);
  return out;
}

/** What an update changed in daemon.json, one line a setting (never a token: daemon.json holds only its file's path). Exported for tests. */
export function settingsDiff(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const a = flatten(before);
  const b = flatten(after);
  const lines: string[] = [];
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (/token/i.test(k) && !/file/i.test(k)) continue;
    if (a[k] === b[k]) continue;
    lines.push(a[k] === undefined ? `+ ${k}: ${b[k]}` : b[k] === undefined ? `- ${k}: ${a[k]}` : `~ ${k}: ${a[k]} -> ${b[k]}`);
  }
  return lines;
}

/** The PATH a LaunchAgent plist gives the daemon, or undefined. Exported for tests. */
export function plistPathOf(text: string): string | undefined {
  const m = /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/.exec(text);
  return m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : undefined;
}

/** The plist with its PATH replaced. */
export function withPlistPath(text: string, value: string): string {
  const x = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text.replace(/(<key>PATH<\/key>\s*<string>)[^<]*(<\/string>)/, (_m, a: string, b: string) => `${a}${x}${b}`);
}

/** The old PATH's folders in their order, then the new one's that it lacks. Exported for tests. */
export function mergePath(old: string, now: string): string {
  const a = old.split(':').filter(Boolean);
  return [...a, ...now.split(':').filter((d) => d && !a.includes(d))].join(':');
}

/** The daemon code a root runs (its app's machine/VERSION), or undefined. */
function daemonVersionIn(l: Layout): string | undefined {
  try {
    return fs.readFileSync(path.join(l.daemon, 'app', 'machine', 'VERSION'), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/** ff-factory, public: fetched with no credential helper and no prompt, so no keychain or credential manager is asked. */
const FF_FACTORY = 'https://github.com/Final-Factory/ff-factory.git';
const anonymousGit = ['-c', 'credential.helper=', '-c', 'core.askPass=', '-c', 'credential.interactive=never'];
const anonymousEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' });

/** The commit the portal runs (GET /api/health), or undefined. */
async function portalSha(portalUrl: string, fetcher: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const r = await fetcher(`${portalUrl}/api/health`, { signal: AbortSignal.timeout(15_000) });
    const sha = r.ok ? ((await r.json()) as { sha?: string }).sha : undefined;
    return sha && /^[0-9a-f]{7,40}$/i.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The daemon code for an update, in the root's installer checkout (<root>/daemon/src): `--source`, a local checkout, as
 * it is; else ff-factory's public repo, fetched anonymously (no keychain, no credential manager, no prompt), at the
 * portal's own commit by default, so the daemon is never newer or older than its portal. Returns the checkout and its commit.
 */
async function updateSource(l: Layout, f: UpdateFlags, portalUrl: string): Promise<{ from: string; commit: string }> {
  if (f.source) {
    if (!fs.existsSync(path.join(f.source, 'machine', 'daemon.ts'))) throw new Error(`--source ${f.source} is not an ff-factory checkout (no machine/daemon.ts)`);
    return { from: f.source, commit: (await must('git rev-parse', 'git', ['-C', f.source, 'rev-parse', 'HEAD'])).trim() };
  }
  let want = f.ref ?? 'portal';
  if (want === 'portal') {
    const sha = await portalSha(portalUrl);
    if (!sha) throw new Error(`the portal at ${portalUrl} does not say which commit it runs (GET /api/health): pass --ref main (or a commit), or --source <checkout>`);
    want = sha;
  }
  if (!fs.existsSync(path.join(l.src, '.git'))) {
    fs.mkdirSync(l.src, { recursive: true });
    await must('git init (the installer checkout)', 'git', ['init', '--quiet', l.src]);
  }
  const env = anonymousEnv();
  const fetched = await exec('git', [...anonymousGit, '-C', l.src, 'fetch', '--quiet', '--no-tags', FF_FACTORY, '+refs/heads/main:refs/remotes/github/main', ...(/^[0-9a-f]{40}$/i.test(want) || /^[0-9a-f]{7,39}$/i.test(want) ? [] : [`+refs/heads/${want}:refs/remotes/github/${want}`])], { env, timeoutMs: 10 * 60_000 });
  if (fetched.code !== 0) throw new Error(`could not fetch ff-factory anonymously from ${FF_FACTORY} (${(fetched.stderr || fetched.stdout).trim().split('\n').pop()}): check this computer's network, or pass --source <a local ff-factory checkout>`);
  const name = /^[0-9a-f]{7,40}$/i.test(want) ? want : `refs/remotes/github/${want}`;
  const r = await exec('git', ['-C', l.src, 'rev-parse', '--verify', '--quiet', `${name}^{commit}`]);
  const commit = r.stdout.trim();
  if (r.code !== 0 || !commit) throw new Error(`${f.ref ?? `the portal's commit ${want}`} is not on ff-factory's main (fetched from ${FF_FACTORY}): pass --ref main or --source <checkout>`);
  await must('checking out the daemon code', 'git', ['-C', l.src, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--force', '--detach', commit]);
  return { from: l.src, commit };
}

/** Windows: the user the daemon's task runs as (its principal), as icacls takes it (a SID as *S-1-...), or undefined. */
async function taskUser(service: string): Promise<{ owner: string; sid?: string } | undefined> {
  const out = (await ps('reading the daemon task\'s user', `$t = Get-ScheduledTask -TaskName ${win.psq(win.taskName({ task: service }))} -ErrorAction SilentlyContinue\nif ($t) { [string]$t.Principal.UserId }\n`).catch(() => '')).trim();
  if (!out) return undefined;
  return /^S-1-[\d-]+$/.test(out) ? { owner: `*${out}`, sid: out } : { owner: out };
}

/** The portal's view of the daemon now: online, and the code it runs (a portal from before w613 does not say). */
async function portalView(portalUrl: string, token: string) {
  const w = await whoami(portalUrl, token);
  return w.ok ? w.me : undefined;
}

/**
 * `worker.ts update --root <root>` (w613): update this machine's install in place, as safe to re-run as the install.
 * Everything comes from what is there: root.json, daemon.json (every setting carried unless a flag changes it), the
 * machine's own credential (secrets/machine-token: nothing is issued, asked for or printed), the LaunchAgent's PATH, the
 * task's user. It fetches no game repo, takes ff-factory anonymously, restarts the daemon and checks the portal sees the
 * new code online. Prints the commit and settings before and after. Returns whether the portal sees it.
 */
export async function update(root: string, f: UpdateFlags): Promise<boolean> {
  const l = layoutOf(path.resolve(root));
  const m = readManifest(l.root);
  if (!m) throw new Error(`no worker install at ${l.root} (no root.json): install it first (docs/worker-install.md, "Install")`);
  const configFile = path.join(l.daemon, 'daemon.json');
  if (!fs.existsSync(configFile)) throw new Error(`no ${configFile}: this root's daemon was never installed; run the install instead`);
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<string, unknown>;
  if (!fs.existsSync(l.token)) throw new Error(`no credential at ${l.token}: an update reuses the machine's own; without it, install again with a new one (sudo fffctl machine-credential issue ${m.machineId})`);
  const token = fs.readFileSync(l.token, 'utf8').trim();
  if (credentialId(token) !== m.machineId) throw new Error(`${l.token} does not hold machine ${m.machineId}'s credential`);
  const portalUrl = String(config.portalUrl || m.portalUrl).replace(/\/+$/, '');
  const before = { version: daemonVersionIn(l), view: await portalView(portalUrl, token) };
  say(`FF Factory worker update of ${l.root} (machine ${m.machineId})`);
  say(`Before: daemon ${before.version ?? 'unknown'}; the portal sees it ${before.view?.online ? 'online' : 'offline'}${before.view?.agents.length ? `, ${before.view.agents.length} live agent(s): ${before.view.agents.map((a) => `${a.id}${a.sandbox ? ` in ${a.sandbox}` : ''}${a.midTurn ? ' (mid-turn)' : ''}`).join(', ')}` : ''}.`);
  const code = await updateSource(l, f, portalUrl);
  say(`The daemon code: ff-factory ${code.commit.slice(0, 12)}${f.source ? ` from ${f.source}` : f.ref && f.ref !== 'portal' ? ` (${f.ref})` : ' (the commit the portal runs)'}.`);
  let owner = f.owner;
  if (isWin && elevated() && !owner) {
    // Elevated (an administrator's ssh session, w613: BEAST's): what the update makes goes to the task's own user, as
    // --owner does for the portal's ssh deploy, so the daemon's non-elevated git does not find Administrators' files.
    const who = await taskUser(m.service);
    if (!who) throw new Error(`this session is elevated and the ${m.service} task is missing, so there is no user to give the files to: pass --owner <user>, or run the install from that user's own session`);
    const me = (await ps('reading this session\'s user', '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value')).trim();
    if (who.sid && who.sid !== me) throw new Error(`the ${m.service} task runs as ${who.sid}, not this session's user ${me}: update from that user's session (ssh in as them), or pass --owner`);
    owner = who.owner;
    say(`Elevated session: what the update makes goes to ${owner}, the user the ${m.service} task runs as.`);
  }
  const rel = (await exec('git', ['-C', l.repo, 'config', '--get', 'worktree.useRelativePaths'])).stdout.trim();
  const o = planUpdate(l.root, m, config, token, { ...f, absoluteWorktrees: rel === 'false', ...(owner ? { owner } : {}) });
  let ok = await install(o, code.from);
  const want = daemonVersionIn(l);
  const current = (v: Awaited<ReturnType<typeof portalView>>) => !!v?.online && (!v.daemon || !want || v.daemon.startsWith(want) || want.startsWith(v.daemon));
  if (!ok || !current(await portalView(portalUrl, token))) {
    say(`The portal does not see the new daemon yet: restarting it once (${isWin ? `the ${o.service} task` : `the ${o.service} LaunchAgent`})...`);
    if (isWin) await ps('restarting the daemon', win.controlScript('restart', l.daemon, { task: o.service, only: true }));
    else await bash('restarting the daemon', macControlScript('restart', o.service));
    ok = false;
  }
  const p = new Progress();
  let view = await portalView(portalUrl, token);
  for (let i = 0; i < 60 && !current(view); i++) {
    p.update(`waiting for the portal to see daemon ${want ?? ''} online (${i * 2}s)`);
    await new Promise((r) => setTimeout(r, 2000));
    view = await portalView(portalUrl, token);
  }
  ok = current(view);
  p.done();
  const after = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<string, unknown>;
  const diff = settingsDiff(config, after);
  say(`\nAfter: daemon ${want ?? 'unknown'} (was ${before.version ?? 'unknown'}).`);
  say(diff.length ? `Settings changed (daemon.json; everything else carried):\n${diff.map((d) => `  ${d}`).join('\n')}` : 'Settings: none changed (every setting carried).');
  say(`Credential: the machine's own (${path.basename(l.token)}), reused; nothing issued or printed.`);
  if (ok) {
    say(`The portal sees ${m.machineId} online${view?.daemon ? ` running ${view.daemon}` : ''}${view?.outdated ? `, but OUTDATED: ${view.outdated}` : view?.daemon ? ', not outdated' : ' (this portal does not report the daemon\'s version yet)'}${view?.agents.length ? `; ${view.agents.length} live agent(s)` : ''}.`);
    if (view?.outdated) ok = false;
  } else say(`The portal does not see ${m.machineId} online with the new daemon. Its log: ${path.join(l.logs, 'daemon.log')}`);
  process.exitCode = ok ? 0 : 1;
  return ok;
}

export const NIGHTLY_TASK = 'ff-nightly-e2e';

/**
 * w577: the nightly lab's schedule names its root on its command line (FF_NIGHTLY_ROOT=... bash <root>/FinalFactory/...),
 * so a root move leaves it where it was: after w513, lothdesktop's task still ran the deleted D:\work\ff-nightly.
 * The line to say when the task's definition (schtasks /xml) does not name this root's nightly/, in either path form;
 * undefined when it does or there is no task. Exported for tests.
 */
export function nightlyTaskProblem(definition: string | undefined, nightly: string): string | undefined {
  if (!definition?.trim()) return undefined;
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const want = norm(nightly);
  const drive = /^([a-z]):\/(.*)$/.exec(want);
  const forms = drive ? [want, `/${drive[1]}/${drive[2]}`] : [want];
  const d = norm(definition);
  if (forms.some((f) => d.includes(f))) return undefined;
  const ran = /<Arguments>([^<]*)<\/Arguments>/.exec(definition)?.[1]?.replace(/&quot;/g, '"').trim();
  return `The nightly lab's task ${NIGHTLY_TASK} does not run from ${nightly}${ran ? ` (it runs: ${ran})` : ''}. Re-point it from any game checkout: FF_NIGHTLY_ROOT="${nightly}" bash scripts/nightly/install_schedule.sh (it makes the nightly checkout there and replaces the task).`;
}

/** Say whether the nightly lab's task follows this root (Windows; the M3's LaunchAgent moves with its own runbook). */
async function nightlyTaskCheck(l: Layout) {
  if (!isWin) return;
  const r = await exec('schtasks', ['/query', '/tn', NIGHTLY_TASK, '/xml'], { timeoutMs: 30_000 });
  if (r.code !== 0) return; // no nightly lab on this machine
  const problem = nightlyTaskProblem(r.stdout, l.nightly);
  say(problem ? `\nWARNING: ${problem}` : `The nightly lab's task ${NIGHTLY_TASK} runs from ${l.nightly}.`);
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
  else {
    // bootout returns before the daemon has gone (it stops its agents first): wait until launchd no longer has it.
    await bash('unloading the LaunchAgent', `${macControlScript('uninstall', m.service)}i=0\nwhile launchctl print gui/$(id -u)/${m.service} >/dev/null 2>&1 && [ $i -lt 60 ]; do sleep 1; i=$((i+1)); done\n`, 2 * 60_000);
  }
  say(`Removed the ${m.service} ${isWin ? 'task' : 'LaunchAgent'}.`);
  say(`Stopped ${await stopRootProcesses(l.root)} process(es) still running from the root.`);

  // 4. Firewall rules, the portal's ssh key (w568: exactly its lines, unless they were there before) and the slot config.
  const steps: ElevatedStep[] = [];
  if (isWin && m.outside.some((x) => x.kind === 'firewall-group')) steps.push({ kind: 'firewall', args: firewallArgs('remove', l, m.slots, [], m.firewallSuffix) });
  for (const k of m.outside.filter((x) => x.kind === 'authorized-key' && !x.existed && x.note)) {
    if (isWin && /administrators_authorized_keys$/i.test(k.name)) steps.push({ kind: 'revoke-key', file: k.name, blob: k.note! });
    else say(`The portal's ssh key: removed ${revokeIn(k.name, k.note!)} line(s) from ${k.name}.`);
  }
  if (steps.length) say(await elevatedSteps(steps));
  if (!isWin && slotConfigRoot(macSlotConfig())?.startsWith(l.root)) {
    fs.rmSync(macSlotConfig(), { force: true });
    say(`Removed ${macSlotConfig()}.`);
  }
  if (removeSlotsPointer(l.root)) say(`Removed ${slotsPointer()}.`);

  // The Unity slots mailbox (only when this install recorded it), and its folder when nothing else is left in it.
  for (const o2 of m.outside.filter((x) => x.kind === 'file' && /unity-slots$/.test(x.name))) {
    fs.rmSync(o2.name, { recursive: true, force: true });
    const parent = path.dirname(o2.name);
    if (path.basename(parent) === '.ff-factory' && fs.existsSync(parent) && !fs.readdirSync(parent).length) fs.rmdirSync(parent);
    say(`Removed the Unity slots mailbox ${o2.name}.`);
  }

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
"slotRules=$(@(Get-NetFirewallRule -Group ${win.psq(SLOT_GROUP + (m?.firewallSuffix ? ` ${m.firewallSuffix}` : ''))} -ErrorAction SilentlyContinue).Count)"
"unityRules=$(@(Get-NetFirewallRule -Group ${win.psq(UNITY_GROUP + (m?.firewallSuffix ? ` ${m.firewallSuffix}` : ''))} -ErrorAction SilentlyContinue).Count)"
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
    const sfx = m?.firewallSuffix ? ` ${m.firewallSuffix}` : '';
    const ours = (g: string) => !!m?.outside.some((o) => o.kind === 'firewall-group' && o.name === g + sfx);
    const group = (g: string, n: string) => ({ what: `firewall group "${g}${sfx}"${ours(g) ? '' : ' (not made by this install)'}`, present: ours(g) && Number(n) > 0, detail: `${n} rule(s)` });
    const sup = await supervisorFacts(l, service);
    items.push(
      { what: `scheduled task ${service}`, present: get('task') === 'True' },
      { what: `the supervisor ${path.win32.join(win.winDir(l.daemon), 'run-daemon.ps1')}`, present: sup.script || sup.running > 0, detail: `${sup.running} running` },
      group(SLOT_GROUP, get('slotRules')),
      group(UNITY_GROUP, get('unityRules')),
      { what: `firewall rules naming a path in the root`, present: Number(get('rootRules')) > 0, detail: `${get('rootRules')} rule(s)` },
      { what: 'slot config %ProgramData%\\FinalFactory\\player-slots.json pointing into the root', present: !!cfgRoot && cfgRoot.toLowerCase().startsWith(l.root.toLowerCase()), detail: cfgRoot || 'none' },
      slotsPointerItem(l.root),
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
      { what: `slot config ${macSlotConfig()} pointing into the root`, present: !!slotConfigRoot(macSlotConfig())?.startsWith(l.root), detail: slotConfigRoot(macSlotConfig()) ?? 'none' },
      slotsPointerItem(l.root),
    );
  }
  // The portal's ssh key (w568): its lines, unless they were there before the install. Windows' admin file cannot be
  // read without administrator rights: the uninstall's elevated step said what it removed.
  for (const k of m?.outside.filter((x) => x.kind === 'authorized-key' && !x.existed && x.note) ?? []) {
    if (isWin && /administrators_authorized_keys$/i.test(k.name) && !elevated()) continue;
    let text = '';
    try {
      text = fs.readFileSync(k.name, 'utf8');
    } catch {
      // gone with its folder
    }
    items.push({ what: `the portal's ssh key in ${k.name}`, present: text.split(/\r?\n/).some((line) => keyBlob(line) === k.note) });
  }
  return items;
}

/** The Unity slots pointer for scripts outside the daemon (machine/unitySlots.ts slotsPointer): `{ "dir": <root>/daemon/unity-slots }`. Exported for tests. */
export function writeSlotsPointer(l: Pick<Layout, 'daemon'>, home = os.homedir()): string {
  const file = slotsPointer(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ dir: path.join(l.daemon, 'unity-slots') }, null, 2) + '\n');
  return file;
}

/** Remove the Unity slots pointer when it points into `root` (another install's is left). Returns whether it did. Exported for tests. */
export function removeSlotsPointer(root: string, home = os.homedir()): boolean {
  const dir = slotsPointerDir(home);
  if (!dir || !pathKey(dir).startsWith(pathKey(root))) return false;
  fs.rmSync(slotsPointer(home), { force: true });
  return true;
}

/** The folder the Unity slots pointer names, if there is one. */
function slotsPointerDir(home = os.homedir()): string | undefined {
  try {
    const dir = (JSON.parse(fs.readFileSync(slotsPointer(home), 'utf8')) as { dir?: unknown }).dir;
    return typeof dir === 'string' ? dir : undefined;
  } catch {
    return undefined;
  }
}

/** The leftover check's line for the Unity slots pointer (w469). */
function slotsPointerItem(root: string) {
  const dir = slotsPointerDir();
  return { what: `Unity slots pointer ${slotsPointer()} pointing into the root`, present: !!dir && pathKey(dir).startsWith(pathKey(root)), detail: dir ?? 'none' };
}

/** A path as compared on this OS: case and either slash on Windows. */
const pathKey = (p: string) => (process.platform === 'win32' ? p.replace(/\\/g, '/').toLowerCase() : p);

/** A Mac's slot config for player_slots.py: the root's players, the sandbox-pairs layout, the sandbox count (w576). Exported for tests. */
export function writeMacSlotConfig(players: string, sandboxes: number, file = macSlotConfig()): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ root: players, layout: 'sandbox-pairs', count: sandboxes }, null, 2) + '\n');
  return file;
}

/** Where scripts/nightly/player_slots.py reads a Mac's slot root (its config_path()). */
export const macSlotConfig = (home = os.homedir()) => path.join(home, '.config', 'finalfactory', 'player-slots.json');

function slotConfigRoot(file: string): string | undefined {
  try {
    return (JSON.parse(fs.readFileSync(file, 'utf8')) as { root?: string }).root;
  } catch {
    return undefined;
  }
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

const USAGE = `node scripts/worker/worker.ts <install|update|uninstall|check> --root <folder> [options]
  install   --portal-url <url> --credential-stdin [--max-sandboxes 3] [--max-agents-per-sandbox 2] [--max-unity 2]
            [--repo-url ${DEFAULT_REPO}] [--service <task or label>] [--no-firewall] [--no-cleanup] [--absolute-worktrees] [--unity-slots-dir <dir> (a test install)]
            [--owner <user> (Windows: run elevated, e.g. over ssh, and give what it makes to that user)]
            [--seed-from <a local clone of the game repo> (its origin branches seed the root's clone: no download, and no
             GitHub credential, which an ssh session does not have)]
            [--unity-editor-root <dir>] [--unity-path <exe>]
            [--no-ssh] [--ssh-host <name the portal reaches it by>] [--ssh-user <user>] (the portal's ssh, w568)
  update    [--max-sandboxes N] [--max-agents-per-sandbox N] [--max-unity N] (only to change them)
            [--ref portal|main|<commit> (the daemon code; default: the commit the portal runs)] [--source <checkout>]
            [--owner <user> (Windows, elevated: default the user the daemon's task runs as)] [--no-firewall] [--no-ssh]
            (this machine's own install, in place: every setting, the credential and the PATH carried; no game-repo
             fetch; restarts the daemon and checks the portal sees it; docs/worker-install.md, "Updating")
            [--voice-whisper <model>|off] (the GPU Whisper for the portal's mic, w615; default: as daemon.json has it)
            [--voice-whisper <model>|off] (Whisper on this machine's GPU for the portal's mic, w615; kept on a re-run)
  uninstall [--yes] [--force] [--keep-registration]
  check     [--service <task or label>] (lists what of the install exists on this computer)
  migrate   [--from <old daemon folder>] [--from-service <its task or label>] [--old-slots <dir>]
            [--nightly <dir;dir>] [--dry-run] | --rollback | --cleanup [--legacy]
            (today's layout into the root; the credential comes from the old daemon.json)
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
      repoUrl: opts['repo-url'] ?? DEFAULT_REPO,
      service: opts.service ?? (isWin ? win.TASK_NAME : LABEL),
      firewall: !flags.has('no-firewall'),
      noCleanup: flags.has('no-cleanup'),
      absoluteWorktrees: flags.has('absolute-worktrees'),
      unitySlotsDir: opts['unity-slots-dir'],
      owner: opts.owner,
      firewallSuffix: opts['firewall-suffix'],
      unityEditorRoot: opts['unity-editor-root'],
      unityPath: opts['unity-path'],
      ssh: !flags.has('no-ssh'),
      sshHost: opts['ssh-host'],
      sshUser: opts['ssh-user'],
      ...(opts['seed-from'] ? { seedFrom: opts['seed-from'] } : {}),
      ...(opts['voice-whisper'] !== undefined ? { voiceWhisper: opts['voice-whisper'] } : {}),
    });
  } else if (cmd === 'update') {
    if (!opts.root) throw new Error(USAGE);
    const opt = (k: string) => (opts[k] === undefined ? undefined : Number(opts[k]));
    await update(opts.root, {
      maxSandboxes: opt('max-sandboxes'),
      maxAgentsPerSandbox: opt('max-agents-per-sandbox'),
      maxUnity: opt('max-unity'),
      ...(opts.owner ? { owner: opts.owner } : {}),
      ...(opts.ref ? { ref: opts.ref } : {}),
      ...(opts.source ? { source: opts.source } : {}),
      ...(flags.has('no-firewall') ? { firewall: false } : {}),
      ...(flags.has('no-ssh') ? { ssh: false } : {}),
      ...(opts['voice-whisper'] !== undefined ? { voiceWhisper: opts['voice-whisper'] } : {}),
    });
  } else if (cmd === 'elevated') {
    // The install's one administrator step (elevatedSteps): run by an elevated copy of this script.
    if (!opts.steps || !opts.log) throw new Error(USAGE);
    process.exitCode = await runElevatedSteps(JSON.parse(fs.readFileSync(opts.steps, 'utf8')) as ElevatedStep[], opts.log);
  } else if (cmd === 'uninstall') {
    if (!opts.root) throw new Error(USAGE);
    await uninstall({ root: opts.root, yes: flags.has('yes'), force: flags.has('force'), keepRegistration: flags.has('keep-registration') });
  } else if (cmd === 'migrate') {
    if (!opts.root) throw new Error(USAGE);
    const mig = await import('./migrate.ts');
    if (flags.has('rollback')) await mig.rollback(opts.root);
    else if (flags.has('cleanup')) await mig.cleanup({ root: opts.root, legacy: flags.has('legacy') });
    else
      await mig.migrate({
        from: opts.from,
        fromService: opts['from-service'],
        oldSlots: opts['old-slots'],
        nightly: opts.nightly ? opts.nightly.split(';').filter(Boolean) : [],
        dryRun: flags.has('dry-run'),
        install: {
          root: opts.root,
          portalUrl: opts['portal-url']?.replace(/\/+$/, ''),
          maxSandboxes: num('max-sandboxes', 3),
          maxAgentsPerSandbox: num('max-agents-per-sandbox', 2),
          maxUnity: num('max-unity', 2),
              repoUrl: opts['repo-url'] ?? DEFAULT_REPO,
          service: opts.service ?? (isWin ? win.TASK_NAME : LABEL),
          firewall: !flags.has('no-firewall'),
          noCleanup: flags.has('no-cleanup'),
          absoluteWorktrees: flags.has('absolute-worktrees'),
          owner: opts.owner,
          firewallSuffix: opts['firewall-suffix'],
          unitySlotsDir: opts['unity-slots-dir'],
          ssh: !flags.has('no-ssh'),
          sshHost: opts['ssh-host'],
          sshUser: opts['ssh-user'],
        },
      });
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

// Real paths: a Mac's temp folder (/var -> /private/var), where the uninstall runs its copy, is a symlink.
if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(`ERROR: ${(e as Error).message}`);
    process.exitCode = 1;
  });
}
