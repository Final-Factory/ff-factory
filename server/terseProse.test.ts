import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TERSE_PROSE_DEFAULT_PERCENT, TERSE_PROSE_RULE, inTerseProsePilot, terseProsePercent, withTerseProse } from './terseProse.ts';
import { inPilot } from './autoCompact.ts';
import { normalizeSetting } from './appConfig.ts';
import type { Config } from './config.ts';

/**
 * w1480 (lothsahn: "File it: measure the history, then pilot caveman and quieter tool output"): a share of workers write terse
 * prose between tool calls; their reports and everything a person reads stay plain English.
 */

const worker = (p: number | undefined) => ({ worker: { terseProsePilotPercent: p } as Config['worker'] });
const ids = Array.from({ length: 2000 }, (_, i) => `s-${i.toString(36)}-${(i * 7919).toString(16)}`);

test('terseProsePercent: 50 by default; config sets it; 0 is off; over 100 is all', () => {
  assert.equal(TERSE_PROSE_DEFAULT_PERCENT, 50);
  assert.equal(terseProsePercent({}), 50);
  assert.equal(terseProsePercent(worker(20)), 20);
  assert.equal(terseProsePercent(worker(0)), 0);
  assert.equal(terseProsePercent(worker(250)), 100);
});

test('the pilot: a stable share of session ids, drawn apart from the compaction pilot', () => {
  const half = ids.filter((id) => inTerseProsePilot(id, {}));
  assert.ok(half.length > 900 && half.length < 1100, `${half.length} of 2000 at 50%`);
  assert.deepEqual(ids.filter((id) => inTerseProsePilot(id, {})), half, 'the same session always answers the same');
  assert.equal(ids.filter((id) => inTerseProsePilot(id, worker(0))).length, 0);
  assert.equal(ids.filter((id) => inTerseProsePilot(id, worker(100))).length, 2000);
  // Both pilots in one session as often as chance says (34% of 50%), so each one's effect can be read apart.
  const both = half.filter((id) => inPilot(id, 34)).length;
  assert.ok(both > 250 && both < 430, `${both} sessions in both pilots`);
});

test('withTerseProse: the rule follows the brief in a pilot session only, and leaves reports in plain English', () => {
  const inside = ids.find((id) => inTerseProsePilot(id, {}))!;
  const outside = ids.find((id) => !inTerseProsePilot(id, {}))!;
  assert.equal(withTerseProse('BRIEF', outside, {}), 'BRIEF');
  assert.equal(withTerseProse('BRIEF', inside, {}), `BRIEF\n\n${TERSE_PROSE_RULE}`);
  assert.match(TERSE_PROSE_RULE, /^## Between tool calls \(pilot\)\n/, 'its heading marks a pilot session in a transcript');
  assert.match(TERSE_PROSE_RULE, /only text between tool calls/);
  for (const kept of ['end-of-turn report', 'PR descriptions', 'commit messages', 'DONE and still-open lines', 'anything else a person reads']) assert.ok(TERSE_PROSE_RULE.includes(kept), kept);
  assert.ok(TERSE_PROSE_RULE.length < 600, `the rule is read on every call of a pilot session: ${TERSE_PROSE_RULE.length} characters`);
});

test('set_app_config takes worker.terseProsePilotPercent as a whole percent', () => {
  assert.equal(normalizeSetting('worker.terseProsePilotPercent', 25), 25);
  assert.equal(normalizeSetting('worker.terseProsePilotPercent', '0'), 0);
  assert.throws(() => normalizeSetting('worker.terseProsePilotPercent', 101), /worker.terseProsePilotPercent is a whole number from 0 to 100/);
  assert.throws(() => normalizeSetting('worker.terseProsePilotPercent', 2.5), /whole number/);
});
