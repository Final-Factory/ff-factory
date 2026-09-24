import { useCallback, useEffect, useState } from 'react';
import type { SessionInfo } from '../../../shared/types';
import { api } from '../api';
import { attempt, getState, openSession, reloadTranscript, useStore } from '../store';
import { Composer } from './Composer';
import { ModeSelect, SessionMeta } from './SessionView';
import { Transcript } from './Transcript';
import { Confirm, Dot, Icon } from './ui';
import { sessionTone } from '../util';

const SUGGESTIONS = [
  'Start work on spec 098',
  'Play a single player game through the tutorial and log the bugs',
  'Read the Discord forums and identify bugs',
  "How's the shader sandbox doing?",
];

/** While workers are busy, wake the orchestrator every N minutes for a one-line status (server/wake.ts). */
function HeartbeatSelect() {
  const minutes = useStore((s) => s.app?.settings?.heartbeatMinutes ?? null);
  return (
    <label className={`mode-select heartbeat${minutes ? ' on' : ''}`} title="Heartbeat: while workers are busy, the orchestrator posts a one-line status every N minutes">
      <select value={minutes ?? ''} onChange={(e) => void attempt(api.setSettings({ heartbeatMinutes: e.target.value ? Number(e.target.value) : null }))}>
        <option value="">Heartbeat off</option>
        {[10, 15, 30, 60].map((m) => (
          <option key={m} value={m}>
            Heartbeat {m} min
          </option>
        ))}
      </select>
    </label>
  );
}

export function OrchestratorView({ session, compact }: { session: SessionInfo | undefined; compact?: boolean }) {
  const [prefill, setPrefill] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const clearPrefill = useCallback(() => setPrefill(null), []);

  useEffect(() => (session ? openSession(session.id) : undefined), [session?.id]);

  if (!session) {
    return (
      <section className="orch orch-missing">
        <div className="transcript-loading">
          <span className="spinner" /> Waiting for the orchestrator…
        </div>
      </section>
    );
  }

  const empty = (
    <div className="orch-empty">
      <div className="orch-mark" aria-hidden>
        <span />
        <span />
        <span />
      </div>
      <h1>What should the factory work on?</h1>
      <p>
        Ask for work in plain words. The orchestrator creates sandboxes, starts Unity and runs agents, then reports back
        here.
      </p>
      <div className="chips">
        {SUGGESTIONS.map((s) => (
          <button key={s} className="suggest" onClick={() => setPrefill(s)}>
            {s}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <section className={`orch${compact ? ' orch-compact' : ''}`}>
      <header className="orch-head">
        <div className="orch-title">
          <Dot tone={sessionTone(session.status)} pulse={session.status === 'running'} />
          <span>Orchestrator</span>
          <SessionMeta session={session} />
        </div>
        <div className="session-actions">
          <HeartbeatSelect />
          <ModeSelect session={session} />
          <button className="btn btn-ghost btn-sm" onClick={() => setConfirmReset(true)} title="Start a fresh main conversation">
            <Icon name="plus" size={14} /> <span className="hide-sm">New conversation</span>
          </button>
        </div>
      </header>
      <Transcript session={session} size={compact ? 'normal' : 'large'} empty={empty} />
      <div className="orch-composer-wrap">
        <Composer
          key={session.id}
          session={session}
          size={compact ? 'normal' : 'large'}
          placeholder="Ask the orchestrator…  (Enter to send, Shift+Enter or Ctrl+Enter for a new line)"
          prefill={prefill}
          onPrefillUsed={clearPrefill}
        />
      </div>
      {confirmReset && (
        <Confirm
          title="Start a new conversation?"
          confirmLabel="New conversation"
          body="The orchestrator starts fresh. Sandboxes and worker agents keep running."
          onConfirm={async () => {
            const ok = await attempt(api.resetOrchestrator());
            if (ok !== undefined) reloadTranscript(getState().app?.orchestratorId ?? session.id);
          }}
          onClose={() => setConfirmReset(false)}
        />
      )}
    </section>
  );
}
