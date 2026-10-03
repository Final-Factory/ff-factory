import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { REVIEW_DEFAULTS, ReviewError, ReviewStore, nthName, reviewHttp, reviewName, reviewTopic, type ReviewConfig } from './review.ts';
import { publishFromMachine } from '../machine/review.ts';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function setup(t: { after: (fn: () => void) => void }, cfg: Partial<ReviewConfig> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, '_review');
  const work = path.join(dir, 'machine-clone');
  fs.mkdirSync(work);
  const store = new ReviewStore(() => ({ ...REVIEW_DEFAULTS, ...cfg, root }));
  return { dir, root, work, store };
}

/** A stand-in portal: only the /machine/review route, with "tok-ld" proving lothdesktop and "tok-m3" proving m3. */
async function portal(t: { after: (fn: () => void) => void }, store: ReviewStore) {
  const tokens: Record<string, string> = { 'Bearer tok-ld': 'lothdesktop', 'Bearer tok-m3': 'm3' };
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = /^\/machine\/review\/(rv_[a-f0-9]{24})$/.exec(url.pathname);
    if (!m) return void res.writeHead(404).end();
    void reviewHttp(store, tokens[req.headers.authorization ?? ''], req, res, m[1], Number(url.searchParams.get('offset') ?? 0));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}

test('publish_review from a machine: chunked over HTTP, lands in its topic on the portal with matching hashes', async (t) => {
  const { root, work, store } = setup(t);
  const url = await portal(t, store);
  // A 9 MB clip crosses a chunk boundary (8 MB); a still and a note ride along.
  const clip = randomBytes(9 * 1024 * 1024 + 123);
  const still = randomBytes(40_000);
  fs.mkdirSync(path.join(work, 'Temp', 'w283'), { recursive: true });
  fs.writeFileSync(path.join(work, 'Temp', 'w283', 'attack.mp4'), clip);
  fs.writeFileSync(path.join(work, 'shot.PNG'), still);
  const text = await publishFromMachine(url, 'tok-ld', work, { topic: 'w283 enemy attacks', files: ['Temp/w283/attack.mp4', path.join(work, 'shot.PNG')], note: 'the signal cloud' }, async (a) =>
    JSON.stringify({ ...store.plan('lothdesktop', a as { topic: unknown; files: unknown }), host: 'BEAST' }),
  );
  const topic = path.join(root, 'w283-enemy-attacks');
  assert.equal(sha(fs.readFileSync(path.join(topic, 'attack.mp4'))), sha(clip));
  assert.equal(sha(fs.readFileSync(path.join(topic, 'shot.png'))), sha(still));
  assert.match(text, /^Published 2 file\(s\) on BEAST:/);
  assert.ok(text.includes(path.join(topic, 'attack.mp4')), text);
  assert.ok(text.includes(`![what it shows](${path.join(topic, 'shot.png')})`), text);
  // Nothing is left behind in the upload folder.
  assert.deepEqual(fs.readdirSync(path.join(root, '.uploads')), []);
});

test('publish_review: a name already in the topic gets "-2"; nothing is overwritten, other topics untouched', async (t) => {
  const { root, work, store } = setup(t);
  const url = await portal(t, store);
  fs.mkdirSync(path.join(root, 'other'), { recursive: true });
  fs.writeFileSync(path.join(root, 'other', 'shot.png'), 'someone else');
  const publish = async (bytes: Buffer) => {
    fs.writeFileSync(path.join(work, 'shot.png'), bytes);
    return publishFromMachine(url, 'tok-ld', work, { topic: 'w309', files: ['shot.png'] }, async (a) => JSON.stringify({ ...store.plan('lothdesktop', a as { topic: unknown; files: unknown }), host: 'BEAST' }));
  };
  const first = randomBytes(1000);
  const second = randomBytes(1000);
  await publish(first);
  const text = await publish(second);
  assert.ok(text.includes(path.join(root, 'w309', 'shot-2.png')), text);
  assert.equal(sha(fs.readFileSync(path.join(root, 'w309', 'shot.png'))), sha(first));
  assert.equal(sha(fs.readFileSync(path.join(root, 'w309', 'shot-2.png'))), sha(second));
  assert.equal(fs.readFileSync(path.join(root, 'other', 'shot.png'), 'utf8'), 'someone else');
  // The same on this host (a copy), and for notes.
  const local = await store.publishLocal({ topic: 'w309', files: [path.join(work, 'shot.png')] });
  assert.equal(local.files[0].path, path.join(root, 'w309', 'shot-3.png'));
  assert.equal(path.basename(store.writeNote('w309', 'x', 'a', [])), 'note.md');
  assert.equal(path.basename(store.writeNote('w309', 'x', 'b', [])), 'note-2.md');
  assert.equal(nthName('clip.tar.zip', 3), 'clip.tar-3.zip');
});

test('publish_review: path traversal in topics and names stays inside the review folder or is refused', async (t) => {
  const { dir, root, work, store } = setup(t);
  for (const bad of ['', '..', '../..', '/', '\\\\', '.', 'CON', 'nul.txt']) assert.throws(() => reviewTopic(bad), ReviewError, JSON.stringify(bad));
  assert.equal(reviewTopic('../../Windows/System32'), 'Windows-System32');
  assert.equal(reviewTopic('C:\\Users\\x'), 'C-Users-x');
  assert.equal(reviewName('..\\..\\evil.png'), 'evil.png');
  assert.equal(reviewName('/etc/../../x.PNG'), 'x.png');
  assert.equal(reviewName('con.png'), '_con.png');
  assert.equal(reviewName('..png'), 'file.png');
  for (const bad of ['run.exe', 'x.png.bat', 'noext', 'save.unity', 'a.ps1']) assert.throws(() => reviewName(bad), /only images, video/, bad);
  // A plan with a climbing topic and name writes under root/<topic>/ only.
  fs.writeFileSync(path.join(work, 'a.png'), 'png');
  const r = await store.publishLocal({ topic: '../../escape', files: [path.join(work, 'a.png')] });
  assert.equal(r.files[0].path, path.join(root, 'escape', 'a.png'));
  assert.ok(!fs.existsSync(path.join(dir, 'escape')));
  // Upload ids are checked before any path is made of them, and only their machine may use one.
  const url = await portal(t, store);
  const plan = store.plan('lothdesktop', { topic: 'w309', files: [{ name: 'a.png', size: 3, sha256: sha(Buffer.from('png')) }] });
  const id = plan.uploads[0].uploadId;
  assert.equal((await fetch(`${url}/machine/review/${id}`, { headers: { authorization: 'Bearer tok-m3' } })).status, 404, "another machine's upload");
  assert.equal((await fetch(`${url}/machine/review/${id}`)).status, 401, 'no token');
  assert.equal((await fetch(`${url}/machine/review/rv_..%2F..%2Fx`)).status, 404, 'not an upload id');
  assert.throws(() => store.status('lothdesktop', '../../x'), /no such upload/);
});

test('publish_review: the per-file, per-call and file-count caps hold; a chunk past the announced size or a bad hash is refused', async (t) => {
  const { root, work, store } = setup(t, { maxFileMB: 1, maxCallMB: 1.5, maxFiles: 3 });
  const MB = 1024 * 1024;
  const f = (name: string, size: number) => ({ name, size, sha256: 'a'.repeat(64) });
  assert.throws(() => store.plan('ld', { topic: 'x', files: [f('big.mp4', MB + 1)] }), (e: ReviewError) => e.status === 413 && /limit per file is 1\.0 MB/.test(e.message));
  assert.throws(() => store.plan('ld', { topic: 'x', files: [f('a.mp4', MB), f('b.mp4', MB)] }), (e: ReviewError) => e.status === 413 && /review\.maxCallMB/.test(e.message));
  assert.throws(() => store.plan('ld', { topic: 'x', files: [f('a.png', 1), f('b.png', 1), f('c.png', 1), f('d.png', 1)] }), (e: ReviewError) => e.status === 413 && /limit is 3/.test(e.message));
  assert.throws(() => store.plan('ld', { topic: 'x', files: [f('a.png', 0)] }), (e: ReviewError) => e.status === 400);
  assert.throws(() => store.plan('ld', { topic: 'x', files: [{ name: 'a.png', size: 1, sha256: 'nope' }] }), /sha256/);
  fs.writeFileSync(path.join(work, 'big.mp4'), Buffer.alloc(MB + 1));
  await assert.rejects(store.publishLocal({ topic: 'x', files: [path.join(work, 'big.mp4')] }), /limit per file/);
  // The daemon is refused before anything is sent.
  await assert.rejects(publishFromMachine('http://127.0.0.1:9', 't', work, { topic: 'x', files: ['big.mp4'] }, async (a) => JSON.stringify(store.plan('ld', a as { topic: unknown; files: unknown }))), /limit per file/);
  // A chunk that would go past the announced size is cut back; a wrong offset says where to resume.
  const body = Buffer.from('12345');
  const [u] = store.plan('ld', { topic: 'x', files: [{ name: 'a.txt', size: 5, sha256: sha(body) }] }).uploads;
  await assert.rejects(store.append('ld', u.uploadId, 0, [Buffer.from('1234567')]), (e: ReviewError) => e.status === 413 && e.received === 0);
  assert.equal(store.status('ld', u.uploadId).received, 0);
  await store.append('ld', u.uploadId, 0, [Buffer.from('123')]);
  await assert.rejects(store.append('ld', u.uploadId, 0, [Buffer.from('45')]), (e: ReviewError) => e.status === 409 && e.received === 3);
  assert.equal((await store.append('ld', u.uploadId, 3, [Buffer.from('45')])).path, path.join(root, 'x', 'a.txt'));
  // Damaged on the way: refused, nothing placed.
  const [v] = store.plan('ld', { topic: 'x', files: [{ name: 'b.txt', size: 5, sha256: sha(body) }] }).uploads;
  await assert.rejects(store.append('ld', v.uploadId, 0, [Buffer.from('54321')]), (e: ReviewError) => e.status === 422);
  assert.ok(!fs.existsSync(path.join(root, 'x', 'b.txt')));
});
