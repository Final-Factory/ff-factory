// The Claude token pool (w739, docs/vault.md section 4): which of a person's tokens a run gets, by the plan meters.
//
// Pure functions, no I/O: server/vault.ts feeds them the entries, the meters and the live counts; server/secrets.ts
// decides who may be held. The rules (lothsahn, 2026-10-08/09):
//   - a person's runs use that person's own tokens only (their pool): no shared Claude token, no one else's;
//   - among the pool, the token with the most weekly headroom per hour left until its weekly reset first (scoreOf, w971),
//     scaled by the room left in its 5-hour window; ties: the soonest weekly reset, then the 5-hour reset, fewer live runs, the name;
//   - a pool token that is also the dispatcher's credential (or the host token), while it is inside that credential's reserve
//     (reserveOf), goes to nothing but a person's own orchestrator, and to it only when no other token has room (w971);
//   - 5-hour meter at or above `sessionHold` (80): no new process on it until that window resets;
//   - weekly at or above `onePerWeekly` (95): one live process at a time;
//   - weekly at or above `retireWeekly` (99): not handed out until the weekly window resets;
//   - a meter at 100 (or a rejection): used up, handed to nobody until it resets;
//   - a person's own orchestrator, when every pool token is past its caps but none is used up, still runs on the one with
//     the most room until it is used up: the caps keep workers from eating the person's own use, they do not lock them out;
//   - the ops worker (w1112, lothsahn: "The ops worker should not hold based on tokens, just like the dispatcher") is never held
//     by the caps either: past them it runs on the person's token with the most room, the dispatcher's reserved token last,
//     and only a pool whose every token is used up stops it.
// A token with no numbers yet counts as 50% on both meters: it passes every rule and ranks after the ones with a score.
// A reading kept from before (data/usage.json) stands in for a poll that failed or has not answered yet, aged by its reset
// times and floored at 50% once older than STALE_READING_MS (server/usage.ts effectiveUsage, w1041).
//
// The dispatcher's reserve (reserveOf) is a different thing: the credential the dispatcher runs on keeps a buffer that
// shrinks as its weekly window runs out, for the dispatcher alone. At `dispatcherStop` (95) on either of its meters the
// token is inside that reserve whatever the buffer says (w1109): no new worker starts on it, and the workers already on it
// are asked to stop (server/dispatcherStop.ts).

import type { PlanUsage } from '../shared/types.ts';

/** The system-wide limits, percent (config vault.pool.*). */
export interface PoolLimits {
  /** 5-hour meter at or above: no new process on the token. */
  sessionHold: number;
  /** Weekly meter at or above: one live process at a time. */
  onePerWeekly: number;
  /** Weekly meter at or above: the token is not handed out until the weekly window resets. */
  retireWeekly: number;
  /** The dispatcher's token keeps this many percent of the weekly window per day left until that window resets. */
  reservePerDay: number;
  /** ... and this many percent of the 5-hour window. */
  reserveSession: number;
  /** Either meter of the dispatcher's token at or above: its workers are asked to stop, and no new one starts on it (w1109). */
  dispatcherStop: number;
}

export const POOL_DEFAULTS: Readonly<PoolLimits> = { sessionHold: 80, onePerWeekly: 95, retireWeekly: 99, reservePerDay: 5, reserveSession: 20, dispatcherStop: 95 };

/** Config vault.pool: the same, with the unit in the name. Anything unset is the default. */
export interface PoolConfig {
  sessionHoldPercent?: number;
  onePerWeeklyPercent?: number;
  retireWeeklyPercent?: number;
  reservePerDayPercent?: number;
  reserveSessionPercent?: number;
  dispatcherStopPercent?: number;
}

export const POOL_CONFIG_KEYS = ['sessionHoldPercent', 'onePerWeeklyPercent', 'retireWeeklyPercent', 'reservePerDayPercent', 'reserveSessionPercent', 'dispatcherStopPercent'] as const;

const pct = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : d);

/** The limits in effect, read at every pick: a change applies to the next process, with no restart. */
export function poolLimits(cfg: { vault?: { pool?: PoolConfig } } | undefined): PoolLimits {
  const p = cfg?.vault?.pool;
  const out: PoolLimits = {
    sessionHold: pct(p?.sessionHoldPercent, POOL_DEFAULTS.sessionHold),
    onePerWeekly: pct(p?.onePerWeeklyPercent, POOL_DEFAULTS.onePerWeekly),
    retireWeekly: pct(p?.retireWeeklyPercent, POOL_DEFAULTS.retireWeekly),
    reservePerDay: pct(p?.reservePerDayPercent, POOL_DEFAULTS.reservePerDay),
    reserveSession: pct(p?.reserveSessionPercent, POOL_DEFAULTS.reserveSession),
    dispatcherStop: pct(p?.dispatcherStopPercent, POOL_DEFAULTS.dispatcherStop),
  };
  // A hand-edited config.json that breaks the order is read as the retire limit for both (checkPoolConfig refuses it at load).
  if (out.onePerWeekly > out.retireWeekly) out.onePerWeekly = out.retireWeekly;
  return out;
}

/** Why a vault.pool block is not usable, or undefined (config load, set_app_config). */
export function checkPoolConfig(p: unknown): string | undefined {
  if (p === undefined) return undefined;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return `config vault.pool is an object: ${POOL_CONFIG_KEYS.join(', ')}`;
  const o = p as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!(POOL_CONFIG_KEYS as readonly string[]).includes(k)) return `config vault.pool.${k} is not a setting (${POOL_CONFIG_KEYS.join(', ')})`;
  for (const k of POOL_CONFIG_KEYS) {
    const v = o[k];
    if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100)) return `config vault.pool.${k} is a percent from 0 to 100`;
  }
  const one = (o.onePerWeeklyPercent as number | undefined) ?? POOL_DEFAULTS.onePerWeekly;
  const retire = (o.retireWeeklyPercent as number | undefined) ?? POOL_DEFAULTS.retireWeekly;
  if (one > retire) return `config vault.pool.onePerWeeklyPercent (${one}) is above retireWeeklyPercent (${retire}): one at a time must start before a token is retired`;
  return undefined;
}

// ---------------------------------------------------------------- one token

/** What the pick knows of one Claude token. */
export interface PoolToken {
  id: string;
  name: string;
  fingerprint: string;
  /** The person whose pool it is. */
  owner?: string;
  /** Its account's plan meters, when polled. */
  usage?: PlanUsage;
  /** Live processes on it, not counting the session that asks. */
  others: number;
  /** Set when the token is also the dispatcher's credential or the host token (w971): the reserve it keeps for that role. */
  reserve?: Reserve;
  /** Which role the reserve is for: "the dispatcher" or "its own roles" (the host token). */
  reserveFor?: string;
}

/** `reserved`: under every limit, but inside the dispatcher's (or the host token's) reserve: not handed out while another token has room. */
export type PoolState = 'ok' | 'held' | 'one-at-a-time' | 'retired' | 'exhausted' | 'reserved';

export interface PoolView {
  state: PoolState;
  /** One line, no token: "5-hour 83% (>= 80), held until 14:05Z". */
  why: string;
  session: number;
  weekly: number;
  /** False when there are no numbers (the 50% default). */
  known: boolean;
  sessionResetsAt?: string;
  weeklyResetsAt?: string;
  /** When the state ends by itself (the window that holds it resets), ISO. */
  until?: string;
  /** `one-at-a-time` only: a process is running on the token, so a new job waits (the state is the same with the slot free, w979). */
  slotTaken?: boolean;
  /** What the dashboard, system_status and `fffctl vault list` show beside the label (w979): the two meters for `ok` and `one-at-a-time`, else `why`. */
  shown: string;
}

/** Whether a new job may start on a token in this view: `ok`, or `one-at-a-time` with its slot free. */
export const usable = (v: PoolView): boolean => v.state === 'ok' || (v.state === 'one-at-a-time' && !v.slotTaken);

/** The label under a pooled token (w979, lothsahn): `pool:ok`, `pool:one-at-a-time`, `pool:held` ..., then ` priority` for the one the picker would choose now. */
export const poolLabel = (v: PoolView, priority = false): string => `pool:${v.state}${priority ? ' priority' : ''}`;

/** The meters of a token, or the 50% default. */
export function metersOf(u: PlanUsage | undefined): { session: number; weekly: number; known: boolean; sessionResetsAt?: string; weeklyResetsAt?: string } {
  if (!u?.available) return { session: 50, weekly: 50, known: false };
  const s = u.session?.percent;
  const w = u.weekly?.percent;
  const known = typeof s === 'number' || typeof w === 'number';
  return { session: typeof s === 'number' ? s : 50, weekly: typeof w === 'number' ? w : 50, known, sessionResetsAt: u.session?.resetsAt, weeklyResetsAt: u.weekly?.resetsAt };
}

/** "Fri 14:05Z" for a reset time, or "its next reset". */
export function clock(iso: string | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return 'its next reset';
  const d = new Date(t);
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${d.toISOString().slice(11, 16)}Z`;
}

/** A percent for a sentence: whole, but never "100%" for a meter still under 100 (99.5 reads 99.5). */
const pc = (n: number) => (n < 100 && Math.round(n) >= 100 ? n.toFixed(1) : String(Math.round(n)));

/** The shortest time to the weekly reset the score divides by: a token minutes from its reset does not score as infinitely good. */
export const MIN_HOURS_TO_RESET = 1;

/**
 * The token's score (w971): its weekly headroom per hour until the weekly window resets, (100 - weekly) / hours left, scaled by
 * the room left in the 5-hour window, (100 - 5-hour) / 100. A token with 73% left and 4 days to go scores 0.76 %/h (18 %/day);
 * one with 3% left and 3 days scores 0.04 %/h (1 %/day). Per day. `undefined` without a weekly reset time (a token with no
 * numbers yet), which ranks after every scored token. The hours left are never below MIN_HOURS_TO_RESET.
 */
export function scoreOf(t: PoolToken, now: number): { perDay?: number } {
  const m = metersOf(t.usage);
  const reset = ms(m.weeklyResetsAt);
  if (!m.known || !Number.isFinite(reset)) return {};
  const hours = Math.max(MIN_HOURS_TO_RESET, (reset - now) / 3_600_000);
  const left = Math.max(0, 100 - m.weekly);
  const sessionLeft = Math.max(0, 100 - m.session);
  const perDay = ((left / hours) * 24 * sessionLeft) / 100;
  return { perDay };
}

/** The state of a token under the limits, for a worker or a standing agent (the strictest reading). */
export function judge(t: PoolToken, limits: PoolLimits, now: number = Date.now()): PoolView {
  const m = metersOf(t.usage);
  const base = { session: m.session, weekly: m.weekly, known: m.known, sessionResetsAt: m.sessionResetsAt, weeklyResetsAt: m.weeklyResetsAt };
  // A reading this portal did not just take (the latest poll failed, or none has answered since it started) says so (w1041).
  const numbers = `5-hour ${pc(m.session)}%, weekly ${pc(m.weekly)}%${t.usage?.reading ? ` [${t.usage.reading.kind} reading: ${t.usage.reading.why}]` : ''}`;
  const meters = m.known ? numbers : 'no numbers yet (counted as 50%)';
  if (m.weekly >= 100 || m.session >= 100) {
    const until = m.weekly >= 100 ? m.weeklyResetsAt : m.sessionResetsAt;
    const why = `${numbers}: used up until ${clock(until)}`;
    return { ...base, state: 'exhausted', why, shown: why, ...(until ? { until } : {}) };
  }
  if (m.weekly >= limits.retireWeekly) {
    const why = `weekly ${pc(m.weekly)}% (>= ${limits.retireWeekly}): retired until ${clock(m.weeklyResetsAt)}`;
    return { ...base, state: 'retired', why, shown: why, ...(m.weeklyResetsAt ? { until: m.weeklyResetsAt } : {}) };
  }
  if (m.session >= limits.sessionHold) {
    const why = `5-hour ${pc(m.session)}% (>= ${limits.sessionHold}): held until ${clock(m.sessionResetsAt)}`;
    return { ...base, state: 'held', why, shown: why, ...(m.sessionResetsAt ? { until: m.sessionResetsAt } : {}) };
  }
  // Inside the reserve of the dispatcher's credential (w971): kept for that role while another token has room.
  if (t.reserve?.inReserve) {
    const why = `${numbers}: inside the buffer kept for ${t.reserveFor ?? 'the dispatcher'} (${reserveReason(t.reserve, t.usage, now)}), so no new run while another token has room${t.reserve.until ? `; free ${clock(t.reserve.until)}` : ''}`;
    return { ...base, state: 'reserved', why, shown: why, ...(t.reserve.until ? { until: t.reserve.until } : {}) };
  }
  // From onePerWeekly up to retireWeekly a token still works, one job at a time. Its state is `one-at-a-time` whether or not its
  // slot is taken (w979, lothsahn: calling it ok was misleading); `slotTaken` says whether a new job can start on it.
  if (m.weekly >= limits.onePerWeekly) {
    const slotTaken = t.others >= 1;
    return { ...base, state: 'one-at-a-time', slotTaken, why: `weekly ${pc(m.weekly)}%, one job at a time${slotTaken ? `; its slot is taken (${t.others} running)` : ''}`, shown: meters };
  }
  return { ...base, state: 'ok', why: meters, shown: meters };
}

/**
 * What a pool can do for a new job, from its tokens' states: `serving` (some token can take a job: `ok`, or in its
 * one-job-at-a-time zone with the slot free), `slot-taken` (none can, but a token that still works is busy with its one
 * job: a new job starts when that finishes), `over` (every token is held, retired or used up: new work waits for a reset) and
 * `used-up` (every token is at 100). Only `over` and `used-up` are "over the caps" (the dashboard banner, w747).
 */
export type PoolKind = 'serving' | 'slot-taken' | 'over' | 'used-up';
export function poolKind(views: readonly PoolView[]): PoolKind {
  if (!views.length || views.some(usable)) return 'serving';
  if (views.every((v) => v.state === 'exhausted')) return 'used-up';
  if (views.some((v) => v.state === 'one-at-a-time')) return 'slot-taken';
  return 'over';
}

/** The earliest time a limit lifts on its own (ISO), among the views that have one. */
export const firstFree = (views: readonly PoolView[]): string | undefined => views.map((v) => v.until).filter((x): x is string => !!x).sort((a, b) => ms(a) - ms(b))[0];

const ms = (iso: string | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : Infinity;
};

/** Soonest weekly reset first, the 5-hour reset next, then the name. A token with no reset time goes last. */
export function bySoonestReset(a: PoolToken, b: PoolToken): number {
  const x = metersOf(a.usage);
  const y = metersOf(b.usage);
  const wx = ms(x.weeklyResetsAt);
  const wy = ms(y.weeklyResetsAt);
  if (wx !== wy) return wx < wy ? -1 : 1;
  const sx = ms(x.sessionResetsAt);
  const sy = ms(y.sessionResetsAt);
  if (sx !== sy) return sx < sy ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/**
 * The pool's order (w971): the highest score first (scoreOf: weekly headroom per hour to the reset, scaled by the 5-hour room);
 * a token with no score after every scored one. Equal scores (within 1e-9): the soonest weekly reset (use what would otherwise
 * be lost), the 5-hour reset, the fewer live runs (spread the load), then the name.
 */
export const byScore = (now: number) => (a: PoolToken, b: PoolToken): number => {
  const x = scoreOf(a, now).perDay;
  const y = scoreOf(b, now).perDay;
  if (x !== y) {
    if (x === undefined) return 1;
    if (y === undefined) return -1;
    if (Math.abs(x - y) > 1e-9 * Math.max(1, Math.abs(x), Math.abs(y))) return y - x;
  }
  return bySoonestReset({ ...a, name: '' }, { ...b, name: '' }) || a.others - b.others || a.name.localeCompare(b.name);
};

/** Room left on the fuller meter (100 minus it), for the over-cap order. */
const room = (t: PoolToken) => {
  const m = metersOf(t.usage);
  return 100 - Math.max(m.session, m.weekly);
};

export interface PoolPick {
  /** The token, when the run may start. */
  token?: PoolToken;
  /** A normal pick, the orchestrator's or the ops worker's use-it-up of a token past its caps, or of one inside the dispatcher's reserve (nothing else had room). */
  how?: 'normal' | 'over-cap' | 'in-reserve';
  /** Every token's state, by id. */
  views: Map<string, PoolView>;
  /** The pool has tokens and none may serve this run now: why, and when the first one frees up (ISO). */
  held?: { why: string; next?: string };
}

/**
 * The token for a run over a person's pool (`tokens` are the pool; the caller keeps other people's out). `orchestrator`:
 * a person's own orchestrator, whose pool is used up past the caps. `ops`: the ops worker (w1112), which no cap holds
 * either. `sticky`: the id the session ran on last, kept while it still passes. `now`: the clock the scores read (default
 * the current time). No tokens at all is the caller's business (the transition: today's account), not a hold.
 *
 * The order is the highest score first (scoreOf, w971). A token inside the dispatcher's reserve (state `reserved`) is
 * handed to nothing while another token has room; when none has, the person's orchestrator takes it (it uses the pool
 * up), a worker waits (held), so the dispatcher keeps its buffer. The ops worker, when no token has room, takes the
 * person's token past its caps with the most room, and the dispatcher's reserved token only when it is the last one not used
 * up (w1112): it is the person's own use, like the orchestrator, but short and rare, so it keeps out of the buffer while it can.
 */
export function pickPool(tokens: readonly PoolToken[], o: { orchestrator: boolean; ops?: boolean; limits: PoolLimits; sticky?: string; now?: number }): PoolPick {
  const now = o.now ?? Date.now();
  const views = new Map(tokens.map((t) => [t.id, judge(t, o.limits, now)] as const));
  const state = (t: PoolToken) => views.get(t.id)!.state;
  const ok = (t: PoolToken) => usable(views.get(t.id)!);
  const order = byScore(now);
  const kept = o.sticky ? tokens.find((t) => t.id === o.sticky && ok(t)) : undefined;
  const best = kept ?? [...tokens].filter(ok).sort(order)[0];
  if (best) return { token: best, how: 'normal', views };
  if (o.orchestrator) {
    // Nothing else has room: the reserve's token is used like any other that passes its caps (today's behaviour for the orchestrator).
    // Its own live-run count does not bind it, so judge it again as if it were not reserved.
    const free = (t: PoolToken) => state(t) === 'reserved' && usable(judge({ ...t, reserve: undefined }, o.limits, now));
    const keptReserved = o.sticky ? tokens.find((t) => t.id === o.sticky && free(t)) : undefined;
    const reserved = keptReserved ?? [...tokens].filter(free).sort(order)[0];
    if (reserved) return { token: reserved, how: 'in-reserve', views };
    const capped = tokens.filter((t) => ['held', 'one-at-a-time', 'retired'].includes(state(t)) || (state(t) === 'reserved' && !free(t)));
    const keptCapped = o.sticky ? capped.find((t) => t.id === o.sticky) : undefined;
    const use = keptCapped ?? [...capped].sort((a, b) => room(b) - room(a) || bySoonestReset(a, b))[0];
    if (use) return { token: use, how: 'over-cap', views };
  }
  if (o.ops) {
    // Every token not used up, the dispatcher's own last (its reserve), then the most room, then the soonest reset (w1112).
    const left = tokens.filter((t) => state(t) !== 'exhausted');
    const use = [...left].sort((a, b) => Number(!!a.reserve) - Number(!!b.reserve) || room(b) - room(a) || bySoonestReset(a, b))[0];
    if (use) return { token: use, how: use.reserve?.inReserve ? 'in-reserve' : 'over-cap', views };
  }
  return { views, held: heldReason(tokens, views) };
}

/** Why no token of a non-empty pool serves a run, and when the first frees up. */
export function heldReason(tokens: readonly PoolToken[], views: ReadonlyMap<string, PoolView>): { why: string; next?: string } {
  const list = tokens.map((t) => views.get(t.id)!);
  const next = firstFree(list);
  const kind = poolKind(list);
  const each = tokens.map((t) => `${t.name}: ${views.get(t.id)!.why}`).join('; ');
  // "Over its caps" only when every token is held, retired or used up; a token busy with its one job is not over anything (w747).
  const head = kind === 'used-up' ? 'every token is used up' : kind === 'over' ? 'every token is at a limit' : 'no token is free for a new job right now';
  const when =
    kind === 'slot-taken'
      ? `a new job starts when the running one finishes${next ? `, or when the first limit lifts ${clock(next)}` : ''}`
      : next
        ? `the first frees up ${clock(next)}`
        : 'no reset time is known yet';
  return { why: `${head} (${each}): ${when}`, ...(next ? { next } : {}) };
}

/**
 * The dashboard banner for one person's pool, or undefined (w747): only when EVERY token is over its caps (held, retired or
 * used up), so that new work waits for a reset. A pool with a token that can take a job, or one busy with its one job at a time,
 * shows nothing at the top (the status line says how things stand). `who` is "your" on the person's own page. The text
 * names the tokens by name and last four characters, what each is at, and when the first frees up.
 */
export function poolBanner(tokens: readonly { name: string; last4: string; view: PoolView }[], who: string, orchestratorOnVault: boolean): { kind: 'exhausted' | 'held'; text: string } | undefined {
  const views = tokens.map((t) => t.view);
  const kind = poolKind(views);
  if (kind !== 'over' && kind !== 'used-up') return undefined;
  const next = firstFree(views);
  const each = tokens.map((t) => `${t.name} …${t.last4}: ${t.view.why}`).join('; ');
  const wait = `New work waits${next ? ` until the first one frees up (${clock(next)})` : ' (no reset time is known yet)'}`;
  if (kind === 'used-up') {
    return { kind: 'exhausted', text: `${who === 'your' ? 'All your' : `All of ${who}'s`} Claude tokens are used up (${each}). ${wait}${orchestratorOnVault ? ' and the orchestrator is stopped; there is no override' : ''}.` };
  }
  return { kind: 'held', text: `${who === 'your' ? 'Every one of your' : `Every one of ${who}'s`} Claude tokens is at a limit (${each}). ${wait}${orchestratorOnVault ? '; the orchestrator keeps running on the token with the most room until it is used up' : ''}.` };
}

/**
 * The banners one person's page shows (w747): those about the whole system (no `person`) and those about their own pool
 * only. Ben never sees lothsahn's pool banner and lothsahn never sees Ben's. Undefined when none is left.
 */
export function warningsForUser<T extends { person?: string; owners?: boolean }>(all: readonly T[] | undefined, user: string, isOwner = false): T[] | undefined {
  // `owners`: the owners see it too (w904: a GitHub token's banner is for its person and every owner).
  const mine = (all ?? []).filter((w) => !w.person || w.person.toLowerCase() === user.toLowerCase() || (w.owners && isOwner));
  return mine.length ? mine : undefined;
}

// ---------------------------------------------------------------- the dispatcher's reserve

export interface Reserve {
  /** Percent of the weekly window kept back: reservePerDay x days left to the reset (all of it, 7 days, when the reset is unknown). */
  weekly: number;
  /** Percent of the 5-hour window kept back. */
  session: number;
  daysLeft: number;
  /** The meters have never been read: counted as in the reserve (the dispatcher's token before its first reading). */
  noReading: boolean;
  /** Either meter has reached the buffer: runs other than the dispatcher's are eating into it. */
  inReserve: boolean;
  /** The weekly meter has reached its buffer (a no-reading token is in neither: it is inside the reserve for want of a reading). */
  weeklyIn: boolean;
  /** The 5-hour meter has reached its buffer. */
  sessionIn: boolean;
  /** The 5-hour or the weekly meter is at or above the dispatcher's stop line (`stopLine`, w1109): inside the reserve too. */
  stopSession: boolean;
  stopWeekly: boolean;
  /** The stop line in effect (limits.dispatcherStop), percent. */
  stopLine: number;
  /** When the buffer shrinks below what the meters have used (the week's buffer falls 5% a day; the 5-hour window resets), ISO: the later of the windows that hold it. Absent without a reading or reset time. */
  until?: string;
}

/**
 * The buffer a reserved credential keeps for its own role: reservePerDay percent of the weekly window for each day
 * left until that window resets (35 with 7 days, 5 with one day, 0 at the reset), and reserveSession percent of the
 * 5-hour window. Others may use the credential only while weekly < 100 - weekly and session < 100 - session. The role
 * the reserve is for is never held by it: it may run into the reserve up to 100%.
 */
export function reserveOf(u: PlanUsage | undefined, limits: PoolLimits, now: number): Reserve {
  const m = metersOf(u);
  const reset = ms(m.weeklyResetsAt);
  const daysLeft = Number.isFinite(reset) ? Math.min(7, Math.max(0, (reset - now) / 86_400_000)) : 7;
  const weekly = Math.min(100, limits.reservePerDay * daysLeft);
  const session = Math.min(100, limits.reserveSession);
  const noReading = !m.known;
  const weeklyIn = !noReading && m.weekly >= 100 - weekly;
  const sessionIn = !noReading && m.session >= 100 - session;
  // The stop line (w1109): a meter there is inside the reserve whatever the buffer is (the week's buffer is under 5% on its last day).
  const stopLine = limits.dispatcherStop;
  const stopSession = !noReading && m.session >= stopLine;
  const stopWeekly = !noReading && m.weekly >= stopLine;
  const inReserve = noReading || weeklyIn || sessionIn || stopSession || stopWeekly;
  // The week's buffer is perDay x days left, so a weekly meter at w is outside it from (100 - w) / perDay days before the reset on;
  // the 5-hour buffer lasts until that window resets.
  const lifts: number[] = [];
  if (weeklyIn && Number.isFinite(reset)) lifts.push(limits.reservePerDay > 0 && m.weekly < 100 ? reset - ((100 - m.weekly) / limits.reservePerDay) * 86_400_000 : reset);
  if (sessionIn && ms(m.sessionResetsAt) !== Infinity) lifts.push(ms(m.sessionResetsAt));
  // A meter at the stop line lifts only when its own window resets.
  if (stopWeekly && Number.isFinite(reset)) lifts.push(reset);
  if (stopSession && ms(m.sessionResetsAt) !== Infinity) lifts.push(ms(m.sessionResetsAt));
  const until = !noReading && lifts.length ? new Date(Math.max(...lifts)).toISOString() : undefined;
  return { weekly, session, daysLeft, noReading, inReserve, weeklyIn, sessionIn, stopSession, stopWeekly, stopLine, ...(until ? { until } : {}) };
}

/** "in 10 min", "in 3 h 5 min", "in 2 days" for a reset time; the clock time when it is over 2 days off; "its reset time is unknown" without one. */
export function resetIn(iso: string | undefined, now: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return 'at an unknown time';
  if (t - now < 60_000) return 'any moment now';
  const min = Math.round((t - now) / 60_000);
  if (min < 90) return `in ${min} min`;
  if (min < 48 * 60) return `in ${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`;
  return clock(iso);
}

/**
 * Why a token is inside the dispatcher's buffer, naming only the limit or limits that put it there, each with its
 * figure, its buffer and its reset: "5-hour 93% (buffer 20%), resets in 10 min". Both when both are inside. Without
 * a reading, says so. Empty when the token is not inside the buffer.
 */
export function reserveReason(r: Reserve, u: PlanUsage | undefined, now: number): string {
  if (r.noReading) return 'no reading yet (counted as inside the buffer)';
  const m = metersOf(u);
  const one = (name: string, read: number | undefined, buffer: number, resetsAt: string | undefined) =>
    `${name} ${typeof read === 'number' ? `${pc(read)}%` : 'no reading (counted as 50%)'} (buffer ${Math.round(buffer)}%), resets ${resetIn(resetsAt, now)}`;
  // At the stop line (w1109) a meter is named with it rather than with the buffer: "weekly 96% (stop line 95%), resets in 9 h".
  const stop = (name: string, read: number | undefined, resetsAt: string | undefined) => `${name} ${typeof read === 'number' ? `${pc(read)}%` : 'no reading'} (stop line ${r.stopLine}%), resets ${resetIn(resetsAt, now)}`;
  const parts: string[] = [];
  if (r.stopSession) parts.push(stop('5-hour', u?.session?.percent, m.sessionResetsAt));
  else if (r.sessionIn) parts.push(one('5-hour', u?.session?.percent, r.session, m.sessionResetsAt));
  if (r.stopWeekly) parts.push(stop('weekly', u?.weekly?.percent, m.weeklyResetsAt));
  else if (r.weeklyIn) parts.push(one('weekly', u?.weekly?.percent, r.weekly, m.weeklyResetsAt));
  return parts.join('; ');
}
