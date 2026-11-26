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
 *   not `/dev/null`, which would be `\dev\null` on a Windows drive a worker can write), the `cat` pager, `:` editors, no signing or signature checks (a gpg program never runs), and remote
 *   transports limited to https, http, ssh and file (`ext::` and named remote helpers are refused). Same list as w5514's
 *   standing agents (server/launch.ts STANDING_GIT_CONFIG) except `safe.bareRepository=explicit`: the machines' main
 *   clones are bare and the daemon runs `git -C <bare clone>`, which `explicit` refuses.
 * - SCANNED: keys a repository names freely (`filter.<driver>.clean`, `diff.<driver>.textconv`, `merge.<driver>.driver`,
 *   `remote.<name>.uploadpack`, a credential helper, git-lfs's custom transfer agents). One `git config` call (which runs
 *   no program) reads them in the call's own repository; each one a repository scope sets takes the user's or system's
 *   value back, else a neutral one (git-lfs's standard filter for `filter.lfs.*`, so LFS files still check out). A
 *   repository's credential helpers are dropped and the user's and system's added again in their order. This one has a
 *   race: a worker who writes the key between the scan and the call wins it, so it narrows the gap without closing it.
 *   Subcommands that start none of those programs (rev-parse, merge-base, config, worktree list, ...: NO_SCAN) skip it (w5991).
 * - `diff`, `log`, `show` and `whatchanged` also get `--no-ext-diff --no-textconv`: `diff.external` cannot be overridden
 *   by value (an empty one makes every `git diff` fail, measured by w5514 on git 2.50.1), and the flags need no scan.
 *
 * Measured on git 2.50.1 (safeGit.test.ts): an empty `filter.<d>.clean` or `diff.<d>.textconv` leaves `git status` and
 * `git diff` working with no program run; a `core.hooksPath` naming a regular file runs no hook.
 */
import {
  execFile,
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type ExecFileOptions,
  type SpawnOptionsWithoutStdio,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  type ExecFileSyncOptions,
  type SpawnOptions,
  type SpawnSyncOptions,
} from 'node:child_process';
import path from 'node:path';
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
  '^(filter\\..+\\.(clean|smudge|process)|merge\\..+\\.driver|diff\\..+\\.(command|textconv)|hook\\..+\\.command|remote\\..+\\.(uploadpack|receivepack|vcs)|submodule\\..+\\.update|lfs\\.customtransfer\\..+\\.path|lfs\\.extension\\..+\\.(clean|smudge)|lfs\\.standalonetransferagent|core\\.(sshcommand|askpass|gitproxy)|gpg\\.(.+\\.)?program|credential\\.(.+\\.)?helper|url\\..+\\.(insteadof|pushinsteadof))$';

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
  return '';
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
export function refusal(args: string[], rows: { scope: string; key: string }[]): string | undefined {
  const bad = rows.find((r) => !TRUSTED_SCOPES.has(r.scope) && isUrlRewrite(r.key));
  if (!bad || !NETWORK.has(args[splitGlobal(args).sub] ?? '')) return undefined;
  return `refused by FF Factory (w5573): the repository's own config sets ${bad.key}, which could send this call to another remote; remove it with \`git config --local --unset-all ${bad.key}\` in that repository`;
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
    if (isCredential(r.key) || isUrlRewrite(r.key) || seen.has(r.key)) continue;
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
 * Subcommands that start no program a scanned key names, so they need no scan (w5991): they read or move refs and read config,
 * and check out, diff, filter, merge or reach a remote never. The fixed keys still go on every call (an editor, a hook such as
 * reference-transaction, fsmonitor). `worktree` only as `list` and `prune`: `add` checks files out (filters) and `remove` runs
 * `git status` in the checkout. Every scan is one more process start, about half of all of ffu-slot's (w5991: 266 of 861 in
 * server/ffuSlots.test.ts); this keeps the protection and drops the scans that protect nothing. A per-repository cache of the
 * scan was not taken: the shared ffu clone's config is written by every worker holding a slot, and a cache would let a key
 * planted after the first call of a run win every later call (take --wait runs for minutes), where the scan's own race is the
 * gap between two process starts.
 */
const NO_SCAN = new Set(['rev-parse', 'merge-base', 'symbolic-ref', 'show-ref', 'for-each-ref', 'config']);

/** Whether a call needs the scan: false only for subcommands that start no program a repository names (NO_SCAN). */
export function needsScan(args: string[]): boolean {
  const { sub } = splitGlobal(args);
  const name = args[sub] ?? '';
  if (NO_SCAN.has(name)) return false;
  if (name === 'worktree' && /^(list|prune)$/.test(args[sub + 1] ?? '')) return false;
  return true;
}

const scanArgs = (location: string[]) => [...location, 'config', '--show-scope', '--includes', '-z', '--get-regexp', SCANNED_KEYS];

function fenced(args: string[], env: Env, scanOut: string): { args: string[]; env: Env } {
  const rows = parseScan(scanOut);
  const no = refusal(args, rows);
  // A refused call still runs git, with an option it rejects (exit 129, the reason in its stderr), so every caller fails the
  // way it already handles a failed git.
  if (no)
    return {
      args: [`--${no.replace(/\s+/g, '-')}`],
      env: withConfigFirst(env, FIXED_GIT_CONFIG),
    };
  return {
    args: fenceArgs(args),
    env: withConfigFirst(env, [...fixedFor(args), ...scannedOverrides(rows)]),
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
  if (!needsScan(args)) return fenced(args, env, '');
  let out = '';
  try {
    out = execFileSync('git', scanArgs(splitGlobal(args).location), {
      cwd: opts.cwd,
      env: scanEnv(env),
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (e) {
    // Exit 1 is "no such key"; anything else (not a repository) leaves the call to fail by itself.
    out = String((e as { stdout?: string }).stdout ?? '');
  }
  return fenced(args, env, out);
}

/** The arguments and environment for a git call in a checkout a worker may have written. */
export function gitFence(args: string[], opts: { cwd?: string; env?: Env } = {}): Promise<{ args: string[]; env: Env }> {
  const env = opts.env ?? process.env;
  if (!needsScan(args)) return Promise.resolve(fenced(args, env, ''));
  return new Promise((resolve) => {
    execFile(
      'git',
      scanArgs(splitGlobal(args).location),
      {
        cwd: opts.cwd,
        env: scanEnv(env),
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
      (_e, out) => resolve(fenced(args, env, String(out ?? ''))),
    );
  });
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

/** execFile('git', ...) with the fence, string output. */
export function gitExecFile(
  args: string[],
  opts: ExecFileOptions & { encoding?: BufferEncoding },
  cb: (err: Error | null, stdout: string, stderr: string) => void,
): void {
  gitFence(args, { cwd: cwdOf(opts), env: opts.env }).then((f) =>
    execFile('git', f.args, { ...opts, encoding: 'utf8', env: f.env }, (e, out, err) => cb(e, String(out ?? ''), String(err ?? ''))),
  );
}
