import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../server/proc.ts';
import { DEFAULT_HANG, bridgeInfo, bridgePing, editorVerdict, restartAllowed, type HangThresholds } from '../server/unityHang.ts';

/**
 * The Unity editor of a machine's clone (docs/unity-lifecycle.md), managed by the daemon on the Mac: status,
 * start, stop (graceful, then forced) and restart, for the orchestrator and machine workers (the "unity" tool),
 * and an automatic restart of a hung or crashed editor (MacUnityWatch). It only ever touches the editor that
 * has this clone open (and the processes that editor started), never git and never another project's editor.
 */

export interface Proc {
  pid: number;
  ppid: number;
  cmd: string;
}

export interface UnityDeps {
  /** Every process: pid, parent, full command line. */
  procs(): Promise<Proc[]>;
  kill(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  launch(bin: string, args: string[], cwd: string): number;
  exists(p: string): boolean;
  remove(p: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

const norm = (p: string) => p.replace(/\/+$/, '');

/** The -projectPath of a Unity command line (Hub writes -projectpath), or undefined. */
export function projectPathOf(cmd: string): string | undefined {
  const m = /-projectpath\s+("([^"]+)"|(\S+))/i.exec(cmd);
  return m ? norm(m[2] ?? m[3]) : undefined;
}

/** Unity editors with `repo` open: the Unity binary itself, with that project path. */
export function editorsFor(procs: Proc[], repo: string): Proc[] {
  return procs.filter((p) => /\/Unity\.app\/Contents\/MacOS\/Unity(\s|$)/.test(p.cmd) && projectPathOf(p.cmd) === norm(repo));
}

/** A process and everything it started (shader compilers, bee, Unity Helper, a crash reporter it spawned). */
export function treeOf(procs: Proc[], root: number): number[] {
  const out = [root];
  for (let i = 0; i < out.length; i++) for (const p of procs) if (p.ppid === out[i] && !out.includes(p.pid)) out.push(p.pid);
  return out;
}

/** Crash reporters left for this project (their parent editor may be gone already). */
export function reportersFor(procs: Proc[], repo: string): Proc[] {
  return procs.filter((p) => /Unity ?Bug ?Reporter|UnityCrashHandler/i.test(p.cmd) && p.cmd.includes(norm(repo)));
}

/** The editor binary for the project's Unity version (ProjectSettings/ProjectVersion.txt), in the Hub's folders. */
export function editorBinary(repo: string, exists: (p: string) => boolean, read: (p: string) => string, home = os.homedir()): string {
  let version = '';
  try {
    version = /m_EditorVersion:\s*(\S+)/.exec(read(path.posix.join(repo, 'ProjectSettings', 'ProjectVersion.txt')))?.[1] ?? '';
  } catch {
    // no version file
  }
  if (!version) throw new Error(`no Unity version in ${repo}/ProjectSettings/ProjectVersion.txt`);
  for (const base of ['/Applications/Unity/Hub/Editor', path.posix.join(home, 'Applications/Unity/Hub/Editor')]) {
    const bin = path.posix.join(base, version, 'Unity.app/Contents/MacOS/Unity');
    if (exists(bin)) return bin;
  }
  throw new Error(`Unity ${version} is not installed in /Applications/Unity/Hub/Editor (install it with Unity Hub)`);
}

export class MacUnity {
  readonly repo: string;
  private readonly d: UnityDeps;
  private readonly bin: () => string;

  constructor(repo: string, deps: UnityDeps = realDeps(), bin?: () => string) {
    this.repo = norm(repo);
    this.d = deps;
    this.bin = bin ?? (() => editorBinary(this.repo, fs.existsSync, (p) => fs.readFileSync(p, 'utf8')));
  }

  /** Every process now (for the watch). */
  procsNow(): Promise<Proc[]> {
    return this.d.procs();
  }

  async status(): Promise<string> {
    const procs = await this.d.procs();
    const eds = editorsFor(procs, this.repo);
    const reporters = reportersFor(procs, this.repo);
    const lock = path.posix.join(this.repo, 'Temp', 'UnityLockfile');
    const parts = [eds.length ? `running: pid ${eds.map((e) => e.pid).join(', ')}` : 'not running', `project ${this.repo}`];
    if (reporters.length) parts.push(`crash reporter open (pid ${reporters.map((r) => r.pid).join(', ')}): the editor crashed`);
    if (!eds.length && this.d.exists(lock)) parts.push('a stale Temp/UnityLockfile is left (start removes it)');
    return parts.join('; ');
  }

  /**
   * Stop the editor of this clone. Graceful first (SIGTERM, up to `graceMs`), then SIGKILL of the editor and
   * everything it started; `force` skips the graceful step (a frozen editor ignores it anyway). Crash reporters
   * for this project go too, and the lock file an editor killed this way leaves behind is removed.
   */
  async stop(opts: { force?: boolean; graceMs?: number } = {}): Promise<string> {
    let procs = await this.d.procs();
    const eds = editorsFor(procs, this.repo);
    const notes: string[] = [];
    if (!eds.length) notes.push('no editor was running');
    if (eds.length && !opts.force) {
      for (const e of eds) this.d.kill(e.pid, 'SIGTERM');
      const until = this.d.now() + (opts.graceMs ?? 30_000);
      while (this.d.now() < until) {
        await this.d.sleep(1000);
        procs = await this.d.procs();
        if (!editorsFor(procs, this.repo).length) break;
      }
      if (!editorsFor(procs, this.repo).length) notes.push(`quit gracefully (pid ${eds.map((e) => e.pid).join(', ')})`);
    }
    const left = editorsFor(procs, this.repo);
    if (left.length) {
      const pids = [...new Set(left.flatMap((e) => treeOf(procs, e.pid)))];
      for (const pid of pids) this.d.kill(pid, 'SIGKILL');
      notes.push(`${opts.force ? 'force-killed' : 'did not quit in time; force-killed'} pid ${left.map((e) => e.pid).join(', ')} and ${pids.length - left.length} process(es) it started`);
      for (let i = 0; i < 15; i++) {
        await this.d.sleep(1000);
        procs = await this.d.procs();
        if (!editorsFor(procs, this.repo).length) break;
      }
    }
    const reporters = reportersFor(procs, this.repo);
    for (const r of reporters) this.d.kill(r.pid, 'SIGKILL');
    if (reporters.length) notes.push(`closed ${reporters.length} crash reporter(s)`);
    procs = await this.d.procs();
    if (editorsFor(procs, this.repo).length) throw new Error(`the editor is still running after SIGKILL (${notes.join('; ')})`);
    const lock = path.posix.join(this.repo, 'Temp', 'UnityLockfile');
    if (this.d.exists(lock)) {
      this.d.remove(lock);
      notes.push('removed the stale Temp/UnityLockfile');
    }
    return `Stopped: ${notes.join('; ')}.`;
  }

  /** Start the editor for this clone (nothing if one already has it open). */
  async start(): Promise<string> {
    const procs = await this.d.procs();
    const eds = editorsFor(procs, this.repo);
    if (eds.length) return `Already running (pid ${eds.map((e) => e.pid).join(', ')}).`;
    const lock = path.posix.join(this.repo, 'Temp', 'UnityLockfile');
    if (this.d.exists(lock)) this.d.remove(lock); // no editor has the project open, so the lock is stale
    const bin = this.bin();
    const pid = this.d.launch(bin, ['-projectPath', this.repo], this.repo);
    for (let i = 0; i < 10; i++) {
      await this.d.sleep(1000);
      if (editorsFor(await this.d.procs(), this.repo).length) break;
    }
    return `Started ${bin} (pid ${pid}). The Unity MCP bridge comes up once the project has loaded (a minute or more); wait for it before Unity MCP calls.`;
  }

  async restart(opts: { force?: boolean } = {}): Promise<string> {
    const stopped = await this.stop(opts);
    return `${stopped} ${await this.start()}`;
  }
}

/** The real Mac: ps, signals, a detached launch. */
export function realDeps(): UnityDeps {
  return {
    procs: async () => {
      const r = await run('ps', ['-axo', 'pid=,ppid=,command='], { timeoutMs: 15_000 });
      return r.stdout
        .split('\n')
        .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }));
    },
    kill: (pid, signal) => {
      try {
        process.kill(pid, signal);
      } catch {
        // already gone
      }
    },
    launch: (bin, args, cwd) => {
      const child = spawn(bin, args, { cwd, detached: true, stdio: 'ignore' });
      child.unref();
      if (!child.pid) throw new Error(`could not start ${bin}`);
      return child.pid;
    },
    exists: (p) => fs.existsSync(p),
    remove: (p) => fs.rmSync(p, { force: true }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}

// ---------------------------------------------------------------- the watch: hangs and crashes, restarted

export interface WatchDeps {
  /** Size and last-write time of the editor log, or undefined when there is none. */
  logStat(): { size: number; mtimeMs: number } | undefined;
  /** The last few KB of the editor log (crash evidence after the editor is gone). */
  logTail(): string;
  bridge(): { port?: number; reloading?: boolean };
  ping(port: number): Promise<boolean>;
  now(): number;
}

/** What Unity writes to its log when it crashes (macOS: signals and the native crash reporter). */
export const CRASH_MARKERS = /Crash!!!|Received signal SIG(SEGV|BUS|ABRT|ILL|FPE)|Native Crash Reporting|Obtained \d+ stack frames/;

export const MAC_EDITOR_LOG = path.join(os.homedir(), 'Library', 'Logs', 'Unity', 'Editor.log');

/**
 * Watches the editor of a machine's clone every `everyMs` (the daemon starts it): an editor judged hung by
 * editorVerdict (server/unityHang.ts: the bridge silent and the log silent for long, a crash reporter) is
 * restarted; one that vanished is started again only when there is crash evidence (a crash reporter, crash
 * lines at the end of its log), never when someone simply quit it. At most `max` automatic restarts per
 * `windowMinutes`; then it reports once and leaves the editor alone until the window has passed.
 */
export class MacUnityWatch {
  private readonly u: MacUnity;
  private readonly d: WatchDeps;
  private readonly report: (text: string, restarted: boolean) => void;
  private readonly opts: { max: number; windowMinutes: number; hang: HangThresholds };
  private pid = 0;
  private bridgeUp = false;
  private bridgeFailingSince?: number;
  private logSize = -1;
  private logGrewAt = 0;
  private expectedUntil = 0;
  private restarts: { at: string }[] = [];
  private gaveUpAt = 0;
  private busy = false;
  /** The watch launched the current editor itself (a restart): only then does a startup stall count. */
  private launchedByUs = false;

  constructor(u: MacUnity, report: (text: string, restarted: boolean) => void, deps: Partial<WatchDeps> = {}, opts: Partial<{ max: number; windowMinutes: number; hang: HangThresholds }> = {}) {
    this.u = u;
    this.report = report;
    this.opts = { max: 3, windowMinutes: 30, hang: DEFAULT_HANG, ...opts };
    this.d = {
      logStat: () => {
        try {
          const s = fs.statSync(MAC_EDITOR_LOG);
          return { size: s.size, mtimeMs: s.mtimeMs };
        } catch {
          return undefined;
        }
      },
      logTail: () => {
        try {
          const fd = fs.openSync(MAC_EDITOR_LOG, 'r');
          try {
            const size = fs.fstatSync(fd).size;
            const n = Math.min(size, 16 * 1024);
            const buf = Buffer.alloc(n);
            fs.readSync(fd, buf, 0, n, size - n);
            return buf.toString('utf8');
          } finally {
            fs.closeSync(fd);
          }
        } catch {
          return '';
        }
      },
      bridge: () => bridgeInfo(u.repo),
      ping: (port) => bridgePing(port),
      now: () => Date.now(),
      ...deps,
    };
  }

  /** A stop or restart asked for through the tool: the editor going away is not a crash. */
  expectExit(ms = 5 * 60_000) {
    this.expectedUntil = this.d.now() + ms;
  }

  /** One look. Returns what it did (for tests); never throws. */
  async tick(): Promise<'ok' | 'restarted' | 'gave-up' | 'skipped'> {
    if (this.busy) return 'skipped';
    this.busy = true;
    try {
      return await this.look();
    } catch (e) {
      this.report(`Unity watch on this machine failed: ${(e as Error).message}`, false);
      return 'ok';
    } finally {
      this.busy = false;
    }
  }

  private async look(): Promise<'ok' | 'restarted' | 'gave-up'> {
    const now = this.d.now();
    const procs = await this.u.procsNow();
    const eds = editorsFor(procs, this.u.repo);
    const st = this.d.logStat();
    if (st && st.size !== this.logSize) {
      if (this.logSize >= 0 || !this.logGrewAt) this.logGrewAt = st.mtimeMs;
      this.logSize = st.size;
    }
    if (!eds.length) {
      const had = this.pid;
      this.pid = 0;
      this.bridgeUp = false;
      this.bridgeFailingSince = undefined;
      if (!had || now < this.expectedUntil) return 'ok';
      const evidence = reportersFor(procs, this.u.repo).length ? 'its crash reporter is open' : CRASH_MARKERS.test(this.d.logTail()) ? 'its log ends in a crash' : '';
      if (!evidence) return 'ok'; // quit by someone: leave it closed
      return this.restart(`the editor crashed (${evidence})`, now);
    }
    const pid = eds[0].pid;
    if (pid !== this.pid) {
      this.pid = pid;
      this.bridgeUp = false;
      this.bridgeFailingSince = undefined;
      this.logGrewAt = Math.max(this.logGrewAt, now);
    }
    const b = this.d.bridge();
    const ok = b.port ? await this.d.ping(b.port) : false;
    if (ok) {
      this.bridgeUp = true;
      this.launchedByUs = false;
      this.bridgeFailingSince = undefined;
    } else if (this.bridgeUp && this.bridgeFailingSince === undefined) this.bridgeFailingSince = now;
    // A silent bridge counts only once it has answered for this editor (an editor running without the bridge,
    // or before it is up, is never judged by it); a startup stall only for an editor the watch launched.
    const v = editorVerdict(
      {
        alive: true,
        crashReporter: reportersFor(procs, this.u.repo).length > 0,
        phase: this.launchedByUs && !this.bridgeUp ? 'starting' : 'running',
        bridgeFailingSince: this.bridgeFailingSince,
        reloading: b.reloading,
        logGrewAt: this.logGrewAt,
      },
      now,
      this.opts.hang,
    );
    if (v.kind === 'ok') return 'ok';
    return this.restart(`the editor ${v.kind === 'crashed' ? 'crashed' : 'hung'}: ${v.why}`, now);
  }

  private async restart(why: string, now: number): Promise<'restarted' | 'gave-up'> {
    this.restarts = this.restarts.filter((r) => now - Date.parse(r.at) < this.opts.windowMinutes * 60_000);
    if (!restartAllowed(this.restarts, now, this.opts.max, this.opts.windowMinutes)) {
      if (now - this.gaveUpAt > this.opts.windowMinutes * 60_000) {
        this.gaveUpAt = now;
        this.report(`Unity on this machine ${why}, but it was already restarted ${this.opts.max} times in ${this.opts.windowMinutes} min; leaving it for a person (the unity tool still restarts it).`, false);
      }
      return 'gave-up';
    }
    this.restarts.push({ at: new Date(now).toISOString() });
    this.expectExit();
    let text: string;
    try {
      text = await this.u.restart({ force: true });
    } catch (e) {
      this.report(`Unity on this machine ${why}; restarting it failed: ${(e as Error).message}`, false);
      return 'restarted';
    }
    this.pid = 0;
    this.bridgeUp = false;
    this.launchedByUs = true;
    this.bridgeFailingSince = undefined;
    this.logGrewAt = now;
    this.report(`Unity on this machine ${why}; restarted it automatically (${this.restarts.length} in the last ${this.opts.windowMinutes} min). ${text}`, true);
    return 'restarted';
  }
}
