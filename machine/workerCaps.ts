// Per-worker caps on memory, processes and temp disk (w5554, item 25 of the rogue-worker audit w5451; lothsahn: "File it:
// generous per-worker memory, process and temp-disk caps"). Until then nothing bounded one worker: a runaway or hijacked
// worker could fill a machine's RAM (and every other worker and editor there with it) or its disk, and the temp-size hook
// (server/tempSizeHook.ts, w3686) only warned.
//
// What is capped is one worker's agent host and everything it starts: its claude and every tool, a batch Unity under
// `unity-slot run` (even `--detach`, which leaves the process tree but not the job or the scope). Its sandbox's Unity editor
// is not: the daemon starts it (machine/unity.ts), outside the host, and it stays outside, because it is the sandbox's and not
// the worker's (a person may be using it, the pool keeps it across workers), its size follows the project, not the worker, and
// the 3-editor limit (machine/unitySlots.ts, w469) and on Linux its own scope with OOMPolicy=continue (machine/linuxScope.ts)
// already bound it. The rest a worker can do to it goes through its MCP bridge, a known gap (docs/worker-caps.md).
//
// How, by OS:
// - Windows: a job object (machine/winJob.cs, built once into <appDir>/bin) holding the host, with a commit limit for the
//   whole job and an active-process limit, and no breakaway. The kernel refuses the allocation or the process past it.
// - Linux: the host's own systemd scope (machine/linuxScope.ts) gets MemoryMax and TasksMax where the user manager delegates
//   those controllers (probed). The kernel's OOM killer ends the biggest process in the scope (OOMPolicy=continue keeps the
//   rest), and a fork past TasksMax fails.
// - macOS: no unprivileged per-tree limit exists (RLIMIT_AS and RLIMIT_DATA are per process and count reserved address
//   space, RLIMIT_NPROC counts the whole user, jetsam limits and coalitions need root or an entitlement: xnu sources,
//   docs/worker-caps.md), so the host reads its tree every POLL_MS and ends its tools when the tree is over a cap.
// - Every OS: the temp folder. Its drive's free space is read every POLL_MS; when it fell TEMP_DROP_BYTES since the last
//   measure, or TEMP_EVERY_MS passed, the folder is measured, and over TEMP_BYTES its tools are ended.
// When a cap is hit, the host ends the worker's tools (every process of the tree but the host and its claude), the worker's
// next tool result carries a note saying which cap and what to do (server/workerCapNotes.ts), and the portal writes a line
// into its request's ledger ('workerCap' signal). The session itself goes on.
//
// The mode (daemon.json `workerCaps`, CapsMode; the daemon hands it to each host in its start record, never through the worker's
// environment, which a worker controls) says how far that goes. The default is warn: a limit starts warn-only,
// enforce waits on a week of warn data and the owner's go, and `ops_worker machine_update worker_caps off` is the recovery
// switch that needs nobody at the machine:
// - off: nothing starts: no job, no scope limits, no watch, no temp stop.
// - warn: everything is measured and reported, nothing is limited or ended. Windows: the job exists with no limit flags and the
//   helper's `stat` answers the active count and the peak commit. Linux: the scope has no MemoryMax or TasksMax, and its
//   memory.peak and pids.peak are read. A Mac: the tree watch only reports. The temp folder: reported, not stopped. A report
//   says "would have hit" (capNote) and the host.log's last line says the peaks seen, so a week of it can set enforce.
// - enforce: the limits above, with two safeguards: tools are ended only when the process list proves who the host's claude is
//   (an empty or host-less list ends nothing, and the helper skips a pid that is no longer in the job), and on Linux the
//   kernel's own action (an OOM kill, a refused fork) is reported but never followed by a kill of ours.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { measureTemp, type TempMeasure } from '../server/tempSizeHook.ts';

const GB = 1e9;
const GiB = 1024 ** 3;

/**
 * The limits, and what each rests on (docs/worker-caps.md has the measurements):
 * - MEMORY_SHARE of the machine's RAM, at least MEMORY_FLOOR. The heaviest normal worker measured: three batch Unity player
 *   builds at once, about 45.5 GB (24.5 GB of Unity.exe and 21 GB of Burst's bcl.exe on LothDesktop, 64 GB, w469); one
 *   build about 15 GB. A worker can hold all three Unity slots (`unity-slot run --count 3`). 80% of 64 GB is 51.2 GB, above
 *   it; the 20% left is the daemon's, the portal's and the editors'. The share is a guess; the peaks are measured.
 *   Normal worker turns measured on BEAST (w5554, 20 s samples): 0.3-1.0 GB, a cargo build 3.4 GB.
 * - PROCESSES (Windows, a Mac): measured peaks of a worker's tree on BEAST were 3-38 processes (w5554), a batch build adds
 *   some tens (bee, compilers, import workers: a guess). 2048 is 50 times the measured peak, and far under what fills a
 *   machine.
 * - TASKS (Linux TasksMax counts threads, not processes): a Unity build alone runs a few hundred threads (a guess); 16384 is
 *   generous for three builds and a cargo build at once, and under the kernel's default pid_max of 4 million.
 * - TEMP_BYTES: the biggest worker temp folder ever measured was 36.5 GB, a game clone with its Library (LothDesktop
 *   2026-11-08, w3686); a cargo target in one reached 23.3 GB (the clean-up's log on lothdesktop, 2026-11-24). 60 GB is
 *   1.6 times the biggest; the 15 GB warning (TEMP_WARN_BYTES) comes long before it.
 */
export const CAP_LIMITS = { MEMORY_SHARE: 0.8, MEMORY_FLOOR: 8 * GiB, PROCESSES: 2048, TASKS: 16384, TEMP_BYTES: 60 * GB };

/**
 * How the caps are watched:
 * - POLL_MS: how often the host looks (a Mac's tree, Linux's cgroup events, the temp drive's free space). A guess: a `ps` of a
 *   machine takes some tens of ms; a fork bomb on a Mac is bounded meanwhile by the kernel's per-user process limit.
 * - TEMP_DROP_BYTES: the temp drive lost this much since the folder's last measure: measure it now (a guess: a clone).
 * - TEMP_EVERY_MS: and at least this often (as TEMP_CHECK_EVERY_MS, w3686).
 * - REPEAT_MS: one cap is reported at most this often; it is enforced every time.
 */
export const CAP_WATCH = { POLL_MS: 2000, TEMP_DROP_BYTES: 2 * GB, TEMP_EVERY_MS: 10 * 60_000, REPEAT_MS: 60_000 };

export interface WorkerCaps {
  /** Bytes the whole tree may use: commit on Windows, memory.max on Linux, resident on a Mac. */
  memoryBytes: number;
  /** Processes at once (Windows, a Mac). */
  processes: number;
  /** Tasks (threads) at once (Linux). */
  tasks: number;
  /** Bytes the worker's temp folder may hold. */
  tempBytes: number;
}

/** The caps on a machine with `totalMem` bytes of RAM. */
export function capsFor(totalMem: number = os.totalmem()): WorkerCaps {
  const memoryBytes = Math.max(CAP_LIMITS.MEMORY_FLOOR, Math.floor((totalMem * CAP_LIMITS.MEMORY_SHARE) / 1048576) * 1048576);
  return { memoryBytes, processes: CAP_LIMITS.PROCESSES, tasks: CAP_LIMITS.TASKS, tempBytes: CAP_LIMITS.TEMP_BYTES };
}

export type CapKind = 'memory' | 'processes' | 'temp';

/** How the caps act (daemon.json `workerCaps`); see the top of this file. */
export type CapsMode = 'off' | 'warn' | 'enforce';

/** daemon.json's `workerCaps` as a mode: absent, and anything it does not name, is warn (a typo must not turn the limits on). */
export function capsModeOf(v: unknown): CapsMode {
  return v === 'off' || v === 'enforce' ? v : 'warn';
}

/** What the host says when a cap was hit: which, its limit, what was seen (when known), how many tool processes it ended. */
export interface CapHit {
  kind: CapKind;
  limit: number;
  seen?: number;
  ended: number;
  /** Warn mode: the cap would have been hit, nothing was stopped. */
  warn?: boolean;
  /** Linux: the kernel enforced the scope's limit (an OOM kill, a refused fork); the host ended nothing. */
  kernel?: boolean;
}

const gb = (b: number) => (b / GB).toFixed(1);

/** The cap hit in a few words: "memory cap (51.2 GB)". */
export function capWords(h: Pick<CapHit, 'kind' | 'limit' | 'seen'>): string {
  const seen = h.seen === undefined ? '' : h.kind === 'processes' ? `, ${h.seen} running` : `, ${gb(h.seen)} GB`;
  if (h.kind === 'memory') return `memory cap (${gb(h.limit)} GB for the agent and every tool it runs${seen})`;
  if (h.kind === 'processes') return `process cap (${h.limit} at once${seen})`;
  return `temp-folder cap (${gb(h.limit)} GB${seen})`;
}

/** The note the worker reads with its next tool result. */
export function capNote(h: CapHit): string {
  const what =
    h.kind === 'temp'
      ? 'Delete what you no longer need in $TMPDIR, each path written out (rm -rf "$TMPDIR/<name>"), before you write more there; a clone of the game repo with its Library does not belong there.'
      : h.kind === 'memory'
        ? 'Something you ran asked for more memory than a worker may use: run fewer heavy jobs at once (a batch Unity build is about 15 GB), or find the runaway before you start it again.'
        : 'Something you ran started processes without end (a fork loop, a runaway script): fix it before you run it again.';
  if (h.warn) {
    return `FF Factory measured your tools: you would have hit your ${capWords(h)} (warn-only: nothing was stopped; w5554, docs/worker-caps.md). ${what} Say in your report that this happened.`;
  }
  if (h.kernel) {
    return `You hit your ${capWords(h)} (w5554, docs/worker-caps.md): the kernel ended the biggest process of your scope or refused a new one; FF Factory ended nothing else and your session goes on. ${what} Say in your report that this happened.`;
  }
  return (
    `FF Factory stopped your tools: you hit your ${capWords(h)} (w5554, docs/worker-caps.md). It ended ${h.ended} process${h.ended === 1 ? '' : 'es'} you had started ` +
    `(shells, builds, background jobs, a batch Unity among them); your session goes on. ${what} Say in your report that this happened.`
  );
}

/** The ledger line for a 'workerCap' signal's `arg` (it crossed a machine link, so its shape is checked), or undefined. */
export function capLedgerLine(sessionId: string, arg: unknown): string | undefined {
  const a = arg as Partial<CapHit> | null | undefined;
  if (!a || !['memory', 'processes', 'temp'].includes(a.kind as string) || typeof a.limit !== 'number' || typeof a.ended !== 'number') return undefined;
  const seen = typeof a.seen === 'number' ? a.seen : undefined;
  const words = capWords({ kind: a.kind as CapKind, limit: a.limit, seen });
  if (a.warn === true) return `worker ${sessionId.slice(0, 8)} would have hit its ${words} (warn-only: nothing was stopped; w5554)`;
  if (a.kernel === true) return `worker ${sessionId.slice(0, 8)} hit its ${words}: the kernel ended a process or refused a fork, FF Factory ended nothing (w5554)`;
  return `worker ${sessionId.slice(0, 8)} hit its ${words}: FF Factory ended ${a.ended} of its tool processes (w5554)`;
}

// ------------------------------------------------------------------------------------------------ the process tree

export interface PsRow {
  pid: number;
  ppid: number;
  /** Resident bytes. */
  rss: number;
}

/** `ps -axo pid=,ppid=,rss=` (rss in KiB) as rows. */
export function parsePs(out: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)/.exec(line);
    if (m) rows.push({ pid: +m[1], ppid: +m[2], rss: +m[3] * 1024 });
  }
  return rows;
}

/** `root` and every process under it. */
export function treeOf(rows: PsRow[], root: number): PsRow[] {
  const kids = new Map<number, PsRow[]>();
  for (const r of rows) if (r.pid !== r.ppid) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r]);
  const self = rows.find((r) => r.pid === root);
  const out: PsRow[] = self ? [self] : [];
  const seen = new Set([root]);
  for (let i = 0; i < out.length; i++) {
    for (const k of kids.get(out[i].pid) ?? []) {
      if (seen.has(k.pid)) continue;
      seen.add(k.pid);
      out.push(k);
    }
  }
  return out;
}

/** The tools among `pids`: all but the host and its own children (its claude, and nothing else a host starts stays). */
export function toolPids(pids: number[], host: number, parentOf: (pid: number) => number | undefined): number[] {
  return pids.filter((p) => p !== host && parentOf(p) !== host);
}

/**
 * The tools among `pids` that are safe to end, given one process list: none, and why, when the list is empty or does not hold
 * the host (then nobody can say which process is its claude, and a kill could hit it); else `toolPids` of those the list knows
 * (a pid it lacks started after it, and is left for the next hit).
 */
export function toolsToEnd(rows: PsRow[], host: number, pids: number[]): { pids: number[]; why?: string } {
  if (!rows.length) return { pids: [], why: 'the process list was empty, so the host and its claude cannot be told from the tools' };
  if (!rows.some((r) => r.pid === host)) return { pids: [], why: `the host (pid ${host}) is not in the process list, so its claude cannot be told from the tools` };
  const parent = new Map(rows.map((r) => [r.pid, r.ppid]));
  return { pids: toolPids(pids.filter((p) => parent.has(p)), host, (q) => parent.get(q)) };
}

/** A Linux cgroup's `memory.events` or `pids.events` counter (`oom_kill 3`, `max 12`), 0 when absent. */
export function eventCount(text: string, key: string): number {
  const m = new RegExp(`^${key}\\s+(\\d+)\\s*$`, 'm').exec(text);
  return m ? Number(m[1]) : 0;
}

/** This process's cgroup v2 folder (`0::/user.slice/...`), or undefined. */
export function ownCgroup(read: (p: string) => string = (p) => fs.readFileSync(p, 'utf8')): string | undefined {
  try {
    const line = read('/proc/self/cgroup').split('\n').find((l) => l.startsWith('0::'));
    return line ? path.posix.join('/sys/fs/cgroup', line.slice(3).trim()) : undefined;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------------------------------------ the temp folder

/**
 * The temp folder's watch: `look(free)` with the drive's free bytes says whether to measure the folder now: the first look,
 * a drop of TEMP_DROP_BYTES since the last measure, or TEMP_EVERY_MS since it.
 */
export function tempWatch(now: () => number = Date.now, w: Pick<typeof CAP_WATCH, 'TEMP_DROP_BYTES' | 'TEMP_EVERY_MS'> = CAP_WATCH) {
  let freeAt: number | undefined;
  let measuredAt = Number.NEGATIVE_INFINITY;
  return {
    look(free: number): boolean {
      if (freeAt === undefined || freeAt - free >= w.TEMP_DROP_BYTES || now() - measuredAt >= w.TEMP_EVERY_MS) {
        freeAt = free;
        measuredAt = now();
        return true;
      }
      // the drive got space back: count drops from here
      if (free > freeAt) freeAt = free;
      return false;
    },
  };
}

// ------------------------------------------------------------------------------------------------ Windows: the job helper

/** The helper's source, beside this file. */
const JOB_SOURCE = path.join(import.meta.dirname, 'winJob.cs');

/**
 * The job helper's exe for this source, built once into `<appDir>/bin` (the daemon's own folder, which a worker cannot write:
 * never its Low tools folder, where a worker could replace it) with PowerShell's Add-Type, which compiles with the .NET
 * Framework compiler every Windows has. Undefined when it cannot be built.
 */
export function jobHelper(appDir: string, log: (s: string) => void = () => undefined): string | undefined {
  let src: string;
  try {
    src = fs.readFileSync(JOB_SOURCE, 'utf8');
  } catch (e) {
    log(`worker caps: no job helper source: ${(e as Error).message}`);
    return undefined;
  }
  const bin = path.join(appDir, 'bin');
  const exe = path.join(bin, `ffjob-${createHash('sha256').update(src).digest('hex').slice(0, 12)}.exe`);
  if (fs.existsSync(exe)) return exe;
  try {
    fs.mkdirSync(bin, { recursive: true });
    // Built under a name of its own, then renamed: two hosts starting at once do not see a half-written exe. It ends in .exe:
    // Add-Type writes a DLL, whatever -OutputType says, to a name that does not (w5554, measured).
    const part = `${exe.slice(0, -4)}.${process.pid}.part.exe`;
    const cs = `${part}.cs`;
    fs.writeFileSync(cs, src);
    const ps = `Add-Type -TypeDefinition ([IO.File]::ReadAllText('${cs.replace(/'/g, "''")}')) -OutputAssembly '${part.replace(/'/g, "''")}' -OutputType ConsoleApplication -Language CSharp`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
    fs.rmSync(cs, { force: true });
    if (r.status !== 0 || !fs.existsSync(part)) {
      log(`worker caps: could not build the job helper: ${(r.stderr || r.stdout || String(r.error ?? '')).trim().slice(0, 400)}`);
      fs.rmSync(part, { force: true });
      return undefined;
    }
    try {
      fs.renameSync(part, exe);
    } catch {
      // another host renamed its own first
      fs.rmSync(part, { force: true });
    }
    return fs.existsSync(exe) ? exe : undefined;
  } catch (e) {
    log(`worker caps: could not build the job helper: ${(e as Error).message}`);
    return undefined;
  }
}

// ------------------------------------------------------------------------------------------------ the watch

export interface CapsOptions {
  caps: WorkerCaps;
  /** How the caps act (daemon.json `workerCaps`, from the host's start record); unset: warn. */
  mode?: CapsMode;
  /** The worker's temp folder, watched on every OS. */
  tempDir?: string;
  /** The daemon's app folder (Windows: where the job helper is built). */
  appDir: string;
  /** A cap was hit (and its tools ended), or in warn mode would have been. */
  onCap: (h: CapHit) => void;
  log: (s: string) => void;
  platform?: NodeJS.Platform;
  /** The host's pid (tests). */
  hostPid?: number;
  /** The scope's cgroup folder (tests; else this process's own, on Linux). */
  cgroup?: string;
  /** CAP_WATCH's timings (tests). */
  watch?: Partial<typeof CAP_WATCH>;
}

/**
 * The caps of the host this runs in, live: returns a stop, which logs the peaks seen and resolves once the job helper is gone
 * (Windows: its exe can be deleted then). Starts the job before the host starts its claude.
 */
export async function startWorkerCaps(o: CapsOptions): Promise<() => Promise<void>> {
  const platform = o.platform ?? process.platform;
  const mode = capsModeOf(o.mode);
  const warn = mode === 'warn';
  o.log(`worker caps: mode ${mode}${warn ? ' (warn-only: nothing is limited or ended, peaks are logged when this host stops)' : ''}`);
  if (mode === 'off') {
    o.log('worker caps: off (daemon.json workerCaps): no job, no scope limits, no watch, no temp stop');
    return () => Promise.resolve();
  }
  const w = { ...CAP_WATCH, ...o.watch };
  const host = o.hostPid ?? process.pid;
  const timers: NodeJS.Timeout[] = [];
  let job: ChildProcess | undefined;
  const reported = new Map<CapKind, number>();
  const reportedSeen = new Map<CapKind, number>();
  let killing: Promise<number> | undefined;
  // What was seen, for the line the host logs when it stops (a week of these sets enforce): the most processes (Linux: tasks)
  // at once, the peak memory (Windows: commit; Linux: the scope's, page cache included; a Mac: resident), the biggest temp
  // folder measured (it is measured only now and then).
  const peaks = { active: 0, memory: 0, temp: 0 };
  const finals: Array<() => Promise<void> | void> = [];

  const ps = (): PsRow[] => parsePs(spawnSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8', timeout: 10_000 }).stdout ?? '');
  const cgroup = o.cgroup ?? (platform === 'linux' ? ownCgroup() : undefined);
  const scoped = !!cgroup && /\/ffw-agent-[^/]+\.scope$/.test(cgroup);

  // Ends the tools: the job's (Windows), the scope's (Linux, a setsid escapee included), else the tree's. Resolves how many.
  // Never in warn mode, and never without a process list that holds the host: with none, which process is its claude is a guess.
  const endTools = (): Promise<number> => {
    if (warn) return Promise.resolve(0);
    if (killing) return killing;
    killing = new Promise<number>((resolve) => {
      if (job?.stdin?.writable) {
        const onLine = (d: Buffer) => {
          const m = /"event":"killed","n":(\d+)/.exec(String(d));
          if (!m) return;
          job?.stdout?.off('data', onLine);
          const why = /"why":"([^"]*)"/.exec(String(d))?.[1];
          if (why) o.log(`worker caps: the job helper ended nothing: ${why}`);
          resolve(Number(m[1]));
        };
        job.stdout?.on('data', onLine);
        job.stdin.write(`kill-tools ${host}\n`);
        setTimeout(() => resolve(0), 15_000).unref();
        return;
      }
      const rows = ps();
      let pids = treeOf(rows, host).map((r) => r.pid);
      if (scoped) {
        try {
          pids = fs.readFileSync(path.join(cgroup!, 'cgroup.procs'), 'utf8').split('\n').filter(Boolean).map(Number);
        } catch {
          // the tree's
        }
      }
      const ends = toolsToEnd(rows, host, pids);
      if (ends.why) {
        o.log(`worker caps: ended nothing: ${ends.why}`);
        resolve(0);
        return;
      }
      let n = 0;
      for (const p of ends.pids) {
        try {
          process.kill(p, 'SIGKILL');
          n++;
        } catch {
          // gone already
        }
      }
      resolve(n);
    }).finally(() => (killing = undefined));
    return killing;
  };

  const report = (h: CapHit) => {
    try {
      o.onCap(h);
    } catch (e) {
      o.log(`worker caps: could not report: ${(e as Error).message}`);
    }
  };

  /**
   * A cap was hit. Warn: said once per kind per REPEAT_MS, nothing ended; `peak` marks a value that only rises (a peak counter),
   * said again only when it rose. Enforce: the tools are ended (every time), unless `kernel`: the kernel already acted.
   */
  const hit = async (kind: CapKind, limit: number, seen?: number, how: { peak?: boolean; kernel?: boolean } = {}) => {
    const fresh = () => Date.now() - (reported.get(kind) ?? Number.NEGATIVE_INFINITY) >= w.REPEAT_MS;
    if (warn) {
      if (!fresh() || (how.peak && seen !== undefined && seen <= (reportedSeen.get(kind) ?? 0))) return;
      reported.set(kind, Date.now());
      reportedSeen.set(kind, seen ?? 0);
      o.log(`worker caps: would have hit the ${capWords({ kind, limit, seen })} (warn-only: nothing was stopped)`);
      report({ kind, limit, ...(seen === undefined ? {} : { seen }), ended: 0, warn: true });
      return;
    }
    const ended = how.kernel ? 0 : await endTools();
    o.log(`worker caps: ${capWords({ kind, limit, seen })} hit; ${how.kernel ? 'the kernel acted, nothing ended here' : `ended ${ended} tool processes`}`);
    if (!fresh()) return;
    reported.set(kind, Date.now());
    report({ kind, limit, ...(seen === undefined ? {} : { seen }), ended, ...(how.kernel ? { kernel: true } : {}) });
  };

  if (platform === 'win32') {
    const exe = jobHelper(o.appDir, o.log);
    if (exe) {
      job = spawn(exe, [String(host), String(o.caps.memoryBytes), String(o.caps.processes), mode], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      job.on('error', (e) => o.log(`worker caps: the job helper failed: ${e.message}`));
      job.stdin?.on('error', () => undefined);
      const statWaiters: Array<() => void> = [];
      const onStat = (active: number, peak: number) => {
        peaks.active = Math.max(peaks.active, active);
        peaks.memory = Math.max(peaks.memory, peak);
        for (const f of statWaiters.splice(0)) f();
        if (!warn) return;
        if (active > o.caps.processes) void hit('processes', o.caps.processes, active);
        if (peak > o.caps.memoryBytes) void hit('memory', o.caps.memoryBytes, peak, { peak: true });
      };
      const ready = await new Promise<boolean>((resolve) => {
        let buf = '';
        const t = setTimeout(() => resolve(false), 20_000);
        job!.stdout?.on('data', (d: Buffer) => {
          buf += String(d);
          let i: number;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (line.includes('"ready"')) (clearTimeout(t), resolve(true));
            else if (line.includes('"error"')) (o.log(`worker caps: the job helper: ${line}`), clearTimeout(t), resolve(false));
            else if (line.includes('"stat"')) {
              const m = /"active":(\d+),"peak":(\d+)/.exec(line);
              if (m) onStat(Number(m[1]), Number(m[2]));
            } else if (line.includes('"memory"')) void hit('memory', o.caps.memoryBytes);
            else if (line.includes('"processes"')) void hit('processes', o.caps.processes, Number(/"active":(\d+)/.exec(line)?.[1]) || undefined);
          }
        });
        job!.on('exit', () => (clearTimeout(t), resolve(false)));
      });
      const asking = () => !!job?.stdin?.writable && job.exitCode === null;
      if (ready) {
        // The job's own counters, asked every POLL_MS: warn mode's only measure, and enforce mode's peaks for the stop line.
        timers.push(setInterval(() => asking() && job!.stdin!.write('stat\n'), w.POLL_MS));
        finals.push(
          () =>
            new Promise<void>((resolve) => {
              if (!asking()) return resolve();
              statWaiters.push(resolve);
              setTimeout(resolve, 1500).unref();
              job!.stdin!.write('stat\n');
            }),
        );
      }
      o.log(
        ready
          ? warn
            ? `worker caps: in a job with no limits (warn-only); measuring against ${gb(o.caps.memoryBytes)} GB and ${o.caps.processes} processes`
            : `worker caps: in a job of ${gb(o.caps.memoryBytes)} GB and ${o.caps.processes} processes`
          : 'worker caps: no job (the helper did not start); temp cap only',
      );
    }
  } else if (scoped) {
    // Enforce: the scope's limits are the kernel's (set when the host was launched, only where the user manager delegates them
    // and takes OOMPolicy=continue, machine/linuxScope.ts); its events say when they were hit, and the host ends nothing then:
    // the kernel already acted, and a ps-based kill here could reach the claude. Warn: the scope has no limits, its peaks are read.
    const counts = { oom: -1, max: -1 };
    const read = (f: string, key: string) => {
      try {
        return eventCount(fs.readFileSync(path.join(cgroup!, f), 'utf8'), key);
      } catch {
        return -1;
      }
    };
    const readFirst = (...files: string[]) => {
      for (const f of files) {
        try {
          const n = Number(fs.readFileSync(path.join(cgroup!, f), 'utf8').trim());
          if (Number.isFinite(n)) return n;
        } catch {
          // the next file: an older kernel has no *.peak
        }
      }
      return -1;
    };
    const look = () => {
      // memory.peak counts page cache too, so warn mode reads high against MemoryMax (which reclaims cache first): a warning, never a stop.
      const mem = readFirst('memory.peak', 'memory.current');
      const tasks = readFirst('pids.peak', 'pids.current');
      peaks.memory = Math.max(peaks.memory, mem);
      peaks.active = Math.max(peaks.active, tasks);
      if (warn) {
        if (tasks > o.caps.tasks) void hit('processes', o.caps.tasks, tasks, { peak: true });
        if (mem > o.caps.memoryBytes) void hit('memory', o.caps.memoryBytes, mem, { peak: true });
        return;
      }
      const local = read('memory.events.local', 'oom_kill');
      const oom = local >= 0 ? local : read('memory.events', 'oom_kill');
      const max = read('pids.events', 'max');
      if (counts.oom >= 0 && oom > counts.oom) void hit('memory', o.caps.memoryBytes, undefined, { kernel: true });
      if (counts.max >= 0 && max > counts.max) void hit('processes', o.caps.tasks, undefined, { kernel: true });
      counts.oom = oom;
      counts.max = max;
    };
    look();
    timers.push(setInterval(look, w.POLL_MS));
    finals.push(look);
    o.log(`worker caps: in scope ${path.posix.basename(cgroup!)}${warn ? ' (no limits: warn-only)' : ''}`);
  } else {
    // A Mac (or a Linux PC with no scope): the tree, read.
    const look = () => {
      if (killing) return;
      const tree = treeOf(ps(), host);
      const rss = tree.reduce((n, r) => n + r.rss, 0);
      peaks.active = Math.max(peaks.active, tree.length);
      peaks.memory = Math.max(peaks.memory, rss);
      const overMemory = rss > o.caps.memoryBytes;
      if (overMemory) void hit('memory', o.caps.memoryBytes, rss);
      // Enforced, one hit ends the tools for both; warn says each.
      if (tree.length > o.caps.processes && (warn || !overMemory)) void hit('processes', o.caps.processes, tree.length);
    };
    timers.push(setInterval(look, w.POLL_MS));
    finals.push(look);
    o.log(`worker caps: watching the tree (${gb(o.caps.memoryBytes)} GB, ${o.caps.processes} processes)${warn ? ', warn-only' : ''}`);
  }

  if (o.tempDir) {
    const dir = o.tempDir;
    const watch = tempWatch(Date.now, w);
    let measuring = false;
    const look = () => {
      if (measuring) return;
      let free: number;
      try {
        const s = fs.statfsSync(dir);
        free = s.bavail * s.bsize;
      } catch {
        return;
      }
      if (!watch.look(free)) return;
      measuring = true;
      void measureTemp(dir)
        .then((m: TempMeasure) => {
          peaks.temp = Math.max(peaks.temp, m.total);
          return m.total > o.caps.tempBytes ? hit('temp', o.caps.tempBytes, m.total) : undefined;
        })
        .catch(() => undefined)
        .finally(() => (measuring = false));
    };
    look();
    timers.push(setInterval(look, w.POLL_MS));
  }
  for (const t of timers) t.unref();
  return async () => {
    for (const t of timers) clearInterval(t);
    for (const f of finals) {
      try {
        await f();
      } catch {
        // the peaks so far
      }
    }
    const tasks = platform === 'linux' && scoped;
    o.log(
      `worker caps: peaks (mode ${mode}): ${peaks.active} ${tasks ? 'tasks' : 'processes'} at once (cap ${tasks ? o.caps.tasks : o.caps.processes}), ` +
        `${gb(peaks.memory)} GB memory (cap ${gb(o.caps.memoryBytes)} GB), ${gb(peaks.temp)} GB temp (cap ${gb(o.caps.tempBytes)} GB)`,
    );
    const helper = job;
    if (!helper || helper.exitCode !== null || helper.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      helper.once('exit', () => resolve());
      setTimeout(resolve, 5000).unref();
      helper.stdin?.end();
    });
  };
}
