import { execFile, execFileSync } from 'node:child_process';

/**
 * Which GitHub repos are public, and the git settings that make agents commit with the public identity in every
 * clone (w3093). Used by the guard's identity rule (any repo GitHub reports as public, not only
 * the configured ones) on the host and on the machines, and by the worker launch (docs/machines.md).
 */

type Run = (cmd: string, args: string[]) => string | undefined;

const runSync: Run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  } catch {
    return undefined;
  }
};

const HOUR = 3_600_000;
const visibility = new Map<string, { isPublic: boolean | undefined; at: number }>();

/**
 * Whether a repo ("github.com/owner/name") is public: `gh api repos/<owner>/<name>` (.private), else an
 * anonymous request to the GitHub API (200: anyone can see it). Cached: public for a day, private for an
 * hour, unknown for 5 minutes. undefined when neither could tell.
 */
export function repoIsPublic(key: string, now = Date.now(), run: Run = runSync): boolean | undefined {
  const m = /^github\.com\/([\w.-]+)\/([\w.-]+)$/i.exec(key);
  if (!m) return undefined;
  const hit = visibility.get(key.toLowerCase());
  if (hit && now - hit.at < (hit.isPublic ? 24 * HOUR : hit.isPublic === false ? HOUR : 5 * 60_000)) return hit.isPublic;
  let isPublic: boolean | undefined;
  const gh = run('gh', ['api', `repos/${m[1]}/${m[2]}`, '--jq', '.private'])?.trim();
  if (gh === 'false') isPublic = true;
  else if (gh === 'true') isPublic = false;
  else {
    const code = run('curl', ['-s', '-o', process.platform === 'win32' ? 'NUL' : '/dev/null', '-w', '%{http_code}', '--max-time', '8', `https://api.github.com/repos/${m[1]}/${m[2]}`])?.trim();
    if (code === '200') isPublic = true;
    else if (code === '404') isPublic = false;
  }
  visibility.set(key.toLowerCase(), { isPublic, at: now });
  return isPublic;
}

/** Forget cached answers (tests). */
export function clearVisibilityCache() {
  visibility.clear();
  owned.clear();
}

const owned = new Map<string, { repos: string[]; at: number; refreshing?: boolean }>();

/**
 * The public repos ("owner/name") of these GitHub owners, from `gh repo list --visibility public`. Returns
 * what is cached at once (empty the first time) and refreshes in the background every hour, so a launch
 * never waits on GitHub.
 */
export function publicReposOf(owners: string[], now = Date.now()): string[] {
  const out: string[] = [];
  for (const o of new Set(owners.map((x) => x.toLowerCase()))) {
    const hit = owned.get(o);
    if (hit) out.push(...hit.repos);
    if (hit?.refreshing || (hit && now - hit.at < HOUR)) continue;
    const entry = { repos: hit?.repos ?? [], at: hit?.at ?? 0, refreshing: true };
    owned.set(o, entry);
    execFile('gh', ['repo', 'list', o, '--visibility', 'public', '--limit', '500', '--json', 'nameWithOwner', '--jq', '.[].nameWithOwner'], { timeout: 30_000, windowsHide: true }, (err, stdout) => {
      entry.refreshing = false;
      if (err) return; // try again on the next launch
      entry.repos = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      entry.at = Date.now();
      for (const r of entry.repos) visibility.set(`github.com/${r}`.toLowerCase(), { isPublic: true, at: entry.at });
    });
  }
  return [...new Set(out)];
}

/** "owner/name" of a GitHub URL or key, or undefined. */
export function githubSlug(url: string): string | undefined {
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/**
 * Environment that makes git commit as `identity` in every repository an agent touches (w3093): command-scope config
 * (GIT_CONFIG_COUNT) `user.name` and `user.email`, which outrank the machine's global identity and a clone's own
 * user.name/user.email, so a fresh clone in a temp folder (ffu, a tool repo) commits as the noreply address too and
 * GitHub's email-privacy rule ("push declines due to email privacy restrictions") never refuses the push. Nobody's
 * gitconfig changes; only the agent's processes see it, and `git -c` or `--author` still win where a worker means them.
 * Appended after the entries already in `baseEnv`. Needs git 2.31+ (GIT_CONFIG_COUNT).
 */
export function gitIdentityEnv(identity: { name: string; email: string }, baseEnv: NodeJS.ProcessEnv = {}): Record<string, string> {
  if (!identity.name || !identity.email) return {};
  const n = Number(baseEnv.GIT_CONFIG_COUNT ?? 0) || 0;
  return {
    [`GIT_CONFIG_KEY_${n}`]: 'user.name',
    [`GIT_CONFIG_VALUE_${n}`]: identity.name,
    [`GIT_CONFIG_KEY_${n + 1}`]: 'user.email',
    [`GIT_CONFIG_VALUE_${n + 1}`]: identity.email,
    GIT_CONFIG_COUNT: String(n + 2),
  };
}

/**
 * The identity workers and standing agents commit with (gitIdentityEnv), and the public repos the guard holds to it: the
 * configured ones plus every public repo of their owners, the game repo's owner and the gh account (cached, refreshed in
 * the background). The name and email default to the gh account's noreply address.
 */
export function workerGitIdentity(pub: { repos: string[]; name?: string; email?: string }, gameRepoUrl: string): { name: string; email: string; repos: string[] } | undefined {
  const me = ghNoreply();
  const email = pub.email ?? me?.email;
  const name = pub.name ?? me?.login;
  if (!email || !name) return undefined;
  const listed = pub.repos.map(githubSlug).filter((x): x is string => !!x);
  const owners = [...listed, githubSlug(gameRepoUrl) ?? ''].map((s) => s.split('/')[0]).concat(me ? [me.login] : []).filter(Boolean);
  return { name, email, repos: [...new Set([...listed, ...publicReposOf(owners)])] };
}

let me: { login: string; id: number; at: number } | undefined;
let meRefreshing = false;

/** The gh account's login and noreply email ("<id>+<login>@users.noreply.github.com"), cached; refreshed in the background. */
export function ghNoreply(now = Date.now()): { login: string; email: string } | undefined {
  if (!meRefreshing && (!me || now - me.at > 24 * HOUR)) {
    meRefreshing = true;
    execFile('gh', ['api', 'user', '--jq', '.id, .login'], { timeout: 30_000, windowsHide: true }, (err, stdout) => {
      meRefreshing = false;
      const m = /^(\d+)\s+(\S+)/.exec(stdout?.trim() ?? '');
      if (!err && m) me = { id: Number(m[1]), login: m[2], at: Date.now() };
    });
  }
  return me ? { login: me.login, email: `${me.id}+${me.login}@users.noreply.github.com` } : undefined;
}
