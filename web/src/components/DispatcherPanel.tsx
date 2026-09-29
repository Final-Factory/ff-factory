import { useEffect, useState } from 'react';
import type { AppState, SessionInfo, WorkItem } from '../../../shared/types';
import { api } from '../api';
import { sessionRoute } from '../attention';
import { attempt, reloadTranscript } from '../store';
import { dispatcherGlance, fmtCost, fmtRelative, isBusy, isOpenWork, navigate, useNow, workLabel, workTone } from '../util';
import { Markdown } from './Markdown';
import { SessionView } from './SessionView';
import { accountOf } from './SystemMeters';
import { Confirm, Dot, Icon, Menu } from './ui';

type Tab = 'requests' | 'conversation';

const RANK: Record<WorkItem['status'], number> = { question: 0, new: 1, queued: 2, active: 3, done: 4, merged: 4, rejected: 4, cancelled: 4 };
const PRIORITY: Record<WorkItem['priority'], number> = { urgent: 0, high: 1, normal: 2, low: 3 };

/** Open requests first (questions, new, queued, active; then by priority and age), then the closed ones, newest first. */
function byLedger(a: WorkItem, b: WorkItem) {
  if (RANK[a.status] !== RANK[b.status]) return RANK[a.status] - RANK[b.status];
  if (isOpenWork(a)) return PRIORITY[a.priority] - PRIORITY[b.priority] || a.createdAt.localeCompare(b.createdAt);
  return b.updatedAt.localeCompare(a.updatedAt);
}

const names = (w: WorkItem) => w.requesters.map((r) => r.displayName).join(', ');

/**
 * The dispatcher (docs/orchestrators.md): the ledger of everyone's requests with what was decided and who works on
 * them, and its conversation, which only the owner writes to. `tab`: "conversation", or a request id to open.
 */
export function DispatcherPanel({ app, tab, onClose }: { app: AppState; tab?: string; onClose?: () => void }) {
  const now = useNow(15_000);
  const [confirmReset, setConfirmReset] = useState(false);
  const session = app.sessions.find((s) => s.id === app.dispatcherId);
  const work = [...(app.work ?? [])].sort(byLedger);
  const open = work.filter(isOpenWork);
  const closed = work.filter((w) => !isOpenWork(w));
  const current: Tab = tab === 'conversation' ? 'conversation' : 'requests';
  const focus = tab && /^w\d+$/.test(tab) ? tab : undefined;
  const setTab = (t: Tab) => navigate({ view: 'dispatcher', tab: t === 'requests' ? undefined : t }, true);
  const owner = app.me?.role === 'owner';
  const glance = dispatcherGlance(session, open, app.me?.userId);
  const account = session ? accountOf(app, session.id) : undefined;

  return (
    <section className="sb-panel sa-panel dispatcher-panel">
      <header className="sb-head">
        <div className="sb-head-top">
          {onClose && (
            <button className="btn btn-ghost btn-icon" onClick={onClose} title="Close" aria-label="Close">
              <Icon name="back" />
            </button>
          )}
          <Dot tone={glance.tone} pulse={isBusy(session)} />
          <h2 className="ellipsis">Dispatcher</h2>
          <div className="spacer" />
          {owner && session && (
            <Menu label="Dispatcher options">
              {(close) => (
                <>
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
                    {session.model ?? 'default model'}
                    {account ? ` on ${account.label}` : ''} · {fmtCost(session.costUsd)} over {session.turns} turns · active {fmtRelative(session.lastActivityAt, now)}
                  </div>
                </>
              )}
            </Menu>
          )}
        </div>
        <p className="sb-head-purpose">Everyone’s requests for work, what was decided, and who is on them.</p>
      </header>

      <nav className="tabs" role="tablist">
        <button role="tab" aria-selected={current === 'requests'} className={`tab${current === 'requests' ? ' active' : ''}`} onClick={() => setTab('requests')}>
          Requests <span className="dim">{open.length}</span>
        </button>
        <button role="tab" aria-selected={current === 'conversation'} className={`tab${current === 'conversation' ? ' active' : ''}`} onClick={() => setTab('conversation')}>
          Conversation
        </button>
      </nav>

      {current === 'requests' && <Requests app={app} open={open} closed={closed} focus={focus} now={now} />}
      {current === 'conversation' &&
        (session ? (
          <SessionView key={session.id} session={session} embedded readOnly={owner ? undefined : 'Only the owner writes to the dispatcher. To ask for work, write to your own orchestrator.'} />
        ) : (
          <div className="panel-empty">
            <p>No dispatcher yet.</p>
          </div>
        ))}

      {confirmReset && (
        <Confirm
          title="Start the dispatcher afresh?"
          confirmLabel="New conversation"
          body="The dispatcher forgets its conversation. The requests, sandboxes and agents all stay; it reads them again from the ledger."
          onConfirm={async () => {
            const ok = await attempt(api.resetOrchestrator('dispatcher'));
            if (ok !== undefined) reloadTranscript(ok.id);
          }}
          onClose={() => setConfirmReset(false)}
        />
      )}
    </section>
  );
}

function Requests({ app, open, closed, focus, now }: { app: AppState; open: WorkItem[]; closed: WorkItem[]; focus?: string; now: number }) {
  const [expanded, setExpanded] = useState<string | null>(focus ?? null);
  const [showClosed, setShowClosed] = useState(() => !!focus && closed.some((w) => w.id === focus));
  useEffect(() => {
    if (!focus) return;
    setExpanded(focus);
    if (closed.some((w) => w.id === focus)) setShowClosed(true);
    requestAnimationFrame(() => document.getElementById(`work-${focus}`)?.scrollIntoView({ block: 'nearest' }));
    // The focus comes from a link (a notice in a chat): open it once, then leave the rows to the user.
  }, [focus]);

  if (!open.length && !closed.length) {
    return (
      <div className="panel-empty">
        <Icon name="inbox" size={28} />
        <p>No requests yet.</p>
        <p className="dim small">When someone asks their orchestrator for work, the request shows here with what the dispatcher decided.</p>
      </div>
    );
  }
  const row = (w: WorkItem) => <WorkRow key={w.id} app={app} w={w} open={expanded === w.id} onToggle={() => setExpanded(expanded === w.id ? null : w.id)} now={now} />;
  return (
    <div className="sa-scroll">
      {open.length ? <div className="run-list">{open.map(row)}</div> : <p className="dim small ledger-none">Nothing open.</p>}
      {closed.length > 0 && (
        <>
          <button className="link-btn small ledger-closed" onClick={() => setShowClosed(!showClosed)} aria-expanded={showClosed}>
            {showClosed ? 'Hide closed' : `${closed.length} closed`}
          </button>
          {showClosed && <div className="run-list">{closed.map(row)}</div>}
        </>
      )}
    </div>
  );
}

function WorkRow({ app, w, open, onToggle, now }: { app: AppState; w: WorkItem; open: boolean; onToggle: () => void; now: number }) {
  const workers = w.sessionIds.map((id) => app.sessions.find((s) => s.id === id)).filter((s): s is SessionInfo => !!s);
  const working = workers.some(isBusy);
  const tone = workTone(w.status);
  return (
    <div id={`work-${w.id}`} className={`run-row work-row${open ? ' open' : ''}`} data-testid={`work-${w.id}`}>
      <button className="run-row-top" onClick={onToggle} aria-expanded={open}>
        <Dot tone={tone} pulse={w.status === 'active' && working} title={workLabel[w.status]} />
        <span className="work-main">
          <span className="work-title">{w.title}</span>
          <span className="work-sub">
            <span className={`tone-${tone}`}>{workLabel[w.status]}</span>
            {w.mergedInto ? ` into ${w.mergedInto}` : ''} · <span className="mono">{w.id}</span> · {names(w)}
            {w.priority === 'urgent' || w.priority === 'high' ? <span className="tone-amber"> · {w.priority}</span> : null}
          </span>
        </span>
        <span className="run-cost mono dim" title={new Date(w.updatedAt).toLocaleString()}>
          {fmtRelative(w.updatedAt, now)}
        </span>
      </button>
      {open && (
        <div className="run-detail work-detail">
          <Markdown text={w.brief} />
          {w.constraints && <p className="dim small">Constraints: {w.constraints}</p>}
          {w.outcome && (
            <p className="small">
              <span className="dim">Latest: </span>
              {w.outcome}
            </p>
          )}
          {w.mergedInto && (
            <button className="link-btn small" onClick={() => navigate({ view: 'dispatcher', tab: w.mergedInto })}>
              Continues as {w.mergedInto}
            </button>
          )}
          {workers.map((s) => (
            <button key={s.id} className="link-btn small" onClick={() => navigate(sessionRoute(s, app))}>
              Open {s.title}
              {s.sandboxId ? ` in ${s.sandboxId}` : s.machineId ? ` on ${s.machineId}` : ''}
            </button>
          ))}
          {w.overlaps.length > 0 && (
            <p className="dim small">
              Found at filing, may repeat: {w.overlaps.map((o) => `${o.ref} “${o.title}” (${o.why})`).join('; ')}
            </p>
          )}
          {w.log.length > 0 && (
            <details className="deleg-log">
              <summary className="dim small">Log · {w.log.at(-1)}</summary>
              <pre className="code">{w.log.join('\n')}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
