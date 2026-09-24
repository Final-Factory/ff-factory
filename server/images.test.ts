import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inRoots, listImages, readImage } from './images.ts';
import { Store } from './store.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-img-'));
  const put = (rel: string, ageS: number) => {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, PNG);
    const t = new Date(Date.now() - ageS * 1000);
    fs.utimesSync(f, t, t);
    return f;
  };
  return { root, put };
}

test('gallery: screenshot folders only, newest first', (t) => {
  const { root, put } = tree();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = put('Assets/Screenshots/a.png', 30);
  const b = put('specs/098-belts/proofs/run1/b.jpg', 10);
  const c = put('Logs/c.webp', 20);
  put('Assets/Art/texture.png', 1); // not a screenshot folder
  put('Assets/Screenshots/notes.txt', 1);
  assert.deepEqual(
    listImages(root).map((f) => f.path),
    [b, c, a],
  );
  assert.deepEqual(
    listImages(root, ['Assets/Art']).map((f) => path.basename(f.path)),
    ['texture.png'],
  );
});

test('image files: only images, only under the roots', (t) => {
  const { root, put } = tree();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = put('Logs/shot.png', 1);
  assert.equal(readImage(f, [root]).mediaType, 'image/png');
  assert.throws(() => readImage(path.join(root, 'Logs', '..', '..', 'x.png'), [root]), /outside/);
  assert.throws(() => readImage(f, [path.join(root, 'Assets')]), /outside/);
  fs.writeFileSync(path.join(root, 'secret.txt'), 'x');
  assert.throws(() => readImage(path.join(root, 'secret.txt'), [root]), /not an image/);
  assert.throws(() => readImage('Logs/shot.png', [root]), /absolute/);
  assert.ok(inRoots(path.join(root, 'a', 'b.png'), [root]));
  assert.ok(!inRoots(root + '-other/b.png', [root]), 'a sibling with the same prefix');
});

test('store: images kept per session, removed with the transcript', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  const id = store.saveImage('s1', 'image/png', PNG.toString('base64'));
  const f = store.imagePath('s1', id)!;
  assert.ok(f.endsWith('.png'));
  assert.deepEqual(fs.readFileSync(f), PNG);
  assert.equal(store.imagePath('s1', '../s2/x'), undefined);
  assert.throws(() => store.saveImage('s1', 'image/svg+xml', 'AAAA'), /unsupported/);
  store.deleteTranscript('s1');
  assert.equal(store.imagePath('s1', id), undefined);
  store.flush();
});
