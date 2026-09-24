// Voice (docs/voice.md): local speech-to-text for the mic button and hands-free voice mode, and
// local text-to-speech for reading replies aloud in voice mode.
//
// Each engine is one Python worker process (server/voice/worker.py: faster-whisper;
// server/voice/tts_worker.py: Kokoro) holding its model on the GPU. They start on demand (the UI
// asks for a warm-up when recording starts, so the load overlaps the speech) and end after
// voice.idleMinutes unused, which frees their VRAM for the Unity editors. Audio and text go over
// stdin/stdout: nothing is written to disk unless voice.keepAudio (a debug switch) is on.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Config } from './config.ts';
import { TTS_WORKER, WORKER, modelDir, setupNeeded, setupRunning, setupVoice, voicePaths } from './voiceSetup.ts';
import type { TranscribeResult, TtsStatus, VoiceStatus } from '../shared/voice.ts';

const REQUEST_TIMEOUT_MS = 120_000;
const LOAD_TIMEOUT_MS = 180_000;

type Reply = Record<string, unknown> & { id?: number; type?: string; error?: string; device?: string };

interface Pending {
  resolve: (r: Reply) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * One JSON-lines Python worker: started on demand, `ready`/`failed` first, then one reply per
 * request id; unloaded after idle. A GPU load that crashes the process (a missing CUDA DLL aborts
 * rather than raising) is retried once on the CPU.
 */
export class PyWorker {
  private proc?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private idleTimer?: NodeJS.Timeout;
  private cpuOnly = false;
  device?: string;
  info: Reply = {};
  lastError?: string;

  private readonly name: string;
  private readonly command: () => { python: string; args: string[]; device: string };
  private readonly idleMinutes: () => number;

  constructor(name: string, command: () => { python: string; args: string[]; device: string }, idleMinutes: () => number) {
    this.name = name;
    this.command = command;
    this.idleMinutes = idleMinutes;
  }

  get loaded() {
    return !!this.proc && !!this.device;
  }
  get loading() {
    return !!this.proc && !this.device;
  }

  /** Start (if needed) and wait until the model is loaded. */
  async start(): Promise<void> {
    if (!this.proc) this.spawn(this.cpuOnly ? 'cpu' : undefined);
    try {
      await this.ready;
    } catch (e) {
      const { device } = this.command();
      if (device === 'auto' && !this.cpuOnly && /exited/.test((e as Error).message)) {
        this.cpuOnly = true;
        console.warn(`[voice] ${this.name}: the GPU load crashed (${(e as Error).message}); using the CPU`);
        this.spawn('cpu');
        await this.ready;
      } else throw e;
    }
    this.touch();
  }

  async request(msg: Record<string, unknown>): Promise<Reply> {
    await this.start();
    const proc = this.proc!;
    const id = this.nextId++;
    const r = await new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      proc.stdin.write(JSON.stringify({ ...msg, id }) + '\n');
    });
    this.touch();
    if (r.error) throw new Error(String(r.error));
    return r;
  }

  /** End the worker (frees its VRAM). */
  unload(why = 'unload') {
    const proc = this.proc;
    if (!proc) return;
    this.proc = undefined;
    this.device = undefined;
    clearTimeout(this.idleTimer);
    this.failAll(new Error(`${this.name} stopped (${why})`));
    proc.stdin.end();
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill();
    }, 5000).unref();
  }

  private failAll(e: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }

  private touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.proc && this.pending.size === 0) {
        console.log(`[voice] ${this.name} idle ${this.idleMinutes()} min: unloading`);
        this.unload('idle');
      } else this.touch();
    }, this.idleMinutes() * 60_000);
    this.idleTimer.unref();
  }

  private spawn(forceDevice?: string) {
    const c = this.command();
    const args = [...c.args, '--device', forceDevice ?? c.device];
    const proc = spawn(c.python, ['-u', ...args], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' },
    });
    this.proc = proc;
    this.device = undefined;
    const stderr: string[] = [];
    let onReady!: () => void;
    let onFail!: (e: Error) => void;
    this.ready = new Promise<void>((res, rej) => {
      onReady = res;
      onFail = rej;
    });
    this.ready.catch(() => {}); // observed by start(); never an unhandled rejection
    const loadTimer = setTimeout(() => {
      onFail(new Error(`${this.name}: model load timed out`));
      if (this.proc === proc) this.unload('load timed out');
    }, LOAD_TIMEOUT_MS);
    const t0 = Date.now();
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      let m: Reply;
      try {
        m = JSON.parse(line);
      } catch {
        return; // a library printing to stdout
      }
      if (m.type === 'ready') {
        clearTimeout(loadTimer);
        if (this.proc !== proc) return;
        this.device = m.device;
        this.info = m;
        this.lastError = undefined;
        console.log(`[voice] ${this.name} loaded on ${m.device} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
        onReady();
        return;
      }
      if (m.type === 'failed') {
        clearTimeout(loadTimer);
        this.lastError = m.error;
        onFail(new Error(m.error ?? `${this.name}: model failed to load`));
        return;
      }
      const pend = m.id !== undefined ? this.pending.get(m.id) : undefined;
      if (!pend) return;
      this.pending.delete(m.id!);
      clearTimeout(pend.timer);
      pend.resolve(m);
    });
    readline.createInterface({ input: proc.stderr }).on('line', (line) => {
      stderr.push(line);
      if (stderr.length > 30) stderr.shift();
    });
    const died = (why: string) => {
      clearTimeout(loadTimer);
      const tail = stderr.filter((l) => l.trim()).slice(-3).join(' | ');
      const msg = `${this.name} worker ${why}${tail ? `: ${tail}` : ''}`;
      if (this.proc === proc) {
        if (!this.device) this.lastError = msg;
        this.proc = undefined;
        this.device = undefined;
        this.failAll(new Error(msg));
      }
      onFail(new Error(msg));
    };
    proc.on('error', (e) => died(`could not start (${e.message})`));
    proc.on('exit', (code) => died(`exited (${code})`));
  }
}

export class VoiceService {
  private readonly cfg: Config;
  private installing = false;
  private installError?: string;
  private readonly prompt: () => string;
  readonly stt: PyWorker;
  readonly tts: PyWorker;

  constructor(cfg: Config, prompt: () => string) {
    this.cfg = cfg;
    this.prompt = prompt;
    const idle = () => this.v.idleMinutes;
    this.stt = new PyWorker(
      'Whisper',
      () => {
        const args = [WORKER, '--model', modelDir(this.v), '--threads', String(this.v.cpuThreads)];
        if (this.v.computeType) args.push('--compute-type', this.v.computeType);
        return { python: voicePaths(this.v).python, args, device: this.v.device };
      },
      idle,
    );
    this.tts = new PyWorker(
      'Kokoro',
      () => {
        const p = voicePaths(this.v);
        return { python: p.ttsPython, args: [TTS_WORKER, '--model', p.kokoroModel, '--voices', p.kokoroVoices], device: this.v.ttsDevice };
      },
      idle,
    );
  }

  private get v() {
    return this.cfg.voice;
  }

  status(): VoiceStatus {
    const base = { model: this.v.model, tts: this.ttsStatus() };
    if (!this.v.enabled) return { ...base, state: 'unavailable', detail: 'turned off in config.json (voice.enabled)' };
    if (this.installing || setupRunning(this.v)) return { ...base, state: 'installing', detail: 'first-time setup: downloading Whisper and its model' };
    const need = setupNeeded(this.v, 'stt');
    if (need) return { ...base, state: 'unavailable', detail: this.installError ? `setup failed: ${this.installError}` : `${need}: run npm run voice-setup` };
    if (this.stt.loaded) return { ...base, state: 'ready', device: this.stt.device };
    if (this.stt.loading) return { ...base, state: 'loading' };
    return { ...base, state: 'idle', ...(this.stt.lastError ? { detail: `last error: ${this.stt.lastError}` } : {}) };
  }

  private ttsStatus(): TtsStatus {
    const voice = this.v.ttsVoice;
    if (!this.v.enabled || !this.v.tts) return { state: 'unavailable', voice, detail: 'turned off in config.json (voice.tts)' };
    if (this.installing || setupRunning(this.v)) return { state: 'installing', voice };
    const need = setupNeeded(this.v, 'tts');
    if (need) return { state: 'unavailable', voice, detail: this.installError ? `setup failed: ${this.installError}` : need };
    if (this.tts.loaded) return { state: 'ready', voice, device: this.tts.device, voices: this.tts.info.voices as string[] | undefined };
    if (this.tts.loading) return { state: 'loading', voice };
    return { state: 'idle', voice, ...(this.tts.lastError ? { detail: `last error: ${this.tts.lastError}` } : {}) };
  }

  /** At startup: install the tools in the background if they are missing or stale. */
  autoInstall(log: (s: string) => void = (s) => console.log(`[voice] ${s}`)) {
    if (!this.v.enabled || !this.v.autoInstall || !setupNeeded(this.v) || setupRunning(this.v)) return;
    void this.install(log);
  }

  async install(log: (s: string) => void = (s) => console.log(`[voice] ${s}`)) {
    if (this.installing) return;
    this.installing = true;
    this.installError = undefined;
    const file = voicePaths(this.v).log;
    const both = (s: string) => {
      log(s);
      try {
        fs.appendFileSync(file, `${new Date().toISOString()} ${s}\n`);
      } catch {
        /* the log is a convenience */
      }
    };
    try {
      await setupVoice(this.v, both);
    } catch (e) {
      this.installError = (e as Error).message.split('\n').slice(-3).join(' ').slice(0, 400);
      both(`setup failed: ${(e as Error).message}`);
    } finally {
      this.installing = false;
    }
  }

  /**
   * Start loading models now so the next request is fast: Whisper when recording starts; Kokoro too
   * when voice mode is on (`tts`), since a reply will be read.
   */
  warm(opts: { tts?: boolean } = {}): VoiceStatus {
    const s = this.status();
    if (s.state === 'idle') this.stt.start().catch(() => {}); // the error shows in status and the next request
    if (opts.tts && s.tts.state === 'idle') this.tts.start().catch(() => {});
    return this.status();
  }

  async transcribe(wav: Buffer): Promise<TranscribeResult> {
    const t0 = Date.now();
    const s = this.status();
    if (s.state === 'unavailable' || s.state === 'installing') throw new Error(`local Whisper is ${s.state}${s.detail ? `: ${s.detail}` : ''}`);
    if (this.v.keepAudio) this.keep(wav, t0);
    const r = await this.stt.request({ audio: wav.toString('base64'), prompt: this.prompt(), language: this.v.language || null });
    const text = String(r.text ?? '');
    if (this.v.keepAudio) this.keep(Buffer.from(text, 'utf8'), t0, '.txt');
    return { text, audioSeconds: Number(r.audioSeconds ?? 0), seconds: Number(r.seconds ?? 0), model: this.v.model, device: this.stt.device ?? '?', totalSeconds: (Date.now() - t0) / 1000 };
  }

  /** Text -> a 16-bit mono WAV (24 kHz), plus timings. */
  async speak(text: string, voice?: string, speed?: number): Promise<{ wav: Buffer; seconds: number; audioSeconds: number; device: string }> {
    const s = this.ttsStatus();
    if (s.state === 'unavailable' || s.state === 'installing') throw new Error(`local text-to-speech is ${s.state}${s.detail ? `: ${s.detail}` : ''}`);
    const r = await this.tts.request({ text, voice: voice || this.v.ttsVoice, speed: speed ?? 1 });
    return { wav: Buffer.from(String(r.audio ?? ''), 'base64'), seconds: Number(r.seconds ?? 0), audioSeconds: Number(r.audioSeconds ?? 0), device: this.tts.device ?? '?' };
  }

  /** End both workers (frees their VRAM). */
  unload(why = 'unload') {
    this.stt.unload(why);
    this.tts.unload(why);
  }

  private keep(data: Buffer, t0: number, ext = '.wav') {
    try {
      const dir = path.join(this.cfg.dataDir, 'voice-debug');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${new Date(t0).toISOString().replace(/[:.]/g, '-')}${ext}`), data);
    } catch (e) {
      console.warn('[voice] could not keep the clip:', (e as Error).message);
    }
  }
}
