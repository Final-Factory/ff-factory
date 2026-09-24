import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EndpointDetector, UtteranceCapture, VAD_DEFAULTS } from '../shared/vad.ts';

const R = 16000;
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;

/** Speech-like: a 180 Hz voice with harmonics, syllables at ~4 Hz, short gaps between words. */
function voice(seconds: number, amp = 0.2): Float32Array {
  const n = Math.round(seconds * R);
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / R;
    const syll = Math.max(0, Math.sin(2 * Math.PI * 4 * t)) ** 0.6;
    const word = t % 0.9 < 0.75 ? 1 : 0.05;
    o[i] = amp * syll * word * (Math.sin(2 * Math.PI * 180 * t) + 0.6 * Math.sin(2 * Math.PI * 360 * t) + 0.4 * Math.sin(2 * Math.PI * 900 * t));
  }
  return o;
}

/** Car-like background: low rumble, engine hum, hiss. */
function road(seconds: number, amp: number): Float32Array {
  const n = Math.round(seconds * R);
  const o = new Float32Array(n);
  let br = 0;
  for (let i = 0; i < n; i++) {
    const w = rnd();
    br = 0.995 * br + 0.05 * w;
    o[i] = amp * (1.5 * br + 0.3 * Math.sin((2 * Math.PI * 32 * i) / R) + 0.25 * w);
  }
  return o;
}

const concat = (...xs: Float32Array[]) => {
  const out = new Float32Array(xs.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of xs) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};
const mix = (a: Float32Array, b: Float32Array) => a.map((v, i) => v + (b[i] ?? 0));
/** A quiet room: not digital silence (which the detector ignores for its floor). */
const quiet = (seconds: number) => road(seconds, 0.0005);

function run(signal: Float32Array, opts = {}) {
  const v = new EndpointDetector(R, opts);
  const events: [string, number][] = [];
  for (let i = 0; i < signal.length; i += 1365) for (const e of v.push(signal.subarray(i, i + 1365))) events.push([e, v.frames * 0.02]);
  return events;
}

test('vad: speech after quiet starts on time and ends silenceMs after the last word', () => {
  const sig = concat(quiet(1), voice(3), quiet(4));
  const ev = run(sig);
  assert.equal(ev.length, 2, JSON.stringify(ev));
  assert.equal(ev[0][0], 'speech');
  assert.ok(ev[0][1] > 1 && ev[0][1] < 1.35, `start ${ev[0][1]}`);
  assert.equal(ev[1][0], 'end');
  // The last syllable of voice(3) fades out a little before 4 s.
  const due = 1 + 3 + VAD_DEFAULTS.silenceMs / 1000;
  assert.ok(ev[1][1] > due - 0.35 && ev[1][1] < due + 0.1, `end ${ev[1][1]}`);
});

test('vad: gaps between words shorter than silenceMs do not end the utterance', () => {
  const sig = concat(quiet(1), voice(2), quiet(1.2), voice(2), quiet(3));
  assert.deepEqual(
    run(sig).map((e) => e[0]),
    ['speech', 'end'],
  );
});

test('vad: works in steady road noise, loud or quiet, with the same settings', () => {
  for (const noise of [0.002, 0.02, 0.06]) {
    const n = road(9, noise);
    const sig = mix(n, concat(new Float32Array(2 * R), voice(3, 0.25), new Float32Array(4 * R)));
    const ev = run(sig);
    assert.deepEqual(
      ev.map((e) => e[0]),
      ['speech', 'end'],
      `noise ${noise}: ${JSON.stringify(ev)}`,
    );
    assert.ok(ev[0][1] > 2 && ev[0][1] < 2.5, `noise ${noise} start ${ev[0][1]}`);
  }
});

test('vad: noise alone never counts as speech, and no speech gives up at noSpeechMs', () => {
  for (const amp of [0, 0.01, 0.2]) {
    const ev = run(road(12, amp));
    assert.equal(ev.length, 1, `amp ${amp}: ${JSON.stringify(ev)}`);
    assert.equal(ev[0][0], 'nospeech');
    assert.ok(Math.abs(ev[0][1] - 10) < 0.1, `amp ${amp}: ${ev[0][1]}`);
  }
  assert.deepEqual(run(road(12, 0.05), { noSpeechMs: 0 }), []);
});

test('vad: a click or a cough is not an utterance', () => {
  const click = new Float32Array(0.06 * R).map(() => 0.8 * rnd());
  const cough = voice(0.2, 0.4);
  const ev = run(concat(road(2, 0.01), click, road(3, 0.01), cough, road(4, 0.01)), { noSpeechMs: 0 });
  assert.ok(!ev.some((e) => e[0] === 'end'), JSON.stringify(ev));
});

test('vad: the barge-in boost needs louder speech to start', () => {
  const sig = mix(road(6, 0.03), concat(new Float32Array(2 * R), voice(2, 0.1)));
  assert.equal(run(sig, { noSpeechMs: 0 })[0]?.[0], 'speech');
  const v = new EndpointDetector(R, { noSpeechMs: 0 });
  v.boostDb = 20;
  assert.deepEqual(v.push(sig), []);
});

test('UtteranceCapture: hands over the utterance with a little pre-roll, bounded while idle', () => {
  const cap = new UtteranceCapture(R, { noSpeechMs: 0 }, 300);
  const sig = concat(quiet(20), voice(2), quiet(3));
  let got: Float32Array | undefined;
  for (let i = 0; i < sig.length; i += 1365) {
    if (cap.push(sig.subarray(i, i + 1365)).includes('end')) got = cap.take();
  }
  assert.ok(got);
  // 2 s of voice + 300 ms pre-roll + the silence until the end fired; not the 20 s of lead-in.
  assert.ok(got.length > 3.8 * R && got.length < 4.8 * R, `${got.length / R}`);
  // It starts in quiet (the pre-roll), not mid-word.
  assert.ok(Math.abs(got[0]) < 0.01);
  cap.reset();
  assert.equal(cap.take().length, 0);
});

test('vad: digital silence (a mic warming up) is not the noise floor, and silence after speech still ends it', () => {
  // Zeros for 0.4 s, then steady room noise: the noise must not look like speech.
  const ev = run(concat(new Float32Array(Math.round(0.4 * R)), road(11, 0.02)));
  assert.deepEqual(
    ev.map((e) => e[0]),
    ['nospeech'],
  );
  // Speech, then the track goes dead (zeros): the utterance still ends.
  const ev2 = run(concat(quiet(1), voice(2), new Float32Array(3 * R)));
  assert.deepEqual(
    ev2.map((e) => e[0]),
    ['speech', 'end'],
  );
});
