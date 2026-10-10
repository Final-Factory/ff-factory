import fs from 'node:fs';
import path from 'node:path';
import { hasLocalWork, neverDelete, norm, touchedSince, within, type CleanupGuard, type CleanupItem } from './cleanup.ts';
import { CONTEXT_MAX_AGE_HOURS, requestIdsIn, type StaleContext, type StalePlan } from './staleOutput.ts';
import { mentions } from './ownLeftovers.ts';

/**
 * Leftovers inside the install folder (w899, docs/self-recovery.md "Install-folder leftovers"): what w876 had to remove
 * by hand on LothDesktop on 2026-10-10 (D: fell from 104 GB to 60 GB free while the daemon's clean-up kept most of it
 * as "not attributable"):
 *
 * - per-commit player builds beyond the newest few, in each sandbox's `.nightly-builds/cache` and `Builds/cache`, old
 *   `Builds/bench*` folders and capture output (`.nightly-builds/clips`, `shots`);
 * - the nightly lab's (`<install>/nightly`) builds beyond the newest few, runs, rehearsals and logs past their age;
 * - folders of sessions that stopped: `<install>/tmp/ffa-<session>` (also those holding fixture repos) and stale `scratch/`;
 * - a Claude task `.output` file past a cap (a runaway writer reached 99.6 GB; the space came back only when its
 *   process ended): the file goes and, when its session has stopped, so does the process still writing it.
 *
 * Lothsahn's rule (2026-10-10): clean-up deletes only inside the install folder. Every item is checked to lie
 * inside `root`, and Library, Assets, .git, Inbox and the other folders of a sandbox are never looked into: only the named
 * children below are. A live session's folder (the guard's inUse), a repo with local work, and anything touched
 * recently stay.
 */

export interface InstallLeftoverSettings {
  /** Per-commit builds (and bench/cache entries) of one folder: the newest this many are kept whatever their age. */
  keepBuilds: number;
  /** The others go once nothing inside changed for this many hours (a worker still building into one keeps it). */
  buildUntouchedHours: number;
  /** A `Builds/bench*` folder goes once untouched this many days. */
  benchDays: number;
  /** Capture output (`.nightly-builds/clips`, `shots`) goes once untouched this many days. */
  captureDays: number;
  /** The nightly lab's runs and logs past this many days (the newest run stays). */
  nightlyRunDays: number;
  /** The nightly lab's rehearsals past this many days. */
  rehearsalDays: number;
  /** A stopped session's folder in the agent temp root goes once untouched this many hours. */
  sessionTempHours: number;
  /** `scratch/` entries go once untouched this many days (and when no open request is named in them). */
  scratchDays: number;
  /** A Claude task `.output` file past this many GB is removed, and its writer ended when its session has stopped. */
  outputCapGB: number;
}

export const INSTALL_LEFTOVER_DEFAULTS: InstallLeftoverSettings = {
  keepBuilds: 2,
  buildUntouchedHours: 6,
  benchDays: 2,
  captureDays: 3,
  nightlyRunDays: 3,
  rehearsalDays: 2,
  sessionTempHours: 2,
  scratchDays: 3,
  outputCapGB: 2,
};

/** The settings in force: the defaults under whatever config gave (unknown or ill-typed values ignored). */
export function installLeftoverSettings(raw: unknown): InstallLeftoverSettings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const d = INSTALL_LEFTOVER_DEFAULTS;
  const n = (k: keyof InstallLeftoverSettings, min: number, max: number) => (typeof r[k] === 'number' && Number.isFinite(r[k]) && (r[k] as number) >= min && (r[k] as number) <= max ? (r[k] as number) : d[k]);
  return {
    keepBuilds: n('keepBuilds', 1, 20),
    buildUntouchedHours: n('buildUntouchedHours', 1, 24 * 30),
    benchDays: n('benchDays', 1, 365),
    captureDays: n('captureDays', 1, 365),
    nightlyRunDays: n('nightlyRunDays', 1, 365),
    rehearsalDays: n('rehearsalDays', 1, 365),
    sessionTempHours: n('sessionTempHours', 1, 24 * 30),
    scratchDays: n('scratchDays', 1, 365),
    outputCapGB: n('outputCapGB', 0.1, 1000),
  };
}

/** A process as the plan needs it. */
export interface ProcLite {
  pid: number;
  ppid: number;
  cmd: string;
}

/** A process still writing into a stopped session's folder. */
export interface Stray {
  pid: number;
  cmd: string;
  /** The session folder it belongs to. */
  dir: string;
  /** Why it is named: the oversize output file it holds. */
  why: string;
}

export interface InstallPlan extends StalePlan {
  strays: Stray[];
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GB = 1024 ** 3;
/** Names that are never looked into, under any place. */
const NEVER_SEGMENT = /^(library|assets|projectsettings|packages|usersettings|inbox|\.git|\.claude|node_modules)$/i;
/** Fixture repos of the app's own tests (ffbox-test-*): scratch though they hold commits by design. */
const FIXTURE_REPO = /^ffbox-test-/i;

async function children(dir: string): Promise<fs.Dirent[]> {
  return fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
}

const mtimeOf = async (p: string) => (await fs.promises.lstat(p).catch(() => undefined))?.mtimeMs ?? 0;

/** A build folder's last activity: the folder itself and the files a build writes at its top. */
async function lastActivity(dir: string): Promise<number> {
  return Math.max(await mtimeOf(dir), await mtimeOf(path.join(dir, 'build.log')), await mtimeOf(path.join(dir, 'build-manifest.json')));
}

/** The processes that are `pid` or below it. */
export function descendants(procs: ProcLite[], pid: number): ProcLite[] {
  const out: ProcLite[] = [];
  const seen = new Set<number>([pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of procs) if (!seen.has(p.pid) && seen.has(p.ppid)) (seen.add(p.pid), out.push(p), (grew = true));
  }
  return out;
}

/** Task output files of a session folder (`<ffa>/claude…/<project>/<session>/tasks/<id>.output`) over `capBytes`. */
async function oversizeOutputs(session: string, capBytes: number): Promise<{ file: string; bytes: number }[]> {
  const out: { file: string; bytes: number }[] = [];
  for (const c of await children(session)) {
    if (!c.isDirectory() || !/^claude/i.test(c.name)) continue;
    for (const proj of await children(path.join(session, c.name))) {
      if (!proj.isDirectory()) continue;
      for (const sess of await children(path.join(session, c.name, proj.name))) {
        const tasks = path.join(session, c.name, proj.name, sess.name, 'tasks');
        for (const f of await children(tasks)) {
          if (!f.isFile() || !f.name.endsWith('.output')) continue;
          const file = path.join(tasks, f.name);
          const st = await fs.promises.stat(file).catch(() => undefined);
          if (st && st.size > capBytes) out.push({ file, bytes: st.size });
        }
      }
    }
  }
  return out;
}

/**
 * The plan: reads only. `root` is the install folder (nothing outside it is ever planned); `sandboxes` are the pool's
 * folders; `tempRoots` the agent temp roots; `procs` the process list (absent: no process is named). `guard` is the
 * clean-up's: its inUse covers live sessions' temp folders, and each item is checked again right before its removal.
 */
export async function planInstallLeftovers(o: {
  root?: string;
  sandboxes: string[];
  tempRoots: string[];
  guard: CleanupGuard;
  ctx?: StaleContext;
  procs?: ProcLite[];
  settings?: InstallLeftoverSettings;
  now?: number;
  /** Pids never named a stray (this daemon and its parents). */
  self?: number[];
  localWork?: (dir: string) => Promise<boolean>;
}): Promise<InstallPlan> {
  const plan: InstallPlan = { items: [], listed: [], strays: [] };
  if (!o.root) return plan; // not a worker-root install: nothing here is the install folder
  const root = o.root;
  const s = o.settings ?? INSTALL_LEFTOVER_DEFAULTS;
  const now = o.now ?? Date.now();
  const localWork = o.localWork ?? ((d: string) => hasLocalWork(d, 60_000));
  const items = new Map<string, CleanupItem>();
  const listed = new Map<string, string>();
  const ctx = o.ctx && now - Date.parse(o.ctx.at) < CONTEXT_MAX_AGE_HOURS * HOUR ? o.ctx : undefined;
  const open = new Set(ctx?.open ?? []);
  const relaxed = (base: string): CleanupGuard => ({ ...o.guard, keep: o.guard.keep.filter((k) => !(norm(base) === norm(k) || norm(base).startsWith(norm(k) + '/'))) });
  const live = (p: string) => o.guard.inUse.some((k) => k && (within(p, k) || within(k, p)));

  /** Why `p` must stay, or undefined; `list`: worth showing a person. */
  const blocked = async (p: string, base: string, untouchedMs: number | undefined): Promise<{ why: string; list: boolean } | undefined> => {
    if (!within(p, root)) return { why: 'outside the install folder', list: false };
    if (norm(p) === norm(root) || norm(p) === norm(base)) return { why: 'the install folder or a place itself', list: false };
    const rel = norm(p).slice(norm(base).length).split('/').filter(Boolean);
    if (rel.some((seg) => NEVER_SEGMENT.test(seg))) return { why: 'a Library, Assets, .git or similar folder', list: false };
    const no = neverDelete(p, relaxed(base));
    if (no) return { why: no, list: false };
    if (untouchedMs !== undefined && (await touchedSince(p, now - untouchedMs))) return { why: 'changed recently', list: false };
    const repos: string[] = [];
    if (fs.existsSync(path.join(p, '.git'))) repos.push(p);
    for (const e of await children(p)) if (e.isDirectory() && fs.existsSync(path.join(p, e.name, '.git'))) repos.push(path.join(p, e.name));
    for (const r of repos) {
      if (FIXTURE_REPO.test(path.basename(r))) continue;
      if (await localWork(r)) return { why: `holds a git repo with uncommitted or unpushed work (${r})`, list: true };
    }
    return undefined;
  };
  const take = async (p: string, base: string, rule: string, why: string, untouchedMs: number | undefined) => {
    if (items.has(p)) return;
    const b = await blocked(p, base, untouchedMs);
    if (!b) items.set(p, { path: p, rule, why, base });
    else if (b.list) listed.set(p, b.why);
  };
  /** The entries of `dir`, newest first (by last activity). */
  const newestFirst = async (dir: string, only?: (e: fs.Dirent) => boolean) => {
    const es = (await children(dir)).filter((e) => (only ? only(e) : e.isDirectory()));
    const dated = await Promise.all(es.map(async (e) => ({ e, at: await lastActivity(path.join(dir, e.name)) })));
    return dated.sort((a, b) => b.at - a.at).map((x) => x.e);
  };
  /** Keep the newest `keepBuilds` entries of `dir`; the others go once idle for buildUntouchedHours. */
  const keepNewest = async (dir: string, base: string, rule: string, what: string) => {
    for (const e of (await newestFirst(dir)).slice(s.keepBuilds)) {
      await take(path.join(dir, e.name), base, rule, `${what} ${e.name.slice(0, 12)}, beyond the newest ${s.keepBuilds}, untouched for ${s.buildUntouchedHours} h (rebuildable)`, s.buildUntouchedHours * HOUR);
    }
  };

  // ---- each sandbox: per-commit builds, bench builds, capture output
  for (const sb of o.sandboxes) {
    await keepNewest(path.join(sb, '.nightly-builds', 'cache'), sb, 'build-cache', 'a cached player build');
    await keepNewest(path.join(sb, 'Builds', 'cache'), sb, 'build-cache', 'a cached build');
    for (const e of await children(path.join(sb, 'Builds'))) {
      if (e.isDirectory() && /^bench/i.test(e.name)) await take(path.join(sb, 'Builds', e.name), sb, 'bench-build', `a benchmark build untouched for ${s.benchDays} days`, s.benchDays * DAY);
    }
    for (const e of await children(path.join(sb, '.nightly-builds'))) {
      if (e.isDirectory() && /^(clips|shots)$/i.test(e.name)) await take(path.join(sb, '.nightly-builds', e.name), sb, 'capture-output', `capture output (${e.name}) untouched for ${s.captureDays} days`, s.captureDays * DAY);
    }
  }

  // ---- the nightly lab inside the install folder
  const nightly = path.join(root, 'nightly');
  await keepNewest(path.join(nightly, 'builds'), nightly, 'nightly-build', 'a nightly player build');
  const runs = await newestFirst(path.join(nightly, 'runs'));
  for (const e of runs.slice(1)) await take(path.join(nightly, 'runs', e.name), nightly, 'nightly-run', `a nightly run (not the newest) untouched for ${s.nightlyRunDays} days`, s.nightlyRunDays * DAY);
  for (const e of await children(path.join(nightly, 'rehearsals'))) await take(path.join(nightly, 'rehearsals', e.name), nightly, 'nightly-rehearsal', `a nightly rehearsal untouched for ${s.rehearsalDays} days`, s.rehearsalDays * DAY);
  for (const e of await children(path.join(nightly, 'logs'))) {
    if (e.isFile()) await take(path.join(nightly, 'logs', e.name), nightly, 'nightly-log', `a nightly log untouched for ${s.nightlyRunDays} days`, s.nightlyRunDays * DAY);
  }

  // ---- stale scratch: named after an open request it stays; the rest goes by age
  const scratch = path.join(root, 'scratch');
  for (const e of await children(scratch)) {
    const p = path.join(scratch, e.name);
    const ids = requestIdsIn(e.name);
    if (ids.some((id) => open.has(id))) continue;
    await take(p, scratch, 'stale-scratch', `scratch untouched for ${s.scratchDays} days${ids.length ? `, ${ids.join(', ')} not open` : ''}`, s.scratchDays * DAY);
  }

  // ---- sessions' temp folders: stopped ones go; an oversize task output goes with the process still writing it
  const cap = s.outputCapGB * GB;
  const procs = o.procs;
  const self = new Set(o.self ?? []);
  for (const t of [...new Set(o.tempRoots)]) {
    if (!within(t, root)) continue;
    for (const e of await children(t)) {
      if (!e.isDirectory() || !/^ffa-/i.test(e.name)) continue;
      const dir = path.join(t, e.name);
      const big = await oversizeOutputs(dir, cap);
      if (live(dir)) {
        for (const b of big) listed.set(b.file, `a task output of a LIVE session past ${s.outputCapGB} GB (${(b.bytes / GB).toFixed(1)} GB): kept, someone should look`);
        continue;
      }
      for (const b of big) {
        const no = (await blocked(b.file, t, undefined))?.why;
        if (no) continue;
        items.set(b.file, { path: b.file, rule: 'oversize-output', why: `a task output of a stopped session past ${s.outputCapGB} GB (${(b.bytes / GB).toFixed(1)} GB)`, base: t });
        const holders = (procs ?? []).filter((p) => !self.has(p.pid) && mentions(p.cmd, dir));
        const all = new Map<number, ProcLite>();
        for (const h of holders) for (const p of [h, ...descendants(procs ?? [], h.pid)]) if (!self.has(p.pid)) all.set(p.pid, p);
        for (const p of all.values()) if (!plan.strays.some((x) => x.pid === p.pid)) plan.strays.push({ pid: p.pid, cmd: p.cmd.slice(0, 300), dir, why: `holds ${b.file} (${(b.bytes / GB).toFixed(1)} GB)` });
        if (!all.size) listed.set(`${b.file} (writer unknown)`, 'no process names this stopped session; if space does not come back, its writer still runs');
      }
      await take(dir, t, 'stopped-session-temp', `the temp folder of a session that stopped, untouched for ${s.sessionTempHours} h`, s.sessionTempHours * HOUR);
    }
  }

  for (const p of items.keys()) for (const l of [...listed.keys()]) if (within(l, p)) listed.delete(l);
  plan.items = [...items.values()];
  plan.listed = [...listed].map(([p, why]) => ({ path: p, why }));
  return plan;
}

/** `a` and `b` as one plan: what `b` takes is no longer listed by `a`. */
export function mergePlans(a: StalePlan, b: InstallPlan): InstallPlan {
  const items = new Map<string, CleanupItem>();
  for (const it of [...a.items, ...b.items]) items.set(it.path, it);
  const listed = new Map<string, string>();
  for (const l of [...a.listed, ...b.listed]) if (![...items.keys()].some((p) => within(l.path, p))) listed.set(l.path, l.why);
  return { items: [...items.values()], listed: [...listed].map(([path, why]) => ({ path, why })), strays: b.strays };
}
