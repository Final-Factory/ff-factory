// A Live view's idle editor closed, and opened again (w1746, docs/live-view.md "Idle editors close"): the portal's half.
//
// lothsahn, 2026-10-22: "If a live view is idle for more than 15 minutes can we close it down to free the box?" Two Live
// view editors on BEAST (w1466, w1475) had sat about 6 hours with no turn, holding 2 of its 3 editor slots, 8-12 GB of RAM
// each, and the bench's quiet-machine gate. Each minute this finds the views idle for config live.idleCloseMinutes (default
// 15): no worker in that sandbox mid-turn, running a tool or a background job, or with a check-in pending, nobody watching,
// no knob moved. It asks the daemon to close the editor (machine/liveIdle.ts saves through the editor and quits it, or says
// why not). The view, the sandbox, its branch and the conversation stay. The editor starts again at the next message to a
// worker there (the daemon's `send`); a person who opens the view wakes its worker, so it starts the editor and stages the
// view again by itself.
import type { MachineSandbox, SessionInfo } from '../shared/types.ts';

export const LIVE_IDLE_DEFAULT_MINUTES = 15;
const BUSY = new Set<SessionInfo['status']>(['running', 'starting', 'waiting_permission']);

/** One running view, as the idle close sees it (LiveHub.idleFacts). */
export interface LiveIdleView {
  liveId: string;
  sessionId: string;
  machineId: string;
  sandbox: string;
  startedAtMs: number;
  /** Pages watching it now. */
  viewers: number;
  /** The last time a page opened or left it (ms). */
  watchedAt?: number;
  /** The last knob move or reset (ms). */
  touchedAt?: number;
}

/** Why a view's editor stays open now, or undefined when it is idle long enough to close. Exported for tests. */
export function liveIdleBlock(
  v: LiveIdleView,
  f: { sandbox?: MachineSandbox; sessions: SessionInfo[]; wakePending(id: string): boolean },
  now: number,
  minutes: number,
): string | undefined {
  if (!(minutes > 0)) return 'the idle close is off (live.idleCloseMinutes 0)';
  const sb = f.sandbox;
  if (!sb) return 'its sandbox is not on the machine record';
  if (sb.idleClosed) return 'its editor is closed already';
  if (sb.unity.state !== 'running') return `its editor is ${sb.unity.state}`;
  if (v.viewers > 0) return `${v.viewers} page${v.viewers > 1 ? 's' : ''} watching`;
  for (const s of f.sessions) {
    if (BUSY.has(s.status)) return `${s.id} is mid-turn`;
    if (s.activeTool) return `${s.id} is running ${s.activeTool.name}`;
    if ((s.backgroundTasks ?? 0) > 0 || s.backgroundJobs?.length) return `${s.id} has a background job running`;
    if (s.pendingPermissions?.length) return `${s.id} waits for a permission answer`;
    if (s.wakeAt || f.wakePending(s.id)) return `${s.id} has a check-in pending${s.wakeAt ? ` (${s.wakeAt})` : ''}`;
  }
  const last = Math.max(v.startedAtMs, v.watchedAt ?? 0, v.touchedAt ?? 0, ...f.sessions.map((s) => Date.parse(s.lastActivityAt) || 0));
  if (now - last < minutes * 60_000) return `idle ${Math.floor((now - last) / 60_000)} of ${minutes} min`;
  return undefined;
}

export interface LiveIdleDeps {
  /** config live.idleCloseMinutes (default LIVE_IDLE_DEFAULT_MINUTES; 0 never). */
  minutes(): number;
  views(): LiveIdleView[];
  sandbox(machineId: string, sandbox: string): MachineSandbox | undefined;
  session(id: string): SessionInfo | undefined;
  wakePending(id: string): boolean;
  /** Its daemon takes `live` op idleClose (hello `liveIdleClose`). */
  canClose(machineId: string): boolean;
  /** Ask the daemon to close the view's editor: "closed (...)" or "skipped: ..."; throws when the daemon is not reached. */
  close(v: LiveIdleView, minutes: number): Promise<string>;
  /** A system message to a worker (SessionManager.send), which starts it if it is stopped. */
  send(sessionId: string, text: string): void;
  log(line: string): void;
  now(): number;
}

export class LiveIdleCloser {
  /** When a view's close was last asked for: a skipped one is asked again only after another idle period. */
  private readonly tried = new Map<string, number>();
  private readonly closing = new Set<string>();
  /** Sandboxes ("machine/sandbox") seen closed idle, to log when they open again. */
  private readonly closed = new Set<string>();
  /** Sandboxes whose worker a viewer already woke since the close. */
  private readonly woken = new Set<string>();
  private running = false;
  private readonly d: LiveIdleDeps;

  constructor(d: LiveIdleDeps) {
    this.d = d;
  }

  private minutes() {
    const m = this.d.minutes();
    return Number.isFinite(m) && m >= 0 ? m : LIVE_IDLE_DEFAULT_MINUTES;
  }

  /** The sessions sharing a view's sandbox (its own first): an editor is a sandbox's, and up to two workers use it. */
  private sessionsOf(v: LiveIdleView, sb: MachineSandbox | undefined): SessionInfo[] {
    const ids = [v.sessionId, ...(sb?.sessionIds ?? []).filter((id) => id !== v.sessionId)];
    return ids.map((id) => this.d.session(id)).filter((s): s is SessionInfo => !!s && s.machineSandbox === v.sandbox && s.machineId === v.machineId);
  }

  /** One pass, every minute: log editors that opened again, then close the idle ones. Overlapping passes are dropped. */
  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.pass();
    } finally {
      this.running = false;
    }
  }

  private async pass() {
    const now = this.d.now();
    const minutes = this.minutes();
    const views = this.d.views();
    for (const key of [...this.closed]) {
      const [m, s] = key.split('/');
      const sb = this.d.sandbox(m, s);
      if (sb?.idleClosed) continue;
      this.closed.delete(key);
      this.woken.delete(key);
      this.d.log(`live idle: ${key}: its editor opened again (unity ${sb?.unity.state ?? 'unknown'})`);
    }
    for (const v of views) {
      const key = `${v.machineId}/${v.sandbox}`;
      const sb = this.d.sandbox(v.machineId, v.sandbox);
      if (sb?.idleClosed) {
        this.closed.add(key);
        continue;
      }
      if (this.closing.has(v.liveId) || !this.d.canClose(v.machineId)) continue;
      const block = liveIdleBlock(v, { sandbox: sb, sessions: this.sessionsOf(v, sb), wakePending: (id) => this.d.wakePending(id) }, now, minutes);
      if (block) continue;
      if (now - (this.tried.get(v.liveId) ?? -Infinity) < minutes * 60_000) continue;
      this.tried.set(v.liveId, now);
      this.closing.add(v.liveId);
      // Not awaited: a close takes up to a few minutes (leaving play mode, saving, the quit), and other views go meanwhile.
      void this.d
        .close(v, minutes)
        .then(
          (text) => {
            this.d.log(`live idle: ${key}: ${v.sessionId}'s Live view idle ${minutes} min: editor ${text}`);
            if (/^closed/.test(text)) this.closed.add(key);
          },
          (e) => this.d.log(`live idle: ${key}: ${v.sessionId}'s Live view idle ${minutes} min: the close was not made: ${(e as Error).message}`),
        )
        .finally(() => this.closing.delete(v.liveId));
    }
    const live = new Set(views.map((v) => v.liveId));
    for (const id of [...this.tried.keys()]) if (!live.has(id)) this.tried.delete(id);
  }

  /**
   * A person opened a view (LiveHub.addViewer). Its editor closed idle: wake its worker, whose next turn starts the editor
   * (the daemon's send) and stages the view again; once per close.
   */
  viewerOpened(v: Pick<LiveIdleView, 'sessionId' | 'machineId' | 'sandbox'>, who: string | undefined) {
    const key = `${v.machineId}/${v.sandbox}`;
    const sb = this.d.sandbox(v.machineId, v.sandbox);
    if (!sb?.idleClosed || this.woken.has(key)) return;
    const s = this.d.session(v.sessionId);
    if (s && BUSY.has(s.status)) return; // mid-turn: its turn already started the editor
    this.woken.add(key);
    const text = `[live view] ${who ?? 'A person'} opened your Live view and is watching it now. Stage it again so they see your asset (above), say so in one line, then end your turn as before (declare waiting_on_person again if you still wait on them).`;
    try {
      this.d.send(v.sessionId, text);
      this.d.log(`live idle: ${key}: ${who ?? 'a person'} opened ${v.sessionId}'s Live view: its worker is woken to start the editor and stage the view again`);
    } catch (e) {
      this.woken.delete(key);
      this.d.log(`live idle: ${key}: ${who ?? 'a person'} opened ${v.sessionId}'s Live view, and its worker could not be woken: ${(e as Error).message}`);
    }
  }
}

/** The sandbox line's editor part while it is closed idle (list_sandboxes); undefined when it is not. */
export function idleClosedPart(sb: Pick<MachineSandbox, 'idleClosed'>): string | undefined {
  const c = sb.idleClosed;
  return c ? `editor closed: idle ${c.minutes} min; reopens on resume (closed ${c.at.slice(11, 16)}Z${c.saved?.length ? `, saved ${c.saved.join(', ')} first` : ''})` : undefined;
}

/** system_status's line (w1746): the setting, and the editors closed idle now. Undefined while the live view is off. */
export function liveIdleStatusLine(enabled: boolean, minutes: number, machines: { id: string; sandboxes?: MachineSandbox[] }[]): string | undefined {
  if (!enabled) return undefined;
  const closed = machines.flatMap((m) => (m.sandboxes ?? []).filter((s) => s.idleClosed).map((s) => `${m.id}/${s.id} (since ${s.idleClosed!.at.slice(11, 16)}Z)`));
  const rule = minutes > 0 ? `a Live view idle ${minutes} min has its editor closed (live.idleCloseMinutes)` : 'off (live.idleCloseMinutes 0)';
  return `Live view idle close: ${rule}; ${closed.length ? `editor closed: idle; reopens on resume: ${closed.join(', ')}` : 'no editor closed now'}.`;
}
