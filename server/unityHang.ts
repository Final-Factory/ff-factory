import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * Hang and crash detection for Unity editors (docs/unity-lifecycle.md), shared by the server (sandbox editors
 * on the host) and the machine daemon (the editor of a Mac's clone). The verdict is a pure function of what
 * was observed; the callers measure and act.
 *
 * Signals:
 *   - the process: gone without a stop we asked for, or a crash reporter for its project -> crashed;
 *   - Windows' "not responding" for its main window (IsHungAppWindow);
 *   - the MCP-for-Unity bridge: a JSON {"type":"ping"} command, which the editor answers from its main
 *     thread (EditorApplication.update), so a frozen editor cannot (the bare framed "ping" is answered by
 *     the socket thread and proves nothing);
 *   - the editor log growing: imports, compiles, test runs and builds all log as they go.
 * A long import or compile keeps the log growing (or the bridge reports reloading), so it never counts as
 * hung; only an editor that is silent on every channel for long does.
 */

export interface HangThresholds {
  /** Window not responding AND log silent this long: hung. */
  notRespondingSeconds: number;
  /** Bridge not answering AND log silent this long (not reloading): hung. */
  bridgeSilentMinutes: number;
  /** Bridge says reloading AND log silent this long: stuck in a domain reload. */
  reloadingMinutes: number;
  /** Starting (bridge never up yet) AND log silent this long: stuck starting. */
  startupStallMinutes: number;
}

export const DEFAULT_HANG: HangThresholds = { notRespondingSeconds: 180, bridgeSilentMinutes: 10, reloadingMinutes: 45, startupStallMinutes: 15 };

export interface EditorObservation {
  /** The editor's process is alive. */
  alive: boolean;
  /** We asked it to stop (or it was never ours to watch). */
  expectedExit?: boolean;
  /** A crash reporter (UnityBugReporter / crash handler window) for this project is open. */
  crashReporter?: boolean;
  /** 'starting': not yet up (the bridge never answered since launch); 'running': it has been up. */
  phase: 'starting' | 'running';
  /** A modal dialog the watchdog handles or reports; a dialog is not a hang. */
  dialog?: boolean;
  /** Since when (ms) the main window is "not responding", if it is. */
  notRespondingSince?: number;
  /** Since when (ms) the bridge has not answered a ping, if it does not. */
  bridgeFailingSince?: number;
  /** The bridge's status file says it is reloading (domain reload, compile). */
  reloading?: boolean;
  /** Last time (ms) the editor log grew. */
  logGrewAt: number;
}

export type Verdict = { kind: 'ok' } | { kind: 'crashed'; why: string } | { kind: 'hung'; why: string };

export function editorVerdict(o: EditorObservation, now: number, t: HangThresholds = DEFAULT_HANG): Verdict {
  if (!o.alive) return o.expectedExit ? { kind: 'ok' } : { kind: 'crashed', why: 'the editor process is gone' };
  if (o.crashReporter) return { kind: 'crashed', why: "Unity's crash reporter is open for this project" };
  if (o.dialog) return { kind: 'ok' }; // the dialog watchdog's business
  const quiet = now - o.logGrewAt;
  const min = 60_000;
  const secs = (ms: number) => (ms >= 2 * min ? `${Math.round(ms / min)} min` : `${Math.round(ms / 1000)} s`);
  if (o.phase === 'starting') {
    if (quiet >= t.startupStallMinutes * min) return { kind: 'hung', why: `no startup progress for ${secs(quiet)} (the log stopped growing)` };
    return { kind: 'ok' };
  }
  if (o.notRespondingSince !== undefined) {
    const nr = now - o.notRespondingSince;
    if (nr >= t.notRespondingSeconds * 1000 && quiet >= t.notRespondingSeconds * 1000) return { kind: 'hung', why: `Windows reports it not responding for ${secs(nr)}, and its log has been silent for ${secs(quiet)}` };
  }
  if (o.bridgeFailingSince !== undefined) {
    const bf = now - o.bridgeFailingSince;
    if (o.reloading) {
      if (bf >= t.reloadingMinutes * min && quiet >= t.bridgeSilentMinutes * min) return { kind: 'hung', why: `stuck reloading for ${secs(bf)} with a silent log (${secs(quiet)})` };
    } else if (bf >= t.bridgeSilentMinutes * min && quiet >= t.bridgeSilentMinutes * min) {
      return { kind: 'hung', why: `the Unity MCP bridge has not answered for ${secs(bf)} and its log has been silent for ${secs(quiet)}` };
    }
  }
  return { kind: 'ok' };
}

type ProcLike = { pid: number; name: string; cmd: string };

/**
 * Unity's bug reporter open for a project (it starts after a crash with --unity_project "<path>"): crash
 * evidence. UnityCrashHandler64 is not: on Windows it runs beside every healthy editor.
 */
export function crashReportersFor(procs: ProcLike[], project: string): ProcLike[] {
  const want = normProject(project);
  return procs.filter((p) => /UnityBugReporter|Unity Bug Reporter/i.test(`${p.name} ${p.cmd}`) && p.cmd.replace(/\\/g, '/').toLowerCase().includes(want));
}

/** What a dead or killed editor leaves behind: its bug reporter, and crash handlers attached to it (--attach <pid>) or naming the project. */
export function crashLeftoversFor(procs: ProcLike[], project: string, editorPid?: number): ProcLike[] {
  const want = normProject(project);
  return procs.filter((p) => {
    const text = `${p.name} ${p.cmd}`;
    if (!/UnityBugReporter|Unity Bug Reporter|UnityCrashHandler/i.test(text)) return false;
    if (p.cmd.replace(/\\/g, '/').toLowerCase().includes(want)) return true;
    return editorPid !== undefined && new RegExp(`--attach\\s+${editorPid}\\b`).test(p.cmd);
  });
}

/** At most `max` automatic restarts within `windowMinutes`; returns whether one more is allowed now. */
export function restartAllowed(recent: { at: string; auto?: boolean }[], now: number, max: number, windowMinutes: number): boolean {
  return recent.filter((r) => r.auto !== false && now - Date.parse(r.at) < windowMinutes * 60_000).length < max;
}

// ---------------------------------------------------------------- the MCP-for-Unity bridge

const normProject = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').replace(/\/Assets$/i, '').toLowerCase();

/** The bridge's port and reloading flag for a project, from ~/.unity-mcp (unity-mcp-status-*, unity-mcp-port-*). */
export function bridgeInfo(project: string, dir = path.join(os.homedir(), '.unity-mcp')): { port?: number; reloading?: boolean } {
  const want = normProject(project);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return {};
  }
  const out: { port?: number; reloading?: boolean } = {};
  for (const n of names) {
    if (!/^unity-mcp-(status|port)-.+\.json$/.test(n)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as { project_path?: string; unity_port?: number; reloading?: boolean };
      if (!j.project_path || normProject(j.project_path) !== want) continue;
      if (n.startsWith('unity-mcp-status-')) {
        out.reloading = !!j.reloading;
        out.port = out.port ?? j.unity_port;
      } else out.port = j.unity_port ?? out.port;
    } catch {
      // being written; next look
    }
  }
  return out;
}

/**
 * Ping the editor's main thread through the bridge: connect, read the WELCOME line, send a framed
 * {"type":"ping"} (8-byte big-endian length, then UTF-8), expect "pong". Resolves true or false, never throws.
 */
export function bridgePing(port: number, timeoutMs = 8000, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let buf = Buffer.alloc(0);
    let welcomed = false;
    const sock = net.connect({ port, host });
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.on('error', () => finish(false));
    sock.on('close', () => finish(false));
    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (!welcomed) {
        const nl = buf.indexOf(0x0a);
        if (nl < 0) return;
        if (!buf.subarray(0, nl).toString('ascii').startsWith('WELCOME UNITY-MCP')) return finish(false);
        welcomed = true;
        buf = buf.subarray(nl + 1);
        const payload = Buffer.from(JSON.stringify({ type: 'ping', params: {} }), 'utf8');
        const header = Buffer.alloc(8);
        header.writeBigUInt64BE(BigInt(payload.length));
        sock.write(Buffer.concat([header, payload]));
      }
      if (buf.length >= 8) {
        const len = Number(buf.readBigUInt64BE(0));
        if (buf.length >= 8 + len) finish(buf.subarray(8, 8 + len).toString('utf8').includes('pong'));
      }
    });
  });
}
