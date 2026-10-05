import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escalationCatchUp, fixLearnable, fixedByPr, followed } from './boardFollow.ts';
import { catchUpReport } from '../scripts/escalation-catchup.ts';
import type { WorkItem } from '../shared/types.ts';

const NOW = Date.parse('2026-10-05T08:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const THREAD = '1556000000000000001';

function item(id: string, o: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    title: `request ${id}`,
    brief: '',
    priority: 'normal',
    keys: [],
    requestedBy: { userId: 'ben', displayName: 'Ben' },
    requesters: [],
    humanAsked: false,
    status: 'done',
    createdAt: daysAgo(20),
    updatedAt: daysAgo(1),
    sessionIds: [],
    log: [],
    ...o,
  } as WorkItem;
}
const escalated = (id: string, conversation: string, o: Partial<WorkItem> = {}) =>
  item(id, { source: { kind: 'ffbox-request', untrusted: true, channel: '#ask-assistant', threadId: THREAD, conversation, url: `https://discord.com/channels/1/${THREAD}` }, ...o });

test('fixedByPr: the one PR a close names as the fix, in the words workers use', () => {
  assert.equal(fixedByPr('Already fixed by #1076 (Build 78).'), 1076);
  assert.equal(fixedByPr('closed as already fixed by #1076 (Build 78)'), 1076);
  assert.equal(fixedByPr('Fixed in PR #1076, shipped in 0.50.0.78'), 1076);
  assert.equal(fixedByPr('PR #1076 already fixed this'), 1076);
  assert.equal(fixedByPr('#1076 fixes it'), 1076);
  assert.equal(fixedByPr('not a bug; see #1076'), undefined, 'a reference is not a fix');
  assert.equal(fixedByPr('fixed by #1076 and #1080'), undefined, 'two PRs: not one fix');
  assert.equal(fixedByPr(undefined), undefined);
});

test('fixLearnable: a finished request whose PR or release can still be learnt', () => {
  assert.equal(fixLearnable(item('w1', { outcome: 'already fixed by #1076' })), true);
  assert.equal(fixLearnable(item('w1', { autoClosed: { at: '', how: 'pr', pr: 9, sha: 'a'.repeat(40), text: '' } })), true);
  assert.equal(fixLearnable(item('w1', { delivery: { fixCommit: 'abc1234' } })), true, 'no PR and no release yet');
  assert.equal(fixLearnable(item('w1', { delivery: { fixCommit: 'abc1234', fixPr: 9, releasedIn: '0.50.0.78' } })), false, 'all known');
  assert.equal(fixLearnable(item('w1', { outcome: 'not a bug' })), false, 'nothing to learn from');
  assert.equal(fixLearnable(item('w1', { status: 'active', outcome: 'fixed by #9' })), false, 'still open');
});

test('escalationCatchUp: escalated requests closed done in the last 14 days, one per conversation; followed through a merge', () => {
  const work = new Map<string, WorkItem>();
  const put = (w: WorkItem) => work.set(w.id, w);
  put(escalated('w436', '692', { outcome: 'already fixed by #1076 (Build 78)', updatedAt: daysAgo(2) }));
  put(escalated('w300', '600', { updatedAt: daysAgo(20) })); // too old
  put(escalated('w301', '601', { status: 'active' })); // still open
  put(escalated('w302', '602', { status: 'cancelled' })); // not done
  put(item('w303', { source: { kind: 'ffbox-request', untrusted: true, channel: 'FFBox', conversation: '603' } })); // FFBox's own request: no thread
  put(item('w304', { source: { kind: 'discord-bug', untrusted: true, channel: '#beta-bugs', threadId: THREAD } })); // not FFBox's
  put(escalated('w305', '605', { status: 'merged', mergedInto: 'w306' }));
  put(item('w306', { updatedAt: daysAgo(3), delivery: { fixCommit: 'b'.repeat(40), fixPr: 1050, releasedIn: '0.50.0.77' } }));
  // The same conversation escalated twice: the newest closed one.
  put(escalated('w307', '607', { updatedAt: daysAgo(5) }));
  put(escalated('w308', '607', { updatedAt: daysAgo(4) }));
  const lines = escalationCatchUp(work, NOW, 14);
  assert.deepEqual(lines.map((l) => [l.ref, l.workId, l.followId]), [
    ['conv-607', 'w308', 'w308'],
    ['conv-605', 'w305', 'w306'],
    ['conv-692', 'w436', 'w436'],
  ]);
  assert.equal(followed('w305', work)?.id, 'w306');
  const report = catchUpReport(lines, work);
  assert.match(report[1], /^conv-605 thread \d+: w305 \(merged into w306\), closed .*; fix bbbbbbbbbbbb, PR #1050, in 0\.50\.0\.77/);
  assert.match(report[2], /^conv-692 .*w436.*PR #1076 to look up/);
  assert.match(report[0], /no fix named/);
});
