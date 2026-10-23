import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { LiveViewInfo } from '../../../shared/types';
import { liveReady, type LiveReady } from '../../../shared/liveReady';
import { Icon } from './ui';

/** What the page measured from the frames it received (the view's own `fps` is what the game was asked for). */
export interface FrameStats {
  /** A frame has been drawn since this page opened the view. */
  hasFrame: boolean;
  /** Frames received over the last two seconds, per second. */
  fps: number;
  width: number;
  height: number;
  /** The frame socket is open. */
  connected: boolean;
}

const NONE: FrameStats = { hasFrame: false, fps: 0, width: 0, height: 0, connected: false };
const FPS_WINDOW_MS = 2000;
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
/** How often a looked-at page says so ("p"), and the least gap between two (server/live.ts LIVE_PRESENT_MS, w1746). */
const PRESENT_EVERY_MS = 30_000;
const PRESENT_GAP_MS = 10_000;
const TOUCHES = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'focus'] as const;

/**
 * Opens /live/<sessionId> (binary messages, one JPEG frame each, docs/live-view.md) and draws the newest frame on `canvas`.
 * Newest wins: a frame that arrives while the last one still decodes replaces the one waiting, so a slow page skips frames
 * and never falls behind. Each frame drawn is answered with how many frames this socket has brought ("a<count>", w1601):
 * the portal sends no more than the link carries in one round trip, so the view never runs behind on a slow link
 * (shared/framePump.ts). The canvas keeps its last picture while the socket is down or the game holds, so the view is
 * never blank after the first frame. Reconnects with backoff while `enabled`; closes on unmount and, to spare a phone's
 * data, while the tab is hidden. While the tab is visible and focused, and at each touch, it says "p" (present): a page
 * nobody looks at stops counting as watching, so the view's idle editor can close (w1746, docs/live-view.md).
 */
function useLiveFrames(sessionId: string, enabled: boolean, canvas: RefObject<HTMLCanvasElement | null>): FrameStats {
  const [stats, setStats] = useState<FrameStats>(NONE);
  useEffect(() => {
    setStats(NONE);
    if (!enabled) return;
    let stopped = false;
    let sock: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let pending: Blob | null = null;
    /** Frames this socket brought, and the number of the one waiting in `pending`. */
    let received = 0;
    let pendingNo = 0;
    let decoding = false;
    let drawn = false;
    let size = { w: 0, h: 0 };
    let connected = false;
    const arrivals: number[] = [];

    const publish = () => {
      const t = performance.now();
      while (arrivals.length && t - arrivals[0] > FPS_WINDOW_MS) arrivals.shift();
      const fps = Math.round((arrivals.length / (FPS_WINDOW_MS / 1000)) * 10) / 10;
      setStats((p) => (p.hasFrame === drawn && p.fps === fps && p.width === size.w && p.height === size.h && p.connected === connected ? p : { hasFrame: drawn, fps, width: size.w, height: size.h, connected }));
    };

    const pump = async () => {
      if (decoding) return;
      decoding = true;
      try {
        while (pending && !stopped) {
          const blob = pending;
          const no = pendingNo;
          const from = sock;
          pending = null;
          // Done with it (drawn, or damaged): the portal may send the next. The count covers frames it replaced.
          const answer = () => {
            if (from && from === sock && from.readyState === WebSocket.OPEN) from.send(`a${no}`);
          };
          let bmp: ImageBitmap;
          try {
            bmp = await createImageBitmap(blob);
          } catch {
            answer();
            continue; // a damaged frame: the next one replaces it
          }
          const el = canvas.current;
          if (el && !stopped) {
            if (el.width !== bmp.width || el.height !== bmp.height) {
              el.width = bmp.width;
              el.height = bmp.height;
            }
            el.getContext('2d')?.drawImage(bmp, 0, 0);
            drawn = true;
            size = { w: bmp.width, h: bmp.height };
          }
          bmp.close();
          answer();
        }
      } finally {
        decoding = false;
      }
      publish();
    };

    const open = () => {
      if (stopped || sock || document.visibilityState === 'hidden') return;
      const s = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/live/${encodeURIComponent(sessionId)}`);
      s.binaryType = 'blob';
      sock = s;
      received = 0;
      pending = null;
      s.onopen = () => {
        connected = true;
        publish();
      };
      s.onmessage = (m) => {
        if (!(m.data instanceof Blob)) return;
        attempt = 0;
        arrivals.push(performance.now());
        pending = m.data; // replaces a frame still waiting to be drawn
        pendingNo = ++received;
        void pump();
      };
      s.onclose = () => {
        if (sock !== s) return;
        sock = null;
        connected = false;
        publish();
        if (stopped || document.visibilityState === 'hidden') return;
        timer = setTimeout(open, BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)] * (0.75 + Math.random() * 0.5));
      };
    };

    const onVisible = () => {
      if (document.visibilityState === 'hidden') {
        clearTimeout(timer);
        const s = sock;
        sock = null;
        s?.close();
        connected = false;
      } else {
        attempt = 0;
        clearTimeout(timer);
        open();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    let saidPresent = 0;
    const present = (e?: Event) => {
      const t = Date.now();
      if (!sock || sock.readyState !== WebSocket.OPEN || document.visibilityState !== 'visible') return;
      if (!e && !document.hasFocus()) return;
      if (t - saidPresent < PRESENT_GAP_MS) return;
      saidPresent = t;
      sock.send('p');
    };
    for (const k of TOUCHES) window.addEventListener(k, present, { passive: true });
    const presence = setInterval(present, PRESENT_EVERY_MS);
    // fps decays to 0 by itself when frames stop.
    const tick = setInterval(publish, 500);
    open();
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(tick);
      clearInterval(presence);
      for (const k of TOUCHES) window.removeEventListener(k, present);
      document.removeEventListener('visibilitychange', onVisible);
      const s = sock;
      sock = null;
      if (s) {
        s.onclose = null;
        s.close();
      }
    };
  }, [sessionId, enabled, canvas]);
  return stats;
}

/**
 * The game's view of the asset: a 16:9 frame with the view's state, the measured fps and size over it, and the toast for a
 * knob that just landed. While it cannot be used (w1838, shared/liveReady.ts: the editor stopped, a build holds the computer,
 * the game left play mode, a script reload) the last frame stays, dimmed, with what it waits on and what brings it back.
 */
export function LiveStage({ view, ready: given, toast, compact }: { view: LiveViewInfo; ready?: LiveReady; toast?: ReactNode; compact?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const ready = given ?? liveReady(view);
  const stopped = view.state === 'stopped';
  const stats = useLiveFrames(view.sessionId, !stopped, canvas);
  const holding = !stopped && !ready.ready;
  // Waiting on something that takes minutes (an editor, a build, a worker), not seconds: no spinner, the state's dot.
  const slow = ready.kind !== 'starting' && ready.kind !== 'holding' && ready.kind !== 'stalled' && ready.kind !== 'editor-starting';
  return (
    <div className={`lv-stage${holding ? ' lv-busy' : ''}${stopped ? ' lv-stopped' : ''}`} data-testid="live-stage" data-state={view.state}>
      <canvas ref={canvas} className="lv-frame" width={16} height={9} aria-label="The game's view of the asset, live" />
      <div className="lv-ov lv-ov-tl">
        {ready.ready ? (
          <span className="chip chip-green lv-chip" data-testid="live-chip">
            <span className="lv-rec" /> LIVE
          </span>
        ) : holding ? (
          <span className={`chip chip-${ready.tone} lv-chip`} data-testid="live-chip" data-ready={ready.kind}>
            {ready.label.toUpperCase()}
          </span>
        ) : (
          <span className="chip lv-chip" data-testid="live-chip">
            STOPPED
          </span>
        )}
        {ready.ready && !stats.connected && (
          <span className="chip chip-amber lv-chip">
            <span className="spinner spinner-sm" /> Reconnecting
          </span>
        )}
      </div>
      {stats.hasFrame && (
        <div className="lv-ov lv-ov-tr mono" data-testid="live-readout">
          {ready.ready ? `${Math.round(stats.fps)} fps · ` : ''}{stats.width}×{stats.height}
        </div>
      )}
      {!stats.hasFrame && !holding && !stopped && <div className="lv-empty">{stats.connected ? 'No frame yet' : 'Connecting…'}</div>}
      {holding && (
        <div className={`lv-hold lv-tone-${ready.tone}${compact ? ' lv-hold-compact' : ''}`} data-testid="live-hold" data-ready={ready.kind}>
          {/* The chip and the header name the state; the card's headline says what is wrong, then what brings it back (the
              w1838 critics: not the state's word a third time, nor one headline for every state). */}
          <div className="lv-hold-title">
            {slow ? <span className={`dot dot-${ready.tone}`} aria-hidden /> : <span className="spinner spinner-sm" />} {ready.why}
          </div>
          {ready.back && <div className="lv-hold-note">{ready.back}</div>}
        </div>
      )}
      {stopped && (
        <div className="lv-hold">
          <div className="lv-hold-title">
            <Icon name="pause" size={14} /> This view has stopped
          </div>
          {view.detail && <div className="lv-hold-note">{view.detail}</div>}
        </div>
      )}
      {toast && <div className="lv-ov lv-ov-bl">{toast}</div>}
    </div>
  );
}
