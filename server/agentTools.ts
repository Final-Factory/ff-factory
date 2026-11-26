import fs from 'node:fs';
import path from 'node:path';
import { TOOLS_MEDIUM_CHILD } from './claudeHome.ts';
import { FIXED_GIT_CONFIG, HOOKS, SCANNED_KEYS, parseScan, scannedOverrides, withConfigFirst } from './safeGit.ts';

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
 * - Brings FF Factory's OWN checkout, `<root>/tools-medium/final-factory-agents` (w5597: a root child no worker fence lets a
 *   worker write; it was `<root>/tools/final-factory-agents`, which workers write, so a planted hook ran at the daemon's level
 *   on the next fetch), to origin/master (a clone the first time, then a fast-forward only). A person's checkout (BEAST's
 *   `~/final-factory-agents`, docs/worker-root.md) is never touched: the plugins Claude Code loads come from its managed
 *   marketplace clone, which `registerAgents.sh` refreshes from GitHub. The old checkout is never run, fetched or written
 *   again (it stays, readable, as the readers' fallback). Its own checkout missing, dirty, on another branch or diverged:
 *   nothing is overwritten, a WARNING says why and the publish goes on, since nothing below runs from it. The same fault
 *   REPAIR_AFTER publishes in a row (files but no .git: at once) moves it to `<checkout>.broken` and clones it again (w5776).
 * - Runs every git with `core.hooksPath` on an empty folder of the run's own, no global config, no system config (but on
 *   Windows, whose TLS backend lives there) and server/safeGit.ts's fence (w5541).
 * - Runs `sh registerAgents.sh --claude`, not from that checkout (w5573) but from a fresh shallow clone of origin/master in
 *   a new folder in `<root>/tools-medium`, removed after: the marketplace refreshed, every plugin the machine remembers updated (a
 *   bare run keeps the machine's set: ff-agents and ff-speckit everywhere, ff-discord where a person asked for it). Claude
 *   Code fetches the marketplace over HTTPS only, with a longer git timeout (REGISTER_ENV), and a failed run is run once
 *   more (w1895).
 * - Puts back publish-skills' checkout marker (`~/.claude/final-factory-agents-checkout`, which `registerAgents.sh` points at
 *   the checkout it ran from), so a person's skill edits keep going to their own checkout. A marker that names no checkout
 *   (an earlier run's removed clone, w5784) is not put back: it names the lasting checkout.
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
/**
 * What registerAgents.sh's `claude plugin` calls run with (w1895). Claude Code (2.1.309) fetches a github marketplace over
 * SSH when `ssh -T git@github.com` authenticates, else over HTTPS, and falls back to the other transport when the first one
 * fails, with a 120 s git timeout. m5's key is on no GitHub account, so whenever its HTTPS fetch failed (both failed runs
 * on 2026-10-23 took about that timeout) the SSH fallback failed too, and the step reported only the SSH error ("Please make
 * sure you have the correct access rights"); m3's key is bryding's, so its fetch goes over SSH. final-factory-agents is
 * public, as FF Factory's own anonymous fetch of it says: HTTPS only on every machine (no person's ssh key in it, and a
 * failure names the real HTTPS error), and five minutes for its git, the value Claude Code's own timeout message suggests.
 * A value the environment already sets is kept.
 */
export const REGISTER_ENV = { CLAUDE_CODE_PLUGIN_PREFER_HTTPS: '1', CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS: String(5 * 60_000) } as const;

export type Versions = Record<string, string | undefined>;

/** The lines `worker.ts tools` prints and the machine rollout reads back. */
export const LINE = { before: 'Agent tools before:', after: 'Agent tools after:', latest: 'Agent tools latest:', checkout: 'Agent tools checkout:' } as const;

/**
 * FF Factory's own checkout of final-factory-agents in a worker root: `<root>/tools-medium/final-factory-agents` (w5597), in
 * a root child only Medium writes (claudeHome.ts MEDIUM_ONLY_CHILDREN), so no worker can plant a hook or a script in it.
 */
export const toolsCheckout = (root: string) => path.join(root, TOOLS_MEDIUM_CHILD, MARKETPLACE);
/** Where it was before w5597, `<root>/tools/final-factory-agents`, which workers write: never run or taken forward again, only read as a fallback. */
export const legacyToolsCheckout = (root: string) => path.join(root, 'tools', MARKETPLACE);
/** The checkout readers use: the new one once it has `rel`, else the old one while it has it, else undefined. */
export function readableToolsCheckout(root: string, rel: string, exists: (p: string) => boolean = fs.existsSync): string | undefined {
  return [toolsCheckout(root), legacyToolsCheckout(root)].find((c) => exists(path.join(c, rel)));
}
/** w5776: how many publishes in a row may find the same fault in FF Factory's checkout before it is moved aside and cloned again. */
export const REPAIR_AFTER = 3;
/** w5776: where a broken checkout is moved when its new clone replaces it; one backup, the newest. */
export const checkoutBackup = (root: string) => `${toolsCheckout(root)}.broken`;
/** w5776: the fault the last publishes found and how many in a row, beside the checkout (Medium only, like it). */
export const repairStateFile = (root: string) => `${toolsCheckout(root)}.repair.json`;
/** w5776 follow-up (w5787 review): the repair clones here first and swaps only once that clone worked (Medium only, like it). */
export const checkoutStaging = (root: string) => `${toolsCheckout(root)}.new`;
const samePath = (a: string, b: string) => {
  const r = (p: string) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' || /^[a-z]:/i.test(a) ? r(a).toLowerCase() === r(b).toLowerCase() : r(a) === r(b);
};

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
  /** Where the run's fresh clone goes (default: <root>/tools, beside the checkout, inside the worker root). */
  tmpdir?: string;
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
 * (daemon.json `claude`), whose folder goes first on PATH; `medium`: the Medium agents' Claude Code folder (w5543,
 * server/claudeHome.ts), which gets the same plugins from the same checkout in the same run, so the two never drift: the
 * run fails when either is not on master's version. Returns the exit code (EXIT).
 */
export async function publishAgentTools(root: string, d: PublishDeps, o: { claude?: string; medium?: string } = {}): Promise<number> {
  const claudeDir = d.env.CLAUDE_CONFIG_DIR || path.join(d.home, '.claude');
  const installed = path.join(claudeDir, 'plugins', 'installed_plugins.json');
  const before = installedVersions(readJson(installed));
  d.say(`${LINE.before} ${formatVersions(before)}`);

  const env: NodeJS.ProcessEnv = { ...d.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  if (o.claude && path.isAbsolute(o.claude)) prependPath(env, path.dirname(o.claude), d.platform);
  // final-factory-agents is public: no credential helper, no prompt (an ssh session reaches no keychain, w613).
  const anon = ['-c', 'credential.helper=', '-c', 'credential.interactive=never'];

  // w5597: FF Factory's checkout and this run's fresh clone live in <root>/tools-medium, a root child no worker fence lets a
  // worker write (claudeHome.ts MEDIUM_ONLY_CHILDREN). The old <root>/tools/final-factory-agents, which workers can write, is
  // never run, read by git or written again: it stays as it is, readable, and the readers fall back to it until a run has
  // made the new one (pluginPaths.ts, evidenceGate.ts). Nothing about the lasting checkout can stop a publish: the plugins
  // come from the fresh clone, so a checkout that cannot be made or taken forward is a WARNING and the run goes on.
  const co = toolsCheckout(root);
  const legacy = legacyToolsCheckout(root);
  const base = path.dirname(co);
  fs.mkdirSync(base, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(d.tmpdir ?? base, 'ff-agents-run-'));
  try {
    // Every git call: no hooks (an empty folder of this run's own, w5597), no global config, no system config but on Windows
    // (whose TLS backend lives there), no replace refs, no templates; worker.ts exec adds server/safeGit.ts's fence (w5541).
    const noHooks = path.join(tmp, 'no-hooks');
    fs.mkdirSync(noHooks);
    const emptyGlobal = path.join(tmp, 'gitconfig');
    fs.writeFileSync(emptyGlobal, '');
    const cleanEnv: NodeJS.ProcessEnv = { ...env, GIT_CONFIG_GLOBAL: emptyGlobal, GIT_NO_REPLACE_OBJECTS: '1', GIT_TEMPLATE_DIR: '', ...(d.platform === 'win32' ? {} : { GIT_CONFIG_NOSYSTEM: '1' }) };
    const git = (args: string[], cwd?: string, timeoutMs = 5 * 60_000) => d.exec('git', [...anon, '-c', `core.hooksPath=${noHooks}`, ...args], { env: cleanEnv, timeoutMs, ...(cwd ? { cwd } : {}) });

    const fresh = '; this run publishes from a fresh clone';
    const clone = async (again: string) => {
      const r = await git(['clone', '--quiet', '--branch', BRANCH, AGENTS_REPO_URL, co]);
      if (r.code !== 0) d.say(`WARNING: could not clone ${AGENTS_REPO_URL} into ${co} (${tail(r)})${fresh}.`);
      else d.say(again || `Cloned ${MARKETPLACE} into ${co} (FF Factory's own checkout, which no worker can write${fs.existsSync(legacy) ? `; the old ${legacy} is no longer used and is left as it is` : ''}).`);
    };
    // What is wrong with the lasting checkout this run: `kind` names the fault the same from one run to the next (w5776).
    let fault: { kind: string; why: string; kept: string } | undefined;
    const kept = `; nothing in it was overwritten${fresh}`;
    if (!fs.existsSync(path.join(co, '.git'))) {
      if (fs.existsSync(co) && fs.readdirSync(co).length) fault = { kind: 'no-git', why: 'holds files but no git checkout', kept: `; it is left as it is${fresh}` };
      else await clone('');
    } else {
      const [st, br, url] = await Promise.all([git(['status', '--porcelain'], co), git(['rev-parse', '--abbrev-ref', 'HEAD'], co), git(['config', '--get', 'remote.origin.url'], co)]);
      const problem = st.code !== 0 ? `could not be read (git status: ${tail(st)})` : checkoutProblem({ porcelain: st.stdout, branch: br.stdout.trim().replace(/^HEAD$/, ''), origin: url.stdout });
      if (problem) fault = { kind: st.code !== 0 ? 'unreadable' : problem.replace(/\d+/g, '#'), why: problem, kept };
      else {
        const f = await git(['fetch', '--quiet', 'origin', BRANCH], co);
        if (f.code !== 0) fault = { kind: 'fetch', why: `could not be fetched from ${MARKETPLACE} (${tail(f)})`, kept: fresh };
        else if ((await git(['merge', '--ff-only', '--quiet', `origin/${BRANCH}`], co)).code !== 0) fault = { kind: 'diverged', why: `has commits origin/${BRANCH} does not (it cannot fast-forward)`, kept };
      }
    }
    // w5776: a fault seen REPAIR_AFTER publishes in a row (a checkout with files but no .git at once) is repaired with no
    // person at the machine: the checkout is moved to `<co>.broken` (the one backup kept, an older one removed) and cloned
    // again, by this Medium run with the same fenced, hook-free git. Workers cannot write <root>/tools-medium, so only a
    // daemon fault, a person or a failed clone breaks it; readers fall back to the old checkout while it is away.
    const state = repairStateFile(root);
    if (!fault) fs.rmSync(state, { force: true });
    else {
      const was = readJson(state) as { kind?: unknown; count?: unknown } | undefined;
      const count = fault.kind === 'no-git' ? REPAIR_AFTER : (was?.kind === fault.kind && typeof was.count === 'number' ? was.count : 0) + 1;
      if (count < REPAIR_AFTER) {
        d.say(`WARNING: ${co} ${fault.why}${fault.kept} (${count} of ${REPAIR_AFTER} publishes in a row before it is moved aside and cloned again).`);
        fs.writeFileSync(state, JSON.stringify({ kind: fault.kind, count }));
      } else {
        const bak = checkoutBackup(root);
        const next = checkoutStaging(root);
        const times = fault.kind === 'no-git' ? '' : ` for ${count} publishes in a row`;
        const keep = () => fs.writeFileSync(state, JSON.stringify({ kind: fault!.kind, count }));
        // The new clone is made first, beside it, and swapped in only once it worked (w5787's review): a fault that is the
        // network (a fetch that failed three times) then leaves the old, readable checkout in place rather than nothing.
        let r: Ran = { code: 1, stdout: '', stderr: '' };
        try {
          fs.rmSync(next, { recursive: true, force: true, maxRetries: 3 });
          r = await git(['clone', '--quiet', '--branch', BRANCH, AGENTS_REPO_URL, next]);
        } catch (e) {
          r = { code: 1, stdout: '', stderr: (e as Error).message };
        }
        if (r.code !== 0) {
          fs.rmSync(next, { recursive: true, force: true, maxRetries: 3 });
          d.say(`WARNING: ${co} ${fault.why}${times}, and a new clone to replace it failed (${tail(r)}); it is left as it is${fresh}.`);
          keep();
        } else {
          let moved = false;
          try {
            fs.rmSync(bak, { recursive: true, force: true, maxRetries: 3 });
            fs.renameSync(co, bak);
            moved = true;
            fs.renameSync(next, co);
          } catch (e) {
            d.say(`WARNING: ${co} ${fault.why}${times}, and it could not be ${moved ? `replaced after it was moved to ${bak}` : 'moved aside'} (${(e as Error).message}); ${moved ? 'the next publish clones it' : 'it is left as it is'}${fresh}.`);
            fs.rmSync(next, { recursive: true, force: true, maxRetries: 3 });
            if (moved) fs.rmSync(state, { force: true });
            else keep();
            moved = false;
          }
          if (moved) {
            d.say(`WARNING: ${co} ${fault.why}${times}; it was moved to ${bak} (the one backup kept) and replaced by a new clone.`);
            d.say(`Repaired FF Factory's checkout: cloned ${MARKETPLACE} into ${co} again.`);
            fs.rmSync(state, { force: true });
          }
        }
      }
    }
    const coHead = fs.existsSync(path.join(co, '.git')) ? (await git(['rev-parse', 'HEAD'], co, 60_000)).stdout.trim() : '';

    // registerAgents.sh records the checkout it ran from in $HOME/.claude for publish-skills; that stays the person's.
    const marker = path.join(d.env.HOME || d.home, '.claude', `${MARKETPLACE}-checkout`);
    const sh = await shell(d);
    // w5573: the script runs from a clone nothing else wrote, made in this run's own folder.
    const run = path.join(tmp, MARKETPLACE);
    const c = await git(['clone', '--quiet', '--depth', '1', '--single-branch', '--branch', BRANCH, AGENTS_REPO_URL, run]);
    const runHead = c.code === 0 ? (await git(['-C', run, 'rev-parse', 'HEAD'], undefined, 60_000)).stdout.trim() : '';
    if (!/^[0-9a-f]{40,64}$/.test(runHead)) {
      d.say(`FAILED: could not make a fresh clone of ${AGENTS_REPO_URL} to run registerAgents.sh from (${tail(c)}); the plugins stay as they were.`);
      return EXIT.failed;
    }
    const latest = marketplaceVersions(readJson(path.join(run, '.claude-plugin', 'marketplace.json')));
    d.say(`${LINE.latest} ${MARKETPLACE} ${runHead.slice(0, 12)}: ${formatVersions(latest)}`);
    d.say(`${LINE.checkout} ${/^[0-9a-f]{40,64}$/.test(coHead) ? `${co} at ${coHead.slice(0, 12)}` : `none (${co} could not be made; see the WARNING above)`}`);
    const keepCo = /^[0-9a-f]{40,64}$/.test(coHead) ? co : undefined;
    // The workers' folder first (its lines are the ones the rollout reads, machineRollout.ts), then the Medium agents' one.
    const x = { co: keepCo, legacy, base, run, env, sh, marker, latest };
    const code = await registerInto(root, d, { ...x, claudeDir, label: '' });
    if (code !== EXIT.ok) return code;
    const medium = o.medium && path.resolve(o.medium) !== path.resolve(claudeDir) ? o.medium : undefined;
    if (medium) {
      fs.mkdirSync(medium, { recursive: true });
      const mBefore = installedVersions(readJson(path.join(medium, 'plugins', 'installed_plugins.json')));
      const label = ` (Medium agents, ${medium})`;
      d.say(`${LINE.before.replace(/:$/, label + ':')} ${formatVersions(mBefore)}`);
      const m = await registerInto(root, d, { ...x, env: { ...env, CLAUDE_CONFIG_DIR: medium }, claudeDir: medium, label });
      if (m !== EXIT.ok) return m;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  d.say('Agent tools published: every installed plugin is on master. Running agents keep the version they started with; new sessions load these.');
  return EXIT.ok;
}

/**
 * w5870: the env registerAgents.sh runs with, fenced like safeGit's calls. Its `claude plugin marketplace update` runs git in
 * <claudeDir>/plugins/marketplaces/final-factory-agents, and the workers' folder is Low-writable while `worker.ts tools`
 * runs at Medium (or elevated): a worker could plant a hook, an fsmonitor or a filter there for that git to run. The
 * fixed keys and the overrides of what that checkout's own config names go in as command-scope entries, which every
 * git under it reads; a planted key is also said, so a person can look.
 */
export async function fencedRegisterEnv(d: Pick<PublishDeps, 'exec' | 'say'>, claudeDir: string, env: NodeJS.ProcessEnv, label = ''): Promise<NodeJS.ProcessEnv | undefined> {
  const mp = path.join(claudeDir, 'plugins', 'marketplaces', 'final-factory-agents');
  let rows: ReturnType<typeof parseScan> = [];
  if (fs.existsSync(mp)) {
    const r = await d.exec('git', ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${HOOKS}`, '-C', mp, 'config', '--show-scope', '-z', '--get-regexp', SCANNED_KEYS], { env, timeoutMs: 60_000 });
    // Exit 1 is "no key matched".
    if (r.code === 0) rows = parseScan(r.stdout);
    else if (r.code !== 1) d.say(`WARNING: could not read the marketplace checkout's git config${label} (${tail(r)}); its git runs with the fixed fence only.`);
  }
  const planted = rows.filter((r) => !['system', 'global', 'command', 'unknown'].includes(r.scope));
  if (planted.length) d.say(`WARNING: the marketplace checkout ${mp}${label} sets ${[...new Set(planted.map((r) => r.key))].join(', ')} in its own config; the refresh runs with them overridden (w5870). Look at who wrote it, or run registerAgents.sh --reinstall there.`);
  // A URL rewrite cannot be overridden by value (safeGit refuses the call, w5573): it could point the refresh at another
  // repository, whose plugins every agent would then load. Refused here too.
  const rewrite = planted.find((r) => /^url\..+\.(insteadof|pushinsteadof)$/.test(r.key));
  if (rewrite) {
    d.say(`FAILED: the marketplace checkout ${mp}${label} rewrites remote URLs (${rewrite.key}), so its refresh could fetch another repository; the plugins stay as they were. Remove it (\`git -C ${mp} config --local --unset-all ${rewrite.key}\`) or run registerAgents.sh --reinstall.`);
    return undefined;
  }
  return withConfigFirst(env, [...FIXED_GIT_CONFIG, ...scannedOverrides(rows)]);
}

/** One Claude Code folder's part of a publish: registerAgents.sh into it, then the check that every plugin is on master's version. */
async function registerInto(
  root: string,
  d: PublishDeps,
  x: { co: string | undefined; legacy: string; base: string; run: string; env: NodeJS.ProcessEnv; sh: string; marker: string; claudeDir: string; latest: Versions; label: string },
): Promise<number> {
  const { co, legacy, base, run, env, sh, marker, claudeDir, latest, label } = x;
  const installed = path.join(claudeDir, 'plugins', 'installed_plugins.json');
  const markerBefore = readText(marker);
  const registerEnv = await fencedRegisterEnv(d, claudeDir, { ...REGISTER_ENV, ...env }, label);
  if (!registerEnv) return EXIT.failed;
  const register = async () => {
    const x = await d.exec(sh, ['registerAgents.sh', '--claude'], { cwd: run, env: registerEnv, timeoutMs: REGISTER_TIMEOUT_MS });
    for (const l of `${x.stdout}\n${x.stderr}`.split(/\r?\n/).filter((y) => y.trim())) d.say(`  ${l.trimEnd()}`);
    return x;
  };
  let r = await register();
  // Every step of it is safe to repeat (a marketplace refresh, plugin updates); a run that timed out is not run again.
  if (r.code !== 0 && r.code !== -1) {
    d.say(`registerAgents.sh exited ${r.code} (${tail(r)}); running it once more.`);
    r = await register();
  }
  // w5597: a marker that names FF Factory's old checkout moves with it (that one is no longer taken forward). w5784: so does
  // one that names no checkout at all (empty, or a folder without .claude-plugin/marketplace.json, such as an earlier run's
  // ff-agents-run-* clone that is gone): putting it back as it was kept BEAST's marker on a removed run folder for every
  // publish after, and publish-skills stops on it.
  const before = markerBefore?.trim().split(/\r?\n/)[0]?.trim() ?? '';
  const oldCo = markerBefore !== undefined && before !== '' && samePath(before, legacy);
  const noCheckout = markerBefore !== undefined && !oldCo && (before === '' || !fs.existsSync(path.join(before, '.claude-plugin', 'marketplace.json')));
  const markerKeep = co && (oldCo || noCheckout) ? `${co}\n` : markerBefore;
  if (markerKeep !== undefined && readText(marker) !== markerKeep) {
    fs.writeFileSync(marker, markerKeep);
    d.say(markerKeep === markerBefore ? `publish-skills' checkout marker kept on ${markerKeep.trim()}.` : oldCo ? `publish-skills' checkout marker now names ${co} (it named the old ${legacy}).` : `publish-skills' checkout marker now names ${co} (it named ${before || 'nothing'}, which is not a checkout).`);
  } else if (markerKeep === undefined && co) {
    // The script ran from a temp folder, which it does not record (or did): the marker names the lasting checkout.
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, `${co}\n`);
    d.say(`publish-skills' checkout marker now names ${co} (there was none).`);
  } else if (markerKeep === undefined) {
    // No lasting checkout this run: no marker naming the run's temp folder, which is removed after.
    fs.rmSync(marker, { force: true });
  }
  if (d.giveTo) {
    const plugins = path.join(claudeDir, 'plugins');
    try {
      // w5305: <root>/claude itself and its settings.json too, when the run made them (an elevated run on Windows). w5597:
      // the whole <root>/tools-medium, the checkout in it.
      await d.giveTo([base, path.join(plugins, 'marketplaces', MARKETPLACE), path.join(plugins, 'cache', MARKETPLACE), installed, path.join(plugins, 'known_marketplaces.json'), ...(fs.existsSync(marker) ? [marker] : []), ...(path.resolve(claudeDir).startsWith(path.resolve(root)) ? [claudeDir] : [])]);
    } catch (e) {
      d.say(`WARNING: could not give what the run made to the daemon's user: ${(e as Error).message}`);
    }
  }

  const after = installedVersions(readJson(installed));
  d.say(`${LINE.after.replace(/:$/, label + ':')} ${formatVersions(after)}`);
  if (r.code !== 0) {
    d.say(`FAILED${label}: registerAgents.sh exited ${r.code}${r.code === -1 ? ' (timed out or could not start)' : ''}: ${tail(r)}`);
    return EXIT.failed;
  }
  const stale = staleAfter(after, latest);
  if (stale.length) {
    d.say(`FAILED${label}: not on master's version after registerAgents.sh: ${stale.join(', ')}.`);
    return EXIT.failed;
  }
  return EXIT.ok;
}
