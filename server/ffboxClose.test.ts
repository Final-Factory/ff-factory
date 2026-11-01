import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeTarget, closeText, closeThreads, judgeThread, linkedRequests, scanOpenThreads, CLOSE_MAX, type CloseRetry } from './ffboxClose.ts';
import { postArgs } from './ffboxPost.ts';
import { CATALOG } from './launch.ts';
import { TOOL_MANIFEST } from './toolManifest.ts';
import type { ProviderManager, QueryAnswer } from './providers.ts';
import type { WorkItem } from '../shared/types.ts';

// w2670, lothsahn, 2026-10-31: "I would like to be able to ask you to scan all the open bug reports and close ones that
// are done, or to close specific ones I ask for." and "I'd actually want you to scan for things that are on the ledger as
// already fixed."

const GUILD = '530867164866150410';
const T1 = '1562003559732486144';
const T2 = '1562003559732486103';
const T3 = '1562003559732486155';
const link = (t: string) => `https://discord.com/channels/${GUILD}/${t}`;

type Ask = { what: string; args?: Record<string, number | string> };
function fake(answer: (q: Ask, n: number) => Partial<QueryAnswer>) {
  const asked: Ask[] = [];
  const p = {
    async query(what: string, args?: Record<string, number | string>): Promise<QueryAnswer> {
      asked.push({ what, args });
      return { what, live: true, ok: true, ...answer({ what, args }, asked.length) } as QueryAnswer;
    },
  };
  return { p: p as unknown as ProviderManager, asked };
}

const NOW_RETRY: CloseRetry = { askMs: 20_000, budgetMs: 150_000, pauseMs: 0, sleep: async () => {} };

function work(over: Partial<WorkItem> & { id: string }): WorkItem {
  return { title: `request ${over.id}`, brief: '', priority: 'normal', keys: [], requestedBy: { userId: 'lothsahn', displayName: 'lothsahn' }, requesters: [], humanAsked: true, status: 'done', createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z', sessionIds: [], overlaps: [], asks: 0, log: [], ...over } as WorkItem;
}
const ledger = (...items: WorkItem[]) => new Map(items.map((w) => [w.id, w]));

test('a close names a thread by id or link, or an FFBox conversation; nothing else is asked', () => {
  assert.deepEqual(closeTarget(T1), { thread: T1 });
  assert.deepEqual(closeTarget(link(T1)), { thread: T1 });
  assert.deepEqual(closeTarget(`${link(T1)}/1562003559732486199`), { thread: T1 }, "a message's link names its thread");
  assert.deepEqual(closeTarget('conversation 4512'), { conversation: '4512' });
  assert.match((closeTarget('4512') as { error: string }).error, /conversation 4512/);
  assert.ok('error' in closeTarget('https://example.com/x'));
});

test('a closing message has the post guards: no mention, no control characters, the length; a secret is masked', () => {
  assert.deepEqual(closeText(undefined), { text: '' });
  assert.match((closeText('thanks @ben') as { error: string }).error, /mentions/);
  assert.match((closeText('x'.repeat(2001)) as { error: string }).error, /2001 characters/);
  const t = closeText('token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa here');
  assert.ok('text' in t && !t.text.includes('ghp_aaaa'), 'a secret never reaches the post');
});

test('close_bug_threads asks FFBox close_thread once per thread and answers a line for each', async () => {
  const { p, asked } = fake((q) => {
    if (q.args?.thread === T1) return { data: { closed: true, thread: T1, channel: 'agent_testing', link: link(T1) } };
    if (q.args?.conversation === '77') return { data: { queued: true, thread: T2, conversation: 77, channel: 'bug_reports', link: link(T2), after: 'fff-fixed:77', message: { message_id: '1', link: `${link(T2)}/1` } } };
    return { live: false, ok: false, error: 'refused', reason: 'only a bug report, feedback or agent_testing thread closes' };
  });
  const out = await closeThreads(p, { threads: [link(T1), 'conversation 77', T3, link(T1)], text: 'Filing this away.', by: 'orchestrator: lothsahn' }, ledger(), Date.now, NOW_RETRY);
  assert.equal(asked.length, 3, 'a repeated thread is asked once');
  assert.ok(asked.every((a) => a.what === 'close_thread' && a.args?.text === 'Filing this away.' && a.args?.by === 'orchestrator: lothsahn'));
  assert.match(out, /2 of 3/);
  assert.match(out, new RegExp(`${link(T1)}: archived now`));
  assert.match(out, /close queued in FFBox conversation 77 \(#bug_reports\), after its merge notice/);
  assert.match(out, new RegExp(`${T3}: not closed: refused \\(only a bug report`));
});

test('an answer that did not come is asked again; a refusal or busy is not', async () => {
  let n = 0;
  const { p } = fake(() => (++n === 1 ? { live: false, ok: false, error: 'timeout' } : { data: { closed: true, thread: T1, channel: 'agent_testing', link: link(T1) } }));
  assert.match(await closeThreads(p, { threads: [T1] }, undefined, Date.now, NOW_RETRY), /archived now/);
  assert.equal(n, 2);
  const busy = fake(() => ({ live: false, ok: false, error: 'busy', reason: 'Max is answering it' }));
  assert.match(await closeThreads(busy.p, { threads: [T1] }, undefined, Date.now, NOW_RETRY), /not closed: busy .*after its turn/);
  assert.equal(busy.asked.length, 1);
});

test('a call refuses nothing named, a list past 25 and a bad message before asking FFBox', async () => {
  const { p, asked } = fake(() => ({}));
  await assert.rejects(closeThreads(p, { threads: [] }), /at least one/);
  await assert.rejects(closeThreads(p, { threads: Array.from({ length: CLOSE_MAX + 1 }, (_, i) => `15620035597324861${String(i).padStart(2, '0')}`) }), /at most 25/);
  await assert.rejects(closeThreads(p, { threads: [T1], text: 'hey @lothsahn' }), /mentions/);
  assert.equal(asked.length, 0);
});

test('a close says when the ledger still holds an open request for that thread', async () => {
  const { p } = fake(() => ({ data: { queued: true, thread: T2, conversation: 77, channel: 'bug_reports', link: link(T2) } }));
  const out = await closeThreads(p, { threads: [T2] }, ledger(work({ id: 'w900', status: 'active', keys: [`discord:${T2}`], title: 'Belts stop' })), Date.now, NOW_RETRY);
  assert.match(out, /Still open on the ledger: w900 \(Belts stop\)/);
});

test('the ledger links a thread by its key, its FFBox conversation and FFBox hand-overs, merges followed', () => {
  const w = ledger(
    work({ id: 'w1', keys: [`discord:${T1}`], status: 'merged', mergedInto: 'w2' }),
    work({ id: 'w2', status: 'done' }),
    work({ id: 'w3', keys: ['ffbox:77'] }),
    work({ id: 'w4' }),
    work({ id: 'w5', keys: ['discord:1562003559732486000'] }),
  );
  assert.deepEqual(linkedRequests(T1, undefined, [], w).map((x) => x.id), []);
  assert.deepEqual(linkedRequests('', '77', ['w4'], w).map((x) => x.id).sort(), ['w3', 'w4']);
  // requestsFor skips a merged request (its thread rides alsoThreads on the one it joined); a hand-over follows the merge
  assert.deepEqual(linkedRequests('', undefined, ['w1'], w).map((x) => x.id), ['w2']);
});

test('the scan judges each thread ledger first: done with its PR and release, not done, unclear', () => {
  const w = ledger(
    work({ id: 'w10', keys: [`discord:${T1}`], status: 'done', delivery: { fixPr: 2901, releasedIn: '0.50.0.120' }, title: 'Belts stop' }),
    work({ id: 'w11', keys: [`discord:${T2}`], status: 'active' }),
    work({ id: 'w12', keys: [`discord:${T3}`], status: 'rejected', outcome: 'works as designed' }),
    work({ id: 'w13', keys: ['ffbox:88'], status: 'done', delivery: { fixPr: 2950 } }),
  );
  const done = judgeThread({ id: T1, channel: 'bug_reports', title: 'Belts stop', link: link(T1), notice: { status: 'sent' } }, w);
  assert.equal(done.verdict, 'done');
  assert.match(done.reason, /w10 is done on the ledger \(PR #2901, released in 0\.50\.0\.120\); FFBox's merge notice is posted/);
  assert.deepEqual(done.request, { id: 'w10', title: 'Belts stop', status: 'done', pr: 2901, version: '0.50.0.120' });
  assert.equal(judgeThread({ id: T2, channel: 'bug_reports' }, w).verdict, 'not_done');
  const rej = judgeThread({ id: T3, channel: 'bug_reports' }, w);
  assert.equal(rej.verdict, 'unclear');
  assert.match(rej.reason, /declined: works as designed/);
  const byConv = judgeThread({ id: '1562003559732486177', channel: 'dev_bug_reports', conversation: { id: 88 } }, w);
  assert.equal(byConv.verdict, 'done', 'found by its FFBox conversation');
  assert.match(byConv.reason, /not in a release yet\); no merge notice from FFBox yet \(a close here never stops it/);
  const after = judgeThread({ id: T1, channel: 'bug_reports', notice: { status: 'sent', person_after: true } }, w);
  assert.equal(after.verdict, 'unclear', 'a person who wrote after the notice may say it is still broken');
  assert.equal(judgeThread({ id: '1562003559732486188', channel: 'bug_reports', notice: { status: 'sent', text: 'Fixed in 0.50.0.99' } }, w).verdict, 'done');
  assert.equal(judgeThread({ id: '1562003559732486188', channel: 'bug_reports' }, w).verdict, 'unclear');
  const handed = judgeThread({ id: '1562003559732486199', channel: 'bug_reports', requests: [{ work_id: 'w11' }] }, w);
  assert.equal(handed.verdict, 'not_done', "FFBox's hand-over names the request");
});

test('open_bug_threads asks open_threads for the channel set, counts the verdicts and tells the person to confirm', async () => {
  const { p, asked } = fake(() => ({
    data: {
      channels: [{ channel: 'bug_reports', open: 2, closes_30d: { sent: 4, failed: 1, last_error: 'Missing Permissions' } }],
      threads: [
        { id: T1, channel: 'bug_reports', title: 'Belts "stop"', link: link(T1) },
        { id: T2, channel: 'bug_reports', title: 'Crash', link: link(T2) },
      ],
    },
  }));
  const w = ledger(work({ id: 'w10', keys: [`discord:${T1}`], delivery: { fixPr: 1 } }));
  const out = await scanOpenThreads(p, {}, w);
  assert.deepEqual(asked, [{ what: 'open_threads', args: { channels: 'bugs', limit: 100 } }]);
  assert.match(out, /Done 1, not done 0, unclear 1/);
  assert.match(out, /1 failed \(last: Missing Permissions; a missing Manage Threads/);
  assert.match(out, new RegExp(`- DONE ${link(T1)} #bug_reports "Belts 'stop'"`));
  assert.match(out, /close only the ones they confirm/);
  const only = await scanOpenThreads(p, { channels: 'agent_testing', verdict: 'unclear' }, w);
  assert.equal(asked[1].args?.channels, 'agent_testing');
  assert.ok(!only.includes('- DONE') && only.includes('- UNCLEAR'));
  const down = fake(() => ({ live: false, ok: false, error: 'unsupported' }));
  await assert.rejects(scanOpenThreads(down.p, {}, w), /older than this tool/);
});

test('post_as_max new_thread is agent_testing only, with no thread', () => {
  assert.deepEqual(postArgs({ channel: 'agent_testing', text: 'w2670 test', new_thread: 'w2670 close test' }), { args: { channel: 'agent_testing', text: 'w2670 test', new_thread: 'w2670 close test' } });
  assert.match((postArgs({ channel: 'dev_chat', text: 'x', new_thread: 'y' }) as { error: string }).error, /only in agent_testing/);
  assert.match((postArgs({ channel: 'agent_testing', text: 'x', thread: T1, new_thread: 'y' }) as { error: string }).error, /not with a thread/);
  assert.ok('new_thread' in CATALOG.post_as_max);
});

test("the close and the scan are a person's orchestrator's tools only", () => {
  const m = TOOL_MANIFEST as Record<string, { kinds: readonly string[] }>;
  assert.deepEqual([...m.close_bug_threads.kinds], ['personal']);
  assert.deepEqual([...m.open_bug_threads.kinds], ['personal']);
});
