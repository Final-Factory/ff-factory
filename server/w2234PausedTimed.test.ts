// w2234: when timed work waits, the line names each computer it skipped and why (a paused laptop, offline, busy).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickComputer, timedLine, type Computer } from './placement.ts';

const GB = 1024 ** 3;
const box = (id: string, o: Partial<Computer> = {}): Computer => ({ id, online: true, live: 0, midTurn: 0, maxAgents: 2, sandboxes: 1, maxSandboxes: 1, freeSandboxes: 1, memUsedBytes: 16 * GB, memTotalBytes: 64 * GB, editors: 0, maxEditors: 1, platform: 'linux', ...o });
const PAUSED = 'paused from its tray app: paused by hand (w1532)';

test('w2234: a paused small computer is skipped and the timed line says "waits on lothlaptop: paused from its tray app"', () => {
  const places = [box('lothlaptop'), box('beast', { online: false }), box('m3', { midTurn: 2, freeSandboxes: 0, sandboxes: 1 })];
  const prefs = { hold: { lothlaptop: PAUSED } };
  const line = timedLine(places, undefined, prefs)!;
  assert.match(line, /^No computer has room for timed work now/);
  assert.match(line, /waits on lothlaptop: paused from its tray app: paused by hand/);
  assert.match(line, /beast: offline/);
  assert.match(line, /m3: busy \(/);
  // Placement is unchanged: nothing is picked while the only fitting computer is paused.
  assert.equal(pickComputer(places, undefined, prefs, 'game', false, 'timed'), undefined);
});

test('w2234: no skipped computers, no waits-on text', () => {
  assert.doesNotMatch(timedLine([box('a'), box('b')])!, /waits on/);
});
