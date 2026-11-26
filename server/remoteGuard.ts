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
 * Warn-only for now (REMOTE_GUARD): the daemon logs what it would refuse and goes on; enforcing it is a separate PR, once
 * the logs show no real checkout trips it. A refused checkout recovers by itself: its worker sets origin back with the
 * `git remote set-url` the message names; reverting the enforce PR (a portal deploy) turns it back to warn-only.
 */
import { githubKey } from './memoryGit.ts';

/** 'warn': log what would be refused and go on; 'enforce': refuse it. */
export const REMOTE_GUARD: 'warn' | 'enforce' = 'warn';

/** A URL with any user name or password taken out, so a message never carries a token. */
export function redact(url: string): string {
  return url.replace(/^([a-z][\w+.-]*:\/\/)[^@/]*@/i, '$1');
}

/** Whether the daemon may push to or fetch from `url`: a GitHub repository over https or ssh. */
export const allowedRemote = (url: string) => !!githubKey(url) && !/^http:/i.test(url.trim());

/**
 * Why `remote`'s URLs (fetch and push, `git remote get-url --all` and `--push --all`, insteadOf applied) are not ones the
 * daemon uses, or undefined. `fetchOut`/`pushOut` are those calls' stdout, or undefined when the call failed.
 */
export function remoteProblem(remote: string, fetchOut: string | undefined, pushOut: string | undefined, allowed = allowedRemote): string | undefined {
  if (fetchOut === undefined || pushOut === undefined) return `could not read ${remote}'s URL`;
  const urls = [...new Set([...fetchOut.split('\n'), ...pushOut.split('\n')].map((u) => u.trim()).filter(Boolean))];
  if (!urls.length) return `${remote} has no URL`;
  const bad = urls.filter((u) => !allowed(u));
  if (!bad.length) return undefined;
  return `${remote} points at ${bad.map(redact).join(', ')}, not a GitHub repository over https or ssh (w6099): a push or fetch there would run that repository's own programs; set it back with \`git remote set-url ${remote} <its GitHub URL>\` (and \`git config --unset-all remote.${remote}.pushurl\`)`;
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
  return verdict(remoteProblem(remote, await read(getUrl(remote, false)), await read(getUrl(remote, true)), allowed), what);
}

/** guardRemote for a synchronous git. */
export function guardRemoteSync(read: (args: string[]) => string | undefined, what: string, remote = 'origin', allowed = allowedRemote): string | undefined {
  return verdict(remoteProblem(remote, read(getUrl(remote, false)), read(getUrl(remote, true)), allowed), what);
}
