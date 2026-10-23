// Orphaned and hung batch builds (w791, Ben on 2026-10-09: "the harness learns from a repeated problem"). Twice that day a
// `-batchmode` Unity build of a sandbox outlived its use and held a Unity slot (machine/unitySlots.ts counts every
// top-level Unity process) until a person approved killing it by hand: LothDesktop pid 3856, a nightly prepare build of
// slot4 hung for 3 h on "More than one copy of bee_backend running in slot4" (its log stopped; its parent script was
// still there), and m5 pid 81390, a worker's Mac build 15 h old whose parent was pid 1. Workers cannot kill Unity by
// hand (server/guard.ts), so nothing cleared them.
//
// This reaper, which the daemon runs once a minute and a worker asks for through the unity tool (`clear_batch`), kills a
// sandbox's batch build (and what it started) when
//   - its owner is gone (the parent process is gone, is init/launchd, or a pid reused after the build started) and the
//     build has made no progress for ORPHAN_STALL_MS, or has run for ORPHAN_MAX_AGE_MS whatever it does;
//   - or its owner is alive but it has run for HUNG_MIN_AGE_MS and made no progress for HUNG_STALL_MS;
//   - or it has run for SPIN_MAX_AGE_MS with a silent log (a hang that burns CPU);
//   - or the worker that owns it asks (`clear_batch` from the session whose `unity-slot run` started it, or from a worker
//     of its sandbox when the run recorded no session) and its log has been silent for OWNED_LOG_STALL_MS, or its log
//     and CPU for OWNED_STALL_MS, whatever its age (w1874).
// Progress is the build's log growing (its -logFile) or its process tree working (CPU_BUSY_SHARE of a core). The owner of
// a build started through `unity-slot run` is the wrapper's caller, not the wrapper: a wrapper whose caller is gone leaves
// an orphan. It then removes the sandbox's stale Temp/UnityLockfile (only when no Unity still has the project open), ends
// a wrapper left with nobody, and tells the orchestrator what it did.
//
// Never touched: an interactive (non-batchmode) editor, any Unity whose project is not one of the daemon's sandboxes (the
// main clone, a person's own checkout), a build whose owner is alive and that shows progress. Pure decisions are
// `ownerOf` and `verdict`; `UnityReaper` gathers the facts and acts.
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../server/proc.ts';
import { parsePsJson } from '../server/watchdog.ts';
import { editorTree, pathKey, treeOf, type Proc, type UnityDeps, type UnityPlatform } from './unity.ts';
import { splitArgs, unityProcesses, type UnityProcess } from './unitySlots.ts';

const MIN = 60_000;

/**
 * The limits. Where each comes from:
 * - HUNG_MIN_AGE_MS: measured. Of 15 healthy nightly Windows builds on LothDesktop (sandboxes/*\/.nightly-builds
 *   build-manifest.json started..finished, 2026-10-07..09) the longest took 36.9 min, the median 8.4; scripts/nightly's README says
 *   about 15 min on the M5. 60 min is 1.6x the longest, so no healthy build is old enough to be judged hung.
 * - ORPHAN_MAX_AGE_MS: a guess on that measurement (2.4x the longest healthy build): an orphan's script is gone, so
 *   nothing finishes the build's steps after it, and it should not hold a slot for longer.
 * - HUNG_STALL_MS, ORPHAN_STALL_MS: guesses. The hung build of 2026-10-09 was silent for hours; a healthy build's log or
 *   CPU stays quiet for minutes at most (Burst, shader and domain-reload phases), so 30 min (10 for an orphan, whose
 *   result no script will use) is a wide margin. Both count progress from when the daemon first saw the build or from
 *   the log's last write, whichever is later, so a daemon restart delays a kill and never brings it forward.
 * - SPIN_MAX_AGE_MS: a guess, 10x the longest healthy build.
 * - CPU_BUSY_SHARE: measured, then a guess (w1874). Until then progress was any 2 s of CPU between two looks. biscuit
 *   pid 2460462 (2026-10-23), a batch build hung in a futex wait after "Unloading 192 Unused Serialized files" (log silent
 *   from 09:51:30), used 50-80 ms of CPU a minute across its process tree (sampled 10:20-10:23), yet clear_batch said
 *   "last progress 3 min ago" at 10:10 and "12 min ago" at 10:20 with the daemon up since 09:49: one burst of 2 s or more
 *   around 10:07 restarted its stall clock. A working build's silent phases (Burst, a player data step) keep a core or
 *   more busy (a guess). 10% of one core between looks (6 s a minute) is above both a burst like that and the idle.
 * - OWNED_STALL_MS, OWNED_LOG_STALL_MS: measured (w1874). Of 690 healthy batch build logs on biscuit (2026-10-14..23), the
 *   longest silence was 592 s: Bee's GenerateNativePluginsForAssemblies (Burst AOT of the player) printed nothing between
 *   [497/500 10s] and [498/500 602s]; the next were 469 s (the same step) and 266 s (BuildPlayerDataGenerator). Bee's own
 *   clock in its progress lines bounds each silence (Unity's log has no clock of its own). So a build its owner asks about
 *   is stalled after 10 min with neither log nor CPU (a Burst step keeps its CPU busy), or 20 min of silent log whatever
 *   its CPU (2x the longest measured, for a slower machine's Burst; a spinning hang).
 * - ORPHAN_LOOKS: an orphan must be seen as one by two looks in a row, so one odd process listing never counts.
 */
export const REAP = {
  HUNG_MIN_AGE_MS: 60 * MIN,
  HUNG_STALL_MS: 30 * MIN,
  ORPHAN_STALL_MS: 10 * MIN,
  ORPHAN_MAX_AGE_MS: 90 * MIN,
  SPIN_MAX_AGE_MS: 6 * 60 * MIN,
  CPU_BUSY_SHARE: 0.1,
  OWNED_STALL_MS: 10 * MIN,
  OWNED_LOG_STALL_MS: 20 * MIN,
  ORPHAN_LOOKS: 2,
  /** How often the daemon looks by itself. */
  LOOK_EVERY_MS: MIN,
} as const;

/** What the machine says about one process (Windows: CIM; a Mac or Linux: ps). */
export interface ProcFacts {
  pid: number;
  /** When it started, ms since the epoch. */
  startedAt?: number;
  /** CPU time used so far (user + system), ms. */
  cpuMs?: number;
}

export interface ReaperPlace {
  id: string;
  path: string;
}

export interface ReaperDeps {
  platform: UnityPlatform;
  procs(): Promise<Proc[]>;
  inspect(pids: number[]): Promise<ProcFacts[]>;
  /** The daemon's sandboxes. Only a Unity whose project is one of these is ever touched. */
  places(): ReaperPlace[];
  /** Last write time of a file, or undefined. */
  mtime(file: string): number | undefined;
  kill(pid: number): void;
  exists(p: string): boolean;
  remove(p: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(line: string): void;
  /** Something the orchestrator should hear: a build was killed. */
  onEvent(text: string): void;
  /** After a kill: look at the slots again at once, so what waited for the freed slot is granted. */
  afterKill?(): Promise<unknown>;
  /** The `unity-slot run` wrappers in the slots mailbox, with the session that started each (w1874: who owns a build). */
  runs?(): { pid: number; session?: string }[];
}

/** A worker asking about its own builds (`unity clear_batch`): its session and its sandbox. */
export interface Asker {
  session: string;
  sandbox: string;
}

// ---------------------------------------------------------------- the pure decisions

export interface Owner {
  gone: boolean;
  /** One phrase: why it is gone, or what the owner is. */
  why: string;
}

/** `unity-slot run` (the daemon's node shim) or the game repo's `unity_slot.py run`: a wrapper, not an owner (w1874). */
export const isSlotWrapper = (cmd: string) => /unitySlots\.ts["']?\s+run\b|unity[-_]slot(?:\.py|\.sh|\.cmd)?["']?\s+run\b/i.test(cmd);

/**
 * Whether the process that started `u` is still there. The parent is the owner (the build script, a worker's shell; for
 * the wrapper `unity-slot run`, the wrapper's caller, w1874: biscuit pid 2460427 lived on under systemd after its
 * worker's shell ended, and its build counted as owned): gone when its pid is not in the listing (Windows keeps the dead parent's pid), when it is
 * init/launchd (pid 1, a user's systemd), or when a process with that pid started after the build did (the pid was
 * reused). Parents of those parents are not looked at: a script that outlives its own parent is still the owner of its build.
 */
export function ownerOf(u: Pick<UnityProcess, 'pid' | 'ppid'>, procs: Proc[], facts: Map<number, ProcFacts>, platform: UnityPlatform, depth = 0): Owner {
  const parent = procs.find((p) => p.pid === u.ppid);
  if (parent && depth < 2 && isSlotWrapper(parent.cmd)) {
    const o = ownerOf(parent, procs, facts, platform, depth + 1);
    return o.gone ? { gone: true, why: `its unity-slot wrapper (pid ${parent.pid}) is left with nobody: ${o.why.replace(/^its /, 'the wrapper\'s ')}` } : { gone: false, why: `its unity-slot wrapper (pid ${parent.pid}) is there, and ${o.why.replace(/^its /, 'the wrapper\'s ')}` };
  }
  if (platform !== 'win32' && u.ppid <= 1) return { gone: true, why: `its parent is ${platform === 'darwin' ? 'launchd' : 'init'} (pid ${u.ppid}): its starter exited` };
  if (!parent) return { gone: true, why: `its parent process ${u.ppid} is gone` };
  if (platform !== 'win32' && /(^|\/)(systemd|init|launchd)(\s|$)/.test(parent.cmd)) return { gone: true, why: `its parent is ${path.posix.basename(parent.cmd.split(/\s/)[0])} (pid ${parent.pid}): its starter exited` };
  const born = facts.get(u.pid)?.startedAt;
  const parentBorn = facts.get(parent.pid)?.startedAt;
  if (born !== undefined && parentBorn !== undefined && parentBorn > born + 1_000) return { gone: true, why: `its parent pid ${u.ppid} is a different process now (started after the build did: the pid was reused)` };
  const name = parent.name ?? path.basename(parent.cmd.split(/\s/)[0] ?? '');
  return { gone: false, why: `its parent ${name || 'process'} (pid ${parent.pid}) is alive` };
}

export interface Judged {
  ageMs: number;
  owner: Owner;
  /** Looks in a row that saw the owner gone. */
  orphanLooks: number;
  /** Time since the log last grew or the tree last used CPU (counted from first sight at the earliest). */
  stalledMs: number;
  /** Time since the log last grew (from first sight when it has no log file). */
  logStalledMs: number;
  /** The worker asking owns it (w1874): it may be ended as soon as it is stalled, whatever its age. */
  owned?: boolean;
  /** It writes a -logFile whose time was read (false: stdout, or no file yet): only then does a silent log alone count. */
  logKnown?: boolean;
}

export function verdict(j: Judged): { kill: boolean; why: string } {
  const min = (ms: number) => `${Math.round(ms / MIN)} min`;
  const state = `running ${min(j.ageMs)}, no log or CPU progress for ${min(j.stalledMs)}`;
  if (j.owned) {
    if (j.logKnown !== false && j.logStalledMs >= REAP.OWNED_LOG_STALL_MS) return { kill: true, why: `stalled, and yours: its log has not grown for ${min(j.logStalledMs)} (a healthy build's log is silent ${min(REAP.OWNED_LOG_STALL_MS / 2)} at most, measured), running ${min(j.ageMs)}` };
    if (j.stalledMs >= REAP.OWNED_STALL_MS) return { kill: true, why: `stalled, and yours: ${state}` };
  }
  const ownNote = j.owned ? `; as it is yours it is ended once its log is silent for ${min(REAP.OWNED_LOG_STALL_MS)}, or log and CPU for ${min(REAP.OWNED_STALL_MS)} (now ${min(j.logStalledMs)} and ${min(j.stalledMs)})` : '';
  if (j.owner.gone) {
    if (j.orphanLooks < REAP.ORPHAN_LOOKS) return { kill: false, why: `${j.owner.why}; waiting for a second look to confirm` };
    if (j.stalledMs >= REAP.ORPHAN_STALL_MS) return { kill: true, why: `orphaned: ${j.owner.why}; ${state}` };
    if (j.ageMs >= REAP.ORPHAN_MAX_AGE_MS) return { kill: true, why: `orphaned: ${j.owner.why}; running ${min(j.ageMs)}, over the ${min(REAP.ORPHAN_MAX_AGE_MS)} an orphan may run, though still making progress` };
    return { kill: false, why: `orphaned (${j.owner.why}) but progressing: ${min(j.stalledMs)} since progress, running ${min(j.ageMs)}; it is stopped at ${min(REAP.ORPHAN_STALL_MS)} without progress or ${min(REAP.ORPHAN_MAX_AGE_MS)} of age${ownNote}` };
  }
  if (j.ageMs >= REAP.HUNG_MIN_AGE_MS && j.stalledMs >= REAP.HUNG_STALL_MS) return { kill: true, why: `hung: ${state} (${j.owner.why}, but it does nothing)` };
  if (j.ageMs >= REAP.SPIN_MAX_AGE_MS && j.logStalledMs >= REAP.HUNG_STALL_MS) return { kill: true, why: `hung: running ${min(j.ageMs)} with a log silent for ${min(j.logStalledMs)} (${j.owner.why}; it still uses CPU)` };
  return { kill: false, why: `${j.owner.why}; running ${min(j.ageMs)}, last progress ${min(j.stalledMs)} ago: kept${ownNote}` };
}

/** The -logFile of a Unity command line, relative ones against the project (where our scripts and Unity's batch mode work). `-` (stdout) is none. */
export function logFileOf(cmd: string, project: string, platform: UnityPlatform): string | undefined {
  const args = splitArgs(cmd);
  const i = args.findIndex((a) => a.toLowerCase() === '-logfile');
  const v = i >= 0 ? args[i + 1] : undefined;
  if (!v || v === '-' || v.startsWith('-')) return undefined;
  const p = platform === 'win32' ? path.win32 : path.posix;
  return p.isAbsolute(v) ? v : p.join(project, v);
}

/** `-executeMethod` of a command line, for the report. */
const methodOf = (cmd: string) => {
  const a = splitArgs(cmd);
  const i = a.findIndex((x) => x.toLowerCase() === '-executemethod');
  return i >= 0 ? a[i + 1] : undefined;
};

/**
 * The CPU and elapsed times `ps` prints: `[[dd-]hh:]mm:ss[.ff]`, in ms.
 */
export function parsePsClock(text: string): number | undefined {
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)(?:\.(\d+))?\s*$/.exec(text);
  if (!m) return undefined;
  const [d, h, mi, s] = [m[1], m[2], m[3], m[4]].map((x) => (x ? Number(x) : 0));
  return (((d * 24 + h) * 60 + mi) * 60 + s) * 1000 + (m[5] ? Math.round(Number(`0.${m[5]}`) * 1000) : 0);
}

// ---------------------------------------------------------------- the reaper

interface Seen {
  /** Its start time at first sight: one more than a few seconds off is another process under the same pid. */
  born: number;
  firstSeen: number;
  orphanLooks: number;
  cpuMs?: number;
  /** When cpuMs was read. */
  cpuReadAt?: number;
  cpuAt: number;
}

export interface Reaped {
  pid: number;
  sandbox: string;
  killed: boolean;
  line: string;
}

export class UnityReaper {
  private readonly d: ReaperDeps;
  /** By pid and command line, with the start time it had, so a reused pid is a new build. */
  private readonly seen = new Map<string, Seen>();
  private busy?: Promise<Reaped[]>;
  /** Looks run one at a time: a worker's look (with its owner rules) waits for the timer's. */
  private chain: Promise<unknown> = Promise.resolve();
  private lastLook = 0;

  constructor(d: ReaperDeps) {
    this.d = d;
  }

  /** The daemon's timer: a look when one is due. */
  async tick(): Promise<void> {
    if (this.d.now() - this.lastLook < REAP.LOOK_EVERY_MS) return;
    await this.look().catch((e) => this.d.log(`unity reaper: look failed: ${(e as Error).message}`));
  }

  /**
   * One look; overlapping plain looks share it. A worker's look (`asker`) runs on its own after any look in flight, with
   * the owner rules for that worker's builds. Returns what it found for each sandbox batch build.
   */
  look(asker?: Asker): Promise<Reaped[]> {
    if (!asker && this.busy) return this.busy;
    const p = this.chain.then(() => this.run(asker));
    this.chain = p.catch(() => undefined);
    if (!asker) {
      this.busy = p;
      void p.finally(() => this.busy === p && (this.busy = undefined)).catch(() => undefined);
    }
    return p;
  }

  /** For a worker that asks (`unity clear_batch`): the same look, in words; its own builds go by the owner rules (w1874). */
  async check(asker?: Asker): Promise<string> {
    const found = await this.look(asker);
    if (!found.length) return 'No batch-mode Unity builds are running in any sandbox on this machine, so there is nothing to clear.';
    const killed = found.filter((f) => f.killed).length;
    const head = killed
      ? `Ended ${killed} stuck batch build(s); the slot(s) are free now.`
      : `No batch build is stuck: each is kept for the reason below. The limits do not move on request; check again later (wake_me) or ask for a restart of the build.${asker ? ` A build of yours (started by your session's unity-slot run, or one of your sandbox's that recorded no session) is ended once its log is silent for ${REAP.OWNED_LOG_STALL_MS / MIN} min, or its log and CPU for ${REAP.OWNED_STALL_MS / MIN} min.` : ''}`;
    return [head, ...found.map((f) => `- ${f.line}`)].join('\n');
  }

  /** The batch Unity runs of the daemon's sandboxes in a listing, with their sandbox (only those are ever touched). */
  batches(procs: Proc[]): { u: UnityProcess; place: ReaperPlace }[] {
    const d = this.d;
    const places = d.places();
    return unityProcesses(procs, d.platform)
      .filter((u) => u.kind === 'batch' && u.project)
      .map((u) => ({ u, place: places.find((p) => pathKey(p.path, d.platform) === pathKey(u.project!, d.platform)) }))
      .filter((c): c is { u: UnityProcess; place: ReaperPlace } => !!c.place);
  }

  /**
   * End one sandbox batch Unity now, whatever its progress (w1860: another worker's exclusive bench turn holds the machine),
   * the way a stuck one is ended: its tree, children first, and the stale Temp/UnityLockfile. Answers what happened.
   */
  async endBatch(pid: number, why: string): Promise<string> {
    const procs = await this.d.procs();
    const c = this.batches(procs).find((x) => x.u.pid === pid);
    if (!c) return 'gone already, or no batch Unity of a sandbox here';
    const cmd = procs.find((p) => p.pid === pid)?.cmd ?? '';
    const label = `batch Unity pid ${pid} of sandbox ${c.place.id}${methodOf(cmd) ? ` (${methodOf(cmd)})` : ''}`;
    return (await this.kill(c.u, c.place, procs, why, label)).line;
  }

  /**
   * Whether `asker` owns the build `u` of `place` (w1874): the `unity-slot run` above it in the process tree recorded the
   * asker's session; or it recorded none (an older wrapper, the game repo's unity_slot.py, no wrapper) and the build is of
   * the asker's sandbox. A build another session started is never the asker's.
   */
  private ownedBy(asker: Asker | undefined, u: UnityProcess, place: ReaperPlace, procs: Proc[], runs: { pid: number; session?: string }[]): boolean {
    if (!asker) return false;
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    for (let pid = u.ppid, i = 0; pid > 1 && i < 8; pid = byPid.get(pid)?.ppid ?? 0, i++) {
      const r = runs.find((x) => x.pid === pid);
      if (r?.session) return r.session === asker.session;
    }
    return place.id === asker.sandbox;
  }

  private async run(asker?: Asker): Promise<Reaped[]> {
    const d = this.d;
    this.lastLook = d.now();
    const procs = await d.procs();
    const cands = this.batches(procs);
    if (!cands.length) {
      this.seen.clear();
      return [];
    }
    const wanted = new Set<number>();
    for (const { u } of cands) {
      for (const pid of treeOf(procs, u.pid)) wanted.add(pid);
      wanted.add(u.ppid);
      // A unity-slot wrapper's caller is the owner (w1874): its start time tells a reused pid.
      const parent = procs.find((p) => p.pid === u.ppid);
      if (parent && isSlotWrapper(parent.cmd)) wanted.add(parent.ppid);
    }
    const runs = asker ? (d.runs?.() ?? []) : [];
    const facts = new Map((await d.inspect([...wanted])).map((f) => [f.pid, f]));
    const now = d.now();
    const out: Reaped[] = [];
    const live = new Set<string>();
    for (const { u, place } of cands) {
      const cmd = procs.find((p) => p.pid === u.pid)?.cmd ?? '';
      const born = facts.get(u.pid)?.startedAt;
      const label = `batch Unity pid ${u.pid} of sandbox ${place.id}${methodOf(cmd) ? ` (${methodOf(cmd)})` : ''}`;
      if (born === undefined) {
        out.push({ pid: u.pid, sandbox: place.id, killed: false, line: `${label}: kept, its start time could not be read` });
        continue;
      }
      // By pid and command line, not start time: on a Mac or Linux the start time is now minus ps's elapsed seconds, which
      // moves by up to a second between looks (measured on biscuit, w1196: 715 ms), so no build was ever seen twice there.
      const key = `${u.pid}|${cmd}`;
      live.add(key);
      let s = this.seen.get(key);
      if (!s || Math.abs(s.born - born) > 5_000) this.seen.set(key, (s = { born, firstSeen: now, orphanLooks: 0, cpuAt: now }));
      const owner = ownerOf(u, procs, facts, d.platform);
      s.orphanLooks = owner.gone ? s.orphanLooks + 1 : 0;
      const tree = treeOf(procs, u.pid);
      const cpu = tree.reduce((n, pid) => n + (facts.get(pid)?.cpuMs ?? 0), 0);
      // Progress is CPU at a working rate since the last read, not any CPU at all (w1874: a hung Unity idles at ~3%).
      if (s.cpuMs !== undefined && s.cpuReadAt !== undefined && now > s.cpuReadAt && cpu - s.cpuMs >= REAP.CPU_BUSY_SHARE * (now - s.cpuReadAt)) s.cpuAt = now;
      s.cpuMs = cpu;
      s.cpuReadAt = now;
      const logFile = logFileOf(cmd, u.project!, d.platform);
      const logAt = logFile ? d.mtime(logFile) : undefined;
      const logStalledMs = now - Math.min(now, logAt ?? s.firstSeen);
      const stalledMs = now - Math.min(now, Math.max(s.cpuAt, logAt ?? 0, s.firstSeen));
      const owned = this.ownedBy(asker, u, place, procs, runs);
      const v = verdict({ ageMs: Math.max(0, now - born), owner, orphanLooks: s.orphanLooks, stalledMs, logStalledMs, owned, logKnown: logAt !== undefined });
      if (!v.kill) {
        out.push({ pid: u.pid, sandbox: place.id, killed: false, line: `${label}: ${v.why}` });
        continue;
      }
      out.push(await this.kill(u, place, procs, v.why, label));
    }
    for (const k of [...this.seen.keys()]) if (!live.has(k)) this.seen.delete(k);
    return out;
  }

  private async kill(u: UnityProcess, place: ReaperPlace, procs: Proc[], why: string, label: string): Promise<Reaped> {
    const d = this.d;
    const { kill, spared } = editorTree(procs, u.pid, place.path, d.platform);
    // Children first, so the build cannot start another one while it dies.
    for (const pid of [...kill].reverse()) d.kill(pid);
    await d.sleep(1_500);
    const after = await d.procs();
    const left = unityProcesses(after, d.platform).filter((x) => x.project && pathKey(x.project, d.platform) === pathKey(place.path, d.platform));
    const lock = (d.platform === 'win32' ? path.win32 : path.posix).join(place.path, 'Temp', 'UnityLockfile');
    let lockNote = '';
    if (d.exists(lock)) {
      if (left.length) lockNote = `; left Temp/UnityLockfile, a Unity (pid ${left.map((x) => x.pid).join(', ')}) still has the project open`;
      else {
        d.remove(lock);
        lockNote = '; removed the stale Temp/UnityLockfile';
      }
    }
    // A unity-slot wrapper ends when its Unity does; one left with nobody (its caller gone) that does not is ended too, so
    // it holds no slot request or bench ticket (w1874). One whose caller is alive is left to report the exit to it.
    let wrapperNote = '';
    const wrapper = procs.find((p) => p.pid === u.ppid && isSlotWrapper(p.cmd));
    if (wrapper && after.some((p) => p.pid === wrapper.pid && p.cmd === wrapper.cmd)) {
      if (ownerOf(wrapper, after, new Map(), d.platform).gone) {
        d.kill(wrapper.pid);
        wrapperNote = `; ended its unity-slot wrapper (pid ${wrapper.pid}), left with nobody`;
      } else wrapperNote = `; its unity-slot wrapper (pid ${wrapper.pid}) tells its caller`;
    } else if (wrapper) wrapperNote = `; its unity-slot wrapper (pid ${wrapper.pid}) ended with it`;
    const text = `ended ${label}: ${why}; killed it and ${kill.length - 1} process(es) it started${spared.length ? ` (spared ${spared.join(', ')})` : ''}${lockNote}${wrapperNote}. Its Unity slot is free.`;
    d.log(`unity reaper: ${text}`);
    d.onEvent(text);
    await d.afterKill?.().catch(() => undefined);
    return { pid: u.pid, sandbox: place.id, killed: true, line: text };
  }
}

// ---------------------------------------------------------------- the real machine

/** Start time and CPU of the given processes: CIM on Windows (100 ns units), `ps -o etime,time` on a Mac or Linux. */
export async function inspectProcs(platform: UnityPlatform, pids: number[], now = Date.now()): Promise<ProcFacts[]> {
  if (!pids.length) return [];
  if (platform === 'win32') {
    const filter = pids.map((p) => `ProcessId=${Math.trunc(p)}`).join(' OR ');
    const script = `@(Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; startedAt = [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds(); cpuMs = [long](([decimal]$_.KernelModeTime + [decimal]$_.UserModeTime) / 10000) } }) | ConvertTo-Json -Compress`;
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error(`inspecting processes failed (${r.code}): ${r.stderr.trim().slice(0, 200)}`);
    return parsePsJson<{ pid: number; startedAt?: number; cpuMs?: number }>(r.stdout, 'the Windows process facts').map((x) => ({ pid: Number(x.pid), startedAt: x.startedAt, cpuMs: x.cpuMs }));
  }
  const r = await run('ps', ['-o', 'pid=,etime=,time=', '-p', pids.map((p) => Math.trunc(p)).join(',')], { timeoutMs: 15_000 });
  // ps exits 1 when some pid is gone and prints the rest.
  return r.stdout
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(\S+)\s+(\S+)\s*$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => {
      const up = parsePsClock(m[2]);
      return { pid: Number(m[1]), startedAt: up === undefined ? undefined : now - up, cpuMs: parsePsClock(m[3]) };
    });
}

/** The reaper's hands on the real machine, from the daemon's Unity process deps (listing, kill, file effects). */
export function realReaperDeps(platform: UnityPlatform, u: UnityDeps, o: Pick<ReaperDeps, 'places' | 'log' | 'onEvent' | 'afterKill' | 'runs'>): ReaperDeps {
  return {
    platform,
    procs: () => u.procs(),
    inspect: (pids) => inspectProcs(platform, pids, u.now()),
    mtime: (f) => {
      try {
        return fs.statSync(f).mtimeMs;
      } catch {
        return undefined;
      }
    },
    kill: (pid) => u.kill(pid, 'SIGKILL'),
    exists: (p) => u.exists(p),
    remove: (p) => u.remove(p),
    sleep: (ms) => u.sleep(ms),
    now: () => u.now(),
    ...o,
  };
}
