import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeMedia, mediaHolds, placeholderSvg, readTombstone, removedMedia, removedText, removedUpload, runMediaRetention, TOMBSTONE, topicRequest, withMedia } from './mediaRetention.ts';
import { Store } from './store.ts';
import { normalizeSetting } from './appConfig.ts';
import type { SessionInfo, WorkItem } from '../shared/types.ts';

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-10-26T12:00:00Z');

type S = Pick<SessionInfo, 'id' | 'kind' | 'status' | 'lastActivityAt' | 'waitingOn' | 'openAsks'>;
type W = Pick<WorkItem, 'id' | 'status' | 'sessionIds'> & Record<string, unknown>;

function tree(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (rel: string, ageDays: number, bytes = 100) => {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, Buffer.alloc(bytes, 1));
    const at = new Date(NOW - ageDays * DAY);
    fs.utimesSync(f, at, at);
    return f;
  };
  return { root, uploads: path.join(root, 'data', 'uploads'), review: path.join(root, 'review'), put };
}

const session = (id: string, over: Partial<S> = {}): S => ({ id, kind: 'worker', status: 'idle', lastActivityAt: new Date(NOW - 30 * DAY).toISOString(), ...over }) as S;
const run = (x: ReturnType<typeof tree>, sessions: S[], work: W[] = [], dryRun = false) =>
  runMediaRetention({ uploadDir: x.uploads, reviewRoot: x.review, days: 14, sessions, work: work as unknown as WorkItem[], now: NOW, dryRun });

test('age cut-off: 15 days goes, 13 stays; a worker counts from its last activity, a chat that never idles from the file', async (t) => {
  const x = tree(t);
  const old = x.put('data/uploads/old/a.png', 15, 1000);
  const young = x.put('data/uploads/old/b.jpg', 13);
  const recentWorker = x.put('data/uploads/busy/c.png', 40);
  const orchOld = x.put('data/uploads/orch/d.webp', 20);
  const orchYoung = x.put('data/uploads/orch/e.gif', 2);
  const rOld = x.put('review/topic-a/shot.png', 15, 500);
  const rPrev = x.put('review/topic-a/.preview/clip.webm.mp4', 15, 300);
  const rClip = x.put('review/topic-a/clip.webm', 15, 700);
  const rYoung = x.put('review/topic-a/new.mp4', 1);
  const orphan = x.put('review/topic-a/.preview/gone.mov.mp4', 20, 50);
  const r = await run(x, [
    session('old'),
    session('busy', { lastActivityAt: new Date(NOW - 3 * DAY).toISOString() }),
    session('orch', { kind: 'orchestrator', lastActivityAt: new Date(NOW).toISOString() }),
  ]);
  for (const f of [old, orchOld, rOld, rPrev, rClip, orphan]) assert.equal(fs.existsSync(f), false, `${f} removed`);
  for (const f of [young, recentWorker, orchYoung, rYoung]) assert.equal(fs.existsSync(f), true, `${f} kept`);
  assert.equal(r.summary.removedFiles, 6);
  assert.equal(r.bytes, 1000 + 100 + 500 + 300 + 700 + 50);
  assert.equal(r.summary.freedBytes, r.bytes);
  assert.deepEqual(r.summary.keptYoung, { files: 4, bytes: 400 });
  assert.deepEqual(r.summary.inventory.uploads, { files: 5, bytes: 1400 });
  assert.equal(r.removed.every((i) => i.rule === 'media'), true);
  assert.match(r.removed.find((i) => i.path.endsWith(path.join('review', 'topic-a')))!.why, /1 picture\(s\), 1 video\(s\) and 1 preview\(s\), idle over 14 days/);
});

test('only pictures and videos go: notes, json, logs and transcripts stay whatever their age', async (t) => {
  const x = tree(t);
  const keep = ['data/uploads/old/note.txt', 'data/uploads/old/x.json', 'review/topic/notes.md', 'review/topic/report.html', 'review/topic/run.log'].map((p) => x.put(p, 90));
  const gone = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'mp4', 'webm', 'mov'].map((e) => x.put(`review/topic/f.${e}`, 90));
  await run(x, [session('old')]);
  for (const f of keep) assert.equal(fs.existsSync(f), true, `${f} kept`);
  for (const f of gone) assert.equal(fs.existsSync(f), false, `${f} removed`);
});

test('skip if referenced: live, waiting and asking sessions, open requests, their topics, files their words name', async (t) => {
  const x = tree(t);
  const files = {
    live: x.put('data/uploads/live/a.png', 30),
    waiting: x.put('data/uploads/waiting/a.png', 30),
    asking: x.put('data/uploads/asking/a.png', 30),
    ofOpen: x.put('data/uploads/ofopen/a.png', 30),
    ofDone: x.put('data/uploads/ofdone/a.png', 30),
    namedId: x.put('data/uploads/other/0f3e-named.png', 30),
    unnamed: x.put('data/uploads/other/plain.png', 30),
    topicOpen: x.put('review/w2268-retention/a.png', 30),
    topicStalled: x.put('review/w9-x/a.png', 30),
    topicDone: x.put('review/w100-old/a.png', 30),
    namedReview: x.put('review/misc/card.png', 30),
    askedReview: x.put('review/misc/asked.mp4', 30),
    plainReview: x.put('review/misc/other.png', 30),
  };
  const work: W[] = [
    { id: 'w2268', status: 'active', sessionIds: ['ofopen'] },
    { id: 'w9', status: 'stalled', sessionIds: [] },
    { id: 'w100', status: 'done', sessionIds: ['ofdone'] },
    { id: 'w5', status: 'question', sessionIds: [], question: 'Is ![still](/api/uploads/other/0f3e-named) right?', needsYou: 'look at C:\\srv\\review\\misc\\card.png' },
  ];
  const r = await run(x, [
    session('live', { status: 'running' }),
    session('waiting', { waitingOn: { who: 'Ben', what: 'look', at: '' } }),
    session('asking', { kind: 'orchestrator', openAsks: [{ id: 'q1', question: 'Which? /api/image?path=misc/asked.mp4' } as never] }),
    session('ofopen'),
    session('ofdone'),
    session('other'),
  ], work);
  const kept = ['live', 'waiting', 'asking', 'ofOpen', 'namedId', 'topicOpen', 'topicStalled', 'namedReview', 'askedReview'] as const;
  for (const k of kept) assert.equal(fs.existsSync(files[k]), true, `${k} kept`);
  for (const k of ['ofDone', 'unnamed', 'topicDone', 'plainReview'] as const) assert.equal(fs.existsSync(files[k]), false, `${k} removed`);
  assert.deepEqual(r.summary.keptReferenced, { files: kept.length, bytes: kept.length * 100 });
});

test('mediaHolds and topicRequest', () => {
  const h = mediaHolds([session('a', { status: 'starting' }), session('b')], [{ id: 'W12', status: 'blocked', sessionIds: ['c'] }, { id: 'w13', status: 'cancelled', sessionIds: ['d'] }] as unknown as WorkItem[]);
  assert.deepEqual([...h.sessions].sort(), ['a', 'c']);
  assert.deepEqual([...h.requests], ['w12']);
  assert.equal(topicRequest('w2268-retention'), 'w2268');
  assert.equal(topicRequest('W77'), 'w77');
  assert.equal(topicRequest('w12x'), undefined);
  assert.equal(topicRequest('misc'), undefined);
});

test('placeholder: a removed file leaves a tombstone, served as "[image removed after 14 days]" and never a broken link', async (t) => {
  const x = tree(t);
  const pic = x.put('data/uploads/s1/abc.png', 20, 42);
  const clip = x.put('review/topic/clip.mp4', 20);
  await run(x, [session('s1')]);
  assert.equal(fs.existsSync(pic), false);
  const tomb = readTombstone(path.dirname(pic));
  assert.deepEqual(tomb['abc.png'], { at: new Date(NOW).toISOString(), days: 14, bytes: 42 });
  assert.equal(removedMedia(pic)?.days, 14);
  assert.equal(removedMedia(clip)?.days, 14);
  assert.equal(removedMedia(path.join(path.dirname(clip), 'never.png')), undefined, 'a file that was never there is a plain 404');
  assert.equal(removedUpload(path.dirname(pic), 'abc')?.bytes, 42);
  assert.equal(removedUpload(path.dirname(pic), 'zzz'), undefined);
  assert.equal(removedText(pic, 14), '[image removed after 14 days]');
  assert.equal(removedText(clip, 14), '[video removed after 14 days]');
  assert.match(placeholderSvg(14).toString(), /^<svg[\s\S]*\[image removed after 14 days\][\s\S]*<\/svg>$/);

  const store = new Store(path.join(x.root, 'data'));
  assert.equal(store.uploadsDir, x.uploads);
  assert.equal(store.removedImage('s1', 'abc')?.days, 14, 'the /api/uploads route finds it by id');

  // Put back by hand: no longer "removed".
  fs.writeFileSync(pic, 'x');
  assert.equal(removedMedia(pic), undefined);
  assert.equal(removedUpload(path.dirname(pic), 'abc'), undefined);
});

test('dry run removes nothing and writes no tombstone; 0 days does nothing', async (t) => {
  const x = tree(t);
  const pic = x.put('data/uploads/s1/abc.png', 20, 42);
  const r = await run(x, [session('s1')], [], true);
  assert.equal(fs.existsSync(pic), true);
  assert.equal(fs.existsSync(path.join(path.dirname(pic), TOMBSTONE)), false);
  assert.equal(r.summary.removedFiles, 1);
  assert.equal(r.summary.dryRun, true);
  const merged = withMedia({ removed: [], failed: [], bytes: 5 }, r, true);
  assert.equal(merged.bytes, 5);
  assert.equal(merged.removed.length, 0);
  assert.equal(merged.planned?.length, 1);
  assert.match(describeMedia(r.summary), /dry run: would remove 1 picture\/video file\(s\)/);

  const off = await runMediaRetention({ uploadDir: x.uploads, reviewRoot: x.review, days: 0, sessions: [session('s1')], work: [], now: NOW });
  assert.equal(off.removed.length, 0);
  assert.equal(fs.existsSync(pic), true);
});

test('withMedia folds the pass into the clean-up run; the log line and the setting', async (t) => {
  const x = tree(t);
  x.put('data/uploads/s1/abc.png', 20, 2 * 1024 * 1024);
  const r = await run(x, [session('s1')]);
  const merged = withMedia({ removed: [{ path: '/x', bytes: 10, rule: 'age' }], failed: [], bytes: 10 }, r);
  assert.equal(merged.removed.length, 2);
  assert.equal(merged.bytes, 10 + 2 * 1024 * 1024);
  assert.equal(merged.media, r.summary);
  assert.match(describeMedia(r.summary), /^media retention \(14 days\): removed 1 picture\/video file\(s\), 2\.0 MB freed; kept 0 file\(s\) 0\.0 MB still referenced, 0 file\(s\) 0\.0 MB newer; before: uploads 1 file\(s\) 2\.0 MB, review 0 file\(s\) 0\.0 MB$/);

  assert.equal(normalizeSetting('hostGuard.cleanup.mediaDays', 30), 30);
  assert.equal(normalizeSetting('hostGuard.cleanup.mediaDays', 0), 0);
  assert.throws(() => normalizeSetting('hostGuard.cleanup.mediaDays', 1.5), /0 \(never\) or a whole number of days/);
  assert.throws(() => normalizeSetting('hostGuard.cleanup.mediaDays', -1), /0 \(never\)/);
});
