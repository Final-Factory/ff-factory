import { run } from './proc.ts';
import { parseStatus } from './gitStatus.ts';

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const SHARED = /^(master|main|develop)$/;

export interface SwitchResult {
  from: string;
  to: string;
  /** What happened, for the caller to show: "pushed 2 commits of x", "created y from origin/develop". */
  notes: string[];
}

async function git(dir: string, args: string[], timeoutMs = 120_000) {
  return run('git', ['-C', dir, ...args], { timeoutMs, env: ENV });
}

async function must(dir: string, args: string[], what: string, timeoutMs?: number) {
  const r = await git(dir, args, timeoutMs);
  if (r.code !== 0) throw new Error(`${what} failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`);
  return r.stdout;
}

/** git's "checked out elsewhere" error, as a plain sentence naming the other worktree. Exported for tests. */
export function explainCheckoutError(stderr: string, branch: string, nameOf: (path: string) => string | undefined = () => undefined): string | undefined {
  const m = /(?:already checked out at|already used by worktree at|is already checked out at)\s+'([^']+)'/.exec(stderr);
  if (!m) return undefined;
  const who = nameOf(m[1]);
  return `Branch ${branch} is checked out in another worktree${who ? ` (${who})` : ''} at ${m[1]}. Switch that one to another branch first; git does not allow one branch in two worktrees.`;
}

/**
 * Switch a working tree to `branch` safely (docs: the switch_branch tool):
 *   - refuse on uncommitted changes to tracked files (untracked files ride along, as git does);
 *   - push the current branch first if it has commits no remote has (never develop/master/main:
 *     those are refused, somebody decides that by hand);
 *   - fetch, then switch to the local branch (fast-forwarding it if it only lags its upstream), or
 *     track origin/<branch>, or create it from `createFrom` (default origin/develop).
 * `lock` wraps the fetch (sandbox worktrees share the base clone's refs).
 */
export async function switchBranch(opts: {
  dir: string;
  branch: string;
  createFrom?: string;
  lock?: <T>(fn: () => Promise<T>) => Promise<T>;
  nameOf?: (path: string) => string | undefined;
}): Promise<SwitchResult> {
  const { dir, branch } = opts;
  const lock = opts.lock ?? (<T>(fn: () => Promise<T>) => fn());
  const notes: string[] = [];
  if ((await git(dir, ['check-ref-format', '--branch', branch])).code !== 0 || branch.startsWith('-')) throw new Error(`"${branch}" is not a valid branch name`);

  const st = parseStatus(await must(dir, ['status', '--porcelain=v2', '--branch'], 'git status'));
  if (st.dirty) {
    const files = (await must(dir, ['status', '--porcelain'], 'git status')).split('\n').filter((l) => l && !l.startsWith('??'));
    throw new Error(`the working tree has ${st.dirty} uncommitted change(s) (${files.slice(0, 5).map((l) => l.slice(3)).join(', ')}${files.length > 5 ? ', …' : ''}). Commit or put them aside first; nothing was switched.`);
  }
  const from = st.branch;
  if (from === branch) return { from, to: branch, notes: [`already on ${branch}`] };

  // Commits on the current branch that no remote has would be stranded: push them first.
  if (from !== 'detached HEAD') {
    const unpushed = Number((await must(dir, ['rev-list', '--count', 'HEAD', '--not', '--remotes'], 'counting unpushed commits')).trim()) || 0;
    if (unpushed > 0) {
      if (SHARED.test(from)) throw new Error(`${from} has ${unpushed} commit(s) that are on no remote. Pushing ${from} is a decision for a person; push or move them yourself, then switch.`);
      await must(dir, ['push', '-u', 'origin', `${from}:${from}`], `pushing ${from}`, 5 * 60_000);
      notes.push(`pushed ${unpushed} unpushed commit(s) of ${from} first`);
    }
  }

  await lock(() => must(dir, ['fetch', '--prune', 'origin'], 'git fetch', 5 * 60_000));
  const has = async (ref: string) => (await git(dir, ['show-ref', '--verify', '--quiet', ref])).code === 0;
  let r;
  if (await has(`refs/heads/${branch}`)) {
    r = await git(dir, ['switch', branch]);
    if (r.code === 0) {
      notes.push(`switched to ${branch}`);
      const ff = await git(dir, ['merge', '--ff-only', '@{u}']);
      if (ff.code === 0 && !/Already up to date/i.test(ff.stdout)) notes.push(`fast-forwarded ${branch} to its upstream`);
    }
  } else if (await has(`refs/remotes/origin/${branch}`)) {
    r = await git(dir, ['switch', '-c', branch, '--track', `origin/${branch}`]);
    if (r.code === 0) notes.push(`checked out ${branch} from origin`);
  } else {
    const base = opts.createFrom?.trim() || 'origin/develop';
    if ((await git(dir, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])).code !== 0) throw new Error(`${branch} does not exist here or on origin, and ${base} (to create it from) is not a known commit`);
    r = await git(dir, ['switch', '-c', branch, '--no-track', base]);
    if (r.code === 0) notes.push(`created ${branch} from ${base}`);
  }
  if (r.code !== 0) {
    throw new Error(explainCheckoutError(r.stderr, branch, opts.nameOf) ?? `git switch failed: ${r.stderr.trim().split('\n').slice(-3).join(' ')}`);
  }
  if (st.untracked) notes.push(`${st.untracked} untracked file(s) came along unchanged`);
  return { from, to: branch, notes };
}

/**
 * What a sandbox switch does about the editor (Agents.switchBranch, docs/unity-dialogs.md): its open scenes are
 * parked across the switch only when the bridge says none has unsaved edits, so Unity has nothing to ask. Everything
 * else is refused before git is touched: a switch under an editor whose scenes were not checked is how Unity ends up
 * asking "The open scene(s) have been modified externally". `scenes` is the bridge's answer, or the error it gave.
 */
export function editorSwitchPlan(
  state: string,
  scenes: { playing: boolean; dirty: string[]; scenes: string[] } | Error | undefined,
  discardSceneEdits = false,
): { refuse: string } | { park: boolean; discarded: string[] } {
  const stopFirst = 'or stop it (unity action "stop") and switch with no editor running';
  if (state === 'stopped' || state === 'crashed') return { park: false, discarded: [] };
  if (state !== 'running') return { refuse: `the editor is ${state}, so its open scenes cannot be checked; nothing was switched. Wait until it runs (wait_for_unity "ready"; a "blocked" editor needs its dialog answered first, unity status), ${stopFirst}.` };
  if (!scenes || scenes instanceof Error) return { refuse: `could not check the editor's open scenes over the MCP bridge (${scenes?.message ?? 'no answer'}); nothing was switched. Try again once the editor answers, ${stopFirst}.` };
  if (scenes.playing) return { refuse: 'the editor is in play mode; nothing was switched. Leave play mode first (manage_editor action "stop"), then switch.' };
  if (scenes.dirty.length && !discardSceneEdits) {
    return { refuse: `unsaved scene edits in the editor (${scenes.dirty.join(', ')}); nothing was switched. Save them (manage_scene action "save") and commit them, or call switch_branch again with discard_scene_edits: true to throw them away.` };
  }
  return { park: scenes.scenes.length > 0, discarded: scenes.dirty };
}
