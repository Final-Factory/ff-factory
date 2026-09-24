// Fallback engine: the browser's own speech recognition (Chrome/Edge send the audio to their cloud
// service; Safari uses Apple's). No vocabulary hints, but it needs nothing on the server.

interface Alternative {
  transcript: string;
}
interface Result {
  isFinal: boolean;
  0: Alternative;
}
interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<Result>;
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

function ctor(): RecognitionCtor | undefined {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export function browserSpeechSupported(): boolean {
  return !!ctor();
}

export class BrowserSpeech {
  private readonly rec: Recognition;
  private finals: string[] = [];
  private interim = '';
  private ended = false;
  private error?: string;
  private onEnd?: () => void;

  /**
   * Starts listening at once: call it from the gesture handler. `continuous: false` (voice mode's
   * fallback) lets the browser end the utterance by itself; done() then gives the text.
   */
  constructor(onInterim: (text: string) => void, onFail: (error: string) => void, opts: { continuous?: boolean } = {}) {
    const C = ctor();
    if (!C) throw new Error('This browser has no speech recognition.');
    this.rec = new C();
    this.rec.lang = navigator.language || 'en-US';
    this.rec.continuous = opts.continuous ?? true;
    this.rec.interimResults = true;
    this.rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) this.finals.push(r[0].transcript.trim());
        else interim += r[0].transcript;
      }
      this.interim = interim.trim();
      onInterim([...this.finals, this.interim].filter(Boolean).join(' '));
    };
    this.rec.onerror = (e) => {
      // "no-speech" and "aborted" just mean nothing was said, or we stopped it.
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      this.error = e.error;
      onFail(e.error);
    };
    this.rec.onend = () => {
      this.ended = true;
      this.onEnd?.();
    };
    this.rec.start();
  }

  /** What was heard, once recognition ends by itself (or is stopped). */
  done(): Promise<string> {
    const text = () => [...this.finals, this.interim].filter(Boolean).join(' ');
    if (this.ended) return this.error ? Promise.reject(new Error(this.error)) : Promise.resolve(text());
    return new Promise((resolve, reject) => {
      this.onEnd = () => (this.error ? reject(new Error(this.error)) : resolve(text()));
    });
  }

  /** Stop listening and return what was heard. */
  stop(): Promise<string> {
    const text = () => [...this.finals, this.interim].filter(Boolean).join(' ');
    if (this.ended) return this.error ? Promise.reject(new Error(this.error)) : Promise.resolve(text());
    return new Promise((resolve) => {
      this.onEnd = () => resolve(text());
      this.rec.stop();
      // Some browsers never fire end after stop(): take what we have.
      setTimeout(() => resolve(text()), 2500);
    });
  }

  cancel() {
    this.onEnd = undefined;
    try {
      this.rec.abort();
    } catch {
      /* already stopped */
    }
  }
}
