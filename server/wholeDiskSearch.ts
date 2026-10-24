import path from 'node:path';
import { SHELL_PAYLOAD_FLAGS, statements, SUBSTITUTION, unquote, verbOf, words } from './rootFence.ts';

/**
 * The whole-disk search fence of a worker's shell and search tools (w2012, lothsahn, 2026-10-24: "Stop messing with my c:").
 * Workers that did not know where the ff-agents scripts are ran `find / -name ui_look.py` and `find / -name pr_evidence.py`
 * (7f785004 for w1937 on LothDesktop, 1225e6c6 for w1928 on m5); on LothDesktop Git Bash's find walked all of C: at about
 * 0.95 cores in every 60 s window (w1894's measurement, 08:05Z). On every machine, a search or a size walk whose root is
 * the whole file system (`/`), a drive (`C:\`, `/c`, `/cygdrive/c`, `/mnt/c`), the folder of every user (`/Users`, `/home`,
 * `C:\Users`), a macOS or Linux top folder that holds them (`/Volumes`, `/System`, `/Library`, `/private`, `/mnt`, `/media`)
 * or a home folder itself (`~`, `$HOME`, `%USERPROFILE%`, `/Users/x`) is refused, and the refusal says where the scripts are
 * (FF_SKILLS, server/pluginPaths.ts). A search inside the sandbox, the worker's temp folder, the install folder or any other
 * folder below those stays allowed; on Windows the off-drive fence (checkOffDriveScan) still keeps the rest of C: out.
 *
 * Read here: find, fd, rg, ag, ack, grep -r, du, dust, ncdu, gdu, tree, ls -R, Get-ChildItem / gci / dir with -Recurse,
 * cmd's dir /s (the folder of `dir /s C:\x.py` is the walk), where /r, through `cd` and `bash -c` / `powershell -Command`;
 * and the Grep and Glob tools' path (checkSearchTool). Like the rest of the guard it is a SEATBELT: python's os.walk or a
 * variable it cannot resolve is the instructions' job (the worker brief's FF_SKILLS line).
 */
export interface WholeDiskContext {
  /** A Windows machine: `/c` is a drive and `\` the current drive's root. */
  win: boolean;
  /** The user's home folder. */
  home: string;
  /** The command's working directory, for relative paths. */
  cwd?: string;
  /** The ff-agents skills folder (FF_SKILLS), named in the refusal. */
  skills?: string;
}

const HOME_WORD = /^(?:~|\$home|\$\{home\}|\$env:userprofile|\$env:home|%userprofile%)$/i;
const HOME_PREFIX = /^(?:~|\$home|\$\{home\}|\$env:userprofile|\$env:home|%userprofile%)(?=[\\/])/i;

const norm = (p: string) => {
  const n = path.posix.normalize(p.replace(/\\/g, '/')).replace(/\/+$/, '');
  return n === '' ? '/' : n;
};

/** A path as written, made absolute and normalised (forward slashes, case kept), 'home' for a bare home word, or undefined. */
function resolve(raw: string, ctx: WholeDiskContext, dir: string | undefined): string | 'home' | undefined {
  let p = unquote(raw).trim();
  if (!p) return undefined;
  if (HOME_WORD.test(p.replace(/[\\/]+$/, ''))) return 'home';
  if (HOME_PREFIX.test(p)) p = p.replace(HOME_PREFIX, ctx.home.replace(/\\/g, '/'));
  if (/[$`*?]|%[^%\s]+%/.test(p)) return undefined; // a variable, a substitution or a glob: not judged
  p = p.replace(/\\/g, '/');
  if (ctx.win) p = p.replace(/^\/cygdrive\/([a-zA-Z])(?=\/|$)/, '$1:').replace(/^\/mnt\/([a-zA-Z])(?=\/|$)/, '$1:').replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:');
  if (/^[a-zA-Z]:(?:\/|$)/.test(p) || p.startsWith('/')) return norm(p);
  if (!dir) return undefined;
  return norm(`${dir}/${p}`);
}

/** What a resolved search root would walk, when it is a whole disk, drive or home folder; undefined otherwise. */
function wholeOf(n: string | 'home' | undefined, ctx: WholeDiskContext): string | undefined {
  if (n === undefined) return undefined;
  if (n === 'home') return 'your whole home folder';
  const low = n.toLowerCase();
  const home = norm(ctx.home).toLowerCase();
  if (low === '/') return ctx.win ? 'the whole file system (/, which in Git Bash reaches every drive through /c, /d, ...)' : 'the whole file system (/)';
  if (/^[a-z]:$/.test(low)) return `the whole drive ${n.toUpperCase()}`;
  if (/^\/(?:cygdrive|mnt)$/.test(low)) return `every drive (${n})`;
  if (/^[a-z]:\/users$/.test(low) || (!ctx.win && /^\/(?:users|home)$/.test(low))) return `every user's folder (${n})`;
  if (!ctx.win && /^\/(?:volumes|system|library|private|mnt|media)$/.test(low)) return `the whole of ${n}`;
  if (low === home || /^[a-z]:\/users\/[^/]+$/.test(low) || (!ctx.win && /^\/(?:users|home)\/[^/]+$/.test(low))) return `a whole home folder (${n})`;
  return undefined;
}

/** The refusal, naming where the plugin scripts are. Exported for tests. */
export function wholeDiskRefusal(verb: string, what: string, skills?: string): string {
  const where = skills
    ? `in $FF_SKILLS/<skill>/ (here ${skills}): python "$FF_SKILLS/unity-ui/ui_look.py", python "$FF_SKILLS/evidence-gate/pr_evidence.py" (PowerShell: $env:FF_SKILLS)`
    : `in the skill's own folder, the "Base directory for this skill" its text starts with`;
  return (
    `Refused: ${verb} would search ${what}. A search of a whole disk, drive or home folder walks every file on it: a worker's ` +
    `\`find / -name ui_look.py\` held a core of lothsahn's own PC for minutes (w2012; lothsahn: "Stop messing with my c:"). ` +
    `The ff-agents scripts (ui_look.py, ui_layout.py, pr_evidence.py, record_clip.py, watch_video.py and the rest) are ${where}. ` +
    `Search inside your sandbox, your $TMPDIR or the install folder instead.`
  );
}

/** Programs that walk a tree whatever their flags; the pattern-first searchers among them take a pattern before their paths. */
const ALWAYS_WALK = new Set(['find', 'fd', 'fdfind', 'du', 'dust', 'ncdu', 'gdu', 'tree', 'rg', 'ag', 'ack']);
const GREPS = new Set(['grep', 'egrep', 'fgrep']);
const PS_LISTERS = new Set(['get-childitem', 'gci', 'dir', 'ls']);
/** Each program's flags whose next word is a value, not a path (case kept: grep's -r is no value, rg's -r is). */
const VALUE_FLAGS: Record<string, Set<string>> = {
  fd: new Set(['-e', '--extension', '-t', '--type', '-E', '--exclude', '-d', '--max-depth', '--min-depth', '--exact-depth', '-S', '--size', '-c', '--color', '-j', '--threads', '--max-results', '--changed-within', '--changed-before', '-o', '--owner']),
  rg: new Set(['-e', '--regexp', '-f', '--file', '-g', '--glob', '--iglob', '-t', '--type', '-T', '--type-not', '-m', '--max-count', '-A', '-B', '-C', '-M', '--max-columns', '-r', '--replace', '-d', '--max-depth', '-j', '--threads', '-E', '--encoding', '--type-add', '--sort', '--sortr', '--color', '--colors']),
  ag: new Set(['-G', '--file-search-regex', '-g', '-A', '-B', '-C', '-m', '--depth', '--ignore', '--ignore-dir']),
  ack: new Set(['-g', '--type', '-A', '-B', '-C', '-m', '--ignore-dir', '--ignore-file']),
  grep: new Set(['-e', '--regexp', '-f', '--file', '-m', '--max-count', '-A', '-B', '-C', '-d', '--directories', '-D', '--devices', '--include', '--exclude', '--exclude-dir', '--label']),
  du: new Set(['-d', '--max-depth', '-B', '--block-size', '-t', '--threshold', '--exclude', '-X']),
  tree: new Set(['-L', '-I', '-P', '-o', '--filelimit']),
  ps: new Set(['-filter', '-include', '-exclude', '-erroraction', '-ea', '-attributes', '-depth', '-errorvariable', '-ev']),
};
VALUE_FLAGS.fdfind = VALUE_FLAGS.fd;
VALUE_FLAGS.egrep = VALUE_FLAGS.fgrep = VALUE_FLAGS.grep;
VALUE_FLAGS.dust = VALUE_FLAGS.ncdu = VALUE_FLAGS.gdu = VALUE_FLAGS.du;
/** Flags that give the pattern, so every positional word is a path (rg -e x /, grep -r -e x /, ag -g x /, rg --files /). */
const PATTERN_FLAGS = new Set(['-e', '--regexp', '-f', '--file', '-g', '--files']);
const PATH_FLAGS = new Set(['-path', '-literalpath', '-lp', '--search-path', '--base-directory']);

/** The folder a path names when its last part is a file name or a wildcard (`C:\ui_look.py` → `C:\`). */
const parentOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '') || p.slice(0, 1);

/** The roots a walking command names (undefined: the current folder), or [] when it walks nothing. */
function rootsOf(verb: string, args: string[]): (string | undefined)[] {
  const a = args.map(unquote);
  const low = a.map((x) => x.toLowerCase());
  // cmd: where /r <dir> <pattern>
  if (verb === 'where') {
    const k = low.indexOf('/r');
    return k >= 0 && k + 1 < a.length ? [a[k + 1]] : [];
  }
  // cmd: dir /s C:\ui_look.py walks C:\ looking for ui_look.py, so its folder is a root too.
  if (verb === 'dir' && low.includes('/s')) {
    const ps = a.filter((x) => !/^\/[a-z](?::.*)?$/i.test(x));
    return ps.length ? ps.flatMap((x) => [x, parentOf(x)]) : [undefined];
  }
  // PowerShell's -Recurse (-r there; Bash's ls -r is a reverse sort, so ls needs -Recurse spelled out).
  const ps = PS_LISTERS.has(verb) && a.some((x) => (verb === 'ls' ? /^-rec\w*(?::\$true)?$/i : /^-(?:r|rec\w*)(?::\$true)?$/i).test(x));
  const walks =
    ALWAYS_WALK.has(verb) ||
    ps ||
    (verb === 'ls' && a.some((x) => /^-[a-zA-Z]*R[a-zA-Z]*$/.test(x) || x === '--recursive')) ||
    (GREPS.has(verb) && a.some((x) => /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(x) || x === '--recursive' || x === '--dereference-recursive' || x === '--directories=recurse'));
  if (!walks) return [];
  const values = ps ? VALUE_FLAGS.ps : (VALUE_FLAGS[verb] ?? new Set<string>());
  const out: (string | undefined)[] = [];
  const positional: string[] = [];
  let patternGiven = verb === 'rg' && low.includes('--files');
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const flag = ps ? low[i] : x;
    if (x === '--') {
      positional.push(...a.slice(i + 1));
      break;
    }
    if (verb === 'find' && (['!', '(', ')'].includes(x) || x.startsWith('-'))) break; // find's expression
    if ((verb === 'fd' || verb === 'fdfind') && (x === '-x' || x === '-X' || x === '--exec' || x === '--exec-batch')) break;
    if (PATH_FLAGS.has(low[i].replace(/[:=].*$/, ''))) {
      const inline = /^-[-a-z]+[:=](.+)$/i.exec(x)?.[1];
      const v = inline ?? (i + 1 < a.length ? a[++i] : undefined);
      if (v) out.push(...v.split(','));
      continue;
    }
    if (values.has(flag)) {
      if (!ps && PATTERN_FLAGS.has(x)) patternGiven = true;
      i++;
      continue;
    }
    if (x.startsWith('-')) {
      if (!ps && /^--(?:regexp|file)=/.test(x)) patternGiven = true;
      continue;
    }
    positional.push(x);
  }
  const patternFirst = ['rg', 'ag', 'ack', 'fd', 'fdfind'].includes(verb) || GREPS.has(verb);
  const paths = patternFirst && !patternGiven ? positional.slice(1) : positional;
  for (const p of paths) {
    if (ps) {
      for (const q of p.split(',').filter(Boolean)) {
        out.push(q);
        // Get-ChildItem C:\*.py -Recurse walks C:\.
        if (/[*?]/.test(q.replace(/^.*[\\/]/, ''))) out.push(parentOf(q));
      }
    } else out.push(p);
  }
  return out.length ? out : [undefined];
}

/** The reason a shell command is refused because it searches a whole disk, drive or home folder, or undefined. */
export function checkWholeDiskSearch(cmd: string, ctx: WholeDiskContext): string | undefined {
  let dir: string | undefined = ctx.cwd ? norm(ctx.cwd) : undefined;
  const run = (command: string): string | undefined => {
    for (const stages of statements(command)) {
      for (let stage of stages) {
        for (let k = 0; k < 5 && stage.search(SUBSTITUTION) >= 0; k++) stage = stage.replace(SUBSTITUTION, '$$SUB');
        const w = words(stage);
        let i = 0;
        while (i < w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]) || ['&', '.', 'sudo', 'exec', 'nohup', 'time', 'env', 'command', 'nice', 'ionice', 'timeout'].includes(unquote(w[i]).toLowerCase()) || (i > 0 && unquote(w[i - 1]).toLowerCase() === 'timeout' && /^\d/.test(w[i])))) i++;
        const verb = w[i] ? verbOf(w[i]) : '';
        const args = w.slice(i + 1);
        if (['cd', 'pushd', 'chdir', 'set-location', 'sl', 'push-location'].includes(verb)) {
          const target = args.map(unquote).find((a) => !a.startsWith('-') || a === '-');
          const n = target ? resolve(target, ctx, dir) : resolve('~', ctx, dir);
          dir = n === 'home' ? norm(ctx.home) : n;
          continue;
        }
        const payload = args.findIndex((a, k) => SHELL_PAYLOAD_FLAGS.has(unquote(a).toLowerCase()) && k + 1 < args.length);
        if (payload >= 0 && /^(?:bash|sh|zsh|dash|cmd|powershell|pwsh)$/.test(verb)) {
          const r = run(unquote(args.slice(payload + 1).join(' ')));
          if (r) return r;
          continue;
        }
        for (const root of rootsOf(verb, args)) {
          const what = wholeOf(root === undefined ? dir : resolve(root, ctx, dir), ctx);
          if (what) return wholeDiskRefusal(verb, what, ctx.skills);
        }
      }
    }
    return undefined;
  };
  return run(cmd);
}

/**
 * The same fence for the Grep and Glob tools: their `path`, or a Glob pattern's fixed start when it is absolute
 * (`/ **\/ui_look.py`, `C:/**\/x`).
 */
export function checkSearchTool(tool: string, args: Record<string, unknown>, ctx: WholeDiskContext): string | undefined {
  if (tool !== 'Grep' && tool !== 'Glob') return undefined;
  const roots: string[] = [];
  if (typeof args.path === 'string' && args.path.trim()) roots.push(args.path);
  if (tool === 'Glob' && typeof args.pattern === 'string') {
    const pat = args.pattern.replace(/\\/g, '/');
    if (/^(?:[a-zA-Z]:)?\/|^~/.test(pat)) {
      const fixed = pat.split('/');
      const k = fixed.findIndex((s) => /[*?[{]/.test(s));
      roots.push(k < 0 ? pat : fixed.slice(0, k).join('/') || '/');
    }
  }
  for (const r of roots) {
    const what = wholeOf(resolve(r, ctx, ctx.cwd ? norm(ctx.cwd) : undefined), ctx);
    if (what) return wholeDiskRefusal(tool, what, ctx.skills);
  }
  return undefined;
}
