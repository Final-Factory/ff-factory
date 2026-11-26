/**
 * w6008 (lothsahn, w5823: "under no circumstances should workers write outside of ffw"): a worker's shell writes nothing into
 * the system temp folders (/tmp, /var/tmp, /private/tmp, /var/folders on Linux and macOS; Git Bash's /tmp, AppData\Local\Temp
 * and C:\Windows\Temp on Windows). Its own temp folder ($TMPDIR, `ffa-<session>` inside the worker install folder) is where
 * scratch files go.
 *
 * Found by w5834's hour diff of biscuit's /tmp (2026-11-26 08:49-09:52 UTC): the one new entry was /tmp/bq_head.ts, 0 bytes,
 * made at 09:27:04 by the w5973 worker running `git show HEAD:machine/benchQueue.ts > /tmp/bq_head.ts`. Its shell printed
 * Permission denied (the OS write fence) yet the redirect had already created the empty file, which no worker may delete.
 *
 * What counts as a write, read from the command's text (a SEATBELT like the rest of the guard: a script, a python open() or a
 * variable it cannot resolve are not seen): an output redirection (`>`, `>>`, `2>`, `&>`, `*>`, glued or spaced), a write verb
 * (tee, Tee-Object, Out-File, Set-Content, Add-Content, New-Item, touch, mkdir, ...), the destination of cp / Copy-Item / xcopy /
 * robocopy / rsync / install / ln and both ends of a move, a delete there (rm, Remove-Item, ...: delete nothing in /tmp either),
 * mktemp given a folder or template there, a tool's output flag (`-o`, `--output`, `-OutFile`, `--log-file`, `-logFile`,
 * `--out-dir`, `dd of=`, `unzip -d`, `tar -C` on extract), and `git clone` / `git worktree add` into one. `cd /tmp` first makes
 * the relative paths after it count, and `bash -c` / `powershell -Command` strings are read too.
 *
 * Never judged a write there: a path inside the worker install folder, the worker's own temp folder or its sandbox (so a
 * $TMPDIR or %TEMP% that the worker's env points inside ffw is fine, whatever it spells), a read of a temp path (cat, cp's
 * source), and `mktemp` with no folder (it uses $TMPDIR).
 *
 * Shipped warn-only (lothsahn's lockout rule: warn first, enforce in a separate, independently reviewed change):
 * tmpWriteHook is a PostToolUse hook that tells the worker what it wrote and where its temp folder is, and logs one line
 * (`tmp write fence (w6008, warn): ...`) so the would-be refusals can be counted before the enforcing change adds
 * checkSystemTempWrite to the PreToolUse guard (server/guard.ts). Nothing is refused, so no worker can be locked out by it.
 */
import os from 'node:os';
import path from 'node:path';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { SHELL_PAYLOAD_FLAGS, SUBSTITUTION, statements, unquote, verbOf, words } from './rootFence.ts';

export interface TmpWriteContext {
  /** The machine's worker install folder (FF_WORKER_ROOT): never a system temp folder for this rule. */
  root?: string;
  /** The worker's own temp folder (TMPDIR of its shell). */
  temp?: string;
  /** The worker's sandbox. */
  sandbox?: string;
  /** The command's working directory, for relative paths. */
  cwd?: string;
  /** The worker's shell environment: $TMPDIR, $TMP, $TEMP, $env:TEMP, %TEMP%, $HOME and $LOCALAPPDATA resolve through it. */
  env?: Record<string, string | undefined>;
  /** The user's home folder. Default: env HOME / USERPROFILE, else os.homedir(). */
  home?: string;
  /** Windows rules for MSYS paths (/c/Users/...). Default: the root (or temp) is a drive path. */
  win?: boolean;
}

/** One write the fence saw: the path as written and as it resolved. */
export interface TempWrite {
  raw: string;
  path: string;
  /** What wrote it: 'redirect', the verb ('tee', 'cp', 'mktemp', ...), or `<verb> <flag>` for an output flag. */
  how: string;
}

/** The system temp folders, as normalised paths (forward slashes, lower case): POSIX ones on every OS, Windows ones by shape. */
const POSIX_TEMP = /^(?:\/private)?(?:\/tmp|\/var\/tmp|\/var\/folders)(?:\/|$)/;
const WIN_TEMP = /^[a-z]:\/(?:windows\/temp|users\/[^/]+\/appdata\/local\/temp|documents and settings\/[^/]+\/local settings\/temp)(?:\/|$)/;

/** Whether a normalised absolute path is in a system temp folder. */
export function isSystemTemp(n: string): boolean {
  return POSIX_TEMP.test(n) || WIN_TEMP.test(n);
}

const norm = (p: string) => path.posix.normalize(p.replace(/\\/g, '/')).replace(/(.)\/+$/, '$1').toLowerCase();
const inside = (n: string, d: string) => n === d || n.startsWith(d + '/');

/** Verbs whose every path argument is written, created or removed. */
const WRITE_ALL = new Set([
  'tee', 'tee-object', 'out-file', 'set-content', 'sc', 'add-content', 'ac', 'new-item', 'ni', 'clear-content', 'clc', 'set-item',
  'touch', 'mkdir', 'md', 'truncate', 'export-csv', 'export-clixml', 'out-string', 'start-transcript', 'screencapture',
  'mv', 'move', 'move-item', 'mi', 'ren', 'rename', 'rename-item', 'rni',
  'rm', 'rmdir', 'unlink', 'rd', 'del', 'erase', 'remove-item', 'ri', 'shred',
]);
/** Verbs that write their last path (or -Destination / -t / --target-directory's). */
const WRITE_LAST = new Set(['cp', 'copy', 'copy-item', 'cpi', 'xcopy', 'rsync', 'scp', 'install', 'ln', 'new-temporaryfile']);
/** Flags whose value is a value, not a path (so `tee -a`, `cp -t DIR` are read right). */
const VALUE_FLAGS = new Set(['-erroraction', '-ea', '-encoding', '-include', '-exclude', '-filter', '-itemtype', '-type', '-value', '-m', '--mode', '-s', '--size']);
/** A destination flag of a copy (cp -t DIR, Copy-Item -Destination DIR). */
const DEST_FLAG = /^(?:-destination|-dest|-t|--target-directory)$/i;
/** The verbs whose -t / --target-directory is the target folder (rsync's -t keeps times, scp's -t is its sink mode). */
const TARGET_T = new Set(['cp', 'mv', 'install', 'ln']);
/** Output flags of any tool: their value is a file or folder the tool writes. */
const OUT_FLAG = /^(?:--output|--out|--outfile|--out-file|--output-file|-outfile|-outputfile|--output-dir|--output-directory|--out-dir|--outdir|-outputdirectory|-outdir|--log-file|--logfile|-logfile|--target-dir|--destination|--junit-xml|-testresults|--results-dir|-destinationpath|-transcriptpath)$/i;
/** Tools whose short -o (wget's -O too) is the file they write; elsewhere -o is often a switch (grep -o, git ls-files -o). */
const SHORT_O = new Set(['curl', 'wget', 'sort', 'gcc', 'g++', 'cc', 'clang', 'clang++', 'go', 'rustc', 'pandoc', 'zstd', 'xz', 'gh', 'uv', 'pip']);

/** Expands the variables a path starts with through the worker's env, or undefined when one is unknown. */
function expand(p: string, env: Record<string, string | undefined>, home: string): string | undefined {
  const get = (name: string) => {
    const k = name.toUpperCase();
    if (k === 'HOME' || k === 'USERPROFILE') return env[name] ?? env[k] ?? home;
    if (k === 'LOCALAPPDATA') return env.LOCALAPPDATA ?? `${home}/AppData/Local`;
    return env[name] ?? env[k] ?? Object.entries(env).find(([e]) => e.toUpperCase() === k)?.[1];
  };
  // An unset variable (a loop's `$c`, `$(...)`'s $SUB) after a literal folder leaves the folder known: `> /tmp/mt_$c.txt`
  // writes in /tmp whatever $c is (w6050's replay of real commands). One before any folder (`$X/out`) leaves nothing known.
  const UNSET = String.fromCharCode(0);
  let out = p;
  for (let n = 0; n < 4; n++) {
    const next = out
      .replace(/^~(?=$|[\\/])/, () => home)
      .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|%([A-Za-z_][A-Za-z0-9_]*)%/g, (_m, a, b, c, d) => {
        const v = get(a ?? b ?? c ?? d);
        return v ?? UNSET;
      });
    if (next === out) break;
    out = next;
  }
  const at = out.indexOf(UNSET);
  if (at >= 0) {
    const head = out.slice(0, at);
    const cut = Math.max(head.lastIndexOf('/'), head.lastIndexOf('\\'));
    if (cut <= 0) return undefined;
    out = head.slice(0, cut + 1) + 'unset';
  }
  return /[$`%]/.test(out) ? undefined : out;
}

/** Where the first `>` outside quotes is in a word (not `->` or `=>`), or -1. */
function unquotedGt(raw: string): number {
  let q = '';
  for (let j = 0; j < raw.length; j++) {
    const c = raw[j];
    if (q) {
      if (c === '\\' && q === '"') j++;
      else if (c === q) q = '';
    } else if (c === '"' || c === "'") q = c;
    else if (c === '\\') j++;
    else if (c === '>' && !/[-=]/.test(raw[j - 1] ?? '')) return j;
  }
  return -1;
}

/** The written paths of one statement's output redirections (`> x`, `>>x`, `2>x`, `&>x`, `*> x`, `echo hi>x`); `2>&1` none. */
function redirects(w: string[]): string[] {
  const out: string[] = [];
  for (let k = 0; k < w.length; k++) {
    const raw = w[k];
    if (raw.startsWith('-')) continue;
    // Only the part before any quote: a `>` inside quotes is text, not a redirection. `->` and `=>` are text too.
    const at = unquotedGt(raw);
    if (at < 0) continue;
    const t = raw.slice(at + 1).replace(/^>?\|?/, '') || w[++k];
    if (t && !t.startsWith('&') && !t.startsWith('(')) out.push(t);
  }
  return out;
}

/** The flag's value: `--out=x`, `-OutFile:x`, `-ox` for -o, or the next word. Returns [value, words used]. */
function flagValue(args: string[], i: number): [string | undefined, number] {
  const a = unquote(args[i]);
  const inline = /^-{1,2}[A-Za-z][A-Za-z-]*[=:](.+)$/.exec(a)?.[1];
  if (inline) return [inline, 0];
  return [i + 1 < args.length ? unquote(args[i + 1]) : undefined, 1];
}

/**
 * tar's mode letters: the first word in old style (`tar xzf a.tar`) and every short-option bundle (`-xzf`, `-c`). A file name
 * that starts with x (`tar -czf a.tgz -C /tmp xfile`) is not a mode. Only lower-case letters count (-C is the folder).
 */
function tarModes(w: string[]): string {
  let m = w[0] && /^[A-Za-z]+$/.test(w[0]) ? w[0] : '';
  for (let k = 0; k < w.length; k++) {
    if (/^-[A-Za-z]+$/.test(w[k])) m += w[k].slice(1);
    // -f, -C and -T take the next word: skip it, so a value is never read as a bundle
    if (/^-[A-Za-z]*[fCT]$/.test(w[k])) k++;
  }
  return m;
}

/** git clone's options that take the next word as their value. */
const GIT_CLONE_VALUE = new Set(['-b', '--branch', '--depth', '-o', '--origin', '-c', '--config', '--reference', '--reference-if-able', '-j', '--jobs', '--filter', '--template', '-u', '--upload-pack', '--shallow-since', '--shallow-exclude', '--separate-git-dir', '--server-option', '--bundle-uri']);

/** The paths (as written) a verb's arguments write, with how. */
function writtenBy(verb: string, args: string[]): { raw: string; how: string }[] {
  const out: { raw: string; how: string }[] = [];
  const plain: string[] = [];
  if (verb === 'tar') {
    // tar -czf ARCHIVE / tar czf ARCHIVE / tar -c -f ARCHIVE / --create --file=ARCHIVE: the archive it creates is written
    const w = args.map(unquote);
    const creates = w.some((x) => ['--create', '--append', '--update'].includes(x)) || /[cru]/.test(tarModes(w));
    const f = w.findIndex((x) => /^-?[A-Za-z]*f$/.test(x) && !x.startsWith('--'));
    const long = w.find((x) => /^--file=/.test(x));
    if (creates && long) out.push({ raw: long.slice(7), how: 'tar -f' });
    else if (creates && f >= 0 && w[f + 1]) out.push({ raw: w[f + 1], how: 'tar -f' });
  }
  let flags = true;
  for (let i = 0; i < args.length; i++) {
    const a = unquote(args[i]);
    const low = a.toLowerCase();
    if (/^(?:\d|\*|&)?>/.test(args[i])) {
      // a redirection: redirects() reads it; skip its target word when it stands apart
      if (/^(?:\d|\*|&)?>>?\|?$/.test(args[i])) i++;
      continue;
    }
    if (flags && a === '--') {
      flags = false;
      continue;
    }
    if (flags && a.startsWith('-') && a.length > 1) {
      const name = low.replace(/[=:].*$/, '');
      if (
        OUT_FLAG.test(name) ||
        (name === '-o' && SHORT_O.has(verb)) ||
        (name === '-d' && verb === 'unzip') ||
        // pip install -t DIR / --target DIR; gh run download -D DIR / --dir DIR; zip -b TEMPDIR (w6040)
        (name === '--target' && /^(?:pip|pip3|uv)$/.test(verb)) ||
        (a.startsWith('-t') && name === '-t' && /^(?:pip|pip3)$/.test(verb)) ||
        (verb === 'gh' && (a === '-D' || name === '--dir')) ||
        (verb === 'zip' && name === '-b') || (verb === 'tar' && /^(?:-C|--directory)(?:=|$)/.test(a) && (/x/.test(tarModes(args.map(unquote))) || args.some((x) => ['--extract', '--get'].includes(unquote(x)))))) {
        const [v, used] = flagValue(args, i);
        if (v) out.push({ raw: v, how: `${verb} ${name}` });
        i += used;
        continue;
      }
      // -t is case-sensitive: cp's -T is "no target folder", not -t (w6040)
      if (DEST_FLAG.test(name) && (name !== '-t' || a.startsWith('-t')) && (WRITE_LAST.has(verb) || TARGET_T.has(verb)) && (!/^(?:-t|--target-directory)$/.test(name) || TARGET_T.has(verb))) {
        const [v, used] = flagValue(args, i);
        if (v) out.push({ raw: v, how: verb });
        i += used;
        continue;
      }
      if ((name === '-p' || name === '--tmpdir') && verb === 'mktemp') {
        const [v, used] = name === '--tmpdir' && !/[=]/.test(a) ? [undefined, 0] : flagValue(args, i);
        if (v) out.push({ raw: v, how: 'mktemp' });
        i += used;
        continue;
      }
      if (VALUE_FLAGS.has(name)) i++;
      if (name === '-path' || name === '-literalpath' || name === '-filepath' || name === '-lp') {
        const [v, used] = flagValue(args, i);
        if (v && WRITE_ALL.has(verb)) out.push(...v.split(',').map((raw) => ({ raw, how: verb })));
        i += used;
      }
      continue;
    }
    // dd of=FILE
    if (verb === 'dd' && /^of=/i.test(a)) {
      out.push({ raw: a.slice(3), how: 'dd of=' });
      continue;
    }
    plain.push(a);
  }
  if (WRITE_ALL.has(verb)) out.push(...plain.flatMap((p) => p.split(',').filter(Boolean)).map((raw) => ({ raw, how: verb })));
  else if (WRITE_LAST.has(verb)) {
    const dst = plain.filter((a) => !/^\/[a-zA-Z](?::.*)?$/.test(a) || verb !== 'xcopy');
    if (dst.length) out.push({ raw: dst[dst.length - 1], how: verb });
  } else if (verb === 'robocopy') {
    const p = plain.filter((a) => !a.startsWith('/'));
    if (p[1]) out.push({ raw: p[1], how: verb });
  } else if (verb === 'ffmpeg') {
    if (plain.length) out.push({ raw: plain[plain.length - 1], how: verb });
  } else if (verb === 'mktemp') {
    for (const p of plain) if (/[\\/]/.test(p)) out.push({ raw: p, how: 'mktemp' });
  } else if (verb === 'git') {
    out.push(...gitWrites(args.map(unquote)));
  } else if (verb === 'sed' || verb === 'perl') {
    // sed -i / --in-place (perl -i, -pi) rewrites its files; the script is the first plain word unless -e / -f gave it (w6040)
    const w = args.map(unquote);
    const inPlace = w.some((x) => /^-[A-Za-z]*i/.test(x) && !x.startsWith('--') || /^--in-place(?:=|$)/.test(x));
    if (inPlace) {
      const files: string[] = [];
      let script = w.some((x) => /^(?:-[A-Za-z]*[ef]|--expression|--file)(?:=|$)/.test(x));
      for (let k = 0; k < w.length; k++) {
        const x = w[k];
        if (/^(?:-[A-Za-z]*[ef]|--expression|--file)$/.test(x)) {
          k++;
          continue;
        }
        if (x.startsWith('-') && x.length > 1) continue;
        if (!script) script = true;
        else files.push(x);
      }
      out.push(...files.map((raw) => ({ raw, how: `${verb} -i` })));
    }
  } else if (verb === 'find') {
    // find ROOTS ... -delete: the roots (the words before the first expression) are deleted in (w6040)
    const w = args.map(unquote);
    if (w.includes('-delete')) for (const x of w) {
      if (/^[-(!]/.test(x)) break;
      out.push({ raw: x, how: 'find -delete' });
    }
  } else if (verb === 'zip' || verb === '7z' || verb === '7za') {
    // zip ARCHIVE FILES...: the archive is written; 7z a ARCHIVE / 7z x -oDIR (w6040)
    const p = verb === 'zip' ? plain : plain.slice(1);
    // zip -sf / --show-files and -T only read the archive
    const zipReads = verb === 'zip' && args.some((x) => ['-sf', '--show-files', '-T', '--test'].includes(unquote(x)));
    if ((verb === 'zip' && !zipReads) || /^[au]$/i.test(plain[0] ?? '')) {
      if (p[0]) out.push({ raw: p[0], how: verb });
    }
    if (verb !== 'zip') for (const x of args.map(unquote)) if (/^-o./.test(x)) out.push({ raw: x.slice(2), how: `${verb} -o` });
  }
  return out;
}

/** git's global options that take the next word as their value (`git -C DIR`, `git -c k=v`). */
const GIT_GLOBAL_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path', '--super-prefix']);
/** git subcommands that write into the repository they run in (`git -C /tmp/x commit`). */
const GIT_WRITE_SUBS = new Set(['init', 'commit', 'add', 'checkout', 'switch', 'reset', 'merge', 'pull', 'fetch', 'apply', 'am', 'stash', 'rm', 'mv', 'restore', 'rebase', 'cherry-pick', 'revert', 'gc', 'prune', 'repack', 'submodule', 'notes', 'update-ref', 'update-index', 'clean', 'lfs', 'sparse-checkout', 'maintenance']);
/** git worktree add's options that take the next word as their value. */
const GIT_WORKTREE_VALUE = new Set(['-b', '-B', '--reason', '--orphan']);

/**
 * The paths a git command writes: `git clone URL DIR` (and --separate-git-dir), `git worktree add [-b new] DIR`, `git init DIR`,
 * and `git -C DIR <a writing subcommand>` (w6040). Global options (`-c k=v`, `-C DIR`, `--git-dir=X`) come before the
 * subcommand and never shift it; a relative destination is taken from -C's folder.
 */
function gitWrites(w: string[]): { raw: string; how: string }[] {
  const out: { raw: string; how: string }[] = [];
  let base: string | undefined;
  let k = 0;
  for (; k < w.length; k++) {
    const x = w[k];
    if (!x.startsWith('-')) break;
    const eq = /^(--git-dir|--work-tree)=(.+)$/.exec(x);
    if (eq) out.push({ raw: eq[2], how: `git ${eq[1]}` });
    if (GIT_GLOBAL_VALUE.has(x)) {
      if (x === '-C') base = base && !/^(?:[a-zA-Z]:)?[\\/]/.test(w[k + 1] ?? '') ? `${base}/${w[k + 1]}` : w[k + 1];
      if ((x === '--git-dir' || x === '--work-tree') && w[k + 1]) out.push({ raw: w[k + 1], how: `git ${x}` });
      k++;
    }
  }
  const sub = w[k]?.toLowerCase();
  const rest = w.slice(k + 1);
  const at = (p: string) => (base && !/^(?:[a-zA-Z]:)?[\\/]|^[~$%]/.test(p) ? `${base}/${p}` : p);
  if (sub === 'clone') {
    const pos: string[] = [];
    for (let j = 0; j < rest.length; j++) {
      const x = rest[j];
      if (x === '--') {
        pos.push(...rest.slice(j + 1));
        break;
      }
      if (/^--separate-git-dir=/.test(x)) out.push({ raw: at(x.slice(19)), how: 'git clone --separate-git-dir' });
      else if (x === '--separate-git-dir' && rest[j + 1]) out.push({ raw: at(rest[j + 1]), how: 'git clone --separate-git-dir' });
      if (GIT_CLONE_VALUE.has(x)) j++;
      else if (!x.startsWith('-')) pos.push(x);
    }
    if (pos[1]) out.push({ raw: at(pos[1]), how: 'git clone' });
    else if (pos[0] && base) out.push({ raw: base, how: 'git -C clone' });
  } else if (sub === 'worktree' && rest[0]?.toLowerCase() === 'add') {
    const pos: string[] = [];
    for (let j = 1; j < rest.length; j++) {
      if (GIT_WORKTREE_VALUE.has(rest[j])) j++;
      else if (!rest[j].startsWith('-')) pos.push(rest[j]);
    }
    if (pos[0]) out.push({ raw: at(pos[0]), how: 'git worktree add' });
  } else if (sub === 'init') {
    const p = rest.filter((x) => !x.startsWith('-'));
    if (p[0]) out.push({ raw: at(p[0]), how: 'git init' });
    else if (base) out.push({ raw: base, how: 'git -C init' });
  } else if (base && sub && GIT_WRITE_SUBS.has(sub)) out.push({ raw: base, how: `git -C ${sub}` });
  return out;
}

/** A heredoc (`<<EOF`, `<<-'EOF'`, not `<<<`), the text before it on its line, and its body. */
const HEREDOC = /(^|\n)([^\n]*?)(?<!<)<<-?[ \t]*(['"]?)([A-Za-z_][\w-]*)\3([^\n]*)\n([\s\S]*?)(?:\n[ \t]*\4[ \t]*(?=\n|$)|$)/g;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'source', '.', 'eval', 'pwsh', 'powershell']);

/**
 * `cmd` with each heredoc's body taken out: it is the input of the command before it (a PR body, a file's text), never a command
 * line, so `cat > "$TMPDIR/body.md" <<'EOF'` with "git show HEAD:x > /tmp/bq_head.ts" in its text writes nothing in /tmp. A body
 * fed to a shell (`bash <<EOF`) is commands and stays. The command line itself (`cat <<'EOF' > /tmp/x`) is always kept. Unlike
 * guard.ts's withoutTextArgs, which also empties quoted -t values, this keeps `cp -t "<temp>/dst" a` seen. Exported for tests.
 */
export function withoutHeredocText(cmd: string): string {
  return cmd.replace(HEREDOC, (m, lead: string, before: string, q: string, delim: string, after: string, body: string) => {
    // The body is fed to the command the heredoc sits on (`sudo bash <<EOF`, `timeout 60 bash <<EOF`) or to a shell later in
    // its pipe (`cat <<EOF | bash`): then it is commands and stays (w6040).
    const mine = before.split(/&&|\|\||[;|]/).pop() ?? '';
    const piped = after.split(/&&|\|\||;/)[0].split('|').slice(1);
    if ([mine, ...piped].some(runsShell)) return m;
    // An unquoted heredoc's $(...) and backticks run as it is read: keep each as a command line of its own (w6040).
    const subs = q ? [] : [...body.matchAll(/\$\(((?:[^()]|\([^()]*\))*)\)|`([^`]*)`/g)].map((s) => s[1] ?? s[2]).filter((s) => s.trim());
    return `${lead}${before}<<${q}${delim}${q}${after}\n${delim}${subs.map((s) => `\n${s}`).join('')}`;
  });
}

/** Whether one pipeline stage runs a shell, past sudo, timeout N, env, nohup and VAR=value prefixes. */
function runsShell(stage: string): boolean {
  const w = stage.trim().split(/\s+/).map((x) => x.replace(/^['"]|['"]$/g, ''));
  let i = 0;
  while (i < w.length) {
    const x = w[i].toLowerCase();
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]) || ['sudo', 'doas', 'exec', 'nohup', 'time', 'env', 'command', 'nice', 'xargs', 'stdbuf'].includes(x) || (i > 0 && /^-/.test(w[i]))) i++;
    else if (x === 'timeout') {
      i++;
      while (i < w.length && (/^-/.test(w[i]) || /^\d/.test(w[i]) || /^[A-Z]+$/.test(w[i]))) i++;
    } else break;
  }
  return SHELLS.has((w[i] ?? '').replace(/^.*[\\/]/, '').toLowerCase().replace(/\.exe$/, ''));
}

/**
 * Every write of a shell command (Bash or PowerShell) into a system temp folder outside the worker's own folders. Exported for
 * tests and for the enforcing change.
 */
export function systemTempWrites(cmd: string, ctx: TmpWriteContext): TempWrite[] {
  const env = ctx.env ?? {};
  const home = (ctx.home ?? env.HOME ?? env.USERPROFILE ?? os.homedir()).replace(/\\/g, '/');
  const win = ctx.win ?? /^[a-zA-Z]:[\\/]/.test(ctx.root ?? ctx.temp ?? '');
  const own = [ctx.root, ctx.temp, ctx.sandbox, env.TMPDIR].filter((d): d is string => !!d).map((d) => norm(msys(d, win)));
  let dir: string | undefined = ctx.cwd ? norm(msys(ctx.cwd, win)) : undefined;
  const found: TempWrite[] = [];

  function msys(p: string, w: boolean): string {
    const s = p.replace(/\\/g, '/');
    return w ? s.replace(/^\/cygdrive\/([a-zA-Z])(?=\/|$)/, '$1:').replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:') : s;
  }
  const resolve = (raw: string): string | undefined => {
    const e = expand(unquote(raw).trim(), env, home);
    if (!e) return undefined;
    const p = msys(e, win);
    if (/^[a-zA-Z]:(?:\/|$)/.test(p) || p.startsWith('/')) return norm(p);
    return dir ? norm(`${dir}/${p}`) : undefined;
  };
  const judge = (raw: string, how: string) => {
    const n = resolve(raw);
    if (!n || !isSystemTemp(n) || own.some((d) => inside(n, d))) return;
    found.push({ raw: unquote(raw), path: n, how });
  };

  const run = (command: string, depth: number) => {
    for (const stages of statements(withoutHeredocText(command).replace(/>\|/g, '>'))) {
      for (let stage of stages) {
        for (let n = 0; n < 5 && stage.search(SUBSTITUTION) >= 0; n++) stage = stage.replace(SUBSTITUTION, '$$SUB');
        const w = words(stage);
        let i = 0;
        while (i < w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]) || ['&', '.', 'sudo', 'exec', 'nohup', 'time', 'env', 'command', 'timeout'].includes(unquote(w[i]).toLowerCase()))) {
          i++;
          // timeout's duration (and -s SIG) come before the command
          if (unquote(w[i - 1]).toLowerCase() === 'timeout') while (i < w.length && (/^-/.test(w[i]) || /^\d/.test(w[i]) || /^[A-Z]+$/.test(w[i]))) i++;
        }
        const verb = w[i] ? verbOf(w[i]) : '';
        const args = w.slice(i + 1);
        for (const r of redirects(w)) judge(r, 'redirect');
        // TMPDIR=/tmp cmd, export TMPDIR=/tmp, $env:TEMP = 'C:\Windows\Temp': every tool after it writes its scratch there (w6040)
        const assigns = [...w.slice(0, i), ...(['export', 'declare', 'typeset', 'local', 'set'].includes(verb) ? args : [])];
        for (const a of assigns) {
          const m = /^(TMPDIR|TEMP|TMP|TEMPDIR)=(.+)$/i.exec(unquote(a));
          if (m) judge(m[2], `${m[1]}=`);
        }
        const ps = /^\$env:(TMPDIR|TEMP|TMP)$/i.exec(w[0] ?? '');
        if (ps && w[1] === '=' && w[2]) judge(w[2], `$env:${ps[1]} =`);
        // [IO.File]::WriteAllText(<temp path>, ...), [System.IO.Directory]::CreateDirectory(...): every quoted path it is given (w6040)
        for (const call of stage.matchAll(/\[(?:System\.)?IO\.(?:File|Directory)\]::(?:Write|Append|Create|Copy|Move|Delete|Replace|Open)\w*\(([^)]*)\)/gi))
          for (const lit of call[1].matchAll(/'([^']*)'|"([^"]*)"/g)) judge(lit[1] ?? lit[2], '[IO.File]');
        if (['cd', 'pushd', 'chdir', 'set-location', 'sl', 'push-location'].includes(verb)) {
          const t = args.map(unquote).find((a) => !a.startsWith('-'));
          dir = t ? resolve(t) : undefined;
          continue;
        }
        const payload = args.findIndex((a, k) => SHELL_PAYLOAD_FLAGS.has(unquote(a).toLowerCase()) && k + 1 < args.length);
        if (payload >= 0 && /^(?:bash|sh|zsh|dash|cmd|powershell|pwsh)$/.test(verb) && depth < 3) {
          run(unquote(args.slice(payload + 1).join(' ')), depth + 1);
          continue;
        }
        for (const { raw, how } of writtenBy(verb, args)) judge(raw, how);
      }
    }
  };
  run(cmd, 0);
  return found;
}

/** The note (warn-only) or the refusal (the enforcing change) for writes found by systemTempWrites. */
export function tmpWriteMessage(writes: TempWrite[], temp: string | undefined, mode: 'warn' | 'refuse'): string {
  const shown = (temp ?? '$TMPDIR').replace(/\\/g, '/').replace(/\/+$/, '');
  const list = writes.map((w) => `${w.raw} (${w.how})`).join(', ');
  const head = mode === 'warn' ? `w6008: that command wrote into a system temp folder outside ffw: ${list}.` : `Refused: this command writes into a system temp folder outside ffw: ${list}.`;
  return (
    `${head} Workers write only inside ffw (lothsahn: "under no circumstances should workers write outside of ffw"). Put scratch ` +
    `files in your own temp folder, ${shown} (\`"$TMPDIR/<name>"\`, or \`$env:TEMP\\<name>\` in PowerShell), never /tmp, /var/tmp, ` +
    `/var/folders or AppData\\Local\\Temp. Do not delete what you left there; say in your report what it was.` +
    (mode === 'warn' ? ' (Warn-only for now: nothing was refused. ff-factory docs/worker-fence.md.)' : '')
  );
}

/** The refusal for the enforcing change (server/guard.ts), or undefined. Not wired in yet: warn-only first. */
export function checkSystemTempWrite(cmd: string, ctx: TmpWriteContext): string | undefined {
  const w = systemTempWrites(cmd, ctx);
  return w.length ? tmpWriteMessage(w, ctx.temp, 'refuse') : undefined;
}

export interface TmpWriteHookOpts {
  root?: string;
  temp?: string;
  sandbox?: string;
  env?: Record<string, string | undefined>;
  /** Who the log line names. */
  session?: string;
  log?: (line: string) => void;
}

/** The PostToolUse hook of one worker process (server/sessions.ts): warn-only. */
export function tmpWriteHook(o: TmpWriteHookOpts): HookCallback {
  const log = o.log ?? ((l: string) => console.log(l));
  return async (input) => {
    if (input.hook_event_name !== 'PostToolUse') return {};
    if (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell') return {};
    const cmd = (input.tool_input as { command?: unknown } | null)?.command;
    if (typeof cmd !== 'string') return {};
    let writes: TempWrite[];
    try {
      writes = systemTempWrites(cmd, { root: o.root, temp: o.temp, sandbox: o.sandbox, env: o.env, cwd: input.cwd || o.sandbox });
    } catch {
      return {};
    }
    if (!writes.length) return {};
    log(`tmp write fence (w6008, warn): ${o.session ?? '?'} ${input.tool_name}: ${writes.map((w) => `${w.path} (${w.how})`).join(', ')}`);
    return { hookSpecificOutput: { hookEventName: 'PostToolUse' as const, additionalContext: tmpWriteMessage(writes, o.temp, 'warn') } };
  };
}
