// Microphone capture for local Whisper: raw PCM through Web Audio (not MediaRecorder), downsampled to
// 16 kHz mono and packed as a WAV in the browser. Whisper wants exactly that, so the server needs no
// ffmpeg, and it sidesteps MediaRecorder's per-browser codecs (webm/opus on Chrome, mp4/aac on Safari).
import { downsample, encodeWav, level } from '../../../shared/voice';

// Batches the 128-sample render quanta into ~85 ms messages.
const WORKLET = `
class FfsbTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf); this.buf = new Float32Array(4096); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('ffsb-tap', FfsbTap);
`;

export function canRecord(): boolean {
  return !!navigator.mediaDevices?.getUserMedia && typeof AudioContext !== 'undefined';
}

export class PcmRecorder {
  /** Also the context voice mode plays replies through: one audio session for mic and speaker (iOS). */
  readonly ctx: AudioContext;
  /** Every captured chunk, at ctx.sampleRate, as it arrives (the VAD listens here). */
  onChunk?: (samples: Float32Array) => void;
  /** Off for voice mode's endless stream: chunks are handed to onChunk and not kept. */
  keep = true;
  private stream?: MediaStream;
  private analyser?: AnalyserNode;
  private tap?: AudioNode;
  private readonly chunks: Float32Array[] = [];
  private readonly scratch = new Uint8Array(1024);
  private closed = false;

  /**
   * Must be called from the click/keydown handler itself: iOS only lets an AudioContext start inside
   * a user gesture, so it is created here, before the first await.
   */
  constructor() {
    this.ctx = new AudioContext();
  }

  async start(): Promise<void> {
    const resumed = this.ctx.resume();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (this.closed) return this.release();
    // iOS may keep the context suspended if the gesture did not count: do not wait forever.
    await Promise.race([resumed, new Promise((r) => setTimeout(r, 1500))]);
    if (this.ctx.state !== 'running') {
      this.release();
      throw new DOMException('audio stayed paused', 'AudioSuspended');
    }
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    src.connect(this.analyser);
    // The tap has to reach the destination to be pulled; a zero gain keeps it silent.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    mute.connect(this.ctx.destination);
    try {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(this.ctx, 'ffsb-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      node.port.onmessage = (e) => this.take(e.data as Float32Array);
      this.tap = node;
    } catch {
      // No AudioWorklet (older Safari): the deprecated ScriptProcessor still works everywhere.
      const node = this.ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => this.take(new Float32Array(e.inputBuffer.getChannelData(0)));
      this.tap = node;
    }
    src.connect(this.tap);
    this.tap.connect(mute);
  }

  private take(c: Float32Array) {
    if (this.closed) return;
    if (this.keep) this.chunks.push(c);
    this.onChunk?.(c);
  }

  /** The mic is still delivering (false once the track ended: another app took it, iOS interrupted). */
  get live(): boolean {
    return !this.closed && !!this.stream?.getAudioTracks().some((t) => t.readyState === 'live');
  }

  /** Loudness right now, 0..1, for the meter. */
  level(): number {
    if (!this.analyser) return 0;
    this.analyser.getByteTimeDomainData(this.scratch);
    return level(this.scratch);
  }

  /** Stop and return the clip as a 16 kHz WAV. */
  async stop(): Promise<{ wav: Uint8Array; seconds: number }> {
    // The worklet posts in batches: give the last one a moment to arrive.
    await new Promise((r) => setTimeout(r, 120));
    const rate = this.ctx.sampleRate;
    this.release();
    let n = 0;
    for (const c of this.chunks) n += c.length;
    const all = new Float32Array(n);
    let o = 0;
    for (const c of this.chunks) {
      all.set(c, o);
      o += c.length;
    }
    const pcm = downsample(all, rate);
    return { wav: encodeWav(pcm), seconds: pcm.length / 16000 };
  }

  /** Stop without keeping anything; also turns the browser's mic indicator off. */
  release() {
    this.closed = true;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.tap?.disconnect();
    if (this.ctx.state !== 'closed') void this.ctx.close().catch(() => {});
  }
}

/** Base64 for the JSON upload. */
export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
