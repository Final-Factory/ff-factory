import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADDRESS_MAX_FAILURES, FAILURE_TTL_MS, FailureTable, KEY_MAX, LoginTimer, TABLE_CAP, USER_BACKOFF_MAX_MS, USER_FREE_FAILURES,
  addressKey, addressRefused, quoteForLog, userWaitMs,
} from './loginThrottle.ts';

/** w5521: the login throttle's tables stay bounded under a flood, and a flood cannot evict a targeted name's backoff. */

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test('w5521: a username backoff starts after its free failures, doubles, and stops growing at the cap', () => {
  const c = clock();
  const users = new FailureTable({ now: c.now });
  for (let i = 0; i < USER_FREE_FAILURES - 1; i++) users.fail('ben');
  assert.equal(userWaitMs(users.state('ben'), c.now()), 0, 'under the free failures nothing waits');
  users.fail('ben');
  assert.equal(userWaitMs(users.state('ben'), c.now()), 1_000);
  users.fail('ben');
  assert.equal(userWaitMs(users.state('ben'), c.now()), 2_000);
  for (let i = 0; i < 40; i++) users.fail('ben');
  assert.equal(userWaitMs(users.state('ben'), c.now()), USER_BACKOFF_MAX_MS, 'bounded: the owner waits at most the cap');
  c.advance(USER_BACKOFF_MAX_MS);
  assert.equal(userWaitMs(users.state('ben'), c.now()), 0, 'and then may try again');
  assert.equal(users.state('lothsahn'), undefined, 'another name is untouched');
});

test('w5521: a flood of unique usernames keeps the table at its cap, and a targeted name stays throttled through it', () => {
  const c = clock();
  const users = new FailureTable({ now: c.now });
  for (let i = 0; i < USER_FREE_FAILURES + 5; i++) users.fail('ben');
  const before = userWaitMs(users.state('ben'), c.now());
  assert.ok(before > 0);
  // The attacker fills the table five times over with made-up names, then goes back to 'ben'.
  const N = TABLE_CAP * 5;
  for (let i = 0; i < N; i++) {
    users.fail(`made-up-${i}`);
    assert.ok(users.size <= TABLE_CAP);
  }
  assert.equal(users.size, TABLE_CAP);
  assert.ok(userWaitMs(users.state('ben'), c.now()) > 0, "the flood evicted ben's entry but not its backoff");
  // The count survives in its bucket (a made-up name that shares the bucket may have raised it: never lowered).
  const kept = users.state('ben')?.fails ?? 0;
  assert.ok(kept >= USER_FREE_FAILURES + 5, `the count survives in its bucket (${kept})`);
  // The next failure for ben counts on from there, not from zero.
  assert.equal(users.fail('ben'), kept + 1);
});

test('w5521: a flood of unique addresses and /64s keeps the table at its cap, and a refused address stays refused', () => {
  const c = clock();
  const addrs = new FailureTable({ now: c.now });
  for (let i = 0; i < ADDRESS_MAX_FAILURES; i++) addrs.fail(addressKey('203.0.113.9'));
  for (let i = 0; i < ADDRESS_MAX_FAILURES; i++) addrs.fail(addressKey(`2001:db8:aaaa:1::${i + 1}`));
  const N = TABLE_CAP * 3;
  for (let i = 0; i < N; i++) {
    addrs.fail(addressKey(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`));
    addrs.fail(addressKey(`2001:db8:${(i >> 16).toString(16)}:${(i & 0xffff).toString(16)}::1`));
    assert.ok(addrs.size <= TABLE_CAP);
  }
  assert.equal(addrs.size, TABLE_CAP);
  assert.ok(addressRefused(addrs.state(addressKey('203.0.113.9'))));
  assert.ok(addressRefused(addrs.state(addressKey('2001:db8:aaaa:1::ffff'))), 'the whole /64 stays refused');
});

test('w5521: entries expire, and the sweep removes them and their buckets', () => {
  const c = clock();
  const t = new FailureTable({ now: c.now, cap: 4 });
  for (let i = 0; i < 10; i++) t.fail(`name-${i}`);
  assert.equal(t.size, 4);
  assert.equal(t.state('name-0')?.fails, 1, 'evicted, but remembered in its bucket');
  c.advance(FAILURE_TTL_MS - 1);
  assert.equal(t.sweep(), 0, 'nothing has expired yet');
  c.advance(1);
  assert.equal(t.state('name-9'), undefined, 'expired entries count for nothing even before a sweep');
  assert.equal(t.sweep(), 4);
  assert.equal(t.size, 0);
  assert.equal(t.state('name-0'), undefined, 'and the buckets are cleared');
});

test('w5521: keys are cut to KEY_MAX, so a long made-up name costs no more memory than a short one', () => {
  const t = new FailureTable();
  t.fail('x'.repeat(10_000));
  t.fail(`${'x'.repeat(KEY_MAX)}different tail`);
  assert.equal(t.size, 1);
  assert.equal(t.state('x'.repeat(KEY_MAX))?.fails, 2);
});

test('w5521: IPv4 is throttled per address, IPv6 per /64', () => {
  assert.equal(addressKey('203.0.113.7'), '203.0.113.7');
  assert.equal(addressKey('::ffff:203.0.113.7'), '203.0.113.7', 'an IPv4-mapped address is its IPv4 address');
  assert.equal(addressKey('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
  assert.equal(addressKey('2001:db8:1:2::9'), '2001:db8:1:2::/64');
  assert.equal(addressKey('2001:0db8:0001:0002:ffff::1'), '2001:db8:1:2::/64', 'leading zeros do not make a new key');
  assert.equal(addressKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(addressKey('fe80::1%eth0'), 'fe80:0:0:0::/64', 'a zone id is dropped');
  assert.equal(addressKey('::1'), '0:0:0:0::/64');
  assert.equal(addressKey('64:ff9b::192.0.2.33'), '64:ff9b:0:0::/64');
  assert.notEqual(addressKey('2001:db8:1:2::1'), addressKey('2001:db8:1:3::1'));
  assert.equal(addressKey('not an address'), 'not an address');
  assert.equal(addressKey('y'.repeat(500)).length, KEY_MAX);
});

test('w5521: a username in a log line is quoted and escaped, so it cannot forge a line', () => {
  assert.equal(quoteForLog('ben'), '"ben"');
  assert.equal(quoteForLog('a"b\\c'), '"a\\"b\\\\c"');
  const forged = quoteForLog('x" from 1.2.3.4\nlogin ok for "ben');
  assert.doesNotMatch(forged, /\n/);
  assert.equal(forged, '"x\\" from 1.2.3.4\\u000alogin ok for \\"ben"');
  const ugly = quoteForLog(['a', 0x0d, 0x2028, 0x1b, '[31mb'].map((c) => (typeof c === 'number' ? String.fromCharCode(c) : c)).join(''));
  assert.equal(ugly, '"a\\u000d\\u2028\\u001b[31mb"');
  assert.equal(quoteForLog('z'.repeat(100)), `"${'z'.repeat(KEY_MAX)}"...`);
});

test('w5521: the fixed login time sits just over the slowest measured login, failed or successful', async () => {
  const timer = new LoginTimer();
  assert.equal(timer.floorMs(), 0);
  timer.observe(80, false);
  timer.observe(90, true);
  assert.equal(timer.floorMs(), LoginTimer.MARGIN(90));
  // An old slow sample rolls out of the window.
  for (let i = 0; i < LoginTimer.WINDOW; i++) timer.observe(50, false);
  assert.equal(timer.floorMs(), LoginTimer.MARGIN(90), 'the last successful logins are kept apart, so rare successes still count');
  for (let i = 0; i < LoginTimer.WINDOW; i++) timer.observe(60, true);
  assert.equal(timer.floorMs(), LoginTimer.MARGIN(60));
  timer.observe(60_000, false);
  assert.equal(timer.floorMs(), LoginTimer.MARGIN(LoginTimer.CEILING_MS), 'a stalled sample cannot raise it past the ceiling');
});
