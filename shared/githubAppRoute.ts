// Which GitHub App installation token answers for a repository (w1519, docs/github-apps.md): the portal's gh calls
// (server/githubTokens.ts), and a worker's git and gh on the machines (machine/ghApp.ts). Pure functions; nothing is logged.

/** One installation token as the portal hands it to a machine's daemon (gh_app_tokens) and the daemon keeps it in its file. */
export interface GhAppToken {
  /** The vault entry of the app ("app-gherik"): a run uses only the apps named in its FF_GH_APP_NAMES. */
  app: string;
  /** The repositories the installation covers, "owner/name" in lower case. */
  repos: string[];
  /** Accounts whose every repository it covers (an installation on "All repositories"), lower case. */
  owners: string[];
  token: string;
  /** ISO. A token this close to its end is not used (the portal sends a new one well before). */
  expiresAt: string;
}

/** A token is not used in its last minute: a push may take that long. */
export const APP_TOKEN_MARGIN_MS = 60_000;

/** "owner/name" in lower case, from "owner/name", "owner/name.git", "/owner/name/" or a longer path; undefined otherwise. */
export function repoKey(p: string | undefined): string | undefined {
  const m = /^\/?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?(?:\/.*)?$/.exec(p?.trim() ?? '');
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : undefined;
}

/** The repository a github.com URL names (https, ssh or scp form, "github.com/owner/name"); undefined for another host. */
export function repoOfUrl(url: string | undefined): string | undefined {
  const m = /(?:^|[/@])github\.com[:/]+([^?#\s]+)/i.exec(url?.trim() ?? '');
  return m ? repoKey(m[1]) : undefined;
}

/** gh subcommands of `gh repo` whose first positional argument is a repository ("gh repo clone owner/name"). */
const REPO_FIRST = /^(?:clone|view|fork|sync|edit|delete|archive|unarchive|rename|set-default)$/;

/** "github.com/owner/name" or "HOST/owner/name" as gh takes it: the last two parts. */
function stripHost(v: string | undefined): string | undefined {
  if (!v) return v;
  const parts = v.replace(/\.git$/, '').split('/').filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('/') : v;
}

/**
 * The repository a gh command line acts on, when it says so: -R/--repo, a github.com URL among its arguments, a REST path
 * "repos/owner/name/…" of `gh api`, or `gh repo <verb> owner/name`; else GH_REPO. Undefined when only the folder's git
 * remotes could say (the caller looks there: gitRemoteRepo).
 */
export function ghRepoOf(args: readonly string[], env: Record<string, string | undefined> = {}): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-R' || a === '--repo') return repoKey(stripHost(args[i + 1]));
    const eq = /^(?:--repo=|-R)(.+)$/.exec(a);
    if (eq) return repoKey(stripHost(eq[1]));
  }
  for (const a of args) {
    const u = /github\.com/i.test(a) ? repoOfUrl(a) : undefined;
    if (u) return u;
  }
  const pos = args.filter((a) => !a.startsWith('-'));
  if (pos[0] === 'api') {
    const p = pos.slice(1).find((x) => /^\/?repos\//.test(x));
    if (p) return repoKey(p.replace(/^\/?repos\//, '').split('?')[0]);
  }
  if (pos[0] === 'repo' && pos[1] && REPO_FIRST.test(pos[1]) && pos[2]) return repoKey(stripHost(pos[2]));
  return env.GH_REPO ? repoKey(stripHost(env.GH_REPO)) : undefined;
}

/**
 * The repository gh picks from a folder's remotes, given `git config --get-regexp ^remote\..*\.url$` output: a remote named
 * upstream first, then github, then origin (sourced: cli/cli context/remote.go, remoteNameSortScore); else the first listed.
 */
export function gitRemoteRepo(configLines: string): string | undefined {
  const remotes = configLines
    .split(/\r?\n/)
    .map((l) => /^remote\.(.+)\.url\s+(\S+)/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ name: m[1], repo: repoOfUrl(m[2]) }))
    .filter((r) => r.repo);
  const score = (n: string) => (n === 'upstream' ? 3 : n === 'github' ? 2 : n === 'origin' ? 1 : 0);
  return [...remotes].sort((a, b) => score(b.name) - score(a.name))[0]?.repo;
}

/**
 * The app token for `repo` among `tokens`: one whose installation covers it (by repository, or by account for "All
 * repositories"), of an app the run may use (`apps`: its FF_GH_APP_NAMES), not in its last minute. Undefined: the run's
 * own credential (the person's GH_TOKEN) answers, as for every other repository.
 */
export function appTokenFor(tokens: readonly GhAppToken[], repo: string | undefined, apps: readonly string[], now: number): GhAppToken | undefined {
  if (!repo) return undefined;
  const r = repo.toLowerCase();
  const owner = r.split('/')[0];
  return tokens.find((t) => apps.includes(t.app) && Date.parse(t.expiresAt) - now > APP_TOKEN_MARGIN_MS && (t.repos.includes(r) || t.owners.includes(owner)));
}

/** FF_GH_APP_NAMES ("a,b") as a list: empty when unset (the run uses no app). */
export const appNamesOf = (v: string | undefined) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);
