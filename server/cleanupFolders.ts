import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { freeableBytes, localWorkWhy, norm, unpushedWorkWhy, OUTSIDE_ROOT_WHY, within } from './cleanup.ts';
import { requestIdsIn, CONTEXT_MAX_AGE_HOURS } from './staleOutput.ts';
import type { SessionOwner } from './resumable.ts';
import { finishedBulkIn, INSTALL_LEFTOVER_DEFAULTS, isCargoTarget, newestTopWrite, newestWrite, runnerJobWhy, RUNNER_KEPT, type ProcLite } from './installLeftovers.ts';
import { idleJitEntries, LIBRARY_CACHES, projectOpen, staleCacheEntries, type StaleEntry } from './cacheTrim.ts';
import { PLAYER_CACHE_ENTRY } from '../machine/playerCache.ts';
import { FFU_SLOTS_DIR, readSlotState } from '../machine/ffuSlots.ts';
import type { PublishedRecord } from './published.ts';
import { leaseLive, mentions, OWN_LEFTOVER_DEFAULTS, type SlotLease } from './ownLeftovers.ts';

/**
 * The folders a clean-up worker may delete, judged against the ledger (w1379). On 2026-10-15 w1374, LothDesktop's low-disk
 * clean-up, deleted the temp folder of stopped worker a735f37c: builds and preview clips of w1332 (the comet catch tail),
 * which was stalled on a usage limit and then waiting for Ben's OK of the look. The daemon's own sweeps had kept it (they
 * leave a session a request still waits for, server/resumable.ts, w1097; the portal's clean-up log for that day holds
 * no entry for it). The clean-up worker deleted it by hand: its brief carried a list of live workers and of "stopped but will
 * resume" ones that somebody had written out, and a735f37c was not on it.
 *
 * So the list comes from the ledger, not from a brief. The daemon writes the facts (`CleanupFacts`: its live sessions, and
 * the portal's sessions with a request not closed, from `welcome`/`resumable`) to a file; `ff-leftovers folders` lists every
 * folder a clean-up could take, each with its owner and a verdict, and `ff-leftovers check <path>` judges one path. A
 * folder is deletable only when it belongs to a request that is closed (done, merged, rejected, cancelled) or to no worker
 * at all (an orphan). Whatever is not provably so is kept, and the answer says why: a stale or missing fact keeps everything.
 *
 * And the ledger is not the only owner (w1387). The same day w1385, LothDesktop's next low-disk clean-up, deleted
 * V:fw	mpfa-31ffe8cc (564 MB) on a DELETE row: no open request named worker 31ffe8cc (w1367, the nightly merge review,
 * was done). The portal's own clean-up had kept that folder three times that evening, "holds a git repo with uncommitted or
 * unpushed work (...fa-31ffe8ccf)", and the clone could not be recovered. So a folder the ledger frees is checked as
 * the portal's sweeps check it (cleanup.ts localWorkWhy): a git repo in it, under it or around it with uncommitted
 * changes, commits on no remote or a stash keeps it, with the repo and what it holds.
 */
export interface CleanupFacts {
  /** When the daemon wrote the file (ISO). */
  at: string;
  /** The daemon's link to the portal is up and its welcome came: the sessions' requests are as the portal last said. */
  connected: boolean;
  /** The machine's worker install folder: nothing outside it is ever a candidate (w896). */
  root?: string;
  /** The workers' temp root, <root>/tmp. */
  tempRoot?: string;
  sandboxes: { id: string; path: string }[];
  /** Sessions whose process runs here now. */
  live: string[];
  /** Sessions a request still waits for (server/resumable.ts resumableSessions). */
  resumable: string[];
  /** Every session of the machine with a request not closed, and the requests it is on (server/resumable.ts ownersOf); absent: the portal never said, and nothing is deletable. */
  owners?: Record<string, SessionOwner>;
  /** Request ids open and closed in the ledger, as the portal last said (server/staleOutput.ts StaleContext). */
  open: string[];
  closed: string[];
  /** When the portal said it (ISO). */
  contextAt?: string;
  /** The timed runs this machine plays now or has queued (machine/timedRunner.ts active()); absent: an older daemon, or none play here (w3217). */
  timedRuns?: string[];
  /** The pool's Library seed (a Library folder itself, machine/sandboxes.ts librarySource): its stale cache entries are candidates (w5280). */
  librarySeed?: string;
  /** Free space was below the soft threshold at the daemon's last clean-up pass: a finished worker's bulk goes after minutes, not a day (w2223). */
  low?: boolean;
}

export interface FolderRow {
  path: string;
  kind: 'session-temp' | 'session-bulk' | 'scratch' | 'sandbox-output' | 'player-slot' | 'ffu-slot-target' | 'ffu-runner-work' | 'player-cache' | 'sandbox-library' | 'seed-library' | 'named' | 'other';
  verdict: 'keep' | 'delete';
  why: string;
  /** What deleting it alone frees (w5168): files hard-linked to a place it does not hold (a build still kept) do not count. */
  bytes?: number;
  /** Bytes in it that are hard links to files kept elsewhere: a delete frees none of them (w5168). */
  linked?: number;
}

/** planFolders' rows, with what deleting every DELETE row together frees (w5168) and the empty player slots it left out. */
export type FolderPlan = FolderRow[] & { freed?: number; linked?: number; emptySlots?: number };

/** The daemon writes the facts every 30 s; older than this and it is not running or not writing. */
export const FACTS_MAX_AGE_MS = 5 * 60_000;

/** Why nothing may be deleted on these facts, or undefined when they can be trusted. */
export function factsProblem(f: CleanupFacts | undefined, now = Date.now()): string | undefined {
  if (!f) return 'no ledger facts on this machine (the FF Factory daemon has not written them: it is old or not running)';
  const age = now - Date.parse(f.at);
  if (!Number.isFinite(age) || age > FACTS_MAX_AGE_MS) return `the daemon's ledger facts are ${Number.isFinite(age) ? `${Math.round(age / 60_000)} min` : 'of unknown age'} old (it writes them every 30 s)`;
  if (!f.connected) return "the daemon is not connected to the portal, so the ledger's facts may have changed";
  if (!f.owners) return 'the portal has not said which sessions its requests are on (it predates w1379, or its welcome has not come)';
  if (!f.root) return 'this machine has no worker install folder, so nothing is a candidate here (w896)';
  return undefined;
}

const sessionOfDir = (name: string) => /^ffa-([\w-]+)$/i.exec(name)?.[1];

/** One session's folder: kept while its worker runs or a request that is not closed names it. */
export function judgeSession(sid: string, f: CleanupFacts): Pick<FolderRow, 'verdict' | 'why'> {
  if (f.live.includes(sid)) return { verdict: 'keep', why: `worker ${sid} is running now` };
  const own = f.owners?.[sid];
  if (own) {
    const open = own.requests.filter((r) => !['merged', 'done', 'rejected', 'cancelled'].includes(r.status));
    const withIt = open.filter((r) => r.with);
    const list = (rs: typeof open) => rs.map((r) => `${r.id} (${r.status})`).join(', ');
    if (withIt.length) return { verdict: 'keep', why: `stopped worker ${sid} is still on ${list(withIt)}, which has not closed: it resumes there and needs its files` };
    return { verdict: 'keep', why: `worker ${sid} was on ${list(open)}, which has not closed (it moved on to another worker, and may be resumed on it: the folder stays until it closes, w4671)` };
  }
  if (f.resumable.includes(sid)) return { verdict: 'keep', why: `a request still waits for worker ${sid}, or a check-in of its own is pending: the folder stays, its rebuildable bulk is listed below it once idle (w2223)` };
  return { verdict: 'delete', why: `no open, stalled or paused request names worker ${sid}: its requests are closed, or it belongs to no request (an orphan); only a clone with commits on no remote or a stash keeps it (w3656)` };
}

/** A folder named for requests ("w1332-comet-catch-tail", "results-w166"): by those requests' state. */
export function judgeNamed(name: string, f: CleanupFacts, now = Date.now()): Pick<FolderRow, 'verdict' | 'why'> {
  const ids = requestIdsIn(name);
  if (!ids.length) return { verdict: 'keep', why: 'names no request, so it cannot be attributed: listed for a person, never deleted' };
  const open = new Set(f.open);
  const closed = new Set(f.closed);
  const fresh = f.contextAt && now - Date.parse(f.contextAt) < CONTEXT_MAX_AGE_HOURS * 3_600_000;
  if (!fresh) return { verdict: 'keep', why: `the ledger's request states are older than ${CONTEXT_MAX_AGE_HOURS} h or missing` };
  const live = ids.filter((id) => open.has(id));
  if (live.length) return { verdict: 'keep', why: `${live.join(', ')} has not closed (open, stalled or paused)` };
  const unknown = ids.filter((id) => !closed.has(id));
  if (unknown.length) return { verdict: 'keep', why: `${unknown.join(', ')} is in neither list of the ledger: not provably closed` };
  return { verdict: 'delete', why: `${ids.join(', ')} closed` };
}

/**
 * <root>/timing (w3217): the timed runs' build cache, builds and last runs (machine/timedRunner.ts; it keeps 10 runs
 * itself). The daemon's clean-up trims its cache and builds while no timed run needs them (installLeftovers.ts, w3502); a clean-up asked whether a queued run needs it: the row says.
 */
export function judgeTiming(f: CleanupFacts): string {
  const base = "the timed runs' build cache, builds and last runs (machine/timedRunner.ts keeps 10 runs itself)";
  if (!f.timedRuns) return `${base}; the daemon did not say which timed runs play or wait here (an older daemon, or none play on this machine)`;
  if (f.timedRuns.length) return `${base}; timed run(s) ${f.timedRuns.join(', ')} play or wait here now and use it`;
  return `${base}; no timed run plays or waits here now: its cache/ and builds/ are rebuilt by the next run, and the daemon's clean-up trims them itself while none plays or waits (w3502: builds after a day, the cache below the soft threshold)`;
}

/** A sandbox's build and capture output belongs to the workers in it. */
export function judgeSandbox(id: string, f: CleanupFacts): Pick<FolderRow, 'verdict' | 'why'> {
  const here = Object.entries(f.owners ?? {}).filter(([, o]) => o.sandbox === id);
  const live = here.filter(([sid]) => f.live.includes(sid)).map(([sid]) => sid);
  if (live.length) return { verdict: 'keep', why: `worker ${live.join(', ')} works in ${id} now` };
  const waiting = here.filter(([sid]) => f.resumable.includes(sid) || judgeSession(sid, f).verdict === 'keep');
  if (waiting.length) return { verdict: 'keep', why: `worker ${waiting.map(([sid]) => sid).join(', ')} in ${id} is on a request that has not closed (${waiting.flatMap(([, o]) => o.requests.filter((r) => !['merged', 'done', 'rejected', 'cancelled'].includes(r.status)).map((r) => r.id)).join(', ')})` };
  return { verdict: 'delete', why: `no worker in ${id} is running or on an open, stalled or paused request` };
}

/** What a player slot's verdict needs beyond the facts (w2796): who this machine is, which pids live, what runs now. */
export interface SlotContext {
  /** This machine's host name, as player_slots.py writes it in a lease (socket.gethostname().lower()). */
  host: string;
  alive: (pid: number) => boolean;
  /** The command lines of the processes running now; undefined when they could not be read (then nothing is deleted). */
  procs?: string[];
  /** The session the asking worker is (FF_SESSION_ID): its own temp folder is never a candidate (w3217). */
  self?: string;
  /** Sessions whose agent host process runs here now (machine/agentHost.ts, its command line names hosts/<session>), seen apart from the daemon's facts (w3217). */
  hosts?: string[];
  /** The same processes with their pids (w5235): an FFU runner's Runner.Worker and listener are found by pid and parent. */
  procList?: ProcLite[];
  /** A runner's newest listener _diag log tail (machine/benchRunners.ts readListenerLog); tests give their own. */
  runnerLog?: (runner: string) => string | undefined;
}

/**
 * What says a session runs that the daemon's facts may miss (w3217). On 2026-11-06 w3213, LothDesktop's clean-up, ran
 * `ff-leftovers folders` 44 s after its own session started and deleted its own temp folder ffa-9aad7b21 on a DELETE row,
 * "no open, stalled or paused request names worker 9aad7b21": the facts it read (accepted up to FACTS_MAX_AGE_MS old, and
 * the daemon was about to restart for an update) predated the session. So a session folder created or written after the
 * facts, the asking worker's own folder, and one whose agent host process runs are kept whatever the facts say.
 */
export function sessionSeen(sid: string, dir: string | undefined, f: CleanupFacts, ctx?: Pick<SlotContext, 'self' | 'hosts'>): string | undefined {
  if (ctx?.self && ctx.self.toLowerCase() === sid.toLowerCase()) return `it is your own temp folder (worker ${sid}, FF_SESSION_ID)`;
  if (ctx?.hosts?.some((h) => h.toLowerCase() === sid.toLowerCase())) return `worker ${sid}'s agent host process runs now`;
  if (!dir) return undefined;
  let st: fs.Stats;
  try {
    st = fs.statSync(dir);
  } catch {
    return undefined;
  }
  const at = Date.parse(f.at);
  const seen = Math.max(st.birthtimeMs || 0, st.mtimeMs);
  if (Number.isFinite(at) && seen > at - FACTS_SLACK_MS) return `it was created or written at ${new Date(seen).toISOString()}, after the ledger facts (${f.at}) were written: they cannot speak for worker ${sid} yet`;
  return undefined;
}

/** How long before the facts a folder may be made and still count as unknown to them: none (the daemon lists a session as it makes its folder). */
const FACTS_SLACK_MS = 0;

const readJson = (p: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return undefined;
  }
};

/**
 * A player slot (<root>/players/slotK, scripts/nightly/player_slots.py) by its own lease files (w2796), as the pool judges
 * them (Pool._live: a local lease while its pid lives, a remote one by its age, none past FF_PLAYER_SLOT_MAX_AGE_H): leased
 * is KEEP; unleased is DELETE, the next launch fills it again from the build. Also kept: a fill in progress (slot.json
 * "filling": the pool copies the build before it writes the lease) and a slot a running process names (a game player
 * nobody leased, a person's game, w1894). Before w2796 `check` called every slot "not a place with an owner in the
 * ledger", and w2795's worker had to read the leases by hand to find nine free slots (about 17 GB).
 */
export function judgePlayerSlot(slot: string, ctx: SlotContext | undefined, now = Date.now()): Pick<FolderRow, 'verdict' | 'why'> {
  if (!ctx) return { verdict: 'keep', why: 'a player slot: its leases were not read here' };
  const leasesDir = path.join(slot, 'leases');
  let names: string[] = [];
  try {
    names = fs.readdirSync(leasesDir).filter((n) => n.endsWith('.json'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return { verdict: 'keep', why: `a player slot whose leases cannot be read (${(e as Error).message})` };
  }
  const leases = names.map((n) => readJson(path.join(leasesDir, n))).filter((l): l is SlotLease => !!l && typeof l === 'object');
  const maxAgeHours = OWN_LEFTOVER_DEFAULTS.leaseMaxAgeHours;
  const live = leases.filter((l) => leaseLive(l, { host: ctx.host, now, maxAgeHours, alive: ctx.alive }));
  if (live.length) {
    const who = live.map((l) => [l.session ? `worker ${l.session}` : '', l.host ? `on ${l.host}` : '', l.pid ? `pid ${l.pid}` : ''].filter(Boolean).join(' ')).join('; ');
    return { verdict: 'keep', why: `a player slot leased now (${who}): a run plays from it` };
  }
  const marker = readJson(path.join(slot, 'slot.json')) as { state?: string; filled?: number } | undefined;
  if (marker?.state === 'filling' && now - Number(marker.filled) * 1000 < maxAgeHours * 3_600_000) return { verdict: 'keep', why: 'a launch is filling this player slot now (slot.json "filling"; its lease comes after the copy)' };
  if (slotEmpty(slot)) return { verdict: 'keep', why: EMPTY_SLOT_WHY };
  if (!ctx.procs) return { verdict: 'keep', why: 'a player slot with no live lease, but the running processes could not be read to see that nothing plays from it' };
  if (ctx.procs.some((c) => mentions(c, slot))) return { verdict: 'keep', why: "a player slot no lease holds, but a running process plays from it (a person's game, or a run whose lease went stale)" };
  const stale = leases.length ? ` (${leases.length} lease file(s), none live)` : '';
  return { verdict: 'delete', why: `a player slot no live lease holds${stale}: \`ff-leftovers remove <slot>\` empties it and keeps the folder and its firewall rule; the next launch fills it again from the build. Its size counts only what that frees: files hard-linked to a build still kept free nothing (w5168)` };
}

export const EMPTY_SLOT_WHY = 'an empty player slot (nothing but its leases/ folder, as `ff-leftovers remove` leaves it): nothing to free; the folder stays for its path and firewall rule, and `folders` does not list it (w5168)';

/**
 * A slot emptied by `remove`/`remove-slot` or player_slots.py prune: only leases/ (no live lease, judged before), a stale
 * slot.json or an empty player/ left (w5168). In w5165 the 12 slots a clean-up had emptied stayed DELETE rows at 0 MB.
 */
export function slotEmpty(slot: string): boolean {
  let names: string[];
  try {
    names = fs.readdirSync(slot);
  } catch {
    return false;
  }
  return names.every((n) => {
    if (n === 'leases' || n === 'slot.json') return true;
    if (n !== 'player') return false;
    try {
      return fs.readdirSync(path.join(slot, n)).length === 0;
    } catch {
      return false;
    }
  });
}

const isSlotDir = (name: string) => /^slot[\w-]*$/i.test(name);

const agoMin = (ms: number) => `${Math.max(0, Math.round(ms / 60_000))} min`;

/**
 * An ffu slot's build output (<root>/ffu-sandboxes/slot<N>/target, machine/ffuSlots.ts), judged as the daemon's clean-up
 * judges the whole target (installLeftovers.ts, rule ffu-slot-target; docs/ffu-sandboxes.md), or undefined for a path
 * outside the ffu slots. Before w4422 `check` called a released slot's target and its debug/incremental "not a place with
 * an owner in the ledger" (biscuit, w4283), and a 25 GB target inside slot1's checkout (ffu/target, where builds landed
 * before the w4258 .cargo/config.toml routing) was something the daemon's sweep never looks at. Kept: a slot a running or
 * resumable worker holds (slots.json, what `ffu-slot list` reads), one a running process names (cargo, rustc, a test binary
 * from it, a shell in its checkout), one written within the settle time, and anything that is not cargo's own output
 * (CACHEDIR.TAG). In the checkout only ffu/target is ever a candidate; the rest may hold a worker's work.
 */
export async function judgeFfuSlotPath(p: string, f: CleanupFacts, now: number, ctx?: SlotContext): Promise<FolderRow | undefined> {
  if (factsProblem(f, now) || !f.root) return undefined;
  const base = path.join(f.root, FFU_SLOTS_DIR);
  if (!within(p, base)) return undefined;
  const row = (verdict: FolderRow['verdict'], why: string): FolderRow => ({ path: p, kind: 'ffu-slot-target', verdict, why });
  const rel = norm(p) === norm(base) ? [] : norm(p).slice(norm(base).length + 1).split('/');
  if (!rel.length || !/^slot\d+$/.test(rel[0]!)) return row('keep', 'the ffu slots\' folder or its shared clone: only a slot\'s target/ (and a stray ffu/target/ cargo made) is a candidate');
  const id = rel[0]!;
  const slot = path.join(base, id);
  const stray = rel[1] === 'ffu' && rel[2] === 'target';
  if (rel[1] !== 'target' && !stray) return row('keep', `ffu ${id}'s checkout or own files: never deleted (it may hold a worker's work); only its target/ and a stray ffu/target/ cargo made are candidates`);
  const target = stray ? path.join(slot, 'ffu', 'target') : path.join(slot, 'target');
  const what = stray ? `the cargo target left inside ffu ${id}'s checkout (ffu/target, where builds landed before the w4258 .cargo/config.toml routing)` : `ffu ${id}'s cargo target`;
  if (!isCargoTarget(target)) return row('keep', `${what} has no CACHEDIR.TAG written by cargo: not provably build output`);
  const holder = readSlotState(f.root).slots.find((x) => x.id === id)?.holder;
  const is = (list: string[]) => !!holder && list.some((s) => s.toLowerCase() === holder.toLowerCase());
  const up = is([...f.live, ...f.resumable, ...Object.keys(f.owners ?? {}), ...(ctx?.hosts ?? []), ...(ctx?.self ? [ctx.self] : [])]);
  // w5240: a holder that is stopped but has a request not closed keeps its warm target, but not the debug/incremental cache of it:
  // the daemon's sweep trims that over the slot cap (installLeftovers.ts; a rebuild is 22 s longer, w3426), and without this row
  // biscuit's finished workers' targets (slot1 5.9 GB of 18.5 GB) stayed KEEP between jobs and filled the disk.
  const rebuildable = rel[1] === 'target' && rel[2] === 'debug' && rel[3] === 'incremental';
  if (up && rebuildable && !is([...f.live, ...(ctx?.hosts ?? []), ...(ctx?.self ? [ctx.self] : [])])) {
    if (!ctx?.procs) return row('keep', `${what}: the running processes could not be read to see that nothing builds in or runs from the slot`);
    const user = ctx.procs.find((c) => mentions(c, slot));
    if (user) return row('keep', `${what}: a running process names the slot (${user.slice(0, 160)})`);
    const settleMs = INSTALL_LEFTOVER_DEFAULTS.lowCacheSettleMinutes * 60_000;
    const last = await newestTopWrite(path.join(target, 'debug', 'incremental'));
    if (last > now - settleMs) return row('keep', `${what}: its incremental cache was written ${agoMin(now - last)} ago, within the settle time (a build may be running)`);
    return row('delete', `the debug/incremental cache of ${what}: worker ${holder} is stopped (a request of it is not closed), no running process names the slot, nothing written for ${agoMin(settleMs)}; its warm units stay and the next edit rebuilds this cache (rebuildable, w5240)`);
  }
  if (up) return row('keep', `${what}: the slot is held by worker ${holder}, which runs or has a request not closed (ffu-slot list); its warm target saves the next build minutes`);
  if (!ctx?.procs) return row('keep', `${what}: the running processes could not be read to see that nothing builds in or runs from the slot`);
  const user = ctx.procs.find((c) => mentions(c, slot));
  if (user) return row('keep', `${what}: a running process names the slot (${user.slice(0, 160)})`);
  const settle = INSTALL_LEFTOVER_DEFAULTS.lowCacheSettleMinutes;
  const newest = await newestTopWrite(target);
  if (newest > now - settle * 60_000) return row('keep', `${what}: written ${agoMin(now - newest)} ago, within the ${settle} min settle time (a build may be running)`);
  const held = holder ? `held by worker ${holder}, which neither runs nor has a request not closed` : 'released (ffu-slot list)';
  const inside = norm(p) === norm(target) ? '' : `inside ${what}: `;
  return row('delete', `${inside}${what}, a slot ${held}, no running process names the slot and nothing in it was written for ${settle} min; the next build in the slot rebuilds it (rule ffu-slot-target)`);
}

/**
 * A stale entry of an idle sandbox's Unity Library caches (<sandbox>/Library/BurstCache, BuildCache), judged as the daemon's
 * trim judges it (cacheTrim.ts staleCacheEntries: superseded Burst player builds and old BuildCache folders; the newest builds,
 * JIT, Artifacts, Bee and the rest stay), or undefined for a path outside them (w5240: biscuit's slot1 and slot2 held 24 and
 * 25 GB of BurstCache that no clean-up row reached). Kept: a sandbox a worker is in or waits on, one with an editor or a
 * batchmode build open (Temp/UnityLockfile), one a running process names, and everything the trim keeps. Never the cache whole:
 * a cold Unity start is slow (lothsahn, 2026-11-01).
 */
export async function judgeSandboxLibraryPath(p: string, f: CleanupFacts, ctx?: SlotContext, now = Date.now()): Promise<FolderRow | undefined> {
  if (!f.root) return undefined;
  for (const sb of f.sandboxes) {
    if (!within(p, sb.path)) continue;
    const rel = norm(p).slice(norm(sb.path).length + 1).split('/');
    if (rel[0] !== 'library' || !LIBRARY_CACHES.some((c) => c.toLowerCase() === rel[1])) return undefined;
    const row = (verdict: FolderRow['verdict'], why: string): FolderRow => ({ path: p, kind: 'sandbox-library', verdict, why });
    const owner = judgeSandbox(sb.id, f);
    if (owner.verdict === 'keep') return row('keep', owner.why);
    if (projectOpen(sb.path)) return row('keep', `an editor or a batchmode build has ${sb.id}'s project open (Temp/UnityLockfile)`);
    if (!ctx?.procs) return row('keep', 'the running processes could not be read to see that nothing builds in the sandbox');
    const user = ctx.procs.find((c) => mentions(c, sb.path));
    if (user) return row('keep', `a running process names ${sb.id} (${user.slice(0, 160)})`);
    if (rel.length < 3) return row('keep', `${sb.id}'s Library/${rel[1]} as a whole: a cold Unity start is slow, only its stale entries are candidates`);
    const { hit, inside } = staleHit(p, await memoStale('sandbox', sb.path, now, () => sandboxLibraryStale(sb.path)));
    if (inside) return row('keep', insideEntryWhy(inside));
    if (!hit) return row('keep', `not stale: the newest Burst player builds, JIT bundles loaded within ${JIT_IDLE_DAYS_TEXT}, the manifests and the newest BuildCache folders stay (cacheTrim.ts)`);
    return row('delete', `a stale entry of ${sb.id}'s Library/${rel[1]}: ${hit.why}; no worker is in the sandbox, no editor or build has it open (rebuildable, w5240)`);
  }
  return undefined;
}

const JIT_IDLE_DAYS_TEXT = '14 days';

/** An idle sandbox's stale Library cache entries: the daemon trim's (staleCacheEntries) and JIT bundles idle 14 days (w5280). */
async function sandboxLibraryStale(project: string): Promise<StaleEntry[]> {
  return [...(await staleCacheEntries(project)).stale, ...(await idleJitEntries(project))];
}

/**
 * One scan of a project's Library caches per clock reading (w5309). planFolders judges every candidate row with its own `now`,
 * and each row of a Library judged its cache again: on m5 the 90 GB seed was walked once per row, `folders` ran for minutes,
 * and its later rows (all 451 BuildCache folders, listed after the Burst builds) outlived the facts. A `check` or `remove`
 * reads the clock afresh, so it scans afresh.
 */
const staleMemo = new Map<string, Promise<StaleEntry[]>>();
function memoStale(kind: string, project: string, now: number, scan: () => Promise<StaleEntry[]>): Promise<StaleEntry[]> {
  const key = `${kind}|${norm(project)}|${now}`;
  let hit = staleMemo.get(key);
  if (!hit) {
    if (staleMemo.size > 64) staleMemo.clear();
    hit = scan();
    staleMemo.set(key, hit);
    hit.catch(() => staleMemo.delete(key));
  }
  return hit;
}

const isBuildCacheEntry = (p: string) => norm(p).includes('/library/buildcache/');

/**
 * The stale entry `p` is (hit), or the BuildCache entry it lies inside (inside). A BuildCache entry goes whole or not at all
 * (w5309): its .info names its files, and one file of it gone fails the next build in ArchiveAndCompressBundles ("Could not
 * find file '...\Library\BuildCache\...'", w1211). A file inside a stale Burst entry (a JIT bundle's dSYM) goes with it.
 */
function staleHit(p: string, stale: StaleEntry[]): { hit?: StaleEntry; inside?: StaleEntry } {
  const exact = stale.find((e) => norm(p) === norm(e.path));
  if (exact) return { hit: exact };
  const outer = stale.find((e) => within(p, e.path));
  if (!outer) return {};
  return isBuildCacheEntry(outer.path) ? { inside: outer } : { hit: outer };
}

const seedStale = (seed: string) => async () => (await staleCacheEntries(path.dirname(seed))).stale;

const insideEntryWhy = (e: StaleEntry) => `part of a stale BuildCache entry (${e.path}): only the whole entry goes, since a build fails on an entry missing one of its files (w1211, w5309)`;

/** The pool's Library seed when ff-leftovers may judge it (w5280): inside the install folder, not a sandbox's, not a project's own Library. */
export function seedLibrary(f: CleanupFacts): string | undefined {
  // The pool's setting, else the install's own seed/Library (w5280: m5's pool names no seed since the portal record lost it,
  // yet <root>/seed/Library held 90 GB nobody seeds from; the same stale-entry rule is only safer on a copy nothing reads).
  const fallback = f.root ? path.join(f.root, 'seed', 'Library') : undefined;
  const seed = f.librarySeed || (fallback && fs.existsSync(fallback) ? fallback : undefined);
  if (!seed || !f.root || !within(seed, f.root) || path.basename(seed).toLowerCase() !== 'library') return undefined;
  if (f.sandboxes.some((sb) => within(seed, sb.path) || norm(seed) === norm(sb.path))) return undefined;
  const project = path.dirname(seed);
  if (['.git', 'Assets', 'ProjectSettings'].some((n) => fs.existsSync(path.join(project, n)))) return undefined;
  return seed;
}

/**
 * A stale entry of the pool's Library seed (<root>/seed/Library on m5, the warm Library every new sandbox is cloned from and an
 * idle one is cloned from again, machine/sandboxes.ts librarySource and reseedIdle), judged by the daemon trim's rules
 * (staleCacheEntries: superseded Burst player builds, BuildCache folders older than the newest build past 2 GB), or undefined
 * for a path outside it (w5280: m5's seed held 90 GB, 28.5 GB of it such entries, and no row reached it). Its JIT stays: nothing
 * loads the seed, so access times say nothing there, and all 1,589 of its bundles were in a sandbox read within 14 days
 * (measured 2026-11-23). Kept while any process names the seed (a sandbox being cloned from it: copyTree runs `cp` or
 * robocopy with the seed's path), and the caches whole.
 */
export async function judgeSeedLibraryPath(p: string, f: CleanupFacts, ctx?: SlotContext, now = Date.now()): Promise<FolderRow | undefined> {
  const seed = seedLibrary(f);
  // `now`, not the wall clock (w5309): planFolders judges on its own clock; on the wall clock its later seed rows found the facts
  // over 5 min old, fell through to judgePath (on planFolders' clock) and came out "not a place with an owner in the ledger".
  if (!seed || !within(p, seed) || factsProblem(f, now)) return undefined;
  const rel = norm(p).slice(norm(seed).length + 1).split('/');
  if (!LIBRARY_CACHES.some((c) => c.toLowerCase() === rel[0])) return undefined;
  const row = (verdict: FolderRow['verdict'], why: string): FolderRow => ({ path: p, kind: 'seed-library', verdict, why });
  if (!ctx?.procs) return row('keep', 'the running processes could not be read to see that no sandbox is being cloned from the Library seed');
  const user = ctx.procs.find((c) => mentions(c, seed));
  if (user) return row('keep', `a running process names the Library seed (${user.slice(0, 160)}): a sandbox may be cloned from it now`);
  if (rel.length < 2) return row('keep', `the Library seed's ${rel[0]} as a whole: a sandbox cloned from a cold seed starts cold, only its stale entries are candidates`);
  if (rel[0] === 'burstcache' && rel[1] === 'jit') return row('keep', "the Library seed's JIT: nothing loads the seed, so its access times say nothing; every seed bundle was in use in a sandbox (w5280)");
  const { hit, inside } = staleHit(p, await memoStale('seed', seed, now, seedStale(seed)));
  if (inside) return row('keep', insideEntryWhy(inside));
  if (!hit) return row('keep', 'not stale: the newest Burst player builds, the manifests and the newest BuildCache folders stay (cacheTrim.ts)');
  return row('delete', `a stale entry of the Library seed's ${path.relative(seed, p).split(/[\\/]/)[0]}: ${hit.why}; no process names the seed (rebuildable, w5280)`);
}

/**
 * An FFU self-hosted runner's job folder (<root>/ffu-runners/<runner>/_work/<entry>), judged as the daemon's rule
 * ffu-runner-work judges it (installLeftovers.ts, w3502), or undefined for a path outside the runners. Before w5235 `check`
 * called them "not a place with an owner in the ledger": on biscuit (w5233) ffu-biscuit-2's _work held 25 GB (16 GB
 * ffu/ffu/target, 7.4 GB ffu/ffu/fuzz/target) with no Runner.Worker running, and the clean-up could not take it between two
 * daemon passes. A runner keeps nothing in _work between jobs that a job does not make again: actions/checkout clones a
 * missing workspace, the runner writes _temp and _PipelineMapping afresh, and cargo rebuilds a missing target (a cold build
 * costs minutes, the price of the space). Its tool cache (_tool) and action downloads (_actions) stay, as the daemon keeps
 * them; so do bin/, _diag/ and the runner's settings. Nothing goes while the runner runs a job (runnerJobWhy: its
 * Runner.Worker, a process run from its _work, a listener just handed a job) or within the settle time of a write.
 */
export async function judgeRunnerWorkPath(p: string, f: CleanupFacts, now: number, ctx?: SlotContext): Promise<FolderRow | undefined> {
  if (factsProblem(f, now) || !f.root) return undefined;
  const base = path.join(f.root, 'ffu-runners');
  if (!within(p, base) || norm(p) === norm(base)) return undefined;
  const row = (verdict: FolderRow['verdict'], why: string): FolderRow => ({ path: p, kind: 'ffu-runner-work', verdict, why });
  // Names as written on disk (norm lowercases them), for the reasons a person reads.
  const rel = path.relative(base, p).split(/[\\/]+/);
  const name = rel[0]!;
  if (rel[1]?.toLowerCase() !== '_work' || rel.length < 3) return row('keep', `FFU runner ${name}'s own files (bin, _diag, its settings, the _work folder itself): only a job folder inside _work is a candidate`);
  if (RUNNER_KEPT.test(rel[2]!)) return row('keep', `FFU runner ${name}'s ${rel[2]} (its tool cache or action downloads): kept, as the daemon's rule ffu-runner-work keeps them`);
  const runner = path.join(base, name);
  const entry = path.join(runner, '_work', rel[2]!);
  const what = `FFU runner ${name}'s job folder (${rel[2]})`;
  if (!ctx?.procList) return row('keep', `${what}: the running processes could not be read, so a running job cannot be ruled out`);
  const busy = runnerJobWhy(runner, ctx.procList, now, ctx.runnerLog);
  if (busy) return row('keep', `${what}: ${busy}`);
  const settle = INSTALL_LEFTOVER_DEFAULTS.lowCacheSettleMinutes;
  const newest = await newestTopWrite(entry);
  if (newest > now - settle * 60_000) return row('keep', `${what}: written ${agoMin(now - newest)} ago, within the ${settle} min settle time (a job may have just ended or begun)`);
  const inside = norm(p) === norm(entry) ? '' : `inside ${what}: `;
  return row('delete', `${inside}${what}, no job running on the runner (no Runner.Worker, no process from its _work, its listener not handed a job) and nothing in it written for ${settle} min; the next job checks out and builds again (rule ffu-runner-work, w3502)`);
}

/**
 * How many of the newest ready players the cache keeps whatever else says (w5235): two. A before/after leg (a fix against the
 * commit before it, the players lane's A/B) needs two commits' players at once, and the newest build is usually the head a
 * requester just built for its --dry run, which its pair legs then use (machine/playerCache.ts, w4601). A player an open
 * request built or used, a pinned or leased one and one used in the last hour are kept by their own rules, so N covers only
 * what nothing names. player_cache.py's own cap is 8 entries or 24 GB (FF_PLAYER_CACHE_MAX_ENTRIES).
 */
export const PLAYER_CACHE_KEEP_NEWEST = 2;
/** A cached player used within this many minutes stays, as player_cache.py's FF_PLAYER_CACHE_RECENT_MIN default. */
export const PLAYER_CACHE_RECENT_MIN = 60;
/** A cache entry with no ready manifest (a build running or failed) stays this long after its last write. */
export const PLAYER_CACHE_BUILD_HOURS = 6;

const fileMtime = (p: string) => {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
};

/** A ready entry's build time: its manifest's "finished", else the manifest's mtime; undefined when not ready. */
function readyAt(entry: string): number | undefined {
  const m = readJson(path.join(entry, 'build-manifest.json')) as { status?: unknown; finished?: unknown } | undefined;
  if (m?.status !== 'ok' || !fs.existsSync(path.join(entry, 'player'))) return undefined;
  const at = typeof m.finished === 'string' ? Date.parse(m.finished) : NaN;
  return Number.isFinite(at) ? at : fileMtime(path.join(entry, 'build-manifest.json'));
}

/** The sessions cache.log names for `key` (its built-ok and hit lines carry ff_session_id), newest last. */
export function cacheLogSessions(log: string, key: string): string[] {
  const out: string[] = [];
  for (const line of log.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts[2] !== key || parts[1] === 'evicted') continue;
    const sid = /(?:^|\s)ff_session_id=([\w-]+)/.exec(line)?.[1];
    if (sid && !out.includes(sid)) out.push(sid);
  }
  return out;
}

/**
 * A cached player (<root>/player-cache/<40 hex>-<os>[-burstN], the game repo's scripts/nightly/player_cache.py), or undefined
 * for a path outside the cache. Before w5235 every entry was "not a place with an owner in the ledger": biscuit's 11 GB of
 * eight Linux players (w5233) could only go through player_cache.py's own eviction, which runs after a build and stops at its
 * 8-entry cap. An entry is kept while anything uses it, as player_cache.py's in_use keeps it from eviction, and more:
 * a running process naming it or its commit (a build holding its lock names the entry), a live pin (<entry>.pins/<pid>), a
 * last-used under an hour old, no ready manifest within a build's time, a player slot filled from it that a lease, a fill
 * or a running process holds, a worker that built or used it (cache.log) whose request is not closed, and the newest
 * PLAYER_CACHE_KEEP_NEWEST ready builds. The rest goes; the next run that needs that commit builds it again (3 to 23 min).
 */
export async function judgePlayerCachePath(p: string, f: CleanupFacts, now: number, ctx?: SlotContext): Promise<FolderRow | undefined> {
  if (factsProblem(f, now) || !f.root) return undefined;
  const base = path.join(f.root, 'player-cache');
  if (!within(p, base) || norm(p) === norm(base)) return undefined;
  const row = (verdict: FolderRow['verdict'], why: string): FolderRow => ({ path: p, kind: 'player-cache', verdict, why });
  const rel = norm(p).slice(norm(base).length + 1).split('/');
  const key = path.basename(path.join(base, rel[0]!));
  if (!PLAYER_CACHE_ENTRY.test(key)) return row('keep', "the player cache's own files (cache.log, an entry's .lock or .pins): only a cached player's folder is a candidate");
  if (rel.length > 1) return row('keep', `inside cached player ${key}: remove the entry itself (${path.join(base, key)}), never part of a player`);
  const entry = path.join(base, key);
  const what = `cached player ${key}`;
  if (!ctx?.procs) return row('keep', `${what}: the running processes could not be read to see that nothing builds or plays it`);
  const sha = key.slice(0, 40);
  const user = ctx.procs.find((c) => mentions(c, entry) || c.toLowerCase().includes(sha));
  if (user) return row('keep', `${what}: a running process names it or its commit (${user.slice(0, 160)})`);
  const pins = (() => {
    try {
      return fs.readdirSync(`${entry}.pins`).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    } catch {
      return [];
    }
  })().filter((pid) => ctx.alive(pid));
  if (pins.length) return row('keep', `${what}: pinned by live pid ${pins.join(', ')} (player_cache.py pin)`);
  const used = Math.max(fileMtime(path.join(entry, 'last-used')), readyAt(entry) ?? 0);
  if (now - used < PLAYER_CACHE_RECENT_MIN * 60_000) return row('keep', `${what}: used ${agoMin(now - used)} ago, within ${PLAYER_CACHE_RECENT_MIN} min (player_cache.py's FF_PLAYER_CACHE_RECENT_MIN)`);
  if (readyAt(entry) === undefined) {
    const wrote = await newestTopWrite(entry);
    if (now - wrote < PLAYER_CACHE_BUILD_HOURS * 3_600_000) return row('keep', `${what}: not ready (no build-manifest.json with "status": "ok") and written ${agoMin(now - wrote)} ago: a build may still run`);
  }
  for (const e of entries(path.join(f.root, 'players'))) {
    if (!e.isDirectory() || !isSlotDir(e.name)) continue;
    const slot = path.join(f.root, 'players', e.name);
    const source = (readJson(path.join(slot, 'slot.json')) as { source?: unknown } | undefined)?.source;
    if (typeof source !== 'string' || !within(source, entry)) continue;
    const s = judgePlayerSlot(slot, ctx, now);
    if (s.verdict === 'keep' && s.why !== EMPTY_SLOT_WHY) return row('keep', `${what}: player slot ${e.name} was filled from it and is in use (${s.why})`);
  }
  let log = '';
  try {
    log = fs.readFileSync(path.join(base, 'cache.log'), 'utf8');
  } catch {
    /* no log: no worker named */
  }
  const up = new Set([...f.live, ...f.resumable, ...Object.keys(f.owners ?? {}), ...(ctx.hosts ?? []), ...(ctx.self ? [ctx.self] : [])].map((s) => s.toLowerCase()));
  const owner = cacheLogSessions(log, key).find((s) => up.has(s.toLowerCase()));
  if (owner) {
    const reqs = f.owners?.[owner]?.requests.map((r) => r.id).join(', ');
    return row('keep', `${what}: worker ${owner}${reqs ? ` (${reqs})` : ''} built or used it (cache.log) and runs or has a request not closed`);
  }
  const newest = entries(base)
    .filter((e) => e.isDirectory() && PLAYER_CACHE_ENTRY.test(e.name))
    .map((e) => ({ name: e.name, at: readyAt(path.join(base, e.name)) }))
    .filter((e): e is { name: string; at: number } => e.at !== undefined)
    .sort((a, b) => b.at - a.at || a.name.localeCompare(b.name))
    .slice(0, PLAYER_CACHE_KEEP_NEWEST)
    .map((e) => e.name);
  if (newest.includes(key)) return row('keep', `${what}: one of the ${PLAYER_CACHE_KEEP_NEWEST} newest ready builds (PLAYER_CACHE_KEEP_NEWEST: a before/after leg needs two commits' players)`);
  return row('delete', `${what}: no running process, pin, slot in use or worker with a request not closed uses it, last used ${agoMin(now - used)} ago, and not one of the ${PLAYER_CACHE_KEEP_NEWEST} newest builds; the next run that needs this commit builds it again (3 to 23 min). An idle player slot filled from it keeps its hard-linked files until that slot is emptied too`);
}

/** The verdict for one path, wherever it is. */
export function judgePath(p: string, f: CleanupFacts, now = Date.now(), slots?: SlotContext): FolderRow {
  const row = (kind: FolderRow['kind'], r: Pick<FolderRow, 'verdict' | 'why'>): FolderRow => ({ path: p, kind, ...r });
  const bad = factsProblem(f, now);
  if (bad) return row('other', { verdict: 'keep', why: bad });
  const root = f.root!;
  if (!within(p, root) || norm(p) === norm(root)) return row('other', { verdict: 'keep', why: OUTSIDE_ROOT_WHY });
  if (f.tempRoot && within(p, f.tempRoot) && norm(p) !== norm(f.tempRoot)) {
    const first = norm(p).slice(norm(f.tempRoot).length + 1).split('/')[0]!;
    const sid = sessionOfDir(first);
    if (sid) {
      const r = judgeSession(sid, f);
      const seen = r.verdict === 'delete' ? sessionSeen(sid, path.join(f.tempRoot, first), f, slots) : undefined;
      return row('session-temp', seen ? { verdict: 'keep', why: seen } : r);
    }
    return row('other', { verdict: 'keep', why: 'not a worker temp folder (ffa-<session>)' });
  }
  for (const sb of f.sandboxes) {
    if (!within(p, sb.path)) continue;
    const rel = norm(p).slice(norm(sb.path).length + 1).split('/');
    if (['builds', '.nightly-builds'].includes(rel[0] ?? '') && rel.length >= 2) return row('sandbox-output', judgeSandbox(sb.id, f));
    return row('other', { verdict: 'keep', why: "a sandbox's own files (only its Builds/ and .nightly-builds/ output is a candidate)" });
  }
  const rel = norm(p).slice(norm(root).length + 1).split('/');
  if (rel[0] === 'scratch' && rel.length >= 2) return row('scratch', judgeNamed(rel[1]!, f, now));
  if (rel[0] === 'players' && rel.length >= 2 && isSlotDir(rel[1]!)) return row('player-slot', judgePlayerSlot(path.join(root, 'players', rel[1]!), slots, now));
  if (rel[0] === 'timing') return row('other', { verdict: 'keep', why: judgeTiming(f) });
  // w5281: the machine's shared caches (the uv cache, the determinism audits): the daemon prunes them itself.
  if (rel[0] === 'cache') return row('other', { verdict: 'keep', why: "the machine's shared caches (uv, determinism audits): the daemon prunes uv's daily (uv cache prune), the game keeps its audits to 40 runs and 10 GB" });
  const named = rel.find((seg) => requestIdsIn(seg).length);
  if (named) return row('named', judgeNamed(named, f, now));
  return row('other', { verdict: 'keep', why: 'not a place with an owner in the ledger' });
}

const entries = (dir: string) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

/** Folders never looked into for repos: a clone's own .git, and the big trees a repo is never inside. */
const NO_LOOK = /^(\.git|node_modules|library)$/i;
/** How far below a folder its repos are looked for: the portal's sweeps look one level down; a worker's legs nest deeper. */
const REPO_DEPTH = 3;

export interface RepoAt {
  repo: string;
  /** The repo holds `p` (p is inside its work tree), rather than `p` holding the repo. */
  around: boolean;
}

/** The git repos (or worktrees: .git may be a file) at `p`, below it to REPO_DEPTH, and the one it is inside, up to `root`. */
export function reposAround(p: string, root: string): RepoAt[] {
  const out: RepoAt[] = [];
  const isRepo = (d: string) => fs.existsSync(path.join(d, '.git'));
  for (let d = path.dirname(p); within(d, root) && norm(d) !== norm(root) && path.dirname(d) !== d; d = path.dirname(d)) {
    if (isRepo(d)) {
      out.push({ repo: d, around: true });
      break;
    }
  }
  const down = (d: string, depth: number) => {
    if (isRepo(d)) {
      out.push({ repo: d, around: false }); // its nested repos are its submodules: its own status covers them
      return;
    }
    if (depth >= REPO_DEPTH) return;
    for (const e of entries(d)) if (e.isDirectory() && !e.isSymbolicLink() && !NO_LOOK.test(e.name)) down(path.join(d, e.name), depth + 1);
  };
  down(p, 0);
  return out;
}

/** Git ignores `p` in `repo` (a build cache, node_modules): deleting it takes nothing git holds. Unknown counts as no. */
export function gitIgnores(repo: string, p: string, timeoutMs = 30_000): Promise<boolean> {
  return new Promise((resolve) =>
    execFile('git', ['--no-optional-locks', '-C', repo, 'check-ignore', '-q', '--', path.relative(repo, p)], { timeout: timeoutMs, windowsHide: true }, (e) => resolve(!e)),
  );
}

/**
 * Why a git repo keeps `p`, or undefined: one in or under it with uncommitted changes, commits on no remote or a stash
 * (cleanup.ts localWorkWhy, the portal sweeps' own check), or the one around it with such work when git does not ignore `p`.
 */
export async function gitKeeps(p: string, root: string, localWork: (dir: string) => Promise<string | undefined> = (d) => localWorkWhy(d, 60_000)): Promise<string | undefined> {
  const held: string[] = [];
  for (const { repo, around } of reposAround(p, root)) {
    if (around && (await gitIgnores(repo, p))) continue;
    const why = await localWork(repo);
    if (why) held.push(`${repo}${around ? ' (around it)' : ''}: ${why}`);
  }
  if (!held.length) return undefined;
  return `holds a git repo with uncommitted or unpushed work (${held.join('; ')}), as the portal's clean-up keeps it (w1387): push it or ask its person; never delete it`;
}

/** A DELETE row checked for git work, which turns it into KEEP with the reason and the ledger's own verdict beside it. */
export async function withGitCheck(r: FolderRow, root: string | undefined, localWork?: (dir: string) => Promise<string | undefined>): Promise<FolderRow> {
  if (r.verdict !== 'delete' || !root) return r;
  const why = await gitKeeps(r.path, root, localWork);
  return why ? { ...r, verdict: 'keep', why: `${why}. The ledger alone said: ${r.why}` } : r;
}

/**
 * One path judged by the ledger, then by the git repos in it (planFolders, and `ff-leftovers check`). A temp folder of a
 * worker whose requests all closed, or of no request, is held only by commits on no remote or a stash (w3656, cleanup.ts
 * unpushedWorkWhy, as the daemon's own pass judges it); every other DELETE row by any local work (localWorkWhy). Until
 * w3707 `check` used localWorkWhy for both, so a closed worker's folder holding a .git with no HEAD or refs read
 * "its git state could not be read" and KEEP while the pass judged it DELETE (ffa-f1beecb0 on LothDesktop, 2026-11-08).
 */
export async function judgeWithGit(p: string, f: CleanupFacts, now: number, slots?: SlotContext, o: { localWork?: (dir: string) => Promise<string | undefined>; unpushedWork?: (dir: string) => Promise<string | undefined> } = {}): Promise<FolderRow> {
  const judged = (await judgeFfuSlotPath(p, f, now, slots)) ?? (await judgeSandboxLibraryPath(p, f, slots, now)) ?? (await judgeSeedLibraryPath(p, f, slots, now)) ?? (await judgeRunnerWorkPath(p, f, now, slots)) ?? (await judgePlayerCachePath(p, f, now, slots)) ?? judgePath(p, f, now, slots);
  // A runner's checkout is CI's own scratch (w5235): actions/checkout (clean: true, its default) runs git clean -ffdx and
  // git reset --hard before every job, so its uncommitted files are a build's leftovers that the next job wipes anyway.
  if (judged.kind === 'ffu-runner-work') return judged;
  const closed = judged.kind === 'session-temp' && judged.verdict === 'delete';
  return withGitCheck(judged, f.root, closed ? (o.unpushedWork ?? ((d: string) => unpushedWorkWhy(d, 60_000))) : o.localWork);
}

/** Worker `sid` finished (w2223): stopped, no request that has not closed is on it, and only a pending check-in keeps its folder (the 7-day reopen hold went in w3656). */
export const finishedSession = (sid: string, f: CleanupFacts) => !f.live.includes(sid) && !f.owners?.[sid] && f.resumable.includes(sid);

/**
 * The DELETE and KEEP rows inside a finished worker's folder (w2223, installLeftovers.ts finishedBulkIn): its clones with
 * nothing on no remote, Library copies, caches and test output, once nothing in the folder was written for a day (15 min
 * while disk is low); evidence published nowhere else and repos with work stay, the latter listed.
 */
export async function finishedRows(dir: string, f: CleanupFacts, o: { now?: number; published?: Map<string, PublishedRecord[]>; localWork?: (dir: string) => Promise<string | undefined>; ignoredEvidence?: (repo: string) => Promise<string[] | undefined> } = {}): Promise<FolderRow[]> {
  const now = o.now ?? Date.now();
  // The daemon sweep's own clock (installLeftovers.ts idleCacheHours, lowCacheSettleMinutes); read here, not at load: the modules import each other.
  const FINISHED_IDLE_HOURS = INSTALL_LEFTOVER_DEFAULTS.idleCacheHours;
  const FINISHED_LOW_MIN = INSTALL_LEFTOVER_DEFAULTS.lowCacheSettleMinutes;
  const bulk = await finishedBulkIn(dir, { published: o.published, localWork: o.localWork, ignoredEvidence: o.ignoredEvidence });
  const rows: FolderRow[] = bulk.keep.filter((k) => k.path !== dir).map((k) => ({ path: k.path, kind: 'session-bulk', verdict: 'keep', why: k.why }));
  if (!bulk.take.length) return rows;
  const cut = now - (f.low ? FINISHED_LOW_MIN * 60_000 : FINISHED_IDLE_HOURS * 3_600_000);
  const found: { path?: string; unreadable?: boolean } = {};
  const last = await newestWrite(dir, cut, new Set(bulk.take.map((t) => norm(t.path))), undefined, found);
  const wait = f.low ? `${FINISHED_LOW_MIN} min (disk is low)` : `${FINISHED_IDLE_HOURS} h`;
  if (last === 'too-big' || last > cut || found.unreadable) {
    const why = last === 'too-big' ? 'too many entries to judge its last write' : found.unreadable ? `a folder in it cannot be read (${found.path})` : `written ${Math.round((now - last) / 60_000)} min ago (${found.path})`;
    return [...rows, { path: dir, kind: 'session-bulk', verdict: 'keep', why: `its rebuildable bulk (${bulk.take.length} item(s)) waits for ${wait} with no write: ${why}` }];
  }
  for (const t of bulk.take) rows.push({ path: t.path, kind: 'session-bulk', verdict: 'delete', why: `${t.what}, in finished worker ${path.basename(dir).replace(/^ffa-/i, '')}'s folder (its requests closed; the reopen hold keeps the folder, not what a reopen rebuilds) with no write for ${wait}` });
  return rows;
}

/** Every folder a clean-up could take, judged. Sizes are measured for the deletable ones only unless `sizes` asks for all. */
export async function planFolders(f: CleanupFacts, o: { now?: number; sizes?: 'all' | 'delete' | 'none'; localWork?: (dir: string) => Promise<string | undefined>; unpushedWork?: (dir: string) => Promise<string | undefined>; published?: Map<string, PublishedRecord[]>; ignoredEvidence?: (repo: string) => Promise<string[] | undefined>; slots?: SlotContext } = {}): Promise<FolderPlan> {
  const now = o.now ?? Date.now();
  const bad = factsProblem(f, now);
  if (bad) return [{ path: f.root ?? '(no install folder)', kind: 'other', verdict: 'keep', why: bad }];
  const paths: string[] = [];
  if (f.tempRoot) for (const e of entries(f.tempRoot)) if (e.isDirectory() && sessionOfDir(e.name)) paths.push(path.join(f.tempRoot, e.name));
  for (const e of entries(path.join(f.root!, 'scratch'))) paths.push(path.join(f.root!, 'scratch', e.name));
  for (const e of entries(path.join(f.root!, 'players'))) if (e.isDirectory() && isSlotDir(e.name)) paths.push(path.join(f.root!, 'players', e.name));
  const ffu = path.join(f.root!, FFU_SLOTS_DIR);
  for (const e of entries(ffu)) {
    if (!e.isDirectory() || !/^slot\d+$/.test(e.name)) continue;
    for (const t of [path.join(ffu, e.name, 'target'), path.join(ffu, e.name, 'ffu', 'target')]) if (fs.existsSync(t)) paths.push(t);
  }
  // w5235: the FFU runners' job folders and the cached players, judged by judgeRunnerWorkPath and judgePlayerCachePath.
  const runners = path.join(f.root!, 'ffu-runners');
  for (const r of entries(runners)) {
    if (!r.isDirectory()) continue;
    for (const e of entries(path.join(runners, r.name, '_work'))) if (e.isDirectory() && !RUNNER_KEPT.test(e.name)) paths.push(path.join(runners, r.name, '_work', e.name));
  }
  for (const e of entries(path.join(f.root!, 'player-cache'))) if (e.isDirectory() && PLAYER_CACHE_ENTRY.test(e.name)) paths.push(path.join(f.root!, 'player-cache', e.name));
  for (const sb of f.sandboxes) {
    // w5240: a sandbox's stale Library cache entries, only while it is idle and closed.
    if (judgeSandbox(sb.id, f).verdict === 'delete' && !projectOpen(sb.path)) for (const e of await memoStale('sandbox', sb.path, now, () => sandboxLibraryStale(sb.path))) paths.push(e.path);
    for (const top of ['Builds', '.nightly-builds']) for (const e of entries(path.join(sb.path, top))) paths.push(path.join(sb.path, top, e.name));
  }
  // w5280: the Library seed's stale entries, while no process names it (judgeSeedLibraryPath judges each again).
  const seed = seedLibrary(f);
  if (seed && o.slots?.procs && !o.slots.procs.some((c) => mentions(c, seed))) for (const e of await memoStale('seed', seed, now, seedStale(seed))) paths.push(e.path);
  const rows: FolderPlan = [];
  let emptySlots = 0;
  for (const p of paths) {
    const r = await judgeWithGit(p, f, now, o.slots, o);
    // An emptied slot is no candidate (w5168): nothing to free, and its folder stays.
    if (r.kind === 'player-slot' && r.why === EMPTY_SLOT_WHY) {
      emptySlots++;
      continue;
    }
    rows.push(r);
    // w5240: a kept slot target's incremental cache is judged on its own (a stopped holder's is DELETE).
    if (r.kind === 'ffu-slot-target' && r.verdict === 'keep' && path.basename(p) === 'target' && path.basename(path.dirname(p)) !== 'ffu') {
      const inc = path.join(p, 'debug', 'incremental');
      if (fs.existsSync(inc)) {
        const ir = await judgeWithGit(inc, f, now, o.slots, o);
        if (ir.verdict === 'delete') rows.push(ir);
      }
    }
    const sid = r.kind === 'session-temp' ? sessionOfDir(path.basename(p)) : undefined;
    if (r.verdict === 'keep' && sid && finishedSession(sid, f)) rows.push(...(await finishedRows(p, f, { now, published: o.published, localWork: o.localWork, ignoredEvidence: o.ignoredEvidence })));
  }
  const mode = o.sizes ?? 'delete';
  if (mode !== 'none') {
    // Measured together (w5168): each row's bytes are what deleting it alone frees, the plan's what deleting every DELETE row frees.
    const measured = rows.filter((r) => mode === 'all' || r.verdict === 'delete');
    const { each, together } = await freeableBytes(measured.map((r) => r.path), { inTotal: measured.map((r) => r.verdict === 'delete') });
    measured.forEach((r, i) => {
      r.bytes = each[i]!.freed;
      if (each[i]!.bytes > each[i]!.freed) r.linked = each[i]!.bytes - each[i]!.freed;
    });
    rows.freed = together.freed;
    if (together.bytes > together.freed) rows.linked = together.bytes - together.freed;
  }
  if (emptySlots) rows.emptySlots = emptySlots;
  rows.sort((a, b) => (a.verdict === b.verdict ? 0 : a.verdict === 'keep' ? -1 : 1) || a.path.localeCompare(b.path));
  return rows;
}

const gb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);

/** The listing a clean-up worker reads: what to keep and why, what it may delete. */
export function renderFolders(rows: FolderPlan, f: CleanupFacts | undefined, now = Date.now()): string {
  const bad = factsProblem(f, now);
  if (bad) return `Nothing may be deleted on this machine's facts: ${bad}.\nReport that; do not guess which folders are free.\n`;
  // w5168: a size is what the delete frees; hard links to files kept elsewhere (a player slot's build) are shown apart.
  const linked = (n: number | undefined) => (n ? `, +${gb(n)} hard-linked to files kept elsewhere, not freed` : '');
  const line = (r: FolderRow) => `${r.verdict === 'keep' ? 'KEEP  ' : 'DELETE'}  ${r.bytes === undefined ? '' : `${gb(r.bytes)}${linked(r.linked)}  `}${r.path}\n        ${r.why}`;
  const keep = rows.filter((r) => r.verdict === 'keep');
  const del = rows.filter((r) => r.verdict === 'delete');
  const total = rows.freed ?? del.reduce((n, r) => n + (r.bytes ?? 0), 0);
  const measured = del.some((r) => r.bytes !== undefined);
  const empty = rows.emptySlots ? ` ${rows.emptySlots} empty player slot(s) not listed: nothing to free.` : '';
  return [
    `Folders under ${f!.root} judged against the ledger (facts ${Math.max(0, Math.round((now - Date.parse(f!.at)) / 1000))} s old): ${keep.length} to KEEP, ${del.length} deletable${measured ? ` (${gb(total)} freed by deleting them all${linked(rows.linked)})` : ''}.${empty}`,
    ...keep.map(line),
    ...del.map(line),
    'Delete only the DELETE rows, and only inside the install folder. A KEEP row belongs to a request that has not closed (open, stalled or paused), holds a git repo with work on no remote or evidence published nowhere else, or could not be attributed: report it, never remove it. A DELETE row inside a kept folder (a finished worker\'s bulk, w2223) goes alone; its folder stays. A player slot is judged by its lease files (w2796).',
    'Delete every DELETE row, player slots included, with `ff-leftovers remove <path>...` (w4394, w5168), never rm: it judges the path again just before it deletes, refuses a KEEP path, a link and anything outside the install folder, and logs each removal with what it freed. A player slot it empties and keeps (its folder and firewall rule stay, as `remove-slot <slot>` does). `ff-leftovers check <path>...` judges any other path before you delete it.',
    '',
  ].join('\n');
}
