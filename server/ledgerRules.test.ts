import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterMergeReason, cleanupSettings, cutOffOf, deployStep, doneProblem, isRelease, mergedMentionsIn, mergePrs, ownerAt, partOfIdsIn, partOfReason, prsOf, prUrlsIn, reportVerdict, requestIdsIn, stallCandidate, stillOpenIn, supersededBy, titleIdsIn, type PrRecord } from './ledgerRules.ts';
import { reportClip } from './sessions.ts';
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

test('a PR is a request’s only on strong evidence: its Request line, its own worker opened it after filing, or its head is the request’s branch (w340)', () => {
  assert.deepEqual(requestIdsIn('Fix\n\nRequest: w293\nrequest: W5 and more'), ['w293', 'w5']);
  assert.deepEqual(prUrlsIn('opened https://github.com/Final-Factory/ff-factory/pull/66 ok'), [{ repo: 'Final-Factory/ff-factory', number: 66 }]);
  const w = item({ id: 'w10', createdAt: '2026-10-03T10:00:00Z' });
  const none = { opened: [] };
  const all = [pr({ number: 1, body: 'Request: w10' }), pr({ number: 2, body: 'Request: w11', head: 'sandbox/x' }), pr({ number: 3, head: 'sandbox/x' }), pr({ number: 6, head: 'other' })];
  assert.deepEqual(prsOf(w, all, none).map((p) => [p.number, p.via]), [[1, 'line']], 'by line only; a shared branch, a worker’s sandbox or another request’s line do not link');
  assert.deepEqual(prsOf(w, all, { opened: [{ repo: 'Final-Factory/FinalFactory', number: 6, at: '2026-10-03T11:30:00Z' }] }).map((p) => [p.number, p.via]), [[1, 'line'], [6, 'worker']]);
  assert.deepEqual(prsOf(w, [pr({ number: 7, createdAt: '2026-10-03T09:00:00Z', mergedAt: undefined, state: 'open' })], { opened: [{ repo: 'Final-Factory/FinalFactory', number: 7, at: '2026-10-03T09:00:01Z' }] }), [], 'opened before the request was filed');
  const intake = item({ id: 'w11', source: { kind: 'ffbox-branch', untrusted: false, branch: 'ffbox/x' } });
  assert.deepEqual(prsOf(intake, [pr({ number: 8, head: 'ffbox/x' }), pr({ number: 9, head: 'develop' })], none).map((p) => [p.number, p.via]), [[8, 'branch']]);
});

test('never from related ids, a PR number in the brief or a report, or a merge from before the request was filed (w340)', () => {
  const w = item({ id: 'w339', createdAt: '2026-10-03T18:00:00Z', keys: ['pr:988'], relatedIds: ['PR 988', 'w292'], brief: 'Follow-up to #988 (the earlier bay tier).' });
  const early = pr({ number: 988, head: 'sandbox/bay', createdAt: '2026-10-03T12:00:00Z', mergedAt: '2026-10-03T14:00:00Z' });
  assert.deepEqual(prsOf(w, [early], { opened: [] }), [], 'related, in the brief, and merged before filing');
  assert.deepEqual(prsOf(w, [early], { opened: [{ repo: early.repo, number: 988, at: '2026-10-03T19:00:00Z' }] }), [], 'even if a worker’s report mentions it: it merged before the request was filed');
  assert.deepEqual(prsOf(w, [{ ...early, body: 'Request: w339' }], { opened: [] }), [], 'nor does a Request line revive a merge from before filing');
});

test('a worker that does requests one after another opens each one’s PRs for the request it was on', () => {
  const a = { id: 'w314', createdAt: '2026-10-03T10:00:00Z' };
  const b = { id: 'w324', createdAt: '2026-10-03T16:00:00Z' };
  assert.equal(ownerAt([a, b], '2026-10-03T12:00:00Z')?.id, 'w314');
  assert.equal(ownerAt([a, b], '2026-10-03T17:00:00Z')?.id, 'w324');
  assert.equal(ownerAt([a, b], '2026-10-03T09:00:00Z'), undefined, 'before either was filed');
});

test('stored PRs keep their note while the state holds, and take gh’s state when it moves', () => {
  const stored = [{ repo: 'a/b', number: 7, state: 'open' as const, noted: 'x', via: 'line' as const }];
  assert.equal(mergePrs(stored, [pr({ repo: 'a/b', number: 7, state: 'open' })])[0].noted, 'x');
  const moved = mergePrs(stored, [pr({ repo: 'a/b', number: 7, state: 'merged', sha: 'c'.repeat(40) })])[0];
  assert.deepEqual([moved.state, moved.noted, moved.sha, moved.via], ['merged', undefined, 'c'.repeat(40), 'line']);
  assert.deepEqual(mergePrs([{ repo: 'a/b', number: 8, state: 'merged' }], []), [], 'a link from before w340 has no evidence and goes');
});

test('a PR that says Part of: wNNN is linked, but its merge leaves the request open; a Request line wins (w424)', () => {
  const w = item({ id: 'w424', createdAt: '2026-10-03T10:00:00Z' });
  assert.deepEqual(requestIdsIn('Fix\n\nPart of: w424\nRequest: w9'), ['w424', 'w9']);
  assert.deepEqual(partOfIdsIn('Fix\n\npart of: W424\n'), ['w424']);
  assert.deepEqual(partOfIdsIn('Part of: w424\nRequest: w424'), [], 'a Request line for the same request wins');
  const linked = prsOf(w, [pr({ number: 99, body: 'Part of: w424' }), pr({ number: 100, body: 'Request: w424' })], { opened: [] });
  assert.deepEqual(linked.map((p) => [p.number, p.via, p.partOf]), [[99, 'line', true], [100, 'line', false]]);
  // Stored: the flag stays while a later lookup by number (no link evidence of its own) refreshes the PR's state.
  const stored = mergePrs([], linked.slice(0, 1));
  assert.equal(stored[0].partOf, true);
  assert.equal(mergePrs(stored, [pr({ number: 99, state: 'merged' })])[0].partOf, true);
  assert.equal(mergePrs(stored, [{ ...pr({ number: 99, body: 'Request: w424' }), via: 'line', partOf: false }])[0].partOf, undefined, 'its description now says Request');
  assert.match(partOfReason('w424', stored)!, /PR #99 is one step of it \(its description says Part of: w424\); more follows/);
  assert.equal(partOfReason('w424', mergePrs([], linked)), undefined, 'the last to merge (#100, same time, higher number last) is a Request PR');
  const later = mergePrs([], [{ ...linked[1], mergedAt: '2026-10-03T11:00:00Z' }, { ...linked[0], mergedAt: '2026-10-03T13:00:00Z' }]);
  assert.match(partOfReason('w424', later)!, /PR #99/, 'a Part of PR that merged last keeps it open');
});

test('a long final report is kept by its start and its end, so "still open" at the end is seen (w424, closed twice)', () => {
  // w424's worker ended long reports with "w424: still open: …"; lastResult kept only the first 1200 characters.
  const report = `**TL;DR:** The crash-safety fix is merged: PR #100. ${'Details of the change and the tests. '.repeat(60)}\n\nw424: still open: lothsahn's deploy, then add_machine, the migration and the restart test`;
  const oldClip = report.slice(0, 1200) + `\n… (${report.length - 1200} more chars)`;
  const base = { title: 'FF Factory: workers keep running through portal restarts', brief: 'Migrate the sandboxes.' };
  assert.equal(afterMergeReason(base, [oldClip]), undefined, 'the old clip lost the line: the merge closed the request');
  const kept = reportClip(report);
  assert.ok(kept.length < report.length && kept.startsWith('**TL;DR:** The crash-safety fix is merged'));
  assert.ok(kept.endsWith('the migration and the restart test'));
  assert.match(afterMergeReason(base, [kept])!, /more is coming.*still open/);
  assert.equal(reportClip('short'), 'short');
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

test('w419: DONE lines, what a DONE still misses, and when the follow-up is due', async () => {
  const { doneIdsIn, doneProblem, followUpDue, FOLLOW_UP_QUIET_MS, FOLLOW_UP_EVERY_MS } = await import('./ledgerRules.ts');
  assert.deepEqual(doneIdsIn('Merged.\n\nDONE: w342\n- **DONE: W12**\n> DONE w7.'), ['w342', 'w12', 'w7']);
  assert.deepEqual(doneIdsIn('Reply DONE: w342 when sure.\nDONE: w342 and more text\nDONE: wNNN'), [], 'only a line of its own counts');
  const base = { title: 'Fix it', brief: 'Make it work.', prs: [{ repo: 'r/r', number: 1, state: 'merged' as const }] };
  assert.equal(doneProblem(base, 'Done.'), undefined);
  assert.match(doneProblem({ ...base, prs: [...base.prs, { repo: 'r/r', number: 2, state: 'open' as const }] }, 'Done.')!, /PR #2 is still open/);
  assert.match(doneProblem({ ...base, title: 'Release 0.50.0.77' }, 'It is live.')!, /link the posted notes/);
  assert.equal(doneProblem({ ...base, title: 'Release 0.50.0.77' }, 'Live on development. Notes: https://discord.com/channels/1/2/3'), undefined);
  assert.match(doneProblem({ ...base, brief: 'Plan: PR1 data, PR2 presentation.' }, 'Merged.')!, /plans more than one PR/);
  assert.equal(doneProblem({ ...base, brief: 'Plan: PR1 data, PR2 presentation.' }, 'Both PRs merged.'), undefined);
  const T = Date.parse('2026-10-05T01:43:00Z');
  const merged = { prs: [{ repo: 'r/r', number: 1024, state: 'merged' as const, at: new Date(T).toISOString() }] };
  assert.equal(followUpDue(merged, [], () => false), T + FOLLOW_UP_QUIET_MS);
  assert.equal(followUpDue({ ...merged, followUp: { at: new Date(T + 7 * 3_600_000).toISOString(), sessionId: 's' } }, [], () => false), T + 7 * 3_600_000 + FOLLOW_UP_EVERY_MS, 'once a day after a question');
});

test('w515: a release is a title that cuts, ships, names or posts one; "release" in passing, or a patch notes line, is not one', () => {
  const brief = 'Fix it.';
  // Real release requests' titles in the ledger (2026-09-29 to 2026-10-06).
  for (const title of [
    'Shepherd all of Lothsahn\'s open FinalFactory PRs to merge (fix conflicts, wait for CI), then cut release 0.50.0.53',
    'Post the 0.50.0.53 patch notes as Max in #dev-patch-notes from LothDesktop once the release is live',
    'Release 0.50.0.54 to multiplayer-beta tonight once the current fixes land (after .53)',
    'Hotfix release 0.50.0.55 to multiplayer-beta as soon as the mega-wave cap (w92) merges',
    'Write the 0.50.0.58 release notes (build cut from master by lothsahn) and post them on Discord once live',
    'Merge #997, #1018 and #1021, then cut a develop release (0.50.0.73) with patch notes',
    'Cut 0.50.0.75 right after 0.50.0.74 is live, to ship blueprint folders (#1047)',
    'Release Build 79 from develop now (FFBox lane), then post patch notes in #dev-patch-notes',
  ])
    assert.ok(isRelease({ title, brief }), title);
  // Not releases: w395, w216, the demo check, the VM update, and w487 (its brief adds a patch notes line).
  for (const title of [
    'Switch versioning to a single build number ("Build 576"), without breaking saves, MP or the release pipeline',
    'Make the release flow unambiguous: one documented, checked truth of what FFBox uploads and sets live',
    'Release-readiness check: the DEMO build for tomorrow (the demo toggle, demo builds, restricted techs)',
    'Portal VM: make "fffctl update" blocking, streaming progress until the new release is verified',
  ])
    assert.ok(!isRelease({ title, brief }), title);
  const w487 = { title: 'Connector merge: two belts feeding one at equal rates should alternate items fairly (like Factorio); fix carefully', brief: 'Done when all of the above holds and the PR is merged once it\'s green and verified. Add a patch notes line.' };
  assert.ok(!isRelease(w487));
  assert.equal(afterMergeReason(w487, []), undefined);
  assert.ok(isRelease({ title: 'Ship it', brief: 'Bump the version, then post the patch notes as Max.' }));
});

test('w515: a 2-peer check or a paired audit is a step after the merge only where the brief puts it after the merge', () => {
  const title = 'Fix it';
  // Before the merge: the briefs of w408, w411, w449, w454 and w484 (their "Done when" ends in the merge).
  for (const brief of [
    'Failing-first test; paired audit and a 2-peer built run deleting a full connector (host and client). Merge when verified and green.',
    'Built players, host plus 2 clients: the fingerprints match for several minutes after. Measured, in built players with 2 peers. Fast suite and CI green; a clip of the switch from a client\'s view; then merge (don\'t hold the PR).',
    'single player and a 2-peer multiplayer check. 5. Merge the PR once it\'s green and verified (merge by default).',
    'it\'s checked against Ben\'s words, plus single player and a 2-peer check; the PR is merged once it\'s green and visually verified.',
    'a 2-peer check passes;\n- the PR is merged once it\'s green and verified.',
  ])
    assert.equal(afterMergeReason({ title, brief }, []), undefined, brief);
  // After the merge, said so.
  for (const brief of [
    'Then run a 2-peer check after the merge.',
    'Run the paired determinism audit when it lands.',
    'Do a post-merge soak on develop.',
    'Once merged, watch the nightly.',
    'Merge with tests green, then deploy the usual way.',
  ])
    assert.match(afterMergeReason({ title, brief }, [])!, /after the merge/, brief);
});

test('w515: an open PR gh could not read is "couldn\'t verify", not "still open"; a report saying a linked PR merged is found', () => {
  const w = { title: 'Fix it', brief: 'Make it work.', prs: [{ repo: 'o/r', number: 7, state: 'open' as const }] };
  assert.match(doneProblem(w, 'DONE: w1')!, /^PR #7 is still open/);
  assert.match(doneProblem(w, 'DONE: w1', [7])!, /^couldn't verify PR #7 on GitHub just now/);
  const prs = [{ repo: 'o/r', number: 1089, state: 'open' as const }, { repo: 'o/r', number: 12, state: 'merged' as const }];
  assert.deepEqual(mergedMentionsIn('PR #1089 (w454) was merged into develop at 01:32 UTC.', prs).map((p) => p.number), [1089]);
  assert.deepEqual(mergedMentionsIn('https://github.com/o/r/pull/1089 merged', prs).map((p) => p.number), [1089]);
  assert.deepEqual(mergedMentionsIn('PR #1089 is open, waiting on CI.', prs), []);
  assert.deepEqual(mergedMentionsIn('PR #10890 merged.', prs), []);
});

test('w631: a status line says what is left ("w12: still open: …", "NOT DONE: w12 …"); a mention in a sentence or a DONE line is not one', () => {
  const lines = stillOpenIn('Merged #12.\nw12: still open: the 2-peer check\n- **w13: still open** — the notes\nNOT DONE: w14: the deploy\nI said w15: still open earlier.\nDONE: w16');
  assert.deepEqual([...lines.keys()], ['w12', 'w13', 'w14']);
  assert.equal(lines.get('w12'), 'w12: still open: the 2-peer check');
  assert.equal(lines.get('w14'), 'NOT DONE: w14: the deploy');
});

test('w631: a deploy is the only step left when nothing else after the merge is: the portal, the machines, or neither', () => {
  const w = item({ id: 'w1' });
  assert.equal(deployStep(w, ['Merged as #193.']), undefined, 'nothing is left at all');
  assert.deepEqual(deployStep(w, ["Merged as #193. Waiting on the portal deploy, which needs lothsahn's own words."]), { portal: true, machines: false });
  assert.deepEqual(deployStep(w, ['Merged. Still to do: update the worker machines (beast, lothdesktop).']), { portal: false, machines: true });
  assert.deepEqual(deployStep(item({ id: 'w2', brief: 'Fix the daemon. Merge, then deploy the portal and update the machines.' }), ['Merged.']), { portal: true, machines: true });
  // Something besides the deploy is left: an audit, a release, a question, a plan of PRs, or more work in the report.
  assert.equal(deployStep(item({ id: 'w3', brief: 'Fix it, then run the paired determinism audit after the merge.' }), ['Merged. Waiting on the portal deploy.']), undefined);
  assert.equal(deployStep(item({ id: 'w4', title: 'Release 0.50.0.80' }), ['Merged. Waiting on the deploy.']), undefined);
  assert.equal(deployStep(item({ id: 'w5', question: { text: 'which one?', at: T } }), ['Waiting on the deploy.']), undefined);
  assert.equal(deployStep(w, ['Merged. Waiting on the portal deploy. The second PR is next.']), undefined);
  assert.equal(deployStep(w, ['Merged. After the deploy, run the nightly soak.']), undefined, 'a sentence naming another step is never set aside');
});

test('w631: a PR title names its request at its start or as its trailing ids only; a step is a part', () => {
  assert.deepEqual(titleIdsIn('w604/w556: warm the shader variants at boot on Windows too'), { ids: ['w604', 'w556'], part: false });
  assert.deepEqual(titleIdsIn('w605 (1): a portal update no longer blocks the workers'), { ids: ['w605'], part: true });
  assert.deepEqual(titleIdsIn('Mass driver link highlight: 40% brighter (w184)'), { ids: ['w184'], part: false });
  assert.deepEqual(titleIdsIn('KNN: a ship holds no neighbours (w197/w214)'), { ids: ['w197', 'w214'], part: false });
  assert.deepEqual(titleIdsIn('w186: smooth-motion architecture, research and plan (docs only, do not merge yet)'), { ids: ['w186'], part: true });
  for (const t of ['Desync report: a bot\'s cargo (w170 diagnostics)', 'Construction bots (deconstruction 15% slower since w170)', 'Load: remap item ids; w292 index-shift regression', 'Station ships change frame (w165 follow-up)', 'Revert "w551: Ringed Gas Giant" (#1161)']) assert.deepEqual(titleIdsIn(t).ids, [], t);
  // prsOf links by the title, also when the description says it is another request's (a takeover).
  const w = item({ id: 'w556', createdAt: '2026-10-01T00:00:00Z' });
  const linked = prsOf(w, [pr({ number: 1196, title: 'w604/w556: warm the variants', body: 'Request: w604' }), pr({ number: 900, title: 'Desync report (w556 diagnostics)' })], { opened: [] });
  assert.deepEqual(linked.map((p) => [p.number, p.via, p.partOf]), [[1196, 'title', false]]);
});
