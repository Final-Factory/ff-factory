import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { batchUnityIn, holdKey, nightsIn, slotRunsFor, switchHoldRefusal } from '../machine/switchHolds.ts';
import type { SlotRequest } from '../machine/unitySlots.ts';

// The w3610 case (2026-11-08): the w3598 night's attempt 2 builds master f19f2af5 with build_player.sh in lothdesktop/slot1,
// and a second worker there calls switch_branch at 05:01 EST (10:01 UTC).
const SLOT1 = 'D:\\work\\ffw\\sandboxes\\slot1';
const STARTED = Date.parse('2026-11-08T09:12:00Z') / 1000;
const NOW = Date.parse('2026-11-08T10:01:00Z');
const night = { tag: '2026-11-08', date: '2026-11-08', rehearsal: false, status: 'running', started: STARTED, host: 'LothDesktop', attempt: 2, step: 'build', stepAt: STARTED, log: '/d/work/ffw/nightly-history/logs/nightly-2026-11-08.log', run: '/d/work/ffw/nightly-history/runs/2026-11-08', request: 'w3598', mode: 'sandbox', builds: '/d/work/ffw/sandboxes/slot1/Builds/cache', pid: 41872 };
const build: SlotRequest = { id: 'b1', holder: 'sandbox:slot1', count: 1, pid: 40100, label: 'nightly build f19f2af5', session: 'w3598-worker', createdAt: NOW - 600_000, grantedAt: Date.parse('2026-11-08T09:58:00Z') };

function history(states: Record<string, unknown>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-nh-'));
  fs.mkdirSync(path.join(root, 'state'));
  for (const [n, st] of Object.entries(states)) fs.writeFileSync(path.join(root, 'state', n), JSON.stringify(st));
  return root;
}

test("w3626: holdKey reads nightly.sh's cygpath -u paths and the daemon's Windows paths as one", () => {
  assert.equal(holdKey('/d/work/ffw/sandboxes/slot1/', 'win32'), 'd:/work/ffw/sandboxes/slot1');
  assert.equal(holdKey(SLOT1, 'win32'), 'd:/work/ffw/sandboxes/slot1');
  assert.equal(holdKey('/d/work/x', 'linux'), '/d/work/x', 'only Windows maps a drive');
});

test('w3626: the w3610 case: a night running in lothdesktop/slot1 refuses its switch, naming the date and request', () => {
  const root = history({ '2026-11-08.json': night, '2026-11-07.json': { ...night, tag: '2026-11-07', date: '2026-11-07', status: 'done', request: 'w3580' } });
  try {
    const nights = nightsIn({ roots: [root, path.join(root, 'missing')], checkout: SLOT1, platform: 'win32', alive: (pid) => pid === 41872, now: NOW });
    assert.deepEqual(nights.map((n) => [n.date, n.request]), [['2026-11-08', 'w3598']], 'only the running night');
    const why = switchHoldRefusal('slot1', { nights, runs: [], batch: [] });
    assert.equal(why, 'switch refused: the nightly run of 2026-11-08 (request w3598, attempt 2, step build) runs in it since 09:12 UTC, pid 41872. A switch now would change the tree under that build (w3626: on 2026-11-08 one moved a nightly\'s build in lothdesktop/slot1 onto another commit). Wait until it ends (wake_me), then switch; nothing was switched.');
    // Another sandbox's switch is not held by it, nor by a night whose shell is gone or a leftover from days ago.
    assert.deepEqual(nightsIn({ roots: [root], checkout: 'D:\\work\\ffw\\sandboxes\\slot10', platform: 'win32', alive: () => true, now: NOW }), [], 'slot10 is not slot1');
    assert.deepEqual(nightsIn({ roots: [root], checkout: SLOT1, platform: 'win32', alive: () => false, now: NOW }), [], 'its process is gone');
    assert.deepEqual(nightsIn({ roots: [root], checkout: SLOT1, platform: 'win32', alive: () => true, now: NOW + 3 * 86400_000 }), [], 'three days old');
    // A state file that names its checkout (a later nightly.sh) counts by it.
    const named = history({ 'a.json': { status: 'running', date: '2026-11-09', request: 'w3700', checkout: '/d/work/ffw/sandboxes/slot1' } });
    assert.equal(nightsIn({ roots: [named], checkout: SLOT1, platform: 'win32', alive: () => true, now: NOW }).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("w3626: the w3610 case: a unity-slot batch build holding slot1's slot refuses its switch, naming the run and its owner", () => {
  const waiting: SlotRequest = { ...build, id: 'b2', grantedAt: undefined, label: 'waits' };
  const other: SlotRequest = { ...build, id: 'b3', holder: 'sandbox:slot2', label: 'slot2 tests' };
  const byProject: SlotRequest = { ...build, id: 'b4', holder: 'pid:777', pid: 777, label: 'detached build', projects: ['d:/work/ffw/sandboxes/slot1/'], session: undefined };
  const runs = slotRunsFor([build, waiting, other, byProject], 'slot1', SLOT1, 'win32');
  assert.deepEqual(runs.map((r) => r.id), ['b1', 'b4'], 'granted runs of slot1, by holder or by project; a waiting one holds nothing');
  const batch = batchUnityIn([{ pid: 40101, ppid: 40100, kind: 'batch', project: 'D:/work/ffw/sandboxes/slot1' }, { pid: 5, ppid: 1, kind: 'interactive', project: SLOT1 }], SLOT1, 'win32');
  const why = switchHoldRefusal('slot1', { nights: [], runs: [build], batch });
  assert.equal(why, 'switch refused: the unity-slot run "nightly build f19f2af5" holds 1 Unity slot(s) for it (holder sandbox:slot1, session w3598-worker, pid 40100, since 09:58 UTC). A switch now would change the tree under that build (w3626: on 2026-11-08 one moved a nightly\'s build in lothdesktop/slot1 onto another commit). Wait until it ends (wake_me), then switch; nothing was switched.');
  // A batchmode Unity started outside the gate on slot1's project holds it too; an interactive one is the editor rule's.
  assert.match(switchHoldRefusal('slot1', { nights: [], runs: [], batch })!, /a batchmode Unity has its project open \(pid 40101\)/);
  assert.equal(switchHoldRefusal('slot1', { nights: [], runs: [], batch: [] }), undefined, 'nothing holds it: the switch goes on');
});
