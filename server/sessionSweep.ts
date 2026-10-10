import fs from 'node:fs';
import path from 'node:path';
import { hasLocalWork, neverDelete, runCleanup, touchedSince, within, type CleanupGuard, type CleanupItem, type CleanupRun } from './cleanup.ts';
import { descendants, type ProcLite } from './installLeftovers.ts';
import { mentions } from './ownLeftovers.ts';

/**
 * A worker's own temp folder, swept by the daemon once the worker has left (w913, lothsahn, 2026-10-10: "Random clean up
 * commands take a lot of approvals. Is there some way we can build what those cleanup commands are doing into the harness
 * (like we have for trimming the Burst Cache) so that they run every time a worker is done"). Every worker session has a
 * folder of its own, `<install>/tmp/ffa-<session>` (TMP, TEMP and TMPDIR of its process), where its clones, logs, builds,
 * tour output and scratch go; 21 GB of them sat on BEAST on 2026-10-10, up to 8.8 GB for one session, because workers
 * cleaned up by hand or not at all and the daemon's own pass (server/installLeftovers.ts) waits for a stopped session's
 * folder to be untouched for two hours and runs once a day.
 *
 * "A worker is done" is the end of its process: a request closed, a wait for CI or a person, a stop or the idle reaper (the
 * same moment the sandbox trims its Library caches, machine/sandboxes.ts). The session itself stays and can be resumed in the
 * same folder, so the sweep has two steps after the process is gone:
 *
 * 1. after `graceMin` (default 10): everything in the folder goes except git clones (a resumed worker usually wants its clone
 *    back: CI came back red, a review comment) and what a running process still names;
 * 2. after `cloneKeepHours` (default 6, longer than a wait for CI): the clones too, except a clone with work that exists
 *    nowhere else (uncommitted changes, commits no remote has), which stays and is listed.
 *
 * A session that is live again starts over. Nothing outside `<install>/tmp/ffa-*` is looked at, and every item still goes
 * through the clean-up guard (`neverDelete`: the install folder itself, a live session's folder, the Git Bash /tmp, ...).
 */
export interface SweepSettings {
  /** Minutes after the process ended before the first sweep. */
  graceMin: number;
  /** Hours after it ended before the clones go too. */
  cloneKeepHours: number;
  /** An entry changed within this many minutes is left (something still writes there). */
  quietMin: number;
}

export const SWEEP_DEFAULTS: SweepSettings = { graceMin: 10, cloneKeepHours: 6, quietMin: 2 };

export function sweepSettings(raw: unknown): SweepSettings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const n = (k: keyof SweepSettings, min: number, max: number) => (typeof r[k] === 'number' && Number.isFinite(r[k]) && (r[k] as number) >= min && (r[k] as number) <= max ? (r[k] as number) : SWEEP_DEFAULTS[k]);
  return { graceMin: n('graceMin', 1, 24 * 60), cloneKeepHours: n('cloneKeepHours', 1, 24 * 30), quietMin: n('quietMin', 0, 60) };
}

export interface SweepPlan {
  items: CleanupItem[];
  /** Kept for a person: a clone with work that exists nowhere else. */
  listed: { path: string; why: string }[];
  /** Entries that stay for now, and why (a process names the folder, a clone waits for step 2, recent writes). */
  kept: { path: string; why: string }[];
}

const MIN = 60_000;

/** The folders at `dir` or one level below it that are git clones. */
async function clonesIn(dir: string): Promise<string[]> {
  const out: string[] = [];
  if (fs.existsSync(path.join(dir, '.git'))) out.push(dir);
  let names: fs.Dirent[] = [];
  try {
    names = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    // unreadable
  }
  for (const e of names) if (e.isDirectory() && fs.existsSync(path.join(dir, e.name, '.git'))) out.push(path.join(dir, e.name));
  return out;
}

/**
 * What the sweep would take from one stopped session's folder. `step` 1: all but clones; 2: clones too (a clone with local
 * work is listed and kept). Reads only.
 */
export async function planSessionSweep(o: {
  dir: string;
  step: 1 | 2;
  root: string;
  guard: CleanupGuard;
  procs?: ProcLite[];
  /** Pids never named a holder (this daemon and its parents). */
  self?: number[];
  settings?: SweepSettings;
  now?: number;
  localWork?: (dir: string) => Promise<boolean>;
}): Promise<SweepPlan> {
  const plan: SweepPlan = { items: [], listed: [], kept: [] };
  const s = o.settings ?? SWEEP_DEFAULTS;
  const now = o.now ?? Date.now();
  const localWork = o.localWork ?? ((d: string) => hasLocalWork(d, 60_000));
  const self = new Set(o.self ?? []);
  if (!within(o.dir, o.root) || path.resolve(o.dir) === path.resolve(o.root) || !/^ffa-/i.test(path.basename(o.dir))) return plan;
  // A process that names the folder (a build started in it, a watcher): the whole folder waits.
  const holders = (o.procs ?? []).filter((p) => !self.has(p.pid) && mentions(p.cmd, o.dir));
  if (holders.length) {
    const live = new Set<number>();
    for (const h of holders) for (const p of [h, ...descendants(o.procs ?? [], h.pid)]) live.add(p.pid);
    plan.kept.push({ path: o.dir, why: `a process still names it (pid ${[...live].slice(0, 3).join(', ')}): ${holders[0].cmd.slice(0, 100)}` });
    return plan;
  }
  let names: fs.Dirent[] = [];
  try {
    names = await fs.promises.readdir(o.dir, { withFileTypes: true });
  } catch {
    return plan;
  }
  for (const e of names) {
    const p = path.join(o.dir, e.name);
    const no = neverDelete(p, o.guard);
    if (no) {
      plan.kept.push({ path: p, why: no });
      continue;
    }
    if (s.quietMin > 0 && (await touchedSince(p, now - s.quietMin * MIN))) {
      plan.kept.push({ path: p, why: `changed in the last ${s.quietMin} min` });
      continue;
    }
    const clones = e.isDirectory() ? await clonesIn(p) : [];
    if (clones.length) {
      if (o.step === 1) {
        plan.kept.push({ path: p, why: 'a git clone: kept for the worker\'s return until step 2' });
        continue;
      }
      let work: string | undefined;
      for (const c of clones) if (await localWork(c)) work = c;
      if (work) {
        plan.listed.push({ path: p, why: `holds a git clone with uncommitted or unpushed work (${work})` });
        continue;
      }
    }
    plan.items.push({ path: p, rule: 'session-end-temp', why: `left in a stopped session's temp folder (step ${o.step})`, base: o.dir });
  }
  return plan;
}

export interface SweepSession {
  id: string;
  live: boolean;
}

export interface SweeperDeps {
  /** The install folder (root.json's root); without one nothing is swept. */
  root?: string;
  /** The agent temp root, `<install>/tmp`. */
  tempRoot: () => string;
  /** The sessions this daemon knows. */
  sessions: () => SweepSession[];
  /** The folder of a session (cleanup.ts sessionTempDir). */
  dirOf: (sessionId: string) => string;
  guard: () => CleanupGuard;
  procs?: () => Promise<ProcLite[]>;
  self?: () => number[];
  settings?: () => SweepSettings;
  localWork?: (dir: string) => Promise<boolean>;
  now?: () => number;
  log?: (line: string) => void;
  /** Runs the items (default: cleanup.ts runCleanup). */
  run?: (items: CleanupItem[], guard: CleanupGuard) => Promise<CleanupRun>;
}

interface Track {
  /** When the process was first seen gone. */
  since: number;
  /** The steps done. */
  done: 0 | 1 | 2;
}

/**
 * The sweep of stopped sessions' folders (see above). `tick()` is called every half minute or so; it only reads the session
 * list until a session has been gone for `graceMin`.
 */
export class SessionSweeper {
  private readonly tracks = new Map<string, Track>();
  private running = false;
  private readonly d: SweeperDeps;
  constructor(deps: SweeperDeps) {
    this.d = deps;
  }

  /** The sessions waiting for a sweep (tests, status). */
  pending(): { id: string; sinceMs: number; done: number }[] {
    const now = (this.d.now ?? Date.now)();
    return [...this.tracks].map(([id, t]) => ({ id, sinceMs: now - t.since, done: t.done }));
  }

  async tick(): Promise<void> {
    if (!this.d.root || this.running) return;
    const now = (this.d.now ?? Date.now)();
    const s = this.d.settings?.() ?? SWEEP_DEFAULTS;
    const known = new Set<string>();
    for (const x of this.d.sessions()) {
      known.add(x.id);
      if (x.live) this.tracks.delete(x.id); // it came back (or never left): the clock starts at its next end
      else if (!this.tracks.has(x.id)) this.tracks.set(x.id, { since: now, done: 0 });
    }
    for (const id of [...this.tracks.keys()]) if (!known.has(id)) this.tracks.delete(id);
    this.running = true;
    try {
      for (const [id, t] of this.tracks) {
        const age = now - t.since;
        const step: 1 | 2 | undefined = t.done < 2 && age >= s.cloneKeepHours * 60 * MIN ? 2 : t.done < 1 && age >= s.graceMin * MIN ? 1 : undefined;
        if (!step) continue;
        const dir = this.d.dirOf(id);
        if (!this.d.tempRoot() || !within(dir, this.d.tempRoot())) continue;
        if (!fs.existsSync(dir)) {
          t.done = 2;
          continue;
        }
        const plan = await planSessionSweep({ dir, step, root: this.d.root, guard: this.d.guard(), procs: await this.d.procs?.().catch(() => undefined), self: this.d.self?.(), settings: s, now, localWork: this.d.localWork });
        // A process that names the folder: look again next tick, do not count the step as done.
        if (plan.kept.some((k) => k.path === dir)) continue;
        const run = await (this.d.run ?? runCleanup)(plan.items, this.d.guard());
        t.done = step;
        // Nothing left of it: the folder itself goes (an empty ffa- folder is the session's TMPDIR, made again when it returns).
        if (!plan.kept.length && !plan.listed.length && !run.failed.length) await fs.promises.rmdir(dir).catch(() => undefined);
        const gb = (b: number) => `${(b / 1024 ** 3).toFixed(2)} GB`;
        if (run.removed.length || run.failed.length || plan.listed.length || plan.kept.length) {
          this.d.log?.(
            `session sweep ${path.basename(dir)} (step ${step}, process gone ${Math.round(age / MIN)} min): removed ${run.removed.length} entries, ${gb(run.bytes)}` +
              `${run.failed.length ? `; ${run.failed.length} could not go (${run.failed.slice(0, 2).map((f) => `${path.basename(f.path)}: ${f.why}`).join('; ')})` : ''}` +
              `${plan.listed.length ? `; kept for a person: ${plan.listed.map((l) => path.basename(l.path)).join(', ')}` : ''}` +
              `${plan.kept.length ? `; kept for now: ${plan.kept.slice(0, 4).map((k) => `${path.basename(k.path)} (${k.why})`).join(', ')}` : ''}`,
          );
        }
      }
    } finally {
      this.running = false;
    }
  }
}
