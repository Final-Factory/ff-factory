/**
 * w6266 (lothsahn: "w6264 follow-up: warn-only guard for rm -r over a tree holding a junction on Windows"). On a Windows
 * worker, Git Bash's `rm -rf` on a folder holding a junction deletes the folder the junction points at, then fails on the
 * junction (w6252 on BEAST; w6264 and w6266 on LothDesktop, measured). In a worker session every junction, whether `cmd /c mklink /J`,
 * PowerShell's `New-Item -ItemType Junction` or Node's `symlinkSync(..., 'junction')` made it, stores its target as
 * `\??\Global\X:\...`. lstat calls that a plain folder; a folder entry read with `readdir({ withFileTypes: true })` calls it
 * a link (w5915). The worker prompt says to delete a folder with `rd /s /q` on Windows (w6264). This check is the backstop
 * for habit. It is WARN-ONLY (lothsahn's lockout rule): before an `rm -r` runs, it walks each target folder within a budget,
 * and when it finds a link it logs one line and tells the agent to use `rd`. It always lets the command run. The step that
 * refuses or rewrites the command is a separate pull request, after a week of these lines.
 */
import fs from 'node:fs';
import path from 'node:path';
import { statements, unquote, verbOf, words, SUBSTITUTION } from './rootFence.ts';

/** The walk's budget: a Library-sized tree (hundreds of thousands of entries) must not stall the hook. */
export const WALK_MAX_ENTRIES = 20_000;
export const WALK_MAX_MS = 200;

export interface JunctionRmContext {
  /** The shell's working folder. */
  cwd?: string;
  /** The shell's variables (TMPDIR, TMP, TEMP, HOME). */
  env?: Record<string, string | undefined>;
  maxEntries?: number;
  maxMs?: number;
  now?: () => number;
}

/** What the walk of one target found. */
export interface LinkFound {
  /** The target as the command named it, resolved. */
  target: string;
  /** The first link inside it (or the target itself). */
  link: string;
  /** Whether lstat also calls it a link: then Git Bash may well remove only the link (a likely false positive). */
  lstatLink: boolean;
}

export interface JunctionRmResult {
  found: LinkFound[];
  /** Targets whose walk ran out of budget before it finished with no link found: not known either way. */
  unfinished: string[];
}

const RECURSIVE = (a: string) => a === '--recursive' || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(a);

/** A path as an `rm` word names it, made absolute in Windows form, or undefined when the text does not say. */
export function rmTargetPath(raw: string, ctx: JunctionRmContext): string | undefined {
  let p = unquote(raw).trim();
  if (!p) return undefined;
  const env = ctx.env ?? {};
  p = p.replace(/^(?:\$\{?(TMPDIR|TMP|TEMP|HOME)\}?|~)(?=$|[\\/])/, (_m, v: string | undefined) => env[v ?? 'HOME'] ?? '$');
  // Another variable, a substitution or a glob: not judged (the walk would guess at the shell's expansion).
  if (/[$`*?[\]{}]/.test(p)) return undefined;
  p = p.replace(/\\/g, '/');
  p = p.replace(/^\/cygdrive\/([a-zA-Z])(?=\/|$)/, '$1:').replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:');
  if (/^[a-zA-Z]:$/.test(p)) p += '/';
  if (!/^[a-zA-Z]:\//.test(p)) {
    if (p.startsWith('/')) return undefined; // an MSYS path that is no drive (/tmp, /usr): where it points is the shell's
    const cwd = ctx.cwd?.replace(/\\/g, '/').replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:');
    if (!cwd || !/^[a-zA-Z]:\//.test(cwd)) return undefined;
    p = `${cwd}/${p}`;
  }
  return path.win32.normalize(p.replace(/^[a-z]:/, (d) => d.toUpperCase()));
}

/** The folders each `rm -r` / `rm -rf` of a command names (Git Bash's rm only: rd and Remove-Item keep a junction's target). */
export function rmRecursiveTargets(cmd: string, ctx: JunctionRmContext): string[] {
  const out: string[] = [];
  let cwd = ctx.cwd;
  for (const stages of statements(cmd)) {
    for (let stage of stages) {
      for (let n = 0; n < 5 && stage.search(SUBSTITUTION) >= 0; n++) stage = stage.replace(SUBSTITUTION, '$$SUB');
      const w = words(stage);
      let i = 0;
      while (i < w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]) || ['sudo', 'exec', 'nohup', 'time', 'env', 'command'].includes(unquote(w[i]).toLowerCase()))) i++;
      const verb = w[i] ? verbOf(w[i]) : '';
      const args = w.slice(i + 1);
      if (verb === 'cd' || verb === 'pushd') {
        const t = args.map(unquote).find((a) => !a.startsWith('-'));
        cwd = t ? rmTargetPath(t, { ...ctx, cwd }) : undefined;
        continue;
      }
      if (verb !== 'rm') continue;
      let flags = true;
      let recursive = false;
      const paths: string[] = [];
      for (const raw of args) {
        const a = unquote(raw);
        if (flags && a === '--') flags = false;
        else if (flags && a.startsWith('-') && a.length > 1) recursive ||= RECURSIVE(a);
        else paths.push(raw);
      }
      if (!recursive) continue;
      for (const raw of paths) {
        const p = rmTargetPath(raw, { ...ctx, cwd });
        if (p) out.push(p);
      }
    }
  }
  return out;
}

/** Whether `name` in `dir` is a link by its folder entry (true for the `\??\Global\` junction lstat misses). */
function entryIsLink(dir: string, name: string): boolean {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.name.toLowerCase() === name.toLowerCase() && e.isSymbolicLink());
  } catch {
    return false;
  }
}

const lstatIsLink = (p: string) => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * The first link at or inside `target`, by folder entries, within the budget. `undefined` link: none found; `done` false:
 * the budget ran out first. Never follows a link.
 */
export function firstLink(target: string, ctx: JunctionRmContext = {}): { link?: string; done: boolean } {
  const maxEntries = ctx.maxEntries ?? WALK_MAX_ENTRIES;
  const maxMs = ctx.maxMs ?? WALK_MAX_MS;
  const now = ctx.now ?? Date.now;
  const start = now();
  const parent = path.dirname(target);
  if (parent !== target && entryIsLink(parent, path.basename(target))) return { link: target, done: true };
  const stack = [target];
  let seen = 0;
  while (stack.length) {
    if (seen > maxEntries || now() - start > maxMs) return { done: false };
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // gone, not a folder, or unreadable: rm will say so itself
    }
    for (const e of entries) {
      seen++;
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) return { link: p, done: true };
      if (e.isDirectory()) stack.push(p);
    }
  }
  return { done: true };
}

/** What a command's `rm -r` targets hold. Never throws: a bug here must not cost a worker its shell. */
export function junctionRmScan(cmd: string, ctx: JunctionRmContext): JunctionRmResult {
  const res: JunctionRmResult = { found: [], unfinished: [] };
  try {
    if (!/(?:^|[\s;&|(`'"/\\])rm(?:\.exe)?\s/.test(cmd)) return res;
    for (const target of rmRecursiveTargets(cmd, ctx)) {
      const r = firstLink(target, ctx);
      if (r.link) res.found.push({ target, link: r.link, lstatLink: lstatIsLink(r.link) });
      else if (!r.done) res.unfinished.push(target);
    }
  } catch {
    /* warn-only: nothing found */
  }
  return res;
}

/** The note the agent reads before its command runs. */
export function junctionRmMessage(found: LinkFound[]): string {
  const f = found[0];
  return (
    `Warning (the command still runs): ${f.target} holds a link, ${f.link}. On Windows, Git Bash's \`rm -rf\` goes through a junction ` +
    `and deletes the folder it points at, then fails on the junction. Delete a folder with \`cmd //c "rd /s /q ${f.target}"\` ` +
    `(or \`Remove-Item -LiteralPath "${f.target}" -Recurse -Force\` in PowerShell): it removes the junction and keeps its target. ` +
    `If this rm already ran, check that the folder the link pointed at is still whole, and say in your report what it removed.` +
    (found.length > 1 ? ` (${found.length - 1} more target${found.length > 2 ? 's' : ''} of this command hold links too.)` : '')
  );
}

/**
 * The line a 'junctionRm' signal carries (arg { line }), or undefined when it is not one: it crossed a machine link, so it is
 * checked, kept to one line and capped.
 */
export function junctionRmSignalLine(arg: unknown): string | undefined {
  const line = arg && typeof arg === 'object' ? (arg as { line?: unknown }).line : undefined;
  if (typeof line !== 'string' || !line.startsWith('junction rm warn (w6266, warn): ')) return undefined;
  return line.replace(/[\r\n]+/g, ' ').slice(0, 4000);
}

/** The one log line per command, for counting hits and likely false positives (`lstatLink=true`) over the warn week. */
export function junctionRmLogLine(session: string | undefined, r: JunctionRmResult): string | undefined {
  if (!r.found.length && !r.unfinished.length) return undefined;
  const hits = r.found.map((f) => `hit target=${JSON.stringify(f.target)} link=${JSON.stringify(f.link)} lstatLink=${f.lstatLink}`);
  const open = r.unfinished.map((t) => `unfinished target=${JSON.stringify(t)}`);
  return `junction rm warn (w6266, warn): ${session ?? '-'} ${[...hits, ...open].join(' ')}`;
}
