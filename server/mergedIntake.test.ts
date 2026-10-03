import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discordThreadsIn, linkedDone, mergeCandidates, mergedBy, mergedText, namesBranch, parseLog, prNumberOf, threadsOf, type MergeRecord } from './mergedIntake.ts';
import type { WorkItem } from '../shared/types.ts';

const T = '2026-10-03T10:00:00.000Z';
const item = (o: Partial<WorkItem> & { id: string }): WorkItem =>
  ({
    title: 'Review and merge ffbox/x',
    brief: '',
    priority: 'normal',
    keys: [],
    requestedBy: { userId: 'ben', displayName: 'Ben' },
    requesters: [{ userId: 'ben', displayName: 'Ben' }],
    humanAsked: false,
    status: 'new',
    createdAt: T,
    updatedAt: T,
    sessionIds: [],
    overlaps: [],
    asks: 0,
    log: [],
    ...o,
  }) as WorkItem;
const SHA = 'a'.repeat(40);
const rec = (o: Partial<MergeRecord>): MergeRecord => ({ sha: SHA, at: T, text: '', ...o });

test('a branch name is matched whole, not as the start of a longer name', () => {
  assert.ok(namesBranch('Merge pull request #945 from Final-Factory/ffbox/alt-tab-1', 'ffbox/alt-tab-1'));
  assert.ok(namesBranch('cherry-picked from ffbox/alt-tab-1.', 'ffbox/alt-tab-1'));
  assert.ok(!namesBranch('Merge pull request #9 from Final-Factory/ffbox/alt-tab-12', 'ffbox/alt-tab-1'));
  assert.ok(!namesBranch('myffbox/alt-tab-1', 'ffbox/alt-tab-1'));
});

test('PR numbers and Discord threads are read from merge and squash messages', () => {
  assert.equal(prNumberOf('Merge pull request #946 from Final-Factory/x'), 946);
  assert.equal(prNumberOf('Fix the belts (#947)'), 947);
  assert.equal(prNumberOf('Fix the belts'), undefined);
  assert.deepEqual(discordThreadsIn('Fix\n\nDiscord: https://discord.com/channels/530867164866150410/1111111111111111111\nDiscord: https://discord.com/channels/530867164866150410/2222222222222222222'), ['1111111111111111111', '2222222222222222222']);
  assert.deepEqual(discordThreadsIn('see Discord: https://discord.com/channels/1/2222222222222222222 inline'), [], 'only a line of its own');
  const raw = `${SHA}\x1f${T}\x1fMerge pull request #945 from F/ffbox/a\x1fbody\x1e\nnot a sha\x1f${T}\x1fx\x1f\x1e`;
  assert.deepEqual(parseLog(raw), [{ sha: SHA, at: T, number: 945, text: 'Merge pull request #945 from F/ffbox/a\nbody' }]);
});

test('merged evidence: the request’s PR, a PR or commit naming its branch, or one carrying its Discord thread', () => {
  const w = item({ id: 'w1', source: { kind: 'ffbox-branch', untrusted: false, branch: 'ffbox/x', pr: 12, threadId: '1111111111111111111' } });
  assert.equal(mergedBy(w, [rec({ number: 12, text: 'Some title' })])?.how, 'pr');
  assert.equal(mergedBy(w, [rec({ head: 'ffbox/x', number: 13 })])?.how, 'branch');
  assert.equal(mergedBy(w, [rec({ text: 'Fix (#14)\n\ncherry-picked from ffbox/x' })])?.how, 'branch');
  const thread = mergedBy(w, [rec({ number: 15, text: 'Fix\n\nDiscord: https://discord.com/channels/1/1111111111111111111' })]);
  assert.deepEqual([thread?.how, thread?.pr, thread?.text], ['thread', 15, 'merged as #15 (aaaaaaaaaaaa) on 2026-10-03']);
  assert.equal(mergedBy(w, [rec({ number: 99, head: 'ffbox/other', text: 'Fix\n\nDiscord: https://discord.com/channels/1/9999999999999999999' })]), undefined);
  assert.equal(mergedText({ sha: SHA, at: T, base: 'origin/develop' }), 'merged into origin/develop (aaaaaaaaaaaa) on 2026-10-03');
  const also = item({ id: 'w2', source: { kind: 'discord-bug', untrusted: true, threadId: '3333333333333333333', alsoThreads: [{ threadId: '4444444444444444444' }] } });
  assert.deepEqual(threadsOf(also), ['3333333333333333333', '4444444444444444444']);
  assert.equal(mergedBy(also, [rec({ text: 'Fix\nDiscord: https://discord.com/channels/1/4444444444444444444' })])?.how, 'thread', 'a thread merged into the request counts');
});

test('only intake requests nobody works on are candidates', () => {
  const src = (kind: NonNullable<WorkItem['source']>['kind']) => ({ kind, untrusted: false });
  const all = [
    item({ id: 'a', source: src('ffbox-branch') }),
    item({ id: 'b', source: src('discord-bug'), status: 'queued' }),
    item({ id: 'c', source: src('ffbox-branch'), status: 'active' }),
    item({ id: 'd', source: src('ffbox-branch'), sessionIds: ['s1'] }),
    item({ id: 'e', source: src('ffbox-dev') }),
    item({ id: 'f', source: src('release') }),
    item({ id: 'g', source: src('ffbox-branch'), status: 'done' }),
    item({ id: 'h' }),
  ];
  assert.deepEqual(mergeCandidates(all).map((w) => w.id), ['a', 'b']);
});

test('a linked request counts only when it is done', () => {
  const w = item({ id: 'w1', relatedIds: ['w2'], source: { kind: 'ffbox-request', untrusted: false } });
  assert.equal(linkedDone(w, [item({ id: 'w2', status: 'done' })])?.id, 'w2');
  assert.equal(linkedDone(w, [item({ id: 'w2', status: 'rejected' })]), undefined);
  assert.equal(linkedDone(w, [item({ id: 'w2', status: 'merged' }), item({ id: 'w3', status: 'active' })]), undefined);
  assert.equal(linkedDone(item({ id: 'w1' }), [item({ id: 'w4', status: 'done', relatedIds: ['W1'] })])?.id, 'w4', 'either side names the other');
  assert.equal(linkedDone(item({ id: 'w1', keys: ['pr:412'] }), [item({ id: 'w5', status: 'done', keys: ['pr:412'] })])?.id, 'w5');
  assert.equal(linkedDone(item({ id: 'w1', keys: ['spec:098'] }), [item({ id: 'w6', status: 'done', keys: ['spec:098'] })]), undefined, 'a spec is not the same work');
  assert.equal(linkedDone(item({ id: 'w1', source: { kind: 'discord-bug', untrusted: true, threadId: '5555555555555555555' } }), [item({ id: 'w7', status: 'done', source: { kind: 'discord-bug', untrusted: true, alsoThreads: [{ threadId: '5555555555555555555' }] } })])?.id, 'w7');
});
