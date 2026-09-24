// Hands-free voice mode (docs/voice.md): listen -> finish on silence -> send -> wait for the turn's
// reply -> read it aloud -> listen again, until the user says "stop" or taps the screen. Built for the
// phone in a car: one mic stream and one AudioContext for the whole mode (iOS keeps a single
// play-and-record session and never re-prompts), the screen kept awake, and earcons for each step.
import { MAX_DICTATION_SECONDS, downsample, encodeWav, isEmptyTranscript, micErrorMessage } from '../../../shared/voice';
import { isStopCommand, speakableText, turnReply } from '../../../shared/speech';
import { UtteranceCapture } from '../../../shared/vad';
import { api } from '../api';
import { getState, subscribeStore } from '../store';
import { BrowserSpeech, browserSpeechSupported } from './browserSpeech';
import { getVoicePrefs, getVoiceStatus, setStatus } from './dictation';
import { SpeechPlayer, earcon, unlockSpeech, type SpeechEngine } from './player';
import { PcmRecorder, canRecord, toBase64 } from './recorder';

export type VoiceModeState = 'starting' | 'listening' | 'hearing' | 'transcribing' | 'thinking' | 'speaking' | 'ended';

export interface VoiceModeView {
  state: VoiceModeState;
  /** What the user said last (as transcribed). */
  heard?: string;
  /** The reply being read (plain text as spoken). */
  reply?: string;
  /** A problem worth showing (the loop keeps going where it can). */
  note?: string;
  stt: 'whisper' | 'browser';
  tts?: SpeechEngine;
  /** Timing of the last round, for the status line: speech end -> text, reply -> first audio. */
  timings?: { transcribeMs?: number; firstAudioMs?: number };
}

/** Extra dB the user's voice needs over the floor to interrupt a reply (the speaker's own echo leaks in). */
const BARGE_IN_BOOST_DB = 8;
/** Voice mode ends by itself after this long with nobody talking. */
const IDLE_END_MS = 5 * 60_000;
const THINKING_TICK_MS = 8000;

const isIphone = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export class VoiceModeController {
  private readonly sessionId: string;
  private readonly send: (text: string) => Promise<boolean>;
  private readonly onChange: (v: VoiceModeView) => void;
  private readonly onEnd: (reason: string) => void;
  private view: VoiceModeView;

  private ctx?: AudioContext;
  private rec?: PcmRecorder;
  private capture?: UtteranceCapture;
  private browser?: BrowserSpeech;
  private player?: SpeechPlayer;
  private wakeLock?: { release(): Promise<void> } | null;
  private unsubscribe?: () => void;
  private timers: ReturnType<typeof setInterval>[] = [];
  /** Waiting for the turn after this transcript seq to finish. */
  private awaitingMark: number | null = null;
  private pendingReply?: string;
  private lastActivity = Date.now();
  private speechEndAt = 0;
  private ended = false;
  private readonly debug = localStorage.getItem('ffsb.voice.debug') === '1';
  private debugN = 0;

  constructor(o: { sessionId: string; send: (text: string) => Promise<boolean>; onChange: (v: VoiceModeView) => void; onEnd: (reason: string) => void }) {
    this.sessionId = o.sessionId;
    this.send = o.send;
    this.onChange = o.onChange;
    this.onEnd = o.onEnd;
    const s = getVoiceStatus();
    const whisper = canRecord() && (!s || (s.state !== 'unavailable' && s.state !== 'installing'));
    this.view = { state: 'starting', stt: whisper || !browserSpeechSupported() ? 'whisper' : 'browser' };
  }

  get state() {
    return this.view.state;
  }

  /** Mic loudness 0..1 for the big circle. */
  level(): number {
    return this.rec?.level() ?? 0;
  }

  private set(patch: Partial<VoiceModeView>) {
    this.view = { ...this.view, ...patch };
    this.onChange(this.view);
  }

  /** Call from the tap that opens voice mode: audio has to be unlocked inside the gesture (iOS). */
  start() {
    const prefs = getVoicePrefs();
    try {
      if (this.view.stt === 'whisper') {
        this.rec = new PcmRecorder();
        this.rec.keep = false;
        this.ctx = this.rec.ctx;
      } else {
        this.ctx = new AudioContext();
      }
    } catch (e) {
      return this.end(`Could not start audio: ${(e as Error).message}`);
    }
    unlockSpeech(this.ctx);
    this.player = new SpeechPlayer(this.ctx);
    api.voiceWarm(true).then(setStatus, () => {});
    void this.keepAwake();
    document.addEventListener('visibilitychange', this.onVisibility);
    this.unsubscribe = subscribeStore(() => this.checkReply());
    this.timers.push(
      setInterval(() => {
        if (this.view.state === 'thinking') earcon(this.ctx!, 'thinking');
      }, THINKING_TICK_MS),
      setInterval(() => {
        if (this.view.state === 'listening' && Date.now() - this.lastActivity > IDLE_END_MS) this.end('No one spoke for 5 minutes.');
      }, 10_000),
    );
    if (this.rec) {
      const rec = this.rec;
      // No "no speech" timeout in voice mode: it keeps listening (up to the idle end above).
      this.capture = new UtteranceCapture(rec.ctx.sampleRate, { silenceMs: prefs.silenceMs, noSpeechMs: 0 });
      rec.onChunk = (c) => this.onAudio(c);
      rec.start().then(
        () => this.listen(),
        (e: DOMException) => this.end(micErrorMessage(e.name || e.message, isIphone() ? 'iphone' : 'desktop')),
      );
    } else {
      void this.ctx.resume().then(() => this.listen());
    }
  }

  /** Leave voice mode: stop reading, free the mic, let the screen sleep. */
  end(reason = 'Voice mode off.') {
    if (this.ended) return;
    this.ended = true;
    this.player?.stop();
    this.browser?.cancel();
    if (this.ctx) earcon(this.ctx, 'end');
    this.timers.forEach(clearInterval);
    this.unsubscribe?.();
    document.removeEventListener('visibilitychange', this.onVisibility);
    void this.wakeLock?.release().catch(() => {});
    const rec = this.rec;
    const ctx = this.ctx;
    // Let the end tone play before the context closes.
    setTimeout(() => {
      rec?.release();
      if (!rec && ctx && ctx.state !== 'closed') void ctx.close().catch(() => {});
    }, 400);
    this.set({ state: 'ended' });
    this.onEnd(reason);
  }

  // ------------------------------------------------------------ listening

  private listen() {
    if (this.ended) return;
    this.lastActivity = Date.now();
    this.capture?.reset();
    if (this.capture) this.capture.vad.boostDb = 0;
    this.set({ state: this.awaitingMark !== null ? 'thinking' : 'listening' });
    if (this.awaitingMark === null) earcon(this.ctx!, 'listen');
    if (this.pendingReply !== undefined) return this.speakPending();
    if (!this.rec) this.listenBrowser();
  }

  private onAudio(c: Float32Array) {
    const st = this.view.state;
    const cap = this.capture;
    if (!cap || this.ended) return;
    if (st === 'transcribing' || st === 'starting') return;
    if (st === 'speaking' && !getVoicePrefs().bargeIn) return;
    const events = cap.push(c);
    // Tuning aid: localStorage['ffsb.voice.debug'] = '1' logs the detector's view to the console.
    if (this.debug && (this.debugN++ % 3 === 0 || events.length)) console.log(`vad[${st}] t=${(cap.vad.frames * 0.02).toFixed(2)} e=${cap.vad.energyDb.toFixed(1)} floor=${cap.vad.floorDb.toFixed(1)} ${events.join(',')}`);
    for (const ev of events) {
      if (ev === 'speech') {
        this.lastActivity = Date.now();
        if (this.view.state === 'speaking') {
          // Barge-in: the user talks over the reply. Cut it and take what they say.
          this.player?.stop();
        }
        this.set({ state: 'hearing' });
      } else if (ev === 'end') {
        const pcm = cap.take();
        cap.reset();
        void this.transcribe(pcm, this.rec!.ctx.sampleRate);
      }
    }
    // Hearing for too long (a radio, a passenger): cut it at the dictation limit.
    if (this.view.state === 'hearing' && Date.now() - this.lastActivity > MAX_DICTATION_SECONDS * 1000) {
      const pcm = cap.take();
      cap.reset();
      void this.transcribe(pcm, this.rec!.ctx.sampleRate);
    }
  }

  /** Fallback when local Whisper is not there: the browser ends the utterance itself. No barge-in. */
  private listenBrowser() {
    if (this.ended || this.browser) return;
    let heardSomething = false;
    const b = new BrowserSpeech(
      () => {
        if (!heardSomething) {
          heardSomething = true;
          this.lastActivity = Date.now();
          this.set({ state: 'hearing' });
        }
      },
      (err) => this.set({ note: micErrorMessage(err, isIphone() ? 'iphone' : 'desktop') }),
      { continuous: false },
    );
    this.browser = b;
    b.done().then(
      (text) => {
        this.browser = undefined;
        void this.handleText(text, 0);
      },
      () => {
        this.browser = undefined;
        // "no-speech" ends recognition quietly: just listen again (after a breath, not in a tight loop).
        setTimeout(() => this.view.state !== 'speaking' && this.listen(), 300);
      },
    );
  }

  private async transcribe(pcm: Float32Array, rate: number) {
    const st = getVoiceStatus();
    // A cold model load (after an idle unload) takes seconds, the first time after a restart longer.
    const cold = !!st && st.state !== 'ready';
    this.set({ state: 'transcribing', ...(cold ? { note: 'Loading the speech model: this answer takes longer.' } : {}) });
    this.speechEndAt = performance.now();
    try {
      const r = await api.voiceTranscribe(toBase64(encodeWav(downsample(pcm, rate))));
      if (this.ended) return;
      if (st) setStatus({ ...st, state: 'ready', device: r.device });
      if (cold) this.set({ note: undefined });
      await this.handleText(r.text, performance.now() - this.speechEndAt);
    } catch (e) {
      if (this.ended) return;
      this.set({ note: `Transcription failed: ${(e as Error).message}` });
      await this.say('Sorry, I could not transcribe that.');
      this.listen();
    }
  }

  private async handleText(raw: string, transcribeMs: number) {
    const text = raw.trim();
    if (isEmptyTranscript(text)) return this.listen();
    if (isStopCommand(text)) return this.end('Stopped by voice.');
    this.set({ heard: text, note: undefined, timings: { transcribeMs: Math.round(transcribeMs) } });
    const mark = this.lastSeq();
    const ok = await this.send(text).catch(() => false);
    if (this.ended) return;
    if (!ok) {
      this.set({ note: 'The message did not go through.' });
      await this.say('The message did not go through.');
      return this.listen();
    }
    earcon(this.ctx!, 'sent');
    // A reply still pending from an earlier question is read first; this turn's comes after it.
    if (this.awaitingMark === null) this.awaitingMark = mark;
    this.set({ state: 'thinking' });
    // Keep listening while it thinks: "stop" still works, and a follow-up is sent as one.
    if (this.pendingReply !== undefined) void this.speakPending();
    else this.checkReply();
  }

  // ------------------------------------------------------------ the reply

  private lastSeq(): number {
    const ev = getState().transcripts[this.sessionId];
    return ev?.length ? ev[ev.length - 1].seq : 0;
  }

  private checkReply() {
    if (this.awaitingMark === null || this.ended) return;
    const st = getState();
    const r = turnReply(st.transcripts[this.sessionId] ?? [], this.awaitingMark);
    const session = st.app?.sessions.find((s) => s.id === this.sessionId);
    if (!r && session?.status !== 'error') return;
    const text = r?.text ?? `The session stopped with an error${session?.statusDetail ? `: ${session.statusDetail}` : ''}.`;
    // The next turn (a follow-up sent while this one ran) starts after this result.
    const events = st.transcripts[this.sessionId] ?? [];
    const result = events.find((e) => e.seq > this.awaitingMark! && e.kind === 'result');
    const pendingFollowUp = !!result && events.some((e) => e.seq > result.seq && e.kind === 'user');
    this.awaitingMark = pendingFollowUp && result ? result.seq : null;
    this.pendingReply = text;
    if (this.view.state === 'listening' || this.view.state === 'thinking') void this.speakPending();
    // Otherwise the user is mid-sentence: it is read when their utterance has been dealt with.
  }

  private async speakPending() {
    const text = this.pendingReply;
    if (text === undefined || this.ended) return;
    this.pendingReply = undefined;
    const prefs = getVoicePrefs();
    const tts = getVoiceStatus()?.tts;
    const local = prefs.ttsEngine === 'local' || (prefs.ttsEngine === 'auto' && (!tts || (tts.state !== 'unavailable' && tts.state !== 'installing')));
    this.capture?.reset();
    if (this.capture) this.capture.vad.boostDb = BARGE_IN_BOOST_DB;
    const t0 = performance.now();
    this.set({ state: 'speaking', reply: speakableText(text), tts: local ? 'local' : 'browser' });
    const onStart = () => this.set({ timings: { ...this.view.timings, firstAudioMs: Math.round(performance.now() - t0) } });
    let how: 'done' | 'stopped';
    try {
      how = await this.player!.speak(text, { engine: local ? 'local' : 'browser', voice: prefs.ttsVoice || undefined, speed: prefs.ttsSpeed, onStart });
    } catch (e) {
      if (!local) {
        this.set({ note: `Could not read the reply: ${(e as Error).message}` });
        how = 'done';
      } else {
        // Local TTS failed: the browser's voice reads it instead.
        this.set({ tts: 'browser', note: `Local voice failed (${(e as Error).message}); using the browser's.` });
        how = await this.player!.speak(text, { engine: 'browser', speed: prefs.ttsSpeed, onStart }).catch(() => 'done' as const);
      }
    }
    if (this.ended) return;
    if (this.capture) this.capture.vad.boostDb = 0;
    // Stopped by barge-in: the capture is already hearing the user.
    if (how === 'done' && this.view.state === 'speaking') this.listen();
  }

  private async say(text: string) {
    const tts = getVoiceStatus()?.tts;
    const local = getVoicePrefs().ttsEngine !== 'browser' && tts?.state === 'ready';
    await this.player?.speak(text, { engine: local ? 'local' : 'browser' }).catch(() => {});
  }

  // ------------------------------------------------------------ the phone

  private async keepAwake() {
    try {
      const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
      this.wakeLock = wl ? await wl.request('screen') : null;
    } catch {
      this.wakeLock = null; // not allowed (battery saver, older iOS): the screen may sleep
    }
  }

  private readonly onVisibility = () => {
    if (document.visibilityState !== 'visible' || this.ended) return;
    // Coming back from the lock screen or another app: iOS suspends audio and drops the wake lock.
    void this.ctx?.resume().catch(() => {});
    void this.keepAwake();
    if (this.rec && !this.rec.live) this.end('The microphone was taken by another app or call.');
  };
}
