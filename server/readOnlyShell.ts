import path from 'node:path';
import { GIT_READ_ONLY } from './mainCloneGuard.ts';

/**
 * w5148 (lothsahn, 2026-11-22: "I just got a bash request. Figure out why I get those and how to cut them down 90%"): a Bash
 * command that only reads is answered by the session itself when Claude Code asks about it in bypass mode. Workers run in
 * bypass mode, where Claude Code asks only when one of its own safety checks trips or cannot run: its permission check
 * did not finish (it could not parse zsh's `${(f)P}`; w5129's worker waited 4 h on lothsahn for a chain of greps), or its
 * dangerous-rm check fired. A command this file reads as nothing but reads (grep, sed -n, git log, cut, head, ...), with
 * every `$(...)` inside it read-only too and every redirect going to /dev/null or the session's own temp folder, deletes
 * nothing and writes nothing outside the temp folder, so neither check had anything to find in it. Our own guards
 * (server/guard.ts and its seatbelts: the main clone, C: scans, secrets, the daemon's folder) are PreToolUse hooks: they ran
 * before Claude Code asked, and still refuse what they refuse.
 *
 * It is a strict reader, never a blanket allow: a verb it does not know, a flag that writes (`sed -i`, `sort -o`,
 * `find -delete`, `git diff --output`), a command named by a variable, eval, a nested shell, an unquoted heredoc, a
 * background job, an arithmetic expansion over names, a zsh `(e)` flag or glob qualifier, an assignment to PATH or a GIT_*
 * variable, or anything it cannot parse, is a no, and the question goes to a person as before.
 */
export interface ReadOnlyContext {
  /** The session's temp folder (TMPDIR): a redirect may write inside it. */
  tmp?: string;
}

export type ReadOnlyVerdict = { ok: true } | { ok: false; why: string };

const no = (why: string): ReadOnlyVerdict => ({ ok: false, why });

interface Word {
  /** The word with quotes removed and substitutions kept as text (`$(…)` stays `$(…)`). */
  text: string;
  /** It holds an expansion (`$x`, `${x}`, `$(…)`, a backquote) outside single quotes. */
  dynamic: boolean;
  /** Every character came from single quotes or is plain text with no expansion. */
  literal: boolean;
}
type Tok = { k: 'word'; w: Word } | { k: 'op'; op: string } | { k: 'redir'; op: string; target?: Word };

class Bad extends Error {}

/** A command substitution's inner text, for the reader to judge as a command of its own. */
type Subs = string[];

/** The end (index of the closing paren) of a `$(` or `<(` that opens at `start` (the index after the paren). */
function closeParen(s: string, start: number): number {
  let depth = 1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === "'") {
      const e = s.indexOf("'", i + 1);
      if (e < 0) throw new Bad('an unbalanced quote');
      i = e;
      continue;
    }
    if (c === '"') {
      i = closeDouble(s, i + 1);
      continue;
    }
    if (c === '`') {
      const e = closeBack(s, i + 1);
      i = e;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  throw new Bad('a substitution with no end');
}

/** The index of the closing `"` of a double-quoted string that starts at `start`. */
function closeDouble(s: string, start: number): number {
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === '"') return i;
    else if (c === '`') i = closeBack(s, i + 1);
    else if (c === '$' && s[i + 1] === '(') i = closeParen(s, i + 2);
    else if (c === '$' && s[i + 1] === '{') i = closeBrace(s, i + 2);
  }
  throw new Bad('an unbalanced quote');
}

function closeBack(s: string, start: number): number {
  for (let i = start; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '`') return i;
  }
  throw new Bad('an unbalanced backquote');
}

function closeBrace(s: string, start: number): number {
  let depth = 1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === "'") {
      const e = s.indexOf("'", i + 1);
      if (e < 0) throw new Bad('an unbalanced quote');
      i = e;
    } else if (c === '"') i = closeDouble(s, i + 1);
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  throw new Bad('a ${ with no end');
}

/** A `${…}` expansion's inner text: a no when it can run code or carries a substitution. */
function checkParam(inner: string): void {
  if (/\$\(|`/.test(inner)) throw new Bad('a substitution inside ${…}');
  // zsh's (e) flag evaluates the value as a command line; bash's @P runs prompt expansion, which can run substitutions.
  const flags = /^\(([^)]*)\)/.exec(inner);
  if (flags && /e/.test(flags[1])) throw new Bad('a zsh (e) flag');
  if (/@[A-Za-z]/.test(inner)) throw new Bad('a ${…@…} transformation');
  // An array subscript is arithmetic in bash, which can expand a name whose value runs code: only a number or @ / *.
  const sub = /\[([^\]]*)\]/.exec(inner);
  if (sub && !/^(?:-?\d+|@|\*)$/.test(sub[1].trim())) throw new Bad('an array subscript that is not a number');
}

/** `$((…))`: only numbers and operators (a name inside is evaluated recursively by bash, and can run code). */
function checkArith(inner: string): void {
  if (/[A-Za-z_$`[\]]/.test(inner)) throw new Bad('arithmetic over names');
}

const OPS = ['&&', '||', ';;', '|&', ';', '|', '&', '(', ')'];
const REDIR = /^(?:\d*(?:>>|>&|>\||<<<|<<-|<<|<&|<>|>|<)|&>>|&>)/;

/** The tokens of a command line; substitutions' inner text goes to `subs`. */
function lex(src: string, subs: Subs): Tok[] {
  const out: Tok[] = [];
  const heredocs: { delim: string; strip: boolean }[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '\\' && src[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (c === '\n') {
      out.push({ k: 'op', op: ';' });
      i++;
      // The bodies of the heredocs opened on that line: data for the verb, skipped to their delimiter.
      while (heredocs.length) {
        const h = heredocs.shift()!;
        for (;;) {
          if (i >= n) throw new Bad('a heredoc with no end');
          const e = src.indexOf('\n', i);
          const line = src.slice(i, e < 0 ? n : e);
          i = e < 0 ? n : e + 1;
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
        }
      }
      continue;
    }
    if (c === '#') {
      const e = src.indexOf('\n', i);
      i = e < 0 ? n : e;
      continue;
    }
    const r = REDIR.exec(src.slice(i));
    if (r && !(src[i + r[0].length] === '(' && /[<>]$/.test(r[0]))) {
      i += r[0].length;
      while (src[i] === ' ' || src[i] === '\t') i++;
      if (/^\d*>&$|^\d*<&$/.test(r[0]) && /^(?:\d+|-)(?=$|[\s;&|)])/.test(src.slice(i))) {
        const m = /^(?:\d+|-)/.exec(src.slice(i))![0];
        i += m.length;
        out.push({ k: 'redir', op: r[0], target: { text: m, dynamic: false, literal: true } });
        continue;
      }
      const [w, next] = word(src, i, subs);
      if (!w) throw new Bad(`a redirect with no target`);
      i = next;
      if (/<<-?$/.test(r[0])) {
        // Only a quoted delimiter ('EOF', "EOF", \EOF) keeps the body from being expanded.
        if (!w.literal || !/['"\\]/.test(lastWordRaw)) throw new Bad('a heredoc whose body is expanded (quote its delimiter)');
        heredocs.push({ delim: w.text, strip: r[0].endsWith('-') });
      }
      out.push({ k: 'redir', op: r[0], target: w });
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      if (op === ';;') throw new Bad('a case statement');
      if (op === '|&') throw new Bad('|&');
      if (op === '&') throw new Bad('a background job');
      out.push({ k: 'op', op });
      i += op.length;
      continue;
    }
    const [w, next] = word(src, i, subs);
    if (!w) throw new Bad(`an unexpected ${c}`);
    out.push({ k: 'word', w });
    i = next;
  }
  if (heredocs.length) throw new Bad('a heredoc with no body');
  return out;
}

/** The raw text of the last word `word` read (to tell a quoted heredoc delimiter). */
let lastWordRaw = '';

/** One word from `i`: its text, and the index after it. */
function word(s: string, i: number, subs: Subs): [Word | undefined, number] {
  const start = i;
  let text = '';
  let dynamic = false;
  let literal = true;
  while (i < s.length) {
    const c = s[i];
    if (/[\s;&|<>()]/.test(c)) {
      if (c === '(' || c === ')') {
        // `)` closes a subshell or a group; a `(` that opens one stands alone.
        if (i === start || c === ')') break;
        // `*(e:…:)` is a zsh glob qualifier that runs code, `@(a|b)` an extglob: a parenthesis inside a word is a no.
        throw new Bad('a parenthesis inside a word');
      }
      if ((c === '<' || c === '>') && s[i + 1] === '(' && i === start) {
        if (c === '>') throw new Bad('a >(…) process substitution');
        const e = closeParen(s, i + 2);
        subs.push(s.slice(i + 2, e));
        text += s.slice(i, e + 1);
        dynamic = true;
        literal = false;
        i = e + 1;
        continue;
      }
      break;
    }
    if (c === "'") {
      const e = s.indexOf("'", i + 1);
      if (e < 0) throw new Bad('an unbalanced quote');
      text += s.slice(i + 1, e);
      i = e + 1;
      continue;
    }
    if (c === '$' && s[i + 1] === "'") {
      // $'…': ANSI-C quoting, no expansion.
      let j = i + 2;
      for (; j < s.length && s[j] !== "'"; j++) if (s[j] === '\\') j++;
      if (j >= s.length) throw new Bad('an unbalanced quote');
      text += s.slice(i + 2, j);
      i = j + 1;
      continue;
    }
    if (c === '"') {
      const e = closeDouble(s, i + 1);
      const inner = s.slice(i + 1, e);
      scanExpansions(inner, subs);
      if (/[$`]/.test(inner.replace(/\\[$`\\"]/g, ''))) {
        dynamic = true;
        literal = false;
      }
      text += inner.replace(/\\([$`\\"])/g, '$1');
      i = e + 1;
      continue;
    }
    if (c === '\\') {
      text += s[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (c === '`' || c === '$') {
      const e = expansionEnd(s, i, subs);
      text += s.slice(i, e);
      dynamic = true;
      literal = false;
      i = e;
      continue;
    }
    text += c;
    i++;
  }
  lastWordRaw = s.slice(start, i);
  return i === start ? [undefined, i] : [{ text, dynamic, literal }, i];
}

/** Where an expansion that starts at `i` (`$x`, `${…}`, `$(…)`, `$((…))`, a backquote) ends; command substitutions go to `subs`. */
function expansionEnd(s: string, i: number, subs: Subs): number {
  if (s[i] === '`') {
    const e = closeBack(s, i + 1);
    subs.push(s.slice(i + 1, e).replace(/\\([`$\\])/g, '$1'));
    return e + 1;
  }
  if (s.startsWith('$((', i)) {
    // closeParen from the second `(` counts it too, so `e` is the `)` that closes `$(`.
    const e = closeParen(s, i + 2);
    if (s[e - 1] === ')') checkArith(s.slice(i + 3, e - 1));
    else subs.push(s.slice(i + 2, e)); // `$( (…) )`: a substitution whose command is a subshell
    return e + 1;
  }
  if (s.startsWith('$(', i)) {
    const e = closeParen(s, i + 2);
    subs.push(s.slice(i + 2, e));
    return e + 1;
  }
  if (s.startsWith('${', i)) {
    const e = closeBrace(s, i + 2);
    checkParam(s.slice(i + 2, e));
    return e + 1;
  }
  const m = /^\$(?:[A-Za-z_]\w*|[0-9@*#?$!-])/.exec(s.slice(i));
  return i + (m ? m[0].length : 1);
}

/** The expansions inside a double-quoted string, checked and their substitutions collected. */
function scanExpansions(inner: string, subs: Subs): void {
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '\\') i++;
    else if (c === '`' || c === '$') i = expansionEnd(inner, i, subs) - 1;
  }
}

// ------------------------------------------------------------------------------------------------------------ verbs

type Check = (args: Word[]) => string | undefined;
const any: Check = () => undefined;

/** sed scripts that only print or delete lines of the output: `366,470p`, `/x/p`, `$d`, `s/a/b/g`. */
const SED_ADDR = String.raw`(?:\d+|\$|/(?:[^/\\]|\\.)*/)`;
const SED_SAFE = new RegExp(String.raw`^\s*(?:${SED_ADDR}(?:\s*,\s*${SED_ADDR})?\s*!?\s*[pdq=]|s(/(?:[^/\\\n]|\\.)*){2}/[gpiI0-9]*)\s*(?:;\s*(?:${SED_ADDR}(?:\s*,\s*${SED_ADDR})?\s*!?\s*[pdq=]|s(/(?:[^/\\\n]|\\.)*){2}/[gpiI0-9]*)\s*)*;?\s*$`);

const sed: Check = (args) => {
  let script = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i].text;
    if (a === '-n' || a === '-E' || a === '-r' || a === '--quiet' || a === '--silent' || a === '-u' || a === '-z' || a === '--posix' || a === '-s') continue;
    if (a === '-e' || a === '--expression') {
      const v = args[++i];
      if (!v || !SED_SAFE.test(v.text)) return `sed script ${v?.text ?? ''}`;
      script = true;
      continue;
    }
    if (a.startsWith('-')) return `sed ${a}`;
    if (!script) {
      if (!SED_SAFE.test(a)) return `sed script ${a}`;
      script = true;
    }
  }
  return script ? undefined : 'sed with no script';
};

const find: Check = (args) => {
  const bad = args.find((a) => /^-(?:exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/.test(a.text));
  return bad ? `find ${bad.text}` : undefined;
};

const sort: Check = (args) => {
  const bad = args.find((a) => /^-[^-]*o|^--(?:output|compress-program)/.test(a.text));
  return bad ? `sort ${bad.text}` : undefined;
};

const operands = (args: Word[]) => args.filter((a) => !a.text.startsWith('-') || a.text === '-');
const uniq: Check = (args) => (operands(args).length > 1 ? 'uniq with an output file' : undefined);
const rg: Check = (args) => {
  const bad = args.find((a) => /^--pre(?:-glob)?(?:=|$)/.test(a.text));
  return bad ? `rg ${bad.text}` : undefined;
};
const date: Check = (args) => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i].text;
    if (a.startsWith('+') || /^-(?:u|R|I\w*)$|^--(?:utc|iso-8601(?:=\w+)?|rfc-\d+(?:=\w+)?|date=.*|reference=.*)$/.test(a)) continue;
    if (a === '-d' || a === '-r' || a === '--date' || a === '--reference') {
      i++;
      continue;
    }
    return `date ${a}`;
  }
  return undefined;
};
const command: Check = (args) => (args[0] && /^-[vV]$/.test(args[0].text) ? undefined : 'command that runs a command');

/** Where a write may go: /dev/null, or strictly inside the session's temp folder. */
function writeTarget(w: Word, ctx: ReadOnlyContext): string | undefined {
  if (/^(?:\/dev\/null|\/dev\/stdout|\/dev\/stderr|nul)$/i.test(w.text)) return undefined;
  if (!ctx.tmp) return `a write to ${w.text}`;
  const tmp = ctx.tmp.replace(/\\/g, '/').replace(/\/+$/, '');
  let p = w.text.replace(/\\/g, '/');
  const v = /^\$(?:\{(?:TMPDIR|TMP|TEMP)\}|(?:TMPDIR|TMP|TEMP))(?=\/)/i.exec(p);
  if (v) p = tmp + p.slice(v[0].length);
  if (/[$`*?[\]{}~]/.test(p)) return `a write to ${w.text}`;
  const drive = /^[a-zA-Z]:\//.test(tmp);
  const norm = (x: string) => {
    let s = path.posix.normalize(x).replace(/\/+$/, '');
    if (drive) s = s.replace(/^\/([a-zA-Z])(?=\/)/, '$1:');
    return s.toLowerCase();
  };
  if (p.split('/').includes('..')) return `a write to ${w.text}`;
  return norm(p).startsWith(norm(tmp) + '/') ? undefined : `a write to ${w.text} (outside your temp folder)`;
}

const tee =
  (ctx: ReadOnlyContext): Check =>
  (args) => {
    for (const a of args) {
      if (a.text === '-a' || a.text === '--append') continue;
      if (a.text.startsWith('-')) return `tee ${a.text}`;
      const why = writeTarget(a, ctx);
      if (why) return why;
    }
    return undefined;
  };

const git: Check = (args) => {
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i].text;
    if (a === '-C') {
      i++;
      continue;
    }
    if (a === '--no-pager' || a === '-P' || a === '--no-optional-locks' || a === '--literal-pathspecs') continue;
    break;
  }
  const sub = args[i]?.text;
  if (!sub || !GIT_READ_ONLY.has(sub)) return `git ${sub ?? ''}`.trim();
  const bad = args.slice(i + 1).find((a) => /^--(?:output|open-files-in-pager|ext-diff|exec)(?:=|$)|^-O/.test(a.text));
  return bad ? `git ${sub} ${bad.text}` : undefined;
};

const VERBS = (ctx: ReadOnlyContext): Record<string, Check> => ({
  cat: any, head: any, tail: any, wc: any, cut: any, tr: any, ls: any, echo: any, printf: any, print: any, pwd: any, cd: any,
  pushd: any, popd: any, test: any, '[': any, true: any, false: any, ':': any, basename: any, dirname: any, realpath: any,
  readlink: any, stat: any, file: any, du: any, df: any, diff: any, cmp: any, comm: any, nl: any, tac: any, rev: any, seq: any,
  jq: any, cygpath: any, which: any, type: any, column: any, fold: any, paste: any, join: any, md5sum: any, sha1sum: any,
  sha256sum: any, shasum: any, cksum: any, whoami: any, hostname: any, uname: any, id: any, tree: any, grep: any, egrep: any,
  fgrep: any, zgrep: any, zcat: any, sleep: any, read: any, shift: any, break: any, continue: any, return: any, exit: any,
  unset: any, wait: any,
  sed, find, sort, uniq, rg, date, command, git, tee: tee(ctx),
});

/** Names whose value changes what a later program runs or where the temp folder is. */
const BAD_NAME = /^(?:PATH|BASH_ENV|ENV|LD_\w+|DYLD_\w+|PROMPT_COMMAND|PS\d|GIT_\w+|PAGER|LESSOPEN|LESSCLOSE|EDITOR|VISUAL|SHELLOPTS|BASHOPTS|CDPATH|FPATH|ZDOTDIR|TMPDIR|TMP|TEMP|IFS|RIPGREP_CONFIG_PATH|GREP_OPTIONS)$/i;
const ASSIGN = /^([A-Za-z_]\w*)(?:\[[^\]]*\])?\+?=/;

/**
 * Whether a Bash command only reads (and writes, if at all, inside the temp folder): see the file comment.
 */
export function readOnlyShell(cmd: string, ctx: ReadOnlyContext = {}): ReadOnlyVerdict {
  if (cmd.length > 8000) return no('a long command');
  try {
    judge(cmd, ctx, 0);
    return { ok: true };
  } catch (e) {
    if (e instanceof Bad) return no(e.message);
    return no(`it could not be read (${e instanceof Error ? e.message : String(e)})`);
  }
}

function judge(src: string, ctx: ReadOnlyContext, depth: number): void {
  if (depth > 6) throw new Bad('substitutions nested too deep');
  const subs: Subs = [];
  lastWordRaw = '';
  const toks = lex(src, subs);
  const verbs = VERBS(ctx);
  let i = 0;
  /** At the start of a statement: a keyword, an assignment or a verb may come. */
  let start = true;
  let parens = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (t.k === 'op') {
      if (t.op === '(') {
        if (!start) throw new Bad('a ( after a command');
        parens++;
      } else if (t.op === ')') {
        if (--parens < 0) throw new Bad('an unbalanced )');
      }
      start = t.op !== ')';
      i++;
      continue;
    }
    if (t.k === 'redir') {
      checkRedir(t, ctx);
      i++;
      continue;
    }
    const w = t.w;
    if (start && !w.dynamic) {
      if (['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{'].includes(w.text)) {
        i++;
        continue;
      }
      if (['fi', 'done', '}'].includes(w.text)) {
        start = false;
        i++;
        continue;
      }
      if (w.text === 'for') {
        const name = toks[i + 1];
        if (name?.k !== 'word' || !/^[A-Za-z_]\w*$/.test(name.w.text) || BAD_NAME.test(name.w.text)) throw new Bad('a for loop over a name it cannot read');
        i += 2;
        if (toks[i]?.k === 'word' && (toks[i] as { w: Word }).w.text === 'in') {
          i++;
          while (toks[i]?.k === 'word') i++;
        }
        continue;
      }
      if (['case', 'select', 'function', 'coproc', 'time', 'eval', 'exec', 'source', '.', 'alias', 'trap', 'builtin', 'enable', 'let', '[[', '((', 'set', 'shopt', 'setopt', 'emulate', 'autoload', 'zmodload', 'bindkey', 'hash', 'ulimit', 'umask', 'disown', 'nohup', 'env', 'sudo', 'xargs'].includes(w.text)) {
        throw new Bad(`${w.text}`);
      }
    }
    if (start) {
      // Leading assignments: `K=$(…)`, `A=(a b)`, `export N=v`.
      const a = ASSIGN.exec(w.text);
      if (a && !w.text.startsWith('=')) {
        if (BAD_NAME.test(a[1])) throw new Bad(`it sets ${a[1]}`);
        i++;
        if (w.text.endsWith('=') && toks[i]?.k === 'op' && (toks[i] as { op: string }).op === '(') {
          i++;
          while (toks[i]?.k === 'word') i++;
          if (toks[i]?.k !== 'op' || (toks[i] as { op: string }).op !== ')') throw new Bad('an array it cannot read');
          i++;
        }
        continue;
      }
      if (['export', 'local', 'declare', 'typeset', 'readonly'].includes(w.text) && !w.dynamic) {
        i++;
        while (toks[i]?.k === 'word') {
          const x = (toks[i] as { w: Word }).w;
          const name = ASSIGN.exec(x.text)?.[1] ?? (/^[A-Za-z_]\w*$/.test(x.text) ? x.text : undefined);
          if (name && BAD_NAME.test(name)) throw new Bad(`it sets ${name}`);
          if (!name && !/^-[a-zA-Z]+$/.test(x.text)) throw new Bad(`${w.text} ${x.text}`);
          if (/^-\w*[fn]/.test(x.text)) throw new Bad(`${w.text} ${x.text}`);
          i++;
        }
        start = false;
        continue;
      }
      if (w.dynamic) throw new Bad(`a command named by a variable (${w.text})`);
      const verb = path.posix.basename(w.text.replace(/\\/g, '/')).replace(/\.exe$/i, '');
      const check = Object.prototype.hasOwnProperty.call(verbs, verb) ? verbs[verb] : undefined;
      if (!check) throw new Bad(`${verb} is not a read-only command it knows`);
      const args: Word[] = [];
      i++;
      while (i < toks.length && toks[i].k !== 'op') {
        const x = toks[i];
        if (x.k === 'redir') checkRedir(x, ctx);
        else if (x.k === 'word') args.push(x.w);
        i++;
      }
      const why = check(args);
      if (why) throw new Bad(why);
      start = false;
      continue;
    }
    throw new Bad(`an unexpected word ${w.text}`);
  }
  if (parens) throw new Bad('an unbalanced (');
  for (const s of subs) judge(s, ctx, depth + 1);
}

function checkRedir(t: { op: string; target?: Word }, ctx: ReadOnlyContext): void {
  if (/^\d*(?:<|<<<|<&|<<-?)$/.test(t.op)) return; // reads, a here-string, a duplicated input, a quoted heredoc
  if (/^\d*>&$/.test(t.op) && t.target && /^(?:\d+|-)$/.test(t.target.text)) return;
  if (t.op === '<>' ) throw new Bad('a <> redirect');
  if (!t.target) throw new Bad('a redirect with no target');
  const why = writeTarget(t.target, ctx);
  if (why) throw new Bad(why);
}
