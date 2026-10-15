import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { absoluteTargets, inlineReviewMedia, mediaFor, mediaNamed, onDisk } from './reviewMedia.ts';
import { needsYouRecord, needsYouText } from './needsYou.ts';

/**
 * w1384: review media is shown inline, never as a bare path. Ben, 2026-10-15, after a [needs you] for w1182 that gave only
 * `/srv/fff/review/w1182-fog-look-v4/`: "I need to see the preview video for the fog. Stop giving me paths to videos and
 * inline the videos like you should be doing and I've reminded you as such like 100 times". A review root on disk shaped
 * like the portal's: the fog folder (w1182), the super-enemy folder whose report cut a name off (w1241), and a bare name.
 */
function root(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffa-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const put = (rel: string, minutesAgo: number) => {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'x');
    const at = new Date(Date.now() - minutesAgo * 60_000);
    fs.utimesSync(f, at, at);
    return f;
  };
  const fog = {
    v3: put('w1182-fog-look-v4/fog-v3-1920.mp4', 90),
    v4: put('w1182-fog-look-v4/fog-v4-1920.mp4', 10),
    v4small: put('w1182-fog-look-v4/fog-v4-1280x800.mp4', 11),
    sheet: put('w1182-fog-look-v4/sheet.png', 20),
    preview: put('w1182-fog-look-v4/.preview/fog-v4-1920.mp4', 5),
    note: put('w1182-fog-look-v4/note.md', 1),
  };
  const glow = {
    closeup: put('w1241-super-enemies/glow_800_closeup.jpg', 30),
    clip: put('w1241-super-enemies/glow_super-enemies_1920x1080.mp4', 40),
  };
  const other = put('w1300-other/clip.mp4', 60);
  return { dir, fog, glow, other };
}

test('a folder is its stills and clips, newest first, without .preview/ or notes; a missing file is its folder’s files', (t) => {
  const r = root(t);
  const o = { root: r.dir };
  // Written the portal's way (/srv/fff/review/…) or as this computer's path, either slash.
  assert.deepEqual(mediaFor('/srv/fff/review/w1182-fog-look-v4/', o), [r.fog.v4, r.fog.v4small, r.fog.sheet, r.fog.v3]);
  assert.deepEqual(mediaFor(path.join(r.dir, 'w1182-fog-look-v4'), o), [r.fog.v4, r.fog.v4small, r.fog.sheet, r.fog.v3]);
  assert.deepEqual(mediaFor('/srv/fff/review/w1182-fog-look-v4/fog-v4-*.mp4', o), [r.fog.v4, r.fog.v4small]);
  assert.deepEqual(mediaFor('/srv/fff/review/w1182-fog-look-v4/sheet.png', o), [r.fog.sheet]);
  // w1241: the kept report cut "glow_800_closeup.jpg" to ".jp": the folder's files stand in for it.
  assert.deepEqual(mediaFor('/srv/fff/review/w1241-super-enemies/glow_800_closeup.jp', o), [r.glow.closeup, r.glow.clip]);
  // Never outside the root.
  assert.equal(onDisk('/srv/fff/review/../../etc/passwd', r.dir), undefined);
  assert.deepEqual(mediaFor('/srv/fff/review/no-such-topic/', o), []);
});

test('the media a text names: folders expanded, bare names found in the request’s topic, each once', (t) => {
  const r = root(t);
  const m = mediaNamed(
    ['Ben: does fog preview v4 at /srv/fff/review/w1182-fog-look-v4/ look right?', 'See glow_800_closeup.jpg and the clip /srv/fff/review/w1182-fog-look-v4/fog-v4-1920.mp4'],
    { root: r.dir, ids: ['w1241'] },
  );
  assert.deepEqual(m.files, [r.fog.v4, r.fog.v4small, r.fog.sheet, r.fog.v3, r.glow.closeup]);
  assert.deepEqual(m.folders, []);
  // A relative image target becomes absolute.
  const fixed = absoluteTargets('Close-up: ![glow](<glow_800_closeup.jpg>) and ![x](<missing.png>)', { root: r.dir, ids: ['w1241'] });
  assert.equal(fixed.text, `Close-up: ![glow](<${r.glow.closeup}>) and ![x](<missing.png>)`);
  assert.equal(fixed.fixed, 1);
});

test('the [needs you] message for a request whose review is a folder shows each clip inline, with absolute paths (w1182)', (t) => {
  const r = root(t);
  const w = { id: 'w1182', title: 'Fog of war: explored areas stay explored', prs: [] };
  const question = 'Ben: does fog preview v4 at /srv/fff/review/w1182-fog-look-v4/ (crisp map edge, grey fog) look right?';
  const rec = needsYouRecord(w, { kind: 'question', key: 'q', question, names: ['Ben'] }, [{ userId: 'ben', displayName: 'Ben' }], '2026-10-15T15:59:00Z', { reviewRoot: r.dir });
  assert.deepEqual(rec.previews, [r.fog.v4, r.fog.v4small, r.fog.sheet, r.fog.v3]);
  const text = needsYouText(w, rec, 'Ben');
  for (const f of [r.fog.v4, r.fog.v4small, r.fog.sheet, r.fog.v3]) assert.ok(text.includes(`- ![${path.basename(f)}](<${f}>)`), `inline: ${f}`);
  assert.ok(!text.includes('.preview'), 'no preview encodes');
  assert.doesNotMatch(text, /- `[^`]*w1182-fog-look-v4\/?`/, 'the folder is not listed as a bare path');

  // w1241: the report the digest keeps is cut in the middle; the cut name is not listed, the folder's files are.
  const w2 = { id: 'w1241', title: 'Super enemies', prs: [] };
  const clipped = 'Stills: /srv/fff/review/w1241-super-enemies/glow_800_closeup.jp\n… (2104 chars left out) …\nw1241: still open: waiting on Ben to watch the glow video';
  const rec2 = needsYouRecord(w2, { kind: 'report', key: 'r', question: 'w1241: still open: waiting on Ben to watch the glow video', names: ['Ben'], worker: 'c651da27', report: clipped }, [{ userId: 'ben', displayName: 'Ben' }], 't', { reviewRoot: r.dir });
  assert.deepEqual(rec2.previews, [r.glow.closeup, r.glow.clip]);
  assert.ok(!rec2.previews.some((p) => p.endsWith('.jp')));
});

test('the outgoing check: a reply that names a review folder, file or name bare gets them inline after its paragraph', (t) => {
  const r = root(t);
  const o = { root: r.dir, ids: ['w1182'] };
  // The w1182 relay as Ben got it.
  const reply = '**w1182** (fog of war) waits on you: does fog preview v4 at `/srv/fff/review/w1182-fog-look-v4/` look right?\n\nAnd which game-view camera do you want?';
  const out = inlineReviewMedia(reply, o);
  assert.equal(out.added, 4);
  assert.equal(
    out.text,
    `**w1182** (fog of war) waits on you: does fog preview v4 at \`/srv/fff/review/w1182-fog-look-v4/\` look right?\n\n` +
      [r.fog.v4, r.fog.v4small, r.fog.sheet, r.fog.v3].map((f) => `![${path.basename(f)}](<${f}>)`).join('\n\n') +
      '\n\nAnd which game-view camera do you want?',
  );
  // Already inline: nothing added, and running it again adds nothing (the stored reply goes through once, but never twice over).
  assert.deepEqual(inlineReviewMedia(out.text, o), { text: out.text, added: 0 });
  const shown = `Here: ![v4](<${r.fog.v4}>)`;
  assert.deepEqual(inlineReviewMedia(shown, o), { text: shown, added: 0 });
  // A bare file, a bare name, a relative target, a path in a code block.
  assert.match(inlineReviewMedia('The clip: /srv/fff/review/w1300-other/clip.mp4.', o).text, new RegExp(`\\n\\n!\\[clip\\.mp4\\]\\(<${r.other.replace(/[\\\\.]/g, '\\$&')}>\\)$`));
  assert.ok(inlineReviewMedia('Look at glow_800_closeup.jpg please', { root: r.dir, ids: ['w1241'] }).text.endsWith(`![glow_800_closeup.jpg](<${r.glow.closeup}>)`));
  assert.equal(inlineReviewMedia('![c](<glow_800_closeup.jpg>)', { root: r.dir, ids: ['w1241'] }).text, `![c](<${r.glow.closeup}>)`);
  const fenced = inlineReviewMedia('Run:\n```\nls /srv/fff/review/w1300-other/clip.mp4\n```\nthen tell me.', o).text;
  assert.ok(fenced.includes('```\n\n![clip.mp4]'), fenced);
  // Media elsewhere (a machine's file) is shown as written; a web link and a plain reply are left alone.
  assert.ok(inlineReviewMedia('Still: C:\\work\\shot.png', o).text.endsWith('![shot.png](<C:\\work\\shot.png>)'));
  assert.deepEqual(inlineReviewMedia('See https://example.com/a.png for the logo.', o), { text: 'See https://example.com/a.png for the logo.', added: 0 });
  assert.deepEqual(inlineReviewMedia('Merged PR #1799; nothing to look at.', o), { text: 'Merged PR #1799; nothing to look at.', added: 0 });
});
