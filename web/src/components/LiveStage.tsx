import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { LiveViewInfo } from '../../../shared/types';
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

/**
 * Opens /live/<sessionId> (binary messages, one JPEG frame each, docs/live-view.md) and draws the newest frame on `canvas`.
 * Newest wins: a frame that arrives while the last one still decodes replaces the one waiting, so a slow page skips frames
 * and never falls behind. The canvas keeps its last picture while the socket is down or the game holds, so the view is
 * never blank after the first frame. Reconnects with backoff while `enabled`; closes on unmount and, to spare a phone's
 * data, while the tab is hidden.
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
          pending = null;
          let bmp: ImageBitmap;
          try {
            bmp = await createImageBitmap(blob);
          } catch {
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
      s.onopen = () => {
        connected = true;
        publish();
      };
      s.onmessage = (m) => {
        if (!(m.data instanceof Blob)) return;
        attempt = 0;
        arrivals.push(performance.now());
        pending = m.data; // replaces a frame still waiting to be drawn
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
    // fps decays to 0 by itself when frames stop.
    const tick = setInterval(publish, 500);
    open();
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(tick);
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
 * knob that just landed. While the game holds (it reloads scripts, restarts a play session) the last frame stays, dimmed,
 * with the reason on top.
 */
export function LiveStage({ view, toast, compact }: { view: LiveViewInfo; toast?: ReactNode; compact?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const stopped = view.state === 'stopped';
  const stats = useLiveFrames(view.sessionId, !stopped, canvas);
  const holding = view.state === 'starting' || view.state === 'holding';
  return (
    <div className={`lv-stage${holding ? ' lv-busy' : ''}${stopped ? ' lv-stopped' : ''}`} data-testid="live-stage" data-state={view.state}>
      <canvas ref={canvas} className="lv-frame" width={16} height={9} aria-label="The game's view of the asset, live" />
      <div className="lv-ov lv-ov-tl">
        {view.state === 'live' ? (
          <span className="chip chip-green lv-chip" data-testid="live-chip">
            <span className="lv-rec" /> LIVE
          </span>
        ) : holding ? (
          <span className="chip chip-amber lv-chip" data-testid="live-chip">
            HOLDING
          </span>
        ) : (
          <span className="chip lv-chip" data-testid="live-chip">
            STOPPED
          </span>
        )}
        {view.state === 'live' && !stats.connected && (
          <span className="chip chip-amber lv-chip">
            <span className="spinner spinner-sm" /> Reconnecting
          </span>
        )}
      </div>
      {stats.hasFrame && (
        <div className="lv-ov lv-ov-tr mono" data-testid="live-readout">
          {view.state === 'live' ? `${Math.round(stats.fps)} fps · ` : ''}{stats.width}×{stats.height}
        </div>
      )}
      {!stats.hasFrame && !holding && !stopped && <div className="lv-empty">{stats.connected ? 'No frame yet' : 'Connecting…'}</div>}
      {holding && (
        <div className={`lv-hold${compact ? ' lv-hold-compact' : ''}`} data-testid="live-hold">
          <div className="lv-hold-title">
            <span className="spinner spinner-sm" /> {view.state === 'starting' ? 'Starting the view' : 'Holding the last frame'}
          </div>
          {view.detail && <div className="lv-hold-note">{view.detail}</div>}
          {!compact && <div className="lv-hold-note">It comes back by itself; knobs still work.</div>}
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
