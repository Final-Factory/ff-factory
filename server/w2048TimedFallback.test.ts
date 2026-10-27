// w2048: timed runs fall back to BEAST or LothDesktop when no small computer can take them. lothsahn, 2026-10-24:
// "sometimes machines go offline. We should still allow timed runs on larger machines if there are no other machines
// available to take them"; "Timings can't be compared across machines at all"; "The dispatcher should have a rule to rerun
// the baseline if a machine is offline or unavailable too long"; "If the fleet is idle it should wait far less than if the
// fleet is busy".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decideTimedPlace, fleetLoad, smallTimedStates, unavailableWait, TIMED_WAIT_BUSY_MIN, TIMED_WAIT_IDLE_MIN } from './timedAsk.ts';
import { TimedRuns, type TimedRunRecord } from './timedRuns.ts';
import { normalizeSetting } from './appConfig.ts';
import type { Computer } from './placement.ts';
import type { Machine } from '../shared/types.ts';

const GB = 1024 ** 3;
const NOW = Date.parse('2026-10-24T14:00:00Z');
const NO = 'lothsahn, 2026-10-23: "The m5 should not be used for timing runs because Ben runs stuff on it personally"';
const box = (id: string, maxAgents: number, platform: string, o: Partial<Computer> = {}): Computer => ({
  id,
  online: true,
  live: 1,
  midTurn: 0,
  maxAgents,
  sandboxes: 1,
  maxSandboxes: Math.max(1, Math.ceil(maxAgents / 2)),
  freeSandboxes: 1,
  memUsedBytes: 16 * GB,
  memTotalBytes: 64 * GB,
  editors: 0,
  maxEditors: 2,
  platform,
  ...o,
});
// The fleet as the portal's capacity line had it on 2026-10-24 14:04Z (journal "Next timed work"): LothLaptop 1 agent slot,
// biscuit 4, m3 3 (offline since 06:50Z), BEAST 6, LothDesktop 10, m5 (no timed runs).
const fleet = (o: Record<string, Partial<Computer>> = {}): Computer[] =>
  [
    box('beast', 6, 'win32', { live: 6, midTurn: 5 }),
    box('lothdesktop', 10, 'win32', { live: 4, midTurn: 4 }),
    box('lothlaptop', 1, 'win32', { live: 0 }),
    box('biscuit', 4, 'linux', { live: 3, midTurn: 2 }),
    box('m3', 3, 'darwin', { online: false, offlineSince: '2026-10-24T06:50:00Z' }),
    box('m5', 4, 'darwin', { noTimedRuns: NO }),
  ].map((c) => ({ ...c, ...o[c.id] }));
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const off = (min: number): Partial<Computer> => ({ online: false, offlineSince: ago(min) });
const WAIT = TIMED_WAIT_IDLE_MIN * 60_000;
const ask = (here: string, places: Computer[], platform?: string) => decideTimedPlace({ here: places.find((c) => c.id === here), places, platform, now: NOW, waitMs: WAIT, waitWhy: '5 min' });

test('w2048: all small computers offline past the wait: the leg times here on the big computer, saying which were unavailable and that every side runs here', () => {
  const places = fleet({ lothlaptop: off(90), biscuit: off(45) });
  for (const big of ['beast', 'lothdesktop']) {
    const d = ask(big, places);
    assert.equal(d.verdict, 'here', big);
    assert.match(d.bigFallback ?? '', /lothlaptop offline since 12:30Z \(90 min\); m3 offline since 06:50Z \(430 min\)/);
    assert.match(d.why, new RegExp(`time here on ${big}, a big computer \\(w2048\\)\\. Every number of this comparison comes from ${big}: run every side on ${big} \\(A and B, the baseline and the change\\), re-measure here any baseline that ran on another computer, and never compare with another computer's numbers`));
    assert.match(d.why, /never m5/);
  }
});

test('w2048: one small computer online, even busy, the leg waits for it there; a blip offline counts as online', () => {
  const busy: Partial<Computer> = { live: 1, midTurn: 1, freeSandboxes: 0, sandboxes: 1, maxSandboxes: 1 };
  const one = ask('beast', fleet({ biscuit: off(45), lothlaptop: busy }), 'win32');
  assert.equal(one.verdict, 'elsewhere');
  assert.deepEqual(one.needs, ['lothlaptop']);
  assert.equal(one.bigFallback, undefined);
  const blip = ask('lothdesktop', fleet({ lothlaptop: off(0.5), biscuit: off(45) }), 'win32');
  assert.equal(blip.verdict, 'elsewhere', 'a 30 s drop (a deploy, a link flap) is waited out');
  assert.deepEqual(blip.needs, ['lothlaptop']);
  const states = smallTimedStates(fleet({ lothlaptop: off(0.5) }), {}, undefined, 'beast', NOW, WAIT);
  assert.deepEqual(states.map((s) => [s.id, s.state]), [['lothlaptop', 'able'], ['m3', 'offline']]);
});

test('w2048: m5 never takes timed work, not even when it is the only computer online', () => {
  const places = fleet({ lothlaptop: off(90), biscuit: off(90), beast: off(90), lothdesktop: off(90) });
  assert.ok(!smallTimedStates(places, {}, undefined, undefined, NOW, WAIT).some((s) => s.id === 'm5'));
  const m5 = ask('m5', places, 'darwin');
  assert.equal(m5.verdict, 'elsewhere');
  // w2147: the leg is still filed, Queued for the Mac that takes timed runs though it is offline, never "ask an operator".
  assert.deepEqual(m5.needs, ['m3']);
  assert.match(m5.why, /m5 takes no timed runs/);
  assert.match(m5.why, /waits Queued for m3 and starts by itself/);
  assert.doesNotMatch(m5.why, /operator/);
});

test('w2048: a small computer that is held or has no game sandbox cannot take it, at once', () => {
  const st = smallTimedStates(fleet({ biscuit: { maxSandboxes: 0 } }), { hold: { lothlaptop: 'lothsahn using it' } }, undefined, 'beast', NOW, WAIT);
  assert.deepEqual(st.map((s) => `${s.id}:${s.state}:${s.why}`), ['lothlaptop:unable:lothlaptop is held (lothsahn using it)', 'm3:offline:m3 offline since 06:50Z (430 min)']);
  assert.equal(decideTimedPlace({ here: fleet().find((c) => c.id === 'beast'), places: fleet({ biscuit: { maxSandboxes: 0 } }), prefs: { hold: { lothlaptop: 'x' } }, now: NOW, waitMs: WAIT }).verdict, 'here');
});

test('w2048: a widened timed leg times where it is, with the same rules', () => {
  const d = decideTimedPlace({ here: fleet().find((c) => c.id === 'lothdesktop'), places: fleet(), widenedLeg: 'w2100', now: NOW, waitMs: WAIT });
  assert.equal(d.verdict, 'here');
  assert.match(d.why, /^w2100 is a timed leg FF Factory widened to the big computers, as no small computer could take it \(w2048\): time here\. Every number of this comparison comes from lothdesktop/);
});

test('w2048: the wait scales with the fleet load: 5 min idle, 60 min busy, a straight line between, and the settings move both ends', () => {
  assert.equal(TIMED_WAIT_IDLE_MIN, 5);
  assert.equal(TIMED_WAIT_BUSY_MIN, 60);
  // Idle: 2026-10-24 13:25Z had 1 request Queued and few mid-turn.
  const idle = fleet({ beast: { midTurn: 1 }, lothdesktop: { midTurn: 1 }, biscuit: { midTurn: 0 } });
  const li = fleetLoad(idle, 1);
  assert.ok(li <= 0.5, `idle load ${li}`);
  assert.equal(unavailableWait(li).ms, 5 * 60_000);
  assert.match(unavailableWait(li).why, /^5 min, as the fleet is at \d+% load/);
  // Busy: 12:17Z had 10 requests Queued with every slot taken.
  const busy = fleet({ beast: { midTurn: 6 }, lothdesktop: { midTurn: 10 }, lothlaptop: { midTurn: 1 }, biscuit: { midTurn: 4 } });
  assert.equal(unavailableWait(fleetLoad(busy, 10)).ms, 60 * 60_000);
  assert.equal(unavailableWait(0.75).ms, Math.round(5 + 55 * 0.5) * 60_000, 'halfway');
  assert.equal(unavailableWait(0.2, { unavailableIdleMinutes: 2, unavailableBusyMinutes: 30 }).ms, 2 * 60_000);
  assert.equal(unavailableWait(3, { unavailableIdleMinutes: 2, unavailableBusyMinutes: 30 }).ms, 30 * 60_000);
  assert.equal(fleetLoad([], 0), 1, 'nothing online counts as busy');
  // Idle vs busy on the same outage: lothlaptop gone 20 min falls back when idle, still waits when busy.
  const gone = fleet({ lothlaptop: off(20), biscuit: off(90) });
  const waitIdle = unavailableWait(fleetLoad(gone.map((c) => ({ ...c, midTurn: 0 })), 0)).ms;
  const waitBusy = unavailableWait(fleetLoad(gone.map((c) => ({ ...c, midTurn: c.maxAgents })), 10)).ms;
  assert.equal(decideTimedPlace({ here: gone[0], places: gone, platform: 'win32', now: NOW, waitMs: waitIdle }).verdict, 'here', 'idle: falls back');
  assert.equal(decideTimedPlace({ here: gone[0], places: gone, platform: 'win32', now: NOW, waitMs: waitBusy }).verdict, 'elsewhere', 'busy: waits');
  assert.equal(normalizeSetting('timing.unavailableIdleMinutes', '3'), 3);
  assert.throws(() => normalizeSetting('timing.unavailableBusyMinutes', 0), /whole number of minutes from 1 to 720/);
});

// ---------------------------------------------------------------- timed_run: the baseline re-run elsewhere

function runs(t: { after: (f: () => void) => void }, o: { online: Record<string, boolean>; lastSeen?: Record<string, string>; waitMs?: number }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2048-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const told: string[] = [];
  const posted: string[] = [];
  let now = NOW;
  const machine = (id: string): Machine => ({ id, online: o.online[id], lastSeen: o.lastSeen?.[id], sandboxRoot: 'F:/ffw', platform: 'win32' }) as unknown as Machine;
  const r = new TimedRuns({
    dataDir: dir,
    store: { get: (id: string) => (id === 'x' ? { id, sha256: '0'.repeat(64) } : undefined), grant: () => {}, begin: () => ({ uploadId: 'u', chunkBytes: 1 }), forget: () => {} } as never,
    machines: () => ['lothlaptop', 'play1'].map(machine),
    isOnline: (id) => !!o.online[id],
    offers: (id) => !!o.online[id],
    post: (id) => (posted.push(id), true),
    deliver: async (_s, text) => void told.push(text),
    smallWorker: (m) => (m.id === 'lothlaptop' ? { agents: 1 } : { agents: 2 }),
    unavailableWait: () => ({ ms: o.waitMs ?? 5 * 60_000, why: '5 min, as the fleet is at 30% load' }),
    now: () => now,
  });
  const queued = (id: string, on: string): TimedRunRecord => ({ id, session: 's1', requests: ['w9'], what: 'A/B', from: 'beast', machine: on, state: 'queued', createdAt: ago(30), updatedAt: ago(1), order: { id, what: 'A/B', requests: ['w9'], session: 's1', variants: [], save: { id: 'x', name: 's.zip', sha256: '0'.repeat(64), size: 1 }, pieceIds: {}, settings: { rounds: 4, settleS: 25, sampleS: 20, res: '1920x1080' } } as never });
  return { r, told, posted, queued, step: (min: number) => void (now += min * 60_000), runsMap: (r as unknown as { runs: Map<string, TimedRunRecord> }).runs };
}

test('w2048: a timed run queued on a computer offline past the wait moves to another and plays every build again there, the baseline included', async (t) => {
  const x = runs(t, { online: { lothlaptop: false, play1: true }, lastSeen: { lothlaptop: ago(30) } });
  x.runsMap.set('tr_a', x.queued('tr_a', 'lothlaptop'));
  assert.deepEqual(x.r.retarget(), ['tr_a']);
  const moved = x.runsMap.get('tr_a')!;
  assert.equal(moved.machine, 'play1');
  assert.match(moved.movedFrom?.[0] ?? '', /^lothlaptop: lothlaptop offline for 30 min, past the wait of 5 min/);
  await new Promise((r) => setImmediate(r));
  assert.match(x.told.join('\n'), /moved from lothlaptop to play1 \(w2048\).*It plays every build again on play1, your baseline included, so all of its numbers come from play1\. Compare them with no number measured on lothlaptop or any other computer/);
  assert.deepEqual(x.posted, ['play1']);
});

test('w2048: a blip or a short outage keeps the run on its computer', (t) => {
  const x = runs(t, { online: { lothlaptop: false, play1: true }, lastSeen: { lothlaptop: ago(2) } });
  x.runsMap.set('tr_b', x.queued('tr_b', 'lothlaptop'));
  assert.deepEqual(x.r.retarget(), []);
  assert.equal(x.runsMap.get('tr_b')!.machine, 'lothlaptop');
});

test('w2048: with no other computer for it, the run stays queued and its worker is told once to time it itself', async (t) => {
  const x = runs(t, { online: { lothlaptop: false, play1: false }, lastSeen: { lothlaptop: ago(30), play1: ago(30) } });
  x.runsMap.set('tr_c', x.queued('tr_c', 'lothlaptop'));
  assert.deepEqual(x.r.retarget(), []);
  x.r.retarget();
  await new Promise((r) => setImmediate(r));
  assert.equal(x.told.length, 1, 'told once');
  assert.match(x.told[0], /no other computer that takes a timed run can take it now.*call timed_place again with via "leg"/);
  assert.equal(x.runsMap.get('tr_c')!.machine, 'lothlaptop');
});

test('w2048: a second timed run with no machine named goes to the computer its request\'s first run used, so its numbers compare', (t) => {
  const x = runs(t, { online: { lothlaptop: true, play1: true } });
  const target = (who?: { session: string; requests: string[] }) => (x.r as unknown as { target: (n: unknown, w?: unknown) => string }).target(undefined, who);
  assert.equal(target(), 'lothlaptop', 'the ranking alone picks LothLaptop (1 agent slot)');
  x.runsMap.set('tr_old', { ...x.queued('tr_old', 'play1'), state: 'done', order: undefined, session: 'other', requests: ['w9'] });
  assert.equal(target({ session: 's2', requests: ['w9'] }), 'play1', 'w9 ran on play1 before');
  assert.equal(target({ session: 's3', requests: ['w10'] }), 'lothlaptop', 'another request: the ranking');
});
