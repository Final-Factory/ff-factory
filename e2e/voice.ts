/**
 * Stand-ins for the browser's speech and audio, installed with page.addInitScript(fakeVoice, …):
 *
 *   SpeechRecognition   a scripted recognizer; the test speaks through window.__speech.say()/end()
 *   speechSynthesis     "reads" instantly for blank text, otherwise holds each utterance until
 *                       window.__tts.release(), so the Speaking state can be seen
 *   getUserMedia        a live tone from an oscillator (Chromium only: it needs real Web Audio)
 *   AudioContext        a silent stand-in when `fakeAudio` (Playwright's WebKit has no Web Audio on
 *                       Windows and headless audio is unreliable elsewhere)
 *
 * Runs in the page, so it must not use anything from the module scope.
 */
export function fakeVoice({ fakeAudio }: { fakeAudio: boolean }) {
  type Handler<T = void> = ((e: T) => void) | null;
  interface Rec {
    onresult: Handler<unknown>;
    onend: Handler;
    finish(): void;
  }
  const w = window as unknown as Record<string, unknown>;

  const speech = {
    live: [] as Rec[],
    /** What the user says to the newest recognizer: interim first, then final. */
    say(text: string, final = true) {
      const r = speech.live.at(-1);
      if (!r) throw new Error('nobody is listening');
      r.onresult?.({ resultIndex: 0, results: [Object.assign({ isFinal: final, 0: { transcript: text } }, { length: 1 })] });
    },
    /** The browser decides the utterance is over. */
    end() {
      speech.live.at(-1)?.finish();
    },
  };
  class FakeRecognition implements Rec {
    lang = '';
    continuous = false;
    interimResults = false;
    onresult: Handler<unknown> = null;
    onerror: Handler<{ error: string }> = null;
    onend: Handler = null;
    private done = false;
    start() {
      speech.live.push(this);
    }
    stop() {
      this.finish();
    }
    abort() {
      this.finish();
    }
    finish() {
      if (this.done) return;
      this.done = true;
      speech.live = speech.live.filter((r) => r !== this);
      setTimeout(() => this.onend?.(), 0);
    }
  }
  w.__speech = speech;
  for (const name of ['SpeechRecognition', 'webkitSpeechRecognition']) Object.defineProperty(window, name, { configurable: true, writable: true, value: FakeRecognition });

  interface Utterance {
    text: string;
    onstart: Handler;
    onend: Handler;
  }
  const tts = {
    spoken: [] as string[],
    held: [] as Utterance[],
    auto: false,
    /** Finish what is being read, and read everything after it at once. */
    release() {
      tts.auto = true;
      tts.held.splice(0).forEach((u) => u.onend?.());
    },
  };
  class FakeUtterance implements Utterance {
    voice = null;
    rate = 1;
    volume = 1;
    onstart: Handler = null;
    onend: Handler = null;
    onerror: Handler = null;
    text: string;
    constructor(text: string) {
      this.text = text;
    }
  }
  w.__tts = tts;
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, writable: true, value: FakeUtterance });
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      speak(u: Utterance) {
        if (u.text.trim()) tts.spoken.push(u.text);
        setTimeout(() => {
          u.onstart?.();
          if (!u.text.trim() || tts.auto) u.onend?.();
          else tts.held.push(u);
        }, 10);
      },
      cancel() {
        tts.held = [];
      },
      getVoices: () => [],
    },
  });

  if (fakeAudio) {
    const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
    const node = () => ({ connect: (n: unknown) => n, disconnect() {} });
    class FakeAudioContext {
      state = 'suspended';
      sampleRate = 48000;
      currentTime = 0;
      destination = node();
      async resume() {
        this.state = 'running';
      }
      async close() {
        this.state = 'closed';
      }
      createOscillator() {
        return { ...node(), frequency: param(), start() {}, stop() {} };
      }
      createGain() {
        return { ...node(), gain: param() };
      }
    }
    Object.defineProperty(window, 'AudioContext', { configurable: true, writable: true, value: FakeAudioContext });
  } else if (navigator.mediaDevices) {
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const out = ctx.createMediaStreamDestination();
      osc.connect(out);
      osc.start();
      return out.stream;
    };
  }
}
