import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The main-clone grant (w936, Ben: "I fucking built ff factory. It's my call"). A machine's main clone is a person's own
 * project folder and the guard keeps every worker out of it (server/guard.ts, protectedPaths). When a request explicitly
 * asks for work there, its person's orchestrator sets `mainCloneAccess` on it (a person's own turn, never text in the
 * brief: server/orchestrators.ts setMainCloneAccess), the worker's spec carries the clone's path, and this file judges
 * each shell command that names it. Everything else about the clone stays protected: file writes (Write, Edit), deletes,
 * resets, cleans, forced checkouts, pushes, and every other protected path.
 *
 * Allowed, and only with `git -C <the clone>` (no `cd` into it, so a later command cannot inherit the directory):
 *   - quit its Unity editor cleanly: the bridge's `unity-bridge.py eval --project-path <clone>` with a snippet made only
 *     of SaveOpenScenes, SaveAssets and EditorApplication.Exit(0) (an osascript quit would end every sandbox's editor too);
 *   - back up uncommitted work: `git stash push/save/create/store/list/show` (the stash keeps tracked changes and, with
 *     -u, untracked files; list it before and after), a backup branch (`git branch <name>`, `checkout -b`, `switch -c`),
 *     or a patch (`git diff > <file outside the clone>`);
 *   - `git fetch` (no prune, no force), `git checkout` / `git switch` of a branch (no -f, -B, --, paths, --merge,
 *     --orphan), `git merge --ff-only`, `git pull --ff-only`;
 *   - read-only git (status, log, diff, show, branch listing, rev-parse, ...);
 *   - reopen Unity on it: `Unity -projectPath <clone> [-logFile <file>]`, directly or through `open -a`;
 *   - find its editor: grep / pgrep with a `-projectPath <clone>` pattern.
 * A seatbelt like the rest of the guard, not a boundary: the bridge snippet is checked as text.
 */
export interface MainCloneGrant {
  /** The main clone's folder on this machine. */
  path: string;
  /** The requests that asked (for the refusal text). */
  requests?: string[];
  /** Whether a path exists (tests); default fs.existsSync. */
  exists?: (p: string) => boolean;
  /** The home folder `~` and $HOME stand for (tests); default os.homedir(). */
  home?: string;
  /** The worker's own sandbox: the bridge script runs from its scripts/ folder only (set by the guard). */
  sandbox?: string;
}

/** A path as the guard compares paths: forward slashes, no trailing slash, lower case, drive-letter paths kept textual. */
export const normPath = (p: string) => (/^(?:[a-zA-Z]:)?[\\/]/.test(p) ? p : path.resolve(p)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** Every way a shell command might spell a path (already normalised by normPath). */
export function pathSpellings(p: string, home: string): string[] {
  const out = [p];
  if (/^[a-z]:\//.test(p)) out.push(`/${p[0]}${p.slice(2)}`); // Git Bash: C:/x -> /c/x
  if (p.startsWith(home + '/')) {
    const rest = p.slice(home.length); // "/games/mygame"
    out.push(`~${rest}`, `$home${rest}`, `\${home}${rest}`, `%userprofile%${rest}`, `$env:userprofile${rest}`);
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Matches any of these spellings as a whole path (followed by a separator, quote or the end), so `/repo-live` is not `/repo`. */
export function spellingsRegex(spellings: string[]): RegExp {
  return new RegExp(`(?:${spellings.map(escapeRe).join('|')})(?=$|[/\\s"';|&)\\]<>$])`, 'g');
}

/** The text a command is matched against: lower case, forward slashes. */
export const flatten = (s: string) => s.replace(/\\/g, '/').toLowerCase();

/** Splits a command into simple commands at ; | && || & and newlines outside quotes (`2>&1` and `&>` stay whole). */
export function splitShell(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: string | undefined;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      cur += c;
      if (c === q) q = undefined;
      else if (c === '\\' && q === '"' && i + 1 < cmd.length) cur += cmd[++i];
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur += c;
    } else if (c === '\n' || c === ';') {
      out.push(cur);
      cur = '';
    } else if (c === '|') {
      out.push(cur);
      cur = '';
      if (cmd[i + 1] === '|') i++;
    } else if (c === '&') {
      if (cmd[i + 1] === '&') {
        out.push(cur);
        cur = '';
        i++;
      } else if (cmd[i - 1] === '>' || cmd[i + 1] === '>' || cmd[i - 1] === '<') cur += c;
      else {
        out.push(cur);
        cur = '';
      }
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** The words of one simple command, quotes removed (adjacent quoted and bare parts join, as a shell does). */
export function shellWords(seg: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let q: string | undefined;
  for (const c of seg) {
    if (q) {
      if (c === q) q = undefined;
      else cur += c;
    } else if (c === "'" || c === '"') {
      q = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

const READ_ONLY = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'describe', 'cat-file', 'merge-base', 'for-each-ref', 'show-ref', 'shortlog', 'blame', 'grep', 'name-rev', 'diff-tree', 'diff-index', 'count-objects']);
const BRANCH_REFUSED = new Set(['-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-f', '--force', '-u', '--set-upstream-to', '--unset-upstream', '--edit-description']);
const FETCH_REFUSED = new Set(['-p', '--prune', '-P', '--prune-tags', '-f', '--force', '--update-head-ok', '--refetch']);
const PULL_REFUSED = new Set(['-r', '--rebase', '-f', '--force', '-p', '--prune', '--autostash', '--no-ff', '--squash']);
const CHECKOUT_REFUSED = new Set(['-f', '--force', '-B', '--orphan', '--ours', '--theirs', '-m', '--merge', '-p', '--patch', '--ignore-skip-worktree-bits', '--pathspec-from-file']);
const SWITCH_REFUSED = new Set(['-C', '--force-create', '-f', '--force', '--discard-changes', '-m', '--merge', '--orphan']);
const SHARED_OK = new Set(['-q', '--quiet', '--progress', '--no-progress', '-t', '--track', '--no-track', '--detach']);

/** What a bridge snippet may contain: saving what is open and quitting the editor, nothing else. */
const BRIDGE_CODE = /^(?:(?:UnityEditor\.)?(?:SceneManagement\.)?EditorSceneManager\.SaveOpenScenes\(\);|(?:UnityEditor\.)?AssetDatabase\.SaveAssets\(\);|(?:UnityEditor\.)?EditorApplication\.Exit\(0\);|(?:UnityEditor\.)?EditorApplication\.delayCall\+=\(\)=>(?:UnityEditor\.)?EditorApplication\.Exit\(0\);|return"[^"\\]*";|return(?:true|false|null|0|1);)+$/;
const UNITY_ARGS_OK = new Set(['-silent-crashes']);
/** What may follow a pipe or && next to a command on the clone: output filters and no-ops. */
const SAFE_FILTERS = new Set(['head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'echo', 'sleep', 'true', 'false', 'ps', 'grep', 'egrep', 'pgrep', 'jq', 'date', 'select-object', 'measure-object', 'out-string']);

const ALLOWED_SUMMARY =
  'git -C <clone> status/diff/log/show/branch/rev-parse/stash list|show, git stash push|save|create|store (back up first), git branch <new>, ' +
  'git fetch (no prune or force), git checkout|switch <branch> (no -f, -B, --, paths), git merge|pull --ff-only, ' +
  'unity-bridge.py eval --project-path <clone> with SaveOpenScenes / SaveAssets / EditorApplication.Exit(0) only, ' +
  'Unity -projectPath <clone> to reopen it, grep|pgrep -f "-projectPath <clone>"';

/**
 * Why a shell command that names the granted main clone is refused, or undefined when every simple command that names
 * it is one of the allowed forms (the doc comment above). Commands that do not name the clone are not judged here.
 * `spellings` are the clone's path spellings (pathSpellings of normPath(grant.path)).
 */
export function checkMainCloneShell(cmd: string, grant: MainCloneGrant, spellings: string[]): string | undefined {
  const rawHome = (grant.home ?? os.homedir()).replace(/\\/g, '/');
  const clone = normPath(grant.path);
  const exists = grant.exists ?? fs.existsSync;
  const names = spellingsRegex(spellings);
  const nameCount = (s: string) => (flatten(s).match(names) ?? []).length;
  const refuse = (why: string) =>
    `Refused in the main clone ${grant.path}: ${why}. Your request (${(grant.requests ?? []).join(', ') || 'granted'}) allows only: ${ALLOWED_SUMMARY}. ` +
    'Deleting, resetting, cleaning, forcing, pushing and writing files there stay refused; hand any other step to your orchestrator for the ops worker or ssh.';
  // The path a word names with its case kept, or undefined when it is not absolute (a relative path says nothing).
  const resolved = (t: string) => {
    let x = t.replace(/\\/g, '/');
    const hm = /^(~|\$home|\$\{home\}|%userprofile%|\$env:userprofile)(?=\/|$)/i.exec(x);
    if (hm) x = rawHome + x.slice(hm[0].length);
    if (/^\/[a-zA-Z]\//.test(x)) x = `${x[1]}:${x.slice(2)}`; // Git Bash /c/x
    return /^(?:[a-zA-Z]:)?\//.test(x) ? path.posix.normalize(x).replace(/\/+$/, '') : undefined;
  };
  const absolute = (t: string) => {
    const r = resolved(t);
    return r === undefined ? undefined : normPath(r);
  };
  const isClone = (t: string) => absolute(t) === clone;
  const inClone = (t: string) => {
    const a = absolute(t);
    return a !== undefined && (a === clone || a.startsWith(clone + '/'));
  };

  for (const seg of splitShell(cmd)) {
    if (!nameCount(seg)) {
      // Chained with a command on the clone, a command that does not name it may only filter output: `git -C <clone> ls-files
      // | xargs rm` must not get past the check just because the second command never says where it acts.
      const prog = path.basename((shellWords(seg)[0] ?? '').replace(/\\/g, '/')).toLowerCase();
      if (!SAFE_FILTERS.has(prog)) return refuse(`${prog || 'that'} cannot be chained with a command on the clone (only filters such as head, tail, wc, sort, uniq, grep can)`);
      if (/\s-o\b|--output|\$\(|`/.test(seg)) return refuse('a filter that writes a file or runs a substitution cannot be chained with a command on the clone');
      continue;
    }
    if (/\$\(|`|<\(|>\(/.test(seg)) return refuse('a command substitution next to the clone cannot be checked');
    // A redirect into the clone is a write there; a patch goes to a file outside it. Redirects are not arguments.
    const all = shellWords(seg);
    let w: string[] = [];
    for (let i = 0; i < all.length; i++) {
      const m = /^\d*>>?&?(.*)$/.exec(all[i]);
      if (!m) {
        w.push(all[i]);
        continue;
      }
      if (nameCount(m[1] || all[i + 1] || '')) return refuse('a redirect into the clone writes a file there');
      if (!m[1]) i++;
    }
    if (!w.length) return refuse('nothing to run');
    if (/^\w+=/.test(w[0])) return refuse('an environment prefix (GIT_DIR=...) changes what git acts on');
    while (w[0] === '&' || w[0] === 'nohup') w = w.slice(1);
    const prog = path.basename(w[0].replace(/\\/g, '/')).toLowerCase();

    if (prog === 'git' || prog === 'git.exe') {
      const why = gitSegment(w);
      if (why) return refuse(why);
      continue;
    }
    if (prog === 'python' || prog === 'python3' || prog === 'python.exe' || prog === 'py') {
      const why = bridgeSegment(w);
      if (why) return refuse(why);
      continue;
    }
    if (prog === 'unity' || prog === 'unity.exe' || prog === 'open') {
      const why = unitySegment(w, prog === 'open');
      if (why) return refuse(why);
      continue;
    }
    if (prog === 'grep' || prog === 'egrep' || prog === 'pgrep') {
      // Finding its editor: the clone appears only inside a -projectPath pattern, never as a file to read.
      if (w.some((t) => nameCount(t) && !/projectpath/i.test(t))) return refuse('grep and pgrep may name the clone only inside a -projectPath pattern');
      continue;
    }
    return refuse(`${w[0]} is not one of the allowed commands`);
  }
  return undefined;

  function gitSegment(w: string[]): string | undefined {
    let i = 1;
    let cwd: string | undefined;
    while (i < w.length && w[i].startsWith('-')) {
      if (w[i] === '-C') {
        if (!w[i + 1] || !inClone(w[i + 1])) return 'git must run with -C pointing at the clone';
        cwd = resolved(w[i + 1]);
        i += 2;
      } else if (w[i] === '--no-pager' || w[i] === '-P' || w[i] === '--no-optional-locks') i++;
      else return `git option ${w[i]} is not allowed before the subcommand`;
    }
    if (!cwd) return 'git must run with -C <the clone> (a cd into it is refused, so a later command cannot inherit it)';
    const sub = (w[i] ?? '').toLowerCase();
    const args = w.slice(i + 1);
    const lower = args.map((a) => a.toLowerCase());
    const flags = args.filter((a) => a.startsWith('-'));
    const refusedFlag = (set: Set<string>) => flags.find((f) => set.has(f) || set.has(f.split('=')[0]));
    const outputFlag = flags.find((f) => f.startsWith('--output') || f === '--open-files-in-pager');

    if (READ_ONLY.has(sub)) return outputFlag ? `git ${sub} ${outputFlag} writes a file` : undefined;
    switch (sub) {
      case 'config':
        return ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(lower[0] ?? '') ? undefined : 'git config only reads (--get, --list)';
      case 'remote':
        return lower.length === 0 || lower[0] === '-v' || lower[0] === 'get-url' || lower[0] === 'show' ? undefined : 'git remote only lists';
      case 'worktree':
        return lower[0] === 'list' ? undefined : 'git worktree only lists';
      case 'branch': {
        const bad = refusedFlag(BRANCH_REFUSED);
        return bad ? `git branch ${bad} deletes, renames or forces` : undefined; // listing, or `branch <new> [<start>]` as a backup branch
      }
      case 'stash': {
        const first = lower[0] ?? '';
        if (first && !first.startsWith('-') && !['list', 'show', 'push', 'save', 'create', 'store'].includes(first)) return `git stash ${first} drops or reapplies a stash; only list, show, push, save, create and store are allowed`;
        return undefined;
      }
      case 'fetch': {
        const bad = refusedFlag(FETCH_REFUSED);
        if (bad) return `git fetch ${bad} deletes or overwrites refs`;
        if (flags.some((f) => /upload-pack|receive-pack|exec|config/.test(f))) return 'git fetch may not name a program to run';
        if (args.some((a) => !a.startsWith('-') && (a.startsWith('+') || a.includes('::')))) return 'git fetch with a forced (+) refspec or a transport helper (::) is not allowed';
        return undefined;
      }
      case 'merge':
        return lower.includes('--ff-only') && !lower.includes('--abort') ? undefined : 'git merge only with --ff-only';
      case 'pull': {
        const bad = refusedFlag(PULL_REFUSED);
        return lower.includes('--ff-only') && !bad ? undefined : `git pull only with --ff-only${bad ? ` and without ${bad}` : ''}`;
      }
      case 'switch': {
        const bad = refusedFlag(SWITCH_REFUSED);
        if (bad) return `git switch ${bad} forces, merges or discards`;
        let positional = 0;
        for (let k = 0; k < args.length; k++) {
          const a = args[k];
          if (a === '-c' || a === '--create') k++;
          else if (a.startsWith('-')) {
            if (!SHARED_OK.has(a) && a !== '-d') return `git switch ${a} is not allowed`;
          } else positional++;
        }
        return positional > 2 ? 'git switch takes a branch (and a start point)' : undefined;
      }
      case 'checkout': {
        const bad = refusedFlag(CHECKOUT_REFUSED);
        if (bad) return `git checkout ${bad} forces, merges or discards changes`;
        if (lower.includes('--')) return 'git checkout -- <paths> overwrites files; switch branches only';
        const positional: string[] = [];
        let creating = false;
        for (let k = 0; k < args.length; k++) {
          const a = args[k];
          if (a === '-b') {
            creating = true;
            k++;
          } else if (a.startsWith('-')) {
            if (!SHARED_OK.has(a)) return `git checkout ${a} is not allowed`;
          } else positional.push(args[k]);
        }
        if (positional.length > 1) return 'git checkout takes one branch (or -b <new> [<start>])';
        if (!creating && positional.length === 0) return 'git checkout needs a branch';
        for (const p of positional) {
          if (p === '.' || /[*?[]/.test(p)) return `git checkout ${p} can restore files`;
          // `git checkout <name>` restores a file when <name> is a path and not a branch.
          if (!creating && exists(path.join(cwd, p))) return `git checkout ${p}: ${p} is a path in the clone, so git would restore the file; use git switch ${p}`;
        }
        return undefined;
      }
      default:
        return `git ${sub || '(no subcommand)'} is not allowed`;
    }
  }

  function bridgeSegment(w: string[]): string | undefined {
    const script = w[1] ?? '';
    if (nameCount(script)) return 'a script inside the clone is not run';
    const sandbox = grant.sandbox ? normPath(grant.sandbox) : undefined;
    const abs = absolute(script);
    const fromSandbox = abs === undefined ? /^(?:\.\/)?scripts\/unity-bridge\.py$/.test(script.replace(/\\/g, '/')) : !!sandbox && abs === `${sandbox}/scripts/unity-bridge.py`;
    if (!fromSandbox) return "python may run only the sandbox's own scripts/unity-bridge.py here";
    const sub = (w[2] ?? '').toLowerCase();
    if (!['ping', 'status', 'eval'].includes(sub)) return `unity-bridge.py ${sub} is not allowed (ping, status and eval are)`;
    let proj: string | undefined;
    const rest: string[] = [];
    for (let k = 3; k < w.length; k++) {
      if (w[k] === '--project-path') proj = w[++k];
      else if (w[k] === '--timeout') k++;
      else if (w[k].startsWith('-')) return `unity-bridge.py ${w[k]} is not allowed`;
      else rest.push(w[k]);
    }
    if (!proj || !isClone(proj)) return 'unity-bridge.py needs --project-path <the clone>';
    if (sub !== 'eval') return rest.length ? 'ping and status take no snippet' : undefined;
    if (rest.length !== 1) return 'eval takes one snippet';
    return BRIDGE_CODE.test(rest[0].replace(/\s+/g, '')) ? undefined : 'the snippet may only save the open scenes and assets and call EditorApplication.Exit(0)';
  }

  function unitySegment(w: string[], viaOpen: boolean): string | undefined {
    let args = w.slice(1);
    if (viaOpen) {
      const at = args.indexOf('--args');
      if (at < 0) return 'open <Unity> needs --args -projectPath <the clone>';
      const before = args.slice(0, at);
      for (let k = 0; k < before.length; k++) {
        if (before[k] === '-a') k++;
        else if (!['-n', '-g', '-j'].includes(before[k]) && !/unity/i.test(before[k])) return `open ${before[k]} is not allowed`;
        else if (nameCount(before[k])) return 'open may not be pointed at the clone itself';
      }
      if (!before.some((b) => /unity/i.test(b))) return 'open may start only Unity';
      args = args.slice(at + 1);
    }
    let proj: string | undefined;
    for (let k = 0; k < args.length; k++) {
      const a = args[k].toLowerCase();
      if (a === '-projectpath') proj = args[++k];
      else if (a === '-logfile') {
        if (nameCount(args[k + 1] ?? '')) return 'the log file goes outside the clone';
        k++;
      } else if (!UNITY_ARGS_OK.has(a)) return `Unity ${args[k]} is not allowed (reopening takes -projectPath and -logFile)`;
    }
    return proj && isClone(proj) ? undefined : 'Unity needs -projectPath <the clone>';
  }
}
