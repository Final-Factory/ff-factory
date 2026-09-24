import path from 'node:path';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { StandingToolGroup } from '../shared/types.ts';

/**
 * The second PreToolUse hook on a standing agent (the first is the workers' sandboxGuard, whose rules
 * apply unchanged). Like that one it is a seatbelt, not a boundary: it keeps a well-meaning agent
 * inside its charter's tool groups (docs/standing-agents.md).
 *
 *   - Write/Edit only inside the agent's own folder.
 *   - Shell (Bash/PowerShell) only with a shell group, and then only allowlisted commands: read-only
 *     git and gh, simple read utilities, and with github_comment the comment-only gh calls. No command
 *     substitution, heredocs or output redirection (they would smuggle in commands or writes the
 *     allowlist cannot see), and no paths into other sandboxes or the base clone.
 */
export function standingGuard(opts: { folder: string; groups: StandingToolGroup[]; offLimits: string[] }): HookCallback {
  const deny = (reason: string) => ({
    hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: reason },
  });
  const own = normPath(opts.folder);
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const tool = input.tool_name;
    const args = (input.tool_input ?? {}) as Record<string, unknown>;
    if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
      const target = String(args.file_path ?? args.notebook_path ?? '');
      const t = normPath(path.isAbsolute(target) || /^[a-zA-Z]:[\\/]/.test(target) ? target : path.join(opts.folder, target));
      if (t !== own && !t.startsWith(own + '/')) return deny(`A standing agent writes only inside its own folder (${opts.folder}); ${target} is outside it.`);
    }
    if (tool === 'Bash' || tool === 'PowerShell') {
      const reason = checkStandingShell(String(args.command ?? ''), { groups: opts.groups, folder: opts.folder, offLimits: opts.offLimits });
      if (reason) return deny(reason);
    }
    return {};
  };
}

/** Lower-case, forward slashes, `..` resolved, no trailing slash; drive-letter paths kept as text so any host OS agrees. */
const normPath = (p: string) =>
  path.posix
    .normalize((/^[a-zA-Z]:[\\/]/.test(p) ? p : path.resolve(p)).replace(/\\/g, '/'))
    .replace(/\/+$/, '')
    .toLowerCase();

// ---- a small shell reader: quote-aware split into simple commands ----

export interface ShellScan {
  /** Each simple command's words, quotes removed. */
  commands: string[][];
  /** Constructs the allowlist cannot judge, found outside single quotes. */
  problems: string[];
}

export function scanShell(cmd: string): ShellScan {
  const commands: string[][] = [];
  const problems = new Set<string>();
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '' | "'" | '"' = '';
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCmd = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const next = cmd[i + 1];
    if (quote === "'") {
      if (c === "'") quote = '';
      else word += c;
      continue;
    }
    if (c === '`') problems.add('backtick command substitution');
    if (c === '$' && next === '(') problems.add('$( ) command substitution');
    if (quote === '"') {
      if (c === '\\' && next !== undefined) {
        word += next;
        i++;
      } else if (c === '"') quote = '';
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
      continue;
    }
    if (c === '\\' && next !== undefined) {
      word += next;
      inWord = true;
      i++;
      continue;
    }
    if (c === '<' && (next === '(' || next === '<')) problems.add(next === '(' ? 'process substitution' : 'heredoc (write the text to a file in your folder with Write, then pass the file)');
    if (c === '>' && next === '(') problems.add('process substitution');
    if (c === '>') {
      // Only discarding output is allowed: 2>&1, >/dev/null, 2>/dev/null, >$null.
      const rest = cmd.slice(i + 1).replace(/^>/, '').trimStart();
      const ok = rest.startsWith('&1') || rest.startsWith('&2') || /^(\/dev\/null|\$null|nul)(\s|$|;|&|\|)/i.test(rest);
      if (!ok) problems.add('output redirection to a file (write files with the Write tool instead)');
      endWord();
      // Skip the redirection target so it is not read as an argument.
      const m = /^>?\s*(&[12]|\/dev\/null|\$null|nul)/i.exec(cmd.slice(i + 1));
      if (m) i += m[0].length;
      continue;
    }
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      endCmd();
      if ((c === '|' || c === '&') && next === c) i++;
      continue;
    }
    if (/\s/.test(c)) {
      endWord();
      continue;
    }
    word += c;
    inWord = true;
  }
  if (quote) problems.add('an unterminated quote');
  endCmd();
  return { commands, problems: [...problems] };
}

// ---- the allowlist ----

const READ_UTILS = new Set([
  'cat', 'head', 'tail', 'grep', 'egrep', 'rg', 'ls', 'dir', 'wc', 'sort', 'uniq', 'jq', 'echo', 'printf', 'find', 'date', 'pwd', 'cd',
  'diff', 'sed', 'cut', 'tr', 'true', 'false', 'test', '[', 'basename', 'dirname', 'realpath', 'sleep', 'mkdir', 'base64', 'column', 'nl', 'file', 'stat',
  'which', 'type', 'du', 'tree', 'sha256sum', 'md5sum', 'fold', 'tac', 'rev', 'comm', 'join', 'paste', 'expand',
]);

const GIT_READ = new Set([
  'log', 'show', 'diff', 'status', 'fetch', 'clone', 'ls-remote', 'rev-parse', 'rev-list', 'cat-file', 'grep', 'blame', 'merge-base', 'ls-files', 'ls-tree',
  'describe', 'shortlog', 'show-ref', 'for-each-ref', 'name-rev', 'range-diff', 'whatchanged', 'version', 'help',
]);

/** gh "<noun> <verb>" pairs that only read. */
const GH_READ = new Set([
  'pr view', 'pr list', 'pr diff', 'pr checks', 'pr status', 'issue view', 'issue list', 'issue status', 'repo view', 'repo list', 'run view', 'run list',
  'release view', 'release list', 'workflow view', 'workflow list', 'label list', 'auth status', 'search prs', 'search issues', 'search code',
  'search commits', 'search repos', 'cache list', 'ruleset view', 'ruleset list', 'gist view', 'gist list',
]);

const GH_COMMENT = new Set(['pr comment', 'issue comment']);

/** gh api endpoints github_comment may POST to: issue/PR comments and reviews. */
const GH_API_COMMENT = /^\/?repos\/[^/]+\/[^/]+\/(issues\/\d+\/comments|pulls\/\d+\/comments|pulls\/\d+\/reviews|pulls\/\d+\/comments\/\d+\/replies)$/;

function checkGit(w: string[]): string | undefined {
  // Skip global options: -C <dir>, -c k=v, --no-pager, …
  let i = 1;
  while (i < w.length && w[i].startsWith('-')) i += w[i] === '-C' || w[i] === '-c' ? 2 : 1;
  const sub = w[i];
  if (!sub) return undefined;
  if (sub === 'branch' || sub === 'tag' || sub === 'remote' || sub === 'config' || sub === 'stash' || sub === 'worktree') {
    const rest = w.slice(i + 1);
    const positional = rest.some((x) => !x.startsWith('-'));
    const listing =
      (sub === 'branch' &&
        !rest.some((x) => /^(-d|-D|--delete|-m|-M|--move|-c|-C|--copy|-f|--force|-u|--set-upstream-to.*|--unset-upstream|--edit-description)$/.test(x)) &&
        (!positional || rest.some((x) => /^(-l|--list|-a|--all|-r|--remotes|--contains|--no-contains|--merged|--no-merged|--points-at)$/.test(x)))) ||
      (sub === 'tag' && (!positional || rest.some((x) => x === '-l' || x === '--list' || x === '--contains'))) ||
      (sub === 'remote' && (rest.length === 0 || rest[0] === '-v' || rest[0] === 'show' || rest[0] === 'get-url')) ||
      (sub === 'config' && rest.some((x) => x === '--get' || x === '--list' || x === '-l' || x === '--get-all' || x === '--get-regexp')) ||
      (sub === 'stash' && rest[0] === 'list') ||
      (sub === 'worktree' && rest[0] === 'list');
    return listing ? undefined : `git ${sub} is only allowed for listing in a standing agent.`;
  }
  if (!GIT_READ.has(sub)) return `git ${sub} changes a repository; a standing agent may only read (log, show, diff, fetch, clone, …).`;
  return undefined;
}

/** Options of `gh api` that take a value. */
const GH_API_VALUE_OPTS = /^(-X|--method|-f|-F|--field|--raw-field|--input|-H|--header|-q|--jq|-t|--template|--hostname|-p|--preview|--cache)$/;

/** The endpoint argument of a `gh api` command: its first positional after "api". */
function ghApiEndpoint(w: string[]): string | undefined {
  for (let i = 2; i < w.length; i++) {
    if (GH_API_VALUE_OPTS.test(w[i])) i++;
    else if (!w[i].startsWith('-')) return w[i];
  }
  return undefined;
}

function checkGh(w: string[], groups: StandingToolGroup[]): string | undefined {
  const comment = groups.includes('github_comment');
  const pair = `${w[1] ?? ''} ${w[2] ?? ''}`;
  if (w[1] === 'api') {
    const lower = w.map((x) => x.toLowerCase());
    const mAt = lower.findIndex((x) => x === '-x' || x === '--method' || x.startsWith('--method='));
    const method = (mAt >= 0 ? (lower[mAt].includes('=') ? lower[mAt].split('=')[1] : lower[mAt + 1]) : undefined)?.toUpperCase();
    const fields = lower.some((x) => /^(-f|-F|--field|--raw-field|--input)$/i.test(x) || /^--(raw-)?field=/.test(x));
    const effective = method ?? (fields ? 'POST' : 'GET');
    if (effective === 'GET') return undefined;
    const endpoint = ghApiEndpoint(w);
    if (comment && effective === 'POST' && endpoint && GH_API_COMMENT.test(endpoint.split('?')[0])) {
      if (lower.some((x) => /approve|request_changes/.test(x))) return 'A standing agent may comment on a review, never approve or request changes.';
      return undefined;
    }
    return comment
      ? 'gh api writes are limited to POSTing issue/PR comments and comment-only reviews.'
      : 'gh api is read-only (GET) for this standing agent; it has no github_comment tool group.';
  }
  if (GH_READ.has(pair)) return undefined;
  if (comment && GH_COMMENT.has(pair)) return undefined;
  if (comment && pair === 'pr review') {
    const lower = w.map((x) => x.toLowerCase());
    if (lower.some((x) => x === '-a' || x === '--approve' || x === '-r' || x === '--request-changes')) return 'A standing agent may leave comment-only reviews, never approve or request changes.';
    if (!lower.some((x) => x === '-c' || x === '--comment')) return 'gh pr review needs --comment in a standing agent.';
    return undefined;
  }
  return comment
    ? `gh ${pair.trim()} is not allowed: a standing agent reads, and comments only with gh pr/issue comment or gh pr review --comment.`
    : `gh ${pair.trim()} is not allowed: this standing agent may only read (gh pr/issue/repo/run view and list, gh api GET).`;
}

/** Why a shell command is refused for a standing agent, or undefined. Exported for tests. */
export function checkStandingShell(cmd: string, ctx: { groups: StandingToolGroup[]; folder: string; offLimits: string[] }): string | undefined {
  if (!ctx.groups.includes('shell_read') && !ctx.groups.includes('github_comment')) {
    return 'This standing agent has no shell tool group; use Read, Glob and Grep.';
  }
  const scan = scanShell(cmd);
  if (scan.problems.length) return `Not allowed in a standing agent's shell: ${scan.problems.join(', ')}.`;
  const own = normPath(ctx.folder);
  const off = ctx.offLimits.map(normPath);
  // Paths are judged on the raw text, so C:\x, C:/x and Git Bash's /c/x all count whatever the shell's escaping.
  const flat = cmd.replace(/\\/g, '/').replace(/(^|[\s'"=])\/([a-zA-Z])\//g, '$1$2:/');
  for (const m of flat.matchAll(/[a-zA-Z]:\/[^\s'"`;|&<>]*/g)) {
    const p = normPath(m[0]);
    if (p === own || p.startsWith(own + '/')) continue;
    if (off.some((o) => p === o || p.startsWith(o + '/'))) return `${m[0]} is another sandbox or the base clone; a standing agent's shell stays out of them (Read and Grep them instead).`;
  }
  for (const w of scan.commands) {
    // Leading VAR=value assignments.
    let k = 0;
    while (k < w.length && /^\w+=/.test(w[k])) k++;
    const words = w.slice(k);
    if (!words.length) continue;
    const exe = words[0].replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.exe$/, '');
    if (exe === 'git') {
      const r = checkGit(words);
      if (r) return r;
      continue;
    }
    if (exe === 'gh') {
      const r = checkGh(words, ctx.groups);
      if (r) return r;
      continue;
    }
    if (READ_UTILS.has(exe)) {
      if (exe === 'sed' && words.some((x) => /^-[a-z]*i/.test(x) || x.startsWith('--in-place'))) return 'sed -i edits files; use the Edit tool inside your folder.';
      if (exe === 'find' && words.some((x) => /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(x))) return 'find may only list files in a standing agent.';
      continue;
    }
    return `"${words[0]}" is not on a standing agent's shell allowlist (read-only git and gh, and read utilities such as cat, grep, ls, jq).`;
  }
  return undefined;
}
