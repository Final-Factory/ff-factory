import os from 'node:os';
import fs from 'node:fs';
import type { Config } from './config.ts';
import type { SystemStats } from '../shared/types.ts';
import { run } from './proc.ts';

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

async function gpu(): Promise<SystemStats['gpu']> {
  const r = await run('nvidia-smi', ['--query-gpu=name,memory.total,memory.used,utilization.gpu', '--format=csv,noheader,nounits'], { timeoutMs: 5000 });
  if (r.code !== 0) return undefined;
  const [name, total, used, util] = r.stdout.trim().split('\n')[0].split(',').map((s) => s.trim());
  return { name, memTotalMiB: Number(total), memUsedMiB: Number(used), utilPct: Number(util) };
}

export async function systemStats(cfg: Config): Promise<SystemStats> {
  let diskTotalBytes: number | undefined;
  let diskFreeBytes: number | undefined;
  try {
    const target = fs.existsSync(cfg.sandboxRoot) ? cfg.sandboxRoot : cfg.dataDir;
    const s = await fs.promises.statfs(target);
    diskTotalBytes = s.blocks * s.bsize;
    diskFreeBytes = s.bavail * s.bsize;
  } catch {
    // statfs is unavailable on some filesystems; the UI hides the meter
  }
  return {
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
    cpuModel: os.cpus()[0]?.model ?? 'unknown',
    cpuCount: os.cpus().length,
    loadPct: cpuLoadPct(),
    memTotalBytes: os.totalmem(),
    memFreeBytes: os.freemem(),
    diskTotalBytes,
    diskFreeBytes,
    gpu: await gpu(),
    limits: cfg.limits,
  };
}
