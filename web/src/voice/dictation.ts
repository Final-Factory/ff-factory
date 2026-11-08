// The mic button's brain: engine choice, recording, push-to-talk, transcription, errors.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  MAX_DICTATION_SECONDS,
  VOICE_RATE,
  chooseEngine,
  encodeWav,
  isEmptyTranscript,
  micErrorMessage,
  type VoiceEngine,
  type VoiceEnginePref,
  type LiveStats,
  type VoiceStatus,
} from '../../../shared/voice';
import { LIVE, joinLive, liveStats, nextLivePass } from '../../../shared/liveTranscript';
import { api } from '../api';
import { EndpointDetector } from '../../../shared/vad';
import { toast } from '../store';
import { lsGet, lsSet } from '../util';
import { BrowserSpeech, browserSpeechSupported } from './browserSpeech';
import { PcmRecorder, canRecord, toBase64 } from './recorder';

// ---------------------------------------------------------------- this device's settings

export type TtsEnginePref = 'auto' | 'local' | 'browser';

export interface VoicePrefs {
  engine: VoiceEnginePref;
  /** Send the message as soon as the transcript lands (off: it waits in the composer for review). */
  autoSend: boolean;
  /** Silence after speech that ends a recording by itself (dictation and voice mode). */
  silenceMs: number;
  /** Dictation (tap to start) stops by itself after that silence; holding the mic always waits for the release. */
  dictationAutoStop: boolean;
  /** Voice mode: who reads replies. auto = local Kokoro when installed, else the browser's voice. */
  ttsEngine: TtsEnginePref;
  /** Kokoro voice; '' = the server's default. */
  ttsVoice: string;
  ttsSpeed: number;
  /** Voice mode: talking over a reply stops it and listens. */
  bargeIn: boolean;
}

export const VOICE_PREF_DEFAULTS: VoicePrefs = {
  engine: 'auto',
  autoSend: false,
  silenceMs: 1800,
  dictationAutoStop: true,
  ttsEngine: 'auto',
  ttsVoice: '',
  ttsSpeed: 1,
  bargeIn: true,
};

const prefListeners = new Set<() => void>();
let prefs: VoicePrefs = readPrefs();

function readPrefs(): VoicePrefs {
  let stored: Partial<VoicePrefs> = {};
  try {
    stored = JSON.parse(lsGet('ffsb.voice.prefs') ?? '{}') as Partial<VoicePrefs>;
  } catch {
    /* defaults */
  }
  // The first version kept two separate keys.
  const e = lsGet('ffsb.voice.engine');
  if (e === 'whisper' || e === 'browser') stored.engine ??= e;
  if (lsGet('ffsb.voice.autoSend') === '1') stored.autoSend ??= true;
  return { ...VOICE_PREF_DEFAULTS, ...stored };
}

export function getVoicePrefs(): VoicePrefs {
  return prefs;
}

export function setVoicePrefs(patch: Partial<VoicePrefs>) {
  prefs = { ...prefs, ...patch };
  const diff = Object.fromEntries(Object.entries(prefs).filter(([k, v]) => VOICE_PREF_DEFAULTS[k as keyof VoicePrefs] !== v));
  lsSet('ffsb.voice.prefs', Object.keys(diff).length ? JSON.stringify(diff) : null);
  lsSet('ffsb.voice.engine', null);
  lsSet('ffsb.voice.autoSend', null);
  prefListeners.forEach((l) => l());
}

export function useVoicePrefs(): VoicePrefs {
  return useSyncExternalStore(
    (l) => {
      prefListeners.add(l);
      return () => prefListeners.delete(l);
    },
    () => prefs,
  );
}

// ---------------------------------------------------------------- the server's Whisper status

let status: VoiceStatus | undefined;
let statusAt = 0;
const statusListeners = new Set<() => void>();

export function getVoiceStatus(): VoiceStatus | undefined {
  return status;
}

export function setStatus(s: VoiceStatus | undefined) {
  status = s;
  statusAt = Date.now();
  statusListeners.forEach((l) => l());
}

/** Fetch the status unless it is fresh; errors leave it unknown (and unknown means "try Whisper"). */
export function refreshVoiceStatus(maxAgeMs = 30_000) {
  if (Date.now() - statusAt < maxAgeMs) return;
  statusAt = Date.now();
  api.voiceStatus().then(setStatus, () => setStatus(undefined));
}

export function useVoiceStatus(): VoiceStatus | undefined {
  useEffect(() => refreshVoiceStatus(), []);
  return useSyncExternalStore(
    (l) => {
      statusListeners.add(l);
      return () => statusListeners.delete(l);
    },
    () => status,
  );
}

export function engineLabel(engine: VoiceEngine | undefined, s: VoiceStatus | undefined): string {
  if (engine === 'browser') return 'Browser speech';
  if (!s) return 'Whisper';
  // A worker machine's GPU takes the clip (w615): name it; the portal's own engine is the fallback.
  const where = s.local && s.remote ? `${s.remote.machine} ` : '';
  if (s.state === 'ready') return `Whisper · ${where}${s.device === 'cuda' ? 'GPU' : 'CPU'}`;
  if (s.state === 'loading' || s.state === 'idle') return 'Whisper · loading model';
  return `Whisper · ${s.state}`;
}

// ---------------------------------------------------------------- the hook

export type DictationPhase = 'idle' | 'starting' | 'recording' | 'transcribing' | 'error';

export interface Dictation {
  phase: DictationPhase;
  engine?: VoiceEngine;
  label: string;
  elapsedMs: number;
  level: number;
  /** Browser engine: what it has heard so far. */
  interim: string;
  error?: string;
  /** A failed transcription kept its clip: retry() sends it again. */
  canRetry: boolean;
  active: boolean;
  stop(): void;
  cancel(): void;
  retry(): void;
  dismiss(): void;
  /** The mic button's pointer down/up: a tap toggles, a hold is push-to-talk. */
  press(): void;
  release(): void;
  /** For the text box: Ctrl+M (hold to talk, tap to toggle), Escape cancels. True when handled. */
  onKeyDown(e: ReactKeyboardEvent): boolean;
  onKeyUp(e: ReactKeyboardEvent): void;
}

/** Held longer than this, a press is push-to-talk: letting go stops. */
const HOLD_MS = 400;
export const SHORTCUT_LABEL = 'Ctrl+M';

const isIphone = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/**
 * Where the words go while the user still talks (w3712): `show` puts the text so far in the box, replacing the last; the
 * final transcript (onText) replaces it in turn; `end` drops it (keep false: cancelled, nothing heard) or leaves it.
 */
export interface LiveSink {
  show(text: string): void;
  end(keep: boolean): void;
}

export function useDictation(onText: (text: string, opts: { autoSend: boolean }) => void, live?: LiveSink): Dictation {
  const [phase, setPhase] = useState<DictationPhase>('idle');
  const [engine, setEngine] = useState<VoiceEngine>();
  const [elapsedMs, setElapsed] = useState(0);
  const [lvl, setLevel] = useState(0);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string>();
  const [canRetry, setCanRetry] = useState(false);
  const vs = useVoiceStatus();

  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const liveRef = useRef(live);
  liveRef.current = live;
  /** This dictation's live passes, for the final request (measured in the page). */
  const liveRun = useRef<{ rtts: number[]; firstTextMs?: number } | undefined>(undefined);
  const phaseRef = useRef<DictationPhase>('idle');
  const rec = useRef<PcmRecorder | undefined>(undefined);
  const speech = useRef<BrowserSpeech | undefined>(undefined);
  const startedAt = useRef(0);
  const pressAt = useRef(0);
  const armed = useRef(false);
  const stopWanted = useRef(false);
  const lastClip = useRef<Uint8Array | undefined>(undefined);
  /** Bumped by start and cancel: a transcription that returns after either is dropped. */
  const gen = useRef(0);

  const go = (p: DictationPhase) => {
    phaseRef.current = p;
    setPhase(p);
  };

  const fail = useCallback((msg: string, retry = false) => {
    rec.current?.release();
    rec.current = undefined;
    speech.current?.cancel();
    speech.current = undefined;
    setError(msg);
    setCanRetry(retry);
    go('error');
  }, []);

  const deliver = useCallback((text: string) => {
    if (isEmptyTranscript(text)) {
      liveRef.current?.end(false);
      toast('Nothing heard');
      return;
    }
    onTextRef.current(text.trim(), { autoSend: prefs.autoSend });
  }, []);

  const transcribe = useCallback(
    async (wav: Uint8Array) => {
      const g = gen.current;
      go('transcribing');
      lastClip.current = wav;
      try {
        const run = liveRun.current;
        const stats: LiveStats | undefined = run?.rtts.length ? liveStats(run.rtts, run.firstTextMs) : undefined;
        const r = await api.voiceTranscribe(toBase64(wav), stats ? { live: stats } : {});
        if (g !== gen.current) return;
        lastClip.current = undefined;
        // Which engine answered (w615) shows in Settings; the status is fetched again, not guessed from the result.
        refreshVoiceStatus(0);
        go('idle');
        deliver(r.text);
      } catch (e) {
        if (g !== gen.current) return;
        refreshVoiceStatus(0);
        fail(`Transcription failed: ${(e as Error).message}`, true);
      }
    },
    [deliver, fail],
  );

  const stop = useCallback(() => {
    const p = phaseRef.current;
    if (p === 'starting') {
      stopWanted.current = true;
      return;
    }
    if (p !== 'recording') return;
    if (rec.current) {
      const r = rec.current;
      rec.current = undefined;
      const g = gen.current;
      go('transcribing');
      void r.stop().then(
        (clip) => {
          if (g !== gen.current) return;
          if (clip.seconds >= 0.3) return transcribe(clip.wav);
          go('idle');
          liveRef.current?.end(false);
          toast('Too short: hold the mic, or tap once to start and again to stop');
        },
        (e: Error) => g === gen.current && fail(e.message),
      );
    } else if (speech.current) {
      const s = speech.current;
      speech.current = undefined;
      const g = gen.current;
      go('transcribing');
      void s.stop().then(
        (text) => {
          if (g !== gen.current) return;
          go('idle');
          deliver(text);
        },
        (e: Error) => fail(micErrorMessage(e.message, isIphone() ? 'iphone' : 'desktop')),
      );
    }
  }, [deliver, fail, transcribe]);

  /**
   * Live text while recording (w3712): about once a second the open window of the clip goes to Whisper as a partial pass,
   * and its text replaces the last in the box. One pass at a time; on the portal's CPU fallback the wait between passes
   * is as long as a pass took, so it never runs more than half the time. Ends with the recording; failures only stop it.
   */
  const liveLoop = useCallback(async (r: PcmRecorder, g: number) => {
    const run: { rtts: number[]; firstTextMs?: number } = { rtts: [] };
    liveRun.current = run;
    const alive = () => rec.current === r && gen.current === g;
    const closed: string[] = [];
    let windowStart = 0;
    let gap: number = LIVE.minGapMs;
    let failures = 0;
    let shown = false;
    while (alive()) {
      await new Promise((res) => setTimeout(res, gap));
      if (!alive() || phaseRef.current !== 'recording') continue;
      const pcm = r.pcm(windowStart);
      const pass = nextLivePass(r.seconds(), windowStart, pcm);
      if (!pass) continue;
      const t0 = performance.now();
      let res;
      try {
        const clip = pcm.subarray(0, Math.round((pass.to - pass.from) * VOICE_RATE));
        res = await api.voiceTranscribe(toBase64(encodeWav(clip)), { partial: true });
      } catch {
        if (++failures >= LIVE.maxFailures) return;
        gap = 1000;
        continue;
      }
      failures = 0;
      const ms = performance.now() - t0;
      if (!alive()) return;
      run.rtts.push(ms);
      gap = res.engine === 'local' ? Math.max(LIVE.minGapMs, ms) : LIVE.minGapMs;
      if (pass.closes) {
        closed.push(res.text);
        windowStart = pass.to;
      }
      // A closing pass holds only the words before the cut: the box keeps its longer text until the next pass, or it would
      // shrink back for a moment (seen with real speech).
      if (pass.closes && shown) continue;
      const text = joinLive(pass.closes ? closed : [...closed, res.text]);
      if (!text) continue;
      shown = true;
      run.firstTextMs ??= Date.now() - startedAt.current;
      liveRef.current?.show(text);
    }
  }, []);

  const start = useCallback(() => {
    const p = phaseRef.current;
    if (p !== 'idle' && p !== 'error') return;
    gen.current++;
    // A failed dictation's live text stays in the box: it is the user's text now.
    liveRef.current?.end(true);
    liveRun.current = undefined;
    setError(undefined);
    setCanRetry(false);
    lastClip.current = undefined;
    setInterim('');
    stopWanted.current = false;
    const choice = chooseEngine(prefs.engine, status, { record: canRecord(), browser: browserSpeechSupported(), secure: window.isSecureContext });
    if ('error' in choice) return fail(choice.error);
    setEngine(choice.engine);
    startedAt.current = Date.now();
    setElapsed(0);
    setLevel(0);
    go('starting');
    const device = isIphone() ? 'iphone' : 'desktop';
    if (choice.engine === 'whisper') {
      // Load the model while the user talks.
      api.voiceWarm().then(setStatus, () => {});
      let r: PcmRecorder;
      try {
        r = new PcmRecorder(); // in the gesture, before any await (iOS)
      } catch (e) {
        return fail(`Could not start audio: ${(e as Error).message}`);
      }
      rec.current = r;
      if (prefs.dictationAutoStop) {
        // Ends the recording by itself after the silence setting, once speech has started; gives up
        // (discarding it) when no speech starts within 10 s. A held mic waits for the release instead.
        const vad = new EndpointDetector(r.ctx.sampleRate, { silenceMs: prefs.silenceMs, noSpeechMs: 10_000 });
        const debug = lsGet('ffsb.voice.debug') === '1';
        let n = 0;
        r.onChunk = (c) => {
          if (rec.current !== r) return;
          const events = vad.push(c);
          // Tuning aid: localStorage['ffsb.voice.debug'] = '1' logs the detector's view to the console.
          if (debug && (n++ % 3 === 0 || events.length)) console.log(`vad t=${(vad.frames * 0.02).toFixed(2)} e=${vad.energyDb.toFixed(1)} floor=${vad.floorDb.toFixed(1)} ${events.join(',')}`);
          for (const ev of events) {
            if (armed.current && Date.now() - pressAt.current > HOLD_MS) continue;
            if (ev === 'end') stop();
            else if (ev === 'nospeech') {
              cancel();
              toast('No speech heard: stopped listening');
            }
          }
        };
      }
      r.start().then(
        () => {
          if (rec.current !== r) return; // cancelled meanwhile
          startedAt.current = Date.now();
          go('recording');
          if (stopWanted.current) stop();
          else void liveLoop(r, gen.current);
        },
        (e: DOMException) => {
          if (rec.current === r) fail(micErrorMessage(e.name || e.message, device));
        },
      );
    } else {
      try {
        const g = gen.current;
        const onInterim = (t: string) => {
          if (g !== gen.current) return;
          setInterim(t);
          if (t.trim()) liveRef.current?.show(t);
        };
        speech.current = new BrowserSpeech(onInterim, (err) => fail(micErrorMessage(err, device)));
        go('recording');
      } catch (e) {
        fail((e as Error).message);
      }
    }
  }, [fail, stop, liveLoop]);

  const cancel = useCallback(() => {
    gen.current++;
    liveRef.current?.end(false);
    rec.current?.release();
    rec.current = undefined;
    speech.current?.cancel();
    speech.current = undefined;
    armed.current = false;
    setError(undefined);
    setCanRetry(false);
    lastClip.current = undefined;
    go('idle');
  }, []);

  // Closing the error bar keeps what the live passes put in the box (cancel and Esc take it out).
  const dismiss = useCallback(() => {
    liveRef.current?.end(true);
    cancel();
  }, [cancel]);

  const retry = useCallback(() => {
    if (lastClip.current) void transcribe(lastClip.current);
  }, [transcribe]);

  const press = useCallback(() => {
    const p = phaseRef.current;
    if (p === 'recording' || p === 'starting') {
      armed.current = false;
      stop();
    } else if (p === 'idle' || p === 'error') {
      pressAt.current = Date.now();
      armed.current = true;
      start();
    }
  }, [start, stop]);

  const release = useCallback(() => {
    if (armed.current && Date.now() - pressAt.current > HOLD_MS) stop();
    armed.current = false;
  }, [stop]);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      const p = phaseRef.current;
      if (e.key === 'Escape' && (p === 'recording' || p === 'starting' || p === 'error')) {
        cancel();
        return true;
      }
      if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'm' || e.key === 'M')) {
        if (!e.repeat) press();
        return true;
      }
      return false;
    },
    [cancel, press],
  );

  const onKeyUp = useCallback(
    (e: ReactKeyboardEvent) => {
      if (armed.current && (e.key === 'm' || e.key === 'M' || e.key === 'Control')) release();
    },
    [release],
  );

  // The timer, the meter, and the length limit.
  useEffect(() => {
    if (phase !== 'recording') return;
    const t = setInterval(() => {
      const ms = Date.now() - startedAt.current;
      setElapsed(ms);
      if (rec.current) setLevel(rec.current.level());
      if (ms > MAX_DICTATION_SECONDS * 1000) {
        toast(`Stopped at the ${MAX_DICTATION_SECONDS / 60} minute limit`);
        stop();
      }
    }, 70);
    return () => clearInterval(t);
  }, [phase, stop]);

  // While dictating, Esc anywhere cancels it (and only it: a modal around the box stays open).
  useEffect(() => {
    if (phase === 'idle') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      cancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [phase, cancel]);

  // Leaving the page (or closing a modal) mid-recording drops the recording and frees the mic.
  useEffect(
    () => () => {
      rec.current?.release();
      speech.current?.cancel();
    },
    [],
  );

  return {
    phase,
    engine,
    label: engineLabel(engine, vs),
    elapsedMs,
    level: lvl,
    interim,
    error,
    canRetry,
    active: phase !== 'idle',
    stop,
    cancel,
    retry,
    dismiss,
    press,
    release,
    onKeyDown,
    onKeyUp,
  };
}
