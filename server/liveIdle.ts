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
import type { LiveViewInfo, MachineSandbox, SessionInfo } from '../shared/types.ts';

export const LIVE_IDLE_DEFAULT_MINUTES = 15;
const BUSY = new Set<SessionInfo['status']>(['running', 'starting', 'waiting_permission']);
/** A session whose process is gone: what it last said it was running (a tool, a background job) runs no more. */
const GONE = new Set<SessionInfo['status']>(['stopped', 'error']);
/**
 * A check-in this close holds the editor (w1746). A check-in further off does not: the wake's message starts the editor
 * again (the daemon's send), as a check-in more than 30 minutes away already lets a sandbox take other work.
 */
export const LIVE_IDLE_WAKE_HOLD_MS = 30 * 60_000;
/** A view that is still not streaming this long after an opening woke its worker may wake it again (w1838). */
export const LIVE_WAKE_AGAIN_MS = 20 * 60_000;

/** One running view, as the idle close sees it (LiveHub.idleFacts). */
export interface LiveIdleView {
  liveId: string;
  sessionId: string;
  machineId: string;
  sandbox: string;
  /** The view's state (LiveViewInfo.state): a view streaming again ends the wake its opening sent (w1838). */
  state?: LiveViewInfo['state'];
  startedAtMs: number;
  /** Pages looked at now: visible and focused, or touched, within LIVE_PRESENT_MS (server/live.ts). */
  viewers: number;
  /** Pages connected, looked at or not. */
  pagesOpen?: number;
  /** The last time a page opened, was looked at, or left it (ms). */
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
    const wake = s.wakeAt ? Date.parse(s.wakeAt) : f.wakePending(s.id) ? now : undefined;
    const wakeNear = wake !== undefined && !(wake - now > LIVE_IDLE_WAKE_HOLD_MS);
    if (GONE.has(s.status)) {
      if (wakeNear) return `${s.id} has a check-in pending${s.wakeAt ? ` (${s.wakeAt})` : ''}`;
      continue;
    }
    // A tool runs only inside a turn, which BUSY covers; a tool still recorded on a session between turns is left over
    // (beast/slot3, 2026-10-22 17:05Z: "b0ae73cf is running Bash" from a worker that was not mid-turn kept the editor open).
    if (BUSY.has(s.status)) return `${s.id} is mid-turn`;
    if ((s.backgroundTasks ?? 0) > 0 || s.backgroundJobs?.length) return `${s.id} has a background job running`;
    if (s.pendingPermissions?.length) return `${s.id} waits for a permission answer`;
    if (wakeNear) return `${s.id} has a check-in pending${s.wakeAt ? ` (${s.wakeAt})` : ''}`;
  }
  const last = Math.max(v.startedAtMs, v.watchedAt ?? 0, v.touchedAt ?? 0, ...f.sessions.map((s) => Date.parse(s.lastActivityAt) || 0));
  const unseen = (v.pagesOpen ?? 0) - v.viewers;
  if (now - last < minutes * 60_000) return `idle ${Math.floor((now - last) / 60_000)} of ${minutes} min${unseen > 0 ? ` (${unseen} page${unseen > 1 ? 's' : ''} open, not looked at)` : ''}`;
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
  /** Why the computer takes no work now (a release build, a bench lock, a pause): an editor cannot start there (w1838). */
  hold?(machineId: string): string | undefined;
  /** Its worker was asked to stage the view again for `who` (LiveHub.woken: the panel says so, w1838). */
  woke?(liveId: string, who: string): void;
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
  /** Views whose worker a viewer woke while it was not streaming for another reason (w1838), and when. */
  private readonly nudged = new Map<string, number>();
  /** Why each view's editor stays open now ("machine/sandbox" → reason), for the log and system_status. */
  private readonly why = new Map<string, string>();
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
        this.why.delete(key);
        continue;
      }
      if (this.closing.has(v.liveId)) continue;
      if (!this.d.canClose(v.machineId)) {
        this.keep(key, v, `${v.machineId}'s daemon does not close editors yet (it needs a daemon update)`);
        continue;
      }
      const block = liveIdleBlock(v, { sandbox: sb, sessions: this.sessionsOf(v, sb), wakePending: (id) => this.d.wakePending(id) }, now, minutes);
      if (block) {
        this.keep(key, v, block);
        continue;
      }
      const tried = this.tried.get(v.liveId);
      if (tried !== undefined && now - tried < minutes * 60_000) {
        this.keep(key, v, `its last close was skipped ${Math.floor((now - tried) / 60_000)} min ago; asked again after ${minutes} min`);
        continue;
      }
      this.why.delete(key);
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
    // A view that streams again (or is gone) is done with its wake: the next time it stops, an opening wakes its worker again.
    const streaming = new Set(views.filter((v) => v.state === 'live').map((v) => v.liveId));
    for (const id of [...this.nudged.keys()]) if (!live.has(id) || streaming.has(id)) this.nudged.delete(id);
    const keys = new Set(views.map((v) => `${v.machineId}/${v.sandbox}`));
    for (const key of [...this.why.keys()]) if (!keys.has(key)) this.why.delete(key);
  }

  /**
   * A view's editor stays open: logged when the kind of reason changes (numbers aside, so "idle 3 of 15 min" counting up
   * logs once), so the journal says why a view that looks idle was not closed.
   */
  private keep(key: string, v: LiveIdleView, reason: string) {
    const was = this.why.get(key);
    this.why.set(key, reason);
    const kind = (r: string) => r.replace(/\d+/g, '#');
    if (was === undefined || kind(was) !== kind(reason)) this.d.log(`live idle: ${key}: ${v.sessionId}'s Live view stays open: ${reason}`);
  }

  /** The views whose editor stays open now, each with why ("beast/slot5 (1 page watching)"), for system_status. */
  keptOpen(): string[] {
    return [...this.why].map(([key, reason]) => `${key} (${reason})`);
  }

  /**
   * A person opened a view (LiveHub.addViewer). Its editor closed idle: wake its worker, whose next turn starts the editor
   * (the daemon's send) and stages the view again; once per close.
   */
  viewerOpened(v: Pick<LiveViewInfo, 'sessionId' | 'machineId' | 'sandbox'> & Partial<Pick<LiveViewInfo, 'liveId' | 'state' | 'detail'>>, who: string | undefined) {
    const key = `${v.machineId}/${v.sandbox}`;
    const sb = this.d.sandbox(v.machineId, v.sandbox);
    if (!sb?.idleClosed) return this.nudge(v, sb, who);
    if (this.woken.has(key)) return;
    const s = this.d.session(v.sessionId);
    if (s && BUSY.has(s.status)) return; // mid-turn: its turn already started the editor
    this.woken.add(key);
    const text = `[live view] ${who ?? 'A person'} opened your Live view and is watching it now. Stage it again so they see your asset (above), say so in one line, then end your turn as before (declare waiting_on_person again if you still wait on them).`;
    try {
      this.d.send(v.sessionId, text);
      if (v.liveId) this.d.woke?.(v.liveId, who ?? 'A person');
      this.d.log(`live idle: ${key}: ${who ?? 'a person'} opened ${v.sessionId}'s Live view: its worker is woken to start the editor and stage the view again`);
    } catch (e) {
      this.woken.delete(key);
      this.d.log(`live idle: ${key}: ${who ?? 'a person'} opened ${v.sessionId}'s Live view, and its worker could not be woken: ${(e as Error).message}`);
    }
  }

  /**
   * w1838: a person opened a view that does not stream because its editor stopped some other way (its worker stopped it at
   * its turn's end, a crash, a hang restart, a start that found no Unity slot) or the game left play mode. Before, only an idle
   * close woke the worker, and the panel said "It comes back by itself" over a view that never did: the w1466 view on
   * beast/slot5 held for hours on 2026-10-23 with its editor stopped since 07:07Z. Now its worker is asked to stage it again,
   * once per stop (again after LIVE_WAKE_AGAIN_MS), unless it is mid-turn (on it already) or its computer is held (a release
   * build, a bench lock: its editor cannot start, and the hold's end tells it, server/buildPlans.ts done).
   */
  private nudge(v: Pick<LiveViewInfo, 'sessionId' | 'machineId' | 'sandbox'> & Partial<Pick<LiveViewInfo, 'liveId' | 'state' | 'detail'>>, sb: MachineSandbox | undefined, who: string | undefined) {
    if (!v.liveId || !sb || v.state === 'live' || v.state === 'stopped') return;
    const editor = sb.unity.state;
    // Starting: someone started it (the worker, the hang watch), and the game is not up yet. A hold while the editor runs
    // in play mode (a script reload, a stall) comes back by itself.
    const why = editor === 'stopped' || editor === 'crashed' ? `its editor is ${editor}` : editor === 'running' && /not in play mode|no agent channel/i.test(v.detail ?? '') ? 'the game is not in play mode' : undefined;
    if (!why) return;
    const key = `${v.machineId}/${v.sandbox}`;
    const hold = this.d.hold?.(v.machineId);
    if (hold) return this.d.log(`live idle: ${key}: ${who ?? 'a person'} opened ${v.sessionId}'s Live view (${why}); its worker is not woken: ${v.machineId} is held (${hold})`);
    const s = this.d.session(v.sessionId);
    if (!s || BUSY.has(s.status)) return;
    const now = this.d.now();
    const last = this.nudged.get(v.liveId);
    if (last !== undefined && now - last < LIVE_WAKE_AGAIN_MS) return;
    this.nudged.set(v.liveId, now);
    const start = editor === 'running' ? '' : 'start your editor (mcp__machine__unity start), ';
    const text = `[live view] ${who ?? 'A person'} opened your Live view, and it is not streaming: ${why}. Now ${start}put the game in play mode with your asset on screen and the HUD hidden, as you staged it before (the view streams by itself; no live_view start needed while it is up), say so in one line, then end your turn as before (declare waiting_on_person again if you still wait on them).`;
    try {
      this.d.send(v.sessionId, text);
      this.d.woke?.(v.liveId, who ?? 'A person');
      this.d.log(`live idle: ${key}: ${who ?? 'a person'} opened ${v.sessionId}'s Live view (${why}): its worker is woken to stage it again`);
    } catch (e) {
      this.nudged.delete(v.liveId);
      this.d.log(`live idle: ${key}: ${who ?? 'a person'} opened ${v.sessionId}'s Live view (${why}), and its worker could not be woken: ${(e as Error).message}`);
    }
  }
}

/** The sandbox line's editor part while it is closed idle (list_sandboxes); undefined when it is not. */
export function idleClosedPart(sb: Pick<MachineSandbox, 'idleClosed'>): string | undefined {
  const c = sb.idleClosed;
  return c ? `editor closed: idle ${c.minutes} min; reopens on resume (closed ${c.at.slice(11, 16)}Z${c.saved?.length ? `, saved ${c.saved.join(', ')} first` : ''})` : undefined;
}

/** system_status's line (w1746): the setting, and the editors closed idle now. Undefined while the live view is off. */
export function liveIdleStatusLine(enabled: boolean, minutes: number, machines: { id: string; sandboxes?: MachineSandbox[] }[], keptOpen: string[] = []): string | undefined {
  if (!enabled) return undefined;
  const closed = machines.flatMap((m) => (m.sandboxes ?? []).filter((s) => s.idleClosed).map((s) => `${m.id}/${s.id} (since ${s.idleClosed!.at.slice(11, 16)}Z)`));
  const rule = minutes > 0 ? `a Live view idle ${minutes} min has its editor closed (live.idleCloseMinutes)` : 'off (live.idleCloseMinutes 0)';
  return `Live view idle close: ${rule}; ${closed.length ? `editor closed: idle; reopens on resume: ${closed.join(', ')}` : 'no editor closed now'}${keptOpen.length ? `; kept open: ${keptOpen.join(', ')}` : ''}.`;
}
