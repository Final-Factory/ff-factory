import assert from 'node:assert/strict';
import test from 'node:test';
import {
  busyLevel,
  freshnessAction,
  healthRetryMs,
  healthyFor,
  IDLE_MS,
  JITTER_MS,
  reloadJitterMs,
  type Busy,
  type FieldLook,
  type PageLook,
} from '../shared/freshness.ts';

// The rules behind web/src/freshness.ts (w285, w1489): when an open tab moves to a new web build by itself.

test('freshness: reload on a new build, a bar when that would lose something, never a reload loop', () => {
  const base = { loaded: 'aaa', served: 'bbb', triedFor: null, busy: 'none' as Busy, healthy: true };
  assert.equal(freshnessAction(base), 'reload');
  // Something a reload cannot put back: a bar, and the reload when it is gone. A hand on the keys: a quiet wait.
  assert.equal(freshnessAction({ ...base, busy: 'blocked' }), 'banner');
  assert.equal(freshnessAction({ ...base, busy: 'soon' }), 'wait');
  // The new build has not answered yet (the portal is draining or starting): no reload, no bar.
  assert.equal(freshnessAction({ ...base, healthy: false }), 'wait');
  assert.equal(freshnessAction({ ...base, served: 'aaa' }), 'none');
  // Reloaded once for bbb and still on aaa (a proxy's stale copy?): offer it, do not loop.
  assert.equal(freshnessAction({ ...base, triedFor: 'bbb' }), 'banner');
  // A later build is worth one more try.
  assert.equal(freshnessAction({ ...base, triedFor: 'bbb', served: 'ccc' }), 'reload');
  // An older server (no build), or a dev server's page (no meta): nothing to compare.
  assert.equal(freshnessAction({ ...base, served: undefined }), 'none');
  assert.equal(freshnessAction({ ...base, loaded: undefined }), 'none');
});

test('freshness: a page waits while it is typed in or holds what a reload cannot put back', () => {
  const idle: PageLook = { holds: 0, pendingFiles: false, modalOpen: false, fields: [], sinceInputMs: undefined, composing: false };
  assert.equal(busyLevel(idle), 'none');
  // The message box keeps its draft over the reload: text in it is no reason to keep the old page, once the hand is off the keys.
  const draft: FieldLook = { kept: true, empty: false };
  assert.equal(busyLevel({ ...idle, fields: [draft] }), 'none');
  assert.equal(busyLevel({ ...idle, fields: [draft], sinceInputMs: 200 }), 'soon');
  assert.equal(busyLevel({ ...idle, fields: [draft], sinceInputMs: IDLE_MS - 1 }), 'soon');
  assert.equal(busyLevel({ ...idle, fields: [draft], sinceInputMs: IDLE_MS }), 'none');
  assert.equal(busyLevel({ ...idle, fields: [draft], composing: true }), 'soon');
  // A box that keeps no draft is waited for until it is emptied; an empty one is nothing.
  assert.equal(busyLevel({ ...idle, fields: [{ kept: false, empty: false }] }), 'blocked');
  assert.equal(busyLevel({ ...idle, fields: [{ kept: false, empty: true }] }), 'none');
  // Files attached, a message on its way, an open dialog: the bar.
  assert.equal(busyLevel({ ...idle, pendingFiles: true }), 'blocked');
  assert.equal(busyLevel({ ...idle, holds: 1 }), 'blocked');
  assert.equal(busyLevel({ ...idle, modalOpen: true }), 'blocked');
  // Blocked outranks a hand on the keys.
  assert.equal(busyLevel({ ...idle, holds: 1, sinceInputMs: 10 }), 'blocked');
});

test('freshness: tabs spread out, and wait for the new build to answer healthy', () => {
  assert.equal(reloadJitterMs(0), 0);
  assert.ok(reloadJitterMs(1) < JITTER_MS && reloadJitterMs(1) >= JITTER_MS - 1);
  assert.equal(reloadJitterMs(0.5), JITTER_MS / 2);
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(healthRetryMs), [2000, 4000, 8000, 16000, 30000, 30000]);
  // A refusal, a different build (the old process still answers), or a page of another build: not yet.
  assert.equal(healthyFor('bbb', { ok: true, web: 'bbb' }, 'bbb'), true);
  assert.equal(healthyFor('bbb', undefined, 'bbb'), false);
  assert.equal(healthyFor('bbb', { ok: false, web: 'bbb' }, 'bbb'), false);
  assert.equal(healthyFor('bbb', { ok: true, web: 'aaa' }, 'bbb'), false);
  assert.equal(healthyFor('bbb', { ok: true, web: 'bbb' }, 'aaa'), false);
  assert.equal(healthyFor('bbb', { ok: true, web: 'bbb' }, undefined), false);
});
