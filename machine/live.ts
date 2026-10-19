// The live view's machine half (w1398, docs/live-view.md): the running game in a sandbox's Unity editor streams what
// the player sees to this daemon, and the daemon passes the newest frame on to the portal, which shows it beside the
// asset agent's conversation. Knob moves come the other way, as game commands.
//
// The game half is the game repo's LiveLook (Assets/Scripts/Behaviours/Multiplayer/AgentControl/LiveLook.cs): its
// dev-tier commands run through the game's agent channel, a loopback HTTP API whose port and bearer token the game
// writes to AgentControl/session-<pid>.json. `live.frames|on|<fps>|<width>|<port>` makes the game dial the loopback
// port this file listens on and send 'H' + u32 BE length + JSON hello once, then 'F' + u32 + JPEG per frame; each
// frame waits for this side's one-byte 'A'. We answer at once and keep only the newest frame: a slow link to the
// portal costs frames, never memory or the game's frame rate.
//
// A plain play session gives the channel the player-safe tier, where the knob commands are refused; the editor's dev
// tier is a SessionState switch, so the first start sets it through the editor's MCP bridge (one execute_code).
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** Where a Final Factory process writes AgentControl/session-<pid>.json (Unity's persistentDataPath + /AgentControl). */
export function agentControlDir(platform: NodeJS.Platform = process.platform, home = os.homedir()): string {
  if (platform === 'win32') return path.join(home, 'AppData', 'LocalLow', 'Never Games', 'finalfactory', 'AgentControl');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Never Games', 'finalfactory', 'AgentControl');
  return path.join(home, '.config', 'unity3d', 'Never Games', 'finalfactory', 'AgentControl');
}

export interface GameChannel {
  port: number;
  token: string;
  tier: string;
  pid: number;
}

/** The game's agent channel for one process, from its session file; undefined when there is none (not in play mode). */
export function readGameChannel(pid: number, dir = agentControlDir()): GameChannel | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, `session-${pid}.json`), 'utf8')) as Partial<GameChannel>;
    if (typeof j.port !== 'number' || typeof j.token !== 'string') return undefined;
    return { port: j.port, token: j.token, tier: String(j.tier ?? ''), pid };
  } catch {
    return undefined;
  }
}

export interface CommandReply {
  ok: boolean;
  status: number;
  result: string;
  reason?: string;
}

/** One `ffauto:` command through the game's agent channel (POST /v1/command); never throws. */
export function gameCommand(ch: GameChannel, command: string, timeoutMs = 10_000): Promise<CommandReply> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ actor: 'local-player', command: command.startsWith('ffauto:') ? command : `ffauto:${command}` });
    const req = http.request(
      { host: '127.0.0.1', port: ch.port, path: '/v1/command', method: 'POST', timeout: timeoutMs, headers: { authorization: `Bearer ${ch.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          let j: { status?: string; result?: string; reason?: string; detail?: string; message?: string } = {};
          try {
            j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            // not JSON: report the status
          }
          const ok = res.statusCode === 200 && j.status === 'completed';
          resolve({ ok, status: res.statusCode ?? 0, result: String(j.result || j.detail || j.message || ''), ...(j.reason ? { reason: j.reason } : {}) });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('the game did not answer in time')));
    req.on('error', (e) => resolve({ ok: false, status: 0, result: e.message }));
    req.end(body);
  });
}

/**
 * The C# the editor runs (through its MCP bridge) to give the play session's agent channel the dev tier: the
 * SessionState switch `AgentChannelHost.ResolveCapabilities` reads, then a restart so the router takes it.
 */
export const DEV_TIER_SNIPPET = [
  'if (!UnityEngine.Application.isPlaying) return "not playing";',
  'UnityEditor.SessionState.SetBool(Behaviours.Multiplayer.AgentControl.AgentChannelHost.DevSessionStateKey, true);',
  'var h = Behaviours.Multiplayer.AgentControl.AgentChannelHost.Instance;',
  'if (h == null) return "no channel host";',
  'if (h.IsListening && h.TierLabel != "all") h.StopChannel("live view: the dev tier");',
  'h.StartChannel();',
  'return "tier=" + h.TierLabel + " port=" + h.Port;',
].join('\n');

/** A frame stream's parser: whole messages out of TCP chunks. */
export class FrameParser {
  private buf: Buffer = Buffer.alloc(0);

  /** Feed a chunk; returns the complete messages it finished, kind 'H' (hello) or 'F' (a JPEG). */
  push(chunk: Buffer): { kind: string; payload: Buffer }[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: { kind: string; payload: Buffer }[] = [];
    while (this.buf.length >= 5) {
      const len = this.buf.readUInt32BE(1);
      if (len > 32 * 1024 * 1024) throw new Error(`a ${len}-byte frame is not a frame`);
      if (this.buf.length < 5 + len) break;
      out.push({ kind: String.fromCharCode(this.buf[0]), payload: this.buf.subarray(5, 5 + len) });
      this.buf = this.buf.subarray(5 + len);
    }
    return out;
  }
}

export type LiveState = 'starting' | 'live' | 'holding' | 'stopped';

export interface LiveSessionDeps {
  /** The sandbox editor's process id, or undefined while it is not running. */
  editorPid(): number | undefined;
  /** Reads the game's channel for a pid (readGameChannel). */
  channel(pid: number): GameChannel | undefined;
  /** Runs DEV_TIER_SNIPPET in the editor (its MCP bridge); resolves its answer or an error text. */
  devTier(): Promise<string>;
  command(ch: GameChannel, text: string): Promise<CommandReply>;
  /** The newest frame, for the portal link (it drops what it cannot send). */
  frame(jpeg: Buffer): void;
  state(state: LiveState, detail: string): void;
  now(): number;
}

/**
 * One live view: keeps the game streaming to a loopback port while it is wanted. Whenever the stream is down (the
 * editor left play mode, a script reload, a new play session's new port) it tries again every few seconds and
 * reports 'holding' with why, so the panel can say the view holds the last frame.
 */
export class LiveSession {
  private server?: net.Server;
  private port = 0;
  private socket?: net.Socket;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private trying = false;
  private lastState: LiveState | undefined;
  private lastDetail = '';
  frames = 0;
  hello: Record<string, unknown> | undefined;

  readonly fps: number;
  readonly width: number;
  private readonly deps: LiveSessionDeps;
  private readonly retryMs: number;

  constructor(fps: number, width: number, deps: LiveSessionDeps, retryMs = 3000) {
    this.fps = fps;
    this.width = width;
    this.deps = deps;
    this.retryMs = retryMs;
  }

  async start(): Promise<void> {
    this.report('starting', 'starting the game stream');
    this.server = net.createServer((sock) => this.accept(sock));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    this.port = (this.server.address() as net.AddressInfo).port;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.retryMs);
  }

  /** The loopback port the game streams to (0 before start). */
  get listenPort() {
    return this.port;
  }

  /** The state it last reported, for the daemon's hello (w1509): a portal that restarted learns it there. */
  get state(): { state: LiveState; detail: string } {
    return { state: this.lastState ?? 'starting', detail: this.lastDetail };
  }

  /** A game command (a knob) through the current channel. */
  async command(text: string): Promise<CommandReply> {
    const pid = this.deps.editorPid();
    const ch = pid ? this.deps.channel(pid) : undefined;
    if (!ch) return { ok: false, status: 0, result: 'the game is not running in play mode' };
    return this.deps.command(ch, text);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    const pid = this.deps.editorPid();
    const ch = pid ? this.deps.channel(pid) : undefined;
    if (ch) await this.deps.command(ch, 'live.frames|off').catch(() => undefined);
    this.socket?.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.report('stopped', 'stopped');
  }

  private accept(sock: net.Socket) {
    this.socket?.destroy();
    this.socket = sock;
    sock.setNoDelay(true);
    const parser = new FrameParser();
    sock.on('data', (chunk: Buffer) => {
      let messages: { kind: string; payload: Buffer }[];
      try {
        messages = parser.push(chunk);
      } catch (e) {
        sock.destroy(e as Error);
        return;
      }
      for (const m of messages) {
        if (m.kind === 'H') {
          try {
            this.hello = JSON.parse(m.payload.toString('utf8'));
          } catch {
            this.hello = {};
          }
          continue;
        }
        if (m.kind !== 'F') continue;
        // Answer at once: the game takes its next frame now, and only the newest one goes on to the portal.
        sock.write('A');
        this.frames++;
        this.deps.frame(Buffer.from(m.payload));
        if (this.lastState !== 'live') this.report('live', `${this.fps} fps at ${this.width} px`);
      }
    });
    const gone = () => {
      if (this.socket === sock) this.socket = undefined;
      if (!this.stopped) this.report('holding', 'the game stopped streaming (left play mode, or a script reload); showing the last frame');
    };
    sock.on('close', gone);
    sock.on('error', () => undefined);
  }

  /** While nothing streams: find the game, give it the dev tier if it lacks it, and ask it to stream here. */
  private async tick() {
    if (this.stopped || this.trying || this.socket) return;
    this.trying = true;
    try {
      const pid = this.deps.editorPid();
      if (!pid) return this.report('holding', 'the sandbox editor is not running');
      let ch = this.deps.channel(pid);
      if (!ch) return this.report('holding', 'the game is not in play mode (no agent channel)');
      if (ch.tier !== 'all') {
        const answer = await this.deps.devTier();
        ch = this.deps.channel(pid);
        if (!ch || ch.tier !== 'all') return this.report('holding', `the game's agent channel is not in the dev tier (${answer})`);
      }
      const reply = await this.deps.command(ch, `live.frames|on|${this.fps}|${this.width}|${this.port}`);
      if (!reply.ok) this.report('holding', `the game refused the stream: ${reply.result || reply.status}`);
    } finally {
      this.trying = false;
    }
  }

  private report(state: LiveState, detail: string) {
    if (state === this.lastState && detail === this.lastDetail) return;
    this.lastState = state;
    this.lastDetail = detail;
    this.deps.state(state, detail);
  }
}
