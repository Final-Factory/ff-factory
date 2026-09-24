import { useEffect, useState } from 'react';
import type { PermissionMode, SessionInfo } from '../../../shared/types';
import { api } from '../api';
import { attempt, openSession } from '../store';
import { fmtCost, fmtRelative, navigate, PERMISSION_MODES, sessionLabel, sessionTone, useNow } from '../util';
import { Composer } from './Composer';
import { Transcript } from './Transcript';
import { Confirm, Dot, Icon } from './ui';
import { CriticalBadges, DetailsSection, DetailsSheet, PanelHeader, useDetailsOpen } from './PanelChrome';

/**
 * A conversation: the transcript takes the height, the composer sits under it. Inside a sandbox or
 * machine panel (`embedded`) the panel's header and details carry the controls; on its own page it
 * has a one-row header and its controls in the details sheet.
 */
export function SessionView({
  session,
  fullWidth,
  embedded,
  onBack,
}: {
  session: SessionInfo;
  fullWidth?: boolean;
  embedded?: boolean;
  onBack?: () => void;
}) {
  useEffect(() => openSession(session.id), [session.id]);
  const [details, setDetails] = useDetailsOpen('session');

  return (
    <section className={`session-view${fullWidth ? ' session-full' : ''}`}>
      {!embedded && (
        <>
          <PanelHeader
            onBack={onBack}
            dot={<Dot tone={sessionTone(session.status)} pulse={session.status === 'running'} />}
            title={session.title}
            subtitle={<SessionMeta session={session} />}
            badges={<CriticalBadges session={session} />}
            detailsOpen={details}
            onToggleDetails={() => setDetails(!details)}
          />
          <DetailsSheet open={details} onClose={() => setDetails(false)} title={session.title}>
            <SessionDetails session={session} fullWidth={fullWidth} />
          </DetailsSheet>
        </>
      )}
      {session.status === 'error' && session.statusDetail && <div className="banner banner-error">{session.statusDetail}</div>}
      <Transcript session={session} size={fullWidth ? 'large' : 'normal'} />
      <Composer
        key={session.id}
        session={session}
        size={fullWidth ? 'large' : 'normal'}
        placeholder={session.kind === 'standing' ? `Message ${session.title} (starts a run, or joins the current one)…` : `Message ${session.title}…`}
      />
    </section>
  );
}

/** One agent's controls, for a details sheet: name (rename), id, status and cost, permission mode, open full width, end. */
export function SessionDetails({ session, fullWidth }: { session: SessionInfo; fullWidth?: boolean }) {
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  return (
    <DetailsSection
      title="Agent"
      actions={
        <span className="details-actions">
          {!fullWidth && (session.sandboxId || session.standingId || session.machineId) && (
            <button className="btn btn-ghost btn-sm" title="Open this conversation full width" onClick={() => navigate({ view: 'session', sessionId: session.id })}>
              <Icon name="expand" size={14} /> Full width
            </button>
          )}
          {session.kind === 'worker' && (
            <button className="btn btn-ghost btn-sm danger-hover" title="End session" onClick={() => setConfirmEnd(true)}>
              <Icon name="trash" size={14} /> End
            </button>
          )}
        </span>
      }
    >
      <div className="session-title">
        <Dot tone={sessionTone(session.status)} pulse={session.status === 'running'} />
        {renaming ? (
          <form
            className="rename-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = draft.trim() && draft.trim() !== session.title ? await attempt(api.renameSession(session.id, draft.trim())) : true;
              if (ok) setRenaming(false);
            }}
          >
            <input className="input" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setRenaming(false)} maxLength={80} autoFocus aria-label="Agent name" />
            <button className="btn btn-primary btn-xs" type="submit">
              Save
            </button>
          </form>
        ) : (
          <>
            <span className="ellipsis">{session.title}</span>
            {session.kind === 'worker' && (
              <button
                className="btn btn-ghost btn-icon btn-xs"
                title="Rename"
                aria-label="Rename"
                onClick={() => {
                  setDraft(session.title);
                  setRenaming(true);
                }}
              >
                <Icon name="edit" size={12} />
              </button>
            )}
          </>
        )}
      </div>
      <div className="details-row">
        <SessionMeta session={session} />
        <span className="session-id mono" title="Session id">
          {session.id}
        </span>
      </div>
      {session.kind !== 'standing' && (
        <div className="details-row">
          <span className="dim small">Permissions</span>
          <ModeSelect session={session} />
        </div>
      )}
      {confirmEnd && (
        <Confirm
          title="End this session?"
          danger
          confirmLabel="End session"
          body={
            <>
              Stops <strong>{session.title}</strong> and removes it from the list. The sandbox and its worktree are left
              alone.
            </>
          }
          onConfirm={() => attempt(api.deleteSession(session.id))}
          onClose={() => setConfirmEnd(false)}
        />
      )}
    </DetailsSection>
  );
}

export function SessionMeta({ session }: { session: SessionInfo }) {
  const now = useNow();
  return (
    <div className="session-meta">
      <span className={`tone-${sessionTone(session.status)}`}>{sessionLabel[session.status]}</span>
      {session.model && <span className="mono">{session.model}</span>}
      <span title={`${session.turns} turns`}>{fmtCost(session.costUsd)}</span>
      <span title={new Date(session.lastActivityAt).toLocaleString()}>{fmtRelative(session.lastActivityAt, now)}</span>
    </div>
  );
}

export function ModeSelect({ session }: { session: SessionInfo }) {
  const [busy, setBusy] = useState(false);
  return (
    <label className={`mode-select mode-${session.permissionMode}`} title="Permission mode">
      <select
        value={session.permissionMode}
        disabled={busy}
        onChange={async (e) => {
          setBusy(true);
          await attempt(api.setMode(session.id, e.target.value as PermissionMode));
          setBusy(false);
        }}
      >
        {PERMISSION_MODES.map((m) => (
          <option key={m.value} value={m.value} title={m.hint}>
            {m.label}
          </option>
        ))}
      </select>
    </label>
  );
}
