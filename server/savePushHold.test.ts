import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ciPushHold } from './savePushHold.ts';
import type { SessionInfo, WorkItem } from '../shared/types.ts';

const session = (id: string, o: Partial<SessionInfo> = {}) => ({ id, kind: 'worker', machineId: 'lothdesktop', ...o }) as SessionInfo;
const item = (id: string, sessionId: string, o: Partial<WorkItem> = {}) => ({ id, status: 'active', sessionIds: [sessionId], ...o }) as WorkItem;
const ci = (ref: string) => ({ kind: 'ci', ref, what: `${ref}'s checks` }) as WorkItem['blocked'];

test("w5067 push hold: de2893f4's case, one request blocked on its PR's CI and one waiting on a person, holds the push", () => {
  const w = session('de2893f4');
  const work: Record<string, WorkItem[]> = {
    de2893f4: [
      item('w5052', 'de2893f4', { status: 'blocked', blocked: ci('Final-Factory/FinalFactory#4137') }),
      item('w5053', 'de2893f4', { status: 'question' }),
    ],
  };
  const hold = (branch: string, sessions = [w], machine = 'lothdesktop') =>
    ciPushHold(machine, branch, sessions, (id) => work[id] ?? [], () => 'sandbox/slot1-w5052');
  assert.equal(hold('sandbox/slot1-w5052'), 'CI runs on Final-Factory/FinalFactory#4137');
  assert.equal(hold('sandbox/slot1-other'), undefined, 'another branch');
  assert.equal(hold('sandbox/slot1-w5052', [w], 'beast'), undefined, 'another machine');
  // Already released from its sandbox: its release branch counts, not where it is now.
  const released = session('de2893f4', { placeReleased: { branch: 'sandbox/slot1-w5052' } as SessionInfo['placeReleased'] });
  assert.equal(ciPushHold('lothdesktop', 'sandbox/slot1-w5052', [released], (id) => work[id] ?? [], () => undefined), 'CI runs on Final-Factory/FinalFactory#4137');
  // A CI gate behind another gate (alsoBlocked) counts too.
  work.de2893f4 = [item('w5052', 'de2893f4', { status: 'blocked', blocked: { kind: 'pr', ref: 'x#1' } as WorkItem['blocked'], alsoBlocked: [ci('Final-Factory/FinalFactory#4137')!] })];
  assert.equal(hold('sandbox/slot1-w5052'), 'CI runs on Final-Factory/FinalFactory#4137');
  // No CI gate, a closed request, or a request now with another worker: no hold.
  work.de2893f4 = [item('w5053', 'de2893f4', { status: 'question' })];
  assert.equal(hold('sandbox/slot1-w5052'), undefined, 'only a person wait');
  work.de2893f4 = [item('w5052', 'de2893f4', { status: 'done', blocked: ci('Final-Factory/FinalFactory#4137') })];
  assert.equal(hold('sandbox/slot1-w5052'), undefined, 'closed');
  work.de2893f4 = [item('w5052', 'de2893f4', { status: 'active', sessionIds: ['de2893f4', 'abc'], blocked: ci('Final-Factory/FinalFactory#4137') })];
  assert.equal(hold('sandbox/slot1-w5052'), undefined, 'with abc now');
});
