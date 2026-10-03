// FFBox's load, memory and disks, as its connector pushes them every 30 s (docs/ffbox-connector-contract.md, "metrics"):
// the numbers the sidebar, system_status and ffbox_activity show, worked out the same way on the server and in the page.
import type { ProviderMetrics } from './types.ts';

/** No update for this long and the numbers are shown as stale, not as current. */
export const METRICS_STALE_MS = 120_000;

/** The 1-minute load over the logical cores, as a percentage. Not clamped: a box with more runnable work than cores reads above 100%. */
export const cpuPct = (m: ProviderMetrics): number | undefined => (m.cpu && m.cpu.cores > 0 ? (m.cpu.load1 / m.cpu.cores) * 100 : undefined);

export const memPct = (m: ProviderMetrics): number | undefined => (m.mem && m.mem.totalBytes > 0 ? (m.mem.usedBytes / m.mem.totalBytes) * 100 : undefined);

export const metricsStale = (m: ProviderMetrics, now: number) => !(now - Date.parse(m.receivedAt) <= METRICS_STALE_MS);

const gb = (n: number) => {
  const v = n / 1024 ** 3;
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} GB`;
};

const ago = (iso: string, now: number) => {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 120 ? `${s} s ago` : s < 7200 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

/** One line: "CPU 135% (load 21.6 on 16 cores) · RAM 38.1 of 125 GB, swap 1.9 GB · disk root+state 120 of 500 GB free", or "no metrics". */
export function metricsLine(m: ProviderMetrics | undefined, now: number): string {
  if (!m) return 'no metrics';
  const parts: string[] = [];
  const cpu = cpuPct(m);
  if (cpu !== undefined && m.cpu) parts.push(`CPU ${Math.round(cpu)}% (load ${m.cpu.load1} on ${m.cpu.cores} cores; 5 min ${m.cpu.load5}, 15 min ${m.cpu.load15})`);
  if (m.mem) parts.push(`RAM ${gb(m.mem.usedBytes)} of ${gb(m.mem.totalBytes)}${m.mem.swapUsedBytes !== undefined ? `, swap ${gb(m.mem.swapUsedBytes)}` : ''}`);
  if (m.disks.length) parts.push(`disk ${m.disks.map((d) => `${d.role} ${gb(d.freeBytes)} of ${gb(d.totalBytes)} free`).join(', ')}`);
  const line = parts.join(' · ') || 'no numbers in the last report';
  return metricsStale(m, now) ? `${line} (stale: last update ${ago(m.receivedAt, now)})` : line;
}

/**
 * The one disk the UI shows: the filesystem whose role names "root" (FFBox's "root+runs"), else the first reported.
 * The others (state, golden, cache, ...) stay in the data, in metricsLine and in disksHint.
 */
export const rootDisk = (m: ProviderMetrics) => {
  const disks = m.disks.filter((d) => d.totalBytes > 0);
  return disks.find((d) => d.role.split('+').includes('root')) ?? disks[0];
};

/** Every filesystem, one per line, for a hover: "root+runs: 200 GB free of 500 GB". */
export const disksHint = (m: ProviderMetrics) => m.disks.map((d) => `${d.role}: ${gb(d.freeBytes)} free of ${gb(d.totalBytes)}`).join('\n');
