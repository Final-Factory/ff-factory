// Measure dictation on a worker's GPU end to end (w615, docs/voice.md "Whisper on a worker's GPU"), with real parts:
// the portal's VoiceService and MachineManager, a real WebSocket, a Daemon with voice on (the real PyWorker on this PC's
// GPU, tools in --gpu-tools), and the portal VM's fallback emulated with --cpu-tools: a CPU model on 2 threads, with
// CTranslate2 held to AVX (the VM's Xeon E5-2680 v2 has no AVX2). Prints the cold start (daemon start to model loaded),
// the clip's latency via the GPU, VRAM and RAM, then stops the daemon and times the fallback.
//
//   node scripts/voice-e2e.ts <clip.wav> --gpu-tools F:/ffw/voice [--cpu-tools <dir with base.en installed>]
//
// The clip is printed as transcribed once per engine: use a test clip, not someone's dictation. It runs a second
// daemon on this PC for a minute (its own temp folder, Unity slots mailbox and no clean-up), and a second copy of the
// model in VRAM while it runs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { parseArgs } from 'node:util';
const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'gpu-tools': { type: 'string' }, 'cpu-tools': { type: 'string' } } });
if (!positionals[0] || !values['gpu-tools']) {
  console.error('usage: node scripts/voice-e2e.ts <clip.wav> --gpu-tools <dir> [--cpu-tools <dir>]');
  process.exit(2);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-e2e-'));
process.env.FF_UNITY_SLOTS = path.join(tmp, 'slots');
process.env.CT2_FORCE_CPU_ISA = 'AVX';
const { Store } = await import('../server/store.ts');
const { SessionManager } = await import('../server/sessions.ts');
const { MachineManager } = await import('../server/machines.ts');
const { VoiceService } = await import('../server/voice.ts');
const { VOICE_DEFAULTS, VOICE_REMOTE_DEFAULTS } = await import('../server/config.ts');
const { Daemon } = await import('../machine/daemon.ts');
const { hostStats } = await import('../server/system.ts');
const { buildVoicePrompt } = await import('../shared/voice.ts');

const vram = () => Number(execSync('nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits').toString().trim());
const workerRam = () => {
  try {
    return execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='python.exe'\\" | ? { $_.CommandLine -like '*worker.py*' } | % { '{0} {1}' -f [math]::Round($_.WorkingSetSize/1MB), ($_.CommandLine -replace '.*--model ([^ ]+).*','$1') }"`).toString().trim().split(/\r?\n/);
  } catch {
    return [];
  }
};
const until = async (what: string, cond: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

const voice = { ...VOICE_DEFAULTS, toolsDir: values['cpu-tools'] ?? path.join(tmp, 'no-cpu-engine'), model: 'base.en', device: 'cpu' as const, cpuThreads: 2, tts: false, autoInstall: false, remote: { ...VOICE_REMOTE_DEFAULTS } };
const cfg = { dataDir: tmp, limits: { maxSessions: 6 }, repo: { url: 'x' }, worker: { effort: 'high' }, voice } as never;
const store = new Store(tmp);
const mm = new MachineManager(cfg, store, new SessionManager(cfg, store));
const server = http.createServer();
server.on('upgrade', (req, socket, head) => mm.upgrade(req, socket, head, '127.0.0.1'));
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const { token } = mm.register({ id: 'beast', host: 'beast', purpose: 'unused', status: 'ready', repoPath: tmp, home: tmp, portalUrl: url });
const prompt = buildVoicePrompt({ sandboxes: [1, 2, 3, 4, 5, 6].map((n) => ({ id: `slot${n}` })), agentNames: [], machines: ['beast', 'lothdesktop', 'm3', 'm5'], specs: [], extra: [] });
const service = new VoiceService(cfg, () => prompt, { machines: (o) => mm.voiceMachines(o), transcribe: (m, r, t) => mm.transcribeOn(m, r, t), warm: (m) => mm.warmVoice(m) });
const wav = fs.readFileSync(positionals[0]);
const out: Record<string, unknown> = { gpuIdleVramMiB: vram() };

const t0 = Date.now();
const d = new Daemon(
  { portalUrl: url, id: 'beast', token, repoPath: tmp, appDir: tmp, tempDir: tmp, claude: 'definitely-not-a-claude-binary', maxEventsFile: null, unitySlotsDir: path.join(tmp, 'slots'), cleanup: { everyMinutes: 0, softFreeGB: 0 }, voice: { enabled: true, toolsDir: values['gpu-tools'], autoInstall: false } },
  undefined,
  { stats: hostStats, usage: async () => ({ account: {}, reply: { subscription_type: 'max', rate_limits_available: true, rate_limits: { limits: [] } } }) },
);
d.start();
await until('the model loaded on the daemon', () => service.status().remote?.state === 'ready', 120_000);
out.coldStartSeconds = (Date.now() - t0) / 1000;
out.remoteStatus = service.status().remote;
out.vramWithModelMiB = vram();

const gpu: unknown[] = [];
for (let i = 0; i < 5; i++) {
  const r = await service.transcribe(wav);
  gpu.push({ engine: r.engine, machine: r.machine, device: r.device, model: r.model, audio: r.audioSeconds, modelSeconds: r.seconds, totalSeconds: r.totalSeconds, ...(i === 0 ? { text: r.text } : {}) });
}
out.viaGpu = gpu;
out.workerRam = workerRam();

// BEAST's side stops (its daemon goes down): the portal's own CPU answers.
d.shutdown();
await until('offline', () => !mm.isOnline('beast'), 10_000);
const cpu: unknown[] = [];
for (let i = 0; i < 3; i++) {
  const r = await service.transcribe(wav);
  cpu.push({ engine: r.engine, device: r.device, model: r.model, audio: r.audioSeconds, modelSeconds: r.seconds, totalSeconds: r.totalSeconds, fallback: r.fallback, ...(i === 0 ? { text: r.text } : {}) });
}
out.fallbackCpu = cpu;
out.fallbackWorkerRam = workerRam();
out.last = service.status().last;
console.log(JSON.stringify(out, null, 1));
service.unload('done');
server.close();
setTimeout(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}, 2000);
