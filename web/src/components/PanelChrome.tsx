// The chrome around a conversation in the sandbox, machine and session views, kept small so the
// transcript gets the screen: one header row (back, label, agent switcher, critical badges, a ⋯
// button) and everything else in a details sheet (a bottom sheet on phones, a collapsible panel on
// desktop that remembers whether it was open).
import { useEffect, useState, type ReactNode } from 'react';
import type { SessionInfo } from '../../../shared/types';
import { focusPermission } from '../store';
import { lsGet, lsSet, sessionLabel, sessionTone, useMediaQuery } from '../util';
import { Dot, Icon } from './ui';

export const PHONE = '(max-width: 860px)';

/** Details open or closed: remembered per kind of page on desktop; on a phone it always starts closed. */
export function useDetailsOpen(kind: string): [boolean, (open: boolean) => void] {
  const phone = useMediaQuery(PHONE);
  const key = `ffsb.details.${kind}`;
  const [open, setOpen] = useState(() => !window.matchMedia(PHONE).matches && lsGet(key) === '1');
  useEffect(() => {
    if (phone) setOpen(false);
  }, [phone]);
  return [
    open,
    (o: boolean) => {
      setOpen(o);
      if (!window.matchMedia(PHONE).matches) lsSet(key, o ? '1' : null);
    },
  ];
}

export function PanelHeader({
  onBack,
  backLabel = 'Back',
  dot,
  title,
  titleClass = '',
  subtitle,
  switcher,
  badges,
  detailsOpen,
  onToggleDetails,
}: {
  onBack?: () => void;
  backLabel?: string;
  dot?: ReactNode;
  title: ReactNode;
  titleClass?: string;
  subtitle?: ReactNode;
  switcher?: ReactNode;
  badges?: ReactNode;
  detailsOpen: boolean;
  onToggleDetails: () => void;
}) {
  return (
    <header className="ph">
      {onBack && (
        <button className="btn btn-ghost btn-icon ph-btn" onClick={onBack} title={backLabel} aria-label={backLabel}>
          <Icon name="back" />
        </button>
      )}
      <div className="ph-title">
        {dot}
        <span className={`ph-name ellipsis ${titleClass}`}>{title}</span>
        {subtitle && <span className="ph-sub ellipsis hide-phone">{subtitle}</span>}
      </div>
      {switcher}
      {badges}
      <button
        className={`btn btn-ghost btn-icon ph-btn${detailsOpen ? ' active' : ''}`}
        onClick={onToggleDetails}
        title={detailsOpen ? 'Hide details' : 'Details: git, Unity, screenshots, permission mode, actions'}
        aria-label="Details"
        aria-expanded={detailsOpen}
      >
        <Icon name="more" />
      </button>
    </header>
  );
}

/** Pick the agent: a compact dropdown on phones, the tab row on desktop. */
export function AgentSwitcher({
  sessions,
  selected,
  onSelect,
  onNew,
  newDisabled,
}: {
  sessions: SessionInfo[];
  selected?: SessionInfo;
  onSelect: (id: string) => void;
  onNew?: () => void;
  newDisabled?: boolean;
}) {
  if (!sessions.length && !onNew) return null;
  return (
    <label className={`agent-select show-phone tone-${selected ? sessionTone(selected.status) : 'grey'}`} title="Agent">
      {selected && <Dot tone={sessionTone(selected.status)} pulse={selected.status === 'running'} />}
      <select
        value={selected?.id ?? ''}
        aria-label="Agent"
        onChange={(e) => {
          if (e.target.value === '__new') {
            e.target.value = selected?.id ?? '';
            onNew?.();
          } else onSelect(e.target.value);
        }}
      >
        {!selected && <option value="">No agents</option>}
        {sessions.map((s) => (
          <option key={s.id} value={s.id}>
            {s.title} · {sessionLabel[s.status]}
            {s.pendingPermissions.length ? ` · ${s.pendingPermissions.length} waiting` : ''}
          </option>
        ))}
        {onNew && (
          <option value="__new" disabled={newDisabled}>
            + New agent…
          </option>
        )}
      </select>
    </label>
  );
}

/** Desktop: the agents as tabs under the header. */
export function AgentTabs({
  sessions,
  selected,
  onSelect,
  onNew,
  newDisabled,
}: {
  sessions: SessionInfo[];
  selected?: SessionInfo;
  onSelect: (id: string) => void;
  onNew?: () => void;
  newDisabled?: boolean;
}) {
  if (!sessions.length && !onNew) return null;
  return (
    <nav className="tabs hide-phone" role="tablist">
      {sessions.map((s) => (
        <button
          key={s.id}
          role="tab"
          aria-selected={s.id === selected?.id}
          className={`tab${s.id === selected?.id ? ' active' : ''}`}
          onClick={() => onSelect(s.id)}
          title={`${s.title}: ${sessionLabel[s.status]}`}
        >
          <Dot tone={sessionTone(s.status)} pulse={s.status === 'running'} />
          <span className="ellipsis">{s.title}</span>
          {s.pendingPermissions.length > 0 && <span className="badge badge-amber">{s.pendingPermissions.length}</span>}
        </button>
      ))}
      {onNew && (
        <button className="tab tab-new" onClick={onNew} disabled={newDisabled}>
          <Icon name="plus" size={13} /> New agent
        </button>
      )}
    </nav>
  );
}

/** Only what cannot wait: a permission prompt (tap: scroll to it), Unity stuck on a dialog (tap: details). */
export function CriticalBadges({ session, unityBlocked, onUnity }: { session?: SessionInfo; unityBlocked?: boolean; onUnity?: () => void }) {
  const waiting = session?.pendingPermissions.length ?? 0;
  if (!waiting && !unityBlocked) return null;
  return (
    <span className="ph-badges">
      {waiting > 0 && (
        <button className="ph-badge ph-badge-amber" onClick={() => focusPermission(session!.pendingPermissions[0].requestId)} title="Waiting for your permission: show it">
          <Icon name="bell" size={13} /> <span>{waiting}</span>
          <span className="hide-narrow">waiting</span>
        </button>
      )}
      {unityBlocked && (
        <button className="ph-badge ph-badge-red" onClick={onUnity} title="Unity is stuck: see details">
          <span>Unity</span>
          <span className="hide-narrow">blocked</span>
        </button>
      )}
    </span>
  );
}

/** The details: a bottom sheet on phones (with a backdrop), an inline collapsible panel on desktop. */
export function DetailsSheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode }) {
  const phone = useMediaQuery(PHONE);
  useEffect(() => {
    if (!open || !phone) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, phone, onClose]);
  if (!open) return null;
  return (
    <>
      {phone && <div className="details-backdrop" onClick={onClose} />}
      <div className={`details-sheet${phone ? ' is-sheet' : ''}`} role={phone ? 'dialog' : 'region'} aria-label="Details">
        {phone && (
          <div className="details-grab">
            <span />
          </div>
        )}
        {phone && (
          <div className="details-sheet-head">
            <span className="ellipsis">{title}</span>
            <button className="btn btn-ghost btn-icon ph-btn" onClick={onClose} aria-label="Close details">
              <Icon name="x" />
            </button>
          </div>
        )}
        <div className="details-body">{children}</div>
      </div>
    </>
  );
}

/** A labelled group inside the details. */
export function DetailsSection({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="details-section">
      <div className="details-section-head">
        <span>{title}</span>
        {actions}
      </div>
      {children}
    </section>
  );
}
