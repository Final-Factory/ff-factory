/**
 * w3257 (ben: "Workers on m5 leave stray placeholder files outside their worker folder: find why, stop it, clean up"): a
 * worker's Write tool may not create a new file outside its own sandbox and its own temp folder.
 *
 * Two m5 workers wrote a probe at a guessed path just before their first use of $TMPDIR (the Write tool takes an absolute
 * path, and they had not yet looked theirs up), ran `echo $TMPDIR`, and wrote to the real folder from then on:
 * 75c467b4 (w3241) Write `/Users/benryding/ffw/sandboxes/slot1/../../../ffw-tmp-placeholder` "x", and 3b978270 (w3249) Write
 * `/Users/benryding/ffw/sandboxes/tmp-pr-body-w3249.md` "placeholder". Neither could delete its file again: the first is
 * outside the worker install folder (server/rootFence.ts checkOutsideRootDelete refuses it), the second is not under its
 * TMPDIR (server/tempDelete.ts sends it to a person). The refusal names the temp folder's path, so the worker's next call
 * goes there.
 *
 * Overwriting a file that exists is not this rule's business (the protected-path check covers that). Left open: the game's
 * data folders (any path through a `Never Games` folder, every OS), the user's Claude Code and Codex folders (plan files),
 * and the ff-agents checkout `~/.claude/final-factory-agents-checkout` names (publish-skills adds lessons there).
 */
import fs from 'node:fs';
import path from 'node:path';

export interface StrayWriteContext {
  /** The worker's sandbox (its worktree). */
  sandbox: string;
  /** The worker's own temp folder (TMPDIR of its shell). */
  temp: string;
  /** The user's home folder. */
  home: string;
  /** Default: fs.existsSync. */
  exists?: (p: string) => boolean;
  /** The ff-agents checkout's path, from the marker publish-skills reads. Default: read `<home>/.claude/final-factory-agents-checkout`. */
  skillsCheckout?: () => string | undefined;
}

/** A path as one comparable string: forward slashes, `.` and `..` resolved, no trailing slash, lower case. */
export function resolvedPath(p: string, cwd: string): string {
  const s = p.replace(/\\/g, '/');
  const abs = /^[a-zA-Z]:\//.test(s) || s.startsWith('/') ? s : `${cwd.replace(/\\/g, '/').replace(/\/+$/, '')}/${s}`;
  return path.posix.normalize(abs).replace(/\/+$/, '').toLowerCase();
}

const inside = (n: string, dir: string) => n === dir || n.startsWith(dir + '/');

const markerCheckout = (home: string) => () => {
  try {
    const line = fs.readFileSync(path.join(home, '.claude', 'final-factory-agents-checkout'), 'utf8').trim();
    return line && !line.includes('\n') ? line : undefined;
  } catch {
    return undefined;
  }
};

/** The refusal for a Write tool call that would create `target` outside the worker's folders, or undefined. */
export function checkStrayWrite(target: string, ctx: StrayWriteContext): string | undefined {
  if (!target || !ctx.temp) return undefined;
  const exists = ctx.exists ?? fs.existsSync;
  if (exists(target)) return undefined;
  const cwd = ctx.sandbox;
  const n = resolvedPath(target, cwd);
  const home = resolvedPath(ctx.home, cwd);
  const temp = resolvedPath(ctx.temp, cwd);
  const open = [resolvedPath(ctx.sandbox, cwd), temp, `${home}/.claude`, `${home}/.codex`];
  const skills = (ctx.skillsCheckout ?? markerCheckout(ctx.home))();
  if (skills) open.push(resolvedPath(skills, cwd));
  if (open.some((d) => inside(n, d)) || /\/never games(?:\/|$)/.test(n)) return undefined;
  const shownTemp = ctx.temp.replace(/\\/g, '/').replace(/\/+$/, '');
  const resolved = n !== target.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() ? ` (that is ${n})` : '';
  return (
    `Refused: this Write would create ${target}${resolved}, a new file outside your sandbox (${ctx.sandbox}) and your temp ` +
    `folder. Your temp folder is ${shownTemp}: write what you make there, e.g. ${shownTemp}/<name> (no probe file and no ` +
    `\`echo $TMPDIR\` needed). A file outside both stays behind where no worker may delete it (w3257).`
  );
}
