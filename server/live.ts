// The live view's portal half (w1398, docs/live-view.md): which views run, who may watch them, and the newest frame
// passed from each daemon's frame socket to every watching page. A page that is behind skips frames; nothing queues.
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { LiveKnobRequest, LiveMaterialKnobs, LiveViewInfo, Requester, SessionInfo, UserRole } from '../shared/types.ts';
import type { FromDaemon, ToDaemon } from './machineProtocol.ts';

/** What a page may hold back before it misses frames (about a second of 960 px JPEGs). */
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
  now?(): number;
}

interface View {
  info: LiveViewInfo;
  frames?: WebSocket;
  latest?: Buffer;
  viewers: Set<WebSocket>;
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
      return v ? statusLine(v.info) : 'No live view for this session.';
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
      viewers: new Set(),
    };
    this.views.set(v.info.liveId, v);
    this.deps.changed();
    try {
      const text = await this.deps.machines.live(machineId, { op: 'start', liveId: v.info.liveId, sessionId: info.id, sandbox, fps, width });
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
    for (const w of v.viewers) w.close(1000, 'the live view stopped');
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
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (!isBinary) return;
      const frame = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      v.latest = frame;
      v.info.frames++;
      for (const w of v.viewers) send(w, frame);
    });
    ws.on('close', () => {
      if (v.frames === ws) v.frames = undefined;
    });
    return true;
  }

  /** A page watching a session's view (/live/<sessionId>); the caller checked canWatch. It gets the newest frame at once. */
  addViewer(sessionId: string, ws: WebSocket): boolean {
    const v = this.bySession(sessionId);
    if (!v || !this.deps.enabled()) return false;
    v.viewers.add(ws);
    if (v.latest) send(ws, v.latest);
    ws.on('close', () => v.viewers.delete(ws));
    return true;
  }
}

/** Newest wins: a page still holding a backlog skips this frame and gets a later one. */
function send(ws: WebSocket, frame: Buffer) {
  if (ws.readyState !== ws.OPEN || ws.bufferedAmount > VIEWER_BACKLOG_BYTES) return;
  ws.send(frame, { binary: true, compress: false });
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
