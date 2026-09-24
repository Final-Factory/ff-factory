// The chrome around a conversation in the sandbox, machine and session views, kept small so the
// transcript gets the screen: one header (back, the label, a line with the state and, on a phone, the
// agent picker, and a ⋯ for the details), a strip when something waits on the user, and everything
// else in a details sheet (a bottom sheet on phones, a collapsible panel on desktop that remembers
// whether it was open).
import { useEffect, useState, type ReactNode } from 'react';
import type { SessionInfo, UnityBlocked } from '../../../shared/types';
import { focusPermission } from '../store';
import { lsGet, lsSet, sameTitle, sessionLabel, sessionTone, useMediaQuery } from '../util';
import { summarizeToolInput, toolLabel } from './toolSummary';
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
  title,
  titleClass = '',
  state,
  extra,
  detailsOpen,
  onToggleDetails,
}: {
  onBack?: () => void;
  backLabel?: string;
  title: string;
  titleClass?: string;
  /** The state in words ("● Working"). */
  state?: ReactNode;
  /** After the state: the agent picker on a phone, a few facts on desktop. */
  extra?: ReactNode;
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
      <div className="ph-text">
        <div className={`ph-name ${titleClass}`} title={title}>
          {title}
        </div>
        {(state || extra) && (
          <div className="ph-sub">
            {state}
            {extra}
          </div>
        )}
      </div>
      <button
        className={`btn btn-ghost btn-icon ph-btn${detailsOpen ? ' active' : ''}`}
        onClick={onToggleDetails}
        title={detailsOpen ? 'Hide details' : 'Details: git, Unity, screenshots, permissions, actions'}
        aria-label="Details"
        aria-expanded={detailsOpen}
      >
        <Icon name="more" />
      </button>
    </header>
  );
}

/**
 * Phones: the agent, in the header's second line. It reads as text ("Lighting pass ▾") and opens the
 * native picker; its tap area reaches past the line so a thumb finds it.
 */
export function AgentPicker({
  place,
  sessions,
  selected,
  onSelect,
  onNew,
  newDisabled,
}: {
  /** The sandbox's or machine's name: an agent named the same is shown as a count ("2 agents") rather than repeated. */
  place: string;
  sessions: SessionInfo[];
  selected?: SessionInfo;
  onSelect: (id: string) => void;
  onNew?: () => void;
  newDisabled?: boolean;
}) {
  if (!sessions.length && !onNew) return null;
  const text = !selected ? 'No agents yet' : sameTitle(selected.title, place) ? `${sessions.length} ${sessions.length === 1 ? 'agent' : 'agents'}` : selected.title;
  return (
    <label className="agent-pick show-phone" title="Agent">
      <span className="ph-sep" aria-hidden>
        ·
      </span>
      <span className="agent-pick-text">{text}</span>
      <Icon name="chevron" size={11} />
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
        {!selected && <option value="">No agents yet</option>}
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

/** Under the header, only while something waits on the user here: a permission request, Unity stuck on a dialog. */
export function AttentionStrip({ session, unity, onUnity }: { session?: SessionInfo; unity?: UnityBlocked; onUnity?: () => void }) {
  const waiting = session?.pendingPermissions ?? [];
  if (!waiting.length && !unity) return null;
  const p = waiting[0];
  const what = p ? summarizeToolInput(p.toolName, p.input) : '';
  return (
    <div className="attn-strip" role="status">
      {p && (
        <button className="attn-strip-row" onClick={() => focusPermission(p.requestId)}>
          <Icon name="bell" size={15} />
          <span className="attn-strip-text">
            <b>{waiting.length > 1 ? `${waiting.length} requests wait for your OK` : 'Waiting for your OK'}</b> · {toolLabel(p.toolName)}
            {what ? `: ${what}` : ''}
          </span>
          <span className="attn-strip-act">Review</span>
        </button>
      )}
      {unity && (
        <button className="attn-strip-row" onClick={onUnity}>
          <Icon name="alert" size={15} />
          <span className="attn-strip-text">
            <b>Unity is stuck</b>
            {unity.reason === 'dialog' && unity.title ? ` on “${unity.title}”` : unity.reason === 'stalled' ? ': no log output' : ''}. Someone at the desktop has to answer it.
          </span>
          <span className="attn-strip-act">Details</span>
        </button>
      )}
    </div>
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
