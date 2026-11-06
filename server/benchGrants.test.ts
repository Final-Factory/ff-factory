import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvedMark, countGrant, grantProblem, liveGrant } from './benchGrants.ts';
import type { BenchGrant, BenchState, WorkItem } from '../shared/types.ts';

const NOW = Date.parse('2026-11-06T15:00:00Z');
const grant = (o: Partial<BenchGrant> = {}): BenchGrant => ({ id: 'w3159.b1', machine: 'biscuit', turns: 2, minutes: 60, by: { userId: 'ben', displayName: 'ben' }, at: '2026-11-06T14:50:00Z', words: 'Give each overload run a one-off 60-minute exclusive turn on biscuit', used: [], expires: '2026-11-13T14:50:00Z', ...o });
const bench = (running: Partial<BenchState['running'][number]>[]): BenchState => ({ mode: running.length ? 'exclusive' : 'free', running: running as BenchState['running'], runningCount: running.length, waiting: 0 });
const S = new Set(['f5b09aea']);

test('w3186: the input checks keep the 30-minute rule the default and the grant bounded', () => {
  assert.equal(grantProblem({ turns: 2, minutes: 60 }), undefined);
  assert.match(grantProblem({ turns: 0, minutes: 60 })!, /^turns: 1 to 4/);
  assert.match(grantProblem({ turns: 5, minutes: 60 })!, /^turns/);
  assert.match(grantProblem({ turns: 1, minutes: 30 })!, /^minutes: more than the 30-minute turn/);
  assert.match(grantProblem({ turns: 1, minutes: 241 })!, /at most 240/);
  assert.match(grantProblem({ turns: 1, minutes: 60, expiresDays: 31 })!, /^expires_days/);
});

test("w3186: a grant counts only its sessions' approved exclusive tickets, at most its turns, and ends once they let go", () => {
  const g = grant();
  assert.deepEqual(countGrant(g, undefined, S, NOW), { took: [] }, 'no bench state (an older or offline daemon): nothing counted');
  countGrant(g, bench([{ ticket: 't1', mode: 'exclusive', session: 'other', approved: true }, { ticket: 't2', mode: 'shared', session: 'f5b09aea' }, { ticket: 't3', mode: 'exclusive', session: 'f5b09aea' }]), S, NOW);
  assert.deepEqual(g.used, [], 'another worker, a shared ticket, or one taken without the approval');
  assert.deepEqual(countGrant(g, bench([{ ticket: 't4', mode: 'exclusive', session: 'f5b09aea', approved: true }]), S, NOW), { took: ['t4'] });
  assert.deepEqual(countGrant(g, bench([{ ticket: 't4', mode: 'exclusive', session: 'f5b09aea', approved: true }]), S, NOW), { took: [] }, 'counted once');
  countGrant(g, bench([{ ticket: 't5', mode: 'exclusive', session: 'f5b09aea', approved: true }]), S, NOW);
  assert.deepEqual(g.used, ['t4', 't5']);
  assert.equal(g.ended, undefined, 'its last turn still holds');
  countGrant(g, bench([{ ticket: 't6', mode: 'exclusive', session: 'f5b09aea', approved: true }]), S, NOW);
  assert.deepEqual(g.used, ['t4', 't5'], 'no third turn');
  assert.match(g.endedWhy!, /its 2 turns \(t4, t5\) were used/);
  assert.equal(liveGrant({ id: 'w3159', benchGrants: [g] } as WorkItem, 'biscuit', NOW), undefined);
});

test('w3186: an unused grant expires, holds only on its machine, and its mark is what bench_queue.py reads', () => {
  const g = grant();
  const w = { id: 'w3159', benchGrants: [g] } as WorkItem;
  assert.equal(liveGrant(w, 'biscuit', NOW), g);
  assert.equal(liveGrant(w, 'beast', NOW), undefined);
  assert.deepEqual(approvedMark(w, g), { grant: 'w3159.b1', by: 'ben', request: 'w3159', turns: 2, turn_min: 60, used: [] });
  const late = Date.parse(g.expires) + 1;
  assert.equal(liveGrant(w, 'biscuit', late), undefined);
  assert.match(countGrant(g, bench([]), S, late).ended!, /expired with 0 of 2 turns used/);
});
