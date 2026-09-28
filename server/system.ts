import os from 'node:os';
import fs from 'node:fs';
import type { Config } from './config.ts';
import type { HostStats, SystemStats } from '../shared/types.ts';
import { run } from './proc.ts';

/**
 * A computer's load: CPU, RAM, disk and GPU. The portal measures its own host with it, and each machine
 * daemon (machine/daemon.ts) measures its Mac with the same code and reports it (protocol 4). The parsers
 * of the tools' output are pure and tested in system.test.ts.
 */

let lastCpu = os.cpus();

function cpuLoadPct() {
  const now = os.cpus();
  let idle = 0;
  let total = 0;
  now.forEach((c, i) => {
    const p = lastCpu[i]?.times ?? c.times;
    const d = (k: keyof typeof c.times) => c.times[k] - p[k];
    const t = d('user') + d('nice') + d('sys') + d('idle') + d('irq');
    idle += d('idle');
    total += t;
  });
  lastCpu = now;
  return total > 0 ? Math.round(100 * (1 - idle / total)) : 0;
}

/** nvidia-smi --query-gpu=name,memory.total,memory.used,utilization.gpu --format=csv,noheader,nounits */
export function parseNvidiaSmi(out: string): HostStats['gpu'] {
  const line = out.trim().split('\n')[0];
  if (!line) return undefined;
  const [name, total, used, util] = line.split(',').map((s) => s.trim());
  const n = [total, used, util].map(Number);
  if (!name || n.some((x) => !Number.isFinite(x))) return undefined;
  return { name, memTotalMiB: n[0], memUsedMiB: n[1], utilPct: n[2] };
}

/**
 * Apple Silicon's GPU from `ioreg -r -d 1 -c IOAccelerator` (no sudo): the model name and its
 * PerformanceStatistics, "Device Utilization %" and "In use system memory" (bytes of the shared RAM the GPU
 * holds). The GPU has no memory of its own, so the total is all of RAM.
 */
export function parseIoregGpu(out: string, memTotalBytes: number): HostStats['gpu'] {
  const util = /"Device Utilization %"\s*=\s*(\d+)/.exec(out);
  if (!util) return undefined;
  const inUse = /"In use system memory"\s*=\s*(\d+)/.exec(out);
  const model = /"model"\s*=\s*"([^"]+)"/.exec(out);
  return {
    name: model?.[1] ?? 'Apple GPU',
    memTotalMiB: Math.round(memTotalBytes / 2 ** 20),
    memUsedMiB: inUse ? Math.round(Number(inUse[1]) / 2 ** 20) : 0,
    utilPct: Number(util[1]),
    unified: true,
  };
}

/**
 * macOS memory from `vm_stat`. os.freemem() counts only free pages there, and macOS keeps nearly all
 * spare RAM as file cache, so "total minus free" reads 90%+ on an idle Mac. Used here is what Activity
 * Monitor calls Memory Used: app memory (anonymous pages less purgeable ones) + wired + compressed.
 */
export function parseVmStat(out: string, memTotalBytes: number): { usedBytes: number; freeBytes: number } | undefined {
  const pageSize = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? NaN);
  const pages = (label: string) => {
    const m = new RegExp(`^${label}:\\s+(\\d+)\\.?`, 'm').exec(out);
    return m ? Number(m[1]) : undefined;
  };
  const wired = pages('Pages wired down');
  const compressed = pages('Pages occupied by compressor');
  if (!Number.isFinite(pageSize) || wired === undefined || compressed === undefined) return undefined;
  const anonymous = pages('Anonymous pages');
  // Older macOS has no "Anonymous pages": active pages are the nearest stand-in.
  const app = anonymous !== undefined ? anonymous - (pages('Pages purgeable') ?? 0) : (pages('Pages active') ?? 0);
  const usedBytes = Math.min(memTotalBytes, Math.max(0, (app + wired + compressed) * pageSize));
  return { usedBytes, freeBytes: memTotalBytes - usedBytes };
}

/** kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical. */
export function parsePressure(out: string): HostStats['memPressure'] {
  const n = Number(out.trim());
  return n === 1 ? 'normal' : n === 2 ? 'warn' : n === 4 ? 'critical' : undefined;
}

async function gpu(memTotalBytes: number): Promise<HostStats['gpu']> {
  if (process.platform === 'darwin') {
    const r = await run('ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator'], { timeoutMs: 5000 });
    return r.code === 0 ? parseIoregGpu(r.stdout, memTotalBytes) : undefined;
  }
  const r = await run('nvidia-smi', ['--query-gpu=name,memory.total,memory.used,utilization.gpu', '--format=csv,noheader,nounits'], { timeoutMs: 5000 });
  return r.code === 0 ? parseNvidiaSmi(r.stdout) : undefined;
}

async function memory(): Promise<Pick<HostStats, 'memTotalBytes' | 'memFreeBytes' | 'memUsedBytes' | 'memPressure'>> {
  const memTotalBytes = os.totalmem();
  if (process.platform !== 'darwin') return { memTotalBytes, memFreeBytes: os.freemem() };
  const [vm, pressure] = await Promise.all([run('vm_stat', [], { timeoutMs: 5000 }), run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { timeoutMs: 5000 })]);
  const m = vm.code === 0 ? parseVmStat(vm.stdout, memTotalBytes) : undefined;
  return {
    memTotalBytes,
    memFreeBytes: m?.freeBytes ?? os.freemem(),
    memUsedBytes: m?.usedBytes,
    memPressure: pressure.code === 0 ? parsePressure(pressure.stdout) : undefined,
  };
}

/** This computer's load; disk is the volume holding `diskPath`. */
export async function hostStats(diskPath: string): Promise<HostStats> {
  let diskTotalBytes: number | undefined;
  let diskFreeBytes: number | undefined;
  try {
    const s = await fs.promises.statfs(diskPath);
    diskTotalBytes = s.blocks * s.bsize;
    diskFreeBytes = s.bavail * s.bsize;
  } catch {
    // statfs is unavailable on some filesystems; the UI hides the meter
  }
  const mem = await memory();
  return {
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
    cpuModel: os.cpus()[0]?.model ?? 'unknown',
    cpuCount: os.cpus().length,
    loadPct: cpuLoadPct(),
    ...mem,
    diskTotalBytes,
    diskFreeBytes,
    gpu: await gpu(mem.memTotalBytes),
  };
}

export async function systemStats(cfg: Config): Promise<SystemStats> {
  const target = fs.existsSync(cfg.sandboxRoot) ? cfg.sandboxRoot : cfg.dataDir;
  return { ...(await hostStats(target)), limits: cfg.limits };
}

/** Memory in use: the OS monitor's figure where known (macOS), else total minus free. */
export const memUsed = (s: Pick<HostStats, 'memTotalBytes' | 'memFreeBytes' | 'memUsedBytes'>) => s.memUsedBytes ?? s.memTotalBytes - s.memFreeBytes;

const gb = (b?: number) => (b === undefined ? '?' : `${(b / 2 ** 30).toFixed(0)} GB`);

/** A computer's load for system_status: "BEAST (win32 10.0), <cpu> x32: CPU 38%, RAM 91/128 GB used, ...". */
export function statsLine(name: string, s: HostStats): string {
  const gpuPart = !s.gpu
    ? 'GPU n/a'
    : s.gpu.unified
      ? `GPU ${s.gpu.name} ${s.gpu.utilPct}% busy, ${(s.gpu.memUsedMiB / 1024).toFixed(1)} GB of the shared RAM in use`
      : `GPU ${s.gpu.name}: VRAM ${s.gpu.memUsedMiB}/${s.gpu.memTotalMiB} MiB, ${s.gpu.utilPct}% util`;
  return [
    `${name} (${s.platform}), ${s.cpuModel} x${s.cpuCount}: CPU ${s.loadPct}%`,
    `RAM ${gb(memUsed(s))} used of ${gb(s.memTotalBytes)}${s.memPressure ? ` (memory pressure ${s.memPressure})` : ''}`,
    gpuPart,
    `disk free ${gb(s.diskFreeBytes)} of ${gb(s.diskTotalBytes)}`,
  ].join('; ');
}

/** A machine's system_status line: its load, or why there is none. */
export function machineLoadLine(m: { id: string; lastSeen?: string }, stats: HostStats | undefined, online: boolean): string {
  if (stats) return statsLine(m.id, stats);
  if (online) return `${m.id}: online, no load numbers yet (a daemon from before protocol 4 sends none until it is redeployed)`;
  return `${m.id}: offline${m.lastSeen ? ` since ${m.lastSeen.slice(0, 16).replace('T', ' ')} UTC` : ''}`;
}
