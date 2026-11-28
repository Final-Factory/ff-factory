/**
 * Git that runs no program a checkout's own config names (w5541).
 *
 * A worker writes its checkout's git config freely (`git config` in its worktree writes the clone's shared config, and a
 * `.git` file can point at a git folder the worker made), so any git the machine daemon, the agent host or another Medium
 * process runs there could start a program the worker chose: `core.fsmonitor` runs on `git status`, hooks on a commit or a
 * checkout, a filter's `clean` on `git status` of a changed file, a credential helper on a fetch. Every such git call goes
 * through this module: `run()` (server/proc.ts) and the other generic runners call gitFence/gitFenceSync when the program
 * is git, and a direct child_process call uses the wrappers below. `safeGit.test.ts` fails on a git spawn that does not.
 *
 * What it does, all as command-scope config (GIT_CONFIG_COUNT, which outranks every config file; the caller's own entries
 * and `-c` options come after and still win):
 * - FIXED: keys whose name is known, forced every call, with no race against the worker: no fsmonitor, hooks read from
 *   FF Factory's own folder (server/gitHooks: git-lfs's four hooks and nothing else, so a push still uploads LFS objects;
 *   not `/dev/null`, which would be `\dev\null` on a Windows drive a worker can write), the `cat` pager, `:` editors, no `core.alternateRefsCommand` (w6082), no signing or signature checks (a gpg program never runs), and remote
 *   transports limited to https, http, ssh and file (`ext::` and named remote helpers are refused). Same list as w5514's
 *   standing agents (server/launch.ts STANDING_GIT_CONFIG) except `safe.bareRepository=explicit`: the machines' main
 *   clones are bare and the daemon runs `git -C <bare clone>`, which `explicit` refuses.
 * - SCANNED: keys a repository names freely (`filter.<driver>.clean`, `diff.<driver>.textconv`, `merge.<driver>.driver`,
 *   `remote.<name>.uploadpack`, a credential helper, git-lfs's custom transfer agents). One `git config` call (which runs
 *   no program) reads them in the call's own repository; each one a repository scope sets takes the user's or system's
 *   value back, else a neutral one (git-lfs's standard filter for `filter.lfs.*`, so LFS files still check out). A
 *   repository's credential helpers are dropped and the user's and system's added again in their order. This one has a
 *   race: a worker who writes the key between the scan and the call wins it, so it narrows the gap without closing it.
 *   Calls that start none of those programs and read no object (config, symbolic-ref, worktree list, a plain rev-parse:
 *   needsScan) skip it (w5991). A repository's `protocol.<name>.allow` is scanned too and refused again (w6570).
 * - FIRST-WINS: `remote.<name>.uploadpack`, `remote.<name>.receivepack` and `core.gitProxy` keep the first value git reads,
 *   so no override by value works (w6570). fetch, pull and ls-remote get `--upload-pack=`, push `--receive-pack=`
 *   (firstWinsArgs); the calls that option cannot cover are refused (firstWinsRefusal).
 * - `diff`, `log`, `show` and `whatchanged` also get `--no-ext-diff --no-textconv`: `diff.external` cannot be overridden
 *   by value (an empty one makes every `git diff` fail, measured by w5514 on git 2.50.1), and the flags need no scan.
 *
 * Measured on git 2.50.1 (safeGit.test.ts): an empty `filter.<d>.clean` or `diff.<d>.textconv` leaves `git status` and
 * `git diff` working with no program run; a `core.hooksPath` naming a regular file runs no hook.
 */
import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  type ExecFileSyncOptions,
  type SpawnOptions,
  type SpawnSyncOptions,
} from 'node:child_process';
import path from 'node:path';
import { runOffThread } from './hostProbe.ts';
import { execFileOffThread, type ThreadExecOptions } from './spawnThread.ts';
import type { RunResult } from './proc.ts';
import { fileURLToPath } from 'node:url';

type Env = NodeJS.ProcessEnv;

/** The hooks git finds: git-lfs's own and no other, in the daemon's code, which no worker writes (server/gitHooks). */
export const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'gitHooks');

/** Forced on every git call; see the header. */
export const FIXED_GIT_CONFIG: [string, string][] = [
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', HOOKS],
  ['core.pager', 'cat'],
  ['core.editor', ':'],
  // Run by a fetch or a receive in a repository whose objects/info/alternates names another (w6082). Empty starts nothing:
  // git tries to run '', reads no alternate refs, and the fetch still works (measured, git 2.56.1, GIT_TRACE).
  ['core.alternateRefsCommand', ''],
  ['sequence.editor', ':'],
  ['log.showSignature', 'false'],
  ['commit.gpgSign', 'false'],
  ['tag.gpgSign', 'false'],
  ['push.gpgSign', 'false'],
  ['merge.verifySignatures', 'false'],
  ['protocol.allow', 'never'],
  ['protocol.https.allow', 'always'],
  ['protocol.http.allow', 'always'],
  ['protocol.ssh.allow', 'always'],
  ['protocol.file.allow', 'always'],
];

/** Keys a repository may name a program in, read per call (canonical names: section and key lower case). */
export const SCANNED_KEYS =
  '^(filter\\..+\\.(clean|smudge|process)|merge\\..+\\.driver|diff\\..+\\.(command|textconv)|hook\\..+\\.command|remote\\..+\\.(uploadpack|receivepack|vcs)|submodule\\..+\\.update|lfs\\.customtransfer\\..+\\.path|lfs\\.extension\\..+\\.(clean|smudge)|lfs\\.standalonetransferagent|core\\.(sshcommand|askpass|gitproxy)|gpg\\.(.+\\.)?program|credential\\.(.+\\.)?helper|url\\..+\\.(insteadof|pushinsteadof)|protocol\\..+\\.allow|remotes\\..+|fetch\\.all)$';

/** Scopes no worker writes: the user's and system's config, the caller's own command line (`unknown` is Apple git's Xcode config). */
const TRUSTED_SCOPES = new Set(['system', 'global', 'command', 'unknown']);

const LFS: Record<string, string> = {
  'filter.lfs.clean': 'git-lfs clean -- %f',
  'filter.lfs.smudge': 'git-lfs smudge -- %f',
  'filter.lfs.process': 'git-lfs filter-process',
};

/** The value a repository-set key falls back to when neither the user nor the system sets it. */
function neutral(key: string): string {
  if (LFS[key]) return LFS[key];
  if (/^remote\..+\.uploadpack$/.test(key)) return 'git-upload-pack';
  if (/^remote\..+\.receivepack$/.test(key)) return 'git-receive-pack';
  if (/^submodule\..+\.update$/.test(key)) return 'checkout';
  if (key === 'core.sshcommand') return 'ssh';
  // A repository that allows another transport gets it refused again (w6570: a repository-set protocol.ext.allow=always ran
  // `ext::<command>` through the fence, measured on git 2.56.1; the more specific key beat protocol.allow=never). The four
  // allows in FIXED_GIT_CONFIG are forced there already and skipped here.
  if (/^protocol\..+\.allow$/.test(key)) return 'never';
  return '';
}

/**
 * Keys git keeps the FIRST value of (w6570, measured on git 2.56.1: the command-scope override, read last, loses to the
 * repository's value and the planted program runs): remote.c's handle_config sets `uploadpack` and `receivepack` only while
 * unset, and connect.c's git_proxy_command_options stops at the first `core.gitProxy`. An override by value does nothing for
 * them, so the fence passes the transport's own option instead (firstWinsArgs) and refuses the calls it cannot pass one to
 * (firstWinsRefusal). core.gitProxy runs only on a git:// URL, which the protocol allows refuse unless the user's or the
 * system's config allows git://.
 */
const isFirstWins = (key: string) => /^remote\..+\.(uploadpack|receivepack)$/.test(key) || key === 'core.gitproxy';
const FIXED_KEYS = new Set(FIXED_GIT_CONFIG.map(([k]) => k.toLowerCase()));
/** Subcommands that take the upload or receive program as an option, and the key each one replaces. */
const PACK_OPTION: Record<string, { key: string; flag: string }> = {
  fetch: { key: 'uploadpack', flag: '--upload-pack' },
  pull: { key: 'uploadpack', flag: '--upload-pack' },
  'ls-remote': { key: 'uploadpack', flag: '--upload-pack' },
  push: { key: 'receivepack', flag: '--receive-pack' },
};

/**
 * `args` with `--upload-pack=` or `--receive-pack=` right after the subcommand when the repository's own config sets that
 * key (w6570): the user's or the system's value of the same key, else git's default. The caller's own option, later on the
 * line, still wins.
 */
export function firstWinsArgs(args: string[], rows: { scope: string; key: string; value: string }[]): string[] {
  const { sub } = splitGlobal(args);
  const o = PACK_OPTION[args[sub] ?? ''];
  if (!o) return args;
  const planted = rows.find((r) => !TRUSTED_SCOPES.has(r.scope) && r.key.startsWith('remote.') && r.key.endsWith(`.${o.key}`));
  if (!planted) return args;
  const back = rows.filter((r) => TRUSTED_SCOPES.has(r.scope) && r.scope !== 'command' && r.key === planted.key).at(-1);
  return [...args.slice(0, sub + 1), `${o.flag}=${back ? back.value : neutral(planted.key)}`, ...args.slice(sub + 1)];
}

/**
 * Keys scanned only to read, never overridden (w6570 review): a remote group (`remotes.<group>`) and `fetch.all` make a fetch
 * or pull start one child `git fetch` per remote, and the injected `--upload-pack=` never reaches those children.
 */
const isReadOnly = (key: string) => /^remotes\..+$/.test(key) || key === 'fetch.all';

/** fetch and pull options that take their value as the next argument (so it is not read as the remote). */
const FETCH_VALUE_OPTS = new Set(['-j', '--jobs', '--depth', '--deepen', '--shallow-since', '--shallow-exclude', '-o', '--server-option', '--upload-pack', '--refmap', '--negotiation-tip', '--filter', '--recurse-submodules-default', '--submodule-prefix', '-s', '--strategy', '-X', '--strategy-option', '--cleanup']);

/**
 * Whether a fetch argument is a cluster of short options holding `-m` (`--multiple`, w6633: `fetch -m origin b` and
 * `fetch -qm origin b` ran a planted uploadpack, measured by w6629). The letters after one that takes a value (`-j`, `-o`)
 * are that value. pull has no `-m` (`git pull -h`).
 */
function shortMultiple(a: string): boolean {
  if (!/^-[^-]/.test(a)) return false;
  for (const c of a.slice(1)) {
    if (c === 'm') return true;
    if (c === 'j' || c === 'o') return false;
  }
  return false;
}

/** The remote (or group) a fetch or pull names, or undefined when it names none. */
function remoteArg(rest: string[]): string | undefined {
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') return rest[i + 1];
    if (!a.startsWith('-')) return a;
    if (FETCH_VALUE_OPTS.has(a)) i++;
  }
  return undefined;
}

/** git's boolean: true, yes, on, a non-zero number, or a key with no value. */
const gitTrue = (v: string) => /^(true|yes|on|)$/i.test(v.trim()) || (/^-?\d+$/.test(v.trim()) && Number(v) !== 0);
/**
 * An argument git may read as `--<long>`: git takes any unique prefix, down to one letter after the dashes (`fetch --m` is
 * `--multiple`, w6638's review of PR #1534). An ambiguous prefix (`fetch --a`) is refused too; git fails it anyway.
 */
const isOpt = (a: string, long: string) => a.length >= 3 && long.startsWith(a);

/**
 * Whether a call starts an upload or receive program, and whether the injected option reaches every one (w6570):
 * - `covered`: ls-remote, push's own transport (receivepack), and a fetch or pull of ONE remote. A fetch or pull of several
 *   (`--all`, `--multiple`, a remote group, `fetch.all` with no remote named) starts a child `git fetch` per remote, which never
 *   gets the option (measured by the review of PR #1523 on git 2.56.1): uncovered.
 * - `uncovered`: also `push` (git-lfs's pre-push hook runs `git ls-remote origin` as a child, measured), `remote show`,
 *   `remote prune`, `remote update`, `remote set-head --auto`, `remote add --fetch`, `submodule`, and git-lfs's fetch, pull, push,
 *   pre-push and prune.
 * - `none`: everything else, `remote -v`, `lfs env`, `clone` (a new repository, none of this one's config) and `archive --remote`
 *   (it runs the remote's upload-archive, not uploadpack) among them (the review measured these run nothing).
 */
export function uploadReach(args: string[], rows: { key: string; value: string }[]): 'covered' | 'uncovered' | 'none' {
  const { sub } = splitGlobal(args);
  const name = args[sub] ?? '';
  const rest = args.slice(sub + 1);
  if (name === 'ls-remote') return 'covered';
  if (name === 'fetch' || name === 'pull') {
    if (rest.some((a) => isOpt(a, '--all') || isOpt(a, '--multiple') || (name === 'fetch' && shortMultiple(a)))) return 'uncovered';
    const remote = remoteArg(rest);
    if (remote === undefined) {
      const all = rows.filter((r) => r.key === 'fetch.all').at(-1);
      return all && gitTrue(all.value) && !rest.includes('--no-all') ? 'uncovered' : 'covered';
    }
    return rows.some((r) => r.key === `remotes.${remote.toLowerCase()}`) ? 'uncovered' : 'covered';
  }
  if (name === 'push' || name === 'submodule') return 'uncovered';
  const verb = rest[0] ?? '';
  if (name === 'remote') {
    if (/^(show|prune|update)$/.test(verb)) return 'uncovered';
    if (verb === 'set-head' && rest.some((a) => a === '-a' || isOpt(a, '--auto'))) return 'uncovered';
    if (verb === 'add' && rest.some((a) => a === '-f' || isOpt(a, '--fetch'))) return 'uncovered';
  }
  if (name === 'lfs' && /^(fetch|pull|push|pre-push|prune)$/.test(verb)) return 'uncovered';
  return 'none';
}

/**
 * How to remove a repository-set key, for a refusal's message: `git config --local` does not touch a key in the worktree's
 * own config (extensions.worktreeConfig; review of PR #1523: `--local --unset-all` exits 5 there), so the scope found picks
 * the option. A key from an included file names that file's scope too, and is removed in the file itself.
 */
export function unsetHint(row: { scope: string; key: string }): string {
  const where = row.scope === 'worktree' ? '--worktree' : '--local';
  return `remove it with \`git config ${where} --unset-all ${row.key}\` in that repository`;
}

/**
 * Why a call is refused for a first-wins key, or undefined (w6570; the warn step was PR #1523): in a repository whose own
 * config sets uploadpack, an `uncovered` call (uploadReach) starts the planted program where no option reaches it, and with
 * core.gitProxy set every call that reaches a remote may start it (no option replaces it). A repository-set receivepack needs
 * nothing: only push's own transport starts it, and `--receive-pack` covers that.
 */
export function firstWinsRefusal(args: string[], rows: { scope: string; key: string; value: string }[]): string | undefined {
  const name = args[splitGlobal(args).sub] ?? '';
  const planted = rows.filter((r) => !TRUSTED_SCOPES.has(r.scope));
  const reach = uploadReach(args, rows);
  const up = planted.find((r) => /^remote\..+\.uploadpack$/.test(r.key));
  const proxy = planted.find((r) => r.key === 'core.gitproxy');
  const bad = (reach === 'uncovered' && up) || (reach !== 'none' && proxy);
  if (!bad) return undefined;
  return `refused by FF Factory (w6570): the repository's own config sets ${bad.key}, which git runs ahead of the fence's override (it keeps the first value) on \`git ${name}\`; ${unsetHint(bad)}`;
}

/** Whether a call runs with lazy fetch off (w6570): the repository sets uploadpack, which a partial clone's lazy fetch starts. */
export function lazyFetchOff(rows: { scope: string; key: string }[]): boolean {
  return rows.some((r) => !TRUSTED_SCOPES.has(r.scope) && /^remote\..+\.uploadpack$/.test(r.key));
}

const isCredential = (key: string) => /^credential\.(.+\.)?helper$/.test(key);
const isUrlRewrite = (key: string) => /^url\..+\.(insteadof|pushinsteadof)$/.test(key);

/** Subcommands that reach a remote, where a repository's `url.<base>.insteadOf` could send the call (and a token) elsewhere. */
const NETWORK = new Set(['fetch', 'pull', 'push', 'clone', 'ls-remote', 'remote', 'submodule', 'lfs', 'archive']);

/**
 * Why a call is refused, or undefined (w5573): a repository-set `url.<base>.insteadOf` cannot be overridden by value (git takes
 * the longest matching prefix, and the repository's entry is read first, so it wins a tie), so a call that reaches a remote
 * through one is not made at all.
 */
export function refusal(args: string[], rows: { scope: string; key: string; value: string }[]): string | undefined {
  const bad = rows.find((r) => !TRUSTED_SCOPES.has(r.scope) && isUrlRewrite(r.key));
  if (!bad || !NETWORK.has(args[splitGlobal(args).sub] ?? '')) return firstWinsRefusal(args, rows);
  return `refused by FF Factory (w5573): the repository's own config sets ${bad.key}, which could send this call to another remote; ${unsetHint(bad)}`;
}

/** `git config --show-scope -z --get-regexp` output: scope NUL key LF value NUL ... */
export function parseScan(out: string): { scope: string; key: string; value: string }[] {
  const parts = out.split('\0');
  const rows: { scope: string; key: string; value: string }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const kv = parts[i + 1];
    const nl = kv.indexOf('\n');
    rows.push({
      scope: parts[i],
      key: nl < 0 ? kv : kv.slice(0, nl),
      value: nl < 0 ? '' : kv.slice(nl + 1),
    });
  }
  return rows;
}

/** The command-scope entries that override what a scan found in a repository's own config. */
export function scannedOverrides(rows: { scope: string; key: string; value: string }[]): [string, string][] {
  const trusted = rows.filter((r) => TRUSTED_SCOPES.has(r.scope) && r.scope !== 'command');
  const repo = rows.filter((r) => !TRUSTED_SCOPES.has(r.scope));
  const out: [string, string][] = [];
  const seen = new Set<string>();
  for (const r of repo) {
    if (isCredential(r.key) || isUrlRewrite(r.key) || isFirstWins(r.key) || isReadOnly(r.key) || FIXED_KEYS.has(r.key) || seen.has(r.key)) continue;
    seen.add(r.key);
    const back = trusted.filter((t) => t.key === r.key).at(-1);
    out.push([r.key, back ? back.value : neutral(r.key)]);
  }
  if (repo.some((r) => isCredential(r.key))) {
    // An empty helper clears the list read so far (git's credential.c); then the user's and system's helpers in their order.
    out.push(['credential.helper', '']);
    for (const t of trusted) if (isCredential(t.key)) out.push([t.key, t.value]);
  }
  return out;
}

/** `env` with `pairs` as the first command-scope entries and the caller's own GIT_CONFIG_* entries after them. */
export function withConfigFirst(env: Env, pairs: [string, string][]): Env {
  const n = Number(env.GIT_CONFIG_COUNT ?? 0) || 0;
  const out: Env = { ...env };
  for (let i = 0; i < n; i++) {
    delete out[`GIT_CONFIG_KEY_${i}`];
    delete out[`GIT_CONFIG_VALUE_${i}`];
  }
  const all: [string, string][] = [...pairs];
  for (let i = 0; i < n; i++) all.push([env[`GIT_CONFIG_KEY_${i}`] ?? '', env[`GIT_CONFIG_VALUE_${i}`] ?? '']);
  all.forEach(([k, v], i) => {
    out[`GIT_CONFIG_KEY_${i}`] = k;
    out[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  out.GIT_CONFIG_COUNT = String(all.length);
  return out;
}

/** Whether `cmd` is git (a bare name or a path to git or git.exe). */
export function isGit(cmd: string): boolean {
  return /^git(\.exe)?$/i.test(path.basename(cmd.replace(/\\/g, '/')));
}

const LOCATION_OPTS = new Set(['-C', '--git-dir', '--work-tree', '--namespace']);
const VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path', '--super-prefix']);
const DIFF_LIKE = new Set(['diff', 'log', 'show', 'whatchanged']);

/** The global options that say where the repository is (`-C`, `--git-dir`, ...), and where the subcommand starts. */
export function splitGlobal(args: string[]): {
  location: string[];
  sub: number;
} {
  const location: string[] = [];
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    const a = args[i];
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (VALUE_OPTS.has(name) && eq < 0) {
      if (LOCATION_OPTS.has(name)) location.push(a, args[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (LOCATION_OPTS.has(name) || a === '--bare') location.push(a);
    i += 1;
  }
  return { location, sub: i };
}

/** `args` with `--no-ext-diff --no-textconv` after a diff-like subcommand. */
export function fenceArgs(args: string[]): string[] {
  const { sub } = splitGlobal(args);
  if (!DIFF_LIKE.has(args[sub] ?? '')) return args;
  return [...args.slice(0, sub + 1), '--no-ext-diff', '--no-textconv', ...args.slice(sub + 1)];
}

/**
 * Calls that start no program a scanned key names, so they need no scan (w5991): they resolve or move refs, read config or
 * list worktrees, and never check out, diff, filter, merge, reach a remote or read an object. The fixed keys still go on every
 * call (an editor, a hook such as reference-transaction, fsmonitor). Reading an object is the trap (w5996's review): a
 * repository that plants extensions.partialClone and a promisor remote makes git lazy-fetch a missing object in a child
 * process, which runs the planted core.sshCommand; merge-base, show-ref, for-each-ref and `rev-parse X^{commit}` all did
 * (measured, git 2.56.1). So `rev-parse` skips only with plain names (no `^`, `~`, `:`, `@{`, and no `..`: `A...B` reads commits for a merge base, w6005) and options from REV_PARSE_OPTS,
 * `worktree` only as `list` and `prune` (`add` checks files out, `remove` runs status), and those calls also carry
 * GIT_NO_LAZY_FETCH=1 (git 2.45.1 on; an older git ignores it, and the list alone holds). Every scan is one more process
 * start, about a third of ffu-slot's (w5991: 266 of 861 in server/ffuSlots.test.ts). A per-repository cache of the scan was
 * not taken: the shared ffu clone's config is written by every worker holding a slot, and a cache would let a key planted
 * after the first call of a run win every later call (take --wait runs for minutes), where the scan's own race is the gap
 * between two process starts.
 */
const NO_SCAN = new Set(['symbolic-ref', 'config']);
const REV_PARSE_OPTS = new Set(['--verify', '--quiet', '-q', '--abbrev-ref', '--symbolic-full-name', '--show-toplevel', '--git-dir', '--git-common-dir', '--absolute-git-dir', '--is-inside-work-tree', '--is-bare-repository', '--show-prefix', '--show-cdup', '--']);

/** Whether a call needs the scan: false only for calls that start no program a repository names (see NO_SCAN). */
export function needsScan(args: string[]): boolean {
  const { sub } = splitGlobal(args);
  const name = args[sub] ?? '';
  const rest = args.slice(sub + 1);
  // `config --blob=<object>` reads its config from an object, which lazy-fetches like any other read (w6023); git takes
  // a unique prefix of an option, so anything starting `--bl` scans.
  if (name === 'config') return rest.some((a) => a.startsWith('--bl'));
  if (NO_SCAN.has(name)) return false;
  if (name === 'worktree' && /^(list|prune)$/.test(rest[0] ?? '')) return false;
  if (name === 'rev-parse') return !rest.every((a) => (a.startsWith('-') ? REV_PARSE_OPTS.has(a) : !/[\^~:@{}\s\\*?[]|\.\./.test(a)));
  return true;
}

/** A call that skips the scan: fixed keys, and no lazy fetch of a missing object (git 2.45.1 on). */
function unscanned(args: string[], env: Env): { args: string[]; env: Env } {
  const f = fenced(args, env, '');
  return { args: f.args, env: { ...f.env, GIT_NO_LAZY_FETCH: '1' } };
}

const scanArgs = (location: string[]) => [...location, 'config', '--show-scope', '--includes', '-z', '--get-regexp', SCANNED_KEYS];

/**
 * Why a scan's rows cannot be trusted, or undefined (w6632): only a scan that ended by itself with exit 0, or with exit 1 (no
 * such key) or 128 (not a repository: git then fails the call itself) and printed nothing, read the whole config. A scan cut
 * short (its output over SCAN_MAX_BUFFER, ENOBUFS; its timeout; a signal; any other exit) holds only the rows before the cut,
 * and a key planted after 5 MiB of padding ran through the fence (measured by w6629). A missing program or folder (ENOENT)
 * passes: the call fails the same way by itself.
 */
export function scanCut(exit: number | null, why: string, out: string): string | undefined {
  if (exit === 0) return undefined;
  if ((exit === 1 || exit === 128) && out === '') return undefined;
  if (why === 'ENOENT') return undefined;
  return why || `exit ${exit}`;
}

/** The scan's output limit: a scan that prints more is cut short and refused (w6632). */
export const SCAN_MAX_BUFFER = 4 * 1024 * 1024;

function fenced(args: string[], env: Env, scanOut: string, cut?: string): { args: string[]; env: Env } {
  const rows = parseScan(scanOut);
  const no = cut
    ? `refused by FF Factory (w6632): the fence's scan of this repository's config was cut short (${cut}), so a key after the cut would run unchecked; look at \`git config --show-scope --includes --get-regexp .\` in that repository for an oversized or hanging entry and remove it`
    : refusal(args, rows);
  // A refused call still runs git, with an option it rejects (exit 129, the reason in its stderr), so every caller fails the
  // way it already handles a failed git.
  if (no)
    return {
      args: [`--${no.replace(/\s+/g, '-')}`],
      env: withConfigFirst(env, FIXED_GIT_CONFIG),
    };
  const out = withConfigFirst(env, [...fixedFor(args), ...scannedOverrides(rows)]);
  return {
    args: fenceArgs(firstWinsArgs(args, rows)),
    env: lazyFetchOff(rows) ? { ...out, GIT_NO_LAZY_FETCH: '1' } : out,
  };
}

/**
 * The fixed keys for this call. `git lfs install` and `git lfs update` write git-lfs's hooks into the repository's hooks
 * folder (`worker.ts install`, server/setup.ts); with core.hooksPath on FF Factory's folder they would fail (measured: "mkdir
 * .../safeGit.ts: not a directory" with a file there), so they keep the repository's own. They write hooks and run none.
 */
export function fixedFor(args: string[]): [string, string][] {
  const { sub } = splitGlobal(args);
  if (args[sub] === 'lfs' && /^(install|update)$/.test(args[sub + 1] ?? '')) return FIXED_GIT_CONFIG.filter(([k]) => k !== 'core.hooksPath');
  return FIXED_GIT_CONFIG;
}

/** The scan runs with the fixed keys in force too, so nothing it reads can start a program. */
const scanEnv = (env: Env) => withConfigFirst({ ...env, GIT_TERMINAL_PROMPT: '0' }, FIXED_GIT_CONFIG);

/** The arguments and environment for a git call in a checkout a worker may have written (sync). */
export function gitFenceSync(args: string[], opts: { cwd?: string; env?: Env } = {}): { args: string[]; env: Env } {
  const env = opts.env ?? process.env;
  if (!needsScan(args)) return unscanned(args, env);
  let out = '';
  try {
    out = execFileSync('git', scanArgs(splitGlobal(args).location), {
      cwd: opts.cwd,
      env: scanEnv(env),
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      maxBuffer: SCAN_MAX_BUFFER,
    });
  } catch (e) {
    const x = e as { stdout?: string; status?: number | null; signal?: string | null; code?: string };
    out = String(x.stdout ?? '');
    const exit = typeof x.status === 'number' && !x.signal && typeof x.code !== 'string' ? x.status : null;
    return fenced(args, env, out, scanCut(exit, x.code ?? x.signal ?? '', out));
  }
  return fenced(args, env, out);
}

/** The arguments and environment for a git call in a checkout a worker may have written. */
export function gitFence(args: string[], opts: { cwd?: string; env?: Env } = {}): Promise<{ args: string[]; env: Env }> {
  const env = opts.env ?? process.env;
  if (!needsScan(args)) return Promise.resolve(unscanned(args, env));
  return new Promise((resolve) => {
    // w6554: started from the spawn thread in the daemon (server/spawnThread.ts); BEAST's loop held 48.8 s in this spawn.
    execFileOffThread(
      'git',
      scanArgs(splitGlobal(args).location),
      {
        cwd: opts.cwd,
        env: scanEnv(env),
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
        maxBuffer: SCAN_MAX_BUFFER,
      },
      (e, raw) => {
        const out = String(raw ?? '');
        if (!e) return resolve(fenced(args, env, out));
        const exit = typeof e.code === 'number' && e.code >= 0 && !e.signal ? e.code : null;
        const why = typeof e.code === 'string' ? e.code : e.signal || (e.killed ? 'timed out' : e.message);
        resolve(fenced(args, env, out, scanCut(exit, why, out)));
      },
    );
  });
}

/**
 * w6237: a git call whose two spawns (the fence's scan and git itself) both run on the probe thread (server/hostProbe.ts),
 * never on the caller's event loop: the guard runs inside the portal on every shell command. `bin` is the git to run (the
 * guard's trusted git), `pre` the settings that go before the fenced arguments (TRUSTED_GIT).
 */
export async function gitOffThread(args: string[], opts: { cwd?: string; env?: Env; timeoutMs?: number; bin?: string; pre?: string[] } = {}): Promise<RunResult> {
  const env = opts.env ?? process.env;
  let f: { args: string[]; env: Env };
  if (!needsScan(args)) f = unscanned(args, env);
  else {
    const scan = await runOffThread('git', scanArgs(splitGlobal(args).location), 15_000, { cwd: opts.cwd, env: scanEnv(env), maxBuffer: SCAN_MAX_BUFFER });
    // The probe thread answers -1 for anything but an exit (its stderr then holds execFile's message: maxBuffer, ENOENT, ...).
    const why = scan.code >= 0 ? '' : scan.timedOut ? 'timed out' : /ENOENT/.test(scan.stderr) ? 'ENOENT' : scan.stderr.split('\n')[0] || 'no exit';
    f = fenced(args, env, scan.stdout, scanCut(scan.code >= 0 ? scan.code : null, why, scan.stdout));
  }
  return runOffThread(opts.bin ?? 'git', [...(opts.pre ?? []), ...f.args], opts.timeoutMs ?? 15_000, { cwd: opts.cwd, env: f.env });
}

const cwdOf = (o?: { cwd?: string | URL }) => (o?.cwd === undefined ? undefined : String(o.cwd instanceof URL ? fileURLToPath(o.cwd) : o.cwd));

// The child_process calls, fenced. A direct `spawn('git', ...)` and its kin are refused by safeGit.test.ts outside this file.

export function gitExecFileSync(args: string[], opts: ExecFileSyncOptions & { encoding: BufferEncoding }): string;
export function gitExecFileSync(args: string[], opts?: ExecFileSyncOptions): string | Buffer;
export function gitExecFileSync(args: string[], opts: ExecFileSyncOptions = {}): string | Buffer {
  const f = gitFenceSync(args, { cwd: cwdOf(opts), env: opts.env });
  return execFileSync('git', f.args, { ...opts, env: f.env });
}

export function gitSpawnSync(args: string[], opts: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string>;
export function gitSpawnSync(args: string[], opts?: SpawnSyncOptions): SpawnSyncReturns<string | Buffer>;
export function gitSpawnSync(args: string[], opts: SpawnSyncOptions = {}): SpawnSyncReturns<string | Buffer> {
  const f = gitFenceSync(args, { cwd: cwdOf(opts), env: opts.env });
  return spawnSync('git', f.args, { ...opts, env: f.env });
}

/** spawn('git', ...) with the fence; the scan runs synchronously so the child is returned at once. */
export function gitSpawn(args: string[], opts?: SpawnOptionsWithoutStdio): ChildProcessWithoutNullStreams;
export function gitSpawn(args: string[], opts: SpawnOptions): ChildProcess;
export function gitSpawn(args: string[], opts: SpawnOptions = {}): ChildProcess {
  const f = gitFenceSync(args, { cwd: cwdOf(opts), env: opts.env });
  return spawn('git', f.args, { ...opts, env: f.env });
}

/**
 * execFile('git', ...) with the fence, string output. w6554: both spawns (the fence's scan and git) start from the daemon's
 * spawn thread (server/spawnThread.ts; elsewhere it is execFile itself): on 2026-11-27 BEAST's loop was held 19-49 s in one
 * git start here (the clean-up's unpushedWorkWhy). The options are the ones that cross to that thread.
 */
export function gitExecFile(args: string[], opts: Omit<ThreadExecOptions, 'encoding'> & { encoding?: BufferEncoding }, cb: (err: Error | null, stdout: string, stderr: string) => void): void {
  gitFence(args, { cwd: opts.cwd, env: opts.env }).then((f) =>
    execFileOffThread('git', f.args, { ...opts, encoding: 'utf8', env: f.env }, (e, out, err) => cb(e, String(out ?? ''), String(err ?? ''))),
  );
}
