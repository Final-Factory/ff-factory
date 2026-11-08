// w3697 (ben, 2026-11-08: "after a wasted run, the harness learns"): w3669, the pair run for PR #3433 (w3642's
// MP-W1587-gatling-tiers scenario fix), put leg 1 on m5 at 17:51 UTC. Each leg ran the scenario alone, host and client on
// one computer, and the game repo's scripts/nightly/player_slots.py require_mac_client_ok refuses a multiplayer client on a
// Mac: all 3 m5 runs ended 'env' in about 20 s, after a 10-minute Mac build. A pair whose legs each start an MP scenario's
// host and client now takes no Mac; a pair lab, the relay, a cross-OS pair or FF_MAC_GPU_HANG_OK=<request> still may host on one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { macRefusedScenario, pairRoom, unfitWhy } from '../shared/capacity.ts';
import type { Requester, WorkItem } from '../shared/types.ts';
import { roomForWork, type RoomNow } from './placement.ts';

const BEN: Requester = { userId: 'ben', displayName: 'Ben' };

// w3669 as filed (its title and the start of its brief, from the ledger).
const w3669 = (extra: Partial<WorkItem> = {}): WorkItem => ({
  id: 'w3669',
  title: 'Pair run for w3642: MP-W1587-gatling-tiers green runs on PR #3433 (w3642)',
  brief:
    'Request w3642: the MP-W1587-gatling-tiers nightly scenario failed on master f19f2af5e. The cause is the scenario, not the game. PR #3433 fixes the scenario.\n\n' +
    'The scenario runs both peers, host and client, on one computer, so every leg works on its own. Do not wait for the other leg.\n' +
    '3. Run the scenario 3 times: `python scripts/nightly/ffnightly.py run --scenario MP-W1587-gatling-tiers --no-retry`.',
  priority: 'high',
  keys: [],
  requestedBy: BEN,
  requesters: [BEN],
  humanAsked: false,
  status: 'queued',
  queuedFor: { at: '2026-11-08T14:54:00.000Z' },
  createdAt: '2026-11-08T14:54:00.000Z',
  updatedAt: '2026-11-08T14:54:00.000Z',
  sessionIds: [],
  needs: 'game',
  overlaps: [],
  asks: 0,
  log: [],
  pair: { legs: 2, for: 'w3642', avoid: ['biscuit'] },
  ...extra,
});

const FIT = { beast: { platform: 'win32' }, lothlaptop: { platform: 'win32' }, biscuit: { platform: 'linux' }, m3: { platform: 'darwin' }, m5: { platform: 'darwin' } };

test('w3697: w3669 (MP-W1587-gatling-tiers, host and client on each leg) takes no leg on a Mac, m5 included', () => {
  const w = w3669();
  assert.equal(macRefusedScenario(w), 'MP-W1587-gatling-tiers');
  assert.match(unfitWhy(w, 'm5', FIT) ?? '', /^m5 is a Mac, and each leg of this pair run starts MP-W1587-gatling-tiers's host and its client on its own computer: a Mac refuses a multiplayer client \(the game repo's scripts\/nightly\/player_slots\.py require_mac_client_ok/);
  assert.match(unfitWhy(w, 'm3', FIT) ?? '', /^m3 is a Mac/);
  assert.equal(unfitWhy(w, 'lothlaptop', FIT), undefined);
  // As at 17:51 UTC: m5 and lothlaptop had room. It now waits for a second Windows or Linux computer instead.
  const r: RoomNow = { game: ['m5', 'lothlaptop'], agent: [], held: [], fit: FIT };
  const one = roomForWork(r, w);
  assert.deepEqual(one.ids, []);
  assert.match(one.unfit.map((u) => u.why).join('\n'), /m5 is a Mac, and each leg/);
  assert.deepEqual(roomForWork({ ...r, game: ['m5', 'lothlaptop', 'beast'] }, w).ids, ['lothlaptop', 'beast']);
  assert.deepEqual(pairRoom(w, roomForWork({ ...r, game: ['m5', 'lothlaptop', 'beast'] }, w).ids, FIT).pick, ['lothlaptop', 'beast']);
});

test('w3697: a Mac still hosts a pair whose peers are spread over its computers, or one FF_MAC_GPU_HANG_OK names', () => {
  const r: RoomNow = { game: ['m5', 'beast'], agent: [], held: [], fit: FIT };
  const lab = w3669({ brief: 'Run MP-W1587-gatling-tiers with `ffnightly.py run --lab scripts/nightly/lab.pair-m5-beast.json`: m5 hosts, BEAST joins.' });
  assert.equal(macRefusedScenario(lab), undefined);
  assert.deepEqual(roomForWork(r, lab).ids, ['m5', 'beast']);
  assert.deepEqual(pairRoom(lab, ['beast', 'm5'], FIT).pick, ['m5', 'beast'], 'the Mac hosts (w2282)');
  const relay = w3669({ brief: 'The client leg runs scripts/nightly/pair_relay.py; the host runs MP-connector-delete-drops-items through it.' });
  assert.equal(unfitWhy(relay, 'm5', FIT), undefined);
  const cross = w3669({ pair: { legs: 2, crossOs: 'Burst codegen differs between arm64 and x86_64' } });
  assert.equal(unfitWhy(cross, 'm5', FIT), undefined, 'a cross-OS pair puts its client on the other OS');
  const repro = w3669({ brief: 'A w665 repro of MP-W1587-gatling-tiers: FF_MAC_GPU_HANG_OK=w665, the Mac\'s person agreed to unlock it.' });
  assert.equal(unfitWhy(repro, 'm5', FIT), undefined, 'the override lifts it, as it lifts the guard');
  // No MP scenario named: the w2282 rule as before (a Mac only as the host).
  const plain = w3669({ title: 'Pair run for w1: Steam lobby join check', brief: 'Host a game on leg 1, join it from leg 2.' });
  assert.equal(unfitWhy(plain, 'm5', FIT), undefined);
});

test('w3697: work that is no pair run keeps the w1944 rule, and the override lifts it too', () => {
  const solo = w3669({ pair: undefined, title: 'Repro MP-W1020-camps-settle-join', brief: 'Run it with ffnightly.py.' });
  assert.equal(unfitWhy(solo, 'm3', FIT), 'm3 is a Mac, which refuses the multiplayer client its MP scenario starts (w665)');
  assert.equal(unfitWhy({ ...solo, brief: 'Run it with FF_MAC_GPU_HANG_OK=w665.' }, 'm3', FIT), undefined);
});
