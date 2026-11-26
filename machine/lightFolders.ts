import fs from 'node:fs';
import path from 'node:path';
import { removeTree, run } from '../server/proc.ts';
import type { DaemonSandbox } from '../server/machineProtocol.ts';

/**
 * Light agent folders (w5924, lothsahn: "FFU and agent-only work run without a game sandbox"): work that needs only an agent
 * slot (a request whose needs is "agent": FF Factory, FFBox, the plugin, FFU, a review) gets a plain folder of its own instead
 * of a game sandbox (a FinalFactory checkout with its own Unity Library). The worker keeps its own clone of its repo there or
 * in its temp folder; FFU builds still borrow an ffu slot (`ffu-slot take`).
 *
 * Where: `<sandbox_root>/agent-work/<id>`, ids `agent1`, `agent2`, ... The sandbox root is already one of the worker fence's
 * work folders on every OS (the Linux Landlock lock and the Mac Seatbelt fence open it, and on Windows `sandboxes` is a Low
 * root child labelled `(OI)(CI)`, so a folder made in it is Low too): no fence, link or update path changes for it.
 *
 * The folders are the state: the daemon lists what is on disk (no state file a restart could lose), reports them with its
 * sandboxes as `kind: "light"`, and keeps them out of everything a game sandbox has (an editor, git status, Library trims,
 * slot repo conversion). A delete refuses while any git repository inside holds work its remote lacks (uncommitted or
 * untracked files, a commit on no remote branch, a stash): nothing is lost to a clean-up.
 */
export const LIGHT_DIR = 'agent-work';
export const LIGHT_ID = /^agent\d{1,3}$/;
export const isLightId = (id: string | undefined): boolean => !!id && LIGHT_ID.test(id);

/** The first free light folder id ("agent1", ...) among the ones that exist. */
export function lightName(have: Iterable<string>): string {
  const taken = new Set(have);
  for (let n = 1; n < 1000; n++) if (!taken.has(`agent${n}`)) return `agent${n}`;
  throw new Error('no free light folder id');
}

/** Folders a repository scan never enters: build output and caches, never a checkout of their own. */
const SKIP = new Set(['node_modules', 'target', 'Library', '.cargo', '.rustup', 'dist', 'build']);

/** The git repositories in `dir` (its own `.git`, a `.git` file of a worktree, or a bare `*.git`), at most `depth` levels down. */
export function reposIn(dir: string, depth = 3): string[] {
  const out: string[] = [];
  const walk = (d: string, left: number) => {
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    if (names.some((n) => n.name === '.git')) {
      out.push(d);
      return;
    }
    if (left <= 0) return;
    for (const n of names) if (n.isDirectory() && !n.isSymbolicLink() && !SKIP.has(n.name)) walk(path.join(d, n.name), left - 1);
  };
  walk(dir, depth);
  return out;
}

export type GitRun = (cwd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
const realGit: GitRun = (cwd, args) => run('git', ['-C', cwd, ...args], { timeoutMs: 60_000 });

/**
 * What in `dir` its remotes lack, one line per repository, or [] when nothing: uncommitted or untracked files, commits no
 * remote branch has, a stash. A repository git cannot read counts as holding work (a delete then refuses).
 */
export async function unsavedWork(dir: string, git: GitRun = realGit): Promise<string[]> {
  const lines: string[] = [];
  for (const repo of reposIn(dir)) {
    const rel = path.relative(dir, repo) || '.';
    const status = await git(repo, ['status', '--porcelain', '--untracked-files=normal']);
    if (status.code !== 0) {
      lines.push(`${rel}: git could not read it (${(status.stderr || status.stdout).trim().split('\n')[0] || `exit ${status.code}`})`);
      continue;
    }
    const why: string[] = [];
    const changed = status.stdout.split('\n').filter((l) => l.trim()).length;
    if (changed) why.push(`${changed} uncommitted or untracked file(s)`);
    const ahead = await git(repo, ['log', '--branches', '--not', '--remotes', '--oneline']);
    const n = ahead.code === 0 ? ahead.stdout.split('\n').filter((l) => l.trim()).length : -1;
    if (n < 0) why.push('its unpushed commits could not be read');
    else if (n) why.push(`${n} commit(s) on no remote branch`);
    const stash = await git(repo, ['stash', 'list']);
    if (stash.code === 0 && stash.stdout.trim()) why.push(`${stash.stdout.trim().split('\n').length} stash entr(ies)`);
    if (why.length) lines.push(`${rel}: ${why.join(', ')}`);
  }
  return lines;
}

export class LightFolders {
  private readonly deleting = new Set<string>();

  private readonly o: { root: () => string | undefined; git?: GitRun; onChange?: () => void };

  constructor(o: { root: () => string | undefined; git?: GitRun; onChange?: () => void }) {
    this.o = o;
  }

  /** `<sandbox_root>/agent-work`, or undefined on a machine without sandboxes. */
  dir(): string | undefined {
    const r = this.o.root();
    return r ? path.join(r, LIGHT_DIR) : undefined;
  }

  pathOf(id: string): string | undefined {
    const d = this.dir();
    return d && isLightId(id) ? path.join(d, id) : undefined;
  }

  /** Every light folder on disk, as the portal sees sandboxes (kind "light": no branch, no editor, never git status). */
  list(): DaemonSandbox[] {
    const d = this.dir();
    if (!d) return [];
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return [];
    }
    return names
      .filter((n) => n.isDirectory() && isLightId(n.name))
      .map((n) => {
        const p = path.join(d, n.name);
        let createdAt = new Date(0).toISOString();
        try {
          const st = fs.statSync(p);
          createdAt = (st.birthtimeMs > 0 ? st.birthtime : st.mtime).toISOString();
        } catch {
          /* listed a moment ago */
        }
        const deleting = this.deleting.has(n.name);
        return { id: n.name, kind: 'light' as const, branch: '', base: '', path: p, createdAt, status: deleting ? ('deleting' as const) : ('ready' as const), unity: { state: 'stopped' as const } };
      })
      .sort((a, b) => Number(a.id.slice(5)) - Number(b.id.slice(5)));
  }

  has(id: string): boolean {
    return this.list().some((s) => s.id === id);
  }

  /** Make a light folder (an empty folder; nothing else). Idempotent: one that exists is kept as it is. */
  create(id: string): string {
    const p = this.pathOf(id);
    if (!p) throw new Error(this.dir() ? `"${id}" is not a light folder id (agent1, agent2, ...)` : 'this machine has no sandbox_root, so no light folders');
    const had = fs.existsSync(p);
    fs.mkdirSync(p, { recursive: true });
    this.o.onChange?.();
    return had ? `Light folder ${id} at ${p} is there already; kept as it is.` : `Made light folder ${id} at ${p}.`;
  }

  /**
   * Delete a light folder, unless a repository in it holds work its remote lacks (then nothing is deleted and the refusal
   * says what): `force` deletes anyway, for a person's word only.
   */
  async remove(id: string, force = false): Promise<string> {
    const p = this.pathOf(id);
    if (!p || !fs.existsSync(p)) return `no light folder ${id}; nothing to delete`;
    if (this.deleting.has(id)) return `light folder ${id} is being deleted already`;
    const unsaved = force ? [] : await unsavedWork(p, this.o.git);
    if (unsaved.length) throw new Error(`delete refused: light folder ${id} holds work its remotes lack (${unsaved.join('; ')}); nothing was deleted`);
    this.deleting.add(id);
    this.o.onChange?.();
    try {
      const r = await removeTree(p);
      if (fs.existsSync(p)) throw new Error(`could not delete ${p}: ${(r.stderr || r.stdout).trim().split('\n')[0] || `exit ${r.code}`}`);
      return `Deleted light folder ${id} (${p}).`;
    } finally {
      this.deleting.delete(id);
      this.o.onChange?.();
    }
  }
}
