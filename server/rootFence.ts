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

const TMP_VAR = /^(?:\$env:(?:tmp|temp)|\$\{?(?:tmp|temp|tmpdir)\}?|%(?:tmp|temp)%)(?=$|[\\/])/i;
const SAVES = /\/never games\/finalfactory[^/]*\/saves\/[^/*?]+/i;

const unquote = (w: string) => w.replace(/^["']|["']$/g, '');

/** The words of a statement, quoted ones kept whole. */
const words = (s: string) => s.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];

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

  const judge = (raw: string): string | undefined => {
    const n = resolvePath(raw, { home, cwd: dir, win });
    if (n === undefined || n === 'ok') return undefined;
    if (allowed.some((a) => strictlyInside(n, a))) return undefined;
    if (SAVES.test(n)) return undefined;
    const why = allowed.includes(n) ? `${unquote(raw)} is the install folder itself` : `${unquote(raw)} is outside this machine's worker install folder (${ctx.root})`;
    return (
      `Refused: ${why}. Disk clean-up deletes only inside the worker install folder (lothsahn, 2026-10-10, w896: "in general we should only be ` +
      `clearing data in the install folder for the worker"). Outside it, measure and report sizes (du, Get-ChildItem | Measure-Object), and list ` +
      `any setting or script that makes FF Factory write there so it can be moved inside the folder; delete nothing there, and do not ask a person ` +
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
      }
    }
    return undefined;
  };
  return run(cmd);
}
