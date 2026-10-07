import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slotName } from './machines.ts';

// A worker root install names its sandboxes slot1..slotN, N its sandbox limit (w513, lothsahn 2026-10-06).

test('slotName: the first free slot within the sandbox limit, none past it', () => {
  assert.equal(slotName([], 6), 'slot1');
  assert.equal(slotName(['slot1', 'slot2'], 6), 'slot3');
  assert.equal(slotName(['slot1', 'slot3'], 6), 'slot2', 'a freed slot is used again first');
  assert.equal(slotName(['SLOT1'], 2), 'slot2', 'names compare without case, as Windows folders do');
  assert.equal(slotName(['lag-lead', 'ui-fix'], 2), 'slot1', 'old names take no slot number');
  assert.equal(slotName(['slot1', 'slot2'], 2), undefined);
  assert.equal(slotName([], 0), undefined);
});
