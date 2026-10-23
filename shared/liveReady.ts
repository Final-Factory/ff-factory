// Whether a Live view can be used now, and if not, what it waits on (w1838, docs/live-view.md "Ready or not").
//
// Ben, 2026-10-23: "a lot of times when I click it, I get this kind of situation where it's just not ready. Or maybe ...
// it's queued up. In that case, don't show the live view go sticker thing on the slot. Only show that when it's ready and
// can be used." The slot's badge said "Live view: go" for any view that was not stopped: the w1466 view on beast/slot5 held
// its last frame for hours with its editor stopped, and every knob was red. Now one function reads the view, its sandbox's
// editor and the computer's hold, and the slot's badge, the panel's state line and the knobs all say what it returns. Pure,
// so the server's tests check it and the browser runs it.
import type { LiveViewInfo, MachineSandbox, SessionInfo } from './types.ts';

export type LiveReadyKind =
  /** Frames flow from the game in play mode: the knobs read and move. The only state that says "go". */
  | 'go'
  /** The portal asked the game to stream and no frame came yet. */
  | 'starting'
  /** The machine is held (a release build, a timed run's bench lock, a pause) and the editor is not running. */
  | 'held'
  /** The editor's start waits its turn in the machine's bench queue, or for a free Unity slot. */
  | 'queued'
  | 'editor-starting'
  /** The editor was closed because the view sat idle (w1746); opening the view wakes its worker. */
  | 'idle-closed'
  | 'editor-stopped'
  /** The editor runs, but the game is not in play mode. */
  | 'no-play'
  /** It streamed, then frames stopped coming with the socket still open (a busy or hung editor). */
  | 'stalled'
  /** Any other hold: a script reload, a new play session (it comes back by itself in seconds). */
  | 'holding'
  | 'stopped';

export interface LiveReady {
  kind: LiveReadyKind;
  ready: boolean;
  tone: 'green' | 'amber' | 'grey' | 'red';
  /** The slot's badge: "Live view: go", "Live view: editor stopped". */
  badge: string;
  /** The panel's chip and title: "Live", "Editor stopped". */
  label: string;
  /** Why, in one line. */
  why: string;
  /** What brings it back, and when (empty when it is ready). */
  back: string;
}

/** What the readiness reads besides the view: its sandbox's editor (the machine record) and its worker. */
export interface LiveReadyContext {
  sandbox?: Pick<MachineSandbox, 'unity' | 'idleClosed'>;
  /** The view's worker: mid-turn, it is already on it. */
  session?: Pick<SessionInfo, 'status'>;
}

const hhmm = (iso: string | undefined) => (iso && iso.length >= 16 ? `${iso.slice(11, 16)}Z` : '');
const MID_TURN = new Set<SessionInfo['status']>(['starting', 'running', 'waiting_permission']);
/** The daemon's hold detail when the editor runs and the game is not in play mode (machine/live.ts tick). */
const NO_PLAY = /not in play mode|no agent channel/i;
/** The portal's stall detail (server/live.ts STALL_MS). */
const STALLED = /^no frame from the game for/i;
/** A start that waits for a Unity slot (machine/sandboxes.ts: "needs 1, 0 free (3 of 3 in use)"). */
const NO_SLOT = /\b0 free\b|of \d+ in use|launch(es)? wait/i;

function woken(view: Pick<LiveViewInfo, 'wake'>): string | undefined {
  const w = view.wake;
  return w ? `${w.who} opened it at ${hhmm(w.at)}: its worker was asked to set the view up again (usually a few minutes).` : undefined;
}

function backByWake(view: Pick<LiveViewInfo, 'wake'>, ctx: LiveReadyContext, what: string): string {
  if (ctx.session && MID_TURN.has(ctx.session.status)) return `Its worker is mid-turn: the view streams once it ${what}.`;
  return woken(view) ?? `Opening it asks its worker to ${what} (usually a few minutes).`;
}

/** Whether `view` can be used now and, if not, what it waits on (the header). */
export function liveReady(view: Pick<LiveViewInfo, 'state' | 'detail' | 'hold' | 'wake'>, ctx: LiveReadyContext = {}): LiveReady {
  // The panel's label is the badge's word (the w1838 critic: "paused for a build" on the slot, "Paused" on the panel read as two
  // states), and every sentence starts with a capital and ends with a full stop, whatever the daemon's detail looked like.
  const sentence = (t: string) => (t ? `${t[0].toUpperCase()}${t.slice(1)}${/[.!?)]$/.test(t) ? '' : '.'}` : t);
  const r = (kind: LiveReadyKind, tone: LiveReady['tone'], badge: string, why: string, back: string): LiveReady => ({
    kind,
    ready: kind === 'go',
    tone,
    badge: `Live view: ${badge}`,
    label: kind === 'go' ? 'Live' : `${badge[0].toUpperCase()}${badge.slice(1)}`,
    why: sentence(why),
    back,
  });
  const unity = ctx.sandbox?.unity;
  const detail = view.detail ?? '';
  if (view.state === 'stopped') return r('stopped', 'grey', 'stopped', detail || 'The view has stopped', 'Its worker starts it again with live_view start.');
  // Frames flow: the one direct evidence, newer than the machine record's editor state (polled). A stream that stops says
  // holding at once (the daemon's socket closes), and one that stalls with the socket open does within LIVE_STALL_MS.
  if (view.state === 'live') return r('go', 'green', 'go', 'The game streams and the knobs move it', '');
  if (view.state === 'starting' && (!unity || unity.state === 'running')) return r('starting', 'amber', 'starting', detail || 'Asking the game to stream', 'The first frame comes in a few seconds once the game is in play mode.');
  // Unknown (no machine record): only the view's own state speaks.
  const down = !!unity && unity.state !== 'running';
  if (down && view.hold) return held(view.hold, r);
  if (down && ctx.sandbox?.idleClosed) {
    const c = ctx.sandbox.idleClosed;
    return r('idle-closed', 'grey', 'editor closed', `The sandbox editor closed after ${c.minutes} idle minutes (at ${hhmm(c.at)}), saved first`, backByWake(view, ctx, 'reopen the editor and set the view up'));
  }
  if (unity?.state === 'starting') {
    if (/queued in the bench queue/i.test(unity.detail ?? '')) return r('queued', 'amber', 'queued', `The sandbox editor's start waits its turn in the bench queue: ${String(unity.detail).replace(/^queued in the bench queue:\s*/i, '')}`, 'The editor starts by itself at its turn, never beside a timed run; then its worker sets the view up.');
    return r('editor-starting', 'amber', 'editor starting', 'The sandbox editor is starting (a minute or two to load)', 'The view streams once its worker puts the game in play mode.');
  }
  if (down && NO_SLOT.test(unity?.detail ?? '')) return r('queued', 'amber', 'waiting on a slot', `The sandbox editor did not start: ${unity!.detail}`, backByWake(view, ctx, 'start the editor again and set the view up'));
  if (down) {
    const crashed = unity?.state === 'crashed';
    return r('editor-stopped', 'grey', crashed ? 'editor crashed' : 'editor stopped', crashed ? `The sandbox editor crashed${unity?.detail ? `: ${unity.detail}` : ''}` : 'The sandbox editor is not running', backByWake(view, ctx, 'start the editor and set the view up'));
  }
  if (STALLED.test(detail)) return r('stalled', 'amber', 'no frames', detail, 'It goes live again with the next frame; a hung editor is restarted by the machine\'s watch.');
  if (NO_PLAY.test(detail)) return r('no-play', 'amber', 'not in play mode', 'The sandbox editor runs, but the game is not in play mode', backByWake(view, ctx, 'enter play mode and set the view up'));
  return r('holding', 'amber', 'holding', detail || 'The game stopped streaming', 'It comes back by itself when the game streams again (a script reload takes seconds).');
}

/**
 * The computer is held: a build plan's hold ("building since 07:40Z (Urgent hotfix release after 1.0.0.9, the dispatcher for
 * w1836; w1606)", server/buildPlans.ts holdWhy), a bench lock (server/placement.ts benchText) or a pause. Said as a sentence,
 * not as the log line (the w1838 critic).
 */
function held(hold: string, r: (kind: LiveReadyKind, tone: LiveReady['tone'], badge: string, why: string, back: string) => LiveReady): LiveReady {
  const text = hold.replace(/: no new work until it is done$/, '');
  const back = 'The sandbox editor can start once that ends: FF Factory tells its worker then, and it sets the view up again.';
  const build = /^(building since \S+|cleared for a build since \S+|a build is coming at \S+) \(([^,;)]+)/.exec(text);
  if (build) return r('held', 'amber', 'paused for a build', `A release build holds this computer (${build[2]}, ${build[1]})`, back);
  const bench = /bench lock is held since (\S+) \(([^)]*)\)/.exec(text);
  if (bench) return r('held', 'amber', 'waiting on a timed run', `A timed run holds this computer's bench (${bench[2]}, since ${bench[1]})`, back);
  return r('held', 'amber', 'paused', `This computer takes no work now (${text})`, back);
}
