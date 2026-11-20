// w4868 (lothsahn, 2026-11-20: "There's no way to unlock the m3's screen, as Ben is out on vacation. Only run work on m3 it
// can do with the screen locked"): w4847, an FFU capture check that needs the Metal window to draw, was started on the
// locked m3 and its worker asked Ben to log in. Work that draws a window goes only where the screen is unlocked, headless
// work still goes to the locked computer, and no card asks a person to unlock a screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unfitWhy, type RoomFit } from '../shared/capacity.ts';
import { mentionsWindow, needsWindow, screenUnlockAskProblem, windowLacks } from '../shared/desktop.ts';
import { capacityLines, windowLine, type Computer } from './placement.ts';

const AT = '2026-11-20T06:00:00.000Z';
const GB = 1024 ** 3;
const box = (id: string, extra: Partial<Computer> = {}): Computer => ({ id, online: true, live: 0, midTurn: 0, maxAgents: 6, sandboxes: 3, maxSandboxes: 3, freeSandboxes: 3, memUsedBytes: 8 * GB, memTotalBytes: 64 * GB, editors: 0, maxEditors: 1, agentSeats: 6, ...extra });
const LOCKED = { checkedAt: AT, locked: true };
const OPEN = { checkedAt: AT };

// w4847 as filed, and a headless request of the same day.
const CAPTURE = { needs: 'agent' as const, title: "w2895 leg M2.31c: FFU M2.31b's capture legs on m3 Metal and lothdesktop's Arc", brief: 'Run M2.31b\'s two capture legs: on m3 (Metal) and on lothdesktop. These are pixel checks, not timing.' };
const HEADLESS = { needs: 'game' as const, title: 'Fix the belt splitter test', brief: 'Change the splitter and run its EditMode tests in batchmode.' };

test('w4868: work that draws a window is never placed on a computer reporting a locked screen; headless work still is', () => {
  const fit: Record<string, RoomFit> = { m3: { platform: 'darwin', desktop: LOCKED }, lothdesktop: { platform: 'win32', desktop: OPEN }, beast: { platform: 'win32' } };
  assert.match(unfitWhy(CAPTURE, 'm3', fit) ?? '', /^screen locked on m3: its work draws a window/);
  assert.equal(unfitWhy(CAPTURE, 'lothdesktop', fit), undefined);
  assert.equal(unfitWhy(CAPTURE, 'beast', fit), undefined, 'a daemon that reports no session locks nothing out');
  assert.equal(unfitWhy(HEADLESS, 'm3', fit), undefined, 'headless work still goes to the locked m3');
  // An outright mark beats the words, either way.
  assert.equal(unfitWhy({ ...CAPTURE, windowMark: { window: false, at: AT, by: 'dispatcher', note: 'offscreen captures' } }, 'm3', fit), undefined);
  assert.match(unfitWhy({ ...HEADLESS, windowMark: { window: true, at: AT, by: 'dispatcher', note: 'it records a clip' } }, 'm3', fit) ?? '', /^screen locked on m3/);
  assert.match(unfitWhy(CAPTURE, 'lothlaptop', { lothlaptop: { desktop: { checkedAt: AT, away: true } } }) ?? '', /^lothlaptop's console is another user's session/);
});

test("w4868: the Capacity block's window line names an unlocked computer and keeps the locked one for headless work", () => {
  const m3 = box('m3', { platform: 'darwin', desktop: LOCKED, maxAgents: 10, agentSeats: 10 });
  const loth = box('lothdesktop', { platform: 'win32', desktop: OPEN, live: 4, midTurn: 4, freeSandboxes: 1, agentSeats: 2 });
  const line = windowLine([m3, loth]) ?? '';
  assert.match(line, /^Next work that draws a window .*: lothdesktop \(/);
  assert.match(line, /Never on m3 \(screen locked on m3\)/);
  assert.match(line, /Headless work .* still goes there/);
  assert.match(windowLine([m3]) ?? '', /no computer with an unlocked screen has room now: it waits Queued/);
  assert.equal(windowLine([box('m3', { desktop: OPEN }), loth]), undefined, 'no line while no screen is locked');
  const block = capacityLines([m3, loth]);
  assert.ok(block.some((l) => l.startsWith('Next work that draws a window')));
  assert.ok(block.some((l) => /^Next non-game work .*: m3 \(/.test(l)), 'headless work still goes to the locked m3 first');
});

test('w4868: the words that mean a window, and the ones that rule it out', () => {
  for (const t of ['take a screenshot of the panel', 'Game view capture', 'enter play mode and look', 'record a clip at 60 fps', 'the FFU client draws frames', 'capture check on Metal', 'a playtest of the tech tree', 'Metal capture leg']) assert.ok(mentionsWindow(t), t);
  for (const t of ['run the PlayMode tests in batchmode', 'headless, no screenshots', 'still open: the EditMode tests', 'fix the window close button handler code']) assert.ok(!mentionsWindow(t), t);
  assert.ok(needsWindow(CAPTURE));
  assert.ok(!needsWindow(HEADLESS));
  assert.ok(needsWindow(HEADLESS, 'then take screenshots of the result'), 'the start prompt counts');
  assert.ok(!needsWindow({ ...CAPTURE, pair: { legs: 2 } }), 'a pair run goes by its menus mark');
  assert.equal(windowLacks('m5', LOCKED), 'screen locked on m5');
  assert.equal(windowLacks('m5', OPEN), undefined);
});

test('w4868: no card asks a person to unlock a screen or log in so a window can draw', () => {
  // w4847's own card (2026-11-20 04:23 and 05:45).
  assert.match(screenUnlockAskProblem('log in at the m3 (its screen is locked), so the FFU client\'s window can draw there for the Metal capture check', [], 'worker') ?? '', /never a person's ask/);
  assert.match(screenUnlockAskProblem('Metal leg', ['Can you unlock the m3 for about 15 minutes?'], 'worker') ?? '', /hand the step that draws a window/i);
  assert.match(screenUnlockAskProblem(undefined, ['The m5 screen is locked: unlock it?'], 'dispatcher') ?? '', /decide_work window true/);
  assert.equal(screenUnlockAskProblem('approve the release notes', ['Ship 1.0.2 today?'], 'worker'), undefined);
  assert.equal(screenUnlockAskProblem('m3 rebooted and FileVault waits for the password at the lock screen', [], 'worker'), undefined, 'a FileVault unlock after a reboot still goes through');
});
