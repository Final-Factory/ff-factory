import { useEffect, useRef, useState } from 'react';
import type { AppState, LiveViewInfo, SessionInfo } from '../../../shared/types';
import { liveReady } from '../../../shared/liveReady';
import { sessionRoute } from '../attention';
import { navigate } from '../util';
import { LiveKnobs } from './LiveKnobs';
import { LiveStage } from './LiveStage';
import { AttentionStrip } from './PanelChrome';
import { SessionView } from './SessionView';
import { Icon, StateText } from './ui';

const TOAST_MS = 3000;

/**
 * A session's live view (docs/live-view.md): the game's own render of the asset, with the asset's knobs, beside the
 * conversation with the agent that edits it. Wide: the view and knobs on the left, the conversation on the right (its own
 * header, details and permission strip). Narrower, including phones: one column, the view fixed on top, a control row, the
 * conversation, and the knobs in a bottom sheet.
 */
export function LiveView({ app, session, view, wide }: { app: AppState; session: SessionInfo; view: LiveViewInfo; wide: boolean }) {
  const [toast, setToast] = useState<string>();
  const [sheet, setSheet] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  const onMoved = (text: string) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(undefined), TOAST_MS);
  };
  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSheet(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheet]);
  useEffect(() => {
    if (wide) setSheet(false);
  }, [wide]);

  // w1838: what the view waits on, with its sandbox's editor (shared/liveReady.ts): the header, the stage and the knobs agree.
  const sandbox = app.machines.find((m) => m.id === view.machineId)?.sandboxes?.find((s) => s.id === view.sandbox);
  const ready = liveReady(view, { sandbox, session });
  const header = (
    <header className="ph" data-testid="live-header">
      <button className="btn btn-ghost btn-icon ph-btn" onClick={() => navigate(sessionRoute(session, app))} title="Back to the conversation's place" aria-label="Back">
        <Icon name="back" />
      </button>
      <div className="ph-text">
        <div className="ph-name" title={session.title}>
          {session.title}
        </div>
        <div className="ph-sub">
          <StateText tone={ready.tone} label={ready.label} pulse={ready.ready} />
          <span className="ph-sep">·</span>
          <span className="mono ellipsis">
            {view.machineId}/{view.sandbox}
          </span>
        </div>
      </div>
    </header>
  );
  const stage = (
    <LiveStage
      view={view}
      ready={ready}
      compact={!wide}
      toast={
        toast ? (
          <span className="lv-toast" role="status" data-testid="live-toast">
            <Icon name="check" size={13} /> Updated after the edit · {toast}
          </span>
        ) : undefined
      }
    />
  );

  if (wide) {
    return (
      <>
        <section className="lv" data-testid="live-view">
          {header}
          <div className="lv-scroll">
            {stage}
            <section className="lv-card">
              <div className="lv-card-head">
                <span className="lv-card-title">Knobs</span>
                <span className="dim small">the material&rsquo;s own properties{ready.ready ? ' · drag to try, the agent sees what you set' : ''}</span>
              </div>
              <LiveKnobs sessionId={session.id} liveNow={ready.ready} materials={view.materials} onMoved={onMoved} />
            </section>
          </div>
        </section>
        <SessionView key={session.id} session={session} />
      </>
    );
  }
  return (
    <section className="lv lv-stacked" data-testid="live-view">
      {header}
      {stage}
      <div className="lv-controls">
        <button className={`btn btn-outline btn-sm${sheet ? ' active' : ''}`} aria-expanded={sheet} onClick={() => setSheet(!sheet)} data-testid="live-knobs-open">
          <Icon name="settings" size={14} /> Knobs
        </button>
        <span className="dim small ellipsis">{view.materials.join(', ')}</span>
      </div>
      <AttentionStrip session={session} />
      <SessionView key={session.id} session={session} embedded />
      {sheet && (
        <div className="lv-sheet" role="dialog" aria-label="Knobs" data-testid="live-sheet">
          <div className="details-grab">
            <span />
          </div>
          <div className="lv-sheet-head">
            <span className="lv-card-title">Knobs</span>
            <span className="dim small ellipsis">{ready.ready ? 'drag to try, the agent sees what you set' : 'back when the view is live'}</span>
            <span className="spacer" />
            <button className="btn btn-ghost btn-icon ph-btn" onClick={() => setSheet(false)} aria-label="Close knobs">
              <Icon name="x" />
            </button>
          </div>
          <div className="lv-sheet-body">
            <LiveKnobs sessionId={session.id} liveNow={ready.ready} materials={view.materials} onMoved={onMoved} />
          </div>
        </div>
      )}
    </section>
  );
}
