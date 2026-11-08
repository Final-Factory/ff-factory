// Live dictation (w3712, docs/voice.md "Live text while you talk"): while the mic records, the page sends the newest few
// seconds to Whisper about once a second and shows the text in the box as it grows; the final pass on stop replaces it.
// The clip is cut into windows of at most LIVE.windowSeconds at a quiet moment, so each pass uploads a few seconds
// (the link to BEAST, not the GPU, set the cost: docs/voice.md), and a closed window's text stays put.
import { VOICE_RATE, isEmptyTranscript } from './voice.ts';

export const LIVE = {
  /** Past this length a window closes at a pause; its last pass is kept and the next window starts at the cut. */
  windowSeconds: 6,
  /** With no pause, a window closes anyway past this length, at its quietest 20 ms. */
  maxWindowSeconds: 12,
  /** A cut falls this far into the window at least. */
  minCutSeconds: 2.5,
  /** A pause: this long below LIVE.quiet of the window's loud frames. Cut inside a word, Whisper loses the words on both sides. */
  minPauseSeconds: 0.1,
  /** Quiet, as a share of the window's 90th-percentile frame level (the mic's gain varies, so not an absolute level). */
  quiet: 0.15,
  /** No pass for less new audio than this. */
  minTailSeconds: 0.6,
  /** Wait between the answer of one pass and the next request. The portal's CPU fallback waits as long as the pass took. */
  minGapMs: 300,
  /** Live passes stop after this many failures in a row; the final pass still runs on stop. */
  maxFailures: 3,
} as const;

/** The next pass: [from, to) seconds of the clip, and whether `to` closes the window there. */
export interface LivePass {
  from: number;
  to: number;
  closes: boolean;
}

/**
 * What to send next, given the clip's length so far and where the open window starts; undefined while there is too little
 * new audio. `pcm` is the open window's audio at 16 kHz (from `windowStart`), used to find a quiet cut.
 */
export function nextLivePass(total: number, windowStart: number, pcm: Float32Array): LivePass | undefined {
  const len = total - windowStart;
  if (len < LIVE.minTailSeconds) return undefined;
  const open = { from: windowStart, to: total, closes: false };
  if (len <= LIVE.windowSeconds) return open;
  // The pause must end before the newest audio: a word may be starting there.
  const pause = pauseCut(pcm, LIVE.minCutSeconds, len - LIVE.minTailSeconds / 2);
  if (pause !== undefined) return { from: windowStart, to: windowStart + pause, closes: true };
  if (len <= LIVE.maxWindowSeconds) return open;
  return { from: windowStart, to: windowStart + quietestCut(pcm, LIVE.minCutSeconds, LIVE.maxWindowSeconds), closes: true };
}

/** The recorder's chunks joined from sample `skip` on (w3712: live passes read the clip while it still records). */
export function chunksFrom(chunks: Float32Array[], skip: number): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  skip = Math.min(total, Math.max(0, skip));
  const out = new Float32Array(total - skip);
  let pos = 0;
  for (const c of chunks) {
    const start = Math.max(0, skip - pos);
    if (start < c.length) out.set(c.subarray(start), pos + start - skip);
    pos += c.length;
  }
  return out;
}

/** 20 ms frame levels (RMS) of 16 kHz audio. */
function frameLevels(pcm: Float32Array, rate: number): Float32Array {
  const frame = Math.round(rate * 0.02);
  const out = new Float32Array(Math.floor(pcm.length / frame));
  for (let f = 0; f < out.length; f++) {
    let e = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) e += pcm[i] * pcm[i];
    out[f] = Math.sqrt(e / frame);
  }
  return out;
}

/**
 * The middle (s) of the longest pause between `from` and `to` s, the later one on a tie; undefined when there is none:
 * no run of LIVE.minPauseSeconds below LIVE.quiet of the window's 90th-percentile level.
 */
export function pauseCut(pcm: Float32Array, from: number, to: number, rate = VOICE_RATE): number | undefined {
  const lv = frameLevels(pcm, rate);
  if (!lv.length) return undefined;
  const sorted = Float32Array.from(lv).sort();
  const loud = sorted[Math.floor((sorted.length - 1) * 0.9)];
  if (loud <= 0) return undefined;
  const limit = loud * LIVE.quiet;
  const first = Math.max(0, Math.ceil(from / 0.02));
  const last = Math.min(lv.length - 1, Math.floor(to / 0.02) - 1);
  const need = Math.round(LIVE.minPauseSeconds / 0.02);
  let best: [number, number] | undefined;
  let run = 0;
  for (let f = first; f <= last + 1; f++) {
    if (f <= last && lv[f] < limit) {
      run++;
      continue;
    }
    if (run >= need && (!best || run >= best[1] - best[0])) best = [f - run, f];
    run = 0;
  }
  return best ? ((best[0] + best[1]) / 2) * 0.02 : undefined;
}

/** Seconds into `pcm` (16 kHz) of the quietest 20 ms frame between `from` and `to` s: where a window cuts cleanly. */
export function quietestCut(pcm: Float32Array, from: number, to: number, rate = VOICE_RATE): number {
  const frame = Math.round(rate * 0.02);
  const first = Math.max(0, Math.floor((from * rate) / frame));
  const last = Math.min(Math.floor(pcm.length / frame) - 1, Math.floor((to * rate) / frame) - 1);
  if (last < first) return Math.min(to, pcm.length / rate);
  let best = first;
  let bestE = Infinity;
  for (let f = first; f <= last; f++) {
    let e = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) e += pcm[i] * pcm[i];
    // Ties go to the later frame: a longer window, fewer cuts.
    if (e <= bestE) {
      bestE = e;
      best = f;
    }
  }
  // Cut in the middle of the quiet frame.
  return (best * frame + frame / 2) / rate;
}

/** The text the box shows: the closed windows' texts, then the open one's, without Whisper's "[silence]" fillers. */
export function joinLive(parts: string[]): string {
  return parts
    .map((p) => p.trim())
    .filter((p) => p && !isEmptyTranscript(p))
    .join(' ');
}

/** The live passes' round trips (ms) as the final request reports them. */
export function liveStats(
  rtts: number[],
  firstTextMs: number | undefined,
): { passes: number; medianMs: number; maxMs: number; firstTextMs?: number } {
  const s = [...rtts].sort((a, b) => a - b);
  const median = s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
  return {
    passes: s.length,
    medianMs: Math.round(median),
    maxMs: Math.round(s.at(-1) ?? 0),
    ...(firstTextMs !== undefined ? { firstTextMs: Math.round(firstTextMs) } : {}),
  };
}
