import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FRESH_AFTER_MERGE_DEFAULT_PERCENT, FRESH_AFTER_MERGE_MARK, freshAfterMergeArm, freshAfterMergeDue, freshAfterMergePercent, freshAfterMergeText, mergedInSession, mergedSince } from './freshAfterMerge.ts';
import { inPilot } from './autoCompact.ts';
import { normalizeSetting } from './appConfig.ts';
import type { Config } from './config.ts';
import type { SessionInfo, WorkItem, WorkPr } from '../shared/types.ts';

/**
 * w2043 (lothsahn: "Do a pilot for one day"): a pilot worker whose pull request merged goes on in a fresh session at its next
 * message, with a short hand-off instead of its old context.
 */

const cfg = (p: number | undefined) => ({ worker: { freshAfterMergePilotPercent: p } as Config['worker'] });
const ids = Array.from({ length: 2000 }, (_, i) => `w${i + 1}`);
const pilotId = ids.find((id) => freshAfterMergeArm(id, cfg(50)) === 'pilot')!;
const controlId = ids.find((id) => freshAfterMergeArm(id, cfg(50)) === 'control')!;

const session = (o: Partial<SessionInfo> = {}) => ({ id: 's1', kind: 'worker', status: 'idle', createdAt: '2026-10-24T10:00:00.000Z', lastResult: 'PR merged; the deploy check is left.', ...o }) as SessionInfo;
const pr = (o: Partial<WorkPr> = {}): WorkPr => ({ repo: 'Final-Factory/ff-factory', number: 2400, title: 'w: a change', state: 'merged', at: '2026-10-24T11:00:00Z', sha: 'abcdef0123456789', ...o });
const item = (o: Partial<WorkItem> = {}) => ({ id: pilotId, title: 'a request', status: 'active', sessionIds: ['s1'], requesters: [], prs: [pr()], ...o }) as unknown as WorkItem;

test('freshAfterMergePercent: off by default; config sets it; over 100 is all', () => {
  assert.equal(FRESH_AFTER_MERGE_DEFAULT_PERCENT, 0);
  assert.equal(freshAfterMergePercent({}), 0);
  assert.equal(freshAfterMergePercent(cfg(undefined)), 0);
  assert.equal(freshAfterMergePercent(cfg(50)), 50);
  assert.equal(freshAfterMergePercent(cfg(150)), 100);
  assert.equal(normalizeSetting('worker.freshAfterMergePilotPercent', '50'), 50);
  assert.equal(normalizeSetting('worker.freshAfterMergePilotPercent', 0), 0);
  assert.throws(() => normalizeSetting('worker.freshAfterMergePilotPercent', 101), /whole number from 0 to 100/);
});

test('the arm: a stable half of request ids at 50, none while off, apart from the other pilots', () => {
  assert.equal(freshAfterMergeArm('w1', cfg(0)), undefined);
  const pilot = ids.filter((id) => freshAfterMergeArm(id, cfg(50)) === 'pilot');
  assert.ok(pilot.length > 900 && pilot.length < 1100, `${pilot.length} of 2000 in the pilot`);
  for (const id of ids.slice(0, 50)) assert.equal(freshAfterMergeArm(id, cfg(50)), freshAfterMergeArm(id.toUpperCase(), cfg(50)));
  assert.ok(ids.every((id) => freshAfterMergeArm(id, cfg(100)) === 'pilot'));
  // Drawn apart from a plain hash of the id: not the same half as another pilot keyed on the bare id.
  const same = ids.filter((id) => inPilot(id, 50) === (freshAfterMergeArm(id, cfg(50)) === 'pilot')).length;
  assert.ok(same > 850 && same < 1150, `${same} of 2000 agree with an unsalted draw`);
});

test('mergedSince: only merges at or after the session start, oldest first', () => {
  const w = item({ prs: [pr({ number: 3, at: '2026-10-24T12:00:00Z' }), pr({ number: 1, at: '2026-10-24T09:00:00Z' }), pr({ number: 2, at: '2026-10-24T11:00:00Z' }), pr({ number: 4, state: 'open', at: undefined })] });
  assert.deepEqual(mergedSince(w, '2026-10-24T10:00:00.000Z').map((p) => p.number), [2, 3]);
  assert.deepEqual(mergedSince(w, 'not a time'), []);
});

test('freshAfterMergeDue: a pilot worker between turns, on one open request, whose PR merged during its session', () => {
  const on = cfg(50);
  const due = freshAfterMergeDue(session(), [item()], on);
  assert.equal(due?.w.id, pilotId);
  assert.deepEqual(due?.merged.map((p) => p.number), [2400]);
  assert.equal(freshAfterMergeDue(session(), [item()], cfg(0)), undefined, 'off');
  assert.equal(freshAfterMergeDue(session({ status: 'running' }), [item()], on), undefined, 'never mid-turn');
  assert.equal(freshAfterMergeDue(session({ kind: 'orchestrator' } as Partial<SessionInfo>), [item()], on), undefined, 'workers only');
  assert.equal(freshAfterMergeDue(session(), [item({ id: controlId })], on), undefined, 'the control arm');
  assert.equal(freshAfterMergeDue(session(), [item({ prs: [pr({ at: '2026-10-24T09:59:00Z' })] })], on), undefined, 'merged before this session');
  assert.equal(freshAfterMergeDue(session(), [item({ prs: [pr({ state: 'open', at: undefined })] })], on), undefined, 'nothing merged');
  assert.equal(freshAfterMergeDue(session(), [item({ status: 'done' } as Partial<WorkItem>)], on), undefined, 'the request is closed');
  assert.equal(freshAfterMergeDue(session(), [item(), item({ id: 'w99999', prs: [] })], on), undefined, 'on two open requests');
  assert.equal(freshAfterMergeDue(session(), [item({ sessionIds: ['s2'] })], on), undefined, 'not its request');
});

test('mergedInSession: a request it served (or was moved off) merged during the session, in the pilot arm', () => {
  const on = cfg(50);
  assert.equal(mergedInSession(session(), [item({ status: 'done' } as Partial<WorkItem>)], on)?.id, pilotId);
  assert.equal(mergedInSession(session(), [item({ sessionIds: ['s2'], movedOff: { s1: '2026-10-24T11:30:00Z' } })], on)?.id, pilotId);
  assert.equal(mergedInSession(session(), [item({ id: controlId })], on), undefined);
  assert.equal(mergedInSession(session(), [item()], cfg(0)), undefined);
  assert.equal(mergedInSession(session(), [item({ sessionIds: ['s2'] })], on), undefined);
});

test('freshAfterMergeText: the mark, the request, what merged, what is left, and the message quoted', () => {
  const t = freshAfterMergeText(item({ title: 'the pilot' }), session(), [pr()], 'CI on PR #2401 finished: green.\n');
  assert.ok(t.startsWith(`[FF Factory] ${FRESH_AFTER_MERGE_MARK}: ${pilotId} "the pilot"`));
  assert.match(t, /Worker s1 was on it until its pull request merged/);
  assert.match(t, /Merged: Final-Factory\/ff-factory#2400 "w: a change" \(merged 2026-10-24 11:00 UTC, abcdef0123\)\./);
  assert.match(t, /What is left, in that worker's last word: PR merged; the deploy check is left\./);
  assert.match(t, /do not redo research/);
  assert.ok(t.endsWith('~~~text\nCI on PR #2401 finished: green.\n~~~'));
  const outcome = freshAfterMergeText(item({ outcome: 'Only   the 24 h\ncheck is left.' } as Partial<WorkItem>), session({ lastResult: undefined }), [pr()], 'x');
  assert.match(outcome, /last word: Only the 24 h check is left\./);
  const none = freshAfterMergeText(item(), session({ lastResult: undefined }), [pr()], 'x');
  assert.match(none, /last word: not said: read the request with read_work/);
});
