import { useCallback, useEffect, useState } from 'react';
import type { SessionInfo } from '../../../shared/types';
import { api } from '../api';
import { attempt, getState, openSession, reloadTranscript, useStore } from '../store';
import { Composer } from './Composer';
import { ModeSelect } from './SessionView';
import { Transcript } from './Transcript';
import { AttentionButton, DrawerButton } from './ShellButtons';
import { Confirm, Icon, Menu, StateText } from './ui';
import { fmtCost, fmtRelative, sessionLabel, sessionTone, useNow } from '../util';

const SUGGESTIONS = ["What's running, and what needs me?", 'Start work on spec 098', 'Play the tutorial single-player and log the bugs', 'Read the Discord forums and find bugs'];

const HEARTBEATS = [10, 15, 30, 60];

/** While workers are busy, wake the orchestrator every N minutes for a one-line status (server/wake.ts). */
function HeartbeatSelect() {
  const minutes = useStore((s) => s.app?.settings?.heartbeatMinutes ?? null);
  return (
    <select className="input input-sm" value={minutes ?? ''} aria-label="Heartbeat" onChange={(e) => void attempt(api.setSettings({ heartbeatMinutes: e.target.value ? Number(e.target.value) : null }))}>
      <option value="">Off</option>
      {HEARTBEATS.map((m) => (
        <option key={m} value={m}>
          Every {m} min
        </option>
      ))}
    </select>
  );
}

export function OrchestratorView({ session, compact }: { session: SessionInfo | undefined; compact?: boolean }) {
  const [prefill, setPrefill] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const clearPrefill = useCallback(() => setPrefill(null), []);
  const heartbeat = useStore((s) => s.app?.settings?.heartbeatMinutes ?? null);
  const now = useNow(30_000);

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

  const running = session.status === 'running' || session.status === 'starting';
  const empty = (
    <div className="orch-empty">
      <div className="orch-mark" aria-hidden>
        <span />
        <span />
        <span />
      </div>
      <h1>What should the factory work on?</h1>
      <p>Say it in plain words. The orchestrator creates sandboxes, starts Unity and runs agents, then reports back here.</p>
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
        {!compact && <DrawerButton />}
        <div className="orch-title">
          <span className="orch-name">Orchestrator</span>
          <StateText tone={sessionTone(session.status)} label={sessionLabel[session.status]} pulse={running} className="orch-state" />
        </div>
        {heartbeat && (
          <span className="hb-on hide-phone" title={`Heartbeat: while workers are busy, a one-line status every ${heartbeat} minutes`}>
            <Icon name="pulse" size={13} /> {heartbeat} min
          </span>
        )}
        {!compact && <AttentionButton />}
        <Menu label="Conversation options" className="orch-menu">
          {(close) => (
            <>
              <label className="menu-field">
                <span>
                  Heartbeat
                  <small>A one-line status while workers are busy</small>
                </span>
                <HeartbeatSelect />
              </label>
              <label className="menu-field">
                <span>
                  Permissions
                  <small>When the orchestrator asks first</small>
                </span>
                <ModeSelect session={session} plain />
              </label>
              <button
                className="menu-item"
                onClick={() => {
                  close();
                  setConfirmReset(true);
                }}
              >
                <Icon name="plus" size={15} /> New conversation…
              </button>
              <div className="menu-foot">
                {session.model ?? 'default model'} · {fmtCost(session.costUsd)} over {session.turns} turns · active {fmtRelative(session.lastActivityAt, now)}
              </div>
            </>
          )}
        </Menu>
      </header>
      <Transcript session={session} size={compact ? 'normal' : 'large'} empty={empty} />
      <div className="orch-composer-wrap">
        <Composer key={session.id} session={session} size={compact ? 'normal' : 'large'} placeholder="Message the orchestrator" prefill={prefill} onPrefillUsed={clearPrefill} autoFocus={!compact} />
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
