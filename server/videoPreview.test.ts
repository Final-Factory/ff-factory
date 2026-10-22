import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { previewArgs, previewPathOf, VideoPreviews } from './videoPreview.ts';

function topic(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-preview-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'w1-clips');
  fs.mkdirSync(dir);
  return { root, dir };
}

/**
 * A stand-in ffmpeg: copies its input (the argument after -i) to its output (the last argument), counting its runs in
 * `<dir>/runs`; exits 1 on an input named "bad*". A node script run by this node, so it runs on every platform: a `.cmd`
 * shim never ran on Windows, where node spawns none without a shell (spawn EINVAL; w1758).
 */
function fakeFfmpeg(dir: string): string[] {
  const js = path.join(dir, 'fake-ffmpeg.mjs');
  fs.writeFileSync(
    js,
    `import fs from 'node:fs';
const a = process.argv.slice(2);
const input = a[a.indexOf('-i') + 1];
fs.appendFileSync(${JSON.stringify(path.join(dir, 'runs'))}, input + '\\n');
if (/[\\\\/]bad[^\\\\/]*$/.test(input)) { console.error('Invalid data found when processing input'); process.exit(1); }
await new Promise((r) => setTimeout(r, 50));
fs.copyFileSync(input, a[a.length - 1]);
`,
  );
  return [process.execPath, js];
}

const runs = (dir: string) => (fs.existsSync(path.join(dir, 'runs')) ? fs.readFileSync(path.join(dir, 'runs'), 'utf8').trim().split('\n') : []);

test('preview args: H.264 at most 1920 px on the long side, never upscaled, faststart, CRF 28 (w1248)', () => {
  const a = previewArgs('/r/t/clip.mp4', '/r/t/.preview/clip.mp4.mp4.part');
  const after = (flag: string) => a[a.indexOf(flag) + 1];
  assert.equal(after('-i'), '/r/t/clip.mp4');
  assert.equal(a.at(-1), '/r/t/.preview/clip.mp4.mp4.part');
  assert.equal(after('-c:v'), 'libx264');
  assert.equal(after('-crf'), '28');
  assert.equal(after('-movflags'), '+faststart');
  assert.equal(after('-pix_fmt'), 'yuv420p');
  assert.match(after('-vf'), /min\(1920,iw\).*min\(1920,ih\).*force_original_aspect_ratio=decrease/);
  assert.equal(after('-f'), 'mp4', 'the .part name says nothing of the format');
  assert.ok(a.includes('-nostdin'));
});

test('preview path: beside the original in .preview, one per original whatever its extension', () => {
  assert.equal(previewPathOf(path.join('/r', 't', 'clip.mp4')), path.join('/r', 't', '.preview', 'clip.mp4.mp4'));
  assert.notEqual(previewPathOf('/r/t/clip.webm'), previewPathOf('/r/t/clip.mp4'));
});

test('ensure: made once, beside the original, which is left untouched; ready after', async (t) => {
  const { dir } = topic(t);
  const original = path.join(dir, 'clip.mp4');
  fs.writeFileSync(original, 'original bytes');
  const before = fs.statSync(original);
  const p = new VideoPreviews({ ffmpeg: fakeFfmpeg(dir) });
  assert.equal(p.ready(original), undefined);
  const [a, b] = await Promise.all([p.ensure(original), p.ensure(original)]);
  assert.equal(a, previewPathOf(original));
  assert.equal(b, a, 'two requests at once share one encode');
  assert.equal(fs.readFileSync(a!, 'utf8'), 'original bytes');
  assert.equal(p.ready(original), a);
  assert.equal(await p.ensure(original), a);
  assert.equal(runs(dir).length, 1);
  assert.equal(fs.readFileSync(original, 'utf8'), 'original bytes');
  assert.equal(fs.statSync(original).mtimeMs, before.mtimeMs);
  assert.deepEqual(fs.readdirSync(path.dirname(a!)), ['clip.mp4.mp4'], 'no .part left');
});

test('ensure: one encode at a time, in order', async (t) => {
  const { dir } = topic(t);
  const files = ['a.mp4', 'b.mp4', 'c.mp4'].map((n) => {
    fs.writeFileSync(path.join(dir, n), n);
    return path.join(dir, n);
  });
  const p = new VideoPreviews({ ffmpeg: fakeFfmpeg(dir) });
  const out = await Promise.all(files.map((f) => p.ensure(f)));
  assert.deepEqual(out, files.map(previewPathOf));
  assert.deepEqual(runs(dir), files);
});

test('a preview older than its original is made again', async (t) => {
  const { dir } = topic(t);
  const original = path.join(dir, 'clip.mp4');
  fs.writeFileSync(original, 'v1');
  const p = new VideoPreviews({ ffmpeg: fakeFfmpeg(dir) });
  const made = (await p.ensure(original))!;
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(made, old, old);
  assert.equal(p.ready(original), undefined);
  await p.ensure(original);
  assert.equal(runs(dir).length, 2);
});

test('no ffmpeg: undefined, and it is not looked for again', async (t) => {
  const { dir } = topic(t);
  const original = path.join(dir, 'clip.mp4');
  fs.writeFileSync(original, 'x');
  const p = new VideoPreviews({ ffmpeg: path.join(dir, 'no-such-ffmpeg') });
  assert.equal(await p.ensure(original), undefined);
  assert.equal(await p.ensure(original), undefined);
  assert.equal(fs.readdirSync(path.join(dir, '.preview')).length, 0);
});

test('a failed encode: undefined, no file left, not retried; other clips still made', async (t) => {
  const { dir } = topic(t);
  const bad = path.join(dir, 'bad.mp4');
  const good = path.join(dir, 'good.mp4');
  fs.writeFileSync(bad, 'not a video');
  fs.writeFileSync(good, 'video');
  const p = new VideoPreviews({ ffmpeg: fakeFfmpeg(dir) });
  assert.equal(await p.ensure(bad), undefined);
  assert.equal(await p.ensure(bad), undefined);
  assert.equal(await p.ensure(good), previewPathOf(good));
  assert.deepEqual(runs(dir), [bad, good]);
  assert.deepEqual(fs.readdirSync(path.join(dir, '.preview')), ['good.mp4.mp4']);
});

test('previews follow their originals: one whose original is gone is removed with the next encode in its topic', async (t) => {
  const { dir } = topic(t);
  const a = path.join(dir, 'a.mp4');
  const b = path.join(dir, 'b.mp4');
  fs.writeFileSync(a, 'a');
  fs.writeFileSync(b, 'b');
  const p = new VideoPreviews({ ffmpeg: fakeFfmpeg(dir) });
  await p.ensure(a);
  fs.writeFileSync(path.join(dir, '.preview', 'old.mp4.99999.part'), 'left by an ended portal');
  fs.rmSync(a);
  await p.ensure(b);
  assert.deepEqual(fs.readdirSync(path.join(dir, '.preview')), ['b.mp4.mp4']);
});

// The real encoder, where there is one (FF_FFMPEG or ffmpeg on PATH): a 2560x1440 clip with its index at the end
// becomes a 1920x1080 H.264 preview with its index first.
const realFfmpeg = (() => {
  for (const c of [process.env.FF_FFMPEG, 'ffmpeg']) {
    if (!c) continue;
    try {
      execFileSync(c, ['-hide_banner', '-version'], { stdio: 'ignore' });
      return c;
    } catch {
      // not this one
    }
  }
  return undefined;
})();

/** The top-level boxes of an mp4, in file order. */
function boxes(file: string): string[] {
  const b = fs.readFileSync(file);
  const out: string[] = [];
  for (let at = 0; at + 8 <= b.length; ) {
    let size = b.readUInt32BE(at);
    out.push(b.toString('latin1', at + 4, at + 8));
    if (size === 1) size = Number(b.readBigUInt64BE(at + 8));
    if (size < 8) break;
    at += size;
  }
  return out;
}

test('real ffmpeg: a 1440p clip without faststart becomes a 1080p preview whose index comes first', { skip: !realFfmpeg && 'no ffmpeg here' }, async (t) => {
  const { dir } = topic(t);
  const original = path.join(dir, 'clip.mp4');
  execFileSync(realFfmpeg!, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=2560x1440:rate=30:duration=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', original]);
  assert.ok(boxes(original).indexOf('moov') > boxes(original).indexOf('mdat'), 'the fixture has its index at the end');
  const p = new VideoPreviews({ ffmpeg: realFfmpeg });
  const made = await p.ensure(original);
  assert.equal(made, previewPathOf(original));
  const order = boxes(made!);
  assert.ok(order.indexOf('moov') < order.indexOf('mdat'), `index first: ${order.join(' ')}`);
  const info = (() => {
    try {
      return execFileSync(realFfmpeg!, ['-hide_banner', '-i', made!], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return String((e as { stderr?: string }).stderr); // ffmpeg -i with no output exits 1 and prints the streams
    }
  })();
  assert.match(info, /Video: h264/);
  assert.match(info, /1920x1080/);
});
