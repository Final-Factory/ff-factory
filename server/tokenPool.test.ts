import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POOL_DEFAULTS, bySoonestReset, checkPoolConfig, clock, heldReason, judge, metersOf, pickPool, poolLimits, reserveOf, type PoolToken } from './tokenPool.ts';
import type { PlanUsage } from '../shared/types.ts';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** A token with meters: session/weekly percent, resets in hours (session) and days (weekly) from NOW. */
const tok = (name: string, o: { session?: number; weekly?: number; sessionHours?: number; weeklyDays?: number; others?: number; none?: boolean; owner?: string } = {}): PoolToken => ({
  id: name,
  name,
  fingerprint: name,
  owner: o.owner ?? 'ben',
  others: o.others ?? 0,
  usage: o.none
    ? undefined
    : ({
        available: true,
        asOf: iso(NOW),
        models: [],
        session: { label: '5-hour', percent: o.session ?? 10, ...(o.sessionHours !== undefined ? { resetsAt: iso(NOW + o.sessionHours * 3_600_000) } : {}) },
        weekly: { label: 'weekly', percent: o.weekly ?? 20, ...(o.weeklyDays !== undefined ? { resetsAt: iso(NOW + o.weeklyDays * DAY) } : {}) },
      } satisfies PlanUsage),
});

const L = POOL_DEFAULTS;

test('pool limits: defaults 80 / 95 / 99 and 5% a day + 20%, config overrides, bad values refused', () => {
  assert.deepEqual(poolLimits(undefined), { sessionHold: 80, onePerWeekly: 95, retireWeekly: 99, reservePerDay: 5, reserveSession: 20 });
  assert.equal(poolLimits({ vault: { pool: { sessionHoldPercent: 70, reservePerDayPercent: 8 } } }).sessionHold, 70);
  assert.equal(poolLimits({ vault: { pool: { sessionHoldPercent: 70, reservePerDayPercent: 8 } } }).reservePerDay, 8);
  assert.equal(poolLimits({ vault: { pool: { sessionHoldPercent: 700 } } }).sessionHold, 80, 'a value out of range is the default');
  assert.equal(checkPoolConfig(undefined), undefined);
  assert.equal(checkPoolConfig({ sessionHoldPercent: 0, retireWeeklyPercent: 100 }), undefined, '0 and 100 are allowed');
  assert.match(checkPoolConfig({ sessionHoldPercent: 101 }) ?? '', /percent from 0 to 100/);
  assert.match(checkPoolConfig({ retireWeeklyPercent: -1 }) ?? '', /percent from 0 to 100/);
  assert.match(checkPoolConfig({ onePerWeeklyPercent: 'x' }) ?? '', /percent from 0 to 100/);
  assert.match(checkPoolConfig({ onePerWeeklyPercent: 99.5 }) ?? '', /above retireWeeklyPercent/, '99.5 is above the default 99');
  assert.match(checkPoolConfig({ onePerWeeklyPercent: 90, retireWeeklyPercent: 85 }) ?? '', /above retireWeeklyPercent/);
  assert.match(checkPoolConfig({ nope: 1 }) ?? '', /not a setting/);
  assert.match(checkPoolConfig([] as never) ?? '', /is an object/);
  // A hand-edited file that breaks the order is read safely.
  assert.equal(poolLimits({ vault: { pool: { onePerWeeklyPercent: 97, retireWeeklyPercent: 90 } } }).onePerWeekly, 90);
});

test('judge: ok, held at the 5-hour limit, one at a time at 95% weekly, retired at 99%, exhausted at 100, no numbers counted as 50%', () => {
  assert.equal(judge(tok('a', { session: 79.9, weekly: 94.9 }), L).state, 'ok');
  const held = judge(tok('a', { session: 80, weekly: 10, sessionHours: 2 }), L);
  assert.equal(held.state, 'held');
  assert.match(held.why, /5-hour 80% \(>= 80\): held until \w{3} \d\d:\d\dZ/);
  assert.equal(held.until, iso(NOW + 2 * 3_600_000));
  assert.equal(judge(tok('a', { weekly: 95, others: 0 }), L).state, 'ok', 'one at a time: the first process is fine');
  const one = judge(tok('a', { weekly: 95, others: 1 }), L);
  assert.equal(one.state, 'one-at-a-time');
  assert.match(one.why, /1 running/);
  assert.equal(judge(tok('a', { weekly: 99, weeklyDays: 2 }), L).state, 'retired');
  assert.equal(judge(tok('a', { weekly: 99 }), L).until, undefined);
  assert.equal(judge(tok('a', { weekly: 100, weeklyDays: 2 }), L).state, 'exhausted');
  assert.equal(judge(tok('a', { session: 100, sessionHours: 1 }), L).state, 'exhausted');
  // Retired outranks held and one-at-a-time; used up outranks retired.
  assert.equal(judge(tok('a', { session: 85, weekly: 99.5 }), L).state, 'retired');
  const none = judge(tok('a', { none: true }), L);
  assert.equal(none.state, 'ok');
  assert.equal(none.known, false);
  assert.equal(none.session, 50);
  assert.match(none.why, /no numbers yet/);
  assert.deepEqual(metersOf({ available: false, asOf: '', models: [] }), { session: 50, weekly: 50, known: false });
  // The limits are the config's.
  const strict = { ...L, sessionHold: 50 };
  assert.equal(judge(tok('a', { session: 60 }), strict).state, 'held');
});

test('order: the weekly reset that comes first, then the 5-hour reset, then the name; no reset time last', () => {
  const a = tok('a', { weeklyDays: 5, sessionHours: 4 });
  const b = tok('b', { weeklyDays: 2, sessionHours: 4 });
  const c = tok('c', { weeklyDays: 2, sessionHours: 1 });
  const d = tok('d', { none: true });
  const e = tok('e');
  assert.deepEqual([a, b, c, d, e].sort(bySoonestReset).map((t) => t.name), ['c', 'b', 'a', 'd', 'e'], 'c before b on the 5-hour tie-break; the ones with no reset last, by name');
  assert.equal(bySoonestReset(tok('x', { weeklyDays: 1 }), tok('y', { weeklyDays: 1 })), -1, 'equal resets: the name');
});

test('pickPool: the soonest weekly reset is drained first; a token past its cap is skipped for the next', () => {
  const tokens = [tok('late', { weeklyDays: 6 }), tok('soon', { weeklyDays: 1 }), tok('mid', { weeklyDays: 3 })];
  const p = pickPool(tokens, { orchestrator: false, limits: L });
  assert.equal(p.token?.name, 'soon');
  assert.equal(p.how, 'normal');
  // The soonest one reaches the session cap: the next soonest.
  tokens[1] = tok('soon', { weeklyDays: 1, session: 82, sessionHours: 3 });
  assert.equal(pickPool(tokens, { orchestrator: false, limits: L }).token?.name, 'mid');
  // The window resets (its meter is low again): the soonest again.
  tokens[1] = tok('soon', { weeklyDays: 1, session: 5, sessionHours: 5 });
  assert.equal(pickPool(tokens, { orchestrator: false, limits: L }).token?.name, 'soon');
});

test('pickPool: one at a time at 95% weekly; retired at 99%; a token with no numbers still serves, last', () => {
  const busy = tok('busy', { weekly: 96, weeklyDays: 1, others: 1 });
  const other = tok('other', { weekly: 30, weeklyDays: 4 });
  assert.equal(pickPool([busy, other], { orchestrator: false, limits: L }).token?.name, 'other', 'busy has a process: the next one');
  assert.equal(pickPool([tok('busy', { weekly: 96, weeklyDays: 1, others: 0 }), other], { orchestrator: false, limits: L }).token?.name, 'busy', 'idle at 96%: it is the soonest, and may take one process');
  assert.equal(pickPool([tok('r', { weekly: 99, weeklyDays: 1 }), other], { orchestrator: false, limits: L }).token?.name, 'other', 'retired');
  const p = pickPool([tok('fresh', { none: true }), tok('known', { weeklyDays: 5 })], { orchestrator: false, limits: L });
  assert.equal(p.token?.name, 'known', 'the one with a reset time first');
  assert.equal(pickPool([tok('fresh', { none: true })], { orchestrator: false, limits: L }).token?.name, 'fresh', 'a token with no numbers yet is served');
});

test('pickPool: a session keeps its token while it passes, and moves off when it does not', () => {
  const a = tok('a', { weeklyDays: 5 });
  const b = tok('b', { weeklyDays: 1 });
  assert.equal(pickPool([a, b], { orchestrator: false, limits: L, sticky: 'a' }).token?.name, 'a', 'sticky: a, though b resets sooner');
  const capped = tok('a', { weeklyDays: 5, session: 85, sessionHours: 2 });
  assert.equal(pickPool([capped, b], { orchestrator: false, limits: L, sticky: 'a' }).token?.name, 'b', 'past the 5-hour cap: moved to the next');
  const retired = tok('a', { weeklyDays: 5, weekly: 99 });
  assert.equal(pickPool([retired, b], { orchestrator: false, limits: L, sticky: 'a' }).token?.name, 'b');
  // One at a time counts the other sessions only: the sticky session's own process is not "another".
  const oneSelf = tok('a', { weeklyDays: 5, weekly: 96, others: 0 });
  assert.equal(pickPool([oneSelf, b], { orchestrator: false, limits: L, sticky: 'a' }).token?.name, 'a');
  assert.equal(pickPool([tok('a', { weeklyDays: 5, weekly: 96, others: 1 }), b], { orchestrator: false, limits: L, sticky: 'a' }).token?.name, 'b');
});

test('pickPool: every token capped holds a worker with the reason and the first reset; the orchestrator uses the pool up', () => {
  const a = tok('a', { session: 90, sessionHours: 2, weekly: 40, weeklyDays: 3 });
  const b = tok('b', { session: 85, sessionHours: 4, weekly: 30, weeklyDays: 5 });
  const worker = pickPool([a, b], { orchestrator: false, limits: L });
  assert.equal(worker.token, undefined);
  assert.match(worker.held?.why ?? '', /2 tokens: all over their caps or used up, the first frees up \w{3} \d\d:\d\dZ/);
  assert.equal(worker.held?.next, iso(NOW + 2 * 3_600_000), 'the first token to free up');
  // The orchestrator still runs: the token with the most room (b: max meter 85 vs a: 90), over its cap.
  const orch = pickPool([a, b], { orchestrator: true, limits: L });
  assert.equal(orch.token?.name, 'b');
  assert.equal(orch.how, 'over-cap');
  // Equal room: the soonest reset.
  const x = tok('x', { session: 90, weeklyDays: 4, sessionHours: 1 });
  const y = tok('y', { session: 90, weeklyDays: 2, sessionHours: 1 });
  assert.equal(pickPool([x, y], { orchestrator: true, limits: L }).token?.name, 'y');
  // One at a time does not bind the orchestrator; retired does not stop it; both are "capped".
  const one = tok('one', { weekly: 97, weeklyDays: 2, others: 3 });
  assert.equal(pickPool([one], { orchestrator: true, limits: L }).token?.name, 'one');
  assert.equal(pickPool([tok('ret', { weekly: 99.5, weeklyDays: 2 })], { orchestrator: true, limits: L }).how, 'over-cap');
  // Its own sticky token stays while capped.
  assert.equal(pickPool([a, b], { orchestrator: true, limits: L, sticky: 'a' }).token?.name, 'a');
});

test('pickPool: used up is used up for everyone; a pool with one token left serves the orchestrator', () => {
  const dead = tok('dead', { weekly: 100, weeklyDays: 2 });
  const dead2 = tok('dead2', { session: 100, sessionHours: 1 });
  for (const orchestrator of [false, true]) {
    const p = pickPool([dead, dead2], { orchestrator, limits: L });
    assert.equal(p.token, undefined, `orchestrator=${orchestrator}`);
    assert.match(p.held?.why ?? '', /all used up/);
    assert.equal(p.held?.next, iso(NOW + 1 * 3_600_000), 'the 5-hour window frees first');
  }
  const capped = tok('capped', { session: 91, sessionHours: 1 });
  assert.equal(pickPool([dead, capped], { orchestrator: true, limits: L }).token?.name, 'capped');
  assert.equal(pickPool([dead, capped], { orchestrator: false, limits: L }).token, undefined);
  assert.equal(pickPool([], { orchestrator: true, limits: L }).token, undefined, 'no tokens: the caller decides (the transition)');
  assert.match(heldReason([dead], new Map([[dead.id, judge(dead, L)]])).why, /its token is all used up/);
  assert.equal(clock(undefined), 'its next reset');
  assert.equal(clock('2026-10-09T14:05:00Z'), 'Fri 14:05Z');
});

test("the dispatcher's reserve: 5% a day to the weekly reset and 20% of the 5-hour window, 0 at the reset", () => {
  const u = (weekly: number, session: number, days?: number): PlanUsage => ({ available: true, asOf: '', models: [], weekly: { label: 'w', percent: weekly, ...(days !== undefined ? { resetsAt: iso(NOW + days * DAY) } : {}) }, session: { label: 's', percent: session } });
  const r7 = reserveOf(u(41, 12, 7), L, NOW);
  assert.equal(r7.weekly, 35);
  assert.equal(r7.session, 20);
  assert.equal(r7.inReserve, false);
  assert.equal(reserveOf(u(41, 12, 5), L, NOW).weekly, 25);
  assert.equal(reserveOf(u(41, 12, 1), L, NOW).weekly, 5);
  assert.equal(reserveOf(u(41, 12, 0), L, NOW).weekly, 0);
  assert.equal(reserveOf(u(41, 12, 9), L, NOW).weekly, 35, 'never more than a week');
  assert.equal(reserveOf(u(41, 12, -1), L, NOW).weekly, 0, 'a reset in the past: nothing kept');
  assert.equal(reserveOf(u(41, 12), L, NOW).weekly, 35, 'no reset time: the whole week');
  // Inside the reserve: weekly at or past 100 - reserve, or the 5-hour window at or past 80.
  assert.equal(reserveOf(u(65, 12, 7), L, NOW).inReserve, true, '65 >= 100 - 35');
  assert.equal(reserveOf(u(64, 12, 7), L, NOW).inReserve, false);
  assert.equal(reserveOf(u(64, 12, 1), L, NOW).inReserve, false, 'near the reset the reserve is small');
  assert.equal(reserveOf(u(96, 12, 1), L, NOW).inReserve, true);
  assert.equal(reserveOf(u(10, 80, 7), L, NOW).inReserve, true, 'the 5-hour side');
  // No reading yet: counted as inside the reserve.
  const none = reserveOf(undefined, L, NOW);
  assert.equal(none.noReading, true);
  assert.equal(none.inReserve, true);
  // The per-day figure is the config's.
  assert.equal(reserveOf(u(41, 12, 5), { ...L, reservePerDay: 2 }, NOW).weekly, 10);
});
