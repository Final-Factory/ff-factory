/**
 * Git Bash's /tmp on a Windows worker (w603).
 *
 * Git for Windows mounts /tmp as `usertemp` (its etc/fstab): the Windows temp folder (GetTempPathW: TMP, else TEMP)
 * of the first MSYS process of this user. The mount table lives in the user's MSYS shared memory, built once by
 * that first process and kept while any MSYS process of the user runs (msys2-runtime mm/shared.cc,
 * user_info::initialize; mount.cc, MOUNT_USER_TEMP). On a worker that first process is usually some agent's
 * bash, whose TMP is its own ffa-<session> folder. Once that session ends its folder goes (the daemon's 'remove',
 * or the agent-temp clean-up rule), and from then on every bash of the user prints
 * "bash.exe: warning: could not find /tmp, please create!" until the machine has no MSYS process left, which on a
 * busy worker is never (LothDesktop, 2026-10-07: pinned to a session folder removed the day before).
 *
 * So the daemon asks Git's cygpath where /tmp is, keeps that folder out of every clean-up, and makes it again
 * when something else removed it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { run, type RunResult } from './proc.ts';

export interface GitBashTmpDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists: (p: string) => boolean;
  mkdir: (p: string) => void;
  run: (cmd: string, args: string[]) => Promise<RunResult>;
}

export const realGitBashTmpDeps = (): GitBashTmpDeps => ({
  platform: process.platform,
  env: process.env,
  exists: (p) => fs.existsSync(p),
  mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
  run: (cmd, args) => run(cmd, args, { timeoutMs: 15_000 }),
});

/** Where Git for Windows' cygpath.exe may be: the Git that Claude Code uses, every Git on PATH, the default install. */
export function cygpathCandidates(env: NodeJS.ProcessEnv): string[] {
  const W = path.win32;
  const out: string[] = [];
  // CLAUDE_CODE_GIT_BASH_PATH is <git>\bin\bash.exe (or <git>\usr\bin\bash.exe).
  const bash = env.CLAUDE_CODE_GIT_BASH_PATH;
  if (bash) {
    const dir = W.dirname(bash);
    out.push(W.basename(dir).toLowerCase() === 'bin' && W.basename(W.dirname(dir)).toLowerCase() === 'usr' ? W.join(dir, 'cygpath.exe') : W.join(dir, '..', 'usr', 'bin', 'cygpath.exe'));
  }
  for (const d of (env.PATH ?? env.Path ?? '').split(';').filter(Boolean)) {
    const base = W.basename(d).toLowerCase();
    if (base === 'cmd' || base === 'bin' || base === 'mingw64') out.push(W.join(d, '..', 'usr', 'bin', 'cygpath.exe'));
    out.push(W.join(d, 'cygpath.exe'));
  }
  for (const pf of [env.ProgramFiles, env.ProgramW6432, 'C:\\Program Files']) if (pf) out.push(W.join(pf, 'Git', 'usr', 'bin', 'cygpath.exe'));
  return [...new Set(out.map((p) => W.normalize(p)))];
}

/** The Windows folder Git Bash maps /tmp to right now, or undefined (not Windows, no Git, cygpath failed). */
export async function gitBashTmp(d: GitBashTmpDeps = realGitBashTmpDeps()): Promise<string | undefined> {
  if (d.platform !== 'win32') return undefined;
  const cygpath = cygpathCandidates(d.env).find((p) => d.exists(p));
  if (!cygpath) return undefined;
  const r = await d.run(cygpath, ['-w', '/tmp']);
  const dir = r.stdout.trim().split(/\r?\n/).pop()?.trim();
  return r.code === 0 && dir && /^([a-zA-Z]:\\|\\\\)/.test(dir) ? dir.replace(/\\+$/, '') : undefined;
}

/** Git Bash's /tmp, made when it is missing. `made` says it was missing. Never throws. */
export async function ensureGitBashTmp(d: GitBashTmpDeps = realGitBashTmpDeps()): Promise<{ dir?: string; made: boolean; error?: string }> {
  let dir: string | undefined;
  try {
    dir = await gitBashTmp(d);
    if (!dir || d.exists(dir)) return { dir, made: false };
    d.mkdir(dir);
    return { dir, made: true };
  } catch (e) {
    return { dir, made: false, error: (e as Error).message };
  }
}

/**
 * Whether clean-up must keep `dir` (Git Bash's /tmp): a folder inside a temp root, such as an agent's ffa-<session>.
 * A temp root itself needs no keep (rules remove entries in it, never the root), and keeping it would keep all of it.
 */
export function keepGitBashTmp(dir: string | undefined, tempRoots: (string | undefined)[]): string | undefined {
  if (!dir) return undefined;
  const n = (p: string) => path.win32.resolve(p).replace(/\\+$/, '').toLowerCase();
  return tempRoots.some((t) => t && n(t) === n(dir)) ? undefined : dir;
}
