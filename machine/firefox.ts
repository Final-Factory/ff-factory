// The tray's "Close Firefox to free RAM" (w1593, lothsahn: "Can you make the daemon have an option in the tray to nicely
// shutdown Firefox (not force kill) to free ram?"; docs/machines.md "Closing Firefox to free RAM"). Firefox is asked to
// close the way a person closes it: a WM_CLOSE to each of its top-level windows, what the title bar's X sends. It never
// kills a process: a Firefox that shows a prompt (close N tabs?, a page asking to leave, downloads in progress) or that
// has not ended within the wait is left running, and the notification says so. When it ends, each profile it had open is
// told to restore its session once at the next start (browser.sessionstore.resume_session_once, Firefox's one-shot
// restore setting, which it clears once used), so its windows and tabs come back whatever its startup setting is.
//
// The logic is here, with its Windows steps behind FirefoxDeps (tested with fakes in server/firefox.test.ts, and the
// PowerShell for real on Windows); the tray (machine/tray/FFFactoryTray.cs) shows the item while Firefox runs in its
// session and shows the result as a notification. Windows only: the daemon has no menu-bar app on a Mac. Off unless the
// machine turns it on (lothsahn: "Closing Firefox should be off by default"): <app_dir>/firefox.json, set from the tray.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../server/proc.ts';

export interface FirefoxProc {
  pid: number;
  ppid: number;
  /** The Windows session it runs in: only the daemon's own session's Firefox is closed. */
  session: number;
  workingSet: number;
  /** Its private memory (Win32_Process PrivatePageCount, bytes): what its end gives back. */
  privateBytes: number;
  commandLine: string;
}

export interface FirefoxInstance {
  main: FirefoxProc;
  /** Its child processes (tabs, GPU, sockets: firefox.exe -contentproc), at any depth. */
  children: FirefoxProc[];
  /** The profile folder its command line names (-profile), when it names one. */
  profile?: string;
}

/** A process Firefox starts to run a background task (--backgroundtask) has no windows and ends by itself: not Firefox open. */
const isBackgroundTask = (p: FirefoxProc) => /(^|\s)--?backgroundtask(\s|$)/i.test(p.commandLine);
const isChild = (p: FirefoxProc) => /(^|\s)-contentproc(\s|$)/i.test(p.commandLine);

/** The -profile folder on a Firefox command line (quoted or not). */
export function profileArg(commandLine: string): string | undefined {
  const m = /(?:^|\s)--?profile\s+(?:"([^"]+)"|(\S+))/i.exec(commandLine);
  return m ? (m[1] ?? m[2]) : undefined;
}

/** The Firefox windows open in `session`: each main process with its children; other sessions' and background tasks left out. */
export function firefoxInstances(procs: FirefoxProc[], session: number): FirefoxInstance[] {
  const mine = procs.filter((p) => p.session === session && !isBackgroundTask(p));
  const kids = new Map<number, FirefoxProc[]>();
  for (const p of mine) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
  return mine
    .filter((p) => !isChild(p))
    .map((main) => {
      const children: FirefoxProc[] = [];
      const seen = new Set([main.pid]);
      for (let todo = [main.pid]; todo.length; ) {
        for (const k of kids.get(todo.pop()!) ?? []) {
          if (seen.has(k.pid) || !isChild(k)) continue;
          seen.add(k.pid);
          children.push(k);
          todo.push(k.pid);
        }
      }
      return { main, children, profile: profileArg(main.commandLine) };
    });
}

/** The profile folders profiles.ini lists (Path=, relative to its folder when IsRelative=1). */
export function parseProfilesIni(text: string, iniDir: string): string[] {
  const out: string[] = [];
  let rel = true;
  let p: string | undefined;
  const flush = () => {
    if (p) out.push(rel ? path.join(iniDir, ...p.split(/[\\/]/)) : p);
    p = undefined;
    rel = true;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      flush();
      // [Install…] sections name a Default= path the [Profile…] sections already list.
      continue;
    }
    const m = /^(Path|IsRelative)\s*=\s*(.*)$/i.exec(line);
    if (!m) continue;
    if (m[1].toLowerCase() === 'path') p = m[2];
    else rel = m[2] !== '0';
  }
  flush();
  return out;
}

export const RESUME_PREF = 'user_pref("browser.sessionstore.resume_session_once", true);';

export interface WindowsClosed {
  /** Its visible top-level windows. */
  windows: number;
  /** Closed, one at a time. */
  closed: number;
  /** A window was still open at the end of the wait (a prompt in it, most likely): the ones after it were not asked. */
  stuck: boolean;
}

export interface FirefoxDeps {
  /** firefox.exe processes and the daemon's own session. */
  list(): Promise<{ session: number; procs: FirefoxProc[] }>;
  /**
   * Close the visible top-level windows of this process one at a time: WM_CLOSE to one, wait until it is gone (at most
   * `waitMs` in all), a moment for Firefox to save it, then the next. Measured on beast (Firefox 157, w1593): two windows
   * sent WM_CLOSE together came back as one, the other lost; one at a time, both came back.
   */
  closeWindows(pid: number, waitMs: number): Promise<WindowsClosed>;
  /** Available physical memory, bytes. */
  freeMem(): number;
  /** Every profile folder Firefox knows of (profiles.ini). */
  profileDirs(): string[];
  /** Whether a Firefox has this profile open (its parent.lock is held). */
  inUse(dir: string): boolean;
  /** Have this closed profile restore its session once at its next start. */
  resumeOnce(dir: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  log?(line: string): void;
}

export interface CloseOptions {
  /** Only these main processes (a check on one Firefox while another is open); all of the session's otherwise. */
  pids?: number[];
  /** How long Firefox gets to close its windows and end its main processes, then its children. */
  waitMs?: number;
  childWaitMs?: number;
  pollMs?: number;
}

export type CloseOutcome = 'not running' | 'closed' | 'some left' | 'left running' | 'no window';

export interface CloseResult {
  outcome: CloseOutcome;
  windows: number;
  instances: number;
  closedInstances: number;
  /** The main processes still running at the end (never killed). */
  left: number[];
  freeBefore: number;
  freeAfter: number;
  firefoxBytes: number;
  /** The profiles told to restore their session once. */
  resumed: string[];
  waitedMs: number;
  title: string;
  text: string;
  warn: boolean;
}

export const DEFAULT_WAIT_MS = 45_000;

/** Ask the session's Firefox to close, wait for it, and say what came of it. Never kills anything. */
export async function closeFirefox(d: FirefoxDeps, o: CloseOptions = {}): Promise<CloseResult> {
  const waitMs = o.waitMs ?? DEFAULT_WAIT_MS;
  const childWaitMs = o.childWaitMs ?? 15_000;
  const pollMs = o.pollMs ?? 1000;
  const first = await d.list();
  let instances = firefoxInstances(first.procs, first.session);
  if (o.pids) instances = instances.filter((i) => o.pids!.includes(i.main.pid));
  const freeBefore = d.freeMem();
  const ours = new Set(instances.flatMap((i) => [i.main.pid, ...i.children.map((c) => c.pid)]));
  const firefoxBytes = first.procs.filter((p) => ours.has(p.pid)).reduce((s, p) => s + p.privateBytes, 0);
  const base = { instances: instances.length, freeBefore, firefoxBytes, resumed: [] as string[] };
  if (!instances.length) return finish({ ...base, outcome: 'not running', windows: 0, closedInstances: 0, left: [], freeAfter: freeBefore, waitedMs: 0 });

  // The profiles open now: those it names on its command line, and any profiles.ini lists that is held. Closing only some
  // (pids), profiles.ini's are left out: one held by a Firefox not closed here could be closed by its person meanwhile.
  const named = instances.map((i) => i.profile).filter((p): p is string => !!p);
  const candidates = [...new Set([...named, ...(o.pids ? [] : safe(() => d.profileDirs(), []))])];
  const openProfiles = candidates.filter((p) => safe(() => d.inUse(p), false));
  const mains = instances.map((i) => i.main.pid);
  const start = d.now();
  // Each Firefox's windows, one at a time; one stuck on a prompt is left as it is, and the next Firefox is asked.
  let windows = 0;
  const asked: number[] = [];
  for (const pid of mains) {
    const w = await d.closeWindows(pid, Math.max(5000, waitMs - (d.now() - start)));
    windows += w.windows;
    d.log?.(`firefox: pid ${pid}: ${w.closed} of ${w.windows} window(s) closed${w.stuck ? ', then one stayed open (a prompt?): the rest not asked' : ''}`);
    if (w.windows && !w.stuck) asked.push(pid);
  }
  if (!windows) return finish({ ...base, outcome: 'no window', windows, closedInstances: 0, left: mains, freeAfter: d.freeMem(), waitedMs: d.now() - start });

  // Its main processes end once their last window has closed (each saves its session as it goes), then their children.
  let alive = (await d.list()).procs;
  const running = (pids: Iterable<number>) => [...pids].filter((pid) => alive.some((p) => p.pid === pid));
  const exitDeadline = Math.max(start + waitMs, d.now() + 15_000);
  while (running(asked).length && d.now() < exitDeadline) {
    await d.sleep(pollMs);
    alive = (await d.list()).procs;
  }
  const left = running(mains);
  const childDeadline = d.now() + childWaitMs;
  const doneKids = new Set(instances.filter((i) => !left.includes(i.main.pid)).flatMap((i) => i.children.map((c) => c.pid)));
  while (running(doneKids).length && d.now() < childDeadline) {
    await d.sleep(pollMs);
    alive = (await d.list()).procs;
  }
  // A moment for Windows to hand the pages back before the second reading.
  await d.sleep(Math.min(pollMs, 1000));
  const freeAfter = d.freeMem();
  const resumed: string[] = [];
  for (const p of openProfiles) {
    if (safe(() => d.inUse(p), true)) continue;
    try {
      d.resumeOnce(p);
      resumed.push(p);
    } catch (e) {
      d.log?.(`firefox: could not set ${p} to restore its session: ${(e as Error).message}`);
    }
  }
  const closedInstances = instances.length - left.length;
  const outcome: CloseOutcome = !left.length ? 'closed' : closedInstances ? 'some left' : 'left running';
  return finish({ ...base, outcome, windows, closedInstances, left, freeAfter, resumed, waitedMs: d.now() - start });

  function finish(r: Omit<CloseResult, 'title' | 'text' | 'warn'>): CloseResult {
    return { ...r, ...closeMessage(r, waitMs) };
  }
}

function safe<T>(f: () => T, fallback: T): T {
  try {
    return f();
  } catch {
    return fallback;
  }
}

/** 2.9 GB, 640 MB. */
export function size(bytes: number): string {
  const gb = bytes / 2 ** 30;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(0, Math.round(bytes / 2 ** 20))} MB`;
}

/** The notification: a title and at most a few short sentences (a Windows balloon shows about 255 characters). */
export function closeMessage(r: Omit<CloseResult, 'title' | 'text' | 'warn'>, waitMs = DEFAULT_WAIT_MS): { title: string; text: string; warn: boolean } {
  const free = `Free RAM ${size(r.freeBefore)} → ${size(r.freeAfter)}`;
  const freed = r.freeAfter - r.freeBefore;
  const memory = freed > 0 ? `Freed ${size(freed)} (${free}).` : `${free}; Firefox held ${size(r.firefoxBytes)}.`;
  const back = r.resumed.length ? 'Its windows and tabs come back when you start it again.' : 'Its session is saved (History > Restore previous session).';
  const prompt = 'It may be asking something in its window (close tabs?, a page asking to leave, downloads).';
  const secs = Math.round(waitMs / 1000);
  switch (r.outcome) {
    case 'not running':
      return { title: 'Firefox is not running', text: 'There was no Firefox to close.', warn: false };
    case 'no window':
      return { title: 'Firefox left running', text: 'Firefox has no window to close here, so it was left running. Nothing was forced.', warn: true };
    case 'closed':
      return { title: 'Firefox closed', text: `${memory} ${back}`, warn: false };
    case 'some left':
      return { title: 'Firefox partly closed', text: `${r.closedInstances} of ${r.instances} Firefox closed; ${r.left.length} still open after ${secs} s. ${prompt} Nothing was forced. ${memory}`, warn: true };
    case 'left running':
      return { title: 'Firefox is still open', text: `Firefox did not close within ${secs} s. ${prompt} It was left running; nothing was forced. ${memory}`, warn: true };
  }
}

// ------------------------------------------------------------------ the setting and the tray's request

/** Off unless turned on (lothsahn, 2026-10-19: "Closing Firefox should be off by default"), per machine, in this file. */
export const firefoxFile = (appDir: string) => path.join(appDir, 'firefox.json');

/** On only for {"enabled": true}; a missing or unreadable file is off. */
export function readFirefoxEnabled(file: string): boolean {
  try {
    return (JSON.parse(fs.readFileSync(file, 'utf8')) as { enabled?: unknown }).enabled === true;
  } catch {
    return false;
  }
}

export interface FirefoxCloserDeps {
  file: string;
  /** The close itself (closeFirefox with the Windows steps). */
  close: () => Promise<CloseResult>;
  /** To the tray: {"type":"firefox","state":...} and {"type":"notify",...}. */
  send: (msg: Record<string, unknown>) => void;
  log: (line: string) => void;
}

/** The daemon's side of the tray item: the setting, one close at a time, and the notification. Nothing closes while it is off. */
export class FirefoxCloser {
  private busy = false;
  private on: boolean;
  private readonly d: FirefoxCloserDeps;

  constructor(d: FirefoxCloserDeps) {
    this.d = d;
    this.on = readFirefoxEnabled(d.file);
  }

  get enabled() {
    return this.on;
  }

  /** The tray's "Allow closing Firefox from this menu". */
  setEnabled(on: boolean) {
    this.on = on === true;
    fs.mkdirSync(path.dirname(this.d.file), { recursive: true });
    fs.writeFileSync(this.d.file, `${JSON.stringify({ enabled: this.on }, null, 2)}\n`);
    this.d.log(`firefox: closing Firefox from the tray is now ${this.on ? 'on' : 'off'} on this machine (${this.d.file})`);
  }

  /** The tray's Close Firefox was chosen. */
  async request(): Promise<CloseResult | undefined> {
    if (!this.on) {
      this.d.log('firefox: a close was asked while closing Firefox is off on this machine: nothing done');
      this.d.send({ type: 'notify', title: 'Closing Firefox is off', text: 'Turn on "Allow closing Firefox from this menu" first. Firefox was not touched.', warn: true });
      this.d.send({ type: 'firefox', state: 'idle' });
      return undefined;
    }
    if (this.busy) return undefined;
    this.busy = true;
    this.d.send({ type: 'firefox', state: 'closing' });
    try {
      const r = await this.d.close();
      this.d.log(
        `firefox: ${r.outcome}: ${r.closedInstances}/${r.instances} closed, ${r.windows} window(s), free ${size(r.freeBefore)} -> ${size(r.freeAfter)}, ${r.resumed.length} profile(s) set to restore, ${Math.round(r.waitedMs / 1000)} s${r.left.length ? `, left running: pid ${r.left.join(', ')}` : ''}`,
      );
      this.d.send({ type: 'notify', title: r.title, text: r.text, warn: r.warn });
      return r;
    } catch (e) {
      this.d.log(`firefox: could not close it: ${(e as Error).message}`);
      this.d.send({ type: 'notify', title: 'Could not close Firefox', text: `${(e as Error).message.slice(0, 200)} Nothing was forced.`, warn: true });
      return undefined;
    } finally {
      this.busy = false;
      this.d.send({ type: 'firefox', state: 'idle' });
    }
  }
}

// ------------------------------------------------------------------ Windows

/**
 * Windows PowerShell 5.1: FF_OP=list prints the firefox.exe processes and this session as JSON. FF_OP=close closes the
 * visible top-level windows (no owner) of process FF_PID whose class starts with FF_CLASS one at a time: WM_CLOSE (what a
 * window's X sends), a wait until it is gone (FF_WAIT_MS for them all), FF_SETTLE_MS for Firefox to save it, the next; a
 * window still open at the end of the wait stops it. It prints {"windows","closed","stuck"}. FF_OP=windows prints how many
 * such windows there are. FF_NAME and FF_CLASS default to Firefox's; a test points them at its own windows. Nothing here
 * ends a process.
 */
export const WIN_FIREFOX_PS = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$name = if ($env:FF_NAME) { $env:FF_NAME } else { 'firefox.exe' }
if ($env:FF_OP -eq 'list') {
  $procs = @(Get-CimInstance Win32_Process -Filter ("Name='" + $name.Replace("'", "") + "'") | ForEach-Object {
    [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; session = [int]$_.SessionId; workingSet = [double]$_.WorkingSetSize; privateBytes = [double]$_.PrivatePageCount; commandLine = [string]$_.CommandLine }
  })
  [pscustomobject]@{ session = [int][System.Diagnostics.Process]::GetCurrentProcess().SessionId; procs = $procs } | ConvertTo-Json -Depth 4 -Compress
  exit 0
}
if ($env:FF_OP -eq 'close' -or $env:FF_OP -eq 'windows') {
  $cls = if ($env:FF_CLASS) { $env:FF_CLASS } else { 'MozillaWindowClass' }
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class FFFirefoxWindows {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static List<IntPtr> Find(int want, string cls) {
    var list = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid == (uint)want && IsWindowVisible(h) && GetWindow(h, 4) == IntPtr.Zero) {
        var sb = new StringBuilder(256);
        GetClassName(h, sb, sb.Capacity);
        if (sb.ToString().StartsWith(cls, StringComparison.Ordinal)) list.Add(h);
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }
  static bool Open(IntPtr h) { return IsWindow(h) && IsWindowVisible(h); }
  public static string Close(int pid, string cls, int waitMs, int settleMs) {
    var list = Find(pid, cls);
    var clock = Stopwatch.StartNew();
    int closed = 0;
    bool stuck = false;
    foreach (IntPtr h in list) {
      if (Open(h)) {
        PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero);
        while (Open(h) && clock.ElapsedMilliseconds < waitMs) Thread.Sleep(100);
        if (Open(h)) { stuck = true; break; }
      }
      closed++;
      if (closed < list.Count) Thread.Sleep(settleMs);
    }
    return "{\"windows\":" + list.Count + ",\"closed\":" + closed + ",\"stuck\":" + (stuck ? "true" : "false") + "}";
  }
}
'@
  $want = [int]$env:FF_PID
  if ($env:FF_OP -eq 'windows') { (([FFFirefoxWindows]::Find($want, $cls)).Count); exit 0 }
  [FFFirefoxWindows]::Close($want, $cls, [int]$env:FF_WAIT_MS, [int]$env:FF_SETTLE_MS)
  exit 0
}
throw "FF_OP is list, close or windows"
`;

async function winPs(env: Record<string, string>, timeoutMs = 60_000): Promise<string> {
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(WIN_FIREFOX_PS, 'utf16le').toString('base64')], {
    env: { ...process.env, ...env },
    timeoutMs,
  });
  if (r.code !== 0) throw new Error(`powershell ${env.FF_OP} failed (${r.code}): ${r.stderr.trim().split('\n').slice(-3).join(' | ')}`);
  return r.stdout.trim();
}

export async function winListFirefox(name?: string): Promise<{ session: number; procs: FirefoxProc[] }> {
  const j = JSON.parse(await winPs({ FF_OP: 'list', ...(name ? { FF_NAME: name } : {}) })) as { session: number; procs?: FirefoxProc[] | FirefoxProc | null };
  return { session: j.session, procs: j.procs == null ? [] : Array.isArray(j.procs) ? j.procs : [j.procs] };
}

/** A second between windows: Firefox saves a closed window's tabs after it closes (measured enough on beast, w1593). */
export const SETTLE_MS = 1000;

export async function winCloseWindows(pid: number, waitMs: number, o: { cls?: string; settleMs?: number } = {}): Promise<WindowsClosed> {
  const out = await winPs({ FF_OP: 'close', FF_PID: String(pid), FF_WAIT_MS: String(waitMs), FF_SETTLE_MS: String(o.settleMs ?? SETTLE_MS), ...(o.cls ? { FF_CLASS: o.cls } : {}) }, waitMs + 60_000);
  return JSON.parse(out) as WindowsClosed;
}

export async function winCountWindows(pid: number, cls?: string): Promise<number> {
  return Number(await winPs({ FF_OP: 'windows', FF_PID: String(pid), ...(cls ? { FF_CLASS: cls } : {}) })) || 0;
}

/** A profile is open while its parent.lock is held: Firefox keeps the file, and an open fails (EBUSY) only while it runs. */
export function profileInUse(dir: string): boolean {
  const lock = path.join(dir, 'parent.lock');
  if (!fs.existsSync(lock)) return false;
  try {
    fs.closeSync(fs.openSync(lock, 'r'));
    return false;
  } catch (e) {
    return ['EBUSY', 'EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '');
  }
}

/** One line added to the closed profile's prefs.js: read at its next start, and set back to false by Firefox once used. */
export function resumeOnce(dir: string) {
  const prefs = path.join(dir, 'prefs.js');
  if (!fs.existsSync(prefs)) throw new Error('no prefs.js');
  const text = fs.readFileSync(prefs, 'utf8');
  fs.appendFileSync(prefs, `${text.endsWith('\n') ? '' : '\n'}${RESUME_PREF}\n`);
}

export function firefoxProfileDirs(appData = process.env.APPDATA): string[] {
  if (!appData) return [];
  const dir = path.join(appData, 'Mozilla', 'Firefox');
  const ini = path.join(dir, 'profiles.ini');
  return fs.existsSync(ini) ? parseProfilesIni(fs.readFileSync(ini, 'utf8'), dir) : [];
}

export function winFirefoxDeps(log?: (line: string) => void): FirefoxDeps {
  return {
    list: () => winListFirefox(),
    closeWindows: (pid, waitMs) => winCloseWindows(pid, waitMs),
    freeMem: () => os.freemem(),
    profileDirs: () => firefoxProfileDirs(),
    inUse: profileInUse,
    resumeOnce,
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    now: () => Date.now(),
    log,
  };
}
