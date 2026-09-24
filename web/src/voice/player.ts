// Reading replies aloud in voice mode. Local Kokoro: the text goes to /api/voice/tts a chunk at a
// time (the first chunk is one short sentence, so audio starts ~0.3 s after the reply), each WAV is
// decoded and scheduled back to back on the SAME AudioContext the mic uses: on iOS that keeps one
// play-and-record session alive across the whole voice-mode loop. Fallback: speechSynthesis.
import { speakableText, speechChunks } from '../../../shared/speech';
import { api } from '../api';

export type SpeechEngine = 'local' | 'browser';

export interface SpeakOptions {
  engine: SpeechEngine;
  voice?: string;
  speed?: number;
  /** Called once, when the first audio actually starts. */
  onStart?: () => void;
}

export class SpeechPlayer {
  private readonly ctx: AudioContext;
  private sources: AudioBufferSourceNode[] = [];
  private abort?: AbortController;
  private stopped = false;
  private finish?: (how: 'done' | 'stopped') => void;
  speaking = false;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  /** Read markdown aloud. Resolves 'done' when it finished, 'stopped' when stop() cut it off. */
  async speak(markdown: string, o: SpeakOptions): Promise<'done' | 'stopped'> {
    this.stop();
    const chunks = speechChunks(speakableText(markdown));
    if (!chunks.length) return 'done';
    this.stopped = false;
    this.speaking = true;
    try {
      return o.engine === 'local' ? await this.speakLocal(chunks, o) : await this.speakBrowser(chunks, o);
    } finally {
      this.speaking = false;
    }
  }

  /** Cut playback off now (barge-in, the end of voice mode). */
  stop() {
    this.stopped = true;
    this.abort?.abort();
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* not started */
      }
    }
    this.sources = [];
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    this.finish?.('stopped');
    this.finish = undefined;
  }

  private async speakLocal(chunks: string[], o: SpeakOptions): Promise<'done' | 'stopped'> {
    const abort = (this.abort = new AbortController());
    // All requests up front: the server works through them in order while the first ones play.
    const audio = chunks.map((c) =>
      api
        .voiceSpeak(c, o.voice, o.speed, abort.signal)
        .then((buf) => this.ctx.decodeAudioData(buf))
        .catch((e: Error) => (abort.signal.aborted ? null : Promise.reject(e))),
    );
    audio.forEach((p) => p.catch(() => {})); // awaited in order below
    let at = 0;
    let last: AudioBufferSourceNode | undefined;
    for (let i = 0; i < audio.length; i++) {
      const buf = await audio[i];
      if (this.stopped || !buf) return 'stopped';
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.ctx.destination);
      // Back to back; a chunk that arrives late starts as soon as it is here.
      at = Math.max(at, this.ctx.currentTime + 0.02);
      src.start(at);
      if (i === 0) o.onStart?.();
      at += buf.duration;
      this.sources.push(src);
      last = src;
    }
    if (!last) return 'done';
    const end = last;
    return new Promise((resolve) => {
      this.finish = resolve;
      end.onended = () => {
        this.finish = undefined;
        this.sources = [];
        resolve(this.stopped ? 'stopped' : 'done');
      };
    });
  }

  private async speakBrowser(chunks: string[], o: SpeakOptions): Promise<'done' | 'stopped'> {
    if (typeof speechSynthesis === 'undefined') throw new Error('This browser cannot speak.');
    const voice = pickBrowserVoice();
    for (let i = 0; i < chunks.length; i++) {
      if (this.stopped) return 'stopped';
      const how = await new Promise<'done' | 'stopped'>((resolve) => {
        const u = new SpeechSynthesisUtterance(chunks[i]);
        if (voice) u.voice = voice;
        u.rate = o.speed ?? 1;
        u.onstart = () => i === 0 && o.onStart?.();
        u.onend = () => resolve('done');
        u.onerror = () => resolve(this.stopped ? 'stopped' : 'done');
        this.finish = resolve;
        // Chrome speaks long utterances in pieces anyway, and stops some after ~15 s: chunks avoid both.
        speechSynthesis.speak(u);
      });
      this.finish = undefined;
      if (how === 'stopped') return how;
    }
    return 'done';
  }
}

/** A natural English voice: Siri/Samantha on Apple, "Natural"/Google voices in Edge/Chrome. */
function pickBrowserVoice(): SpeechSynthesisVoice | undefined {
  const all = speechSynthesis.getVoices().filter((v) => /^en[-_]/i.test(v.lang));
  const rank = (v: SpeechSynthesisVoice) => (/natural|neural|premium|enhanced|siri/i.test(v.name) ? 0 : /samantha|google us|aria|jenny/i.test(v.name) ? 1 : v.localService ? 2 : 3);
  return all.sort((a, b) => rank(a) - rank(b))[0];
}

/**
 * iOS lets a page play speech (and Web Audio) only after a user gesture: call this in the tap that
 * starts voice mode, before any await.
 */
export function unlockSpeech(ctx: AudioContext) {
  void ctx.resume().catch(() => {});
  if (typeof speechSynthesis !== 'undefined') {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  }
}

/** Short tones so a driver knows what state the loop is in without looking. */
export function earcon(ctx: AudioContext, kind: 'listen' | 'sent' | 'end' | 'thinking') {
  if (ctx.state !== 'running') return;
  const tones: Record<typeof kind, [number, number, number][]> = {
    // [frequency Hz, start s, length s]
    listen: [
      [660, 0, 0.09],
      [880, 0.1, 0.12],
    ],
    sent: [[740, 0, 0.08]],
    end: [
      [660, 0, 0.1],
      [440, 0.12, 0.16],
    ],
    thinking: [[520, 0, 0.06]],
  };
  const t0 = ctx.currentTime + 0.01;
  for (const [f, s, len] of tones[kind]) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = f;
    const peak = kind === 'thinking' ? 0.04 : 0.12;
    g.gain.setValueAtTime(0, t0 + s);
    g.gain.linearRampToValueAtTime(peak, t0 + s + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + s + len);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0 + s);
    osc.stop(t0 + s + len + 0.02);
  }
}
