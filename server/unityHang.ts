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

/** At most `max` automatic restarts within `windowMinutes`; returns whether one more is allowed now. */
export function restartAllowed(recent: { at: string; auto?: boolean }[], now: number, max: number, windowMinutes: number): boolean {
  return recent.filter((r) => r.auto !== false && now - Date.parse(r.at) < windowMinutes * 60_000).length < max;
}

// ---------------------------------------------------------------- the MCP-for-Unity bridge

export const normProject = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').replace(/\/Assets$/i, '').toLowerCase();

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
 * The bridge of the editor that runs now is up (w1829): a port is known and a status file of the project was written at
 * or after `since` (when this editor process was launched or first seen). The port file is written once and outlives
 * every editor (BEAST's slot5 kept one from three days before), so it alone made a booting editor look up at once: its
 * bench boot ticket went 12 s into a 199 s first import, which then ran beside another worker's timed run. The bridge
 * writes the status file when it starts and again every ~5 s, never during the boot. No `since`: the port alone (an
 * editor the daemon found running when it started).
 */
export function bridgeUpSince(project: string, since: number | undefined, dir = path.join(os.homedir(), '.unity-mcp')): boolean {
  if (!bridgeInfo(project, dir).port) return false;
  if (since === undefined) return true;
  const want = normProject(project);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return false;
  }
  for (const n of names) {
    if (!/^unity-mcp-status-.+\.json$/.test(n)) continue;
    try {
      const f = path.join(dir, n);
      if (fs.statSync(f).mtimeMs < since) continue;
      const j = JSON.parse(fs.readFileSync(f, 'utf8')) as { project_path?: string };
      if (j.project_path && normProject(j.project_path) === want) return true;
    } catch {
      // being written; next look
    }
  }
  return false;
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

/**
 * Run a C# snippet in the editor through its MCP bridge (w1398, the live view's dev tier: machine/live.ts): connect,
 * read the WELCOME line, send a framed {"type":"execute_code"} and resolve the editor's answer text, or an error text.
 * Never throws. The editor compiles the snippet first (about a second). `safetyChecks` false lets the snippet call what the
 * bridge refuses by default, such as EditorApplication.Exit (w1746's save and quit, machine/liveIdle.ts).
 */
export function bridgeExecute(port: number, code: string, timeoutMs = 45_000, host = '127.0.0.1', safetyChecks = true): Promise<string> {
  return new Promise((resolve) => {
    let done = false;
    let buf = Buffer.alloc(0);
    let welcomed = false;
    const sock = net.connect({ port, host });
    const finish = (text: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(text);
    };
    const timer = setTimeout(() => finish('the editor did not answer in time (compiling, or its main thread is busy)'), timeoutMs);
    sock.on('error', (e) => finish(`no bridge: ${e.message}`));
    sock.on('close', () => finish('the bridge closed the connection'));
    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (!welcomed) {
        const nl = buf.indexOf(0x0a);
        if (nl < 0) return;
        if (!buf.subarray(0, nl).toString('ascii').startsWith('WELCOME UNITY-MCP')) return finish('not a Unity MCP bridge');
        welcomed = true;
        buf = buf.subarray(nl + 1);
        const payload = Buffer.from(JSON.stringify({ type: 'execute_code', params: { action: 'execute', code, safety_checks: safetyChecks } }), 'utf8');
        const header = Buffer.alloc(8);
        header.writeBigUInt64BE(BigInt(payload.length));
        sock.write(Buffer.concat([header, payload]));
      }
      if (buf.length >= 8) {
        const len = Number(buf.readBigUInt64BE(0));
        if (buf.length < 8 + len) return;
        const text = buf.subarray(8, 8 + len).toString('utf8');
        try {
          const j = JSON.parse(text) as { status?: string; result?: { success?: boolean; data?: { result?: unknown }; message?: string; error?: string }; error?: string };
          const r = j.result;
          finish(r?.success ? String(r.data?.result ?? '') : `error: ${r?.error ?? r?.message ?? j.error ?? text.slice(0, 200)}`);
        } catch {
          finish(text.slice(0, 200));
        }
      }
    });
  });
}
