// The machine's Steam client (w2459, shared/steam.ts): installed, running, signed in, as which account, read cheaply and
// reported to the portal, which places a pair run that needs Steam only on computers signed in to it. It reads only Steam's
// own keys and files: on Windows `reg query` of HKCU\Software\Valve\Steam (SteamPath, ActiveProcess\ActiveUser, which Steam
// sets to the signed-in account id and back to 0 at sign-out) and `tasklist` for steam.exe; on macOS and Linux Steam's
// registry.vdf (the same keys) and pgrep. The display name comes from <Steam>/config/loginusers.vdf, read for the signed-in
// account's PersonaName and WantsOfflineMode only: its login name is never kept, logged or sent. No drive is scanned.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, type RunOptions, type RunResult } from '../server/proc.ts';
import { loginUserOf, parseVdf, steamLabel, vdfGet, type SteamClient } from '../shared/steam.ts';

/** How often it is read: three small commands and two small files, so a sign-out shows within minutes. */
export const READ_EVERY_MS = 5 * 60_000;

export interface SteamClientDeps {
  run: (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;
  /** A file's text, or undefined when it is missing or unreadable. */
  read: (file: string) => string | undefined;
  exists: (file: string) => boolean;
  platform: NodeJS.Platform;
  home: string;
  now: () => Date;
}

export const realSteamDeps = (): SteamClientDeps => ({
  run,
  read: (file) => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  },
  exists: (file) => fs.existsSync(file),
  platform: process.platform,
  home: os.homedir(),
  now: () => new Date(),
});

const RUN = { timeoutMs: 15_000 };

/** One value of `reg query <key> /v <name>`: "SteamPath    REG_SZ    c:/games/steam", "ActiveUser    REG_DWORD    0x6d307f". */
export function regValue(out: string, name: string): string | undefined {
  const m = new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*?)\\s*$`, 'im').exec(out);
  return m?.[1];
}

/** A REG_DWORD's "0x6d307f", or a registry.vdf's "7155839", as a number. */
export function dword(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = /^0x[0-9a-f]+$/i.test(v) ? parseInt(v, 16) : /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** Where Steam lives on macOS and Linux (native, then the Flatpak): its root (holds config/) and its registry.vdf. */
export function unixSteamPlaces(platform: NodeJS.Platform, home: string): { root: string; registry: string }[] {
  if (platform === 'darwin') {
    const root = path.join(home, 'Library', 'Application Support', 'Steam');
    return [{ root, registry: path.join(root, 'registry.vdf') }];
  }
  const flat = path.join(home, '.var', 'app', 'com.valvesoftware.Steam');
  return [
    { root: path.join(home, '.steam', 'steam'), registry: path.join(home, '.steam', 'registry.vdf') },
    { root: path.join(home, '.local', 'share', 'Steam'), registry: path.join(home, '.steam', 'registry.vdf') },
    { root: path.join(flat, '.local', 'share', 'Steam'), registry: path.join(flat, '.steam', 'registry.vdf') },
  ];
}

/** Read the Steam client once. Never throws. */
export async function readSteamClient(d: SteamClientDeps): Promise<SteamClient> {
  const checkedAt = d.now().toISOString();
  try {
    let root: string | undefined;
    let accountId: number | undefined;
    let running = false;
    if (d.platform === 'win32') {
      const base = await d.run('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], RUN);
      root = base.code === 0 ? regValue(base.stdout, 'SteamPath') : undefined;
      if (!root || !d.exists(path.join(root, 'steam.exe'))) return { checkedAt, installed: false, running: false };
      const act = await d.run('reg', ['query', 'HKCU\\Software\\Valve\\Steam\\ActiveProcess', '/v', 'ActiveUser'], RUN);
      accountId = act.code === 0 ? dword(regValue(act.stdout, 'ActiveUser')) : undefined;
      const t = await d.run('tasklist', ['/FI', 'IMAGENAME eq steam.exe', '/NH', '/FO', 'CSV'], RUN);
      running = /^"steam\.exe"/im.test(t.stdout);
    } else {
      const place = unixSteamPlaces(d.platform, d.home).find((p) => d.exists(path.join(p.root, 'config')) || d.exists(p.registry));
      if (!place) return { checkedAt, installed: false, running: false };
      root = place.root;
      const reg = d.read(place.registry);
      accountId = reg ? dword(String(vdfGet(parseVdf(reg), 'Registry', 'HKCU', 'Software', 'Valve', 'Steam', 'ActiveProcess', 'ActiveUser') ?? '')) : undefined;
      const p = await d.run('pgrep', ['-x', d.platform === 'darwin' ? 'steam_osx' : 'steam'], RUN);
      running = p.code === 0 && /\d/.test(p.stdout);
    }
    const base: SteamClient = { checkedAt, installed: true, running };
    if (!running || !accountId) return base;
    const users = d.read(path.join(root, 'config', 'loginusers.vdf'));
    return { ...base, accountId, ...(users ? loginUserOf(users, accountId) : {}) };
  } catch (e) {
    return { checkedAt, installed: false, running: false, error: `read failed: ${(e as Error).message}`.slice(0, 120) };
  }
}

/** The daemon's watch of its Steam client: reads it every READ_EVERY_MS, sends it when it changed, and again after each hello. */
export class SteamClientWatch {
  private last?: SteamClient;
  private lastSent = '';
  private reading = false;
  private readonly d: SteamClientDeps & { send: (s: SteamClient) => void; log: (line: string) => void };

  constructor(d: SteamClientDeps & { send: (s: SteamClient) => void; log: (line: string) => void }) {
    this.d = d;
  }

  current(): SteamClient | undefined {
    return this.last;
  }

  resend() {
    if (this.last) this.d.send(this.last);
  }

  async tick(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      const s = await readSteamClient(this.d);
      this.last = s;
      const key = JSON.stringify({ ...s, checkedAt: undefined });
      if (key === this.lastSent) return;
      this.d.log(`steam client: ${steamLabel(s)}`);
      this.lastSent = key;
      this.d.send(s);
    } finally {
      this.reading = false;
    }
  }
}
