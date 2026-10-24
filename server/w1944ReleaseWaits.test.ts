// w1944: a worker's still-open line that waits on another request, the orchestrator or a worker only they can start
// (shared/workState.ts otherWorkWait) frees its sandbox at once (server/agents.ts waitOn, w890's release).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { otherWorkWait } from '../shared/workState.ts';

test('w1944: otherWorkWait names what a line waits on outside its own sandbox, and nothing for its own work, a person or a lock', () => {
  assert.equal(otherWorkWait('w665: still open: waiting on a Windows or Linux pair worker to run `MP-lowore-pin-pair` for PR #2340', 'w665'), 'a worker the dispatcher starts');
  assert.equal(otherWorkWait('w1: still open: waits for another worker on beast', 'w1'), 'a worker the dispatcher starts');
  assert.equal(otherWorkWait('w1: still open: waiting for w1761 to report', 'w1'), 'w1761');
  assert.equal(otherWorkWait('w1: still open: waiting on the orchestrator to run the two-machine check', 'w1'), 'the orchestrator');
  assert.equal(otherWorkWait('w1: still open: waiting on w1 itself', 'w1'), undefined, 'its own id is no other request');
  assert.equal(otherWorkWait('w1: still open: I run the scenario three more times', 'w1'), undefined);
  assert.equal(otherWorkWait("w1: still open: waiting on beast's bench lock", 'w1'), undefined);
  assert.equal(otherWorkWait('w1: still open: waiting on Ben to approve the look', 'w1'), undefined, 'a person is waitOn\'s other rule');
});
