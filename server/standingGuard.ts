import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { StandingToolGroup } from '../shared/types.ts';
import { homeSecrets, readProblem, readTargets, realReadFs, type ReadCtx, type SecretRules } from './secretGuard.ts';

/**
 * The second PreToolUse hook on a standing agent (the first is the workers' sandboxGuard, whose rules
 * apply unchanged). Like that one it is a seatbelt, not a boundary: it keeps a well-meaning agent
 * inside its charter's tool groups (docs/standing-agents.md).
 *
 *   - Write/Edit only inside the agent's own folder (its real path), never into a `.git` (w5514).
 *   - Shell (Bash/PowerShell) only with a shell group, and then only allowlisted commands: read-only
 *     git and gh, simple read utilities, and with github_comment the comment-only gh calls. No command
 *     substitution, heredocs or output redirection (they would smuggle in commands or writes the
 *     allowlist cannot see), and no paths into other sandboxes or the base clone.
 */
export function standingGuard(opts: { folder: string; groups: StandingToolGroup[]; offLimits: string[]; secrets?: SecretRules }): HookCallback {
  const deny = (reason: string) => ({
    hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: reason },
  });
  // FF Factory's secrets (w467): the portal's (opts.secrets, from where it runs) and this computer's home secrets.
  const secrets = withHomeSecrets(opts.secrets);
  const ctx: ReadCtx = { platform: process.platform, home: os.homedir(), cwd: opts.folder, fsx: realReadFs };
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const tool = input.tool_name;
    const args = (input.tool_input ?? {}) as Record<string, unknown>;
    for (const t of readTargets(tool, args)) {
      const why = readProblem(t.path, t.kind, secrets, ctx);
      if (why) return deny(why);
    }
    if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
      const why = standingWriteProblem(String(args.file_path ?? args.notebook_path ?? ''), opts.folder, ctx.fsx);
      if (why) return deny(why);
    }
    if (tool === 'Bash' || tool === 'PowerShell') {
      const reason = checkStandingShell(String(args.command ?? ''), { groups: opts.groups, folder: opts.folder, offLimits: opts.offLimits, secrets, read: ctx });
      if (reason) return deny(reason);
    }
    return {};
  };
}

/** A path written as a whole: its deepest existing folder's real path (symlinks resolved) plus the rest of it. */
function realWritePath(abs: string, fsx: Pick<ReadCtx['fsx'], 'realpath'>, hops = 0): string {
  // A drive-letter path judged on another OS (tests, a spec read elsewhere) stays as written.
  if (!path.isAbsolute(abs)) return abs;
  const rest: string[] = [];
  let p = abs;
  for (;;) {
    const real = fsx.realpath(p);
    if (real) return rest.length ? path.join(real, ...rest.reverse()) : real;
    // A symlink to nothing yet (`cfg -> .git/config`): writing it creates its target, so judge the target.
    const link = hops < 8 ? readLink(p) : undefined;
    if (link !== undefined) return realWritePath(path.join(path.resolve(path.dirname(p), link), ...rest.reverse()), fsx, hops + 1);
    const up = path.dirname(p);
    if (up === p) return abs;
    rest.push(path.basename(p));
    p = up;
  }
}

const readLink = (p: string): string | undefined => {
  try {
    return fs.readlinkSync(p);
  } catch {
    return undefined;
  }
};

/**
 * A folder segment git takes as its own metadata (w5514): `.git`, also as Windows and macOS would read it (any case,
 * trailing dots or spaces dropped, the 8.3 short name `GIT~1`).
 */
const GIT_SEGMENT = /^(\.git[. ]*|git~\d+)$/i;

/**
 * Why a standing agent may not Write or Edit `target`, or undefined (w5514). It writes only inside its own folder, judged on
 * the real path, so a symlink a cloned repository checked out (`x -> /etc`, `x -> .git`) cannot carry a write out of the
 * folder or into git's metadata. Nothing under a `.git` segment, nor a `.git` file (a gitfile pointing elsewhere): git
 * runs programs a repository's config names (`core.fsmonitor`, `diff.<driver>.textconv`, `filter.<driver>.clean`,
 * hooks), and only some of those keys can be overridden from the environment (launch.ts standingGitEnv). A folder shaped
 * like a bare repository is left to that environment's `safe.bareRepository=explicit`.
 */
export function standingWriteProblem(target: string, folder: string, fsx: Pick<ReadCtx['fsx'], 'realpath'> = realReadFs): string | undefined {
  const abs = path.isAbsolute(target) || /^[a-zA-Z]:[\\/]/.test(target) ? target : path.join(folder, target);
  // As written, against the folder as written; resolved, against the folder's real path (macOS's /tmp is /private/tmp).
  for (const [t, own] of [
    [normPath(abs), normPath(folder)],
    [normPath(realWritePath(abs, fsx)), normPath(fsx.realpath(folder) ?? folder)],
  ]) {
    if (t !== own && !t.startsWith(own + '/')) return `A standing agent writes only inside its own folder (${folder}); ${target} is outside it.`;
    if (t.slice(own.length).split('/').some((seg) => GIT_SEGMENT.test(seg)))
      return `A standing agent never writes git's own files (.git): a repository's config or hooks can name a program git would run. ${target} is one.`;
  }
  return undefined;
}

/** The rules plus this computer's home secrets (~/.ssh, Claude's and gh's credentials), expanded where the agent runs. */
export const withHomeSecrets = (r: SecretRules | undefined, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): SecretRules => ({
  deny: [...(r?.deny ?? []), ...homeSecrets(env, platform)],
  allow: [...(r?.allow ?? [])],
});

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
  /**
   * Words whose glob or brace expansion could start with "-" (w5504): an unquoted `*`, `?`, `[` or `{` at the start of the
   * word, or anywhere in a word that starts with "-". The shell would turn them into options the allowlist never saw
   * (a file named `--output=x` in the folder, or `{-o,out}`).
   */
  expanding: string[];
}

export function scanShell(cmd: string): ShellScan {
  const commands: string[][] = [];
  const problems = new Set<string>();
  const expanding: string[] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '' | "'" | '"' = '';
  // Where the current word has its first unquoted glob or brace character.
  let globAt = -1;
  const endWord = () => {
    if (inWord) {
      words.push(word);
      const lone = word === '[' || word === ']' || word === '{' || word === '}';
      if (globAt >= 0 && !lone && (globAt === 0 || word.startsWith('-'))) expanding.push(word);
    }
    word = '';
    inWord = false;
    globAt = -1;
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
    // Variable expansion and $'…' quoting (w5504): the shell would hand the command words the allowlist never saw
    // (`X=--output=f; git log $X`, `$IFS` splitting, `$'\x2do'`). Write the value out instead.
    else if (c === '$' && next !== undefined && (/[A-Za-z_{0-9@*#?$!-]/.test(next) || (quote === '' && (next === "'" || next === '"'))))
      problems.add('shell variables and $\'…\' quoting (write the value out)');
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
    if (/[*?[{]/.test(c) && globAt < 0) globAt = word.length;
    word += c;
    inWord = true;
  }
  if (quote) problems.add('an unterminated quote');
  endCmd();
  return { commands, problems: [...problems], expanding };
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

/**
 * The first option among `args` that the tool would read as a refused one, or undefined (w5504). GNU getopt and git's
 * parse-options take any unambiguous prefix of a long option (`--outp=f` is `--output=f`), so a long name that starts a
 * refused one is refused too. Short options may be joined (`-rof` is `-r -o f`); a letter in `valueShort` takes the rest
 * of the word as its value, so the scan of that word stops there. Separate values are not skipped: a value that looks
 * like a refused option is refused, which only ever errs towards refusing.
 */
function refusedOption(args: string[], spec: { long: string[]; short?: string; valueShort?: string; exact?: boolean }): string | undefined {
  for (const a of args) {
    if (a.startsWith('--') && a.length > 2) {
      const name = a.slice(2).split('=')[0].toLowerCase();
      if (spec.long.some((b) => b === name || (!spec.exact && b.startsWith(name)))) return a;
    } else if (a.startsWith('-') && a.length > 1 && spec.short) {
      for (const c of a.slice(1)) {
        if (spec.short.includes(c)) return a;
        if (spec.valueShort?.includes(c)) break;
      }
    }
  }
  return undefined;
}

/**
 * `git -c` keys a standing agent may set: output formatting only. Every other key is refused, since many run a program
 * (core.pager, core.fsmonitor, core.sshCommand, diff.external, alias.*, *.textconv, credential.helper, …).
 */
const GIT_SAFE_CONFIG = /^(color(\.[\w-]+)*|core\.quotepath|core\.abbrev|diff\.renames|diff\.renamelimit|log\.date|log\.decorate|log\.showsignature|grep\.linenumber)$/i;

/** git's global options that only change output or pathspec reading; everything else (--exec-path, --git-dir, --config-env, …) is refused. */
const GIT_SAFE_GLOBAL = new Set(['--no-pager', '-P', '-p', '--paginate', '--no-replace-objects', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks', '--no-lazy-fetch', '--version', '--help']);

/** Long options of git subcommands that run a program or write a file (any prefix of one counts, as git takes abbreviations). */
const GIT_REFUSED_LONG = ['output', 'upload-pack', 'receive-pack', 'exec', 'template', 'config', 'config-env', 'ext-diff', 'open-files-in-pager', 'separate-git-dir', 'web', 'info', 'man'];

/** Joined or separate short options per subcommand that do the same (clone -u <cmd> and -c k=v, grep -O<pager>, help -w/-i/-m). */
const GIT_REFUSED_SHORT: Record<string, { short: string; valueShort: string }> = {
  clone: { short: 'uc', valueShort: 'objj' },
  grep: { short: 'O', valueShort: 'efABCm' },
  help: { short: 'wim', valueShort: '' },
};

function checkGit(w: string[]): string | undefined {
  let i = 1;
  for (; i < w.length && w[i].startsWith('-'); i++) {
    const o = w[i];
    if (o === '-C') {
      i++;
      continue;
    }
    if (o === '-c') {
      const kv = w[++i] ?? '';
      const key = kv.split('=')[0];
      if (!GIT_SAFE_CONFIG.test(key)) return `git -c ${key} is not allowed in a standing agent: only color and output-format keys (many git keys run a program).`;
      continue;
    }
    if (!GIT_SAFE_GLOBAL.has(o)) return `git ${o.split('=')[0]} is not allowed in a standing agent (only -C, -c with an output-format key, --no-pager and pathspec options).`;
  }
  const sub = w[i];
  if (!sub) return undefined;
  const rest = w.slice(i + 1);
  if (sub === 'branch' || sub === 'tag' || sub === 'remote' || sub === 'config' || sub === 'stash' || sub === 'worktree') {
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
    if (!listing) return `git ${sub} is only allowed for listing in a standing agent.`;
    // Listing options that still run something: stash list takes log options, config --show-origin is harmless.
    const bad = refusedOption(rest, { long: ['output', 'ext-diff', 'open-files-in-pager'] });
    return bad ? `git ${sub} ${bad} is not allowed in a standing agent.` : undefined;
  }
  if (!GIT_READ.has(sub)) return `git ${sub} changes a repository; a standing agent may only read (log, show, diff, fetch, clone, …).`;
  const bad = refusedOption(rest, { long: GIT_REFUSED_LONG, ...GIT_REFUSED_SHORT[sub] });
  if (bad) return `git ${sub} ${bad.split('=')[0]} runs a program or writes a file; a standing agent's git only reads.`;
  // Transports that run a command: ext:: (git's own default refuses it, kept refused here whatever the config says) and fd::.
  const url = rest.find((x) => /^(ext|fd)::/i.test(x));
  if (url) return `git ${sub} with an ${url.split('::')[0]}:: remote runs a command; not allowed in a standing agent.`;
  return undefined;
}

/** Long options of `gh api` that take a value (pflag: no abbreviations), and its value-taking short letters. */
const GH_API_VALUE_LONG = new Set(['method', 'field', 'raw-field', 'input', 'header', 'jq', 'template', 'hostname', 'preview', 'cache']);
const GH_API_VALUE_SHORT = 'XfFHqtp';
const GH_API_BOOL_SHORT = 'i';

interface GhApiCall {
  method?: string;
  endpoint?: string;
  fields: string[];
  input: boolean;
  unknown?: string;
}

/** Reads a `gh api` command as pflag would: joined short options (`-iXDELETE`), `--method=X` and `--method X`, the last method wins. */
function parseGhApi(w: string[]): GhApiCall {
  const r: GhApiCall = { fields: [], input: false };
  const take = (name: string, value: string | undefined) => {
    if (name === 'X' || name === 'method') r.method = (value ?? '').toUpperCase();
    else if (name === 'f' || name === 'F' || name === 'field' || name === 'raw-field') r.fields.push(value ?? '');
    else if (name === 'input') r.input = true;
  };
  for (let i = 2; i < w.length; i++) {
    const a = w[i];
    if (a === '--') {
      r.endpoint ??= w[i + 1];
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = a.slice(2, eq < 0 ? undefined : eq);
      if (GH_API_VALUE_LONG.has(name)) take(name, eq < 0 ? w[++i] : a.slice(eq + 1));
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (GH_API_VALUE_SHORT.includes(c)) {
          const v = a.slice(j + 1).replace(/^=/, '');
          take(c, v || w[++i]);
          break;
        }
        if (!GH_API_BOOL_SHORT.includes(c)) {
          r.unknown = a;
          break;
        }
      }
      continue;
    }
    r.endpoint ??= a;
  }
  return r;
}

/** Files a gh command would read and send: `-F key=@file` on gh api, `--body-file file` / `-F file` on comment commands. */
function ghReadFiles(w: string[]): string[] {
  if (w[1] === 'api') return parseGhApi(w).fields.flatMap((f) => /^[^=]*=@(.+)$/.exec(f)?.[1] ?? []).filter((f) => f !== '-');
  const out: string[] = [];
  for (let i = 3; i < w.length; i++) {
    const m = /^(--body-file|-F)(?:=(.*))?$/.exec(w[i]);
    const v = m && (m[2] ?? w[i + 1]);
    if (v && v !== '-') out.push(v);
  }
  return out;
}

function checkGh(w: string[], groups: StandingToolGroup[]): string | undefined {
  const comment = groups.includes('github_comment');
  const pair = `${w[1] ?? ''} ${w[2] ?? ''}`;
  if (w[1] === 'api') {
    const call = parseGhApi(w);
    if (call.unknown) return `gh api ${call.unknown} is not an option a standing agent may use.`;
    if (call.input) return 'gh api --input sends a file the guard cannot read; pass fields with -f/-F instead.';
    const effective = call.method ?? (call.fields.length ? 'POST' : 'GET');
    if (effective === 'GET') return undefined;
    if (comment && effective === 'POST' && call.endpoint && GH_API_COMMENT.test(call.endpoint.split('?')[0])) {
      if (w.some((x) => /approve|request_changes/i.test(x))) return 'A standing agent may comment on a review, never approve or request changes.';
      return undefined;
    }
    return comment
      ? 'gh api writes are limited to POSTing issue/PR comments and comment-only reviews.'
      : 'gh api is read-only (GET) for this standing agent; it has no github_comment tool group.';
  }
  const args = w.slice(3);
  // --web starts a browser; auth status --show-token prints the token (w5504).
  if (pair === 'auth status') {
    const bad = refusedOption(args, { long: ['show-token'], short: 't', valueShort: 'h', exact: true });
    if (bad) return 'gh auth status --show-token prints the GitHub token; not allowed in a standing agent.';
  }
  // gh run list's -w is --workflow, not --web.
  const web = refusedOption(args, { long: ['web'], short: pair === 'run list' ? '' : 'w', valueShort: 'RLqtsSjABh', exact: true });
  if (web) return `gh ${pair} ${web} opens a browser; not allowed in a standing agent.`;
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

// ---- sed: options and the script, both allowlisted (w5504) ----

/** GNU sed's long options; a prefix picks every one it starts (getopt takes unambiguous prefixes). */
const SED_LONG: Record<string, 'ok' | 'value' | 'script' | 'refused'> = {
  expression: 'script', file: 'refused', 'in-place': 'refused', 'line-length': 'value', 'null-data': 'ok', 'zero-terminated': 'ok', quiet: 'ok', silent: 'ok',
  'regexp-extended': 'ok', separate: 'ok', unbuffered: 'ok', posix: 'ok', debug: 'ok', sandbox: 'ok', 'follow-symlinks': 'ok', binary: 'ok', help: 'ok', version: 'ok',
};

/** Why a sed command is refused: an option off the list (-i/-I/--in-place, -f/--file), or a script that runs, writes or reads files. */
export function checkSed(w: string[]): string | undefined {
  const scripts: string[] = [];
  let operand: string | undefined;
  let ended = false;
  for (let i = 1; i < w.length; i++) {
    const a = w[i];
    if (ended || a === '-' || !a.startsWith('-')) {
      operand ??= a;
      continue;
    }
    if (a === '--') {
      ended = true;
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = a.slice(2, eq < 0 ? undefined : eq);
      const kinds = Object.keys(SED_LONG).filter((k) => k.startsWith(name)).map((k) => SED_LONG[k]);
      if (!kinds.length || kinds.includes('refused')) return `sed ${a.split('=')[0]} is not allowed in a standing agent (it edits files in place or reads a script file).`;
      if (kinds.length > 1) return `sed ${a} is ambiguous; spell the option out.`;
      if (kinds[0] === 'script' || kinds[0] === 'value') {
        const v = eq < 0 ? w[++i] : a.slice(eq + 1);
        if (kinds[0] === 'script') scripts.push(v ?? '');
      }
      continue;
    }
    for (let j = 1; j < a.length; j++) {
      const c = a[j];
      if (c === 'e' || c === 'l') {
        const v = a.slice(j + 1) || w[++i];
        if (c === 'e') scripts.push(v ?? '');
        break;
      }
      if (!'nsuzErb'.includes(c)) return `sed -${c} is not allowed in a standing agent (-i edits files in place, -f reads a script file; allowed: -n -E -r -s -u -z -e -l).`;
    }
  }
  if (!scripts.length) scripts.push(operand ?? '');
  for (const s of scripts) {
    const why = sedScriptProblem(s);
    if (why) return `sed: ${why}`;
  }
  return undefined;
}

/**
 * Reads a sed script the way GNU sed does and refuses the commands that run a program or touch files: `e`, `w`, `W`,
 * `r`, `R`, and the `e` and `w` flags of `s`. Any command it does not know is refused too, so the list is an allowlist.
 */
export function sedScriptProblem(s: string): string | undefined {
  let i = 0;
  const n = s.length;
  const spaces = () => {
    while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
  };
  /** Skips a delimited part starting after its opening delimiter; false if it never closes. */
  const delimited = (d: string) => {
    while (i < n && s[i] !== d) {
      if (s[i] === '\\') i++;
      if (s[i] === '\n' && d !== '\n') return false;
      i++;
    }
    if (i >= n) return false;
    i++;
    return true;
  };
  const address = (): boolean | undefined => {
    if (/[0-9]/.test(s[i] ?? '')) {
      while (/[0-9]/.test(s[i] ?? '')) i++;
      if (s[i] === '~') {
        i++;
        while (/[0-9]/.test(s[i] ?? '')) i++;
      }
      return true;
    }
    if (s[i] === '$') {
      i++;
      return true;
    }
    if (s[i] === '/' || s[i] === '\\') {
      const d = s[i] === '\\' ? s[++i] : '/';
      i++;
      if (!d || !delimited(d)) return undefined;
      while (s[i] === 'I' || s[i] === 'M') i++;
      return true;
    }
    return false;
  };
  const toEol = () => {
    while (i < n && s[i] !== '\n') {
      if (s[i] === '\\') i++;
      i++;
    }
  };
  const label = () => {
    spaces();
    while (i < n && s[i] !== '\n' && s[i] !== ';') i++;
  };
  while (i < n) {
    while (i < n && /[\s;]/.test(s[i])) i++;
    if (i >= n) break;
    const a1 = address();
    if (a1 === undefined) return 'an unterminated address in the script.';
    if (a1) {
      spaces();
      if (s[i] === ',') {
        i++;
        spaces();
        if (s[i] === '+' || s[i] === '~') {
          i++;
          while (/[0-9]/.test(s[i] ?? '')) i++;
        } else if (!address()) return 'a bad second address in the script.';
      }
    }
    spaces();
    while (s[i] === '!') {
      i++;
      spaces();
    }
    const c = s[i++];
    if (c === undefined) return 'an address with no command.';
    if ('{}=dDgGhHnNpPxzF'.includes(c)) continue;
    if (c === 'l' || c === 'q' || c === 'Q') {
      spaces();
      while (/[0-9]/.test(s[i] ?? '')) i++;
      continue;
    }
    if (c === '#' || c === 'a' || c === 'i' || c === 'c') {
      toEol();
      continue;
    }
    if (c === ':' || c === 'b' || c === 't' || c === 'T' || c === 'v') {
      label();
      continue;
    }
    if (c === 's' || c === 'y') {
      const d = s[i++];
      if (!d || d === '\n' || d === '\\') return `a bad delimiter after ${c}.`;
      if (!delimited(d) || !delimited(d)) return `an unterminated ${c} command.`;
      if (c === 's') {
        while (i < n && /[gpiImM0-9]/.test(s[i])) i++;
        if (s[i] === 'e' || s[i] === 'w') return `the s///${s[i]} flag ${s[i] === 'e' ? 'runs the pattern space as a command' : 'writes a file'}; not allowed in a standing agent.`;
      }
      spaces();
      if (i < n && !/[;\n}#]/.test(s[i])) return `unexpected "${s[i]}" after the ${c} command.`;
      continue;
    }
    if ('ewWrR'.includes(c)) return `the ${c} command ${c === 'e' ? 'runs a command' : c === 'r' || c === 'R' ? 'reads a file past the guard' : 'writes a file'}; not allowed in a standing agent.`;
    return `the script command "${c}" is not one a standing agent may use.`;
  }
  return undefined;
}

/** Leading or lone VAR=value assignments allowed: names that change only formatting, with plain values (w5504). */
const SAFE_ENV = /^(LC_[A-Z]+|LANG|LANGUAGE|TZ|NO_COLOR|CLICOLOR|CLICOLOR_FORCE|TERM|COLUMNS|GH_REPO|GH_PROMPT_DISABLED|GH_NO_UPDATE_NOTIFIER|GIT_TERMINAL_PROMPT|GIT_LFS_SKIP_SMUDGE|GH_PAGER|GIT_PAGER|PAGER)$/;

function envProblem(assign: string): string | undefined {
  const eq = assign.indexOf('=');
  const name = assign.slice(0, eq);
  const value = assign.slice(eq + 1);
  if (!SAFE_ENV.test(name)) return `Setting ${name} is not allowed in a standing agent's shell (variables such as PATH, GIT_*, *_PAGER and LD_PRELOAD change what runs).`;
  if (/PAGER$/.test(name) ? !(value === '' || value === 'cat') : !/^[\w.:@/+-]*$/.test(value) || value.startsWith('-')) return `${name}=${value} is not allowed in a standing agent's shell (pagers may only be empty or cat).`;
  return undefined;
}

/** Why a utility's options are refused (w5504): the ones that run a program or write a file. */
function checkUtil(exe: string, w: string[]): string | undefined {
  const args = w.slice(1);
  const say = (bad: string, what: string) => `${exe} ${bad.split('=')[0]} ${what}; not allowed in a standing agent.`;
  let bad: string | undefined;
  switch (exe) {
    case 'sed':
      return checkSed(w);
    case 'find':
      bad = args.find((x) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/i.test(x));
      return bad ? `find ${bad} is not allowed: find may only list files in a standing agent.` : undefined;
    case 'sort':
      bad = refusedOption(args, { long: ['output', 'compress-program'], short: 'o', valueShort: 'kSTt' });
      return bad ? say(bad, 'writes a file or runs a program') : undefined;
    case 'rg':
      bad = refusedOption(args, { long: ['pre', 'hostname-bin'] });
      return bad ? say(bad, 'runs a program') : undefined;
    case 'tree':
      // -o writes the listing to a file, -R runs tree again with -o in every folder.
      bad = refusedOption(args, { long: ['output'], short: 'oR', valueShort: '' });
      return bad ? say(bad, 'writes files') : undefined;
    case 'file':
      bad = refusedOption(args, { long: ['compile'], short: 'C', valueShort: 'mFfeP' });
      return bad ? say(bad, 'writes a compiled magic file') : undefined;
    case 'uniq': {
      // uniq IN OUT writes OUT.
      const operands: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (/^(-[fsw]|--skip-fields|--skip-chars|--check-chars)$/.test(args[i])) i++;
        else if (args[i] === '-' || !args[i].startsWith('-')) operands.push(args[i]);
      }
      return operands.length > 1 ? 'uniq with a second file writes it; not allowed in a standing agent.' : undefined;
    }
  }
  return undefined;
}

/** Programs with options that run or write something: a glob or brace that could expand into an option is refused for them. */
const OPTION_SENSITIVE = new Set(['git', 'gh', 'sed', 'sort', 'rg', 'find', 'tree', 'file', 'uniq']);

/** A command word that is a path must be a system program: a cloned repo can carry an executable named cat (w5504). */
const SYSTEM_PROGRAM = /^(\/usr(\/local)?\/s?bin|\/s?bin|\/opt\/homebrew\/bin|[a-z]:\/program files( \(x86\))?\/(git\/(usr\/)?bin|github cli|git\/cmd))\/[^/]+$/i;

/** Why a shell command is refused for a standing agent, or undefined. Exported for tests. */
export function checkStandingShell(cmd: string, ctx: { groups: StandingToolGroup[]; folder: string; offLimits: string[]; secrets?: SecretRules; read?: ReadCtx }): string | undefined {
  if (!ctx.groups.includes('shell_read') && !ctx.groups.includes('github_comment')) {
    return 'This standing agent has no shell tool group; use Read, Glob and Grep.';
  }
  const scan = scanShell(cmd);
  if (scan.problems.length) return `Not allowed in a standing agent's shell: ${scan.problems.join(', ')}.`;
  const own = normPath(ctx.folder);
  const off = ctx.offLimits.map(normPath);
  // Paths are judged on the raw text, so C:\x, C:/x and Git Bash's /c/x all count whatever the shell's escaping.
  const flat = cmd.replace(/\\/g, '/').replace(/(^|[\s'"=])\/([a-zA-Z])\//g, '$1$2:/');
  // Drive-letter paths, and absolute POSIX paths (w467, change 8: /srv/fff/base in the portal VM was never checked).
  for (const m of flat.matchAll(/[a-zA-Z]:\/[^\s'"`;|&<>]*|(?<=^|[\s'"=(])\/[^\s'"`;|&<>]+/g)) {
    const p = normPath(m[0]);
    if (p === own || p.startsWith(own + '/')) continue;
    if (off.some((o) => p === o || p.startsWith(o + '/'))) return `${m[0]} is another sandbox or the base clone; a standing agent's shell stays out of them (Read and Grep them instead).`;
  }
  for (const w of scan.commands) {
    // Leading VAR=value assignments, or a command of assignments alone: only formatting variables (w5504).
    let k = 0;
    while (k < w.length && /^\w+=/.test(w[k])) {
      const why = envProblem(w[k]);
      if (why) return why;
      k++;
    }
    const words = w.slice(k);
    if (!words.length) continue;
    const word0 = words[0].replace(/\\/g, '/');
    if (word0.includes('/') && !SYSTEM_PROGRAM.test(word0)) return `${words[0]}: run programs by name; a standing agent runs no program from a path (it could be a file a clone brought in).`;
    const exe = word0.split('/').pop()!.toLowerCase().replace(/\.exe$/, '');
    // FF Factory's secrets (w467): no word of the command may name one, nor start a recursive read above one.
    if (ctx.secrets && ctx.read) {
      const recursive = ['find', 'tree', 'du', 'rg'].includes(exe) || (['grep', 'egrep', 'fgrep', 'ls'].includes(exe) && words.some((x) => /^-[a-zA-Z]*[rR]/.test(x) || x === '--recursive'));
      const files = exe === 'gh' ? ghReadFiles(words) : [];
      for (const x of [...words.slice(1), ...files]) {
        if (/^-/.test(x) || !/[\\/~]|^\.\.?$/.test(x)) continue;
        const why = readProblem(x, recursive ? 'search' : 'file', ctx.secrets, ctx.read);
        if (why) return why;
      }
    }
    const expands = OPTION_SENSITIVE.has(exe) && words.find((x) => scan.expanding.includes(x));
    if (expands) return `${expands} could expand into ${exe} options; quote it, or start the pattern with ./ (a standing agent's shell judges every ${exe} option).`;
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
      const r = checkUtil(exe, words);
      if (r) return r;
      continue;
    }
    return `"${words[0]}" is not on a standing agent's shell allowlist (read-only git and gh, and read utilities such as cat, grep, ls, jq).`;
  }
  return undefined;
}
