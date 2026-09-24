// End-of-speech detection for hands-free voice (docs/voice.md). Pure: fed raw samples, it says when
// speech started, when it ended (N ms of silence after it), or that none came. No imports, so the
// browser and `node --test` share it.
//
// Energy, not a model: each 20 ms frame is high-passed (road rumble and engine hum live below
// ~150 Hz), measured in dB, and compared with a noise floor that ADAPTS: the minimum of the smoothed
// energy over the last few seconds. Speech always has gaps between words that fall back to the
// floor, so the minimum follows the background (a quiet room, a car at speed) and not the voice. A
// fixed threshold would either miss quiet speech in a quiet room or never end in a loud car.

export interface VadOptions {
  /** Silence after speech that ends the utterance. */
  silenceMs: number;
  /** Give up when no speech starts within this long (0 = wait forever). */
  noSpeechMs: number;
  /**
   * Loud time needed within the last 300 ms before it counts as speech: a click or a bump is
   * shorter, while clipped syllables with gaps between them still add up.
   */
  onsetMs: number;
  /** Voiced time an utterance needs; less (a cough, a door) is dropped and listening goes on. */
  minSpeechMs: number;
  /** dB over the noise floor that starts speech. */
  onDb: number;
  /** dB over the noise floor that still counts as voice (hysteresis: lower than onDb). */
  offDb: number;
  /** How far back the noise floor looks. Longer = steadier; shorter = adapts faster to new noise. */
  floorWindowMs: number;
  /** High-pass corner, Hz. */
  highPassHz: number;
  /** The floor never goes below this (digital silence would otherwise make any hiss "speech"). */
  minFloorDb: number;
}

export const VAD_DEFAULTS: VadOptions = {
  silenceMs: 1800,
  noSpeechMs: 10_000,
  onsetMs: 140,
  minSpeechMs: 300,
  onDb: 9,
  offDb: 5,
  floorWindowMs: 4000,
  highPassHz: 150,
  minFloorDb: -70,
};

export type VadEvent = 'speech' | 'end' | 'nospeech';

const FRAME_MS = 20;
const ONSET_WINDOW = 15; // 300 ms
const DIGITAL_SILENCE_DB = -100;
const SETTLE_FRAMES = 30;

export class EndpointDetector {
  readonly rate: number;
  opts: VadOptions;
  /** Extra dB needed to START speech, e.g. while a reply plays from the speaker (barge-in). */
  boostDb = 0;

  private readonly frameLen: number;
  private frameBuf: Float32Array;
  private frameN = 0;
  // one-pole high-pass state
  private readonly hpA: number;
  private hpPrevX = 0;
  private hpPrevY = 0;
  private smooth = -100;
  /** ~130 ms smoothing, for "is this still voice": noise-suppressor residue flickers for single frames, syllables do not. */
  private slow = -100;
  private silent = false;
  private readonly hist: Float32Array;
  private histN = 0;
  private histI = 0;

  /** Frames since reset. */
  frames = 0;
  started = false;
  /** Frame index where the current speech began (onset included). */
  startFrame = -1;
  /** Loud (1) or not (0) for the last ONSET_WINDOW frames, as a ring. */
  private readonly loud = new Uint8Array(ONSET_WINDOW);
  private loudCount = 0;
  private lastVoiced = -1;
  private voicedFrames = 0;
  private gaveUp = false;
  /** Latest frame energy and floor, for meters and tuning. */
  energyDb = -100;
  floorDb = -100;

  constructor(rate: number, opts: Partial<VadOptions> = {}) {
    this.rate = rate;
    this.opts = { ...VAD_DEFAULTS, ...opts };
    this.frameLen = Math.round((rate * FRAME_MS) / 1000);
    this.frameBuf = new Float32Array(this.frameLen);
    const rc = 1 / (2 * Math.PI * this.opts.highPassHz);
    const dt = 1 / rate;
    this.hpA = rc / (rc + dt);
    this.hist = new Float32Array(Math.max(1, Math.round(this.opts.floorWindowMs / FRAME_MS)));
  }

  get frameMs() {
    return FRAME_MS;
  }

  /** Sample index (since reset) where speech began, for cutting the utterance out of a buffer. */
  get startSample() {
    return this.startFrame < 0 ? -1 : this.startFrame * this.frameLen;
  }

  get speaking() {
    return this.started;
  }

  /** Listen for the next utterance. The noise floor is kept: the background has not changed. */
  reset() {
    this.frames = 0;
    this.started = false;
    this.startFrame = -1;
    this.loud.fill(0);
    this.loudCount = 0;
    this.lastVoiced = -1;
    this.voicedFrames = 0;
    this.gaveUp = false;
    this.frameN = 0;
  }

  /** Feed samples; returns what happened in them, in order. */
  push(samples: Float32Array): VadEvent[] {
    const out: VadEvent[] = [];
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      const y = this.hpA * (this.hpPrevY + x - this.hpPrevX);
      this.hpPrevX = x;
      this.hpPrevY = y;
      this.frameBuf[this.frameN++] = y;
      if (this.frameN === this.frameLen) {
        this.frameN = 0;
        const e = this.frame();
        if (e) out.push(e);
      }
    }
    return out;
  }

  private frame(): VadEvent | null {
    let sum = 0;
    for (let i = 0; i < this.frameLen; i++) sum += this.frameBuf[i] * this.frameBuf[i];
    const db = 10 * Math.log10(sum / this.frameLen + 1e-12);
    this.energyDb = db;
    // Digital silence (a mic warming up delivers zeros for a few hundred ms, as does a muted track) says
    // nothing about the background: kept out of the floor, it would drag it to minFloorDb and make the
    // real room noise that follows look like speech.
    if (db > DIGITAL_SILENCE_DB) {
      // ~60 ms smoothing: the floor follows this, so one quiet frame inside a word does not drag it down.
      // Coming out of digital silence it starts afresh (a ramp up from -120 dB would pull the floor down too).
      const fresh = this.histN === 0 || this.silent;
      this.smooth = fresh ? db : this.smooth + 0.35 * (db - this.smooth);
      this.slow = fresh ? db : this.slow + 0.15 * (db - this.slow);
      this.silent = false;
      this.hist[this.histI] = this.smooth;
      this.histI = (this.histI + 1) % this.hist.length;
      if (this.histN < this.hist.length) this.histN++;
    } else {
      // Still counts as "not voice" for ending an utterance.
      this.smooth = db;
      this.slow = db;
      this.silent = true;
    }
    let min = Infinity;
    for (let i = 0; i < this.histN; i++) if (this.hist[i] < min) min = this.hist[i];
    this.floorDb = Math.max(min, this.opts.minFloorDb);
    const f = this.frames++;
    const o = this.opts;

    const onsetFrames = Math.ceil(o.onsetMs / FRAME_MS);
    if (!this.started) {
      // Too little real signal to know the floor yet: the first 600 ms of it, which is also when a
      // browser's gain control and noise suppression settle (measured in Edge: the level jumps ~11 dB
      // above the first frames, then falls back).
      if (this.histN < SETTLE_FRAMES) {
        if (o.noSpeechMs > 0 && !this.gaveUp && f * FRAME_MS >= o.noSpeechMs) {
          this.gaveUp = true;
          return 'nospeech';
        }
        return null;
      }
      const slot = f % ONSET_WINDOW;
      this.loudCount -= this.loud[slot];
      this.loud[slot] = db > this.floorDb + o.onDb + this.boostDb ? 1 : 0;
      this.loudCount += this.loud[slot];
      if (this.loudCount >= onsetFrames) {
        this.started = true;
        // Speech began at the oldest loud frame in the window.
        let first = f;
        for (let k = ONSET_WINDOW - 1; k >= 0; k--) {
          const g = f - k;
          if (g >= 0 && this.loud[g % ONSET_WINDOW]) {
            first = g;
            break;
          }
        }
        this.startFrame = first;
        this.lastVoiced = f;
        this.voicedFrames = this.loudCount;
        return 'speech';
      }
      if (o.noSpeechMs > 0 && !this.gaveUp && f * FRAME_MS >= o.noSpeechMs) {
        this.gaveUp = true;
        return 'nospeech';
      }
      return null;
    }
    if (this.slow > this.floorDb + o.offDb) {
      this.lastVoiced = f;
      this.voicedFrames++;
    }
    if ((f - this.lastVoiced) * FRAME_MS >= o.silenceMs) {
      // The onset ring still holds the frames that started this utterance.
      this.loud.fill(0);
      this.loudCount = 0;
      this.started = false;
      if (this.voicedFrames * FRAME_MS >= o.minSpeechMs) return 'end';
      // A false start: keep listening (and keep the no-speech clock running from the reset).
      this.startFrame = -1;
      this.voicedFrames = 0;
    }
    return null;
  }
}

/**
 * Hands-free listening on a continuous stream: keeps a short pre-roll while waiting, the whole
 * utterance once speech starts, and hands it over when it ends. Memory stays bounded while idle.
 */
export class UtteranceCapture {
  readonly vad: EndpointDetector;
  private chunks: Float32Array[] = [];
  private kept = 0;
  /** Samples (since vad.reset) dropped from the front of `chunks`. */
  private dropped = 0;
  private readonly prerollSamples: number;
  private readonly idleKeep: number;

  constructor(rate: number, opts: Partial<VadOptions> = {}, prerollMs = 500) {
    this.vad = new EndpointDetector(rate, opts);
    this.prerollSamples = Math.round((rate * prerollMs) / 1000);
    this.idleKeep = Math.round(rate * 1.5);
  }

  /** Start waiting for the next utterance. */
  reset() {
    this.vad.reset();
    this.chunks = [];
    this.kept = 0;
    this.dropped = 0;
  }

  push(samples: Float32Array): VadEvent[] {
    this.chunks.push(samples);
    this.kept += samples.length;
    const events = this.vad.push(samples);
    if (!this.vad.speaking && !events.includes('end')) {
      // Idle: keep only the last ~1.5 s, enough for the pre-roll of the next start.
      while (this.chunks.length > 1 && this.kept - this.chunks[0].length >= this.idleKeep) {
        const c = this.chunks.shift()!;
        this.kept -= c.length;
        this.dropped += c.length;
      }
    }
    return events;
  }

  /** The utterance just ended (or the speech so far), with a little audio before the onset. */
  take(): Float32Array {
    const all = new Float32Array(this.kept);
    let o = 0;
    for (const c of this.chunks) {
      all.set(c, o);
      o += c.length;
    }
    const start = this.vad.startSample < 0 ? 0 : Math.max(0, this.vad.startSample - this.prerollSamples - this.dropped);
    return all.subarray(start);
  }
}
