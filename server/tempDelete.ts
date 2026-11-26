import fs from 'node:fs';
import path from 'node:path';

/**
 * The one delete a worker's shell may run without a person's approval (w913, lothsahn, 2026-10-10: "Random clean up commands
 * take a lot of approvals"): a plain `rm` / `rmdir` / `Remove-Item` whose every target lies strictly inside the session's
 * own temp folder ($TMPDIR, `<install>/tmp/ffa-<session>`), or is a save copy named with the session's own tag in the game's
 * saves folder. Claude Code asks about `rm -rf`, a wildcard or a path outside the working folder even in the portal's
 * bypass mode (the `canUseTool` callback is called), and the clean-up commands workers ran were exactly those: `rm -rf
 * $TMPDIR/ff-factory $TMPDIR/*.log`. The session answers them itself when this says yes (server/sessions.ts askPermission);
 * anything else goes to a person as before.
 *
 * It is narrow on purpose, never a blanket `rm` allow: the text must be a list of simple statements (`;`, `&&`, `||`, newlines)
 * of delete verbs and read-only ones (`du`, `ls`, `df`, `echo`); a pipe, a redirect to a file, a command substitution, an
 * unknown variable, `..`, a `~`, a flag it does not know, or a path that is the temp folder itself, outside it, or reaches
 * outside it through a link, is a no. The Git Bash `/tmp` is not the session's temp folder ($TMPDIR is), so it is a no.
 * Like the rest of the guard it reads text; the delete verbs it accepts do nothing else.
 */
export interface TempDeleteContext {
  /** The session's temp folder: TMPDIR in its environment. */
  tmp: string;
  /** The game's saves folder entries that may go: names starting with this (the temp folder's own name, `ffa-<session>`) and a dash. Default: the temp folder's name. */
  tag?: string;
  /** realpath, injected for tests; `undefined` when the path does not exist. */
  real?: (p: string) => string | undefined;
  /** The user's home, for `~`-less forms (`$USERPROFILE`, `$HOME`) of the saves folder. Default: any. */
  home?: string;
  /**
   * The session's own sandbox (its worktree, `<install>/sandboxes/<name>`), set only when the session's folder is one (w5148):
   * a path strictly inside it, not in its `.git` and not a wildcard at its top, may go too.
   */
  sandbox?: string;
  /** The folder relative paths are read against: the command's own leading `cd` (tempDeletesWithin). None: a relative path is a no. */
  base?: string;
  /** Reads a small file, injected for tests (w5148: `rm -rf "$(cat $TMPDIR/x.path)"`). `undefined` when it cannot be read. */
  read?: (p: string) => string | undefined;
}

export type TempDeleteVerdict = { ok: true } | { ok: false; why: string };

const no = (why: string): TempDeleteVerdict => ({ ok: false, why });

const READ_ONLY = new Set(['du', 'ls', 'df', 'echo', 'true', 'pwd', 'stat', 'wc']);
const RM_VERBS = new Set(['rm', 'rmdir']);
const PS_VERBS = new Set(['remove-item', 'ri']);
const RM_FLAG = /^-[rRfvdI]+$|^--(force|recursive|verbose|dir)$/;
/** PowerShell's switches, and the parameters whose next word is a value we accept. */
const PS_SWITCH = new Set(['-recurse', '-force', '-verbose']);
const PS_PATH = new Set(['-path', '-literalpath']);

const TMP_VAR = /^(?:\$env:(?:tmp|temp|tmpdir)|\$\{(?:tmp|temp|tmpdir)\}|\$(?:tmp|temp|tmpdir)|%(?:tmp|temp)%)(?=$|[\\/])/i;
const HOME_VAR = /^(?:~|\$home|\$\{home\}|\$userprofile|\$\{userprofile\}|\$env:userprofile|\$env:home|%userprofile%)(?=$|[\\/])/i;
/**
 * The game's saves folder: `UserData/saves` since the game's UserData layout (GameDataPaths.Saves), `saves` before it, on
 * Windows (AppData/LocalLow), Linux (~/.config/unity3d) and macOS (Library/Application Support) (w1505), and a worker
 * install's own data root, `<install>/gamedata` (FF_GAME_DATA_DIR, w5306), or a sandbox's own one inside it,
 * `<install>/gamedata/sandboxes/<sandbox>` (w5557).
 */
const SAVES_DIR = /\/(?:(?:appdata\/locallow|\.config\/unity3d|library\/application support)\/never games\/finalfactory[^/]*|gamedata(?:\/sandboxes\/[^/]+)?)\/(?:userdata\/)?saves\/([^/*?]+)$/i;

interface Word {
  text: string;
  /** In single quotes: the shell does not expand it. */
  literal: boolean;
}

/** The words of a statement; quotes removed, single-quoted ones marked. `undefined`: unbalanced quotes. */
function words(stmt: string): Word[] | undefined {
  const out: Word[] = [];
  let cur = '';
  let has = false;
  let lit = true;
  let q = '';
  for (let i = 0; i < stmt.length; i++) {
    const c = stmt[i];
    if (q) {
      if (c === q) q = '';
      else {
        cur += c;
        if (q === '"') lit = false;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      has = true;
      if (c === '"') lit = false;
    } else if (c === '\\' && /[\s"']/.test(stmt[i + 1] ?? '') && !cur.includes('\\')) {
      // Bash's `Never\ Games`; in a Windows path (`D:\work\ffw\ -Recurse`) a backslash is a separator and the space ends the word.
      cur += stmt[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has) out.push({ text: cur, literal: lit });
      cur = '';
      has = false;
      lit = true;
    } else {
      cur += c;
      has = true;
      lit = false;
    }
  }
  if (q) return undefined;
  if (has) out.push({ text: cur, literal: lit });
  return out;
}

/** Split into statements at `;`, `&&`, `||` and newlines outside quotes; a single `|` or `&` is a no. */
function statements(cmd: string): string[] | { bad: string } {
  const out: string[] = [];
  let cur = '';
  let q = '';
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      cur += c;
      if (c === q) q = '';
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === ';' || c === '\n' || c === '\r') {
      out.push(cur);
      cur = '';
    } else if ((c === '&' && cmd[i + 1] === '&') || (c === '|' && cmd[i + 1] === '|')) {
      out.push(cur);
      cur = '';
      i++;
    } else if (c === '|') return { bad: 'a pipe' };
    else if (c === '&') {
      // `2>&1` is fine, a lone & (background) is not
      if (cmd[i - 1] === '>') cur += c;
      else return { bad: 'a background job' };
    } else cur += c;
  }
  if (q) return { bad: 'an unbalanced quote' };
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

const slash = (p: string) => p.replace(/\\/g, '/');
/** Normalised for comparing: forward slashes, no trailing slash, lower case, `/f/x` as `f:/x` on a drive-letter folder. */
function norm(p: string, drive: boolean): string {
  let s = path.posix.normalize(slash(p)).replace(/\/+$/, '');
  if (drive) s = s.replace(/^\/cygdrive\/([a-zA-Z])(?=\/|$)/, '$1:').replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:');
  return s.toLowerCase();
}

/** A sandbox's folder: `<install>/sandboxes/<name>`, never the main clone (`<install>/repo`). */
const SANDBOX_DIR = /\/sandboxes\/[^/]+$/i;
/** Not absolute and not a variable: read against the current folder. */
const isRelative = (p: string) => !/^(?:[\\/]|[a-zA-Z]:|[$%~])/.test(p);

/** The glob characters a shell expands in a word. */
const GLOB = /[*?[\]{}]/;

/**
 * Whether the text of a shell command (Bash or PowerShell) is a delete the session may run on its own authority.
 */
export function tempOnlyDelete(cmd: string, ctx: TempDeleteContext): TempDeleteVerdict {
  const tmpRaw = slash(ctx.tmp).replace(/\/+$/, '');
  if (!tmpRaw || /^[a-zA-Z]:$/.test(tmpRaw) || tmpRaw === '/' || tmpRaw.split('/').filter(Boolean).length < 2) return no('the session has no temp folder of its own');
  const drive = /^[a-zA-Z]:\//.test(tmpRaw);
  const tmp = norm(tmpRaw, drive);
  const tag = (ctx.tag ?? path.posix.basename(tmpRaw)).toLowerCase();
  // w5915: the native realpath. A junction a Low-integrity process makes (every BEAST worker) points at \??\Global\F:\...,
  // which Node's JavaScript realpath does not follow: it answered the link's own path, so a delete through it passed.
  const real = ctx.real ?? ((p: string) => { try { return fs.realpathSync.native(p); } catch { return undefined; } });
  if (cmd.length > 4000) return no('a long command');
  if (/`|\$\(|<|\$\{[^}]*[:#%/!][^}]*\}/.test(cmd)) return no('a substitution, a redirect from a file or a computed variable');
  // Redirects: only to /dev/null or into a stream (2>&1).
  const redirects = cmd.match(/\d*>>?\s*[^\s;&|]*/g) ?? [];
  for (const r of redirects) if (!/^\d*>>?\s*(?:&\d|\/dev\/null|\$null|nul)$/i.test(r)) return no('a redirect into a file');
  const stmts = statements(cmd);
  if (!Array.isArray(stmts)) return no(stmts.bad);
  if (!stmts.length) return no('nothing to run');
  let deletes = 0;

  /** Whether `raw` names something strictly inside the temp folder; the glob part is what follows the literal prefix. */
  /** A relative path read against the command's own leading `cd` (w5148), or left as it is (and then outside both folders). */
  const resolve = (raw: string): string => (ctx.base && isRelative(raw) ? `${slash(ctx.base).replace(/\/+$/, '')}/${raw}` : raw);
  const insideTmp = (raw: string, literal: boolean): string | undefined => {
    if (literal && /[$%]/.test(raw)) return `${raw} is single-quoted, so its variable is not expanded`;
    let p = resolve(raw);
    const v = TMP_VAR.exec(p);
    if (v) p = tmpRaw + p.slice(v[0].length);
    // A variable after the folder (`$TMPDIR/$S`) could be empty (the folder itself) or `../..` (w1097).
    if (/[$%`]/.test(v ? p.slice(tmpRaw.length) : p)) return `${raw} has a variable that is not the temp folder`;
    // A tilde expands only at the start of a word; one inside a path is a Windows short name (C:/Users/RUNNER~1/...).
    if (raw.startsWith('~')) return `${raw} has a ~`;
    const n = norm(p, drive);
    if (!n.startsWith(tmp + '/')) return `${raw} is not strictly inside your temp folder (${ctx.tmp})`;
    const rest = n.slice(tmp.length);
    if (rest.split('/').some((seg) => seg === '..')) return `${raw} has a ..`;
    if (/\.\./.test(rest)) return `${raw} has a ..`;
    if (/^\/[^/]*\{/.test(rest) && /\{[^}]*\//.test(rest)) return `${raw} has a brace list across folders`;
    // A link inside the temp folder that leads out of it: the longest existing literal prefix must stay inside.
    const lit = rest.split('/').filter(Boolean);
    let cur = tmpRaw;
    for (const [i, seg] of lit.entries()) {
      if (GLOB.test(seg)) break;
      if (i === lit.length - 1) break; // the last name itself: rm removes a link, it does not follow it
      const next = `${cur}/${seg}`;
      const r = real(next);
      if (r === undefined) break;
      const rn = norm(r, drive);
      const base = real(tmpRaw);
      if (base !== undefined && !(rn === norm(base, drive) || rn.startsWith(norm(base, drive) + '/'))) return `${raw} leads out of your temp folder through a link`;
      cur = next;
    }
    return undefined;
  };

  /**
   * Strictly inside the session's own sandbox (w5148: w3802's `cd <sandbox>; rm -f dev_loadsave.trigger` waited 9.5 h on Ben):
   * a literal path, or one relative to the command's leading `cd`, with no `..`, no `.git` part, no wildcard at the sandbox's
   * top (`rm -rf *` there would empty the worktree), and no link out of the sandbox on the way.
   */
  const inSandbox = (raw: string, literal: boolean): boolean => {
    if (!ctx.sandbox || !SANDBOX_DIR.test(slash(ctx.sandbox).replace(/\/+$/, ''))) return false;
    if (literal && /[$%]/.test(raw)) return false;
    let p = resolve(raw);
    const v = TMP_VAR.exec(p);
    if (v) return false;
    if (/[$%`]/.test(p) || p.startsWith('~')) return false;
    const sbRaw = slash(ctx.sandbox).replace(/\/+$/, '');
    const sd = /^[a-zA-Z]:\//.test(sbRaw);
    const sb = norm(sbRaw, sd);
    if (slash(p).split('/').includes('..')) return false;
    const n = norm(p, sd);
    if (!n.startsWith(sb + '/')) return false;
    const segs = n.slice(sb.length).split('/').filter(Boolean);
    if (!segs.length || GLOB.test(segs[0]) || segs.some((x) => x === '.git' || x === '..')) return false;
    let cur = sbRaw;
    const base = real(sbRaw);
    for (const [i, seg] of segs.entries()) {
      if (GLOB.test(seg) || i === segs.length - 1) break;
      cur = `${cur}/${seg}`;
      const r = real(cur);
      if (r === undefined) break;
      if (base !== undefined && !norm(r, sd).startsWith(norm(base, sd) + '/')) return false;
    }
    return true;
  };

  /** A save copy of this session: `.../AppData/LocalLow/Never Games/finalfactory/saves/<tag>-<name>`. */
  const ownSave = (raw: string): boolean => {
    let p = raw;
    const h = HOME_VAR.exec(p);
    if (h) p = '/home-var' + p.slice(h[0].length);
    else if (/[$%`]/.test(p) || p.includes('~')) return false;
    const m = SAVES_DIR.exec(norm(p, true).replace(/^([a-z]):/, '/$1:'));
    if (!m || /\.\./.test(p)) return false;
    return m[1].startsWith(`${tag}-`) && !/[*?[\]{}]/.test(m[1].slice(tag.length + 1).replace(/\*$/, ''));
  };

  for (const raw of stmts) {
    // The redirects checked above (to /dev/null, into a stream) are not words of the command.
    const stmt = raw.replace(/\d*>>?\s*(?:&\d|\/dev\/null|\$null|nul)(?=\s|$)/gi, ' ');
    const w = words(stmt);
    if (!w || !w.length) return no('an unbalanced quote');
    // Leading VAR=value, cd, env and the like are not accepted: relative paths and a changed directory are not judged.
    const verb = path.posix.basename(slash(w[0].text)).replace(/\.exe$/i, '').toLowerCase();
    const args = w.slice(1);
    if (READ_ONLY.has(verb)) continue;
    if (RM_VERBS.has(verb)) {
      let flags = true;
      let n = 0;
      for (const a of args) {
        if (flags && a.text === '--') {
          flags = false;
          continue;
        }
        if (flags && a.text.startsWith('-')) {
          if (!RM_FLAG.test(a.text)) return no(`rm flag ${a.text}`);
          continue;
        }
        n++;
        const why = insideTmp(a.text, a.literal);
        if (why !== undefined && !ownSave(a.text) && !inSandbox(a.text, a.literal)) return no(why);
      }
      if (!n) return no('rm with no path');
      deletes += n;
      continue;
    }
    if (PS_VERBS.has(verb)) {
      let n = 0;
      for (let i = 0; i < args.length; i++) {
        const a = args[i].text;
        const low = a.toLowerCase();
        if (low.startsWith('-')) {
          const [name, inline] = low.split(/:(.*)/s);
          if (PS_SWITCH.has(name)) continue;
          if (name === '-erroraction' || name === '-ea') {
            const val = (inline ?? args[++i]?.text ?? '').toLowerCase();
            if (!['silentlycontinue', 'stop', 'continue', 'ignore'].includes(val)) return no(`Remove-Item ${a} ${val}`);
            continue;
          }
          if (PS_PATH.has(name)) {
            const val = inline ?? args[++i]?.text;
            if (!val) return no('Remove-Item -Path with no path');
            n++;
            const why = insideTmp(val, false);
            if (why !== undefined && !ownSave(val) && !inSandbox(val, false)) return no(why);
            continue;
          }
          return no(`Remove-Item parameter ${a}`);
        }
        if (a.includes(',')) return no('Remove-Item with a list of paths');
        n++;
        const why = insideTmp(a, args[i].literal);
        if (why !== undefined && !ownSave(a) && !inSandbox(a, args[i].literal)) return no(why);
      }
      if (!n) return no('Remove-Item with no path');
      deletes += n;
      continue;
    }
    return no(`${verb || stmt} is not a delete or a read-only command`);
  }
  if (!deletes) return no('no delete in it');
  return { ok: true };
}

/**
 * The words that delete, as a command or a program name anywhere in the text (quotes included): each one must be a
 * statement this file judges, or the command is not answered here.
 */
const DELETE_WORD = /(?:^|[\s;&|(){}`'"=/\\])(?:rm|rmdir|unlink|shred|del|erase|rd|ri|remove-item|rimraf|trash)(?:\.exe)?(?=$|[\s;&|(){}`'"])/gi;

/** What a command must not hold for its deletes to be judged one by one: each could change what a judged delete removes. */
const COMPOUND_REFUSED: [RegExp, string][] = [
  // A name, not its expansion: `TMPDIR=/`, `export TMP`, `for TEMP in`, `$env:TMP = …`; `"$TMPDIR/x"` and `${TMPDIR}` are reads.
  // IFS (w4338): `IFS=/` splits an unquoted `$TMPDIR/x` into relative names (`V:`, `ffw`, ...) that rm would remove.
  [/(?<![$\w{:])(?:TMPDIR|TMP|TEMP|PATH|BASH_ENV|ENV|CDPATH|IFS)\s*\+?=|\b(?:export|unset|declare|typeset|local|readonly|read|for)\b[^;&|\n]*(?<![$\w{:])(?:TMPDIR|TMP|TEMP|PATH|IFS)\b|\$env:(?:TMP|TEMP|TMPDIR|PATH)\s*=/i, 'it changes the temp folder variable, PATH or IFS'],
  [/\b(?:eval|xargs|source|alias|enable|exec)\b|(?:^|[;&|\n]\s*)\.\s+\S/i, 'eval, xargs, source, alias or exec'],
  [/\b(?:ln|mklink|subst|mount|junction)\b|-itemtype\s+['"]?(?:symboliclink|junction|hardlink)/i, 'it makes a link'],
  [/(?:^|[\s;&|])-(?:delete|exec|execdir|ok)\b/i, 'find -delete or -exec'],
  [/\b(?:function\s+(?:rm|rmdir|remove-item|ri|del|rd)\b|(?:rm|rmdir|del|rd)\s*\(\s*\))/i, 'it defines a function named like a delete'],
  [/\b(?:sh|bash|zsh|dash|pwsh|powershell)(?:\.exe)?\s+(?:-\w+\s+)*-(?:\w*c|command|encodedcommand)\b|\bcmd(?:\.exe)?\s+\/[ck]\b/i, 'a nested shell'],
];

/** Comments removed: a `#` that starts a word outside quotes, to the end of its line. */
function stripComments(cmd: string): string {
  let out = '';
  let q = '';
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      out += c;
      if (c === q) q = '';
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      out += c;
    } else if (c === '#' && (i === 0 || /[\s;&|]/.test(cmd[i - 1]))) {
      while (i < cmd.length && cmd[i] !== '\n') i++;
      out += '\n';
    } else out += c;
  }
  return out;
}

/** Simple statements: split at `;`, `&&`, `||`, `|`, `&` and newlines outside quotes (`2>&1` kept). `undefined`: an unbalanced quote. */
function allStatements(cmd: string): string[] | undefined {
  const out: string[] = [];
  let cur = '';
  let q = '';
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      cur += c;
      if (c === q) q = '';
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === ';' || c === '\n' || c === '\r' || c === '|' || (c === '&' && cmd[i - 1] !== '>' && cmd[i + 1] !== '>')) {
      out.push(cur);
      cur = '';
      if ((c === '&' || c === '|') && cmd[i + 1] === c) i++;
    } else cur += c;
  }
  if (q) return undefined;
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * The folders a command names once at its very start and then deletes in (w4338: w4222's worker waited 17 hours on a
 * person for `K=$(cygpath -m "$TMPDIR/keep"); ...; rm -f "$K"/*strip.png`). A name counts as a folder inside the temp
 * folder only when all of this holds: it is assigned in the command's leading run of plain assignments, each ended by `;`
 * or a newline at the top level (not inside `$(...)`, a group, a loop or after `&&`, so the assignment always runs before
 * anything else); its value is `"$TMPDIR/x"`, `$TMPDIR/x` or `$(cygpath -m|-w|-u "$TMPDIR/x")` with no space, glob,
 * quote or other variable, strictly inside the temp folder and not through a link out of it; and the name appears nowhere
 * else in the text except as `$NAME` or `${NAME}` (no second assignment, `for NAME`, `read NAME`, `unset NAME`, `NAME+=`).
 */
function tempFolderNames(text: string, ctx: TempDeleteContext): Map<string, string> {
  const named = new Map<string, string>();
  let i = 0;
  for (;;) {
    while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
    const m = /^([A-Za-z_]\w*)=/.exec(text.slice(i));
    if (!m) break;
    // The statement's end at the top level: `;` or a newline outside quotes, `$(...)` and backquotes.
    // A stack of what the scanner is inside: `'` single quotes, `"` double quotes, `` ` `` backquotes, `(` a `$(...)` or `(...)`.
    const stack: string[] = [];
    let end = -1;
    let bad = false;
    for (let j = i + m[0].length; j < text.length && end < 0 && !bad; j++) {
      const c = text[j];
      const top = stack[stack.length - 1];
      if (top === "'") {
        if (c === "'") stack.pop();
      } else if (top === '"' || top === '`') {
        if (c === '\\') j++;
        else if (c === top) stack.pop();
        else if (top === '"' && c === '`') stack.push('`');
        else if (top === '"' && c === '$' && text[j + 1] === '(') {
          stack.push('(');
          j++;
        }
      } else if (c === "'" || c === '"' || c === '`') stack.push(c);
      else if (c === '$' && text[j + 1] === '(') {
        stack.push('(');
        j++;
      } else if (c === '(') stack.push('(');
      else if (c === ')') {
        if (top === '(') stack.pop();
        else bad = true;
      } else if (top === '(') {
        if (c === '\\') j++;
      } else if (c === ';' || c === '\n') end = j;
      else if (/[&|<>\\{}\s]/.test(c)) bad = true; // `&&`, a pipe, a redirect, a heredoc, a continuation, a second word
    }
    if (end < 0 || bad) break;
    const value = text.slice(i + m[0].length, end).trim();
    const v = /^(?:"([^"]*)"|\$\(cygpath\s+-[mwu]\s+(?:"([^"]*)"|([^\s"'()]+))\)|([^\s"'()]+))$/.exec(value);
    const target = v ? (v[1] ?? v[2] ?? v[3] ?? v[4]) : undefined;
    if (target !== undefined && /^[^\s"'`*?[\]{}()]+$/.test(target) && tempOnlyDelete(`rm -rf "${target}"`, ctx).ok) named.set(m[1], target);
    else named.delete(m[1]);
    i = end + 1;
  }
  for (const name of [...named.keys()]) {
    const bare = [...text.matchAll(new RegExp(`(?<![$\\w{])${name}(?!\\w)`, 'g'))].length;
    if (bare !== 1) named.delete(name);
  }
  return named;
}

/** The shell keywords, openers and function headers a statement may start with before its command (`then rm …`, `run() { rm …`). */
const LEADING = /^(?:(?:do|then|else|elif|if|while|until|time|!|\{|\()\s+|(?:function\s+)?[\w-]+\s*\(\s*\)\s*\{?\s*|function\s+[\w-]+\s*\{?\s+)+/;

/**
 * Whether every delete in a longer command (a test leg: a function, a loop, a copy, a script run and a delete of its own
 * output folders) is one `tempOnlyDelete` allows (w1097, lothsahn, 2026-10-12: "Why did it do that, and how do we allow it
 * to do what it just needed to do without a complex bash prompt?"). The session asks this only when Claude Code's own
 * reason for asking is its dangerous-rm check and the session runs in bypass mode, where nothing else in the command
 * would have been asked about: so the deletes are the whole question. Each statement whose command is a delete must pass
 * `tempOnlyDelete` alone; every delete word anywhere in the text (inside quotes, `$(...)`, after `xargs`, a `git rm`)
 * must be one of those statements; and the command may not change what such a delete removes (the temp folder variable,
 * PATH, a link made first, a function named `rm`, eval, a nested shell). Anything else is asked as before.
 */
export function tempDeletesWithin(cmd: string, ctx: TempDeleteContext): TempDeleteVerdict {
  if (cmd.length > 8000) return no('a long command');
  const orig = stripComments(cmd);
  // A link or a find -delete inside a nested shell's body still counts (literalShells replaces the body below).
  for (const [re, why] of COMPOUND_REFUSED.slice(2, 4)) if (re.test(orig)) return no(why);
  const text = ffuSlotAsCd(literalShells(orig));
  for (const [re, why] of COMPOUND_REFUSED) if (re.test(text)) return no(why);
  const stmts = allStatements(text);
  if (!stmts) return no('an unbalanced quote');
  const mentions = [...text.matchAll(DELETE_WORD)].length;
  const named = tempFolderNames(text, ctx);
  const loops = loopNames(text);
  const judgeCtx: TempDeleteContext = { ...ctx, base: leadingCd(text, ctx) };
  let judged = 0;
  for (const [index, raw] of stmts.entries()) {
    let stmt = raw.replace(LEADING, '');
    const verb = path.posix.basename(slash(stmt.split(/\s+/)[0] ?? '')).replace(/\.exe$/i, '').toLowerCase();
    if (!RM_VERBS.has(verb) && !PS_VERBS.has(verb)) continue;
    // `rm -rf "$(cat $TMPDIR/x.path)"`: the path that file holds now, when nothing before it could have changed the file.
    if (CAT_PATH.test(stmt)) {
      const r = catPaths(stmt, stmts.slice(0, index), judgeCtx);
      if (typeof r !== 'string') return no(`${stmt}: ${r.why}`);
      stmt = r;
    }
    if (/[(){}]/.test(stmt.replace(/\{[^{}/]*\}/g, ''))) return no(`${stmt} has a parenthesis or a brace`);
    // A folder named at the start of the command (tempFolderNames) is judged as the path it holds.
    for (const [name, target] of named) stmt = stmt.replace(new RegExp(`\\$\\{${name}\\}|\\$${name}(?!\\w)`, 'g'), target);
    // A `for d in leg-*` name (loopNames) is judged once for each word it takes.
    const loop = [...loops].find(([name]) => new RegExp(`\\$\\{?${name}(?!\\w)`).test(stmt));
    const variants = loop ? loop[1].map((w) => stmt.replace(new RegExp(`\\$\\{${loop[0]}\\}|\\$${loop[0]}(?!\\w)`, 'g'), w)) : [stmt];
    for (const v of variants) {
      const r = tempOnlyDelete(v, judgeCtx);
      if (!r.ok) return no(`${v}: ${r.why}`);
    }
    judged++;
  }
  if (!judged && !mentions) return no('no delete in it');
  if (judged !== mentions) return no('a delete it cannot judge (inside quotes, a substitution, xargs, git rm, a path named rm)');
  return { ok: true };
}

/**
 * `bash -c '<script>'` whose script is single-quoted (the outer shell expands nothing in it) and names no delete (w5148: w2210's
 * worker waited on lothsahn for a `bash -c` that ran awk, beside a plain `rm -f` in its temp folder): it runs in a child shell
 * and deletes nothing, so it is judged as `true`. A script with a delete word, or quoted any other way, keeps the
 * nested-shell no.
 */
function literalShells(text: string): string {
  return text.replace(/(^|[\s;&|(])(?:ba|z|da)?sh(?:\.exe)?\s+-c\s+'([^']*)'(?=$|[\s;&|)])/g, (m, pre: string, body: string) =>
    new RegExp(DELETE_WORD.source, 'i').test(body) ? m : `${pre}true`,
  );
}

/**
 * `eval "$(ffu-slot where)"` and `eval "$(ffu-slot take --branch b)"` (w5148: w3966's worker waited 6 and 10 hours on a
 * clean-up that started with one): our own tool's output, `export FFU_SLOT=… FFU_DIR=… CARGO_TARGET_DIR=…` and a `cd` into the
 * slot (machine/ffuSlots.ts envLines), never the temp folder variable. It is judged as a `cd` the command does not know, so a
 * relative delete after it is still a no.
 */
function ffuSlotAsCd(text: string): string {
  return text.replace(/\beval\s+"\$\(ffu-slot\s+(?:where|take)(?:\s+[\w./=-]+)*\s*\)"/g, 'cd ffu-slot');
}

/** Words that change the shell's folder. */
const DIR_CHANGE = /(?:^|[\s;&|(){}])(?:cd|pushd|popd|chdir|set-location|sl|push-location|pop-location)(?=$|[\s;&|()])/gi;

/**
 * The folder the command's relative paths are read against (w5148: w1815's worker waited on Ben six times for `cd
 * $TMPDIR/…/critic && …; rm -f g1/*`): the command starts with `cd <dir>`, the only folder change in it, where `<dir>` is the
 * temp folder or inside it, or the session's sandbox or inside it, with no other variable, `..` or wildcard, and not a link
 * out of them. After `;` (the next statement runs even when cd fails) the folder must exist now. Anything else: none, and a
 * relative delete is a no.
 */
function leadingCd(text: string, ctx: TempDeleteContext): string | undefined {
  if ([...text.matchAll(DIR_CHANGE)].length !== 1) return undefined;
  const m = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s"';&|()<>`]+))\s*(&&|;|\n)/.exec(text);
  if (!m) return undefined;
  const raw = m[1] ?? m[2] ?? m[3];
  if (m[2] !== undefined && /[$%]/.test(raw)) return undefined;
  const tmpRaw = slash(ctx.tmp).replace(/\/+$/, '');
  let p = slash(raw);
  const v = TMP_VAR.exec(p);
  if (v) p = tmpRaw + p.slice(v[0].length);
  if (/[$%`~*?[\]{}]/.test(p) || p.split('/').includes('..') || isRelative(p)) return undefined;
  const d = /^[a-zA-Z]:\//.test(tmpRaw) || /^[a-zA-Z]:/.test(slash(ctx.sandbox ?? ''));
  const within = (x: string, root: string) => norm(x, d) === norm(root, d) || norm(x, d).startsWith(norm(root, d) + '/');
  const sandbox = ctx.sandbox && SANDBOX_DIR.test(slash(ctx.sandbox).replace(/\/+$/, '')) ? slash(ctx.sandbox).replace(/\/+$/, '') : undefined;
  if (!within(p, tmpRaw) && !(sandbox && within(p, sandbox))) return undefined;
  const real = ctx.real ?? ((x: string) => { try { return fs.realpathSync.native(x); } catch { return undefined; } });
  const r = real(p);
  if (m[4] !== '&&' && r === undefined) return undefined;
  if (r !== undefined) {
    const roots = [real(tmpRaw), sandbox && real(sandbox)].filter((x): x is string => !!x);
    if (roots.length && !roots.some((x) => within(r, x))) return undefined;
  }
  return p;
}

/**
 * The names a `for NAME in WORDS; do … done` loop sets, with its words (w5148: w3999's `for d in leg-*; do rm -rf
 * "$TMPDIR/$d/shard"; done`). Each word is a plain name or a wildcard (no `/`, quote, variable or leading dot, so a wildcard
 * never matches `.` or `..`); the name is set nowhere else; and every `$NAME` is in double quotes between that `do` and the
 * next `done`, so it always holds one of those words (or a name they match), never empty and never split.
 */
function loopNames(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of text.matchAll(/(?:^|[\s;&|(])for\s+([A-Za-z_]\w*)\s+in\s+([^;\n]*?)\s*(?:;|\n)\s*do\b/g)) {
    const name = m[1];
    const words = m[2].split(/\s+/).filter(Boolean);
    if (!words.length || !words.every((w) => /^[A-Za-z0-9_*?][\w.*?+@,=-]*$/.test(w))) continue;
    if ([...text.matchAll(new RegExp(`(?<![$\\w{])${name}(?!\\w)`, 'g'))].length !== 1) continue;
    const body = m.index! + m[0].length;
    const done = /(?:^|[\s;&|])done(?=$|[\s;&|)])/g;
    done.lastIndex = body;
    const end = done.exec(text)?.index ?? -1;
    if (end < 0) continue;
    const uses = [...text.matchAll(new RegExp(`\\$\\{${name}\\}|\\$${name}(?!\\w)`, 'g'))].map((u) => u.index!);
    if (uses.every((u) => u > body && u < end && inDoubleQuotes(text, u))) out.set(name, words);
  }
  return out;
}

/** Whether `index` lies inside double quotes at the top level of the text. */
function inDoubleQuotes(text: string, index: number): boolean {
  let q = '';
  for (let i = 0; i < index; i++) {
    const c = text[i];
    if (q === "'") {
      if (c === "'") q = '';
    } else if (q === '"') {
      if (c === '\\') i++;
      else if (c === '"') q = '';
    } else if (c === '\\') i++;
    else if (c === '"' || c === "'") q = c;
  }
  return q === '"';
}

/** `"$(cat FILE)"` where FILE is one plain word. */
const CAT_PATH = /"\$\(cat\s+("?)([^\s"'()`;&|<>*?]+)\1\)"/;
/** What may come before such a delete: a cd, an export or an assignment whose only substitution is another `$(cat FILE)`. */
const CAT_BEFORE = /^(?:cd\s+\S+|(?:export\s+)?[A-Za-z_]\w*=(?:[^$`()<>|&;]|\$\{?[A-Za-z_]\w*\}?|\$\(cat\s+[^\s"'()`;&|<>]+\))*)$/;

/**
 * The delete with each `"$(cat FILE)"` replaced by the one path FILE holds (w5148: w4768's and w4143's workers each waited
 * about 4 hours on `rm -rf "$(cat $TMPDIR/w/clips-head.path)"`). FILE must be inside the temp folder; it is read now and must
 * hold one line, a path with no quote, variable, wildcard or space; and the statements before the delete may only change
 * folder, export or assign (so nothing in the command rewrites FILE before the delete runs). The path is then judged like
 * any other.
 */
function catPaths(stmt: string, before: string[], ctx: TempDeleteContext): string | { why: string } {
  if (!before.every((s) => CAT_BEFORE.test(s.trim()))) return { why: 'something runs before it that could change the file it reads' };
  const read = ctx.read ?? ((p: string) => { try { return fs.statSync(p).size <= 4096 ? fs.readFileSync(p, 'utf8') : undefined; } catch { return undefined; } });
  const tmpRaw = slash(ctx.tmp).replace(/\/+$/, '');
  let out = stmt;
  for (;;) {
    const m = CAT_PATH.exec(out);
    if (!m) return out;
    let f = slash(m[2]);
    const v = TMP_VAR.exec(f);
    if (v) f = tmpRaw + f.slice(v[0].length);
    else if (ctx.base && isRelative(f)) f = `${slash(ctx.base).replace(/\/+$/, '')}/${f}`;
    if (!tempOnlyDelete(`rm -f "${f}"`, { ...ctx, base: undefined, sandbox: undefined }).ok) return { why: `${m[2]} is not a file inside your temp folder` };
    const body = read(f);
    if (body === undefined) return { why: `${m[2]} could not be read` };
    const line = body.replace(/\r?\n$/, '');
    if (!/^[^\s"'`$*?[\]{}()<>|&;~%]+$/.test(line)) return { why: `${m[2]} does not hold one plain path` };
    out = out.slice(0, m.index) + `"${line}"` + out.slice(m.index + m[0].length);
  }
}

/** Claude Code's reason when its dangerous-removal check asks, in every mode (`Dangerous rm operation …`). */
export const DANGEROUS_REMOVAL = /^Dangerous (?:rm|rmdir|remove-item|\S+) operation\b/i;
