import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POOL_DEFAULTS, MIN_HOURS_TO_RESET, bySoonestReset, byScore, scoreOf, checkPoolConfig, clock, heldReason, judge, metersOf, poolLabel, usable, pickPool, poolBanner, poolKind, poolLimits, reserveOf, reserveReason, resetIn, warningsForUser, type PoolToken } from './tokenPool.ts';
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

/** pickPool at the test clock (the tokens' resets are relative to NOW). */
const pickAt = (tokens: PoolToken[], o: { orchestrator: boolean; limits: typeof L; sticky?: string }) => pickPool(tokens, { ...o, now: NOW });

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
  assert.equal(judge(tok('a', { weekly: 95, others: 0 }), L).state, 'one-at-a-time', 'one at a time, slot free: still that state (w979)');
  assert.equal(usable(judge(tok('a', { weekly: 95, others: 0 }), L)), true, 'but the first process is fine');
  const one = judge(tok('a', { weekly: 95, others: 1 }), L);
  assert.equal(one.state, 'one-at-a-time');
  assert.equal(usable(one), false);
  assert.equal(one.why, 'weekly 95%, one job at a time; its slot is taken (1 running)');
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

test('pickPool: the highest score is picked; a token past its cap is skipped for the next', () => {
  const tokens = [tok('late', { weeklyDays: 6 }), tok('soon', { weeklyDays: 1 }), tok('mid', { weeklyDays: 3 })];
  const p = pickAt(tokens, { orchestrator: false, limits: L });
  assert.equal(p.token?.name, 'soon');
  assert.equal(p.how, 'normal');
  // The soonest one reaches the session cap: the next soonest.
  tokens[1] = tok('soon', { weeklyDays: 1, session: 82, sessionHours: 3 });
  assert.equal(pickAt(tokens, { orchestrator: false, limits: L }).token?.name, 'mid');
  // The window resets (its meter is low again): the best score again.
  tokens[1] = tok('soon', { weeklyDays: 1, session: 5, sessionHours: 5 });
  assert.equal(pickAt(tokens, { orchestrator: false, limits: L }).token?.name, 'soon');
});

test('pickPool: one at a time at 95% weekly; retired at 99%; a token with no numbers still serves, last', () => {
  const busy = tok('busy', { weekly: 96, weeklyDays: 1, others: 1 });
  const other = tok('other', { weekly: 30, weeklyDays: 4 });
  assert.equal(pickAt([busy, other], { orchestrator: false, limits: L }).token?.name, 'other', 'busy has a process: the next one');
  assert.equal(pickAt([tok('busy', { weekly: 96, weeklyDays: 1, others: 0 })], { orchestrator: false, limits: L }).token?.name, 'busy', 'idle at 96%: it may take one process');
  assert.equal(pickAt([tok('r', { weekly: 99, weeklyDays: 1 }), other], { orchestrator: false, limits: L }).token?.name, 'other', 'retired');
  const p = pickAt([tok('fresh', { none: true }), tok('known', { weeklyDays: 5 })], { orchestrator: false, limits: L });
  assert.equal(p.token?.name, 'known', 'the one with a reset time first');
  assert.equal(pickAt([tok('fresh', { none: true })], { orchestrator: false, limits: L }).token?.name, 'fresh', 'a token with no numbers yet is served');
});

test('pickPool: a session keeps its token while it passes, and moves off when it does not', () => {
  const a = tok('a', { weeklyDays: 5 });
  const b = tok('b', { weeklyDays: 1 });
  assert.equal(pickAt([a, b], { orchestrator: false, limits: L, sticky: 'a' }).token?.name, 'a', 'sticky: a, though b resets sooner');
  const capped = tok('a', { weeklyDays: 5, session: 85, sessionHours: 2 });
  assert.equal(pickAt([capped, b], { orchestrator: false, limits: L, sticky: 'a' }).token?.name, 'b', 'past the 5-hour cap: moved to the next');
  const retired = tok('a', { weeklyDays: 5, weekly: 99 });
  assert.equal(pickAt([retired, b], { orchestrator: false, limits: L, sticky: 'a' }).token?.name, 'b');
  // One at a time counts the other sessions only: the sticky session's own process is not "another".
  const oneSelf = tok('a', { weeklyDays: 5, weekly: 96, others: 0 });
  assert.equal(pickAt([oneSelf, b], { orchestrator: false, limits: L, sticky: 'a' }).token?.name, 'a');
  assert.equal(pickAt([tok('a', { weeklyDays: 5, weekly: 96, others: 1 }), b], { orchestrator: false, limits: L, sticky: 'a' }).token?.name, 'b');
});

test('pickPool: every token capped holds a worker with the reason and the first reset; the orchestrator uses the pool up', () => {
  const a = tok('a', { session: 90, sessionHours: 2, weekly: 40, weeklyDays: 3 });
  const b = tok('b', { session: 85, sessionHours: 4, weekly: 30, weeklyDays: 5 });
  const worker = pickAt([a, b], { orchestrator: false, limits: L });
  assert.equal(worker.token, undefined);
  assert.match(worker.held?.why ?? '', /^every token is at a limit \(a: 5-hour 90% \(>= 80\): held until Fri 14:00Z; b: .*\): the first frees up Fri 14:00Z$/);
  assert.equal(worker.held?.next, iso(NOW + 2 * 3_600_000), 'the first token to free up');
  // The orchestrator still runs: the token with the most room (b: max meter 85 vs a: 90), over its cap.
  const orch = pickAt([a, b], { orchestrator: true, limits: L });
  assert.equal(orch.token?.name, 'b');
  assert.equal(orch.how, 'over-cap');
  // Equal room: the soonest reset.
  const x = tok('x', { session: 90, weeklyDays: 4, sessionHours: 1 });
  const y = tok('y', { session: 90, weeklyDays: 2, sessionHours: 1 });
  assert.equal(pickAt([x, y], { orchestrator: true, limits: L }).token?.name, 'y');
  // One at a time does not bind the orchestrator; retired does not stop it; both are "capped".
  const one = tok('one', { weekly: 97, weeklyDays: 2, others: 3 });
  assert.equal(pickAt([one], { orchestrator: true, limits: L }).token?.name, 'one');
  assert.equal(pickAt([tok('ret', { weekly: 99.5, weeklyDays: 2 })], { orchestrator: true, limits: L }).how, 'over-cap');
  // Its own sticky token stays while capped.
  assert.equal(pickAt([a, b], { orchestrator: true, limits: L, sticky: 'a' }).token?.name, 'a');
});

test('pickPool: used up is used up for everyone; a pool with one token left serves the orchestrator', () => {
  const dead = tok('dead', { weekly: 100, weeklyDays: 2 });
  const dead2 = tok('dead2', { session: 100, sessionHours: 1 });
  for (const orchestrator of [false, true]) {
    const p = pickAt([dead, dead2], { orchestrator, limits: L });
    assert.equal(p.token, undefined, `orchestrator=${orchestrator}`);
    assert.match(p.held?.why ?? '', /^every token is used up \(/);
    assert.equal(p.held?.next, iso(NOW + 1 * 3_600_000), 'the 5-hour window frees first');
  }
  const capped = tok('capped', { session: 91, sessionHours: 1 });
  assert.equal(pickAt([dead, capped], { orchestrator: true, limits: L }).token?.name, 'capped');
  assert.equal(pickAt([dead, capped], { orchestrator: false, limits: L }).token, undefined);
  assert.equal(pickAt([], { orchestrator: true, limits: L }).token, undefined, 'no tokens: the caller decides (the transition)');
  assert.match(heldReason([dead], new Map([[dead.id, judge(dead, L)]])).why, /^every token is used up \(dead: /);
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

test("w828: reserveOf says WHICH limit put the token inside its buffer, and reserveReason names only that one", () => {
  const u = (weekly: number, session: number, days = 5.2): PlanUsage => ({ available: true, asOf: '', models: [], weekly: { label: 'w', percent: weekly, resetsAt: iso(NOW + days * DAY) }, session: { label: 's', percent: session, resetsAt: iso(NOW + 10 * 60_000) } });
  // Session only: the live case, weekly 51% (buffer 26%) and 5-hour 93% (buffer 20%).
  const sessionOnly = reserveOf(u(51, 93), L, NOW);
  assert.deepEqual([sessionOnly.inReserve, sessionOnly.sessionIn, sessionOnly.weeklyIn], [true, true, false]);
  assert.equal(Math.round(sessionOnly.weekly), 26);
  assert.equal(reserveReason(sessionOnly, u(51, 93), NOW), '5-hour 93% (buffer 20%), resets in 10 min');
  // Weekly only.
  const weeklyOnly = reserveOf(u(80, 12), L, NOW);
  assert.deepEqual([weeklyOnly.inReserve, weeklyOnly.sessionIn, weeklyOnly.weeklyIn], [true, false, true]);
  assert.equal(reserveReason(weeklyOnly, u(80, 12), NOW), `weekly 80% (buffer 26%), resets ${clock(iso(NOW + 5.2 * DAY))}`);
  // Both.
  const both = reserveOf(u(80, 93), L, NOW);
  assert.deepEqual([both.sessionIn, both.weeklyIn], [true, true]);
  assert.equal(reserveReason(both, u(80, 93), NOW), `5-hour 93% (buffer 20%), resets in 10 min; weekly 80% (buffer 26%), resets ${clock(iso(NOW + 5.2 * DAY))}`);
  // Neither: not in the buffer, no reason.
  const calm = reserveOf(u(51, 12), L, NOW);
  assert.deepEqual([calm.inReserve, calm.sessionIn, calm.weeklyIn], [false, false, false]);
  assert.equal(reserveReason(calm, u(51, 12), NOW), '');
  // No reading: inside for want of a reading, neither limit blamed, no figure shown.
  const none = reserveOf(undefined, L, NOW);
  assert.deepEqual([none.inReserve, none.noReading, none.sessionIn, none.weeklyIn], [true, true, false, false]);
  assert.equal(reserveReason(none, undefined, NOW), 'no reading yet (counted as inside the buffer)');
});

test('w828: resetIn reads a reset as minutes, hours, or a clock time, and owns up to an unknown one', () => {
  const at = (ms: number) => iso(NOW + ms);
  assert.equal(resetIn(at(10 * 60_000), NOW), 'in 10 min');
  assert.equal(resetIn(at(30_000), NOW), 'any moment now');
  assert.equal(resetIn(at(-5 * 60_000), NOW), 'any moment now', 'already past: the reading is old, the reset is due');
  assert.equal(resetIn(at(3 * 3_600_000 + 5 * 60_000), NOW), 'in 3 h 5 min');
  assert.equal(resetIn(at(2 * 3_600_000), NOW), 'in 2 h');
  assert.equal(resetIn(at(3 * DAY), NOW), clock(at(3 * DAY)));
  assert.equal(resetIn(undefined, NOW), 'at an unknown time');
});

test("w979: the label is pool:ok below the one-at-a-time cap, pool:one-at-a-time in the band (slot free or taken), and the rarer states keep their names", () => {
  const v = (o: Parameters<typeof tok>[1]) => judge(tok('a', o), L, NOW);
  const ok = v({ weekly: 94, others: 3, session: 10 });
  assert.equal(poolLabel(ok), 'pool:ok');
  assert.equal(ok.shown, '5-hour 10%, weekly 94%', 'the two meters stay, nothing calculated');
  // One at a time with its slot FREE: no longer called ok (lothsahn found that misleading).
  const free = v({ weekly: 95, others: 0, session: 10 });
  assert.equal(free.state, 'one-at-a-time');
  assert.equal(free.slotTaken, false);
  assert.equal(usable(free), true, 'a new job still takes the free slot');
  assert.equal(poolLabel(free), 'pool:one-at-a-time');
  assert.equal(free.shown, '5-hour 10%, weekly 95%');
  // ... and with its slot TAKEN: the same label, and not usable.
  const taken = v({ weekly: 98.2, others: 2 });
  assert.equal(poolLabel(taken), 'pool:one-at-a-time');
  assert.equal(taken.slotTaken, true);
  assert.equal(usable(taken), false);
  for (const view of [ok, free, taken]) assert.doesNotMatch(`${poolLabel(view)} ${view.shown}`, /score|%\/day|left over|before it stops|slot is|room/, 'no calculation, no slot wording');
  // The rarer states: the same pool:<state> form.
  assert.equal(poolLabel(v({ session: 85, sessionHours: 2 })), 'pool:held');
  assert.equal(poolLabel(v({ weekly: 99.5, weeklyDays: 2 })), 'pool:retired');
  assert.equal(poolLabel(v({ weekly: 100, weeklyDays: 2 })), 'pool:exhausted');
  assert.equal(poolLabel(judge(withReserve(tok('r', { weekly: 97, weeklyDays: 4 })), L, NOW)), 'pool:reserved');
  assert.equal(poolLabel(ok, true), 'pool:ok priority');
  assert.equal(poolLabel(free, true), 'pool:one-at-a-time priority');
  // Under the one-job limit nothing changes; the limits are the config's.
  assert.equal(judge(tok('a', { weekly: 90, others: 1 }), { ...L, onePerWeekly: 90, retireWeekly: 96 }, NOW).state, 'one-at-a-time');
  assert.equal(judge(tok('a', { weekly: 89, others: 1 }), { ...L, onePerWeekly: 90, retireWeekly: 96 }, NOW).state, 'ok');
});

test('w747: poolKind and poolBanner: the banner only when every token is held, retired or used up', () => {
  const v = (t: PoolToken) => judge(t, L);
  const lab = (name: string, t: PoolToken) => ({ name, last4: name.slice(-4), view: v(t) });
  // lothsahn's pool on 2026-10-09: one token, 95% weekly, one agent running: busy with its one job, not over any cap.
  const lothsahn = [lab('host-lothsahn-claude-1', tok('t1', { weekly: 95, others: 1 }))];
  assert.equal(poolKind(lothsahn.map((x) => x.view)), 'slot-taken');
  assert.equal(poolBanner(lothsahn, 'your', false), undefined, 'no top banner for it');
  // the same token with its slot free serves
  assert.equal(poolKind([v(tok('t1', { weekly: 95, others: 0 }))]), 'serving');
  assert.equal(poolBanner([lab('t1', tok('t1', { weekly: 95 }))], 'your', false), undefined);
  // one ok token among capped ones: never a banner
  const mixed = [lab('aaaa', tok('a', { session: 90, sessionHours: 2 })), lab('bbbb', tok('b', { weekly: 99.5, weeklyDays: 2 })), lab('cccc', tok('c'))];
  assert.equal(poolKind(mixed.map((x) => x.view)), 'serving');
  assert.equal(poolBanner(mixed, 'your', false), undefined);
  // a held token and one busy with its one job: new work waits for the running one, or a reset: still not "over"
  const busy = [lab('aaaa', tok('a', { session: 90, sessionHours: 2 })), lab('bbbb', tok('b', { weekly: 96, others: 1 }))];
  assert.equal(poolKind(busy.map((x) => x.view)), 'slot-taken');
  assert.equal(poolBanner(busy, 'your', false), undefined);
  // every token held or retired: the banner, in plain words, with the first reset
  const over = [lab('aaaa', tok('a', { session: 90, sessionHours: 2, weekly: 30 })), lab('bbbb', tok('b', { weekly: 99.5, weeklyDays: 2 }))];
  assert.equal(poolKind(over.map((x) => x.view)), 'over');
  const b = poolBanner(over, 'your', false)!;
  assert.equal(b.kind, 'held');
  assert.match(b.text, /^Every one of your Claude tokens is at a limit \(aaaa …aaaa: 5-hour 90% \(>= 80\): held until Fri 14:00Z; bbbb …bbbb: weekly 99\.5% \(>= 99\): retired until .*\)\. New work waits until the first one frees up \(Fri 14:00Z\)\.$/);
  assert.match(poolBanner(over, 'ben', true)!.text, /^Every one of ben's Claude tokens is at a limit .*the orchestrator keeps running on the token with the most room until it is used up\.$/);
  // every token used up: the other kind
  const dead = [lab('aaaa', tok('a', { weekly: 100, weeklyDays: 2 })), lab('bbbb', tok('b', { session: 100, sessionHours: 1 }))];
  assert.equal(poolKind(dead.map((x) => x.view)), 'used-up');
  const d = poolBanner(dead, 'your', true)!;
  assert.equal(d.kind, 'exhausted');
  assert.match(d.text, /^All your Claude tokens are used up .*New work waits until the first one frees up \(Fri 13:00Z\) and the orchestrator is stopped; there is no override\.$/);
  assert.equal(poolKind([]), 'serving', 'no tokens is the transition, never a banner');
  assert.equal(poolBanner([], 'your', false), undefined);
});

test('w747: the held reason of a busy one-job token says it is not over anything', () => {
  const t = tok('a', { weekly: 96, others: 1 });
  const r = heldReason([t], new Map([[t.id, judge(t, L)]]));
  assert.equal(r.why, 'no token is free for a new job right now (a: weekly 96%, one job at a time; its slot is taken (1 running)): a new job starts when the running one finishes');
  assert.doesNotMatch(r.why, /every token is at a limit|over its caps|used up/);
  // with a held neighbour the reset is named as the other way out
  const h = tok('h', { session: 90, sessionHours: 2 });
  assert.match(heldReason([t, h], new Map([[t.id, judge(t, L)], [h.id, judge(h, L)]])).why, /a new job starts when the running one finishes, or when the first limit lifts Fri 14:00Z$/);
});

test('w747: a pool banner is for its own person only; the whole-system banners are for everyone', () => {
  const all = [
    { id: 'pool:lothsahn', person: 'lothsahn', text: 'x' },
    { id: 'pool:ben', person: 'ben', text: 'y' },
    { id: 'reserve:k', text: 'the dispatcher token' },
  ];
  assert.deepEqual(warningsForUser(all, 'ben')?.map((w) => w.id), ['pool:ben', 'reserve:k'], 'ben never sees lothsahn\'s');
  assert.deepEqual(warningsForUser(all, 'Lothsahn')?.map((w) => w.id), ['pool:lothsahn', 'reserve:k'], 'user ids compare without case; lothsahn never sees ben\'s');
  assert.deepEqual(warningsForUser(all, 'carol')?.map((w) => w.id), ['reserve:k'], 'someone with no pool sees none of them');
  assert.equal(warningsForUser(all.slice(0, 2), 'carol'), undefined);
  assert.equal(warningsForUser(undefined, 'ben'), undefined);
});

// ---------------------------------------------------------------- w971: the score

test('w971: score = weekly % left per hour to the reset, x the 5-hour room: the 3%-left-3-days token scores ~1%/day, the 73%-left-4-days one ~18%/day', () => {
  // lothsahn's example, at a fresh 5-hour window so the factor is 1.
  const ben2 = tok('vault-ben-2', { weekly: 97, weeklyDays: 3, session: 0 });
  const ben1 = tok('vault-ben-1', { weekly: 27, weeklyDays: 4, session: 0 });
  const s2 = scoreOf(ben2, NOW).perDay!;
  const s1 = scoreOf(ben1, NOW).perDay!;
  assert.ok(Math.abs(s2 - 1) < 0.01, `3% over 3 days is 1%/day, got ${s2}`);
  assert.ok(Math.abs(s1 - 18.25) < 0.01, `73% over 4 days is 18.25%/day, got ${s1}`);
  // Whichever order the pool lists them in, ben-1 is picked, by a worker and by the orchestrator.
  for (const list of [[ben2, ben1], [ben1, ben2]]) for (const orchestrator of [false, true]) assert.equal(pickAt(list, { orchestrator, limits: L }).token?.name, 'vault-ben-1');
  assert.deepEqual([ben2, ben1].sort(byScore(NOW)).map((t) => t.name), ['vault-ben-1', 'vault-ben-2']);
  // The soonest reset alone no longer wins: ben-2 resets first and used to be tried first.
  assert.equal([ben2, ben1].sort(bySoonestReset)[0].name, 'vault-ben-2');
});

test('w971: more headroom beats a sooner reset; the same headroom goes to the sooner reset; the 5-hour room scales the score', () => {
  const big = tok('big', { weekly: 10, weeklyDays: 6, session: 0 }); // 90% over 6 days = 15%/day
  const small = tok('small', { weekly: 70, weeklyDays: 1, session: 0 }); // 30% over 1 day = 30%/day: more per hour, wins
  assert.equal(pickAt([big, small], { orchestrator: false, limits: L }).token?.name, 'small');
  const tight = tok('tight', { weekly: 85, weeklyDays: 1, session: 0 }); // 15%/day
  assert.equal(pickAt([big, tight], { orchestrator: false, limits: L }).token?.name, 'tight', 'equal score (15%/day): the sooner weekly reset');
  assert.equal(pickAt([tight, big], { orchestrator: false, limits: L }).token?.name, 'tight', 'whatever the list order');
  // Equal in everything: fewer live runs, then the name.
  const a = tok('a', { weekly: 50, weeklyDays: 2, session: 0, sessionHours: 3, others: 2 });
  const b = tok('b', { weekly: 50, weeklyDays: 2, session: 0, sessionHours: 3, others: 1 });
  assert.equal(pickAt([a, b], { orchestrator: false, limits: L }).token?.name, 'b');
  assert.equal(pickAt([tok('y', { weekly: 50, weeklyDays: 2 }), tok('x', { weekly: 50, weeklyDays: 2 })], { orchestrator: false, limits: L }).token?.name, 'x');
  // The 5-hour window is in the picture: 70% used there is a third of the room.
  const busy5 = tok('busy5', { weekly: 20, weeklyDays: 3, session: 70 });
  const calm5 = tok('calm5', { weekly: 40, weeklyDays: 3, session: 0 });
  assert.ok(scoreOf(busy5, NOW).perDay! < scoreOf(calm5, NOW).perDay!, '80% x 0.3 < 60% x 1');
  assert.equal(pickAt([busy5, calm5], { orchestrator: false, limits: L }).token?.name, 'calm5');
  // The caps are unchanged: a token at the 5-hour limit is skipped whatever it scores.
  assert.equal(pickAt([tok('top', { weekly: 0, weeklyDays: 3, session: 80, sessionHours: 2 }), small], { orchestrator: false, limits: L }).token?.name, 'small');
});

test('w971: no reset time, no score: ranked after every scored token; a reset a few minutes off does not score as infinite', () => {
  assert.equal(scoreOf(tok('n', { none: true }), NOW).perDay, undefined);
  assert.equal(scoreOf(tok('n', { weekly: 50 }), NOW).perDay, undefined, 'meters but no weekly reset time');
  assert.equal(pickAt([tok('fresh', { none: true }), tok('known', { weekly: 90, weeklyDays: 5 })], { orchestrator: false, limits: L }).token?.name, 'known');
  // 3% left, 5 minutes to go: the hours are floored at MIN_HOURS_TO_RESET, so 3 / 1 h x 24 = 72%/day, not 864.
  const edge = tok('edge', { weekly: 97, weeklyDays: 5 / 1440, session: 0 });
  assert.ok(Math.abs(scoreOf(edge, NOW).perDay! - (3 / MIN_HOURS_TO_RESET) * 24) < 0.01);
});

// ---------------------------------------------------------------- w971: the dispatcher's reserve is enforced

/** A pool token that is also the dispatcher's credential: its reserve at NOW. */
const withReserve = (t: PoolToken, role = 'the dispatcher'): PoolToken => ({ ...t, reserve: reserveOf(t.usage, L, NOW), reserveFor: role });

test("w971: a pool token inside the dispatcher's reserve goes to no worker, no ops worker and no orchestrator while another token has room", () => {
  // The 04:32Z picture: vault-ben-2 at 97% weekly with 4 days to the reset (reserve 20%), vault-ben-1 at 27%.
  const ben2 = withReserve(tok('vault-ben-2', { weekly: 97, weeklyDays: 4, session: 5 }));
  const ben1 = tok('vault-ben-1', { weekly: 27, weeklyDays: 4, session: 5 });
  const v = judge(ben2, L, NOW);
  assert.equal(v.state, 'reserved');
  assert.match(v.why, /inside the buffer kept for the dispatcher \(weekly 97% \(buffer 20%\), resets /);
  for (const orchestrator of [false, true]) {
    for (const list of [[ben2, ben1], [ben1, ben2]]) {
      const p = pickAt(list, { orchestrator, limits: L });
      assert.equal(p.token?.name, 'vault-ben-1', `orchestrator=${orchestrator}`);
      assert.equal(p.how, 'normal');
    }
  }
  // A session already on it (sticky) moves at its next start.
  assert.equal(pickAt([ben2, ben1], { orchestrator: true, limits: L, sticky: 'vault-ben-2' }).token?.name, 'vault-ben-1');
  assert.equal(pickAt([ben2, ben1], { orchestrator: false, limits: L, sticky: 'vault-ben-2' }).token?.name, 'vault-ben-1');
  // Even when it would score best: a reserved token with plenty of room left in a long week is still not handed out.
  const roomy = withReserve(tok('roomy', { weekly: 70, weeklyDays: 6, session: 0 })); // reserve 30%: 70 >= 70, inside
  assert.equal(judge(roomy, L, NOW).state, 'reserved');
  assert.equal(pickAt([roomy, tok('other', { weekly: 90, weeklyDays: 6, session: 0 })], { orchestrator: false, limits: L }).token?.name, 'other');
});

test('w971: nothing else has room: a worker (and the ops worker) is held with the reason, the orchestrator uses the reserved token', () => {
  const ben2 = withReserve(tok('vault-ben-2', { weekly: 97, weeklyDays: 4, session: 5 }));
  const ben1held = tok('vault-ben-1', { weekly: 30, weeklyDays: 4, session: 90, sessionHours: 2 });
  const worker = pickAt([ben2, ben1held], { orchestrator: false, limits: L });
  assert.equal(worker.token, undefined);
  assert.match(worker.held?.why ?? '', /^every token is at a limit \(vault-ben-2: .*inside the buffer kept for the dispatcher.*; vault-ben-1: 5-hour 90% \(>= 80\): held until/);
  assert.equal(worker.held?.next, iso(NOW + 2 * 3_600_000), 'the first to free up: the 5-hour window, before the buffer lifts');
  const orch = pickAt([ben2, ben1held], { orchestrator: true, limits: L });
  assert.equal(orch.token?.name, 'vault-ben-2');
  assert.equal(orch.how, 'in-reserve');
  assert.equal(pickAt([ben2], { orchestrator: true, limits: L }).token?.name, 'vault-ben-2', 'a pool of one reserved token: the orchestrator runs on it as before');
  assert.equal(pickAt([ben2], { orchestrator: false, limits: L }).token, undefined);
  // A reserved token that is itself held or used up stays as those: used up is used up.
  const dead = withReserve(tok('dead', { weekly: 100, weeklyDays: 4 }));
  assert.equal(pickAt([dead], { orchestrator: true, limits: L }).token, undefined);
  // The reserved token being the only one that is ok for the orchestrator, but the other capped: it prefers the reserved one (today's behaviour: an ok token wins).
  const capped = tok('capped', { weekly: 96, weeklyDays: 2, others: 1 });
  assert.equal(pickAt([ben2, capped], { orchestrator: true, limits: L }).token?.name, 'vault-ben-2');
  assert.equal(pickAt([ben2, capped], { orchestrator: false, limits: L }).token, undefined, 'a worker waits for capped to free its slot');
});

test('w971: a token outside its buffer is an ordinary pool token; the buffer lifts as the week runs out', () => {
  // 97% weekly: the buffer (5% a day) is 20% with 4 days left (97 >= 80: inside), 10% with 2 days (97 >= 90: inside), 2.5% with 0.5 day (outside).
  const at = (days: number) => withReserve(tok('t', { weekly: 97, weeklyDays: days, session: 0 }));
  assert.equal(judge(at(4), L, NOW).state, 'reserved');
  assert.equal(judge(at(2), L, NOW).state, 'reserved');
  assert.equal(judge(at(0.5), L, NOW).state, 'one-at-a-time', 'outside the buffer: an ordinary token (97% is in the one-at-a-time band)');
  // It says when: (100 - 97) / 5 = 0.6 days before the reset.
  assert.equal(judge(at(4), L, NOW).until, iso(NOW + 4 * DAY - 0.6 * DAY));
  // The 5-hour buffer: 85% used is inside the 20% buffer, so 'held' (at 80) comes first; at 79% it is outside; the token is ok.
  assert.equal(judge(withReserve(tok('t', { weekly: 10, weeklyDays: 4, session: 79 })), L, NOW).state, 'ok');
  // The host token's reserve is kept the same way and says for whom.
  const host = withReserve(tok('h', { weekly: 97, weeklyDays: 4 }), 'its own roles');
  assert.match(judge(host, L, NOW).why, /kept for its own roles/);
  // A reserved token with no reading yet counts as inside; with no other token it still serves the orchestrator.
  const noRead = withReserve(tok('nr', { none: true }));
  assert.equal(judge(noRead, L, NOW).state, 'reserved');
  assert.equal(pickAt([noRead], { orchestrator: true, limits: L }).token?.name, 'nr');
  // A token that is not the dispatcher's has no reserve at all.
  assert.equal(judge(tok('plain', { weekly: 97, weeklyDays: 4 }), L, NOW).state, 'one-at-a-time');
});

test('w971: poolKind and the banner read a reserved token as not free (workers cannot use it)', () => {
  const ben2 = withReserve(tok('vault-ben-2', { weekly: 97, weeklyDays: 4 }));
  const ben1 = tok('vault-ben-1', { weekly: 27, weeklyDays: 4 });
  const vs = (...t: PoolToken[]) => t.map((x) => judge(x, L, NOW));
  assert.equal(poolKind(vs(ben2, ben1)), 'serving');
  assert.equal(poolKind(vs(ben2)), 'over');
  const banner = poolBanner([{ name: 'vault-ben-2', last4: 'dAAA', view: vs(ben2)[0] }], 'your', true);
  assert.equal(banner?.kind, 'held');
  assert.match(banner?.text ?? '', /inside the buffer kept for the dispatcher/);
  assert.match(banner?.text ?? '', /the orchestrator keeps running on the token with the most room/);
});
