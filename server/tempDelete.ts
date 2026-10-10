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
const SAVES_DIR = /\/appdata\/locallow\/never games\/finalfactory[^/]*\/saves\/([^/*?]+)$/i;

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
    else if (/[$%`]/.test(p)) return `${raw} has a variable that is not the temp folder`;
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
