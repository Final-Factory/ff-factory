import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { OutsideWatchConfig } from '../machine/outsideWatch.ts';
import { isWindows, run } from './proc.ts';

/**
 * The portal's side of the outside watchdog (docs/self-recovery.md, "Watched from outside"): the ntfy topic
 * (random, made once), this host's LAN MAC and broadcast address for Wake-on-LAN (learnt while it is up),
 * and the config a Mac's daemon watches this host with (machine/outsideWatch.ts).
 */

export interface OutsideWatchState {
  /** The ntfy.sh topic the alerts go to; the user subscribes to it in the ntfy app. Unguessable. */
  topic: string;
  mac?: string;
  ip?: string;
  broadcast?: string;
  collectedAt?: string;
}

const FILE = 'outside-watch.json';

/** The saved state, made (with a fresh random topic) the first time. */
export function loadOutsideWatchState(dataDir: string): OutsideWatchState {
  const file = path.join(dataDir, FILE);
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8')) as OutsideWatchState;
    if (/^[\w-]{16,64}$/.test(s.topic ?? '')) return s;
  } catch {
    // first run
  }
  const s: OutsideWatchState = { topic: `ffsb-${randomBytes(15).toString('base64url').replace(/[^\w-]/g, '').toLowerCase()}` };
  saveOutsideWatchState(dataDir, s);
  return s;
}

export function saveOutsideWatchState(dataDir: string, s: OutsideWatchState) {
  fs.writeFileSync(path.join(dataDir, FILE), JSON.stringify(s, null, 2), { mode: 0o600 });
}

/** The broadcast address of an IPv4 network (192.168.1.37/24 -> 192.168.1.255). */
export function broadcastAddress(ip: string, prefix: number): string {
  const n = ip.split('.').map(Number);
  if (n.length !== 4 || n.some((x) => !Number.isInteger(x) || x < 0 || x > 255) || prefix < 0 || prefix > 32) throw new Error(`bad address ${ip}/${prefix}`);
  const v = ((n[0] << 24) | (n[1] << 16) | (n[2] << 8) | n[3]) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const b = (v | (~mask >>> 0)) >>> 0;
  return [b >>> 24, (b >>> 16) & 255, (b >>> 8) & 255, b & 255].join('.');
}

/** "AA-BB-CC-DD-EE-FF" (Windows) -> "aa:bb:cc:dd:ee:ff". */
export const normMac = (mac: string) =>
  mac
    .replace(/[^0-9a-f]/gi, '')
    .toLowerCase()
    .replace(/(..)(?!$)/g, '$1:');

/** This host's LAN adapter (the one with the default IPv4 route): MAC, address, prefix. Windows only; undefined otherwise. */
export async function collectNetwork(): Promise<{ mac: string; ip: string; broadcast: string } | undefined> {
  if (!isWindows) return undefined;
  const ps =
    "$r = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop | Sort-Object RouteMetric, InterfaceMetric | Select-Object -First 1; " +
    '$a = Get-NetAdapter -InterfaceIndex $r.InterfaceIndex; $ip = Get-NetIPAddress -InterfaceIndex $r.InterfaceIndex -AddressFamily IPv4 | Select-Object -First 1; ' +
    '[pscustomobject]@{ mac = $a.MacAddress; ip = $ip.IPAddress; prefix = $ip.PrefixLength } | ConvertTo-Json -Compress';
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeoutMs: 30_000 });
  if (r.code !== 0 || !r.stdout.trim()) return undefined;
  const j = JSON.parse(r.stdout) as { mac?: string; ip?: string; prefix?: number };
  if (!j.mac || !j.ip || j.prefix === undefined) return undefined;
  return { mac: normMac(j.mac), ip: j.ip, broadcast: broadcastAddress(j.ip, j.prefix) };
}

/**
 * The config the watching Mac gets, or undefined when there is nothing to watch with (no public URL). The
 * health URL and host default to the portal's public (Tailscale) URL.
 */
export function outsideWatchConfig(
  o: { publicUrl?: string; healthUrl?: string; host?: string; ntfyServer?: string; name: string },
  s: OutsideWatchState,
): OutsideWatchConfig | undefined {
  const base = o.publicUrl?.replace(/\/+$/, '');
  const healthUrl = o.healthUrl ?? (base ? `${base}/api/health` : undefined);
  if (!healthUrl) return undefined;
  const host = o.host ?? new URL(healthUrl).hostname;
  return { name: o.name, host, healthUrl, ntfyTopic: s.topic, ...(o.ntfyServer ? { ntfyServer: o.ntfyServer } : {}), ...(s.mac ? { mac: s.mac } : {}), ...(s.broadcast ? { broadcast: s.broadcast } : {}) };
}

/** Which machine watches: the configured one, else "m5" if there is one, else the first. */
export function watcherOf(configured: string | undefined, machines: string[]): string | undefined {
  if (configured) return machines.includes(configured) ? configured : undefined;
  return machines.includes('m5') ? 'm5' : machines[0];
}
