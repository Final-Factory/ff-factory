import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isWindows, run } from './proc.ts';

/**
 * The orphan headless-browser reaper (docs/self-recovery.md). Scripts that drive a headless browser
 * (screenshots, Playwright checks) sometimes die or hang and leave it running: on 2026-09-24, 31 headless
 * Edge instances held 24 GB of RAM. Agents are not allowed to kill browsers or node by hand (the guard),
 * so the server does it, for automation browsers only:
 *   - a browser under Playwright's own folder (%LOCALAPPDATA%\ms-playwright\...), or
 *   - Edge / Chrome / Firefox started --headless with a profile under the temp folder.
 * The user's normal browser (no temp profile, not headless, not Playwright's) is never matched, and neither
 * is this server or a Claude process. A matched browser is reaped when it has run longer than the limit, or
 * when whatever started it is gone (an orphan) for more than a few minutes. The node script driving it goes
 * too, when it is older than the limit.
 */

export interface Proc {
  pid: number;
  ppid: number;
  name: string;
  cmd: string;
  /** Start time, ms since the epoch. */
  created: number;
}

export interface ReapTarget {
  /** The process to kill with its whole tree. */
  pid: number;
  name: string;
  why: string;
  /** Temp profile folders to delete afterwards. */
  profiles: string[];
}

const BROWSER = /^(msedge|chrome|chrome-headless-shell|headless_shell|chromium|firefox|playwright|minibrowser)\.exe$/i;
const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** Temp-folder profile paths on a command line (--user-data-dir=, --user-data-dir "…", -profile "…"). */
export function tempProfiles(cmd: string, tmp: string): string[] {
  const out = new Set<string>();
  const re = /(?:--user-data-dir[= ]|-profile\s+)("([^"]+)"|(\S+))/gi;
  for (const m of cmd.matchAll(re)) {
    const p = (m[2] ?? m[3] ?? '').trim();
    if (p && norm(p).startsWith(norm(tmp) + '/')) out.add(p);
  }
  return [...out];
}

/** Whether a process is an automation browser (never the user's own). */
export function isAutomationBrowser(p: Proc, tmp: string, playwrightDir: string): boolean {
  if (!BROWSER.test(p.name)) return false;
  if (norm(p.cmd).includes(norm(playwrightDir) + '/')) return true;
  return /--headless\b|-headless\b/i.test(p.cmd) && tempProfiles(p.cmd, tmp).length > 0;
}

/** Never touched: this server, anything running the app's server script, Claude itself. */
export function isProtected(p: Proc, selfPid: number): boolean {
  return p.pid === selfPid || /server[\\/]index\.ts/i.test(p.cmd) || /^claude(\.exe)?$/i.test(p.name) || /[\\/]claude(\.exe)?["\s]/i.test(p.cmd);
}

/**
 * What to reap now. Only the root of each automation browser (its parent is not the same browser) is
 * targeted; killing its tree takes the helpers along. A node driver (the browser root's parent) is
 * targeted too when it is older than the limit.
 */
export function pickReaps(procs: Proc[], o: { tmp: string; playwrightDir: string; now: number; maxAgeMs: number; orphanGraceMs?: number; selfPid: number }): ReapTarget[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const grace = o.orphanGraceMs ?? 10 * 60_000;
  const out: ReapTarget[] = [];
  const hours = (ms: number) => `${(ms / 3_600_000).toFixed(1)} h`;
  for (const p of procs) {
    if (!isAutomationBrowser(p, o.tmp, o.playwrightDir) || isProtected(p, o.selfPid)) continue;
    const parent = byPid.get(p.ppid);
    if (parent && parent.name.toLowerCase() === p.name.toLowerCase()) continue; // a helper process; its root is handled
    const age = o.now - p.created;
    // A pid can be reused: a "parent" younger than its child is not the parent.
    const orphan = !parent || parent.created > p.created;
    let why: string | undefined;
    if (age > o.maxAgeMs) why = `headless ${p.name} running for ${hours(age)}`;
    else if (orphan && age > grace) why = `headless ${p.name} whose starter is gone (running ${hours(age)})`;
    if (!why) continue;
    const profiles = procs.filter((x) => x.pid === p.pid || x.ppid === p.pid).flatMap((x) => tempProfiles(x.cmd, o.tmp));
    const driver = !orphan && parent && /^node(\.exe)?$/i.test(parent.name) && !isProtected(parent, o.selfPid) && o.now - parent.created > o.maxAgeMs ? parent : undefined;
    if (driver) out.push({ pid: driver.pid, name: driver.name, why: `${why}, driven by \`${driver.cmd.slice(0, 120)}\``, profiles: [...new Set(profiles)] });
    else out.push({ pid: p.pid, name: p.name, why, profiles: [...new Set(profiles)] });
  }
  return out;
}

/** The processes on this machine (Windows; empty elsewhere). */
export async function listProcs(): Promise<Proc[]> {
  if (!isWindows) return [];
  const ps = "Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; cmd = [string]$_.CommandLine; created = if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { 0 } } } | ConvertTo-Json -Compress";
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeoutMs: 60_000 });
  if (r.code !== 0 || !r.stdout.trim()) return [];
  const list = JSON.parse(r.stdout) as Proc[] | Proc;
  return Array.isArray(list) ? list : [list];
}

export const PLAYWRIGHT_DIR = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');

/** Find and reap stale automation browsers. Returns one line per reaped tree. */
export async function reapBrowsers(maxAgeHours: number, selfPid = process.pid): Promise<string[]> {
  const targets = pickReaps(await listProcs(), { tmp: os.tmpdir(), playwrightDir: PLAYWRIGHT_DIR, now: Date.now(), maxAgeMs: maxAgeHours * 3_600_000, selfPid });
  const lines: string[] = [];
  for (const t of targets) {
    const k = await run('taskkill', ['/PID', String(t.pid), '/T', '/F'], { timeoutMs: 30_000 });
    let removed = 0;
    for (const p of t.profiles) {
      for (let i = 0; i < 10; i++) {
        try {
          fs.rmSync(p, { recursive: true, force: true });
          removed++;
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    }
    lines.push(`${k.code === 0 ? 'killed' : 'could not kill'} ${t.name} ${t.pid} and its children (${t.why})${t.profiles.length ? `; removed ${removed}/${t.profiles.length} temp profile(s)` : ''}`);
  }
  return lines;
}
