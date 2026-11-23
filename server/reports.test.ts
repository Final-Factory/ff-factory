import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReportError, ReportStore, audienceOf, backfillAudienceOf, isCostReport, plainText } from './reports.ts';

/** Reports (w2541, docs/reports.md): filing, revising without losing the older text, media kept, listing and search. */

const LOTH = { userId: 'lothsahn', displayName: 'Lothsahn' };
const BEN = { userId: 'ben', displayName: 'Ben' };

function setup(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-reports-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const review = path.join(dir, '_review');
  fs.mkdirSync(path.join(review, 'w2531'), { recursive: true });
  const clock = { now: Date.parse('2026-10-29T10:00:00Z') };
  const open = () => new ReportStore(path.join(dir, 'data'), () => [review], () => new Date(clock.now));
  return { dir, review, clock, open, store: open() };
}

const w2531 = { id: 'w2531', title: 'Profile the late-game save', requesters: [LOTH] };
const w2600 = { id: 'w2600', title: 'Design the new belt UI', requesters: [BEN] };

test('a filed report gets the next id, the request and its operators, and survives a restart', (t) => {
  const { store, open } = setup(t);
  const a = store.file({ title: 'Late-game frame time', kind: 'profile', body: '# Result\n\nMeasured: 41 ms a frame on M3.' }, w2531, 'sess-1');
  const b = store.file({ title: 'Belt UI options', kind: 'design', body: 'Three options.' }, w2600, 'sess-2');
  assert.equal(a.report.id, 'r1');
  assert.equal(b.report.id, 'r2');
  assert.ok(a.created);
  assert.deepEqual(a.report.requesters, [LOTH]);
  assert.equal(a.report.workId, 'w2531');
  assert.equal(a.report.excerpt, 'Result Measured: 41 ms a frame on M3.');
  const again = open();
  assert.deepEqual(
    again.all().map((r) => r.id),
    ['r2', 'r1'],
  );
  assert.equal(again.get('r1')!.body, '# Result\n\nMeasured: 41 ms a frame on M3.');
  // A number is never given twice, even after the newest report's folder is gone.
  fs.rmSync(path.join(again.root, 'r2'), { recursive: true });
  assert.equal(open().file({ title: 'x', kind: 'other', body: 'y' }, w2600, undefined).report.id, 'r3');
});

test('a revision adds a file and keeps every older text', (t) => {
  const { store, clock, open } = setup(t);
  store.file({ title: 'Late-game frame time', kind: 'profile', body: 'First numbers (guess).' }, w2531, 'sess-1');
  clock.now += 3_600_000;
  const r = store.file({ id: 'r1', title: 'Late-game frame time, M3 and BEAST', kind: 'profile', body: 'Measured on both.', note: 'added BEAST' }, w2531, 'sess-9');
  assert.equal(r.rev, 2);
  assert.ok(!r.created);
  assert.equal(r.report.revisions, 2);
  assert.equal(r.report.createdAt, '2026-10-29T10:00:00.000Z');
  assert.equal(r.report.updatedAt, '2026-10-29T11:00:00.000Z');
  const s = open();
  assert.equal(s.get('r1')!.body, 'Measured on both.');
  assert.equal(s.get('r1', 1)!.body, 'First numbers (guess).');
  assert.deepEqual(
    s.get('r1')!.history.map((h) => [h.n, h.note, h.sessionId]),
    [
      [1, undefined, 'sess-1'],
      [2, 'added BEAST', 'sess-9'],
    ],
  );
  assert.equal(fs.readFileSync(path.join(s.root, 'r1', 'rev-1.md'), 'utf8'), 'First numbers (guess).');
  assert.equal(s.get('r1', 3), undefined);
});

test('only a worker of the same request revises a report; bad input is refused', (t) => {
  const { store } = setup(t);
  store.file({ title: 'T', kind: 'analysis', body: 'B' }, w2531, 's');
  assert.throws(() => store.file({ id: 'r1', title: 'T', kind: 'analysis', body: 'B2' }, w2600, 's'), (e: unknown) => e instanceof ReportError && e.status === 403);
  assert.throws(() => store.file({ id: 'r9', title: 'T', kind: 'analysis', body: 'B' }, w2531, 's'), (e: unknown) => e instanceof ReportError && e.status === 404);
  assert.throws(() => store.file({ title: 'T', kind: 'essay', body: 'B' }, w2531, 's'), /kind must be one of/);
  assert.throws(() => store.file({ title: ' ', kind: 'analysis', body: 'B' }, w2531, 's'), /needs a title/);
  assert.throws(() => store.file({ title: 'T', kind: 'analysis', body: '' }, w2531, 's'), /needs its text/);
});

test('stills from review media are copied in and their links rewritten; other local paths are named back', (t) => {
  const { store, review } = setup(t);
  const still = path.join(review, 'w2531', 'frame graph.png');
  fs.writeFileSync(still, 'png-bytes');
  const body = `Measured:\n\n![frame graph](<${still}>)\n\n![elsewhere](C:/Users/x/secret.png)\n\nhttps://example.com/x.png`;
  const r = store.file({ title: 'T', kind: 'profile', body }, w2531, 's');
  const text = store.get('r1')!.body;
  assert.match(text, /!\[frame graph\]\(<\/api\/reports\/r1\/media\/frame-graph\.png>\)/);
  assert.match(text, /!\[elsewhere\]\(C:\/Users\/x\/secret\.png\)/);
  assert.deepEqual(r.notKept, ['C:/Users/x/secret.png']);
  const kept = store.mediaFile('r1', 'frame-graph.png')!;
  assert.equal(fs.readFileSync(kept, 'utf8'), 'png-bytes');
  // The copy outlives review media's 14 days: delete the original and it is still there.
  fs.rmSync(still);
  assert.ok(store.mediaFile('r1', 'frame-graph.png'));
  assert.equal(store.mediaFile('r1', '../report.json'), undefined);
  // A revision that shows the same path again reuses the copy.
  fs.writeFileSync(still, 'png-bytes-2');
  store.file({ id: 'r1', title: 'T', kind: 'profile', body: `![g](<${still}>)` }, w2531, 's');
  assert.match(store.get('r1')!.body, /\/api\/reports\/r1\/media\/frame-graph\.png/);
});

test('listing filters by kind, request, operator and date; search matches every word and gives a snippet', (t) => {
  const { store, clock } = setup(t);
  store.file({ title: 'Late-game frame time', kind: 'profile', body: 'The belt render pass costs 12 ms on M3.' }, w2531, 's');
  clock.now = Date.parse('2026-10-30T09:00:00Z');
  store.file({ title: 'Belt UI options', kind: 'design', body: 'Three layouts for the belt panel.' }, w2600, 's');
  assert.deepEqual(
    store.list({ kind: 'design' }).map((r) => r.id),
    ['r2'],
  );
  assert.deepEqual(
    store.list({ request: 'w2531' }).map((r) => r.id),
    ['r1'],
  );
  assert.deepEqual(
    store.list({ person: 'LOTHSAHN' }).map((r) => r.id),
    ['r1'],
  );
  assert.deepEqual(
    store.list({ person: 'Ben' }).map((r) => r.id),
    ['r2'],
  );
  assert.deepEqual(
    store.list({ since: '2026-10-30' }).map((r) => r.id),
    ['r2'],
  );
  assert.deepEqual(
    store.list({ until: '2026-10-29' }).map((r) => r.id),
    ['r1'],
  );
  assert.deepEqual(
    store.list({ query: 'belt' }).map((r) => r.id),
    ['r2', 'r1'],
  );
  const hits = store.search({ query: 'render 12 ms' });
  assert.deepEqual(
    hits.map((h) => h.report.id),
    ['r1'],
  );
  assert.match(hits[0].snippet, /render pass costs 12 ms/);
  assert.deepEqual(
    store.list({ query: 'lothsahn' }).map((r) => r.id),
    ['r1'],
  );
  assert.deepEqual(store.list({ query: 'belt nowhere' }), []);
  assert.deepEqual(
    store.forWork('w2531').map((r) => r.id),
    ['r1'],
  );
});

test('attachments filed with a report are held, and the operators of the request are kept up to date', (t) => {
  const { store } = setup(t);
  const att = { id: 'att_abcdefabcdef', name: 'capture.zip', size: 10, sha256: 'a'.repeat(64), kind: 'zip', mediaType: 'application/zip' };
  store.file({ title: 'T', kind: 'profile', body: 'B', attachments: [att] }, w2531, 's');
  store.file({ id: 'r1', title: 'T', kind: 'profile', body: 'B2', attachments: [att] }, { ...w2531, requesters: [LOTH, BEN] }, 's');
  assert.deepEqual([...store.attachmentIds()], ['att_abcdefabcdef']);
  assert.equal(store.get('r1')!.attachments.length, 1);
  assert.deepEqual(store.get('r1')!.requesters, [LOTH, BEN]);
});

test('plainText drops Markdown for the excerpt', () => {
  assert.equal(plainText('# T\n\n![x](a.png) see [the PR](https://x) `code`\n\n```\nblock\n```\n| a | b |'), 'T see the PR code a b');
  // A table's rule line goes, emphasis leaves no gap before its punctuation, and a snake_case name keeps its underscore.
  assert.equal(plainText('1. **Left first**, as _Factorio_ does.\n\n| a | b |\n|---|:-:|\n| 1 | 2 |\n\nsee belt_render_system'), '1. Left first, as Factorio does. a b 1 2 see belt_render_system');
});

// ---------------------------------------------------------------- w5223: reports only when a person asks

test('w5223: a report is for people when asked, a review or a cost; anything else is a worker note', () => {
  const asked = { kind: 'design', by: 'Lothsahn', asked: true };
  assert.equal(audienceOf({ title: 'Belt UI options', mark: asked }).audience, 'people');
  // A mark from before w5223 has no asked: it reads as asked.
  assert.equal(audienceOf({ title: 'Belt UI options', mark: { kind: 'design', by: 'Ben' } }).audience, 'people');
  // The dispatcher's mark, or one outside a person's turn, is no ask.
  assert.equal(audienceOf({ title: 'Where the planner went', mark: { kind: 'investigation', by: 'the dispatcher', asked: false } }).audience, 'workers');
  assert.equal(audienceOf({ title: 'Where the planner went' }).audience, 'workers');
  // A review a person must make, and every cost estimate (lothsahn: "Please make sure the cost remains unhidden").
  assert.equal(audienceOf({ title: 'Splitter options', review: 'pick one of three splitter rules' }).audience, 'people');
  assert.equal(audienceOf({ title: 'FFU G3 rented scale-run cost estimate' }).audience, 'people');
  assert.equal(audienceOf({ title: 'FFU M5 run-cost refresh', mark: { kind: 'analysis', by: 'the dispatcher', asked: false } }).audience, 'people');
  assert.equal(audienceOf({ title: 'Scale run', review: 'approve the $412 rent' }).audience, 'people');
  assert.ok(isCostReport('Spending on the nightly'));
  assert.ok(!isCostReport('Costume shader pass'));
  assert.ok(!isCostReport('Late-game frame time'));
});

test('w5223: search for people skips worker notes; a revision never hides a report people saw; backfill runs once', (t) => {
  const { store, open } = setup(t);
  store.file({ title: 'Late-game frame time', kind: 'profile', body: 'one', audience: 'workers', audienceWhy: 'worker note: no report asked' }, w2531, 'sess-1');
  store.file({ title: 'Belt UI options', kind: 'design', body: 'two', audience: 'people' }, w2600, 'sess-2');
  assert.deepEqual(store.list({ audience: 'people' }).map((r) => r.id), ['r2']);
  assert.deepEqual(store.list().map((r) => r.id), ['r2', 'r1']);
  // A worker note becomes a report for people when a revision is (the request was marked since); never the other way.
  store.file({ id: 'r2', title: 'Belt UI options', kind: 'design', body: 'two, revised', audience: 'workers' }, w2600, 'sess-2');
  assert.equal(store.get('r2')!.audience, 'people');
  store.file({ id: 'r1', title: 'Late-game frame time', kind: 'profile', body: 'one, revised', audience: 'people', audienceWhy: 'asked' }, w2531, 'sess-1');
  assert.equal(store.get('r1')!.audience, 'people');

  // Reports from before w5223 carry no audience: the backfill gives each one, written down, and skips them next time.
  const old = open();
  const r3 = old.file({ title: 'Where the planner went', kind: 'investigation', body: 'x' }, w2531, 's');
  const r4 = old.file({ title: 'FFU G3 rented scale-run cost estimate', kind: 'analysis', body: 'y' }, w2531, 's');
  for (const id of [r3.report.id, r4.report.id]) {
    const f = path.join(old.root, id, 'report.json');
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    delete j.audience;
    fs.writeFileSync(f, JSON.stringify(j));
  }
  const again = open();
  const w = { report: { kind: 'investigation' as const, at: '', by: 'the dispatcher' }, humanAsked: true };
  assert.deepEqual(again.backfillAudience((r) => backfillAudienceOf(r, w)), { people: 1, workers: 1 });
  assert.equal(again.get('r3')!.audience, 'workers');
  assert.match(again.get('r3')!.audienceWhy!, /dispatcher.*backfilled, w5223/);
  assert.equal(again.get('r4')!.audience, 'people');
  assert.deepEqual(open().backfillAudience(() => assert.fail('backfilled twice')), { people: 0, workers: 0 });
});

test('w5223: the backfill keeps people-asked and cost reports, and hides unmarked, dispatcher and hand-up ones', () => {
  const t = (title: string, w?: Parameters<typeof backfillAudienceOf>[1]) => backfillAudienceOf({ title }, w).audience;
  const mark = (by: string, asked?: boolean) => ({ kind: 'analysis' as const, at: '', by, ...(asked === undefined ? {} : { asked }) });
  assert.equal(t('Profile', { report: mark('Lothsahn'), humanAsked: true }), 'people');
  assert.equal(t('Profile', { report: mark('Lothsahn'), humanAsked: false }), 'workers');
  assert.equal(t('Profile', { report: mark('Lothsahn', true), humanAsked: false }), 'people');
  assert.equal(t('Profile', { report: mark('the dispatcher'), humanAsked: true }), 'workers');
  assert.equal(t('Profile', { report: undefined, humanAsked: true }), 'workers');
  assert.equal(t('FFU M5 run-cost refresh', { report: undefined, humanAsked: false }), 'people');
  assert.equal(t('Profile', undefined), 'people');
});
