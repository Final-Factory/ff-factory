// The FF Factory machine daemon (docs/machines.md). Runs on a Mac as a LaunchAgent, keeps a WebSocket
// open to the portal, and runs the portal's agents for this machine locally with the same AgentSession
// code the portal uses, streaming everything they record back.
//
//   node machine/daemon.ts [config.json]      (default ~/.ff-factory/daemon.json)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { AgentSession, type OptionsFactory, type SessionHandle, type SessionSink } from '../server/sessions.ts';
import { bus, type DistributiveOmit } from '../server/store.ts';
import { CATALOG, buildOptions, type CatalogTool, type LaunchSpec, type ToolHandler } from '../server/launch.ts';
import { PROTOCOL_VERSION, type FromDaemon, type SignalName, type ToDaemon } from '../server/machineProtocol.ts';
import { MacUnity, MacUnityWatch } from './unity.ts';
import { run } from '../server/proc.ts';
import { listImages, readImage } from '../server/images.ts';
import { readGitStatus } from '../server/gitStatus.ts';
import { switchBranch } from '../server/switchBranch.ts';
import type { SessionInfo, TranscriptEvent } from '../shared/types.ts';

export interface DaemonConfig {
  /** Portal base URL, e.g. https://<host>.<tailnet>.ts.net */
  portalUrl: string;
  id: string;
  token: string;
  repoPath: string;
  /** The machine's own `claude` (its login, settings and plugins). */
  claude?: string;
  maxSessions?: number;
}

/** Builds a session; the real one is an AgentSession, tests pass a fake. */
export type SessionFactory = (info: SessionInfo, sink: SessionSink, options: OptionsFactory, events: EventEmitter) => SessionHandle;

interface Entry {
  s: SessionHandle;
  spec?: LaunchSpec;
  seq: number;
}

const HOME = os.homedir();
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

export class Daemon {
  private readonly cfg: DaemonConfig;
  /** The Unity editor of this machine's clone (machine/unity.ts). */
  unity: MacUnity;
  /** Its hang and crash watch (auto-restart), started with the daemon. */
  unityWatch?: MacUnityWatch;
  private ws?: WebSocket;
  private readonly entries = new Map<string, Entry>();
  private readonly events = new EventEmitter();
  private readonly outbox: string[] = [];
  private readonly rpcs = new Map<string, { resolve: (t: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private attempt = 0;
  private lastPong = 0;
  private stopped = false;
  private caffeinate?: ChildProcess;
  private maxSessions: number;
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly makeSession: SessionFactory;

  constructor(cfg: DaemonConfig, makeSession: SessionFactory = (info, sink, options, events) => new AgentSession(info, sink, options, events)) {
    this.cfg = cfg;
    this.unity = new MacUnity(cfg.repoPath);
    this.makeSession = makeSession;
    this.maxSessions = cfg.maxSessions ?? 3;
    for (const name of ['turnEnd', 'permission', 'result', 'ended'] as SignalName[]) {
      this.events.on(name, (s: SessionHandle, arg?: unknown) => {
        this.out({ type: 'signal', name, sessionId: s.info.id, arg: name === 'permission' ? undefined : arg });
        this.awake();
      });
    }
    bus.on('event', (e) => {
      if (e.type === 'delta' && this.entries.has(e.sessionId)) this.out({ type: 'delta', sessionId: e.sessionId, text: e.text });
    });
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start() {
    this.connect();
    // The editor of this clone: a hung or crashed one is restarted automatically (machine/unity.ts).
    this.unityWatch = new MacUnityWatch(this.unity, (text, restarted) => {
      log(`unity: ${text}`);
      this.send({ type: 'unity_event', text, restarted });
    });
    this.timers.push(setInterval(() => void this.unityWatch?.tick(), 30_000));
    // App Nap off for Unity (takes effect at the editor's next launch; start() does it too).
    if (process.platform === 'darwin') void this.unity.noAppNap().catch(() => undefined);
    this.timers.push(setInterval(() => this.heartbeat(), 20_000));
    this.timers.push(setInterval(() => void this.reportStatus(), 60_000));
  }

  shutdown() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    for (const e of this.entries.values()) e.s.stop();
    this.caffeinate?.kill();
    this.ws?.close();
  }

  // ---------------------------------------------------------------- connection

  /** When the connection was last lost (0 while connected), for the reconnect pace. */
  private downSince = 0;

  private connect() {
    if (this.stopped) return;
    const url = this.cfg.portalUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + '/machine';
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${this.cfg.token}` }, handshakeTimeout: 8_000 });
    this.ws = ws;
    ws.on('open', () => {
      this.attempt = 0;
      this.downSince = 0;
      this.lastPong = Date.now();
      log(`connected to ${url}`);
      void this.hello();
    });
    ws.on('pong', () => (this.lastPong = Date.now()));
    ws.on('ping', () => (this.lastPong = Date.now()));
    ws.on('message', (d) => {
      this.lastPong = Date.now();
      try {
        this.onMessage(JSON.parse(String(d)) as ToDaemon);
      } catch (e) {
        log('bad message:', (e as Error).message);
      }
    });
    ws.on('unexpected-response', (req, res) => {
      // With this listener, ws leaves the aborting to us: without it each refused attempt (a 502 while the
      // portal restarts) hung until the handshake timeout, and a restart took 40 s to get over.
      log(`portal refused the connection: HTTP ${res.statusCode}`);
      res.resume();
      req.destroy();
      ws.terminate();
    });
    ws.on('error', (e) => log('socket error:', e.message));
    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      if (this.stopped) return;
      // Sleep, wake, a network change or a portal restart: try again, forever. For the first two minutes
      // every ~2 s (a portal restart takes 20-60 s), then back off to 30 s.
      if (!this.downSince) this.downSince = Date.now();
      const delay = reconnectDelayMs(Date.now() - this.downSince, this.attempt);
      this.attempt = Math.min(this.attempt + 1, 6);
      log(`disconnected (${code}); retrying in ${Math.round(delay / 1000)} s`);
      setTimeout(() => this.connect(), delay);
    });
  }

  private heartbeat() {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastPong > 45_000) {
      log('portal silent for 45 s; reconnecting');
      ws.terminate();
      return;
    }
    ws.ping();
  }

  private send(msg: FromDaemon) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Session records and transcript events are queued while disconnected, so a short outage loses nothing. */
  private out(msg: FromDaemon) {
    const data = JSON.stringify(msg);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.flush();
      this.ws.send(data);
    } else if (msg.type !== 'delta') {
      this.outbox.push(data);
      if (this.outbox.length > 20_000) this.outbox.splice(0, this.outbox.length - 20_000);
    }
  }

  private flush() {
    while (this.outbox.length && this.ws?.readyState === WebSocket.OPEN) this.ws.send(this.outbox.shift()!);
  }

  private async hello() {
    const [osv, claude] = await Promise.all([
      run('sw_vers', ['-productVersion'], { timeoutMs: 5000 }),
      run(this.cfg.claude ?? 'claude', ['--version'], { timeoutMs: 15000 }),
    ]);
    this.send({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      home: HOME,
      live: [...this.entries.values()].filter((e) => e.s.live).map((e) => e.s.info.id),
      catalog: Object.keys(CATALOG),
      info: {
        hostname: os.hostname(),
        os: osv.code === 0 ? `macOS ${osv.stdout.trim()}` : `${os.type()} ${os.release()}`,
        node: process.version,
        claude: claude.code === 0 ? claude.stdout.trim().split(/\s+/)[0] : undefined,
        daemon: readVersion(),
      },
    });
    this.flush();
    // The portal showed these stopped while the link was down; give it their real state.
    for (const e of this.entries.values()) this.send({ type: 'session', info: e.s.info, live: e.s.live });
    void this.reportStatus();
  }

  private async reportStatus() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.send({ type: 'status', git: await readGitStatus(this.cfg.repoPath) });
  }

  // ---------------------------------------------------------------- sessions

  private sink(): SessionSink {
    return {
      putSession: (info: SessionInfo) => {
        this.out({ type: 'session', info, live: !!this.entries.get(info.id)?.s.live });
        this.awake();
      },
      append: (sessionId: string, e: DistributiveOmit<TranscriptEvent, 'seq' | 't'>) => {
        const entry = this.entries.get(sessionId)!;
        const full = { ...e, seq: ++entry.seq, t: new Date().toISOString() } as TranscriptEvent;
        this.out({ type: 'event', sessionId, event: full });
        return full;
      },
      amend: (sessionId: string, seq: number, patch: Partial<TranscriptEvent>) => this.out({ type: 'amend', sessionId, seq, patch }),
      saveImage: (sessionId: string, mediaType: string, data: string) => {
        const id = randomUUID();
        this.out({ type: 'image', sessionId, id, mediaType, data });
        return id;
      },
    } as SessionSink;
  }

  private handlers(sessionId: string): Partial<Record<CatalogTool, ToolHandler>> {
    const call = (method: CatalogTool) => (args: Record<string, unknown>) =>
      new Promise<string>((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => {
          this.rpcs.delete(id);
          reject(new Error('the portal did not answer in 60 s'));
        }, 60_000);
        this.rpcs.set(id, { resolve, reject, timer });
        if (this.ws?.readyState !== WebSocket.OPEN) {
          clearTimeout(timer);
          this.rpcs.delete(id);
          return reject(new Error('the portal is unreachable right now'));
        }
        this.send({ type: 'rpc', id, sessionId, method, args });
      });
    // Every tool the portal can answer: it decides per session which ones it serves (MachineManager.answer), and
    // the spec decides which ones the agent sees. (A fixed list here once left wake_me and unity out on the Macs.)
    return Object.fromEntries((Object.keys(CATALOG) as CatalogTool[]).map((k) => [k, call(k)]));
  }

  private entry(info: SessionInfo, lastSeq: number): Entry {
    let e = this.entries.get(info.id);
    if (!e) {
      const events = this.events;
      const holder: { e?: Entry } = {};
      const s = this.makeSession({ ...info, pendingPermissions: [] }, this.sink(), () => {
        const spec = holder.e!.spec!;
        return buildOptions({ ...spec, claudeExecutable: spec.claudeExecutable ?? this.cfg.claude }, this.handlers(info.id));
      }, events);
      e = { s, seq: lastSeq };
      holder.e = e;
      this.entries.set(info.id, e);
    } else if (!e.s.live) {
      // The portal owns naming, model and mode; a resume id only if this daemon has none (it restarted).
      Object.assign(e.s.info, { title: info.title, model: info.model, permissionMode: info.permissionMode, sdkSessionId: e.s.info.sdkSessionId ?? info.sdkSessionId });
    }
    e.seq = Math.max(e.seq, lastSeq);
    return e;
  }

  private liveCount() {
    return [...this.entries.values()].filter((e) => e.s.live).length;
  }

  /** caffeinate -i while any agent process is live, so the Mac does not idle-sleep under a run. */
  private awake() {
    const live = this.liveCount() > 0;
    if (live && !this.caffeinate && process.platform === 'darwin') {
      this.caffeinate = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
      this.caffeinate.on('exit', () => (this.caffeinate = undefined));
    } else if (!live && this.caffeinate) {
      this.caffeinate.kill();
      this.caffeinate = undefined;
    }
  }

  private onMessage(msg: ToDaemon) {
    switch (msg.type) {
      case 'welcome': {
        this.maxSessions = msg.maxSessions;
        const known = new Set(msg.sessions.map((s) => s.id));
        for (const [id, e] of this.entries) {
          if (!known.has(id)) {
            e.s.stop();
            this.entries.delete(id);
          }
        }
        return;
      }
      case 'send': {
        try {
          const e = this.entry(msg.info, msg.lastSeq);
          if (!e.s.live && this.liveCount() >= this.maxSessions) throw new Error(`already ${this.maxSessions} agents running on this machine`);
          e.spec = msg.spec;
          if (!e.s.live) prepare(msg.spec);
          e.s.send(msg.text, msg.from, msg.uuid, msg.images);
        } catch (err) {
          this.out({ type: 'failed', sessionId: msg.info.id, error: (err as Error).message });
        }
        this.awake();
        return;
      }
      case 'switch': {
        const busy = [...this.entries.values()].filter((e) => e.s.live && e.s.info.status !== 'idle');
        if (busy.length) {
          this.send({ type: 'switch_result', id: msg.id, ok: false, error: `${busy.length} agent(s) are mid-turn on this machine` });
          return;
        }
        void switchBranch({ dir: this.cfg.repoPath, branch: msg.branch, createFrom: msg.createFrom }).then(
          (r) => {
            this.send({ type: 'switch_result', id: msg.id, ok: true, ...r });
            void this.reportStatus();
          },
          (err) => this.send({ type: 'switch_result', id: msg.id, ok: false, error: (err as Error).message }),
        );
        return;
      }
      case 'status_now':
        void this.reportStatus();
        return;
      case 'unity': {
        const u = this.unity;
        const status = async () => [await u.status(), this.unityWatch?.describe()].filter(Boolean).join('\n');
        const act = msg.action === 'start' ? u.start() : msg.action === 'stop' ? u.stop({ force: msg.force }) : msg.action === 'restart' ? u.restart({ force: msg.force }) : status();
        if (msg.action === 'stop' || msg.action === 'restart') this.unityWatch?.expectExit();
        void act.then(
          (text) => this.send({ type: 'unity_result', id: msg.id, ok: true, text }),
          (err) => this.send({ type: 'unity_result', id: msg.id, ok: false, text: (err as Error).message }),
        );
        return;
      }
      case 'interrupt':
        void this.entries.get(msg.sessionId)?.s.interrupt();
        return;
      case 'stop':
        this.entries.get(msg.sessionId)?.s.stop();
        this.awake();
        return;
      case 'remove': {
        const e = this.entries.get(msg.sessionId);
        e?.s.stop();
        this.entries.delete(msg.sessionId);
        this.awake();
        return;
      }
      case 'mode':
        void this.entries.get(msg.sessionId)?.s.setMode(msg.mode);
        return;
      case 'decide':
        this.entries.get(msg.sessionId)?.s.decide(msg.requestId, msg.allow, msg.message);
        return;
      case 'fs': {
        // Only the clone and the standing agents' folders: the gallery and inline images, nothing else.
        const roots = [this.cfg.repoPath, path.join(HOME, '.ff-factory', 'agents')];
        try {
          if (msg.op === 'read') {
            const img = readImage(msg.path, roots);
            this.send({ type: 'fs_result', id: msg.id, ok: true, mediaType: img.mediaType, data: img.data.toString('base64') });
          } else {
            this.send({ type: 'fs_result', id: msg.id, ok: true, files: listImages(this.cfg.repoPath, msg.dirs) });
          }
        } catch (err) {
          this.send({ type: 'fs_result', id: msg.id, ok: false, error: (err as Error).message });
        }
        return;
      }
      case 'rpc_result': {
        const p = this.rpcs.get(msg.id);
        if (!p) return;
        this.rpcs.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.text);
        else p.reject(new Error(msg.text));
        return;
      }
    }
  }
}

/** Make the spec's folder and seed files exist before its process starts. */
function prepare(spec: LaunchSpec) {
  fs.mkdirSync(spec.cwd, { recursive: true });
  for (const [name, content] of Object.entries(spec.init?.files ?? {})) {
    const f = path.join(spec.cwd, name);
    if (!fs.existsSync(f)) fs.writeFileSync(f, content);
  }
}

function readVersion() {
  try {
    return fs.readFileSync(path.join(import.meta.dirname, 'VERSION'), 'utf8').trim();
  } catch {
    return `protocol ${PROTOCOL_VERSION}`;
  }
}

// Run when started directly (not when imported by the tests).
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const file = process.argv[2] ?? path.join(HOME, '.ff-factory', 'daemon.json');
  const cfg: DaemonConfig = JSON.parse(fs.readFileSync(file, 'utf8'));
  const d = new Daemon(cfg);
  d.start();
  log(`FF Factory daemon for machine ${cfg.id}, repo ${cfg.repoPath}, portal ${cfg.portalUrl}`);
  const quit = () => {
    log('shutting down: stopping agent processes');
    d.shutdown();
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGTERM', quit);
  process.on('SIGINT', quit);
  process.on('uncaughtException', (e) => log('UNCAUGHT (kept running):', e));
  process.on('unhandledRejection', (e) => log('UNHANDLED REJECTION (kept running):', e));
}

/** How long to wait before the next connection attempt: ~2 s for the first two minutes down, then 1-30 s backoff. */
export function reconnectDelayMs(downForMs: number, attempt: number, rand = Math.random()): number {
  const jitter = 0.75 + rand * 0.5;
  if (downForMs < 120_000) return 2000 * jitter;
  return Math.min(30_000, 1000 * 2 ** attempt) * jitter;
}
