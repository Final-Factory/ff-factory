import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jobSection, settingsOfLog } from './updateLog.ts';
import { linkReportSummary } from './machineRollout.ts';
import { linkUpdateMessage } from './opsWorker.ts';
import { jobLog } from '../scripts/worker/linkJob.ts';

// w5394: update-job.log as m5 had it on 2026-11-24 (update job 6ddf0065): earlier jobs said "none changed", this one added
// workerFence. The report read the stale line, and cut the value at its escaped quote.
const older = (id: string) =>
  [
    '',
    `2026-11-23T10:00:00.000Z FF Factory update job ${id}: update to ff-factory aaaaaaaaaaaa (w1596, the portal asked over the daemon's link).`,
    'Before: daemon 111111111111; the portal sees it online.',
    'After: daemon aaaaaaaaaaaa (was 111111111111).',
    'Settings: none changed (every setting carried).',
    "Credential: the machine's own (token), reused; nothing issued or printed.",
    'The portal sees m5 online running aaaaaaaaaaaa, the commit installed, not outdated.',
    `2026-11-23T10:02:00.000Z job ${id}: done.`,
  ].join('\n');
const THIS = '6ddf0065-1111-2222-3333-444444444444';
const own = [
  '',
  `2026-11-24T07:33:00.000Z FF Factory update job ${THIS}: update to ff-factory bbbbbbbbbbbb (w1596, the portal asked over the daemon's link).`,
  'Before: daemon aaaaaaaaaaaa; the portal sees it online.',
  'After: daemon bbbbbbbbbbbb (was aaaaaaaaaaaa).',
  'Settings changed (daemon.json; everything else carried):',
  '  + workerFence: "seatbelt"',
  "Credential: the machine's own (token), reused; nothing issued or printed.",
  'The portal sees m5 online running bbbbbbbbbbbb, the commit installed, not outdated.',
  `2026-11-24T07:35:00.000Z job ${THIS}: done.`,
  '',
].join('\n');
const TAIL = [older('5dd49812-0000-0000-0000-000000000000'), older('7e7e7e7e-0000-0000-0000-000000000000'), own].join('\n');

test('w5394: jobSection cuts one job out of a log tail holding several', () => {
  const s = jobSection(TAIL, THIS);
  assert.match(s, /^2026-11-24T07:33:00.000Z FF Factory update job 6ddf0065/);
  assert.doesNotMatch(s, /none changed/);
  assert.match(jobSection(TAIL, '7e7e7e7e'), /none changed/, 'a short id names its job too');
  assert.doesNotMatch(jobSection(TAIL, '7e7e7e7e'), /workerFence/, 'and ends at the next job');
  assert.equal(jobSection(TAIL), jobSection(TAIL, THIS), 'no id: the last job');
  assert.equal(jobSection(TAIL, 'ffffffff'), '', "a job whose header fell out of the tail: nothing is known to be its");
  assert.equal(jobSection('Before: a\nSettings: none changed.'), 'Before: a\nSettings: none changed.', 'no header (ssh output): whole');
});

test('w5394: settingsOfLog reads the diff lines whole, quotes included', () => {
  assert.deepEqual(settingsOfLog(jobSection(TAIL, THIS)), ['+ workerFence: "seatbelt"']);
  assert.deepEqual(settingsOfLog(older('x')), []);
  assert.equal(settingsOfLog('Before: a\nFAILED: no'), undefined);
  assert.deepEqual(settingsOfLog('Settings changed (daemon.json; everything else carried):\n  + writeLock: true\n  ~ maxUnity: 2 -> 3\n  - old: "a \\"b\\""\nCredential: x'), ['+ writeLock: true', '~ maxUnity: 2 -> 3', '- old: "a \\"b\\""']);
});

test('w5394: an old daemon report (several jobs in its log, through result.json) shows this job\'s settings, whole', () => {
  // result.json escapes the quotes; the report the portal gets back is parsed JSON.
  const r = JSON.parse(JSON.stringify({ id: THIS, form: 'update', commit: 'b'.repeat(40), ok: true, exit: 0, log: TAIL, at: 'x' }));
  const got = linkReportSummary(r);
  assert.deepEqual(got.settings, ['+ workerFence: "seatbelt"']);
  assert.ok(got.summary.includes('+ workerFence: "seatbelt"'), got.summary.join('\n'));
  assert.ok(!got.summary.some((l) => /none changed/.test(l)), got.summary.join('\n'));
  assert.ok(!got.summary.some((l) => /aaaaaaaaaaaa \(was 111111111111\)/.test(l)), 'no earlier job\'s lines');
  const msg = linkUpdateMessage('m5', 'w5393', r);
  assert.match(msg, /Settings changed \(daemon\.json; everything else carried\):\n {4}\+ workerFence: "seatbelt"\n {4}Credential:/);
  assert.doesNotMatch(msg, /none changed/);
});

test('w5394: a new daemon report carries the settings as a field, and the field wins', () => {
  const r = { id: THIS, log: 'Before: x\nCredential: y', settings: ['+ writeLock: true'] };
  assert.deepEqual(linkReportSummary(r).summary, ['Before: x', 'Settings changed (daemon.json; everything else carried):', '+ writeLock: true', 'Credential: y']);
  assert.deepEqual(linkReportSummary({ id: THIS, log: own, settings: [] }).summary.filter((l) => /Settings|workerFence/.test(l)), ['Settings: none changed (every setting carried).']);
});

test('w5394: the job writes its own section and its settings into result.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w5394-'));
  try {
    const f = path.join(dir, 'update-job.log');
    fs.writeFileSync(f, TAIL);
    const r = jobLog(f, THIS);
    assert.deepEqual(r.settings, ['+ workerFence: "seatbelt"']);
    assert.doesNotMatch(r.log, /none changed|5dd49812/);
    assert.match(r.log, /FF Factory update job 6ddf0065/);
    const back = JSON.parse(JSON.stringify(r));
    assert.deepEqual(back.settings, ['+ workerFence: "seatbelt"'], 'whole through JSON');
    assert.deepEqual(jobLog(path.join(dir, 'none.log'), THIS), { log: '' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
