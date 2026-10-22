import os from 'node:os';
import path from 'node:path';

/**
 * The delete fence of a worker's shell (w896, lothsahn, 2026-10-10: "Why are you clearing C: on LothDesktop? ... In general we
 * should only be clearing data in the install folder for the worker"). On a machine with a worker install, a sandbox worker's
 * shell command that deletes something outside the install folder (root.json's root: D:\work\ffw, F:\ffw, ~/ffw) is refused
 * by the sandbox guard (server/guard.ts), whatever the request is: the daemon cannot tell a clean-up request from any other
 * (a session's guard is fixed when it starts, a request can be handed to it later), and a worker has no other reason to delete
 * outside its folder. Like the rest of the guard it is a SEATBELT: it reads the text of rm / rmdir / del / rd / Remove-Item
 * (and find -delete, xargs rm, a listing piped into a removal) and cannot see a script, a python shutil.rmtree or a variable
 * it does not know; those are the instructions' job (DISK_HYGIENE in server/agents.ts, docs/self-recovery.md "Where clean-up
 * may delete").
 *
 * On Windows the game's data folders under AppData (inNeverGames) are read-only besides: a move, rename, copy into them or
 * write there is refused too (w1755, lothsahn, 2026-10-22: "Let's let it scan the never games folder, but not the rest of C.
 * And it shouldn't modify it."), apart from the worker's own save copy.
 *
 * What stays allowed: anything strictly inside the install folder or inside `allow` (the worker's own sandbox), the agent's
 * own temp (`$TMP`, `$env:TEMP`, `%TEMP%`, `/tmp`), and an entry of the game's saves folder (a save copy the worker put there,
 * which its brief tells it to remove again). Unknown text (an unset variable, `$(...)`, a path on a mount it cannot map) is not
 * judged.
 */
export interface RootFenceContext {
  /** The worker install folder. */
  root: string;
  /** The command's working directory, for relative paths. */
  cwd?: string;
  /** More folders a worker may delete in (its own sandbox, when that is not inside the root). */
  allow?: string[];
  /** The user's home folder (`~`, `$HOME`, `%USERPROFILE%`, AppData). Default: os.homedir(). */
  home?: string;
  /**
   * The session's own temp folder name (`ffa-<session>`): a saves folder entry named `<saveTag>-<name>` is its save copy and
   * may go (w1505). Absent: no save entry may go.
   */
  saveTag?: string;
}

const DELETE_VERBS = new Set(['rm', 'rmdir', 'unlink', 'rd', 'del', 'erase', 'remove-item', 'ri']);
/** cmd.exe's verbs: `/s` and `/q` are flags there, but `/c` is a path to rm. */
const CMD_VERBS = new Set(['rd', 'del', 'erase']);
/** `$(...)` and `` `...` ``: a value the text does not give. */
const SUBSTITUTION = /\$\([^()]*\)|`[^`]*`/g;

/** Pipeline stages that pass a listing on to the next (Get-ChildItem X | Where-Object {...} | Remove-Item). */
const PASS_THROUGH = new Set(['where-object', 'where', 'select-object', 'select', 'sort-object', 'sort', 'head', 'tail', 'grep', 'xargs']);
const LISTERS = new Set(['get-childitem', 'gci', 'ls', 'dir', 'get-item', 'gi', 'find']);
const SHELL_PAYLOAD_FLAGS = new Set(['-c', '-lc', '-ic', '-command', '/c', '/k']);
/** PowerShell parameters (and rm's) whose next word is a value, not a path. */
const VALUE_FLAGS = new Set(['-erroraction', '-ea', '-include', '-exclude', '-filter', '-stream', '-credential']);
const PATH_FLAGS = new Set(['-path', '-literalpath', '-lp']);
/** Verbs that change every path they name: a move or rename takes the source away and writes the destination (w1755). */
const MOVE_VERBS = new Set(['mv', 'move', 'move-item', 'mi', 'ren', 'rename', 'rename-item', 'rni']);
/** Verbs that write their destination (the last path, or -Destination's). */
const COPY_VERBS = new Set(['cp', 'copy', 'copy-item', 'cpi', 'xcopy']);
/** Verbs that write or create every path they name. */
const WRITE_VERBS = new Set(['set-content', 'add-content', 'ac', 'out-file', 'new-item', 'ni', 'clear-content', 'clc', 'clear-item', 'cli', 'set-item', 'tee', 'tee-object', 'touch', 'mkdir', 'md', 'truncate']);

const TMP_VAR = /^(?:\$env:(?:tmp|temp)|\$\{?(?:tmp|temp|tmpdir)\}?|%(?:tmp|temp)%)(?=$|[\\/])/i;
/**
 * One entry of the game's saves folder (GameDataPaths.Saves: `<persistentDataPath>/UserData/saves`, `saves` before the
 * UserData layout), on Windows (AppData/LocalLow), Linux (~/.config/unity3d) and macOS (Library/Application Support).
 */
const SAVES = /\/(?:appdata\/locallow|\.config\/unity3d|library\/application support)\/never games\/finalfactory[^/]*\/(?:userdata\/)?saves\/([^/*?[\]{}]+)$/i;

/**
 * Whether a backslash at `i` escapes the whitespace or quote after it (Bash's `Never\ Games`). In a Windows path a backslash
 * is a separator: once the word has used one so (`D:\work\ffw\ -Recurse`), a backslash before a space ends the word, and so
 * does one right after a drive (`C:\ -Recurse`, w1755).
 */
const escapes = (s: string, i: number, word: string) =>
  s[i] === '\\' && i + 1 < s.length && /[\s"']/.test(s[i + 1]) && !/\\(?![\s"'])/.test(word) && !/^["']?[a-zA-Z]:$/.test(word);

/** A word with its shell quoting removed: quoted parts joined to the rest (`~/"Never Games"/x`), `\ ` as a space. */
function unquote(w: string): string {
  let out = '';
  let q = '';
  for (let i = 0; i < w.length; i++) {
    const c = w[i];
    if (q) {
      if (c === q) q = '';
      else out += c;
    } else if (c === '"' || c === "'") q = c;
    else if (escapes(w, i, w.slice(0, i))) out += w[++i];
    else out += c;
  }
  return out;
}

/** The words of a statement, as written: a quoted part or an escaped space belongs to its word (w1505). */
function words(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (c === q) q = '';
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (escapes(s, i, cur)) {
      cur += c + s[++i];
    } else if (/\s/.test(c)) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/** The program a word names, lower case, without a directory or `.exe`. */
const verbOf = (w: string) => unquote(w).replace(/\\/g, '/').split('/').pop()!.replace(/\.exe$/i, '').toLowerCase();

/**
 * A path as written in the command, made absolute and normalised (forward slashes, lower case, no trailing slash), or
 * 'ok' for the agent's own temp, or undefined when it cannot be known from the text.
 */
function resolvePath(raw: string, ctx: Required<Pick<RootFenceContext, 'home'>> & { cwd?: string; win: boolean }): string | 'ok' | undefined {
  let p = unquote(raw).trim();
  if (!p) return undefined;
  if (TMP_VAR.test(p) || /^\/tmp(?:\/|$)/.test(p.replace(/\\/g, '/'))) return 'ok';
  const home = ctx.home.replace(/\\/g, '/').replace(/\/+$/, '');
  const known: [RegExp, string][] = [
    [/^(?:~|\$home|\$\{home\}|\$env:userprofile|\$env:home|%userprofile%)(?=$|[\\/])/i, home],
    [/^(?:\$env:localappdata|%localappdata%)(?=$|[\\/])/i, `${home}/AppData/Local`],
    [/^(?:\$env:appdata|%appdata%)(?=$|[\\/])/i, `${home}/AppData/Roaming`],
    [/^(?:\$env:programdata|%programdata%)(?=$|[\\/])/i, 'C:/ProgramData'],
    [/^(?:\$env:systemroot|\$env:windir|%systemroot%|%windir%)(?=$|[\\/])/i, 'C:/Windows'],
  ];
  for (const [re, to] of known) {
    if (re.test(p)) {
      p = p.replace(re, to);
      break;
    }
  }
  // Anything else with a variable or a substitution is not judged.
  if (/[$`]|%[^%\s]+%|\$\(/.test(p)) return undefined;
  p = p.replace(/\\/g, '/');
  if (ctx.win) p = p.replace(/^\/cygdrive\/([a-zA-Z])(?=\/|$)/, '$1:').replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:');
  let abs: string;
  if (/^[a-zA-Z]:\//.test(p) || /^[a-zA-Z]:$/.test(p)) abs = p;
  else if (p.startsWith('/')) {
    if (ctx.win) return undefined; // an MSYS path that is no drive (/usr, /home): where it points is the shell's
    abs = p;
  } else {
    if (!ctx.cwd) return undefined;
    abs = `${ctx.cwd}/${p}`;
  }
  return path.posix.normalize(abs).replace(/\/+$/, '').toLowerCase();
}

/** Whether `n` (normalised) is strictly inside `root` (normalised). */
const strictlyInside = (n: string, root: string) => n.startsWith(root + '/');

interface Stmt {
  verb: string;
  /** The paths it names, as written. */
  paths: string[];
  /** The targets come from the previous stage of a pipeline (Get-ChildItem X | Remove-Item). */
  piped: boolean;
}

/** The paths a delete verb names (flags, their values and `--` skipped). */
function pathsOf(verb: string, args: string[]): string[] {
  const out: string[] = [];
  let flags = true;
  for (let i = 0; i < args.length; i++) {
    const a = unquote(args[i]);
    const low = a.toLowerCase();
    if (flags && a === '--') {
      flags = false;
      continue;
    }
    if (flags && PATH_FLAGS.has(low.replace(/:.*$/, ''))) {
      const inline = /^-[a-z]+:(.+)$/i.exec(a)?.[1];
      const v = inline ?? (i + 1 < args.length ? unquote(args[++i]) : undefined);
      if (v) out.push(...v.split(','));
      continue;
    }
    if (flags && VALUE_FLAGS.has(low)) {
      i++;
      continue;
    }
    if (flags && a.startsWith('-')) continue;
    if (flags && CMD_VERBS.has(verb) && /^\/[a-zA-Z](?::.*)?$/.test(a)) continue;
    out.push(...a.split(',').filter(Boolean));
  }
  return out;
}

/** Statements of one command line: `cd` is tracked by the caller, so each one carries the stage list of its pipeline. */
function statements(cmd: string): string[][] {
  // Respecting quotes: a separator inside "..." or '...' belongs to the word.
  const out: string[][] = [];
  let cur: string[] = [];
  let buf = '';
  let quote = '';
  const flush = () => {
    cur.push(buf);
    buf = '';
  };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      buf += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
    } else if (ch === '|' && cmd[i + 1] !== '|') flush();
    else if (ch === '&' && cmd[i - 1] === '>') buf += ch; // 2>&1
    else if (ch === '|' || ch === '&' || ch === ';' || ch === '\n') {
      if ((ch === '|' || ch === '&') && cmd[i + 1] === ch) i++;
      flush();
      out.push(cur);
      cur = [];
    } else buf += ch;
  }
  flush();
  out.push(cur);
  return out.map((st) => st.map((s) => s.trim()).filter(Boolean)).filter((st) => st.length);
}

/**
 * The reason a shell command is refused because it deletes outside the worker install folder, or undefined. Exported for tests.
 */
export function checkOutsideRootDelete(cmd: string, ctx: RootFenceContext): string | undefined {
  const win = /^[a-zA-Z]:[\\/]/.test(ctx.root);
  const home = ctx.home ?? os.homedir();
  const norm = (p: string) => path.posix.normalize(p.replace(/\\/g, '/')).replace(/\/+$/, '').toLowerCase();
  const root = norm(ctx.root);
  const allowed = [root, ...(ctx.allow ?? []).map(norm)];
  let dir: string | undefined = ctx.cwd ? norm(ctx.cwd) : undefined;
  const tag = ctx.saveTag?.toLowerCase();

  /** A save copy of this session: one entry `<tag>-<name>` of the game's saves folder, written without a `..`. */
  const ownSave = (raw: string, n: string): boolean => {
    const m = SAVES.exec(n);
    return !!tag && !!m && m[1].startsWith(`${tag}-`) && m[1].length > tag.length + 1 && !unquote(raw).replace(/\\/g, '/').split('/').includes('..');
  };

  /** On Windows the game's data folders under AppData are read-only: no delete, move, rename or write there (w1755). */
  const neverGames = (raw: string, n: string): string | undefined =>
    win && inNeverGames(n, home) && !ownSave(raw, n)
      ? `Refused: ${unquote(raw)} is in the game's data folder under AppData (Never Games). On this Windows computer it may be read and measured, ` +
        `never modified (lothsahn, 2026-10-22, w1755: "Let's let it scan the never games folder, but not the rest of C.  And it shouldn't modify it."): no delete, move, rename, copy into it or write there, by a clean-up ` +
        `or any other disk work. A test's saves and settings go in and out through the game repo's \`python scripts/game_data.py\` (\`read_rules saves\`); ` +
        `the one thing you may put there and remove again is your own save copy, named after your temp folder (\`ffa-<session>-<name>.zip\` in its saves folder).`
      : undefined;

  /** A path a move, copy or write changes: refused only in the game's data folders (the rest is not this fence's). */
  const judgeWrite = (raw: string): string | undefined => {
    const n = resolvePath(raw, { home, cwd: dir, win });
    return n === undefined || n === 'ok' ? undefined : neverGames(raw, n);
  };

  const judge = (raw: string): string | undefined => {
    const n = resolvePath(raw, { home, cwd: dir, win });
    if (n === undefined || n === 'ok') return undefined;
    if (allowed.some((a) => strictlyInside(n, a))) return undefined;
    if (ownSave(raw, n)) return undefined;
    const ng = neverGames(raw, n);
    if (ng) return ng;
    const why = allowed.includes(n) ? `${unquote(raw)} is the install folder itself` : `${unquote(raw)} is outside this machine's worker install folder (${ctx.root})`;
    const outside = win
      ? `On this Windows computer disk work stays on the install drive (${driveLabel(ctx.root)}): never read, measure or touch C: or another drive ` +
        `(lothsahn, 2026-10-22, w1755: "Fix the instructions for Windows boxes to only look at v:"); report what you could not free inside the folder`
      : `Outside it, measure and report sizes (du), and list any setting or script that makes FF Factory write there so it can be moved inside the folder`;
    return (
      `Refused: ${why}. Disk clean-up deletes only inside the worker install folder (lothsahn, 2026-10-10, w896: "in general we should only be ` +
      `clearing data in the install folder for the worker"). ${outside}; delete nothing there, and do not ask a person ` +
      `to either. Fine to delete: anything inside ${ctx.root}, your own temp folder ($TMP), and a save copy you put in the game's saves folder ` +
      `(docs/self-recovery.md, "Where clean-up may delete").`
    );
  };

  const run = (command: string): string | undefined => {
    for (const stages of statements(command)) {
      let prevPaths: string[] | undefined;
      for (let si = 0; si < stages.length; si++) {
        // A command or backtick substitution is a value the text does not give: it is dropped, like an unknown variable.
        let stage = stages[si];
        for (let n = 0; n < 5 && stage.search(SUBSTITUTION) >= 0; n++) stage = stage.replace(SUBSTITUTION, '$$SUB');
        const w = words(stage);
        let i = 0;
        while (i < w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]) || ['&', '.', 'sudo', 'exec', 'nohup', 'time', 'env', 'command'].includes(unquote(w[i]).toLowerCase()))) i++;
        const verb = w[i] ? verbOf(w[i]) : '';
        const args = w.slice(i + 1);

        // cd / Set-Location / pushd: later statements are relative to it (unknown when the text does not say).
        if (['cd', 'pushd', 'chdir', 'set-location', 'sl', 'push-location'].includes(verb)) {
          const target = args.map(unquote).find((a) => !a.startsWith('-') || a === '-');
          const n = target ? resolvePath(target, { home, cwd: dir, win }) : undefined;
          dir = n && n !== 'ok' ? n : undefined;
          prevPaths = undefined;
          continue;
        }

        // A shell started with a command string: judge the string.
        const payload = args.findIndex((a, k) => SHELL_PAYLOAD_FLAGS.has(unquote(a).toLowerCase()) && k + 1 < args.length);
        if (payload >= 0 && /^(?:bash|sh|zsh|dash|cmd|powershell|pwsh)$/.test(verb)) {
          const inner = unquote(args.slice(payload + 1).join(' '));
          const r = run(inner);
          if (r) return r;
          continue;
        }

        let targets: string[] | undefined;
        if (DELETE_VERBS.has(verb)) {
          const own = pathsOf(verb, args);
          // A removal with no path of its own takes its targets from the listing before it in the pipeline.
          targets = own.length ? own : prevPaths;
        } else if (verb === 'find') {
          const isDelete = args.some((a) => unquote(a) === '-delete') || args.some((a, k) => unquote(a) === '-exec' && DELETE_VERBS.has(verbOf(args[k + 1] ?? '')));
          const expr = args.findIndex((a) => ['!', '('].includes(unquote(a)) || unquote(a).startsWith('-'));
          const starts = args.slice(0, expr < 0 ? args.length : expr).map(unquote);
          if (isDelete) targets = starts;
          prevPaths = starts;
        } else if (verb === 'xargs' && DELETE_VERBS.has(verbOf(args.find((a) => !unquote(a).startsWith('-')) ?? ''))) {
          targets = prevPaths;
        } else if (si > 0 && /(?:^|[\s{;(])(?:remove-item|rm|del|erase|ri)(?=[\s}]|$)/i.test(stage) && !LISTERS.has(verb)) {
          // ... | ForEach-Object { Remove-Item $_ }: the listing before it names the targets.
          targets = prevPaths;
        }
        if (LISTERS.has(verb) && verb !== 'find') {
          const l = pathsOf(verb, args);
          prevPaths = l.length ? l : undefined;
        } else if (!LISTERS.has(verb) && !DELETE_VERBS.has(verb) && !PASS_THROUGH.has(verb)) prevPaths = undefined;

        for (const t of targets ?? []) {
          const r = judge(t);
          if (r) return r;
        }
        if (win) {
          for (const t of [...changedPaths(verb, args), ...redirects(w)]) {
            const r = judgeWrite(t);
            if (r) return r;
          }
        }
      }
    }
    return undefined;
  };
  return run(cmd);
}

/** The paths a move, copy, robocopy or write changes (w1755): the game's data folders under AppData are never one of them. */
function changedPaths(verb: string, args: string[]): string[] {
  if (MOVE_VERBS.has(verb) || WRITE_VERBS.has(verb)) return pathsOf(verb, args);
  if (COPY_VERBS.has(verb)) {
    const k = args.findIndex((a) => /^-(?:destination|dest|target-directory)$|^--target-directory$|^-t$/i.test(unquote(a).replace(/[:=].*$/, '')));
    if (k >= 0) {
      const inline = /^-{1,2}[a-z-]+[:=](.+)$/i.exec(unquote(args[k]))?.[1];
      return [inline ?? unquote(args[k + 1] ?? '')].filter(Boolean);
    }
    return pathsOf(verb, args).filter((a) => !/^\/[a-zA-Z](?::.*)?$/.test(a)).slice(-1);
  }
  if (verb === 'robocopy') {
    const flags = args.map(unquote).filter((a) => a.startsWith('/'));
    if (flags.some((f) => /^\/l$/i.test(f))) return [];
    const [src, dst] = args.map(unquote).filter((a) => !a.startsWith('/'));
    const moves = flags.some((f) => /^\/(?:mov|move|purge|mir)$/i.test(f));
    return [dst, ...(moves ? [src] : [])].filter((x): x is string => !!x);
  }
  return [];
}

/** The files a statement's output redirections write (`> x`, `>> x`, `2>x`, `*> x`); `2>&1` writes none. */
function redirects(w: string[]): string[] {
  const out: string[] = [];
  for (let k = 0; k < w.length; k++) {
    const m = /^(?:\d|\*)?>>?\|?(.*)$/.exec(w[k]);
    if (!m) continue;
    const t = m[1] || w[++k];
    if (t && !t.startsWith('&')) out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------- Windows: the install drive only (w1755)

/** The drive of a Windows install folder, lower case without the colon ('v' for V:\ffw); undefined for a POSIX root. */
export function installDrive(root: string | undefined): string | undefined {
  const m = /^([a-zA-Z]):(?:[\\/]|$)/.exec(root ?? '');
  return m ? m[1].toLowerCase() : undefined;
}

/** `V:` for a Windows install folder, the folder itself for a POSIX one. */
export const driveLabel = (root: string) => (installDrive(root) ? `${installDrive(root)!.toUpperCase()}:` : root);

/**
 * Whether `p` is in one of the game's data folders under a Windows profile's AppData, the one exception to the install drive
 * rule (w1755, lothsahn, 2026-10-22: "Let's let it scan the never games folder, but not the rest of C.  And it shouldn't
 * modify it." and "By never games I mean in appdata"): `AppData\LocalLow\Never Games` (the game's saves, settings and logs),
 * `AppData\Local\Never Games` and `AppData\Roaming\Never Games`, of any profile in the folder that holds this user's profile
 * (the parent of os.homedir(), which Windows takes from USERPROFILE: C:\Users on a usual install). A worker may read and
 * measure them there; nothing modifies them (checkOutsideRootDelete). A `Never Games` folder anywhere else, and every other
 * AppData folder, is not one of them. Always false for a POSIX home.
 */
export function inNeverGames(p: string, home: string = os.homedir()): boolean {
  const n = path.posix.normalize(p.replace(/\\/g, '/').replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:')).replace(/\/+$/, '').toLowerCase();
  const profiles = path.posix.dirname(path.posix.normalize(home.replace(/\\/g, '/')).replace(/\/+$/, '')).toLowerCase();
  if (!/^[a-z]:\/./.test(profiles) || !n.startsWith(profiles + '/')) return false;
  return /^[^/]+\/appdata\/(?:locallow|local|roaming)\/never games(?:\/|$)/.test(n.slice(profiles.length + 1));
}

/**
 * Whether `p` is somewhere a Windows worker may read, measure or delete on (w1755): on the install folder's drive, and when
 * that drive is C: only inside the folder itself. Always true for a POSIX root (macOS and Linux keep the w896 rule), and for a
 * path that is not a drive path.
 */
export function onInstallDrive(p: string, root: string | undefined): boolean {
  const drive = installDrive(root);
  if (!drive) return true;
  const n = p.replace(/\\/g, '/').replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:').toLowerCase();
  const d = /^([a-z]):(?:\/|$)/.exec(n)?.[1];
  if (!d) return true;
  if (d !== drive) return false;
  if (drive !== 'c') return true;
  const r = path.posix.normalize(root!.replace(/\\/g, '/')).replace(/\/+$/, '').toLowerCase();
  const x = path.posix.normalize(n).replace(/\/+$/, '');
  return x === r || x.startsWith(r + '/');
}

/** Programs that walk a whole tree whatever their flags. */
const ALWAYS_SCAN = new Set(['du', 'dust', 'ncdu', 'gdu', 'tree', 'find', 'ff-leftovers']);
/** Listers that walk a tree only with a recursive flag (`-Recurse`, `-r`, `-R`, cmd's `/s`). */
const RECURSIVE_LISTERS = new Set(['get-childitem', 'gci', 'ls', 'dir']);
const isRecursiveFlag = (a: string) => /^-(?:r|rec\w*)(?::\$true)?$/i.test(a) || /^\/s$/i.test(a) || /^-[a-zA-Z]*R[a-zA-Z]*$/.test(a) || a === '--recursive';
/** Value flags of the scanners whose next word is no path (du -d 1, find -maxdepth 2, Get-ChildItem -Depth 3). */
const SCAN_VALUE_FLAGS = new Set(['-d', '--max-depth', '-depth', '--block-size', '-t', '--threshold', '--exclude', '-filter', '-include', '-exclude', '-erroraction', '-ea', '-attributes']);

/**
 * The reason a shell command is refused because it scans or measures off this Windows computer's install drive, or undefined
 * (w1755, lothsahn, 2026-10-22: "Your worker on LothDesktop is still scanning c:  it should not.  You need to only look at v:.
 * Stop messing with my c:" and "Fix the instructions for Windows boxes to only look at v:"). A LothDesktop clean-up worker
 * ran du over C:\Users\...\AppData and ~\.claude because the rules said to "measure and report" outside the install folder.
 * Read here: du, dust, ncdu, gdu, tree, find, `ff-leftovers check <path>`, `robocopy <source> ... /L` (the w1561 way to size
 * a Windows folder; its source is judged), and Get-ChildItem / gci / ls / dir with -Recurse, -r, -R or /s (whatever follows
 * them in a pipeline, Measure-Object included); deletes are the delete fence's
 * (checkOutsideRootDelete, which already refuses any outside the install folder). The allowed drive is the install folder's
 * (root.json's root: V:\ffw on LothDesktop, F:\ffw on BEAST), never a fixed letter; a root on C: allows only the folder
 * itself. The game's data folders under AppData (inNeverGames) may be read too. Only a Windows root is judged. Like the rest of the guard it is a SEATBELT: a script, python's os.walk or a
 * variable it cannot resolve is the instructions' job. Exported for tests.
 */
export function checkOffDriveScan(cmd: string, ctx: RootFenceContext): string | undefined {
  if (!installDrive(ctx.root)) return undefined;
  const home = ctx.home ?? os.homedir();
  const norm = (p: string) => path.posix.normalize(p.replace(/\\/g, '/')).replace(/\/+$/, '').toLowerCase();
  const allowed = (ctx.allow ?? []).map(norm);
  let dir: string | undefined = ctx.cwd ? norm(ctx.cwd) : undefined;

  const judge = (raw: string | undefined, verb: string): string | undefined => {
    const n = raw === undefined ? dir : resolvePath(raw, { home, cwd: dir, win: true });
    if (n === undefined || n === 'ok') return undefined;
    if (onInstallDrive(n, ctx.root) || inNeverGames(n, home) || allowed.some((a) => n === a || strictlyInside(n, a))) return undefined;
    const shown = raw === undefined ? `the current folder ${n}` : unquote(raw);
    return (
      `Refused: ${verb} would scan ${shown}, off this Windows computer's install drive ${driveLabel(ctx.root)} (the install folder is ${ctx.root}). ` +
      `On Windows, disk work (clean-ups, low-disk checks, leftover scans, disk measurements) reads, measures and deletes only on the install ` +
      `drive, never on C: (lothsahn, 2026-10-22, w1755: "Your worker on LothDesktop is still scanning c:  it should not.  You need to only look ` +
      `at v:.  Stop messing with my c:"). The one exception on C: is reading the game's data folders under AppData (AppData\\LocalLow\\Never Games, ` +
      `and AppData\\Local's and AppData\\Roaming's Never Games), which nothing modifies (lothsahn: "Let's let it scan the never games folder, but not ` +
      `the rest of C.  And it shouldn't modify it."). Measure inside ${ctx.root} instead (\`ff-leftovers folders\`, du of a folder there), and say ` +
      `in your report what you could not free there; do not ask a person to look on C: either (docs/self-recovery.md, "Where clean-up may delete").`
    );
  };

  /** The paths a scanner names; none means the current folder. */
  const scanPaths = (verb: string, args: string[]): string[] => {
    // robocopy <source> <destination> /L: only the source is read.
    if (verb === 'robocopy') return args.map(unquote).filter((a) => !a.startsWith('/')).slice(0, 1);
    const out: string[] = [];
    let flags = true;
    for (let i = verb === 'ff-leftovers' ? 1 : 0; i < args.length; i++) {
      const a = unquote(args[i]);
      const low = a.toLowerCase();
      if (flags && a === '--') {
        flags = false;
        continue;
      }
      if (verb === 'find' && flags && (['!', '(', ')'].includes(a) || a.startsWith('-'))) break; // find's expression
      if (flags && PATH_FLAGS.has(low.replace(/:.*$/, ''))) {
        const inline = /^-[a-z]+:(.+)$/i.exec(a)?.[1];
        const v = inline ?? (i + 1 < args.length ? unquote(args[++i]) : undefined);
        if (v) out.push(...v.split(','));
        continue;
      }
      if (flags && SCAN_VALUE_FLAGS.has(low)) {
        i++;
        continue;
      }
      if (flags && a.startsWith('-')) continue;
      if (flags && ['dir', 'tree'].includes(verb) && /^\/[a-zA-Z](?::.*)?$/.test(a)) continue; // cmd's /s /a /f
      out.push(...a.split(',').filter(Boolean));
    }
    return out;
  };

  const run = (command: string): string | undefined => {
    for (const stages of statements(command)) {
      for (let stage of stages) {
        for (let k = 0; k < 5 && stage.search(SUBSTITUTION) >= 0; k++) stage = stage.replace(SUBSTITUTION, '$$SUB');
        const w = words(stage);
        let i = 0;
        while (i < w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]) || ['&', '.', 'sudo', 'exec', 'nohup', 'time', 'env', 'command'].includes(unquote(w[i]).toLowerCase()))) i++;
        const verb = w[i] ? verbOf(w[i]) : '';
        const args = w.slice(i + 1);
        if (['cd', 'pushd', 'chdir', 'set-location', 'sl', 'push-location'].includes(verb)) {
          const target = args.map(unquote).find((a) => !a.startsWith('-') || a === '-');
          const n = target ? resolvePath(target, { home, cwd: dir, win: true }) : undefined;
          dir = n && n !== 'ok' ? n : undefined;
          continue;
        }
        const payload = args.findIndex((a, k) => SHELL_PAYLOAD_FLAGS.has(unquote(a).toLowerCase()) && k + 1 < args.length);
        if (payload >= 0 && /^(?:bash|sh|zsh|dash|cmd|powershell|pwsh)$/.test(verb)) {
          const r = run(unquote(args.slice(payload + 1).join(' ')));
          if (r) return r;
          continue;
        }
        // ff-leftovers list, end and folders read the daemon's own facts; only `check <path>` names a path.
        if (verb === 'ff-leftovers' && unquote(args[0] ?? '').toLowerCase() !== 'check') continue;
        const scans =
          ALWAYS_SCAN.has(verb) ||
          (RECURSIVE_LISTERS.has(verb) && args.some((a) => isRecursiveFlag(unquote(a)))) ||
          (verb === 'robocopy' && args.some((a) => /^\/l$/i.test(unquote(a))));
        if (!scans) continue;
        const ps = scanPaths(verb, args);
        for (const t of ps.length ? ps : verb === 'ff-leftovers' ? [] : [undefined]) {
          const r = judge(t, verb);
          if (r) return r;
        }
      }
    }
    return undefined;
  };
  return run(cmd);
}
