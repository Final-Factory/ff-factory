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
 * (cleanup-facts.json's `live`) and its checkout holds no work (no change, no commit missing from origin). A held slot whose
 * holder stopped with work in it stays theirs. The cargo registry stays the machine's (CARGO_HOME, already one per machine).
 * Measured design: docs/ffu-sandboxes.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { CleanupFacts } from '../server/cleanupFolders.ts';

export const FFU_REMOTE = 'https://github.com/Final-Factory/ffu.git';
export const FFU_SLOTS_DIR = 'ffu-sandboxes';
/** Slots per machine unless the daemon says otherwise (FF_FFU_SLOTS_MAX): a guess, 4 x the 16 GB cap = 64 GB at most (docs/ffu-sandboxes.md). */
export const FFU_SLOTS_DEFAULT_MAX = 4;
/** A new slot (a cold target: 6.8 GB after a workspace test build, up to the 16 GB clean-up cap) is not made below this much free disk. */
export const FFU_NEW_SLOT_MIN_FREE_GB = 40;
/** The facts file is trusted for other holders' liveness only while this fresh; older, every other holder counts as live. */
const FACTS_FRESH_MS = 15 * 60_000;
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

export interface FfuSlotState {
  slots: FfuSlot[];
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
  facts?: CleanupFacts;
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
const stateFile = (root: string) => path.join(slotsBase(root), 'slots.json');
const repoDir = (root: string) => path.join(slotsBase(root), 'repo');

export function readSlotState(root: string): FfuSlotState {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(root), 'utf8')) as FfuSlotState;
    return { slots: Array.isArray(s.slots) ? s.slots.filter((x) => x && /^slot\d+$/.test(x.id)) : [] };
  } catch {
    return { slots: [] };
  }
}

function writeSlotState(root: string, s: FfuSlotState): void {
  const f = stateFile(root);
  fs.writeFileSync(`${f}.tmp`, `${JSON.stringify(s, null, 2)}\n`);
  fs.renameSync(`${f}.tmp`, f);
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
  const st = d.git(['status', '--porcelain', '--untracked-files=normal'], wt);
  if (st.code !== 0) return `its checkout cannot be read (git status: ${st.err.trim().slice(0, 160)})`;
  if (st.out.trim()) return `its checkout has ${st.out.trim().split('\n').length} uncommitted change(s)`;
  const ahead = d.git(['log', '--oneline', '-n', '1', 'HEAD', '--not', '--remotes'], wt);
  if (ahead.code !== 0) return `its commits cannot be read (git log: ${ahead.err.trim().slice(0, 160)})`;
  if (ahead.out.trim()) return `its checkout has commits on no branch of origin (${ahead.out.trim()})`;
  return undefined;
}

/** Whether another worker may take `s` now, and if not why. */
export function slotFree(d: FfuSlotDeps, s: FfuSlot): { free: boolean; why: string } {
  if (!s.holder) return { free: true, why: 'released' };
  if (s.holder === d.session) return { free: true, why: 'yours' };
  const f = d.facts;
  if (!f || !f.at || d.now() - Date.parse(f.at) > FACTS_FRESH_MS) return { free: false, why: `held by ${s.holder} (whether it runs is not known: no fresh cleanup-facts.json)` };
  if (f.live.includes(s.holder)) return { free: false, why: `held by ${s.holder}, which runs` };
  const work = checkoutWork(d, s.id);
  if (work) return { free: false, why: `held by ${s.holder}, stopped, and ${work}` };
  return { free: true, why: `held by ${s.holder}, which no longer runs, and its work is pushed` };
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
}

/** Put a slot's checkout on `branch` (or detached at origin/main), discarding what a stopped holder left only when it held no work. */
function prepare(d: FfuSlotDeps, id: string, branch: string | undefined, base: string): void {
  const repo = repoDir(d.root);
  const wt = slotCheckout(d.root, id);
  fs.mkdirSync(slotDir(d.root, id), { recursive: true });
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

/** The lines `eval "$(ffu-slot take)"` runs: the slot, its checkout and target, and a cd into the checkout. */
export function envLines(root: string, id: string): string {
  const wt = fwd(slotCheckout(root, id));
  return [`export FFU_SLOT=${q(id)}`, `export FFU_DIR=${q(wt)}`, `export CARGO_TARGET_DIR=${q(fwd(slotTarget(root, id)))}`, `cd ${q(wt)}`, ''].join('\n');
}

export interface TakeOptions {
  branch?: string;
  base?: string;
  remote?: string;
}

/** Take a slot (or keep the one held): its id, after the checkout is ready. Throws with the reason when none can be had. */
export function takeSlot(d: FfuSlotDeps, o: TakeOptions = {}): string {
  const base = o.base ?? 'main';
  return withLock(d, () => {
    ensureRepo(d, o.remote ?? FFU_REMOTE);
    const st = readSlotState(d.root);
    const mine = st.slots.find((s) => s.holder === d.session);
    let pick = mine;
    if (!pick) {
      const free = st.slots.filter((s) => slotFree(d, s).free);
      const used = (s: FfuSlot) => Date.parse(s.usedAt ?? '') || 0;
      const onBranch = o.branch ? free.filter((s) => s.branch === o.branch) : [];
      pick = (onBranch.length ? onBranch : free).sort((a, b) => used(b) - used(a))[0];
    }
    if (!pick) {
      if (st.slots.length >= d.max) {
        const why = st.slots.map((s) => `${s.id}: ${slotFree(d, s).why}`).join('; ');
        throw new Error(`all ${d.max} ffu slots are held (${why}). Build in your temp folder this time (CARGO_TARGET_DIR="$TMPDIR/ffu-target"), or wait and take one later`);
      }
      const gb = d.freeGB(d.root);
      if (gb !== undefined && gb < FFU_NEW_SLOT_MIN_FREE_GB) throw new Error(`no free ffu slot, and a new one is not made with ${gb.toFixed(0)} GB free (under ${FFU_NEW_SLOT_MIN_FREE_GB} GB)`);
      pick = { id: nextId(st) };
      st.slots.push(pick);
      d.say(`ffu-slot: made ${pick.id}: its first build is cold\n`);
    } else if (pick !== mine) {
      d.say(`ffu-slot: took ${pick.id}${pick.branch ? ` (last on ${pick.branch})` : ''}: ${slotFree(d, pick).why}\n`);
    }
    // Your own slot keeps its checkout as you left it, unless you ask for another branch.
    if (pick !== mine || (o.branch && o.branch !== pick.branch) || !fs.existsSync(path.join(slotCheckout(d.root, pick.id), '.git'))) {
      if (pick === mine) {
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
    writeSlotState(d.root, st);
    return pick.id;
  });
}

export function releaseSlot(d: FfuSlotDeps): string | undefined {
  return withLock(d, () => {
    const st = readSlotState(d.root);
    const mine = st.slots.find((s) => s.holder === d.session);
    if (!mine) return undefined;
    const work = checkoutWork(d, mine.id);
    if (work) throw new Error(`${mine.id}: ${work}. Commit and push first; a slot with work stays yours`);
    delete mine.holder;
    mine.usedAt = new Date(d.now()).toISOString();
    writeSlotState(d.root, st);
    return mine.id;
  });
}

export const USAGE = `usage: ffu-slot take [--branch <b>] [--base <b>] | where | release | list
  take: eval "$(ffu-slot take --branch <your branch>)" gives you an ffu checkout with a warm cargo target (FFU_DIR, CARGO_TARGET_DIR) and cds into it
  where: the same lines for the slot you hold (exit 1 if none)
  release: give your slot back once your work is pushed (a stopped worker's pushed slot frees itself)
  list: every slot, its holder, branch and whether it is free
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
  try {
    if (cmd === 'take') {
      const branch = opt('--branch');
      if (branch !== undefined && !/^[A-Za-z0-9._/-]+$/.test(branch)) throw new Error(`not a branch name: ${branch}`);
      const id = takeSlot(d, { branch, base: opt('--base') });
      d.write(envLines(d.root, id));
      d.say(`ffu-slot: ${id}: ${fwd(slotCheckout(d.root, id))} (target ${fwd(slotTarget(d.root, id))})\n`);
      return 0;
    }
    if (cmd === 'where') {
      const mine = readSlotState(d.root).slots.find((s) => s.holder === d.session);
      if (!mine) return 1;
      d.write(envLines(d.root, mine.id));
      return 0;
    }
    if (cmd === 'release') {
      const id = releaseSlot(d);
      d.say(id ? `ffu-slot: released ${id}; its target stays warm for the next worker\n` : 'ffu-slot: you hold no slot\n');
      return 0;
    }
    if (cmd === 'list') {
      const st = readSlotState(d.root);
      if (!st.slots.length) d.write(`no ffu slots yet in ${fwd(slotsBase(d.root))} (max ${d.max})\n`);
      for (const s of st.slots) d.write(`${s.id}\t${s.branch ?? '(origin/main)'}\t${s.usedAt ?? '-'}\t${slotFree(d, s).why}\n`);
      return 0;
    }
    d.say(USAGE);
    return 2;
  } catch (e) {
    d.say(`ffu-slot: ${(e as Error).message}\n`);
    return 3;
  }
}

export function realFfuSlotDeps(env: NodeJS.ProcessEnv = process.env): FfuSlotDeps {
  let facts: CleanupFacts | undefined;
  try {
    facts = env.FF_CLEANUP_FACTS ? (JSON.parse(fs.readFileSync(env.FF_CLEANUP_FACTS, 'utf8')) as CleanupFacts) : undefined;
  } catch {
    facts = undefined;
  }
  const root = env.FF_WORKER_ROOT || facts?.root || '';
  if (!root) throw new Error('FF_WORKER_ROOT is not set: run it from a worker of FF Factory');
  const max = Number(env.FF_FFU_SLOTS_MAX);
  return {
    root,
    session: env.FF_SESSION_ID ?? '',
    max: Number.isInteger(max) && max >= 0 ? max : FFU_SLOTS_DEFAULT_MAX,
    facts,
    now: () => Date.now(),
    git: (args, cwd) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 20 * 60_000 });
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

// Run when started directly (the ffu-slot shim).
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    process.exit(ffuSlotMain(process.argv.slice(2), realFfuSlotDeps()));
  } catch (e) {
    process.stderr.write(`ffu-slot: ${(e as Error).message}\n`);
    process.exit(2);
  }
}
