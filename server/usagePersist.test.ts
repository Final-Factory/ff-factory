import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STALE_READING_MS, UsageFetchError, UsageTracker, buildAccounts, effectiveUsage, tokenKey, type UsageDeps } from './usage.ts';
import { POOL_DEFAULTS, judge, reserveOf, type PoolToken } from './tokenPool.ts';
import type { PlanUsage } from '../shared/types.ts';

/**
 * A reading survives a restart and a failed poll (w1041). On 2026-10-11 at 20:30Z a deploy restarted the portal, the first
 * poll of vault-lothsahn-1 got a 429 and a network failure, the failed poll replaced the saved reading with "unknown", and
 * the pool counted 50% on both windows: inside the dispatcher's reserve, so it blocked new work for ~2 minutes (w1038).
 */

const NOW = Date.parse('2026-10-11T20:30:00Z');
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const TOKEN = `sk-ant-oat01-${'x'.repeat(60)}EAAA`;

const reading = (o: { weekly?: number; session?: number; asOf?: number; weeklyReset?: number; sessionReset?: number; fable?: number }): PlanUsage => ({
  available: true,
  asOf: iso(o.asOf ?? NOW),
  models: o.fable === undefined ? [] : [{ label: 'Weekly Fable', percent: o.fable, resetsAt: iso(o.weeklyReset ?? NOW + 3 * 86_400_000) }],
  weekly: { label: 'Weekly', percent: o.weekly ?? 6, resetsAt: iso(o.weeklyReset ?? NOW + 3 * 86_400_000) },
  session: { label: 'Session (5 h)', percent: o.session ?? 16, resetsAt: iso(o.sessionReset ?? NOW + 2 * H) },
});

test('effectiveUsage: a window whose reset passed counts as 0%, the weekly one rolls forward by whole weeks', () => {
  const u = reading({ weekly: 80, session: 90, fable: 70, asOf: NOW - 3 * H, weeklyReset: NOW - 86_400_000, sessionReset: NOW - H });
  const e = effectiveUsage(u, NOW, true)!;
  assert.deepEqual([e.weekly?.percent, e.session?.percent, e.models[0].percent], [0, 0, 0]);
  assert.equal(e.session?.resetsAt, undefined, 'the next 5-hour reset is unknown: it starts with the next message');
  assert.equal(e.weekly?.resetsAt, iso(NOW - 86_400_000 + 7 * 86_400_000), 'the weekly window repeats every 7 days');
  // not yet reset: kept as read
  const keep = effectiveUsage(reading({ weekly: 80, session: 30, asOf: NOW - H }), NOW, true)!;
  assert.deepEqual([keep.weekly?.percent, keep.session?.percent], [80, 30]);
  // nothing held (this portal just read it): returned as it is, with no label
  const fresh = effectiveUsage(reading({ weekly: 6 }), NOW, false)!;
  assert.equal(fresh.reading, undefined);
  assert.equal(fresh.weekly?.percent, 6);
  // unavailable readings are not touched
  const none: PlanUsage = { available: false, asOf: iso(NOW), models: [], why: 'usage unknown' };
  assert.equal(effectiveUsage(none, NOW, true), none);
  assert.equal(effectiveUsage(undefined, NOW, true), undefined);
});

test('effectiveUsage: a persisted reading is labelled with its age; older than the bound, windows not yet reset count at least 50%', () => {
  const recent = effectiveUsage(reading({ weekly: 6, session: 16, asOf: NOW - 12 * 60_000 }), NOW, true)!;
  assert.deepEqual([recent.weekly?.percent, recent.session?.percent], [6, 16], 'inside the bound the old numbers stand');
  assert.equal(recent.reading?.kind, 'persisted');
  assert.match(recent.reading!.why, /^read 12 min ago; not read since this portal started$/);
  const failed = effectiveUsage({ ...reading({ asOf: NOW - 2 * H }), error: 'the usage endpoint rate-limits this token (HTTP 429)' }, NOW, true)!;
  assert.match(failed.reading!.why, /^read 2 h ago; the latest poll failed \(the usage endpoint rate-limits this token \(HTTP 429\)\)$/);
  assert.equal(STALE_READING_MS, 6 * H);
  const old = effectiveUsage(reading({ weekly: 6, session: 16, fable: 3, asOf: NOW - 7 * H }), NOW, true)!;
  assert.deepEqual([old.weekly?.percent, old.session?.percent, old.models[0].percent], [50, 50, 50], 'older than 6 h: the same assumption as a token never read');
  assert.equal(old.reading?.kind, 'stale');
  assert.match(old.reading!.why, /read 7 h ago.*older than 6 h, so a window not yet reset counts as at least 50%/);
  // a counter only goes up before its reset: an old high reading stays high
  const high = effectiveUsage(reading({ weekly: 97, session: 20, asOf: NOW - 20 * H, weeklyReset: NOW + 86_400_000, sessionReset: NOW - 15 * H }), NOW, true)!;
  assert.deepEqual([high.weekly?.percent, high.session?.percent], [97, 0], 'the weekly stays 97 until its reset; the 5-hour window reset long ago');
});

/** How the meters label a vault token (a vault entry's name and the last four characters, w1078). */
const tokenLabel = (token: string) => `vault-ben-1 …${token.slice(-4)}`;

function trackerIn(dir: string, deps: UsageDeps) {
  const cfg = { dataDir: dir } as never;
  const logs: string[] = [];
  const t = new UsageTracker(cfg, () => undefined, {
    log: (l) => logs.push(l),
    ...deps,
  });
  t.personTokens = () => [{ token: TOKEN, label: tokenLabel(TOKEN) }];
  return { t, logs };
}
const body = (weekly: number, session: number) => ({
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: session, resets_at: iso(Date.now() + 2 * H) },
    seven_day: { utilization: weekly, resets_at: iso(Date.now() + 3 * 86_400_000) },
    limits: [
      { kind: 'session', group: 'session', percent: session, severity: 'normal', resets_at: iso(Date.now() + 2 * H), scope: null },
      { kind: 'weekly_all', group: 'weekly', percent: weekly, severity: 'normal', resets_at: iso(Date.now() + 3 * 86_400_000), scope: null },
    ],
  },
});

test('a reading is persisted, loaded at startup, and kept through a restart whose first poll fails (429 and no network)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-persist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = tokenKey(TOKEN);

  // Before the deploy: the token reads weekly 8%, 5-hour 28%
  const first = trackerIn(dir, { fetchToken: async () => body(8, 28) });
  await first.t.refresh();
  assert.equal(first.t.usageOf(key)?.reading, undefined, 'read by this process just now: no label');
  const file = fs.readFileSync(path.join(dir, 'usage.json'), 'utf8');
  assert.ok(!file.includes(TOKEN) && !file.includes('xxxxxxxx'), 'a token is never written: the file has the hash key and the label (last four) only');
  assert.match(file, new RegExp(`"${key}"`));
  assert.match(file, /vault-ben-1 …EAAA/);
  const saved = JSON.parse(file).entries[key];
  assert.deepEqual([saved.usage.weekly.percent, saved.usage.session.percent, typeof saved.usage.asOf, typeof saved.usage.weekly.resetsAt], [8, 28, 'string', 'string']);

  // The restart: a new process reads the file before any poll
  const second = trackerIn(dir, {
    fetchToken: async () => {
      throw new UsageFetchError('the usage endpoint rate-limits this token, next try in 60 min (HTTP 429: Rate limited.)', 3_600_000);
    },
    fetchTokenLimits: async () => {
      throw new UsageFetchError('the API could not be reached: fetch failed');
    },
  });
  const loaded = second.t.usageOf(key)!;
  assert.deepEqual([loaded.available, loaded.weekly?.percent, loaded.session?.percent, loaded.reading?.kind], [true, 8, 28, 'persisted'], 'loaded at startup, before any poll answers');
  assert.match(loaded.reading!.why, /not read since this portal started/);

  // Its first poll fails both ways: the saved reading stays, with the failure
  await second.t.refresh();
  const after = second.t.usageOf(key)!;
  assert.deepEqual([after.available, after.weekly?.percent, after.session?.percent, after.reading?.kind], [true, 8, 28, 'persisted']);
  assert.match(after.reading!.why, /^read under a minute ago; the latest poll failed \(usage unknown: the usage endpoint rate-limits this token/);
  assert.match(second.logs.find((l) => /vault-ben-1/.test(l))!, /failed \(.*\), keeping its reading from /);
  assert.equal(second.t.nearTokens().length, 1, 'a token on a kept reading is asked again at the near-poll pace');

  // The kept reading is what the pool uses: not "no numbers", not the 50% assumption
  const poolToken = (usage: PlanUsage | undefined): PoolToken => ({ id: 'e1', name: 'vault-lothsahn-1', fingerprint: 'abc', owner: 'lothsahn', usage, others: 0 });
  const view = judge(poolToken(after), POOL_DEFAULTS, NOW);
  assert.deepEqual([view.state, view.session, view.weekly, view.known], ['ok', 28, 8, true]);
  assert.match(view.shown, /^5-hour 28%, weekly 8% \[persisted reading: read .*the latest poll failed/);
  const r = reserveOf(after, POOL_DEFAULTS, Date.now());
  assert.equal(r.inReserve, false, 'the dispatcher token on a kept reading is not counted as inside its own reserve');
  // ... which is exactly what blocked w1038 without it
  const blind = reserveOf({ available: false, asOf: iso(NOW), models: [], why: 'usage unknown' }, POOL_DEFAULTS, Date.now());
  assert.deepEqual([blind.noReading, blind.inReserve], [true, true]);
  assert.equal(judge(poolToken({ available: false, asOf: iso(NOW), models: [] }), POOL_DEFAULTS, NOW).known, false);

  // A poll that answers clears the label and replaces the reading (the endpoint's 60 minutes are still running: the headers answer)
  const third = trackerIn(dir, { fetchToken: async () => body(1, 1), fetchTokenLimits: async () => body(9, 5) });
  await third.t.refresh();
  const back = third.t.usageOf(key)!;
  assert.deepEqual([back.weekly?.percent, back.session?.percent, back.reading], [9, 5, undefined]);
  const accounts = buildAccounts(third.t.effectiveEntries(), { hostName: 'vm', token: { key, label: tokenLabel(TOKEN) }, machines: [], sessions: [] });
  assert.equal(accounts.find((a) => a.id === key)?.usage?.weekly?.percent, 9);
});

test('a persisted reading is aged by its reset times when the restart is late; one older than the bound is a floor, not a guess', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-persist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = tokenKey(TOKEN);
  // The file as an old process left it: 8 h old, 5-hour window reset since, weekly window not
  const old = reading({ weekly: 8, session: 90, asOf: Date.now() - 8 * H, weeklyReset: Date.now() + 2 * 86_400_000, sessionReset: Date.now() - 3 * H });
  fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({ entries: { [key]: { kind: 'token', label: tokenLabel(TOKEN), direct: true, usage: old } } }));
  const { t: tracker } = trackerIn(dir, { fetchToken: async () => { throw new UsageFetchError('boom'); }, fetchTokenLimits: async () => { throw new UsageFetchError('boom'); } });
  const u = tracker.usageOf(key)!;
  assert.equal(u.session?.percent, 0, 'its 5-hour window reset: 0%, not the 90% it read');
  assert.equal(u.weekly?.percent, 50, 'its weekly window has not reset and the reading is over 6 h old: at least 50%, as for a token never read');
  assert.equal(u.reading?.kind, 'stale');
  // the near-poll does not wait for the next regular poll
  assert.equal(tracker.nearTokens().length, 1);
});

test('a token the API rejected (401) is unknown, not a kept reading; the usage endpoint\'s refusal is remembered across a restart', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-persist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = tokenKey(TOKEN);
  const a = trackerIn(dir, { fetchToken: async () => body(8, 28) });
  await a.t.refresh();
  const rejected = trackerIn(dir, {
    fetchToken: async () => {
      throw new UsageFetchError('the token was rejected (expired or revoked?) (HTTP 401)');
    },
  });
  await rejected.t.refresh();
  assert.equal(rejected.t.usageOf(key)?.available, false);
  assert.match(rejected.t.usageOf(key)!.why!, /rejected/);

  // 429 with Retry-After: written to the file, and the next process does not ask the endpoint within it
  const calls: string[] = [];
  const limited = trackerIn(dir, {
    fetchToken: async (tok) => {
      calls.push(tok);
      throw new UsageFetchError('the usage endpoint rate-limits this token, next try in 60 min (HTTP 429)', 3_600_000);
    },
    fetchTokenLimits: async () => body(11, 12),
  });
  await limited.t.refresh();
  assert.equal(calls.length, 1);
  assert.match(fs.readFileSync(path.join(dir, 'usage.json'), 'utf8'), /"holds":\{"token:[0-9a-f]{12}":\{"retryAt":\d+\}\}/);
  assert.ok(!fs.readFileSync(path.join(dir, 'usage.json'), 'utf8').includes(TOKEN));
  const restarted = trackerIn(dir, {
    fetchToken: async (tok) => {
      calls.push(tok);
      return body(1, 1);
    },
    fetchTokenLimits: async () => body(12, 13),
  });
  await restarted.t.refresh();
  assert.equal(calls.length, 1, 'the endpoint was not asked again inside its Retry-After, even by a new process');
  assert.equal(restarted.t.usageOf(key)?.weekly?.percent, 12, 'the rate-limit headers answered');
});
