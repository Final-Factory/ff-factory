import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DAEMON_ALIVE, SELF_REBOOT_STATE, readSelfReboot, writeAlive } from './selfReboot.ts';
import { sanitizeSelfReboot, selfRebootChip, selfRebootEligibility, selfRebootEventLine } from '../shared/selfReboot.ts';
import { tmpDir } from '../server/testTmp.ts';

const AT = '2026-11-28T15:00:00.000Z';
const SINCE = '2026-11-28T14:45:00.000Z';

test('w6792: sanitizeSelfReboot keeps only its fields, as short strings', () => {
  assert.equal(sanitizeSelfReboot(undefined), undefined);
  assert.equal(sanitizeSelfReboot({ why: 'x' }), undefined, 'no mode');
  assert.equal(sanitizeSelfReboot({ mode: 'reboot', why: 'x' }), undefined, 'an unknown mode');
  assert.equal(sanitizeSelfReboot({ mode: 'warn', why: '' }), undefined, 'no why');
  const s = sanitizeSelfReboot({
    mode: 'warn',
    why: 'w'.repeat(1000),
    eligible: true,
    checkedAt: AT,
    stuckSince: 'not a time',
    last: { at: AT, mode: 'warn', why: 'stuck', stuckSince: SINCE, extra: 1 },
    skip: { at: AT, why: 'input' },
    lastLiveAt: AT,
    command: 'shutdown /r',
  });
  assert.deepEqual(s, { mode: 'warn', why: 'w'.repeat(400), eligible: true, checkedAt: AT, last: { at: AT, mode: 'warn', why: 'stuck', stuckSince: SINCE }, skip: { at: AT, why: 'input' } });
  assert.equal(sanitizeSelfReboot({ mode: 'live', why: 'x', eligible: 'yes', last: { at: AT, why: 'no mode' } })?.eligible, undefined);
  assert.equal(sanitizeSelfReboot({ mode: 'live', why: 'x', last: { at: AT, why: 'no mode' } })?.last, undefined);
});

test('w6792: the portal\'s lines and the panel\'s chip say eligible or not, warn only, and what it did', () => {
  assert.equal(selfRebootEligibility({ mode: 'warn', eligible: true, why: 'auto logon' }), 'self-reboot: eligible (warn only): auto logon');
  assert.equal(selfRebootEligibility({ mode: 'live', eligible: true, why: 'auto logon' }), 'self-reboot: eligible: auto logon');
  assert.equal(selfRebootEligibility({ mode: 'warn', eligible: false, why: 'off' }), 'self-reboot: not eligible: off');
  assert.equal(selfRebootEligibility({ mode: 'warn', why: 'starting' }), 'self-reboot: not read yet: starting');
  assert.equal(selfRebootEventLine({ at: AT, mode: 'warn', why: 'stuck 15 min' }), `would have rebooted itself at ${AT} (warn only): stuck 15 min`);
  assert.equal(selfRebootEventLine({ at: AT, mode: 'live', why: 'stuck 15 min' }), `rebooted itself at ${AT}: stuck 15 min`);
  assert.deepEqual(selfRebootChip({ mode: 'warn', eligible: true, why: 'x' }), { label: 'warn only', tone: 'amber' });
  assert.deepEqual(selfRebootChip({ mode: 'live', eligible: true, why: 'x' }), { label: 'on', tone: 'green' });
  assert.deepEqual(selfRebootChip({ mode: 'live', eligible: false, why: 'x' }), { label: 'off', tone: 'grey' });
  assert.deepEqual(selfRebootChip({ mode: 'warn', why: 'x' }), { label: 'not read yet', tone: 'grey' });
  assert.deepEqual(selfRebootChip({ mode: 'warn', eligible: true, why: 'x', stuckSince: SINCE }), { label: 'stuck', tone: 'red' });
});

test('w6792: readSelfReboot answers why a Mac or Linux machine is not eligible, and on Windows what the supervisor wrote', (t) => {
  const dir = tmpDir('ffselfreboot-', t);
  assert.match(readSelfReboot(dir, 'darwin')!.why, /FileVault/);
  assert.equal(readSelfReboot(dir, 'darwin')!.eligible, false);
  assert.match(readSelfReboot(dir, 'linux')!.why, /systemd/);
  assert.equal(readSelfReboot(dir, 'freebsd'), undefined);
  assert.equal(readSelfReboot(dir, 'win32'), undefined, 'no file yet');
  fs.writeFileSync(path.join(dir, SELF_REBOOT_STATE), '{"mode":');
  assert.equal(readSelfReboot(dir, 'win32'), undefined, 'half a file');
  // Windows PowerShell 5.1 starts it with a byte order mark.
  fs.writeFileSync(path.join(dir, SELF_REBOOT_STATE), '﻿' + JSON.stringify({ mode: 'warn', why: 'auto logon', eligible: true, lastLiveAt: AT, last: { at: AT, mode: 'warn', why: 'stuck' } }));
  assert.deepEqual(readSelfReboot(dir, 'win32'), { mode: 'warn', why: 'auto logon', eligible: true, last: { at: AT, mode: 'warn', why: 'stuck' } });
});

test('w6792: writeAlive leaves the whole heartbeat, and no temporary file', (t) => {
  const dir = tmpDir('ffalive-', t);
  writeAlive(dir, true, new Date(AT));
  writeAlive(dir, false, new Date(SINCE));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, DAEMON_ALIVE), 'utf8')), { pid: process.pid, at: SINCE, linked: false });
  assert.deepEqual(fs.readdirSync(dir), [DAEMON_ALIVE]);
});
