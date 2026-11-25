// The Evidence gate before a merge (w3088). The game repo's CLAUDE.md: "A PR that changes simulation or what a player sees
// carries an `## Evidence` section, checked with that skill's `pr_evidence.py` before it merges." w3080's #3180 merged on
// green CI with its section still failing: the worker ran `pr_evidence.py --pr 3180` with no --repo, which printed only a
// usage error (exit 2), and `ff-pr merge` in the same command merged. So both merge paths that act without a person,
// `ff-pr merge` (machine/prFlow.ts) and the merge-on-green pilot (server/blockerWatch.ts ghMerge, w2045), run
// `pr_evidence.py --repo <repo> --pr <n>` first (for the game repo and ffu, EVIDENCE_GATED) and refuse on anything but exit 0: a FAIL, a usage error, a gh failure, or
// no python or no script to run. The script decides which pull requests it covers: one with no game code or assets
// changed prints "PASS: no game code or assets changed" and exits 0, so docs, tools and tests still merge.
import { mediumPluginClaudeEnv } from '../server/claudeHome.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitSpawnSync } from '../server/safeGit.ts';

type PlatformPath = typeof path.posix;

/**
 * The repositories whose pull requests the gate checks (lower case). ffu since w3098: pr_evidence.py holds an ffu PR that
 * touches art/ or the code that draws the image (ffu-bake, ffu-render, a .wgsl; w2895, w3097) to its 'Reference capture:'
 * and 'Art language:' lines, and passes any other ffu PR ("no game code or assets changed", exit 0).
 */
export const EVIDENCE_GATED = new Set(['final-factory/finalfactory', 'final-factory/ffu']);

export const evidenceGated = (repo: string) => EVIDENCE_GATED.has(repo.toLowerCase());

/** The python the script runs under: FF_PYTHON, else python on Windows and python3 elsewhere (machine/benchQueue.ts). */
export const evidencePython = (env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform) =>
  env.FF_PYTHON || (platform === 'win32' ? 'python' : 'python3');

const SCRIPT = ['skills', 'evidence-gate', 'pr_evidence.py'];

function pluginVersion(plugin: string, read: (p: string) => string, P: PlatformPath): number[] {
  try {
    const v = String((JSON.parse(read(P.join(plugin, '.claude-plugin', 'plugin.json'))) as { version?: unknown }).version ?? '');
    return v.split(/[.+-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : 0));
  } catch {
    return [];
  }
}

function newer(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

export interface FindDeps {
  env: NodeJS.ProcessEnv;
  home: string;
  /** The worker install folder, for FF Factory's own checkout of the plugin repo (server/agentTools.ts toolsCheckout). */
  root?: string;
  exists?: (p: string) => boolean;
  list?: (dir: string) => string[];
  read?: (p: string) => string;
  /** The path rules of the machine it runs on (tests: path.win32 for BEAST, path.posix for a Mac). Default: this one's. */
  pathApi?: PlatformPath;
}

/**
 * The newest pr_evidence.py on this machine, by its plugin.json version: the plugin cache's versions, FF_SKILLS's, and the
 * tools checkout's. The newest, because a copy older than the released ff-agents FAILs every pull request ("this
 * pr_evidence.py is ff-agents X, but Y is released", w733), and checklists/merge.md picks it the same way (sort -V).
 * FF_PR_EVIDENCE names one outright. Undefined when there is none: the gate then refuses.
 */
export function findPrEvidence(d: FindDeps): string | undefined {
  const exists = d.exists ?? ((p: string) => fs.existsSync(p));
  const list = d.list ?? ((dir: string) => { try { return fs.readdirSync(dir); } catch { return []; } });
  const read = d.read ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const P = d.pathApi ?? path;
  if (d.env.FF_PR_EVIDENCE) return exists(d.env.FF_PR_EVIDENCE) ? d.env.FF_PR_EVIDENCE : undefined;
  // w5305: the folder whose plugins the agents load (the legacy ~/.claude until the worker root's folder has them). w5543: the
  // daemon runs this script at Medium, so the Medium agents' folder, never the one workers can write.
  const cfgDir = mediumPluginClaudeEnv(d.env).CLAUDE_CONFIG_DIR;
  const cache = P.join(cfgDir || P.join(d.home, '.claude'), 'plugins', 'cache', 'final-factory-agents', 'ff-agents');
  const plugins = list(cache).map((v) => P.join(cache, v));
  if (d.env.FF_SKILLS) plugins.push(P.dirname(d.env.FF_SKILLS));
  const root = d.root ?? d.env.FF_WORKER_ROOT;
  if (root) plugins.push(P.join(root, 'tools', 'final-factory-agents', 'plugins', 'ff-agents'));
  let best: { script: string; v: number[] } | undefined;
  for (const p of plugins) {
    const script = P.join(p, ...SCRIPT);
    if (!exists(script)) continue;
    const v = pluginVersion(p, read, P);
    if (!best || newer(v, best.v)) best = { script, v };
  }
  return best?.script;
}

/** pr_evidence.py's refusal of itself (its stale_problem): this copy is older than the released ff-agents. */
export const STALE_EVIDENCE = /this pr_evidence\.py is ff-agents (\S+), but (\S+) is released/;

/**
 * w4926: brings this machine's ff-agents plugin up to the released version, the update pr_evidence.py's stale refusal names
 * (`claude plugin marketplace update final-factory-agents`, then `claude plugin update ff-agents@final-factory-agents`).
 * Plugins otherwise move only when a portal deploy runs registerAgents.sh, so a release made between two deploys refused
 * every gated merge on a machine (w4873, 1.34.382 against 1.34.383). Answers what went wrong, or undefined when it worked.
 * 2.9 to 3.3 s on LothDesktop (measured, 2026-11-20).
 */
export function updateLocalPlugin(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const opts = { encoding: 'utf8', windowsHide: true, timeout: 5 * 60_000, env } as const;
  for (const args of [['plugin', 'marketplace', 'update', 'final-factory-agents'], ['plugin', 'update', 'ff-agents@final-factory-agents']]) {
    // claude is an npm shim (claude.cmd) on Windows, which spawnSync runs only through a shell; the words are fixed.
    const r = platform === 'win32' ? spawnSync(`claude ${args.join(' ')}`, { ...opts, shell: true }) : spawnSync('claude', args, opts);
    if (r.status !== 0) return `claude ${args.join(' ')}: ${(r.stderr || r.stdout || r.error?.message || `exit ${r.status}`).replace(/\s+/g, ' ').trim().slice(0, 300)}`;
  }
  return undefined;
}

export const findLocalPrEvidence = (env: NodeJS.ProcessEnv = process.env) => findPrEvidence({ env, home: os.homedir() });

/** final-factory-agents, public: cloned with no credential helper and no prompt (server/agentTools.ts publishAgentTools). */
export const AGENTS_REPO = 'https://github.com/Final-Factory/final-factory-agents.git';
const AGENTS_BRANCH = 'master';
const ANON_GIT = ['-c', 'credential.helper=', '-c', 'credential.interactive=never'];

/** pr_evidence.py in a checkout of final-factory-agents: one path, never a pick among versions (w5542). */
export const checkoutScript = (co: string, P: PlatformPath = path) => P.join(co, 'plugins', 'ff-agents', ...SCRIPT);

/**
 * w5542: the daemon's folder (daemon.ts appDirOfConfig: daemon.json's appDir, else `<root>/daemon`, else ~/.ff-factory),
 * read from the host's own environment, which a worker cannot change. Workers cannot write it on any OS: Windows keeps it
 * Medium against the Low workers, the Mac fence and Linux's ff-landlock.py take it out of the root (docs/worker-fence.md).
 */
export function trustedAppDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir(), P: PlatformPath = path): string {
  if (env.FF_APP_DIR) return env.FF_APP_DIR;
  return env.FF_WORKER_ROOT ? P.join(env.FF_WORKER_ROOT, 'daemon') : P.join(home, '.ff-factory');
}

/** The guard's own checkout of final-factory-agents, in the daemon's folder (w5542). */
export const trustedAgentsCheckout = (appDir: string, P: PlatformPath = path) => P.join(appDir, 'trusted', 'final-factory-agents');

/** How old the trusted checkout may be before the guard fetches it again before a check (a stale copy FAILs, w733). */
export const TRUSTED_MAX_AGE_MS = 10 * 60_000;
const REFRESHED = 'ff-refreshed';

export interface TrustedRefreshDeps {
  /** git, run synchronously: the guard answers a tool call synchronously (server/guard.ts). */
  git?: (args: string[]) => { code: number; stderr: string };
  now?: () => number;
  /** The host's environment for git: never the worker's PATH or git settings. */
  env?: NodeJS.ProcessEnv;
}

/**
 * w5542: brings the guard's trusted checkout of final-factory-agents' master up to date from GitHub, as the portal's own
 * (portalPrEvidence), when it is missing, older than maxAgeMs, or `force` (the copy said a newer one is released). A first
 * clone goes to a folder of its own and is renamed into place, so two agent hosts never see half a clone. Answers what
 * failed, or undefined; a failed fetch leaves the copy it had.
 */
export function refreshTrustedCheckout(co: string, d: TrustedRefreshDeps = {}, opts: { maxAgeMs?: number; force?: boolean } = {}): string | undefined {
  const now = d.now ?? Date.now;
  const env: NodeJS.ProcessEnv = { ...(d.env ?? process.env), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  const git = d.git ?? ((args: string[]) => {
    const r = gitSpawnSync([...ANON_GIT, ...args], { encoding: 'utf8', timeout: 2 * 60_000, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: r.status ?? 1, stderr: String(r.stderr || r.error?.message || '') };
  });
  const said = (r: { code: number; stderr: string }) => r.stderr.replace(/\s+/g, ' ').trim().slice(0, 200) || `exit ${r.code}`;
  const marker = path.join(co, '.git', REFRESHED);
  try {
    if (!fs.existsSync(path.join(co, '.git'))) {
      fs.mkdirSync(path.dirname(co), { recursive: true });
      const tmp = `${co}.clone-${process.pid}-${now()}`;
      const r = git(['clone', '--quiet', '--depth', '1', '--branch', AGENTS_BRANCH, AGENTS_REPO, tmp]);
      if (r.code !== 0) {
        fs.rmSync(tmp, { recursive: true, force: true });
        return `git clone ${AGENTS_REPO}: ${said(r)}`;
      }
      fs.writeFileSync(path.join(tmp, '.git', REFRESHED), '');
      try {
        if (fs.existsSync(co)) fs.rmSync(co, { recursive: true, force: true });
        fs.renameSync(tmp, co);
      } catch {
        // Another host's clone got there first: use its.
        fs.rmSync(tmp, { recursive: true, force: true });
      }
      return undefined;
    }
    let age = Infinity;
    try { age = now() - fs.statSync(marker).mtimeMs; } catch { /* never refreshed */ }
    if (!opts.force && age < (opts.maxAgeMs ?? TRUSTED_MAX_AGE_MS)) return undefined;
    const f = git(['-C', co, 'fetch', '--quiet', '--depth', '1', 'origin', AGENTS_BRANCH]);
    if (f.code !== 0) return `git fetch in ${co}: ${said(f)}`;
    const r = git(['-C', co, 'reset', '--quiet', '--hard', 'FETCH_HEAD']);
    if (r.code !== 0) return `git reset in ${co}: ${said(r)}`;
    fs.writeFileSync(marker, '');
    return undefined;
  } catch (e) {
    return `the trusted checkout ${co}: ${(e as Error).message}`;
  }
}

/** Whether `p` is `dir` or inside it, by the path rules of the machine (Windows: no case). */
function within(p: string, dir: string, P: PlatformPath): boolean {
  const fold = (s: string) => (P === path.win32 ? s.toLowerCase() : s);
  const rel = P.relative(fold(P.resolve(dir)), fold(P.resolve(p)));
  return rel === '' || (!!rel && !rel.startsWith('..') && !P.isAbsolute(rel));
}

/**
 * w5542: a PATH with no folder a worker can write: every entry inside the worker root is dropped except the daemon's
 * folder (`<root>/unity-slots/bin` comes first in a worker's PATH and is writable, so a planted `python3` or `gh` there
 * would run at the host's level), and so is every relative or empty entry (the working directory).
 */
export function trustedPathValue(value: string | undefined, root: string | undefined, appDir: string, P: PlatformPath = path): string {
  const delim = P === path.win32 ? ';' : ':';
  return (value ?? '').split(delim).filter((e) => e && P.isAbsolute(e) && (!root || !within(e, root, P) || within(e, appDir, P))).join(delim);
}

/**
 * The program a bare name runs from a trusted PATH, as an absolute path (w5542). On Windows libuv looks in the working
 * directory before PATH (src/win/process.c search_path), and the guard's working directory is the worker's sandbox, so
 * the gate never spawns a bare name there. Undefined when there is none.
 */
export function resolveTrusted(name: string, pathValue: string, P: PlatformPath = path, exists: (p: string) => boolean = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }, pathext = '.COM;.EXE;.BAT;.CMD'): string | undefined {
  if (P.isAbsolute(name)) return exists(name) ? name : undefined;
  const win = P === path.win32;
  const exts = win && !/\.\w+$/.test(name) ? pathext.split(';').filter(Boolean) : [''];
  for (const dir of pathValue.split(win ? ';' : ':').filter(Boolean)) {
    for (const ext of exts) {
      const p = P.join(dir, name + ext.toLowerCase());
      if (exists(p)) return p;
    }
  }
  return undefined;
}

/**
 * w5542/w5572: a python and an environment for a script the host runs at its own level: no PYTHON* setting but UTF8 and
 * IOENCODING (a PYTHONPATH or pycache prefix could name a worker's folder), a PATH with no worker-writable folder, and the
 * python resolved on it to an absolute path (FF_PYTHON refused inside the worker root). Run it with `-s`.
 */
export function trustedPython(o: {
  workerEnv: NodeJS.ProcessEnv; host?: NodeJS.ProcessEnv; root: string | undefined; appDir: string;
  platform?: NodeJS.Platform; P?: PlatformPath; exists?: (p: string) => boolean;
}): { python: string; env: NodeJS.ProcessEnv } | { error: string } {
  const platform = o.platform ?? process.platform;
  const P = o.P ?? (platform === 'win32' ? path.win32 : path.posix);
  const host = o.host ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(o.workerEnv)) if (!/^PYTHON/i.test(k) || /^PYTHON(UTF8|IOENCODING)$/i.test(k)) env[k] = v;
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = trustedPathValue(env[pathKey] ?? host.PATH, o.root, o.appDir, P);
  const want = evidencePython(host, platform);
  if (P.isAbsolute(want) && o.root && within(want, o.root, P) && !within(want, o.appDir, P)) return { error: `FF_PYTHON ${want} is in a folder workers can write` };
  const python = resolveTrusted(want, env[pathKey]!, P, o.exists, env.PATHEXT ?? host.PATHEXT);
  if (!python) return { error: `no ${want} on a trusted PATH` };
  return { python, env };
}

export interface TrustedEvidence {
  /** The python, as an absolute path outside the worker-writable folders. */
  python: string;
  /** The arguments: `-s` (no user site, where APPDATA or ~/.local could hold a planted .pth), then evidenceArgs. */
  args: string[];
  env: NodeJS.ProcessEnv;
  /** The trusted checkout, as the working directory: never the sandbox (Windows looks for `gh` in it first). */
  cwd: string;
}

/**
 * w5542: how the guard runs pr_evidence.py at the host's level: the script from the trusted checkout only, the python and
 * PATH with no worker-writable folder, no PYTHON* settings (a PYTHONPATH or pycache prefix could name one), and the game
 * checkout's HUD pins named by FF_HUD_DATA (the script reads them from its working directory otherwise). Either the run or
 * why it cannot be run.
 */
export function trustedEvidenceRun(o: {
  script: string; repo: string; pr: string | number; workerEnv: NodeJS.ProcessEnv; hostEnv?: NodeJS.ProcessEnv;
  appDir: string; sandboxDir?: string; platform?: NodeJS.Platform; P?: PlatformPath; exists?: (p: string) => boolean;
}): TrustedEvidence | { error: string } {
  const platform = o.platform ?? process.platform;
  const P = o.P ?? (platform === 'win32' ? path.win32 : path.posix);
  const host = o.hostEnv ?? process.env;
  const t = trustedPython({ ...o, platform, P, host, root: o.workerEnv.FF_WORKER_ROOT || host.FF_WORKER_ROOT });
  if ('error' in t) return t;
  const { python, env } = t;
  if (!env.FF_HUD_DATA && o.sandboxDir) {
    const has = o.exists ?? ((p: string) => fs.existsSync(p));
    for (let d = P.resolve(o.sandboxDir); ; d = P.dirname(d)) {
      const hud = P.join(d, ...HUD_DATA_DIR.split('/'));
      if (has(P.join(hud, 'hud-pins.json'))) { env.FF_HUD_DATA = hud; break; }
      if (P.dirname(d) === d) break;
    }
  }
  return { python, args: ['-s', ...evidenceArgs(o.script, o.repo, o.pr)], env, cwd: P.dirname(o.script) };
}

export type GitRun = (cmd: string, args: string[], opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface PortalEvidenceDeps {
  /** The portal's data folder: its checkout is `<dataDir>/tools/final-factory-agents`, where findPrEvidence's `root` looks. */
  dataDir: string;
  run: GitRun;
  env?: NodeJS.ProcessEnv;
  home?: string;
  exists?: (p: string) => boolean;
  list?: (dir: string) => string[];
  read?: (p: string) => string;
}

let refreshing: Promise<void> | undefined;

/**
 * w3110: the merge-on-green pilot runs in the portal's own process (server/blockerWatch.ts ghMerge, on the portal VM), not
 * on the worker's machine, and the portal has no plugin cache, no FF_SKILLS and no worker root: every gated merge after
 * w3088 was refused with "no pr_evidence.py found" (FinalFactory #3186, #3187, ffu #237, 2026-11-04), whichever machine
 * the worker was on. So the portal keeps its own shallow checkout of final-factory-agents' master, brought up to date
 * before each check (pr_evidence.py fails every PR from a copy older than the released one, w733), and runs that
 * checkout's script only (w5542: never the newest of several copies). A clone or fetch that fails leaves the copy it had;
 * with none, undefined, and the merge is refused.
 */
export async function portalPrEvidence(d: PortalEvidenceDeps): Promise<string | undefined> {
  const co = path.join(d.dataDir, 'tools', 'final-factory-agents');
  const exists = d.exists ?? ((p: string) => fs.existsSync(p));
  const env: NodeJS.ProcessEnv = { ...(d.env ?? process.env), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  const anon = ['-c', 'credential.helper=', '-c', 'credential.interactive=never'];
  const git = (args: string[]) => d.run('git', [...anon, ...args], { env, timeoutMs: 2 * 60_000 });
  // One refresh at a time: two merges at once would race for the checkout's lock.
  refreshing ??= (async () => {
    try {
      if (!exists(path.join(co, '.git'))) {
        if (exists(co)) return;
        fs.mkdirSync(path.dirname(co), { recursive: true });
        await git(['clone', '--quiet', '--depth', '1', '--branch', AGENTS_BRANCH, AGENTS_REPO, co]);
      } else if ((await git(['-C', co, 'fetch', '--quiet', '--depth', '1', 'origin', AGENTS_BRANCH])).code === 0) {
        await git(['-C', co, 'reset', '--quiet', '--hard', 'FETCH_HEAD']);
      }
    } catch {
      // The copy it had, if any.
    }
  })().finally(() => { refreshing = undefined; });
  await refreshing;
  // w5542: its own checkout's script, never the newest of several copies.
  const script = checkoutScript(co);
  return exists(script) ? script : undefined;
}

/** The command the gate runs: the script, the repository and the pull request, always all three. */
export const evidenceArgs = (script: string, repo: string, pr: number | string) => [script, '--repo', repo, '--pr', String(pr)];

export interface EvidenceVerdict {
  ok: boolean;
  /** What it said: the verdict's first line on a pass; on a refusal, the failing lines (or the last lines it printed). */
  lines: string[];
}

/**
 * The verdict of one run: exit 0 passes, anything else refuses. A FAIL names its reasons as `- ` lines after the
 * `evidence-gate: FAIL` line (notes, `- note:`, are left out); a usage error or a gh failure prints no such lines, so its
 * last lines are named instead.
 */
export function evidenceVerdict(code: number, out: string, err: string): EvidenceVerdict {
  const all = `${out}\n${err}`.split(/\r?\n/).map((l) => l.trimEnd());
  if (code === 0) return { ok: true, lines: [all.find((l) => l.trim()) ?? 'PASS'] };
  const fails = all.filter((l) => /^- /.test(l) && !/^- note:/.test(l));
  return { ok: false, lines: fails.length ? fails : all.filter((l) => l.trim()).slice(-4) };
}

/** One refusal, for a person or a worker to act on: the command, how it ended, and each failing line. */
export function evidenceRefusal(repo: string, pr: number | string, code: number, v: EvidenceVerdict): string {
  const how = code === 127 ? 'could not run' : code === 2 ? 'usage error, exit 2' : `exit ${code}`;
  return `the Evidence check refused it (pr_evidence.py --repo ${repo} --pr ${pr}, ${how}):\n${v.lines.map((l) => `  ${l}`).join('\n')}`;
}

/** The refusal when there is no pr_evidence.py to run. */
export const noScriptRefusal = (repo: string, pr: number | string) =>
  `the Evidence check could not run for ${repo}#${pr}: no pr_evidence.py found (the ff-agents plugin cache, FF_SKILLS or the tools checkout); merge it by hand only after pr_evidence.py --repo ${repo} --pr ${pr} passes`;

/** The game repository, whose pr_evidence.py checks read its HUD pins (lower case). */
const HUD_REPO = 'final-factory/finalfactory';
/** Where the game repo keeps them (w2998: ui_layout.py's HUD_DATA_DIR), and the files pr_evidence.py's unity-ui import reads. */
export const HUD_DATA_DIR = 'scripts/nightly/ui_layout';
const HUD_FILES = ['hud-pins.json', 'hud-clusters.json'] as const;

export type HudData = { dir: string } | { error: string } | undefined;

/**
 * w3190: pr_evidence.py reads hud-pins.json from a game checkout (unity-ui's ui_layout.hud_data: $FF_HUD_DATA, $FF_GAME_REPO,
 * else the working directory's), and the merge-on-green pilot runs it on the portal, in no game checkout: #3229 (w3156) was
 * refused with "hud-pins.json (or the clusters file) lives in the game repo at scripts/nightly/ui_layout/ (w2998)". So before
 * the check of a game repo pull request the files are read from GitHub at the pull request's base branch, as it is now (no
 * clone to go stale), into a fresh folder named to the script as FF_HUD_DATA. The base, not the head: a pin changes only
 * when the person asks, through a harness PR (hud-pins.json's own "about"), so a PR cannot loosen the pins it is checked
 * against. Undefined for another repository; an error, naming what gh said, when the pins cannot be read.
 */
export async function fetchHudData(repo: string, pr: number | string, run: GitRun, opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}, tmp: string = os.tmpdir()): Promise<HudData> {
  if (repo.toLowerCase() !== HUD_REPO) return undefined;
  const said = (r: { code: number; stdout: string; stderr: string }) => (r.stderr || r.stdout || `exit ${r.code}`).replace(/\s+/g, ' ').trim().slice(0, 200);
  const p = await run('gh', ['pr', 'view', String(pr), '-R', repo, '--json', 'baseRefName'], opts);
  let base = '';
  try { base = p.code === 0 ? String((JSON.parse(p.stdout) as { baseRefName?: unknown }).baseRefName ?? '') : ''; } catch { /* below */ }
  if (!base) return { error: `its base branch cannot be read: ${said(p)}` };
  const dir = fs.mkdtempSync(path.join(tmp, 'fff-hud-data-'));
  for (const f of HUD_FILES) {
    const r = await run('gh', ['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${repo}/contents/${HUD_DATA_DIR}/${f}?ref=${encodeURIComponent(base)}`], opts);
    if (r.code !== 0 || !r.stdout.trim()) {
      // Only the pins are needed (pr_evidence.py pins()); a missing clusters file leaves the script to say so if it reads it.
      if (f === 'hud-pins.json') return { error: `${HUD_DATA_DIR}/${f} cannot be read from ${repo} at ${base}: ${said(r)}` };
      continue;
    }
    fs.writeFileSync(path.join(dir, f), r.stdout);
  }
  return { dir };
}

/** w5542: gh on the agent host's PATH with every folder workers can write left out (<root>/unity-slots/bin comes first there). */
export function trustedGh(root: string | undefined = process.env.FF_WORKER_ROOT, appDir: string = trustedAppDir()): string {
  return resolveTrusted('gh', trustedPathValue(process.env.PATH ?? process.env.Path, root, appDir)) ?? 'gh';
}

/** w5542: git the same way, for the guard's reads of a worker's repository. */
export function trustedGit(): string {
  return resolveTrusted('git', trustedPathValue(process.env.PATH ?? process.env.Path, process.env.FF_WORKER_ROOT, trustedAppDir())) ?? 'git';
}

/** w5542: git options for reading a repository a worker can write: none of its config may run a program at the host's level. */
// `remote -v` and `log` run no hooks, no pager (stdout is a pipe) and no external diff (--no-ext-diff); a repo's fsmonitor and a
// signature check (gpg.program) are the programs left, both off here.
export const TRUSTED_GIT = ['-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false'];
