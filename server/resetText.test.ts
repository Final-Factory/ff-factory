import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetClock, resetText, resetWhen, timeLeft } from '../shared/resetText.ts';

const NOW = Date.parse('2026-10-16T12:00:00Z');
const at = (iso: string) => iso;

test('resetText: the day, the time and the zone in the viewer\'s zone, then the time left (w1528)', () => {
  assert.equal(resetText(at('2026-10-18T17:00:00Z'), NOW, 'America/Denver'), 'Resets Sun 11:00 MDT (in 2 d 5 h)');
  // Another viewer, another zone: the same instant.
  assert.equal(resetText(at('2026-10-18T17:00:00Z'), NOW, 'UTC'), 'Resets Sun 17:00 UTC (in 2 d 5 h)');
  assert.equal(resetText(at('2026-10-18T17:00:00Z'), NOW, 'America/New_York'), 'Resets Sun 13:00 EDT (in 2 d 5 h)');
  // Past the clock change the zone name changes with it (MST in winter).
  assert.equal(resetClock('2026-12-01T17:00:00Z', Date.parse('2026-11-30T12:00:00Z'), 'America/Denver'), 'Tue 10:00 MST');
});

test('resetText: a session window hours away and a reset past midnight in the viewer\'s zone', () => {
  assert.equal(resetText('2026-10-16T15:20:00Z', NOW, 'America/Denver'), 'Resets Fri 09:20 MDT (in 3 h 20 m)');
  // 03:00 UTC Saturday is still Friday evening in Denver.
  assert.equal(resetText('2026-10-17T03:00:00Z', NOW, 'America/Denver'), 'Resets Fri 21:00 MDT (in 15 h)');
});

test('resetText: a missing or unreadable reset time says so and guesses nothing (w1528)', () => {
  assert.equal(resetText(undefined, NOW, 'UTC'), 'Reset time unknown');
  assert.equal(resetText('', NOW, 'UTC'), 'Reset time unknown');
  assert.equal(resetText('soon', NOW, 'UTC'), 'Reset time unknown');
  assert.equal(resetWhen(undefined, NOW, 'UTC'), 'reset time unknown');
});

test('resetText: a reset time that passed is not shown as time left', () => {
  assert.equal(resetText('2026-10-16T11:00:00Z', NOW, 'UTC'), 'Resets Fri 11:00 UTC (passed, waiting for a fresh reading)');
});

test('resetText: a reset a week away names its date, since its weekday is today\'s', () => {
  assert.equal(resetText('2026-10-23T12:00:00Z', NOW, 'UTC'), 'Resets Fri Oct 23 12:00 UTC (in 7 d)');
});

test('timeLeft: whole units, the smaller one left out when zero', () => {
  assert.equal(timeLeft(30_000), 'under 1 m');
  assert.equal(timeLeft(12 * 60_000), '12 m');
  assert.equal(timeLeft(3 * 3_600_000), '3 h');
  assert.equal(timeLeft(3 * 3_600_000 + 59_999 + 20 * 60_000), '3 h 20 m');
  assert.equal(timeLeft(2 * 86_400_000 + 4 * 3_600_000), '2 d 4 h');
  assert.equal(timeLeft(2 * 86_400_000), '2 d');
});
