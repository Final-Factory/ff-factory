import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUnused, labelAfterEnd, labelDecision, type Place } from './labelPolicy.ts';

const lead = { id: 'lead', title: '074 lead', status: 'running' as const, live: true, label: '074 three-peer playthrough', labelAt: '2026-09-24T20:00:00Z' };
const helper = { id: 'help', title: 'helper', status: 'running' as const, live: true, label: 'helper: fix the belt test', labelAt: '2026-09-24T21:00:00Z' };

test('labels: a helper finishing does not mark the place unused while the lead still works', () => {
  const place: Place = { sessions: [lead, helper] };
  const d = labelDecision(place, 'help', 'unused', 'helper: fix the belt test');
  assert.equal(d.set, '074 three-peer playthrough', "the lead's label comes back");
  assert.equal(d.remember, false);
  assert.match(d.note ?? '', /Not set to "unused": "074 lead" \(lead\) still works here, so the label stays "074 three-peer playthrough"/);
  // Alone there: unused is fine.
  assert.deepEqual(labelDecision({ sessions: [helper] }, 'help', ' Unused ', 'x'), { set: ' Unused ', remember: false });
  // A stopped, idle agent does not count as working.
  assert.equal(labelDecision({ sessions: [{ ...lead, live: false, status: 'stopped' }, helper] }, 'help', 'unused', 'x').set, 'unused');
  // Any other label is set, and remembered as the caller's own.
  assert.deepEqual(labelDecision(place, 'help', 'helper: second task', 'x'), { set: 'helper: second task', remember: true });
  // Nobody else has a label: the current one stays.
  assert.equal(labelDecision({ sessions: [{ ...lead, label: undefined }, helper] }, 'help', 'unused', 'current').set, 'current');
  assert.ok(isUnused('UNUSED') && !isUnused('unused sandbox for x'));
});

test("labels: when an agent ends, the newest label of an agent still working there comes back", () => {
  const place: Place = { sessions: [lead, { ...helper, live: false, status: 'stopped' }] };
  assert.equal(labelAfterEnd(place, 'help', helper.label, helper.label), '074 three-peer playthrough');
  assert.equal(labelAfterEnd(place, 'help', helper.label, 'unused'), '074 three-peer playthrough');
  // Someone relabelled it since (the orchestrator, the lead): left alone.
  assert.equal(labelAfterEnd(place, 'help', helper.label, 'orchestrator: new plan'), undefined);
  // Nobody left working there: nothing to restore.
  assert.equal(labelAfterEnd({ sessions: [{ ...lead, live: false, status: 'idle' }] }, 'help', helper.label, helper.label), undefined);
});
