// The tray app on a Windows PC (w1532, machine/tray/FFFactoryTray.cs; docs/machines.md "Pausing a machine"). The daemon
// runs in the logged-on user's session (a Task Scheduler task with an interactive token, machineDeployWin.ts taskXml), so
// the app it starts shows in that user's notification area: it starts at logon with the daemon. The daemon builds it
// from the source in its own code with the C# compiler .NET Framework 4 puts on every Windows PC, into <app_dir>/tray
// (outside the app folder an update swaps), again whenever the source changes: a daemon update updates the tray. The app
// ends when its stdin closes, so the daemon that stopped takes its tray with it and the next one starts its own.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { spawn, type ChildProcess } from 'node:child_process';
import { run } from '../server/proc.ts';

export const TRAY_EXE = 'FFFactoryTray.exe';
export const TRAY_SOURCES = ['FFFactoryTray.cs', 'fff.ico', 'fff-paused.ico'];
const CSC_ARGS = ['-nologo', '-target:winexe', '-optimize', '-win32icon:fff.ico', '-r:System.Windows.Forms.dll', '-r:System.Drawing.dll', '-r:System.Web.Extensions.dll'];

/** The source folder: beside this file. */
export const traySourceDir = () => path.join(path.dirname(import.meta.filename), 'tray');
export const trayDir = (appDir: string) => path.join(appDir, 'tray');

/** .NET Framework 4's C# compiler (C# 5), on every Windows 10 and 11 PC; the 64-bit one first. */
export function cscPath(windir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows', exists: (p: string) => boolean = fs.existsSync): string | undefined {
  return ['Framework64', 'Framework'].map((f) => path.join(windir, 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe')).find(exists);
}

/** The build's identity: the sources and the compiler arguments. A daemon update that changes any of them rebuilds. */
export function trayBuildId(src: string): string {
  const h = createHash('sha256');
  for (const f of TRAY_SOURCES) h.update(f).update(fs.readFileSync(path.join(src, f)));
  h.update(CSC_ARGS.join(' '));
  return h.digest('hex').slice(0, 16);
}

export interface TrayBuild {
  exe: string;
  built: boolean;
  id: string;
}

/**
 * Build the tray app into `out` when its build id changed (or it is missing): the icons copied beside it, the exe written
 * under another name and moved over the old one, so a tray still closing never leaves a half-written file.
 */
export async function buildTray(src: string, out: string, o: { csc?: string; log?: (l: string) => void } = {}): Promise<TrayBuild> {
  const id = trayBuildId(src);
  const exe = path.join(out, TRAY_EXE);
  const idFile = path.join(out, 'build-id.txt');
  const have = fs.existsSync(exe) && fs.existsSync(idFile) ? fs.readFileSync(idFile, 'utf8').trim() : '';
  if (have === id) return { exe, built: false, id };
  const csc = o.csc ?? cscPath();
  if (!csc) throw new Error('no C# compiler: .NET Framework 4 (Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe) is missing');
  fs.mkdirSync(out, { recursive: true });
  for (const f of TRAY_SOURCES.filter((x) => x.endsWith('.ico'))) fs.copyFileSync(path.join(src, f), path.join(out, f));
  const next = path.join(out, `FFFactoryTray.${id}.exe`);
  const r = await run(csc, [...CSC_ARGS, `-out:${next}`, 'FFFactoryTray.cs'], { cwd: src, timeoutMs: 120_000 });
  if (r.code !== 0 || !fs.existsSync(next)) throw new Error(`csc failed (${r.code}): ${(r.stdout + r.stderr).trim().split('\n').slice(-6).join(' | ')}`);
  // A tray of the daemon before this one may still be closing (it ends when its daemon's pipe closes): wait for it a little.
  for (let i = 0; ; i++) {
    try {
      fs.rmSync(exe, { force: true });
      fs.renameSync(next, exe);
      break;
    } catch (e) {
      if (i >= 30) throw new Error(`could not replace ${exe}: ${(e as Error).message}`);
      await new Promise((res) => setTimeout(res, 500));
    }
  }
  fs.writeFileSync(idFile, `${id}\n`);
  o.log?.(`tray: built ${exe} (build ${id}) with ${csc}`);
  return { exe, built: true, id };
}

export interface TrayHostDeps {
  appDir: string;
  /** One tray per daemon folder (a test daemon's tray runs beside the real one's): the app's single-instance key. */
  instance: string;
  log: (line: string) => void;
  /** A message from the tray (pause, unpause, input, injected, settings, hello, log). */
  message: (msg: Record<string, unknown>) => void;
  /** Its status changed: "running", "starting", "not running: …". */
  status: (s: string) => void;
  src?: string;
}

/** Starts the tray app, keeps it running (backing off 10 s to 5 min when it keeps ending) and carries its messages. */
export class TrayHost {
  private child?: ChildProcess;
  private stopped = false;
  private restarts = 0;
  private timer?: NodeJS.Timeout;
  private startedAt = 0;

  private readonly d: TrayHostDeps;

  constructor(d: TrayHostDeps) {
    this.d = d;}

  async start(): Promise<void> {
    if (this.stopped) return;
    this.d.status('starting');
    let build: TrayBuild;
    try {
      build = await buildTray(this.d.src ?? traySourceDir(), trayDir(this.d.appDir), { log: this.d.log });
    } catch (e) {
      const why = (e as Error).message;
      this.d.log(`tray: not started: ${why}`);
      this.d.status(`not running: ${why}`);
      return;
    }
    if (this.stopped) return;
    const child = spawn(build.exe, ['--instance', this.d.instance], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: false });
    this.child = child;
    this.startedAt = Date.now();
    child.on('error', (e) => this.d.log(`tray: ${e.message}`));
    createInterface({ input: child.stdout! }).on('line', (line) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.d.log(`tray: ${line.slice(0, 300)}`);
        return;
      }
      if (msg.type === 'hello') {
        this.d.log(`tray: running, pid ${msg.pid} in session ${msg.session}, hooks: ${msg.hooks}`);
        this.d.status(msg.hooks === 'keyboard and mouse' ? 'running' : `running, but its input hooks failed`);
      }
      this.d.message(msg);
    });
    createInterface({ input: child.stderr! }).on('line', (line) => this.d.log(`tray (stderr): ${line.slice(0, 300)}`));
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = undefined;
      if (this.stopped) return;
      // Ran a while: a fresh run of restarts; ended at once again: wait longer each time.
      if (Date.now() - this.startedAt > 10 * 60_000) this.restarts = 0;
      const wait = Math.min(300_000, 10_000 * 2 ** this.restarts++);
      this.d.log(`tray: ended (${signal ?? `code ${code}`}); started again in ${Math.round(wait / 1000)} s`);
      this.d.status(`not running: it ended (${signal ?? `code ${code}`}), starting again`);
      this.timer = setTimeout(() => void this.start(), wait);
      this.timer.unref?.();
    });
  }

  send(msg: Record<string, unknown>) {
    const c = this.child;
    if (!c?.stdin || c.stdin.destroyed) return;
    c.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    const c = this.child;
    this.child = undefined;
    if (!c) return;
    // Its stdin closing ends it; a tray that does not end is ended.
    c.stdin?.end();
    setTimeout(() => {
      if (c.exitCode === null && c.signalCode === null) c.kill();
    }, 3000).unref?.();
  }
}

/** The instance key for a daemon folder. */
export const trayInstance = (appDir: string) => createHash('sha256').update(path.resolve(appDir).toLowerCase()).digest('hex').slice(0, 12);
