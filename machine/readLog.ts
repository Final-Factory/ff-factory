/**
 * The worker read log (w6599; docs/worker-fence.md "The read log"). lothsahn's answer, 2026-11-27: "Keep today's fence and add read
 * logging only": no change to the fences and none to any system drive; the daemon records what workers read outside the work
 * folder and flags it, but blocks nothing; it logs only paths and the reading process, never file contents or credentials.
 *
 * Windows only for now. The daemon (Medium, a member of Administrators or Performance Log Users) runs machine/winReadLog.cs, a
 * real-time ETW session on Windows' own Kernel-Process and Kernel-File providers. The helper follows every process below the
 * live agent hosts and reports each file one of them opens (Kernel-File's Create, which a stat or a directory listing also
 * makes, so "read" here means "opened") outside READ_ALLOW_WIN. The daemon writes each to `<appDir>/logs/read-log-<UTC
 * date>.jsonl` and flags it once a day per worker and folder in daemon.log, `read log: ...`.
 *
 * daemon.json `readLog`: "warn" (unset: the default) logs; "off" starts no session and stops one an earlier daemon left behind:
 * the way back with nobody at the machine (`ops_worker machine_update read_log off`, or the installer's --read-log / -ReadLog).
 * A helper that cannot start (no rights, no compiler) logs why, retries hourly and stops nothing else.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { csHelper } from './workerCaps.ts';

export type ReadLogMode = 'off' | 'warn';

/** daemon.json `readLog`: off, or warn (unset or anything else: warn, the default, which only logs). */
export function readLogModeOf(v: unknown): ReadLogMode {
  return v === 'off' ? 'off' : 'warn';
}

/** The ETW session's name: one a machine (one daemon a machine). */
export const READ_LOG_SESSION = 'ffw-readlog';

export interface AllowEntry {
  /** The folder (everything at or under it is allowed) or, with `exact`, the one path. */
  path: string;
  exact?: true;
  /** Why workers may read it: every entry carries its reason (lothsahn: "Workers should have to justify allowlists"). */
  why: string;
}

/**
 * What workers may read outside the work folder without a log line, each with its reason. A new entry is added by a harness PR
 * with its reason, never granted ad hoc. Profiles (C:\Users\...) and Public are not here: a read there is what the log is for.
 */
export function readAllowWin(env: NodeJS.ProcessEnv, root: string): AllowEntry[] {
  const out: AllowEntry[] = [{ path: root, why: 'the work folder: sandboxes, temp folders, tools, the workers\' own home' }];
  const add = (p: string | undefined, why: string, exact?: true) => {
    if (p) out.push({ path: p, why, ...(exact ? { exact } : {}) });
  };
  add(env.SystemRoot, 'Windows itself: every program loads its DLLs, fonts, locale and certificate stores from here');
  add(env.ProgramFiles, 'installed programs and runtimes workers\' tools load: PowerShell, .NET, the Visual C++ runtime, GPU drivers\' user parts');
  add(env['ProgramFiles(x86)'], 'the 32-bit side of Program Files, for the same reason');
  add(env.ProgramData, 'machine-wide settings programs need: the Unity licence, the keys and certificates TLS uses (lothsahn, w6599 card: "ProgramData stays readable")');
  // A drive's root and the folders above the work folder, as paths only: resolving a path or listing its parent opens them.
  const drives = new Set<string>();
  for (const p of [root, env.SystemRoot]) if (p && /^[A-Za-z]:/.test(p)) drives.add(`${p.slice(0, 2).toUpperCase()}\\`);
  for (const d of drives) add(d, 'a drive\'s root, opened by path resolution (the folder, not what is in it)', true);
  for (let p = path.win32.dirname(root); p.length > 3 && p !== path.win32.dirname(p); p = path.win32.dirname(p)) {
    add(p, 'a folder above the work folder, opened by path resolution (the folder, not what is in it)', true);
  }
  return out;
}

export interface ReadLine {
  root: number;
  /** The host record's start time (Unix ms) the daemon sent with the root, so a reused root pid names no other session. */
  rootAt?: number;
  pid: number;
  image: string;
  path: string;
}

export interface ReadStat {
  fileEvents: number;
  procEvents: number;
  tracked: number;
  reported: number;
  dropped: number;
  lost: number;
}

export interface ReadLogDeps {
  appDir: string;
  /** The worker root; unset (a daemon without one) logs nothing. */
  root?: string;
  mode: ReadLogMode;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** The live agent hosts: their processes' descendants are the workers whose reads are logged. */
  hosts: () => { session: string; pid: number; startedAt?: number; sandbox?: string }[];
  log: (line: string) => void;
  now?: () => Date;
  /** The helper's exe; csHelper by default. */
  helper?: () => string | undefined;
  /** Starts the helper; node's spawn by default. */
  start?: (exe: string, args: string[]) => ChildProcess;
}

/** A day's read-log file over this is not written further that day (the count still goes into the daily line). */
export const READ_LOG_MAX_BYTES = 50 * 1024 * 1024;
/** Days a read-log file is kept. */
export const READ_LOG_KEEP_DAYS = 14;
/** daemon.log lines a day (one per worker and folder); past it, only the count. */
export const READ_LOG_LINES_A_DAY = 300;
/** A host's name is kept this long after it was last live, for the reads of its orphaned tools (they stay followed). */
const NAME_KEEP_MS = 24 * 60 * 60_000;
const RETRY_MS = 60 * 60_000;

/** The folder a path's log line is grouped by: the path's first three parts (`C:\Users\rydin`), the file for a shorter one. */
export function folderOf(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  if (p.startsWith('\\\\')) return `\\\\${parts.slice(0, 3).join('\\')}`;
  return parts.slice(0, 3).join('\\');
}

export class ReadLog {
  private child?: ChildProcess;
  private stopped = false;
  private retry?: NodeJS.Timeout;
  private rootsSent = '';
  private firstStat = true;
  private day = '';
  private flagged = new Set<string>();
  private lines = 0;
  private unflagged = 0;
  private bytes = 0;
  /** By `<pid>:<startedAt>`, as the helper names a read's host. */
  private readonly sessions = new Map<string, { session: string; sandbox?: string; seen: number }>();
  private readonly now: () => Date;
  private readonly platform: NodeJS.Platform;

  private readonly d: ReadLogDeps;

  constructor(d: ReadLogDeps) {
    this.d = d;
    this.now = d.now ?? (() => new Date());
    this.platform = d.platform ?? process.platform;
  }

  get enabled(): boolean {
    return this.platform === 'win32' && this.d.mode !== 'off' && !!this.d.root;
  }

  /** Starts the helper (warn), or stops a session an earlier daemon left behind (off). Never throws. */
  start(): void {
    if (this.platform !== 'win32') return;
    try {
      this.prune();
      const exe = (this.d.helper ?? (() => csHelper(this.d.appDir, path.join(import.meta.dirname, 'winReadLog.cs'), 'ffreadlog', 'read log: the helper', this.d.log)))();
      if (this.d.mode === 'off' || !this.d.root) {
        if (exe) spawnSync(exe, [READ_LOG_SESSION, 'stop'], { windowsHide: true, timeout: 30_000, stdio: 'ignore' });
        return;
      }
      if (!exe) return this.later('the helper could not be built');
      this.launch(exe);
    } catch (e) {
      this.later(`it failed to start: ${(e as Error).message}`);
    }
  }

  private later(why: string): void {
    this.d.log(`read log: off for now, ${why}; tried again in an hour (warn only: nothing is refused either way)`);
    if (this.stopped) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.start(), RETRY_MS);
    this.retry.unref?.();
  }

  private launch(exe: string): void {
    const child = (this.d.start ?? ((e, a) => spawn(e, a, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })))(exe, [READ_LOG_SESSION]);
    this.child = child;
    this.rootsSent = '';
    this.firstStat = true;
    let error: string | undefined;
    child.stdin?.on('error', () => undefined);
    child.on('error', (e) => (error = e.message));
    for (const a of readAllowWin(this.d.env ?? process.env, this.d.root!)) child.stdin?.write(`${a.exact ? 'exact' : 'allow'} ${a.path}\n`);
    // w6715: an orphaned Low process counts as a worker's only when it runs a program from here or carries FF_SESSION_ID
    child.stdin?.write(`work ${this.d.root}\n`);
    this.tick();
    const rl = readline.createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.event === 'ready') this.d.log(`read log: running (warn only: it records what workers open outside ${this.d.root} and refuses nothing)`);
      else if (m.event === 'error') error = String(m.why);
      else if (m.event === 'read') this.onRead(m as unknown as ReadLine);
      else if (m.event === 'stat') this.onStat(m as unknown as ReadStat);
      else if (m.event === 'trace') this.d.log(`read log trace: ${String(m.msg)}`);
      else if (m.event === 'root-refused') this.d.log(`read log: agent host ${String(m.root)} not followed: ${String(m.why)}`);
    });
    child.on('exit', (code) => {
      if (this.child === child) this.child = undefined;
      if (this.stopped) return;
      this.later(error ?? `its helper ended (exit ${code})`);
    });
  }

  /** Sends the live hosts to the helper when they changed; the daemon calls it every few seconds. */
  tick(): void {
    const child = this.child;
    if (!child?.stdin || this.stopped) return;
    // w6728: a host without a start time is not sent: the helper takes a pid only for the process that started with its host
    const hosts = this.d.hosts().filter((h) => h.pid > 0 && h.startedAt);
    const now = this.now().getTime();
    for (const h of hosts) this.sessions.set(`${h.pid}:${h.startedAt}`, { session: h.session, ...(h.sandbox ? { sandbox: h.sandbox } : {}), seen: now });
    // a host gone keeps its name a day: its orphaned tools stay followed, each by its own creation time
    for (const [k, s] of this.sessions) if (now - s.seen > NAME_KEEP_MS) this.sessions.delete(k);
    const roots = hosts.map((h) => `${h.pid}:${h.startedAt}`).sort().join(' ');
    if (roots === this.rootsSent) return;
    this.rootsSent = roots;
    child.stdin.write(`roots ${roots}\n`);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    // its stdin closed, the helper stops its session and exits
    this.child?.stdin?.end();
  }

  private file(t: Date): string {
    return path.join(this.d.appDir, 'logs', `read-log-${t.toISOString().slice(0, 10)}.jsonl`);
  }

  private onRead(r: ReadLine): void {
    const t = this.now();
    const day = t.toISOString().slice(0, 10);
    if (day !== this.day) {
      if (this.day && this.unflagged) this.d.log(`read log: ${this.unflagged} more reads outside the work folder on ${this.day}, past ${READ_LOG_LINES_A_DAY} lines (in ${this.file(new Date(`${this.day}T00:00:00Z`))})`);
      this.day = day;
      this.flagged.clear();
      this.lines = 0;
      this.unflagged = 0;
      try {
        this.bytes = fs.statSync(this.file(t)).size;
      } catch {
        this.bytes = 0;
      }
    }
    const who = this.sessions.get(`${r.root}:${r.rootAt}`);
    const entry = JSON.stringify({ t: t.toISOString(), session: who?.session ?? null, ...(who?.sandbox ? { sandbox: who.sandbox } : {}), pid: r.pid, image: r.image, path: r.path });
    if (this.bytes < READ_LOG_MAX_BYTES) {
      try {
        fs.mkdirSync(path.dirname(this.file(t)), { recursive: true });
        fs.appendFileSync(this.file(t), `${entry}\n`);
        this.bytes += entry.length + 1;
      } catch {
        // a full disk or a locked file: the line is lost, the daemon goes on
      }
    }
    const folder = folderOf(r.path);
    const key = `${who?.session ?? r.root}|${folder.toLowerCase()}`;
    if (this.flagged.has(key)) return;
    // past the day's lines only the count goes on, and the set stops growing (w6728 N3): a read counted twice is fine
    if (this.lines >= READ_LOG_LINES_A_DAY) {
      this.unflagged++;
      return;
    }
    this.flagged.add(key);
    this.lines++;
    // root 0: a Low process found at the helper's start with no living parent (a tool whose shell exited)
    const name = who ? `${who.session}${who.sandbox ? ` (${who.sandbox})` : ''}` : r.root === 0 ? 'a Low worker process' : `agent host ${r.root}`;
    this.d.log(`read log: ${name}: ${path.win32.basename(r.image) || `pid ${r.pid}`} read ${r.path}, outside the work folder and not on the allowlist (warn only: nothing was refused)`);
  }

  private onStat(s: ReadStat): void {
    if (this.firstStat) {
      this.firstStat = false;
      this.d.log(`read log: its first minute saw ${s.fileEvents} file opens on the machine and ${s.procEvents} process events, followed ${s.tracked} worker processes, reported ${s.reported}${s.fileEvents === 0 ? '. WARNING: no file opens at all: the session runs but Kernel-File gives it nothing' : ''}`);
    }
    if (s.dropped || s.lost) this.d.log(`read log: ${s.dropped} reads over the helper's cap and ${s.lost} events ETW lost in the last minute (not in the file)`);
  }

  /** Read-log files older than READ_LOG_KEEP_DAYS go. */
  private prune(): void {
    const dir = path.join(this.d.appDir, 'logs');
    const cutoff = new Date(this.now().getTime() - READ_LOG_KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const m = /^read-log-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(n);
      if (m && m[1]! < cutoff) fs.rmSync(path.join(dir, n), { force: true });
    }
  }
}
