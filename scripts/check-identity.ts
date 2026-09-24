/**
 * CI: fail when a commit about to land carries an author or committer email that is not a GitHub
 * noreply address. The repo is public, so a personal email in a commit is published for good.
 *
 *   node scripts/check-identity.ts <rev-range>     e.g. origin/main..HEAD, or a single SHA
 *
 * Allowed: <id>+<login>@users.noreply.github.com (and <login>@users.noreply...), plus GitHub's own
 * noreply@github.com, which commits merges and edits made on github.com.
 */
import { execFileSync } from 'node:child_process';
import { isNoreplyEmail } from '../server/guard.ts';

export interface CommitIdentity {
  sha: string;
  author: string;
  committer: string;
  subject: string;
}

export const isPublicEmail = (email: string) => isNoreplyEmail(email) || email.trim().toLowerCase() === 'noreply@github.com';

/** Parse `git log --format=%H%x1f%ae%x1f%ce%x1f%s` output. */
export function parseLog(out: string): CommitIdentity[] {
  return out
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      const [sha, author, committer, subject] = l.split('\x1f');
      return { sha, author, committer, subject: subject ?? '' };
    });
}

/** The commits whose author or committer email is not public, with a line each saying why. */
export function offenders(commits: CommitIdentity[]): string[] {
  const out: string[] = [];
  for (const c of commits) {
    const bad = [c.author, c.committer].filter((e, i, a) => !isPublicEmail(e) && a.indexOf(e) === i);
    if (bad.length) out.push(`${c.sha.slice(0, 9)} ${c.subject.slice(0, 60)}: ${bad.join(', ')}`);
  }
  return out;
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  const range = process.argv[2];
  if (!range) {
    console.error('usage: node scripts/check-identity.ts <rev-range>');
    process.exit(2);
  }
  const log = execFileSync('git', ['log', '--format=%H%x1f%ae%x1f%ce%x1f%s', range], { encoding: 'utf8' });
  const commits = parseLog(log);
  const bad = offenders(commits);
  if (bad.length) {
    console.error(`::error::${bad.length} commit(s) carry a non-noreply email. This repo is public; rewrite them with your GitHub noreply address (Settings > Emails) before merging:`);
    for (const b of bad) console.error(`  ${b}`);
    process.exit(1);
  }
  console.log(`commit identities OK: ${commits.length} commit(s) in ${range}, all noreply`);
}
