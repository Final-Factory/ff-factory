// A worker machine's GPU Whisper for the portal's mic (w615, docs/voice.md "Whisper on a worker's GPU"). Part of the
// daemon, off unless daemon.json `voice.enabled`: it installs faster-whisper and the model under <root>/voice, keeps the
// model loaded on the GPU, and transcribes the clips the portal sends over the daemon's own link (`transcribe`). It is
// the portal's own engine (server/voice.ts PyWorker, server/voiceSetup.ts, server/voice/worker.py), run here.
//
// VRAM is shared with the machine's Unity editors: it loads only with minFreeVramMiB free, and an idle loaded model is
// unloaded when free VRAM falls under yieldBelowMiB. A refused or failed clip is answered with an error at once, and the
// portal transcribes it on its own CPU. Audio and text are never logged or written to disk here.
import fs from 'node:fs';
import path from 'node:path';
import { PyWorker } from '../server/voice.ts';
import { VOICE_DEFAULTS, type VoiceConfig } from '../server/config.ts';
import { WORKER, modelDir, setupNeeded, setupRunning, setupVoice, voicePaths } from '../server/voiceSetup.ts';
import { wavSeconds, type RemoteVoiceStatus } from '../shared/voice.ts';
import type { HostStats } from '../shared/types.ts';

/** daemon.json `voice` (docs/voice.md has the table). Everything but `enabled` has a default. */
export interface DaemonVoiceSettings {
  enabled: boolean;
  /** A faster-whisper model name; default large-v3-turbo (what BEAST's portal ran before the move). */
  model?: string;
  /** cuda (default): the GPU only. A worker's CPU belongs to its agents and builds; the portal's VM is the CPU fallback. */
  device?: 'cuda' | 'auto' | 'cpu';
  computeType?: string;
  /** Default <root>/voice (<app_dir>/voice without a worker root). */
  toolsDir?: string;
  language?: string;
  /**
   * Load the model only with this much VRAM free (default 3072: the model's ~1.1 GB, room for an editor to grow, and
   * more than yieldBelowMiB plus the model, so an unload for the editors is not followed by a reload at once).
   */
  minFreeVramMiB?: number;
  /** Unload an idle loaded model when free VRAM falls under this (default 1024). */
  yieldBelowMiB?: number;
  /** 0 (default): kept loaded. Otherwise unloaded after this many minutes unused. */
  idleMinutes?: number;
  /** Install or update the tools in the background at start when they are missing or stale (default true). */
  autoInstall?: boolean;
  /** A uv executable (default: uv on PATH, else one downloaded into toolsDir). */
  uvPath?: string;
  /** CPU threads for a CPU load (device auto or cpu). */
  cpuThreads?: number;
}

export const DAEMON_VOICE_DEFAULTS = { model: 'large-v3-turbo', device: 'cuda', minFreeVramMiB: 3072, yieldBelowMiB: 1024, idleMinutes: 0 } as const;

/** After a load that failed (not a VRAM refusal), the stats tick tries again only this much later. */
export const RELOAD_AFTER_FAILURE_MS = { value: 10 * 60_000 };

/** The largest clip the daemon takes: the portal's 300 s limit at 16 kHz 16-bit mono, with room for a header. */
export const MAX_REMOTE_WAV_BYTES = 10 * 1024 * 1024;

/** The portal-style VoiceConfig the shared setup and worker code read. Exported for tests. */
export function voiceConfigOf(s: DaemonVoiceSettings, home: string): VoiceConfig {
  return {
    ...VOICE_DEFAULTS,
    enabled: !!s.enabled,
    model: s.model || DAEMON_VOICE_DEFAULTS.model,
    device: s.device ?? DAEMON_VOICE_DEFAULTS.device,
    ...(s.computeType ? { computeType: s.computeType } : {}),
    language: s.language ?? 'en',
    toolsDir: s.toolsDir || path.join(home, 'voice'),
    idleMinutes: s.idleMinutes ?? DAEMON_VOICE_DEFAULTS.idleMinutes,
    autoInstall: s.autoInstall ?? true,
    ...(s.uvPath ? { uvPath: s.uvPath } : {}),
    ...(s.cpuThreads ? { cpuThreads: s.cpuThreads } : {}),
    // Speech-to-text only: replies are read by the portal or the browser.
    tts: false,
  };
}

/** Free VRAM from the daemon's stats, MiB; undefined when it has no discrete GPU reading. Exported for tests. */
export function freeVramMiB(stats: HostStats | undefined): number | undefined {
  const g = stats?.gpu;
  if (!g || g.unified || !(g.memTotalMiB > 0)) return undefined;
  return g.memTotalMiB - g.memUsedMiB;
}

/** What runs the model: the portal's PyWorker; tests give a fake. */
export interface VoiceEngine {
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly busy: boolean;
  device?: string;
  lastError?: string;
  start(): Promise<void>;
  request(msg: Record<string, unknown>): Promise<Record<string, unknown>>;
  unload(why?: string): void;
}

export interface TranscribeAsk {
  audio: string;
  prompt?: string;
  language?: string | null;
}

export interface TranscribeAnswer {
  text: string;
  audioSeconds: number;
  seconds: number;
  model: string;
  device: string;
  /** Set when this clip had to wait for the model to load. */
  loadSeconds?: number;
}

export interface DaemonVoiceDeps {
  log: (s: string) => void;
  /** The daemon's last host stats (15 s old at most), for the GPU's free memory. */
  stats: () => HostStats | undefined;
  /** The machine's state changed: the daemon sends the portal a `voice` status. */
  changed: () => void;
  engine?: VoiceEngine;
  /** Install the tools (tests skip it). */
  setup?: (v: VoiceConfig, log: (s: string) => void) => Promise<void>;
  /** Why the tools need installing, or null (tests fake it). */
  needed?: (v: VoiceConfig) => string | null;
  /** The GPU's used memory right now, MiB (nvidia-smi), to measure the model's share; tests fake it. */
  vramUsedNow?: () => Promise<number | undefined>;
}

export class DaemonVoice {
  readonly v: VoiceConfig;
  private readonly s: DaemonVoiceSettings;
  private readonly deps: DaemonVoiceDeps;
  readonly engine: VoiceEngine;
  private installing = false;
  private installError?: string;
  /** Why the last load was refused or failed (VRAM, an error); cleared by a load that works. */
  private refused?: string;
  private vramMiB?: number;
  private lastSent = '';
  /** When a load last failed (an error, not VRAM): the stats tick waits RELOAD_AFTER_FAILURE_MS before it tries again. */
  private failedAt = 0;
  private loadError?: string;

  constructor(settings: DaemonVoiceSettings, home: string, deps: DaemonVoiceDeps) {
    this.s = settings;
    this.v = voiceConfigOf(settings, home);
    this.deps = deps;
    this.engine =
      deps.engine ??
      new PyWorker(
        'Whisper',
        () => {
          const args = [WORKER, '--model', modelDir(this.v), '--threads', String(this.v.cpuThreads)];
          if (this.v.computeType) args.push('--compute-type', this.v.computeType);
          return { python: voicePaths(this.v).python, args, device: this.v.device };
        },
        () => this.v.idleMinutes,
      );
  }

  private get minFree() {
    return this.s.minFreeVramMiB ?? DAEMON_VOICE_DEFAULTS.minFreeVramMiB;
  }
  private get yieldBelow() {
    return this.s.yieldBelowMiB ?? DAEMON_VOICE_DEFAULTS.yieldBelowMiB;
  }
  private needed(): string | null {
    return (this.deps.needed ?? setupNeeded)(this.v);
  }

  status(): RemoteVoiceStatus {
    const base = { model: this.v.model };
    if (this.installing || (!this.deps.needed && setupRunning(this.v))) return { ...base, state: 'installing', detail: `installing faster-whisper and ${this.v.model} in ${this.v.toolsDir}` };
    const need = this.needed();
    if (need) return { ...base, state: 'unavailable', detail: this.installError ? `setup failed: ${this.installError}` : need };
    if (this.engine.loaded) return { ...base, state: 'ready', device: this.engine.device, ...(this.vramMiB ? { vramMiB: this.vramMiB } : {}) };
    if (this.engine.loading) return { ...base, state: 'loading' };
    const err = this.loadError ?? this.engine.lastError;
    const why = this.refused ?? (err ? `last error: ${err}` : undefined);
    return { ...base, state: 'idle', ...(why ? { detail: why } : {}), ...(this.refused ? { vramShort: true } : {}) };
  }

  /** Tell the daemon when the status a portal sees changed. */
  private notify() {
    const s = JSON.stringify(this.status());
    if (s === this.lastSent) return;
    this.lastSent = s;
    this.deps.changed();
  }

  /**
   * At start: install in the background if needed. The model loads at the first stats tick that shows the VRAM for it
   * (onStats), not before: until then the daemon has no reading of the GPU.
   */
  start() {
    if (this.v.autoInstall && this.needed() && !(!this.deps.needed && setupRunning(this.v))) void this.install();
  }

  async install() {
    if (this.installing) return;
    this.installing = true;
    this.installError = undefined;
    this.notify();
    const file = voicePaths(this.v).log;
    const say = (s: string) => {
      this.deps.log(`voice: ${s}`);
      try {
        fs.mkdirSync(this.v.toolsDir, { recursive: true });
        fs.appendFileSync(file, `${new Date().toISOString()} ${s}\n`);
      } catch {
        /* the log is a convenience */
      }
    };
    try {
      await (this.deps.setup ?? ((v, l) => setupVoice(v, l)))(this.v, say);
    } catch (e) {
      this.installError = (e as Error).message.split('\n').slice(-3).join(' ').slice(0, 400);
      say(`setup failed: ${(e as Error).message}`);
    } finally {
      this.installing = false;
      this.notify();
    }
  }

  /** Load the model unless it is loaded, VRAM is short, or the tools are not there. Throws why not. */
  async load(): Promise<void> {
    if (this.engine.loaded) return;
    const st = this.status();
    if (st.state === 'installing' || st.state === 'unavailable') throw new Error(`Whisper on this machine is ${st.state}${st.detail ? `: ${st.detail}` : ''}`);
    if (!this.engine.loading) {
      const free = freeVramMiB(this.deps.stats());
      if (this.v.device !== 'cpu' && free !== undefined && free < this.minFree) {
        this.refused = `not enough free VRAM: ${free} MiB, it loads with ${this.minFree}`;
        this.notify();
        throw new Error(this.refused);
      }
    }
    const before = this.engine.loading ? undefined : await this.vramUsed();
    try {
      await this.engine.start();
    } catch (e) {
      this.refused = undefined;
      this.failedAt = Date.now();
      this.loadError = (e as Error).message.slice(0, 300);
      this.deps.log(`voice: ${this.v.model} did not load: ${(e as Error).message.slice(0, 300)}`);
      this.notify();
      throw e;
    }
    const after = before === undefined ? undefined : await this.vramUsed();
    if (before !== undefined && after !== undefined && after > before) this.vramMiB = after - before;
    this.refused = undefined;
    this.loadError = undefined;
    this.deps.log(`voice: ${this.v.model} loaded on ${this.engine.device}${this.vramMiB ? `, ~${this.vramMiB} MiB VRAM` : ''}`);
    this.notify();
  }

  private async vramUsed(): Promise<number | undefined> {
    if (this.deps.vramUsedNow) return this.deps.vramUsedNow();
    const { run } = await import('../server/proc.ts');
    const r = await run('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { timeoutMs: 5000 });
    const n = r.code === 0 ? Number(r.stdout.trim().split(/\r?\n/)[0]) : NaN;
    return Number.isFinite(n) ? n : undefined;
  }

  /** The portal's warm-up (a recording started): load now so the clip does not wait. */
  warm() {
    if (!this.engine.loaded && !this.engine.loading) void this.load().catch(() => {});
  }

  /** One clip. Throws (the portal then uses its own CPU) when it cannot be done here. */
  async transcribe(ask: TranscribeAsk): Promise<TranscribeAnswer> {
    if (typeof ask.audio !== 'string' || !ask.audio) throw new Error('no audio');
    // Base64 is 4/3 of the bytes: check the size before decoding.
    if ((ask.audio.length * 3) / 4 > MAX_REMOTE_WAV_BYTES) throw new Error(`the clip is over ${MAX_REMOTE_WAV_BYTES >> 20} MB`);
    if (wavSeconds(Buffer.from(ask.audio, 'base64')) === undefined) throw new Error('expected a 16-bit PCM WAV');
    const wasLoaded = this.engine.loaded;
    const t0 = Date.now();
    await this.load();
    const loadSeconds = wasLoaded ? undefined : (Date.now() - t0) / 1000;
    const r = await this.engine.request({ audio: ask.audio, prompt: ask.prompt ?? '', language: ask.language ?? this.v.language ?? null });
    this.notify();
    return {
      text: String(r.text ?? ''),
      audioSeconds: Number(r.audioSeconds ?? 0),
      seconds: Number(r.seconds ?? 0),
      model: this.v.model,
      device: this.engine.device ?? '?',
      ...(loadSeconds !== undefined ? { loadSeconds } : {}),
    };
  }

  /**
   * Every stats tick (15 s): give the VRAM back to the editors when it is tight and the model is idle, and report a
   * worker that died. A clip being transcribed is never cut off.
   */
  onStats() {
    const free = freeVramMiB(this.deps.stats());
    if (this.engine.loaded && !this.engine.busy && free !== undefined && free < this.yieldBelow && this.v.device !== 'cpu') {
      this.deps.log(`voice: free VRAM ${free} MiB is under ${this.yieldBelow}: unloading Whisper for the editors`);
      this.engine.unload('VRAM needed');
      this.vramMiB = undefined;
      this.refused = `unloaded for the editors: ${free} MiB VRAM free`;
    } else if (this.v.idleMinutes === 0 && !this.engine.loaded && !this.engine.loading && !this.installing && Date.now() - this.failedAt >= RELOAD_AFTER_FAILURE_MS.value && !this.needed()) {
      // Kept loaded: load at start, and again once there is room (load refuses, quietly, while VRAM is short).
      void this.load().catch(() => {});
    }
    this.notify();
  }

  stop(why = 'daemon stopping') {
    this.engine.unload(why);
  }
}

