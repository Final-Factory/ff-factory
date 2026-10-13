import { test } from 'node:test';
import assert from 'node:assert/strict';
import { namesReporter, namesRequesters, sourceLabel, untrustedLabel } from '../shared/workLabels.ts';
import type { WorkSource } from '../shared/types.ts';

const dev = (reporter?: string, o: Partial<WorkSource> = {}): WorkSource => ({ kind: 'ffbox-dev', untrusted: false, channel: 'FFBox web', ...(reporter ? { reporter } : {}), ...o });

test('workLabels: an FFBox dev request reads "<operator> (FFBox)" for every operator (w1105)', () => {
  assert.equal(sourceLabel(dev('lothsahn')), 'lothsahn (FFBox)');
  assert.equal(sourceLabel(dev('ben')), 'ben (FFBox)');
  assert.equal(sourceLabel(dev('Some Operator')), 'Some Operator (FFBox)');
  assert.equal(sourceLabel(dev()), 'FFBox dev request', 'no operator on record: nothing to put before (FFBox)');
});

test('workLabels: the other sources keep their labels', () => {
  assert.equal(sourceLabel({ ...dev(), kind: 'ffbox-branch' }), 'FFBox branch');
  assert.equal(sourceLabel({ ...dev(), kind: 'ffbox-request' }), 'FFBox request');
  assert.equal(sourceLabel({ ...dev('Pat'), kind: 'discord-request' }), 'Discord request from Pat');
  assert.equal(sourceLabel({ ...dev(), kind: 'discord-bug' }), 'Discord bug');
  assert.equal(sourceLabel({ ...dev(), kind: 'nightly', nightly: { date: '2026-10-11' } } as WorkSource), 'Nightly regression 2026-10-11');
  assert.equal(sourceLabel({ ...dev(), kind: 'master-batch', masterBatch: { run: '5', tip: 'a'.repeat(40), kind: 'culprit', pr: 1234 } } as WorkSource), 'Master batch red (#1234)');
  assert.equal(sourceLabel({ ...dev(), kind: 'master-batch' } as WorkSource), 'Master batch red');
});

test('workLabels: the detail names the operator once and keeps a short untrusted marking (w1105)', () => {
  assert.equal(untrustedLabel(dev('lothsahn')), 'untrusted');
  assert.equal(untrustedLabel({ ...dev(), kind: 'discord-bug' }), 'players’ text, untrusted', 'other sources are unchanged');
  assert.equal(namesReporter(dev('lothsahn')), false, '"reported by lothsahn" repeats "lothsahn (FFBox)"');
  assert.equal(namesReporter({ ...dev('Pat'), kind: 'discord-request' }), true);
  assert.equal(namesRequesters(dev('lothsahn'), 'Lothsahn'), false, '"for Lothsahn" repeats the operator, whatever the case');
  assert.equal(namesRequesters(dev('ben-ffbox'), 'Ben'), true, 'a different name stays');
  assert.equal(namesRequesters(dev(), 'Ben'), true);
  assert.equal(namesRequesters({ ...dev('Pat'), kind: 'discord-request' }, 'Pat'), true, 'other sources are unchanged');
});
