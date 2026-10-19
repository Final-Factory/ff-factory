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
 * Windows (AppData/LocalLow), Linux (~/.config/unity3d) and macOS (Library/Application Support) (w1505).
 */
const SAVES_DIR = /\/(?:appdata\/locallow|\.config\/unity3d|library\/application support)\/never games\/finalfactory[^/]*\/(?:userdata\/)?saves\/([^/*?]+)$/i;

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
  const real = ctx.real ?? ((p: string) => { try { return fs.realpathSync(p); } catch { return undefined; } });
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
  const insideTmp = (raw: string, literal: boolean): string | undefined => {
    if (literal && /[$%]/.test(raw)) return `${raw} is single-quoted, so its variable is not expanded`;
    let p = raw;
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
        if (why !== undefined && !ownSave(a.text)) return no(why);
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
            if (why !== undefined && !ownSave(val)) return no(why);
            continue;
          }
          return no(`Remove-Item parameter ${a}`);
        }
        if (a.includes(',')) return no('Remove-Item with a list of paths');
        n++;
        const why = insideTmp(a, args[i].literal);
        if (why !== undefined && !ownSave(a)) return no(why);
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
  [/(?<![$\w{:])(?:TMPDIR|TMP|TEMP|PATH|BASH_ENV|ENV|CDPATH)\s*\+?=|\b(?:export|unset|declare|typeset|local|readonly|read|for)\b[^;&|\n]*(?<![$\w{:])(?:TMPDIR|TMP|TEMP|PATH)\b|\$env:(?:TMP|TEMP|TMPDIR|PATH)\s*=/i, 'it changes the temp folder variable or PATH'],
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
  const text = stripComments(cmd);
  for (const [re, why] of COMPOUND_REFUSED) if (re.test(text)) return no(why);
  const stmts = allStatements(text);
  if (!stmts) return no('an unbalanced quote');
  const mentions = [...text.matchAll(DELETE_WORD)].length;
  let judged = 0;
  for (const raw of stmts) {
    const stmt = raw.replace(LEADING, '');
    const verb = path.posix.basename(slash(stmt.split(/\s+/)[0] ?? '')).replace(/\.exe$/i, '').toLowerCase();
    if (!RM_VERBS.has(verb) && !PS_VERBS.has(verb)) continue;
    if (/[(){}]/.test(stmt.replace(/\{[^{}/]*\}/g, ''))) return no(`${stmt} has a parenthesis or a brace`);
    const r = tempOnlyDelete(stmt, ctx);
    if (!r.ok) return no(`${stmt}: ${r.why}`);
    judged++;
  }
  if (!judged && !mentions) return no('no delete in it');
  if (judged !== mentions) return no('a delete it cannot judge (inside quotes, a substitution, xargs, git rm, a path named rm)');
  return { ok: true };
}

/** Claude Code's reason when its dangerous-removal check asks, in every mode (`Dangerous rm operation …`). */
export const DANGEROUS_REMOVAL = /^Dangerous (?:rm|rmdir|remove-item|\S+) operation\b/i;
