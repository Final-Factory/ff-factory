/**
 * Which remotes the daemon pushes to and fetches from in a checkout a worker writes (w6099, from w6091's review of #1367).
 *
 * `origin` is whatever the checkout's own config says, and safeGit pins and scans neither `remote.<name>.url` nor
 * `remote.<name>.pushurl` (an origin's URL is always set at repository scope, so a scan cannot tell a planted one apart). A
 * worker who points origin, or its push URL, at a bare repository on the disk makes the daemon's push start that
 * repository's git-receive-pack, and git unsets GIT_CONFIG_COUNT for a local transport's other end (measured, git 2.56.1,
 * GIT_TRACE: `unset GIT_CONFIG_COUNT GIT_PREFIX; 'git-receive-pack ...'`), so its hooks and config run in the daemon's
 * process with none of safeGit's fence; a fetch starts its git-upload-pack the same way. Every sandbox's origin is a GitHub
 * repository, so each URL must be one, over https or ssh.
 *
 * Enforced (REMOTE_GUARD): #1371 shipped it warn-only, and no daemon log on BEAST showed a checkout it would refuse. A refused
 * save still commits and only skips the push; a refused switch or rescue push changes nothing. A refused checkout recovers
 * by itself: its worker sets origin back with the `git remote set-url` the message names; setting REMOTE_GUARD back to
 * 'warn' (a portal deploy) turns it back to logging only.
 */
import { githubKey } from './memoryGit.ts';

/** 'warn': log what would be refused and go on; 'enforce': refuse it. */
export const REMOTE_GUARD: 'warn' | 'enforce' = 'enforce';

/**
 * A URL with anything that may carry a token taken out, so a message never does: the user name and password up to the
 * last `@` before the path (`https://a@b@host/`, scp's `tok@host:path`), and any query or fragment.
 */
export function redact(url: string): string {
  const m = /^([a-z][\w+.-]*:\/\/)?([^/]*)(.*)$/is.exec(url.trim().replace(/[?#].*$/s, ''))!;
  return `${m[1] ?? ''}${m[2].slice(m[2].lastIndexOf('@') + 1)}${m[3]}`;
}

/**
 * Set by the tests' preload (scripts/testEnv.ts) only: their checkouts push to bare repositories in a temp folder, which
 * the guard would refuse; remoteGuard.test.ts turns it off to test the guard itself. Nothing a worker writes reaches the
 * daemon's globals.
 */
const testLocalRemotes = () => (globalThis as { ffTestLocalRemotes?: boolean }).ffTestLocalRemotes === true;

/** Whether the daemon may push to or fetch from `url`: a GitHub repository over https or ssh. */
export const allowedRemote = (url: string) => (!!githubKey(url) && !/^http:/i.test(url.trim())) || (testLocalRemotes() && !/^[a-z][\w+.-]*::/i.test(url.trim()));

/**
 * Why `remote`'s URLs (fetch and push, `git remote get-url --all` and `--push --all`, insteadOf applied) are not ones the
 * daemon uses, or undefined. `fetchOut`/`pushOut` are those calls' stdout, or undefined when the call failed.
 */
export function remoteProblem(remote: string, fetchOut: string | undefined, pushOut: string | undefined, allowed = allowedRemote, remotes?: string): string | undefined {
  const fix = `set it with \`git remote set-url ${remote} <its GitHub URL>\``;
  // With no remote of that name, git takes `origin` for a path: a folder of that name in the checkout.
  if (remotes !== undefined && !remotes.split('\n').some((r) => r.trim() === remote))
    return `the checkout has no remote named ${remote}, so git would take "${remote}" for a folder in it (w6099); add it with \`git remote add ${remote} <its GitHub URL>\``;
  if (fetchOut === undefined || pushOut === undefined) return `could not read ${remote}'s URL (w6099); look at it with \`git remote -v\` and ${fix}`;
  const urls = [...new Set([...fetchOut.split('\n'), ...pushOut.split('\n')].map((u) => u.trim()).filter(Boolean))];
  if (!urls.length) return `${remote} has no URL`;
  const bad = urls.filter((u) => !allowed(u));
  if (!bad.length) return undefined;
  return `${remote} points at ${bad.map(redact).join(', ')}, not a GitHub repository over https or ssh (w6099): a push or fetch there would run that repository's own programs; ${fix} (and \`git config --unset-all remote.${remote}.pushurl\`)`;
}

/** What a check found: undefined to go on, else the refusal; in warn-only mode the problem is logged and the call goes on. */
function verdict(problem: string | undefined, what: string): string | undefined {
  if (!problem) return undefined;
  if (REMOTE_GUARD === 'warn') {
    console.warn(`remote guard (w6099, warn-only): would refuse ${what}: ${problem}`);
    return undefined;
  }
  return `refused by FF Factory: ${problem}`;
}

const getUrl = (remote: string, push: boolean) => ['remote', 'get-url', ...(push ? ['--push'] : []), '--all', remote];

/**
 * The check before a push or fetch of `remote` in a checkout. `read` runs `git <args>` there and gives its stdout, or
 * undefined when it failed; `what` names the call and the checkout for the log.
 */
export async function guardRemote(read: (args: string[]) => Promise<string | undefined>, what: string, remote = 'origin', allowed = allowedRemote): Promise<string | undefined> {
  const remotes = await read(['remote']);
  return verdict(remoteProblem(remote, await read(getUrl(remote, false)), await read(getUrl(remote, true)), allowed, remotes), what);
}

/** guardRemote for a synchronous git. */
export function guardRemoteSync(read: (args: string[]) => string | undefined, what: string, remote = 'origin', allowed = allowedRemote): string | undefined {
  const remotes = read(['remote']);
  return verdict(remoteProblem(remote, read(getUrl(remote, false)), read(getUrl(remote, true)), allowed, remotes), what);
}
