import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIVE, chunksFrom, joinLive, liveStats, nextLivePass, pauseCut, quietestCut } from '../shared/liveTranscript.ts';

const RATE = 16000;
/** `seconds` of a loud tone with silence over [qFrom, qTo). */
function clip(seconds: number, qFrom = -1, qTo = -1): Float32Array {
  const pcm = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < pcm.length; i++) {
    const t = i / RATE;
    pcm[i] = t >= qFrom && t < qTo ? 0 : 0.3 * Math.sin(2 * Math.PI * 220 * t);
  }
  return pcm;
}

test('nextLivePass: waits for enough new audio, then sends the open window whole', () => {
  assert.equal(nextLivePass(0.4, 0, clip(0.4)), undefined);
  assert.deepEqual(nextLivePass(2.5, 0, clip(2.5)), {
    from: 0,
    to: 2.5,
    closes: false,
  });
  assert.deepEqual(nextLivePass(9, 6.2, clip(2.8)), {
    from: 6.2,
    to: 9,
    closes: false,
  });
});

test('nextLivePass: a window past its length closes at a pause', () => {
  // A pause at 4.6-4.8 s of a 6.5 s window.
  const p = nextLivePass(6.5, 0, clip(6.5, 4.6, 4.8))!;
  assert.equal(p.closes, true);
  assert.ok(p.to > 4.6 && p.to < 4.8, `cut at ${p.to}`);
  // The same pause in a window that starts at 10 s.
  const q = nextLivePass(16.5, 10, clip(6.5, 4.6, 4.8))!;
  assert.ok(q.from === 10 && q.to > 14.6 && q.to < 14.8, `cut at ${q.to}`);
});

test('quietestCut: never outside its range, and a later tie wins (fewer cuts)', () => {
  const silent = new Float32Array(7 * RATE);
  const c = quietestCut(silent, LIVE.minCutSeconds, LIVE.windowSeconds);
  assert.ok(c > LIVE.windowSeconds - 0.03 && c <= LIVE.windowSeconds, `cut at ${c}`);
  const loud = clip(7);
  const d = quietestCut(loud, LIVE.minCutSeconds, LIVE.windowSeconds);
  assert.ok(d >= LIVE.minCutSeconds && d <= LIVE.windowSeconds, `cut at ${d}`);
  // Shorter than the range: the clip's end.
  assert.equal(quietestCut(clip(1), 3.5, 6), 1);
});

test('joinLive: windows in order, fillers and blanks left out', () => {
  assert.equal(joinLive([' the build is ', '[silence]', '', 'green now.']), 'the build is green now.');
  assert.equal(joinLive([]), '');
});

test('liveStats: median, slowest and the first words', () => {
  assert.deepEqual(liveStats([900, 400, 1200.4], 1530.6), {
    passes: 3,
    medianMs: 900,
    maxMs: 1200,
    firstTextMs: 1531,
  });
  assert.deepEqual(liveStats([], undefined), {
    passes: 0,
    medianMs: 0,
    maxMs: 0,
  });
});

test('nextLivePass: a gap shorter than a pause (a consonant) is no cut; without a pause the window grows to its maximum', () => {
  // 60 ms of silence at 4.0 s: inside a word. No cut until 12 s, then the quietest moment.
  const gap = (s: number) => clip(s, 4.0, 4.06);
  assert.deepEqual(nextLivePass(9, 0, gap(9)), { from: 0, to: 9, closes: false });
  assert.deepEqual(nextLivePass(12, 0, gap(12)), { from: 0, to: 12, closes: false });
  const p = nextLivePass(12.5, 0, gap(12.5))!;
  assert.equal(p.closes, true);
  assert.ok(p.to >= 4.0 && p.to <= 4.06, `cut at ${p.to}`);
});

test('pauseCut: the longest pause after the minimum cut, never one in the newest audio', () => {
  // Pauses: 1.0-1.5 s (too early), 3.0-3.2 s, 4.5-4.9 s (longest), 6.6-7.0 s (in the newest 0.3 s of a 7 s window).
  const pcm = clip(7);
  for (const [a, b] of [[1.0, 1.5], [3.0, 3.2], [4.5, 4.9], [6.6, 7.0]]) pcm.fill(0, Math.round(a * RATE), Math.round(b * RATE));
  const cut = pauseCut(pcm, LIVE.minCutSeconds, 7 - LIVE.minTailSeconds / 2)!;
  assert.ok(Math.abs(cut - 4.7) < 0.03, `cut at ${cut}`);
  assert.equal(nextLivePass(7, 0, pcm)!.to, cut);
  // Quiet is relative to the window's loud frames: the same speech at a tenth of the level cuts at the same place.
  const soft = pcm.map((x) => x / 10);
  assert.equal(pauseCut(soft, LIVE.minCutSeconds, 6.7), cut);
  // All silence: no loud frames, so no pause either.
  assert.equal(pauseCut(new Float32Array(5 * RATE), 0, 5), undefined);
});

test('chunksFrom: every sample from the skip on, across chunks (a live pass once sent zeros for the newest 2 s)', () => {
  const chunks = [0, 1, 2, 3].map((k) => Float32Array.from({ length: 4 }, (_, i) => k * 4 + i + 1));
  const all = Array.from({ length: 16 }, (_, i) => i + 1);
  for (const skip of [0, 1, 4, 6, 15, 16, 20, -3]) assert.deepEqual(Array.from(chunksFrom(chunks, skip)), all.slice(Math.max(0, skip)), `skip ${skip}`);
  assert.equal(chunksFrom([], 0).length, 0);
});
