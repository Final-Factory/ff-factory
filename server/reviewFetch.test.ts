/** fetch_review (w4926, docs/review.md "Getting review files back"). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AttachmentStore } from './attachments.ts';
import { FETCH_REVIEW_MAX_FILES, reviewFilesFor, reviewFilesForMachine } from './reviewFetch.ts';

function setup(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-rf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const root = path.join(dir, 'review');
  fs.mkdirSync(path.join(root, 'w4877-clips'), { recursive: true });
  fs.mkdirSync(path.join(root, '.uploads'), { recursive: true });
  fs.writeFileSync(path.join(root, 'w4877-clips', 'swallow.mp4'), 'clip');
  fs.writeFileSync(path.join(root, 'w4877-clips', 'notes.md'), 'notes');
  fs.writeFileSync(path.join(root, 'w4877-clips', '.preview.png'), 'hidden');
  fs.writeFileSync(path.join(root, '.uploads', 'half.mp4'), 'half');
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'no');
  return { dir, root, store: new AttachmentStore(path.join(dir, 'data')) };
}

const real = (p: string) => fs.realpathSync(p);

test('fetch_review: files by the path publish_review answered and relative to the root, with either separator, once each', async (t) => {
  const { root } = setup(t);
  const abs = path.join(root, 'w4877-clips', 'swallow.mp4');
  const got = await reviewFilesFor(root, { files: [abs, 'w4877-clips/swallow.mp4', ['w4877-clips', 'notes.md'].join(String.fromCharCode(92))] });
  assert.deepEqual(got, [real(abs), real(path.join(root, 'w4877-clips', 'notes.md'))]);
});

test('fetch_review: a topic lists its published files, not dot files; an unknown topic is refused', async (t) => {
  const { root } = setup(t);
  const got = await reviewFilesFor(root, { topic: 'w4877-clips' });
  assert.deepEqual(got.map((f) => path.basename(f)), ['notes.md', 'swallow.mp4']);
  await assert.rejects(reviewFilesFor(root, { topic: 'nope' }), /no review topic/);
  await assert.rejects(reviewFilesFor(root, {}), /give files/);
});

test('fetch_review: refuses a file outside the review folder, a climb out of it, and an upload in progress', async (t) => {
  const { dir, root } = setup(t);
  await assert.rejects(reviewFilesFor(root, { files: [path.join(dir, 'outside.txt')] }));
  await assert.rejects(reviewFilesFor(root, { files: ['../outside.txt'] }));
  await assert.rejects(reviewFilesFor(root, { files: ['.uploads/half.mp4'] }), /upload in progress/);
});

test('fetch_review: more than the cap in one call is refused', async (t) => {
  const { root } = setup(t);
  const many = Array.from({ length: FETCH_REVIEW_MAX_FILES + 1 }, () => 'w4877-clips/swallow.mp4');
  await assert.rejects(reviewFilesFor(root, { files: many }), /at most/);
});

test('fetch_review: each file becomes an attachment granted to that machine only, with the same bytes', async (t) => {
  const { root, store } = setup(t);
  const r = await reviewFilesForMachine(root, store, 'biscuit', { files: ['w4877-clips/swallow.mp4'] }, 'w4877');
  assert.equal(r.refs.length, 1);
  const id = r.refs[0].id;
  assert.equal(r.refs[0].name, 'swallow.mp4');
  assert.ok(store.granted('biscuit', id));
  assert.ok(!store.granted('beast', id));
  assert.match(r.text, /1 review file/);
});
