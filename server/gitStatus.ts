import { run } from './proc.ts';
import type { GitStatus } from '../shared/types.ts';
import type { Store } from './store.ts';

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GH_PROMPT_DISABLED: '1' };

/** Parse `git status --porcelain=v2 --branch`: branch, upstream, ahead/behind, changed files. Exported for tests. */
export function parseStatus(out: string): Pick<GitStatus, 'branch' | 'upstream' | 'ahead' | 'behind' | 'dirty' | 'untracked'> {
  const lines = out.split('\n');
  const head = lines.find((l) => l.startsWith('# branch.head '))?.slice(14).trim() ?? '?';
  const upstream = lines.find((l) => l.startsWith('# branch.upstream '))?.slice(18).trim();
  const ab = /^# branch\.ab \+(\d+) -(\d+)/m.exec(out);
  const files = lines.filter((l) => l && !l.startsWith('#'));
  return {
    branch: head === '(detached)' ? 'detached HEAD' : head,
    upstream,
    ahead: ab ? Number(ab[1]) : undefined,
    behind: ab ? Number(ab[2]) : undefined,
    dirty: files.filter((l) => !l.startsWith('?')).length,
    untracked: files.filter((l) => l.startsWith('?')).length,
  };
}

/** The real state of a working tree, read from git (not the branch it was created on). */
export async function readGitStatus(dir: string): Promise<GitStatus | undefined> {
  const [st, log] = await Promise.all([
    run('git', ['-C', dir, 'status', '--porcelain=v2', '--branch'], { timeoutMs: 30_000, env: ENV }),
    run('git', ['-C', dir, 'log', '-1', '--format=%h%x1f%s%x1f%cI'], { timeoutMs: 15_000, env: ENV }),
  ]);
  if (st.code !== 0) return undefined;
  const [sha, subject, date] = log.stdout.trim().split('\x1f');
  return { ...parseStatus(st.stdout), head: sha ? { sha, subject: subject ?? '', date: date ?? '' } : undefined, at: new Date().toISOString() };
}

const prCache = new Map<string, { at: number; pr: GitStatus['pr'] | null }>();

/**
 * The open PR whose head is `branch`, via gh (cached 5 minutes per repo+branch). Undefined when there is
 * none, gh is missing or not logged in, or the branch is a shared one.
 */
export async function openPr(where: { cwd?: string; repo?: string }, branch: string): Promise<GitStatus['pr']> {
  if (!branch || /^(develop|master|main|detached HEAD|\?)$/.test(branch)) return undefined;
  const repo = where.repo ?? (where.cwd ? (await run('git', ['-C', where.cwd, 'remote', 'get-url', 'origin'], { timeoutMs: 10_000, env: ENV })).stdout.trim() : '');
  if (!repo) return undefined;
  const key = `${repo}#${branch}`;
  const hit = prCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.pr ?? undefined;
  const r = await run('gh', ['pr', 'list', '-R', repo.replace(/\.git$/, ''), '--head', branch, '--state', 'open', '--json', 'number,url,title,isDraft', '--limit', '1'], { timeoutMs: 20_000, env: ENV });
  let pr: GitStatus['pr'] | null = null;
  if (r.code === 0) {
    try {
      const [p] = JSON.parse(r.stdout) as { number: number; url: string; title: string; isDraft: boolean }[];
      if (p) pr = { number: p.number, url: p.url, title: p.title, draft: p.isDraft };
    } catch {
      // gh printed something else; treat as no PR
    }
  }
  prCache.set(key, { at: Date.now(), pr });
  return pr ?? undefined;
}

const gitBusy = new Set<string>();

/** Read a sandbox's git state (and PR) into its record; emits only when something changed. */
export async function refreshSandboxGit(store: Store, id: string) {
  const sb = store.sandboxes.get(id);
  if (!sb || sb.status !== 'ready' || gitBusy.has(id)) return;
  gitBusy.add(id);
  try {
    const g = await readGitStatus(sb.path);
    if (!g) return;
    g.pr = await openPr({ cwd: sb.path }, g.branch);
    const cur = store.sandboxes.get(id);
    if (!cur) return;
    const same = cur.git && JSON.stringify({ ...cur.git, at: '' }) === JSON.stringify({ ...g, at: '' });
    cur.git = g;
    if (!same) store.putSandbox(cur);
  } finally {
    gitBusy.delete(id);
  }
}

/** One line for the orchestrator: "on 098-belts (was sandbox/x), 3 uncommitted, ↑2 ↓0, last abc123 'Fix…', PR #41". */
export function describeGit(g: GitStatus | undefined, createdBranch?: string): string {
  if (!g) return 'git: unknown';
  const parts = [`on ${g.branch}${createdBranch && createdBranch !== g.branch ? ` (created on ${createdBranch})` : ''}`];
  parts.push(g.dirty || g.untracked ? `${g.dirty} changed, ${g.untracked} untracked` : 'clean');
  if (g.upstream) parts.push(`↑${g.ahead ?? 0} ↓${g.behind ?? 0} vs ${g.upstream}`);
  else parts.push('no upstream');
  if (g.head) parts.push(`last ${g.head.sha} "${g.head.subject.slice(0, 80)}"`);
  if (g.pr) parts.push(`PR #${g.pr.number}${g.pr.draft ? ' (draft)' : ''} ${g.pr.url}`);
  return `git: ${parts.join('; ')}`;
}
