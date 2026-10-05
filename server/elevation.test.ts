import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HANDOFF_RETRY_MS, NO_DESKTOP_WHY, desktopSignedIn, parseDesktopProbe, parseWhoamiGroups, planHandoff, tokenIsElevated } from './elevation.ts';

// `whoami /groups /fo csv` from an elevated shell on this host (trimmed).
const ELEVATED = `"Group Name","Type","SID","Attributes"
"Mandatory Label\\High Mandatory Level","Label","S-1-16-12288",""
"Everyone","Well-known group","S-1-1-0","Mandatory group, Enabled by default, Enabled group"
"NT AUTHORITY\\Local account and member of Administrators group","Well-known group","S-1-5-114","Mandatory group, Enabled by default, Enabled group"
"BUILTIN\\Administrators","Alias","S-1-5-32-544","Mandatory group, Enabled by default, Enabled group, Group owner"
"BUILTIN\\Users","Alias","S-1-5-32-545","Mandatory group, Enabled by default, Enabled group"`;

// The same admin account, UAC-filtered (a normal, non-elevated shell).
const FILTERED = `"Group Name","Type","SID","Attributes"
"Everyone","Well-known group","S-1-1-0","Mandatory group, Enabled by default, Enabled group"
"BUILTIN\\Administrators","Alias","S-1-5-32-544","Group used for deny only"
"BUILTIN\\Users","Alias","S-1-5-32-545","Mandatory group, Enabled by default, Enabled group"
"Mandatory Label\\Medium Mandatory Level","Label","S-1-16-8192",""`;

// runas /trustlevel:0x20000 from an elevated shell: Administrators removed, integrity still high.
const HIGH_NO_ADMIN = `"Mandatory Label\\High Mandatory Level","Label","S-1-16-12288",""
"BUILTIN\\Users","Alias","S-1-5-32-545","Mandatory group, Enabled by default, Enabled group"`;

test('whoami: an elevated token is high integrity with Administrators enabled', () => {
  const t = parseWhoamiGroups(ELEVATED);
  assert.deepEqual(t, { integrity: 'high', adminGroupEnabled: true });
  assert.equal(tokenIsElevated(t), true);
});

test('whoami: a UAC-filtered admin token is not elevated', () => {
  const t = parseWhoamiGroups(FILTERED);
  assert.deepEqual(t, { integrity: 'medium', adminGroupEnabled: false });
  assert.equal(tokenIsElevated(t), false);
});

test('whoami: high integrity alone counts as elevated', () => {
  assert.equal(tokenIsElevated(parseWhoamiGroups(HIGH_NO_ADMIN)), true);
});

test('whoami: localized attribute text still parses by SID', () => {
  const de = `"Mandatory Label\\Hohe Verbindlichkeitsstufe","Bezeichnung","S-1-16-12288",""
"VORDEFINIERT\\Administratoren","Alias","S-1-5-32-544","Verbindliche Gruppe, Standardmäßig aktiviert, Aktivierte Gruppe"`;
  assert.deepEqual(parseWhoamiGroups(de), { integrity: 'high', adminGroupEnabled: true });
  assert.deepEqual(parseWhoamiGroups(''), { integrity: undefined, adminGroupEnabled: false });
});

const base = { elevated: true, optedOut: false, taskRunLevel: 'Limited', supervisorPid: 42, nowMs: 10 * HANDOFF_RETRY_MS };

test('hand-off: an elevated, supervised server with a Limited task hands off', () => {
  assert.deepEqual(planHandoff(base), { handoff: true });
  assert.deepEqual(planHandoff({ ...base, taskRunLevel: 'LIMITED' }), { handoff: true });
});

test('hand-off: never when not elevated, and every refusal says why', () => {
  assert.deepEqual(planHandoff({ ...base, elevated: false }), { handoff: false });
  for (const f of [
    { ...base, optedOut: true },
    { ...base, taskRunLevel: undefined },
    { ...base, taskRunLevel: 'Highest' }, // handing off to it would start us elevated again: a loop
    { ...base, supervisorPid: undefined }, // nothing would start the server again
    { ...base, lastAttemptMs: base.nowMs - 60_000 }, // tried a minute ago and we are still elevated
  ]) {
    const p = planHandoff(f);
    assert.equal(p.handoff, false);
    assert.ok(!p.handoff && p.why, JSON.stringify(f));
  }
  assert.deepEqual(planHandoff({ ...base, lastAttemptMs: base.nowMs - HANDOFF_RETRY_MS }), { handoff: true });
});

test('hand-off: not while nobody is signed in to the desktop, and the banner says to sign in (BEAST after a crash, w424)', () => {
  // The task runs only in its user's desktop session: a hand-off would restart the app (cutting off every agent) for a
  // task that cannot start, and the reason beats "FFSB_NO_DEELEVATE is set", which restart.ps1 sets after that failure.
  for (const f of [{ ...base, desktop: false }, { ...base, desktop: false, optedOut: true }]) {
    const p = planHandoff(f);
    assert.deepEqual(p, { handoff: false, why: NO_DESKTOP_WHY });
  }
  assert.match(NO_DESKTOP_WHY, /nobody is signed in/);
  assert.match(NO_DESKTOP_WHY, /Fix: sign in .* then right-click scripts\\restart\.cmd > Run as administrator/);
  // Unknown (not Windows, or PowerShell could not tell): as before.
  assert.deepEqual(planHandoff({ ...base, desktop: undefined }), { handoff: true });
  assert.deepEqual(planHandoff({ ...base, desktop: true }), { handoff: true });
  assert.deepEqual(planHandoff({ ...base, elevated: false, desktop: false }), { handoff: false });
});

test('desktop sign-in: explorer=<n> means signed in when n > 0; anything else is unknown', async () => {
  assert.equal(parseDesktopProbe('explorer=1\r\n'), true);
  assert.equal(parseDesktopProbe('explorer=0'), false);
  assert.equal(parseDesktopProbe(''), undefined);
  assert.equal(parseDesktopProbe('Get-CimInstance : Access denied'), undefined);
  const live = await desktopSignedIn();
  assert.equal(typeof live, process.platform === 'win32' ? 'boolean' : 'undefined');
});
