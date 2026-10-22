// The live view's portal half (w1398, docs/live-view.md): which views run, who may watch them, and the newest frame
// passed from each daemon's frame socket to every watching page. A page that is behind skips frames; nothing queues.
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { FramePump, parseAck } from '../shared/framePump.ts';
import type { LiveKnobRequest, LiveMaterialKnobs, LiveViewInfo, Requester, SessionInfo, UserRole } from '../shared/types.ts';
import type { DaemonLiveView, FromDaemon, ToDaemon } from './machineProtocol.ts';
import type { LiveIdleView } from './liveIdle.ts';

/** What a page that does not answer frames (an older one) may hold back before it misses frames (about a second of 960 px JPEGs). */
const VIEWER_BACKLOG_BYTES = 1024 * 1024;
export const LIVE_FPS = { default: 15, max: 30 };
export const LIVE_WIDTH = { default: 960, min: 320, max: 1920 };
/**
 * A material as the game names it ("VfxComet") or its Resources path ("Vfx/VfxComet", loaded even before anything draws it),
 * and a shader property name ("_ComaColor"); nothing else reaches the game.
 */
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_ .()\/-]{0,79}$/;
const PROPERTY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export interface LiveHubDeps {
  enabled(): boolean;
  /** The machine link (server/machines.ts): its `live` call and whether its daemon offers it. */
  machines: {
    canLive(machineId: string): boolean;
    live(machineId: string, op: Omit<Extract<ToDaemon, { type: 'live' }>, 'type' | 'id'>, timeoutMs?: number): Promise<string>;
  };
  session(id: string): SessionInfo | undefined;
  roleOf(userId: string): UserRole | undefined;
  /** The views changed: tell the pages (each gets the ones it may watch). */
  changed(): void;
  /** The switch moved: every page needs its state again (the switch is in AppState.config). */
  switched?(): void;
  /** A person opened a view (w1746): an editor closed idle wakes its worker (server/liveIdle.ts viewerOpened). */
  viewerOpened?(info: LiveViewInfo, who: string | undefined): void;
  now?(): number;
}

interface View {
  info: LiveViewInfo;
  frames?: WebSocket;
  latest?: Buffer;
  /** Each watching page and its frame pump (w1601: it keeps to what the page's link carries, shared/framePump.ts). */
  viewers: Map<WebSocket, FramePump>;
  /** The last time a page opened or left it, and the last knob move or reset (ms): a watched or tuned view is not idle (w1746). */
  watchedAt?: number;
  touchedAt?: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

export class LiveHub {
  private readonly views = new Map<string, View>();
  private readonly deps: LiveHubDeps;

  constructor(deps: LiveHubDeps) {
    this.deps = deps;
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  /** The session's requester and the owners watch a view and move its knobs (docs/live-view.md). */
  canWatch(sessionId: string, userId: string | undefined): boolean {
    if (!userId) return false;
    if (this.deps.roleOf(userId) === 'owner') return true;
    const s = this.deps.session(sessionId);
    const me = userId.toLowerCase();
    return !!s && [s.requestedBy, s.lastRequestedBy].some((r) => r?.userId.toLowerCase() === me);
  }

  /** The views a person may watch, for their page. */
  viewsFor(userId: string | undefined): LiveViewInfo[] {
    if (!this.deps.enabled()) return [];
    return [...this.views.values()].map((v) => v.info).filter((i) => this.canWatch(i.sessionId, userId));
  }

  private bySession(sessionId: string): View | undefined {
    for (const v of this.views.values()) if (v.info.sessionId === sessionId) return v;
    return undefined;
  }

  private require(sessionId: string): View {
    if (!this.deps.enabled()) throw new LiveError(404, 'the live view is off on this portal (config live.enabled)');
    const v = this.bySession(sessionId);
    if (!v) throw new LiveError(404, 'no live view for this session: its agent starts one with live_view');
    return v;
  }

  private touch(v: View, patch: Partial<LiveViewInfo>) {
    Object.assign(v.info, patch, { updatedAt: iso(this.now()) });
    this.deps.changed();
  }

  // ------------------------------------------------------------------ the agent's tool

  /** live_view for a worker: start, stop, status or knobs, for its own sandbox's game. */
  async tool(info: SessionInfo, args: Record<string, unknown>): Promise<string> {
    if (!this.deps.enabled()) return 'The live view is off on this portal (config live.enabled); nothing started.';
    const action = String(args.action ?? 'status');
    const machineId = info.machineId;
    const sandbox = info.machineSandbox;
    if (!machineId || !sandbox) return 'A live view shows a sandbox editor\'s game: this session has no sandbox.';
    if (action === 'status') {
      const v = this.bySession(info.id);
      return v ? statusLine(v.info) + viewersLine(v) : 'No live view for this session.';
    }
    if (action === 'stop') {
      const v = this.bySession(info.id);
      if (!v) return 'No live view to stop.';
      await this.stopView(v);
      return 'Live view stopped.';
    }
    if (action === 'knobs') {
      const knobs = await this.knobs(info.id);
      return JSON.stringify(knobs);
    }
    if (action !== 'start') return `Unknown action "${action}": start, stop, status or knobs.`;
    if (!this.deps.machines.canLive(machineId)) return `${machineId}'s daemon has no live view yet (it is offline, or needs a daemon update).`;
    const fps = clamp(Number(args.fps ?? LIVE_FPS.default), 1, LIVE_FPS.max, LIVE_FPS.default);
    const width = clamp(Number(args.width ?? LIVE_WIDTH.default), LIVE_WIDTH.min, LIVE_WIDTH.max, LIVE_WIDTH.default);
    const materials = (Array.isArray(args.materials) ? args.materials : []).map(String).map((m) => m.trim()).filter((m) => NAME.test(m)).slice(0, 8);
    const old = this.bySession(info.id);
    if (old) await this.stopView(old);
    const at = iso(this.now());
    const v: View = {
      info: { liveId: randomUUID(), sessionId: info.id, machineId, sandbox, state: 'starting', detail: 'asking the game to stream', fps, width, materials, startedAt: at, updatedAt: at, frames: 0 },
      viewers: new Map(),
    };
    this.views.set(v.info.liveId, v);
    this.deps.changed();
    try {
      const text = await this.deps.machines.live(machineId, { op: 'start', liveId: v.info.liveId, sessionId: info.id, sandbox, fps, width, materials });
      return `Live view started (${fps} fps, ${width} px${materials.length ? `, knobs on ${materials.join(', ')}` : ', no knobs: pass materials'}): ${text}. People open it from your conversation's "Live view" button.`;
    } catch (e) {
      this.views.delete(v.info.liveId);
      this.deps.changed();
      return `The live view did not start: ${(e as Error).message}`;
    }
  }

  private async stopView(v: View) {
    this.views.delete(v.info.liveId);
    v.frames?.close(1000, 'stopped');
    for (const w of v.viewers.keys()) w.close(1000, 'the live view stopped');
    this.deps.changed();
    await this.deps.machines.live(v.info.machineId, { op: 'stop', liveId: v.info.liveId, sessionId: v.info.sessionId, sandbox: v.info.sandbox }).catch(() => undefined);
  }

  /**
   * The switch (config live.enabled, set_app_config) moved: off stops every running view; either way every page gets the
   * switch and the views it may watch again (w1417).
   */
  async switched(on: boolean) {
    if (!on) for (const v of [...this.views.values()]) await this.stopView(v);
    this.deps.switched?.();
  }

  /**
   * A machine's daemon said hello (w1509). A daemon restarts on every machine rollout, and the views it ran went with it:
   * the page kept showing them while every knob was refused ("this live view is not running on the machine") and the
   * stream had stopped. So a view of this machine its daemon does not run is started again, with the same id, and the
   * daemon's views this portal does not know (the portal restarted) are taken back while their session is still on that
   * sandbox, else stopped. An older daemon reports none (`running` undefined): its views are asked to start again, which
   * it answers "already running" for a view it still has.
   */
  async daemonHello(machineId: string, running: DaemonLiveView[] | undefined) {
    if (!this.deps.enabled()) return;
    const ids = new Set((running ?? []).map((r) => r.liveId));
    for (const v of [...this.views.values()]) {
      if (v.info.machineId !== machineId || ids.has(v.info.liveId)) continue;
      const { liveId, sessionId, sandbox, fps, width, materials } = v.info;
      if (running) this.touch(v, { state: 'starting', detail: "the machine's daemon restarted: starting the stream again" });
      try {
        await this.deps.machines.live(machineId, { op: 'start', liveId, sessionId, sandbox, fps, width, materials });
      } catch (e) {
        if (this.views.get(liveId) === v) this.touch(v, { state: 'holding', detail: `the machine's daemon restarted and the view did not start again: ${(e as Error).message}` });
      }
    }
    for (const r of running ?? []) {
      if (this.views.has(r.liveId)) continue;
      const s = this.deps.session(r.sessionId);
      if (!s || s.machineId !== machineId || s.machineSandbox !== r.sandbox || this.bySession(r.sessionId)) {
        await this.deps.machines.live(machineId, { op: 'stop', liveId: r.liveId, sessionId: r.sessionId, sandbox: r.sandbox }).catch(() => undefined);
        continue;
      }
      const at = iso(this.now());
      const materials = (Array.isArray(r.materials) ? r.materials : []).map(String).filter((m) => NAME.test(m)).slice(0, 8);
      this.views.set(r.liveId, {
        info: { liveId: r.liveId, sessionId: r.sessionId, machineId, sandbox: r.sandbox, state: r.state, detail: String(r.detail ?? ''), fps: clamp(r.fps, 1, LIVE_FPS.max, LIVE_FPS.default), width: clamp(r.width, LIVE_WIDTH.min, LIVE_WIDTH.max, LIVE_WIDTH.default), materials, startedAt: at, updatedAt: at, frames: 0 },
        viewers: new Map(),
      });
      this.deps.changed();
    }
  }

  /** The settings of the session's running view, or undefined when it has none (Agents.liveHold, w1582). */
  running(sessionId: string): Pick<LiveViewInfo, 'materials' | 'fps' | 'width'> | undefined {
    if (!this.deps.enabled()) return undefined;
    const v = this.bySession(sessionId);
    return v && v.info.state !== 'stopped' ? { materials: [...v.info.materials], fps: v.info.fps, width: v.info.width } : undefined;
  }

  /**
   * Its sandbox was released (w1582): stop the session's view, which would show whatever that sandbox's editor shows next,
   * and answer its settings so the worker can start it again when it resumes. Undefined when it had none.
   */
  async endFor(sessionId: string): Promise<Pick<LiveViewInfo, 'materials' | 'fps' | 'width'> | undefined> {
    const v = this.bySession(sessionId);
    if (!v) return undefined;
    await this.stopView(v);
    return { materials: [...v.info.materials], fps: v.info.fps, width: v.info.width };
  }

  /** Every running view, as the idle close reads it (w1746, server/liveIdle.ts). */
  idleFacts(): LiveIdleView[] {
    if (!this.deps.enabled()) return [];
    return [...this.views.values()]
      .filter((v) => v.info.state !== 'stopped')
      .map((v) => ({ liveId: v.info.liveId, sessionId: v.info.sessionId, machineId: v.info.machineId, sandbox: v.info.sandbox, startedAtMs: Date.parse(v.info.startedAt) || 0, viewers: v.viewers.size, ...(v.watchedAt ? { watchedAt: v.watchedAt } : {}), ...(v.touchedAt ? { touchedAt: v.touchedAt } : {}) }));
  }

  /** Every live view of a session that is gone (its worker ended). */
  async sessionGone(sessionId: string) {
    const v = this.bySession(sessionId);
    if (v) await this.stopView(v);
  }

  // ------------------------------------------------------------------ knobs

  /** The view's materials' knobs, read from the game now. */
  async knobs(sessionId: string): Promise<LiveMaterialKnobs[]> {
    const v = this.require(sessionId);
    const out: LiveMaterialKnobs[] = [];
    for (const material of v.info.materials) {
      try {
        const text = await this.command(v, `look.material.list|${material}`);
        const j = JSON.parse(text) as { material?: string; shader?: string; knobs?: LiveMaterialKnobs['knobs'] };
        // The name the view was started with, not the game's: a knob move must name one of the view's materials.
        out.push({ material, ...(j.shader ? { shader: j.shader } : {}), knobs: Array.isArray(j.knobs) ? j.knobs : [] });
      } catch (e) {
        out.push({ material, knobs: [], error: (e as Error).message });
      }
    }
    return out;
  }

  /** One knob move from a page: checked against the view's materials, then the game's look.material.set. */
  async setKnob(sessionId: string, req: LiveKnobRequest, who: Requester): Promise<unknown> {
    const v = this.require(sessionId);
    const material = String(req.material ?? '');
    const name = String(req.name ?? '');
    if (!v.info.materials.includes(material)) throw new LiveError(400, `"${material}" is not one of this view's materials (${v.info.materials.join(', ') || 'none'})`);
    if (!PROPERTY.test(name)) throw new LiveError(400, `"${name}" is not a shader property name`);
    const value = knobValue(req.value);
    if (value === undefined) throw new LiveError(400, 'a knob value is a number, or 3 or 4 numbers (a colour or a vector)');
    const note = `${who.displayName} set ${material}.${name} to ${value} in the live view`;
    const text = await this.command(v, `look.material.set|${material}|${name}|${value}`, note);
    try {
      return JSON.parse(text);
    } catch {
      return { result: text };
    }
  }

  /** Puts a material's knobs (or all) back. */
  async reset(sessionId: string, material: string | undefined, who: Requester): Promise<string> {
    const v = this.require(sessionId);
    if (material !== undefined && !v.info.materials.includes(material)) throw new LiveError(400, `"${material}" is not one of this view's materials`);
    return this.command(v, `look.material.reset${material ? `|${material}` : ''}`, `${who.displayName} put back ${material ?? 'every'} knob${material ? 's' : ''} in the live view`);
  }

  private command(v: View, command: string, note?: string) {
    if (note) v.touchedAt = this.now();
    return this.deps.machines.live(v.info.machineId, { op: 'command', liveId: v.info.liveId, sessionId: v.info.sessionId, sandbox: v.info.sandbox, command, ...(note ? { note } : {}) }, 30_000);
  }

  // ------------------------------------------------------------------ frames

  /** A daemon's state report for one of its views. */
  onState(machineId: string, msg: Extract<FromDaemon, { type: 'live_state' }>) {
    const v = this.views.get(msg.liveId);
    if (!v || v.info.machineId !== machineId) return;
    this.touch(v, { state: msg.state, detail: String(msg.detail ?? '') });
  }

  /** A daemon's frame socket for a view (/machine/live/<liveId>); false when the view is not that machine's. */
  attachFrames(machineId: string, liveId: string, ws: WebSocket): boolean {
    const v = this.views.get(liveId);
    if (!v || v.info.machineId !== machineId) return false;
    v.frames?.close(1000, 'replaced');
    v.frames = ws;
    let taken = 0;
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (!isBinary) return;
      const frame = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      // The daemon's pump sends its next frame on this answer (w1601); an older daemon ignores it.
      if (ws.readyState === ws.OPEN) ws.send(`a${++taken}`);
      v.latest = frame;
      v.info.frames++;
      for (const pump of v.viewers.values()) pump.push(frame);
    });
    ws.on('close', () => {
      if (v.frames === ws) v.frames = undefined;
    });
    return true;
  }

  /** A page watching a session's view (/live/<sessionId>); the caller checked canWatch. It gets the newest frame at once. */
  addViewer(sessionId: string, ws: WebSocket, who?: string): boolean {
    const v = this.bySession(sessionId);
    if (!v || !this.deps.enabled()) return false;
    // Newest wins: a page whose link is full gets a later frame, never a queue (shared/framePump.ts).
    const pump = new FramePump(
      {
        send: (frame) => ws.send(frame, { binary: true, compress: false }),
        buffered: () => (ws.readyState === ws.OPEN ? ws.bufferedAmount : -1),
        now: () => Date.now(),
        later: (fn, ms) => void setTimeout(fn, ms),
      },
      VIEWER_BACKLOG_BYTES,
    );
    v.viewers.set(ws, pump);
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (isBinary) return;
      const n = parseAck(String(data));
      if (n !== undefined) pump.ack(n);
    });
    if (v.latest) pump.push(v.latest);
    v.watchedAt = this.now();
    ws.on('close', () => {
      v.viewers.delete(ws);
      v.watchedAt = this.now();
    });
    this.deps.viewerOpened?.(v.info, who);
    return true;
  }
}

/** How each watching page keeps up (w1601): frames it drew, what it skipped, its round trip and its link's rate. */
function viewersLine(v: View) {
  if (!v.viewers.size) return ' Nobody is watching.';
  const parts = [...v.viewers.values()].map((p) => {
    const s = p.stats;
    if (!s.acking) return `a page that does not answer frames (${s.sent} sent)`;
    return `a page: ${s.acked} frames drawn, ${s.skipped} skipped, round trip ${s.rttMs} ms (shortest ${s.minRttMs} ms), ${Math.round((s.rateBps * 8) / 1e5) / 10} Mbit/s`;
  });
  return ` Watching: ${parts.join('; ')}.`;
}

export class LiveError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function clamp(n: number, min: number, max: number, fallback: number) {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

/** The game's value text: a finite number, or 3 or 4 finite numbers joined by commas. */
export function knobValue(v: unknown): string | undefined {
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? String(Math.round(x * 1e5) / 1e5) : undefined);
  if (typeof v === 'number') return num(v);
  if (Array.isArray(v) && (v.length === 3 || v.length === 4)) {
    const parts = v.map(num);
    return parts.every((p) => p !== undefined) ? parts.join(',') : undefined;
  }
  return undefined;
}

function statusLine(i: LiveViewInfo) {
  return `Live view ${i.state}${i.detail ? ` (${i.detail})` : ''}: ${i.fps} fps, ${i.width} px, ${i.frames} frames passed on, knobs on ${i.materials.join(', ') || 'no material'}.`;
}
