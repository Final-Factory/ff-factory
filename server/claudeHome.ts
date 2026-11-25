// Claude Code's folder for a worker root's agents (w5305, part of w5297; lothsahn: "under no circumstances should workers
// write outside of ffw"). Before this every agent's transcripts, plugins and settings went to the person's ~/.claude (8.6 GB on
// m5): a main install left CLAUDE_CONFIG_DIR unset, and only `worker.ts install --instance` set it (daemon.json env).
//
// Now a worker root's daemon moves its agents to <root>/claude, in four parts that land together:
// 1. The daemon sets CLAUDE_CONFIG_DIR on its own environment at start (moveClaudeHome), so every reader that follows it (the
//    transcript scrubber, plugin paths, the evidence gate, the transcript meter) looks there. It remembers the folder it left
//    (FF_CLAUDE_LEGACY_DIR): the person's own ~/.claude, which it only reads from now on.
// 2. `worker.ts tools` (the rollout's tools publish after each verified deploy) installs the plugins into the new folder. Until
//    <root>/claude/plugins/installed_plugins.json lists ff-agents, each agent launch keeps the legacy folder (agentClaudeEnv), so
//    skills load either way.
// 3. A resumed conversation's transcript is copied across before its process starts (carryTranscript); cliTranscriptPath looks
//    in both folders.
// 4. settings.json is carried across once (carrySettings), without its credentials or its plugin lists; ~/.claude.json's Unity
//    MCP entry is read from both folders (claudeJsonFiles).
//
// What stays in the legacy folder, on purpose: the machine's own claude.ai login (macOS keeps it in the Keychain under a name
// that depends on CLAUDE_CONFIG_DIR, Windows and Linux in .credentials.json; it is never moved or copied), so the usage probe and
// an agent on the stored login run with CLAUDE_CONFIG_DIR unset (loginClaudeEnv); and registerAgents.sh's checkout marker and
// plugin set (`$HOME/.claude/final-factory-agents-*`), which registerAgents.sh writes and publish-skills reads at that fixed
// path. docs/worker-root.md "Claude Code's folder".
import fs from 'node:fs';
import path from 'node:path';

/** The folder the daemon moved its agents from (the person's ~/.claude); set only by moveClaudeHome. */
export const LEGACY_VAR = 'FF_CLAUDE_LEGACY_DIR';
/** The worker root's own Claude Code folder, <root>/claude; set only by moveClaudeHome. */
export const WORKER_VAR = 'FF_CLAUDE_WORKER_DIR';
/** daemon.json env `FF_CLAUDE_HOME: "legacy"` keeps a machine on ~/.claude (the off switch). */
export const SWITCH_VAR = 'FF_CLAUDE_HOME';

type Env = Record<string, string | undefined>;

/** <root>/claude. */
export const workerClaudeDir = (root: string) => path.join(root, 'claude');

/** Whether a worker root's agents move to <root>/claude: CLAUDE_CONFIG_DIR not set already (an instance's own) and no off switch. */
export function movesClaudeHome(env: Env): boolean {
  return !env.CLAUDE_CONFIG_DIR && env[SWITCH_VAR] !== 'legacy';
}

/**
 * The daemon's start (part 1), in place on `env` (its process.env): CLAUDE_CONFIG_DIR = <root>/claude, the folder made, the
 * legacy one remembered and its settings.json carried across. Returns what it did, for the log; undefined when it moved nothing.
 */
export function moveClaudeHome(env: Env, root: string, home: string, log: (line: string) => void = () => {}): string | undefined {
  if (!movesClaudeHome(env)) return undefined;
  const dir = workerClaudeDir(root);
  const legacy = path.join(home, '.claude');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    log(`Claude Code's folder: could not make ${dir} (${(e as Error).message}); agents stay on ${legacy}`);
    return undefined;
  }
  env[LEGACY_VAR] = legacy;
  env[WORKER_VAR] = dir;
  env.CLAUDE_CONFIG_DIR = dir;
  const carried = carrySettings(legacy, dir);
  return `Claude Code's folder: ${dir} (was ${legacy}; settings.json ${carried})${pluginsReady(dir) ? '' : '; its plugins are not installed yet, so agents start on the old folder until the tools publish installs them'}`;
}

/** Whether `dir`'s plugins/installed_plugins.json lists ff-agents with an install folder that exists. */
export function pluginsReady(dir: string | undefined, exists: (p: string) => boolean = fs.existsSync, read: (p: string) => string = (p) => fs.readFileSync(p, 'utf8')): boolean {
  if (!dir) return false;
  try {
    const json = JSON.parse(read(path.join(dir, 'plugins', 'installed_plugins.json'))) as { plugins?: Record<string, { installPath?: unknown }[]> };
    const list = json.plugins?.['ff-agents@final-factory-agents'];
    return Array.isArray(list) && list.some((e) => typeof e?.installPath === 'string' && exists(path.join(e.installPath, 'skills')));
  } catch {
    return false;
  }
}

/** `env` without CLAUDE_CONFIG_DIR: Claude Code's own default, ~/.claude, with the Keychain entry it always had. */
function legacyEnv<E extends Env>(env: E): E {
  const out = { ...env };
  delete out.CLAUDE_CONFIG_DIR;
  return out;
}

/** Whether the run carries its own Claude credential (a vault token); without one it runs on the machine's stored login. */
export const hasOwnCredential = (env: Env) => !!(env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);

/**
 * The folder one agent launch uses (part 2): the worker folder once its plugins are in, else the legacy one; the legacy one
 * also for a run on the stored login (its login is there). `env`: the environment the launch starts from; `runEnv`: what the
 * run adds on top (its vault token).
 */
export function agentClaudeEnv<E extends Env>(env: E, runEnv: Env = {}, ready: (dir: string | undefined) => boolean = pluginsReady): E {
  if (!env[LEGACY_VAR] || !env.CLAUDE_CONFIG_DIR || env.CLAUDE_CONFIG_DIR !== env[WORKER_VAR]) return env;
  return hasOwnCredential({ ...env, ...runEnv }) && ready(env.CLAUDE_CONFIG_DIR) ? env : legacyEnv(env);
}

/** The environment that reads the machine's own claude.ai login (the usage probe): the legacy folder, where the login is. */
export function loginClaudeEnv<E extends Env>(env: E): E {
  return env[LEGACY_VAR] && env.CLAUDE_CONFIG_DIR === env[WORKER_VAR] ? legacyEnv(env) : env;
}

/**
 * w5559 (lothsahn: "workers can't read BEAST's old Claude login folder"): what never reaches an agent's environment. The
 * legacy folder holds the machine's own claude.ai login (.credentials.json on Windows and Linux), and a worker runs on its
 * vault token, never on that login (server/secrets.ts machineRunEnv), so only the daemon and its readers keep the path.
 */
export const LOGIN_PATH_VARS = [LEGACY_VAR] as const;

/** `env` without a path to the machine's own Claude login (LOGIN_PATH_VARS), for an agent's process. */
export function withoutLoginPaths<E extends Env>(env: E): E {
  const out = { ...env };
  for (const k of LOGIN_PATH_VARS) delete out[k];
  return out;
}

/**
 * The files that hold a claude.ai login a worker could read (w5559): `.credentials.json` in the person's ~/.claude, in the
 * legacy folder the daemon left and in the environment's own Claude Code folder, whether or not it exists now (Claude Code
 * writes it at the next login or refresh). The read fences deny each (server/workerFence.ts, machine/writeLock.ts,
 * machine/lowIntegrity.ts); the folders themselves stay readable, since skills read other files there by fixed path
 * (`~/.claude/final-factory-agents-checkout`, `~/.claude/plugins/cache/...`). macOS keeps its login in the Keychain instead.
 */
export function claudeLoginFiles(env: Env, home: string): string[] {
  const dirs = [path.join(home, '.claude'), env[LEGACY_VAR], env.CLAUDE_CONFIG_DIR].filter((x): x is string => !!x);
  const files = dirs.map((d) => path.join(d, '.credentials.json'));
  return files.filter((f, i) => files.findIndex((x) => path.resolve(x) === path.resolve(f)) === i);
}

/** The folder whose plugins a reader on the daemon uses (FF_SKILLS, the evidence gate): the agents' one while the worker folder has none. */
export function pluginClaudeEnv<E extends Env>(env: E, ready: (dir: string | undefined) => boolean = pluginsReady): E {
  return env[LEGACY_VAR] && env.CLAUDE_CONFIG_DIR === env[WORKER_VAR] && !ready(env.CLAUDE_CONFIG_DIR) ? legacyEnv(env) : env;
}

/** Every Claude Code folder a transcript or config may be in, the environment's own first, no repeats. */
export function claudeDirs(env: Env, home: string): string[] {
  const own = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const all = [own, env[WORKER_VAR], env[LEGACY_VAR]].filter((x): x is string => !!x);
  return all.filter((d, i) => all.findIndex((x) => path.resolve(x) === path.resolve(d)) === i);
}

/**
 * The ~/.claude.json files to read the machine's Unity MCP entry from: the environment's own Claude Code config first
 * (`$CLAUDE_CONFIG_DIR/.claude.json`), then the person's ~/.claude.json, where MCP for Unity registers it.
 */
export function claudeJsonFiles(env: Env, home: string): string[] {
  const all = [env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : undefined, path.join(home, '.claude.json')].filter((x): x is string => !!x);
  return [...new Set(all)];
}

/** settings.json keys never carried: credentials and their helpers, and the plugin lists the tools publish writes itself. */
const NOT_CARRIED = new Set(['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper', 'enabledPlugins', 'extraKnownMarketplaces']);
/** An `env` entry of settings.json that is, or may be, a credential: never carried. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE/i;
/** The marker that the legacy settings.json was carried (once: a person's later edit in either folder is theirs). */
export const CARRIED_MARKER = '.ff-settings-carried';

/**
 * Part 4: the legacy settings.json's keys the worker folder's settings.json lacks, once, without NOT_CARRIED keys or
 * credential-looking env entries. Never prints a value. Returns a word for the log.
 */
export function carrySettings(legacy: string, dir: string): string {
  const marker = path.join(dir, CARRIED_MARKER);
  if (fs.existsSync(marker)) return 'carried before';
  const from = path.join(legacy, 'settings.json');
  const to = path.join(dir, 'settings.json');
  let src: Record<string, unknown>;
  try {
    src = JSON.parse(fs.readFileSync(from, 'utf8').replace(/^﻿/, '')) as Record<string, unknown>;
  } catch {
    // none, or not JSON: nothing to carry; the marker still goes, so a later one of the person's is not taken
    try {
      fs.writeFileSync(marker, `${new Date().toISOString()} no legacy settings.json\n`);
    } catch {
      // read-only: tried again next start
    }
    return fs.existsSync(from) ? 'not carried (not JSON)' : 'none to carry';
  }
  let dst: Record<string, unknown> = {};
  try {
    dst = JSON.parse(fs.readFileSync(to, 'utf8').replace(/^﻿/, '')) as Record<string, unknown>;
  } catch {
    // none yet
  }
  const keys: string[] = [];
  for (const [k, v] of Object.entries(src)) {
    if (NOT_CARRIED.has(k) || k in dst) continue;
    if (k === 'env' && v && typeof v === 'object') {
      const env = Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([n]) => !SECRET_NAME.test(n)));
      if (Object.keys(env).length) dst.env = env;
      else continue;
    } else dst[k] = v;
    keys.push(k);
  }
  try {
    if (keys.length) fs.writeFileSync(to, JSON.stringify(dst, null, 2) + '\n');
    fs.writeFileSync(marker, `${new Date().toISOString()} carried from ${from}: ${keys.join(', ') || 'nothing new'}\n`);
  } catch (e) {
    return `not carried (${(e as Error).message})`;
  }
  return keys.length ? `carried (${keys.join(', ')})` : 'had nothing new';
}

/** Claude Code's project folder name for a working directory. */
export const projectSlug = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

/**
 * Part 3: before a conversation resumes in `env`'s folder, copy its transcript (<id>.jsonl and its <id>/ folder: subagents,
 * tool results) from another folder it is in. Copies, never moves: the legacy folder keeps its copy for an older daemon.
 * Returns where it came from, or undefined when nothing was copied (already there, nowhere else, or no move configured).
 */
export function carryTranscript(cwd: string, sessionId: string, env: Env, home: string): string | undefined {
  if (!env[LEGACY_VAR] || !/^[A-Za-z0-9_-]{8,80}$/.test(sessionId)) return undefined;
  const dirs = claudeDirs(env, home);
  const own = path.join(dirs[0], 'projects');
  const slug = projectSlug(cwd);
  if (findTranscript(own, slug, sessionId)) return undefined;
  for (const d of dirs.slice(1)) {
    const projects = path.join(d, 'projects');
    const src = findTranscript(projects, slug, sessionId);
    if (src) {
      const f = path.basename(path.dirname(src));
      const dest = path.join(own, f);
      fs.mkdirSync(dest, { recursive: true });
      const side = path.join(projects, f, sessionId);
      if (fs.existsSync(side)) fs.cpSync(side, path.join(dest, sessionId), { recursive: true, force: false, errorOnExist: false });
      // the transcript last, through a temporary name: a half copy is never what the CLI resumes
      const tmp = path.join(dest, `.${sessionId}.jsonl.carry`);
      fs.copyFileSync(src, tmp);
      fs.renameSync(tmp, path.join(dest, `${sessionId}.jsonl`));
      return src;
    }
  }
  return undefined;
}

/** <projects>/<folder>/<id>.jsonl: the working directory's folder first, then any (a long path's hashed name, a moved sandbox). */
export function findTranscript(projects: string, slug: string, sessionId: string): string | undefined {
  const direct = path.join(projects, slug, `${sessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  try {
    for (const d of fs.readdirSync(projects)) {
      const p = path.join(projects, d, `${sessionId}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
  } catch {
    // no projects folder
  }
  return undefined;
}

/** The legacy folder's projects, when the daemon moved its agents (the transcript scrubber looks there too). */
export const legacyProjectsDirs = (env: Env): string[] => (env[LEGACY_VAR] && env.CLAUDE_CONFIG_DIR === env[WORKER_VAR] ? [path.join(env[LEGACY_VAR]!, 'projects')].filter((d) => fs.existsSync(d)) : []);
