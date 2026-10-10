import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escalationCatchUp, fixLearnable, fixedByPr, followed, reportFixesOf, reportLines, reportObsoletesOf, reportSweep } from './boardFollow.ts';
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

test('w502: reportLines reads a PR\'s `Report: <id>` lines only, each once', () => {
  const body = ['Fix the crash on load', '', 'Report: 20261005T035612Z-crash-6102d405dc', '- Report: `20261005T035747Z-crash-1216e47e7d`', '> report: 20261005T035612Z-crash-6102d405dc', 'Seen in 20261004T000000Z-desync-abcdef0123 too.', 'Report: not-a-report'].join('\r\n');
  assert.deepEqual(reportLines(body), ['20261005T035612Z-crash-6102d405dc', '20261005T035747Z-crash-1216e47e7d']);
  assert.deepEqual(reportLines(undefined), []);
});

test('w502: reportFixesOf: a finished request\'s reports once its fix is merged and released, through a merge, recent only', () => {
  const work = new Map<string, WorkItem>();
  const put = (w: WorkItem) => work.set(w.id, w);
  put(item('w414', { keys: ['report:20261005T035612Z-crash-6102d405dc', 'report:20261005T035747Z-crash-1216e47e7d', 'pr:1064'], delivery: { fixCommit: 'ede697a08', fixPr: 1064, releasedIn: '0.50.0.77' } }));
  put(item('w420', { keys: ['report:20261004T000000Z-crash-aaaaaaaaaa'], delivery: { fixCommit: 'abc1234' } })); // not released
  put(item('w421', { keys: ['report:20261004T000000Z-crash-bbbbbbbbbb'], status: 'active' })); // open
  put(item('w422', { keys: ['report:20261004T000000Z-crash-cccccccccc'], status: 'merged', mergedInto: 'w423' }));
  put(item('w423', { keys: [], delivery: { fixCommit: 'def5678', releasedIn: '0.50.0.78' } }));
  put(item('w424', { keys: ['report:20261001T000000Z-crash-dddddddddd'], updatedAt: daysAgo(40), delivery: { fixCommit: 'f00f00f', releasedIn: '0.50.0.70' } }));
  assert.deepEqual(reportFixesOf(work, 'develop', NOW, 30), [
    { reportId: '20261004T000000Z-crash-cccccccccc', workId: 'w423', version: '0.50.0.78', mergedIn: 'develop@def5678' },
    { reportId: '20261005T035612Z-crash-6102d405dc', workId: 'w414', pr: 1064, version: '0.50.0.77', mergedIn: 'develop@ede697a08' },
    { reportId: '20261005T035747Z-crash-1216e47e7d', workId: 'w414', pr: 1064, version: '0.50.0.77', mergedIn: 'develop@ede697a08' },
  ]);
  assert.equal(fixLearnable(item('w1', { delivery: { fixPr: 1064 } })), true, 'a PR without its commit can be learnt');
});

test('w502: reportSweep: claimed reports are certain, mentioned ones are for a person', () => {
  const work = new Map<string, WorkItem>();
  work.set('w414', item('w414', { title: 'Fix the crash on load', brief: 'Reports 20261005T035612Z-crash-6102d405dc and 20261005T035747Z-crash-1216e47e7d.', keys: [] }));
  work.set('w430', item('w430', { title: 'Crash 20261004T000000Z-crash-aaaaaaaaaa', keys: ['report:20261004T000000Z-crash-aaaaaaaaaa'] }));
  work.set('w431', item('w431', { status: 'active', brief: 'see 20261004T000000Z-crash-bbbbbbbbbb' }));
  const s = reportSweep(work, NOW, 30);
  assert.deepEqual(s.certain, [{ workId: 'w430', reportIds: ['20261004T000000Z-crash-aaaaaaaaaa'], released: false }]);
  assert.deepEqual(s.uncertain, [{ workId: 'w414', title: 'Fix the crash on load', reportIds: ['20261005T035612Z-crash-6102d405dc', '20261005T035747Z-crash-1216e47e7d'] }]);
});

test('w853: reportObsoletesOf: a declined request\'s reports, through a merge, recent only, never one other work still claims', () => {
  const work = new Map<string, WorkItem>();
  const put = (w: WorkItem) => work.set(w.id, w);
  const r = (x: string) => `2026100${x}T000000Z-crash-${x.repeat(10)}`;
  put(item('w720', { status: 'rejected', keys: [`report:${r('1')}`, 'ffbox:752'] }));
  put(item('w721', { status: 'rejected', keys: [`report:${r('2')}`] }));
  put(item('w722', { status: 'active', keys: [`report:${r('2')}`] })); // still worked
  put(item('w723', { status: 'rejected', keys: [`report:${r('3')}`] }));
  put(item('w724', { status: 'done', keys: [`report:${r('3')}`] })); // its fix says more
  put(item('w725', { status: 'merged', mergedInto: 'w726', keys: [`report:${r('4')}`] }));
  put(item('w726', { status: 'rejected', keys: [`report:${r('5')}`] }));
  put(item('w727', { status: 'rejected', keys: [`report:${r('6')}`], updatedAt: daysAgo(40) }));
  put(item('w728', { status: 'cancelled', keys: [`report:${r('1')}`] })); // a cancelled claim does not keep it live
  put(item('w729', { status: 'done', keys: [`report:${r('7')}`] }));
  assert.deepEqual(reportObsoletesOf(work, NOW, 30), [
    { reportId: r('1'), workId: 'w720' },
    { reportId: r('4'), workId: 'w726' },
    { reportId: r('5'), workId: 'w726' },
  ]);
  assert.deepEqual(reportObsoletesOf(work, NOW, Infinity).map((x) => x.reportId), [r('1'), r('4'), r('5'), r('6')], 'an old decline still counts for a withdrawal');
});
