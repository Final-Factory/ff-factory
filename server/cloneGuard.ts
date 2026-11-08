/**
 * w3703: no worker makes a full clone of the game repo (lothsahn, about w3683's pair run: "The worker put a whole clone of
 * the repo in the temp directory. It should not be doing this.").
 *
 * A clone of the game repo carries its LFS store (8 GB on BEAST, w3683) and, with the game repo's `scratch_clone.sh
 * --library`, a copy of a sandbox's Library (24-48 GB): w3683's clone-w3683 reached 43 GB on LothDesktop's V:, w3682's 48 GB
 * on BEAST's F:, and each drove its drive towards full while every worker on the machine shares it. A before/after or
 * pair-run player is built in the worker's own sandbox, one commit at a time, so the guard refuses:
 *   - `git clone` of the game repo (its URL, a configured game repo path, the sandbox, or any folder that is a Unity project)
 *     unless the clone is `--sparse` (a scripts-only clone for editing: no Assets, no LFS files checked out);
 *   - the game repo's `scripts/nightly/scratch_clone.sh`, whatever its arguments.
 * A PR that only had a lesson written (w3682's #3440) did not stop the next worker; this does.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expandVars, repoKey } from './guard.ts';

type ShellEnv = Record<string, string | undefined>;

/** For the briefs: where a pair-run leg or an A/B side builds its players (the pair leg role, timed legs, timed_place). */
export const PLAYERS_IN_SANDBOX =
  'Build every commit\'s player in your own sandbox, one commit at a time: check the commit out, build it, move the player out of the tree (into $TMPDIR), then check out the next; ' +
  'never clone the game repo into your temp folder : the harness refuses a full clone and scratch_clone.sh (one such clone reached 43 GB).';

export const BUILD_IN_SANDBOX =
  'Build in your sandbox, one commit at a time (w3703): commit or set aside your work, check the commit out in your sandbox ' +
  '(mcp__machine__switch_branch to a branch; with the editor stopped, `git checkout --detach <sha>` for a bare commit), build it ' +
  'with `unity-slot run -- scripts/nightly/build_player.sh` there, move the player out of the tree (into $TMPDIR/<leg>), then ' +
  'check out the next commit and build again, and switch back to your branch at the end. To only read or edit scripts of the ' +
  'game repo elsewhere, clone it sparse and without LFS files: `GIT_LFS_SKIP_SMUDGE=1 git clone --sparse --filter=blob:none ' +
  '--depth 50 <url> $TMPDIR/<dir>`, then `git sparse-checkout set scripts`.';

export interface CloneGuardContext {
  cwd?: string;
  env?: ShellEnv;
  /** URLs or paths that name the game repo (the guard's gameRepos). Empty: only Unity project folders and the sandbox count. */
  gameRepos: string[];
  /** The worker's sandbox, a checkout of the game repo when it is a game sandbox. */
  sandboxPath?: string;
  /** Whether a folder is a Unity project (the game repo's checkout). Default: it holds ProjectSettings/ProjectVersion.txt. */
  isUnityProject?: (dir: string) => boolean;
}

/** git clone's options that take a value as the next word. */
const CLONE_VALUE_FLAGS = new Set(['-o', '--origin', '-b', '--branch', '-u', '--upload-pack', '--reference', '--reference-if-able', '--separate-git-dir', '--depth', '--shallow-since', '--shallow-exclude', '-c', '--config', '--server-option', '-j', '--jobs', '--filter', '--template', '--bundle-uri', '--ref-format']);

const norm = (p: string) => path.posix.normalize(p.replace(/\\/g, '/')).replace(/\/+$/, '').toLowerCase();
const gitBashDrive = (p: string) => (/^\/[a-zA-Z]\//.test(p) ? `${p[1]}:${p.slice(2)}` : p);
const unityProject = (dir: string) => {
  try {
    return fs.existsSync(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt'));
  } catch {
    return false;
  }
};

/** Whether `src`, a clone's source as written (a URL or a path, from `dir`), is the game repo. */
function isGameSource(src: string, dir: string | undefined, ctx: CloneGuardContext): boolean {
  const e = expandVars(src, ctx.env) ?? src;
  const remote = /^(?:[a-z+]+:\/\/|[^@/\s]+@[^:/\s]+:)/i.test(e) && !/^file:\/\//i.test(e);
  if (remote) {
    const key = repoKey(e);
    if (ctx.gameRepos.some((g) => repoKey(g) === key)) return true;
    // The game repo's own name on GitHub, whatever is configured here.
    return /^github\.com\/final-factory\/finalfactory$/.test(key);
  }
  const local = gitBashDrive(e.replace(/^file:\/\//i, ''));
  const abs = /^[a-zA-Z]:[\\/]/.test(local) || local.startsWith('/') ? local : dir ? path.join(dir, local) : local;
  const n = norm(abs);
  const named = [...ctx.gameRepos, ...(ctx.sandboxPath ? [ctx.sandboxPath] : [])].filter((g) => !/^[a-z+]+:\/\//i.test(g) && !/^[^@/\s]+@/.test(g));
  if (named.some((g) => norm(gitBashDrive(g)) === n)) return true;
  return (ctx.isUnityProject ?? unityProject)(abs);
}

/**
 * The refusal for a command that makes a full clone of the game repo or runs scratch_clone.sh (w3703), else undefined.
 * Each simple command is judged on its own; `cd` is followed so a relative source resolves.
 */
export function checkGameRepoClone(command: string, ctx: CloneGuardContext): string | undefined {
  let dir = ctx.cwd;
  for (const seg of command.split(/&&|\|\||[;|\n]/)) {
    const raw = seg
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.replace(/^["']|["']$/g, ''));
    const lower = raw.map((w) => w.toLowerCase());
    if (['cd', 'pushd', 'chdir', 'set-location', 'sl'].includes(lower[0] ?? '') && raw[1]) {
      const t = expandVars(raw[1], ctx.env);
      const q = t === undefined ? undefined : gitBashDrive(t);
      dir = q === undefined ? undefined : /^[a-zA-Z]:[\\/]/.test(q) || q.startsWith('/') ? q : dir ? path.join(dir, q) : undefined;
    }
    if (lower.some((w) => /(?:^|[\\/])scratch_clone\.sh$/.test(w))) {
      return `scripts/nightly/scratch_clone.sh is retired: its clones of the game repo (LFS files, and with --library a whole Library) filled V: on LothDesktop (43 GB, w3683) and F: on BEAST (48 GB, w3682). ${BUILD_IN_SANDBOX}`;
    }
    // The command word, past `NAME=value` assignments: `echo "git clone ..."` runs no clone.
    const g = lower.findIndex((w) => !/^\w+=/.test(w));
    if (g < 0 || !(lower[g] === 'git' || lower[g].endsWith('/git') || lower[g].endsWith('\\git') || lower[g].endsWith('git.exe'))) continue;
    let i = g + 1;
    let gitDir = dir;
    while (i < raw.length && raw[i].startsWith('-')) {
      if (raw[i] === '-C' && raw[i + 1]) {
        const t = expandVars(raw[i + 1], ctx.env);
        gitDir = t === undefined ? undefined : /^[a-zA-Z]:[\\/]/.test(gitBashDrive(t)) || t.startsWith('/') ? gitBashDrive(t) : gitDir ? path.join(gitDir, t) : undefined;
      }
      i += raw[i] === '-C' || raw[i] === '-c' ? 2 : 1;
    }
    if (lower[i] !== 'clone') continue;
    const args = raw.slice(i + 1);
    let sparse = false;
    const positionals: string[] = [];
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (a === '--') {
        positionals.push(...args.slice(k + 1));
        break;
      }
      if (a.startsWith('-')) {
        if (a === '--sparse') sparse = true;
        if (CLONE_VALUE_FLAGS.has(a.toLowerCase())) k++;
        continue;
      }
      positionals.push(a);
    }
    const src = positionals[0];
    if (!src || sparse) continue;
    if (!isGameSource(src, gitDir, ctx)) continue;
    return `A full clone of the game repo is refused (w3703, lothsahn: "The worker put a whole clone of the repo in the temp directory. It should not be doing this."): its LFS files and Library copies filled V: on LothDesktop (43 GB, w3683) and F: on BEAST (48 GB, w3682). ${BUILD_IN_SANDBOX}`;
  }
  return undefined;
}
