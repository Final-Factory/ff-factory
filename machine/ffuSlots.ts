/**
 * ffu slots (w3764): per-machine sandboxes for work in Final-Factory/ffu, the Rust engine, so a worker builds in a warm cargo
 * target instead of cold in its temp folder (lothsahn: "Can we have ffu sandboxes like final factory sandboxes but in a
 * different folder?"). The layout, under the worker install folder (FF_WORKER_ROOT):
 *
 *   ffu-sandboxes/repo        one bare clone of ffu, fetched under the lock
 *   ffu-sandboxes/slot<N>/ffu a worktree of it, the worker's checkout
 *   ffu-sandboxes/slot<N>/target  the slot's CARGO_TARGET_DIR, kept between workers (outside the worktree, so a reset and
 *                             a clean of the checkout never touch it)
 *   ffu-sandboxes/slots.json  who holds which slot (the session), and what it last built
 *
 * A worker takes a slot with `eval "$(ffu-slot take --branch <b>)"`: it keeps the slot it holds, else gets a free one, the
 * one last on its branch first, then the one used most recently (the warmest target), and only then a new one (a cold
 * target), up to FF_FFU_SLOTS_MAX. A slot is free when no one holds it, or its holder's process no longer runs here
 * (cleanup-facts.json's `live`) and its checkout holds no work (no change, no commit missing from origin). w5885 (lothsahn:
 * "fix how stale workers held on to slots"): a holder also loses its slot once it is finished (on no open request), stopped
 * or waiting past FFU_SLOT_WAIT_GRACE_MS, or idle in it past FFU_SLOT_IDLE_MS; work it left is saved first on a rescue
 * branch (rescueWork), never dropped. A worker that finds every slot held waits (`take --wait`, or wake_me) and never builds
 * elsewhere. The cargo registry is the machine's, inside the install folder (w5501): every
 * slot shares one CARGO_HOME, `<root>/cache/cargo` unless one already sits inside the root (sharedCaches.ts workerCargoHome).
 * Measured design: docs/ffu-sandboxes.md.
 *
 * w5870: the slots are in a folder workers write (Low on Windows), so a build there runs build scripts, target binaries and a
 * slot's `.cargo/config.toml` that any worker could have written. A sandbox agent is a worker itself; a Medium agent (one not
 * in a sandbox, outside the fences) is not, so `take` and `where` warn it, and refuse it (exit 5) once the daemon says "on" in
 * MEDIUM_AGENT_VAR (machine/mediumFolders.ts): daemon.json "mediumAgentCaches" is "on" and w5862's "mediumAgentFolders" gave
 * the agent its own temp folder, which no worker writes, so it builds there instead (w5946 F5). A Medium agent's `take` keeps its
 * own CARGO_HOME and never gets the workers' `<root>/cache/cargo` (w5947): crates and build scripts a worker could have planted.
 */
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitSpawnSync, splitGlobal } from '../server/safeGit.ts';
import type { CleanupFacts } from '../server/cleanupFolders.ts';
import { MEDIUM_AGENT_VAR } from './mediumFolders.ts';
import type { FfuSlotsReport, FfuSlotView } from '../shared/types.ts';
import { workerCargoHome } from './sharedCaches.ts';

export const FFU_REMOTE = 'https://github.com/Final-Factory/ffu.git';
export const FFU_SLOTS_DIR = 'ffu-sandboxes';
/** Slots per machine unless the daemon says otherwise (FF_FFU_SLOTS_MAX): a guess, 4 x the 16 GB cap = 64 GB at most (docs/ffu-sandboxes.md). */
export const FFU_SLOTS_DEFAULT_MAX = 4;
/** A new slot (a cold target: 6.8 GB after a workspace test build, up to the 16 GB clean-up cap) is not made below this much free disk. */
export const FFU_NEW_SLOT_MIN_FREE_GB = 40;
/** The facts file is trusted for other holders' liveness only while this fresh; older, every other holder counts as live. */
const FACTS_FRESH_MS = 15 * 60_000;
/**
 * w5885: a holder that stopped, or whose every request waits (blocked_on, a question, queued), keeps its slot this long after
 * its last use; then a worker that needs one may take it (its work saved first, rescueWork). 30 min is the harness's own line
 * between a short wait and a long one (a wake_me check-in under 30 min keeps a sandbox, a longer one frees it; the worker
 * brief). ffu's pull request CI took 123 min at the median and 190 at p90 (measured, gh run list -R Final-Factory/ffu, 92
 * runs to 2026-11-26), so holding a slot through a whole CI wait idles a warm target for hours, and a resumed worker takes
 * one back cheaply: a slot last on its branch is picked first.
 */
export const FFU_SLOT_WAIT_GRACE_MS = 30 * 60_000;
/**
 * w5885: a holder on a request still marked working keeps its slot this long with no use of it (no take, git index or cargo
 * write), then it is taken like a waiting one. A guess, long beside the ffu loop's slowest measured step (a cold workspace
 * build, 221-366 s; docs/ffu-sandboxes.md), so only a worker that moved to other work loses it (6d0f156a held LothDesktop's
 * slot1 all of 2026-11-25 while it worked in Unity, and five workers built in their temp folders).
 */
export const FFU_SLOT_IDLE_MS = 2 * 60 * 60_000;
/**
 * w5885 (lothsahn's note, 2026-11-26: "A worker with two checkouts may lease a second ffu slot, one slot per checkout and per
 * branch, when one is free"): the most slots one worker holds at once. Two covers the case that note came from (w5475: a map
 * branch and a Report a Bug branch); a guess, kept low so one worker never takes a machine's four.
 */
export const FFU_SLOTS_PER_WORKER = 2;
/** w5885: how often `take --wait` looks for a free slot again. */
const WAIT_POLL_MS = 30_000;
const LOCK_STALE_MS = 15 * 60_000;
const LOCK_WAIT_MS = 10 * 60_000;

export interface FfuSlot {
  id: string;
  /** The session (FF_SESSION_ID) that holds it; absent when released. */
  holder?: string;
  /** The branch it was last given (absent: detached at origin/main). */
  branch?: string;
  takenAt?: string;
  usedAt?: string;
}

/** w5885: work a freed slot's holder had left in it, kept on a branch of the shared clone (and pushed to origin when it could be). */
export interface FfuRescue {
  holder: string;
  slot: string;
  branch: string;
  sha: string;
  /** The holder's branch in the slot, if it was on one. */
  from?: string;
  pushed: boolean;
  at: string;
  /** Set once the holder was told (its next take or where). */
  told?: boolean;
}

export interface FfuSlotState {
  slots: FfuSlot[];
  rescues?: FfuRescue[];
}

export interface Ran {
  code: number;
  out: string;
  err: string;
}

export interface FfuSlotDeps {
  root: string;
  session: string;
  max: number;
  /** The machine's CARGO_HOME inside the root (w5501, sharedCaches.ts workerCargoHome); `take` exports it. */
  cargoHome?: string;
  facts?: CleanupFacts;
  /** w5870: MEDIUM_AGENT_VAR, set only for a Medium agent: "warn" or "on". */
  medium?: string;
  /** w6038: the folder the slots' core.hooksPath names; default slotHooksDir's pick (w6062). */
  hooks?: string;
  /** Read cleanup-facts.json again (`take --wait` polls with it); absent: the facts stay as given. */
  readFacts?: () => CleanupFacts | undefined;
  now: () => number;
  git: (args: string[], cwd?: string) => Ran;
  freeGB: (dir: string) => number | undefined;
  write: (s: string) => void;
  say: (s: string) => void;
  sleep: (ms: number) => void;
}

export const slotsBase = (root: string) => path.join(root, FFU_SLOTS_DIR);
export const slotDir = (root: string, id: string) => path.join(slotsBase(root), id);
export const slotCheckout = (root: string, id: string) => path.join(slotDir(root, id), 'ffu');
export const slotTarget = (root: string, id: string) => path.join(slotDir(root, id), 'target');
/** A slot's fixed folder for a server a run copies out of the target (w5442): a rebuild then never meets a running exe. */
export const slotBin = (root: string, id: string) => path.join(slotDir(root, id), 'bin');

/** The Windows Firewall group of ffu-server's rules (scripts/worker/firewall.ps1 $FfuGroup, w5442). */
export const FFU_SERVER_GROUP = 'Final Factory ffu-server';

/**
 * Every path an ffu slot's ffu-server runs from on Windows (w5442; lothsahn, 2026-11-24: "What ports does ffu-server
 * need? These should be added for all the ffu sandboxes so that it can start servers always"). Windows Firewall puts
 * inbound Block rules on every new exe path that listens beyond loopback (ffu tools/soak.sh, w3346 and w3347), and a
 * Block beats any allow, so the rules go by program: slot1..slot<max>'s cargo profiles (dev builds in debug; release and
 * bench in release) and the slot's bin folder. Slot ids are the lowest free number up to max (nextId below), so these
 * paths cover every slot a machine can make, before it exists. ffu-server's ports come from flags (--listen,
 * --peer-listen, port 0 picks a free one), so a rule by port could not cover them all.
 */
export function ffuServerExes(root: string, max: number = FFU_SLOTS_DEFAULT_MAX): string[] {
  const out: string[] = [];
  for (let i = 1; i <= max; i++) {
    const slot = path.win32.join(root, FFU_SLOTS_DIR, `slot${i}`);
    out.push(path.win32.join(slot, 'target', 'debug', 'ffu-server.exe'), path.win32.join(slot, 'target', 'release', 'ffu-server.exe'), path.win32.join(slot, 'bin', 'ffu-server.exe'));
  }
  return out;
}

const stateFile = (root: string) => path.join(slotsBase(root), 'slots.json');
const repoDir = (root: string) => path.join(slotsBase(root), 'repo');

export function readSlotState(root: string): FfuSlotState {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(root), 'utf8')) as FfuSlotState;
    return { slots: Array.isArray(s.slots) ? s.slots.filter((x) => x && /^slot\d+$/.test(x.id)) : [], ...(Array.isArray(s.rescues) && s.rescues.length ? { rescues: s.rescues } : {}) };
  } catch {
    return { slots: [] };
  }
}

function writeSlotState(root: string, s: FfuSlotState): void {
  const f = stateFile(root);
  fs.writeFileSync(`${f}.tmp`, `${JSON.stringify(s, null, 2)}\n`);
  fs.renameSync(`${f}.tmp`, f);
  writeHolderFiles(root, s);
}

/**
 * w6038: the hooks every slot's checkout runs (ffuSlotHooks/: reference-transaction, pre-push, pre-rebase), in FF Factory's
 * own code, which no worker writes. `take` points the shared clone's core.hooksPath here, so a worker's own git in a slot
 * refuses a write when its session does not hold the slot, or when the checkout is on a branch other than the one recorded.
 * FF Factory's git (gitSpawnSync, ff-pr) runs with core.hooksPath on server/gitHooks and never meets them: take, the rescue
 * and the daemon's reads stay as they were, and ff-pr checks the same with slotWriteRefusal.
 */
export const FFU_SLOT_HOOKS = path.join(import.meta.dirname, 'ffuSlotHooks');

/**
 * w6062: on Windows the slots run a native reference-transaction (ffuSlotHooks/native/reference_transaction.rs, the same
 * check as the shell one). Git runs that hook at every phase of every ref transaction, 7 times per `git commit`, and each
 * start of Git Bash's sh cost about 30 ms on LothDesktop: the shell hooks added about 210 ms per commit (measured). `take`
 * builds it once per version of the hooks with rustc into `<install>/ffu-sandboxes/hooks/<hash>/` beside copies of the
 * shell pre-push, pre-rebase and slot-guard.sh, as the worker it runs as: that folder is as much a worker's to write as the
 * shared clone's core.hooksPath, which `take` sets in that same folder tree. No rustc, or a build that fails: the shell hooks.
 */
const NATIVE_HOOK_SRC = path.join(FFU_SLOT_HOOKS, 'native', 'reference_transaction.rs');
const NATIVE_HOOK_SHELL = ['pre-push', 'pre-rebase', 'slot-guard.sh'];
export const nativeSlotHooksBase = (root: string) => path.join(slotsBase(root), 'hooks');

/** rustc for the native hook (w6062): on PATH, else in the machine's cargo homes (LothDesktop's `<root>/tools/cargo`, with its rustup beside it as ffu-build-test's ci_local.sh finds it). */
export function findRustc(env: NodeJS.ProcessEnv, root: string, home = os.homedir()): { cmd: string; env: NodeJS.ProcessEnv } | undefined {
  const exe = process.platform === 'win32' ? 'rustc.exe' : 'rustc';
  const runs = (cmd: string, e: NodeJS.ProcessEnv) => spawnSync(cmd, ['-V'], { env: e, windowsHide: true, timeout: 60_000 }).status === 0;
  if (runs('rustc', env)) return { cmd: 'rustc', env };
  const homes = [env.CARGO_HOME, root && path.join(root, 'tools', 'cargo'), root && path.join(root, 'cache', 'cargo'), home && path.join(home, '.cargo')];
  for (const h of homes) {
    if (!h) continue;
    const cmd = path.join(h, 'bin', exe);
    if (!fs.existsSync(cmd)) continue;
    if (runs(cmd, env)) return { cmd, env };
    // A rustup proxy with no toolchain where RUSTUP_HOME points (LothDesktop's ~/.rustup has none set): its rustup beside it.
    const rustup = path.join(path.dirname(h), 'rustup');
    const e = { ...env, RUSTUP_HOME: rustup };
    if (fs.existsSync(path.join(rustup, 'toolchains')) && runs(cmd, e)) return { cmd, env: e };
  }
  return undefined;
}

/**
 * The native slot hooks folder for this version of the hooks (w6062), built under `base` if it is not there yet; undefined
 * when rustc is missing or the build fails (said with `say`), and the shell hooks stay. Two takes building at once each
 * build in a folder of their own and the first rename wins.
 */
export function ensureNativeSlotHooks(base: string, o: { env?: NodeJS.ProcessEnv; root?: string; say?: (s: string) => void } = {}): string | undefined {
  const exe = process.platform === 'win32' ? 'reference-transaction.exe' : 'reference-transaction';
  const sum = createHash('sha256').update(process.platform).update(fs.readFileSync(NATIVE_HOOK_SRC));
  for (const f of NATIVE_HOOK_SHELL) sum.update(fs.readFileSync(path.join(FFU_SLOT_HOOKS, f)));
  const dir = path.join(base, sum.digest('hex').slice(0, 12));
  if (fs.existsSync(path.join(dir, exe))) return dir;
  const say = o.say ?? (() => {});
  const rustc = findRustc(o.env ?? process.env, o.root ?? '');
  if (!rustc) {
    say('ffu-slot: no rustc found, so the slot runs the shell git hooks (about 0.2 s slower per commit on Windows, w6062)\n');
    return undefined;
  }
  const tmp = path.join(base, `.build-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(tmp, { recursive: true });
    for (const f of NATIVE_HOOK_SHELL) {
      fs.copyFileSync(path.join(FFU_SLOT_HOOKS, f), path.join(tmp, f));
      fs.chmodSync(path.join(tmp, f), 0o755);
    }
    const r = spawnSync(rustc.cmd, ['--edition', '2021', '-O', '-C', 'panic=abort', '-C', 'debuginfo=0', '--crate-name', 'reference_transaction', '-o', path.join(tmp, exe), NATIVE_HOOK_SRC], { env: rustc.env, encoding: 'utf8', windowsHide: true, timeout: 300_000 });
    if (r.status !== 0) throw new Error(`rustc: ${(r.stderr || r.error?.message || '').trim().slice(0, 300)}`);
    for (const f of fs.readdirSync(tmp)) if (f.endsWith('.pdb')) fs.rmSync(path.join(tmp, f), { force: true });
    try {
      fs.renameSync(tmp, dir);
    } catch (e) {
      if (!fs.existsSync(path.join(dir, exe))) throw e; // else another take built it first
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return dir;
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
    say(`ffu-slot: could not build the native slot git hook, so the slot runs the shell ones (w6062): ${(e as Error).message}\n`);
    return undefined;
  }
}

/** The folder the shared clone's core.hooksPath names (w6062): the native hooks on Windows when they build, else the shell ones. */
export function slotHooksDir(d: Pick<FfuSlotDeps, 'root' | 'hooks' | 'say'>, platform = process.platform): string {
  if (d.hooks) return d.hooks;
  if (platform !== 'win32') return FFU_SLOT_HOOKS;
  return ensureNativeSlotHooks(nativeSlotHooksBase(d.root), { root: d.root, say: d.say }) ?? FFU_SLOT_HOOKS;
}

/** w6038: `<slot>/holder`, what the hooks read (shell builtins only, no JSON): `holder <session>` and `branch <branch>` lines. */
export const slotHolderFile = (root: string, id: string) => path.join(slotDir(root, id), 'holder');

export function holderText(s: FfuSlot): string {
  return `# Written by FF Factory's ffu-slot with slots.json (w6038): who may run a git write in this slot's checkout.\nholder ${s.holder ?? ''}\nbranch ${s.branch ?? ''}\n`;
}

function writeHolderFiles(root: string, st: FfuSlotState): void {
  for (const s of st.slots) {
    if (!fs.existsSync(slotDir(root, s.id))) continue;
    const f = slotHolderFile(root, s.id);
    const text = holderText(s);
    try {
      if (fs.existsSync(f) && fs.readFileSync(f, 'utf8') === text) continue;
      fs.writeFileSync(`${f}.tmp`, text);
      fs.renameSync(`${f}.tmp`, f);
    } catch {
      // best effort: with no holder file the hooks let every write through, as before w6038
    }
  }
}

/** w6038: parse a holder file; undefined when it cannot be read. */
export function readHolderFile(file: string): { holder: string; branch: string } | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const v = (k: string) => new RegExp(`^${k}[ \\t]*(.*?)\\s*$`, 'm').exec(text)?.[1] ?? '';
  return { holder: v('holder'), branch: v('branch') };
}

/** w6038: the branch a checkout is on, read from its HEAD file (no git runs); '' when detached or unreadable. */
export function checkoutBranch(checkout: string): string {
  try {
    let gd = path.join(checkout, '.git');
    if (fs.statSync(gd).isFile()) gd = path.resolve(checkout, /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(gd, 'utf8'))?.[1] ?? '.git');
    return /^ref: refs\/heads\/(.+?)\s*$/m.exec(fs.readFileSync(path.join(gd, 'HEAD'), 'utf8'))?.[1] ?? '';
  } catch {
    return '';
  }
}

/**
 * w6038: why `what` (a git write) may not run in `cwd` for `session`, as the slot hooks say it (ffuSlotHooks/slot-guard.sh),
 * or undefined: not in a slot's checkout, no session, no holder file, or the session holds the slot and is on its branch
 * (or detached). For ff-pr, whose git runs with FF Factory's hooks and not the slot's.
 */
export function slotWriteRefusal(cwd: string, session: string | undefined, what: string): string | undefined {
  if (!session) return undefined;
  const m = /^(.*\/ffu-sandboxes\/(slot\d+))\/ffu(?:\/|$)/.exec(fwd(path.resolve(cwd)));
  if (!m) return undefined;
  const rec = readHolderFile(path.join(m[1], 'holder'));
  if (!rec) return undefined;
  const checkout = `${m[1]}/ffu`;
  const on = rec.branch || 'origin/main, detached';
  const fix = `Take your own slot and work there: eval "$(ffu-slot take --branch <your branch>)" (ffu-slot where --branch <b> names the one you hold) (w6038).`;
  if (rec.holder !== session) {
    return rec.holder
      ? `ffu-slot: refused: ${what} in ffu slot ${m[2]} (${checkout}), which session ${rec.holder} holds on branch ${on}; you are session ${session}. That is another worker's checkout. ${fix}`
      : `ffu-slot: refused: ${what} in ffu slot ${m[2]} (${checkout}), which no session holds (released; last on branch ${on}); you are session ${session}. ${fix}`;
  }
  const cur = rec.branch ? checkoutBranch(checkout) : '';
  if (cur && cur !== rec.branch) return `ffu-slot: refused: ${what} on branch ${cur} in ffu slot ${m[2]} (${checkout}): your session ${session} holds this slot for branch ${rec.branch}, and ffu-slot recorded no other. Go back with git switch ${rec.branch}, or take a slot for ${cur}: eval "$(ffu-slot take --branch ${cur})" (w6038).`;
  return undefined;
}

/** The lock every change to the slots takes: a folder made atomically, taken over when older than LOCK_STALE_MS. */
function withLock<T>(d: FfuSlotDeps, fn: () => T): T {
  const lock = path.join(slotsBase(d.root), '.lock');
  fs.mkdirSync(slotsBase(d.root), { recursive: true });
  const until = d.now() + LOCK_WAIT_MS;
  let told = false;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'owner'), `${d.session} ${new Date(d.now()).toISOString()}\n`);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const st = fs.statSync(lock, { throwIfNoEntry: false });
      if (st && d.now() - st.mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (d.now() > until) throw new Error(`the ffu slots' lock ${lock} stayed held for ${LOCK_WAIT_MS / 60_000} min`);
      if (!told) d.say(`ffu-slot: waiting for another worker's slot change (${lock})\n`);
      told = true;
      d.sleep(2000);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/** Why a slot's checkout holds work no one else may take over, or undefined when it holds none. */
export function checkoutWork(d: FfuSlotDeps, id: string): string | undefined {
  const wt = slotCheckout(d.root, id);
  if (!fs.existsSync(wt)) return undefined;
  // --no-optional-locks: a plain status rewrites the index, which slotLastUsed reads as the holder's own use (w5885)
  const st = d.git(['--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal'], wt);
  if (st.code !== 0) return `its checkout cannot be read (git status: ${st.err.trim().slice(0, 160)})`;
  if (st.out.trim()) return `its checkout has ${st.out.trim().split('\n').length} uncommitted change(s)`;
  const ahead = d.git(['log', '--oneline', '-n', '1', 'HEAD', '--not', '--remotes'], wt);
  if (ahead.code !== 0) return `its commits cannot be read (git log: ${ahead.err.trim().slice(0, 160)})`;
  if (ahead.out.trim()) return `its checkout has commits on no branch of origin (${ahead.out.trim()})`;
  return undefined;
}

/**
 * When the slot was last used (ms): the newest of its take, its checkout's git files (the index git status refreshes, HEAD,
 * the reflog) and its target's profile folders (cargo adds files there on a build). A proxy: an edit no command has looked
 * at yet does not count, so the limits above are long.
 */
export function slotLastUsed(d: FfuSlotDeps, s: FfuSlot): number {
  let t = Math.max(Date.parse(s.usedAt ?? '') || 0, Date.parse(s.takenAt ?? '') || 0);
  const m = (p: string) => {
    const st = fs.statSync(p, { throwIfNoEntry: false });
    if (st && st.mtimeMs > t) t = st.mtimeMs;
  };
  // git names a worktree's folder in the shared clone after the checkout's folder ("ffu", then "ffu1", ...): read its .git file
  const dotGit = fs.existsSync(path.join(slotCheckout(d.root, s.id), '.git')) ? fs.readFileSync(path.join(slotCheckout(d.root, s.id), '.git'), 'utf8') : '';
  const gd = /^gitdir:\s*(.+?)\s*$/m.exec(dotGit)?.[1];
  if (gd) for (const f of ['index', 'HEAD', path.join('logs', 'HEAD')]) m(path.resolve(slotCheckout(d.root, s.id), gd, f));
  const tgt = slotTarget(d.root, s.id);
  for (const prof of ['debug', 'release', 'bench']) for (const sub of ['', '.fingerprint', 'deps']) m(path.join(tgt, prof, sub));
  return t;
}

/** Whether the holder is on no open request, or every request it works on waits (blocked, a question, queued), as the portal last said. */
function holderState(f: CleanupFacts, holder: string): 'finished' | 'waiting' | 'working' | 'unknown' {
  if (!f.connected || !f.owners) return 'unknown';
  const o = f.owners[holder];
  if (!o) return 'finished';
  const open = o.requests.filter((r) => ['new', 'question', 'queued', 'blocked', 'active', 'stalled'].includes(r.status));
  const mine = open.some((r) => r.with) ? open.filter((r) => r.with) : open;
  if (!mine.length) return 'finished';
  return mine.every((r) => ['question', 'queued', 'blocked', 'stalled'].includes(r.status)) ? 'waiting' : 'working';
}

const mins = (ms: number) => `${Math.round(ms / 60_000)} min`;

/**
 * Whether another worker may take `s` now, and if not why. `rescue` is set when the slot is free only once its holder's work
 * is saved (rescueWork): a finished holder, or one stopped, waiting or idle past its limit (w5885).
 */
export function slotFree(d: FfuSlotDeps, s: FfuSlot): { free: boolean; why: string; rescue?: string } {
  if (!s.holder) return { free: true, why: 'released' };
  if (s.holder === d.session) return { free: true, why: `yours${s.branch ? ` (on ${s.branch})` : ''}` };
  const f = d.facts;
  if (!f || !f.at || d.now() - Date.parse(f.at) > FACTS_FRESH_MS) return { free: false, why: `held by ${s.holder} (whether it runs is not known: no fresh cleanup-facts.json)` };
  const live = f.live.includes(s.holder);
  const state = holderState(f, s.holder);
  const idle = d.now() - slotLastUsed(d, s);
  const work = checkoutWork(d, s.id);
  const free = (why: string) => (work ? { free: true, why: `${why}; ${work}, saved on a rescue branch first`, rescue: work } : { free: true, why: `${why}, and its work is pushed` });
  if (state === 'finished') return free(`held by ${s.holder}, which is on no open request`);
  if (!live && !work) return { free: true, why: `held by ${s.holder}, which no longer runs, and its work is pushed` };
  if ((!live || state === 'waiting') && idle > FFU_SLOT_WAIT_GRACE_MS) return free(`held by ${s.holder}, ${live ? 'which waits' : 'which no longer runs'}, unused for ${mins(idle)}`);
  if (idle > FFU_SLOT_IDLE_MS) return free(`held by ${s.holder}, unused for ${mins(idle)}`);
  if (!live) return { free: false, why: `held by ${s.holder}, stopped and used ${mins(idle)} ago (kept ${mins(FFU_SLOT_WAIT_GRACE_MS)} for a short wait), and ${work}` };
  if (state === 'waiting') return { free: false, why: `held by ${s.holder}, which waits, used ${mins(idle)} ago (kept ${mins(FFU_SLOT_WAIT_GRACE_MS)} for a short wait)` };
  return { free: false, why: `held by ${s.holder}, which runs, used ${mins(idle)} ago` };
}

/**
 * Every slot as `ffu-slot list` judges it, for the daemon's status (w5912, lothsahn: "Can we show those on the portal?"):
 * the same slotFree, so the portal's free, held and stale are the shim's own. Run by `ffu-slot list --json`.
 */
export function slotsReport(d: FfuSlotDeps): FfuSlotsReport {
  const f = d.facts;
  const fresh = !!f?.at && d.now() - Date.parse(f.at) <= FACTS_FRESH_MS;
  const slots = readSlotState(d.root).slots.map((s): FfuSlotView => {
    const j = slotFree(d, s);
    const used = slotLastUsed(d, s);
    const head = fs.existsSync(slotCheckout(d.root, s.id)) ? d.git(['rev-parse', '--short=12', 'HEAD'], slotCheckout(d.root, s.id)) : undefined;
    const holderIs = !s.holder ? undefined : !fresh ? 'unknown' : f!.live.includes(s.holder) ? 'live' : f!.resumable.includes(s.holder) ? 'stopped' : 'gone';
    return {
      id: s.id,
      ...(s.holder ? { holder: s.holder, holderIs } : {}),
      ...(s.branch ? { branch: s.branch } : {}),
      ...(head?.code === 0 && head.out.trim() ? { commit: head.out.trim() } : {}),
      ...(s.takenAt ? { takenAt: s.takenAt } : {}),
      ...(used ? { usedAt: new Date(used).toISOString() } : {}),
      free: j.free,
      // A held slot another worker may take now: w5885's notion of a stale hold, which the next take frees by itself.
      stale: !!s.holder && j.free,
      why: j.why,
    };
  });
  return { at: new Date(d.now()).toISOString(), max: d.max, slots };
}

/**
 * w5885: save the work a freed slot's holder left in its checkout before the slot is reset (lothsahn: "Unpushed work is pushed
 * or kept safe first, never dropped"): uncommitted changes are committed, and the tip is kept as branch
 * `rescue/ffu-slot/<slot>-<holder>-<sha8>` in the shared clone (a local branch: fetch --prune never drops it) and pushed to
 * origin when it can be (ffu's CI runs on pushes to main and tags only, so the push starts nothing). Throws when it cannot
 * commit: the take then fails and the checkout stays as it was.
 */
export function rescueWork(d: FfuSlotDeps, s: FfuSlot): FfuRescue {
  const wt = slotCheckout(d.root, s.id);
  const repo = repoDir(d.root);
  const holder = s.holder ?? 'unknown';
  const from = d.git(['symbolic-ref', '--quiet', '--short', 'HEAD'], wt).out.trim() || undefined;
  if (d.git(['status', '--porcelain', '--untracked-files=normal'], wt).out.trim()) {
    must(d.git(['add', '-A'], wt), 'git add');
    must(d.git(['commit', '--quiet', '-m', `ffu-slot rescue: what ${holder} left uncommitted in ${s.id}${from ? ` on ${from}` : ''} (w5885)`], wt), 'git commit');
  }
  const sha = must(d.git(['rev-parse', 'HEAD'], wt), 'git rev-parse').trim();
  const branch = `rescue/ffu-slot/${s.id}-${holder.slice(0, 8)}-${sha.slice(0, 8)}`;
  must(d.git(['branch', '-f', branch, sha], repo), 'git branch');
  // The work now lives on the rescue branch only: the holder's own branch goes back to origin's (or away, if origin has
  // none), so the next worker on it starts from what was pushed, not from what another worker left.
  if (from) {
    must(d.git(['checkout', '--quiet', '--detach'], wt), 'git checkout');
    const onOrigin = d.git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${from}`], repo).code === 0;
    must(d.git(onOrigin ? ['branch', '-f', from, `refs/remotes/origin/${from}`] : ['branch', '-D', from], repo), 'git branch');
  }
  const push = d.git(['push', '--quiet', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], repo);
  const r: FfuRescue = { holder, slot: s.id, branch, sha, ...(from ? { from } : {}), pushed: push.code === 0, at: new Date(d.now()).toISOString() };
  d.say(`ffu-slot: saved ${holder}'s work in ${s.id} (${sha.slice(0, 8)}) on branch ${branch}${r.pushed ? ', pushed to origin' : ` in ${fwd(repo)} (push failed: ${(push.err || push.out).trim().slice(0, 160)})`}\n`);
  return r;
}

/** Tell this worker, once, of work of its own that a freed slot saved (w5885); true when it told one. */
function tellRescues(d: FfuSlotDeps, st: FfuSlotState): boolean {
  let told = false;
  for (const r of st.rescues ?? []) {
    if (r.holder !== d.session || r.told) continue;
    d.say(`ffu-slot: your slot ${r.slot} went to another worker after you left it unused; your work there (${r.sha.slice(0, 8)}${r.from ? `, on ${r.from}` : ''}) is on branch ${r.branch}${r.pushed ? ' (pushed to origin)' : ' in the shared clone'}: take a slot and merge or check it out\n`);
    r.told = told = true;
  }
  return told;
}

const nextId = (s: FfuSlotState) => {
  const used = new Set(s.slots.map((x) => x.id));
  for (let i = 1; ; i++) if (!used.has(`slot${i}`)) return `slot${i}`;
};

function must(r: Ran, what: string): string {
  if (r.code !== 0) throw new Error(`${what} failed: ${(r.err || r.out).trim().slice(0, 400)}`);
  return r.out;
}

/** The shared clone: made once (bare, fetching every branch into origin/*), fetched on every take. */
function ensureRepo(d: FfuSlotDeps, remote: string): void {
  const repo = repoDir(d.root);
  if (!fs.existsSync(path.join(repo, 'HEAD'))) {
    d.say(`ffu-slot: cloning ${remote} into ${repo} (once per machine)\n`);
    must(d.git(['clone', '--bare', '--quiet', remote, repo]), 'git clone');
    must(d.git(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], repo), 'git config');
  }
  must(d.git(['fetch', '--prune', '--quiet', 'origin'], repo), 'git fetch');
  d.git(['worktree', 'prune'], repo);
  // w6038: the slots' own git runs FF Factory's slot hooks. --local: gitSpawnSync's command-scope core.hooksPath would answer.
  const hooks = fwd(slotHooksDir(d));
  if (d.git(['config', '--local', '--get', 'core.hooksPath'], repo).out.trim() !== hooks) must(d.git(['config', '--local', 'core.hooksPath', hooks], repo), 'git config');
}

/**
 * `slot<N>/.cargo/config.toml` naming the slot's target (w4258): cargo reads config from every folder above where it runs,
 * so a build in the checkout lands in the slot's target even without CARGO_TARGET_DIR (a new shell, a script that resets
 * its environment), never in a second `ffu/target` beside it. The environment variable still wins when it is set.
 */
export function writeSlotCargoConfig(root: string, id: string): void {
  const file = path.join(slotDir(root, id), '.cargo', 'config.toml');
  // w5499: incremental off, as ffu CI builds (ci.yml, CARGO_INCREMENTAL: 0). debug/incremental was the biggest and fastest
  // growing part of every slot target (BEAST slot2: 38 of 55 GB; a fresh workspace test build 14.2 GB with it, 9.1 GB
  // without) for an edit rebuild about 60 s faster (docs/ffu-sandboxes.md, "Incremental off"). CARGO_INCREMENTAL=1 in a
  // worker's shell turns it back on for a tight edit loop; the clean-up drops an idle incremental cache.
  const text = `# Written by FF Factory's ffu-slot (w4258): this slot's builds go in its own warm target.\n# w5499: incremental off, as ffu CI builds; CARGO_INCREMENTAL=1 turns it on for one shell.\n[build]\ntarget-dir = ${JSON.stringify(fwd(slotTarget(root, id)))}\nincremental = false\n`;
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  } catch {
    // best effort: CARGO_TARGET_DIR from envLines still points the build there
  }
}

/** Put a slot's checkout on `branch` (or detached at origin/main), discarding what a stopped holder left only when it held no work. */
function prepare(d: FfuSlotDeps, id: string, branch: string | undefined, base: string): void {
  const repo = repoDir(d.root);
  const wt = slotCheckout(d.root, id);
  fs.mkdirSync(slotDir(d.root, id), { recursive: true });
  writeSlotCargoConfig(d.root, id);
  if (!fs.existsSync(path.join(wt, '.git'))) {
    fs.rmSync(wt, { recursive: true, force: true });
    must(d.git(['worktree', 'add', '--detach', '--quiet', wt, `origin/${base}`], repo), 'git worktree add');
  } else {
    must(d.git(['reset', '--hard', '--quiet'], wt), 'git reset');
    must(d.git(['clean', '-fdq'], wt), 'git clean');
  }
  if (!branch) {
    must(d.git(['checkout', '--quiet', '--detach', `origin/${base}`], wt), 'git checkout');
    return;
  }
  const has = (ref: string) => d.git(['rev-parse', '--verify', '--quiet', ref], repo).code === 0;
  const local = has(`refs/heads/${branch}`);
  const remote = has(`refs/remotes/origin/${branch}`);
  // A local branch with commits origin lacks is kept as it is (a stopped holder's work); otherwise it follows origin.
  const localAhead = local && remote && d.git(['merge-base', '--is-ancestor', `refs/heads/${branch}`, `refs/remotes/origin/${branch}`], repo).code !== 0;
  // git checks a branch out in one worktree only: a branch another slot has gets a detached checkout of its tip here.
  const elsewhere = d
    .git(['worktree', 'list', '--porcelain'], repo)
    .out.split(/\r?\n\r?\n/)
    .some((b) => b.includes(`\nbranch refs/heads/${branch}`) && !path.resolve(b.split(/\r?\n/)[0].replace(/^worktree /, '')).startsWith(path.resolve(wt)));
  if (elsewhere) {
    const tip = localAhead || !remote ? `refs/heads/${branch}` : `refs/remotes/origin/${branch}`;
    must(d.git(['checkout', '--quiet', '--detach', tip], wt), 'git checkout');
    d.say(`ffu-slot: ${branch} is checked out in another slot: this one is detached at its tip (push with git push origin HEAD:${branch})\n`);
    return;
  }
  const args = localAhead || (local && !remote) ? ['checkout', '--quiet', branch] : ['checkout', '--quiet', '-B', branch, remote ? `origin/${branch}` : `origin/${base}`];
  must(d.git(args, wt), 'git checkout');
  if (!remote) d.say(`ffu-slot: ${branch} is new: made from origin/${base}\n`);
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const fwd = (p: string) => p.replace(/\\/g, '/');

/**
 * The lines `eval "$(ffu-slot take)"` runs: the slot, its checkout and target, the machine's cargo home inside the root
 * (w5501: a fenced worker can fetch a new crate there, which it could not in the person's ~/.cargo), and a cd into the checkout.
 */
export function envLines(root: string, id: string, cargoHome?: string): string {
  const wt = fwd(slotCheckout(root, id));
  return [`export FFU_SLOT=${q(id)}`, `export FFU_DIR=${q(wt)}`, `export CARGO_TARGET_DIR=${q(fwd(slotTarget(root, id)))}`, 'export CARGO_INCREMENTAL=0', ...(cargoHome ? [`export CARGO_HOME=${q(fwd(cargoHome))}`] : []), `cd ${q(wt)}`, ''].join('\n');
}

export interface TakeOptions {
  branch?: string;
  base?: string;
  remote?: string;
}

/** No slot can be had now (all held, or no disk for a new one): `take --wait` waits on it; the CLI exits 4. */
export class NoFreeSlot extends Error {}

/** What a worker that finds no free slot does (w5885): wait, never build elsewhere. */
export const NO_SLOT_ADVICE =
  'Wait for one: run `ffu-slot take --wait 9 --branch <your branch>` (it looks every 30 s), or set a wake_me check-in (15 min) and end your turn, then take again. Do not build ffu anywhere else: not in $TMPDIR, not in a clone or worktree of your own (w5885)';

/** w5885: the slots a session holds, the most recently used first. */
export function heldSlots(st: FfuSlotState, session: string): FfuSlot[] {
  const used = (s: FfuSlot) => Date.parse(s.usedAt ?? '') || 0;
  return st.slots.filter((s) => session && s.holder === session).sort((a, b) => used(b) - used(a));
}

/** Take a slot (or keep the one held): its id, after the checkout is ready. Throws NoFreeSlot with the reason when none can be had. */
export function takeSlot(d: FfuSlotDeps, o: TakeOptions = {}): string {
  const base = o.base ?? 'main';
  return withLock(d, () => {
    ensureRepo(d, o.remote ?? FFU_REMOTE);
    const st = readSlotState(d.root);
    tellRescues(d, st);
    // w5885: a worker holds one slot per branch (up to FFU_SLOTS_PER_WORKER): take --branch on a branch none of its slots is on
    // leases another free slot, so two checkouts never share one target; with none free, a slot of its own with no work
    // switches, as before.
    const held = heldSlots(st, d.session);
    const mine = o.branch ? held.find((s) => s.branch === o.branch) : held[0];
    let pick = mine;
    if (!pick) {
      const verdict = new Map(st.slots.map((s) => [s, slotFree(d, s)]));
      const free = held.length < FFU_SLOTS_PER_WORKER ? st.slots.filter((s) => s.holder !== d.session && verdict.get(s)?.free) : [];
      const used = (s: FfuSlot) => Date.parse(s.usedAt ?? '') || 0;
      const onBranch = o.branch ? free.filter((s) => s.branch === o.branch) : [];
      // A slot with no work to save goes before one whose holder's work must be rescued first.
      const clean = (l: FfuSlot[]) => l.filter((s) => !verdict.get(s)?.rescue);
      const pool = [onBranch, free].map((l) => (clean(l).length ? clean(l) : l)).find((l) => l.length) ?? [];
      pick = pool.sort((a, b) => used(b) - used(a))[0];
      // No other slot to lease (or at the cap): a slot of your own with no work switches to the branch, the least used first.
      const own = () => [...held].reverse().find((s) => !checkoutWork(d, s.id));
      if (!pick && held.length && (held.length >= FFU_SLOTS_PER_WORKER || st.slots.length >= d.max)) {
        const sw = own();
        if (sw) pick = sw;
        else {
          tellAndKeep(d, st);
          const yours = held.map((s) => `${s.id}${s.branch ? ` on ${s.branch}` : ''}: ${checkoutWork(d, s.id)}`).join('; ');
          throw new NoFreeSlot(
            held.length >= FFU_SLOTS_PER_WORKER
              ? `you hold ${held.length} ffu slots, the most one worker may (${yours}): push the work of one and release it (ffu-slot release --slot <id>), or wait for your own build to finish there`
              : `no other ffu slot is free for ${o.branch} (${st.slots.filter((s) => s.holder !== d.session).map((s) => `${s.id}: ${verdict.get(s)?.why}`).join('; ')}), and yours have work (${yours}). ${NO_SLOT_ADVICE}`,
          );
        }
      }
      if (!pick && st.slots.length >= d.max) {
        tellAndKeep(d, st);
        throw new NoFreeSlot(`all ${d.max} ffu slots are held (${st.slots.map((s) => `${s.id}: ${verdict.get(s)?.why}`).join('; ')}). ${NO_SLOT_ADVICE}`);
      }
      if (pick && pick.holder !== d.session) {
        const v = verdict.get(pick);
        if (v?.rescue) (st.rescues ??= []).push(rescueWork(d, pick));
        d.say(`ffu-slot: took ${pick.id}${pick.branch ? ` (last on ${pick.branch})` : ''}${held.length ? `, beside your ${held.map((s) => s.id).join(', ')}` : ''}: ${v?.why}\n`);
      }
    }
    if (!pick) {
      const gb = d.freeGB(d.root);
      if (gb !== undefined && gb < FFU_NEW_SLOT_MIN_FREE_GB) {
        tellAndKeep(d, st);
        throw new NoFreeSlot(`no free ffu slot, and a new one is not made with ${gb.toFixed(0)} GB free (under ${FFU_NEW_SLOT_MIN_FREE_GB} GB). ${NO_SLOT_ADVICE}`);
      }
      pick = { id: nextId(st) };
      st.slots.push(pick);
      d.say(`ffu-slot: made ${pick.id}: its first build is cold\n`);
    }
    // Your own slot keeps its checkout as you left it, unless you ask for another branch.
    if (pick.holder !== d.session || (o.branch && o.branch !== pick.branch) || !fs.existsSync(path.join(slotCheckout(d.root, pick.id), '.git'))) {
      if (pick.holder === d.session) {
        const work = checkoutWork(d, pick.id);
        if (work) throw new Error(`${pick.id}: ${work}: commit and push it before switching the slot to ${o.branch}`);
      }
      prepare(d, pick.id, o.branch, base);
      pick.branch = o.branch;
    }
    const at = new Date(d.now()).toISOString();
    if (pick.holder !== d.session) pick.takenAt = at;
    pick.holder = d.session;
    pick.usedAt = at;
    // A rescue is listed a fortnight; its branch stays until someone deletes it.
    if (st.rescues) st.rescues = st.rescues.filter((r) => d.now() - Date.parse(r.at) < 14 * 24 * 3_600_000);
    writeSlotState(d.root, st);
    return pick.id;
  });
}

/** Keep the told marks a refused take set. */
function tellAndKeep(d: FfuSlotDeps, st: FfuSlotState): void {
  if (st.rescues?.some((r) => r.holder === d.session && r.told)) writeSlotState(d.root, st);
}

/** w5885: take a slot, waiting up to `minutes` for one to free (looking every WAIT_POLL_MS, outside the lock) instead of building elsewhere. */
export function takeSlotWaiting(d: FfuSlotDeps, o: TakeOptions, minutes: number): string {
  const until = d.now() + minutes * 60_000;
  let told = false;
  for (;;) {
    try {
      return takeSlot(d, o);
    } catch (e) {
      if (!(e instanceof NoFreeSlot) || d.now() + WAIT_POLL_MS > until) throw e;
      if (!told) d.say(`ffu-slot: no slot is free; waiting up to ${minutes} min for one (${(e as Error).message.replace(/\. Wait for one:.*$/s, '')})\n`);
      told = true;
      d.sleep(WAIT_POLL_MS);
      if (d.readFacts) d.facts = d.readFacts() ?? d.facts;
    }
  }
}

/** w5885: free every slot a worker may take now (a finished or long-unused holder's), saving its work first; the ids freed. */
export function sweepSlots(d: FfuSlotDeps): string[] {
  return withLock(d, () => {
    const st = readSlotState(d.root);
    const out: string[] = [];
    for (const s of st.slots) {
      if (!s.holder || s.holder === d.session) continue;
      const f = slotFree(d, s);
      if (!f.free) continue;
      if (f.rescue) (st.rescues ??= []).push(rescueWork(d, s));
      d.say(`ffu-slot: freed ${s.id}: ${f.why}\n`);
      delete s.holder;
      out.push(s.id);
    }
    writeSlotState(d.root, st);
    return out;
  });
}

/**
 * Give back the slots you hold (w5885: all of them, or the one on `which.branch` or with id `which.slot`); the ids released.
 * A slot with work stays yours: the error names it, after the others are released.
 */
export function releaseSlot(d: FfuSlotDeps, which: { branch?: string; slot?: string } = {}): string[] {
  return withLock(d, () => {
    const st = readSlotState(d.root);
    const mine = heldSlots(st, d.session).filter((s) => (!which.slot || s.id === which.slot) && (!which.branch || s.branch === which.branch));
    const out: string[] = [];
    const kept: string[] = [];
    for (const s of mine) {
      const work = checkoutWork(d, s.id);
      if (work) {
        kept.push(`${s.id}: ${work}`);
        continue;
      }
      delete s.holder;
      s.usedAt = new Date(d.now()).toISOString();
      out.push(s.id);
    }
    writeSlotState(d.root, st);
    if (kept.length) throw new Error(`${out.length ? `released ${out.join(', ')}; ` : ''}${kept.join('; ')}. Commit and push first; a slot with work stays yours`);
    return out;
  });
}

/** `take` and `where`'s exit when a Medium agent is refused a slot (w5870; 4 is "no slot free", w5946 F4). */
export const EXIT_MEDIUM_REFUSED = 5;

/** The CARGO_HOME `take` exports: the machine's one in the root for a worker; none for a Medium agent, which keeps its own (w5947). */
export const slotCargoHome = (d: Pick<FfuSlotDeps, 'cargoHome' | 'medium'>) => (d.medium ? undefined : d.cargoHome);

export const USAGE = `usage: ffu-slot take [--branch <b>] [--base <b>] [--wait <minutes>] | where [--branch <b>] | release [--branch <b> | --slot <id>] | list [--json] | sweep
  take: eval "$(ffu-slot take --branch <your branch>)" gives you an ffu checkout with a warm cargo target (FFU_DIR, CARGO_TARGET_DIR) and cds into it
    exit 4: no slot is free; --wait <minutes> waits for one. Never build ffu elsewhere: wait, or end your turn with wake_me and take again
    exit 5: refused to an agent outside the worker fences (w5870): build in a clone in your own temp folder, as the message says
    a second branch gets a second slot of its own (its own checkout and target), up to ${FFU_SLOTS_PER_WORKER} per worker; never two checkouts in one target
  where: the same lines for the slot you hold on --branch, else the one you used last (exit 1 if none)
  release: give your slots back (or the one on --branch, or --slot) once your work is pushed (a stopped worker's pushed slot frees itself)
  list: every slot, its holder, branch and whether it is free
  sweep: free every slot whose holder finished or left it unused past its limit, saving its work on a rescue branch first
`;

export function ffuSlotMain(argv: string[], d: FfuSlotDeps): number {
  const [cmd, ...rest] = argv;
  const opt = (k: string) => {
    const i = rest.indexOf(k);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (!d.session && cmd !== 'list') {
    d.say(`ffu-slot: FF_SESSION_ID is not set: run it from a worker of FF Factory\n`);
    return 2;
  }
  // w5870: a Medium agent and the slots workers write (see the header).
  const own = 'build ffu in your own temp folder instead, which no worker writes: git clone https://github.com/Final-Factory/ffu.git "$TMPDIR/ffu" and CARGO_TARGET_DIR="$TMPDIR/ffu-target"';
  if ((cmd === 'take' || cmd === 'where') && (d.medium === 'on' || d.medium === 'warn')) {
    if (d.medium === 'on') {
      d.say(`ffu-slot: refused: you run outside the worker fences (not in a sandbox), and the ffu slots are in a folder workers write, so a build there would run their build scripts and cargo config outside the fence; ${own} (w5870)
`);
      return EXIT_MEDIUM_REFUSED;
    }
    d.say(`ffu-slot: WARNING: you run outside the worker fences (not in a sandbox), and the ffu slots are in a folder workers write: a build there runs build scripts and a cargo config any worker could have written. Once daemon.json "mediumAgentFolders" and "mediumAgentCaches" are both "on" (your own temp folder then no worker writes) this is refused (w5870)
`);
  }
  try {
    if (cmd === 'take') {
      const branch = opt('--branch');
      if (branch !== undefined && !/^[A-Za-z0-9._/-]+$/.test(branch)) throw new Error(`not a branch name: ${branch}`);
      const wait = opt('--wait');
      if (wait !== undefined && !(Number(wait) >= 0)) throw new Error(`not a number of minutes: ${wait}`);
      const id = wait ? takeSlotWaiting(d, { branch, base: opt('--base') }, Number(wait)) : takeSlot(d, { branch, base: opt('--base') });
      d.write(envLines(d.root, id, slotCargoHome(d)));
      d.say(`ffu-slot: ${id}: ${fwd(slotCheckout(d.root, id))} (target ${fwd(slotTarget(d.root, id))})\n`);
      return 0;
    }
    if (cmd === 'where') {
      const held = heldSlots(readSlotState(d.root), d.session);
      const want = opt('--branch');
      const mine = want ? held.find((s) => s.branch === want) : held[0];
      if (!mine) {
        if (want && held.length) {
          d.say(`ffu-slot: none of your slots (${held.map((s) => `${s.id} on ${s.branch ?? 'origin/main'}`).join(', ')}) is on ${want}: take one with eval "$(ffu-slot take --branch ${want})"\n`);
          return 1;
        }
        d.say(`ffu-slot: you hold no slot: take one with eval "$(ffu-slot take --branch <your branch>)"\n`);
        return 1;
      }
      d.write(envLines(d.root, mine.id, slotCargoHome(d)));
      return 0;
    }
    if (cmd === 'release') {
      const ids = releaseSlot(d, { branch: opt('--branch'), slot: opt('--slot') });
      d.say(ids.length ? `ffu-slot: released ${ids.join(', ')}; ${ids.length > 1 ? 'their targets stay' : 'its target stays'} warm for the next worker\n` : 'ffu-slot: you hold no slot\n');
      return 0;
    }
    if (cmd === 'list' && rest.includes('--json')) {
      d.write(`${JSON.stringify(slotsReport(d))}\n`);
      return 0;
    }
    if (cmd === 'list') {
      const st = readSlotState(d.root);
      if (!st.slots.length) d.write(`no ffu slots yet in ${fwd(slotsBase(d.root))} (max ${d.max})\n`);
      // w5912: the last use slotFree and the portal's report read (slotLastUsed), not only the stamp a take wrote in slots.json.
      for (const s of st.slots) {
        const used = slotLastUsed(d, s);
        d.write(`${s.id}\t${s.branch ?? '(origin/main)'}\t${used ? new Date(used).toISOString() : '-'}\t${slotFree(d, s).why}\n`);
      }
      for (const r of st.rescues ?? []) d.write(`rescue\t${r.branch}\t${r.at}\t${r.holder}'s work from ${r.slot}${r.pushed ? ', pushed to origin' : ', in the shared clone only'}\n`);
      return 0;
    }
    if (cmd === 'sweep') {
      const ids = sweepSlots(d);
      d.say(ids.length ? `ffu-slot: freed ${ids.join(', ')}; their targets stay warm\n` : 'ffu-slot: no slot to free\n');
      return 0;
    }
    d.say(USAGE);
    return 2;
  } catch (e) {
    d.say(`ffu-slot: ${(e as Error).message}\n`);
    return e instanceof NoFreeSlot ? 4 : 3;
  }
}

/**
 * The environment of ffu-slot's own git calls (w5991): no hooks but on a push. server/safeGit.ts points core.hooksPath at
 * git-lfs's hooks; their post-checkout and post-commit start `sh` on every checkout and commit (seconds each on a busy
 * Windows machine) to do git-lfs locking, which ffu has none of, and ffu-slot never merges. A push keeps them: pre-push
 * uploads LFS objects, should the rescue branch ever carry any. A core.hooksPath naming a regular file runs no hook
 * (safeGit.test.ts), and this file is FF Factory's code, which no worker writes. Caller entries come after safeGit's fixed
 * keys and win.
 */
export function slotGitEnv(args: string[], env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (args[splitGlobal(args).sub] === 'push') return env;
  const n = Number(env.GIT_CONFIG_COUNT ?? 0) || 0;
  return { ...env, GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: 'core.hooksPath', [`GIT_CONFIG_VALUE_${n}`]: import.meta.filename };
}

export function realFfuSlotDeps(env: NodeJS.ProcessEnv = process.env): FfuSlotDeps {
  const readFacts = () => {
    try {
      return env.FF_CLEANUP_FACTS ? (JSON.parse(fs.readFileSync(env.FF_CLEANUP_FACTS, 'utf8')) as CleanupFacts) : undefined;
    } catch {
      return undefined;
    }
  };
  const facts = readFacts();
  const root = env.FF_WORKER_ROOT || facts?.root || '';
  if (!root) throw new Error('FF_WORKER_ROOT is not set: run it from a worker of FF Factory');
  const max = Number(env.FF_FFU_SLOTS_MAX);
  return {
    root,
    session: env.FF_SESSION_ID ?? '',
    cargoHome: workerCargoHome(root, env, '').home, // the home folder only names a seed's source, which take does not need
    max: Number.isInteger(max) && max >= 0 ? max : FFU_SLOTS_DEFAULT_MAX,
    facts,
    ...(env[MEDIUM_AGENT_VAR] ? { medium: env[MEDIUM_AGENT_VAR] } : {}),
    readFacts,
    now: () => Date.now(),
    git: (args, cwd) => {
      const r = gitSpawnSync(args, { cwd, env: slotGitEnv(args), encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 20 * 60_000 });
      return { code: r.status ?? (r.error ? 127 : 1), out: r.stdout ?? '', err: r.stderr ?? (r.error ? r.error.message : '') };
    },
    freeGB: (dir) => {
      try {
        const s = fs.statfsSync(dir);
        return (s.bavail * s.bsize) / 1024 ** 3;
      } catch {
        return undefined;
      }
    },
    write: (s) => void process.stdout.write(s),
    say: (s) => void process.stderr.write(s),
    sleep: (ms) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  };
}

/** Write the ffu-slot shims (sh for Git Bash and macOS/Linux, .cmd for PowerShell) beside ff-leftovers. */
export function installFfuSlotShim(bin: string, factsFile: string, max: number, node = process.execPath, nodeArgs = process.execArgv.filter((a) => /strip-types|transform-types/.test(a)), script = import.meta.filename): void {
  const qq = (s: string) => `"${s.replace(/(["$`\\])/g, '\\$1')}"`;
  fs.mkdirSync(bin, { recursive: true });
  const sh = path.join(bin, 'ffu-slot');
  fs.writeFileSync(
    `${sh}.tmp`,
    `#!/bin/sh\n# FF Factory: ffu sandboxes with warm cargo targets (machine/ffuSlots.ts, w3764). Written by the machine daemon at start.\nFF_CLEANUP_FACTS=${qq(fwd(factsFile))}\nFF_FFU_SLOTS_MAX=${max}\nexport FF_CLEANUP_FACTS FF_FFU_SLOTS_MAX\nexec ${[fwd(node), ...nodeArgs, fwd(script)].map(qq).join(' ')} "$@"\n`,
  );
  fs.chmodSync(`${sh}.tmp`, 0o755);
  fs.renameSync(`${sh}.tmp`, sh);
  fs.writeFileSync(`${sh}.cmd`, `@echo off\r\nrem FF Factory: ffu sandboxes (machine/ffuSlots.ts).\r\nset "FF_CLEANUP_FACTS=${factsFile}"\r\nset "FF_FFU_SLOTS_MAX=${max}"\r\n${[node, ...nodeArgs, script].map((s) => `"${s}"`).join(' ')} %*\r\n`);
}

/**
 * The daemon's ffu slot report (w5912): `ffu-slot list --json` run as its own process, so the git reads slotFree makes never
 * hold the daemon's event loop, with each target's size as the last clean-up pass measured it (`sizes`, never a du here).
 * Undefined when no slot was made here yet, or the run failed (said in `log`).
 */
export function readFfuSlotsReport(o: { root: string; factsFile: string; max: number; sizes?: ReadonlyMap<string, { bytes: number; at: string }>; log?: (s: string) => void; script?: string }): Promise<FfuSlotsReport | undefined> {
  if (!fs.existsSync(stateFile(o.root))) return Promise.resolve(undefined);
  const env = { ...process.env, FF_WORKER_ROOT: o.root, FF_CLEANUP_FACTS: o.factsFile, FF_FFU_SLOTS_MAX: String(o.max), FF_SESSION_ID: '' };
  const args = [...process.execArgv.filter((a) => /strip-types|transform-types/.test(a)), o.script ?? import.meta.filename, 'list', '--json'];
  return new Promise((resolve) => {
    execFile(process.execPath, args, { env, timeout: 60_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        o.log?.(`ffu slots: list --json failed: ${(stderr || err.message).trim().slice(0, 200)}`);
        return resolve(undefined);
      }
      try {
        const r = JSON.parse(stdout) as FfuSlotsReport;
        for (const s of r.slots) {
          const z = o.sizes?.get(s.id);
          if (z) Object.assign(s, { targetBytes: z.bytes, sizedAt: z.at });
        }
        resolve(r);
      } catch (e) {
        o.log?.(`ffu slots: list --json printed no report: ${(e as Error).message}`);
        resolve(undefined);
      }
    });
  });
}

// Run when started directly (the ffu-slot shim).
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    process.exit(ffuSlotMain(process.argv.slice(2), realFfuSlotDeps()));
  } catch (e) {
    process.stderr.write(`ffu-slot: ${(e as Error).message}\n`);
    process.exit(2);
  }
}
