// The machine's Steam client (w2459, shared/steam.ts): installed, running, signed in, as which account, read cheaply and
// reported to the portal, which places a pair run that needs Steam only on computers signed in to it. It reads only Steam's
// own keys and files: on Windows `reg query` of HKCU\Software\Valve\Steam (SteamPath, ActiveProcess\ActiveUser, which Steam
// sets to the signed-in account id and back to 0 at sign-out) and `tasklist` for steam.exe; on macOS and Linux Steam's
// registry.vdf (the same keys) and pgrep. The display name comes from <Steam>/config/loginusers.vdf, read for the signed-in
// account's PersonaName and WantsOfflineMode only: its login name is never kept, logged or sent. No drive is scanned.
// Beside it, the desktop session (readDesktopSession): whether the screen is locked, since a pair run's menus need clicks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, type RunOptions, type RunResult } from '../server/proc.ts';
import { loginUserOf, parseVdf, steamConnection, steamLabel, vdfGet, type SteamClient } from '../shared/steam.ts';
import { desktopLabel, type DesktopSession } from '../shared/desktop.ts';
import { SESSION_SCRIPT } from './macDialogs.ts';

/** How often it is read: four small commands and two small files, so a sign-out or a locked screen shows within minutes. */
export const READ_EVERY_MS = 2 * 60_000;

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
    // w2461: signed in is not connected; its connection log's tail says whether it is (the file grows to megabytes).
    const log = d.read(path.join(root, 'logs', 'connection_log.txt'));
    // w4638: and its login log's tail whether another sign-in kicked it off and it waits for a person.
    const login = d.read(path.join(root, 'logs', 'steamui_login.txt'));
    const notConnected = log ? steamConnection(log.slice(-64_000), login ? { login: login.slice(-16_000) } : {}) : undefined;
    return { ...base, accountId, ...(users ? loginUserOf(users, accountId) : {}), ...(notConnected ? { notConnected } : {}) };
  } catch (e) {
    return { checkedAt, installed: false, running: false, error: `read failed: ${(e as Error).message}`.slice(0, 120) };
  }
}

/**
 * The desktop session once (w2459, shared/desktop.ts; w2460's rerun 2: a Mac with a locked screen takes no menu clicks).
 * macOS: CGSessionCopyCurrentDictionary through osascript (macDialogs.ts SESSION_SCRIPT, as the dialog watch reads it).
 * Windows: whether LogonUI.exe, the lock screen, runs (tasklist). Linux (w6311): readLinuxDesktop. When a Mac or Windows
 * reading fails: unknown (undefined), which locks no computer out. Never throws.
 */
export async function readDesktopSession(d: Pick<SteamClientDeps, 'run' | 'platform' | 'now'>, env: LinuxSessionEnv = linuxSessionEnv()): Promise<DesktopSession | undefined> {
  const checkedAt = d.now().toISOString();
  try {
    if (d.platform === 'darwin') {
      const r = await d.run('osascript', ['-l', 'JavaScript', '-e', SESSION_SCRIPT], RUN);
      if (r.code !== 0) return undefined;
      const s = JSON.parse(r.stdout.trim() || '{}') as { locked?: boolean; onConsole?: boolean };
      if (s.locked === undefined && s.onConsole === undefined) return undefined;
      return { checkedAt, ...(s.locked ? { locked: true } : {}), ...(s.onConsole === false ? { away: true } : {}) };
    }
    if (d.platform === 'win32') {
      const t = await d.run('tasklist', ['/FI', 'IMAGENAME eq LogonUI.exe', '/NH', '/FO', 'CSV'], RUN);
      if (t.code !== 0) return undefined;
      return { checkedAt, ...(/^"LogonUI\.exe"/im.test(t.stdout) ? { locked: true } : {}) };
    }
    if (d.platform === 'linux') return await readLinuxDesktop(d, env);
  } catch {
    // unknown
  }
  return undefined;
}

/** What the Linux reading needs from the daemon's own process: its uid, and its session bus when the environment names one. */
export interface LinuxSessionEnv {
  uid?: number;
  env: NodeJS.ProcessEnv;
}

export const linuxSessionEnv = (): LinuxSessionEnv => ({ ...(typeof process.getuid === 'function' ? { uid: process.getuid() } : {}), env: process.env });

/**
 * A Linux desktop's lock (w6311: w6282's windowed pair leg went on biscuit behind a locked GNOME desktop and drew no frames).
 * First GNOME's own answer, `gdbus call --session --dest org.gnome.ScreenSaver ... GetActive`: "(true,)" while the lock
 * shield is up, "(false,)" when not (on the user's session bus: /run/user/<uid>/bus when the daemon's environment names
 * none). Without GNOME, loginctl: the user's graphical session (show-user Display) and its
 * LockedHint or IdleHint, either "yes" counting as locked. Neither: via "none", which placement counts as locked for work
 * that draws a window (shared/desktop.ts heeded).
 */
export async function readLinuxDesktop(d: Pick<SteamClientDeps, 'run' | 'now'>, s: LinuxSessionEnv): Promise<DesktopSession> {
  const checkedAt = d.now().toISOString();
  const runtime = s.uid !== undefined ? `/run/user/${s.uid}` : s.env.XDG_RUNTIME_DIR;
  const bus = s.env.DBUS_SESSION_BUS_ADDRESS || (runtime ? `unix:path=${runtime}/bus` : undefined);
  const env = bus ? { ...s.env, DBUS_SESSION_BUS_ADDRESS: bus } : s.env;
  try {
    const g = await d.run('gdbus', ['call', '--session', '--dest', 'org.gnome.ScreenSaver', '--object-path', '/org/gnome/ScreenSaver', '--method', 'org.gnome.ScreenSaver.GetActive'], { ...RUN, env });
    const m = g.code === 0 ? /^\(\s*(true|false)\s*,?\s*\)$/.exec(g.stdout.trim()) : null;
    if (m) return { checkedAt, via: 'gnome', ...(m[1] === 'true' ? { locked: true } : {}) };
  } catch {
    // no gdbus: loginctl
  }
  try {
    const who = s.uid !== undefined ? String(s.uid) : s.env.USER;
    if (who) {
      const u = await d.run('loginctl', ['show-user', who, '-p', 'Display', '--value'], RUN);
      const session = u.code === 0 ? u.stdout.trim() : '';
      if (/^[\w-]+$/.test(session)) {
        const r = await d.run('loginctl', ['show-session', session, '-p', 'LockedHint', '-p', 'IdleHint'], RUN);
        const hint = (k: string) => new RegExp(`^${k}=(yes|no)$`, 'm').exec(r.stdout)?.[1];
        if (r.code === 0 && (hint('LockedHint') || hint('IdleHint'))) return { checkedAt, via: 'loginctl', ...(hint('LockedHint') === 'yes' || hint('IdleHint') === 'yes' ? { locked: true } : {}) };
      }
    }
  } catch {
    // no loginctl: unknown
  }
  return { checkedAt, via: 'none' };
}

/** The daemon's watch of its Steam client: reads it every READ_EVERY_MS, sends it when it changed, and again after each hello. */
export class SteamClientWatch {
  private last?: SteamClient;
  private lastDesktop?: DesktopSession;
  private lastSent = '';
  private reading = false;
  private readonly d: SteamClientDeps & { send: (s: SteamClient, desktop?: DesktopSession) => void; log: (line: string) => void };

  constructor(d: SteamClientDeps & { send: (s: SteamClient, desktop?: DesktopSession) => void; log: (line: string) => void }) {
    this.d = d;
  }

  current(): SteamClient | undefined {
    return this.last;
  }

  resend() {
    if (this.last) this.d.send(this.last, this.lastDesktop);
  }

  async tick(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      const s = await readSteamClient(this.d);
      const desktop = await readDesktopSession(this.d);
      this.last = s;
      this.lastDesktop = desktop;
      const key = JSON.stringify({ ...s, checkedAt: undefined, desktop: desktop ? { ...desktop, checkedAt: undefined } : undefined });
      if (key === this.lastSent) return;
      this.d.log(`steam client: ${steamLabel(s)}; screen: ${desktopLabel(desktop)}`);
      this.lastSent = key;
      this.d.send(s, desktop);
    } finally {
      this.reading = false;
    }
  }
}
