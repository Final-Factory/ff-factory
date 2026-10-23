// The live view's portal half (w1398, docs/live-view.md): which views run, who may watch them, and the newest frame
// passed from each daemon's frame socket to every watching page. A page that is behind skips frames; nothing queues.
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { FramePump, parseAck } from '../shared/framePump.ts';
import type { LiveKnobRequest, LiveMaterialKnobs, LiveStageStep, LiveViewInfo, Requester, SessionInfo, UserRole } from '../shared/types.ts';
import { legsText, parseStage, stageSummary } from '../machine/liveStage.ts';
import { LIVE_MATERIAL_NAME as NAME, LIVE_PROPERTY_NAME as PROPERTY } from '../machine/matText.ts';
import type { DaemonLiveView, FromDaemon, ToDaemon } from './machineProtocol.ts';
import type { LiveIdleView } from './liveIdle.ts';

/** What a page that does not answer frames (an older one) may hold back before it misses frames (about a second of 960 px JPEGs). */
const VIEWER_BACKLOG_BYTES = 1024 * 1024;
/**
 * A page counts as watching while it said "p" (present) this recently (w1746): it says so every 30 s while its tab is
 * visible and focused, and at each touch (web/src/components/LiveStage.tsx). A page left open behind other windows, on a
 * screen nobody looks at, or whose link died without a close, stops counting after this, so the view can go idle.
 */
export const LIVE_PRESENT_MS = 90_000;
/**
 * A view that streamed and got no frame for this long goes to holding with why (w1838): its daemon's socket to the game can
 * stay open while the editor is busy, minimized (12.6 fps) or hung, and the view said "live" over a still picture. A late
 * save at 0.5 fps (w1604) still sends a frame every 2 s.
 */
export const LIVE_STALL_MS = 10_000;
export const LIVE_FPS = { default: 15, max: 30 };
export const LIVE_WIDTH = { default: 960, min: 320, max: 1920 };

export interface LiveHubDeps {
  enabled(): boolean;
  /** The machine link (server/machines.ts): its `live` call and whether its daemon offers it. */
  machines: {
    canLive(machineId: string): boolean;
    /** Its daemon sets a view up again from a stage recipe (w1839: hello `liveRestage`). */
    canRestage?(machineId: string): boolean;
    /** Its daemon writes a kept knob into the sandbox's .mat (w1839: hello `liveKeep`). */
    canKeep?(machineId: string): boolean;
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
  /** Why its computer takes no work now (a release build, a bench lock, a pause), or undefined (w1838: LiveViewInfo.hold). */
  hold?(machineId: string): string | undefined;
  /** The daemon could not set a view up again from its recipe (w1839): its worker is told (server/liveIdle.ts restageFailed). */
  restageFailed?(info: LiveViewInfo, detail: string): void;
  /** The portal journal: each view's state changes, with how long the last state lasted (w1838). */
  log?(line: string): void;
  now?(): number;
}

interface View {
  info: LiveViewInfo;
  frames?: WebSocket;
  latest?: Buffer;
  /** Each watching page and its frame pump (w1601: it keeps to what the page's link carries, shared/framePump.ts). */
  viewers: Map<WebSocket, FramePump>;
  /** When each page last said it is looked at (ms; LIVE_PRESENT_MS). */
  present: Map<WebSocket, number>;
  /** Taken back from a daemon after a portal restart (daemonHello): its idle time counts from its sessions, not the restart. */
  takenBack?: boolean;
  /** The last time a page opened or left it, and the last knob move or reset (ms): a watched or tuned view is not idle (w1746). */
  watchedAt?: number;
  touchedAt?: number;
  /** When the last frame came from the daemon (ms), and whether the stall watch put the view to holding (w1838). */
  frameAt?: number;
  stalled?: boolean;
  /** When it entered its state (ms), for the journal's timings (w1838). */
  stateAt?: number;
  /** Its stage recipe (w1839): the daemon replays it with no worker turn. Empty while it has none. */
  stage: LiveStageStep[];
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
    return [...this.views.values()]
      .map((v) => v.info)
      .filter((i) => this.canWatch(i.sessionId, userId))
      .map((i) => {
        const hold = this.deps.hold?.(i.machineId);
        return hold ? { ...i, hold } : i;
      });
  }

  /** The holds the pages last heard of, per view (tick). */
  private holdsKey = '';

  /**
   * Every few seconds (server/index.ts): the stall watch, and the computers' holds the pages show (w1838). A hold starts and
   * ends outside this hub (a build plan, a bench lock, a pause), so the pages hear of it here.
   */
  tick() {
    if (!this.deps.enabled()) return;
    const now = this.now();
    for (const v of this.views.values()) {
      if (v.info.state !== 'live' || v.stalled || v.frameAt === undefined || now - v.frameAt < LIVE_STALL_MS) continue;
      v.stalled = true;
      this.setState(v, 'holding', `no frame from the game for ${Math.round((now - v.frameAt) / 1000)} s (its editor may be busy, minimized or hung)`);
    }
    const key = [...this.views.values()].map((v) => `${v.info.liveId}=${this.deps.hold?.(v.info.machineId) ?? ''}`).join('|');
    if (key === this.holdsKey) return;
    this.holdsKey = key;
    this.deps.changed();
  }

  /** A person opened the view while it was not streaming, and its worker was asked to stage it again (server/liveIdle.ts). */
  woken(liveId: string, who: string) {
    const v = this.views.get(liveId);
    if (v) this.touch(v, { wake: { at: iso(this.now()), who } });
  }

  /** A state change: the journal says how long the last one lasted (so the first frame's time after a start or a hold). */
  private setState(v: View, state: LiveViewInfo['state'], detail: string) {
    const was = v.info.state;
    const now = this.now();
    if (was !== state) {
      const took = v.stateAt !== undefined ? ` after ${((now - v.stateAt) / 1000).toFixed(1)} s` : '';
      this.deps.log?.(`live view ${v.info.machineId}/${v.info.sandbox} (${v.info.sessionId}): ${was} -> ${state}${took}${detail ? `: ${detail}` : ''}`);
      v.stateAt = now;
    }
    // Streaming again: the wake it had is done.
    this.touch(v, state === 'live' ? { state, detail, wake: undefined } : { state, detail });
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
    for (const k of Object.keys(patch) as (keyof LiveViewInfo)[]) if (patch[k] === undefined) delete v.info[k];
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
      return v ? statusLine(v.info) + stageLine(v) + viewersLine(v) : 'No live view for this session.';
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
    if (action === 'stage') return this.stageTool(info, args);
    if (action === 'restage') return this.restageTool(info);
    if (action !== 'start') return `Unknown action "${action}": start, stop, status, knobs, stage or restage.`;
    let stage: LiveStageStep[] = [];
    if (args.stage !== undefined) {
      const parsed = parseStage(args.stage);
      if ('error' in parsed) return `The live view did not start: ${parsed.error}`;
      stage = parsed.steps;
    }
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
      present: new Map(),
      stateAt: this.now(),
      stage,
    };
    if (stage.length) v.info.stage = stageSummary(stage);
    this.views.set(v.info.liveId, v);
    this.deps.changed();
    try {
      const text = await this.deps.machines.live(machineId, { op: 'start', liveId: v.info.liveId, sessionId: info.id, sandbox, fps, width, materials, ...(stage.length ? { stage } : {}) });
      const recipe = !stage.length
        ? ' Give it a stage recipe (live_view stage) so it comes back by itself, without your turn.'
        : this.canRestage(machineId)
          ? ` Its stage recipe is kept (${stageSummary(stage)}): the daemon sets the view up again by itself when a person opens it; test it with live_view restage.`
          : " Its stage recipe is kept, but this machine's daemon needs an update before it can use it.";
      return `Live view started (${fps} fps, ${width} px${materials.length ? `, knobs on ${materials.join(', ')}` : ', no knobs: pass materials'}): ${text}. People open it from your conversation's "Live view" button.${recipe}`;
    } catch (e) {
      this.views.delete(v.info.liveId);
      this.deps.changed();
      return `The live view did not start: ${(e as Error).message}`;
    }
  }

  private canRestage(machineId: string): boolean {
    return !!this.deps.machines.canRestage?.(machineId);
  }

  /** live_view stage (w1839): give the running view a recipe, or replace it. */
  private async stageTool(info: SessionInfo, args: Record<string, unknown>): Promise<string> {
    const v = this.bySession(info.id);
    if (!v) return 'No live view to give a recipe: live_view start first.';
    const parsed = parseStage(args.stage);
    if ('error' in parsed) return `The recipe was not kept: ${parsed.error}`;
    if (!this.canRestage(v.info.machineId)) return `${v.info.machineId}'s daemon cannot set a view up again yet (it needs an update); the recipe was not kept.`;
    try {
      const text = await this.deps.machines.live(v.info.machineId, { op: 'stage', liveId: v.info.liveId, sessionId: v.info.sessionId, sandbox: v.info.sandbox, stage: parsed.steps });
      v.stage = parsed.steps;
      this.touch(v, { stage: parsed.steps.length ? stageSummary(parsed.steps) : undefined });
      return parsed.steps.length ? `${text}. Test it with live_view restage, then live_view status.` : 'The stage recipe is cleared.';
    } catch (e) {
      return `The recipe was not kept: ${(e as Error).message}`;
    }
  }

  /** live_view restage (w1839): how a worker tests its recipe. */
  private async restageTool(info: SessionInfo): Promise<string> {
    const v = this.bySession(info.id);
    if (!v) return 'No live view to set up again: live_view start first.';
    if (!v.stage.length) return 'This view has no stage recipe: give one with live_view stage.';
    if (!this.canRestage(v.info.machineId)) return `${v.info.machineId}'s daemon cannot set a view up again yet (it needs an update).`;
    if (!(await this.restage(v.info.liveId, 'its worker'))) return 'The daemon was not asked to set it up again (it is setting it up already, or the request failed: see the portal journal).';
    return 'Setting it up again now from your recipe (editor, play mode, save, steps). live_view status shows how it went and how long each leg took.';
  }

  /**
   * Ask the daemon to set a view up again from its recipe (w1839), with no worker turn. False when the view has none, its machine
   * cannot, it is doing so already, or the request failed.
   */
  async restage(liveId: string, who: string): Promise<boolean> {
    const v = this.views.get(liveId);
    if (!v || !v.stage.length || !this.canRestage(v.info.machineId) || v.info.restaging) return false;
    this.touch(v, { restaging: { at: iso(this.now()), who } });
    try {
      await this.deps.machines.live(v.info.machineId, { op: 'restage', liveId, sessionId: v.info.sessionId, sandbox: v.info.sandbox });
      return true;
    } catch (e) {
      this.deps.log?.(`live view ${v.info.machineId}/${v.info.sandbox} (${v.info.sessionId}): the daemon was not asked to set it up again: ${(e as Error).message}`);
      if (this.views.get(liveId) === v) this.touch(v, { restaging: undefined });
      return false;
    }
  }

  /** The daemon says how a replay of the recipe went (w1839). */
  staged(machineId: string, msg: Extract<FromDaemon, { type: 'live_staged' }>) {
    const v = this.views.get(msg.liveId);
    if (!v || v.info.machineId !== machineId) return;
    const legs = msg.legs && typeof msg.legs === 'object' ? msg.legs : {};
    const detail = String(msg.detail ?? '');
    this.touch(v, { staged: { at: iso(this.now()), ok: !!msg.ok, detail, ms: Number(msg.ms) || 0, legs }, restaging: undefined });
    const where = `live view ${v.info.machineId}/${v.info.sandbox} (${v.info.sessionId})`;
    this.deps.log?.(msg.ok ? `${where}: staged again by the daemon in ${((Number(msg.ms) || 0) / 1000).toFixed(1)} s (${legsText(legs)})` : `${where}: could not be staged again: ${detail}`);
    if (!msg.ok) this.deps.restageFailed?.(v.info, detail);
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
      if (running) this.setState(v, 'starting', "the machine's daemon restarted: starting the stream again");
      try {
        await this.deps.machines.live(machineId, { op: 'start', liveId, sessionId, sandbox, fps, width, materials, ...(v.stage.length ? { stage: v.stage } : {}) });
      } catch (e) {
        if (this.views.get(liveId) === v) this.setState(v, 'holding', `the machine's daemon restarted and the view did not start again: ${(e as Error).message}`);
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
      const parsed = r.stage === undefined ? undefined : parseStage(r.stage);
      const stage = parsed && 'steps' in parsed ? parsed.steps : [];
      this.views.set(r.liveId, {
        info: { liveId: r.liveId, sessionId: r.sessionId, machineId, sandbox: r.sandbox, state: r.state, detail: String(r.detail ?? ''), fps: clamp(r.fps, 1, LIVE_FPS.max, LIVE_FPS.default), width: clamp(r.width, LIVE_WIDTH.min, LIVE_WIDTH.max, LIVE_WIDTH.default), materials, startedAt: at, updatedAt: at, frames: 0, ...(stage.length ? { stage: stageSummary(stage) } : {}) },
        viewers: new Map(),
        present: new Map(),
        takenBack: true,
        stage,
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
      .map((v) => {
        const now = this.now();
        const seen = [...v.present.values()];
        const watchedAt = Math.max(v.watchedAt ?? 0, ...seen);
        return {
          liveId: v.info.liveId,
          sessionId: v.info.sessionId,
          machineId: v.info.machineId,
          sandbox: v.info.sandbox,
          state: v.info.state,
          startedAtMs: v.takenBack ? 0 : Date.parse(v.info.startedAt) || 0,
          viewers: seen.filter((t) => now - t < LIVE_PRESENT_MS).length,
          pagesOpen: v.viewers.size,
          ...(watchedAt ? { watchedAt } : {}),
          ...(v.touchedAt ? { touchedAt: v.touchedAt } : {}),
        };
      });
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
    // All at once (w1838): each is a round trip to the game through the daemon, and three materials read one after another
    // tripled the wait for the panel's first knobs.
    return Promise.all(
      v.info.materials.map(async (material): Promise<LiveMaterialKnobs> => {
        try {
          const text = await this.command(v, `look.material.list|${material}`);
          const j = JSON.parse(text) as { material?: string; shader?: string; knobs?: LiveMaterialKnobs['knobs'] };
          // The name the view was started with, not the game's: a knob move must name one of the view's materials.
          return { material, ...(j.shader ? { shader: j.shader } : {}), knobs: Array.isArray(j.knobs) ? j.knobs : [] };
        } catch (e) {
          return { material, knobs: [], error: (e as Error).message };
        }
      }),
    );
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

  /**
   * Keep (w1839, docs/live-view.md "Keep"): write the moved knobs of one material into its .mat file on the worker's branch.
   * The game says which file (look.material.keep) and the daemon writes it as text; nothing is committed.
   */
  async keep(sessionId: string, material: string, who: Requester): Promise<{ kept: { name: string; path: string; change: string }[] }> {
    const v = this.require(sessionId);
    if (!v.info.materials.includes(material)) throw new LiveError(400, `"${material}" is not one of this view's materials`);
    if (!this.deps.machines.canKeep?.(v.info.machineId)) throw new LiveError(409, "this machine's daemon needs an update to keep values");
    let list: { knobs?: LiveMaterialKnobs['knobs'] };
    try {
      list = JSON.parse(await this.command(v, `look.material.list|${material}`)) as { knobs?: LiveMaterialKnobs['knobs'] };
    } catch (e) {
      throw new LiveError(502, `could not read ${material}'s knobs: ${(e as Error).message}`);
    }
    const moved = (Array.isArray(list.knobs) ? list.knobs : []).filter((k) => k.moved && !k.driven && PROPERTY.test(k.name));
    if (!moved.length) throw new LiveError(400, `nothing moved on ${material} to keep`);
    v.touchedAt = this.now();
    const kept: { name: string; path: string; change: string }[] = [];
    for (const k of moved) {
      try {
        // The daemon finishes the note with the change and the file it wrote, and counts it as activity there.
        const answer = JSON.parse(await this.deps.machines.live(v.info.machineId, { op: 'keep', liveId: v.info.liveId, sessionId: v.info.sessionId, sandbox: v.info.sandbox, material, name: k.name, note: `${who.displayName} kept ${material} ${k.name}` }, 30_000)) as { path: string; change: string };
        kept.push({ name: k.name, path: answer.path, change: answer.change });
      } catch (e) {
        throw new LiveError(502, kept.length ? `kept ${kept.map((x) => x.name).join(', ')}, then ${k.name} failed: ${(e as Error).message}` : (e as Error).message);
      }
    }
    this.deps.log?.(`live view ${v.info.machineId}/${v.info.sandbox} (${v.info.sessionId}): ${who.displayName} kept ${kept.length} value${kept.length === 1 ? '' : 's'} of ${material} in ${[...new Set(kept.map((x) => x.path))].join(', ')}`);
    return { kept };
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
    v.stalled = false;
    this.setState(v, msg.state, String(msg.detail ?? ''));
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
      v.frameAt = this.now();
      // Frames again after the stall watch held it: live once more (its daemon still thinks it is, so it says nothing).
      if (v.stalled) {
        v.stalled = false;
        this.setState(v, 'live', `${v.info.fps} fps at ${v.info.width} px`);
      }
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
    v.present.set(ws, this.now());
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (isBinary) return;
      const text = String(data);
      if (text === 'p') {
        // Looked at again after a while away: its editor may have closed idle meanwhile, so it counts as an opening (w1746).
        const was = v.present.get(ws) ?? 0;
        v.present.set(ws, this.now());
        if (this.now() - was >= LIVE_PRESENT_MS) this.deps.viewerOpened?.(v.info, who);
        return;
      }
      const n = parseAck(text);
      if (n !== undefined) pump.ack(n);
    });
    if (v.latest) pump.push(v.latest);
    v.watchedAt = this.now();
    ws.on('close', () => {
      v.viewers.delete(ws);
      // Watched until now, or last looked at a while ago: a page closed long after anyone looked does not restart the idle time.
      const seen = v.present.get(ws) ?? 0;
      v.watchedAt = Math.max(v.watchedAt ?? 0, this.now() - seen < LIVE_PRESENT_MS ? this.now() : seen);
      v.present.delete(ws);
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

/** The recipe and the daemon's last replay of it (w1839), for live_view status. */
function stageLine(v: View) {
  const i = v.info;
  let out = v.stage.length ? ` Stage recipe: ${i.stage ?? stageSummary(v.stage)}.` : ' Stage recipe: none (live_view stage gives one, so the view comes back by itself).';
  if (i.restaging) out += ` The daemon is setting it up again now (opened by ${i.restaging.who} at ${hhmm(i.restaging.at)}).`;
  if (i.staged) out += i.staged.ok ? ` Staged again ok at ${hhmm(i.staged.at)} in ${(i.staged.ms / 1000).toFixed(1)} s (${legsText(i.staged.legs)}).` : ` Staged again failed at ${hhmm(i.staged.at)}: ${i.staged.detail}.`;
  return out;
}

const hhmm = (at: string) => `${at.slice(11, 16)}Z`;

function statusLine(i: LiveViewInfo) {
  return `Live view ${i.state}${i.detail ? ` (${i.detail})` : ''}: ${i.fps} fps, ${i.width} px, ${i.frames} frames passed on, knobs on ${i.materials.join(', ') || 'no material'}.`;
}
