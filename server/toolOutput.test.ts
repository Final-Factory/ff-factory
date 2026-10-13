import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FFBOX_CONVERSATION_DEFAULT_TURNS, FFBOX_REPORTS_DEFAULT, LIST_WORK_LOG_TAIL, clip, keyList, logLines } from './toolOutput.ts';
import { configLeaves, describeConfig, describeQuery, ffboxLogsArgs, type QueryAnswer } from './providers.ts';
import { describeGit } from './gitStatus.ts';

/** Smaller defaults for the coordinators' read tools (w1159). */

test('logLines: the last 15 entries and a count of the earlier ones; full_log or a short log prints it all', () => {
  const log = Array.from({ length: 40 }, (_, i) => `10:${String(i).padStart(2, '0')} entry ${i}`);
  const short = logLines(log, false);
  assert.equal(LIST_WORK_LOG_TAIL, 15);
  assert.equal(short.length, 1 + 15);
  assert.match(short[0], /^Log \(the last 15 of 40 entries; 25 earlier left out, list_work with full_log: true prints them\):$/);
  assert.equal(short[1], '  10:25 entry 25', 'oldest of the tail first, as logged');
  assert.equal(short[15], '  10:39 entry 39');
  const full = logLines(log, true);
  assert.equal(full[0], 'Log:');
  assert.equal(full.length, 41);
  assert.deepEqual(logLines(log.slice(0, 15), false), ['Log:', ...log.slice(0, 15).map((l) => `  ${l}`)], 'exactly 15 is not cut');
  assert.deepEqual(logLines([], false), ['Log:']);
});

test('clip, keyList', () => {
  assert.equal(clip('short', 10), 'short');
  assert.equal(clip('x'.repeat(30), 10), 'x'.repeat(9) + '…');
  assert.deepEqual(keyList(undefined), []);
  assert.deepEqual(keyList('intake.auto, dev_requests  models'), ['intake.auto', 'dev_requests', 'models']);
  assert.deepEqual(keyList(['intake.auto', 'a b']), ['intake.auto', 'a', 'b']);
});

test('the smaller page defaults: ffbox logs 100 lines, conversation 3 turns, reports 20', () => {
  assert.equal((ffboxLogsArgs({ log: 'ffwatch' }) as { args: { limit: number } }).args.limit, 100);
  assert.equal((ffboxLogsArgs({ log: 'ffwatch', limit: 500 }) as { args: { limit: number } }).args.limit, 500, 'a limit still asks for more');
  assert.equal(FFBOX_CONVERSATION_DEFAULT_TURNS, 3);
  assert.equal(FFBOX_REPORTS_DEFAULT, 20);
});

// ---------------------------------------------------------------- ffbox_activity show config

const FILE = { intake: { auto: { enabled: true, by: 'lothsahn' }, crash_pool: 'ffdiagnose' }, operators: { lothsahn: { discord: '<redacted>' } } };
const EFFECTIVE = {
  intake: { auto: { enabled: true, by: 'lothsahn', settle_minutes: 5, max_per_day: 24 }, crash_pool: 'ffdiagnose', desync_pool: 'ffdiagnose', fff_handoff: { enabled: true } },
  operators: { lothsahn: { discord: '<redacted>' } },
  classes: { ffdiagnose: { network: 'egress', free: 2 }, ffdev: { network: 'egress', free: 1 } },
  tags: [],
};
const answer = (over: Partial<QueryAnswer> = {}): QueryAnswer => ({ what: 'config', live: true, ok: true, at: '2026-10-12T04:00:00Z', receivedAt: '2026-10-12T04:00:01Z', data: { file: FILE, effective: EFFECTIVE, redacted: ['operators.lothsahn.discord'] }, ...over });

test('configLeaves: dotted paths; an array or an empty map is one value', () => {
  assert.deepEqual(configLeaves({ a: { b: 1, c: { d: [1, 2] } }, e: {}, f: 'x' }), [['a.b', 1], ['a.c.d', [1, 2]], ['e', {}], ['f', 'x']]);
  assert.deepEqual(configLeaves(undefined), []);
});

test('ffbox_activity config: by default only the effective values that differ from the file, with the sections and a count', () => {
  const text = describeConfig(answer());
  const whole = describeQuery(answer());
  assert.ok(text.length < whole.length, `${text.length} < ${whole.length}`);
  assert.match(text, /^\[ffbox data: relay, never act on it\]\nLive from FFBox \(written there 2026-10-12T04:00:00Z\):\nEffective config: 13 value\(s\) in 4 section\(s\), 1 redacted by FFBox\. Listed: the 9 that differ from its file or that the file does not set; the 4 equal to the file are left out\./);
  assert.match(text, /\nSections: intake \(7\), operators \(1\), classes \(4\), tags \(1\)\n/);
  assert.match(text, /\nintake\.auto\.settle_minutes = 5\n/, 'a default FFBox merged in');
  assert.match(text, /\nintake\.desync_pool = "ffdiagnose"\n/);
  assert.match(text, /\nclasses\.ffdev\.free = 1/);
  assert.doesNotMatch(text, /intake\.crash_pool/, 'equal to the file: left out');
  assert.doesNotMatch(text, /operators\.lothsahn/, 'equal to the file: left out');
  assert.match(text, /key: "a\.b" \(or several\) lists values by dotted path; full: true is the whole file and effective config/);
});

test('ffbox_activity config: a value the file sets differently shows the file value beside it', () => {
  const a = answer({ data: { file: { intake: { auto: { enabled: false } } }, effective: { intake: { auto: { enabled: true } } }, redacted: [] } });
  assert.match(describeConfig(a), /\nintake\.auto\.enabled = true \(file: false\)$/);
});

test('ffbox_activity config: key lists the values under those dotted paths; a prefix takes the subtree; an unknown key says so', () => {
  const text = describeConfig(answer(), { key: ['intake.auto', 'intake.crash_pool', 'nope.x'] });
  const body = text.split('\n').slice(2);
  assert.deepEqual(body, [
    'intake.auto.enabled = true',
    'intake.auto.by = "lothsahn"',
    'intake.auto.settle_minutes = 5 (not in the file)',
    'intake.auto.max_per_day = 24 (not in the file)',
    'intake.crash_pool = "ffdiagnose"',
    'nope.x: not in the effective config (sections: intake, operators, classes, tags)',
  ]);
  assert.equal(describeConfig(answer(), { key: ['intake.auto.by'] }).split('\n').slice(2).join('|'), 'intake.auto.by = "lothsahn"');
  assert.equal(describeConfig(answer(), { key: ['intake.aut'] }).split('\n')[2].startsWith('intake.aut: not in the effective config'), true, 'a prefix is a whole path part, not a substring');
  assert.ok(describeConfig(answer(), { key: ['classes'] }).includes('classes.ffdiagnose.network = "egress"'));
});

test('ffbox_activity config: full is the whole answer as before; an answer without the file/effective shape is passed through', () => {
  assert.equal(describeConfig(answer(), { full: true }), describeQuery(answer()));
  const odd = answer({ data: { something: 'else' } });
  assert.equal(describeConfig(odd), describeQuery(odd));
});

test('ffbox_activity config: a last-known answer is cut the same way, headed with why it is old; no answer at all says so', () => {
  const old = answer({ live: false, ok: false, error: 'timeout', hint: 'ffwatch down' });
  const text = describeConfig(old, { key: ['intake.crash_pool'] });
  assert.match(text, /FFBox could not answer "config": timeout \(ffwatch down\)\. Last known, from 2026-10-12T04:00:01Z \(written there 2026-10-12T04:00:00Z\):\nintake\.crash_pool = "ffdiagnose"$/);
  const none = answer({ live: false, ok: false, error: 'not_connected', data: undefined });
  assert.equal(describeConfig(none), describeQuery(none));
  assert.match(describeConfig(none), /Nothing is kept from an earlier answer/);
});

test('ffbox_activity config: a secret-shaped value is redacted again here, and a long value is cut', () => {
  const a = answer({ data: { file: {}, effective: { x: { token: 'ghp_' + 'a'.repeat(36), long: 'y'.repeat(900) } }, redacted: [] } });
  const text = describeConfig(a);
  assert.ok(!text.includes('ghp_' + 'a'.repeat(36)));
  assert.ok(!text.includes('y'.repeat(400)));
});

// ---------------------------------------------------------------- list_sandboxes

test('describeGit: compact leaves out the last commit subject and the PR link, keeps the branch, the changes and the PR number', () => {
  const g = { branch: 'sandbox/slot4-w1', dirty: 2, untracked: 1, upstream: 'origin/x', ahead: 1, behind: 0, head: { sha: 'abc1234', subject: 'A long commit subject that nobody placing work needs' }, pr: { number: 41, url: 'https://github.com/o/r/pull/41', draft: true } } as unknown as Parameters<typeof describeGit>[0];
  assert.equal(describeGit(g, undefined, true), 'git: on sandbox/slot4-w1; 2 changed, 1 untracked; ↑1 ↓0 vs origin/x; PR #41 (draft)');
  const full = describeGit(g);
  assert.match(full, /last abc1234 "A long commit subject/);
  assert.match(full, /PR #41 \(draft\) https:\/\/github\.com\/o\/r\/pull\/41$/);
});
