import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterMergeReason, cleanupSettings, cutOffOf, isRelease, mergePrs, prsOf, prUrlsIn, reportVerdict, requestIdsIn, stallCandidate, supersededBy, type PrRecord } from './ledgerRules.ts';
import type { WorkItem } from '../shared/types.ts';

const T = '2026-10-03T10:00:00.000Z';
const item = (o: Partial<WorkItem> & { id: string }): WorkItem =>
  ({ title: 'Fix the belts', brief: 'Make belts keep items.', priority: 'normal', keys: [], requestedBy: { userId: 'ben', displayName: 'Ben' }, requesters: [{ userId: 'ben', displayName: 'Ben' }], humanAsked: true, status: 'active', createdAt: T, updatedAt: T, sessionIds: [], overlaps: [], asks: 0, log: [], ...o }) as WorkItem;
const pr = (o: Partial<PrRecord> & { number: number }): PrRecord => ({ repo: 'Final-Factory/FinalFactory', url: `https://github.com/Final-Factory/FinalFactory/pull/${o.number}`, title: 'A fix', body: '', head: 'sandbox/x', base: 'develop', state: 'merged', createdAt: '2026-10-03T11:00:00Z', mergedAt: '2026-10-03T12:00:00Z', ...o });

test('settings: on every 4 hours by default, clamped, repos validated', () => {
  assert.deepEqual(cleanupSettings({}), { enabled: true, everyHours: 4 });
  assert.deepEqual(cleanupSettings({ ledger: { cleanup: { enabled: false, everyHours: 0.2, repos: ['a/b', 'bad'] } } }), { enabled: false, everyHours: 4, repos: ['a/b'] });
  assert.equal(cleanupSettings({ ledger: { cleanup: { everyHours: 1000 } } }).everyHours, 168);
  assert.equal(cleanupSettings({ ledger: { cleanup: { everyHours: 6 } } }).everyHours, 6);
});

test('a PR belongs to a request by its Request line, a worker-linked URL, a worker branch opened after it, or the request’s pr key', () => {
  assert.deepEqual(requestIdsIn('Fix\n\nRequest: w293\nrequest: W5 and more'), ['w293', 'w5']);
  assert.deepEqual(prUrlsIn('opened https://github.com/Final-Factory/ff-factory/pull/66 ok'), [{ repo: 'Final-Factory/ff-factory', number: 66 }]);
  const w = item({ id: 'w10' });
  const all = [pr({ number: 1, body: 'Request: w10' }), pr({ number: 2, body: 'Request: w11', head: 'sandbox/x' }), pr({ number: 3, head: 'sandbox/x' }), pr({ number: 4, head: 'sandbox/x', createdAt: '2026-10-01T00:00:00Z' }), pr({ number: 5, head: 'develop' }), pr({ number: 6, head: 'other' })];
  const mine = prsOf(w, all, { heads: ['sandbox/x', 'develop'], linked: [] }).map((p) => p.number);
  assert.deepEqual(mine, [1, 3], 'by line, and by branch after filing; not another request’s, not older, not develop');
  assert.deepEqual(prsOf(w, all, { heads: [], linked: [{ repo: 'final-factory/finalfactory', number: 6 }] }).map((p) => p.number), [1, 6]);
  assert.deepEqual(prsOf(item({ id: 'w10', keys: ['pr:6'] }), all, { heads: [], linked: [] }).map((p) => p.number), [1, 6]);
});

test('stored PRs keep their note while the state holds, and take gh’s state when it moves', () => {
  const stored = [{ repo: 'a/b', number: 7, state: 'open' as const, noted: 'x' }];
  assert.equal(mergePrs(stored, [pr({ repo: 'a/b', number: 7, state: 'open' })])[0].noted, 'x');
  const moved = mergePrs(stored, [pr({ repo: 'a/b', number: 7, state: 'merged', sha: 'c'.repeat(40) })])[0];
  assert.deepEqual([moved.state, moved.noted, moved.sha], ['merged', undefined, 'c'.repeat(40)]);
});

test('what is left after a merge: a release, a check, several PRs, a worker saying more, a question', () => {
  const base = { title: 'Fix the belts', brief: 'Make belts keep items.' };
  assert.equal(afterMergeReason(base, ['Done, merged as #5.']), undefined);
  assert.match(afterMergeReason({ title: 'Release 0.50.0.60', brief: 'Cut it.' }, [])!, /patch notes are posted/);
  assert.ok(isRelease({ title: 'x', brief: 'Use /ff-agents:ci-release and post the patch notes.' }));
  assert.match(afterMergeReason({ ...base, brief: 'Then run a 2-peer check after the merge.' }, [])!, /after the merge/);
  assert.match(afterMergeReason({ ...base, brief: 'Run the paired determinism audit when it lands.' }, [])!, /after the merge/);
  assert.match(afterMergeReason({ ...base, brief: 'Plan: PR1 data, PR2 presentation.' }, [])!, /more than one PR/);
  assert.match(afterMergeReason(base, ['PR 1 is merged. The second PR is next.'])!, /more is coming/);
  assert.match(afterMergeReason({ ...base, question: { text: 'Co-op?', at: T } }, [])!, /question/);
});

test('a final report counts only when it says plainly that the work is done and nothing is left or asked', () => {
  assert.equal(reportVerdict('All done. The belts keep their items now.'), 'delivered');
  assert.equal(reportVerdict('Delivered: the copy is in the Screenshots folder.'), 'delivered');
  assert.equal(reportVerdict('The research is complete, nothing more to do.'), 'delivered');
  assert.equal(reportVerdict('Done with step one. Next steps: open the second PR.'), 'more');
  assert.equal(reportVerdict('It is finished. Should I also tidy the logs?'), 'more');
  assert.equal(reportVerdict('Blocked: the editor will not start. Done otherwise.'), 'more');
  assert.equal(reportVerdict('I looked at the belts and found three causes.'), 'unsure');
  assert.equal(reportVerdict(undefined), 'unsure');
  assert.equal(reportVerdict('The release is live and the notes are posted.', true), 'unsure', 'a release must link its notes');
  assert.equal(reportVerdict('Release 0.50.0.60 is live on development. Notes posted: https://discord.com/channels/530867164866150410/1069745561672106015/1290000000000000001. Done.', true), 'delivered');
});

test('a stop is cut off by a limit, a restart or a refused tool; anything else is not', () => {
  const s = (o: object) => ({ status: 'stopped' as const, ...o });
  assert.equal(cutOffOf({ status: 'running' }, ['usage limit']), undefined, 'running is not cut off');
  assert.equal(cutOffOf(s({ statusDetail: 'You hit your limit · resets 3pm' }), [])?.kind, 'limit');
  assert.equal(cutOffOf(s({}), ['Claude AI usage limit reached|1759500000'])?.kind, 'limit');
  assert.equal(cutOffOf({ status: 'error', statusDetail: 'Permission denied by the guard: a push to master' }, [])?.kind, 'refused');
  assert.equal(cutOffOf(s({ turnOpenSince: T }), [])?.kind, 'restart');
  assert.equal(cutOffOf(s({ statusDetail: 'stopped by app restart' }), [])?.kind, 'restart');
  assert.equal(cutOffOf(s({}), ['all good']), undefined);
});

test('stalling: waiting requests are not candidates; a newer finished release or strong overlap supersedes', () => {
  assert.equal(stallCandidate(item({ id: 'w1' })), true);
  assert.equal(stallCandidate(item({ id: 'w1', status: 'question' })), false);
  assert.equal(stallCandidate(item({ id: 'w1', status: 'done' })), false);
  assert.equal(stallCandidate(item({ id: 'w1', approval: { state: 'pending' } })), false);
  const old = item({ id: 'w1', title: 'Release 0.50.0.50', brief: 'ci-release', createdAt: '2026-09-20T00:00:00Z' });
  const newer = item({ id: 'w9', title: 'Release 0.50.0.58', brief: 'ci-release', status: 'done', createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-30T00:00:00Z' });
  assert.equal(supersededBy(old, [newer], [])?.id, 'w9');
  assert.equal(supersededBy(old, [{ ...newer, createdAt: '2026-09-10T00:00:00Z', updatedAt: '2026-09-11T00:00:00Z' }], []), undefined, 'older than the request');
  const plain = item({ id: 'w2', createdAt: '2026-09-20T00:00:00Z' });
  const covers = item({ id: 'w8', status: 'done', updatedAt: '2026-09-25T00:00:00Z' });
  assert.equal(supersededBy(plain, [covers], [{ ref: 'w8' }])?.id, 'w8');
  assert.equal(supersededBy(plain, [covers], []), undefined);
});
