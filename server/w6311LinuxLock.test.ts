// w6311 (lothsahn, 2026-11-26): w6282, a 1-leg windowed pair run filed "only on computers whose screen is unlocked", went on
// biscuit/slot3 while biscuit's GNOME desktop was locked (GetActive answered (true,), loginctl showed session 2 idle 4 days),
// and its player drew no frames (/v1/screenshot 409 no_frame_available). A Linux daemon reported no desktop session, which
// locked nothing out. It now reads GNOME's ScreenSaver, else loginctl's hints; placement warned first (#1432), and now refuses
// windowed work there (LINUX_LOCK_ENFORCED).
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

test('w6311 enforced: a locked or unreadable Linux desktop takes no windowed work or menus pair leg; headless work still goes', () => {
  assert.equal(LINUX_LOCK_ENFORCED, true, 'enforced after the warn-only step (#1432) read biscuit locked');
  const LOCKED = { checkedAt: AT, via: 'gnome' as const, locked: true };
  const IDLE = { checkedAt: AT, via: 'loginctl' as const, locked: true };
  const UNKNOWN = { checkedAt: AT, via: 'none' as const };
  const OPEN = { checkedAt: AT, via: 'gnome' as const };
  const pair = { title: 'Pair run for w6241: CLIP-W6241-route-line before/after', brief: 'Record the clips.', pair: { legs: 1, menus: 'its windowed player' } };
  const CAPTURE = { needs: 'agent' as const, title: 'Take screenshots of the route line', brief: 'Record a clip of the windowed player.' };
  const HEADLESS = { needs: 'game' as const, title: 'Fix the belt splitter test', brief: 'Change the splitter and run its EditMode tests in batchmode.' };
  const on = (desktop: object): Record<string, RoomFit> => ({ biscuit: { platform: 'linux', desktop } as RoomFit });
  // w6282 as it went: a windowed pair leg on biscuit behind a locked GNOME desktop.
  assert.match(unfitWhy(pair, 'biscuit', on(LOCKED)) ?? '', /biscuit's screen is locked \(read by gnome\)/);
  assert.match(unfitWhy(CAPTURE, 'biscuit', on(LOCKED)) ?? '', /^screen locked on biscuit \(read by gnome\)/);
  assert.match(unfitWhy(CAPTURE, 'biscuit', on(IDLE)) ?? '', /^screen locked on biscuit \(read by loginctl\)/);
  assert.match(unfitWhy(CAPTURE, 'biscuit', on(UNKNOWN)) ?? '', /can't be read/, "can't tell counts as locked for a window");
  assert.match(desktopLacks('biscuit', UNKNOWN) ?? '', /can't be read/);
  for (const d of [LOCKED, IDLE, UNKNOWN]) assert.equal(unfitWhy(HEADLESS, 'biscuit', on(d)), undefined, 'headless work still goes there');
  assert.equal(unfitWhy(pair, 'biscuit', on(OPEN)), undefined, 'unlocked at the next reading: it takes the leg, nobody at the machine');
  assert.equal(unfitWhy(CAPTURE, 'biscuit', on(OPEN)), undefined);
  assert.equal(windowLacks('biscuit', OPEN), undefined);
  // Once enforced, no warning: the refusal says it.
  assert.equal(linuxLockWarn('biscuit', LOCKED), undefined);
  assert.equal(linuxLockWarn('biscuit', UNKNOWN), undefined);
  assert.equal(desktopLabel(LOCKED), 'locked (gnome)');
  assert.equal(desktopLabel(OPEN), 'unlocked (gnome)');
  // Mac and Windows readings are unchanged.
  assert.equal(desktopLacks('m3', { checkedAt: AT, locked: true }), "m3's screen is locked");
  assert.equal(desktopLabel({ checkedAt: AT, locked: true }), 'locked');
  assert.deepEqual(sanitizeDesktop({ checkedAt: AT, locked: true, via: 'gnome' }), LOCKED);
  assert.deepEqual(sanitizeDesktop({ checkedAt: AT, via: 'rm -rf' }), { checkedAt: AT });
});
