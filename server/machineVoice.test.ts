// w615: a worker machine's GPU Whisper for the portal's mic (machine/voice.ts, docs/voice.md "Whisper on a worker's GPU").
// The daemon's side with a fake engine, and the whole path: the portal's VoiceService through MachineManager and the
// real WebSocket to a Daemon, with the portal's own Whisper as the fallback when the machine is gone, slow, failing or
// short of VRAM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from './store.ts';
import { SessionManager } from './sessions.ts';
import { MachineManager, VOICE_PING_MS, VOICE_RETRY_MS } from './machines.ts';
import { VoiceService } from './voice.ts';
import { VOICE_DEFAULTS, VOICE_REMOTE_DEFAULTS, type Config, type VoiceConfig } from './config.ts';
import { modelDir, requirementsHash, voicePaths } from './voiceSetup.ts';
import { Daemon, type Probes } from '../machine/daemon.ts';
import { DaemonVoice, MAX_REMOTE_WAV_BYTES, freeVramMiB, voiceConfigOf, type VoiceEngine } from '../machine/voice.ts';
import { encodeWav } from '../shared/voice.ts';
import type { HostStats } from '../shared/types.ts';

process.env.FF_UNITY_SLOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-slots-'));

const until = async (what: string, cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** A Windows PC with a 16 GB card: `used` MiB of it in use. */
const pcStats = (used: number): HostStats => ({
  hostname: 'beast',
  platform: 'win32',
  cpuModel: 'i9',
  cpuCount: 32,
  loadPct: 10,
  memTotalBytes: 64 * 2 ** 30,
  memFreeBytes: 40 * 2 ** 30,
  memUsedBytes: 24 * 2 ** 30,
  memPressure: 'normal',
  gpu: { name: 'RTX 4080 SUPER', memTotalMiB: 16376, memUsedMiB: used, utilPct: 5 },
});

/** The model, without Python: loads at once (or when `gate` opens), answers "gpu text", or hangs or fails on cue. */
class FakeEngine implements VoiceEngine {
  loaded = false;
  loading = false;
  busy = false;
  device?: string;
  lastError?: string;
  starts = 0;
  unloads: string[] = [];
  requests: Record<string, unknown>[] = [];
  mode: 'ok' | 'hang' | 'fail' = 'ok';
  async start() {
    if (this.loaded) return;
    this.starts++;
    this.loading = true;
    await new Promise((r) => setTimeout(r, 5));
    this.loading = false;
    this.loaded = true;
    this.device = 'cuda';
  }
  async request(msg: Record<string, unknown>) {
    this.requests.push(msg);
    this.busy = true;
    try {
      if (this.mode === 'hang') await new Promise((r) => setTimeout(r, 60_000).unref());
      if (this.mode === 'fail') throw new Error('CUDA out of memory');
      return { text: 'gpu text', audioSeconds: 1, seconds: 0.2 };
    } finally {
      this.busy = false;
    }
  }
  unload(why = 'unload') {
    this.unloads.push(why);
    this.loaded = false;
    this.device = undefined;
  }
}

const SETTINGS = { enabled: true } as const;
const clip = (seconds = 1) => Buffer.from(encodeWav(new Float32Array(16000 * seconds)));

function daemonVoice(used: { mib: number }, engine = new FakeEngine(), needed: string | null = null) {
  const changes: string[] = [];
  const v = new DaemonVoice(SETTINGS, '/root', {
    log: () => {},
    stats: () => pcStats(used.mib),
    changed: () => changes.push(v.status().state),
    engine,
    needed: () => needed,
    setup: async () => {},
    vramUsedNow: async () => used.mib + (engine.loaded ? 1161 : 0),
  });
  return { v, engine, changes };
}

test('w615: daemon.json voice: off unless enabled; large-v3-turbo on the GPU only, tools in <root>/voice, no TTS', () => {
  const v = voiceConfigOf({ enabled: true }, path.join('F:', 'ffw'));
  assert.equal(v.model, 'large-v3-turbo');
  assert.equal(v.device, 'cuda');
  assert.equal(v.toolsDir, path.join('F:', 'ffw', 'voice'));
  assert.equal(v.tts, false);
  assert.equal(v.idleMinutes, 0, 'kept loaded');
  assert.equal(voiceConfigOf({ enabled: true, model: 'small.en', toolsDir: '/x' }, '/r').toolsDir, '/x');
  assert.equal(freeVramMiB(pcStats(4000)), 16376 - 4000);
  // A Mac's unified memory is not VRAM the editors and the model compete for in the same way: no reading.
  assert.equal(freeVramMiB({ ...pcStats(0), gpu: { name: 'M4', memTotalMiB: 48000, memUsedMiB: 1000, utilPct: 0, unified: true } }), undefined);
});

test('w615: the daemon loads only with free VRAM, gives it back to the editors when idle, and loads again when there is room', async () => {
  const used = { mib: 15000 };
  const { v, engine } = daemonVoice(used);
  // 1.4 GB free: refused, and the portal is told to go straight to its CPU.
  await assert.rejects(v.load(), /not enough free VRAM: 1376 MiB, it loads with 3072/);
  assert.equal(v.status().state, 'idle');
  assert.equal(v.status().vramShort, true);
  await assert.rejects(v.transcribe({ audio: clip().toString('base64') }), /not enough free VRAM/);
  assert.equal(engine.starts, 0);

  // The editors let go: the next stats tick loads it back, and the model's share is measured.
  used.mib = 3000;
  v.onStats();
  await until('reloaded', () => v.status().state === 'ready');
  assert.equal(v.status().vramMiB, 1161);
  assert.equal(v.status().vramShort, undefined);

  // An editor grows: under 1 GB free, an idle model is unloaded...
  used.mib = 15500;
  v.onStats();
  assert.deepEqual(engine.unloads, ['VRAM needed']);
  assert.equal(v.status().vramShort, true);
  // ...and the 1.1 GB it gave back is not enough to load it again (3072 to load, 1024 to keep): no flapping.
  used.mib = 15500 - 1161;
  v.onStats();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(engine.starts, 1);
  // ...but never one that is transcribing.
  used.mib = 3000;
  v.onStats();
  await until('reloaded again', () => v.status().state === 'ready');
  engine.busy = true;
  used.mib = 15500;
  v.onStats();
  assert.equal(engine.unloads.length, 1);
  assert.equal(v.status().state, 'ready');
});

test('w615: the daemon transcribes a WAV clip, refuses what is not one or too big, and says when it is not installed', async () => {
  const { v, engine } = daemonVoice({ mib: 3000 });
  const r = await v.transcribe({ audio: clip().toString('base64'), prompt: 'Final Factory', language: 'en' });
  assert.equal(r.text, 'gpu text');
  assert.equal(r.device, 'cuda');
  assert.equal(r.model, 'large-v3-turbo');
  assert.ok(r.loadSeconds !== undefined, 'this clip waited for the load');
  assert.deepEqual(engine.requests[0], { audio: clip().toString('base64'), prompt: 'Final Factory', language: 'en' });
  assert.equal((await v.transcribe({ audio: clip().toString('base64') })).loadSeconds, undefined);
  await assert.rejects(v.transcribe({ audio: Buffer.from('not a wav at all, not at all, no').toString('base64') }), /16-bit PCM WAV/);
  await assert.rejects(v.transcribe({ audio: 'A'.repeat(Math.ceil((MAX_REMOTE_WAV_BYTES * 4) / 3) + 8) }), /over 10 MB/);
  await assert.rejects(v.transcribe({ audio: '' }), /no audio/);

  const missing = daemonVoice({ mib: 3000 }, new FakeEngine(), 'not installed').v;
  assert.equal(missing.status().state, 'unavailable');
  await assert.rejects(missing.load(), /unavailable: not installed/);
});

// ---- the whole path: portal VoiceService -> MachineManager -> WebSocket -> Daemon -> engine

function localVoice(tmp: string, over: Partial<VoiceConfig> = {}): VoiceConfig {
  const voice: VoiceConfig = { ...VOICE_DEFAULTS, toolsDir: path.join(tmp, 'tools'), model: 'base.en', device: 'cpu', tts: false, autoInstall: false, remote: { ...VOICE_REMOTE_DEFAULTS }, ...over };
  // The portal's own Whisper, installed (faked: a python file, the model, the stamp).
  const p = voicePaths(voice);
  fs.mkdirSync(path.dirname(p.python), { recursive: true });
  fs.writeFileSync(p.python, '');
  fs.mkdirSync(modelDir(voice), { recursive: true });
  fs.writeFileSync(path.join(modelDir(voice), 'model.bin'), '');
  fs.writeFileSync(p.stamp, JSON.stringify({ requirements: requirementsHash(voice), model: voice.model }));
  return voice;
}

async function setup(opts: { used?: { mib: number }; voice?: Partial<VoiceConfig>; idleMinutes?: number } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-machinevoice-'));
  const voice = localVoice(tmp, opts.voice);
  const cfg = { dataDir: tmp, limits: { maxSessions: 6 }, repo: { url: 'x' }, worker: { effort: 'high' }, voice } as unknown as Config;
  const store = new Store(tmp);
  const mm = new MachineManager(cfg, store, new SessionManager(cfg, store));
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => mm.upgrade(req, socket, head, '127.0.0.1'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { token } = mm.register({ id: 'beast', host: 'beast', purpose: 'unused', status: 'ready', repoPath: tmp, home: tmp, portalUrl: url });
  const used = opts.used ?? { mib: 3000 };
  const probes: Probes = {
    stats: async () => pcStats(used.mib),
    usage: async () => ({ account: {}, reply: { subscription_type: 'max', rate_limits_available: true, rate_limits: { limits: [] } } }),
  };
  const engine = new FakeEngine();
  const d = new Daemon(
    { portalUrl: url, id: 'beast', token, repoPath: tmp, appDir: tmp, claude: 'definitely-not-a-claude-binary', maxEventsFile: null, voice: { enabled: true, ...(opts.idleMinutes ? { idleMinutes: opts.idleMinutes } : {}) } },
    undefined,
    probes,
    undefined,
    undefined,
    { engine, needed: () => null, setup: async () => {}, vramUsedNow: async () => used.mib + (engine.loaded ? 1161 : 0) },
  );
  d.start();
  // The portal's own Whisper: a stand-in for its CPU worker.
  const lines: string[] = [];
  const service = new VoiceService(cfg, () => 'Final Factory', { machines: (o) => mm.voiceMachines(o), transcribe: (m, r, t) => mm.transcribeOn(m, r, t), warm: (m) => mm.warmVoice(m) });
  const localCalls: unknown[] = [];
  Object.assign(service.stt, {
    request: async (msg: unknown) => {
      localCalls.push(msg);
      return { text: 'cpu text', audioSeconds: 1, seconds: 3.1 };
    },
    device: 'cpu',
  });
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(' '));
  const cleanup = async () => {
    console.log = log;
    d.shutdown();
    await until('disconnect', () => !mm.isOnline('beast')).catch(() => undefined);
    server.close();
    await new Promise((r) => setTimeout(r, 300));
    store.flush();
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  await until('the daemon offers its Whisper', () => mm.voiceMachines().length === 1);
  /** A stats tick now, instead of in 15 s. */
  const tick = () => (d as unknown as { reportStats: () => Promise<void> }).reportStats();
  return { tick, mm, d, engine, service, localCalls, lines, used, cleanup, cfg };
}

test('w615: a clip goes to the machine GPU over the daemon link; the result and status say which engine answered', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  await until('loaded at start (kept loaded)', () => s.service.status().state === 'ready');
  const st = s.service.status();
  assert.equal(st.remote?.machine, 'beast');
  assert.equal(st.remote?.state, 'ready');
  assert.equal(st.device, 'cuda');
  assert.equal(st.local?.model, 'base.en');
  const r = await s.service.transcribe(clip(2));
  assert.equal(r.text, 'gpu text');
  assert.equal(r.engine, 'remote');
  assert.equal(r.machine, 'beast');
  assert.equal(r.model, 'large-v3-turbo');
  assert.equal(r.fallback, undefined);
  assert.equal(s.localCalls.length, 0, "the portal's own Whisper never ran");
  assert.equal(s.engine.requests[0].prompt, 'Final Factory');
  assert.equal(s.service.status().last?.engine, 'remote');
  assert.equal(s.service.status().last?.machine, 'beast');
  // One line per clip, with the engine and timings, never the words.
  const line = s.lines.find((l) => l.startsWith('[voice] 1.0 s clip') || l.startsWith('[voice] 2.0 s clip'));
  assert.ok(line, s.lines.join('\n'));
  assert.match(line!, /beast cuda large-v3-turbo/);
  assert.ok(!s.lines.some((l) => l.includes('gpu text')), 'the transcript is never logged');
});

test('w615: the portal falls back to its own CPU when the machine errors, times out or goes offline, and says why', async (t) => {
  const s = await setup({ voice: { remote: { ...VOICE_REMOTE_DEFAULTS, timeoutSeconds: 0.3, perAudioSecond: 0 } } });
  t.after(s.cleanup);
  await until('ready', () => s.service.status().state === 'ready');

  s.engine.mode = 'fail';
  let r = await s.service.transcribe(clip());
  assert.equal(r.engine, 'local');
  assert.equal(r.text, 'cpu text');
  assert.match(r.fallback ?? '', /^beast: CUDA out of memory/);

  s.engine.mode = 'hang';
  const t0 = Date.now();
  r = await s.service.transcribe(clip());
  assert.equal(r.engine, 'local');
  assert.match(r.fallback ?? '', /beast did not answer within 0.3 s/);
  assert.ok(Date.now() - t0 < 2000, 'the timeout holds');
  assert.equal(s.service.status().last?.fallback, r.fallback);

  // The daemon stops (BEAST down): straight to the CPU, no wait.
  s.d.shutdown();
  await until('offline', () => !s.mm.isOnline('beast'));
  assert.equal(s.service.status().remote, undefined);
  assert.equal(s.service.status().state, 'idle', "the portal's own Whisper, not loaded yet");
  r = await s.service.transcribe(clip());
  assert.equal(r.engine, 'local');
  assert.equal(r.fallback, undefined, 'no machine offered it');
  assert.equal(s.localCalls.length, 3);
});

test('w615: a machine short of VRAM is skipped at once; voice.remote off or another machine named keeps clips on the portal', async (t) => {
  const s = await setup({ used: { mib: 15500 } });
  t.after(s.cleanup);
  await until('refused for VRAM', () => s.mm.voiceMachines()[0]?.status.vramShort === true);
  const st = s.service.status();
  assert.equal(st.state, 'idle', "the portal's own engine is what the mic sees");
  assert.equal(st.remote?.vramShort, true);
  const r = await s.service.transcribe(clip());
  assert.equal(r.engine, 'local');
  assert.match(r.fallback ?? '', /beast: Whisper waiting for free VRAM/);
  assert.equal(s.engine.requests.length, 0, 'nothing was sent');

  s.used.mib = 3000;
  await s.tick();
  await until('loaded once there is room', () => s.service.status().state === 'ready');
  s.cfg.voice.remote.enabled = false;
  assert.equal(s.service.status().remote, undefined);
  assert.equal((await s.service.transcribe(clip())).engine, 'local');
  s.cfg.voice.remote = { ...VOICE_REMOTE_DEFAULTS, machines: ['lothdesktop'] };
  assert.equal((await s.service.transcribe(clip())).engine, 'local');
  s.cfg.voice.remote = { ...VOICE_REMOTE_DEFAULTS, machines: ['BEAST'] };
  assert.equal((await s.service.transcribe(clip())).engine, 'remote');
});

test('w615: with the portal own Whisper off, the machine still answers; with both gone the error names both', async (t) => {
  const s = await setup({ voice: { enabled: false } });
  t.after(s.cleanup);
  await until('ready', () => s.service.status().state === 'ready');
  assert.equal((await s.service.transcribe(clip())).engine, 'remote');
  s.engine.mode = 'fail';
  await assert.rejects(s.service.transcribe(clip()), /beast: CUDA out of memory; and local Whisper is unavailable/);
});

test('w615: a recording warms the machine only; the portal loads its own model only when no machine can take the clip', async (t) => {
  // Not kept loaded (idleMinutes 5): it waits for a warm-up.
  const s = await setup({ idleMinutes: 5 });
  t.after(s.cleanup);
  let starts = 0;
  Object.assign(s.service.stt, { start: async () => void starts++ });
  await s.tick();
  assert.equal(s.engine.starts, 0);
  assert.equal(s.service.status().state, 'idle');
  assert.equal(s.service.status().remote?.state, 'idle');
  s.service.warm();
  await until('the daemon loaded it', () => s.engine.starts === 1);
  await until('ready at the portal', () => s.service.status().state === 'ready');
  assert.equal(starts, 0, "the portal's own model stays unloaded");
  s.d.shutdown();
  await until('offline', () => !s.mm.isOnline('beast'));
  s.service.warm();
  assert.equal(starts, 1, "no machine: the portal's own model loads");
});

test('w615: a load that fails is retried by the stats tick only after a while', async () => {
  const { RELOAD_AFTER_FAILURE_MS } = await import('../machine/voice.ts');
  const engine = new FakeEngine();
  let fail = true;
  const start = engine.start.bind(engine);
  engine.start = async () => {
    engine.starts++;
    if (fail) throw new Error('cudnn64_9.dll not found');
    engine.starts--;
    return start();
  };
  const { v } = daemonVoice({ mib: 3000 }, engine);
  v.onStats();
  await until('tried', () => engine.starts === 1);
  await new Promise((r) => setTimeout(r, 10));
  assert.match(v.status().detail ?? '', /cudnn|last error/i);
  v.onStats();
  v.onStats();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(engine.starts, 1, 'no retry every 15 s');
  const was = RELOAD_AFTER_FAILURE_MS.value;
  RELOAD_AFTER_FAILURE_MS.value = 0;
  try {
    fail = false;
    v.onStats();
    await until('loaded on the retry', () => v.status().state === 'ready');
  } finally {
    RELOAD_AFTER_FAILURE_MS.value = was;
  }
});

test('w615: an abrupt drop (no close, no answer) costs one clip the ping wait, not the timeout; later clips go straight to the CPU', async (t) => {
  const s = await setup({ voice: { remote: { ...VOICE_REMOTE_DEFAULTS, timeoutSeconds: 30 } } });
  t.after(s.cleanup);
  await until('ready', () => s.service.status().state === 'ready');
  const was = VOICE_PING_MS.value;
  VOICE_PING_MS.value = 300;
  t.after(() => (VOICE_PING_MS.value = was));
  // BEAST asleep or cut off: its socket stays open, but it reads nothing and answers nothing.
  const sock = (s.d as unknown as { ws: { _socket: { pause(): void; resume(): void } } }).ws._socket;
  sock.pause();
  let t0 = Date.now();
  let r = await s.service.transcribe(clip());
  assert.equal(r.engine, 'local');
  assert.match(r.fallback ?? '', /beast did not answer a ping within 0\.3 s/);
  assert.ok(Date.now() - t0 < 2000, `the ping wait, not the 30 s timeout (${Date.now() - t0} ms)`);
  assert.equal(s.mm.isOnline('beast'), true, 'the heartbeat has not dropped it yet');
  // The next clip does not try it at all.
  t0 = Date.now();
  r = await s.service.transcribe(clip());
  assert.equal(r.engine, 'local');
  assert.equal(r.fallback, undefined, 'no machine is offered');
  assert.ok(Date.now() - t0 < 200, `straight to the CPU (${Date.now() - t0} ms)`);
  assert.equal(s.service.status().remote, undefined);
  // It wakes: anything heard from it (the pong) and it takes clips again.
  sock.resume();
  await until('offered again', () => s.mm.voiceMachines().length === 1);
  r = await s.service.transcribe(clip());
  assert.equal(r.engine, 'remote');
});

test('w615: a clip that timed out on a live link keeps the next ones off that machine until it re-offers or the retry time passes', async (t) => {
  const s = await setup({ voice: { remote: { ...VOICE_REMOTE_DEFAULTS, timeoutSeconds: 0.3, perAudioSecond: 0 } } });
  t.after(s.cleanup);
  await until('ready', () => s.service.status().state === 'ready');
  s.engine.mode = 'hang';
  let r = await s.service.transcribe(clip());
  assert.equal(r.engine, 'local');
  assert.match(r.fallback ?? '', /beast did not answer within 0\.3 s/);
  // The pongs keep coming (its daemon is up), but its Whisper hung: the next clips do not wait on it.
  const sent = s.engine.requests.length;
  const t0 = Date.now();
  for (let i = 0; i < 3; i++) assert.equal((await s.service.transcribe(clip())).engine, 'local');
  assert.ok(Date.now() - t0 < 300, `three clips straight to the CPU (${Date.now() - t0} ms)`);
  assert.equal(s.engine.requests.length, sent, 'nothing more was sent to it');

  // It re-offers (its Whisper reloaded: a status change): back in use at once.
  s.engine.mode = 'ok';
  s.engine.unload('test');
  s.d.voice!.onStats();
  await until('offered again', () => s.mm.voiceMachines().length === 1);
  await until('ready again', () => s.service.status().state === 'ready');
  assert.equal((await s.service.transcribe(clip())).engine, 'remote');

  // Without a re-offer, one clip tries it again after the retry time.
  const was = VOICE_RETRY_MS.value;
  VOICE_RETRY_MS.value = 300;
  t.after(() => (VOICE_RETRY_MS.value = was));
  s.engine.mode = 'hang';
  assert.equal((await s.service.transcribe(clip())).engine, 'local');
  assert.equal(s.mm.voiceMachines().length, 0);
  s.engine.mode = 'ok';
  await new Promise((r2) => setTimeout(r2, 350));
  assert.equal(s.mm.voiceMachines().length, 1, 'tried again after the retry time');
  r = await s.service.transcribe(clip());
  assert.equal(r.engine, 'remote');
});
