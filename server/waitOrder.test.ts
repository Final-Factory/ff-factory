import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holdsWorker, waitOrder, type HoldingSession } from '../shared/waiting.ts';
import type { WorkNeedsYou } from '../shared/types.ts';

// w2856 (lothsahn: "Can we have it have the question at the top so it's easy to answer?"): the Waiting on input tab puts the
// cards whose answer lets a running worker go on first, then the rest, oldest first within each group.

const worker = (id: string, more: Partial<HoldingSession> = {}): HoldingSession => ({ id, kind: 'worker', status: 'idle', pendingPermissions: [], ...more });
const needs = (more: Partial<WorkNeedsYou>): WorkNeedsYou => ({
  key: 'k', kind: 'declared', question: 'Which look?', who: ['lothsahn'], to: [], at: '2026-11-01T10:00:00Z', previews: [], prs: [], ...more,
});

test('w2856: a pending permission or a declared wait on a live worker holds it', () => {
  assert.equal(holdsWorker({ sessionIds: ['s1'] }, [worker('s1', { pendingPermissions: [{} as never] })]), true);
  assert.equal(holdsWorker({ sessionIds: ['s1'] }, [worker('s1', { waitingOn: {} as never })]), true);
  assert.equal(holdsWorker({ sessionIds: ['s1'], needsYou: needs({ worker: 's1' }) }, [worker('s1')]), true);
  assert.equal(holdsWorker({ sessionIds: ['s1'], needsYou: needs({ kind: 'report', worker: 's1' }) }, [worker('s1')]), true);
});

test('w2856: a stopped worker, an answered wait, a dispatcher question or another request\'s worker holds nothing', () => {
  assert.equal(holdsWorker(undefined, [worker('s1')]), false);
  assert.equal(holdsWorker({ sessionIds: ['s1'] }, [worker('s1')]), false);
  assert.equal(holdsWorker({ sessionIds: ['s1'] }, [worker('s1', { status: 'stopped', pendingPermissions: [{} as never] })]), false);
  assert.equal(holdsWorker({ sessionIds: ['s1'], needsYou: needs({ worker: 's1' }) }, [worker('s1', { status: 'error' })]), false);
  assert.equal(holdsWorker({ sessionIds: ['s1'], needsYou: needs({ worker: 's1', answered: { by: 'lothsahn', at: 'x' } }) }, [worker('s1')]), false);
  assert.equal(holdsWorker({ sessionIds: ['s1'], needsYou: needs({ kind: 'question', worker: 's1' }) }, [worker('s1')]), false);
  assert.equal(holdsWorker({ sessionIds: ['s1'] }, [worker('s2', { pendingPermissions: [{} as never] })]), false);
  assert.equal(holdsWorker({ sessionIds: ['o1'] }, [{ id: 'o1', kind: 'orchestrator', status: 'idle', pendingPermissions: [], waitingOn: {} as never }]), false);
});

test('w2856: holding cards first, then oldest first, and equal cards keep their order', () => {
  const cards = [
    { id: 'a', at: '2026-11-01T09:00:00Z', holds: false },
    { id: 'b', at: '2026-11-01T11:00:00Z', holds: true },
    { id: 'c', at: '2026-10-30T09:00:00Z', holds: false },
    { id: 'd', at: '2026-11-01T08:00:00Z', holds: true },
    { id: 'e', at: '2026-11-01T09:00:00Z', holds: false },
  ];
  assert.deepEqual(waitOrder(cards).map((c) => c.id), ['d', 'b', 'c', 'a', 'e']);
  assert.deepEqual(cards.map((c) => c.id), ['a', 'b', 'c', 'd', 'e'], 'the input is not sorted in place');
});
