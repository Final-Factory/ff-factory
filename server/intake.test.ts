import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_PER_DAY, groupIntake, signatureOf, versionLine } from '../shared/intake.ts';
import type { ProviderIntakeEvent } from '../shared/types.ts';

const NOW = Date.parse('2026-09-28T12:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
let n = 0;
const desync = (o: { surfaces?: string; version?: string; sender?: string; group?: string; role?: 'host' | 'client'; min?: number }): ProviderIntakeEvent => ({
  reportId: `r${++n}`,
  kind: 'desync',
  receivedAt: ago(o.min ?? 10),
  gameVersion: o.version ?? '0.50.0.46',
  platform: 'WindowsPlayer',
  bytes: 1000,
  sender: o.sender,
  desync: { group: o.group ?? `g${n}`, role: o.role, divergedSurfaces: o.surfaces ?? 'minerBots+census' },
});

test('intake: the coarse signature is the version line and the diverged surfaces; a crash has only its version line', () => {
  assert.equal(versionLine('0.50.0.46'), '0.50.0');
  assert.equal(versionLine('0.50.0'), '0.50.0');
  assert.equal(signatureOf(desync({})), 'desync:0.50.0:minerBots+census');
  assert.equal(signatureOf({ ...desync({}), desync: {} }), 'desync:0.50.0:unknown');
  assert.equal(signatureOf({ ...desync({}), kind: 'crash', desync: undefined }), 'crash:0.50.0');
});

test('intake: one item per signature across builds; trusted with 2 senders or a host+client pair', () => {
  const events = [
    // One sender, two builds of one series: one item, not trusted.
    desync({ sender: 'a', version: '0.50.0.45', min: 30 }),
    desync({ sender: 'a', version: '0.50.0.46', min: 20 }),
    // Two senders: trusted.
    desync({ surfaces: 'fleets', sender: 'a', min: 15 }),
    desync({ surfaces: 'fleets', sender: 'b', min: 5 }),
    // One event reported by its host and its client (one sender for both): a pair, trusted.
    desync({ surfaces: 'power', sender: 'c', group: 'G', role: 'host', min: 3 }),
    desync({ surfaces: 'power', sender: 'c', group: 'G', role: 'client', min: 3 }),
    { ...desync({ min: 1 }), kind: 'crash' as const, desync: undefined, sender: 'd' },
    { ...desync({ min: 2 }), kind: 'crash' as const, desync: undefined, sender: 'e' },
  ];
  const g = groupIntake(events, NOW);
  assert.equal(g.reports, 8);
  const by = Object.fromEntries(g.signatures.map((s) => [s.signature, s]));
  assert.deepEqual(Object.keys(by), ['crash:0.50.0', 'desync:0.50.0:power', 'desync:0.50.0:fleets', 'desync:0.50.0:minerBots+census'], 'newest item first');
  assert.deepEqual([by['desync:0.50.0:minerBots+census'].reports, by['desync:0.50.0:minerBots+census'].trusted, by['desync:0.50.0:minerBots+census'].versions], [2, false, ['0.50.0.46', '0.50.0.45']]);
  assert.deepEqual([by['desync:0.50.0:fleets'].senders, by['desync:0.50.0:fleets'].trusted], [2, true]);
  assert.deepEqual([by['desync:0.50.0:power'].events, by['desync:0.50.0:power'].pair, by['desync:0.50.0:power'].trusted], [1, true, true]);
  assert.equal(by['crash:0.50.0'].trusted, false, 'crashes wait for their real signature (phase 6)');
  assert.equal(by['crash:0.50.0'].surfaces, undefined);

  assert.deepEqual(g.budget, {
    live: false,
    perDay: AUTO_PER_DAY,
    perHour: 3,
    newToday: 4,
    newLastHour: 4,
    trustedToday: 2,
    wouldStartToday: 2,
    stormBreaker: { threshold: 5, tripped: false },
  });
});

test('intake: the daily cap and the storm breaker', () => {
  const many = Array.from({ length: 30 }, (_, i) => [desync({ surfaces: `s${i}`, sender: 'a', min: 5 }), desync({ surfaces: `s${i}`, sender: 'b', min: 5 })]).flat();
  const old = desync({ surfaces: 'old', sender: 'a', min: 60 * 30 });
  const g = groupIntake([...many, old], NOW);
  assert.equal(g.budget.newToday, 30, 'a signature first seen yesterday is not new today');
  assert.equal(g.budget.trustedToday, 30);
  assert.equal(g.budget.wouldStartToday, 20, 'capped at 20 a day');
  assert.equal(g.budget.stormBreaker.tripped, true, 'more than 5 new signatures in an hour');
  assert.equal(groupIntake([], NOW).signatures.length, 0);
});
