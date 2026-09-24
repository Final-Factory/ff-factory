import test from 'node:test';
import assert from 'node:assert/strict';
import { displayName, isUnused, nameWithSlot } from '../shared/labels.ts';

test('labels: the label is the name; empty or "unused" reads as Unused', () => {
  assert.equal(displayName({ purpose: 'Voice worker' }), 'Voice worker');
  assert.equal(displayName({ purpose: '  Trimmed  ' }), 'Trimmed');
  for (const p of [undefined, '', '  ', 'unused', 'Unused ']) {
    assert.equal(isUnused(p), true);
    assert.equal(displayName({ purpose: p }), 'Unused');
  }
  assert.equal(nameWithSlot({ id: 'agent-mcp', purpose: 'Phase 3 upgrades' }), 'Phase 3 upgrades (slot agent-mcp)');
});
