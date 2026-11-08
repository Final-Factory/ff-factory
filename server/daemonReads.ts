import os from 'node:os';
import path from 'node:path';
import { flatten, normPath, pathSpellings, shellWords, spellingsRegex, splitShell, GIT_READ_ONLY } from './mainCloneGuard.ts';
import { globBase, mayList, readProblem, realReadFs, type ReadCtx, type ReadFs, type SecretRules } from './secretGuard.ts';

/**
 * w3670 (lothsahn, 2026-11-08: "Please give workers read only access to the logs and other reasonable daemon files it might ever
 * need"): a machine worker READS its daemon's diagnostic files, and nothing else there. The daemon's folder stays a protected
 * path of sandboxGuard (server/guard.ts): Write and Edit there are refused, and so is every shell command naming it that is not a
 * plain read of an allowed file below. w3650's worker on LothDesktop could not `tail` D:\work\ffw\daemon\logs\daemon.log.
 *
 * The daemon's folder is appDirOf(m) (shared/types.ts): `<host>\daemon` on a Windows worker install (D:\work\ffw\daemon on
 * LothDesktop, F:\ffw\daemon on BEAST; scripts/worker/worker.ts layoutOf), `<root>/daemon` or ~/.ff-factory on a Mac. What a
 * worker may read there is an allow-list (DAEMON_READ_ALLOW); the rest of it stays closed, and so does the install's secrets
 * folder (secrets/machine-token, the machine credential). Closed on purpose, because each can hold a secret or another
 * worker's words:
 *   - daemon.json (and daemon.json.*): the daemon's config; an install that is not a worker root keeps the machine `token` in it
 *     (server/machineDeploy.ts);
 *   - gh-app/: GitHub App installation tokens (machine/ghApp.ts tokens.json);
 *   - hosts/: each agent host's commands and output (machine/agentHost.ts in.jsonl, out.jsonl): other workers' conversations;
 *   - agents/: standing agents' own folders; max-events.jsonl: Discord events for Max; update/*.bundle: a git bundle (code, no
 *     secret, but not a diagnostic: read src/ instead);
 *   - <host>/secrets and <root>/secrets: the machine credential.
 * Like the rest of the guard this is a seatbelt (a script or python reading the file is the instructions' job).
 */

/** Below the daemon's folder: what a worker may read (a folder covers all below it). */
export const DAEMON_READ_ALLOW = [
  // Its logs: daemon.log, daemon.err.log and their rolled copies (daemon.log.<UTC stamp>.gz), supervisor.log, update-job.log,
  // before-migration/ (machine/logRetention.ts, machine/selfUpdate.ts updateFiles). The daemon masks secret values in its log.
  'logs',
  // The code that ran: the worker install's checkout (src) and the older deploys' copy (app) (server/machineDeploy*.ts).
  'src',
  'app',
  // The last self-update's job and result (machine/selfUpdate.ts UpdateJob: ids, commits, phases, no secret).
  'update/job.json',
  'update/result.json',
  // State and settings with no secret: the sandbox pool, pause, a person playing, clean-up settings, facts and log, what was
  // published, the spare root.json, the outside-folder watch, Firefox, the Windows supervisor script, the Unity slot mailbox.
  'sandboxes.json',
  'pause.json',
  'person-play.json',
  'cleanup.json',
  'cleanup-facts.json',
  'cleanup-log.jsonl',
  'cleanup-state.json',
  'published.jsonl',
  'root-backup.json',
  'outside-watch.json',
  'firefox.json',
  'run-daemon.ps1',
  'unity-slots',
];

/** Beside the daemon's folder, in the install's host folder (scripts/worker/driveRoot.ts HOST_FILES): no secret. */
export const HOST_READ_ALLOW = ['devdrive.json', 'root.json', 'moved.json'];

export interface DaemonReads {
  /** The daemon's folder (appDirOf). */
  dir: string;
  /** The worker install folder (root.json's root), whose secrets folder stays closed. */
  root?: string;
  platform?: NodeJS.Platform;
  home?: string;
  fsx?: ReadFs;
  cwd?: string;
}

const winLike = (p: string) => /^[a-zA-Z]:[\\/]/.test(p);
const join = (dir: string, rel: string) => `${dir.replace(/[\\/]+$/, '')}/${rel}`;
const parentOf = (dir: string) => dir.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '');

/** The secretGuard rules a worker's reads into the daemon's folder are judged by. */
export function daemonReadRules(r: DaemonReads): SecretRules {
  const host = parentOf(r.dir);
  return {
    deny: [r.dir, join(host, 'secrets'), ...(r.root ? [join(r.root, 'secrets')] : [])],
    allow: DAEMON_READ_ALLOW.map((a) => join(r.dir, a)),
    // Names, never contents: an ls of the daemon's folder shows daemon.json, not what it holds.
    list: [r.dir],
  };
}

function ctxOf(r: DaemonReads): ReadCtx {
  const platform = r.platform ?? (winLike(r.dir) ? 'win32' : process.platform);
  return { platform, home: r.home ?? os.homedir(), cwd: r.cwd ?? r.dir, fsx: r.fsx ?? realReadFs };
}

/** The closed-path refusal for a worker. */
const closed = (target: string, r: DaemonReads) =>
  `${target} is closed to workers: it can hold a secret (the machine credential, tokens) or other workers' words. In the daemon's folder ${r.dir} a worker reads only: ` +
  `${DAEMON_READ_ALLOW.join(', ')}; beside it ${HOST_READ_ALLOW.join(', ')} (w3670). Ask your orchestrator for anything else there.`;

/** Why a Read, Grep, Glob or LS call into the daemon's folder or a secrets folder is refused, or undefined. */
export function daemonToolProblem(targets: { path: string; kind: 'file' | 'search'; names?: true }[], r: DaemonReads): string | undefined {
  const rules = daemonReadRules(r);
  const c = ctxOf(r);
  for (const t of targets) {
    if (!t.path) continue;
    if (t.names && mayList(t.path, rules, c)) continue;
    if (readProblem(t.path, t.kind, rules, c)) return closed(t.path, r);
  }
  return undefined;
}

/** Programs that only read the files they name (and print to the shell). */
const FILE_READERS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'wc', 'zcat', 'gzcat', 'zless', 'zmore', 'strings', 'jq', 'sort', 'uniq', 'cut', 'stat', 'file', 'md5sum', 'sha256sum',
  'type', 'get-content', 'gc', 'get-item', 'gi', 'test-path', 'get-filehash', 'select-string', 'sls',
]);
/** Programs that read a whole tree when told to (grep -r), or always (rg). */
const SEARCHERS = new Set(['grep', 'egrep', 'fgrep', 'zgrep', 'rg']);
/** Programs that list names: ls, find, Get-ChildItem (a tree's names, never contents). */
const LISTERS = new Set(['ls', 'dir', 'get-childitem', 'gci', 'find', 'du']);
/** What may sit beside a read of the daemon's files in one command (filters of its output, a cd, an echo). */
const BESIDE = new Set(['head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'echo', 'printf', 'true', 'false', 'grep', 'egrep', 'jq', 'date', 'cd', 'select-object', 'measure-object', 'out-string', 'format-list', 'format-table', 'where-object', 'select-string', 'sls', 'cat', 'less', 'more', 'zcat', 'gzcat']);
/** find's actions that run, delete or write. */
const FIND_REFUSED = /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/i;

/**
 * Whether a shell command names the daemon's folder (or a host file beside it), and, when it does, why it is refused (undefined:
 * every simple command naming it is a plain read of what DAEMON_READ_ALLOW and HOST_READ_ALLOW name). `strip` takes those names
 * out of the flattened command, so sandboxGuard's protected-path check still sees every other protected path in it.
 */
export function daemonShell(cmd: string, r: DaemonReads): { named: boolean; why?: string; strip: (flat: string) => string } {
  const c = ctxOf(r);
  const home = normPath(c.home);
  // The secrets folders too, so a shell read of them is judged (and refused) like a Read.
  const names = [normPath(r.dir), ...HOST_READ_ALLOW.map((f) => normPath(join(parentOf(r.dir), f))), ...daemonReadRules(r).deny.slice(1).map(normPath)];
  const spellings = names.flatMap((n) => pathSpellings(n, home));
  const re = spellingsRegex(spellings);
  const count = (s: string) => {
    re.lastIndex = 0;
    return (flatten(s).match(re) ?? []).length;
  };
  const strip = (flat: string) => {
    re.lastIndex = 0;
    return flat.replace(re, ' ');
  };
  if (!count(cmd)) return { named: false, strip };
  const rules = daemonReadRules(r);
  const refuse = (why: string) => ({
    named: true,
    strip,
    why:
      `Refused in the FF Factory daemon's folder ${r.dir}: ${why}. A worker only reads there (w3670): cat, head, tail, less, wc, zcat, grep, rg, ls, find (no -exec or -delete), ` +
      `Get-Content, Select-String, Get-ChildItem, and read-only git in its src folder, of ${DAEMON_READ_ALLOW.join(', ')}, and ${HOST_READ_ALLOW.join(', ')} beside it. ` +
      'Writing, deleting, moving or running anything there stays refused; copy a log into your $TMPDIR with `tail -n 2000 <log> > "$TMPDIR/daemon.log"` to work on it.',
  });
  // A word as the path it names: home spellings to "~", a flag's inline value (-Path:x, --file=x) to x.
  const asPath = (w: string) => {
    let x = w.replace(/^-{1,2}[A-Za-z][\w-]*[:=](?=.)/, '');
    x = x.replace(/^(?:\$home|\$\{home\}|%userprofile%|\$env:userprofile)(?=[\\/]|$)/i, '~');
    return x;
  };
  const judge = (w: string, kind: 'file' | 'search' | 'names'): string | undefined => {
    let p = asPath(w);
    if (/[*?[\]{}]/.test(p)) {
      p = globBase(p);
      if (kind === 'file') kind = 'search';
    }
    if (kind === 'names' && mayList(p, rules, c)) return undefined;
    if (readProblem(p, kind === 'names' ? 'search' : kind, rules, c)) return `${w} is closed to workers (it can hold a secret or other workers' words)`;
    return undefined;
  };

  for (const seg of splitShell(cmd)) {
    const words = shellWords(seg);
    const prog0 = path.basename((words.find((w) => !/^\w+=/.test(w)) ?? '').replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
    if (!count(seg)) {
      // `ls <daemon> | xargs rm` must not get past because the second command never names where it acts.
      if (!BESIDE.has(prog0)) return refuse(`${prog0 || 'that'} cannot run beside a read of the daemon's files (only filters such as head, tail, grep, sort, wc can)`);
      if (/\$\(|`|<\(|>\(/.test(seg)) return refuse('a command substitution beside the daemon\'s files cannot be checked');
      continue;
    }
    if (/\$\(|`|<\(|>\(/.test(seg)) return refuse('a command substitution next to the daemon\'s files cannot be checked');
    // Redirects: into the daemon's folder is a write there; out to anywhere else (your $TMPDIR) is fine; `< file` is a read.
    let w: string[] = [];
    for (let i = 0; i < words.length; i++) {
      const out = /^(?:\d*|&)>>?(?:&\d*)?(.*)$/.exec(words[i]);
      if (out) {
        const target = out[1] || words[i + 1] || '';
        if (count(target)) return refuse('a redirect into the daemon\'s folder writes a file there');
        if (!out[1] && !/&\d*$/.test(words[i])) i++;
        continue;
      }
      const inp = /^<(.*)$/.exec(words[i]);
      if (inp) {
        const target = inp[1] || words[i + 1] || '';
        if (count(target)) {
          const why = judge(target, 'file');
          if (why) return refuse(why);
        }
        if (!inp[1]) i++;
        continue;
      }
      w.push(words[i]);
    }
    if (!w.length) continue;
    if (/^\w+=/.test(w[0])) return refuse('an environment prefix changes what the command does');
    if (w[0] === '&' || w[0] === '.') w = w.slice(1);
    const prog = path.basename(w[0].replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
    const args = w.slice(1);
    const named = args.filter((a) => count(a));
    if (count(w[0])) return refuse(`${w[0]} would run a program from there`);

    if (prog === 'git') {
      // git -C <daemon>/src log|show|status|diff...: the code that ran.
      let i = 0;
      while (i < args.length && args[i].startsWith('-')) {
        if (args[i] === '-C' && args[i + 1]) i += 2;
        else if (args[i] === '--no-pager' || args[i] === '-P') i++;
        else return refuse(`git option ${args[i]} is not allowed there`);
      }
      const sub = args[i];
      if (!sub || !GIT_READ_ONLY.has(sub)) return refuse(`git ${sub ?? ''} is not a read-only git command`);
      if (args.some((a) => /^--(?:output|ext-diff|textconv)/.test(a))) return refuse('git --output, --ext-diff and --textconv write files or run programs');
      for (const a of named) {
        const why = judge(a, 'search');
        if (why) return refuse(why);
      }
      continue;
    }
    if (prog === 'gzip' || prog === 'gunzip') {
      // Only to the screen: -c / --stdout (with -d), -t, -l.
      if (!args.some((a) => /^(?:-[a-z]*[ctl][a-z]*|--stdout|--to-stdout|--test|--list)$/.test(a))) return refuse(`${prog} without -c, -t or -l writes or removes files`);
      for (const a of named) {
        const why = judge(a, 'file');
        if (why) return refuse(why);
      }
      continue;
    }
    if (prog === 'sed') {
      if (args.some((a) => /^(?:-[a-zA-Z]*i|--in-place)/.test(a))) return refuse('sed -i writes the file');
      // Only printing scripts (sed -n '1,40p', '$p', '/x/p'): a `w` or `e` command writes or runs.
      const scripts = args.filter((a) => !a.startsWith('-') && !count(a));
      if (!scripts.every((s) => /^(?:\$|\d+|\/[^/]*\/)?(?:,(?:\$|\d+|\/[^/]*\/))?p$/.test(s))) return refuse('only sed -n \'<from>,<to>p\' reads there');
      for (const a of named) {
        const why = judge(a, 'file');
        if (why) return refuse(why);
      }
      continue;
    }
    if (FILE_READERS.has(prog) || SEARCHERS.has(prog)) {
      if (prog === 'sort' && args.some((a) => /^(?:-o|--output)/.test(a))) return refuse('sort -o writes a file');
      const recursive = prog === 'rg' || args.some((a) => /^(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--dereference-recursive|-recurse)$/i.test(a));
      for (const a of named) {
        const why = judge(a, recursive ? 'search' : 'file');
        if (why) return refuse(why);
      }
      continue;
    }
    if (LISTERS.has(prog)) {
      if (prog === 'find' && args.some((a) => FIND_REFUSED.test(a))) return refuse('find -exec, -ok, -delete and -fprint run, delete or write');
      for (const a of named) {
        const why = judge(a, 'names');
        if (why) return refuse(why);
      }
      continue;
    }
    // A cd into it would let a later relative name (cat daemon.json) past the check: name each file by its full path.
    if (prog === 'cd' || prog === 'pushd' || prog === 'set-location' || prog === 'sl') return refuse('a cd into the daemon\'s folder is refused: name the file you read by its full path');
    return refuse(`${w[0]} is not a read`);
  }
  return { named: true, strip };
}
