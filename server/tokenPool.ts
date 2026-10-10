// The Claude token pool (w739, docs/vault.md section 4): which of a person's tokens a run gets, by the plan meters.
//
// Pure functions, no I/O: server/vault.ts feeds them the entries, the meters and the live counts; server/secrets.ts
// decides who may be held. The rules (lothsahn, 2026-10-08/09):
//   - a person's runs use that person's own tokens only (their pool): no shared Claude token, no one else's;
//   - among the pool, the token whose WEEKLY window resets soonest first, the 5-hour reset as the tie-break;
//   - 5-hour meter at or above `sessionHold` (80): no new process on it until that window resets;
//   - weekly at or above `onePerWeekly` (95): one live process at a time;
//   - weekly at or above `retireWeekly` (99): not handed out until the weekly window resets;
//   - a meter at 100 (or a rejection): used up, handed to nobody until it resets;
//   - a person's own orchestrator, when every pool token is past its caps but none is used up, still runs on the one with
//     the most room until it is used up: the caps keep workers from eating the person's own use, they do not lock them out.
// A token with no numbers yet counts as 50% on both meters: it passes every rule and ranks after the ones with a reset.
//
// The dispatcher's reserve (reserveOf) is a different thing: the credential the dispatcher runs on keeps a buffer that
// shrinks as its weekly window runs out, for the dispatcher alone.

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
}

export const POOL_DEFAULTS: Readonly<PoolLimits> = { sessionHold: 80, onePerWeekly: 95, retireWeekly: 99, reservePerDay: 5, reserveSession: 20 };

/** Config vault.pool: the same, with the unit in the name. Anything unset is the default. */
export interface PoolConfig {
  sessionHoldPercent?: number;
  onePerWeeklyPercent?: number;
  retireWeeklyPercent?: number;
  reservePerDayPercent?: number;
  reserveSessionPercent?: number;
}

export const POOL_CONFIG_KEYS = ['sessionHoldPercent', 'onePerWeeklyPercent', 'retireWeeklyPercent', 'reservePerDayPercent', 'reserveSessionPercent'] as const;

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
}

export type PoolState = 'ok' | 'held' | 'one-at-a-time' | 'retired' | 'exhausted';

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
}

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

/** The state of a token under the limits, for a worker, a standing agent or the ops worker (the strictest reading). */
export function judge(t: PoolToken, limits: PoolLimits): PoolView {
  const m = metersOf(t.usage);
  const base = { session: m.session, weekly: m.weekly, known: m.known, sessionResetsAt: m.sessionResetsAt, weeklyResetsAt: m.weeklyResetsAt };
  const numbers = `5-hour ${pc(m.session)}%, weekly ${pc(m.weekly)}%`;
  if (m.weekly >= 100 || m.session >= 100) {
    const until = m.weekly >= 100 ? m.weeklyResetsAt : m.sessionResetsAt;
    return { ...base, state: 'exhausted', why: `${numbers}: used up until ${clock(until)}`, ...(until ? { until } : {}) };
  }
  if (m.weekly >= limits.retireWeekly) return { ...base, state: 'retired', why: `weekly ${pc(m.weekly)}% (>= ${limits.retireWeekly}): retired until ${clock(m.weeklyResetsAt)}`, ...(m.weeklyResetsAt ? { until: m.weeklyResetsAt } : {}) };
  if (m.session >= limits.sessionHold) return { ...base, state: 'held', why: `5-hour ${pc(m.session)}% (>= ${limits.sessionHold}): held until ${clock(m.sessionResetsAt)}`, ...(m.sessionResetsAt ? { until: m.sessionResetsAt } : {}) };
  // From onePerWeekly up to retireWeekly a token still works, one job at a time (w747: it is not over its cap, and says so):
  // how much is left before it stops, and whether its one slot is taken now.
  const left = Math.max(0, Math.round((limits.retireWeekly - m.weekly) * 10) / 10);
  const oneJob = m.weekly >= limits.onePerWeekly ? `one job at a time until ${limits.retireWeekly}%: ${left}% left before it stops` : '';
  if (oneJob && t.others >= 1) {
    return { ...base, state: 'one-at-a-time', why: `weekly ${pc(m.weekly)}%, ${oneJob}; the slot is taken now (${t.others} running)` };
  }
  return { ...base, state: 'ok', why: m.known ? `${numbers}${oneJob ? `; ${oneJob}; the slot is free` : ''}` : 'no numbers yet (counted as 50%)' };
}

/**
 * What a pool can do for a new job, from its tokens' states: `serving` (some token is ok: under every limit, or in its
 * one-job-at-a-time zone with the slot free), `slot-taken` (none is ok, but a token that still works is busy with its one
 * job: a new job starts when that finishes), `over` (every token is held, retired or used up: new work waits for a reset) and
 * `used-up` (every token is at 100). Only `over` and `used-up` are "over the caps" (the dashboard banner, w747).
 */
export type PoolKind = 'serving' | 'slot-taken' | 'over' | 'used-up';
export function poolKind(views: readonly PoolView[]): PoolKind {
  if (!views.length || views.some((v) => v.state === 'ok')) return 'serving';
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

/** Room left on the fuller meter (100 minus it), for the over-cap order. */
const room = (t: PoolToken) => {
  const m = metersOf(t.usage);
  return 100 - Math.max(m.session, m.weekly);
};

export interface PoolPick {
  /** The token, when the run may start. */
  token?: PoolToken;
  /** A normal pick, or the orchestrator's use-it-up of a token past its caps. */
  how?: 'normal' | 'over-cap';
  /** Every token's state, by id. */
  views: Map<string, PoolView>;
  /** The pool has tokens and none may serve this run now: why, and when the first one frees up (ISO). */
  held?: { why: string; next?: string };
}

/**
 * The token for a run over a person's pool (`tokens` are the pool; the caller keeps other people's out). `orchestrator`:
 * a person's own orchestrator, whose pool is used up past the caps. `sticky`: the id the session ran on last, kept while
 * it still passes. No tokens at all is the caller's business (the transition: today's account), not a hold.
 */
export function pickPool(tokens: readonly PoolToken[], o: { orchestrator: boolean; limits: PoolLimits; sticky?: string }): PoolPick {
  const views = new Map(tokens.map((t) => [t.id, judge(t, o.limits)] as const));
  const ok = (t: PoolToken) => views.get(t.id)!.state === 'ok';
  const kept = o.sticky ? tokens.find((t) => t.id === o.sticky && ok(t)) : undefined;
  const best = kept ?? [...tokens].filter(ok).sort(bySoonestReset)[0];
  if (best) return { token: best, how: 'normal', views };
  if (o.orchestrator) {
    const capped = tokens.filter((t) => ['held', 'one-at-a-time', 'retired'].includes(views.get(t.id)!.state));
    const keptCapped = o.sticky ? capped.find((t) => t.id === o.sticky) : undefined;
    const use = keptCapped ?? [...capped].sort((a, b) => room(b) - room(a) || bySoonestReset(a, b))[0];
    if (use) return { token: use, how: 'over-cap', views };
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
export function warningsForUser<T extends { person?: string }>(all: readonly T[] | undefined, user: string): T[] | undefined {
  const mine = (all ?? []).filter((w) => !w.person || w.person.toLowerCase() === user.toLowerCase());
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
  const inReserve = noReading || weeklyIn || sessionIn;
  return { weekly, session, daysLeft, noReading, inReserve, weeklyIn, sessionIn };
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
  const parts: string[] = [];
  if (r.sessionIn) parts.push(one('5-hour', u?.session?.percent, r.session, m.sessionResetsAt));
  if (r.weeklyIn) parts.push(one('weekly', u?.weekly?.percent, r.weekly, m.weeklyResetsAt));
  return parts.join('; ');
}
