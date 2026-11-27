// w6311 (lothsahn, 2026-11-26): w6282, a 1-leg windowed pair run filed "only on computers whose screen is unlocked", went on
// biscuit/slot3 while biscuit's GNOME desktop was locked (GetActive answered (true,), loginctl showed session 2 idle 4 days),
// and its player drew no frames (/v1/screenshot 409 no_frame_available). A Linux daemon reported no desktop session, which
// locked nothing out. It now reads GNOME's ScreenSaver, else loginctl's hints; placement only warns until LINUX_LOCK_ENFORCED.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unfitWhy, type RoomFit } from '../shared/capacity.ts';
import { desktopLabel, desktopLacks, LINUX_LOCK_ENFORCED, linuxLockWarn, sanitizeDesktop, windowLacks } from '../shared/desktop.ts';
import { readLinuxDesktop } from '../machine/steamClient.ts';
import type { RunOptions, RunResult } from './proc.ts';

const AT = '2026-11-26T21:40:00.000Z';

/** A Linux box: each command's answer by its first two words ("gdbus call", "loginctl show-user", "loginctl show-session"). */
const linux = (answers: Record<string, RunResult | Error>) => {
  const ran: { cmd: string; env?: NodeJS.ProcessEnv }[] = [];
  return {
    ran,
    now: () => new Date(AT),
    run: async (cmd: string, args: string[], opts?: RunOptions): Promise<RunResult> => {
      const key = `${cmd} ${args[0]}`;
      ran.push({ cmd: [cmd, ...args].join(' '), env: opts?.env });
      const a = answers[key];
      if (a instanceof Error) throw a;
      return a ?? { code: 1, stdout: '', stderr: 'not found' };
    },
  };
};
const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });
const SESSION = { uid: 1000, env: {} };

test('w6311: a Linux daemon reads GNOME ScreenSaver GetActive on the user session bus', async () => {
  const locked = linux({ 'gdbus call': ok('(true,)\n') });
  assert.deepEqual(await readLinuxDesktop(locked, SESSION), { checkedAt: AT, via: 'gnome', locked: true });
  assert.equal(locked.ran[0].cmd, 'gdbus call --session --dest org.gnome.ScreenSaver --object-path /org/gnome/ScreenSaver --method org.gnome.ScreenSaver.GetActive');
  assert.equal(locked.ran[0].env?.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1000/bus', 'a daemon with no session bus in its environment finds the user bus');
  assert.equal(locked.ran.length, 1, 'GNOME answered: loginctl is not asked');
  assert.deepEqual(await readLinuxDesktop(linux({ 'gdbus call': ok('(false,)') }), SESSION), { checkedAt: AT, via: 'gnome' });
  const own = linux({ 'gdbus call': ok('(false,)') });
  await readLinuxDesktop(own, { uid: 1000, env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus,guid=x' } });
  assert.equal(own.ran[0].env?.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1000/bus,guid=x', 'its own bus is kept');
});

test('w6311: without GNOME it reads loginctl LockedHint and IdleHint of the graphical session; neither is via none', async () => {
  const noGnome = { 'gdbus call': { code: 1, stdout: '', stderr: 'Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown' } };
  const idle = linux({ ...noGnome, 'loginctl show-user': ok('2\n'), 'loginctl show-session': ok('LockedHint=no\nIdleHint=yes\n') });
  assert.deepEqual(await readLinuxDesktop(idle, SESSION), { checkedAt: AT, via: 'loginctl', locked: true }, "biscuit's session 2, idle 4 days");
  assert.deepEqual(idle.ran.slice(1).map((r) => r.cmd), ['loginctl show-user 1000 -p Display --value', 'loginctl show-session 2 -p LockedHint -p IdleHint']);
  assert.deepEqual(await readLinuxDesktop(linux({ ...noGnome, 'loginctl show-user': ok('2'), 'loginctl show-session': ok('LockedHint=yes\nIdleHint=no') }), SESSION), { checkedAt: AT, via: 'loginctl', locked: true });
  assert.deepEqual(await readLinuxDesktop(linux({ ...noGnome, 'loginctl show-user': ok('2'), 'loginctl show-session': ok('LockedHint=no\nIdleHint=no') }), SESSION), { checkedAt: AT, via: 'loginctl' });
  assert.deepEqual(await readLinuxDesktop(linux({ ...noGnome, 'loginctl show-user': ok('\n') }), SESSION), { checkedAt: AT, via: 'none' }, 'no graphical session');
  assert.deepEqual(await readLinuxDesktop(linux({ 'gdbus call': new Error('ENOENT'), 'loginctl show-user': new Error('ENOENT') }), SESSION), { checkedAt: AT, via: 'none' }, 'neither tool');
  assert.deepEqual(await readLinuxDesktop(linux({ 'gdbus call': ok('garbage') }), SESSION), { checkedAt: AT, via: 'none' });
});

test('w6311 warn-only: a Linux reading changes no placement yet; it says what it would refuse', () => {
  assert.equal(LINUX_LOCK_ENFORCED, false, 'the enforce step is its own PR');
  const LOCKED = { checkedAt: AT, via: 'gnome' as const, locked: true };
  const UNKNOWN = { checkedAt: AT, via: 'none' as const };
  const OPEN = { checkedAt: AT, via: 'gnome' as const };
  const fit: Record<string, RoomFit> = { biscuit: { platform: 'linux', desktop: LOCKED } };
  const pair = { title: 'Pair run for w6241: CLIP-W6241-route-line before/after', brief: 'Record the clips.', pair: { legs: 1, menus: 'its windowed player' } };
  assert.equal(unfitWhy(pair, 'biscuit', fit), undefined);
  assert.equal(desktopLacks('biscuit', LOCKED), undefined);
  assert.equal(windowLacks('biscuit', UNKNOWN), undefined);
  assert.equal(linuxLockWarn('biscuit', LOCKED), 'would not place: biscuit screen locked (gnome; w6311, warn-only)');
  assert.match(linuxLockWarn('biscuit', UNKNOWN) ?? '', /^would not place: biscuit screen lock unknown/);
  assert.equal(linuxLockWarn('biscuit', OPEN), undefined);
  assert.equal(linuxLockWarn('m3', { checkedAt: AT, locked: true }), undefined, 'a Mac or Windows reading already refuses; no warning');
  assert.equal(desktopLabel(LOCKED), 'locked (gnome, warn-only)');
  assert.equal(desktopLabel(OPEN), 'unlocked (gnome, warn-only)');
  // Mac and Windows readings are unchanged.
  assert.equal(desktopLacks('m3', { checkedAt: AT, locked: true }), "m3's screen is locked");
  assert.equal(desktopLabel({ checkedAt: AT, locked: true }), 'locked');
  assert.deepEqual(sanitizeDesktop({ checkedAt: AT, locked: true, via: 'gnome' }), LOCKED);
  assert.deepEqual(sanitizeDesktop({ checkedAt: AT, via: 'rm -rf' }), { checkedAt: AT });
});
