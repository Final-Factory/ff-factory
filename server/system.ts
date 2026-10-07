import os from 'node:os';
import fs from 'node:fs';
import type { Config } from './config.ts';
import type { HostStats, SystemStats, UnitySlotsReport } from '../shared/types.ts';
import { unitySlotsLine } from '../shared/fleet.ts';
import { run } from './proc.ts';
import { memUsed } from '../shared/stats.ts';

export { memUsed };

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

/**
 * Windows' own GPU numbers, for any vendor (Intel, AMD, NVIDIA without nvidia-smi): the performance counters
 * `\GPU Engine(*)\Utilization Percentage` and `\GPU Adapter Memory(*)\Dedicated Usage` (Get-Counter; where their
 * English names are unknown, a localized Windows, the same counters through their CIM classes), and each display
 * adapter's name and dedicated memory from the registry (Win32_VideoController's AdapterRAM stops at 4 GB). One line per
 * value: `engine|<instance>|<percent>`, `mem|<instance>|<bytes>`, `adapter|<name>|<bytes>`; parseWinGpu reads them.
 */
export const WIN_GPU_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$s = (Get-Counter -Counter '\\GPU Engine(*)\\Utilization Percentage','\\GPU Adapter Memory(*)\\Dedicated Usage').CounterSamples",
  "if ($s) { foreach ($x in $s) { $k = if ($x.Path -like '*utilization percentage') { 'engine' } else { 'mem' }; \"$k|$($x.InstanceName)|$($x.CookedValue)\" } }",
  'else {',
  '  foreach ($x in Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine) { "engine|$($x.Name)|$($x.UtilizationPercentage)" }',
  '  foreach ($x in Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory) { "mem|$($x.Name)|$($x.DedicatedUsage)" }',
  '}',
  "Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' | ForEach-Object {",
  "  $b = $_.'HardwareInformation.qwMemorySize'",
  "  if (-not $b) { $v = $_.'HardwareInformation.MemorySize'; if ($v -is [byte[]]) { $b = [BitConverter]::ToUInt32($v, 0) } elseif ($v) { $b = $v } }",
  '  if ($_.DriverDesc) { "adapter|$($_.DriverDesc)|$([uint64]$b)" }',
  '}',
].join('\n');

/**
 * The GPU from WIN_GPU_SCRIPT's lines. Utilisation as Task Manager shows it: per engine (adapter, physical GPU, engine
 * index) the sum over the processes using it, and the adapter's figure is its busiest engine. The adapter reported is
 * the one with the most dedicated memory in use (the one doing the work); its name and total are the display adapter's
 * with the most memory of its own (virtual adapters such as Remote Display have none). Undefined without any numbers.
 */
export function parseWinGpu(out: string): HostStats['gpu'] {
  const engines = new Map<string, number>();
  const used = new Map<string, number>();
  const adapters: { name: string; bytes: number }[] = [];
  for (const line of out.split(/\r?\n/)) {
    const [kind, inst = '', raw = ''] = line.trim().split('|');
    const v = Number(raw.replace(',', '.'));
    if (!Number.isFinite(v)) continue;
    if (kind === 'adapter') {
      if (inst && v > 0) adapters.push({ name: inst.trim(), bytes: v });
      continue;
    }
    const luid = /luid_(0x[0-9a-f]+_0x[0-9a-f]+)_phys_(\d+)/i.exec(inst);
    if (!luid) continue;
    const adapter = `${luid[1].toLowerCase()}_${luid[2]}`;
    if (kind === 'mem') used.set(adapter, Math.max(used.get(adapter) ?? 0, v));
    else if (kind === 'engine') {
      const eng = /_eng_(\d+)/i.exec(inst)?.[1] ?? '0';
      const key = `${adapter}|${eng}`;
      engines.set(key, (engines.get(key) ?? 0) + v);
    }
  }
  const util = new Map<string, number>();
  for (const [key, v] of engines) {
    const a = key.split('|')[0];
    util.set(a, Math.max(util.get(a) ?? 0, v));
  }
  const luids = [...new Set([...used.keys(), ...util.keys()])];
  const best = adapters.sort((a, b) => b.bytes - a.bytes)[0];
  if (!luids.length && !best) return undefined;
  const pick = luids.sort((a, b) => (used.get(b) ?? 0) - (used.get(a) ?? 0) || (util.get(b) ?? 0) - (util.get(a) ?? 0))[0];
  const memUsedMiB = Math.round((pick ? (used.get(pick) ?? 0) : 0) / 2 ** 20);
  return {
    name: best?.name ?? 'GPU',
    memTotalMiB: Math.max(Math.round((best?.bytes ?? 0) / 2 ** 20), memUsedMiB),
    memUsedMiB,
    utilPct: Math.min(100, Math.round(pick ? (util.get(pick) ?? 0) : 0)),
  };
}

/**
 * An AMD card on Linux (no nvidia-smi): the amdgpu driver's counters under /sys/class/drm/cardN/device, the card with
 * the most VRAM. Exported for tests.
 */
export function linuxDrmGpu(read: (p: string) => string = (p) => fs.readFileSync(p, 'utf8'), list: () => string[] = () => fs.readdirSync('/sys/class/drm')): HostStats['gpu'] {
  let best: HostStats['gpu'];
  let cards: string[] = [];
  try {
    cards = list().filter((c) => /^card\d+$/.test(c));
  } catch {
    return undefined;
  }
  for (const c of cards) {
    const num = (f: string) => {
      try {
        const n = Number(read(`/sys/class/drm/${c}/device/${f}`).trim());
        return Number.isFinite(n) ? n : undefined;
      } catch {
        return undefined;
      }
    };
    const total = num('mem_info_vram_total');
    const used = num('mem_info_vram_used');
    const busy = num('gpu_busy_percent');
    if (total === undefined || busy === undefined) continue;
    const g = { name: 'AMD GPU', memTotalMiB: Math.round(total / 2 ** 20), memUsedMiB: Math.round((used ?? 0) / 2 ** 20), utilPct: Math.min(100, Math.round(busy)) };
    if (!best || g.memTotalMiB > best.memTotalMiB) best = g;
  }
  return best;
}

async function gpu(memTotalBytes: number): Promise<HostStats['gpu']> {
  if (process.platform === 'darwin') {
    const r = await run('ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator'], { timeoutMs: 5000 });
    return r.code === 0 ? parseIoregGpu(r.stdout, memTotalBytes) : undefined;
  }
  const r = await run('nvidia-smi', ['--query-gpu=name,memory.total,memory.used,utilization.gpu', '--format=csv,noheader,nounits'], { timeoutMs: 5000 });
  const nvidia = r.code === 0 ? parseNvidiaSmi(r.stdout) : undefined;
  if (!nvidia && process.platform === 'linux') return linuxDrmGpu();
  if (nvidia || process.platform !== 'win32') return nvidia;
  // No nvidia-smi (an Intel or AMD card): Windows' own counters. Get-Counter takes a second or two.
  const w = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_GPU_SCRIPT], { timeoutMs: 20_000 });
  return w.code === 0 ? parseWinGpu(w.stdout) : undefined;
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

/** This host's load: its data volume's disk (the portal holds no sandboxes of its own, w510). */
export async function systemStats(cfg: Config): Promise<SystemStats> {
  return hostStats(cfg.dataDir);
}


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
export function machineLoadLine(m: { id: string; lastSeen?: string }, stats: (HostStats & { unity?: UnitySlotsReport }) | undefined, online: boolean, protocol?: number): string {
  // Its Unity editors as its daemon counts them (w469): every Unity process there, against max_unity.
  if (stats) return `${statsLine(m.id, stats)}${stats.unity ? `; Unity ${unitySlotsLine(stats.unity)}` : ''}`;
  // A current daemon sends its first numbers a few seconds after it connects (after every portal restart, w424); only one
  // from before protocol 4 never does.
  if (online && protocol !== undefined && protocol < 4) return `${m.id}: online, no load numbers (a daemon from before protocol 4 sends none; the portal redeploys it once no agent runs there)`;
  if (online) return `${m.id}: online, no load numbers yet (its daemon sends them within a minute of connecting)`;
  return `${m.id}: offline${m.lastSeen ? ` since ${m.lastSeen.slice(0, 16).replace('T', ' ')} UTC` : ''}`;
}
