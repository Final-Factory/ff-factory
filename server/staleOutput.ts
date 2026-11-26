import fs from 'node:fs';
import path from 'node:path';
import type { OwnLeftoverPlan } from './ownLeftovers.ts';
import { onInstallDrive } from './rootFence.ts';
import { fenceToRoot, hasLocalWork, neverDelete, runCleanup, sizeOf, sizePlan, touchedSince, within, type CleanupGuard, type CleanupItem, type CleanupRun, type PassOptions } from './cleanup.ts';

/**
 * Stale, rebuildable output in the places agents work (w459, docs/self-recovery.md "Stale build output"): player builds
 * and run output whose request is closed, commit builds and run output past their retention, and the Unity Temp and
 * old Logs of sandboxes whose editor is not running. It runs inside the regular clean-up pass (server/cleanup.ts), on
 * the host guard and on every machine's daemon, once a day and whenever free space is low.
 *
 * Safe by design:
 * - an allowlist: only the entries of these folders of a sandbox or a main clone (and the nightly lab's own folders)
 *   are ever looked at: Builds/ (any case), .nightly-builds/ and its runs/, Temp/, Logs/;
 * - attribution: an entry goes only for a reason it can name: the request in its name is closed in the ledger, it
 *   is a build of one commit (rebuildable) past its age, it is run output past the retention window, or it is the
 *   Temp or an old log of a stopped editor. Anything else is listed, never removed;
 * - the guard (neverDelete) and the clean-up's own checks still apply: nothing touched recently, nothing holding a
 *   git repo with local work, nothing kept, protected or in use. Library, Assets, Inbox, .git and every other
 *   folder of a place are not on the list, so they are never looked into.
 */

export interface StaleOutputSettings {
  /** on: remove; dry-run: plan and report only; off: not looked at. */
  mode: 'on' | 'dry-run' | 'off';
  /** A pass with these rules this often (hours), the first one this long after the clean-up started; and whenever free space is below the soft threshold. */
  everyHours: number;
  /** Nothing goes that anything inside changed within this many hours (a worker still using it). */
  untouchedHours: number;
  /** A build of one commit (<sha>-win, <sha>-mac) goes once untouched this many days. */
  shaBuildDays: number;
  /** Run output (.nightly-builds/runs, the nightly lab's runs) not tied to a closed request goes once untouched this many days. */
  runRetentionDays: number;
  /** A stopped editor's log files (a sandbox's Logs/) go once untouched this many days. */
  logRetentionDays: number;
  /** A stopped editor's Temp/ goes once untouched this many hours. */
  tempHours: number;
  /** The nightly lab's builds/: the newest this many are kept whatever their age. */
  nightlyKeep: number;
  /** The nightly lab's roots; default FF_NIGHTLY_ROOT, else the worker root's nightly/ (defaultNightlyRoots). */
  nightlyRoots?: string[];
}

export const STALE_OUTPUT_DEFAULTS: StaleOutputSettings = {
  mode: 'on',
  everyHours: 24,
  untouchedHours: 24,
  shaBuildDays: 2,
  runRetentionDays: 14,
  logRetentionDays: 14,
  tempHours: 6,
  nightlyKeep: 2,
};

/** The settings in force: the defaults under whatever config gave (unknown or ill-typed values ignored). */
export function staleOutputSettings(raw: unknown): StaleOutputSettings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const n = (k: keyof StaleOutputSettings, min: number, max: number) => (typeof r[k] === 'number' && Number.isFinite(r[k]) && (r[k] as number) >= min && (r[k] as number) <= max ? (r[k] as number) : (STALE_OUTPUT_DEFAULTS[k] as number));
  return {
    mode: r.mode === 'off' || r.mode === 'dry-run' || r.mode === 'on' ? r.mode : STALE_OUTPUT_DEFAULTS.mode,
    everyHours: n('everyHours', 1, 24 * 14),
    untouchedHours: n('untouchedHours', 6, 24 * 30),
    shaBuildDays: n('shaBuildDays', 1, 365),
    runRetentionDays: n('runRetentionDays', 1, 365),
    logRetentionDays: n('logRetentionDays', 1, 365),
    tempHours: n('tempHours', 1, 24 * 30),
    nightlyKeep: n('nightlyKeep', 1, 20),
    ...(Array.isArray(r.nightlyRoots) ? { nightlyRoots: r.nightlyRoots.filter((x): x is string => typeof x === 'string' && x.trim() !== '') } : {}),
  };
}

/**
 * The nightly lab's default roots: FF_NIGHTLY_ROOT, else the worker root's nightly/ (scripts/nightly/nightly_root.sh in
 * the game repo), and the worker root's nightly-history/ (w1099). The old places outside the install folder are gone (2026-10-10), so a machine with neither has none.
 */
export function defaultNightlyRoots(workerRoot?: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const root = env.FF_NIGHTLY_ROOT || (workerRoot ? path.join(workerRoot, 'nightly') : '');
  // w1099: a sandbox night's history (scripts/nightly/nightly_root.sh ff_nightly_history) sits beside it.
  const base = workerRoot || env.FF_WORKER_ROOT;
  const history = base ? path.join(base, 'nightly-history') : '';
  return [...new Set([root, history].filter((x) => x))];
}

/**
 * The ledger's facts the rules need (w459): which requests are open and which are closed. The portal knows the
 * ledger and sends it to every daemon; `at` is when, and facts older than CONTEXT_MAX_AGE_HOURS are not acted on.
 */
export interface StaleContext {
  at: string;
  /** Request ids ("w123") still open: new, question, queued, active, or stalled (a person may reopen it). */
  open: string[];
  /** Request ids merged, done, rejected or cancelled. */
  closed: string[];
}

export const CONTEXT_MAX_AGE_HOURS = 48;

/** The ledger's facts for the rules, from its requests' statuses. Stalled counts as open: its person decides. */
export function staleContextOf(work: Iterable<{ id: string; status: string }>, now = Date.now()): StaleContext {
  const open: string[] = [];
  const closed: string[] = [];
  for (const w of work) (['merged', 'done', 'rejected', 'cancelled'].includes(w.status) ? closed : open).push(w.id.toLowerCase());
  return { at: new Date(now).toISOString(), open, closed };
}

/** The request ids an entry's name carries ("w95", "w393-facing", "results-w166-final" → w95, w393, w166). */
export function requestIdsIn(name: string): string[] {
  return [...new Set([...name.matchAll(/(?:^|[^a-z0-9])(w\d{1,6})(?![0-9])/gi)].map((m) => m[1].toLowerCase()))];
}

/** A build of one commit: "<40 hex>" with an optional platform suffix (scripts/nightly/build_player.sh names them so). */
export const SHA_BUILD = /^[0-9a-f]{40}(?:-(?:win|mac|osx|linux))?$/i;

/** One place agents work in: a sandbox's folder or a main clone, and whether its Unity editor runs. */
export interface StalePlace {
  /** For the log: "sb1", "lothdesktop/sb1", "main clone". */
  id: string;
  path: string;
  kind: 'sandbox' | 'clone';
  /** Unknown (undefined) counts as running: Temp and Logs are then left alone. */
  editorRunning?: boolean;
}

/** What a stale-output plan found: what goes, and what it could not attribute (listed for a person, never removed). */
export interface StalePlan {
  items: CleanupItem[];
  listed: { path: string; why: string }[];
  /** Processes still writing into a stopped session's folder (server/installLeftovers.ts, w899): ended before the items go. */
  strays?: { pid: number; cmd: string; dir: string; why: string }[];
  /** Rebuildable caches a low pass saw and kept, measured, with the check that kept them (installLeftovers.ts, w1813). */
  held?: { path: string; bytes: number; why: string }[];
}

const DAY = 86_400_000;
const HOUR = 3_600_000;

async function children(dir: string): Promise<fs.Dirent[]> {
  return fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
}

/** Whether `p` is or holds (one level down) a git repo or worktree. */
async function holdsRepo(p: string): Promise<string[]> {
  const out: string[] = [];
  if (fs.existsSync(path.join(p, '.git'))) out.push(p);
  for (const e of await children(p)) if (e.isDirectory() && fs.existsSync(path.join(p, e.name, '.git'))) out.push(path.join(p, e.name));
  return out;
}

/**
 * The plan: reads only. `guard` is the clean-up's; each item carries its place as `base`, so the keep that covers a
 * whole sandbox or clone does not cover these entries (as the clean-up's insideKept rules), while everything else in
 * the guard still applies, and is checked again right before each removal.
 */
export async function planStaleOutput(opts: {
  places: StalePlace[];
  nightlyRoots: string[];
  ctx?: StaleContext;
  settings: StaleOutputSettings;
  guard: CleanupGuard;
  now?: number;
}): Promise<StalePlan> {
  const s = opts.settings;
  const now = opts.now ?? Date.now();
  const items = new Map<string, CleanupItem>();
  const listed = new Map<string, string>();
  const ctx = opts.ctx && now - Date.parse(opts.ctx.at) < CONTEXT_MAX_AGE_HOURS * HOUR ? opts.ctx : undefined;
  const open = new Set(ctx?.open ?? []);
  const closed = new Set(ctx?.closed ?? []);
  const relaxed = (base: string): CleanupGuard => ({ ...opts.guard, keep: opts.guard.keep.filter((k) => !(norm(base) === norm(k) || norm(base).startsWith(norm(k) + '/'))) });

  /** The common checks; undefined when `p` may go, else why it is kept (and whether to list it). */
  const blocked = async (p: string, base: string, untouchedMs: number): Promise<{ why: string; list: boolean } | undefined> => {
    const no = neverDelete(p, relaxed(base));
    if (no) return { why: no, list: false };
    if (await touchedSince(p, now - untouchedMs)) return { why: 'changed recently', list: false };
    const repos = await holdsRepo(p);
    if (repos.length) {
      for (const r of repos) if (await hasLocalWork(r)) return { why: `holds a git repo with uncommitted or unpushed work (${r})`, list: true };
      return { why: 'holds a git repo', list: true };
    }
    return undefined;
  };
  const take = async (p: string, base: string, rule: string, why: string, untouchedMs: number) => {
    if (items.has(p)) return;
    const b = await blocked(p, base, untouchedMs);
    if (!b) items.set(p, { path: p, rule, why, base });
    else if (b.list) listed.set(p, b.why);
  };
  /** An entry named after requests: goes once every one of them is closed; kept while any is open; listed when unknown. */
  const byRequest = async (p: string, base: string, rule: string, what: string): Promise<boolean> => {
    const ids = requestIdsIn(path.basename(p));
    if (!ids.length) return false;
    if (!ctx) {
      listed.set(p, `${what} for ${ids.join(', ')}, but the ledger's facts are missing or old`);
      return true;
    }
    if (ids.some((id) => open.has(id))) return true;
    const unknown = ids.filter((id) => !closed.has(id));
    if (unknown.length) {
      listed.set(p, `${what} for ${unknown.join(', ')}, which the ledger does not know`);
      return true;
    }
    await take(p, base, rule, `${what} for ${ids.join(', ')}, closed in the ledger`, s.untouchedHours * HOUR);
    return true;
  };

  for (const place of opts.places) {
    const top = await children(place.path);
    for (const d of top) {
      if (!d.isDirectory()) continue;
      const dir = path.join(place.path, d.name);
      const lower = d.name.toLowerCase();
      if (lower === 'builds') {
        // Builds/ (any case: on Windows and macOS builds/ is the same folder): a worker's builds and scratch.
        for (const e of await children(dir)) {
          const p = path.join(dir, e.name);
          if (await byRequest(p, place.path, 'stale-build', 'build output')) continue;
          if (e.isDirectory() && SHA_BUILD.test(e.name)) {
            await take(p, place.path, 'commit-build', `a player build of commit ${e.name.slice(0, 12)} (rebuildable), untouched for ${s.shaBuildDays} day(s)`, Math.max(s.shaBuildDays * DAY, s.untouchedHours * HOUR));
            continue;
          }
          const b = await blocked(p, place.path, s.untouchedHours * HOUR);
          if (!b || b.list) listed.set(p, b?.why ?? `not attributable to a request or a commit (${place.id})`);
        }
      } else if (lower === '.nightly-builds') {
        for (const e of await children(dir)) {
          const p = path.join(dir, e.name);
          if (e.isDirectory() && SHA_BUILD.test(e.name)) {
            await take(p, place.path, 'commit-build', `a player build of commit ${e.name.slice(0, 12)} (rebuildable), untouched for ${s.shaBuildDays} day(s)`, Math.max(s.shaBuildDays * DAY, s.untouchedHours * HOUR));
          } else if (e.isDirectory() && e.name.toLowerCase() === 'runs') {
            for (const r of await children(p)) {
              const rp = path.join(p, r.name);
              if (await byRequest(rp, place.path, 'stale-run', 'e2e run output')) continue;
              await take(rp, place.path, 'old-run', `e2e run output untouched for ${s.runRetentionDays} days`, s.runRetentionDays * DAY);
            }
          } else if (await byRequest(p, place.path, 'stale-build', 'build output')) {
            continue;
          } else {
            const b = await blocked(p, place.path, s.untouchedHours * HOUR);
            if (!b || b.list) listed.set(p, b?.why ?? `not attributable to a request or a commit (${place.id})`);
          }
        }
      } else if (lower === 'temp' && place.kind === 'sandbox' && place.editorRunning === false) {
        // Unity's Temp of an editor that is not running: left by a crash or a kill, recreated at the next start.
        if (fs.existsSync(path.join(dir, 'UnityLockfile'))) continue;
        await take(dir, place.path, 'unity-temp', `Unity's Temp of a stopped editor (${place.id}), untouched for ${s.tempHours} h`, s.tempHours * HOUR);
      } else if (lower === 'logs' && place.kind === 'sandbox' && place.editorRunning === false) {
        for (const e of await children(dir)) {
          if (!e.isFile()) continue;
          await take(path.join(dir, e.name), place.path, 'old-log', `a log of a stopped editor (${place.id}), untouched for ${s.logRetentionDays} days`, s.logRetentionDays * DAY);
        }
      }
    }
  }

  // The nightly lab (scripts/nightly/nightly.sh): builds/<sha>-<platform> beyond the newest few, and old runs/ and logs/.
  for (const root of [...new Set(opts.nightlyRoots)]) {
    const builds = (await children(path.join(root, 'builds'))).filter((e) => e.isDirectory() && SHA_BUILD.test(e.name));
    const dated = await Promise.all(builds.map(async (e) => ({ e, at: (await fs.promises.stat(path.join(root, 'builds', e.name)).catch(() => undefined))?.mtimeMs ?? now })));
    dated.sort((a, b) => b.at - a.at);
    for (const { e } of dated.slice(s.nightlyKeep)) {
      await take(path.join(root, 'builds', e.name), root, 'nightly-build', `a nightly player build of commit ${e.name.slice(0, 12)}, older than the newest ${s.nightlyKeep}`, Math.max(s.shaBuildDays * DAY, s.untouchedHours * HOUR));
    }
    for (const e of await children(path.join(root, 'runs'))) {
      await take(path.join(root, 'runs', e.name), root, 'nightly-run', `a nightly run untouched for ${s.runRetentionDays} days`, s.runRetentionDays * DAY);
    }
    for (const e of await children(path.join(root, 'logs'))) {
      if (e.isFile()) await take(path.join(root, 'logs', e.name), root, 'nightly-log', `a nightly log untouched for ${s.runRetentionDays} days`, s.runRetentionDays * DAY);
    }
  }
  for (const p of items.keys()) listed.delete(p);
  return { items: [...items.values()], listed: [...listed].map(([p, why]) => ({ path: p, why })) };
}

/**
 * One clean-up pass with the stale-output rules (the host guard's and every daemon's): the regular plan, plus the
 * stale plan when it is their turn. A dry run measures both and removes nothing; stale output in dry-run mode is
 * measured and reported while the regular rules still remove. What could not be attributed is listed with its size.
 */
/**
 * The regular rules and the own-leftover plan pick from the same folders (agent-temp and stopped-session-temp both take
 * `tmp/ffa-*`). Run apart, the second found what the first had removed and logged every entry `in use (ENOENT)` (w5284,
 * biscuit 2026-11-23 15:12Z: 130 of them). Own leftovers judge a session's folder more closely (unpushed work at any depth,
 * live sessions), so where they split a folder or kept something inside it, the regular item for that folder is dropped;
 * an own item at or inside a regular item that stays is dropped instead.
 */
export function withoutOverlap<A extends { path: string }, B extends { path: string }>(first: A[], own: { items: B[]; listed: { path: string }[] }): { first: A[]; own: B[] } {
  const inner = [...own.items, ...own.listed].map((i) => i.path);
  const kept = first.filter((r) => !inner.some((p) => norm(p) !== norm(r.path) && within(p, r.path)));
  return { first: kept, own: own.items.filter((i) => !kept.some((r) => within(i.path, r.path))) };
}

/**
 * w6044 stage 3: the released ffu slots' first step alone, at low, while a pass that is not low runs (CleanupRunner firstAlone;
 * the daemon's ffuFirstAlone). Mode off: nothing, so recovery needs nobody at the machine. Stage 3a is report-only: it plans
 * and says what it would take, and removes nothing, whatever the mode.
 */
export async function firstAlonePass(o: {
  mode: StaleOutputSettings['mode'];
  root?: string[];
  guard: CleanupGuard;
  first: NonNullable<Parameters<typeof cleanupPass>[0]['first']>;
  busyNow?: (it: CleanupItem) => Promise<string | undefined>;
}): Promise<CleanupRun | undefined> {
  if (o.mode === 'off' || !o.root?.[0]) return undefined;
  return cleanupPass({
    opts: { stale: false, dryRun: false },
    guard: o.guard,
    mode: 'dry-run',
    regular: async () => [],
    stale: async () => ({ items: [], listed: [] }),
    first: o.first,
    busyNow: o.busyNow,
    root: o.root,
  });
}

export async function cleanupPass(o: {
  opts: PassOptions;
  guard: CleanupGuard;
  mode: StaleOutputSettings['mode'];
  regular: () => Promise<CleanupItem[]>;
  stale: () => Promise<StalePlan>;
  /**
   * The one stale rule that runs on every pass: the cargo target cap (w3471; w3426 meant it for any pass, but it rode the daily stale
   * plan, so an idle target over the cap stayed up to a day). Run when the stale plan is not due and the mode is on.
   */
  cap?: () => Promise<StalePlan>;
  /**
   * The released ffu slots' cargo targets, planned first, before every slower step (w6044: on BEAST, 2026-11-26, three released
   * targets held 190.6 GB while the passes were cut off in their regular step, before the ffu rule ran in the stale or cap
   * step). With the mode on, the plan is removed at once, before own and regular are planned (busyNow re-checks each item
   * right before its rename); in dry-run mode it is only said. report gets the fenced plan, the time to plan it, and the
   * removal (absent when nothing was removed); a report that throws costs the pass nothing.
   */
  first?: { plan(): Promise<StalePlan>; report?(items: CleanupItem[], ms: number, run?: CleanupRun): void };
  /** FF Factory's own leftovers (server/ownLeftovers.ts, w626): the caller passes them only while free space is low. */
  own?: { plan(): Promise<OwnLeftoverPlan>; run(plan: OwnLeftoverPlan): Promise<CleanupRun> };
  /** Ends the plan's strays, before its items go (a deleted file's space comes back only when its writer ends); not in a dry run. */
  /** Asked right before an item's removal: a reason to keep it now, or undefined (w5502: a runner's job started since the plan). */
  busyNow?: (it: CleanupItem) => Promise<string | undefined>;
  endStrays?: (strays: NonNullable<StalePlan['strays']>) => Promise<void>;
  /**
   * The machine's worker install folder (root.json's root; w896, lothsahn: "in general we should only be clearing data in the
   * install folder for the worker"). Given, a pass removes only what is strictly inside it: whatever a rule picks outside
   * (system temp, caches, crash dumps, Unity Hub's editors, the game's data folder) is measured and listed with the reason,
   * not removed. Absent (a machine without a root, the portal's own host): no fence. A list: the root and the folders that are
   * part of the install though they lie elsewhere (daemon.json `extraRoots`: a Dev Drive's sandboxes and seed, w900).
   */
  root?: string | string[];
}): Promise<CleanupRun> {
  const outside: { path: string; why: string }[] = [];
  const fence = <T extends { path: string }>(items: T[]): T[] => {
    if (!o.root) return items;
    const f = fenceToRoot(items, o.root);
    outside.push(...f.outside);
    return f.inside;
  };
  // w5795: each step timed, for the summary (LothDesktop's low passes took over an hour to plan, longer than its daemon ran).
  const phasesMs: Record<string, number> = {};
  // What this pass has removed so far: each step's plan goes as soon as the step is planned (w5795), so the marker says it too.
  const r: CleanupRun = { removed: [], failed: [], bytes: 0 };
  const add = (x: CleanupRun) => {
    r.removed.push(...x.removed);
    r.failed.push(...x.failed);
    r.bytes += x.bytes;
  };
  const timed = async <T>(name: string, f: () => Promise<T>): Promise<T> => {
    const t = Date.now();
    o.opts.step?.(name, { ...phasesMs }, { removed: r.removed.length, bytes: r.bytes });
    try {
      return await f();
    } finally {
      phasesMs[name] = Date.now() - t;
    }
  };
  const none: OwnLeftoverPlan = { items: [], listed: [] };
  // What a step's removal has tried so far: own's removal keeps clear of it (withoutOverlap).
  const attempted: CleanupItem[] = [];
  // The first step's items: removed before own was planned, so an own item inside one is dropped outright (withoutOverlap
  // would keep own's and drop the first item, which is gone already).
  const firstTaken: CleanupItem[] = [];
  // w6044: the released ffu slots' targets first, removed at once with the mode on, before any slower step can cut the pass off.
  const first = o.first;
  if (first && o.mode !== 'off' && !o.opts.dryRun) {
    const t0 = Date.now();
    const fp = await timed('ffu first', () => first.plan().catch(() => ({ items: [], listed: [] }) as StalePlan));
    const items = o.root ? fenceToRoot(fp.items, o.root).inside : fp.items;
    const ms = Date.now() - t0;
    let run: CleanupRun | undefined;
    if (o.mode === 'on' && items.length) {
      attempted.push(...items);
      firstTaken.push(...items);
      run = await timed('ffu firstRemove', () => runCleanup(items, o.guard, o.busyNow).catch((e) => ({ removed: [], failed: items.map((i) => ({ path: i.path, why: (e as Error).message })), bytes: 0 }) as CleanupRun));
      add(run);
    }
    try {
      first.report?.(items, ms, run);
    } catch {
      // the log line only
    }
  }
  // A failure there must not cost the regular pass: nothing of it is removed then.
  const ownPlan = o.own;
  // Planned first (w5795): the removals of each step below keep clear of what it keeps or removes itself (withoutOverlap).
  const own0 = ownPlan ? await timed('own', () => ownPlan.plan().catch(() => none)) : none;
  const own = { ...own0, items: fence(own0.items) };
  const dry = !!o.opts.dryRun;
  // Each step's plan removed at once, not after every step is planned (w5795): LothDesktop's low passes planned for about
  // 55 min, its daemon restarted about hourly, and four passes in a row were cut off having removed nothing.
  const removeNow = async (name: string, items: CleanupItem[]) => {
    if (dry || !items.length) return;
    const { first } = withoutOverlap(items, own);
    attempted.push(...first);
    if (first.length) add(await timed(name, () => runCleanup(first, o.guard, o.busyNow)));
  };
  const regular = fence(await timed('regular', o.regular));
  await removeNow('remove', regular);
  const planned: StalePlan = o.opts.stale && o.mode !== 'off' ? await timed('stale', o.stale) : o.mode === 'on' && o.cap ? await timed('cap', o.cap) : { items: [], listed: [] };
  const plan = { ...planned, items: fence(planned.items) };
  if (!dry && o.mode === 'on') {
    // Ends the plan's strays, before its items go (a deleted file's space comes back only when its writer ends).
    if (plan.strays?.length && o.endStrays) await o.endStrays(plan.strays).catch(() => undefined);
    await removeNow('removeStale', plan.items);
  }
  const listed: NonNullable<CleanupRun['listed']> = [];
  // On Windows nothing off the install drive is measured or listed (w1755, lothsahn: "You need to only look at v:.  Stop
  // messing with my c:"): a listed C: folder was a clean-up worker's cue to measure it.
  const roots = o.root ? (Array.isArray(o.root) ? o.root : [o.root]) : [];
  const onDrive = (p: string) => !roots.length || roots.some((r) => onInstallDrive(p, r));
  await timed('listed', async () => {
    for (const l of [...plan.listed, ...own.listed, ...outside]) if (onDrive(l.path)) listed.push({ ...l, bytes: await sizeOf(l.path, 300_000) });
  });
  listed.sort((a, b) => b.bytes - a.bytes);
  const held = (plan.held ?? []).filter((h) => onDrive(h.path)).sort((a, b) => b.bytes - a.bytes);
  const kept = { ...(held.length ? { held } : {}), phasesMs };
  if (dry) return { removed: [], failed: [], bytes: 0, planned: await timed('size', () => sizePlan([...regular, ...plan.items, ...own.items])), listed, ...kept };
  own.items = withoutOverlap(attempted, own).own.filter((i) => !firstTaken.some((t) => within(i.path, t.path)));
  if (ownPlan && own.items.length) add(await timed('ownRemove', () => ownPlan.run(own).catch((e) => ({ removed: [], failed: [{ path: '(own leftovers)', why: (e as Error).message }], bytes: 0 }) as CleanupRun)));
  return { ...r, ...(o.mode === 'dry-run' && plan.items.length ? { planned: await sizePlan(plan.items) } : {}), listed, ...kept };
}

const norm = (p: string) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
