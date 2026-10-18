import fs from 'node:fs';
import path from 'node:path';

/**
 * The agent tools publish (w1476; lothsahn, 2026-10-18: "Please create a new work item that deploying the latest tools is
 * part of every deploy operation"). The ff-agents, ff-speckit and ff-discord plugins Claude Code loads on a worker machine
 * come from final-factory-agents (docs/vault.md 13.2); before this, nothing in FF Factory ran its `registerAgents.sh`, so a
 * plugin release (ff-agents 1.29.20, w1469) reached no machine until someone ran it there by hand.
 *
 * `worker.ts tools` runs this on the machine (the installer's `-Tools` / `--tools` form), and the machine rollout runs that
 * on every worker-root machine after a verified portal deploy (server/machineRollout.ts, docs/ops-worker.md "After a verified
 * deploy"). What it does:
 *
 * - Reads the versions Claude Code has installed (`<CLAUDE_CONFIG_DIR or ~/.claude>/plugins/installed_plugins.json`).
 * - Brings FF Factory's OWN checkout, `<root>/tools/final-factory-agents`, to origin/master (a clone the first time, then a
 *   fast-forward only). A person's checkout (BEAST's `~/final-factory-agents`, docs/worker-root.md) is never touched: the
 *   plugins Claude Code loads come from its managed marketplace clone, which `registerAgents.sh` refreshes from GitHub, so
 *   the script only has to run from an up-to-date copy. Its own checkout dirty, on another branch or diverged: nothing is
 *   overwritten, the run stops and says why.
 * - Runs `sh registerAgents.sh --claude` from it: the marketplace refreshed, every plugin the machine remembers updated (a
 *   bare run keeps the machine's set: ff-agents and ff-speckit everywhere, ff-discord where a person asked for it).
 * - Puts back publish-skills' checkout marker (`~/.claude/final-factory-agents-checkout`, which `registerAgents.sh` points at
 *   the checkout it ran from), so a person's skill edits keep going to their own checkout.
 * - Reads the versions again and compares them with the checkout's marketplace.json: every installed plugin on master's
 *   version, or it fails.
 *
 * Running agents keep the plugin version they started with (the old cached copy stays on disk); new sessions load the new one.
 */

export const AGENTS_REPO_URL = 'https://github.com/Final-Factory/final-factory-agents.git';
export const MARKETPLACE = 'final-factory-agents';
export const AGENT_PLUGINS = ['ff-agents', 'ff-speckit', 'ff-discord'] as const;
/** What registerAgents.sh installs on every machine (its DEFAULT_PLUGINS); ff-discord only where a person asked for it. */
export const DEFAULT_AGENT_PLUGINS: readonly string[] = ['ff-agents', 'ff-speckit'];
export const BRANCH = 'master';
/** The registerAgents.sh run: a marketplace clone and three plugin installs on a slow link. */
export const REGISTER_TIMEOUT_MS = 10 * 60_000;

export type Versions = Record<string, string | undefined>;

/** The lines `worker.ts tools` prints and the machine rollout reads back. */
export const LINE = { before: 'Agent tools before:', after: 'Agent tools after:', latest: 'Agent tools latest:' } as const;

/** FF Factory's own checkout of final-factory-agents in a worker root. */
export const toolsCheckout = (root: string) => path.join(root, 'tools', MARKETPLACE);

const NOT_INSTALLED = 'not installed';

/** installed_plugins.json (version 2: `{plugins: {"<name>@<marketplace>": [{scope, version, ...}]}}`): the user-scope version of each of ours. */
export function installedVersions(json: unknown): Versions {
  const plugins = (json as { plugins?: Record<string, unknown> } | undefined)?.plugins;
  const out: Versions = {};
  for (const p of AGENT_PLUGINS) {
    const list = Array.isArray(plugins?.[`${p}@${MARKETPLACE}`]) ? (plugins![`${p}@${MARKETPLACE}`] as { scope?: string; version?: unknown }[]) : [];
    const e = list.find((x) => x?.scope === 'user') ?? list[0];
    out[p] = typeof e?.version === 'string' ? e.version : undefined;
  }
  return out;
}

/** .claude-plugin/marketplace.json: the version master publishes for each of ours. */
export function marketplaceVersions(json: unknown): Versions {
  const list = (json as { plugins?: { name?: string; version?: unknown }[] } | undefined)?.plugins;
  const out: Versions = {};
  for (const p of AGENT_PLUGINS) {
    const e = Array.isArray(list) ? list.find((x) => x?.name === p) : undefined;
    out[p] = typeof e?.version === 'string' ? e.version : undefined;
  }
  return out;
}

/** "ff-agents 1.29.20, ff-speckit 1.0.2, ff-discord not installed". */
export const formatVersions = (v: Versions) => AGENT_PLUGINS.map((p) => `${p} ${v[p] ?? NOT_INSTALLED}`).join(', ');

/** The reverse of formatVersions, from a line that holds one (the rollout reads the machine's output with it). */
export function parseVersions(s: string): Versions {
  const out: Versions = {};
  for (const p of AGENT_PLUGINS) {
    const m = new RegExp(`(?:^|[\\s:,])${p} (${NOT_INSTALLED}|[\\w.+-]+)`).exec(s);
    if (m) out[p] = m[1] === NOT_INSTALLED ? undefined : m[1];
  }
  return out;
}

/** The plugins not on master's version after a run: an installed one on another version, or a default one missing. */
export function staleAfter(after: Versions, latest: Versions): string[] {
  return AGENT_PLUGINS.filter((p) => (after[p] ? !!latest[p] && after[p] !== latest[p] : DEFAULT_AGENT_PLUGINS.includes(p))).map(
    (p) => `${p} ${after[p] ?? NOT_INSTALLED}${latest[p] ? ` (master: ${latest[p]})` : ''}`,
  );
}

/** Why FF Factory's checkout is not taken forward, or undefined: never a reset, a stash or a branch switch over what is there. */
export function checkoutProblem(s: { porcelain: string; branch: string; origin: string }): string | undefined {
  const changed = s.porcelain.split('\n').filter((l) => l.trim()).length;
  if (changed) return `has uncommitted changes (${changed} path${changed === 1 ? '' : 's'})`;
  if (s.branch !== BRANCH) return `is on ${s.branch || 'a detached HEAD'}, not ${BRANCH}`;
  if (!/github\.com[/:]Final-Factory\/final-factory-agents(\.git)?\/?$/i.test(s.origin.trim())) return `has origin ${s.origin.trim() || '(none)'}, not ${AGENTS_REPO_URL}`;
  return undefined;
}

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

export interface PublishDeps {
  exec(cmd: string, args: string[], o?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<Ran>;
  say(line: string): void;
  env: NodeJS.ProcessEnv;
  /** The user's home folder (os.homedir()). */
  home: string;
  platform: NodeJS.Platform;
  /** Windows, an elevated session (BEAST's ssh, w613): hand what the run made to the daemon task's user, so its non-elevated git does not refuse it. */
  giveTo?: (paths: string[]) => Promise<void>;
}

/** Exit codes of `worker.ts tools`: 0 published and verified, 1 failed, 3 not published (its checkout is not FF Factory's to move). */
export const EXIT = { ok: 0, failed: 1, notPublished: 3 } as const;

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return undefined;
  }
};
const readText = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};
const tail = (r: Ran) => (r.stderr || r.stdout).trim().split(/\r?\n/).slice(-3).join(' / ').slice(0, 400);

/** The `sh` registerAgents.sh runs in: Git Bash's on Windows (next to git itself), the system's elsewhere. */
async function shell(d: PublishDeps): Promise<string> {
  if (d.platform !== 'win32') return 'sh';
  const r = await d.exec('git', ['--exec-path']);
  // <Git>\mingw64\libexec\git-core -> <Git>\bin\sh.exe
  const git = r.code === 0 ? path.resolve(r.stdout.trim(), '..', '..', '..') : '';
  for (const c of [path.join(git, 'bin', 'sh.exe'), path.join(git, 'usr', 'bin', 'sh.exe')]) if (git && fs.existsSync(c)) return c;
  return 'sh';
}

/**
 * Put `dir` first on the search path in `env`, in place. A copy of Windows' process.env keeps the name as it was
 * (`Path`) and is no longer case-blind, so setting `PATH` beside it gave the child two, and git was not found
 * (w1476: beast, whose daemon.json names claude, failed "spawn git ENOENT" in the first rollout). Exported for tests.
 */
export function prependPath(env: NodeJS.ProcessEnv, dir: string, platform: NodeJS.Platform): void {
  const win = platform === 'win32';
  const key = (win ? Object.keys(env).find((k) => k.toUpperCase() === 'PATH') : undefined) ?? 'PATH';
  env[key] = `${dir}${win ? ';' : ':'}${env[key] ?? ''}`;
}

/**
 * Publish the latest agent tools on this machine. `root`: the worker root; `claude`: the daemon's Claude Code binary
 * (daemon.json `claude`), whose folder goes first on PATH. Returns the exit code (EXIT).
 */
export async function publishAgentTools(root: string, d: PublishDeps, o: { claude?: string } = {}): Promise<number> {
  const claudeDir = d.env.CLAUDE_CONFIG_DIR || path.join(d.home, '.claude');
  const installed = path.join(claudeDir, 'plugins', 'installed_plugins.json');
  const before = installedVersions(readJson(installed));
  d.say(`${LINE.before} ${formatVersions(before)}`);

  const env: NodeJS.ProcessEnv = { ...d.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  if (o.claude && path.isAbsolute(o.claude)) prependPath(env, path.dirname(o.claude), d.platform);
  // final-factory-agents is public: no credential helper, no prompt (an ssh session reaches no keychain, w613).
  const anon = ['-c', 'credential.helper=', '-c', 'credential.interactive=never'];
  const git = (args: string[], cwd?: string) => d.exec('git', [...anon, ...args], { env, timeoutMs: 5 * 60_000, ...(cwd ? { cwd } : {}) });

  const co = toolsCheckout(root);
  if (!fs.existsSync(path.join(co, '.git'))) {
    if (fs.existsSync(co) && fs.readdirSync(co).length) {
      d.say(`NOT PUBLISHED: ${co} holds files but no git checkout; it is left as it is. Move it aside and run this again.`);
      return EXIT.notPublished;
    }
    fs.mkdirSync(path.dirname(co), { recursive: true });
    const r = await git(['clone', '--quiet', '--branch', BRANCH, AGENTS_REPO_URL, co]);
    if (r.code !== 0) {
      d.say(`FAILED: could not clone ${AGENTS_REPO_URL} into ${co}: ${tail(r)}`);
      return EXIT.failed;
    }
    d.say(`Cloned ${MARKETPLACE} into ${co} (FF Factory's own checkout; a person's is never used).`);
  } else {
    const [st, br, url] = await Promise.all([git(['status', '--porcelain'], co), git(['rev-parse', '--abbrev-ref', 'HEAD'], co), git(['config', '--get', 'remote.origin.url'], co)]);
    const problem = st.code !== 0 ? `could not be read (git status: ${tail(st)})` : checkoutProblem({ porcelain: st.stdout, branch: br.stdout.trim().replace(/^HEAD$/, ''), origin: url.stdout });
    if (problem) {
      d.say(`NOT PUBLISHED: ${co} ${problem}; nothing in it was overwritten.`);
      d.say(`${LINE.after} ${formatVersions(before)} (unchanged)`);
      return EXIT.notPublished;
    }
    const f = await git(['fetch', '--quiet', 'origin', BRANCH], co);
    if (f.code !== 0) {
      d.say(`FAILED: could not fetch ${MARKETPLACE} (${tail(f)}); the plugins stay as they were.`);
      return EXIT.failed;
    }
    const m = await git(['merge', '--ff-only', '--quiet', `origin/${BRANCH}`], co);
    if (m.code !== 0) {
      d.say(`NOT PUBLISHED: ${co} has commits origin/${BRANCH} does not (it cannot fast-forward); nothing in it was overwritten.`);
      d.say(`${LINE.after} ${formatVersions(before)} (unchanged)`);
      return EXIT.notPublished;
    }
  }
  const head = (await git(['rev-parse', 'HEAD'], co)).stdout.trim().slice(0, 12);
  const latest = marketplaceVersions(readJson(path.join(co, '.claude-plugin', 'marketplace.json')));
  d.say(`${LINE.latest} ${MARKETPLACE} ${head}: ${formatVersions(latest)}`);

  // registerAgents.sh records the checkout it ran from in $HOME/.claude for publish-skills; that stays the person's.
  const marker = path.join(d.env.HOME || d.home, '.claude', `${MARKETPLACE}-checkout`);
  const markerBefore = readText(marker);
  const r = await d.exec(await shell(d), ['registerAgents.sh', '--claude'], { cwd: co, env, timeoutMs: REGISTER_TIMEOUT_MS });
  for (const l of `${r.stdout}\n${r.stderr}`.split(/\r?\n/).filter((x) => x.trim())) d.say(`  ${l.trimEnd()}`);
  if (markerBefore !== undefined && readText(marker) !== markerBefore) {
    fs.writeFileSync(marker, markerBefore);
    d.say(`publish-skills' checkout marker kept on ${markerBefore.trim()}.`);
  } else if (markerBefore === undefined && readText(marker) !== undefined) {
    d.say(`publish-skills' checkout marker now names ${co} (there was none).`);
  }
  if (d.giveTo) {
    const plugins = path.join(claudeDir, 'plugins');
    try {
      await d.giveTo([co, path.join(plugins, 'marketplaces', MARKETPLACE), path.join(plugins, 'cache', MARKETPLACE), installed, path.join(plugins, 'known_marketplaces.json'), marker]);
    } catch (e) {
      d.say(`WARNING: could not give what the run made to the daemon's user: ${(e as Error).message}`);
    }
  }

  const after = installedVersions(readJson(installed));
  d.say(`${LINE.after} ${formatVersions(after)}`);
  if (r.code !== 0) {
    d.say(`FAILED: registerAgents.sh exited ${r.code}${r.code === -1 ? ' (timed out or could not start)' : ''}: ${tail(r)}`);
    return EXIT.failed;
  }
  const stale = staleAfter(after, latest);
  if (stale.length) {
    d.say(`FAILED: not on master's version after registerAgents.sh: ${stale.join(', ')}.`);
    return EXIT.failed;
  }
  d.say('Agent tools published: every installed plugin is on master. Running agents keep the version they started with; new sessions load these.');
  return EXIT.ok;
}
